// Pages: news, projects, services, company content, team, documents, media, users & roles, settings.
import { h, raw, setHTML, $, $$, icon, api, qs, state, can, isSuper, toast, showError, nf, fmtDate, fmtDateTime, fmtSize, chip, confirmDialog, promptDialog, modal, copyText, initials } from './core.js';
import { dataTable, buildForm, uploadFiles, mediaThumb, pickMedia } from './ui.js';

const go = (hash) => { location.hash = '#/' + hash; };
const LANGS = ['en', 'ru'];
const NEWS_STATUS = { draft: ['Qaralama', 'grey'], published: ['Dərc olunub', 'green'], archived: ['Arxiv', 'amber'] };
const PROJECT_STATUS = { planned: ['Planlaşdırılır', 'blue'], ongoing: ['Davam edir', 'amber'], completed: ['Tamamlanıb', 'green'], archived: ['Arxiv', 'grey'] };
const st = (map, k) => chip((map[k] || [k])[0], (map[k] || [])[1]);
const opts = (map) => Object.entries(map).map(([k, v]) => [k, v[0]]);
const seoSection = { title: 'SEO', sub: 'Axtarış sistemləri üçün başlıq və təsvir', fields: [
  { name: 'seo_title', label: 'SEO başlığı', i18n: true, full: true, max: 120, help: '60–70 simvol tövsiyə olunur. Boş qalsa, əsas başlıq istifadə olunur.' },
  { name: 'seo_description', label: 'SEO təsviri', type: 'textarea', rows: 2, i18n: true, full: true, max: 300, help: '160 simvola qədər tövsiyə olunur.' }] };
const delAction = async (url, text, reload) => { if (!(await confirmDialog(text, { title: 'Silmə təsdiqi', ok: 'Sil', danger: true }))) return; try { await api.del(url); toast('Silindi', 'ok'); reload(); } catch (e) { showError(e); } };
const iconBtn = (act, ic, label, extra = '') => h`<button class="iconbtn ${extra}" data-act="${act}" aria-label="${label}" title="${label}">${icon(ic)}</button>`;
const backLink = (hash, label) => h`<a class="back" href="#/${hash}">${icon('left', 'sm')}${label}</a>`;

/* ------------------------------------------------------------------- news */
async function news(view, args) {
  if (args[0]) return newsForm(view, args[0]);
  try { view._cats = (await api.get('/api/news/meta')).categories.map((c) => [c, c]); } catch { view._cats = []; }
  setHTML(view, h`<div id="siteBox" style="margin-bottom:16px"></div><section class="card" id="nT"></section>`);
  drawSiteStatus($('#siteBox'));
  dataTable($('#nT'), { id: 'news', url: '/api/news', sort: '-date', dateRange: true, exportUrl: '/api/news/export', searchPlaceholder: 'Başlıq, kateqoriya, teq…',
    filters: [{ key: 'status', label: 'Status', options: opts(NEWS_STATUS) }, { key: 'category', label: 'Kateqoriya', options: () => view._cats || [] }, { key: 'featured', label: 'Seçilmiş', options: [['1', 'Yalnız seçilmişlər']] }],
    extra: can('news.create') ? h`<a class="btn sm pri" href="#/xeberler/yeni">${icon('plus', 'sm')}Yeni xəbər</a>` : '',
    onRow: (n) => go('xeberler/' + n.id), emptyText: 'Hələ xəbər yoxdur. «Yeni xəbər» düyməsi ilə əlavə edin.',
    columns: [{ label: '', render: (n) => mediaThumb(n.cover || (n.site_image ? { url: n.site_image, kind: 'image', alt: '' } : null)) }, { label: 'Başlıq', sort: 'title', render: (n) => h`${n.is_featured ? h`<span class="star" title="Seçilmiş xəbər">${icon('star', 'sm')}</span> ` : ''}<b class="t">${n.title}</b><br><span class="mono muted">/xeberler/${n.slug}/</span>` },
      { label: 'Kateqoriya', sort: 'category', cls: 'nw', render: (n) => n.category || '—' }, { label: 'Müəllif', cls: 'nw', render: (n) => n.author_name || '—' }, { label: 'Tarix', sort: 'date', cls: 'nw', render: (n) => fmtDate(n.published_at || n.created_at) },
      { label: 'Baxış', sort: 'views', cls: 'num', render: (n) => nf(n.views) }, { label: 'Status', sort: 'status', render: (n) => st(NEWS_STATUS, n.status) }],
    actions: (n) => h`${can('news.edit') ? h`${iconBtn('feat', 'star', n.is_featured ? 'Seçilmişlərdən çıxar' : 'Önə çıxar', n.is_featured ? 'on' : '')}${n.status !== 'published' ? iconBtn('pub', 'check', 'Dərc et') : iconBtn('arch', 'history', 'Arxivləşdir')}` : ''}
      <a class="iconbtn" href="#/xeberler/${n.id}" aria-label="Redaktə et" title="Redaktə et">${icon('edit')}</a>${can('news.delete') ? iconBtn('del', 'trash', 'Sil') : ''}`,
    onAction: async (act, n, t) => {
      try {
        if (act === 'feat') { await api.patch(`/api/news/${n.id}`, { is_featured: !n.is_featured }); toast(n.is_featured ? 'Seçilmişlərdən çıxarıldı' : 'Önə çıxarıldı', 'ok'); }
        else if (act === 'pub') { await api.patch(`/api/news/${n.id}`, { status: 'published' }); toast('Xəbər dərc olundu', 'ok'); }
        else if (act === 'arch') { await api.patch(`/api/news/${n.id}`, { status: 'archived' }); toast('Xəbər arxivə göndərildi', 'ok'); }
        else if (act === 'del') return delAction(`/api/news/${n.id}`, `«${n.title}» xəbəri həmişəlik silinəcək.`, t.reload);
        t.reload();
        setTimeout(() => drawSiteStatus($('#siteBox')), 1500);
      } catch (e) { showError(e); }
    } });
}

// News are published as pages of the website. This box shows whether that works.
async function drawSiteStatus(box) {
  if (!box) return;
  let s;
  try { s = await api.get('/api/site/status'); } catch { return; }
  if (!box.isConnected) return;
  const last = s.last || {};
  const errs = (last.errors || []).filter(Boolean);
  if (!s.enabled) {
    setHTML(box, h`<div class="note warn">${icon('alert')}<span>Xəbərlər sayta yazılmır: layihədə site/xeberler qovluğu tapılmadı.</span></div>`);
    return;
  }
  setHTML(box, h`<div class="note ${errs.length ? 'warn' : ''}" style="align-items:center;flex-wrap:wrap">${icon(errs.length ? 'alert' : 'check')}
    <span style="flex:1;min-width:220px">${errs.length ? h`Saytın xəbər səhifələri yenilənərkən problem: <b>${errs.join('; ')}</b>`
      : h`Dərc olunan xəbərlər saytda avtomatik görünür (AZ, EN, RU). Son yoxlama: ${last.at ? fmtDateTime(last.at) : '—'} · saytda ${nf(last.items || 0)} xəbər.`}
      EN/RU səhifəsi yalnız həmin dildə başlıq və tam mətn yazıldıqda yaranır.</span>
    <a class="btn sm" href="/xeberler/" target="_blank" rel="noopener">${icon('eye', 'sm')}Saytda bax</a>
    ${can('news.edit') ? h`<button class="btn sm" id="sitePub">${icon('refresh', 'sm')}İndi yenilə</button>` : ''}</div>`);
  const b = $('#sitePub', box);
  if (b) b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = await api.post('/api/site/publish'); toast(r.result.ok ? `Sayt yeniləndi: ${r.result.written.length} fayl dəyişdi` : 'Yeniləmədə problem var', r.result.ok ? 'ok' : 'error'); }
    catch (e) { showError(e); }
    drawSiteStatus(box);
  });
}

async function newsForm(view, id) {
  const isNew = id === 'yeni';
  const [meta, data] = await Promise.all([api.get('/api/news/meta'), isNew ? null : api.get(`/api/news/${encodeURIComponent(id)}`)]);
  const n = data ? data.item : { status: 'draft', tags: [], i18n: {}, author_name: state.user.name };
  const editable = isNew ? can('news.create') : can('news.edit');
  setHTML(view, h`${backLink('xeberler', 'Bütün xəbərlər')}<h2 class="ptitle">${isNew ? 'Yeni xəbər' : 'Xəbəri redaktə et'}</h2><div id="nf"></div>`);
  buildForm($('#nf'), { langs: LANGS, values: n, readonly: !editable, cancelHref: '#/xeberler', langHint: 'Bu dildə başlıq və tam mətn yazılmasa, xəbərin bu dildə səhifəsi saytda yaranmır.', submitLabel: isNew ? 'Xəbəri yarat' : 'Dəyişiklikləri saxla',
    sections: [
      { title: 'Məzmun', fields: [{ name: 'title', label: 'Başlıq', required: true, i18n: true, full: true, max: 200 },
        { name: 'slug', label: 'Slug (səhifə ünvanı)', full: true, mono: true, slugFrom: 'title', max: 120, help: 'Saytda: /xeberler/<slug>/. Başlıqdan avtomatik yaranır. Yalnız kiçik latın hərfləri, rəqəm və tire.' },
        { name: 'excerpt', label: 'Qısa təsvir', type: 'textarea', rows: 3, i18n: true, full: true, max: 600 },
        { name: 'content', label: 'Tam mətn', type: 'markdown', rows: 14, i18n: true, full: true }] },
      { title: 'Şəkillər', fields: [{ name: 'cover_media_id', label: 'Əsas şəkil (cover)', type: 'media', full: true },
        { name: 'cover_alt', label: 'Şəklin təsviri (alt mətn)', i18n: true, full: true, max: 200, help: 'Görmə imkanı məhdud oxucular və axtarış sistemləri üçün: şəkildə nə göstərilir.' },
        { name: 'site_image', label: 'Saytdakı mövcud şəkil', mono: true, full: true, max: 120, placeholder: '/assets/img/news-iea.jpg', help: 'Yalnız əsas şəkil seçilməyibsə istifadə olunur (köhnə xəbərlərin şəkilləri belədir).' },
        { name: 'gallery', label: 'Qalereya', type: 'gallery', full: true, itemsKey: 'gallery_items' }] },
      { title: 'İngilis və rus səhifələrinin ünvanı', sub: 'Boş qalsa, tərcümə başlığından avtomatik yaranır', fields: [
        { name: 'slug_en', label: 'EN: /en/news/…/', mono: true, max: 120 }, { name: 'slug_ru', label: 'RU: /ru/news/…/', mono: true, max: 120 }] },
      seoSection,
      { title: 'Dərc', col: 'side', fields: [{ name: 'status', label: 'Status', type: 'select', options: opts(NEWS_STATUS) }, { name: 'published_at', label: 'Dərc tarixi', type: 'datetime', help: 'Boş qalsa, dərc edilən an yazılır. Gələcək tarix seçilsə, xəbər həmin vaxt saytda görünür.' },
        { name: 'is_featured', label: 'Seçilmiş xəbər (önə çıxar)', type: 'checkbox' }, { name: 'category', label: 'Kateqoriya', i18n: true, list: meta.categories, max: 80 }, { name: 'tags', label: 'Teqlər', type: 'tags' },
        { name: 'author_name', label: 'Müəllif', max: 120 }] }],
    onSubmit: async (v) => {
      if (isNew) { const r = await api.post('/api/news', v); toast('Xəbər yaradıldı', 'ok'); go('xeberler/' + r.item.id); }
      else { await api.put(`/api/news/${n.id}`, v); toast('Xəbər yadda saxlanıldı', 'ok'); go('xeberler'); }
    } });
}

/* --------------------------------------------------------------- projects */
async function projects(view, args) {
  if (args[0]) return projectForm(view, args[0]);
  try { view._sectors = (await api.get('/api/projects/meta')).sectors.map((c) => [c, c]); } catch { view._sectors = []; }
  setHTML(view, h`<section class="card" id="pT"></section>`);
  dataTable($('#pT'), { id: 'projects', url: '/api/projects', dateRange: true, exportUrl: '/api/projects/export', searchPlaceholder: 'Layihə, sifarişçi, yer…',
    filters: [{ key: 'status', label: 'Status', options: opts(PROJECT_STATUS) }, { key: 'sector', label: 'Sektor', options: () => view._sectors || [] }, { key: 'active', label: 'Saytda', options: [['1', 'Aktiv'], ['0', 'Gizli']] }],
    extra: can('projects.create') ? h`<a class="btn sm pri" href="#/layiheler/yeni">${icon('plus', 'sm')}Yeni layihə</a>` : '', onRow: (p) => go('layiheler/' + p.id), emptyText: 'Hələ layihə yoxdur. «Yeni layihə» düyməsi ilə əlavə edin.',
    columns: [{ label: '', render: (p) => mediaThumb(p.main) }, { label: 'Layihənin adı', sort: 'name', render: (p) => h`<b class="t">${p.name}</b>` }, { label: 'Sifarişçi', sort: 'client', render: (p) => p.client || '—' }, { label: 'Yer', render: (p) => p.location || '—' },
      { label: 'Sektor', render: (p) => p.sector || '—' }, { label: 'Başlama', sort: 'start', cls: 'nw', render: (p) => fmtDate(p.start_date) }, { label: 'Bitmə', sort: 'end', cls: 'nw', render: (p) => fmtDate(p.end_date) },
      { label: 'Status', sort: 'status', render: (p) => st(PROJECT_STATUS, p.status) }, { label: 'Saytda', render: (p) => (can('projects.edit') ? h`<input type="checkbox" class="switch" data-act="toggle" aria-label="Saytda göstər" ${p.is_active ? raw('checked') : ''}>` : chip(p.is_active ? 'Aktiv' : 'Gizli', p.is_active ? 'green' : 'grey')) }],
    actions: (p) => h`<a class="iconbtn" href="#/layiheler/${p.id}" aria-label="Redaktə et" title="Redaktə et">${icon('edit')}</a>${can('projects.delete') ? iconBtn('del', 'trash', 'Sil') : ''}`,
    onAction: async (act, p, t) => {
      if (act === 'del') return delAction(`/api/projects/${p.id}`, `«${p.name}» layihəsi həmişəlik silinəcək.`, t.reload);
      if (act === 'toggle') { try { await api.patch(`/api/projects/${p.id}`, { is_active: !p.is_active }); toast(p.is_active ? 'Layihə saytda gizlədildi' : 'Layihə saytda aktiv edildi', 'ok'); } catch (e) { showError(e); } t.reload(); }
    } });
}
async function projectForm(view, id) {
  const isNew = id === 'yeni';
  const [meta, data, docs] = await Promise.all([api.get('/api/projects/meta'), isNew ? null : api.get(`/api/projects/${encodeURIComponent(id)}`), can('documents.view') ? api.get('/api/documents?per_page=100') : { items: [] }]);
  const p = data ? data.item : { status: 'planned', is_active: 1, stats: [], documents: [], i18n: {} };
  const editable = isNew ? can('projects.create') : can('projects.edit');
  setHTML(view, h`${backLink('layiheler', 'Bütün layihələr')}<h2 class="ptitle">${isNew ? 'Yeni layihə' : 'Layihəni redaktə et'}</h2><div id="pf"></div>`);
  const f = buildForm($('#pf'), { langs: LANGS, values: p, readonly: !editable, cancelHref: '#/layiheler', submitLabel: isNew ? 'Layihəni yarat' : 'Dəyişiklikləri saxla',
    sections: [
      { title: 'Əsas məlumat', fields: [{ name: 'name', label: 'Layihənin adı', required: true, i18n: true, full: true, max: 200 }, { name: 'slug', label: 'Slug (səhifə ünvanı)', mono: true, slugFrom: 'name', full: true, max: 120 },
        { name: 'client', label: 'Sifarişçi', i18n: true, max: 200 }, { name: 'location', label: 'Yer', i18n: true, max: 200 }, { name: 'sector', label: 'Sektor', i18n: true, list: meta.sectors, max: 120 }, { name: 'project_type', label: 'Layihə növü', i18n: true, list: meta.types, max: 120 },
        { name: 'description', label: 'Təsvir', type: 'markdown', rows: 10, i18n: true, full: true }] },
      { title: 'Layihə göstəriciləri', sub: 'Məsələn: Güc — 2 MVt', fields: [{ name: 'stats', label: 'Göstəricilər', type: 'rows', i18n: true, full: true, columns: [{ key: 'label', label: 'Göstərici' }, { key: 'value', label: 'Dəyər', width: '160px' }], addLabel: 'Göstərici əlavə et' }] },
      { title: 'Şəkillər və sənədlər', fields: [{ name: 'main_media_id', label: 'Əsas şəkil', type: 'media', full: true }, { name: 'gallery', label: 'Qalereya', type: 'gallery', full: true, itemsKey: 'gallery_items' },
        { name: '_docs', label: 'Əlaqəli sənədlər', type: 'static', full: true, value: '' }] },
      seoSection,
      { title: 'Vəziyyət', col: 'side', fields: [{ name: 'status', label: 'Status', type: 'select', options: opts(PROJECT_STATUS) }, { name: 'is_active', label: 'Saytda göstər', type: 'checkbox' },
        { name: 'start_date', label: 'Başlama tarixi', type: 'date' }, { name: 'end_date', label: 'Bitmə tarixi', type: 'date' }] }],
    onSubmit: async (v) => {
      delete v._docs;
      // Links to documents this user cannot see (or that are beyond the listed ones) are kept as they are.
      const listed = new Set(docs.items.map((d) => d.id));
      v.documents = [...(p.documents || []).filter((x) => !listed.has(x)), ...$$('#docPick input:checked', view).map((x) => Number(x.value))];
      if (isNew) { const r = await api.post('/api/projects', v); toast('Layihə yaradıldı', 'ok'); go('layiheler/' + r.item.id); }
      else { await api.put(`/api/projects/${p.id}`, { ...v, sort_order: p.sort_order }); toast('Layihə yadda saxlanıldı', 'ok'); go('layiheler'); }
    } });
  const holder = $('.static', f.form);
  if (holder) setHTML(holder, docs.items.length ? h`<div id="docPick" class="checks">${docs.items.map((d) => h`<label class="check"><input type="checkbox" value="${d.id}" ${(p.documents || []).includes(d.id) ? raw('checked') : ''} ${editable ? '' : raw('disabled')}> <span>${d.title} ${d.visibility === 'public' ? '' : h`<span class="tag">daxili</span>`}</span></label>`)}</div><small class="muted">Saytda yalnız «Açıq» sənədlər görünür.</small>` : h`<span class="muted" id="docPick">Sənədlər bölməsində hələ sənəd yoxdur.</span>`);
}

/* --------------------------------------------------------------- services */
const ICONS = [['', 'İkon yoxdur'], ['bolt', 'Enerji'], ['chip', 'Rəqəmsal'], ['leaf', 'Yaşıl enerji'], ['academy', 'Təhsil'], ['gear', 'Mühəndislik'], ['chart', 'Analitika'], ['shield', 'Təhlükəsizlik'], ['lab', 'Laboratoriya']];
async function services(view, args) {
  if (args[0]) return serviceForm(view, args[0]);
  const editable = can('services.edit');
  const draw = async () => {
    const d = await api.get('/api/services?per_page=100');
    setHTML(view, h`<section class="card"><div class="card-h"><div><h2>Xidmətlər</h2><p>Saytdakı sıra buradakı sıra ilə eynidir${editable ? ' — oxlarla dəyişin' : ''}</p></div><span class="sp"></span>${can('services.create') ? h`<a class="btn sm pri" href="#/xidmetler/yeni">${icon('plus', 'sm')}Yeni xidmət</a>` : ''}</div>
      <div style="margin-top:12px">${d.items.length ? d.items.map((s, i) => h`<div class="svc" data-id="${s.id}"><span class="ord">${String(i + 1).padStart(2, '0')}</span>${mediaThumb(s.image)}<div class="st"><b>${s.title}</b><span>${s.short_description}</span></div>
        ${editable ? h`<button class="iconbtn" data-mv="-1" aria-label="Yuxarı" title="Yuxarı" ${i === 0 ? raw('disabled') : ''}>${icon('up')}</button><button class="iconbtn" data-mv="1" aria-label="Aşağı" title="Aşağı" ${i === d.items.length - 1 ? raw('disabled') : ''}>${icon('dn')}</button>
        <input type="checkbox" class="switch" data-sw aria-label="Saytda aktiv" title="Saytda aktiv" ${s.is_active ? raw('checked') : ''}>` : chip(s.is_active ? 'Aktiv' : 'Gizli', s.is_active ? 'green' : 'grey')}
        <a class="iconbtn" href="#/xidmetler/${s.id}" aria-label="Redaktə et" title="Redaktə et">${icon('edit')}</a>${can('services.delete') ? h`<button class="iconbtn" data-del aria-label="Sil" title="Sil">${icon('trash')}</button>` : ''}</div>`) : h`<div class="empty">Hələ xidmət yoxdur</div>`}</div></section>`);
    view._items = d.items;
  };
  view.addEventListener('click', async (e) => {
    const row = e.target.closest('.svc'); if (!row) return;
    const id = Number(row.dataset.id), items = view._items, i = items.findIndex((x) => x.id === id);
    const mv = e.target.closest('[data-mv]');
    if (mv) { const j = i + Number(mv.dataset.mv); const ids = items.map((x) => x.id); [ids[i], ids[j]] = [ids[j], ids[i]]; try { await api.post('/api/services/reorder', { ids }); } catch (er) { showError(er); } draw(); return; }
    if (e.target.closest('[data-del]')) delAction(`/api/services/${id}`, `«${items[i].title}» xidməti həmişəlik silinəcək.`, draw);
  });
  view.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-sw]')) return;
    const id = e.target.closest('.svc').dataset.id;
    try { await api.patch(`/api/services/${id}`, { is_active: e.target.checked }); toast(e.target.checked ? 'Xidmət aktivləşdirildi' : 'Xidmət saytda gizlədildi', 'ok'); } catch (er) { showError(er); draw(); }
  });
  await draw();
}
async function serviceForm(view, id) {
  const isNew = id === 'yeni';
  const data = isNew ? null : await api.get(`/api/services/${encodeURIComponent(id)}`);
  const s = data ? data.item : { is_active: 1, features: [], i18n: {} };
  const editable = isNew ? can('services.create') : can('services.edit');
  setHTML(view, h`${backLink('xidmetler', 'Bütün xidmətlər')}<h2 class="ptitle">${isNew ? 'Yeni xidmət' : 'Xidməti redaktə et'}</h2><div id="sf"></div>`);
  buildForm($('#sf'), { langs: LANGS, values: s, readonly: !editable, cancelHref: '#/xidmetler',
    sections: [{ title: 'Məzmun', fields: [{ name: 'title', label: 'Başlıq', required: true, i18n: true, full: true, max: 200 }, { name: 'slug', label: 'Slug', mono: true, slugFrom: 'title', full: true, max: 120 },
      { name: 'short_description', label: 'Qısa təsvir', type: 'textarea', rows: 3, i18n: true, full: true, max: 600 }, { name: 'full_description', label: 'Tam təsvir', type: 'markdown', rows: 10, i18n: true, full: true },
      { name: 'features', label: 'Xüsusiyyətlər (siyahı)', type: 'rows', i18n: true, full: true, columns: [{ key: '', label: 'Xüsusiyyət' }], addLabel: 'Sətir əlavə et' }] }, seoSection,
    { title: 'Görünüş', col: 'side', fields: [{ name: 'is_active', label: 'Saytda aktiv', type: 'checkbox' }, { name: 'icon', label: 'İkon', type: 'select', options: ICONS }, { name: 'image_media_id', label: 'Şəkil', type: 'media' }] }],
    onSubmit: async (v) => { if (isNew) await api.post('/api/services', v); else await api.put(`/api/services/${s.id}`, { ...v, sort_order: s.sort_order }); toast('Xidmət yadda saxlanıldı', 'ok'); go('xidmetler'); } });
}

/* ---------------------------------------------------------------- company */
async function company(view) {
  const { company: c } = await api.get('/api/company');
  setHTML(view, h`<div id="cf"></div>`);
  buildForm($('#cf'), { langs: LANGS, values: c, readonly: !can('company.edit'), submitLabel: 'Dəyişiklikləri saxla', footerNote: 'Dəyişikliklər saytın bu məlumatı oxuyan hissələrində görünür.',
    sections: [{ title: 'Şirkət haqqında', sub: '“Haqqımızda” səhifəsinin mətnləri', fields: [{ name: 'about', label: 'Şirkət haqqında', type: 'textarea', rows: 6, i18n: true, full: true, max: 8000 },
      { name: 'mission', label: 'Missiya', type: 'textarea', rows: 3, i18n: true, full: true, max: 2000 }, { name: 'vision', label: 'Vizyon', type: 'textarea', rows: 3, i18n: true, full: true, max: 2000 },
      { name: 'values', label: 'Dəyərlər', type: 'rows', i18n: true, full: true, columns: [{ key: 'title', label: 'Dəyər', width: '200px' }, { key: 'text', label: 'İzah', type: 'textarea' }], addLabel: 'Dəyər əlavə et' }] },
    { title: 'Şirkət göstəriciləri', sub: 'Saytda yalnız «Göstər» işarələnmiş və dəyəri yazılmış göstəricilər görünür', fields: [{ name: 'stats', label: 'Göstəricilər', type: 'rows', i18n: true, full: true,
      columns: [{ key: 'label', label: 'Göstərici (məs. Tamamlanmış layihələr)' }, { key: 'value', label: 'Rəqəm', width: '130px' }, { key: 'is_active', label: 'Göstər', type: 'checkbox' }], addLabel: 'Göstərici əlavə et' }] }],
    onSubmit: async (v) => { await api.put('/api/settings/company', v); toast('Şirkət məlumatları yadda saxlanıldı', 'ok'); } });
}

/* ------------------------------------------------------------------- team */
async function team(view, args) {
  if (args[0]) return teamForm(view, args[0]);
  const editable = can('team.edit');
  const draw = async () => {
    const d = await api.get('/api/team?per_page=100');
    view._items = d.items;
    setHTML(view, h`<div class="row"><span class="muted" style="flex:1">Saytda yalnız aktiv əməkdaşlar göstərilir, sıra buradakı kimidir.</span>${can('team.create') ? h`<a class="btn sm pri" href="#/komanda/yeni">${icon('plus', 'sm')}Əməkdaş əlavə et</a>` : ''}</div>
      ${d.items.length ? h`<div class="people">${d.items.map((t, i) => h`<div class="card person" data-id="${t.id}">${t.photo ? mediaThumb(t.photo, 'round') : h`<span class="avatar">${initials(t.name)}</span>`}<div><b>${t.name}</b><br><span class="muted">${t.position || '—'}</span></div>
        <div class="row">${chip(t.is_active ? 'Aktiv' : 'Gizli', t.is_active ? 'green' : 'grey')}<span class="tag">Sıra: ${i + 1}</span></div>
        <div class="row">${editable ? h`<button class="iconbtn" data-mv="-1" aria-label="Əvvələ" title="Əvvələ" ${i === 0 ? raw('disabled') : ''}>${icon('up')}</button><button class="iconbtn" data-mv="1" aria-label="Sonraya" title="Sonraya" ${i === d.items.length - 1 ? raw('disabled') : ''}>${icon('dn')}</button>` : ''}
          <a class="btn sm" href="#/komanda/${t.id}">${icon('edit', 'sm')}${editable ? 'Redaktə' : 'Bax'}</a>${can('team.delete') ? h`<button class="btn sm ghost danger" data-del>Sil</button>` : ''}</div></div>`)}</div>` : h`<div class="card"><div class="empty">Hələ əməkdaş əlavə olunmayıb</div></div>`}`);
  };
  view.addEventListener('click', async (e) => {
    const card = e.target.closest('.person'); if (!card) return;
    const id = Number(card.dataset.id), items = view._items, i = items.findIndex((x) => x.id === id);
    const mv = e.target.closest('[data-mv]');
    if (mv) { const j = i + Number(mv.dataset.mv); const ids = items.map((x) => x.id); [ids[i], ids[j]] = [ids[j], ids[i]]; try { await api.post('/api/team/reorder', { ids }); } catch (er) { showError(er); } draw(); return; }
    if (e.target.closest('[data-del]')) delAction(`/api/team/${id}`, `«${items[i].name}» komanda siyahısından silinəcək.`, draw);
  });
  await draw();
}
async function teamForm(view, id) {
  const isNew = id === 'yeni';
  const data = isNew ? null : await api.get(`/api/team/${encodeURIComponent(id)}`);
  const t = data ? data.item : { is_active: 1, i18n: {} };
  const editable = isNew ? can('team.create') : can('team.edit');
  setHTML(view, h`${backLink('komanda', 'Komanda')}<h2 class="ptitle">${isNew ? 'Yeni əməkdaş' : 'Əməkdaşı redaktə et'}</h2><div id="tf"></div>`);
  buildForm($('#tf'), { langs: LANGS, values: t, readonly: !editable, cancelHref: '#/komanda',
    sections: [{ title: 'Əməkdaş', fields: [{ name: 'name', label: 'Ad, soyad', required: true, i18n: true, max: 150 }, { name: 'position', label: 'Vəzifə', i18n: true, max: 150 },
      { name: 'biography', label: 'Qısa bioqrafiya', type: 'textarea', rows: 5, i18n: true, full: true, max: 5000 }, { name: 'email', label: 'E-poçt', type: 'email', max: 254 }, { name: 'phone', label: 'Telefon', type: 'tel', max: 40 },
      { name: 'linkedin', label: 'LinkedIn', type: 'url', full: true, placeholder: 'https://www.linkedin.com/in/…' }] },
    { title: 'Görünüş', col: 'side', fields: [{ name: 'photo_media_id', label: 'Şəkil', type: 'media' }, { name: 'is_active', label: 'Saytda göstər', type: 'checkbox' }] }],
    onSubmit: async (v) => { if (isNew) await api.post('/api/team', v); else await api.put(`/api/team/${t.id}`, { ...v, sort_order: t.sort_order }); toast('Yadda saxlanıldı', 'ok'); go('komanda'); } });
}

/* -------------------------------------------------------------- documents */
async function documents(view) {
  const meta = await api.get('/api/documents/meta');
  const cats = Object.entries(meta.categories);
  setHTML(view, h`<section class="card" id="dT"></section><div class="note">${icon('shield')}<span><b>Fayl təhlükəsizliyi:</b> yalnız ${meta.allowed.join(', ').toUpperCase()} faylları qəbul olunur (ən çox ${meta.max_mb} MB), məzmunu yoxlanılır və təsadüfi adla saxlanılır. «Daxili» sənədlər yalnız panelə daxil olmuş istifadəçilərə açılır; saytda yalnız «Açıq» sənədlər görünür.</span></div>`);
  const fields = (d) => [{ name: 'title', label: 'Sənədin adı', value: d ? d.title : '', required: true }, { name: 'category', label: 'Kateqoriya', type: 'select', options: cats, value: d ? d.category : 'company' },
    { name: 'visibility', label: 'Görünmə', type: 'select', options: [['internal', 'Daxili (yalnız panel)'], ['public', 'Açıq (saytda görünür)']], value: d ? d.visibility : 'internal' }, { name: 'description', label: 'Qısa təsvir', type: 'textarea', rows: 3, value: d ? d.description : '' }];
  const table = dataTable($('#dT'), { id: 'docs', url: '/api/documents', sort: '-date', dateRange: true, searchPlaceholder: 'Sənədin adı…',
    filters: [{ key: 'category', label: 'Kateqoriya', options: cats }, { key: 'visibility', label: 'Görünmə', options: [['public', 'Açıq'], ['internal', 'Daxili']] }],
    extra: can('documents.create') ? h`<button class="btn sm pri" id="docUp">${icon('upload', 'sm')}Sənəd yüklə</button>` : '', emptyText: 'Hələ sənəd yüklənməyib',
    columns: [{ label: 'Sənəd', sort: 'title', render: (d) => h`<span class="row nowrap"><span class="ft">${String(d.ext).toUpperCase()}</span><span><b class="t">${d.title}</b><br><span class="muted" style="font-size:12.5px">${d.file_name} · ${fmtSize(d.size)}</span></span></span>` },
      { label: 'Kateqoriya', sort: 'category', cls: 'nw', key: 'category_label' }, { label: 'Yüklənib', sort: 'date', cls: 'nw', render: (d) => fmtDate(d.created_at) }, { label: 'Yükləmə sayı', sort: 'downloads', cls: 'num', render: (d) => nf(d.downloads) },
      { label: 'Görünmə', sort: 'visibility', render: (d) => chip(d.visibility === 'public' ? 'Açıq' : 'Daxili', d.visibility === 'public' ? 'green' : 'grey') }],
    actions: (d) => h`${d.previewable ? h`<a class="iconbtn" href="/api/documents/${d.id}/download?inline=1" target="_blank" rel="noopener" aria-label="Ön baxış" title="Ön baxış">${icon('eye')}</a>` : ''}<a class="iconbtn" href="/api/documents/${d.id}/download" download aria-label="Yüklə" title="Yüklə">${icon('down')}</a>
      ${can('documents.edit') ? iconBtn('edit', 'edit', 'Adını və məlumatını dəyiş') : ''}${can('documents.delete') ? iconBtn('del', 'trash', 'Sil') : ''}`,
    onAction: async (act, d, t) => {
      if (act === 'del') return delAction(`/api/documents/${d.id}`, `«${d.title}» sənədi və faylı həmişəlik silinəcək.`, t.reload);
      if (act === 'edit') { const r = await promptDialog({ title: 'Sənədi redaktə et', fields: fields(d), submit: (v) => api.put(`/api/documents/${d.id}`, { ...v, i18n: d.i18n || {} }) }); if (r) { toast('Sənəd yeniləndi', 'ok'); t.reload(); } }
    } });
  const up = $('#docUp');
  if (up) up.addEventListener('click', () => modal((dlg, close) => {
    setHTML(dlg, h`<form novalidate><div class="modal-h"><h2>Sənəd yüklə</h2></div><div class="modal-b" style="display:grid;gap:12px">
      <label class="field"><span>Fayl *</span><input class="in" type="file" name="file" accept="${meta.allowed.map((x) => '.' + x).join(',')}"><small>${meta.allowed.join(', ').toUpperCase()} · ən çox ${meta.max_mb} MB</small></label>
      <label class="field"><span>Sənədin adı *</span><input class="in" name="title" maxlength="200"></label>
      <label class="field"><span>Kateqoriya</span><select class="in" name="category">${cats.map((c) => h`<option value="${c[0]}">${c[1]}</option>`)}</select></label>
      <label class="field"><span>Görünmə</span><select class="in" name="visibility"><option value="internal">Daxili (yalnız panel)</option><option value="public">Açıq (saytda görünür)</option></select></label>
      <label class="field"><span>Qısa təsvir</span><textarea class="in" name="description" rows="2" maxlength="1000"></textarea></label><p class="ferr" hidden></p></div>
      <div class="modal-f"><button type="button" class="btn" data-x>Ləğv et</button><button class="btn pri" type="submit">${icon('upload', 'sm')}Yüklə</button></div></form>`);
    const f = $('form', dlg), er = $('.ferr', dlg);
    $('[data-x]', dlg).addEventListener('click', () => close());
    f.file.addEventListener('change', () => { if (!f.title.value && f.file.files[0]) f.title.value = f.file.files[0].name.replace(/\.[^.]+$/, ''); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); er.hidden = true;
      const file = f.file.files[0];
      const fail = (m) => { er.textContent = m; er.hidden = false; };
      if (!file) return fail('Fayl seçin');
      if (!f.title.value.trim()) return fail('Sənədin adını yazın');
      if (file.size > meta.max_mb * 1048576) return fail(`Fayl çox böyükdür (ən çox ${meta.max_mb} MB)`);
      const fd = new FormData(f);
      const btn = $('button[type=submit]', dlg); btn.disabled = true;
      try { await api.upload('/api/documents', fd); toast('Sənəd yükləndi', 'ok'); close(true); table.reload(); } catch (x) { fail(x.fields ? Object.values(x.fields)[0] : x.message); btn.disabled = false; }
    });
  }, { label: 'Sənəd yüklə' }));
}

/* ------------------------------------------------------------------ media */
async function media(view) {
  const S = { q: '', kind: '', folder: '', page: 1 };
  setHTML(view, h`<section class="card"><div class="tbar"><div class="search">${icon('search')}<label class="sr" for="mq">Axtarış</label><input class="in" id="mq" type="search" placeholder="Fayl adı ilə axtar…"></div>
    <label class="sr" for="mk">Növ</label><select class="in" id="mk"><option value="">Növ: hamısı</option><option value="image">Şəkillər</option><option value="video">Videolar</option><option value="file">Sənədlər</option></select>
    <label class="sr" for="mfo">Qovluq</label><select class="in" id="mfo"><option value="">Qovluq: hamısı</option></select><span class="sp"></span>
    ${can('media.upload') ? h`<label class="btn sm pri">${icon('upload', 'sm')}Fayl yüklə<input type="file" id="mup" multiple hidden></label>` : ''}</div>
    <div class="card-b"><p class="muted" id="minfo" style="font-size:13px;margin-bottom:12px"></p><div class="media" id="mgrid" aria-live="polite"></div></div><div class="pager" id="mpg"></div></section>`);
  let items = [];
  const load = async () => {
    const d = await api.get('/api/media' + qs({ ...S, per_page: 24 }));
    items = d.items;
    const pages = Math.max(1, Math.ceil(d.total / 24));
    $('#minfo').textContent = `İcazəli növlər: ${d.allowed.join(', ').toUpperCase()} · bir fayl ən çox ${d.max_mb} MB`;
    const fo = $('#mfo'); if (fo.options.length !== d.folders.length + 1) { setHTML(fo, h`<option value="">Qovluq: hamısı</option>${d.folders.map((x) => h`<option value="${x}">${x}</option>`)}`); fo.value = S.folder; }
    setHTML($('#mgrid'), items.length ? h`${items.map((m) => h`<button type="button" class="mi" data-id="${m.id}" title="${m.name}">${m.kind === 'image' ? h`<span class="mp"><img src="${m.url}" alt="${m.alt || ''}" loading="lazy"></span>` : h`<span class="mp doc">${String(m.ext).toUpperCase()}</span>`}<span class="mm"><b>${m.name}</b><span class="muted">${fmtSize(m.size)}${m.folder ? ' · ' + m.folder : ''}</span></span></button>`)}` : h`<div class="empty" style="grid-column:1/-1">Fayl tapılmadı</div>`);
    setHTML($('#mpg'), h`<span>${d.total} fayl · səhifə ${S.page} / ${pages}</span><span class="row"><button class="btn sm" data-p="-1" ${S.page <= 1 ? raw('disabled') : ''}>Əvvəlki</button><button class="btn sm" data-p="1" ${S.page >= pages ? raw('disabled') : ''}>Növbəti</button></span>`);
  };
  const details = (m) => modal(async (dlg, close) => {
    let usage = [];
    try { usage = (await api.get(`/api/media/${m.id}`)).usage; } catch { usage = []; }
    const abs = location.origin + m.url;
    setHTML(dlg, h`<form novalidate><div class="modal-h"><h2>Fayl məlumatı</h2><span class="sp"></span><button type="button" class="iconbtn" data-x aria-label="Bağla">${icon('x')}</button></div><div class="modal-b" style="display:grid;gap:12px">
      <div class="preview">${m.kind === 'image' ? h`<img src="${m.url}" alt="${m.alt || ''}">` : m.kind === 'video' ? h`<video src="${m.url}" controls preload="metadata"></video>` : h`<span class="thumb lg doc">${String(m.ext).toUpperCase()}</span>`}</div>
      <label class="field"><span>Fayl adı</span><input class="in" name="name" value="${m.name.replace(/\.[^.]+$/, '')}" maxlength="140" ${can('media.edit') ? '' : raw('disabled')}><small>Uzantı (.${m.ext}) dəyişmir.</small></label>
      <label class="field"><span>Alt mətn (şəkil təsviri)</span><input class="in" name="alt" value="${m.alt || ''}" maxlength="300" ${can('media.edit') ? '' : raw('disabled')}><small>Ekran oxuyucuları və axtarış sistemləri üçün.</small></label>
      <label class="field"><span>Qovluq / kateqoriya</span><input class="in" name="folder" value="${m.folder || ''}" maxlength="60" ${can('media.edit') ? '' : raw('disabled')}></label>
      <div class="field"><span class="flabel">Ünvan (URL)</span><span class="row nowrap"><code class="keybox" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.url}</code><button type="button" class="btn sm" id="cpU">${icon('copy', 'sm')}Kopyala</button></span></div>
      <p class="muted" style="font-size:13px">${fmtSize(m.size)} · ${m.mime} · ${fmtDateTime(m.created_at)}${usage.length ? h`<br><b>İstifadə olunur:</b> ${usage.join('; ')}` : h`<br>Heç yerdə istifadə olunmur.`}</p><p class="ferr" hidden></p></div>
      <div class="modal-f">${can('media.delete') ? h`<button type="button" class="btn ghost danger" id="mDel" style="margin-right:auto">${icon('trash', 'sm')}Sil</button>` : ''}<a class="btn" href="${m.url}" target="_blank" rel="noopener">${icon('eye', 'sm')}Aç</a>${can('media.edit') ? h`<button class="btn pri" type="submit">Yadda saxla</button>` : ''}</div></form>`);
    const f = $('form', dlg);
    $('[data-x]', dlg).addEventListener('click', () => close());
    $('#cpU', dlg).addEventListener('click', () => copyText(abs));
    f.addEventListener('submit', async (e) => { e.preventDefault(); try { await api.put(`/api/media/${m.id}`, { name: f.name.value, alt: f.alt.value, folder: f.folder.value }); toast('Yadda saxlanıldı', 'ok'); close(true); load(); } catch (x) { const er = $('.ferr', dlg); er.textContent = x.message; er.hidden = false; } });
    const del = $('#mDel', dlg);
    if (del) del.addEventListener('click', async () => {
      const text = usage.length ? `Bu fayl istifadə olunur (${usage.slice(0, 3).join('; ')}). Silinsə, həmin yerlərdə şəkil görünməyəcək.` : 'Fayl həmişəlik silinəcək.';
      if (!(await confirmDialog(text, { title: 'Faylı sil', ok: 'Sil', danger: true }))) return;
      try { await api.del(`/api/media/${m.id}?force=1`); toast('Fayl silindi', 'ok'); close(true); load(); } catch (x) { showError(x); }
    });
  }, { label: 'Fayl məlumatı' });
  let timer;
  view.addEventListener('input', (e) => { if (e.target.id === 'mq') { clearTimeout(timer); timer = setTimeout(() => { S.q = e.target.value.trim(); S.page = 1; load(); }, 300); } });
  view.addEventListener('change', async (e) => {
    if (e.target.id === 'mk') { S.kind = e.target.value; S.page = 1; load(); }
    if (e.target.id === 'mfo') { S.folder = e.target.value; S.page = 1; load(); }
    if (e.target.id === 'mup') {
      const folder = S.folder;
      const r = await uploadFiles(e.target.files, { folder, onProgress: (i, n, name) => { $('#minfo').textContent = `Yüklənir ${i}/${n}: ${name}`; } });
      e.target.value = '';
      if (r.failed.length) toast(r.failed.join(' · '), 'error'); else toast(`${r.done.length} fayl yükləndi`, 'ok');
      S.page = 1; load();
    }
  });
  view.addEventListener('click', (e) => {
    const p = e.target.closest('[data-p]'); if (p) { S.page += Number(p.dataset.p); load(); return; }
    const b = e.target.closest('.mi'); if (b) { const m = items.find((x) => String(x.id) === b.dataset.id); if (m) details(m); }
  });
  await load();
}

/* ---------------------------------------------------------- users & roles */
const genPassword = () => { const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', sym = '!@#%&*-_+='; const a = new Uint32Array(18); crypto.getRandomValues(a); let s = ''; for (let i = 0; i < 16; i++) s += set[a[i] % set.length]; return s.slice(0, 5) + sym[a[16] % sym.length] + s.slice(5, 11) + sym[a[17] % sym.length] + s.slice(11) + '7a'; };
async function users(view) {
  const manage = can('users.manage');
  // Roles are loaded first so the «add user» dialog always has its role list.
  let roles = (await api.get('/api/roles')).roles;
  setHTML(view, h`<section class="card" id="uT"></section><section class="card" id="roles"></section>`);
  const userDialog = (u) => {
    const pw = genPassword();
    return promptDialog({ title: u ? 'İstifadəçini redaktə et' : 'Yeni istifadəçi', ok: u ? 'Yadda saxla' : 'Yarat',
      intro: u ? '' : 'İstifadəçi ilk girişdə şifrəni dəyişməlidir. Müvəqqəti şifrəni ona təhlükəsiz yolla (məsələn, şifahi) çatdırın.',
      fields: [{ name: 'name', label: 'Ad, soyad', value: u ? u.name : '', required: true }, { name: 'email', label: 'E-poçt', type: 'email', value: u ? u.email : '', required: true },
        { name: 'role_id', label: 'Rol', type: 'select', options: roles.filter((r) => isSuper() || r.key !== 'super_admin').map((r) => [r.id, r.name]), value: u ? u.role_id : (roles.find((r) => r.key === 'viewer') || {}).id },
        { name: 'is_active', label: 'Vəziyyət', type: 'select', options: [['1', 'Aktiv'], ['0', 'Deaktiv']], value: u ? (u.is_active ? '1' : '0') : '1' },
        ...(u ? [] : [{ name: 'password', label: 'Müvəqqəti şifrə', value: pw, required: true, help: 'Avtomatik yaradılıb; dəyişə bilərsiniz (ən azı 12 simvol).' }])],
      submit: (v) => { const body = { name: v.name, email: v.email, role_id: Number(v.role_id), is_active: v.is_active === '1', ...(u ? {} : { password: v.password }) }; return u ? api.put(`/api/users/${u.id}`, body) : api.post('/api/users', body); } });
  };
  const table = dataTable($('#uT'), { id: 'users', url: '/api/users', searchPlaceholder: 'Ad, e-poçt, rol…',
    filters: [{ key: 'role_id', label: 'Rol', options: (d) => (d.roles || []).map((r) => [r.id, r.name]) }, { key: 'active', label: 'Vəziyyət', options: [['1', 'Aktiv'], ['0', 'Deaktiv']] }],
    onData: (d) => { roles = d.roles || roles; }, extra: manage ? h`<button class="btn sm pri" id="uAdd">${icon('plus', 'sm')}İstifadəçi əlavə et</button>` : '',
    columns: [{ label: 'İstifadəçi', sort: 'name', render: (u) => h`<b class="t">${u.name}</b><br><span class="muted">${u.email}</span>` }, { label: 'Rol', sort: 'role', render: (u) => h`<span class="tag">${u.role}</span>` },
      { label: '2FA', render: (u) => chip(u.totp_enabled ? 'Aktiv' : 'Qoşulmayıb', u.totp_enabled ? 'green' : 'grey') }, { label: 'Son giriş', sort: 'last_login', cls: 'nw', render: (u) => (u.last_login_at ? fmtDateTime(u.last_login_at) : 'Heç vaxt') },
      { label: 'Vəziyyət', render: (u) => h`${chip(u.is_active ? 'Aktiv' : 'Deaktiv', u.is_active ? 'green' : 'red')}${u.locked ? h` ${chip('Bloklanıb', 'amber')}` : ''}${u.must_change_password ? h` <span class="tag">müvəqqəti şifrə</span>` : ''}` }],
    actions: (u) => (manage && (isSuper() || u.role_key !== 'super_admin') ? h`${iconBtn('edit', 'edit', 'Redaktə et')}${iconBtn('pw', 'key', 'Şifrəni sıfırla')}${u.totp_enabled ? iconBtn('tfa', 'shield', '2FA-nı sıfırla') : ''}${u.locked ? iconBtn('unlock', 'lock', 'Bloku götür') : ''}${u.id !== state.user.id ? iconBtn('del', 'trash', 'Sil') : ''}` : ''),
    onAction: async (act, u, t) => {
      try {
        if (act === 'edit') { if (await userDialog(u)) { toast('İstifadəçi yeniləndi', 'ok'); t.reload(); loadRoles(); } }
        else if (act === 'pw') { const pw = genPassword(); const r = await promptDialog({ title: 'Şifrəni sıfırla', ok: 'Sıfırla', intro: `${u.name} üçün yeni müvəqqəti şifrə. İstifadəçi növbəti girişdə onu dəyişməlidir; bütün açıq sessiyaları bağlanacaq.`, fields: [{ name: 'password', label: 'Müvəqqəti şifrə', value: pw, required: true }], submit: (v) => api.post(`/api/users/${u.id}/reset-password`, v) }); if (r) { toast('Şifrə sıfırlandı', 'ok'); t.reload(); } }
        else if (act === 'tfa') { if (await confirmDialog(`${u.name} üçün ikimərhələli təsdiq söndürüləcək.`, { ok: 'Sıfırla' })) { await api.post(`/api/users/${u.id}/reset-2fa`); toast('2FA sıfırlandı', 'ok'); t.reload(); } }
        else if (act === 'unlock') { await api.post(`/api/users/${u.id}/unlock`); toast('Blok götürüldü', 'ok'); t.reload(); }
        else if (act === 'del') delAction(`/api/users/${u.id}`, `«${u.name}» hesabı silinəcək. Audit jurnalındakı qeydləri qalır.`, () => { t.reload(); loadRoles(); });
      } catch (e) { showError(e); }
    } });
  const add = $('#uAdd'); if (add) add.addEventListener('click', async () => { if (await userDialog(null)) { toast('İstifadəçi yaradıldı', 'ok'); table.reload(); loadRoles(); } });
  const loadRoles = async () => {
    const d = await api.get('/api/roles');
    const mods = [...new Set(d.permissions.map((p) => p.module))];
    setHTML($('#roles'), h`<div class="card-h"><div><h2>Rollar və icazələr</h2><p>Hər rol üçün modul əsaslı icazələr${d.can_edit ? ' — qutuları işarələyib «Saxla» basın' : ' (dəyişmək yalnız Super Admin üçündür)'}</p></div></div>
      <div class="card-b" style="display:grid;gap:8px">${d.roles.map((r) => h`<div class="row"><b>${r.name}</b><span class="muted">— ${r.description} (${r.users} istifadəçi)</span></div>`)}</div>
      <div class="tw"><table class="matrix"><thead><tr><th>Modul / icazə</th>${d.roles.map((r) => h`<th>${r.name}</th>`)}</tr></thead><tbody>
      ${mods.map((m) => h`<tr class="grp"><td colspan="${d.roles.length + 1}">${m}</td></tr>${d.permissions.filter((p) => p.module === m).map((p) => h`<tr><td>${p.label}</td>${d.roles.map((r) => h`<td><input type="checkbox" data-role="${r.id}" data-perm="${p.key}" aria-label="${r.name}: ${m} — ${p.label}" ${r.permissions.includes(p.key) ? raw('checked') : ''} ${!d.can_edit || r.key === 'super_admin' || p.super_only ? raw('disabled') : ''}></td>`)}</tr>`)}`)}
      </tbody></table></div>${d.can_edit ? h`<div class="card-b row">${d.roles.filter((r) => r.key !== 'super_admin').map((r) => h`<button class="btn sm" data-saverole="${r.id}">${icon('save', 'sm')}«${r.name}» icazələrini saxla</button>`)}</div>` : ''}`);
  };
  $('#roles').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-saverole]'); if (!b) return;
    const id = b.dataset.saverole;
    const permissions = $$(`input[data-role="${id}"]:checked`, view).map((x) => x.dataset.perm);
    if (!(await confirmDialog('Bu roldakı bütün istifadəçilərin icazələri dərhal dəyişəcək.', { ok: 'Saxla' }))) return;
    try { await api.put(`/api/roles/${id}/permissions`, { permissions }); toast('İcazələr yeniləndi', 'ok'); loadRoles(); } catch (er) { showError(er); }
  });
  await loadRoles();
}

/* --------------------------------------------------------------- settings */
async function settings(view, args) {
  const TABS = [['umumi', 'Ümumi', 'settings.view'], ['elaqe', 'Əlaqə', 'settings.view'], ['sosial', 'Sosial şəbəkələr', 'settings.view'], ['seo', 'SEO', 'seo.manage'], ['footer', 'Footer', 'settings.view'], ['bildiris', 'E-poçt bildirişləri', 'settings.view'],
    ['tehlukesizlik', 'Təhlükəsizlik və analitika', 'settings.view'], ['backup', 'Ehtiyat nüsxə', 'super'], ['inteqrasiya', 'İnteqrasiyalar', 'settings.view']]
    .filter((t) => (t[2] === 'super' ? isSuper() : can(t[2], 'settings.manage')));
  const tab = TABS.some((t) => t[0] === args[0]) ? args[0] : TABS[0][0];
  const edit = can('settings.manage');
  setHTML(view, h`<section class="card"><div class="tabs" role="tablist">${TABS.map((t) => h`<a role="tab" aria-selected="${t[0] === tab}" href="#/tenzimlemeler/${t[0]}">${t[1]}</a>`)}</div></section><div id="sbody" class="grid"></div>`);
  const body = $('#sbody');
  const needs = tab === 'backup' ? null : await api.get('/api/settings');
  const S = needs ? needs.settings : {};
  const mediaObj = async (id) => { if (!id || !can('media.view')) return null; try { return (await api.get(`/api/media/${id}`)).item; } catch { return null; } };
  const simple = (group, sections, opt = {}) => buildForm(body, { values: opt.values || S[group], langs: opt.langs || null, readonly: !(opt.editable ?? edit), sections, submitLabel: 'Yadda saxla',
    onSubmit: async (v) => { const r = await api.put(`/api/settings/${group}`, opt.merge ? opt.merge(v) : v); S[group] = r.value; toast('Tənzimləmələr yadda saxlanıldı', 'ok'); if (opt.after) opt.after(); } });

  if (tab === 'umumi') {
    const g = { ...S.general, logo: await mediaObj(S.general.logo_media_id), favicon: await mediaObj(S.general.favicon_media_id) };
    simple('general', [{ title: 'Ümumi məlumat', fields: [{ name: 'company_name', label: 'Şirkətin adı', required: true, i18n: true, full: true, max: 200 }, { name: 'site_name', label: 'Saytın qısa adı', max: 120 }, { name: 'working_hours', label: 'İş saatları', i18n: true, max: 200, placeholder: 'B.e – Cümə, 09:00–18:00' }] },
      { title: 'Loqo və favicon', col: 'side', fields: [{ name: 'logo_media_id', label: 'Loqo', type: 'media', objKey: 'logo' }, { name: 'favicon_media_id', label: 'Favicon', type: 'media', objKey: 'favicon' }] }], { values: g, langs: LANGS });
  } else if (tab === 'elaqe') {
    simple('contact', [{ title: 'Əlaqə məlumatları', sub: 'Saytın əlaqə bölməsində və footer-də göstərilir', fields: [{ name: 'address', label: 'Ünvan', i18n: true, full: true, max: 300 }, { name: 'phone', label: 'Telefon', type: 'tel', max: 40 }, { name: 'email', label: 'E-poçt', type: 'email', max: 254 },
      { name: 'whatsapp', label: 'WhatsApp nömrəsi', type: 'tel', max: 40 }, { name: 'maps_url', label: 'Google Maps keçidi', type: 'url', full: true }] }], { langs: LANGS });
  } else if (tab === 'sosial') {
    simple('social', [{ title: 'Sosial şəbəkələr', sub: 'Boş qalan şəbəkələr saytda göstərilmir', fields: ['linkedin', 'facebook', 'instagram', 'youtube', 'telegram', 'other'].map((k) => ({ name: k, label: k === 'other' ? 'Digər' : k[0].toUpperCase() + k.slice(1), type: 'url', placeholder: 'https://…' })) }]);
  } else if (tab === 'footer') {
    simple('footer', [{ title: 'Footer', fields: [{ name: 'text', label: 'Footer mətni', i18n: true, full: true, max: 400 }, { name: 'copyright', label: 'Müəllif hüququ sətri', i18n: true, full: true, max: 200 }, { name: 'show_social', label: 'Sosial şəbəkə keçidlərini göstər', type: 'checkbox', full: true }] }], { langs: LANGS });
  } else if (tab === 'bildiris') {
    const sys = await api.get('/api/system');
    const n = { ...S.notifications, emails_text: (S.notifications.emails || []).join(', ') };
    setHTML(body, h`<div id="nform"></div><section class="card"><div class="card-h"><div><h2>E-poçt göndərişinin vəziyyəti</h2><p>SMTP parametrləri serverdəki .env faylında saxlanılır (şifrə paneldə göstərilmir)</p></div><span class="sp"></span>${chip(sys.smtp ? 'Qurulub' : 'Qurulmayıb', sys.smtp ? 'green' : 'amber')}</div>
      <div class="card-b" style="display:grid;gap:10px"><p class="muted">Üsul: <b>${sys.mail_transport === 'smtp' ? 'SMTP server' : sys.mail_transport === 'sendmail' ? 'serverin öz poçt proqramı (sendmail/postfix)' : 'qurulmayıb'}</b> · göndərən ünvan: <b>${sys.smtp_from || '—'}</b> · gözləyən məktub: <b>${sys.mail_pending}</b> · göndərilməyən: <b>${sys.mail_failed}</b></p>
      ${edit ? h`<div><button class="btn wrap" id="testMail" ${sys.smtp ? '' : raw('disabled')}>${icon('send', 'sm')}Sınaq məktubu göndər (${state.user.email})</button></div>` : ''}</div></section>`);
    buildForm($('#nform'), { values: n, readonly: !edit, sections: [{ title: 'Yeni sorğu bildirişləri', sub: 'Saytdan sorğu gələndə bu ünvanlara məktub göndərilir', fields: [
      { name: 'emails_text', label: 'Alıcı e-poçt ünvanları', full: true, max: 600, help: 'Vergüllə ayırın. Boş qalsa, məktub Super Admin istifadəçilərinə gedir.' },
      { name: 'email_on_lead', label: 'Yeni layihə sorğusunda e-poçt göndər', type: 'checkbox', full: true }, { name: 'lead_subject', label: 'Layihə sorğusu məktubunun mövzusu', required: true, full: true, max: 150 },
      { name: 'email_on_contact', label: 'Yeni əlaqə sorğusunda e-poçt göndər', type: 'checkbox', full: true }, { name: 'contact_subject', label: 'Əlaqə sorğusu məktubunun mövzusu', required: true, full: true, max: 150 }] }],
      onSubmit: async (v) => { const emails = v.emails_text.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean); delete v.emails_text; const r = await api.put('/api/settings/notifications', { ...v, emails }); S.notifications = r.value; toast('Bildiriş tənzimləmələri yadda saxlanıldı', 'ok'); } });
    const tm = $('#testMail'); if (tm) tm.addEventListener('click', async () => { tm.disabled = true; try { const r = await api.post('/api/settings/test-email'); toast(`Sınaq məktubu göndərildi: ${r.to}`, 'ok'); } catch (e) { showError(e); } tm.disabled = false; });
  } else if (tab === 'tehlukesizlik') {
    const sys = await api.get('/api/system');
    setHTML(body, h`<div id="aform"></div><section class="card"><div class="card-h"><div><h2>Təhlükəsizlik parametrləri</h2><p>Bu dəyərlər serverdəki .env faylında təyin olunur</p></div></div><div class="card-b">
      <dl class="dl">${[['Uğursuz giriş limiti', `${sys.login_max_fails} cəhd`], ['Bloklama müddəti', `${sys.login_lock_min} dəqiqə`], ['Fəaliyyətsiz sessiya müddəti', `${sys.session_idle_min} dəqiqə`], ['Minimum şifrə uzunluğu', `${sys.password_min} simvol`],
        ['Serverin gördüyü IP ünvanınız', sys.client_ip_problem ? h`${sys.client_ip} ${chip('Problem', 'amber')}<br><small class="muted">${sys.client_ip_problem}. Bu halda giriş limitləri bütün istifadəçilərə birlikdə tətbiq olunur — quraşdırma təlimatının «Apache» bölməsinə baxın.</small>` : h`${sys.client_ip} ${chip('Düzgün', 'green')}`],
        ['Təhlükəsiz kuki (HTTPS)', sys.cookie_secure ? 'Aktiv' : 'Söndürülüb — yalnız lokal sınaq üçün'], ['Fayl ölçüsü limiti', `${sys.max_upload_mb} MB`], ['Verilənlər bazası', fmtSize(sys.db_size)], ['Yüklənmiş fayllar', fmtSize(sys.uploads_size)], ['Versiya', `${sys.version} · Node ${sys.node}`]].map((x) => h`<dt>${x[0]}</dt><dd>${x[1]}</dd>`)}</dl>
      <div class="note" style="margin-top:14px">${icon('shield')}<span>Aktiv qorumalar: şifrələrin scrypt ilə heşlənməsi, HttpOnly + SameSite=Strict kukilər, CSRF nişanı, sorğu limiti, giriş bloklaması, parametrli SQL sorğuları, məzmun təhlükəsizliyi siyasəti (CSP), fayl növü və məzmun yoxlaması, dəyişdirilə bilməyən audit jurnalı.</span></div></div></section>`);
    buildForm($('#aform'), { values: S.analytics, readonly: !edit, sections: [{ title: 'Ziyarətçi analitikası', sub: 'IP ünvanı və kuki saxlanılmır', fields: [{ name: 'enabled', label: 'Ziyarətlərin sayılması aktivdir', type: 'checkbox', full: true },
      { name: 'respect_dnt', label: 'Brauzerində “izləmə” qadağası (Do Not Track / GPC) olan ziyarətçiləri sayma', type: 'checkbox', full: true },
      { name: 'retention_days', label: 'Analitika məlumatının saxlanma müddəti (gün)', type: 'number', help: 'Bu müddətdən köhnə ziyarət qeydləri avtomatik silinir (30–1825 gün).' }] }],
      onSubmit: async (v) => { const r = await api.put('/api/settings/analytics', v); S.analytics = r.value; toast('Yadda saxlanıldı', 'ok'); } });
  } else if (tab === 'inteqrasiya') {
    setHTML(body, h`<div class="note">${icon('info')}<span>Bu inteqrasiyalar hələ aktiv deyil. Sistem onların sonradan qoşula bilməsi üçün hazır qurulub; aşağıdakı dəyərlər indidən saxlanıla bilər.</span></div><div id="iform"></div>
      <section class="card"><div class="card-h"><h2>Gələcək inteqrasiyalar</h2></div><div class="card-b"><div class="intg">${['Google Analytics', 'Google Search Console', 'Google Maps', 'Korporativ e-poçt', 'CRM sistemi', 'WhatsApp', 'Telegram', 'Microsoft 365', 'Google Workspace'].map((n) => h`<div><b>${n}</b>${chip(n === 'Korporativ e-poçt' ? 'SMTP ilə işləyir' : n === 'Google Maps' ? 'Keçid kimi' : 'Hazır quruluş', n === 'Korporativ e-poçt' ? 'green' : 'grey')}</div>`)}</div></div></section>`);
    buildForm($('#iform'), { values: S.integrations, readonly: !edit, sections: [{ title: 'İnteqrasiya parametrləri', fields: [{ name: 'google_analytics_id', label: 'Google Analytics ölçmə ID-si', placeholder: 'G-XXXXXXXXXX', max: 40 }, { name: 'search_console_verification', label: 'Search Console təsdiq kodu', max: 120 },
      { name: 'crm_webhook_url', label: 'CRM webhook ünvanı', type: 'url', full: true }, { name: 'telegram_chat', label: 'Telegram kanalı / çat', max: 80 }, { name: 'whatsapp_number', label: 'WhatsApp nömrəsi', type: 'tel', max: 40 }] }],
      onSubmit: async (v) => { const r = await api.put('/api/settings/integrations', v); S.integrations = r.value; toast('Yadda saxlanıldı', 'ok'); } });
  } else if (tab === 'seo') {
    const canSeo = can('seo.manage');
    const g = { ...S.seo, og_image: await mediaObj(S.seo.og_image_media_id) };
    setHTML(body, h`<div id="seoG"></div><section class="card" id="seoP"></section><div class="note">${icon('info')}<span><b>sitemap.xml</b> avtomatik yaranır (aşağıdakı səhifələr × 3 dil; URL şablonu yazılıbsa, dərc olunmuş xəbərlər və aktiv layihələr də). <b>robots.txt</b> boşdursa, standart mətn istifadə olunur: <span class="mono">/admin</span> və <span class="mono">/api/</span> axtarış sistemlərinə bağlıdır. Canonical ünvan boşdursa, səhifənin öz ünvanı götürülür.</span></div>`);
    buildForm($('#seoG'), { values: g, langs: LANGS, readonly: !canSeo, sections: [{ title: 'Ümumi SEO', fields: [{ name: 'site_title', label: 'Saytın başlığı', i18n: true, full: true, max: 120 }, { name: 'meta_description', label: 'Meta təsvir', type: 'textarea', rows: 2, i18n: true, full: true, max: 300 },
      { name: 'keywords', label: 'Açar sözlər', i18n: true, full: true, max: 300 }, { name: 'google_verification', label: 'Google təsdiq kodu', max: 120 }] },
    { title: 'Open Graph şəkli', col: 'side', fields: [{ name: 'og_image_media_id', label: 'Paylaşım şəkli', type: 'media', objKey: 'og_image' }] }],
      onSubmit: async (v) => { const r = await api.put('/api/settings/seo', v); S.seo = r.value; toast('SEO tənzimləmələri yadda saxlanıldı', 'ok'); } });
    if (canSeo) {
      const seoFields = (p) => [{ name: 'name', label: 'Səhifənin adı', value: p ? p.name : '', required: true }, { name: 'path', label: 'Yol (slug)', value: p ? p.path : '/', required: true, help: 'Məsələn: /haqqimizda/' }, { name: 'seo_title', label: 'SEO başlığı', value: p ? p.seo_title : '' },
        { name: 'meta_description', label: 'Meta təsvir', type: 'textarea', rows: 2, value: p ? p.meta_description : '' }, { name: 'keywords', label: 'Açar sözlər', value: p ? p.keywords : '' }, { name: 'og_title', label: 'OG başlığı', value: p ? p.og_title : '' },
        { name: 'og_description', label: 'OG təsviri', type: 'textarea', rows: 2, value: p ? p.og_description : '' }, { name: 'canonical', label: 'Canonical ünvan', type: 'url', value: p ? p.canonical : '' },
        { name: 'in_sitemap', label: 'Sitemap', type: 'select', options: [['1', 'Daxil et'], ['0', 'Daxil etmə']], value: p ? (p.in_sitemap ? '1' : '0') : '1' }];
      const save = (p) => (v) => { const b = { ...v, in_sitemap: v.in_sitemap === '1', og_image_media_id: p ? p.og_image_media_id : null, sort_order: p ? p.sort_order : 0, i18n: p ? p.i18n : {} }; return p ? api.put(`/api/seo-pages/${p.id}`, b) : api.post('/api/seo-pages', b); };
      const t = dataTable($('#seoP'), { id: 'seo', url: '/api/seo-pages', perPage: 30, searchPlaceholder: 'Səhifə…', extra: h`<button class="btn sm pri" id="seoAdd">${icon('plus', 'sm')}Səhifə əlavə et</button>`,
        columns: [{ label: 'Səhifə', sort: 'name', render: (p) => h`<b class="t">${p.name}</b><br><span class="mono muted">${p.path}</span>` }, { label: 'SEO başlığı', render: (p) => p.seo_title || h`<span class="muted">yazılmayıb</span>` },
          { label: 'Meta təsvir', render: (p) => (p.meta_description ? p.meta_description.slice(0, 80) : h`<span class="muted">yazılmayıb</span>`) }, { label: 'OG şəkli', render: (p) => (p.og_image ? mediaThumb(p.og_image) : h`<span class="muted">—</span>`) },
          { label: 'Sitemap', render: (p) => chip(p.in_sitemap ? 'Daxildir' : 'Yox', p.in_sitemap ? 'green' : 'grey') }],
        actions: () => h`${iconBtn('edit', 'edit', 'Redaktə et')}${iconBtn('og', 'image', 'OG şəklini seç')}${iconBtn('del', 'trash', 'Sil')}`,
        onAction: async (act, p, tt) => {
          if (act === 'edit') { if (await promptDialog({ title: `SEO — ${p.name}`, fields: seoFields(p), submit: save(p) })) { toast('SEO məlumatı yeniləndi', 'ok'); tt.reload(); } }
          else if (act === 'og') { const m = await pickMedia({ kind: 'image' }); if (m) { try { await api.patch(`/api/seo-pages/${p.id}`, { og_image_media_id: m.id }); toast('OG şəkli təyin olundu', 'ok'); tt.reload(); } catch (e) { showError(e); } } }
          else if (act === 'del') delAction(`/api/seo-pages/${p.id}`, `«${p.name}» səhifəsinin SEO qeydi silinəcək (səhifənin özü silinmir).`, tt.reload);
        } });
      $('#seoAdd').addEventListener('click', async () => { if (await promptDialog({ title: 'Yeni səhifə', fields: seoFields(null), submit: save(null) })) { toast('Səhifə əlavə olundu', 'ok'); t.reload(); } });
    }
  } else if (tab === 'backup') {
    const draw = async () => {
      const d = await api.get('/api/backups');
      const last = d.last, any = d.last_any;
      setHTML(body, h`<div class="kpis three"><div class="card kpi"><div class="kl">${icon('save')}<span>Son ehtiyat nüsxə</span></div><div class="kv sm">${last ? fmtDateTime(last.created_at) : 'Hələ yoxdur'}</div><div class="kd">${last ? `${last.kind === 'auto' ? 'avtomatik' : 'əl ilə'} · ${fmtSize(last.size)}` : ''}</div></div>
        <div class="card kpi"><div class="kl">${icon('check')}<span>Vəziyyət</span></div><div class="kv sm">${any ? (any.status === 'ok' ? 'Uğurlu' : 'Uğursuz') : '—'}</div><div class="kd">${any ? any.message : 'nüsxə yaradılmayıb'}</div></div>
        <div class="card kpi"><div class="kl">${icon('history')}<span>Avtomatik rejim</span></div><div class="kv sm">${d.settings.auto ? `Hər gün ${String(d.settings.hour).padStart(2, '0')}:00` : 'Söndürülüb'}</div><div class="kd">son ${d.settings.keep} nüsxə saxlanılır</div></div></div>
        <div class="row"><button class="btn pri" id="bkNow">${icon('save', 'sm')}İndi nüsxə yarat</button><span class="muted" style="font-size:13px">Nüsxə faylları serverdə <span class="mono">data/backups</span> qovluğundadır. Server sıradan çıxarsa itməməsi üçün onları vaxtaşırı başqa yerə də köçürün (təlimatda izah olunub).</span></div>
        <div id="bform"></div><section class="card"><div class="card-h"><h2>Nüsxələr</h2></div><div class="tw" style="margin-top:12px">${d.items.length ? h`<table><thead><tr><th>Tarix</th><th>Növ</th><th>Vəziyyət</th><th>Tərkib</th><th class="num">Ölçü</th><th>Yaradan</th><th></th></tr></thead><tbody>
          ${d.items.map((b) => h`<tr><td class="nw">${fmtDateTime(b.created_at)}</td><td>${b.kind === 'auto' ? 'Avtomatik' : 'Əl ilə'}</td><td>${chip(b.status === 'ok' ? 'Uğurlu' : 'Uğursuz', b.status === 'ok' ? 'green' : 'red')}</td><td>${b.message}</td><td class="num nw">${b.status === 'ok' ? fmtSize(b.size) : '—'}</td><td class="nw">${b.user_name || 'Sistem'}</td>
            <td><div class="acts">${b.status === 'ok' ? h`<a class="btn sm" href="/api/backups/${b.id}/download" download>${icon('down', 'sm')}Baza</a>${b.file.includes(',') ? h`<a class="btn sm" href="/api/backups/${b.id}/download?part=files" download>${icon('down', 'sm')}Fayllar</a>` : ''}` : ''}<button class="iconbtn" data-bdel="${b.id}" aria-label="Sil" title="Sil">${icon('trash')}</button></div></td></tr>`)}</tbody></table>` : h`<div class="empty">Hələ nüsxə yoxdur</div>`}</div></section>
        <div class="note warn">${icon('alert')}<span>Nüsxə faylında bütün məlumatlar (sorğular, istifadəçilər, heşlənmiş şifrələr) var. Yüklədiyiniz faylı təhlükəsiz yerdə saxlayın və heç kimlə paylaşmayın.</span></div>`);
      buildForm($('#bform'), { values: d.settings, sections: [{ title: 'Avtomatik nüsxə', fields: [{ name: 'auto', label: 'Hər gün avtomatik nüsxə yarat', type: 'checkbox', full: true }, { name: 'hour', label: 'Saat (Bakı vaxtı, 0–23)', type: 'number' }, { name: 'keep', label: 'Saxlanılan nüsxə sayı', type: 'number' },
        { name: 'include_files', label: 'Yüklənmiş faylları da arxivlə', type: 'checkbox', full: true }] }], onSubmit: async (v) => { await api.put('/api/settings/backup', v); toast('Yadda saxlanıldı', 'ok'); draw(); } });
      $('#bkNow').addEventListener('click', async (e) => { e.target.disabled = true; toast('Nüsxə hazırlanır…'); try { await api.post('/api/backups'); toast('Ehtiyat nüsxə yaradıldı', 'ok'); } catch (er) { showError(er); } draw(); });
    };
    body.addEventListener('click', (e) => { const b = e.target.closest('[data-bdel]'); if (b) delAction(`/api/backups/${b.dataset.bdel}`, 'Bu nüsxə faylı serverdən silinəcək.', draw); });
    await draw();
  }
}

export const CONTENT_PAGES = { xeberler: news, layiheler: projects, xidmetler: services, sirket: company, komanda: team, senedler: documents, media, istifadeciler: users, tenzimlemeler: settings };
