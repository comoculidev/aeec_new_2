// Core helpers of the admin panel: safe HTML templating, API client, formatting, dialogs.

/* ---------- safe HTML ----------
   h`<p>${value}</p>` escapes every interpolated value. Only values that were themselves produced
   by h`…` (or explicitly wrapped with raw()) are inserted as markup. Data coming from the server
   or from visitors therefore can never become HTML. */
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
export const raw = (s) => new Safe(String(s));
function renderValue(v) {
  if (v === null || v === undefined) return '';
  if (v === true || v === false) return String(v); // booleans are used for aria-* attribute values
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(v);
}
export function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += renderValue(vals[i]); });
  return new Safe(out);
}
export const setHTML = (el, safe) => { el.innerHTML = safe instanceof Safe ? safe.s : esc(safe); return el; };
export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
export const icon = (name, cls = '') => raw(`<svg class="ic ${esc(cls)}" aria-hidden="true"><use href="#i-${esc(name)}"/></svg>`);

/* ---------- state ---------- */
export const state = { user: null, perms: new Set(), csrf: '', config: {} };
export const can = (...p) => p.some((x) => state.perms.has(x));
export const isSuper = () => state.user && state.user.role_key === 'super_admin';

/* ---------- API ---------- */
export class ApiError extends Error {
  constructor(status, body) {
    const e = (body && body.error) || {};
    super(e.message || `Xəta (${status})`);
    this.status = status; this.code = e.code; this.fields = e.fields || null;
  }
}
async function request(method, url, body, isForm) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let payload;
  if (isForm) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' }); }
  catch { throw new ApiError(0, { error: { message: 'Serverlə əlaqə yoxdur. İnternet bağlantısını yoxlayın.' } }); }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) { try { data = await res.json(); } catch { data = null; } }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !url.startsWith('/api/auth/')) { sessionExpired(); }
    if (err.code === 'password_change_required') location.hash = '#/profil';
    throw err;
  }
  return data;
}
export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b === undefined ? {} : b),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, formData) => request('POST', u, formData, true),
};
let expiredOnce = false;
function sessionExpired() {
  if (expiredOnce) return;
  expiredOnce = true;
  try { sessionStorage.setItem('aeec_msg', 'Sessiyanın vaxtı bitdi. Yenidən daxil olun.'); } catch { /* ignore */ }
  location.replace(LOGIN_URL + safeNext(location.hash));
}
// Canonical panel addresses. After login the user returns to the page they asked for, but only to
// an in-panel hash route (never to another path or host), so there is no open redirect.
export const ADMIN_URL = '/admin/';
export const LOGIN_URL = '/admin/login';
export const safeNext = (hash) => (/^#\/(?!reset\/)[a-z0-9-]{1,40}(?:\/[A-Za-z0-9-]{1,60}){0,3}$/.test(String(hash || '')) ? hash : '');
export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

/* ---------- formatting ---------- */
const BAKU = 'Asia/Baku';
export const nf = (n) => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
const pad = (n) => String(n).padStart(2, '0');
const parts = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const o = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: BAKU, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
  return o;
};
export const fmtDate = (iso) => { if (!iso) return '—'; if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`; const p = parts(iso); return p ? `${p.day}.${p.month}.${p.year}` : '—'; };
export const fmtDateTime = (iso) => { if (!iso) return '—'; const p = parts(iso); return p ? `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}` : '—'; };
export const todayBaku = () => new Intl.DateTimeFormat('en-CA', { timeZone: BAKU }).format(new Date());
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const relDay = (iso) => { const d = fmtDate(iso), t = todayBaku(); const ds = `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`; return ds === t ? 'Bu gün' : ds === addDays(t, -1) ? 'Dünən' : d; };
export const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : (b || 0) + ' B');
export const fmtDuration = (s) => { s = Math.max(0, Math.round(s || 0)); return s >= 60 ? `${Math.floor(s / 60)} dəq ${pad(s % 60)} san` : `${s} san`; };
// ISO timestamp <-> value of <input type="datetime-local"> shown in Baku time (UTC+4, no DST).
export const isoToLocalInput = (iso) => { const p = iso && parts(iso); return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : ''; };
export const localInputToIso = (v) => (v ? new Date(v + ':00+04:00').toISOString() : null);
const AZ = { 'ə': 'e', 'ı': 'i', 'ö': 'o', 'ü': 'u', 'ç': 'c', 'ş': 's', 'ğ': 'g' };
export const slugify = (s) => String(s || '').toLowerCase().replace(/\u0307/g, '').replace(/[əıöüçşğ]/g, (c) => AZ[c]).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
export const chip = (label, color = 'grey') => h`<span class="chip c-${color}"><i></i>${label}</span>`;
export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/* ---------- toast ---------- */
export function toast(message, kind = 'info') {
  $$('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast ' + (kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : '');
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  setHTML(t, h`${icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info')}<span>${message}</span>`);
  document.body.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3800);
}
export const showError = (e) => toast(e && e.message ? e.message : 'Xəta baş verdi', 'error');

/* ---------- dialogs ---------- */
// Opens a modal dialog. `build(dialog, close)` fills it. Resolves with the value passed to close().
export function modal(build, { wide = false, label = 'Pəncərə' } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal' + (wide ? ' wide' : '');
    d.setAttribute('aria-label', label);
    let result;
    const close = (val) => { result = val; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.addEventListener('click', (e) => { if (e.target === d) close(undefined); });
    document.body.append(d);
    build(d, close);
    d.showModal();
  });
}
export function confirmDialog(message, { title = 'Təsdiq', ok = 'Bəli', danger = false, detail = '' } = {}) {
  return modal((d, close) => {
    setHTML(d, h`<div class="modal-h"><h2>${title}</h2></div><div class="modal-b"><p>${message}</p>${detail ? h`<p class="muted" style="margin-top:8px;font-size:13.5px">${detail}</p>` : ''}</div>
      <div class="modal-f"><button class="btn" data-x="0">Ləğv et</button><button class="btn ${danger ? 'dangerbtn' : 'pri'}" data-x="1">${ok}</button></div>`);
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (b) close(b.dataset.x === '1'); });
  }, { label: title }).then((v) => v === true);
}
// Small form in a dialog. fields: [{name,label,type,value,help,required,rows}] -> resolves with values or undefined.
export function promptDialog({ title, fields, ok = 'Yadda saxla', intro = '', submit }) {
  return modal((d, close) => {
    setHTML(d, h`<form novalidate><div class="modal-h"><h2>${title}</h2></div><div class="modal-b" style="display:grid;gap:12px">
      ${intro ? h`<p class="muted" style="font-size:13.5px">${intro}</p>` : ''}
      ${fields.map((f) => h`<label class="field"><span>${f.label}${f.required ? ' *' : ''}</span>${f.type === 'textarea'
        ? h`<textarea class="in" name="${f.name}" rows="${f.rows || 5}">${f.value || ''}</textarea>`
        : f.type === 'select' ? h`<select class="in" name="${f.name}">${f.options.map((o) => h`<option value="${o[0]}" ${String(o[0]) === String(f.value) ? raw('selected') : ''}>${o[1]}</option>`)}</select>`
          : h`<input class="in" name="${f.name}" type="${f.type || 'text'}" value="${f.value || ''}" autocomplete="${f.autocomplete || 'off'}">`}
        ${f.help ? h`<small>${f.help}</small>` : ''}<small class="ferr" data-err="${f.name}" hidden></small></label>`)}
      <p class="ferr" data-err="_" hidden></p></div>
      <div class="modal-f"><button type="button" class="btn" data-x>Ləğv et</button><button class="btn pri" type="submit">${ok}</button></div></form>`);
    const form = $('form', d);
    $('[data-x]', d).addEventListener('click', () => close(undefined));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value]));
      $$('[data-err]', d).forEach((x) => { x.hidden = true; });
      const miss = fields.find((f) => f.required && !String(values[f.name]).trim());
      if (miss) { const x = $(`[data-err="${miss.name}"]`, d); x.textContent = 'Bu sahə mütləqdir'; x.hidden = false; form.elements[miss.name].focus(); return; }
      if (!submit) return close(values);
      const btn = $('button[type=submit]', d); btn.disabled = true;
      try { close((await submit(values)) ?? values); }
      catch (er) {
        btn.disabled = false;
        let shown = false;
        for (const [k, m] of Object.entries(er.fields || {})) { const x = $(`[data-err="${k}"]`, d); if (x) { x.textContent = m; x.hidden = false; shown = true; } }
        if (!shown) { const x = $('[data-err="_"]', d); x.textContent = er.message; x.hidden = false; }
      }
    });
    const first = form.querySelector('input,textarea,select'); if (first) setTimeout(() => first.focus(), 30);
  }, { label: title });
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const download = (url) => { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.append(a); a.click(); a.remove(); };
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Kopyalandı', 'ok'); }
  catch { toast('Kopyalamaq mümkün olmadı', 'error'); }
}

/* ---------- tooltip (charts) ---------- */
const tip = document.getElementById('tip');
export function showTip(value, label, x, y) {
  tip.replaceChildren();
  const b = document.createElement('b'); b.textContent = value;
  tip.append(b, label);
  tip.hidden = false;
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  let L = x + 14, T = y - ht - 12;
  if (L + w > innerWidth - 8) L = x - w - 14;
  if (L < 8) L = 8;
  if (T < 8) T = y + 16;
  tip.style.left = L + 'px'; tip.style.top = T + 'px';
}
export const hideTip = () => { tip.hidden = true; };
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t) { const p = t.getAttribute('data-tip').split('|'); showTip(p[0], p[1] || '', e.clientX, e.clientY); }
  else if (!e.target.closest || !e.target.closest('.linehit')) hideTip();
});
document.addEventListener('scroll', hideTip, true);
