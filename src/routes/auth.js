'use strict';
// Login, logout, password reset, password change and two-factor (TOTP) endpoints.
const config = require('../config');
const { get, all, run, tx, now } = require('../db');
const { err } = require('../http');
const { v, validate } = require('../validate');
const sec = require('../security');
const { requireAuth, checkOrigin, createSession, destroySession, destroyUserSessions } = require('../auth');
const { audit } = require('../audit');
const { queueMail, isConfigured } = require('../mail');
const { systemAlert } = require('../notify');

const LOGIN_FAIL = `E-poçt və ya şifrə yanlışdır. ${config.login.maxFails} uğursuz cəhddən sonra giriş ${config.login.lockMin} dəqiqəlik bloklanır.`;
// Brute-force protection works on two levels:
//  1. the same address failing `maxFails` times for one account is refused for `lockMin` minutes
//     (kept in memory) - a single attacker cannot lock the real owner out;
//  2. `maxFails * 4` failures for one account from any addresses lock the account itself.
const ACCOUNT_FAILS = config.login.maxFails * 4;
const pairKey = (email, ip) => `${email}|${ip}`;
const pairBlocked = (email, ip) => sec.peekRateLimit('login-pair', pairKey(email, ip)) >= config.login.maxFails;
// Registers one failed attempt. `u` is the user row when the account exists.
function loginFailed(ctx, email, u) {
  const pr = sec.rateLimit('login-pair', pairKey(email, ctx.ip), config.login.maxFails, config.login.lockMin * 60);
  if (pr.ok && pr.remaining === 0) audit(ctx, { action: 'Giriş bloklandı', module: 'Auth', recordId: u ? u.id : '', summary: `${config.login.maxFails} uğursuz cəhd — ${email} üçün bu ünvandan giriş ${config.login.lockMin} dəqiqəlik bloklandı`, userName: '—' });
  if (!u) return;
  const fails = u.failed_logins + 1;
  if (fails >= ACCOUNT_FAILS) {
    run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', new Date(Date.now() + config.login.lockMin * 60000).toISOString(), u.id);
    audit(ctx, { action: 'Hesab bloklandı', module: 'Auth', recordId: u.id, summary: `${fails} uğursuz giriş cəhdi — ${u.email} hesabı ${config.login.lockMin} dəqiqəlik bloklandı`, userName: '—' });
    systemAlert('Sistem xəbərdarlığı', `${fails} uğursuz giriş cəhdi — ${u.email} hesabı ${config.login.lockMin} dəqiqəlik bloklandı`, '#/audit');
  } else run('UPDATE users SET failed_logins = ? WHERE id = ?', fails, u.id);
}
const limited = (name, key, limit, win) => {
  const r = sec.rateLimit(name, key, limit, win);
  if (!r.ok) throw err(429, 'Çox sayda cəhd. Bir az sonra yenidən yoxlayın.', { headers: { 'Retry-After': String(r.retryAfter) } });
};
const me = (ctx) => ({
  user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role_name, role_key: ctx.user.role_key,
    must_change_password: !!ctx.user.must_change_password, totp_enabled: !!ctx.user.totp_enabled, last_login_at: ctx.user.last_login_at },
  permissions: [...ctx.perms], csrf: ctx.session.csrf,
  config: { password_min: config.passwordMinLength, max_upload_mb: config.maxUploadMb, smtp: isConfigured(), site_url: config.siteUrl },
});

module.exports = (app) => {
  app.post('/api/auth/login', async (ctx) => {
    checkOrigin(ctx);
    limited('login-ip', ctx.ip, 20, 15 * 60);
    const b = validate({ email: v.email({ required: true }), password: v.str({ required: true, max: 200 }), remember: v.bool() }, await ctx.readJson(4096));
    const u = get('SELECT * FROM users WHERE email = ?', b.email);
    const refused = pairBlocked(b.email, ctx.ip) || !u || !u.is_active || (u.locked_until && Date.parse(u.locked_until) > Date.now());
    if (refused) {
      // Same time and same answer whether the account exists, is locked, or the address is blocked.
      await sec.burnPasswordTime(b.password);
      if (!pairBlocked(b.email, ctx.ip)) loginFailed(ctx, b.email, null);
      throw err(401, LOGIN_FAIL);
    }
    if (!(await sec.verifyPassword(b.password, u.password_hash))) { loginFailed(ctx, b.email, u); throw err(401, LOGIN_FAIL); }
    sec.clearRateLimit('login-pair', pairKey(b.email, ctx.ip));
    destroySession(ctx); // never reuse a pre-login session id
    run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', u.id);
    if (u.totp_enabled) {
      createSession(ctx, u, { remember: !!b.remember, mfaPending: true });
      return ctx.json({ mfa_required: true });
    }
    createSession(ctx, u, { remember: !!b.remember });
    run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), u.id);
    audit(ctx, { action: 'Giriş', module: 'Auth', recordId: u.id, summary: `${u.name} sistemə daxil oldu`, user: u });
    ctx.json({ ok: true });
  });

  app.post('/api/auth/mfa', async (ctx) => {
    checkOrigin(ctx);
    if (!ctx.session || !ctx.session.mfa_pending || !ctx.mfaUser) throw err(401, 'Əvvəlcə e-poçt və şifrə ilə daxil olun');
    const r = sec.rateLimit('mfa', ctx.session.id, 5, 300);
    if (!r.ok) { destroySession(ctx); throw err(429, 'Çox sayda yanlış kod. Yenidən daxil olun.'); }
    const b = validate({ code: v.str({ required: true, max: 12 }) }, await ctx.readJson(1024));
    const u = get('SELECT * FROM users WHERE id = ?', ctx.mfaUser.id);
    const step = sec.verifyTotp(u.totp_secret, b.code, u.totp_last_step);
    if (!step) { loginFailed(ctx, u.email, u); throw err(401, 'Kod yanlışdır və ya vaxtı keçib'); }
    const remember = !!ctx.session.remember;
    destroySession(ctx);
    createSession(ctx, u, { remember });
    run('UPDATE users SET totp_last_step = ?, last_login_at = ? WHERE id = ?', step, now(), u.id);
    audit(ctx, { action: 'Giriş (2FA)', module: 'Auth', recordId: u.id, summary: `${u.name} ikimərhələli təsdiqlə daxil oldu`, user: u });
    ctx.json({ ok: true });
  });

  app.post('/api/auth/logout', requireAuth, (ctx) => {
    audit(ctx, { action: 'Çıxış', module: 'Auth', recordId: ctx.user.id, summary: `${ctx.user.name} sistemdən çıxdı` });
    destroySession(ctx);
    ctx.json({ ok: true });
  });
  app.post('/api/auth/logout-others', requireAuth, (ctx) => {
    const n = destroyUserSessions(ctx.user.id, ctx.session.id).changes;
    audit(ctx, { action: 'Digər sessiyaların bağlanması', module: 'Auth', recordId: ctx.user.id, summary: `${n} sessiya bağlandı` });
    ctx.json({ ok: true, closed: n });
  });
  app.get('/api/auth/me', requireAuth, (ctx) => ctx.json(me(ctx)));

  app.post('/api/auth/forgot', async (ctx) => {
    checkOrigin(ctx);
    limited('forgot-ip', ctx.ip, 5, 60 * 60);
    const b = validate({ email: v.email({ required: true }) }, await ctx.readJson(1024));
    const u = get('SELECT id, email, name, is_active FROM users WHERE email = ?', b.email);
    if (u && u.is_active && sec.rateLimit('forgot-user', u.id, 3, 60 * 60).ok) {
      const token = sec.randomToken(32);
      tx(() => {
        run('DELETE FROM password_resets WHERE user_id = ?', u.id);
        run('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)', sec.sha256(token), u.id, new Date(Date.now() + 30 * 60000).toISOString(), now());
      });
      const link = `${config.baseUrl}/admin/login#/reset/${token}`;
      if (isConfigured()) {
        queueMail({ to: u.email, subject: 'AEEC Admin — şifrənin bərpası', text: `Salam, ${u.name}.\n\nŞifrənizi yeniləmək üçün aşağıdakı keçidi açın (30 dəqiqə etibarlıdır, bir dəfə istifadə olunur):\n\n${link}\n\nƏgər bu sorğunu siz göndərməmisinizsə, bu məktuba əhəmiyyət verməyin.` });
      } else console.warn(`[auth] SMTP qurulmayıb — ${u.email} üçün bərpa keçidi e-poçtla göndərilmədi. Şifrəni serverdə "npm run create-admin" ilə yeniləyə bilərsiniz.`);
      audit(ctx, { action: 'Şifrə bərpası sorğusu', module: 'Auth', recordId: u.id, summary: `${u.email} üçün bərpa keçidi yaradıldı`, user: u });
    }
    // Same answer whether or not the address exists.
    ctx.json({ ok: true, message: 'Əgər bu ünvan sistemdə varsa, bərpa keçidi e-poçtla göndərildi.' });
  });

  app.post('/api/auth/reset', async (ctx) => {
    checkOrigin(ctx);
    limited('reset-ip', ctx.ip, 10, 60 * 60);
    const b = validate({ token: v.str({ required: true, max: 100 }), password: v.str({ required: true, max: 200 }) }, await ctx.readJson(2048));
    const row = get('SELECT * FROM password_resets WHERE token_hash = ?', sec.sha256(b.token));
    if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) throw err(400, 'Keçid etibarsızdır və ya vaxtı bitib. Yenidən sorğu göndərin.');
    const u = get('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!u || !u.is_active) throw err(400, 'Keçid etibarsızdır');
    const problem = sec.passwordProblem(b.password, u);
    if (problem) throw err(422, problem, { fields: { password: problem } });
    const hash = await sec.hashPassword(b.password);
    tx(() => {
      run('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', hash, now(), now(), u.id);
      run('DELETE FROM password_resets WHERE user_id = ?', u.id);
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
    });
    audit(ctx, { action: 'Şifrə bərpa olundu', module: 'Auth', recordId: u.id, summary: `${u.email} şifrəsini bərpa keçidi ilə yenilədi`, user: u });
    ctx.json({ ok: true });
  });

  app.post('/api/auth/password', requireAuth, async (ctx) => {
    limited('pw-change', ctx.user.id, 10, 60 * 60);
    const b = validate({ current: v.str({ required: true, max: 200 }), password: v.str({ required: true, max: 200 }) }, await ctx.readJson(2048));
    const u = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!(await sec.verifyPassword(b.current, u.password_hash))) throw err(422, 'Cari şifrə yanlışdır', { fields: { current: 'Cari şifrə yanlışdır' } });
    const problem = b.current === b.password ? 'Yeni şifrə köhnə ilə eyni ola bilməz' : sec.passwordProblem(b.password, u);
    if (problem) throw err(422, problem, { fields: { password: problem } });
    const hash = await sec.hashPassword(b.password);
    tx(() => {
      run('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?', hash, now(), now(), u.id);
      destroyUserSessions(u.id, ctx.session.id);
    });
    audit(ctx, { action: 'Şifrə dəyişdirildi', module: 'Auth', recordId: u.id, summary: `${u.name} öz şifrəsini dəyişdi` });
    // The temporary first-login password is no longer valid: remove the note that held it.
    if (u.must_change_password) { try { require('node:fs').rmSync(require('node:path').join(config.dataDir, 'ilk-giris.txt'), { force: true }); } catch { /* ignore */ } }
    ctx.json({ ok: true });
  });

  /* ------------------------------------------------ two-factor authentication */
  const confirmPassword = async (ctx, password) => {
    limited('pw-confirm', ctx.user.id, 10, 15 * 60);
    const u = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!(await sec.verifyPassword(String(password || ''), u.password_hash))) throw err(422, 'Şifrə yanlışdır', { fields: { password: 'Şifrə yanlışdır' } });
    return u;
  };
  app.post('/api/auth/2fa/setup', requireAuth, async (ctx) => {
    const b = await ctx.readJson(1024);
    const u = await confirmPassword(ctx, b.password);
    if (u.totp_enabled) throw err(409, 'İkimərhələli təsdiq artıq aktivdir');
    const secret = sec.newTotpSecret();
    run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', secret, u.id);
    ctx.json({ secret, uri: sec.totpUri(secret, u.email) });
  });
  app.post('/api/auth/2fa/enable', requireAuth, async (ctx) => {
    limited('2fa-enable', ctx.user.id, 10, 15 * 60);
    const b = validate({ code: v.str({ required: true, max: 12 }) }, await ctx.readJson(1024));
    const u = get('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!u.totp_secret || u.totp_enabled) throw err(409, 'Əvvəlcə quraşdırmanı başladın');
    const step = sec.verifyTotp(u.totp_secret, b.code, 0);
    if (!step) throw err(422, 'Kod yanlışdır', { fields: { code: 'Kod yanlışdır və ya vaxtı keçib' } });
    run('UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?', step, now(), u.id);
    destroyUserSessions(u.id, ctx.session.id);
    audit(ctx, { action: '2FA aktivləşdirildi', module: 'Auth', recordId: u.id, summary: `${u.name} ikimərhələli təsdiqi aktiv etdi` });
    ctx.json({ ok: true });
  });
  app.post('/api/auth/2fa/disable', requireAuth, async (ctx) => {
    const b = await ctx.readJson(1024);
    const u = await confirmPassword(ctx, b.password);
    run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?', now(), u.id);
    audit(ctx, { action: '2FA söndürüldü', module: 'Auth', recordId: u.id, summary: `${u.name} ikimərhələli təsdiqi söndürdü` });
    ctx.json({ ok: true });
  });
  app.get('/api/auth/sessions', requireAuth, (ctx) => {
    ctx.json({ items: all('SELECT id, ip, user_agent, created_at, last_seen_at, remember FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY last_seen_at DESC', ctx.user.id)
      .map((s) => ({ current: s.id === ctx.session.id, ip: s.ip, user_agent: s.user_agent, created_at: s.created_at, last_seen_at: s.last_seen_at, remember: !!s.remember })) });
  });
};
