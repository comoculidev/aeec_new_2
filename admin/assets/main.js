// Application shell: login, navigation, routing.
import { h, raw, setHTML, $, $$, icon, api, state, can, isSuper, toast, showError, initials, hideTip, ADMIN_URL, LOGIN_URL, safeNext } from './core.js';
import { resetCharts } from './charts.js';
import { PAGES } from './pages.js';

const root = document.getElementById('root');
const logo = (cls = '') => h`<svg class="${cls}" viewBox="0 0 389.1 88" role="img" aria-label="AEEC"><use href="#aeec-logo"/></svg>`;

const NAV = [
  ['ÜMUMİ', [['dashboard', 'İdarə paneli', 'grid', ['dashboard.view']], ['analitika', 'Analitika', 'chart', ['analytics.view']]]],
  ['SORĞULAR', [['layihe-sorgulari', 'Layihə sorğuları', 'inbox', ['leads.view']], ['elaqe-sorgulari', 'Əlaqə sorğuları', 'mail', ['contacts.view']]]],
  ['MƏZMUN', [['xeberler', 'Xəbərlər', 'news', ['news.view']], ['layiheler', 'Layihələr', 'brief', ['projects.view']], ['xidmetler', 'Xidmətlər', 'layers', ['services.view']],
    ['sirket', 'Şirkət məlumatları', 'building', ['company.view', 'company.edit']], ['komanda', 'Komanda', 'users', ['team.view']], ['senedler', 'Sənədlər', 'file', ['documents.view']], ['media', 'Media kitabxanası', 'image', ['media.view']]]],
  ['SİSTEM', [['istifadeciler', 'İstifadəçilər və rollar', 'shield', ['users.view', 'users.manage']], ['bildirisler', 'Bildirişlər', 'bell', null], ['audit', 'Audit jurnalı', 'history', 'super'],
    ['tenzimlemeler', 'Tənzimləmələr', 'cog', ['settings.view', 'settings.manage', 'seo.manage']]]],
];
const allowed = (need) => need === null || (need === 'super' ? isSuper() : can(...need));
const TITLES = { profil: 'Profil və təhlükəsizlik' };
NAV.forEach((g) => g[1].forEach((i) => { TITLES[i[0]] = i[1]; }));
const firstRoute = () => { for (const g of NAV) for (const i of g[1]) if (allowed(i[3])) return i[0]; return 'profil'; };

/* ------------------------------------------------------------------ login */
function loginPage() {
  const m = /^#\/reset\/([\w-]{20,100})$/.exec(location.hash);
  let msg = '';
  try { msg = sessionStorage.getItem('aeec_msg') || ''; sessionStorage.removeItem('aeec_msg'); } catch { msg = ''; }
  const brand = h`<div class="login-brand">${logo('lg')}<div><h1>Saytın idarəetmə paneli</h1><p>Sorğular, ziyarətçi statistikası, xəbərlər və saytın bütün məzmunu bir yerdən idarə olunur.</p></div>
    <ul><li>${icon('check')}Şifrələr yalnız heş formasında saxlanılır</li><li>${icon('check')}Çoxsaylı uğursuz cəhddən sonra müvəqqəti bloklama</li><li>${icon('check')}İkimərhələli təsdiq (2FA)</li><li>${icon('check')}Bütün əməliyyatlar audit jurnalına yazılır</li></ul>
    <svg class="xbg" viewBox="8 0 250 161" aria-hidden="true"><use href="#aeec-mark"/></svg></div>`;
  const view = (inner) => setHTML(root, h`<div class="login">${brand}<div class="login-form"><div class="login-card">${inner}</div></div></div>`);
  const err = (text) => { const e = $('.lerr', root); e.textContent = text; e.hidden = !text; };
  const busy = (on) => { const b = $('button[type=submit]', root); if (b) b.disabled = on; };

  const showLogin = () => {
    view(h`<div><h2>Daxil olun</h2><p class="muted">AEEC idarəetmə paneli</p></div>${msg ? h`<div class="login-note">${icon('info')}<span>${msg}</span></div>` : ''}
      <form id="lf" novalidate style="display:grid;gap:16px">
      <label class="field"><span>E-poçt</span><input class="in" name="email" type="email" autocomplete="username" required autofocus></label>
      <label class="field"><span>Şifrə</span><input class="in" name="password" type="password" autocomplete="current-password" required></label>
      <div class="row" style="justify-content:space-between"><label class="check"><input type="checkbox" name="remember"> Məni xatırla</label><a href="#/forgot" id="fg">Şifrəni unutmusunuz?</a></div>
      <p class="ferr lerr" role="alert" hidden></p>
      <button class="btn pri" type="submit" style="justify-content:center">${icon('lock')}Daxil ol</button></form>
      <p class="muted" style="font-size:12.5px">Yalnız səlahiyyətli əməkdaşlar üçün. Giriş cəhdləri qeydə alınır.</p>`);
    $('#fg').addEventListener('click', (e) => { e.preventDefault(); showForgot(); });
    $('#lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (!f.email.value.trim() || !f.password.value) return err('E-poçt və şifrəni daxil edin');
      busy(true); err('');
      try {
        const r = await api.post('/api/auth/login', { email: f.email.value.trim(), password: f.password.value, remember: f.remember.checked });
        if (r.mfa_required) return showMfa();
        location.replace(ADMIN_URL + safeNext(location.hash));
      } catch (er) { err(er.message); busy(false); f.password.value = ''; f.password.focus(); }
    });
  };
  const showMfa = () => {
    view(h`<div><h2>İkimərhələli təsdiq</h2><p class="muted">Telefonunuzdakı təsdiqləmə tətbiqində göstərilən 6 rəqəmli kodu daxil edin.</p></div>
      <form id="mf" novalidate style="display:grid;gap:16px"><label class="field"><span>Təsdiq kodu</span><input class="in mono" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" autofocus style="font-size:20px;letter-spacing:.2em"></label>
      <p class="ferr lerr" role="alert" hidden></p><button class="btn pri" type="submit" style="justify-content:center">Təsdiqlə</button><a href="/admin/login" class="back">${icon('left', 'sm')}Girişə qayıt</a></form>`);
    $('#mf').addEventListener('submit', async (e) => {
      e.preventDefault(); busy(true); err('');
      try { await api.post('/api/auth/mfa', { code: e.target.code.value }); location.replace(ADMIN_URL + safeNext(location.hash)); }
      catch (er) { err(er.message); busy(false); e.target.code.select(); if (er.status === 429) setTimeout(() => location.replace(LOGIN_URL), 1800); }
    });
  };
  const showForgot = () => {
    view(h`<div><h2>Şifrənin bərpası</h2><p class="muted">E-poçt ünvanınızı yazın — bərpa keçidi göndəriləcək (30 dəqiqə etibarlıdır).</p></div>
      <form id="ff" novalidate style="display:grid;gap:16px"><label class="field"><span>E-poçt</span><input class="in" name="email" type="email" autocomplete="username" autofocus></label>
      <p class="ferr lerr" role="alert" hidden></p><button class="btn pri" type="submit" style="justify-content:center">Keçid göndər</button><a href="/admin/login" class="back" id="bk">${icon('left', 'sm')}Girişə qayıt</a></form>`);
    $('#bk').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    $('#ff').addEventListener('submit', async (e) => {
      e.preventDefault(); busy(true); err('');
      try { const r = await api.post('/api/auth/forgot', { email: e.target.email.value.trim() }); view(h`<div><h2>E-poçtunuzu yoxlayın</h2><p class="muted" style="margin-top:8px">${r.message}</p></div><a href="/admin/login" class="btn" style="justify-content:center">Girişə qayıt</a>`); }
      catch (er) { err(er.fields && er.fields.email ? er.fields.email : er.message); busy(false); }
    });
  };
  const showReset = (token) => {
    view(h`<div><h2>Yeni şifrə</h2><p class="muted">Ən azı 12 simvol; böyük və kiçik hərf, rəqəm və simvoldan ən azı üçü.</p></div>
      <form id="rf" novalidate style="display:grid;gap:16px"><label class="field"><span>Yeni şifrə</span><input class="in" name="p1" type="password" autocomplete="new-password" autofocus></label>
      <label class="field"><span>Yeni şifrə (təkrar)</span><input class="in" name="p2" type="password" autocomplete="new-password"></label>
      <p class="ferr lerr" role="alert" hidden></p><button class="btn pri" type="submit" style="justify-content:center">Şifrəni yenilə</button></form>`);
    $('#rf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.p1.value !== f.p2.value) return err('Şifrələr eyni deyil');
      busy(true); err('');
      try { await api.post('/api/auth/reset', { token, password: f.p1.value }); try { sessionStorage.setItem('aeec_msg', 'Şifrə yeniləndi. İndi daxil ola bilərsiniz.'); } catch { /* ignore */ } location.replace(LOGIN_URL); }
      catch (er) { err(er.message); busy(false); }
    });
  };
  if (m) showReset(m[1]); else showLogin();
}

/* ------------------------------------------------------------------ shell */
function shell() {
  setHTML(root, h`<a class="skip" href="#view">Məzmuna keç</a><div class="app"><aside class="side" id="side"><a class="side-logo" href="#/${firstRoute()}" aria-label="AEEC — İdarə paneli">${logo()}</a>
    ${NAV.map((g) => { const items = g[1].filter((i) => allowed(i[3])); return items.length ? h`<h4>${g[0]}</h4><nav>${items.map((i) => h`<a href="#/${i[0]}" data-nav="${i[0]}">${icon(i[2])}<span>${i[1]}</span>${i[0] === 'layihe-sorgulari' ? raw('<span class="badge" id="b-pr" hidden></span>') : i[0] === 'elaqe-sorgulari' ? raw('<span class="badge" id="b-cr" hidden></span>') : ''}</a>`)}</nav>` : ''; })}
    <div class="side-foot">AEEC Admin<br><a href="/" target="_blank" rel="noopener">Sayta bax</a></div></aside><div class="scrim" id="scrim"></div>
    <div class="main"><header class="top"><button class="iconbtn" id="menuBtn" aria-label="Menyu">${icon('menu')}</button><h1 id="ttl"></h1>
      <a class="iconbtn" href="#/bildirisler" aria-label="Bildirişlər" title="Bildirişlər">${icon('bell')}<span class="dot" id="b-nt" hidden></span></a>
      <div class="user"><a class="avatar" href="#/profil" title="Profil">${initials(state.user.name)}</a><div><b>${state.user.name}</b><span>${state.user.role}</span></div>
      <button class="iconbtn" id="logoutBtn" aria-label="Çıxış" title="Çıxış">${icon('out')}</button></div></header>
      <main class="content" id="view" tabindex="-1"></main></div></div>`);
  $('#menuBtn').addEventListener('click', toggleSide);
  $('#scrim').addEventListener('click', toggleSide);
  $('#logoutBtn').addEventListener('click', async () => { try { await api.post('/api/auth/logout'); } catch { /* ignore */ } location.replace(LOGIN_URL); });
}
function toggleSide() { $('#side').classList.toggle('open'); $('#scrim').classList.toggle('open'); }

let lastUnread = null;
async function refreshBadges() {
  try {
    const s = await api.get('/api/notifications/summary');
    for (const [id, n] of [['b-pr', s.new_leads], ['b-cr', s.new_contacts], ['b-nt', s.unread]]) { const e = document.getElementById(id); if (e) { e.textContent = n > 99 ? '99+' : n; e.hidden = !n; } }
    if (lastUnread !== null && s.unread > lastUnread) toast('Yeni bildiriş var');
    lastUnread = s.unread;
  } catch { /* handled globally */ }
}
document.addEventListener('aeec:badges', refreshBadges);

let cleanup = [];
const NOT_ON_SITE = ['layiheler', 'xidmetler', 'sirket', 'komanda', 'senedler'];
function route() {
  const parts = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/').map((p) => p.slice(0, 120));
  let name = parts[0] || firstRoute();
  if (state.user.must_change_password) name = 'profil';
  const navItem = NAV.flatMap((g) => g[1]).find((i) => i[0] === name);
  if (!PAGES[name] || (navItem && !allowed(navItem[3]))) { location.replace('#/' + firstRoute()); return; }
  cleanup.forEach((f) => { try { f(); } catch { /* ignore */ } }); cleanup = [];
  resetCharts(); hideTip();
  $$('[data-nav]').forEach((a) => { if (a.dataset.nav === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#ttl').textContent = TITLES[name] || '';
  document.title = `${TITLES[name] || 'Panel'} — AEEC Admin`;
  const view = document.createElement('main');
  view.id = 'view'; view.className = 'content'; view.tabIndex = -1;
  $('#view').replaceWith(view);
  $('#side').classList.remove('open'); $('#scrim').classList.remove('open');
  window.scrollTo(0, 0);
  if (!state.user.must_change_password) refreshBadges();
  Promise.resolve(PAGES[name](view, parts.slice(1), { onCleanup: (f) => cleanup.push(f), reload: route })).then(() => {
    // Honest notice: these sections store data (and serve it through /api/public/*), but the
    // pages of the current website are still hand-written HTML and do not read it yet.
    const settingsTab = name === 'tenzimlemeler' && ['', 'umumi', 'elaqe', 'sosial', 'seo', 'footer'].includes(parts[1] || '');
    if (view.isConnected && (NOT_ON_SITE.includes(name) || settingsTab)) {
      const n = document.createElement('div');
      n.className = 'note warn'; n.style.marginBottom = '16px';
      setHTML(n, h`${icon('info')}<span>Bu bölmənin məlumatları hələ saytın səhifələrində avtomatik göstərilmir — sayt səhifələri (Haqqımızda, Həllər, Layihələr, Əlaqə) hazırda ayrıca HTML fayllarıdır. Saytla avtomatik əlaqəli olanlar: <b>Xəbərlər</b>, <b>sorğu formaları</b> və <b>ziyarət statistikası</b>.</span>`);
      view.prepend(n);
    }
  }, (e) => {
    if (!view.isConnected) return; // the user already moved to another screen
    setHTML(view, h`<div class="card"><div class="empty">${e && e.message ? e.message : 'Səhifə yüklənmədi'}</div></div>`);
    if (!e || !e.status) console.error(e);
  });
}

async function boot() {
  const onLogin = location.pathname === LOGIN_URL;
  let me = null;
  try { me = await api.get('/api/auth/me'); } catch (e) { if (e.status && e.status !== 401) { setHTML(root, h`<p class="boot">${e.message}</p>`); return; } }
  if (!me) { if (!onLogin) { location.replace(LOGIN_URL + safeNext(location.hash)); return; } loginPage(); return; }
  if (onLogin) { location.replace(ADMIN_URL + safeNext(location.hash)); return; }
  state.user = me.user; state.perms = new Set(me.permissions); state.csrf = me.csrf; state.config = me.config || {};
  shell();
  window.addEventListener('hashchange', route);
  route();
  if (state.user.must_change_password) { toast('Davam etmək üçün əvvəlcə şifrənizi dəyişin'); return; }
  setInterval(refreshBadges, 60000);
}
boot().catch((e) => { showError(e); });
