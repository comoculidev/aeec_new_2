'use strict';
// Minimal HTTP layer: router, request context, body parsing with hard size limits, security
// headers, safe static file serving and uniform JSON errors.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = extra.code || ({ 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 415: 'unsupported_media_type', 422: 'validation', 429: 'rate_limited' }[status] || 'error');
    this.fields = extra.fields;
    this.headers = extra.headers;
  }
}
const err = (status, message, extra) => new HttpError(status, message, extra);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
// Uploaded files are untrusted: opened directly they run in a sandbox with no script execution.
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; sandbox";

function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000'); // same as site/.htaccess (no includeSubDomains: other subdomains are not ours to force)
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (config.trustProxy) {
    const real = req.headers['x-real-ip'];
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    ip = (typeof real === 'string' && real) || fwd[fwd.length - 1] || ip;
  }
  ip = String(ip).replace(/^::ffff:/, '');
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : '';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > limit) return reject(err(413, 'Göndərilən məlumat həddən böyükdür'));
    const chunks = []; let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; chunks.length = 0; reject(err(413, 'Göndərilən məlumat həddən böyükdür')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    req.on('aborted', () => { if (!done) { done = true; reject(err(400, 'Sorğu yarımçıq kəsildi')); } });
  });
}

class Ctx {
  constructor(req, res, url) {
    this.req = req; this.res = res; this.method = req.method;
    this.path = url.pathname; this.url = url;
    this.query = Object.fromEntries(url.searchParams.entries());
    this.params = {}; this.ip = clientIp(req);
    this.ua = String(req.headers['user-agent'] || '').slice(0, 300);
    this.user = null; this.session = null; this.perms = new Set();
  }
  get sent() { return this.res.writableEnded || this.res.headersSent; }
  header(k, v) { this.res.setHeader(k, v); return this; }
  json(body, status = 200) {
    const s = JSON.stringify(body);
    this.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
    this.res.end(s);
  }
  send(status, body, type) {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    this.res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': b.length });
    this.res.end(b);
  }
  noContent() { this.res.writeHead(204); this.res.end(); }
  // Temporary (302) redirects depend on the login state, so no cache may keep them.
  redirect(loc, status = 302) { this.res.writeHead(status, status === 302 ? { Location: loc, 'Cache-Control': 'no-store' } : { Location: loc }); this.res.end(); }
  async readJson(limit = 256 * 1024) {
    const ct = String(this.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') throw err(415, 'Yalnız application/json qəbul olunur');
    const buf = await readBody(this.req, limit);
    if (!buf.length) return {};
    let v;
    try { v = JSON.parse(buf.toString('utf8')); } catch { throw err(400, 'JSON düzgün deyil'); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw err(400, 'JSON obyekt gözlənilir');
    return v;
  }
  // multipart/form-data parsed by the runtime's own (WHATWG) parser.
  async readForm(limit) {
    const ct = String(this.req.headers['content-type'] || '');
    if (!/^multipart\/form-data;/i.test(ct)) throw err(415, 'multipart/form-data gözlənilir');
    const buf = await readBody(this.req, limit);
    try { return await new Response(buf, { headers: { 'content-type': ct } }).formData(); }
    catch { throw err(400, 'Forma məlumatı oxunmadı'); }
  }
  async readText(limit = 16 * 1024) { return (await readBody(this.req, limit)).toString('utf8'); }
  intParam(name) {
    const v = this.params[name];
    if (!/^\d{1,12}$/.test(v || '')) throw err(404, 'Tapılmadı');
    return parseInt(v, 10);
  }
}

function compile(pattern) {
  const names = [];
  const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
  return { rx: new RegExp('^' + rx + '$'), names };
}

function createApp() {
  const routes = [];
  const pre = [];
  let fallback = null;
  const app = {
    use(fn) { pre.push(fn); },
    // Called for any path that no route matches (website files, panel 404 page, API 404).
    fallback(fn) { fallback = fn; },
    route(method, pattern, ...handlers) { routes.push({ method, ...compile(pattern), handlers }); },
    get: (p, ...h) => app.route('GET', p, ...h), post: (p, ...h) => app.route('POST', p, ...h),
    put: (p, ...h) => app.route('PUT', p, ...h), delete: (p, ...h) => app.route('DELETE', p, ...h),
    async handle(req, res) {
      baseHeaders(res);
      let ctx;
      try {
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) throw err(405, 'Metod dəstəklənmir');
        if ((req.url || '').length > 4096) throw err(414, 'URL çox uzundur');
        let url;
        try { url = new URL(req.url, 'http://local'); } catch { throw err(400, 'URL düzgün deyil'); }
        let pathname;
        try { pathname = decodeURIComponent(url.pathname); } catch { throw err(400, 'URL düzgün deyil'); }
        if (pathname.includes('\0') || pathname.includes('..') || pathname.includes('\\')) throw err(400, 'URL düzgün deyil');
        ctx = new Ctx(req, res, url);
        ctx.path = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
        ctx.rawPath = pathname;
        if (ctx.path.startsWith('/api/')) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', API_CSP); }
        for (const fn of pre) { await fn(ctx); if (ctx.sent) return; }
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        let pathMatched = false;
        for (const r of routes) {
          const m = r.rx.exec(ctx.path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== method) continue;
          r.names.forEach((n, i) => { ctx.params[n] = m[i + 1]; });
          for (const h of r.handlers) { await h(ctx); if (ctx.sent) return; }
          if (!ctx.sent) ctx.noContent();
          return;
        }
        if (pathMatched) throw err(405, 'Metod dəstəklənmir');
        if (fallback) { await fallback(ctx); if (ctx.sent) return; }
        throw err(404, 'Tapılmadı');
      } catch (e) {
        if (res.headersSent) { res.destroy(); return; }
        if (!(e instanceof HttpError) && e && e.code === 'ERR_SQLITE_ERROR' && /constraint/i.test(e.message)) e = new HttpError(409, 'Əməliyyat məlumat bütövlüyü qaydasını pozur (təkrarlanan və ya istifadədə olan qeyd)');
        const status = e instanceof HttpError ? e.status : 500;
        if (status >= 500) console.error(`[error] ${req.method} ${String(req.url).split('?')[0]}`, e);
        if (e.headers) for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
        if (!req.complete) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); }
        const body = JSON.stringify({ error: { code: e instanceof HttpError ? e.code : 'server_error', message: status >= 500 ? 'Daxili xəta baş verdi' : e.message, fields: e.fields } });
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      }
    },
  };
  return app;
}

/* ------------------------------------------------------------ static files */
// Serves a file from `root`. `rel` must already be a validated relative name; the resolved path
// is checked again so that nothing outside `root` can ever be read.
function sendFile(ctx, root, rel, opts = {}) {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw err(404, 'Tapılmadı');
  let st;
  try { st = fs.statSync(full); } catch { throw err(404, 'Tapılmadı'); }
  if (!st.isFile()) throw err(404, 'Tapılmadı');
  const res = ctx.res;
  const ext = path.extname(full).toLowerCase();
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('Content-Type', opts.type || MIME[ext] || 'application/octet-stream');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', opts.cache || 'no-cache');
  if (opts.csp) res.setHeader('Content-Security-Policy', opts.csp);
  if (opts.download) {
    const name = String(opts.download).replace(/[\r\n"\\/]/g, '_');
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Disposition', `${opts.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  if (ctx.req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  let start = 0, end = st.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(ctx.req.headers.range || '');
  res.setHeader('Accept-Ranges', 'bytes');
  if (range && st.size > 0 && (range[1] || range[2])) {
    if (range[1]) { start = parseInt(range[1], 10); if (range[2]) end = Math.min(end, parseInt(range[2], 10)); }
    else start = Math.max(0, st.size - parseInt(range[2], 10));
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  }
  res.writeHead(status, { 'Content-Length': st.size === 0 ? 0 : end - start + 1 });
  if (ctx.req.method === 'HEAD' || st.size === 0) { res.end(); return; }
  const stream = fs.createReadStream(full, { start, end });
  stream.on('error', () => res.destroy());
  // If the client goes away mid-transfer the file handle must be released, otherwise it leaks.
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = { HttpError, err, createApp, sendFile, MIME, ADMIN_CSP, FILE_CSP, clientIp };
