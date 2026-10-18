// Pages: dashboard, analytics, requests, notifications, audit log, profile.
import { h, raw, setHTML, $, $$, icon, api, qs, state, can, isSuper, toast, showError, nf, fmtDate, fmtDateTime, relDay, fmtSize, fmtDuration, todayBaku, addDays, chip, confirmDialog, promptDialog, modal, download, copyText } from './core.js';
import { lineChart, groupBars, hbars, donut, funnel, tableView, chartCard } from './charts.js';
import { dataTable } from './ui.js';
import { CONTENT_PAGES } from './pages-content.js';

export const LEAD_COLORS = { new: 'blue', contacted: 'cyan', discussion: 'amber', proposal: 'violet', won: 'green', lost: 'red', archived: 'grey' };
export const CONTACT_COLORS = { new: 'blue', read: 'cyan', replied: 'green', closed: 'grey' };
const badges = () => document.dispatchEvent(new Event('aeec:badges'));
const go = (hash) => { location.hash = '#/' + hash; };
const mailto = (email) => 'mailto:' + encodeURIComponent(String(email || '')).replace('%40', '@');
const leadNo = (id) => 'LS-' + String(id).padStart(4, '0');
const contactNo = (id) => 'ES-' + String(id).padStart(4, '0');

/* ------------------------------------------------------------ date range */
const R = { preset: 'd30', from: '', to: '' };
const PRESETS = [['today', 'Bu gün'], ['yest', 'Dünən'], ['d7', 'Son 7 gün'], ['d30', 'Son 30 gün'], ['m3', 'Son 3 ay'], ['m12', 'Son 12 ay'], ['custom', 'Xüsusi aralıq']];
function rangeDates() {
  const t = todayBaku();
  const m = { today: [t, t], yest: [addDays(t, -1), addDays(t, -1)], d7: [addDays(t, -6), t], d30: [addDays(t, -29), t], m3: [addDays(t, -89), t], m12: [addDays(t, -364), t] };
  if (m[R.preset]) return { from: m[R.preset][0], to: m[R.preset][1] };
  let from = R.from || addDays(t, -13), to = R.to || t;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
const rangeLabel = () => { const r = rangeDates(); return R.preset === 'custom' ? `${fmtDate(r.from)} – ${fmtDate(r.to)}` : PRESETS.find((p) => p[0] === R.preset)[1]; };
const rangeBar = (extra) => { const r = rangeDates(), t = todayBaku(); return h`<div class="filters"><div class="seg" role="group" aria-label="Tarix filtri">${PRESETS.map((p) => h`<button type="button" data-range="${p[0]}" aria-pressed="${R.preset === p[0]}">${p[1]}</button>`)}</div>
  ${R.preset === 'custom' ? h`<label class="sr" for="cf">Başlanğıc</label><input class="in" style="width:auto" type="date" id="cf" value="${r.from}" max="${t}"><span class="muted">–</span><label class="sr" for="ct">Son</label><input class="in" style="width:auto" type="date" id="ct" value="${r.to}" max="${t}"><button class="btn sm pri" id="capply">Tətbiq et</button>` : ''}
  <span class="sp"></span>${extra || ''}</div>`; };
function bindRange(view, rerender) {
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) { R.preset = b.dataset.range; if (R.preset === 'custom' && !R.from) { const t = todayBaku(); R.from = addDays(t, -13); R.to = t; } rerender(); return; }
    if (e.target.closest('#capply')) { R.from = $('#cf', view).value || R.from; R.to = $('#ct', view).value || R.to; rerender(); }
  });
}

const kpi = (ic, label, value, sub) => h`<div class="card kpi"><div class="kl">${icon(ic)}<span>${label}</span></div><div class="kv">${value}</div><div class="kd">${sub || ''}</div></div>`;
const delta = (v, text = 'əvvəlki dövrə görə') => (v === null || v === undefined ? h`<span>müqayisə üçün əvvəlki dövrdə məlumat yoxdur</span>`
  : h`<span class="${v >= 0 ? 'up' : 'down'}">${icon(v >= 0 ? 'up' : 'dn', 'sm')}</span><b>${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%</b> ${text}`);
const METRICS = [['visitors', 'Ziyarətçi'], ['pageviews', 'Səhifə baxışı'], ['sessions', 'Sessiya'], ['returning', 'Təkrar ziyarət']];
let metric = 'visitors';
const metricSeg = () => h`<div class="seg sm" role="group" aria-label="Göstərici">${METRICS.map((m) => h`<button type="button" data-metric="${m[0]}" aria-pressed="${metric === m[0]}">${m[1]}</button>`)}</div>`;
const BUCKET = { hour: 'saatlar üzrə', day: 'günlər üzrə', week: 'həftələr üzrə', month: 'aylar üzrə' };
function drawSeries(id, series) {
  const name = METRICS.find((m) => m[0] === metric)[1];
  const pts = series.points.map((p) => ({ label: p.label, full: p.full, value: p[metric] }));
  const el = document.getElementById(id);
  el.hidden = false; document.getElementById(id + '-t').hidden = true;
  lineChart(el, pts, name);
  setHTML(document.getElementById(id + '-t'), tableView(['Dövr', ...METRICS.map((m) => m[1])], series.points.map((p) => [p.full, ...METRICS.map((m) => nf(p[m[0]]))])));
}
const notifItem = (n) => h`<a class="ntf ${n.is_read ? '' : 'unread'}" href="${n.link || '#/bildirisler'}" data-nid="${n.id}"><span class="ni">${icon({ new_lead: 'inbox', new_contact: 'mail', new_user: 'user', assigned: 'user', system: 'shield' }[n.type] || 'bell')}</span>
  <span><b>${n.title}</b><small>${n.body}</small><small>${relDay(n.created_at)} · ${fmtDateTime(n.created_at).slice(11)}</small></span></a>`;

/* ------------------------------------------------------------ dashboard */
async function dashboard(view) {
  const draw = async () => {
    const r = rangeDates(), lab = rangeLabel();
    const [d, nt] = await Promise.all([api.get('/api/dashboard' + qs(r)), api.get('/api/notifications')]);
    const k = d.kpis;
    setHTML(view, h`${rangeBar()}<div class="kpis">
      ${kpi('users', 'Ümumi ziyarətçilər', nf(k.total_visitors), 'sayğac qoşulandan bəri')}
      ${kpi('eye', 'Bu gün ziyarətçilər', nf(k.visitors_today), h`dünən: <b>${nf(k.visitors_yesterday)}</b>`)}
      ${kpi('chart', 'Bu ay ziyarətçilər', nf(k.visitors_month), 'cari təqvim ayı')}
      ${kpi('file', 'Səhifə baxışları', nf(k.pageviews), h`${delta(k.pageviews_change)} · ${lab}`)}
      ${kpi('mail', 'Yeni əlaqə sorğuları', nf(k.new_contacts), h`${lab} · <b>${nf(k.contacts_open)}</b> oxunmayıb`)}
      ${kpi('inbox', 'Yeni layihə sorğuları', nf(k.new_leads), h`${lab} · <b>${nf(k.leads_open)}</b> baxılmayıb`)}
      ${kpi('news', 'Dərc olunmuş xəbərlər', nf(k.published_news), h`<b>${nf(k.draft_news)}</b> qaralama`)}
      ${kpi('brief', 'Aktiv layihələr', nf(k.active_projects), h`<b>${nf(k.planned_projects)}</b> planlaşdırılır`)}</div>
      <div class="grid g21">${chartCard('c-vis', 'Sayt analitikası', `${lab} · ${BUCKET[d.series.bucket]}`, { controls: metricSeg() })}${chartCard('c-dev', 'Cihazlar', `${lab} · sessiyalar`)}</div>
      <div class="grid g2">${chartCard('c-req', 'Sorğular aylar üzrə', 'Son 6 ay', { legend: [['Layihə sorğuları', 'var(--c1)'], ['Əlaqə sorğuları', 'var(--c2)']] })}${chartCard('c-pages', 'Ən çox baxılan səhifələr', `${lab} · səhifə baxışları`)}</div>
      <div class="grid g2">${chartCard('c-src', 'Trafik mənbələri', `${lab} · sessiyalar`)}
        ${d.lead_stats ? h`<section class="card"><div class="card-h"><div><h2>Sorğudan layihəyə</h2><p>${lab} · çevrilmə mərhələləri</p></div></div><div class="card-b"><div id="c-fun"></div>
          <p class="muted" style="font-size:13px;margin-top:12px">Ziyarətçi → sorğu çevrilməsi: <b>${d.lead_stats.funnel[1].rate}%</b> (${nf(d.lead_stats.funnel[0].value)} ziyarətçi, ${nf(d.lead_stats.funnel[1].value)} sorğu)</p></div></section>` : ''}</div>
      <div class="grid g21">${d.recent_leads ? h`<section class="card"><div class="card-h"><div><h2>Son layihə sorğuları</h2><p>“Layihənizi müzakirə edək” formasından</p></div><span class="sp"></span><a class="btn sm" href="#/layihe-sorgulari">Hamısına bax</a></div>
        <div class="tw" style="margin-top:12px">${d.recent_leads.length ? h`<table><thead><tr><th>ID</th><th>Ad</th><th>Layihə</th><th>Tarix</th><th>Status</th></tr></thead><tbody>${d.recent_leads.map((p) => h`<tr class="click" data-go="layihe-sorgulari/${p.id}"><td class="mono nw">${leadNo(p.id)}</td><td class="nw">${p.first_name} ${p.last_name}</td><td>${p.project_name || p.company || '—'}</td><td class="nw">${fmtDate(p.created_at)}</td><td>${chip(LEAD_LABELS[p.status] || p.status, LEAD_COLORS[p.status])}</td></tr>`)}</tbody></table>` : h`<div class="empty">Hələ sorğu yoxdur</div>`}</div></section>` : h`<span></span>`}
        <section class="card"><div class="card-h"><div><h2>Bildirişlər</h2><p>${nf(nt.unread)} oxunmamış</p></div><span class="sp"></span><a class="btn sm" href="#/bildirisler">Hamısı</a></div><div style="margin-top:12px">${nt.items.length ? nt.items.slice(0, 4).map(notifItem) : h`<div class="empty">Bildiriş yoxdur</div>`}</div></section></div>`);
    drawSeries('c-vis', d.series);
    donut($('#c-dev'), d.devices.map((x) => ({ label: x.label, value: x.value })), 'sessiya');
    setHTML($('#c-dev-t'), tableView(['Cihaz', 'Sessiya'], d.devices.map((x) => [x.label, nf(x.value)])));
    const cats = d.requests_by_month.map((m) => m.label);
    groupBars($('#c-req'), cats, [{ name: 'Layihə sorğuları', color: 'var(--c1)', values: d.requests_by_month.map((m) => m.leads) }, { name: 'Əlaqə sorğuları', color: 'var(--c2)', values: d.requests_by_month.map((m) => m.contacts) }]);
    setHTML($('#c-req-t'), tableView(['Ay', 'Layihə sorğuları', 'Əlaqə sorğuları'], d.requests_by_month.map((m) => [m.label, m.leads, m.contacts])));
    hbars($('#c-pages'), d.pages.map((p) => ({ label: p.title || p.label, title: p.label, value: p.value })));
    setHTML($('#c-pages-t'), tableView(['Səhifə', 'Baxış'], d.pages.map((p) => [p.label, nf(p.value)])));
    hbars($('#c-src'), d.sources);
    setHTML($('#c-src-t'), tableView(['Mənbə', 'Sessiya'], d.sources.map((p) => [p.label, nf(p.value)])));
    if (d.lead_stats) funnel($('#c-fun'), d.lead_stats.funnel.slice(1));
    view._series = d.series;
  };
  bindRange(view, () => draw().catch(showError));
  view.addEventListener('click', (e) => {
    const m = e.target.closest('[data-metric]');
    if (m) { metric = m.dataset.metric; $$('[data-metric]', view).forEach((b) => b.setAttribute('aria-pressed', String(b === m))); drawSeries('c-vis', view._series); return; }
    const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go);
  });
  await draw();
}
let LEAD_LABELS = { new: 'Yeni', contacted: 'Əlaqə saxlanılıb', discussion: 'Müzakirədə', proposal: 'Təklif göndərilib', won: 'Qazanılıb', lost: 'İtirilib', archived: 'Arxiv' };
let CONTACT_LABELS = { new: 'Yeni', read: 'Oxunub', replied: 'Cavablandırılıb', closed: 'Bağlı' };

/* ------------------------------------------------------------ analytics */
async function analytics(view) {
  let table = null;
  const draw = async () => {
    const r = rangeDates(), lab = rangeLabel();
    const a = await api.get('/api/analytics' + qs(r));
    const t = a.totals, ls = a.lead_stats;
    const exportBtns = can('analytics.export') ? h`<div class="row"><span class="muted" style="font-size:13px">Eksport:</span>${[['daily', 'Günlük'], ['pages', 'Səhifələr'], ['sessions', 'Sessiyalar']].map((x) => h`<button class="btn sm" data-aexp="${x[0]},xlsx">${icon('down', 'sm')}${x[1]} (Excel)</button><button class="btn sm ghost" data-aexp="${x[0]},csv">CSV</button>`)}</div>` : '';
    setHTML(view, h`${rangeBar()}<div class="kpis">
      ${kpi('users', 'Unikal ziyarətçilər', nf(t.visitors), delta(a.change.visitors))}${kpi('file', 'Səhifə baxışları', nf(t.pageviews), delta(a.change.pageviews))}
      ${kpi('chart', 'Sessiyalar', nf(t.sessions), h`<b>${nf(t.new_visitors)}</b> yeni · <b>${nf(t.returning)}</b> təkrar ziyarət`)}${kpi('history', 'Orta sessiya müddəti', fmtDuration(t.avg_duration), h`bir səhifəlik ziyarət: <b>${t.bounce_rate}%</b>`)}</div>
      ${chartCard('a-main', 'Sayt analitikası', `${lab} · ${BUCKET[a.series.bucket]}`, { controls: metricSeg() })}
      <div class="grid g3">${chartCard('a-src', 'Trafik mənbələri', `${lab} · sessiyalar`)}${chartCard('a-dev', 'Cihazlar', `${lab} · sessiyalar`)}${chartCard('a-br', 'Brauzerlər', `${lab} · sessiyalar`)}</div>
      <div class="grid g3">${chartCard('a-pages', 'Ən çox baxılan səhifələr', `${lab} · baxışlar`)}${chartCard('a-land', 'Giriş səhifələri', `${lab} · sessiyalar`)}${chartCard('a-exit', 'Çıxış səhifələri', `${lab} · sessiyalar`)}</div>
      <div class="grid g2"><section class="card"><div class="card-h"><div><h2>Ölkə və şəhərlər</h2><p>${lab} · sessiyalar</p></div></div><div class="tw" style="margin-top:12px">${a.countries.length ? h`<table><thead><tr><th>Ölkə</th><th>Şəhər</th><th class="num">Sessiya</th><th class="num">Pay</th></tr></thead><tbody>
        ${a.countries.map((c) => h`<tr><td>${c.country}</td><td>${c.city}</td><td class="num">${nf(c.value)}</td><td class="num">${t.sessions ? Math.round((c.value / t.sessions) * 100) : 0}%</td></tr>`)}</tbody></table>` : h`<div class="empty">Bu dövr üçün məlumat yoxdur</div>`}</div>
        <div class="card-b"><p class="muted" style="font-size:13px">Ölkə ziyarətçinin brauzerindəki saat qurşağına görə təxmini müəyyən olunur; IP ünvanı saxlanılmır.</p></div></section>
        ${ls ? h`<section class="card"><div class="card-h"><div><h2>Sorğu statistikası</h2><p>${lab} · “Layihənizi müzakirə edək”</p></div></div><div class="card-b">
          <div class="mini">${[['Cəmi', ls.total], ['Yeni', ls.by_status.new], ['Müzakirədə', ls.by_status.discussion], ['Təklif göndərilib', ls.by_status.proposal], ['Qazanılıb', ls.by_status.won], ['İtirilib', ls.by_status.lost]].map((x) => h`<div><b>${nf(x[1])}</b><span>${x[0]}</span></div>`)}</div>
          <div id="a-fun" style="margin-top:16px"></div><p class="muted" style="font-size:13px;margin-top:12px">Ziyarətçi → Sorğu → Müzakirə → Təklif → Layihə. Ziyarətçidən sorğuya çevrilmə: <b>${ls.funnel[1].rate}%</b> (${nf(ls.funnel[0].value)} ziyarətçi).</p></div></section>` : h`<span></span>`}</div>
      <section class="card"><div class="card-h"><div><h2>Sessiyalar</h2><p>${lab} · hər ziyarət üzrə toplanan məlumat</p></div><span class="sp"></span>${exportBtns}</div>
        <div class="card-b" style="padding-bottom:0"><div class="note">${icon('shield')}<span><b>IP ünvanı saxlanılmır.</b> Ziyarətçi yalnız hər gün dəyişən təsadüfi açarla hesablanmış anonim kodla sayılır; bu kod şəxsi müəyyən etməyə və günlər arasında əlaqələndirməyə imkan vermir.</span></div></div><div id="sessT"></div></section>`);
    drawSeries('a-main', a.series);
    const bars = (id, items, head) => { hbars($('#' + id), items); setHTML($('#' + id + '-t'), tableView(head, items.map((p) => [p.label, nf(p.value)]))); };
    bars('a-src', a.sources, ['Mənbə', 'Sessiya']); bars('a-br', a.browsers, ['Brauzer', 'Sessiya']);
    // Show page titles instead of bare paths where the title is known.
    const titleOf = Object.fromEntries(a.pages.filter((x) => x.title).map((x) => [x.key, x.title]));
    const named = (list) => list.map((x) => ({ label: titleOf[x.key] || x.label, title: x.label, value: x.value }));
    bars('a-pages', named(a.pages), ['Səhifə', 'Baxış']); bars('a-land', named(a.landing), ['Səhifə', 'Sessiya']); bars('a-exit', named(a.exits), ['Səhifə', 'Sessiya']);
    donut($('#a-dev'), a.devices, 'sessiya'); setHTML($('#a-dev-t'), tableView(['Cihaz', 'Sessiya'], a.devices.map((x) => [x.label, nf(x.value)])));
    if (ls) funnel($('#a-fun'), ls.funnel.slice(1));
    view._series = a.series;
    table = dataTable($('#sessT'), { id: 'sessions', url: '/api/analytics/sessions', params: () => rangeDates(), sort: '-date', perPage: 10, searchPlaceholder: 'Səhifə, ölkə, brauzer…',
      filters: [{ key: 'device', label: 'Cihaz', options: (d) => Object.entries(d.devices || {}) }, { key: 'source', label: 'Mənbə', options: (d) => Object.entries(d.sources || {}) }],
      emptyText: 'Bu dövrdə ziyarət qeydə alınmayıb',
      columns: [{ label: 'Tarix və saat', sort: 'date', cls: 'nw', render: (s) => fmtDateTime(s.started_at) }, { label: 'Giriş səhifəsi', cls: 'nw', key: 'landing_page' }, { label: 'Çıxış səhifəsi', cls: 'nw', key: 'exit_page' },
        { label: 'Baxış', sort: 'pageviews', cls: 'num', key: 'pageviews' }, { label: 'Müddət', sort: 'duration', cls: 'num nw', render: (s) => `${Math.floor(s.duration_sec / 60)}:${String(s.duration_sec % 60).padStart(2, '0')}` },
        { label: 'Mənbə', cls: 'nw', key: 'source_label' }, { label: 'Referrer', cls: 'nw', render: (s) => s.referrer || '—' }, { label: 'Brauzer', key: 'browser' }, { label: 'ƏS', key: 'os' }, { label: 'Cihaz', key: 'device_label' },
        { label: 'Ekran', cls: 'nw mono', render: (s) => s.screen || '—' }, { label: 'Ölkə', sort: 'country', cls: 'nw', render: (s) => s.country || '—' }, { label: 'Şəhər', render: (s) => s.city || '—' },
        { label: 'Ziyarət', cls: 'nw', render: (s) => (s.is_returning ? 'Təkrar' : 'İlk') }, { label: 'Sessiya ID', cls: 'mono', key: 'id' }] });
  };
  bindRange(view, () => draw().catch(showError));
  view.addEventListener('click', (e) => {
    const m = e.target.closest('[data-metric]');
    if (m) { metric = m.dataset.metric; $$('[data-metric]', view).forEach((b) => b.setAttribute('aria-pressed', String(b === m))); drawSeries('a-main', view._series); return; }
    const x = e.target.closest('[data-aexp]');
    if (x) { const [type, format] = x.dataset.aexp.split(','); download('/api/analytics/export' + qs({ ...rangeDates(), type, format })); }
  });
  await draw();
}

/* ------------------------------------------------------------ timeline shared by both request types */
const KIND = { note: ['edit', 'Qeyd'], status: ['refresh', 'Status'], assign: ['user', 'Təyinat'], email: ['send', 'E-poçt'], followup: ['calendar', 'Növbəti əlaqə'] };
const timeline = (notes) => (notes.length ? h`<div class="notes">${notes.map((n) => h`<div class="nitem k-${n.kind}"><span class="nk">${icon((KIND[n.kind] || KIND.note)[0], 'sm')}${(KIND[n.kind] || KIND.note)[1]}</span><div class="nb">${n.body}</div><small>${n.user_name || 'Sistem'} · ${fmtDateTime(n.created_at)}</small></div>`)}</div>` : h`<p class="muted">Hələ qeyd yoxdur.</p>`);
const dl = (pairs) => h`<dl class="dl">${pairs.map((p) => h`<dt>${p[0]}</dt><dd>${p[1] === '' || p[1] === null || p[1] === undefined ? '—' : p[1]}</dd>`)}</dl>`;
const replyDialog = (url, to, subject) => promptDialog({ title: 'E-poçtla cavab', ok: 'Göndər', intro: `Alıcı: ${to}. Məktub şirkətin korporativ ünvanından göndəriləcək və sorğunun tarixçəsinə yazılacaq.`,
  fields: [{ name: 'subject', label: 'Mövzu', value: subject, required: true }, { name: 'body', label: 'Mətn', type: 'textarea', rows: 9, required: true }], submit: (v) => api.post(url, v) });

/* ------------------------------------------------------------ project requests */
async function leads(view, args) {
  if (args[0]) return leadDetail(view, args[0]);
  let assignees = [];
  try { assignees = (await api.get('/api/leads/assignees')).items; } catch { assignees = []; }
  setHTML(view, h`<section class="card" id="prT"></section>`);
  dataTable($('#prT'), { id: 'leads', url: '/api/leads', sort: '-date', dateRange: true, exportUrl: can('leads.export') ? '/api/leads/export' : null, searchPlaceholder: 'Ad, şirkət, layihə, e-poçt…',
    filters: [{ key: 'status', label: 'Status', options: (d) => Object.entries(d.statuses || LEAD_LABELS) }, { key: 'direction', label: 'İstiqamət', options: (d) => (d.directions || []).map((x) => [x, x]) }, { key: 'assigned_to', label: 'Məsul şəxs', options: assignees.map((u) => [u.id, u.name]) }],
    onData: (d) => { if (d.statuses) LEAD_LABELS = d.statuses; },
    onRow: (p) => go('layihe-sorgulari/' + p.id), rowClass: (p) => (p.status === 'new' ? 'unread' : ''), emptyText: 'Hələ layihə sorğusu daxil olmayıb',
    columns: [{ label: 'ID', sort: 'id', cls: 'mono nw', render: (p) => leadNo(p.id) }, { label: 'Ad', sort: 'name', cls: 'nw', render: (p) => `${p.first_name} ${p.last_name}` }, { label: 'Şirkət', sort: 'company', key: 'company' },
      { label: 'Layihə', sort: 'project', render: (p) => p.project_name || '—' }, { label: 'Tarix', sort: 'date', cls: 'nw', render: (p) => fmtDateTime(p.created_at) },
      { label: 'Məsul şəxs', cls: 'nw', render: (p) => p.assigned_name || '—' }, { label: 'Status', sort: 'status', render: (p) => chip(LEAD_LABELS[p.status] || p.status, LEAD_COLORS[p.status]) }],
    actions: (p) => h`<a class="btn sm" href="#/layihe-sorgulari/${p.id}">${icon('eye', 'sm')}Bax</a>` });
}
async function leadDetail(view, id) {
  const editable = can('leads.edit');
  let assignees = [];
  try { assignees = (await api.get('/api/leads/assignees')).items; } catch { assignees = []; }
  const draw = (d) => {
    const p = d.item; LEAD_LABELS = d.statuses || LEAD_LABELS;
    const draft = $('#noteI', view) ? $('#noteI', view).value : ''; // keep a note that is being typed
    setHTML(view, h`<a class="back" href="#/layihe-sorgulari">${icon('left', 'sm')}Bütün sorğular</a>
      <div class="row"><h2 class="ptitle">${p.project_name || `${p.first_name} ${p.last_name}`}</h2>${chip(LEAD_LABELS[p.status], LEAD_COLORS[p.status])}<span class="mono muted">${leadNo(p.id)}</span></div>
      <div class="grid g21"><div class="grid"><section class="card"><div class="card-h"><h2>Sorğu məlumatları</h2></div><div class="card-b">${dl([['Ad, soyad', `${p.first_name} ${p.last_name}`], ['Şirkət', p.company], ['Vəzifə', p.position],
        ['E-poçt', h`<a href="${mailto(p.email)}">${p.email}</a>`], ['Telefon', p.phone ? h`<a href="tel:${p.phone.replace(/[^+\d]/g, '')}">${p.phone}</a>` : ''], ['Layihənin adı', p.project_name], ['İstiqamət', p.direction], ['Büdcə diapazonu', p.budget],
        ['Layihənin təsviri', h`<span class="pre">${p.description || '—'}</span>`], ['Əlavə qeyd', h`<span class="pre">${p.note || '—'}</span>`], ['Göndərilmə tarixi', fmtDateTime(p.created_at)], ['Sayt dili / səhifə', `${(p.lang || '').toUpperCase()} · ${p.source_page || '—'}`],
        ['Razılıq', p.consent ? `Fərdi məlumatların emalına razılıq verilib · ${fmtDateTime(p.consent_at)}` : 'Verilməyib']])}</div></section>
        <section class="card"><div class="card-h"><div><h2>Tarixçə və daxili qeydlər</h2><p>Yalnız panel istifadəçiləri görür</p></div></div><div class="card-b">${timeline(d.notes)}
          ${editable ? h`<form id="noteF" class="row" style="margin-top:14px;align-items:flex-end"><label class="field" style="flex:1;min-width:200px"><span>Yeni qeyd</span><textarea class="in" id="noteI" rows="2" maxlength="4000" placeholder="Məsələn: müştəri ilə görüş təyin olundu"></textarea></label><button class="btn pri" type="submit">${icon('plus', 'sm')}Əlavə et</button></form>` : ''}</div></section></div>
      <div class="grid" style="align-content:start"><section class="card"><div class="card-h"><h2>İdarəetmə</h2></div><div class="card-b" style="display:grid;gap:12px">
        <label class="field"><span>Status</span><select class="in" id="stS" ${editable ? '' : raw('disabled')}>${Object.entries(LEAD_LABELS).map(([k, v]) => h`<option value="${k}" ${p.status === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
        <label class="field"><span>Məsul şəxs</span><select class="in" id="asS" ${editable ? '' : raw('disabled')}><option value="0">Təyin olunmayıb</option>${assignees.map((u) => h`<option value="${u.id}" ${p.assigned_to === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select></label>
        <label class="field"><span>Növbəti əlaqə tarixi</span><input class="in" type="date" id="fuS" value="${p.follow_up_date || ''}" ${editable ? '' : raw('disabled')}></label>
        ${editable ? h`<button class="btn pri" id="mailB" style="justify-content:center" ${d.smtp ? '' : raw('disabled')}>${icon('mail', 'sm')}E-poçtla cavab ver</button>${d.smtp ? '' : h`<small class="muted">E-poçt göndərişi (SMTP) hələ qurulmayıb.</small>`}` : ''}
        ${can('leads.delete') ? h`<button class="btn ghost danger" id="delB" style="justify-content:center">${icon('trash', 'sm')}Sorğunu sil</button>` : ''}</div></section>
        <section class="card"><div class="card-h"><h2>Əlavə fayllar</h2></div><div class="card-b">${d.files.length ? d.files.map((f) => h`<div class="filei"><span class="ft">${String(f.ext).toUpperCase()}</span><span style="flex:1;min-width:0;overflow-wrap:anywhere">${f.name}<br><small class="muted">${fmtSize(f.size)}</small></span>
          ${['pdf', 'jpg', 'png'].includes(f.ext) ? h`<a class="iconbtn" href="/api/leads/${p.id}/files/${f.id}?inline=1" target="_blank" rel="noopener" aria-label="Aç" title="Aç">${icon('eye')}</a>` : ''}<a class="iconbtn" href="/api/leads/${p.id}/files/${f.id}" download aria-label="Yüklə" title="Yüklə">${icon('down')}</a></div>`) : h`<p class="muted">Fayl əlavə olunmayıb.</p>`}</div></section></div></div>`);
    if (!editable) return;
    $('#noteI').value = draft;
    const patch = async (body, msg) => { try { const r = await api.patch(`/api/leads/${id}`, body); toast(msg, 'ok'); draw({ ...d, item: r.item, notes: r.notes }); badges(); } catch (e) { showError(e); draw(d); } };
    $('#stS').addEventListener('change', (e) => patch({ status: e.target.value }, 'Status dəyişdirildi'));
    $('#asS').addEventListener('change', (e) => patch({ assigned_to: Number(e.target.value) }, 'Məsul şəxs yeniləndi'));
    $('#fuS').addEventListener('change', (e) => patch({ follow_up_date: e.target.value || null }, 'Növbəti əlaqə tarixi saxlanıldı'));
    $('#noteF').addEventListener('submit', async (e) => {
      e.preventDefault(); const t = $('#noteI').value.trim(); if (!t) { $('#noteI').focus(); return; }
      try { const r = await api.post(`/api/leads/${id}/notes`, { body: t }); $('#noteI').value = ''; draw({ ...d, notes: r.notes }); } catch (er) { showError(er); }
    });
    $('#mailB').addEventListener('click', async () => { const r = await replyDialog(`/api/leads/${id}/email`, p.email, `Re: ${p.project_name || 'Sorğunuz'}`); if (r && r.item) { toast('Məktub göndərilmə növbəsinə əlavə olundu', 'ok'); draw({ ...d, item: r.item, notes: r.notes }); badges(); } });
    const del = $('#delB');
    if (del) del.addEventListener('click', async () => {
      if (!(await confirmDialog('Bu sorğu, onun qeydləri və faylları həmişəlik silinəcək.', { title: 'Sorğunu sil', ok: 'Sil', danger: true }))) return;
      try { await api.del(`/api/leads/${id}`); toast('Sorğu silindi', 'ok'); badges(); go('layihe-sorgulari'); } catch (e) { showError(e); }
    });
  };
  draw(await api.get(`/api/leads/${encodeURIComponent(id)}`));
}

/* ------------------------------------------------------------ contact requests */
async function contacts(view, args) {
  if (args[0]) return contactDetail(view, args[0]);
  setHTML(view, h`<section class="card" id="crT"></section>`);
  dataTable($('#crT'), { id: 'contacts', url: '/api/contacts', sort: '-date', dateRange: true, exportUrl: can('contacts.export') ? '/api/contacts/export' : null, searchPlaceholder: 'Ad, e-poçt, mövzu, mesaj…',
    filters: [{ key: 'status', label: 'Status', options: (d) => Object.entries(d.statuses || CONTACT_LABELS) }], onData: (d) => { if (d.statuses) CONTACT_LABELS = d.statuses; },
    onRow: (c) => go('elaqe-sorgulari/' + c.id), rowClass: (c) => (c.status === 'new' ? 'unread' : ''), emptyText: 'Hələ əlaqə sorğusu daxil olmayıb',
    columns: [{ label: 'ID', sort: 'id', cls: 'mono nw', render: (c) => contactNo(c.id) }, { label: 'Ad', sort: 'name', cls: 'nw', key: 'name' }, { label: 'Şirkət', render: (c) => c.company || '—' }, { label: 'Mövzu', sort: 'subject', render: (c) => c.subject || '—' },
      { label: 'E-poçt', key: 'email' }, { label: 'Telefon', cls: 'nw', render: (c) => c.phone || '—' }, { label: 'Tarix', sort: 'date', cls: 'nw', render: (c) => fmtDateTime(c.created_at) },
      { label: 'Status', sort: 'status', render: (c) => chip(CONTACT_LABELS[c.status] || c.status, CONTACT_COLORS[c.status]) }],
    actions: (c) => h`<a class="btn sm" href="#/elaqe-sorgulari/${c.id}">${icon('eye', 'sm')}Bax</a>` });
}
async function contactDetail(view, id) {
  const editable = can('contacts.edit');
  let d = await api.get(`/api/contacts/${encodeURIComponent(id)}`);
  if (editable && d.item.status === 'new') { try { const r = await api.patch(`/api/contacts/${id}`, { status: 'read' }); d = { ...d, item: r.item, notes: r.notes }; badges(); } catch { /* ignore */ } }
  const draw = () => {
    const c = d.item; CONTACT_LABELS = d.statuses || CONTACT_LABELS;
    const draft = $('#noteI', view) ? $('#noteI', view).value : '';
    setHTML(view, h`<a class="back" href="#/elaqe-sorgulari">${icon('left', 'sm')}Bütün əlaqə sorğuları</a>
      <div class="row"><h2 class="ptitle">${c.subject || c.name}</h2>${chip(CONTACT_LABELS[c.status], CONTACT_COLORS[c.status])}<span class="mono muted">${contactNo(c.id)}</span></div>
      <div class="grid g21"><div class="grid"><section class="card"><div class="card-h"><h2>Mesaj</h2></div><div class="card-b"><p class="pre" style="font-size:15.5px;max-width:70ch">${c.message}</p>
        <div style="margin-top:16px">${dl([['Ad', c.name], ['Şirkət', c.company], ['E-poçt', h`<a href="${mailto(c.email)}">${c.email}</a>`], ['Telefon', c.phone ? h`<a href="tel:${c.phone.replace(/[^+\d]/g, '')}">${c.phone}</a>` : ''], ['Mövzu', c.subject], ['Tarix', fmtDateTime(c.created_at)],
          ['Razılıq', c.consent ? `Verilib · ${fmtDateTime(c.consent_at)}` : 'Verilməyib']])}</div></div></section>
        <section class="card"><div class="card-h"><h2>Tarixçə və qeydlər</h2></div><div class="card-b">${timeline(d.notes)}${editable ? h`<form id="noteF" class="row" style="margin-top:14px;align-items:flex-end"><label class="field" style="flex:1;min-width:200px"><span>Yeni qeyd</span><textarea class="in" id="noteI" rows="2" maxlength="4000"></textarea></label><button class="btn pri" type="submit">${icon('plus', 'sm')}Əlavə et</button></form>` : ''}</div></section></div>
      <section class="card" style="align-self:start"><div class="card-h"><h2>İdarəetmə</h2></div><div class="card-b" style="display:grid;gap:12px">
        <label class="field"><span>Status</span><select class="in" id="cS" ${editable ? '' : raw('disabled')}>${Object.entries(CONTACT_LABELS).map(([k, v]) => h`<option value="${k}" ${c.status === k ? raw('selected') : ''}>${v}</option>`)}</select></label>
        ${editable ? h`<button class="btn pri" id="mailB" style="justify-content:center" ${d.smtp ? '' : raw('disabled')}>${icon('mail', 'sm')}E-poçtla cavab ver</button>${d.smtp ? '' : h`<small class="muted">E-poçt göndərişi (SMTP) hələ qurulmayıb.</small>`}` : ''}
        ${can('contacts.delete') ? h`<button class="btn ghost danger" id="delB" style="justify-content:center">${icon('trash', 'sm')}Müraciəti sil</button>` : ''}</div></section></div>`);
    if (editable) {
      $('#noteI').value = draft;
      $('#cS').addEventListener('change', async (e) => { try { const r = await api.patch(`/api/contacts/${id}`, { status: e.target.value }); d = { ...d, item: r.item, notes: r.notes }; toast('Status dəyişdirildi', 'ok'); badges(); } catch (er) { showError(er); } draw(); });
      $('#noteF').addEventListener('submit', async (e) => { e.preventDefault(); const t = $('#noteI').value.trim(); if (!t) return; try { const r = await api.post(`/api/contacts/${id}/notes`, { body: t }); d = { ...d, notes: r.notes }; $('#noteI').value = ''; draw(); } catch (er) { showError(er); } });
      $('#mailB').addEventListener('click', async () => { const r = await replyDialog(`/api/contacts/${id}/email`, c.email, `Re: ${c.subject || 'Müraciətiniz'}`); if (r && r.item) { d = { ...d, item: r.item, notes: r.notes }; toast('Məktub göndərilmə növbəsinə əlavə olundu', 'ok'); draw(); } });
    }
    const del = $('#delB');
    if (del) del.addEventListener('click', async () => { if (!(await confirmDialog('Bu müraciət və qeydləri həmişəlik silinəcək.', { title: 'Müraciəti sil', ok: 'Sil', danger: true }))) return; try { await api.del(`/api/contacts/${id}`); toast('Müraciət silindi', 'ok'); badges(); go('elaqe-sorgulari'); } catch (e) { showError(e); } });
  };
  draw();
}

/* ------------------------------------------------------------ notifications */
async function notifications(view) {
  let page = 1;
  const draw = async () => {
    const d = await api.get('/api/notifications' + qs({ page }));
    const pages = Math.max(1, Math.ceil(d.total / d.per_page));
    setHTML(view, h`<section class="card"><div class="card-h"><div><h2>Bildirişlər</h2><p>${nf(d.unread)} oxunmamış</p></div><span class="sp"></span><button class="btn sm" id="readAll" ${d.unread ? '' : raw('disabled')}>${icon('check', 'sm')}Hamısını oxunmuş et</button></div>
      <div style="margin-top:12px">${d.items.length ? d.items.map(notifItem) : h`<div class="empty">Bildiriş yoxdur</div>`}</div>
      <div class="pager"><span>${d.total} bildiriş · səhifə ${page} / ${pages}</span><span class="row"><button class="btn sm" data-p="-1" ${page <= 1 ? raw('disabled') : ''}>Əvvəlki</button><button class="btn sm" data-p="1" ${page >= pages ? raw('disabled') : ''}>Növbəti</button></span></div></section>
      <div class="note">${icon('bell')}<span>Bildiriş növləri: yeni layihə sorğusu, yeni əlaqə sorğusu, sizə təyin olunan sorğu, yeni istifadəçi, sistem xəbərdarlıqları. Yeni sorğular həm burada, həm də e-poçtla bildirilir.</span></div>`);
  };
  view.addEventListener('click', async (e) => {
    if (e.target.closest('#readAll')) { await api.post('/api/notifications/read-all'); badges(); draw(); return; }
    const p = e.target.closest('[data-p]'); if (p) { page += Number(p.dataset.p); draw(); return; }
    const n = e.target.closest('[data-nid]'); if (n) { api.post(`/api/notifications/${n.dataset.nid}/read`).then(badges).catch(() => {}); }
  });
  await draw();
}
document.addEventListener('click', (e) => { const n = e.target.closest('a.ntf.unread[data-nid]'); if (n && !n.closest('#view section .pager')) api.post(`/api/notifications/${n.dataset.nid}/read`).then(badges).catch(() => {}); });

/* ------------------------------------------------------------ audit log */
const pretty = (v) => { if (v === null || v === undefined || v === '') return '—'; try { const o = JSON.parse(v); return typeof o === 'object' ? JSON.stringify(o, null, 2) : String(o); } catch { return String(v); } };
const short = (v) => { const s = pretty(v).replace(/\s+/g, ' '); return s.length > 60 ? s.slice(0, 60) + '…' : s; };
async function audit(view) {
  setHTML(view, h`<div class="note warn">${icon('lock')}<span><b>Audit jurnalı silinə və dəyişdirilə bilməz.</b> Yalnız Super Admin görür. Sətirə klikləyərək əvvəlki və yeni dəyəri tam görə bilərsiniz.</span></div><section class="card" id="aT"></section>`);
  dataTable($('#aT'), { id: 'audit', url: '/api/audit', dateRange: true, exportUrl: '/api/audit/export', perPage: 20, searchPlaceholder: 'İstifadəçi, əməliyyat, qeyd…',
    filters: [{ key: 'module', label: 'Modul', options: (d) => (d.modules || []).map((m) => [m, m]) }, { key: 'user_id', label: 'İstifadəçi', options: (d) => (d.users || []).map((u) => [u.id, u.name]) }],
    onRow: (a) => modal((d, close) => {
      setHTML(d, h`<div class="modal-h"><h2>${a.action}</h2><span class="sp"></span><button class="iconbtn" data-x aria-label="Bağla">${icon('x')}</button></div><div class="modal-b">${dl([['Tarix və saat', fmtDateTime(a.created_at)], ['İstifadəçi', a.user_name], ['Modul', a.module], ['Qeyd ID', a.record_id], ['IP', a.ip], ['Təsvir', a.summary]])}
        <h3 class="sub">Əvvəlki dəyər</h3><pre class="code">${pretty(a.previous_value)}</pre><h3 class="sub">Yeni dəyər</h3><pre class="code">${pretty(a.new_value)}</pre></div>`);
      $('[data-x]', d).addEventListener('click', () => close());
    }, { wide: true, label: 'Audit qeydi' }),
    columns: [{ label: 'Tarix və saat', cls: 'nw', render: (a) => fmtDateTime(a.created_at) }, { label: 'İstifadəçi', cls: 'nw', key: 'user_name' }, { label: 'Əməliyyat', key: 'action' }, { label: 'Modul', cls: 'nw', key: 'module' },
      { label: 'Qeyd ID', cls: 'mono nw', render: (a) => a.record_id || '—' }, { label: 'Təsvir', key: 'summary' }, { label: 'IP', cls: 'mono nw', render: (a) => a.ip || '—' }, { label: 'Əvvəlki dəyər', cls: 'mono', render: (a) => short(a.previous_value) }, { label: 'Yeni dəyər', cls: 'mono', render: (a) => short(a.new_value) }] });
}

/* ------------------------------------------------------------ profile */
async function profile(view) {
  const draw = async () => {
    const [me, sess] = await Promise.all([api.get('/api/auth/me'), api.get('/api/auth/sessions')]);
    const u = me.user; state.user = u; state.csrf = me.csrf;
    setHTML(view, h`${u.must_change_password ? h`<div class="note warn">${icon('alert')}<span><b>Şifrənizi dəyişin.</b> Hesab müvəqqəti şifrə ilə yaradılıb; panelin digər bölmələri yeni şifrə təyin edildikdən sonra açılacaq.</span></div>` : ''}
      <div class="grid g2"><section class="card"><div class="card-h"><div><h2>Şifrəni dəyiş</h2><p>${u.name} · ${u.email} · ${u.role}</p></div></div><form class="card-b" id="pwF" novalidate style="display:grid;gap:12px">
        <label class="field"><span>Cari şifrə</span><input class="in" type="password" name="current" autocomplete="current-password"><small class="ferr" data-err="current" hidden></small></label>
        <label class="field"><span>Yeni şifrə</span><input class="in" type="password" name="p1" autocomplete="new-password"><small>Ən azı ${state.config.password_min || 12} simvol; böyük hərf, kiçik hərf, rəqəm və simvoldan ən azı üçü.</small><small class="ferr" data-err="password" hidden></small></label>
        <label class="field"><span>Yeni şifrə (təkrar)</span><input class="in" type="password" name="p2" autocomplete="new-password"></label>
        <div><button class="btn pri" type="submit">${icon('key', 'sm')}Şifrəni dəyiş</button></div></form></section>
      <section class="card"><div class="card-h"><div><h2>İkimərhələli təsdiq (2FA)</h2><p>Şifrədən əlavə telefon tətbiqindəki kod tələb olunur</p></div><span class="sp"></span>${chip(u.totp_enabled ? 'Aktiv' : 'Qoşulmayıb', u.totp_enabled ? 'green' : 'grey')}</div>
        <div class="card-b" id="tfa" style="display:grid;gap:12px">${u.totp_enabled ? h`<p class="muted">Girişdə Google Authenticator, Microsoft Authenticator və ya oxşar tətbiqdəki 6 rəqəmli kod soruşulur.</p><div><button class="btn danger" id="tfaOff">2FA-nı söndür</button></div>`
          : h`<p class="muted">Tövsiyə olunur — xüsusilə Super Admin və Administrator hesabları üçün. Telefonunuza Google Authenticator və ya Microsoft Authenticator tətbiqi lazımdır.</p><div><button class="btn pri" id="tfaOn" ${u.must_change_password ? raw('disabled') : ''}>${icon('shield', 'sm')}2FA-nı qoş</button></div>`}</div></section></div>
      <section class="card"><div class="card-h"><div><h2>Aktiv sessiyalar</h2><p>Hesabınıza hazırda daxil olan cihazlar</p></div><span class="sp"></span><button class="btn sm" id="outOthers" ${sess.items.length > 1 ? '' : raw('disabled')}>Digər cihazlardan çıx</button></div>
        <div class="tw" style="margin-top:12px"><table><thead><tr><th>Cihaz / brauzer</th><th>IP</th><th>Giriş</th><th>Son fəaliyyət</th><th></th></tr></thead><tbody>${sess.items.map((s) => h`<tr><td>${(s.user_agent || '—').slice(0, 90)}</td><td class="mono nw">${s.ip || '—'}</td><td class="nw">${fmtDateTime(s.created_at)}</td><td class="nw">${fmtDateTime(s.last_seen_at)}</td><td>${s.current ? chip('Bu cihaz', 'green') : ''}</td></tr>`)}</tbody></table></div></section>`);
    $('#pwF').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      $$('.ferr', f).forEach((x) => { x.hidden = true; });
      const fail = (k, m) => { const x = $(`[data-err="${k}"]`, f); x.textContent = m; x.hidden = false; };
      if (f.p1.value !== f.p2.value) return fail('password', 'Şifrələr eyni deyil');
      try { await api.post('/api/auth/password', { current: f.current.value, password: f.p1.value }); toast('Şifrə dəyişdirildi', 'ok'); if (u.must_change_password) { location.replace('/admin/'); return; } draw(); }
      catch (er) { let any = false; for (const [k, m] of Object.entries(er.fields || {})) { fail(k, m); any = true; } if (!any) showError(er); }
    });
    $('#outOthers').addEventListener('click', async () => { try { const r = await api.post('/api/auth/logout-others'); toast(`${r.closed} sessiya bağlandı`, 'ok'); draw(); } catch (e) { showError(e); } });
    const on = $('#tfaOn'), off = $('#tfaOff');
    if (on) on.addEventListener('click', async () => {
      const r = await promptDialog({ title: 'Şifrənizi təsdiqləyin', ok: 'Davam et', fields: [{ name: 'password', label: 'Cari şifrə', type: 'password', required: true, autocomplete: 'current-password' }], submit: (v) => api.post('/api/auth/2fa/setup', v) });
      if (!r || !r.secret) return;
      const box = $('#tfa');
      setHTML(box, h`<ol class="steps"><li>Telefonda təsdiqləmə tətbiqini açın və <b>“Quraşdırma açarını daxil et”</b> (Enter a setup key) seçin.</li><li>Hesab adı: <b>AEEC Admin</b>. Açar: <span class="row" style="margin-top:6px"><code class="keybox">${r.secret.replace(/(.{4})/g, '$1 ').trim()}</code><button type="button" class="btn sm" id="cpK">${icon('copy', 'sm')}Kopyala</button></span></li><li>Tətbiqdə görünən 6 rəqəmli kodu yazın:</li></ol>
        <form id="tfaF" class="row" novalidate><input class="in mono" name="code" inputmode="numeric" maxlength="7" autocomplete="one-time-code" style="max-width:160px;font-size:18px;letter-spacing:.15em" aria-label="Təsdiq kodu"><button class="btn pri" type="submit">Təsdiqlə və aktiv et</button></form><small class="ferr" id="tfaE" hidden></small>`);
      $('#cpK').addEventListener('click', () => copyText(r.secret));
      $('#tfaF').addEventListener('submit', async (e) => { e.preventDefault(); try { await api.post('/api/auth/2fa/enable', { code: e.target.code.value }); toast('İkimərhələli təsdiq aktiv edildi', 'ok'); draw(); } catch (er) { const x = $('#tfaE'); x.textContent = er.message; x.hidden = false; } });
    });
    if (off) off.addEventListener('click', async () => {
      const r = await promptDialog({ title: '2FA-nı söndür', ok: 'Söndür', intro: 'Təsdiq üçün cari şifrənizi yazın.', fields: [{ name: 'password', label: 'Cari şifrə', type: 'password', required: true, autocomplete: 'current-password' }], submit: (v) => api.post('/api/auth/2fa/disable', v) });
      if (r) { toast('2FA söndürüldü'); draw(); }
    });
  };
  await draw();
}

export const PAGES = { dashboard, analitika: analytics, 'layihe-sorgulari': leads, 'elaqe-sorgulari': contacts, bildirisler: notifications, audit, profil: profile, ...CONTENT_PAGES };
export { isSuper };
