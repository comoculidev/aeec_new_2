'use strict';
// Safe, deliberately small Markdown renderer for news/service/project texts.
//
// Safety model:
// - Links and images are cut out of the raw text first and replaced by opaque placeholders, so
//   markup that was already generated is never scanned again by a later rule.
// - Everything else is HTML-escaped before any tag is added.
// - Link/image targets are restricted to https, (for links) http/mailto/tel, and site-relative
//   paths made of a conservative character set. Attribute values are always quoted and escaped.
// - Every quantifier that runs over author-controlled text is bounded, so rendering time grows
//   linearly with the length of the text.
// The same code is mirrored in admin/assets/ui.js for the live preview - keep both in sync.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const URL_CHARS = "[A-Za-z0-9\\-._~%/?&=#+,:;@!$*]";
const REL = new RegExp('^/(?!/)' + URL_CHARS + '{0,1000}$');
const HTTPS = new RegExp('^https://' + URL_CHARS + '{1,1000}$', 'i');
const OTHER = new RegExp('^(?:http://|mailto:|tel:)' + URL_CHARS + '{1,1000}$', 'i');
function safeUrl(u, image) {
  u = String(u).trim();
  if (REL.test(u) || HTTPS.test(u)) return u;
  if (!image && OTHER.test(u)) return u;
  return null;
}
const OPEN = String.fromCharCode(1), CLOSE = String.fromCharCode(2);
const MARKERS = new RegExp('[' + OPEN + CLOSE + ']', 'g');
const TOKEN = new RegExp(OPEN + '(\\d{1,6})' + CLOSE, 'g');
const emphasis = (escaped) => escaped.replace(/\*\*([^*\n]{1,2000})\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]{1,2000})\*(?!\*)/g, '$1<em>$2</em>');

function inline(text) {
  const tokens = [];
  const hold = (html) => OPEN + (tokens.push(html) - 1) + CLOSE;
  let s = String(text).replace(MARKERS, '');
  s = s.replace(/!\[([^\]\n]{0,300})\]\(([^)\s]{1,1100})\)/g, (m, alt, url) => {
    const u = safeUrl(url, true);
    return u ? hold(`<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy">`) : m;
  });
  s = s.replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,1100})\)/g, (m, label, url) => {
    const u = safeUrl(url, false);
    if (!u) return m;
    const ext = /^https?:/i.test(u) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return hold(`<a href="${esc(u)}"${ext}>${emphasis(esc(label))}</a>`);
  });
  s = emphasis(esc(s));
  // Put the finished tags back. A link label may itself hold an image placeholder, hence two passes.
  for (let i = 0; i < 2; i++) s = s.replace(TOKEN, (m, n) => (tokens[+n] !== undefined ? tokens[+n] : ''));
  return s.replace(MARKERS, '');
}
function render(md) {
  const lines = String(md || '').slice(0, 200000).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>` + list.items.map((i) => `<li>${inline(i)}</li>`).join('') + `</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push('<blockquote><p>' + quote.map(inline).join('<br>') + '</p></blockquote>'); quote = []; } };
  const flush = () => { flushPara(); flushList(); flushQuote(); };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    let m;
    if (!t) { flush(); continue; }
    if ((m = /^(#{2,4}) +(.+)$/.exec(t))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^-{3,}$/.test(t)) { flush(); out.push('<hr>'); continue; }
    if ((m = /^[-*] +(.+)$/.exec(t))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\d{1,3}[.)] +(.+)$/.exec(t))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^> ?(.*)$/.exec(t))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = /^!\[([^\]\n]{0,300})\]\(([^)\s]{1,1100})\)$/.exec(t))) {
      const u = safeUrl(m[2], true);
      if (u) { flush(); out.push(`<figure><img src="${esc(u)}" alt="${esc(m[1])}" loading="lazy">${m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : ''}</figure>`); continue; }
    }
    flushList(); flushQuote(); para.push(line);
  }
  flush();
  return out.join('\n');
}
module.exports = { render, esc, safeUrl };
