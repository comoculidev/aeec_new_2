'use strict';
// Public endpoints used by the website itself: form intake, visit counter, read-only content,
// sitemap.xml and robots.txt. Nothing here requires a login, so every write is validated,
// rate-limited and protected against automated spam.
const config = require('../config');
const { get, all, run, tx, now } = require('../db');
const { err, sendFile, FILE_CSP } = require('../http');
const { v, validate } = require('../validate');
const { rateLimit, sha256 } = require('../security');
const { getSetting, localize, GROUPS } = require('../settings');
const { parseJsonCols } = require('../crud');
const md = require('../markdown');
const files = require('../files');
const analytics = require('../analytics');
const notify = require('../notify');

const LANGS = ['az', 'en', 'ru'];
const langOf = (ctx) => (LANGS.includes(ctx.query.lang) ? ctx.query.lang : 'az');
const allowedOrigins = () => { const s = new Set(); for (const u of [config.siteUrl, config.baseUrl, ...config.siteOrigins]) { try { s.add(new URL(u).origin); } catch { /* ignore */ } } return s; };
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const pub = (m) => (m ? { url: m.url, alt: m.alt || '', name: m.name } : null);
const page = (ctx, max = 50, def = 12) => { const per = Math.min(max, Math.max(1, parseInt(ctx.query.per_page, 10) || def)); const p = Math.max(1, parseInt(ctx.query.page, 10) || 1); return { per, p, off: (p - 1) * per }; };
const recentDuplicates = new Map();

// Accepts JSON or multipart/form-data and returns { fields, files }.
async function readSubmission(ctx, maxBytes) {
  const ct = String(ctx.req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('multipart/form-data')) {
    const form = await ctx.readForm(maxBytes);
    const fields = {}, list = [];
    for (const [k, val] of form.entries()) { if (typeof val === 'string') fields[k] = val; else if (val && val.size > 0) list.push(val); }
    return { fields, files: list };
  }
  return { fields: await ctx.readJson(64 * 1024), files: [] };
}
// Cheap checks that run BEFORE the request body is read, so an address that is already over its
// limit cannot make the server buffer megabytes.
let bigUploads = 0;
function preGuard(ctx, kind) {
  const r = rateLimit(`${kind}-pre`, ctx.ip, 15, 10 * 60);
  if (!r.ok) throw err(429, 'Çox sayda müraciət göndərilib. Bir az sonra yenidən cəhd edin.', { headers: { 'Retry-After': String(r.retryAfter) } });
}
function guard(ctx, kind, f) {
  // Honeypot: real visitors never see or fill this field. Bots get a normal-looking answer.
  if (f.website || f.url || f.hp) return false;
  const a = rateLimit(`${kind}-short`, ctx.ip, 5, 10 * 60), b = rateLimit(`${kind}-day`, ctx.ip, 30, 86400);
  if (!a.ok || !b.ok) throw err(429, 'Çox sayda müraciət göndərilib. Bir az sonra yenidən cəhd edin.', { headers: { 'Retry-After': String(a.ok ? b.retryAfter : a.retryAfter) } });
  return true;
}
function isDuplicate(key) {
  const t = Date.now();
  for (const [k, exp] of recentDuplicates) if (exp <= t) recentDuplicates.delete(k);
  if (recentDuplicates.has(key)) return true;
  recentDuplicates.set(key, t + 10 * 60000);
  return false;
}
function saveContact(d) {
  const ts = now();
  const id = run('INSERT INTO contact_requests (name, company, email, phone, subject, message, consent, consent_at, lang, source_page, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?)',
    d.name, d.company, d.email, d.phone, d.subject, d.message, ts, d.lang, d.page, ts, ts).lastInsertRowid;
  try { notify.newContact(get('SELECT * FROM contact_requests WHERE id = ?', id)); } catch (e) { console.error('[notify]', e); }
  return id;
}
function saveLead(d, stored = []) {
  const ts = now();
  const id = tx(() => {
    const rid = run(`INSERT INTO project_requests (first_name, last_name, company, position, email, phone, project_name, direction, description, budget, note, consent, consent_at, lang, source_page, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
    d.first_name, d.last_name, d.company, d.position, d.email, d.phone, d.project_name, d.direction, d.description, d.budget, d.note, ts, d.lang, d.page, ts, ts).lastInsertRowid;
    for (const m of stored) run('INSERT INTO project_request_files (request_id, media_id) VALUES (?,?)', rid, m.id);
    return rid;
  });
  try { notify.newLead(get('SELECT * FROM project_requests WHERE id = ?', id)); } catch (e) { console.error('[notify]', e); }
  return id;
}
const splitName = (f) => { if (f.name && !f.first_name) { const parts = String(f.name).trim().split(/\s+/); f.first_name = parts.shift(); f.last_name = f.last_name || parts.join(' '); } };
const consentRequired = (x) => { if (!(x === true || x === 1 || x === '1' || x === 'true' || x === 'on')) throw err(422, 'Razılıq verilməlidir', { fields: { consent: 'Fərdi məlumatların emalına razılıq verilməlidir' } }); };

module.exports = (app) => {
  /* CORS for /api/public/* - only the website's own origins. */
  app.use((ctx) => {
    if (!ctx.path.startsWith('/api/public/')) return;
    const origin = ctx.req.headers.origin;
    const ok = origin && allowedOrigins().has(origin);
    if (ok) { ctx.res.setHeader('Access-Control-Allow-Origin', origin); ctx.res.setHeader('Vary', 'Origin'); }
    if (ctx.method === 'OPTIONS') {
      if (ok) { ctx.res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); ctx.res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); ctx.res.setHeader('Access-Control-Max-Age', '600'); }
      return ctx.noContent();
    }
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && origin && !ok) {
      let host = '';
      try { host = new URL(origin).host; } catch { host = ''; }
      if (!host || host !== ctx.req.headers.host) throw err(403, 'Mənbə qəbul edilmir');
    }
    if (ctx.method === 'GET') ctx.res.setHeader('Cache-Control', 'public, max-age=60');
  });

  /* ---------------------------------------------------- visit counter */
  app.post('/api/public/collect', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    if (!rateLimit('collect', ctx.ip, 120, 60).ok) return ctx.noContent();
    let e;
    try { e = JSON.parse(await ctx.readText(4096)); } catch { return ctx.noContent(); }
    if (e && typeof e === 'object') { try { analytics.collect(ctx, e); } catch (x) { console.error('[analytics]', x.message); } }
    ctx.noContent();
  });

  /* ---------------------------------------------------- form intake */
  app.post('/api/public/project-request', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    preGuard(ctx, 'lead');
    const big = parseInt(ctx.req.headers['content-length'] || '0', 10) > 512 * 1024;
    if (big && bigUploads >= 3) throw err(503, 'Server hazırda məşğuldur. Bir az sonra yenidən cəhd edin.', { headers: { 'Retry-After': '20' } });
    let f, uploads;
    if (big) bigUploads++;
    try { ({ fields: f, files: uploads } = await readSubmission(ctx, (config.maxRequestFileMb * 3 + 1) * files.MB)); }
    finally { if (big) bigUploads--; }
    if (!guard(ctx, 'lead', f)) return ctx.json({ ok: true });
    splitName(f);
    const d = validate({
      first_name: v.str({ max: 80, required: true }), last_name: v.str({ max: 80 }), company: v.str({ max: 160 }), position: v.str({ max: 120 }),
      email: v.email({ required: true }), phone: v.phone(), project_name: v.str({ max: 200 }), direction: v.str({ max: 120 }),
      description: v.text({ max: 5000 }), budget: v.str({ max: 80 }), note: v.text({ max: 2000 }), lang: v.oneOf(LANGS, { default: 'az' }), page: v.str({ max: 200 }),
    }, f);
    consentRequired(f.consent);
    if (uploads.length > 3) throw err(422, 'Ən çox 3 fayl əlavə etmək olar', { fields: { files: 'Ən çox 3 fayl əlavə etmək olar' } });
    if (isDuplicate(sha256(`lead|${d.email}|${d.project_name}|${d.description}`))) return ctx.json({ ok: true });
    // Attachments from anonymous visitors: at most 300 files per day in total.
    for (let i = 0; i < uploads.length; i++) {
      if (!rateLimit('lead-files', 'all', 300, 86400).ok) throw err(429, 'Hazırda fayl qəbul edilmir. Sorğunu faylsız göndərin və ya bir az sonra yenidən cəhd edin.', { fields: { files: 'Hazırda fayl qəbul edilmir' } });
    }
    const stored = [];
    try {
      for (const file of uploads) stored.push(await files.storeUpload(file, { allowed: files.REQUEST_EXT, isPrivate: true, maxMb: config.maxRequestFileMb }));
    } catch (e) { stored.forEach(files.removeMedia); throw e; }
    saveLead(d, stored);
    ctx.json({ ok: true }, 201);
  });

  app.post('/api/public/contact', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    preGuard(ctx, 'contact');
    const { fields: f } = await readSubmission(ctx, 128 * 1024);
    if (!guard(ctx, 'contact', f)) return ctx.json({ ok: true });
    const d = validate({
      name: v.str({ max: 160, required: true }), company: v.str({ max: 160 }), email: v.email({ required: true }), phone: v.phone(),
      subject: v.str({ max: 200 }), message: v.text({ max: 5000, required: true }), lang: v.oneOf(LANGS, { default: 'az' }), page: v.str({ max: 200 }),
    }, f);
    consentRequired(f.consent);
    if (isDuplicate(sha256(`contact|${d.email}|${d.message}`))) return ctx.json({ ok: true });
    saveContact(d);
    ctx.json({ ok: true }, 201);
  });

  /* ------------------------------------- the website's own forms (site/assets/js/main.js) */
  // One endpoint for the three forms of aeec.az. The payload is the one main.js has always sent:
  // { form: home|contact|academy, lang, page, consent, aeec_hp, elapsed, name, email, ... }.
  //   home    ("Layihənizi müzakirə edək") -> project request
  //   contact (Əlaqə səhifəsi)              -> contact request, subject = chosen direction
  //   academy (Akademiya, maraq bildirmə)   -> contact request, subject = "AEEC Academy: <course>"
  // /api/contact.php is kept as an alias so that pages still cached with the old script keep working.
  const siteForm = async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    preGuard(ctx, 'site-form');
    const f = await ctx.readJson(64 * 1024);
    // Spam trap and "filled in faster than a person can" check, exactly as the old PHP script did:
    // the bot gets a normal-looking answer and nothing is stored.
    // (1.5 s: even a browser that fills the fields automatically needs longer for a real person.)
    if ((typeof f.aeec_hp === 'string' && f.aeec_hp.trim()) || !(Number(f.elapsed) >= 1500)) return ctx.json({ ok: true });
    const kind = ['home', 'contact', 'academy'].includes(f.form) ? f.form : '';
    if (!kind) throw err(422, 'Forma növü düzgün deyil');
    consentRequired(f.consent);
    const common = { lang: v.oneOf(LANGS, { default: 'az' }), page: v.str({ max: 200 }), email: v.email({ required: true }) };
    if (kind === 'home') {
      splitName(f);
      f.description = f.message;
      const d = validate({ ...common, first_name: v.str({ max: 80, required: true }), last_name: v.str({ max: 80 }), company: v.str({ max: 160 }), direction: v.str({ max: 120 }),
        description: v.text({ max: 5000 }), phone: v.phone() }, f);
      Object.assign(d, { position: '', project_name: '', budget: '', note: '' });
      // The submission limit counts only valid requests, so correcting a typo does not lock anybody out.
      if (!guard(ctx, 'lead', {})) return ctx.json({ ok: true });
      if (isDuplicate(sha256(`lead|${d.email}||${d.description}`))) return ctx.json({ ok: true });
      saveLead(d);
    } else {
      const d = validate({ ...common, name: v.str({ max: 160, required: true }), company: v.str({ max: 160 }), phone: v.phone(),
        direction: v.str({ max: 120 }), course: v.str({ max: 160 }), message: v.text({ max: 5000 }) }, f);
      d.subject = kind === 'academy' ? `AEEC Academy: ${d.course || '—'}`.slice(0, 200) : d.direction;
      if (!guard(ctx, 'contact', {})) return ctx.json({ ok: true });
      if (isDuplicate(sha256(`contact|${d.email}|${d.subject}|${d.message}`))) return ctx.json({ ok: true });
      saveContact(d);
    }
    ctx.json({ ok: true }, 201);
  };
  app.post('/api/public/form', siteForm);
  app.post('/api/contact.php', siteForm);

  /* ---------------------------------------------------- read-only content */
  const newsOut = (row, lang, full) => {
    const r = localize(parseJsonCols({ jsonCols: ['gallery', 'tags', 'i18n'] }, { ...row }), lang);
    const o = { id: r.id, slug: r.slug, title: r.title, excerpt: r.excerpt, category: r.category, tags: r.tags, author: r.author_name, published_at: r.published_at,
      is_featured: !!r.is_featured, cover: pub(files.mediaById(r.cover_media_id)) };
    if (full) Object.assign(o, { content_html: md.render(r.content), gallery: files.mediaList(r.gallery).map(pub), seo_title: r.seo_title || r.title, seo_description: r.seo_description || r.excerpt });
    return o;
  };
  app.get('/api/public/news', (ctx) => {
    const { per, p, off } = page(ctx);
    const where = ["status = 'published'", 'published_at <= ?'], params = [now()];
    if (ctx.query.category) { where.push('category = ?'); params.push(String(ctx.query.category).slice(0, 80)); }
    if (ctx.query.featured === '1') where.push('is_featured = 1');
    const total = get(`SELECT COUNT(*) AS n FROM news WHERE ${where.join(' AND ')}`, ...params).n;
    const rows = all(`SELECT * FROM news WHERE ${where.join(' AND ')} ORDER BY is_featured DESC, published_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, per, off);
    ctx.json({ items: rows.map((r) => newsOut(r, langOf(ctx), false)), total, page: p, per_page: per });
  });
  app.get('/api/public/news/:slug', (ctx) => {
    const row = get("SELECT * FROM news WHERE slug = ? AND status = 'published' AND published_at <= ?", String(ctx.params.slug).slice(0, 120), now());
    if (!row) throw err(404, 'Xəbər tapılmadı');
    if (rateLimit('news-view', `${ctx.ip}|${row.id}`, 1, 3600).ok) run('UPDATE news SET views = views + 1 WHERE id = ?', row.id);
    ctx.json({ item: newsOut(row, langOf(ctx), true) });
  });
  const projectOut = (row, lang, full) => {
    const r = localize(parseJsonCols({ jsonCols: ['gallery', 'documents', 'stats', 'i18n'] }, { ...row }), lang);
    const o = { id: r.id, slug: r.slug, name: r.name, client: r.client, location: r.location, sector: r.sector, project_type: r.project_type, start_date: r.start_date, end_date: r.end_date,
      status: r.status, image: pub(files.mediaById(r.main_media_id)), stats: (r.stats || []).filter((s) => s.label && s.value) };
    if (full) Object.assign(o, { description_html: md.render(r.description), gallery: files.mediaList(r.gallery).map(pub), seo_title: r.seo_title || r.name, seo_description: r.seo_description,
      documents: (r.documents || []).map((id) => get("SELECT id, title FROM documents WHERE id = ? AND visibility = 'public'", id)).filter(Boolean).map((d) => ({ ...d, url: `/api/public/documents/${d.id}/download` })) });
    return o;
  };
  app.get('/api/public/projects', (ctx) => {
    const where = ['is_active = 1', "status <> 'archived'"], params = [];
    if (['planned', 'ongoing', 'completed'].includes(ctx.query.status)) { where.push('status = ?'); params.push(ctx.query.status); }
    if (ctx.query.sector) { where.push('sector = ?'); params.push(String(ctx.query.sector).slice(0, 120)); }
    ctx.json({ items: all(`SELECT * FROM projects WHERE ${where.join(' AND ')} ORDER BY sort_order ASC, id DESC LIMIT 200`, ...params).map((r) => projectOut(r, langOf(ctx), false)) });
  });
  app.get('/api/public/projects/:slug', (ctx) => {
    const row = get("SELECT * FROM projects WHERE slug = ? AND is_active = 1 AND status <> 'archived'", String(ctx.params.slug).slice(0, 120));
    if (!row) throw err(404, 'Layihə tapılmadı');
    ctx.json({ item: projectOut(row, langOf(ctx), true) });
  });
  app.get('/api/public/services', (ctx) => {
    ctx.json({ items: all('SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').map((row) => {
      const r = localize(parseJsonCols({ jsonCols: ['features', 'i18n'] }, { ...row }), langOf(ctx));
      return { id: r.id, slug: r.slug, title: r.title, short_description: r.short_description, full_description_html: md.render(r.full_description), icon: r.icon,
        image: pub(files.mediaById(r.image_media_id)), features: r.features, seo_title: r.seo_title || r.title, seo_description: r.seo_description || r.short_description };
    }) });
  });
  app.get('/api/public/team', (ctx) => {
    ctx.json({ items: all('SELECT * FROM team_members WHERE is_active = 1 ORDER BY sort_order ASC, id ASC').map((row) => {
      const r = localize(parseJsonCols({ jsonCols: ['i18n'] }, { ...row }), langOf(ctx));
      return { id: r.id, name: r.name, position: r.position, biography: r.biography, email: r.email, linkedin: r.linkedin, phone: r.phone, photo: pub(files.mediaById(r.photo_media_id)) };
    }) });
  });
  app.get('/api/public/documents', (ctx) => {
    ctx.json({ items: all("SELECT d.*, m.ext, m.size FROM documents d JOIN media m ON m.id = d.file_media_id WHERE d.visibility = 'public' ORDER BY d.created_at DESC").map((row) => {
      const r = localize(parseJsonCols({ jsonCols: ['i18n'] }, { ...row }), langOf(ctx));
      return { id: r.id, title: r.title, description: r.description, category: r.category, ext: r.ext, size: r.size, url: `/api/public/documents/${r.id}/download` };
    }) });
  });
  app.get('/api/public/documents/:id/download', (ctx) => {
    const d = get("SELECT * FROM documents WHERE id = ? AND visibility = 'public'", ctx.intParam('id'));
    const m = d && get('SELECT * FROM media WHERE id = ? AND is_private = 1', d.file_media_id);
    if (!m) throw err(404, 'Sənəd tapılmadı');
    if (rateLimit('doc-dl', `${ctx.ip}|${d.id}`, 1, 3600).ok) run('UPDATE documents SET downloads = downloads + 1 WHERE id = ?', d.id);
    sendFile(ctx, config.privateDir, m.stored_name, { type: m.mime, csp: FILE_CSP, download: m.original_name, inline: files.INLINE_EXT.has(m.ext), cache: 'public, max-age=300' });
  });
  app.get('/api/public/settings', (ctx) => {
    const lang = langOf(ctx), out = {};
    for (const [k, g] of Object.entries(GROUPS)) if (g.public) out[k] = localize(getSetting(k), lang);
    const img = (id) => { const m = files.mediaById(id); return m ? m.url : null; };
    out.general.logo_url = img(out.general.logo_media_id); out.general.favicon_url = img(out.general.favicon_media_id);
    out.seo = { site_title: out.seo.site_title, meta_description: out.seo.meta_description, keywords: out.seo.keywords, og_image_url: img(out.seo.og_image_media_id) };
    out.company.stats = (out.company.stats || []).filter((s) => s.is_active && s.value);
    out.company.values = (out.company.values || []).filter((s) => s.title);
    ctx.json(out);
  });
  app.get('/api/public/seo', (ctx) => {
    const p = String(ctx.query.path || '/').slice(0, 200);
    const row = get('SELECT * FROM seo_pages WHERE path = ?', p);
    if (!row) return ctx.json({ item: null });
    const r = localize(parseJsonCols({ jsonCols: ['i18n'] }, { ...row }), langOf(ctx));
    const og = files.mediaById(r.og_image_media_id);
    ctx.json({ item: { path: r.path, seo_title: r.seo_title, meta_description: r.meta_description, keywords: r.keywords, og_title: r.og_title || r.seo_title, og_description: r.og_description || r.meta_description,
      og_image_url: og ? og.url : null, canonical: r.canonical || config.siteUrl + r.path } });
  });

};
