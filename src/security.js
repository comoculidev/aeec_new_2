'use strict';
// Cryptographic helpers: password hashing (scrypt), random tokens, TOTP (RFC 6238), rate limiting.
const crypto = require('node:crypto');
const config = require('./config');

/* ---------------------------------------------------------- passwords */
// scrypt parameters follow the OWASP recommendation (N=2^15, r=8, p=3). They are stored inside the
// hash string so they can be raised later without invalidating existing passwords.
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 64 };
function scrypt(password, salt, o) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const o = { N: +parts[1], r: +parts[2], p: +parts[3], keylen: 64 };
  if (!(o.N >= 16384 && o.N <= 1048576 && o.r >= 8 && o.r <= 32 && o.p >= 1 && o.p <= 16)) return false;
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, Buffer.from(parts[4], 'base64'), { ...o, keylen: expected.length });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
// A fixed dummy hash so that logins for unknown e-mails take as long as for known ones.
let dummyHash = null;
async function burnPasswordTime(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password, dummyHash);
}
const COMMON = new Set(['password', '123456789012', 'qwertyuiop12', 'aeecaeecaeec', 'admin1234567', 'azerbaijan123']);
function passwordProblem(pw, user) {
  if (typeof pw !== 'string') return 'Şifrə daxil edin';
  if (pw.length < config.passwordMinLength) return `Şifrə ən azı ${config.passwordMinLength} simvol olmalıdır`;
  if (pw.length > 200) return 'Şifrə çox uzundur';
  const classes = [/[a-zçəğıöşü]/, /[A-ZÇƏĞİÖŞÜ]/, /\d/, /[^\p{L}\d]/u].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Şifrədə böyük hərf, kiçik hərf, rəqəm və simvoldan ən azı üçü olmalıdır';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw)) return 'Bu şifrə çox sadədir';
  if (user && user.email && low.includes(String(user.email).split('@')[0].toLowerCase())) return 'Şifrədə e-poçt ünvanınız olmamalıdır';
  return null;
}

/* ---------------------------------------------------------- tokens */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s, key = config.secret) => crypto.createHmac('sha256', key).update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------------------------------------------------------- TOTP (2FA) */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1000000).padStart(6, '0');
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
// Returns the matched time step (so a code cannot be replayed) or 0 when the code is wrong.
function verifyTotp(secret, code, lastStep = 0, at = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return 0;
  const step = Math.floor(at / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s > lastStep && safeEqual(totpAt(secret, s), c)) return s;
  }
  return 0;
}
const totpUri = (secret, email) =>
  `otpauth://totp/${encodeURIComponent('AEEC Admin')}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent('AEEC Admin')}&algorithm=SHA1&digits=6&period=30`;

/* ---------------------------------------------------------- rate limiting */
// Fixed-window counters kept in memory (one process). Keys include a client IP, which is held only
// in memory for the length of the window and never written to disk.
const buckets = new Map();
function rateLimit(name, key, limit, windowSec) {
  const k = `${name}|${key}`, t = Date.now();
  let b = buckets.get(k);
  if (!b || b.reset <= t) { b = { n: 0, reset: t + windowSec * 1000 }; buckets.set(k, b); }
  b.n++;
  return { ok: b.n <= limit, retryAfter: Math.max(1, Math.ceil((b.reset - t) / 1000)), remaining: Math.max(0, limit - b.n) };
}
const sweep = setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k); }, 60000);
sweep.unref();
const resetRateLimits = () => buckets.clear();
// Removes the counters of one limiter whose key starts with the given text (e.g. after an unlock).
function clearRateLimit(name, keyPrefix) { const p = `${name}|${keyPrefix}`; for (const k of buckets.keys()) if (k.startsWith(p)) buckets.delete(k); }
const peekRateLimit = (name, key) => { const b = buckets.get(`${name}|${key}`); return b && b.reset > Date.now() ? b.n : 0; };

module.exports = {
  hashPassword, verifyPassword, burnPasswordTime, passwordProblem,
  randomToken, sha256, hmac, safeEqual,
  newTotpSecret, verifyTotp, totpAt, totpUri, base32Encode, base32Decode,
  rateLimit, resetRateLimits, clearRateLimit, peekRateLimit,
};
