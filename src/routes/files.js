'use strict';
// Media library and document management.
const config = require('../config');
const siteNews = require('../site-news');
const { get, all, run, tx, now } = require('../db');
const { err, sendFile, FILE_CSP } = require('../http');
const { v, validate } = require('../validate');
const { can } = require('../auth');
const { audit, diff } = require('../audit');
const { defineResource, listRows } = require('../crud');
const files = require('../files');

const DOC_CATEGORIES = { company: 'Şirkət sənədləri', certificates: 'Sertifikatlar', reports: 'Hesabatlar', publications: 'Nəşrlər', technical: 'Texniki sənədlər', presentations: 'Təqdimatlar' };
const bodyLimit = () => (config.maxUploadMb + 1) * files.MB;

const presentMedia = (m) => ({ id: m.id, kind: m.kind, name: m.original_name, url: files.mediaUrl(m), mime: m.mime, ext: m.ext, size: m.size, folder: m.folder, alt: m.alt, created_at: m.created_at });
// Where a library item is referenced (shown before deletion).
function mediaUsage(id) {
  const out = [];
  const add = (sql, label) => { for (const r of all(sql, id)) out.push(`${label}: ${r.t}`); };
  add('SELECT title AS t FROM news WHERE cover_media_id = ?', 'Xəbər');
  add('SELECT name AS t FROM projects WHERE main_media_id = ?', 'Layihə');
  add('SELECT title AS t FROM services WHERE image_media_id = ?', 'Xidmət');
  add('SELECT name AS t FROM team_members WHERE photo_media_id = ?', 'Əməkdaş');
  add('SELECT name AS t FROM seo_pages WHERE og_image_media_id = ?', 'SEO səhifəsi');
  for (const [table, col, label] of [['news', 'title', 'Xəbər qalereyası'], ['projects', 'name', 'Layihə qalereyası']]) {
    for (const r of all(`SELECT ${col} AS t, gallery FROM ${table} WHERE gallery LIKE ?`, `%${id}%`)) {
      try { if (JSON.parse(r.gallery).includes(id)) out.push(`${label}: ${r.t}`); } catch { /* ignore */ }
    }
  }
  return out;
}

module.exports = (app) => {
  /* ------------------------------------------------------------ media */
  const mediaDef = {
    table: 'media', search: ['original_name', 'alt', 'folder'],
    filters: { kind: { col: 'kind', values: ['image', 'video', 'file'] }, folder: { col: 'folder' }, ext: { col: 'ext' } },
    dateCol: 'created_at', sortable: { name: 'fold(original_name)', size: 'size', date: 'created_at' }, defaultSort: 'created_at DESC, id DESC',
  };
  app.get('/api/media', can('media.view'), (ctx) => {
    const r = listRows(mediaDef, ctx.query, { where: ['is_private = 0'] });
    ctx.json({ items: r.rows.map(presentMedia), total: r.total, page: r.page, per_page: r.perPage,
      folders: all("SELECT DISTINCT folder FROM media WHERE is_private = 0 AND folder <> '' ORDER BY folder").map((x) => x.folder),
      allowed: files.MEDIA_EXT, max_mb: config.maxUploadMb });
  });
  app.post('/api/media', can('media.upload'), async (ctx) => {
    const form = await ctx.readForm(bodyLimit());
    const file = form.get('file');
    const m = await files.storeUpload(file, { userId: ctx.user.id, folder: String(form.get('folder') || '') });
    audit(ctx, { action: 'Fayl yükləmə', module: 'Media', recordId: m.id, summary: `${ctx.user.name} yüklədi: ${m.original_name}`, next: { name: m.original_name, size: m.size } });
    ctx.json({ item: presentMedia(m) }, 201);
  });
  app.get('/api/media/:id', can('media.view'), (ctx) => {
    const m = get('SELECT * FROM media WHERE id = ? AND is_private = 0', ctx.intParam('id'));
    if (!m) throw err(404, 'Fayl tapılmadı');
    ctx.json({ item: presentMedia(m), usage: mediaUsage(m.id) });
  });
  app.put('/api/media/:id', can('media.edit'), async (ctx) => {
    const id = ctx.intParam('id');
    const before = get('SELECT * FROM media WHERE id = ? AND is_private = 0', id);
    if (!before) throw err(404, 'Fayl tapılmadı');
    const b = validate({ name: v.str({ max: 150, required: true }), alt: v.str({ max: 300 }), folder: v.str({ max: 60 }) }, await ctx.readJson(4096));
    // Renaming changes the display name only; the extension and the stored file never change.
    const base = b.name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[A-Za-z0-9]{2,5}$/, '');
    run('UPDATE media SET original_name = ?, alt = ?, folder = ? WHERE id = ?', `${base || 'fayl'}.${before.ext}`, b.alt, b.folder, id);
    const after = get('SELECT * FROM media WHERE id = ?', id);
    const d = diff(before, after);
    if (d.changed) audit(ctx, { action: 'Redaktə', module: 'Media', recordId: id, summary: `${ctx.user.name}: ${after.original_name}`, prev: d.prev, next: d.next });
    siteNews.schedule('media dəyişdi');
    ctx.json({ item: presentMedia(after) });
  });
  app.delete('/api/media/:id', can('media.delete'), (ctx) => {
    const m = get('SELECT * FROM media WHERE id = ? AND is_private = 0', ctx.intParam('id'));
    if (!m) throw err(404, 'Fayl tapılmadı');
    const usage = mediaUsage(m.id);
    if (usage.length && ctx.query.force !== '1') throw err(409, 'Bu fayl istifadə olunur', { code: 'in_use', fields: { usage: usage.slice(0, 10).join('; ') } });
    tx(() => {
      files.removeMedia(m);
      audit(ctx, { action: 'Silmə', module: 'Media', recordId: m.id, summary: `${ctx.user.name} sildi: ${m.original_name}`, prev: { name: m.original_name, size: m.size } });
    });
    siteNews.schedule('media silindi');
    ctx.json({ ok: true });
  });
  // Public media files (images used on the website).
  app.get('/media/:name', (ctx) => {
    const name = ctx.params.name;
    if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(name)) throw err(404, 'Tapılmadı');
    const ext = name.split('.').pop();
    if (!get('SELECT id FROM media WHERE stored_name = ? AND is_private = 0', name)) throw err(404, 'Tapılmadı');
    ctx.res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    sendFile(ctx, config.uploadDir, name, { cache: 'public, max-age=31536000, immutable', csp: FILE_CSP, type: Object.hasOwn(files.TYPES, ext) ? files.TYPES[ext].mime : undefined, download: files.INLINE_EXT.has(ext) ? undefined : name });
  });

  /* -------------------------------------------------------- documents */
  const docText = { title: v.str({ max: 200 }), description: v.text({ max: 1000 }) };
  const docShape = { title: v.str({ max: 200, required: true }), description: v.text({ max: 1000 }), category: v.oneOf(Object.keys(DOC_CATEGORIES), { default: 'company' }),
    visibility: v.oneOf(['public', 'internal'], { default: 'internal' }), i18n: v.i18n(docText) };
  const presentDoc = (d) => {
    const m = get('SELECT original_name, ext, size, mime FROM media WHERE id = ?', d.file_media_id) || {};
    return { ...d, file_name: m.original_name || '', ext: m.ext || '', size: m.size || 0, previewable: files.INLINE_EXT.has(m.ext), category_label: DOC_CATEGORIES[d.category] || d.category };
  };
  // Upload = multipart (file + fields). Editing metadata afterwards goes through the generic PUT.
  app.post('/api/documents', can('documents.create'), async (ctx) => {
    const form = await ctx.readForm(bodyLimit());
    let i18n = {};
    try { i18n = JSON.parse(String(form.get('i18n') || '{}')); } catch { /* ignore */ }
    const data = validate(docShape, { title: form.get('title'), description: form.get('description'), category: form.get('category'), visibility: form.get('visibility'), i18n });
    const m = await files.storeUpload(form.get('file'), { allowed: files.DOC_EXT, isPrivate: true, userId: ctx.user.id });
    const id = tx(() => {
      const rid = run('INSERT INTO documents (title, category, description, file_media_id, visibility, i18n, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        data.title, data.category, data.description, m.id, data.visibility, JSON.stringify(data.i18n), ctx.user.id, now(), now()).lastInsertRowid;
      audit(ctx, { action: 'Fayl yükləmə', module: 'Sənədlər', recordId: rid, summary: `${ctx.user.name} sənəd yüklədi: ${data.title}`, next: { title: data.title, file: m.original_name, visibility: data.visibility } });
      return rid;
    });
    ctx.json({ item: presentDoc(get('SELECT * FROM documents WHERE id = ?', id)) }, 201);
  });
  defineResource(app, {
    name: 'documents', path: '/api/documents', table: 'documents', module: 'Sənədlər',
    perms: { view: 'documents.view', edit: 'documents.edit', delete: 'documents.delete' },
    shape: docShape, jsonCols: ['i18n'],
    search: ['title', 'description'],
    filters: { category: { col: 'category', values: Object.keys(DOC_CATEGORIES) }, visibility: { col: 'visibility', values: ['public', 'internal'] } },
    dateCol: 'created_at', sortable: { title: 'fold(title)', category: 'category', date: 'created_at', visibility: 'visibility', downloads: 'downloads' },
    defaultSort: 'created_at DESC, id DESC',
    label: (r) => `Sənəd #${r.id} «${r.title}»`,
    actionName: (a, b) => (a.visibility !== b.visibility ? 'Görünmə dəyişikliyi' : 'Redaktə'),
    present: presentDoc,
    afterDelete: (ctx, row) => files.removeMedia(get('SELECT * FROM media WHERE id = ?', row.file_media_id)),
    extra(a) {
      a.get('/api/documents/meta', can('documents.view'), (ctx) => ctx.json({ categories: DOC_CATEGORIES, allowed: files.DOC_EXT, max_mb: config.maxUploadMb }));
      a.get('/api/documents/:id/download', can('documents.view'), (ctx) => {
        const d = get('SELECT * FROM documents WHERE id = ?', ctx.intParam('id'));
        const m = d && get('SELECT * FROM media WHERE id = ? AND is_private = 1', d.file_media_id);
        if (!m) throw err(404, 'Sənəd tapılmadı');
        const inline = ctx.query.inline === '1' && files.INLINE_EXT.has(m.ext);
        sendFile(ctx, config.privateDir, m.stored_name, { type: m.mime, csp: FILE_CSP, download: m.original_name, inline, cache: 'private, no-store' });
      });
    },
  });
};
module.exports.DOC_CATEGORIES = DOC_CATEGORIES;
