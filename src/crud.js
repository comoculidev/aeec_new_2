'use strict';
// Generic resource routes: list (search, filters, date range, sorting, pagination), read,
// create, update (full or partial), delete and export. Column names used in SQL always come
// from the resource definition (an allow-list), never from the request.
const config = require('./config');
const { db, get, all, run, tx, now } = require('./db');
const { err } = require('./http');
const { validate } = require('./validate');
const { can } = require('./auth');
const { audit, diff } = require('./audit');
const { sendExport } = require('./xlsx');

// Search folding: case-insensitive and tolerant of Azerbaijani letters typed without diacritics
// (ə→e, ş→s, ç→c, ğ→g, ö→o, ü→u, ı/İ→i), so "sirket" finds "Şirkət".
const AZ = { 'ə': 'e', 'ı': 'i', 'ö': 'o', 'ü': 'u', 'ç': 'c', 'ş': 's', 'ğ': 'g' };
const fold = (s) => String(s == null ? '' : s).toLowerCase().replace(/\u0307/g, '').replace(/[əıöüçşğ]/g, (c) => AZ[c]);
db.function('fold', { deterministic: true }, (s) => fold(s));
const likeParam = (q) => '%' + fold(q).replace(/[\\%_]/g, '\\$&') + '%';
const TZ = `${config.tzOffsetMin >= 0 ? '+' : ''}${config.tzOffsetMin} minutes`;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function slugify(s) {
  return fold(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
function uniqueSlug(table, base, exceptId) {
  base = base || 'qeyd';
  for (let i = 1; i < 500; i++) {
    const s = i === 1 ? base : `${base}-${i}`;
    if (!get(`SELECT id FROM ${table} WHERE slug = ? AND id <> ?`, s, exceptId || 0)) return s;
  }
  return `${base}-${Date.now()}`;
}

// Builds WHERE/ORDER/LIMIT from request query according to the definition.
function buildList(def, query, extraWhere = [], extraParams = []) {
  const where = [...extraWhere], params = [...extraParams];
  const q = String(query.q || '').trim().slice(0, 100);
  if (q && def.search && def.search.length) {
    where.push('(' + def.search.map((c) => `fold(${c}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    for (let i = 0; i < def.search.length; i++) params.push(likeParam(q));
  }
  for (const [name, f] of Object.entries(def.filters || {})) {
    const val = query[name];
    if (val === undefined || val === '') continue;
    if (f.values && !f.values.includes(String(val))) throw err(422, `Filtr dəyəri yolverilməzdir: ${name}`);
    where.push(`${f.col} = ?`);
    params.push(f.int ? parseInt(val, 10) || 0 : String(val).slice(0, 120));
  }
  if (def.dateCol) {
    if (isDay(query.from)) { where.push(`date(${def.dateCol}, '${TZ}') >= ?`); params.push(query.from); }
    if (isDay(query.to)) { where.push(`date(${def.dateCol}, '${TZ}') <= ?`); params.push(query.to); }
  }
  let order = def.defaultSort;
  const sort = String(query.sort || '');
  const key = sort.replace(/^-/, '');
  if (key && def.sortable && Object.hasOwn(def.sortable, key)) order = `${def.sortable[key]} ${sort.startsWith('-') ? 'DESC' : 'ASC'}, ${def.idCol || 'id'} DESC`;
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page, 10) || 20));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, order, perPage, page };
}
function listRows(def, query, opts = {}) {
  const b = buildList(def, query, opts.where, opts.params);
  const from = def.from || def.table;
  const total = get(`SELECT COUNT(*) AS n FROM ${from} ${b.whereSql}`, ...b.params).n;
  const limit = opts.all ? Math.min(total, 20000) : b.perPage;
  const offset = opts.all ? 0 : (b.page - 1) * b.perPage;
  const rows = all(`SELECT ${def.select || '*'} FROM ${from} ${b.whereSql} ORDER BY ${b.order} LIMIT ? OFFSET ?`, ...b.params, limit, offset);
  return { rows, total, page: b.page, perPage: b.perPage };
}

function parseJsonCols(def, row) {
  if (!row) return row;
  for (const c of def.jsonCols || []) { try { row[c] = JSON.parse(row[c] || 'null'); } catch { row[c] = null; } if (row[c] === null) row[c] = c === 'i18n' ? {} : []; }
  return row;
}
function toDb(def, data) {
  const out = {};
  for (const [k, val] of Object.entries(data)) out[k] = (def.jsonCols || []).includes(k) ? JSON.stringify(val) : val;
  return out;
}

// Referenced media must exist and be public library items.
function checkMedia(def, data) {
  for (const col of def.mediaCols || []) {
    if (data[col] && !get('SELECT id FROM media WHERE id = ? AND is_private = 0', data[col])) throw err(422, 'Seçilmiş fayl tapılmadı', { fields: { [col]: 'Seçilmiş fayl tapılmadı' } });
  }
  for (const col of def.mediaListCols || []) {
    if (Array.isArray(data[col])) data[col] = data[col].filter((id) => get('SELECT id FROM media WHERE id = ? AND is_private = 0', id));
  }
}

function defineResource(app, def) {
  const P = def.perms;
  const present = (row) => (def.present ? def.present(parseJsonCols(def, { ...row })) : parseJsonCols(def, { ...row }));
  const load = (id) => get(`SELECT * FROM ${def.table} WHERE id = ?`, id);
  const label = (r) => (def.label ? def.label(r) : `#${r.id}`);

  app.get(def.path, can(P.view), (ctx) => {
    const r = listRows(def, ctx.query);
    ctx.json({ items: r.rows.map(present), total: r.total, page: r.page, per_page: r.perPage });
  });
  if (def.exportColumns) {
    app.get(`${def.path}/export`, can(P.export || P.view), (ctx) => {
      const r = listRows(def, ctx.query, { all: true });
      audit(ctx, { action: `Eksport (${ctx.query.format === 'xlsx' ? 'Excel' : 'CSV'})`, module: def.module, summary: `${r.rows.length} sətir eksport edildi` });
      sendExport(ctx, { name: def.name, columns: def.exportColumns, rows: r.rows.map((x) => parseJsonCols(def, x)), format: ctx.query.format });
    });
  }
  if (def.extra) def.extra(app, { present, load });
  app.get(`${def.path}/:id`, can(P.view), (ctx) => {
    const row = load(ctx.intParam('id'));
    if (!row) throw err(404, 'Qeyd tapılmadı');
    ctx.json({ item: present(row) });
  });
  if (P.create) {
    app.post(def.path, can(P.create), async (ctx) => {
      const data = validate(def.shape, await ctx.readJson(def.bodyLimit || 512 * 1024));
      const row = tx(() => {
        checkMedia(def, data);
        if (def.prepare) def.prepare(ctx, data, null);
        const d = toDb(def, { ...data, ...(def.noCreatedAt ? {} : { created_at: now() }), updated_at: now() });
        const cols = Object.keys(d);
        const id = run(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => d[c])).lastInsertRowid;
        const created = load(id);
        audit(ctx, { action: 'Yaratma', module: def.module, recordId: id, summary: `${ctx.user.name} yeni qeyd yaratdı: ${label(created)}`, next: data });
        return created;
      });
      if (def.afterSave) def.afterSave(ctx, row, null);
      ctx.json({ item: present(row) }, 201);
    });
  }
  if (P.edit) {
    const update = (partial) => async (ctx) => {
      const id = ctx.intParam('id');
      const data = validate(def.shape, await ctx.readJson(def.bodyLimit || 512 * 1024), { partial });
      let before;
      const row = tx(() => {
        before = load(id);
        if (!before) throw err(404, 'Qeyd tapılmadı');
        checkMedia(def, data);
        if (def.prepare) def.prepare(ctx, data, before);
        const d = toDb(def, { ...data, updated_at: now() });
        const cols = Object.keys(d);
        run(`UPDATE ${def.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => d[c]), id);
        const after = load(id);
        const df = diff(before, after);
        if (df.changed) audit(ctx, { action: def.actionName ? def.actionName(before, after) : 'Redaktə', module: def.module, recordId: id, summary: `${ctx.user.name}: ${label(after)}`, prev: df.prev, next: df.next });
        return after;
      });
      if (def.afterSave) def.afterSave(ctx, row, before);
      ctx.json({ item: present(row) });
    };
    app.put(`${def.path}/:id`, can(P.edit), update(false));
    app.route('PATCH', `${def.path}/:id`, can(P.edit), update(true));
    if (def.reorder) {
      // Body: { ids: [3, 1, 2] } - the new display order.
      app.post(`${def.path}/reorder`, can(P.edit), async (ctx) => {
        const b = await ctx.readJson(8192);
        if (!Array.isArray(b.ids) || b.ids.length > 500 || !b.ids.every((x) => Number.isInteger(x))) throw err(422, 'Sıra siyahısı düzgün deyil');
        tx(() => b.ids.forEach((id, i) => run(`UPDATE ${def.table} SET sort_order = ? WHERE id = ?`, i + 1, id)));
        audit(ctx, { action: 'Sıra dəyişikliyi', module: def.module, summary: `${ctx.user.name} sıranı dəyişdi`, next: { ids: b.ids } });
        ctx.json({ ok: true });
      });
    }
  }
  if (P.delete) {
    app.delete(`${def.path}/:id`, can(P.delete), (ctx) => {
      const id = ctx.intParam('id');
      const row = load(id);
      if (!row) throw err(404, 'Qeyd tapılmadı');
      tx(() => {
        if (def.beforeDelete) def.beforeDelete(ctx, row);
        run(`DELETE FROM ${def.table} WHERE id = ?`, id);
        audit(ctx, { action: 'Silmə', module: def.module, recordId: id, summary: `${ctx.user.name} sildi: ${label(row)}`, prev: parseJsonCols(def, { ...row }) });
      });
      if (def.afterDelete) def.afterDelete(ctx, row);
      ctx.json({ ok: true });
    });
  }
}

module.exports = { defineResource, buildList, listRows, parseJsonCols, slugify, uniqueSlug, fold, likeParam, TZ, isDay };
