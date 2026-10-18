'use strict';
// Dashboard, analytics reports, users & roles, notifications, audit log, settings, SEO, backups.
const fs = require('node:fs');
const { proxyProblem } = require('../proxycheck');
const path = require('node:path');
const config = require('../config');
const { get, all, run, tx, now, dayOf } = require('../db');
const { err, sendFile } = require('../http');
const { v, validate } = require('../validate');
const sec = require('../security');
const { requireAuth, can, superOnly, destroyUserSessions } = require('../auth');
const { audit, diff } = require('../audit');
const { defineResource, listRows, TZ } = require('../crud');
const { sendExport } = require('../xlsx');
const { PERMISSIONS, SUPER_ONLY } = require('../permissions');
const { GROUPS, getSetting, setSetting } = require('../settings');
const analytics = require('../analytics');
const { leadStats } = require('./requests');
const mail = require('../mail');
const backup = require('../backup');
const notify = require('../notify');
const { mediaById } = require('../files');

const localTime = (iso) => (iso ? new Date(Date.parse(iso) + config.tzOffsetMin * 60000).toISOString().replace('T', ' ').slice(0, 19) : '');
const inRange = (table, r) => get(`SELECT COUNT(*) AS n FROM ${table} WHERE date(created_at, '${TZ}') BETWEEN ? AND ?`, r.from, r.to).n;

module.exports = (app) => {
  /* -------------------------------------------------------- dashboard */
  app.get('/api/dashboard', can('dashboard.view'), (ctx) => {
    const o = analytics.overview(ctx.query);
    const r = { from: o.range.from, to: o.range.to };
    const months = [];
    const today = dayOf();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1));
      months.push({ key: d.toISOString().slice(0, 7), label: analytics.MON[d.getUTCMonth()], leads: 0, contacts: 0 });
    }
    const since = months[0].key + '-01';
    for (const [table, field] of [['project_requests', 'leads'], ['contact_requests', 'contacts']]) {
      for (const x of all(`SELECT strftime('%Y-%m', created_at, '${TZ}') AS m, COUNT(*) AS n FROM ${table} WHERE date(created_at, '${TZ}') >= ? GROUP BY m`, since)) {
        const mo = months.find((y) => y.key === x.m);
        if (mo) mo[field] = x.n;
      }
    }
    const out = {
      range: o.range,
      kpis: {
        total_visitors: o.all_time_visitors, visitors_today: o.today_visitors, visitors_yesterday: o.yesterday_visitors, visitors_month: o.month_visitors,
        visitors: o.totals.visitors, visitors_change: o.change.visitors, pageviews: o.totals.pageviews, pageviews_change: o.change.pageviews,
        returning: o.totals.returning, new_visitors: o.totals.new_visitors,
        new_contacts: inRange('contact_requests', r), contacts_open: get("SELECT COUNT(*) AS n FROM contact_requests WHERE status = 'new'").n,
        new_leads: inRange('project_requests', r), leads_open: get("SELECT COUNT(*) AS n FROM project_requests WHERE status = 'new'").n,
        published_news: get("SELECT COUNT(*) AS n FROM news WHERE status = 'published'").n, draft_news: get("SELECT COUNT(*) AS n FROM news WHERE status = 'draft'").n,
        active_projects: get("SELECT COUNT(*) AS n FROM projects WHERE status = 'ongoing'").n, planned_projects: get("SELECT COUNT(*) AS n FROM projects WHERE status = 'planned'").n,
      },
      series: o.series, devices: o.devices, sources: o.sources, pages: o.pages.slice(0, 8), requests_by_month: months,
    };
    if (ctx.perms.has('leads.view')) {
      out.lead_stats = leadStats(r.from, r.to, o.totals.visitors);
      out.recent_leads = all('SELECT id, first_name, last_name, company, project_name, status, created_at FROM project_requests ORDER BY created_at DESC, id DESC LIMIT 5');
    }
    ctx.json(out);
  });

  /* -------------------------------------------------------- analytics */
  app.get('/api/analytics', can('analytics.view'), (ctx) => {
    const o = analytics.overview(ctx.query);
    if (ctx.perms.has('leads.view')) o.lead_stats = leadStats(o.range.from, o.range.to, o.totals.visitors);
    ctx.json(o);
  });
  const sessionDef = {
    table: 'analytics_sessions', search: ['landing_page', 'exit_page', 'referrer', 'country', 'city', 'browser', 'os'],
    filters: { device: { col: 'device', values: Object.keys(analytics.DEVICES) }, source: { col: 'source', values: Object.keys(analytics.SOURCES) }, country: { col: 'country' }, browser: { col: 'browser' } },
    sortable: { date: 'started_at', duration: 'duration_sec', pageviews: 'pageviews', country: 'country' }, defaultSort: 'started_at DESC', idCol: 'started_at',
  };
  const sessionRows = (ctx, opts) => {
    const r = analytics.range(ctx.query);
    return listRows(sessionDef, ctx.query, { where: ['day BETWEEN ? AND ?'], params: [r.from, r.to], ...opts });
  };
  const presentSession = (s) => ({ id: s.id.slice(0, 10), started_at: s.started_at, duration_sec: s.duration_sec, pageviews: s.pageviews, landing_page: s.landing_page, exit_page: s.exit_page,
    referrer: s.referrer, source: s.source, source_label: analytics.SOURCES[s.source] || s.source, browser: s.browser, os: s.os, device: s.device, device_label: analytics.DEVICES[s.device] || s.device,
    screen: s.screen, country: s.country, city: s.city, lang: s.lang, is_returning: !!s.is_returning });
  app.get('/api/analytics/sessions', can('analytics.view'), (ctx) => {
    const r = sessionRows(ctx);
    ctx.json({ items: r.rows.map(presentSession), total: r.total, page: r.page, per_page: r.perPage, sources: analytics.SOURCES, devices: analytics.DEVICES });
  });
  app.get('/api/analytics/export', can('analytics.export'), (ctx) => {
    const type = ['sessions', 'daily', 'pages'].includes(ctx.query.type) ? ctx.query.type : 'daily';
    const r = analytics.range(ctx.query);
    let columns, rows;
    if (type === 'sessions') {
      rows = sessionRows(ctx, { all: true }).rows.map(presentSession);
      columns = [{ label: 'Tarix və saat', get: (s) => localTime(s.started_at) }, { label: 'Sessiya ID', get: (s) => s.id }, { label: 'Giriş səhifəsi', get: (s) => s.landing_page }, { label: 'Çıxış səhifəsi', get: (s) => s.exit_page },
        { label: 'Səhifə baxışı', get: (s) => s.pageviews }, { label: 'Müddət (san)', get: (s) => s.duration_sec }, { label: 'Trafik mənbəyi', get: (s) => s.source_label }, { label: 'Referrer', get: (s) => s.referrer },
        { label: 'Brauzer', get: (s) => s.browser }, { label: 'Əməliyyat sistemi', get: (s) => s.os }, { label: 'Cihaz', get: (s) => s.device_label }, { label: 'Ekran', get: (s) => s.screen },
        { label: 'Ölkə', get: (s) => s.country }, { label: 'Şəhər', get: (s) => s.city }, { label: 'Təkrar ziyarət', get: (s) => (s.is_returning ? 'Bəli' : 'Xeyr') }];
    } else if (type === 'pages') {
      rows = all('SELECT path, MAX(title) AS title, COUNT(*) AS n FROM page_views WHERE day BETWEEN ? AND ? GROUP BY path ORDER BY n DESC LIMIT 5000', r.from, r.to);
      columns = [{ label: 'Səhifə', get: (x) => x.path }, { label: 'Başlıq', get: (x) => x.title }, { label: 'Baxış', get: (x) => x.n }];
    } else {
      const byDay = new Map();
      for (const x of all('SELECT day, COUNT(DISTINCT visitor_hash) AS v, COUNT(*) AS s, SUM(is_returning) AS ret FROM analytics_sessions WHERE day BETWEEN ? AND ? GROUP BY day', r.from, r.to)) byDay.set(x.day, { v: x.v, s: x.s, ret: x.ret, pv: 0 });
      for (const x of all('SELECT day, COUNT(*) AS n FROM page_views WHERE day BETWEEN ? AND ? GROUP BY day', r.from, r.to)) { const o = byDay.get(x.day) || { v: 0, s: 0, ret: 0, pv: 0 }; o.pv = x.n; byDay.set(x.day, o); }
      rows = [];
      for (let i = 0; i < r.n; i++) { const d = analytics.addDays(r.from, i); rows.push({ day: d, ...(byDay.get(d) || { v: 0, s: 0, ret: 0, pv: 0 }) }); }
      columns = [{ label: 'Tarix', get: (x) => x.day }, { label: 'Unikal ziyarətçi', get: (x) => x.v }, { label: 'Sessiya', get: (x) => x.s }, { label: 'Təkrar ziyarət', get: (x) => x.ret }, { label: 'Səhifə baxışı', get: (x) => x.pv }];
    }
    audit(ctx, { action: `Eksport (${ctx.query.format === 'xlsx' ? 'Excel' : 'CSV'})`, module: 'Analitika', summary: `${rows.length} sətir eksport edildi (${type}, ${r.from} – ${r.to})` });
    sendExport(ctx, { name: `analitika-${type}`, format: ctx.query.format, rows, columns });
  });

  /* ------------------------------------------------- users and roles */
  const userOut = (u) => ({ id: u.id, name: u.name, email: u.email, role_id: u.role_id, role: u.role_name, role_key: u.role_key, is_active: !!u.is_active, totp_enabled: !!u.totp_enabled,
    must_change_password: !!u.must_change_password, locked: !!(u.locked_until && Date.parse(u.locked_until) > Date.now()), last_login_at: u.last_login_at, created_at: u.created_at });
  const userDef = {
    from: 'users u JOIN roles r ON r.id = u.role_id', select: 'u.*, r.name AS role_name, r.key AS role_key', idCol: 'u.id',
    search: ['u.name', 'u.email', 'r.name'], filters: { role_id: { col: 'u.role_id', int: true }, active: { col: 'u.is_active', int: true } },
    sortable: { name: 'fold(u.name)', email: 'u.email', role: 'r.name', last_login: 'u.last_login_at', created: 'u.created_at' }, defaultSort: 'u.id ASC',
  };
  const loadUserRow = (id) => get('SELECT u.*, r.name AS role_name, r.key AS role_key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', id);
  const activeSupers = (exceptId) => get("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'super_admin' AND u.is_active = 1 AND u.id <> ?", exceptId || 0).n;
  // Only a Super Admin may create, change or remove Super Admin accounts.
  const guardSuper = (ctx, target, newRole) => {
    const isSuper = ctx.user.role_key === 'super_admin';
    if (!isSuper && ((target && target.role_key === 'super_admin') || (newRole && newRole.key === 'super_admin'))) throw err(403, 'Super Admin hesablarını yalnız Super Admin idarə edə bilər');
  };
  const userShape = { name: v.str({ max: 120, required: true }), email: v.email({ required: true }), role_id: v.int({ min: 1, required: true }), is_active: v.bool({ default: true }) };
  app.get('/api/users', can('users.view', 'users.manage'), (ctx) => {
    const r = listRows(userDef, ctx.query);
    ctx.json({ items: r.rows.map(userOut), total: r.total, page: r.page, per_page: r.perPage, roles: all('SELECT id, key, name FROM roles ORDER BY id') });
  });
  app.post('/api/users', can('users.manage'), async (ctx) => {
    const b = await ctx.readJson(4096);
    const d = validate({ ...userShape, password: v.str({ max: 200, required: true }) }, b);
    const role = get('SELECT * FROM roles WHERE id = ?', d.role_id);
    if (!role) throw err(422, 'Rol tapılmadı', { fields: { role_id: 'Rol tapılmadı' } });
    guardSuper(ctx, null, role);
    if (get('SELECT id FROM users WHERE email = ?', d.email)) throw err(422, 'Bu e-poçt artıq istifadə olunur', { fields: { email: 'Bu e-poçt artıq istifadə olunur' } });
    const problem = sec.passwordProblem(d.password, d);
    if (problem) throw err(422, problem, { fields: { password: problem } });
    const hash = await sec.hashPassword(d.password);
    const id = tx(() => {
      const rid = run('INSERT INTO users (email, name, password_hash, role_id, is_active, must_change_password, password_changed_at, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)', d.email, d.name, hash, role.id, d.is_active, now(), now(), now()).lastInsertRowid;
      audit(ctx, { action: 'Yaratma', module: 'İstifadəçilər', recordId: rid, summary: `${ctx.user.name} yeni istifadəçi yaratdı: ${d.name} (${role.name})`, next: { name: d.name, email: d.email, role: role.name } });
      return rid;
    });
    notify.notify('users.manage', { type: 'new_user', title: 'Yeni istifadəçi', body: `${d.name} — ${role.name}`, link: '#/istifadeciler' }, ctx.user.id);
    ctx.json({ item: userOut(loadUserRow(id)) }, 201);
  });
  app.put('/api/users/:id', can('users.manage'), async (ctx) => {
    const id = ctx.intParam('id');
    const d = validate(userShape, await ctx.readJson(4096));
    const item = tx(() => {
      const before = loadUserRow(id);
      if (!before) throw err(404, 'İstifadəçi tapılmadı');
      const role = get('SELECT * FROM roles WHERE id = ?', d.role_id);
      if (!role) throw err(422, 'Rol tapılmadı', { fields: { role_id: 'Rol tapılmadı' } });
      guardSuper(ctx, before, role);
      if (id === ctx.user.id && (!d.is_active || role.id !== before.role_id)) throw err(422, 'Öz rolunuzu və ya aktivliyinizi dəyişə bilməzsiniz');
      if (before.role_key === 'super_admin' && (role.key !== 'super_admin' || !d.is_active) && activeSupers(id) === 0) throw err(422, 'Sistemdə ən azı bir aktiv Super Admin qalmalıdır');
      if (get('SELECT id FROM users WHERE email = ? AND id <> ?', d.email, id)) throw err(422, 'Bu e-poçt artıq istifadə olunur', { fields: { email: 'Bu e-poçt artıq istifadə olunur' } });
      run('UPDATE users SET name = ?, email = ?, role_id = ?, is_active = ?, updated_at = ? WHERE id = ?', d.name, d.email, role.id, d.is_active, now(), id);
      if (!d.is_active || role.id !== before.role_id) destroyUserSessions(id);
      const after = loadUserRow(id);
      const df = diff({ name: before.name, email: before.email, role: before.role_name, is_active: before.is_active }, { name: after.name, email: after.email, role: after.role_name, is_active: after.is_active });
      if (df.changed) audit(ctx, { action: before.role_id !== after.role_id ? 'Rol dəyişikliyi' : 'Redaktə', module: 'İstifadəçilər', recordId: id, summary: `${ctx.user.name}: ${after.name}`, prev: df.prev, next: df.next });
      return after;
    });
    ctx.json({ item: userOut(item) });
  });
  const userAction = (pathName, label, fn) => app.post(`/api/users/:id/${pathName}`, can('users.manage'), async (ctx) => {
    const target = loadUserRow(ctx.intParam('id'));
    if (!target) throw err(404, 'İstifadəçi tapılmadı');
    guardSuper(ctx, target, null);
    await fn(ctx, target);
    audit(ctx, { action: label, module: 'İstifadəçilər', recordId: target.id, summary: `${ctx.user.name}: ${label} — ${target.name}` });
    ctx.json({ item: userOut(loadUserRow(target.id)) });
  });
  userAction('reset-password', 'Şifrə sıfırlandı', async (ctx, target) => {
    const b = validate({ password: v.str({ max: 200, required: true }) }, await ctx.readJson(2048));
    const problem = sec.passwordProblem(b.password, target);
    if (problem) throw err(422, problem, { fields: { password: problem } });
    const hash = await sec.hashPassword(b.password);
    run('UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hash, now(), now(), target.id);
    destroyUserSessions(target.id, target.id === ctx.user.id ? ctx.session.id : '');
  });
  userAction('reset-2fa', '2FA sıfırlandı', (ctx, target) => { run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?', now(), target.id); });
  userAction('unlock', 'Blok götürüldü', (ctx, target) => { run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', target.id); sec.clearRateLimit('login-pair', `${target.email}|`); });
  app.delete('/api/users/:id', can('users.manage'), (ctx) => {
    const id = ctx.intParam('id');
    const target = loadUserRow(id);
    if (!target) throw err(404, 'İstifadəçi tapılmadı');
    guardSuper(ctx, target, null);
    if (id === ctx.user.id) throw err(422, 'Öz hesabınızı silə bilməzsiniz');
    if (target.role_key === 'super_admin' && target.is_active && activeSupers(id) === 0) throw err(422, 'Sistemdə ən azı bir aktiv Super Admin qalmalıdır');
    tx(() => {
      run('DELETE FROM users WHERE id = ?', id);
      audit(ctx, { action: 'Silmə', module: 'İstifadəçilər', recordId: id, summary: `${ctx.user.name} istifadəçini sildi: ${target.name}`, prev: { name: target.name, email: target.email, role: target.role_name } });
    });
    ctx.json({ ok: true });
  });
  app.get('/api/roles', can('users.view', 'users.manage'), (ctx) => {
    const roles = all('SELECT id, key, name, description FROM roles ORDER BY id').map((r) => ({ ...r,
      users: get('SELECT COUNT(*) AS n FROM users WHERE role_id = ?', r.id).n,
      permissions: r.key === 'super_admin' ? PERMISSIONS.map((p) => p[0]) : all('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', r.id).map((x) => x.key) }));
    ctx.json({ roles, permissions: PERMISSIONS.map(([key, module, label]) => ({ key, module, label, super_only: SUPER_ONLY.has(key) })), can_edit: ctx.user.role_key === 'super_admin' });
  });
  app.put('/api/roles/:id/permissions', superOnly, async (ctx) => {
    const id = ctx.intParam('id');
    const role = get('SELECT * FROM roles WHERE id = ?', id);
    if (!role) throw err(404, 'Rol tapılmadı');
    if (role.key === 'super_admin') throw err(422, 'Super Admin rolunun icazələri dəyişdirilə bilməz');
    const b = await ctx.readJson(16384);
    if (!Array.isArray(b.permissions)) throw err(422, 'İcazə siyahısı gözlənilir');
    const valid = new Set(PERMISSIONS.map((p) => p[0]));
    const keys = [...new Set(b.permissions)].filter((k) => typeof k === 'string' && valid.has(k) && !SUPER_ONLY.has(k));
    const before = all('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', id).map((x) => x.key).sort();
    tx(() => {
      run('DELETE FROM role_permissions WHERE role_id = ?', id);
      for (const k of keys) run('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE key = ?', id, k);
      audit(ctx, { action: 'İcazə dəyişikliyi', module: 'Rollar', recordId: id, summary: `${ctx.user.name} «${role.name}» rolunun icazələrini dəyişdi`,
        prev: before.filter((k) => !keys.includes(k)), next: keys.filter((k) => !before.includes(k)) });
    });
    ctx.json({ ok: true, permissions: keys });
  });

  /* ---------------------------------------------------- notifications */
  app.get('/api/notifications', requireAuth, (ctx) => {
    const per = 20, p = Math.max(1, parseInt(ctx.query.page, 10) || 1);
    const where = ctx.query.unread === '1' ? 'AND is_read = 0' : '';
    ctx.json({ items: all(`SELECT id, type, title, body, link, is_read, created_at FROM notifications WHERE user_id = ? ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ctx.user.id, per, (p - 1) * per),
      total: get(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? ${where}`, ctx.user.id).n, page: p, per_page: per,
      unread: get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', ctx.user.id).n });
  });
  // Small payload polled by the panel for the bell and the sidebar badges.
  app.get('/api/notifications/summary', requireAuth, (ctx) => {
    ctx.json({ unread: get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', ctx.user.id).n,
      new_leads: ctx.perms.has('leads.view') ? get("SELECT COUNT(*) AS n FROM project_requests WHERE status = 'new'").n : 0,
      new_contacts: ctx.perms.has('contacts.view') ? get("SELECT COUNT(*) AS n FROM contact_requests WHERE status = 'new'").n : 0 });
  });
  app.post('/api/notifications/read-all', requireAuth, (ctx) => { run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', ctx.user.id); ctx.json({ ok: true }); });
  app.post('/api/notifications/:id/read', requireAuth, (ctx) => { run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', ctx.intParam('id'), ctx.user.id); ctx.json({ ok: true }); });

  /* -------------------------------------------------------- audit log */
  const auditDef = {
    table: 'audit_logs', search: ['user_name', 'action', 'module', 'record_id', 'summary', 'previous_value', 'new_value'],
    filters: { module: { col: 'module' }, user_id: { col: 'user_id', int: true } }, dateCol: 'created_at', sortable: { date: 'created_at' }, defaultSort: 'id DESC',
  };
  app.get('/api/audit', superOnly, (ctx) => {
    const r = listRows(auditDef, ctx.query);
    ctx.json({ items: r.rows, total: r.total, page: r.page, per_page: r.perPage, modules: all('SELECT DISTINCT module FROM audit_logs ORDER BY module').map((x) => x.module),
      users: all("SELECT DISTINCT user_id AS id, user_name AS name FROM audit_logs WHERE user_id IS NOT NULL ORDER BY user_name") });
  });
  app.get('/api/audit/export', superOnly, (ctx) => {
    const r = listRows(auditDef, ctx.query, { all: true });
    audit(ctx, { action: `Eksport (${ctx.query.format === 'xlsx' ? 'Excel' : 'CSV'})`, module: 'Audit jurnalı', summary: `${r.rows.length} sətir eksport edildi` });
    sendExport(ctx, { name: 'audit-jurnali', format: ctx.query.format, rows: r.rows, columns: [
      { label: 'Tarix və saat', get: (x) => localTime(x.created_at) }, { label: 'İstifadəçi', get: (x) => x.user_name }, { label: 'Əməliyyat', get: (x) => x.action }, { label: 'Modul', get: (x) => x.module },
      { label: 'Qeyd ID', get: (x) => x.record_id }, { label: 'Təsvir', get: (x) => x.summary }, { label: 'IP', get: (x) => x.ip }, { label: 'Əvvəlki dəyər', get: (x) => x.previous_value || '' }, { label: 'Yeni dəyər', get: (x) => x.new_value || '' },
    ] });
  });

  /* --------------------------------------------------------- settings */
  const groupPerm = (group) => (group === 'company' ? 'company.edit' : group === 'seo' ? 'seo.manage' : group === 'backup' ? 'backup.manage' : 'settings.manage');
  app.get('/api/settings', can('settings.view', 'settings.manage', 'seo.manage'), (ctx) => {
    const out = {};
    for (const k of Object.keys(GROUPS)) if (k !== 'company' && (k !== 'backup' || ctx.user.role_key === 'super_admin')) out[k] = getSetting(k);
    ctx.json({ settings: out });
  });
  app.get('/api/company', can('company.view', 'company.edit'), (ctx) => ctx.json({ company: getSetting('company') }));
  app.put('/api/settings/:group', requireAuth, async (ctx) => {
    const group = ctx.params.group;
    if (!Object.prototype.hasOwnProperty.call(GROUPS, group)) throw err(404, 'Tənzimləmə qrupu tapılmadı');
    if (!ctx.perms.has(groupPerm(group))) throw err(403, 'Bu əməliyyat üçün icazəniz yoxdur');
    const before = getSetting(group);
    const value = setSetting(group, await ctx.readJson(256 * 1024), ctx.user.id);
    const df = diff(before, value);
    if (df.changed) audit(ctx, { action: 'Tənzimləmə dəyişikliyi', module: group === 'company' ? 'Şirkət məlumatları' : 'Tənzimləmələr', recordId: group, summary: `${ctx.user.name} «${group}» tənzimləmələrini dəyişdi`, prev: df.prev, next: df.next });
    ctx.json({ value: getSetting(group) });
  });
  app.post('/api/settings/test-email', can('settings.manage'), async (ctx) => {
    if (!mail.isConfigured()) throw err(409, 'SMTP qurulmayıb (.env faylında SMTP_HOST və SMTP_FROM)');
    if (!sec.rateLimit('test-mail', ctx.user.id, 5, 600).ok) throw err(429, 'Bir az sonra yenidən cəhd edin');
    try { await mail.smtpSend({ to: ctx.user.email, subject: 'AEEC Admin — sınaq məktubu', text: 'Bu, AEEC idarəetmə panelindən göndərilən sınaq məktubudur. E-poçt göndərişi düzgün işləyir.' }); }
    catch (e) { throw err(409, `Göndərilmədi: ${String(e.message).slice(0, 200)}`); }
    ctx.json({ ok: true, to: ctx.user.email });
  });
  app.get('/api/system', can('settings.view', 'settings.manage'), (ctx) => {
    const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const dirSize = (d) => { try { return fs.readdirSync(d).reduce((a, f) => a + size(path.join(d, f)), 0); } catch { return 0; } };
    ctx.json({ version: require('../../package.json').version, node: process.version, smtp: mail.isConfigured(), smtp_from: config.smtp.from, base_url: config.baseUrl, site_url: config.siteUrl,
      db_size: size(config.dbFile), uploads_size: dirSize(config.uploadDir) + dirSize(config.privateDir), cookie_secure: config.cookieSecure,
      mail_failed: get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed'").n, mail_pending: get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").n,
      client_ip: ctx.ip, client_ip_problem: config.baseUrl.startsWith('https://') ? proxyProblem(ctx.ip) : '', // locally 127.0.0.1 is correct mail_transport: mail.transport(), site_dir: config.siteDir,
      session_idle_min: config.session.idleMin, login_max_fails: config.login.maxFails, login_lock_min: config.login.lockMin, password_min: config.passwordMinLength, max_upload_mb: config.maxUploadMb });
  });

  /* -------------------------------------------------------------- SEO */
  const seoText = { seo_title: v.str({ max: 120 }), meta_description: v.str({ max: 300 }), keywords: v.str({ max: 300 }), og_title: v.str({ max: 120 }), og_description: v.str({ max: 300 }) };
  defineResource(app, {
    name: 'seo', path: '/api/seo-pages', table: 'seo_pages', module: 'SEO', noCreatedAt: true,
    perms: { view: 'seo.manage', create: 'seo.manage', edit: 'seo.manage', delete: 'seo.manage' },
    shape: { ...seoText, name: v.str({ max: 120, required: true }), path: v.str({ max: 200, required: true, pattern: /^\/[A-Za-z0-9\-_/.]*$/, message: 'Yol / ilə başlamalıdır (məs. /haqqimizda/)' }),
      og_image_media_id: v.int({ min: 1 }), canonical: v.url(), in_sitemap: v.bool({ default: true }), sort_order: v.int({ min: 0, max: 100000, default: 0 }), i18n: v.i18n(seoText) },
    jsonCols: ['i18n'], mediaCols: ['og_image_media_id'], search: ['name', 'path', 'seo_title'], sortable: { name: 'fold(name)', path: 'path', order: 'sort_order' }, defaultSort: 'sort_order ASC, id ASC',
    label: (r) => `SEO «${r.name}» (${r.path})`,
    prepare(ctx, d, existing) { if (d.path && get('SELECT id FROM seo_pages WHERE path = ? AND id <> ?', d.path, existing ? existing.id : 0)) throw err(422, 'Bu yol artıq mövcuddur', { fields: { path: 'Bu yol artıq mövcuddur' } }); },
    present: (r) => ({ ...r, og_image: mediaById(r.og_image_media_id) }),
  });

  /* ---------------------------------------------------------- backups */
  app.get('/api/backups', superOnly, (ctx) => {
    const items = all('SELECT b.*, u.name AS user_name FROM backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 60');
    ctx.json({ items, settings: getSetting('backup'), last: items.find((x) => x.status === 'ok') || null, last_any: items[0] || null });
  });
  app.post('/api/backups', superOnly, async (ctx) => {
    if (!sec.rateLimit('backup', 'manual', 6, 3600).ok) throw err(429, 'Saatda ən çox 6 əl ilə nüsxə yaratmaq olar');
    let row;
    try { row = await backup.createBackup('manual', ctx.user.id); }
    catch (e) { audit(ctx, { action: 'Ehtiyat nüsxə (uğursuz)', module: 'Ehtiyat nüsxə', summary: String(e.message).slice(0, 200) }); throw err(409, `Nüsxə yaradılmadı: ${String(e.message).slice(0, 200)}`); }
    audit(ctx, { action: 'Ehtiyat nüsxə yaradıldı', module: 'Ehtiyat nüsxə', recordId: row.id, summary: `${ctx.user.name} əl ilə ehtiyat nüsxə yaratdı (${row.message})` });
    ctx.json({ item: row }, 201);
  });
  app.get('/api/backups/:id/download', superOnly, (ctx) => {
    const row = get("SELECT * FROM backups WHERE id = ? AND status = 'ok'", ctx.intParam('id'));
    const list = row ? row.file.split(',') : [];
    const f = list[ctx.query.part === 'files' ? 1 : 0];
    if (!f || !backup.NAME.test(f)) throw err(404, 'Nüsxə tapılmadı');
    audit(ctx, { action: 'Ehtiyat nüsxə yükləndi', module: 'Ehtiyat nüsxə', recordId: row.id, summary: `${ctx.user.name} nüsxə faylını yüklədi: ${f}` });
    sendFile(ctx, config.backupDir, f, { type: 'application/gzip', download: f, cache: 'private, no-store' });
  });
  app.delete('/api/backups/:id', superOnly, (ctx) => {
    const row = get('SELECT * FROM backups WHERE id = ?', ctx.intParam('id'));
    if (!row) throw err(404, 'Nüsxə tapılmadı');
    backup.removeFiles(row);
    run('DELETE FROM backups WHERE id = ?', row.id);
    audit(ctx, { action: 'Ehtiyat nüsxə silindi', module: 'Ehtiyat nüsxə', recordId: row.id, summary: `${ctx.user.name} nüsxəni sildi: ${row.file}` });
    ctx.json({ ok: true });
  });
};
