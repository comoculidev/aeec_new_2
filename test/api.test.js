'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { boot, Client, PNG, PDF, fileForm, sleep, mails } = require('./helpers');

const ADMIN = ['office@aeec.az', 'Sinaq-Parol-2026!'];
const NEWPW = 'Yeni-Guclu-Parol-77!';
let T, admin, sec, db;
const waitMail = async () => { for (let i = 0; i < 40 && !mails.length; i++) await sleep(50); };

test.before(async () => {
  T = await boot();
  sec = T.req('src/security');
  db = T.req('src/db');
});
test.after(() => { T.stop(); setTimeout(() => process.exit(0), 200).unref(); });

test('security headers and unauthenticated access', async () => {
  const c = new Client(T.base);
  const r = await c.get('/api/auth/me');
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const u of ['/api/news', '/api/leads', '/api/users', '/api/audit', '/api/dashboard', '/api/media', '/api/backups', '/api/settings', '/api/documents/1/download', '/api/leads/1/files/1'])
    assert.equal((await c.get(u)).status, 401, u);
  assert.equal((await c.get('/admin/assets/..%2f..%2fserver.js')).status, 400);
  assert.equal((await c.get('/media/..%2f..%2fetc%2fpasswd')).status, 400);
  assert.equal((await c.get('/media/0123456789abcdef0123456789abcdef.png')).status, 404);
  const shell = await c.get('/admin/login');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /script-src 'self'/);
});

test('login: wrong password, forced password change, CSRF', async () => {
  const c = new Client(T.base, '10.0.0.2');
  assert.equal((await c.login(ADMIN[0], 'yanlis-parol')).status, 401);
  assert.equal((await c.login('yox@aeec.az', 'yanlis-parol')).status, 401);
  assert.equal((await c.req('POST', '/api/auth/login', { raw: 'email=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await c.post('/api/auth/login', { email: ADMIN[0], password: ADMIN[1] }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  admin = new Client(T.base, '10.0.0.3');
  const r = await admin.login(...ADMIN);
  assert.equal(r.status, 200);
  assert.match(admin.lastSetCookie, /HttpOnly; SameSite=Strict/);
  assert.equal(admin.me.user.must_change_password, true);
  assert.equal(admin.me.user.role_key, 'super_admin');
  // Until the password is changed nothing else is reachable.
  const blocked = await admin.get('/api/news');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'password_change_required');
  // CSRF: a state-changing request without the token is refused.
  const csrf = admin.csrf; admin.csrf = '';
  assert.equal((await admin.post('/api/auth/password', { current: ADMIN[1], password: NEWPW })).status, 403);
  admin.csrf = 'wrong-token';
  assert.equal((await admin.post('/api/auth/password', { current: ADMIN[1], password: NEWPW })).status, 403);
  admin.csrf = csrf;
  assert.equal((await admin.post('/api/auth/password', { current: ADMIN[1], password: 'qisa' })).status, 422);
  assert.equal((await admin.post('/api/auth/password', { current: 'səhv', password: NEWPW })).status, 422);
  assert.equal((await admin.post('/api/auth/password', { current: ADMIN[1], password: NEWPW })).status, 200);
  assert.equal((await admin.get('/api/news')).status, 200);
  // The stored hash is scrypt, never the password itself.
  const row = db.get('SELECT password_hash FROM users WHERE email = ?', ADMIN[0]);
  assert.match(row.password_hash, /^scrypt\$32768\$8\$3\$/);
  assert.ok(!row.password_hash.includes(NEWPW));
});

test('brute-force protection: per-address block, account lock, audit entries', async () => {
  const mk = await admin.post('/api/users', { name: 'Kilid Test', email: 'kilid@aeec.az', role_id: 4, password: 'Qapali-Parol-2026!', is_active: true });
  assert.equal(mk.status, 201, JSON.stringify(mk.data));
  const c = new Client(T.base, '10.0.9.9');
  for (let i = 0; i < 5; i++) assert.equal((await c.login('kilid@aeec.az', 'səhv-parol-' + i)).status, 401);
  // After five failures this address is refused even with the correct password …
  assert.equal((await c.login('kilid@aeec.az', 'Qapali-Parol-2026!')).status, 401);
  // … but the real owner, coming from another address, is not locked out by the attacker.
  assert.equal((await new Client(T.base, '10.0.9.10').login('kilid@aeec.az', 'Qapali-Parol-2026!')).status, 200);
  assert.ok((await admin.get('/api/audit?q=' + encodeURIComponent('Giriş bloklandı'))).data.items.some((x) => x.action === 'Giriş bloklandı'));
  // Unknown accounts behave exactly the same way.
  const g = new Client(T.base, '10.0.9.12');
  for (let i = 0; i < 6; i++) assert.equal((await g.login('yoxdur@aeec.az', 'x' + i)).status, 401);
  // Twenty failures from several addresses lock the account itself.
  for (let ip = 20; ip < 24; ip++) { const x = new Client(T.base, '10.0.8.' + ip); for (let i = 0; i < 5; i++) await x.login('kilid@aeec.az', 'səhv-' + i); }
  const u = db.get('SELECT locked_until FROM users WHERE email = ?', 'kilid@aeec.az');
  assert.ok(u.locked_until && Date.parse(u.locked_until) > Date.now());
  assert.equal((await new Client(T.base, '10.0.9.30').login('kilid@aeec.az', 'Qapali-Parol-2026!')).status, 401);
  assert.ok((await admin.get('/api/audit?q=' + encodeURIComponent('Hesab bloklandı'))).data.items.length >= 1);
  const users = await admin.get('/api/users?q=kilid');
  assert.equal(users.data.items[0].locked, true);
  assert.equal((await admin.post(`/api/users/${users.data.items[0].id}/unlock`)).status, 200);
  assert.equal((await c.login('kilid@aeec.az', 'Qapali-Parol-2026!')).status, 200); // unlock also clears the per-address block
  // Address rate limit: the 21st attempt from one address within the window is rejected outright.
  const c3 = new Client(T.base, '10.0.9.11');
  let last;
  for (let i = 0; i < 21; i++) last = await c3.login('nobody' + i + '@aeec.az', 'x');
  assert.equal(last.status, 429);
});

test('news CRUD, slug, validation, search, export, audit', async () => {
  const bad = await admin.post('/api/news', { title: '', status: 'nope' });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.error.fields.title && bad.data.error.fields.status);
  const a = await admin.post('/api/news', { title: 'Şəki şəhərində yeni yarımstansiya İŞİ', excerpt: 'Qısa', content: '## Başlıq\n\n<script>alert(1)</script> **qalın**', category: 'Layihələr', tags: ['enerji', 'sınaq'], status: 'draft',
    i18n: { en: { title: 'New substation works in Sheki' }, ru: {} } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const n = a.data.item;
  assert.equal(n.slug, 'seki-seherinde-yeni-yarimstansiya-isi');
  assert.equal(n.author_name, 'Tayfun Hacılı');
  assert.equal(n.published_at, null);
  assert.deepEqual(n.i18n, { en: { title: 'New substation works in Sheki' } });
  const dup = await admin.post('/api/news', { title: 'Şəki şəhərində yeni yarımstansiya işi' });
  assert.equal(dup.data.item.slug, 'seki-seherinde-yeni-yarimstansiya-isi-2');
  // Case-insensitive search with Azerbaijani letters.
  assert.equal((await admin.get('/api/news?q=' + encodeURIComponent('ŞƏKİ'))).data.total, 2);
  assert.equal((await admin.get('/api/news?q=' + encodeURIComponent('seki seherinde'))).data.total, 2); // typed without diacritics
  assert.equal((await admin.get('/api/news?status=draft&category=' + encodeURIComponent('Layihələr'))).data.total, 1);
  assert.equal((await admin.get('/api/news?status=xxx')).status, 422);
  // SQL injection attempts are treated as plain text.
  assert.equal((await admin.get('/api/news?q=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
  assert.equal((await admin.get('/api/news?sort=' + encodeURIComponent('title; DROP TABLE news'))).status, 200);
  // 4 = the news items imported from the existing website pages on first start.
  assert.equal((await admin.get('/api/news')).data.total, 6);
  // Publishing sets the date and is visible publicly; drafts are not.
  const pubc = new Client(T.base, '10.1.0.1');
  assert.equal((await pubc.get('/api/public/news')).data.total, 4);
  const p = await admin.patch(`/api/news/${n.id}`, { status: 'published', is_featured: true });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.ok(p.data.item.published_at);
  const list = await pubc.get('/api/public/news');
  assert.equal(list.data.total, 5);
  assert.equal((await pubc.get('/api/public/news?lang=en')).data.items[0].title, 'New substation works in Sheki');
  const one = await pubc.get('/api/public/news/' + n.slug);
  assert.match(one.data.item.content_html, /<h2>Başlıq<\/h2>/);
  assert.ok(!one.data.item.content_html.includes('<script>'));
  assert.match(one.data.item.content_html, /&lt;script&gt;/);
  assert.equal((await pubc.get('/api/public/news/' + dup.data.item.slug)).status, 404);
  const csv = await admin.get('/api/news/export?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data.toString('utf8'), /Şəki şəhərində/);
  const xl = await admin.get('/api/news/export?format=xlsx');
  assert.equal(xl.data.subarray(0, 2).toString(), 'PK');
  const log = await admin.get('/api/audit?module=' + encodeURIComponent('Xəbərlər'));
  assert.ok(log.data.items.some((x) => x.action === 'Dərc etmə' && /published/.test(x.new_value)));
  assert.ok(log.data.items.some((x) => x.action === 'Yaratma'));
  assert.equal((await admin.del(`/api/news/${dup.data.item.id}`)).status, 200);
  assert.equal((await admin.get(`/api/news/${dup.data.item.id}`)).status, 404);
});

test('roles: editor, viewer, administrator boundaries', async () => {
  const mk = async (name, email, role_id) => { const r = await admin.post('/api/users', { name, email, role_id, password: 'Rol-Sinaq-Parol-1!', is_active: true }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.item; };
  const roles = (await admin.get('/api/roles')).data.roles;
  const rid = Object.fromEntries(roles.map((r) => [r.key, r.id]));
  await mk('Redaktor', 'editor@aeec.az', rid.editor); await mk('Baxış', 'viewer@aeec.az', rid.viewer); const adm = await mk('Admin', 'admin2@aeec.az', rid.administrator);
  const login = async (email, ip) => { const c = new Client(T.base, ip); await c.login(email, 'Rol-Sinaq-Parol-1!'); assert.equal((await c.post('/api/auth/password', { current: 'Rol-Sinaq-Parol-1!', password: 'Rol-Sinaq-Parol-2!' })).status, 200); return c; };
  const ed = await login('editor@aeec.az', '10.2.0.1'), vw = await login('viewer@aeec.az', '10.2.0.2'), ad = await login('admin2@aeec.az', '10.2.0.3');
  // Editor: content yes; requests read-only; users, settings, audit, backups no.
  assert.equal((await ed.post('/api/news', { title: 'Redaktor xəbəri' })).status, 201);
  assert.equal((await ed.get('/api/leads')).status, 200);
  assert.equal((await ed.get('/api/leads/export?format=csv')).status, 403);
  assert.equal((await ed.get('/api/users')).status, 403);
  assert.equal((await ed.put('/api/settings/contact', { phone: '+994 12 000 00 00' })).status, 403);
  const coBefore = (await ed.get('/api/company')).data.company;
  assert.equal((await ed.put('/api/settings/company', { ...coBefore, about: 'Şirkət haqqında mətn' })).status, 200);
  assert.equal((await ed.get('/api/audit')).status, 403);
  assert.equal((await ed.get('/api/backups')).status, 403);
  // Viewer: read only.
  assert.equal((await vw.get('/api/news')).status, 200);
  assert.equal((await vw.post('/api/news', { title: 'x' })).status, 403);
  assert.equal((await vw.del('/api/news/1')).status, 403);
  assert.equal((await vw.get('/api/dashboard')).status, 200);
  assert.equal((await vw.get('/api/settings')).status, 403);
  // Administrator: settings yes, audit / backups / role editing / user management no.
  assert.equal((await ad.put('/api/settings/contact', { address: 'Xırdalan şəhəri, Həsən Əliyev küçəsi', phone: '+994 50 362 30 38', email: 'office@aeec.az' })).status, 200);
  assert.equal((await ad.get('/api/audit')).status, 403);
  assert.equal((await ad.get('/api/backups')).status, 403);
  assert.equal((await ad.post('/api/backups')).status, 403);
  assert.equal((await ad.put(`/api/roles/${rid.editor}/permissions`, { permissions: ['audit.view'] })).status, 403);
  assert.equal((await ad.post('/api/users', { name: 'X', email: 'x@aeec.az', role_id: rid.viewer, password: 'Rol-Sinaq-Parol-1!' })).status, 403);
  // Super-only permissions can never be granted to another role, even by a Super Admin.
  const g = await admin.put(`/api/roles/${rid.editor}/permissions`, { permissions: ['news.view', 'audit.view', 'backup.manage', 'users.manage', 'yox.icaze'] });
  assert.deepEqual(g.data.permissions.sort(), ['news.view', 'users.manage']);
  assert.equal((await admin.put(`/api/roles/${rid.super_admin}/permissions`, { permissions: [] })).status, 422);
  // A non-super user with users.manage cannot touch or create Super Admins.
  const ed2 = new Client(T.base, '10.2.0.4'); await ed2.login('editor@aeec.az', 'Rol-Sinaq-Parol-2!');
  assert.equal((await ed2.post('/api/users', { name: 'Y', email: 'y@aeec.az', role_id: rid.super_admin, password: 'Rol-Sinaq-Parol-1!' })).status, 403);
  assert.equal((await ed2.post(`/api/users/${admin.me.user.id}/reset-password`, { password: 'Hücum-Parol-2026!' })).status, 403);
  assert.equal((await ed2.post('/api/news', { title: 'x' })).status, 403);
  // Self-protection and last Super Admin.
  assert.equal((await admin.del(`/api/users/${admin.me.user.id}`)).status, 422);
  assert.equal((await admin.put(`/api/users/${admin.me.user.id}`, { name: 'T', email: ADMIN[0], role_id: rid.viewer, is_active: true })).status, 422);
  // Deactivating a user ends their sessions immediately.
  assert.equal((await admin.put(`/api/users/${adm.id}`, { name: 'Admin', email: 'admin2@aeec.az', role_id: rid.administrator, is_active: false })).status, 200);
  assert.equal((await ad.get('/api/news')).status, 401);
});

test('uploads: type checks, private documents, media library', async () => {
  const up = (name, buf, type) => admin.req('POST', '/api/media', { form: fileForm({ folder: 'Sınaq' }, [['file', name, buf, type]]) });
  const ok = await up('şəkil 1.png', PNG, 'image/png');
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const m = ok.data.item;
  assert.match(m.url, /^\/media\/[a-f0-9]{32}\.png$/);
  const pubc = new Client(T.base, '10.3.0.1');
  const img = await pubc.get(m.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await up('virus.exe', Buffer.from('MZ....'), 'application/octet-stream')).status, 422);
  assert.equal((await up('shell.php', Buffer.from('<?php echo 1;'), 'image/png')).status, 422);
  assert.equal((await up('saxta.png', Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).status, 422);
  assert.equal((await up('pis.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 422);
  assert.equal((await up('yaxsi.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>'), 'image/svg+xml')).status, 201);
  assert.equal((await up('double.png.html', PNG, 'image/png')).status, 422);
  for (const bad of ['<svg/onload=alert(1)>', '<svg a="1"onload=alert(1)>', '<svg><a xlink:href="&#106;avascript:alert(1)"><text>x</text></a></svg>', '<svg><use href="data:image/svg+xml;base64,AAAA"/></svg>', '<svg><style>@import url(https://x.example/a.css)</style></svg>'])
    assert.equal((await up('pis2.svg', Buffer.from(bad), 'image/svg+xml')).status, 422, bad);
  const slow = Date.now();
  await up('yavas.svg', Buffer.from('<svg href=' + ' '.repeat(900000) + '>'), 'image/svg+xml');
  assert.ok(Date.now() - slow < 2000, 'SVG check must not backtrack');
  const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
  assert.equal((await up('boyuk.png', big, 'image/png')).status, 413);
  // Rename keeps the extension; usage is reported before deletion.
  const ren = await admin.put(`/api/media/${m.id}`, { name: 'yeni ad.exe', alt: 'Alt mətn', folder: 'Sınaq' });
  assert.equal(ren.data.item.name, 'yeni ad.png');
  const news = await admin.post('/api/news', { title: 'Şəkilli xəbər', cover_media_id: m.id, gallery: [m.id, 99999] });
  assert.equal(news.data.item.cover.url, m.url);
  assert.deepEqual(news.data.item.gallery, [m.id]);
  assert.equal((await admin.post('/api/news', { title: 'x', cover_media_id: 424242 })).status, 422);
  const delTry = await admin.del(`/api/media/${m.id}`);
  assert.equal(delTry.status, 409);
  assert.equal((await admin.del(`/api/media/${m.id}?force=1`)).status, 200);
  assert.equal((await pubc.get(m.url)).status, 404);
  assert.equal((await admin.get(`/api/news/${news.data.item.id}`)).data.item.cover, null);
  // Documents are private files: internal ones are never reachable without a login.
  const d1 = await admin.req('POST', '/api/documents', { form: fileForm({ title: 'Daxili hesabat', category: 'reports', visibility: 'internal' }, [['file', 'hesabat.pdf', PDF, 'application/pdf']]) });
  assert.equal(d1.status, 201, JSON.stringify(d1.data));
  const d2 = await admin.req('POST', '/api/documents', { form: fileForm({ title: 'Laboratoriya şəhadətnaməsi', category: 'certificates', visibility: 'public' }, [['file', 'şəhadətnamə.pdf', PDF, 'application/pdf']]) });
  assert.equal(d2.status, 201);
  assert.equal((await admin.req('POST', '/api/documents', { form: fileForm({ title: 'Pis', category: 'reports' }, [['file', 'a.svg', Buffer.from('<svg/>'), 'image/svg+xml']]) })).status, 422);
  assert.equal((await pubc.get(`/api/documents/${d1.data.item.id}/download`)).status, 401);
  assert.equal((await pubc.get(`/api/public/documents/${d1.data.item.id}/download`)).status, 404);
  const dl = await pubc.get(`/api/public/documents/${d2.data.item.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal((await pubc.get('/api/public/documents')).data.items.length, 1);
  assert.equal((await admin.get(`/api/documents/${d1.data.item.id}/download`)).data.subarray(0, 5).toString(), '%PDF-');
  // Private files are never served from /media.
  const priv = db.get('SELECT stored_name FROM media WHERE is_private = 1 LIMIT 1');
  assert.equal((await pubc.get('/media/' + priv.stored_name)).status, 404);
  const upd = await admin.patch(`/api/documents/${d1.data.item.id}`, { visibility: 'public' });
  assert.equal(upd.data.item.visibility, 'public');
  assert.equal((await admin.del(`/api/documents/${d2.data.item.id}`)).status, 200);
  await sleep(100);
  assert.equal(fs.readdirSync(path.join(T.dataDir, 'private')).length, 1);
});

test('public forms: validation, consent, honeypot, e-mail, lead workflow', async () => {
  const v1 = new Client(T.base, '10.4.0.1');
  const lead = { first_name: 'Rəşad', last_name: 'Quliyev', company: '=HYPERLINK("http://evil","x")', position: 'Baş energetik', email: 'r.quliyev@example.com', phone: '+994 50 000 00 01',
    project_name: '35/10 kV yarımstansiya <img src=x onerror=alert(1)>', direction: 'Energy Engineering & Consulting', description: 'Modernləşdirmə işləri', budget: '100 000 AZN', consent: true, lang: 'az', page: '/elaqe/' };
  assert.equal((await v1.post('/api/public/project-request', { ...lead, consent: false })).status, 422);
  assert.equal((await v1.post('/api/public/project-request', { ...lead, email: 'pis-email' })).status, 422);
  assert.equal((await v1.post('/api/public/project-request', { ...lead, email: 'a?subject=x&bcc=evil%40evil.example@evil.example' })).status, 422);
  assert.equal((await v1.post('/api/public/project-request', lead, { headers: { Origin: 'https://spam.example' } })).status, 403);
  const before = db.get('SELECT COUNT(*) AS n FROM project_requests').n;
  // Honeypot filled: answered politely, nothing stored.
  assert.equal((await v1.post('/api/public/project-request', { ...lead, website: 'http://spam' })).status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM project_requests').n, before);
  mails.length = 0;
  const form = fileForm({ ...lead, consent: 'on' }, [['files', 'tapsiriq.pdf', PDF, 'application/pdf']]);
  const ok = await v1.req('POST', '/api/public/project-request', { form, headers: { Origin: 'https://aeec.az' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://aeec.az');
  // An identical re-submission is not stored twice.
  const v2 = new Client(T.base, '10.4.0.2');
  await v2.post('/api/public/project-request', lead);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM project_requests').n, before + 1);
  assert.equal((await v2.req('POST', '/api/public/project-request', { form: fileForm({ ...lead, description: 'başqa', consent: 'on' }, [['files', 'a.exe', Buffer.from('MZ'), 'application/pdf']]) })).status, 422);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM project_requests').n, before + 1);
  // The administrator is notified by e-mail with a link to the request.
  await waitMail();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'New Project Discussion Request – AEEC Website');
  assert.deepEqual(mails[0].to, ['office@aeec.az']);
  assert.match(mails[0].text, /Rəşad Quliyev/);
  assert.match(mails[0].text, /http:\/\/admin\.test\/admin\/#\/layihe-sorgulari\/\d+/);
  // Admin side.
  const list = await admin.get('/api/leads?status=new');
  assert.equal(list.data.total, 1);
  const id = list.data.items[0].id;
  const det = await admin.get(`/api/leads/${id}`);
  assert.equal(det.data.files.length, 1);
  assert.equal(det.data.item.consent, 1);
  assert.equal((await new Client(T.base).get(`/api/leads/${id}/files/${det.data.files[0].id}`)).status, 401);
  assert.equal((await admin.get(`/api/leads/${id}/files/${det.data.files[0].id}`)).data.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await admin.patch(`/api/leads/${id}`, { status: 'yox' })).status, 422);
  const st = await admin.patch(`/api/leads/${id}`, { status: 'discussion', assigned_to: admin.me.user.id, follow_up_date: '2026-11-01' });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.equal(st.data.item.status, 'discussion');
  assert.equal(st.data.item.assigned_name, 'Tayfun Hacılı');
  assert.equal(st.data.notes.length, 3);
  assert.equal((await admin.post(`/api/leads/${id}/notes`, { body: 'Müştəri ilə görüş təyin olundu <b>' })).status, 201);
  mails.length = 0;
  assert.equal((await admin.post(`/api/leads/${id}/email`, { subject: 'Sorğunuz barədə\r\nBcc: evil@example.com', body: 'Salam, təşəkkür edirik.' })).status, 200);
  await waitMail();
  assert.deepEqual(mails[0].to, ['r.quliyev@example.com']);
  const headerBlock = mails[0].body.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/im.test(headerBlock), headerBlock);
  // CSV export neutralises spreadsheet formulas coming from public input.
  const csv = (await admin.get('/api/leads/export?format=csv')).data.toString('utf8');
  assert.match(csv, /'=HYPERLINK/);
  // Contact form.
  mails.length = 0;
  const c = await v1.post('/api/public/contact', { name: 'Vüsal Kərimov', email: 'vusal@example.com', subject: 'Laboratoriya', message: 'Sınaq xidmətləri barədə məlumat.', consent: '1' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal((await v1.post('/api/public/contact', { name: 'V', email: 'v@example.com', message: '', consent: '1' })).status, 422);
  await waitMail();
  assert.equal(mails[0].subject, 'New Contact Request – AEEC Website');
  const cl = await admin.get('/api/contacts');
  assert.equal(cl.data.total, 1);
  assert.equal((await admin.patch(`/api/contacts/${cl.data.items[0].id}`, { status: 'read' })).data.item.status, 'read');
  // Notifications for the new requests.
  const n = await admin.get('/api/notifications');
  assert.ok(n.data.items.some((x) => x.type === 'new_lead') && n.data.items.some((x) => x.type === 'new_contact'));
  const sum = await admin.get('/api/notifications/summary');
  assert.ok(sum.data.unread >= 2);
  await admin.post('/api/notifications/read-all');
  assert.equal((await admin.get('/api/notifications/summary')).data.unread, 0);
  // Form flooding from one address is cut off.
  const flood = new Client(T.base, '10.4.0.77');
  let last;
  for (let i = 0; i < 6; i++) last = await flood.post('/api/public/contact', { name: 'F', email: `f${i}@example.com`, message: 'm' + i, consent: 1 });
  assert.equal(last.status, 429);
});

test('analytics: collection, privacy, dashboard numbers', async () => {
  db.run("DELETE FROM contact_requests WHERE name = 'F'");
  const hit = (ip, body, ua, headers = {}) => new Client(T.base, ip).req('POST', '/api/public/collect', { raw: JSON.stringify(body), headers: { 'Content-Type': 'text/plain', ...(ua ? { 'User-Agent': ua } : {}), ...headers } });
  const sid = (n) => 'sessiontest' + String(n).padStart(8, '0');
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
  await hit('20.0.0.1', { t: 'pv', sid: sid(1), path: '/', title: 'Ana səhifə', ref: 'https://www.google.com/search?q=aeec', sw: 1920, sh: 1080, tz: 'Asia/Baku', lang: 'az' });
  await hit('20.0.0.1', { t: 'pv', sid: sid(1), path: '/heller/?utm=1#x', title: 'Həllər' });
  await hit('20.0.0.2', { t: 'pv', sid: sid(2), path: '/', title: 'Ana səhifə', ref: 'https://www.linkedin.com/feed', sw: 390, sh: 844, tz: 'Europe/Istanbul', ret: 1 }, IPHONE);
  await hit('20.0.0.2', { t: 'pv', sid: sid(3), path: '/elaqe/', title: 'Əlaqə', sw: 390, sh: 844, tz: 'Europe/Istanbul' }, IPHONE); // same visitor, new session
  await hit('20.0.0.3', { t: 'pv', sid: sid(4), path: '/', title: 'x' }, 'Googlebot/2.1 (+http://www.google.com/bot.html)');
  await hit('20.0.0.4', { t: 'pv', sid: sid(5), path: '/', title: 'x' }, null, { DNT: '1' });
  await hit('20.0.0.5', { t: 'pv', sid: 'short', path: '/' });
  await hit('20.0.0.6', { t: 'pv', sid: sid(6), path: '/admin/login' });
  await hit('20.0.0.1', { t: 'ping', sid: sid(1) });
  const a = (await admin.get('/api/analytics')).data;
  assert.equal(a.totals.sessions, 3);
  assert.equal(a.totals.visitors, 2);
  assert.equal(a.totals.pageviews, 4);
  assert.equal(a.totals.returning, 1);
  const by = (arr, k) => (arr.find((x) => x.key === k) || {}).value;
  assert.equal(by(a.sources, 'google'), 1); assert.equal(by(a.sources, 'social'), 1); assert.equal(by(a.sources, 'direct'), 1);
  assert.equal(by(a.devices, 'desktop'), 1); assert.equal(by(a.devices, 'mobile'), 2);
  assert.equal(a.pages[0].key, '/'); assert.equal(a.pages[0].value, 2);
  assert.ok(a.pages.some((p) => p.key === '/heller/'));
  assert.ok(a.countries.some((c) => c.country === 'Azərbaycan') && a.countries.some((c) => c.country === 'Türkiyə'));
  // No IP address anywhere in the analytics tables.
  const dump = JSON.stringify(db.all('SELECT * FROM analytics_sessions')) + JSON.stringify(db.all('SELECT * FROM page_views'));
  assert.ok(!dump.includes('20.0.0.'));
  const s = await admin.get('/api/analytics/sessions?device=mobile');
  assert.equal(s.data.total, 2);
  assert.equal(s.data.items[0].screen, '390×844');
  const d = (await admin.get('/api/dashboard')).data;
  assert.equal(d.kpis.total_visitors, 2); assert.equal(d.kpis.visitors_today, 2); assert.equal(d.kpis.pageviews, 4);
  assert.equal(d.kpis.new_leads, 1); assert.equal(d.kpis.new_contacts, 1); assert.equal(d.kpis.published_news, 5);
  assert.equal(d.lead_stats.funnel[0].value, 2); assert.equal(d.lead_stats.funnel[1].value, 1); assert.equal(d.lead_stats.funnel[2].value, 1);
  assert.equal(d.requests_by_month.length, 6); assert.equal(d.requests_by_month[5].leads, 1);
  assert.equal(d.series.bucket, 'day'); assert.equal(d.series.points.length, 30);
  assert.equal((await admin.get('/api/dashboard?from=2026-01-01&to=2026-01-01')).data.series.bucket, 'hour');
  for (const t of ['daily', 'sessions', 'pages']) assert.equal((await admin.get(`/api/analytics/export?type=${t}&format=xlsx`)).data.subarray(0, 2).toString(), 'PK');
  // Staff visits are not counted.
  const st = await admin.req('POST', '/api/public/collect', { raw: JSON.stringify({ t: 'pv', sid: sid(9), path: '/' }), headers: { 'Content-Type': 'text/plain' } });
  assert.equal(st.status, 204);
  assert.equal((await admin.get('/api/analytics')).data.totals.sessions, 3);
});

test('audit log is append-only and Super Admin only', async () => {
  assert.throws(() => db.run('DELETE FROM audit_logs'), /immutable/);
  assert.throws(() => db.run("UPDATE audit_logs SET action = 'x'"), /immutable/);
  assert.equal((await admin.del('/api/audit/1')).status, 404);
  const r = await admin.get('/api/audit?per_page=100');
  assert.ok(r.data.total > 20);
  assert.ok(r.data.items.every((x) => x.created_at && x.action && x.module));
  assert.ok(r.data.items.some((x) => x.ip === '10.0.0.3'));
  assert.ok(!JSON.stringify(r.data.items).includes(NEWPW));
  assert.equal((await admin.get('/api/audit/export?format=csv')).status, 200);
});

test('settings, company, SEO pages, sitemap', async () => {
  const s = await admin.get('/api/settings');
  assert.equal(s.data.settings.contact.phone, '+994 50 362 30 38');
  assert.equal((await admin.put('/api/settings/social', { linkedin: 'javascript:alert(1)' })).status, 422);
  assert.equal((await admin.put('/api/settings/social', { linkedin: 'https://www.linkedin.com/company/aeec' })).status, 200);
  assert.equal((await admin.put('/api/settings/yox', {})).status, 404);
  assert.equal((await admin.put('/api/settings/__proto__', {})).status, 404);
  const co = (await admin.get('/api/company')).data.company;
  co.stats[3].value = '120'; co.stats[3].is_active = true; co.i18n = { en: { mission: 'We create engineering solutions.' } };
  const cs = await admin.put('/api/settings/company', co);
  assert.equal(cs.status, 200, JSON.stringify(cs.data));
  const pubc = new Client(T.base, '10.5.0.1');
  const ps = (await pubc.get('/api/public/settings?lang=en')).data;
  assert.equal(ps.company.mission, 'We create engineering solutions.');
  assert.equal(ps.company.stats.length, 4);
  assert.equal(ps.social.linkedin, 'https://www.linkedin.com/company/aeec');
  assert.equal(ps.notifications, undefined); assert.equal(ps.backup, undefined);
  const pages = await admin.get('/api/seo-pages');
  assert.equal(pages.data.total, 9);
  const pg = pages.data.items[0];
  const up = await admin.put(`/api/seo-pages/${pg.id}`, { ...pg, seo_title: 'AEEC — enerji mühəndisliyi', meta_description: 'Təsvir' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await pubc.get('/api/public/seo?path=/')).data.item.seo_title, 'AEEC — enerji mühəndisliyi');
  assert.equal((await admin.post('/api/seo-pages', { name: 'Təkrar', path: '/' })).status, 422);
  // sitemap.xml and robots.txt are the website's own files (served by Apache in production).
  const sm = (await pubc.get('/sitemap.xml')).data.toString();
  assert.match(sm, /<loc>https:\/\/aeec\.az\/haqqimizda\/<\/loc>/);
  assert.match(sm, /hreflang="ru" href="https:\/\/aeec\.az\/ru\/about\/"/);
  assert.match(sm, /<loc>https:\/\/aeec\.az\/xeberler\/seki-seherinde-yeni-yarimstansiya-isi\/<\/loc>/); // published in the news test
  assert.match((await pubc.get('/robots.txt')).data.toString(), /Disallow: \/admin/);
  const te = await admin.post('/api/settings/test-email');
  assert.equal(te.status, 200, JSON.stringify(te.data));
  const sys = await admin.get('/api/system');
  assert.equal(sys.data.smtp, true);
});

test('services, projects, team: reorder and public output', async () => {
  const svc = (await admin.get('/api/services')).data.items;
  assert.equal(svc.length, 4);
  assert.equal((await admin.post('/api/services/reorder', { ids: [svc[1].id, svc[0].id, svc[2].id, svc[3].id] })).status, 200);
  await admin.patch(`/api/services/${svc[3].id}`, { is_active: false });
  const pubc = new Client(T.base, '10.6.0.1');
  const ps = (await pubc.get('/api/public/services')).data.items;
  assert.equal(ps.length, 3); assert.equal(ps[0].title, 'Digital & AI Solutions');
  const p = await admin.post('/api/projects', { name: 'Nasos stansiyasının enerji səmərəliliyi', client: 'Nümunə', location: 'Abşeron', sector: 'Su təchizatı', status: 'ongoing', start_date: '2026-08-01', end_date: '2027-02-01',
    stats: [{ label: 'Güc', value: '2 MVt' }, { label: '', value: '' }] });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  assert.equal((await admin.post('/api/projects', { name: 'Tarix səhvi', start_date: '2026-08-01', end_date: '2026-01-01' })).status, 422);
  assert.equal((await pubc.get('/api/public/projects')).data.items[0].stats.length, 1);
  await admin.patch(`/api/projects/${p.data.item.id}`, { is_active: false });
  assert.equal((await pubc.get('/api/public/projects')).data.items.length, 0);
  const t = await admin.post('/api/team', { name: 'Tayfun Hacılı', position: 'Direktor', linkedin: 'ftp://x' });
  assert.equal(t.status, 422);
  assert.equal((await admin.post('/api/team', { name: 'Tayfun Hacılı', position: 'Direktor' })).status, 201);
  assert.equal((await pubc.get('/api/public/team')).data.items[0].position, 'Direktor');
});

test('password reset by e-mail and two-factor login', async () => {
  const c = new Client(T.base, '10.7.0.1');
  mails.length = 0;
  const resetMail = () => mails.find((m) => m.text.includes('#/reset/'));
  assert.equal((await c.post('/api/auth/forgot', { email: 'yoxdur@aeec.az' })).status, 200);
  await sleep(300);
  assert.equal(resetMail(), undefined);
  assert.equal((await c.post('/api/auth/forgot', { email: 'viewer@aeec.az' })).status, 200);
  for (let i = 0; i < 60 && !resetMail(); i++) await sleep(50);
  assert.deepEqual(resetMail().to, ['viewer@aeec.az']);
  const token = /#\/reset\/([\w-]+)/.exec(resetMail().text)[1];
  assert.equal((await c.post('/api/auth/reset', { token: 'yanlis', password: 'Bərpa-Parol-2026!' })).status, 400);
  assert.equal((await c.post('/api/auth/reset', { token, password: 'zeif' })).status, 422);
  assert.equal((await c.post('/api/auth/reset', { token, password: 'Bərpa-Parol-2026!' })).status, 200);
  assert.equal((await c.post('/api/auth/reset', { token, password: 'Bərpa-Parol-2027!' })).status, 400); // single use
  assert.equal((await c.login('viewer@aeec.az', 'Bərpa-Parol-2026!')).status, 200);
  // 2FA: enable, then login needs the code; a wrong or replayed code is refused.
  assert.equal((await c.post('/api/auth/2fa/setup', { password: 'səhv' })).status, 422);
  const setup = await c.post('/api/auth/2fa/setup', { password: 'Bərpa-Parol-2026!' });
  assert.match(setup.data.secret, /^[A-Z2-7]{32}$/);
  assert.equal((await c.post('/api/auth/2fa/enable', { code: '000000' })).status, 422);
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await c.post('/api/auth/2fa/enable', { code: sec.totpAt(setup.data.secret, step) })).status, 200);
  const c2 = new Client(T.base, '10.7.0.2');
  const l = await c2.post('/api/auth/login', { email: 'viewer@aeec.az', password: 'Bərpa-Parol-2026!' });
  assert.equal(l.data.mfa_required, true);
  assert.equal((await c2.get('/api/auth/me')).status, 401);
  assert.equal((await c2.get('/api/news')).status, 401);
  assert.equal((await c2.post('/api/auth/mfa', { code: '123456' })).status, 401);
  assert.equal((await c2.post('/api/auth/mfa', { code: sec.totpAt(setup.data.secret, step) })).status, 401); // already used step
  assert.equal((await c2.post('/api/auth/mfa', { code: sec.totpAt(setup.data.secret, step + 1) })).status, 200);
  const me = await c2.get('/api/auth/me');
  assert.equal(me.status, 200);
  // Logout really ends the session.
  c2.csrf = me.data.csrf;
  const cookie = c2.cookie;
  assert.equal((await c2.post('/api/auth/logout')).status, 200);
  c2.cookie = cookie;
  assert.equal((await c2.get('/api/auth/me')).status, 401);
});

test('backups: create, download, Super Admin only', async () => {
  const b = await admin.post('/api/backups');
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.match(b.data.item.file, /^aeec-db-\d{8}-\d{6}\.sqlite\.gz,aeec-files-\d{8}-\d{6}\.tar\.gz$/);
  const dl = await admin.get(`/api/backups/${b.data.item.id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(zlib.gunzipSync(dl.data).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await admin.get(`/api/backups/${b.data.item.id}/download?part=files`)).status, 200);
  const list = await admin.get('/api/backups');
  assert.equal(list.data.last.status, 'ok');
  assert.equal((await new Client(T.base).get(`/api/backups/${b.data.item.id}/download`)).status, 401);
  assert.equal((await admin.del(`/api/backups/${b.data.item.id}`)).status, 200);
  assert.equal(fs.readdirSync(path.join(T.dataDir, 'backups')).length, 0);
});

test('robustness: malformed input never causes a 500', async () => {
  const c = new Client(T.base, '10.8.0.1');
  const cases = [
    ['POST', '/api/auth/login', { raw: '{bad json', headers: { 'Content-Type': 'application/json' } }],
    ['POST', '/api/auth/login', { raw: '[]', headers: { 'Content-Type': 'application/json' } }],
    ['POST', '/api/public/contact', { raw: 'null', headers: { 'Content-Type': 'application/json' } }],
    ['POST', '/api/public/project-request', { raw: 'x', headers: { 'Content-Type': 'multipart/form-data; boundary=zz' } }],
    ['GET', '/api/public/news/%E0%A4%A'], ['GET', '/api/public/news?page=-5&per_page=99999'], ['GET', '/api/public/seo?path=' + 'a'.repeat(900)],
    ['GET', '/api/public/documents/99999999999999999999/download'], ['PUT', '/api/public/news'],
    ['POST', '/api/public/collect', { raw: '{"t":"pv","sid":{"a":1},"path":["x"]}', headers: { 'Content-Type': 'text/plain' } }],
  ];
  for (const [m, u, o] of cases) { const r = await c.req(m, u, o || {}); assert.ok(r.status < 500, `${m} ${u} -> ${r.status}`); }
  for (const [m, u, body] of [['POST', '/api/news', { title: { a: 1 }, tags: 'x', gallery: [{}] }], ['PATCH', '/api/leads/abc', {}], ['PUT', '/api/users/999999', { name: 'a', email: 'a@b.cc', role_id: 1 }],
    ['POST', '/api/services/reorder', { ids: ['a'] }], ['GET', '/api/news?from=2026-13-45&to=x'], ['GET', '/api/analytics?from=1999-01-01&to=2099-01-01'], ['POST', '/api/news', { title: 'a'.repeat(5000) }]]) {
    const r = await admin.req(m, u, m === 'GET' ? {} : { json: body });
    assert.ok(r.status < 500, `${m} ${u} -> ${r.status} ${JSON.stringify(r.data)}`);
  }
  const big = await admin.req('POST', '/api/news', { raw: '{"title":"' + 'x'.repeat(700 * 1024) + '"}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(big.status, 413);
});
