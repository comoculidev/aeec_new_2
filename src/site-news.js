'use strict';
// News on the public website.
//
// The website is static HTML in site/ (served by this same application). News written in the panel are published by
// GENERATING the same static pages the site always had:
//   /xeberler/            /en/news/            /ru/news/             (lists)
//   /xeberler/<slug>/     /en/news/<slug>/     /ru/news/<slug>/      (one page per news item)
// plus the news entries of sitemap.xml and copies of the cover images (assets/img/cms/).
// The page design comes from site-templates/*.html, which were made from the hand-written
// v3.1 pages, so a generated page is identical to a hand-written one.
//
// Safety rules:
// - Only files listed in the site_files table ("managed" files) are ever overwritten or deleted.
//   An existing file that the panel did not create is never touched (the item is skipped and the
//   problem is reported in the panel instead).
// - Everything is written inside config.siteDir, into the folders above only, atomically
//   (temporary file + rename) and only when the content really changed.
// - All text is HTML-escaped; the body goes through the safe Markdown renderer.
//
// On first start the four news items that exist as hand-written pages are imported into the
// database, so the panel shows them and the next generation reproduces them byte for byte.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { get, all, run, tx, now } = require('./db');
const md = require('./markdown');
const { imageSize } = require('./imagesize');

const LANGS = ['az', 'en', 'ru'];
const LIST_DIR = { az: 'xeberler', en: 'en/news', ru: 'ru/news' };
const TPL_DIR = path.join(__dirname, '..', 'site-templates');
const LABELS = JSON.parse(fs.readFileSync(path.join(TPL_DIR, 'labels.json'), 'utf8'));
const EMPTY = { az: 'Hazırda dərc olunmuş xəbər yoxdur.', en: 'There are no news items yet.', ru: 'Новостей пока нет.' };
const MANAGED_ROOTS = ['xeberler/', 'en/news/', 'ru/news/', 'assets/img/cms/'];
const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SITE_IMAGE_RX = /^\/assets\/img\/[A-Za-z0-9._-]{1,100}\.(?:jpe?g|png|webp)$/;

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escJson = (s) => JSON.stringify(String(s ?? '')).slice(1, -1).replace(/</g, '\\u003c');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const decode = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: '\u00a0' }[e]));

const templates = {};
function template(name) {
  if (!templates[name]) templates[name] = fs.readFileSync(path.join(TPL_DIR, name), 'utf8');
  return templates[name];
}
// {{key}} = HTML-escaped, {{key|json}} = JSON-string-escaped, {{{key}}} = trusted HTML made here.
function render(tpl, vars) {
  return tpl.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)(\|json)?\}\}/g, (m, rawKey, key, json) => {
    const k = rawKey || key;
    if (!Object.hasOwn(vars, k)) throw new Error(`template variable missing: ${k}`);
    return rawKey ? String(vars[k]) : json ? escJson(vars[k]) : escHtml(vars[k]);
  });
}

// Asset versions are taken from the live home page, so a later "?v=" bump there is followed here.
function assetVersions() {
  let home = '';
  try { home = fs.readFileSync(path.join(config.siteDir, 'index.html'), 'utf8'); } catch { home = ''; }
  return { css_v: (/style\.css\?v=([\w.]+)/.exec(home) || [])[1] || '3.1', js_v: (/main\.js\?v=([\w.]+)/.exec(home) || [])[1] || '3.2' };
}

/* ------------------------------------------------------------------ data */
function itemsFor() {
  const rows = all("SELECT * FROM news WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= ? ORDER BY is_featured DESC, published_at DESC, id DESC", now());
  return rows.map((r) => {
    let i18n = {};
    try { i18n = JSON.parse(r.i18n || '{}') || {}; } catch { i18n = {}; }
    const langs = {};
    for (const l of LANGS) {
      const t = l === 'az' ? r : { ...(i18n[l] || {}) };
      const slug = l === 'az' ? r.slug : l === 'en' ? r.slug_en || r.slug : r.slug_ru || r.slug_en || r.slug;
      if (!t.title || !t.content || !SLUG_RX.test(slug || '')) continue; // this language version is not written yet
      const firstPara = String(t.content).split(/\n\s*\n/)[0].replace(/[*_[\]()#>`]/g, '').replace(/\s+/g, ' ').trim();
      langs[l] = {
        slug, title: t.title, content: t.content, excerpt: t.excerpt || '',
        seo_title: t.seo_title || t.title,
        description: t.seo_description || t.excerpt || (firstPara.length > 160 ? firstPara.slice(0, 157).replace(/\s+\S*$/, '') + '…' : firstPara),
        category: t.category || (l === 'az' ? r.category : '') || '',
        alt: t.cover_alt || (l === 'az' ? r.cover_alt : '') || t.title,
        url: `/${LIST_DIR[l]}/${slug}/`,
      };
    }
    return { row: r, langs };
  }).filter((x) => x.langs.az || x.langs.en || x.langs.ru);
}

// Cover image of an item: an uploaded media file (copied into the site) or an existing site image.
function imageOf(row, out) {
  if (row.cover_media_id) {
    const m = get('SELECT * FROM media WHERE id = ? AND is_private = 0 AND kind = ?', row.cover_media_id, 'image');
    if (m && /^[\w.-]+$/.test(m.stored_name) && /^(jpe?g|png|webp|gif)$/.test(m.ext)) {
      let buf;
      try { buf = fs.readFileSync(path.join(config.uploadDir, m.stored_name)); } catch { buf = null; }
      if (buf) {
        const rel = `assets/img/cms/${m.stored_name}`;
        out.set(rel, buf); // same cover in several items = same file, not a conflict
        const size = imageSize(buf) || { width: 1200, height: 630 };
        return { src: '/' + rel, webp: null, ...size, mediaAlt: m.alt };
      }
    }
  }
  if (row.site_image && SITE_IMAGE_RX.test(row.site_image)) {
    const full = path.join(config.siteDir, row.site_image);
    let buf;
    try { buf = fs.readFileSync(full); } catch { buf = null; }
    if (buf) {
      const size = imageSize(buf) || { width: 1200, height: 630 };
      const webpRel = row.site_image.replace(/\.(jpe?g|png)$/, '.webp');
      const webp = webpRel !== row.site_image && fs.existsSync(path.join(config.siteDir, webpRel)) ? webpRel : null;
      return { src: row.site_image, webp, ...size, mediaAlt: '' };
    }
  }
  return null;
}
const picture = (img, cls, alt, extra) => (img
  ? `<picture class="${cls}">${img.webp ? `<source type="image/webp" srcset="${escHtml(img.webp)}">` : ''}<img src="${escHtml(img.src)}" alt="${escHtml(alt)}" width="${img.width}" height="${img.height}"${extra} decoding="async"></picture>`
  : '');

/* ------------------------------------------------------------------ pages */
function buildPages() {
  const out = new Map(); // relative path -> Buffer|string
  const errors = [];
  // Two items must never produce the same page (e.g. the same EN address); the first one wins.
  const put = (rel, data) => { if (out.has(rel)) errors.push(`Eyni ünvanlı iki xəbər səhifəsi: /${rel.replace(/index\.html$/, '')}`); else out.set(rel, data); };
  const v = assetVersions();
  const items = itemsFor();
  for (const it of items) it.img = imageOf(it.row, out);
  const base = config.siteUrl;
  for (const l of LANGS) {
    const list = items.filter((it) => it.langs[l]);
    // ---- list page
    const cards = list.map((it, i) => {
      const t = it.langs[l];
      return '      <article class="news">\n'
        + (it.img ? `        ${picture(it.img, 'ph', t.alt || it.img.mediaAlt, i >= 2 ? ' loading="lazy"' : '')}\n` : '')
        + `        <div class="bd">${t.category ? `<span class="tag">${escHtml(t.category)}</span>` : ''}<h2><a href="${escHtml(t.url)}">${escHtml(t.title)}</a></h2>${t.excerpt ? `<p>${escHtml(t.excerpt)}</p>` : ''}<span class="more" aria-hidden="true">${escHtml(LABELS[l].read_more)} <span class="arrow">→</span></span></div>\n`
        + '      </article>';
    });
    put(`${LIST_DIR[l]}/index.html`, render(template(`news-list.${l}.html`), { ...v, cards: cards.length ? cards.join('\n') : `      <p>${escHtml(EMPTY[l])}</p>` }));
    // ---- detail pages
    for (const it of list) {
      const t = it.langs[l];
      const href = {};
      for (const x of LANGS) href[x] = it.langs[x] ? it.langs[x].url : LABELS[x].list;
      const alternates = LANGS.filter((x) => it.langs[x]).map((x) => `<link rel="alternate" hreflang="${x}" href="${escHtml(base + it.langs[x].url)}">`);
      const def = it.langs.az || it.langs[l];
      alternates.push(`<link rel="alternate" hreflang="x-default" href="${escHtml(base + def.url)}">`);
      const others = list.filter((o) => o !== it).map((o) => `<li><a href="${escHtml(o.langs[l].url)}">${escHtml(o.langs[l].title)}</a></li>`).join('');
      const body = md.render(t.content).split('\n').filter((x) => x.trim()).map((x) => '        ' + x).join('\n');
      const alt = t.alt || it.img?.mediaAlt || t.title;
      let html;
      html = render(template(`news-detail.${l}.html`), {
        ...v, seo_title: t.seo_title, description: t.description, title: t.title, self_abs: base + t.url, alternates: alternates.join('\n'),
        og_image: it.img ? base + it.img.src : `${base}/assets/img/og-image.jpg`, og_w: it.img ? it.img.width : 1200, og_h: it.img ? it.img.height : 630, og_alt: alt,
        href_az: href.az, href_en: href.en, href_ru: href.ru,
        picture: picture(it.img, 'art-img', alt, ' fetchpriority="high"'), body, more: others,
      });
      if (!it.img) html = html.replace(/\n *\n( *<div class="art-body">)/, '\n$1');
      if (!others) html = html.replace(/\n *<aside class="art-more"[^\n]*<\/aside>/, '');
      put(`${LIST_DIR[l]}/${t.slug}/index.html`, html);
    }
  }
  return { out, items, errors };
}

// News entries of sitemap.xml: hand-written entries stay as they are; the news detail entries are
// rebuilt; the lastmod of the three list pages follows the newest change.
function buildSitemap(items) {
  const file = path.join(config.siteDir, 'sitemap.xml');
  let xml;
  try { xml = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
  const base = config.siteUrl;
  const detailRx = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:xeberler|en/news|ru/news)/[^/]+/$`);
  const blocks = xml.match(/ {2}<url>\n[\s\S]*?\n {2}<\/url>\n/g) || [];
  let out = xml;
  for (const b of blocks) { const loc = (/<loc>([^<]+)<\/loc>/.exec(b) || [])[1] || ''; if (detailRx.test(loc)) out = out.replace(b, ''); }
  let newest = '';
  const add = [];
  for (const it of items) {
    const day = String(it.row.updated_at || '').slice(0, 10);
    if (day > newest) newest = day;
    for (const l of LANGS) {
      if (!it.langs[l]) continue;
      const lines = ['  <url>', `    <loc>${escHtml(base + it.langs[l].url)}</loc>`, `    <lastmod>${day}</lastmod>`];
      for (const x of LANGS) if (it.langs[x]) lines.push(`    <xhtml:link rel="alternate" hreflang="${x}" href="${escHtml(base + it.langs[x].url)}"/>`);
      lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escHtml(base + (it.langs.az || it.langs[l]).url)}"/>`, '  </url>');
      add.push(lines.join('\n') + '\n');
    }
  }
  if (newest) {
    for (const l of LANGS) {
      const loc = `${base}/${LIST_DIR[l]}/`;
      out = out.replace(new RegExp(`(<loc>${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\n {4}<lastmod>)([\\d-]{10})`), (m, a, d) => a + (newest > d ? newest : d));
    }
  }
  return out.replace('</urlset>', add.join('') + '</urlset>');
}

/* ------------------------------------------------------------------ writing */
const inManagedRoot = (rel) => MANAGED_ROOTS.some((r) => rel.startsWith(r));
function safeFull(rel) {
  const full = path.resolve(config.siteDir, rel);
  if (!full.startsWith(config.siteDir + path.sep)) throw new Error('path outside the site: ' + rel);
  return full;
}
function writeAtomic(full, data) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = path.join(path.dirname(full), `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  fs.renameSync(tmp, full);
}

let lastResult = null, lastErrorSig = '';
function generate({ reason = '' } = {}) {
  const started = Date.now();
  const result = { ok: true, at: now(), reason, written: [], removed: [], skipped: [], errors: [], items: 0 };
  try {
    if (!fs.existsSync(path.join(config.siteDir, LIST_DIR.az, 'index.html'))) throw new Error(`Sayt qovluğu tapılmadı: ${config.siteDir}`);
    const { out, items, errors } = buildPages();
    result.errors.push(...errors);
    result.items = items.length;
    const managed = new Map(all('SELECT path, hash FROM site_files').map((r) => [r.path, r.hash]));
    const keep = new Set();
    // Images first, then the news pages, the lists last: a list never links to a page that
    // could not be written in the same run.
    const rank = (rel) => (rel.startsWith('assets/') ? 0 : /^(?:xeberler|en\/news|ru\/news)\/index\.html$/.test(rel) ? 2 : 1);
    const failedPages = new Set();
    for (const [rel, data] of [...out].sort((a, b) => rank(a[0]) - rank(b[0]))) {
      if (!inManagedRoot(rel)) { result.errors.push(`icazəsiz yol: ${rel}`); continue; }
      const full = safeFull(rel);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      const exists = fs.existsSync(full);
      if (exists && !managed.has(rel)) { result.skipped.push(rel); continue; } // never overwrite a file the panel did not create
      keep.add(rel);
      if (rank(rel) === 2 && failedPages.size) { result.errors.push(`${rel}: digər səhifələr yazılmadığı üçün siyahı yenilənmədi`); continue; }
      try {
        const h = sha(buf);
        if (exists && sha(fs.readFileSync(full)) === h) { if (managed.get(rel) !== h) run('INSERT OR REPLACE INTO site_files (path, hash, generated_at) VALUES (?,?,?)', rel, h, now()); continue; }
        writeAtomic(full, buf);
        run('INSERT OR REPLACE INTO site_files (path, hash, generated_at) VALUES (?,?,?)', rel, h, now());
        result.written.push(rel);
      } catch (e) {
        if (rank(rel) === 1) failedPages.add(rel);
        result.errors.push(`${rel}: yazmaq mümkün olmadı (${e.code || e.message})`);
      }
    }
    for (const rel of managed.keys()) {
      if (keep.has(rel) || rel === 'sitemap.xml') continue;
      const full = safeFull(rel);
      try { fs.unlinkSync(full); result.removed.push(rel); } catch (e) { if (e.code !== 'ENOENT') { result.errors.push(`${rel}: ${e.code}`); continue; } }
      run('DELETE FROM site_files WHERE path = ?', rel);
      // remove the now empty folder of a news item (never a list folder)
      const dir = path.dirname(full);
      if (/\/(xeberler|en\/news|ru\/news)\/[^/]+$/.test(dir)) { try { fs.rmdirSync(dir); } catch { /* not empty or gone */ } }
    }
    try {
      const sm = buildSitemap(items);
      const full = path.join(config.siteDir, 'sitemap.xml');
      if (sm !== null && fs.readFileSync(full, 'utf8') !== sm) { fs.writeFileSync(full, sm); result.written.push('sitemap.xml'); }
    } catch (e) { result.errors.push(`sitemap.xml: yazmaq mümkün olmadı (${e.code || e.message})`); }
    if (result.skipped.length) result.errors.push(`Panelin yaratmadığı mövcud fayl üzərinə yazılmadı: ${result.skipped.join(', ')}`);
  } catch (e) {
    result.ok = false;
    result.errors.push(String(e.message || e));
  }
  result.ok = result.ok && !result.errors.length;
  result.ms = Date.now() - started;
  lastResult = result;
  run('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)', 'last_generation', JSON.stringify({ ...result, written: result.written.slice(0, 50), removed: result.removed.slice(0, 50) }));
  // The same problem is logged once, not every minute.
  const sig = result.errors.join('|');
  if (sig && sig !== lastErrorSig) console.error('[site-news] xəta:', result.errors.join('; '));
  lastErrorSig = sig;
  if (result.written.length || result.removed.length) console.log(`[site-news] ${result.written.length} fayl yazıldı, ${result.removed.length} silindi (${reason})`);
  return result;
}

let timer = null;
function schedule(reason = 'dəyişiklik') {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; generate({ reason }); }, 400);
  timer.unref?.();
}
const enabled = () => fs.existsSync(path.join(config.siteDir, LIST_DIR.az));
function status() {
  let last = lastResult;
  if (!last) { const r = get("SELECT value FROM site_meta WHERE key = 'last_generation'"); try { last = r ? JSON.parse(r.value) : null; } catch { last = null; } }
  return { enabled: enabled(), site_dir_found: fs.existsSync(path.join(config.siteDir, LIST_DIR.az)), managed_files: get('SELECT COUNT(*) AS n FROM site_files').n, last };
}

/* ------------------------------------------------------------------ first-run import */
function readPage(rel) { try { return fs.readFileSync(path.join(config.siteDir, rel), 'utf8'); } catch { return null; } }
const m1 = (s, rx) => { const m = rx.exec(s || ''); return m ? m[1] : ''; };
function parseDetail(html) {
  const body = m1(html, /<div class="art-body">\n([\s\S]*?)\n {6}<\/div>/);
  const paras = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, '')).trim()).filter(Boolean);
  return {
    seo_title: decode(m1(html, /<title>(.*) \| AEEC<\/title>/)), description: decode(m1(html, /<meta name="description" content="([^"]*)">/)),
    title: decode(m1(html, /<h1 class="art-title">(.*)<\/h1>/)), content: paras.join('\n\n'),
    alt: decode(m1(html, /<picture class="art-img">.*?<img [^>]*alt="([^"]*)"/)), image: m1(html, /<picture class="art-img">.*?<img src="([^"]+)"/),
    en: m1(html, /<link rel="alternate" hreflang="en" href="[^"]*\/en\/news\/([a-z0-9-]+)\/">/), ru: m1(html, /<link rel="alternate" hreflang="ru" href="[^"]*\/ru\/news\/([a-z0-9-]+)\/">/),
  };
}
function parseCards(html) {
  return [...String(html || '').matchAll(/<article class="news">([\s\S]*?)<\/article>/g)].map((m) => ({
    url: m1(m[1], /<h2><a href="([^"]+)">/), category: decode(m1(m[1], /<span class="tag">([^<]*)<\/span>/)), excerpt: decode(m1(m[1], /<\/h2><p>([\s\S]*?)<\/p>/)),
  }));
}
function importExisting() {
  if (get("SELECT value FROM site_meta WHERE key = 'news_imported'")) return 0;
  const lists = {};
  for (const l of LANGS) lists[l] = parseCards(readPage(`${LIST_DIR[l]}/index.html`));
  if (!readPage(`${LIST_DIR.az}/index.html`)) return 0;
  const files = new Set(LANGS.map((l) => `${LIST_DIR[l]}/index.html`));
  let n = 0, incomplete = false;
  const base = Date.parse('2026-10-03T12:00:00.000Z');
  tx(() => {
    lists.az.forEach((card, i) => {
      const slug = m1(card.url, /^\/xeberler\/([a-z0-9-]+)\/$/);
      if (!slug || get('SELECT id FROM news WHERE slug = ?', slug)) { incomplete = true; return; }
      const az = parseDetail(readPage(`xeberler/${slug}/index.html`));
      if (!az.title || !az.content) { incomplete = true; return; }
      files.add(`xeberler/${slug}/index.html`);
      const i18n = {};
      for (const l of ['en', 'ru']) {
        const s = az[l];
        const page = s && readPage(`${LIST_DIR[l]}/${s}/index.html`);
        if (!page) continue;
        const t = parseDetail(page);
        const c = lists[l].find((x) => x.url === `/${LIST_DIR[l]}/${s}/`) || {};
        i18n[l] = { title: t.title, content: t.content, excerpt: c.excerpt || '', category: c.category || '', cover_alt: t.alt };
        if (t.seo_title && t.seo_title !== t.title) i18n[l].seo_title = t.seo_title;
        if (t.description && t.description !== (c.excerpt || '')) i18n[l].seo_description = t.description;
        files.add(`${LIST_DIR[l]}/${s}/index.html`);
      }
      // Order on the site: first card = newest. The pages were published with v3.1 on 03.10.2026.
      const ts = new Date(base - i * 60000).toISOString();
      run(`INSERT INTO news (slug, slug_en, slug_ru, title, excerpt, content, category, cover_alt, site_image, author_name, status, is_featured, published_at,
            seo_title, seo_description, i18n, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
      slug, az.en && i18n.en ? az.en : '', az.ru && i18n.ru ? az.ru : '', az.title, card.excerpt, az.content, card.category, az.alt,
      SITE_IMAGE_RX.test(az.image) ? az.image : '', 'AEEC', 'published', ts, az.seo_title !== az.title ? az.seo_title : '',
      az.description !== card.excerpt ? az.description : '', JSON.stringify(i18n), ts, ts);
      n++;
    });
    // The imported pages become "managed": from now on the panel keeps them up to date.
    // If a card could not be imported, the list pages stay hand-made (the panel reports it)
    // instead of being regenerated without that item.
    if (incomplete) for (const l of LANGS) files.delete(`${LIST_DIR[l]}/index.html`);
    for (const rel of files) {
      const full = path.join(config.siteDir, rel);
      if (fs.existsSync(full)) run('INSERT OR REPLACE INTO site_files (path, hash, generated_at) VALUES (?,?,?)', rel, sha(fs.readFileSync(full)), now());
    }
    run('INSERT OR REPLACE INTO site_meta (key, value) VALUES (?, ?)', 'news_imported', now());
  });
  if (n) console.log(`[site-news] Saytdakı ${n} xəbər panelə köçürüldü.`);
  return n;
}

// Called once at start-up.
function init() {
  if (!enabled()) { console.warn('[site-news] site/xeberler qovluğu tapılmadı — xəbərlər sayta yazılmayacaq.'); return; }
  try { importExisting(); } catch (e) { console.error('[site-news] import', e); }
  generate({ reason: 'başlanğıc' });
  // Once a minute: publishes items whose publication time has come and repairs pages that were
  // changed or deleted by hand. Nothing is written when nothing changed.
  const t = setInterval(() => generate({ reason: 'dövri yoxlama' }), 60000);
  t.unref();
}

module.exports = { init, generate, schedule, status, enabled, importExisting, SLUG_RX, SITE_IMAGE_RX, LIST_DIR };
