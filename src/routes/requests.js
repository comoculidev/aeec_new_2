'use strict';
// "Layihənizi müzakirə edək" requests (leads) and contact-form requests: admin side.
const config = require('../config');
const { get, all, run, tx, now } = require('../db');
const { err, sendFile, FILE_CSP } = require('../http');
const { v, validate } = require('../validate');
const { can } = require('../auth');
const { audit } = require('../audit');
const { listRows, TZ, isDay } = require('../crud');
const { sendExport } = require('../xlsx');
const { queueMail, isConfigured } = require('../mail');
const { getSetting } = require('../settings');
const { notify } = require('../notify');
const files = require('../files');

const LEAD_STATUS = { new: 'Yeni', contacted: 'Əlaqə saxlanılıb', discussion: 'Müzakirədə', proposal: 'Təklif göndərilib', won: 'Qazanılıb', lost: 'İtirilib', archived: 'Arxiv' };
const CONTACT_STATUS = { new: 'Yeni', read: 'Oxunub', replied: 'Cavablandırılıb', closed: 'Bağlı' };
const day = (iso) => (iso ? new Date(Date.parse(iso) + config.tzOffsetMin * 60000).toISOString().replace('T', ' ').slice(0, 16) : '');

const leadDef = {
  from: 'project_requests pr LEFT JOIN users u ON u.id = pr.assigned_to', select: 'pr.*, u.name AS assigned_name', idCol: 'pr.id',
  search: ['pr.first_name', 'pr.last_name', 'pr.company', 'pr.project_name', 'pr.email', 'pr.phone'],
  filters: { status: { col: 'pr.status', values: Object.keys(LEAD_STATUS) }, assigned_to: { col: 'pr.assigned_to', int: true }, direction: { col: 'pr.direction' } },
  dateCol: 'pr.created_at',
  sortable: { id: 'pr.id', name: 'fold(pr.first_name)', company: 'fold(pr.company)', project: 'fold(pr.project_name)', date: 'pr.created_at', status: 'pr.status', follow_up: 'pr.follow_up_date' },
  defaultSort: 'pr.created_at DESC, pr.id DESC',
};
const contactDef = {
  from: 'contact_requests', search: ['name', 'company', 'email', 'phone', 'subject', 'message'],
  filters: { status: { col: 'status', values: Object.keys(CONTACT_STATUS) } }, dateCol: 'created_at',
  sortable: { id: 'id', name: 'fold(name)', subject: 'fold(subject)', date: 'created_at', status: 'status' }, defaultSort: 'created_at DESC, id DESC',
};
const notesOf = (type, id) => all('SELECT id, kind, body, user_name, created_at FROM request_notes WHERE request_type = ? AND request_id = ? ORDER BY id DESC', type, id);
const addNote = (ctx, type, id, kind, body) => run('INSERT INTO request_notes (request_type, request_id, kind, body, user_id, user_name, created_at) VALUES (?,?,?,?,?,?,?)', type, id, kind, body, ctx.user.id, ctx.user.name, now());

// Lead totals and the conversion funnel for a date range (local days, inclusive).
function leadStats(from, to, visitors) {
  const where = [], p = [];
  if (isDay(from)) { where.push(`date(created_at, '${TZ}') >= ?`); p.push(from); }
  if (isDay(to)) { where.push(`date(created_at, '${TZ}') <= ?`); p.push(to); }
  const rows = all(`SELECT status, COUNT(*) AS n FROM project_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY status`, ...p);
  const by = Object.fromEntries(Object.keys(LEAD_STATUS).map((k) => [k, 0]));
  for (const r of rows) by[r.status] = r.n;
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  // A lead that reached a later stage is counted in the earlier ones as well.
  const discussion = by.discussion + by.proposal + by.won, proposal = by.proposal + by.won, won = by.won;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const funnel = [
    { key: 'visitor', label: 'Ziyarətçi', value: visitors || 0, rate: null },
    { key: 'inquiry', label: 'Sorğu', value: total, rate: pct(total, visitors) },
    { key: 'discussion', label: 'Müzakirə', value: discussion, rate: pct(discussion, total) },
    { key: 'proposal', label: 'Təklif', value: proposal, rate: pct(proposal, discussion) },
    { key: 'project', label: 'Layihə', value: won, rate: pct(won, proposal) },
  ];
  return { total, by_status: by, funnel };
}

module.exports = (app) => {
  /* ------------------------------------------------------------ leads */
  app.get('/api/leads', can('leads.view'), (ctx) => {
    const r = listRows(leadDef, ctx.query);
    ctx.json({ items: r.rows, total: r.total, page: r.page, per_page: r.perPage, statuses: LEAD_STATUS,
      directions: all("SELECT DISTINCT direction FROM project_requests WHERE direction <> '' ORDER BY direction").map((x) => x.direction),
      counts: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM project_requests GROUP BY status').map((x) => [x.status, x.n])) });
  });
  app.get('/api/leads/export', can('leads.export'), (ctx) => {
    const r = listRows(leadDef, ctx.query, { all: true });
    audit(ctx, { action: `Eksport (${ctx.query.format === 'xlsx' ? 'Excel' : 'CSV'})`, module: 'Layihə sorğuları', summary: `${r.rows.length} sətir eksport edildi` });
    sendExport(ctx, { name: 'layihe-sorgulari', format: ctx.query.format, rows: r.rows, columns: [
      { label: 'ID', get: (x) => x.id }, { label: 'Tarix', get: (x) => day(x.created_at) }, { label: 'Ad', get: (x) => x.first_name }, { label: 'Soyad', get: (x) => x.last_name },
      { label: 'Şirkət', get: (x) => x.company }, { label: 'Vəzifə', get: (x) => x.position }, { label: 'E-poçt', get: (x) => x.email }, { label: 'Telefon', get: (x) => x.phone },
      { label: 'Layihənin adı', get: (x) => x.project_name }, { label: 'İstiqamət', get: (x) => x.direction }, { label: 'Büdcə', get: (x) => x.budget }, { label: 'Təsvir', get: (x) => x.description },
      { label: 'Əlavə qeyd', get: (x) => x.note }, { label: 'Status', get: (x) => LEAD_STATUS[x.status] }, { label: 'Məsul şəxs', get: (x) => x.assigned_name || '' },
      { label: 'Növbəti əlaqə', get: (x) => x.follow_up_date || '' }, { label: 'Razılıq', get: (x) => (x.consent ? 'Bəli' : 'Xeyr') },
    ] });
  });
  app.get('/api/leads/stats', can('leads.view'), (ctx) => ctx.json(leadStats(ctx.query.from, ctx.query.to)));
  app.get('/api/leads/assignees', can('leads.view'), (ctx) => {
    const { usersWith } = require('../permissions');
    ctx.json({ items: usersWith('leads.view').map((u) => ({ id: u.id, name: u.name })) });
  });
  const loadLead = (id) => get('SELECT pr.*, u.name AS assigned_name FROM project_requests pr LEFT JOIN users u ON u.id = pr.assigned_to WHERE pr.id = ?', id);
  app.get('/api/leads/:id', can('leads.view'), (ctx) => {
    const lead = loadLead(ctx.intParam('id'));
    if (!lead) throw err(404, 'Sorğu tapılmadı');
    const fl = all('SELECT f.id, m.original_name AS name, m.size, m.ext FROM project_request_files f JOIN media m ON m.id = f.media_id WHERE f.request_id = ?', lead.id);
    ctx.json({ item: lead, files: fl, notes: notesOf('project', lead.id), statuses: LEAD_STATUS, smtp: isConfigured() });
  });
  app.route('PATCH', '/api/leads/:id', can('leads.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    const b = validate({ status: v.oneOf(Object.keys(LEAD_STATUS)), assigned_to: v.int({ min: 0 }), follow_up_date: v.date() }, await ctx.readJson(2048), { partial: true });
    const item = tx(() => {
      const before = loadLead(id);
      if (!before) throw err(404, 'Sorğu tapılmadı');
      if ('status' in b && b.status && b.status !== before.status) {
        run('UPDATE project_requests SET status = ?, updated_at = ? WHERE id = ?', b.status, now(), id);
        addNote(ctx, 'project', id, 'status', `Status: ${LEAD_STATUS[before.status]} → ${LEAD_STATUS[b.status]}`);
        audit(ctx, { action: 'Status dəyişikliyi', module: 'Layihə sorğuları', recordId: id, summary: `${ctx.user.name} sorğu #${id} statusunu dəyişdi`, prev: LEAD_STATUS[before.status], next: LEAD_STATUS[b.status] });
      }
      if ('assigned_to' in b && (b.assigned_to || null) !== before.assigned_to) {
        const target = b.assigned_to ? get('SELECT id, name, is_active FROM users WHERE id = ?', b.assigned_to) : null;
        if (b.assigned_to && (!target || !target.is_active)) throw err(422, 'İstifadəçi tapılmadı', { fields: { assigned_to: 'İstifadəçi tapılmadı' } });
        run('UPDATE project_requests SET assigned_to = ?, updated_at = ? WHERE id = ?', target ? target.id : null, now(), id);
        addNote(ctx, 'project', id, 'assign', `Məsul şəxs: ${before.assigned_name || 'təyin olunmayıb'} → ${target ? target.name : 'təyin olunmayıb'}`);
        audit(ctx, { action: 'Məsul şəxs təyini', module: 'Layihə sorğuları', recordId: id, summary: `${ctx.user.name} sorğu #${id} üçün məsul şəxsi dəyişdi`, prev: before.assigned_name || '—', next: target ? target.name : '—' });
        if (target && target.id !== ctx.user.id) run('INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES (?,?,?,?,?,?)', target.id, 'assigned', 'Sizə sorğu təyin olundu', `${before.first_name} ${before.last_name} — ${before.project_name || before.company}`.trim(), `#/layihe-sorgulari/${id}`, now());
      }
      if ('follow_up_date' in b && (b.follow_up_date || null) !== before.follow_up_date) {
        run('UPDATE project_requests SET follow_up_date = ?, updated_at = ? WHERE id = ?', b.follow_up_date, now(), id);
        addNote(ctx, 'project', id, 'followup', `Növbəti əlaqə tarixi: ${b.follow_up_date || 'silindi'}`);
      }
      return loadLead(id);
    });
    ctx.json({ item, notes: notesOf('project', id) });
  });
  app.post('/api/leads/:id/notes', can('leads.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    if (!get('SELECT id FROM project_requests WHERE id = ?', id)) throw err(404, 'Sorğu tapılmadı');
    const b = validate({ body: v.text({ max: 4000, required: true }) }, await ctx.readJson(16384));
    addNote(ctx, 'project', id, 'note', b.body);
    audit(ctx, { action: 'Qeyd əlavə edildi', module: 'Layihə sorğuları', recordId: id, summary: `${ctx.user.name} sorğu #${id} üçün qeyd yazdı` });
    ctx.json({ notes: notesOf('project', id) }, 201);
  });
  const replyShape = { subject: v.str({ max: 200, required: true }), body: v.text({ max: 10000, required: true }) };
  app.post('/api/leads/:id/email', can('leads.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    const lead = loadLead(id);
    if (!lead) throw err(404, 'Sorğu tapılmadı');
    if (!isConfigured()) throw err(409, 'E-poçt göndərişi (SMTP) hələ qurulmayıb');
    const b = validate(replyShape, await ctx.readJson(32768));
    queueMail({ to: lead.email, subject: b.subject, text: b.body, replyTo: getSetting('contact').email });
    tx(() => {
      addNote(ctx, 'project', id, 'email', `E-poçt göndərildi — ${b.subject}\n\n${b.body}`);
      if (lead.status === 'new') { run("UPDATE project_requests SET status = 'contacted', updated_at = ? WHERE id = ?", now(), id); addNote(ctx, 'project', id, 'status', `Status: ${LEAD_STATUS.new} → ${LEAD_STATUS.contacted}`); }
      audit(ctx, { action: 'E-poçt göndərildi', module: 'Layihə sorğuları', recordId: id, summary: `${ctx.user.name} sorğu #${id} müəllifinə e-poçt göndərdi`, next: { subject: b.subject } });
    });
    ctx.json({ item: loadLead(id), notes: notesOf('project', id) });
  });
  app.get('/api/leads/:id/files/:fid', can('leads.view'), (ctx) => {
    const m = get('SELECT m.* FROM project_request_files f JOIN media m ON m.id = f.media_id WHERE f.request_id = ? AND f.id = ? AND m.is_private = 1', ctx.intParam('id'), ctx.intParam('fid'));
    if (!m) throw err(404, 'Fayl tapılmadı');
    sendFile(ctx, config.privateDir, m.stored_name, { type: m.mime, csp: FILE_CSP, download: m.original_name, inline: ctx.query.inline === '1' && files.INLINE_EXT.has(m.ext), cache: 'private, no-store' });
  });
  app.delete('/api/leads/:id', can('leads.delete'), (ctx) => {
    const id = ctx.intParam('id');
    const lead = loadLead(id);
    if (!lead) throw err(404, 'Sorğu tapılmadı');
    const media = all('SELECT m.* FROM project_request_files f JOIN media m ON m.id = f.media_id WHERE f.request_id = ?', id);
    tx(() => {
      run("DELETE FROM request_notes WHERE request_type = 'project' AND request_id = ?", id);
      run('DELETE FROM project_requests WHERE id = ?', id);
      media.forEach(files.removeMedia);
      audit(ctx, { action: 'Silmə', module: 'Layihə sorğuları', recordId: id, summary: `${ctx.user.name} sorğu #${id} sildi (${lead.first_name} ${lead.last_name}, ${lead.company})` });
    });
    ctx.json({ ok: true });
  });

  /* --------------------------------------------------------- contacts */
  app.get('/api/contacts', can('contacts.view'), (ctx) => {
    const r = listRows(contactDef, ctx.query);
    ctx.json({ items: r.rows, total: r.total, page: r.page, per_page: r.perPage, statuses: CONTACT_STATUS,
      counts: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM contact_requests GROUP BY status').map((x) => [x.status, x.n])) });
  });
  app.get('/api/contacts/export', can('contacts.export'), (ctx) => {
    const r = listRows(contactDef, ctx.query, { all: true });
    audit(ctx, { action: `Eksport (${ctx.query.format === 'xlsx' ? 'Excel' : 'CSV'})`, module: 'Əlaqə sorğuları', summary: `${r.rows.length} sətir eksport edildi` });
    sendExport(ctx, { name: 'elaqe-sorgulari', format: ctx.query.format, rows: r.rows, columns: [
      { label: 'ID', get: (x) => x.id }, { label: 'Tarix', get: (x) => day(x.created_at) }, { label: 'Ad', get: (x) => x.name }, { label: 'Şirkət', get: (x) => x.company },
      { label: 'E-poçt', get: (x) => x.email }, { label: 'Telefon', get: (x) => x.phone }, { label: 'Mövzu', get: (x) => x.subject }, { label: 'Mesaj', get: (x) => x.message },
      { label: 'Status', get: (x) => CONTACT_STATUS[x.status] }, { label: 'Razılıq', get: (x) => (x.consent ? 'Bəli' : 'Xeyr') },
    ] });
  });
  app.get('/api/contacts/:id', can('contacts.view'), (ctx) => {
    const c = get('SELECT * FROM contact_requests WHERE id = ?', ctx.intParam('id'));
    if (!c) throw err(404, 'Müraciət tapılmadı');
    ctx.json({ item: c, notes: notesOf('contact', c.id), statuses: CONTACT_STATUS, smtp: isConfigured() });
  });
  app.route('PATCH', '/api/contacts/:id', can('contacts.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    const b = validate({ status: v.oneOf(Object.keys(CONTACT_STATUS), { required: true }) }, await ctx.readJson(1024));
    const before = get('SELECT * FROM contact_requests WHERE id = ?', id);
    if (!before) throw err(404, 'Müraciət tapılmadı');
    if (b.status !== before.status) tx(() => {
      run('UPDATE contact_requests SET status = ?, updated_at = ? WHERE id = ?', b.status, now(), id);
      addNote(ctx, 'contact', id, 'status', `Status: ${CONTACT_STATUS[before.status]} → ${CONTACT_STATUS[b.status]}`);
      audit(ctx, { action: 'Status dəyişikliyi', module: 'Əlaqə sorğuları', recordId: id, summary: `${ctx.user.name} müraciət #${id} statusunu dəyişdi`, prev: CONTACT_STATUS[before.status], next: CONTACT_STATUS[b.status] });
    });
    ctx.json({ item: get('SELECT * FROM contact_requests WHERE id = ?', id), notes: notesOf('contact', id) });
  });
  app.post('/api/contacts/:id/notes', can('contacts.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    if (!get('SELECT id FROM contact_requests WHERE id = ?', id)) throw err(404, 'Müraciət tapılmadı');
    const b = validate({ body: v.text({ max: 4000, required: true }) }, await ctx.readJson(16384));
    addNote(ctx, 'contact', id, 'note', b.body);
    ctx.json({ notes: notesOf('contact', id) }, 201);
  });
  app.post('/api/contacts/:id/email', can('contacts.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    const c = get('SELECT * FROM contact_requests WHERE id = ?', id);
    if (!c) throw err(404, 'Müraciət tapılmadı');
    if (!isConfigured()) throw err(409, 'E-poçt göndərişi (SMTP) hələ qurulmayıb');
    const b = validate(replyShape, await ctx.readJson(32768));
    queueMail({ to: c.email, subject: b.subject, text: b.body, replyTo: getSetting('contact').email });
    tx(() => {
      addNote(ctx, 'contact', id, 'email', `E-poçt göndərildi — ${b.subject}\n\n${b.body}`);
      if (c.status !== 'replied') { run("UPDATE contact_requests SET status = 'replied', updated_at = ? WHERE id = ?", now(), id); addNote(ctx, 'contact', id, 'status', `Status: ${CONTACT_STATUS[c.status]} → ${CONTACT_STATUS.replied}`); }
      audit(ctx, { action: 'E-poçt göndərildi', module: 'Əlaqə sorğuları', recordId: id, summary: `${ctx.user.name} müraciət #${id} müəllifinə cavab göndərdi`, next: { subject: b.subject } });
    });
    ctx.json({ item: get('SELECT * FROM contact_requests WHERE id = ?', id), notes: notesOf('contact', id) });
  });
  app.delete('/api/contacts/:id', can('contacts.delete'), (ctx) => {
    const id = ctx.intParam('id');
    const c = get('SELECT * FROM contact_requests WHERE id = ?', id);
    if (!c) throw err(404, 'Müraciət tapılmadı');
    tx(() => {
      run("DELETE FROM request_notes WHERE request_type = 'contact' AND request_id = ?", id);
      run('DELETE FROM contact_requests WHERE id = ?', id);
      audit(ctx, { action: 'Silmə', module: 'Əlaqə sorğuları', recordId: id, summary: `${ctx.user.name} müraciət #${id} sildi (${c.name})` });
    });
    ctx.json({ ok: true });
  });
};
Object.assign(module.exports, { LEAD_STATUS, CONTACT_STATUS, leadStats });
