'use strict';
// Content modules: news, projects, services, team.
const { get, all } = require('../db');
const { err } = require('../http');
const { v } = require('../validate');
const { defineResource, slugify, uniqueSlug } = require('../crud');
const { mediaById, mediaList } = require('../files');
const { can } = require('../auth');
const siteNews = require('../site-news');
const { audit } = require('../audit');

const mediaId = () => v.int({ min: 1 });
const idList = (max = 30) => v.arr(v.int({ min: 1, required: true }), { max });
const kv = (max = 12) => v.arr(v.obj({ label: v.str({ max: 120 }), value: v.str({ max: 60 }) }), { max, dropEmpty: false });
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
const NEWS_STATUS = { draft: 'Qaralama', published: 'Dərc olunub', archived: 'Arxiv' };
const PROJECT_STATUS = { planned: 'Planlaşdırılır', ongoing: 'Davam edir', completed: 'Tamamlanıb', archived: 'Arxiv' };

function ensureSlug(table, data, existing, titleKey) {
  if (!('slug' in data) && existing) return;
  const base = data.slug || slugify(data[titleKey] || (existing && existing[titleKey]) || '');
  data.slug = uniqueSlug(table, base, existing ? existing.id : 0);
}

module.exports = (app) => {
  /* ------------------------------------------------------------- news */
  const newsText = { title: v.str({ max: 200 }), excerpt: v.text({ max: 600 }), content: v.text({ max: 100000 }), seo_title: v.str({ max: 120 }), seo_description: v.str({ max: 300 }),
    category: v.str({ max: 80 }), cover_alt: v.str({ max: 200 }) };
  const siteImage = () => v.str({ max: 120, pattern: siteNews.SITE_IMAGE_RX, message: 'Yalnız saytdakı şəkil ünvanı, məs. /assets/img/news-iea.jpg' });
  defineResource(app, {
    name: 'news', path: '/api/news', table: 'news', module: 'Xəbərlər',
    perms: { view: 'news.view', create: 'news.create', edit: 'news.edit', delete: 'news.delete' },
    shape: {
      ...newsText, title: v.str({ max: 200, required: true }), slug: v.slug(), slug_en: v.slug(), slug_ru: v.slug(), site_image: siteImage(), cover_media_id: mediaId(), gallery: idList(30),
      category: v.str({ max: 80 }), tags: v.arr(v.str({ max: 40 }), { max: 20 }), author_name: v.str({ max: 120 }),
      status: v.oneOf(Object.keys(NEWS_STATUS), { default: 'draft' }), is_featured: v.bool(), published_at: v.datetime(), i18n: v.i18n(newsText),
    },
    jsonCols: ['gallery', 'tags', 'i18n'], mediaCols: ['cover_media_id'], mediaListCols: ['gallery'],
    search: ['title', 'excerpt', 'category', 'author_name', 'tags'],
    filters: { status: { col: 'status', values: Object.keys(NEWS_STATUS) }, category: { col: 'category' }, featured: { col: 'is_featured', int: true } },
    dateCol: 'COALESCE(published_at, created_at)',
    sortable: { title: 'fold(title)', date: 'COALESCE(published_at, created_at)', views: 'views', status: 'status', category: 'fold(category)' },
    defaultSort: 'COALESCE(published_at, created_at) DESC, id DESC',
    label: (r) => `Xəbər #${r.id} «${r.title}»`,
    actionName: (a, b) => (a.status !== b.status ? (b.status === 'published' ? 'Dərc etmə' : b.status === 'archived' ? 'Arxivləşdirmə' : 'Status dəyişikliyi') : 'Redaktə'),
    prepare(ctx, d, existing) {
      ensureSlug('news', d, existing, 'title');
      // EN/RU addresses: default to the transliterated translated title. On the website the
      // EN page uses slug_en || slug and the RU page slug_ru || slug_en || slug, so uniqueness
      // is checked on those effective addresses, not only inside one column.
      let tr = d.i18n;
      if (tr === undefined && existing) { try { tr = JSON.parse(existing.i18n || '{}'); } catch { tr = {}; } }
      const others = all('SELECT slug, slug_en, slug_ru FROM news WHERE id <> ?', existing ? existing.id : 0);
      const eff = { en: (r) => r.slug_en || r.slug, ru: (r) => r.slug_ru || r.slug_en || r.slug };
      for (const l of ['en', 'ru']) {
        const col = `slug_${l}`;
        const explicit = col in d && d[col];
        if (!(col in d) && existing) d[col] = existing[col];
        else if (!d[col]) d[col] = slugify((tr && tr[l] && tr[l].title) || '') || '';
        const me = { slug: d.slug || (existing && existing.slug), slug_en: d.slug_en ?? (existing && existing.slug_en), slug_ru: d.slug_ru ?? (existing && existing.slug_ru) };
        const taken = new Set(others.map(eff[l]));
        if (!taken.has(eff[l](me))) continue;
        if (explicit) throw err(422, 'Bu ünvan artıq başqa xəbərdə istifadə olunur', { fields: { [col]: 'Bu ünvan artıq başqa xəbərdə istifadə olunur' } });
        const want = eff[l](me);
        let cand = want, i = 2;
        while (taken.has(cand)) cand = `${want}-${i++}`;
        d[col] = cand;
      }
      if (!existing) { d.created_by = ctx.user.id; if (!d.author_name) d.author_name = ctx.user.name; }
      const status = d.status || (existing && existing.status);
      const published = 'published_at' in d ? d.published_at : existing && existing.published_at;
      if (status === 'published' && !published) d.published_at = new Date().toISOString();
    },
    present: (r) => ({ ...r, cover: mediaById(r.cover_media_id), gallery_items: mediaList(r.gallery) }),
    afterSave: () => siteNews.schedule('xəbər yadda saxlanıldı'),
    afterDelete: () => siteNews.schedule('xəbər silindi'),
    exportColumns: [
      { label: 'ID', get: (r) => r.id }, { label: 'Başlıq', get: (r) => r.title }, { label: 'Kateqoriya', get: (r) => r.category },
      { label: 'Müəllif', get: (r) => r.author_name }, { label: 'Status', get: (r) => NEWS_STATUS[r.status] }, { label: 'Seçilmiş', get: (r) => (r.is_featured ? 'Bəli' : 'Xeyr') },
      { label: 'Dərc tarixi', get: (r) => day(r.published_at) }, { label: 'Baxış', get: (r) => r.views }, { label: 'Slug', get: (r) => r.slug }, { label: 'Teqlər', get: (r) => (r.tags || []).join(', ') },
    ],
    extra(a) {
      a.get('/api/news/meta', can('news.view'), (ctx) => {
        const tags = new Set();
        for (const r of all('SELECT tags FROM news')) { try { JSON.parse(r.tags).forEach((t) => tags.add(t)); } catch { /* ignore */ } }
        ctx.json({ categories: all("SELECT DISTINCT category FROM news WHERE category <> '' ORDER BY category").map((r) => r.category), tags: [...tags].sort(), statuses: NEWS_STATUS });
      });
    },
  });

  /* ------------------------------------------- news -> website pages */
  app.get('/api/site/status', can('news.view'), (ctx) => ctx.json(siteNews.status()));
  app.post('/api/site/publish', can('news.edit'), (ctx) => {
    if (!siteNews.enabled()) throw err(409, 'Layihədə site/xeberler qovluğu tapılmadı');
    const r = siteNews.generate({ reason: `${ctx.user.name} əl ilə yenilədi` });
    audit(ctx, { action: 'Saytın yenilənməsi', module: 'Xəbərlər', summary: `${ctx.user.name} xəbər səhifələrini yenilədi: ${r.written.length} fayl yazıldı, ${r.removed.length} silindi${r.ok ? '' : ' (xəta var)'}` });
    ctx.json({ result: r, status: siteNews.status() });
  });

  /* --------------------------------------------------------- projects */
  const projText = { name: v.str({ max: 200 }), client: v.str({ max: 200 }), location: v.str({ max: 200 }), sector: v.str({ max: 120 }), project_type: v.str({ max: 120 }),
    description: v.text({ max: 50000 }), stats: kv(), seo_title: v.str({ max: 120 }), seo_description: v.str({ max: 300 }) };
  defineResource(app, {
    name: 'projects', path: '/api/projects', table: 'projects', module: 'Layihələr', reorder: true,
    perms: { view: 'projects.view', create: 'projects.create', edit: 'projects.edit', delete: 'projects.delete' },
    shape: {
      ...projText, name: v.str({ max: 200, required: true }), slug: v.slug(), start_date: v.date(), end_date: v.date(),
      status: v.oneOf(Object.keys(PROJECT_STATUS), { default: 'planned' }), is_active: v.bool({ default: true }), main_media_id: mediaId(),
      gallery: idList(30), documents: idList(20), sort_order: v.int({ min: 0, max: 100000, default: 0 }), i18n: v.i18n(projText),
    },
    jsonCols: ['gallery', 'documents', 'stats', 'i18n'], mediaCols: ['main_media_id'], mediaListCols: ['gallery'],
    search: ['name', 'client', 'location', 'sector', 'project_type'],
    filters: { status: { col: 'status', values: Object.keys(PROJECT_STATUS) }, sector: { col: 'sector' }, active: { col: 'is_active', int: true } },
    dateCol: 'COALESCE(start_date, created_at)',
    sortable: { name: 'fold(name)', client: 'fold(client)', start: 'start_date', end: 'end_date', status: 'status', order: 'sort_order' },
    defaultSort: 'sort_order ASC, id DESC',
    label: (r) => `Layihə #${r.id} «${r.name}»`,
    actionName: (a, b) => (a.status !== b.status ? 'Status dəyişikliyi' : a.is_active !== b.is_active ? (b.is_active ? 'Aktivləşdirmə' : 'Deaktivləşdirmə') : 'Redaktə'),
    prepare(ctx, d, existing) {
      ensureSlug('projects', d, existing, 'name');
      if (d.start_date && d.end_date && d.end_date < d.start_date) { throw err(422, 'Bitmə tarixi başlama tarixindən əvvəl ola bilməz', { fields: { end_date: 'Bitmə tarixi başlama tarixindən əvvəl ola bilməz' } }); }
      if (!existing && !d.sort_order) d.sort_order = (get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM projects').m || 0) + 1;
    },
    present: (r) => ({ ...r, main: mediaById(r.main_media_id), gallery_items: mediaList(r.gallery),
      document_items: (r.documents || []).map((id) => get('SELECT id, title, visibility FROM documents WHERE id = ?', id)).filter(Boolean) }),
    exportColumns: [
      { label: 'ID', get: (r) => r.id }, { label: 'Layihənin adı', get: (r) => r.name }, { label: 'Sifarişçi', get: (r) => r.client }, { label: 'Yer', get: (r) => r.location },
      { label: 'Sektor', get: (r) => r.sector }, { label: 'Layihə növü', get: (r) => r.project_type }, { label: 'Başlama', get: (r) => r.start_date || '' }, { label: 'Bitmə', get: (r) => r.end_date || '' },
      { label: 'Status', get: (r) => PROJECT_STATUS[r.status] }, { label: 'Saytda aktiv', get: (r) => (r.is_active ? 'Bəli' : 'Xeyr') },
    ],
    extra(a) {
      a.get('/api/projects/meta', can('projects.view'), (ctx) => ctx.json({
        sectors: all("SELECT DISTINCT sector FROM projects WHERE sector <> '' ORDER BY sector").map((r) => r.sector),
        types: all("SELECT DISTINCT project_type FROM projects WHERE project_type <> '' ORDER BY project_type").map((r) => r.project_type), statuses: PROJECT_STATUS }));
    },
  });

  /* --------------------------------------------------------- services */
  const svcText = { title: v.str({ max: 200 }), short_description: v.text({ max: 600 }), full_description: v.text({ max: 50000 }), features: v.arr(v.str({ max: 200 }), { max: 30 }),
    seo_title: v.str({ max: 120 }), seo_description: v.str({ max: 300 }) };
  defineResource(app, {
    name: 'services', path: '/api/services', table: 'services', module: 'Xidmətlər', reorder: true,
    perms: { view: 'services.view', create: 'services.create', edit: 'services.edit', delete: 'services.delete' },
    shape: { ...svcText, title: v.str({ max: 200, required: true }), slug: v.slug(), icon: v.str({ max: 40, pattern: /^[a-z0-9-]*$/ }), image_media_id: mediaId(),
      sort_order: v.int({ min: 0, max: 100000, default: 0 }), is_active: v.bool({ default: true }), i18n: v.i18n(svcText) },
    jsonCols: ['features', 'i18n'], mediaCols: ['image_media_id'],
    search: ['title', 'short_description'],
    filters: { active: { col: 'is_active', int: true } },
    sortable: { title: 'fold(title)', order: 'sort_order' },
    defaultSort: 'sort_order ASC, id ASC',
    label: (r) => `Xidmət #${r.id} «${r.title}»`,
    actionName: (a, b) => (a.is_active !== b.is_active ? (b.is_active ? 'Aktivləşdirmə' : 'Deaktivləşdirmə') : 'Redaktə'),
    prepare(ctx, d, existing) {
      ensureSlug('services', d, existing, 'title');
      if (!existing && !d.sort_order) d.sort_order = (get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM services').m || 0) + 1;
    },
    present: (r) => ({ ...r, image: mediaById(r.image_media_id) }),
  });

  /* ------------------------------------------------------------- team */
  const teamText = { name: v.str({ max: 150 }), position: v.str({ max: 150 }), biography: v.text({ max: 5000 }) };
  defineResource(app, {
    name: 'team', path: '/api/team', table: 'team_members', module: 'Komanda', reorder: true,
    perms: { view: 'team.view', create: 'team.create', edit: 'team.edit', delete: 'team.delete' },
    shape: { ...teamText, name: v.str({ max: 150, required: true }), photo_media_id: mediaId(), email: v.email(), linkedin: v.url(), phone: v.phone(),
      sort_order: v.int({ min: 0, max: 100000, default: 0 }), is_active: v.bool({ default: true }), i18n: v.i18n(teamText) },
    jsonCols: ['i18n'], mediaCols: ['photo_media_id'],
    search: ['name', 'position', 'email'],
    filters: { active: { col: 'is_active', int: true } },
    sortable: { name: 'fold(name)', position: 'fold(position)', order: 'sort_order' },
    defaultSort: 'sort_order ASC, id ASC',
    label: (r) => `Əməkdaş #${r.id} «${r.name}»`,
    prepare(ctx, d, existing) { if (!existing && !d.sort_order) d.sort_order = (get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM team_members').m || 0) + 1; },
    present: (r) => ({ ...r, photo: mediaById(r.photo_media_id) }),
  });
};
module.exports.NEWS_STATUS = NEWS_STATUS;
module.exports.PROJECT_STATUS = PROJECT_STATUS;
