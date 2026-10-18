'use strict';
// Central configuration. Everything lives inside this one project folder:
//   site/   the website        admin/  the panel        data/  database, uploads, backups
//   .env    optional settings (only needed on the live server: BASE_URL, SMTP, ...)
// No setting points outside the project.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

const bool = (v, d) => (v === undefined || v === '' ? d : v === '1' || v === 'true');
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const port = int(env.PORT, 8080);
// The address people use to open the site; used for links in e-mails. Locally: http://localhost:PORT.
const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const dataDir = path.join(ROOT, 'data');

const config = {
  env: env.NODE_ENV || 'production',
  port,
  host: env.HOST || '127.0.0.1',            // 0.0.0.0 = reachable from other computers
  rootDir: ROOT,
  baseUrl,
  // Canonical address written into the website's own SEO tags (canonical, hreflang, sitemap).
  // It is the domain the existing pages already carry; it is metadata, not a link anybody follows.
  siteUrl: 'https://aeec.az',
  siteOrigins: list(env.SITE_ORIGINS),
  dataDir,
  siteDir: path.join(ROOT, 'site'),          // the website - part of this project
  dbFile: path.join(dataDir, 'aeec.sqlite'),
  uploadDir: path.join(dataDir, 'uploads'),   // public media
  privateDir: path.join(dataDir, 'private'),  // documents + request attachments (served only through auth checks)
  backupDir: path.join(dataDir, 'backups'),
  cookieSecure: bool(env.COOKIE_SECURE, baseUrl.startsWith('https://')),
  trustProxy: bool(env.TRUST_PROXY, false),   // behind a reverse proxy (Apache/Cloudflare): read the visitor's IP from X-Real-IP
  tzOffsetMin: int(env.TZ_OFFSET_MIN, 240),   // Asia/Baku = UTC+4, no DST
  maxUploadMb: int(env.MAX_UPLOAD_MB, 20),
  maxRequestFileMb: int(env.MAX_REQUEST_FILE_MB, 10),
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, false),     // true = implicit TLS (465); false = STARTTLS (587)
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'AEEC Sayt <noreply@aeec.az>',
    allowInsecure: bool(env.SMTP_ALLOW_INSECURE, false), // only for local testing without TLS
  },
  sendmailPath: env.SENDMAIL_PATH || '',     // optional: the server's own mail program instead of SMTP
  session: {
    idleMin: int(env.SESSION_IDLE_MIN, 30),
    absoluteHours: int(env.SESSION_ABSOLUTE_HOURS, 12),
    rememberDays: int(env.SESSION_REMEMBER_DAYS, 14),
  },
  login: { maxFails: int(env.LOGIN_MAX_FAILS, 5), lockMin: int(env.LOGIN_LOCK_MIN, 15) },
  passwordMinLength: int(env.PASSWORD_MIN_LENGTH, 12),
  geoHeaders: { country: (env.GEO_COUNTRY_HEADER || '').toLowerCase(), city: (env.GEO_CITY_HEADER || '').toLowerCase() },
};

for (const d of [config.dataDir, config.uploadDir, config.privateDir, config.backupDir]) fs.mkdirSync(d, { recursive: true, mode: 0o750 });

// Server secret (HMAC key for visitor hashes etc.). Generated once and kept next to the database.
const secretFile = path.join(dataDir, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
config.secret = fs.readFileSync(secretFile, 'utf8').trim();

module.exports = config;
