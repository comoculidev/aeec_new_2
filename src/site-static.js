'use strict';
// Serves the website (site/ inside this project). These rules used to live in Apache's
// .htaccess; the application now applies them itself, so no web-server configuration is needed:
//   - old addresses (.html pages, pre-2026 pages) -> 301 to the new clean address
//   - /index.html -> folder address, folder without "/" -> with "/"
//   - hidden files are not served (except .well-known), service files are refused
//   - security headers (CSP etc.), cache rules, gzip for text files
//   - the custom 404 page
// All redirect targets are paths on this same site - never another domain.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('./config');
const { sendFile, MIME } = require('./http');

// Old address -> new address (exactly the list that was in .htaccess).
const OLD = {
  'haqqimizda.html': '/haqqimizda/', 'heller.html': '/heller/', 'layiheler.html': '/layiheler/', 'dayaniqliliq.html': '/dayaniqliliq/',
  'academy.html': '/akademiya/', 'xeberler.html': '/xeberler/', 'elaqe.html': '/elaqe/', 'mexfilik.html': '/mexfilik/',
  'en/haqqimizda.html': '/en/about/', 'en/heller.html': '/en/solutions/', 'en/layiheler.html': '/en/projects/', 'en/dayaniqliliq.html': '/en/sustainability/',
  'en/academy.html': '/en/academy/', 'en/xeberler.html': '/en/news/', 'en/elaqe.html': '/en/contact/', 'en/mexfilik.html': '/en/privacy/',
  'ru/haqqimizda.html': '/ru/about/', 'ru/heller.html': '/ru/solutions/', 'ru/layiheler.html': '/ru/projects/', 'ru/dayaniqliliq.html': '/ru/sustainability/',
  'ru/academy.html': '/ru/academy/', 'ru/xeberler.html': '/ru/news/', 'ru/elaqe.html': '/ru/contact/', 'ru/mexfilik.html': '/ru/privacy/',
};
// Pages of the pre-2026 site (case-insensitive).
const OLD_NC = { 'homemore.html': '/en/about/', 'aboutmore.html': '/en/about/', 'aservice.html': '/en/solutions/', 'bservice.html': '/en/solutions/', 'cservice.html': '/en/solutions/', 'dservice.html': '/en/solutions/' };

const SITE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-src https://www.google.com; connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'"
    + (config.cookieSecure ? '; upgrade-insecure-requests' : ''),
};

const DENIED = /\.(?:bak|conf|ini|log|sh|sql|md)$/i;
const TEXT = /^\.(html|css|js|svg|xml|txt|json|webmanifest)$/;
const CACHE = (ext) => (/^\.(css|js)$/.test(ext) ? 'public, max-age=31536000, immutable' : /^\.(webp|jpe?g|png|svg|ico|webmanifest)$/.test(ext) ? 'public, max-age=2592000' : 'no-cache');
const TYPES = { '.webmanifest': 'application/manifest+json', '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8' };

function notFound(ctx) {
  const page = path.join(config.siteDir, '404.html');
  ctx.res.setHeader('Cache-Control', 'no-cache');
  ctx.send(404, fs.existsSync(page) ? fs.readFileSync(page) : 'Tapılmadı', 'text/html; charset=utf-8');
}

// Text files are sent gzip-compressed when the browser accepts it (small files, kept in memory).
const gzCache = new Map();
function sendText(ctx, full, st, ext) {
  const { res, req } = ctx;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', TYPES[ext] || MIME[ext] || 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', CACHE(ext));
  res.setHeader('ETag', etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  let body = fs.readFileSync(full);
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
    const key = full + etag;
    let gz = gzCache.get(key);
    if (!gz) { gz = zlib.gzipSync(body); if (gzCache.size > 300) gzCache.clear(); gzCache.set(key, gz); }
    body = gz; res.setHeader('Content-Encoding', 'gzip');
  }
  res.writeHead(200, { 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function serveSite(ctx) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return;
  for (const [k, val] of Object.entries(SITE_HEADERS)) ctx.res.setHeader(k, val);
  ctx.res.removeHeader('Cross-Origin-Opener-Policy');
  const p = ctx.rawPath;
  const qs = ctx.url.search || '';
  if (/\/\.(?!well-known\/)/.test(p)) return notFound(ctx);
  // Redirect targets are built from the still-encoded path with leading slashes collapsed, so
  // "/%2Fevil.example/index.html" can never become a "//evil.example/" (protocol-relative) target.
  const enc = ctx.url.pathname.replace(/^\/+/, '/');
  if (/\/index\.html$/.test(p)) return ctx.redirect(enc.replace(/index\.html$/, '') + qs, 301);
  const rel = p.slice(1);
  if (Object.hasOwn(OLD, rel)) return ctx.redirect(OLD[rel], 301);
  if (Object.hasOwn(OLD_NC, rel.toLowerCase())) return ctx.redirect(OLD_NC[rel.toLowerCase()], 301);
  const full = path.resolve(config.siteDir, '.' + p);
  if (full !== config.siteDir && !full.startsWith(config.siteDir + path.sep)) return notFound(ctx);
  let st;
  try { st = fs.statSync(full); } catch { return notFound(ctx); }
  if (st.isDirectory()) {
    if (!p.endsWith('/')) return ctx.redirect(enc + '/' + qs, 301);
    const index = path.join(full, 'index.html');
    let ist;
    try { ist = fs.statSync(index); } catch { ctx.send(403, 'Forbidden'); return; }
    return sendText(ctx, index, ist, '.html');
  }
  if (DENIED.test(p)) { ctx.send(403, 'Forbidden'); return; }
  const ext = path.extname(full).toLowerCase();
  if (TEXT.test(ext) && st.size < 2 * 1024 * 1024) return sendText(ctx, full, st, ext);
  sendFile(ctx, config.siteDir, path.relative(config.siteDir, full), { cache: CACHE(ext), type: TYPES[ext] });
}

module.exports = { serveSite };
