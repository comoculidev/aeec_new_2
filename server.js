'use strict';
// AEEC Admin - entry point. Start with: npm start
const http = require('node:http');
const path = require('node:path');
const config = require('./src/config');
const { db, migrate } = require('./src/db');
const { createApp, sendFile, err, ADMIN_CSP } = require('./src/http');
const { sessionMiddleware, cleanupSessions } = require('./src/auth');
const { seed } = require('./src/seed');
const mail = require('./src/mail');
const backup = require('./src/backup');
const analytics = require('./src/analytics');
const { systemAlert } = require('./src/notify');
const { serveSite } = require('./src/site-static');
const siteNews = require('./src/site-news');
const { proxyProblem } = require('./src/proxycheck');

const ADMIN_DIR = path.join(__dirname, 'admin');

async function start() {
  migrate();
  await seed();
  siteNews.init();
  const app = createApp();
  let ipWarned = false;
  app.use((ctx) => {
    if (ipWarned || !config.baseUrl.startsWith('https://') || !ctx.path.startsWith('/api/')) return;
    const p = proxyProblem(ctx.ip);
    if (p) { ipWarned = true; console.warn(`[xəbərdarlıq] ${p}. Sorğu limitləri bütün ziyarətçilərə birlikdə tətbiq olunacaq. Bax: OXU-MENI.txt, «Apache» addımı.`); }
  });
  app.use(sessionMiddleware);
  require('./src/routes/public')(app);
  require('./src/routes/auth')(app);
  require('./src/routes/content')(app);
  require('./src/routes/files')(app);
  require('./src/routes/requests')(app);
  require('./src/routes/admin')(app);

  /* Admin panel (single-page app). Canonical addresses:
       /admin/        - the panel (requires a valid session, otherwise -> /admin/login)
       /admin/login   - the sign-in page (already signed in -> /admin/)
     Anything else under /admin/ is a plain 404 - no guessing, no redirects elsewhere.
     The browser keeps the #fragment across these redirects, so /admin/#/xeberler survives the
     detour through the login page; the page itself only ever returns to an in-panel #/route. */
  const ADMIN_CACHE = 'no-store, no-transform'; // no-transform: Cloudflare must not inject scripts
  const shell = (ctx) => sendFile(ctx, ADMIN_DIR, 'index.html', { csp: ADMIN_CSP, cache: ADMIN_CACHE });
  // One canonical address: when BASE_URL is set to the live address (https://aeec.az), requests for
  // www.aeec.az or plain http are sent there. The target is built from BASE_URL only, never from
  // the request, so this can never send anybody to a foreign site. Locally nothing is redirected.
  const base = new URL(config.baseUrl);
  app.use((ctx) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return;
    const wrongHost = String(ctx.req.headers.host || '').toLowerCase() === 'www.' + base.host;
    const plainHttp = base.protocol === 'https:' && config.trustProxy && ctx.req.headers['x-forwarded-proto'] === 'http';
    // The still-encoded path is used (a decoded one could contain characters a header cannot carry).
    if (wrongHost || plainHttp) ctx.redirect(base.origin + ctx.url.pathname.replace(/^\/+/, '/') + ctx.url.search, 301);
  });
  app.get('/admin', (ctx) => {
    if (ctx.rawPath !== '/admin/') return ctx.redirect('/admin/', 301);
    if (!ctx.user) return ctx.redirect('/admin/login');
    shell(ctx);
  });
  app.get('/admin/login', (ctx) => {
    if (ctx.rawPath !== '/admin/login') return ctx.redirect('/admin/login', 301);
    if (ctx.user) return ctx.redirect('/admin/');
    shell(ctx);
  });
  app.get('/admin/index.html', (ctx) => ctx.redirect('/admin/', 301));
  app.get('/admin/assets/:file', (ctx) => {
    if (!/^[\w.-]+\.(js|css|svg|png|ico|woff2)$/.test(ctx.params.file)) throw err(404, 'Tapılmadı');
    sendFile(ctx, path.join(ADMIN_DIR, 'assets'), ctx.params.file, { csp: ADMIN_CSP, cache: 'no-cache, no-transform' });
  });
  const ADMIN_404 = '<!doctype html><html lang="az"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tapılmadı | AEEC Admin</title>'
    + '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;color:#0E2147"><h1>Səhifə tapılmadı</h1>'
    + '<p>Bu ünvanda panel səhifəsi yoxdur.</p><p><a href="/admin/">İdarəetmə panelinə keçin</a></p></body></html>';
  app.fallback((ctx) => {
    if (ctx.path === '/admin' || ctx.path.startsWith('/admin/')) {
      ctx.res.setHeader('Content-Security-Policy', ADMIN_CSP); ctx.res.setHeader('Cache-Control', ADMIN_CACHE);
      return ctx.send(404, ADMIN_404, 'text/html; charset=utf-8');
    }
    if (ctx.path === '/api' || ctx.path.startsWith('/api/') || ctx.path.startsWith('/media/')) return;
    return serveSite(ctx); // everything else is the website
  });
  app.get('/healthz', (ctx) => ctx.json({ ok: true }));

  const server = http.createServer((req, res) => { app.handle(req, res); });
  server.requestTimeout = 120000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;

  // Background jobs.
  mail.startMailLoop();
  const hourly = setInterval(() => { try { cleanupSessions(); analytics.purge(); } catch (e) { console.error('[jobs]', e); } }, 3600000);
  const backupTimer = setInterval(() => backup.autoBackupTick((e) => systemAlert('Ehtiyat nüsxə alınmadı', String(e.message).slice(0, 200), '#/tenzimlemeler/backup')), 10 * 60000);
  hourly.unref(); backupTimer.unref();
  try { cleanupSessions(); } catch { /* ignore */ }

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`AEEC işə düşdü — sayt: ${config.baseUrl}/  ·  idarəetmə paneli: ${config.baseUrl}/admin/  (port ${server.address().port})`);
  if (!config.cookieSecure && !/^http:\/\/(localhost|127\.)/.test(config.baseUrl)) console.warn('[xəbərdarlıq] COOKIE_SECURE söndürülüb — yalnız lokal sınaq üçün. Canlı serverdə HTTPS istifadə edin.');

  const stop = () => { server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return server;
}

// A failed background promise must not take the whole service down; anything else unexpected
// is logged and the process exits so that the supervisor (systemd) restarts it cleanly.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { start };
