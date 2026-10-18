'use strict';
// SQLite access layer (built-in node:sqlite). Every query is a prepared statement with bound
// parameters - user input is never concatenated into SQL.
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    if (cache.size > 800) cache.clear();
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}
const get = (sql, ...p) => stmt(sql).get(...p);
const all = (sql, ...p) => stmt(sql).all(...p);
const run = (sql, ...p) => stmt(sql).run(...p);
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn(); // nested call joins the outer transaction
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}
const now = () => new Date().toISOString();
// Local calendar day (YYYY-MM-DD) for a timestamp, using the configured fixed UTC offset.
const dayOf = (d) => new Date((d ? new Date(d).getTime() : Date.now()) + config.tzOffsetMin * 60000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ schema */
const MIGRATIONS = [
  /* v1 */ `
CREATE TABLE roles (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE permissions (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, module TEXT NOT NULL, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id));
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id),
  is_active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  last_login_at TEXT, password_changed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, remember INTEGER NOT NULL DEFAULT 0, mfa_pending INTEGER NOT NULL DEFAULT 0,
  ip TEXT, user_agent TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);

CREATE TABLE media (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('image','video','file')),
  original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, ext TEXT NOT NULL,
  size INTEGER NOT NULL, folder TEXT NOT NULL DEFAULT '', alt TEXT NOT NULL DEFAULT '',
  is_private INTEGER NOT NULL DEFAULT 0, uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL);
CREATE INDEX idx_media_lib ON media(is_private, created_at);

CREATE TABLE news (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', cover_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  gallery TEXT NOT NULL DEFAULT '[]', category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  author_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  is_featured INTEGER NOT NULL DEFAULT 0, published_at TEXT, seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '', i18n TEXT NOT NULL DEFAULT '{}', views INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_news_status ON news(status, published_at);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', sector TEXT NOT NULL DEFAULT '', project_type TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', start_date TEXT, end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ongoing','completed','archived')),
  is_active INTEGER NOT NULL DEFAULT 1, main_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  gallery TEXT NOT NULL DEFAULT '[]', documents TEXT NOT NULL DEFAULT '[]', stats TEXT NOT NULL DEFAULT '[]',
  seo_title TEXT NOT NULL DEFAULT '', seo_description TEXT NOT NULL DEFAULT '', i18n TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_projects_status ON projects(status, is_active);

CREATE TABLE services (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, short_description TEXT NOT NULL DEFAULT '',
  full_description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '',
  image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL, features TEXT NOT NULL DEFAULT '[]',
  seo_title TEXT NOT NULL DEFAULT '', seo_description TEXT NOT NULL DEFAULT '', i18n TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE team_members (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, position TEXT NOT NULL DEFAULT '',
  photo_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL, biography TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', linkedin TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, i18n TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  file_media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('public','internal')),
  i18n TEXT NOT NULL DEFAULT '{}', downloads INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE project_requests (
  id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', consent INTEGER NOT NULL DEFAULT 0, consent_at TEXT,
  lang TEXT NOT NULL DEFAULT 'az', source_page TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','discussion','proposal','won','lost','archived')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL, follow_up_date TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_preq_status ON project_requests(status, created_at);
CREATE TABLE project_request_files (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE);

CREATE TABLE contact_requests (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0, consent_at TEXT, lang TEXT NOT NULL DEFAULT 'az', source_page TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','replied','closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_creq_status ON contact_requests(status, created_at);

CREATE TABLE request_notes (
  id INTEGER PRIMARY KEY, request_type TEXT NOT NULL CHECK (request_type IN ('project','contact')),
  request_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','status','assign','email','followup')),
  body TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, user_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
CREATE INDEX idx_notes_req ON request_notes(request_type, request_id);

CREATE TABLE analytics_sessions (
  id TEXT PRIMARY KEY, visitor_hash TEXT NOT NULL, day TEXT NOT NULL, started_at TEXT NOT NULL, last_at TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0, pageviews INTEGER NOT NULL DEFAULT 0,
  landing_page TEXT NOT NULL DEFAULT '', exit_page TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'direct', browser TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '', screen TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '', is_returning INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_as_day ON analytics_sessions(day);
CREATE TABLE page_views (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', day TEXT NOT NULL, ts TEXT NOT NULL);
CREATE INDEX idx_pv_day ON page_views(day);
CREATE INDEX idx_pv_session ON page_views(session_id);
CREATE TABLE analytics_salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
  module TEXT NOT NULL, record_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  previous_value TEXT, new_value TEXT, ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
-- The audit log is append-only: the database itself refuses changes and deletions.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER);
CREATE TABLE seo_pages (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, seo_title TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', og_title TEXT NOT NULL DEFAULT '',
  og_description TEXT NOT NULL DEFAULT '', og_image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  canonical TEXT NOT NULL DEFAULT '', in_sitemap INTEGER NOT NULL DEFAULT 1, i18n TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE backups (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL CHECK (kind IN ('auto','manual')),
  status TEXT NOT NULL CHECK (status IN ('ok','failed')), message TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL, reply_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')), attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, sent_at TEXT);
`,
  // 2: news are published as static pages of the website (src/site-news.js).
  `
ALTER TABLE news ADD COLUMN slug_en TEXT NOT NULL DEFAULT '';
ALTER TABLE news ADD COLUMN slug_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE news ADD COLUMN cover_alt TEXT NOT NULL DEFAULT '';
ALTER TABLE news ADD COLUMN site_image TEXT NOT NULL DEFAULT '';
CREATE TABLE site_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, generated_at TEXT NOT NULL);
CREATE TABLE site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
];

function migrate() {
  let v = get('PRAGMA user_version').user_version;
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

module.exports = { db, get, all, run, tx, now, dayOf, migrate };
