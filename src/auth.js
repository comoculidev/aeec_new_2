'use strict';
// Session handling and access control.
// - The session cookie holds a random token; only its SHA-256 hash is stored in the database.
// - Cookie flags: HttpOnly, SameSite=Strict, Secure (on HTTPS) and the __Host- prefix.
// - Every state-changing request must carry the per-session CSRF token in X-CSRF-Token and come
//   from our own origin.
const config = require('./config');
const { get, run, now } = require('./db');
const { err } = require('./http');
const { randomToken, sha256, safeEqual, rateLimit } = require('./security');
const { permsForRole } = require('./permissions');

const COOKIE = config.cookieSecure ? '__Host-aeec_sid' : 'aeec_sid';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setCookie(ctx, token, maxAgeSec) {
  let c = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
  if (config.cookieSecure) c += '; Secure';
  if (maxAgeSec !== undefined) c += `; Max-Age=${maxAgeSec}`;
  ctx.res.setHeader('Set-Cookie', c);
}
const clearCookie = (ctx) => setCookie(ctx, '', 0);

function createSession(ctx, user, { remember = false, mfaPending = false } = {}) {
  const token = randomToken(32);
  const t = Date.now();
  const ttl = mfaPending ? 5 * 60000 : remember ? config.session.rememberDays * 86400000 : config.session.absoluteHours * 3600000;
  const csrf = randomToken(24);
  run('INSERT INTO sessions (id, user_id, csrf, remember, mfa_pending, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sha256(token), user.id, csrf, remember ? 1 : 0, mfaPending ? 1 : 0, ctx.ip, ctx.ua, new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + ttl).toISOString());
  setCookie(ctx, token, remember && !mfaPending ? Math.floor(ttl / 1000) : undefined);
  return { csrf };
}
function destroySession(ctx) {
  const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  clearCookie(ctx);
}
const destroyUserSessions = (userId, exceptId) => run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptId || '');

function loadUser(id) {
  const u = get(`SELECT u.id, u.email, u.name, u.role_id, u.is_active, u.must_change_password, u.totp_enabled, u.last_login_at,
                        r.key AS role_key, r.name AS role_name
                 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, id);
  return u || null;
}

// Runs on every request: attaches ctx.session / ctx.user when the cookie is valid.
function sessionMiddleware(ctx) {
  const token = parseCookies(ctx.req.headers.cookie)[COOKIE];
  if (!token || !/^[\w-]{20,100}$/.test(token)) return;
  const id = sha256(token);
  const s = get('SELECT * FROM sessions WHERE id = ?', id);
  if (!s) return;
  const t = Date.now();
  const idleMs = s.remember ? config.session.rememberDays * 86400000 : config.session.idleMin * 60000;
  if (Date.parse(s.expires_at) <= t || Date.parse(s.last_seen_at) + idleMs <= t) { run('DELETE FROM sessions WHERE id = ?', id); return; }
  const user = loadUser(s.user_id);
  if (!user || !user.is_active) { run('DELETE FROM sessions WHERE id = ?', id); return; }
  if (t - Date.parse(s.last_seen_at) > 60000) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date(t).toISOString(), id);
  ctx.session = s;
  if (s.mfa_pending) { ctx.mfaUser = user; return; }
  ctx.user = user;
  ctx.perms = permsForRole({ id: user.role_id, key: user.role_key });
}

// Requests that change state must originate from our own pages.
function checkOrigin(ctx) {
  const origin = ctx.req.headers.origin;
  if (!origin) return;
  let host = '';
  try { host = new URL(origin).host; } catch { throw err(403, 'Mənbə qəbul edilmir'); }
  const allowed = origin === new URL(config.baseUrl).origin || host === ctx.req.headers.host;
  if (!allowed) throw err(403, 'Mənbə qəbul edilmir');
}
function checkCsrf(ctx) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) return;
  checkOrigin(ctx);
  if (!ctx.session || !safeEqual(ctx.req.headers['x-csrf-token'], ctx.session.csrf)) throw err(403, 'Təhlükəsizlik nişanı (CSRF) yanlışdır. Səhifəni yeniləyin.', { code: 'csrf' });
}

function requireAuth(ctx) {
  if (!ctx.user) throw err(401, 'Giriş tələb olunur');
  checkCsrf(ctx);
  const rl = rateLimit('api', ctx.session.id, 600, 60);
  if (!rl.ok) throw err(429, 'Çox sayda sorğu. Bir az sonra yenidən cəhd edin.', { headers: { 'Retry-After': String(rl.retryAfter) } });
  if (ctx.user.must_change_password && !ctx.path.startsWith('/api/auth/')) throw err(403, 'Davam etmək üçün şifrənizi dəyişin', { code: 'password_change_required' });
}
// can('news.edit') or can('news.view', 'news.edit') - any of the listed permissions is enough.
const can = (...perms) => (ctx) => {
  requireAuth(ctx);
  if (!perms.some((p) => ctx.perms.has(p))) throw err(403, 'Bu əməliyyat üçün icazəniz yoxdur');
};
const superOnly = (ctx) => {
  requireAuth(ctx);
  if (ctx.user.role_key !== 'super_admin') throw err(403, 'Bu bölmə yalnız Super Admin üçündür');
};
const cleanupSessions = () => {
  run('DELETE FROM sessions WHERE expires_at <= ?', now());
  run('DELETE FROM password_resets WHERE expires_at <= ?', now());
};

module.exports = { sessionMiddleware, requireAuth, can, superOnly, checkOrigin, checkCsrf, createSession, destroySession, destroyUserSessions, loadUser, cleanupSessions, COOKIE };
