// Reusable interface pieces: server-driven data table, form builder (with AZ/EN/RU tabs),
// media picker, text editor with formatting toolbar.
import { h, raw, esc, setHTML, $, $$, icon, api, qs, toast, showError, modal, debounce, download, state, fmtSize, slugify, isoToLocalInput, localInputToIso } from './core.js';

/* =====================================================================  data table  */
const TABLES = {};
export function dataTable(host, cfg) {
  const st = TABLES[cfg.id] || (TABLES[cfg.id] = { q: '', f: {}, from: '', to: '', sort: cfg.sort || '', page: 1 });
  const filters = cfg.filters || [];
  let lastData = null, rows = [];
  setHTML(host, h`<div class="tbar">
    ${cfg.search !== false ? h`<div class="search">${icon('search')}<label class="sr" for="q-${cfg.id}">Axtarış</label><input class="in" id="q-${cfg.id}" type="search" placeholder="${cfg.searchPlaceholder || 'Axtarış…'}" value="${st.q}"></div>` : ''}
    ${filters.map((f) => h`<label class="sr" for="f-${cfg.id}-${f.key}">${f.label}</label><select class="in" id="f-${cfg.id}-${f.key}" data-f="${f.key}"></select>`)}
    ${cfg.dateRange ? h`<span class="drange"><label class="sr" for="d1-${cfg.id}">Başlanğıc tarix</label><input class="in" type="date" id="d1-${cfg.id}" data-d="from" value="${st.from}" title="Başlanğıc tarix"><span class="muted">–</span><label class="sr" for="d2-${cfg.id}">Son tarix</label><input class="in" type="date" id="d2-${cfg.id}" data-d="to" value="${st.to}" title="Son tarix"></span>` : ''}
    <span class="sp"></span>
    ${cfg.exportUrl ? h`<button class="btn sm" data-exp="xlsx" title="Excel faylı kimi yüklə">${icon('down', 'sm')}Excel</button><button class="btn sm" data-exp="csv" title="CSV faylı kimi yüklə">${icon('down', 'sm')}CSV</button>` : ''}
    ${cfg.extra || ''}</div><div class="tw" aria-live="polite"><div class="empty">Yüklənir…</div></div><div class="pager"></div>`);
  const tw = $('.tw', host), pg = $('.pager', host);
  const fillFilters = (data) => {
    for (const f of filters) {
      const sel = $(`[data-f="${f.key}"]`, host);
      const opts = typeof f.options === 'function' ? f.options(data || {}) : f.options;
      const sig = JSON.stringify(opts);
      if (sel.dataset.sig === sig) continue;
      sel.dataset.sig = sig;
      setHTML(sel, h`<option value="">${f.label}: hamısı</option>${(opts || []).map((o) => h`<option value="${o[0]}">${o[1]}</option>`)}`);
      sel.value = st.f[f.key] || '';
    }
  };
  fillFilters(null);
  const params = () => ({ q: st.q, ...st.f, from: st.from, to: st.to, sort: st.sort, ...(cfg.params ? cfg.params() : {}) });
  const head = () => h`<thead><tr>${cfg.columns.map((c) => {
    const key = c.sort, active = key && (st.sort === key || st.sort === '-' + key), desc = st.sort === '-' + key;
    return h`<th class="${c.cls || ''}" ${active ? raw(`aria-sort="${desc ? 'descending' : 'ascending'}"`) : ''}>${key ? h`<button type="button" data-sort="${key}">${c.label}${active ? icon(desc ? 'dn' : 'up', 'sm') : ''}</button>` : c.label}</th>`;
  })}${cfg.actions ? h`<th><span class="sr">Əməliyyat</span></th>` : ''}</tr></thead>`;
  async function load() {
    let data;
    try { data = await api.get(cfg.url + qs({ ...params(), page: st.page, per_page: cfg.perPage || 15 })); }
    catch (e) { setHTML(tw, h`<div class="empty">${e.message}</div>`); pg.textContent = ''; return; }
    lastData = data; rows = data.items || [];
    const pages = Math.max(1, Math.ceil((data.total || 0) / (data.per_page || 15)));
    if (st.page > pages) { st.page = pages; return load(); }
    fillFilters(data);
    setHTML(tw, rows.length ? h`<table>${head()}<tbody>${rows.map((r, i) => h`<tr data-i="${i}" class="${cfg.onRow ? 'click' : ''} ${cfg.rowClass ? cfg.rowClass(r) : ''}">
      ${cfg.columns.map((c) => h`<td class="${c.cls || ''}">${c.render ? c.render(r) : r[c.key]}</td>`)}${cfg.actions ? h`<td><div class="acts">${cfg.actions(r)}</div></td>` : ''}</tr>`)}</tbody></table>`
      : h`<div class="empty">${st.q || Object.values(st.f).some(Boolean) || st.from || st.to ? 'Bu axtarışa uyğun qeyd tapılmadı' : (cfg.emptyText || 'Hələ qeyd yoxdur')}</div>`);
    setHTML(pg, h`<span>${data.total || 0} qeyd · səhifə ${st.page} / ${pages}</span><span class="row"><button class="btn sm" data-pg="-1" ${st.page <= 1 ? raw('disabled') : ''}>Əvvəlki</button><button class="btn sm" data-pg="1" ${st.page >= pages ? raw('disabled') : ''}>Növbəti</button></span>`);
    if (cfg.onData) cfg.onData(data);
  }
  const search = debounce(() => { st.page = 1; load(); }, 300);
  host.addEventListener('input', (e) => { if (e.target.type === 'search') { st.q = e.target.value.trim(); search(); } });
  host.addEventListener('change', (e) => {
    const f = e.target.getAttribute('data-f'), d = e.target.getAttribute('data-d');
    if (f) { st.f[f] = e.target.value; st.page = 1; load(); }
    if (d) { st[d] = e.target.value; st.page = 1; load(); }
  });
  host.addEventListener('click', (e) => {
    const sb = e.target.closest('[data-sort]');
    if (sb) { const k = sb.dataset.sort; st.sort = st.sort === k ? '-' + k : k; st.page = 1; load(); return; }
    const pb = e.target.closest('[data-pg]');
    if (pb) { st.page += Number(pb.dataset.pg); load(); return; }
    const ex = e.target.closest('[data-exp]');
    if (ex) { download(cfg.exportUrl + qs({ ...params(), format: ex.dataset.exp })); return; }
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const row = rows[Number(tr.dataset.i)];
    if (!row) return;
    const ab = e.target.closest('[data-act]');
    if (ab) { if (cfg.onAction) cfg.onAction(ab.dataset.act, row, { reload: load }); return; }
    if (cfg.onRow && !e.target.closest('a,button,input,select,label')) cfg.onRow(row);
  });
  load();
  return { reload: load, data: () => lastData };
}

/* =====================================================================  uploads  */
export async function uploadFiles(fileList, { folder = '', url = '/api/media', maxMb = state.config.max_upload_mb || 20, onProgress } = {}) {
  const done = [], failed = [];
  const list = [...fileList];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (onProgress) onProgress(i + 1, list.length, f.name);
    if (f.size > maxMb * 1048576) { failed.push(`${f.name}: fayl çox böyükdür (ən çox ${maxMb} MB)`); continue; }
    const fd = new FormData();
    fd.append('file', f); fd.append('folder', folder);
    try { done.push((await api.upload(url, fd)).item); } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  return { done, failed };
}
export const mediaThumb = (m, cls = '') => (m && m.kind === 'image' && m.url ? h`<img class="thumb ${cls}" src="${m.url}" alt="${m.alt || ''}" loading="lazy">` : h`<span class="thumb doc ${cls}">${m ? String(m.ext || (m.name || '').split('.').pop() || '').toUpperCase() : '—'}</span>`);

// Lets the user choose one or several files from the media library (and upload new ones).
export function pickMedia({ multiple = false, kind = 'image' } = {}) {
  return modal((d, close) => {
    const st = { q: '', page: 1, kind };
    const chosen = new Map();
    setHTML(d, h`<div class="modal-h"><h2>Media kitabxanası</h2><span class="sp"></span><button class="iconbtn" data-close aria-label="Bağla">${icon('x')}</button></div>
      <div class="tbar"><div class="search">${icon('search')}<input class="in" type="search" placeholder="Fayl adı ilə axtar…" aria-label="Axtarış"></div>
        <select class="in" aria-label="Növ"><option value="image">Şəkillər</option><option value="">Bütün fayllar</option><option value="file">Sənədlər</option><option value="video">Videolar</option></select><span class="sp"></span>
        ${state.perms.has('media.upload') ? h`<label class="btn sm pri">${icon('upload', 'sm')}Yüklə<input type="file" multiple hidden></label>` : ''}</div>
      <div class="modal-b picker-body"><div class="picker" aria-live="polite"></div></div>
      <div class="modal-f"><span class="muted pinfo" style="flex:1;font-size:13px"></span><button class="btn" data-close>Ləğv et</button>${multiple ? h`<button class="btn pri" data-ok disabled>Seçilənləri əlavə et</button>` : ''}</div>`);
    const grid = $('.picker', d), info = $('.pinfo', d), sel = $('select', d);
    sel.value = kind;
    const load = async () => {
      let data;
      try { data = await api.get('/api/media' + qs({ q: st.q, kind: st.kind, page: st.page, per_page: 24 })); }
      catch (e) { setHTML(grid, h`<div class="empty">${e.message}</div>`); return; }
      const pages = Math.max(1, Math.ceil(data.total / 24));
      setHTML(grid, data.items.length ? h`${data.items.map((m) => h`<button type="button" class="pk ${chosen.has(m.id) ? 'on' : ''}" data-id="${m.id}" title="${m.name}">${mediaThumb(m)}<span>${m.name}</span></button>`)}` : h`<div class="empty">Fayl tapılmadı. Yuxarıdakı «Yüklə» düyməsi ilə əlavə edin.</div>`);
      grid._items = data.items;
      setHTML(info, h`${data.total} fayl${pages > 1 ? h` · səhifə ${st.page}/${pages} <button class="btn sm ghost" data-p="-1" ${st.page <= 1 ? raw('disabled') : ''}>‹</button><button class="btn sm ghost" data-p="1" ${st.page >= pages ? raw('disabled') : ''}>›</button>` : ''}`);
    };
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return close(undefined);
      const p = e.target.closest('[data-p]'); if (p) { st.page += Number(p.dataset.p); load(); return; }
      if (e.target.closest('[data-ok]')) return close([...chosen.values()]);
      const b = e.target.closest('.pk');
      if (!b) return;
      const m = (grid._items || []).find((x) => String(x.id) === b.dataset.id);
      if (!m) return;
      if (!multiple) return close(m);
      if (chosen.has(m.id)) chosen.delete(m.id); else chosen.set(m.id, m);
      b.classList.toggle('on');
      $('[data-ok]', d).disabled = !chosen.size;
    });
    $('input[type=search]', d).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }, 300));
    sel.addEventListener('change', () => { st.kind = sel.value; st.page = 1; load(); });
    const fi = $('input[type=file]', d);
    if (fi) fi.addEventListener('change', async () => {
      info.textContent = 'Yüklənir…';
      const r = await uploadFiles(fi.files, { onProgress: (i, n, name) => { info.textContent = `Yüklənir ${i}/${n}: ${name}`; } });
      fi.value = '';
      if (r.failed.length) toast(r.failed.join(' · '), 'error'); else toast(`${r.done.length} fayl yükləndi`, 'ok');
      st.page = 1; load();
    });
    load();
  }, { wide: true, label: 'Media kitabxanası' });
}

/* =====================================================================  text formatting  */
// Client-side copy of the server renderer (src/markdown.js), used only for the live preview.
// Keep both in sync: links/images become placeholders first, everything else is escaped, every
// quantifier is bounded.
const URL_CHARS = "[A-Za-z0-9\\-._~%/?&=#+,:;@!$*]";
const REL = new RegExp('^/(?!/)' + URL_CHARS + '{0,1000}$');
const HTTPS = new RegExp('^https://' + URL_CHARS + '{1,1000}$', 'i');
const OTHER = new RegExp('^(?:http://|mailto:|tel:)' + URL_CHARS + '{1,1000}$', 'i');
const safeUrl = (u, image) => { u = String(u).trim(); if (REL.test(u) || HTTPS.test(u)) return u; if (!image && OTHER.test(u)) return u; return null; };
const OPEN = String.fromCharCode(1), CLOSE = String.fromCharCode(2);
const MARKERS = new RegExp('[' + OPEN + CLOSE + ']', 'g');
const TOKEN = new RegExp(OPEN + '(\\d{1,6})' + CLOSE, 'g');
const emphasis = (escaped) => escaped.replace(/\*\*([^*\n]{1,2000})\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]{1,2000})\*(?!\*)/g, '$1<em>$2</em>');
function mdInline(text) {
  const tokens = [];
  const hold = (html) => OPEN + (tokens.push(html) - 1) + CLOSE;
  let s = String(text).replace(MARKERS, '');
  s = s.replace(/!\[([^\]\n]{0,300})\]\(([^)\s]{1,1100})\)/g, (m, alt, url) => { const u = safeUrl(url, true); return u ? hold(`<img src="${esc(u)}" alt="${esc(alt)}">`) : m; });
  s = s.replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,1100})\)/g, (m, label, url) => { const u = safeUrl(url, false); return u ? hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${emphasis(esc(label))}</a>`) : m; });
  s = emphasis(esc(s));
  for (let i = 0; i < 2; i++) s = s.replace(TOKEN, (m, n) => (tokens[+n] !== undefined ? tokens[+n] : ''));
  return s.replace(MARKERS, '');
}
export function renderMarkdown(md) {
  const out = []; let para = [], list = null, quote = [];
  const fp = () => { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } };
  const fl = () => { if (list) { out.push(`<${list.tag}>` + list.items.map((i) => `<li>${mdInline(i)}</li>`).join('') + `</${list.tag}>`); list = null; } };
  const fq = () => { if (quote.length) { out.push('<blockquote><p>' + quote.map(mdInline).join('<br>') + '</p></blockquote>'); quote = []; } };
  const flush = () => { fp(); fl(); fq(); };
  for (const rawLine of String(md || '').slice(0, 200000).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd(), t = line.trim(); let m;
    if (!t) { flush(); continue; }
    if ((m = /^(#{2,4}) +(.+)$/.exec(t))) { flush(); out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); continue; }
    if (/^-{3,}$/.test(t)) { flush(); out.push('<hr>'); continue; }
    if ((m = /^[-*] +(.+)$/.exec(t))) { fp(); fq(); if (!list || list.tag !== 'ul') { fl(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\d{1,3}[.)] +(.+)$/.exec(t))) { fp(); fq(); if (!list || list.tag !== 'ol') { fl(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^> ?(.*)$/.exec(t))) { fp(); fl(); quote.push(m[1]); continue; }
    fl(); fq(); para.push(line);
  }
  flush();
  return raw(out.join('\n'));
}
function wireEditor(box) {
  const ta = $('textarea', box), prev = $('.md-preview', box);
  const wrap = (before, after, placeholder) => {
    const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || placeholder;
    ta.setRangeText(before + sel + after, s, e, 'select');
    ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
    ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const linePrefix = (prefix) => {
    const s = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1; let e = ta.value.indexOf('\n', ta.selectionEnd); if (e === -1) e = ta.value.length;
    const block = ta.value.slice(s, e).split('\n').map((l, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + l.replace(/^(#{2,4}\s+|[-*]\s+|\d+[.)]\s+|>\s?)/, '')).join('\n');
    ta.setRangeText(block, s, e, 'end'); ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-md]');
    if (!b) return;
    const a = b.dataset.md;
    if (a === 'b') wrap('**', '**', 'qalın mətn');
    else if (a === 'i') wrap('*', '*', 'kursiv mətn');
    else if (a === 'h2') linePrefix('## ');
    else if (a === 'h3') linePrefix('### ');
    else if (a === 'ul') linePrefix('- ');
    else if (a === 'ol') linePrefix((i) => `${i + 1}. `);
    else if (a === 'q') linePrefix('> ');
    else if (a === 'link') { const url = window.prompt('Keçid ünvanı (https://…)', 'https://'); if (url && url !== 'https://') wrap('[', `](${url.trim()})`, 'keçid mətni'); }
    else if (a === 'img') { const m = await pickMedia({ kind: 'image' }); if (m) { ta.setRangeText(`\n\n![${m.alt || ''}](${m.url})\n\n`, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); } }
    else if (a === 'preview') {
      const on = prev.hidden;
      if (on) setHTML(prev, renderMarkdown(ta.value));
      prev.hidden = !on; ta.hidden = on; b.setAttribute('aria-pressed', String(on));
      b.querySelector('span').textContent = on ? 'Redaktə' : 'Ön baxış';
    }
  });
}
const editorHTML = (name, value, rows, placeholder, label) => h`<div class="md" data-editor>
  <div class="md-bar" role="toolbar" aria-label="Mətn formatı">
    <button type="button" class="iconbtn" data-md="b" title="Qalın" aria-label="Qalın">${icon('bold')}</button><button type="button" class="iconbtn" data-md="i" title="Kursiv" aria-label="Kursiv">${icon('italic')}</button>
    <button type="button" class="btn sm ghost" data-md="h2" title="Başlıq">H2</button><button type="button" class="btn sm ghost" data-md="h3" title="Alt başlıq">H3</button>
    <button type="button" class="iconbtn" data-md="ul" title="Siyahı" aria-label="Siyahı">${icon('list')}</button><button type="button" class="btn sm ghost" data-md="ol" title="Nömrəli siyahı">1.</button>
    <button type="button" class="iconbtn" data-md="q" title="Sitat" aria-label="Sitat">${icon('quote')}</button><button type="button" class="iconbtn" data-md="link" title="Keçid" aria-label="Keçid">${icon('link')}</button>
    <button type="button" class="iconbtn" data-md="img" title="Şəkil" aria-label="Şəkil">${icon('image')}</button><span class="sp"></span>
    <button type="button" class="btn sm ghost" data-md="preview" aria-pressed="false">${icon('eye', 'sm')}<span>Ön baxış</span></button></div>
  <textarea class="in" data-f="${name}" rows="${rows || 12}" placeholder="${placeholder || ''}" aria-label="${label || 'Mətn'}">${value || ''}</textarea><div class="md-preview prose" hidden aria-label="Ön baxış"></div></div>`;

/* =====================================================================  form builder  */
const LANG_LABEL = { az: 'Azərbaycan', en: 'English', ru: 'Русский' };
const get = (obj, pathStr) => pathStr.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

function rowsHTML(name, f, value) {
  const list = Array.isArray(value) ? value : [];
  const row = (r) => h`<div class="rw">${f.columns.map((c) => (c.type === 'checkbox'
    ? h`<label class="check" title="${c.label}"><input type="checkbox" data-c="${c.key}" ${r && r[c.key] ? raw('checked') : ''}> <span>${c.label}</span></label>`
    : c.type === 'textarea' ? h`<textarea class="in" data-c="${c.key}" rows="2" placeholder="${c.label}" aria-label="${c.label}">${r ? r[c.key] || '' : ''}</textarea>`
      : h`<input class="in" data-c="${c.key}" placeholder="${c.label}" aria-label="${c.label}" value="${r ? (c.key ? r[c.key] : r) || '' : ''}" style="${c.width ? `max-width:${c.width}` : ''}">`))}
    <button type="button" class="iconbtn" data-rw="up" title="Yuxarı" aria-label="Yuxarı">${icon('up')}</button><button type="button" class="iconbtn" data-rw="del" title="Sil" aria-label="Sil">${icon('trash')}</button></div>`;
  return h`<div class="rows" data-rows="${name}" data-def="${f.name}">${list.map(row)}<template>${row(null)}</template><button type="button" class="btn sm" data-rw="add">${icon('plus', 'sm')}${f.addLabel || 'Əlavə et'}</button></div>`;
}
function fieldHTML(f, name, value, baseValue) {
  const id = 'f_' + name.replace(/\W/g, '_');
  const ph = baseValue && typeof baseValue === 'string' ? baseValue.slice(0, 80) : (f.placeholder || '');
  let control;
  switch (f.type) {
    case 'textarea': control = h`<textarea class="in" id="${id}" data-f="${name}" rows="${f.rows || 3}" maxlength="${f.max || 20000}" placeholder="${ph}">${value || ''}</textarea>`; break;
    case 'markdown': control = editorHTML(name, value, f.rows, ph, f.label); break;
    case 'select': control = h`<select class="in" id="${id}" data-f="${name}">${(f.options || []).map((o) => h`<option value="${o[0]}" ${String(o[0]) === String(value === null || value === undefined ? '' : value) ? raw('selected') : ''}>${o[1]}</option>`)}</select>`; break;
    case 'checkbox': return h`<label class="check ${f.full ? 'full' : ''}"><input type="checkbox" class="switch" data-f="${name}" ${value ? raw('checked') : ''}> <span>${f.label}</span></label>`;
    case 'tags': control = h`<input class="in" id="${id}" data-f="${name}" data-tags value="${Array.isArray(value) ? value.join(', ') : ''}" placeholder="${f.placeholder || 'vergüllə ayırın'}">`; break;
    case 'datetime': control = h`<input class="in" id="${id}" type="datetime-local" data-f="${name}" data-dt value="${isoToLocalInput(value)}">`; break;
    case 'media': control = h`<div class="mfield" data-media="${name}" data-kind="${f.kind || 'image'}"></div>`; break;
    case 'gallery': control = h`<div class="gfield" data-gallery="${name}"></div>`; break;
    case 'rows': control = rowsHTML(name, f, value); break;
    case 'static': control = h`<div class="static">${value || '—'}</div>`; break;
    default: control = h`<input class="in ${f.mono ? 'mono' : ''}" id="${id}" type="${f.type || 'text'}" data-f="${name}" value="${value === null || value === undefined ? '' : value}" maxlength="${f.max || 500}" placeholder="${ph}" ${f.list ? raw(`list="${esc(id)}_l"`) : ''} autocomplete="off">${f.list ? h`<datalist id="${id}_l">${f.list.map((o) => h`<option value="${o}">`)}</datalist>` : ''}`;
  }
  const plain = !['media', 'gallery', 'rows', 'markdown', 'static'].includes(f.type);
  return h`<div class="field ${f.full ? 'full' : ''}">${plain ? h`<label for="${id}">${f.label}${f.required ? ' *' : ''}</label>` : h`<span class="flabel">${f.label}${f.required ? ' *' : ''}</span>`}${control}${f.help ? h`<small>${f.help}</small>` : ''}<small class="ferr" data-err="${name}" hidden></small></div>`;
}

// sections: [{ title, sub, col: 'main'|'side', fields: [{name,label,type,…,i18n:true}] }]
export function buildForm(host, { sections, values = {}, langs = null, onSubmit, submitLabel = 'Yadda saxla', cancelHref, readonly = false, footerNote = '', langHint = 'Boş qalan sahələr saytda Azərbaycan dilində göstərilir.' }) {
  const fields = sections.flatMap((s) => s.fields);
  const tr = langs ? fields.filter((f) => f.i18n) : [];
  const store = new Map(); // media / gallery values by field name
  const section = (s) => h`<section class="card"><div class="card-h"><div><h2>${s.title}</h2>${s.sub ? h`<p>${s.sub}</p>` : ''}</div></div><div class="card-b form ${s.col === 'side' ? 'one' : ''}">
    ${s.fields.map((f) => (f.i18n && langs
      ? h`<div class="langset ${f.full ? 'full' : ''}"><div data-lang="az">${fieldHTML(f, f.name, values[f.name])}</div>${langs.map((l) => h`<div data-lang="${l}" hidden>${fieldHTML({ ...f, required: false, help: f.help }, `i18n.${l}.${f.name}`, get(values, `i18n.${l}.${f.name}`), values[f.name])}</div>`)}</div>`
      : h`<div class="${f.full ? 'full' : ''} ${s.col === 'side' ? '' : 'shared'}">${fieldHTML(f, f.name, values[f.name])}</div>`))}</div></section>`;
  const main = sections.filter((s) => s.col !== 'side'), side = sections.filter((s) => s.col === 'side');
  setHTML(host, h`<form class="eform" novalidate>
    ${tr.length ? h`<div class="langbar" role="tablist" aria-label="Dil">${['az', ...langs].map((l, i) => h`<button type="button" role="tab" aria-selected="${i === 0}" data-langtab="${l}">${LANG_LABEL[l]}</button>`)}<span class="muted langhint" hidden>${langHint}</span></div>` : ''}
    <div class="${side.length ? 'grid g21' : 'grid'}"><div class="grid">${main.map(section)}</div>${side.length ? h`<div class="grid" style="align-content:start">${side.map(section)}</div>` : ''}</div>
    ${readonly ? '' : h`<div class="formbar"><button class="btn pri" type="submit">${icon('save', 'sm')}${submitLabel}</button>${cancelHref ? h`<a class="btn" href="${cancelHref}">Ləğv et</a>` : ''}<span class="muted" style="font-size:13px">${footerNote}</span></div>`}</form>`);
  const form = $('form', host);
  if (readonly) $$('input,select,textarea,button:not([data-langtab]):not([data-md="preview"])', form).forEach((x) => { x.disabled = true; });
  $$('[data-editor]', form).forEach(wireEditor);

  // media and gallery fields
  const drawMedia = (box) => {
    const name = box.dataset.media, m = store.get(name);
    setHTML(box, h`${m ? h`${mediaThumb(m, 'lg')}<span class="mname">${m.name}</span>` : h`<span class="thumb lg doc">—</span><span class="muted">Seçilməyib</span>`}
      ${readonly ? '' : h`<button type="button" class="btn sm" data-mpick>${icon('image', 'sm')}${m ? 'Dəyiş' : 'Seç'}</button>${m ? h`<button type="button" class="btn sm ghost danger" data-mclear>Sil</button>` : ''}`}`);
  };
  const drawGallery = (box) => {
    const list = store.get(box.dataset.gallery) || [];
    setHTML(box, h`<div class="gal">${list.map((m, i) => h`<div class="gi">${mediaThumb(m, 'lg')}${readonly ? '' : h`<button type="button" class="iconbtn" data-gdel="${i}" aria-label="Sil" title="Sil">${icon('x', 'sm')}</button>`}</div>`)}</div>
      ${readonly ? '' : h`<button type="button" class="btn sm" data-gadd>${icon('plus', 'sm')}Şəkillər əlavə et</button>`}`);
  };
  for (const f of fields) {
    if (f.type === 'media') { store.set(f.name, values[f.objKey || f.name.replace(/_media_id$/, '')] || null); }
    if (f.type === 'gallery') store.set(f.name, values[f.itemsKey || f.name + '_items'] || []);
  }
  $$('[data-media]', form).forEach(drawMedia); $$('[data-gallery]', form).forEach(drawGallery);

  form.addEventListener('click', async (e) => {
    const lt = e.target.closest('[data-langtab]');
    if (lt) {
      const l = lt.dataset.langtab;
      $$('[data-langtab]', form).forEach((b) => b.setAttribute('aria-selected', String(b === lt)));
      $$('[data-lang]', form).forEach((x) => { x.hidden = x.dataset.lang !== l; });
      $$('.shared', form).forEach((x) => { x.hidden = l !== 'az'; });
      $('.langhint', form).hidden = l === 'az';
      return;
    }
    const mp = e.target.closest('[data-mpick]');
    if (mp) { const box = mp.closest('[data-media]'); const m = await pickMedia({ kind: box.dataset.kind }); if (m) { store.set(box.dataset.media, m); drawMedia(box); } return; }
    const mc = e.target.closest('[data-mclear]');
    if (mc) { const box = mc.closest('[data-media]'); store.set(box.dataset.media, null); drawMedia(box); return; }
    const ga = e.target.closest('[data-gadd]');
    if (ga) { const box = ga.closest('[data-gallery]'); const ms = await pickMedia({ multiple: true }); if (ms && ms.length) { const cur = store.get(box.dataset.gallery) || []; store.set(box.dataset.gallery, cur.concat(ms.filter((m) => !cur.some((c) => c.id === m.id)))); drawGallery(box); } return; }
    const gd = e.target.closest('[data-gdel]');
    if (gd) { const box = gd.closest('[data-gallery]'); const cur = (store.get(box.dataset.gallery) || []).slice(); cur.splice(Number(gd.dataset.gdel), 1); store.set(box.dataset.gallery, cur); drawGallery(box); return; }
    const rw = e.target.closest('[data-rw]');
    if (rw) {
      const box = rw.closest('[data-rows]'), act = rw.dataset.rw;
      if (act === 'add') { const node = $('template', box).content.firstElementChild.cloneNode(true); box.insertBefore(node, $('template', box)); const first = node.querySelector('input,textarea'); if (first) first.focus(); }
      else { const row = rw.closest('.rw'); if (act === 'del') row.remove(); else if (row.previousElementSibling && row.previousElementSibling.classList.contains('rw')) box.insertBefore(row, row.previousElementSibling); }
    }
  });
  // slug follows its source field until the user edits it
  for (const f of fields.filter((x) => x.slugFrom)) {
    const slug = $(`[data-f="${f.name}"]`, form), src = $(`[data-f="${f.slugFrom}"]`, form);
    let touched = Boolean(slug.value);
    src.addEventListener('input', () => { if (!touched) slug.value = slugify(src.value); });
    slug.addEventListener('input', () => { touched = true; });
  }
  const readRows = (box, f) => $$(':scope > .rw', box).map((row) => {
    if (f.columns.length === 1 && !f.columns[0].key) return $('[data-c]', row).value.trim();
    const o = {};
    for (const c of f.columns) { const el = $(`[data-c="${c.key}"]`, row); o[c.key] = c.type === 'checkbox' ? el.checked : el.value.trim(); }
    return o;
  }).filter((r) => (typeof r === 'string' ? r : f.columns.some((c) => c.type !== 'checkbox' && r[c.key])));
  const readField = (f, name) => {
    if (f.type === 'media') { const m = store.get(name); return m ? m.id : null; }
    if (f.type === 'gallery') return (store.get(name) || []).map((m) => m.id);
    if (f.type === 'rows') return readRows($(`[data-rows="${name}"]`, form), f);
    if (f.type === 'static') return undefined;
    const el = $(`[data-f="${name}"]`, form);
    if (!el) return undefined;
    if (f.type === 'checkbox') return el.checked;
    if (f.type === 'tags') return el.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (f.type === 'datetime') return localInputToIso(el.value);
    if (f.type === 'number') return el.value === '' ? null : Number(el.value);
    return el.value;
  };
  function collect() {
    const out = {};
    for (const f of fields) { const v = readField(f, f.name); if (v !== undefined) out[f.name] = v; }
    if (tr.length) {
      out.i18n = {};
      for (const l of langs) { out.i18n[l] = {}; for (const f of tr) { const v = readField(f, `i18n.${l}.${f.name}`); if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) out.i18n[l][f.name] = v; } }
    }
    return out;
  }
  function showErrors(map) {
    $$('.ferr', form).forEach((x) => { x.hidden = true; });
    let first = null;
    for (const [k, msg] of Object.entries(map || {})) {
      const x = $(`[data-err="${CSS.escape(k)}"]`, form);
      if (x) { x.textContent = msg; x.hidden = false; if (!first) first = x; }
    }
    if (first) {
      const pane = first.closest('[data-lang]');
      if (pane && pane.hidden) { const b = $(`[data-langtab="${pane.dataset.lang}"]`, form); if (b) b.click(); }
      first.closest('.field').scrollIntoView({ block: 'center', behavior: 'smooth' });
      const inp = first.closest('.field').querySelector('input,textarea,select'); if (inp) inp.focus({ preventScroll: true });
    }
    return Boolean(first);
  }
  if (!readonly) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = collect();
    const missing = {};
    for (const f of fields) if (f.required && (data[f.name] === '' || data[f.name] === null || data[f.name] === undefined)) missing[f.name] = 'Bu sahə mütləqdir';
    if (showErrors(missing)) { toast('Mütləq sahələri doldurun', 'error'); return; }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try { await onSubmit(data); }
    catch (er) { if (!showErrors(er.fields)) showError(er); else toast(er.message || 'Məlumatlar düzgün deyil', 'error'); }
    finally { btn.disabled = false; }
  });
  return { collect, form };
}
export { fmtSize };
