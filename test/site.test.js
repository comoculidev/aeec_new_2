'use strict';
// The website and the panel as ONE project: addresses, sign-in flow, the website's own forms,
// the visit counter and news published as static website pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, Client, PNG, fileForm, sleep, mails } = require('./helpers');

const ADMIN = ['office@aeec.az', 'Sinaq-Parol-2026!'];
const NEWPW = 'Saytla-Vahid-Parol-55!';
let T, admin, db;
const site = (rel) => path.join(T.siteDir, rel);
const read = (rel) => fs.readFileSync(site(rel), 'utf8');
const publish = async () => { const r = await admin.post('/api/site/publish'); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.result; };

test.before(async () => {
  T = await boot();
  db = T.req('src/db');
  admin = new Client(T.base, '10.9.0.1');
  await admin.login(...ADMIN);
  const pw = await admin.post('/api/auth/password', { current: ADMIN[1], password: NEWPW });
  assert.equal(pw.status, 200, JSON.stringify(pw.data));
  await admin.login(ADMIN[0], NEWPW);
});
test.after(() => { T.stop(); setTimeout(() => process.exit(0), 200).unref(); });

test('one address scheme: website /, panel /admin/, sign-in /admin/login, API /api/', async () => {
  const c = new Client(T.base, '10.9.1.1');
  const home = await c.get('/');
  assert.equal(home.status, 200);
  assert.match(home.data.toString(), /<html lang="az">/);
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/); // the site's own CSP from .htaccess
  const expect = [
    ['/admin', 301, '/admin/'], ['/admin/', 302, '/admin/login'], ['/admin/login/', 301, '/admin/login'], ['/admin/index.html', 301, '/admin/'],
    ['/index.html', 301, '/'], ['/haqqimizda', 301, '/haqqimizda/'], ['/haqqimizda.html', 301, '/haqqimizda/'], ['/en/xeberler.html', 301, '/en/news/'], ['/aService.html', 301, '/en/solutions/'],
  ];
  for (const [u, status, loc] of expect) {
    const r = await c.get(u);
    assert.equal(r.status, status, u);
    assert.equal(r.headers.get('location'), loc, u);
  }
  assert.equal((await c.get('/admin/')).headers.get('cache-control'), 'no-store');
  const login = await c.get('/admin/login');
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('cache-control'), 'no-store, no-transform');
  assert.match(login.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const nf = await c.get('/admin/xeberler');
  assert.equal(nf.status, 404);
  assert.match(nf.headers.get('content-type'), /text\/html/);
  const api = await c.get('/api/yoxdur');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /json/);
  assert.equal((await c.get('/olmayan-sehife')).status, 404);
  assert.match((await c.get('/olmayan-sehife')).data.toString(), /<html/);
  assert.equal((await c.get('/.htaccess')).status, 404);
  assert.equal((await c.get('/.well-known/security.txt')).status, 200);
  // No open redirect: none of these leaves the site or follows a parameter.
  for (const u of ['/admin/login?next=https://evil.example', '/admin?next=//evil.example', '//evil.example/', '/admin//evil.example', '/\\evil.example']) {
    const r = await c.get(u);
    const loc = r.headers.get('location') || '';
    assert.ok(!/evil/.test(loc) && !/^(https?:)?\/\//.test(loc), `${u} -> ${r.status} ${loc}`);
  }
});

test('sign-in flow: wrong password, login, page refresh, logout, expired session', async () => {
  const c = new Client(T.base, '10.9.2.1');
  const bad = await c.post('/api/auth/login', { email: ADMIN[0], password: 'yanlis-parol' });
  assert.equal(bad.status, 401);
  assert.ok(!c.cookie, 'no session cookie after a wrong password');
  assert.ok(!JSON.stringify(bad.data).includes(NEWPW));
  const ok = await c.login(ADMIN[0], NEWPW);
  assert.equal(ok.status, 200);
  assert.match(c.lastSetCookie, /HttpOnly/); assert.match(c.lastSetCookie, /SameSite=Strict/); assert.match(c.lastSetCookie, /Path=\//);
  // signed in: the panel opens, the sign-in page sends the user to the panel
  assert.equal((await c.get('/admin/')).status, 200);
  const again = await c.get('/admin/login');
  assert.equal(again.status, 302); assert.equal(again.headers.get('location'), '/admin/');
  // "page refresh" = the same requests again with the same cookie
  for (let i = 0; i < 3; i++) { assert.equal((await c.get('/api/auth/me')).status, 200); assert.equal((await c.get('/admin/')).status, 200); }
  // state-changing request without the CSRF token is refused
  const csrf = c.csrf; c.csrf = '';
  assert.equal((await c.post('/api/auth/logout')).status, 403);
  c.csrf = csrf;
  // a foreign Origin is refused even with the token
  assert.equal((await c.req('POST', '/api/auth/logout', { json: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  // logout
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await c.get('/admin/')).headers.get('location'), '/admin/login');
  // session expiry (idle time passed)
  const d = new Client(T.base, '10.9.2.2');
  await d.login(ADMIN[0], NEWPW);
  assert.equal((await d.get('/api/auth/me')).status, 200);
  db.run("UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE remember = 0");
  assert.equal((await d.get('/api/auth/me')).status, 401);
  assert.equal((await d.get('/admin/')).headers.get('location'), '/admin/login');
  assert.equal((await d.get('/api/news')).status, 401);
  // the admin client used by the other tests signs in again
  await admin.login(ADMIN[0], NEWPW);
});

test('website forms (home / contact / academy) land in the panel and notify by e-mail', async () => {
  const v = new Client(T.base, '10.9.3.1');
  const send = (body, url = '/api/public/form') => v.req('POST', url, { json: { lang: 'az', page: '/', consent: true, aeec_hp: '', elapsed: 9000, ...body }, headers: { Origin: 'https://aeec.az' } });
  mails.length = 0;
  const h = await send({ form: 'home', name: 'Elvin Məmmədov', email: 'elvin@example.az', message: 'Zavod üçün enerji auditi lazımdır.' });
  assert.equal(h.status, 201, JSON.stringify(h.data)); assert.equal(h.data.ok, true);
  const lead = db.get('SELECT * FROM project_requests ORDER BY id DESC LIMIT 1');
  assert.equal(lead.first_name, 'Elvin'); assert.equal(lead.last_name, 'Məmmədov'); assert.equal(lead.description, 'Zavod üçün enerji auditi lazımdır.'); assert.equal(lead.source_page, '/');
  const c = await send({ form: 'contact', lang: 'en', page: '/en/contact/', name: 'John Smith', company: 'ACME', email: 'john@acme.com', direction: 'Energy engineering', message: 'Hello' });
  assert.equal(c.status, 201);
  const cr = db.get('SELECT * FROM contact_requests ORDER BY id DESC LIMIT 1');
  assert.equal(cr.subject, 'Energy engineering'); assert.equal(cr.company, 'ACME'); assert.equal(cr.lang, 'en');
  const a = await send({ form: 'academy', name: 'Aysel Əliyeva', email: 'aysel@example.az', course: 'Enerji auditi və effektivlik' }, '/api/contact.php');
  assert.equal(a.status, 201, 'old address /api/contact.php still works');
  assert.equal(db.get('SELECT subject FROM contact_requests ORDER BY id DESC LIMIT 1').subject, 'AEEC Academy: Enerji auditi və effektivlik');
  // e-mail notification with Reply-To = visitor
  for (let i = 0; i < 40 && mails.length < 3; i++) await sleep(50);
  assert.ok(mails.some((m) => m.subject === 'New Project Discussion Request – AEEC Website' && /Reply-To: elvin@example\.az/.test(m.body)));
  // spam and invalid input
  const before = db.get('SELECT COUNT(*) AS n FROM contact_requests').n;
  assert.equal((await send({ form: 'contact', name: 'Bot', email: 'b@b.az', aeec_hp: 'http://spam' })).data.ok, true);
  assert.equal((await send({ form: 'contact', name: 'Bot', email: 'b@b.az', elapsed: 300 })).data.ok, true);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM contact_requests').n, before, 'spam is not stored');
  assert.equal((await send({ form: 'contact', name: 'X', email: 'pis-unvan' })).status, 422);
  assert.equal((await send({ form: 'contact', name: 'X', email: 'x@x.az', consent: false })).status, 422);
  assert.equal((await send({ form: 'nese', name: 'X', email: 'x@x.az' })).status, 422);
  assert.equal((await v.req('POST', '/api/public/form', { raw: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
});

test('visit counter from the website pages', async () => {
  const v = new Client(T.base, '10.9.4.1');
  const sid = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const r = await v.req('POST', '/api/public/collect', { raw: JSON.stringify({ t: 'pv', sid, path: '/xeberler/', title: 'Xəbərlər | AEEC', ref: '', sw: 1440, sh: 900, lang: 'az', tz: 'Asia/Baku', ret: 0 }), headers: { 'Content-Type': 'text/plain', Origin: 'http://admin.test' } });
  assert.equal(r.status, 204);
  assert.ok(db.get("SELECT COUNT(*) AS n FROM page_views WHERE path = '/xeberler/'").n >= 1);
  // the website script really sends to that address
  const js = (await v.get('/assets/js/main.js?v=3.2')).data.toString();
  assert.match(js, /STATS_ENDPOINT = '\/api\/public\/collect'/);
  assert.match(js, /FORM_ENDPOINT = '\/api\/public\/form'/);
});

test('news: imported website pages, publishing in 3 languages, removal, safety', async () => {
  // 1. the four hand-written news pages were imported and regeneration changes nothing
  const imported = (await admin.get('/api/news?per_page=50')).data.items;
  assert.equal(imported.length, 4);
  const iea = imported.find((n) => n.slug === 'iea-enerji-semereliliyi-cop29');
  assert.equal(iea.slug_en, 'iea-energy-efficiency-cop29'); assert.equal(iea.site_image, '/assets/img/news-iea.jpg');
  const orig = T.origSite;
  let r = await publish();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.written, []);
  for (const rel of ['xeberler/index.html', 'en/news/index.html', 'xeberler/iea-enerji-semereliliyi-cop29/index.html', 'ru/news/iea-energy-efficiency-cop29/index.html', 'sitemap.xml'])
    assert.equal(read(rel), fs.readFileSync(path.join(orig, rel), 'utf8'), rel);

  // 2. a new item with an image, in three languages, with hostile text
  const up = await admin.req('POST', '/api/media', { form: fileForm({ folder: 'Xəbərlər', alt: 'Yarımstansiya' }, [['file', 'stansiya.png', PNG, 'image/png']]) });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const media = up.data.items ? up.data.items[0] : up.data.item;
  const n = (await admin.post('/api/news', {
    title: 'Gəncədə <img src=x onerror=alert(1)> yeni yarımstansiya', excerpt: 'Qısa "məlumat" & s.', content: 'Birinci abzas.\n\nİkinci **abzas** <script>alert(1)</script>', category: 'Layihələr',
    cover_media_id: media.id, cover_alt: 'Yarımstansiyanın görünüşü', status: 'published',
    i18n: { en: { title: 'New substation in Ganja', content: 'First paragraph.', excerpt: 'Short', category: 'Projects' }, ru: { title: 'Новая подстанция в Гяндже', content: 'Первый абзац.' } },
  })).data.item;
  assert.equal(n.slug, 'gencede-img-src-x-onerror-alert-1-yeni-yarimstansiya');
  assert.equal(n.slug_en, 'new-substation-in-ganja');
  assert.equal(n.slug_ru, '', 'Cyrillic title gives no latin slug; the page falls back to the English address');
  await sleep(700); // automatic publication after saving (debounced)
  const az = read(`xeberler/${n.slug}/index.html`);
  assert.ok(!az.includes('<img src=x'), 'title is escaped');
  assert.match(az, /<h1 class="art-title">Gəncədə &lt;img src=x onerror=alert\(1\)&gt; yeni yarımstansiya<\/h1>/);
  assert.ok(!az.includes('<script>alert'), 'body is escaped');
  assert.match(az, /<p>İkinci <strong>abzas<\/strong> &lt;script&gt;/);
  assert.match(az, /<link rel="alternate" hreflang="en" href="https:\/\/aeec\.az\/en\/news\/new-substation-in-ganja\/">/);
  assert.match(az, new RegExp(`<img src="/assets/img/cms/${media.url.split('/').pop()}" alt="Yarımstansiyanın görünüşü" width="1" height="1" fetchpriority="high"`));
  assert.ok(fs.existsSync(site(`assets/img/cms/${media.url.split('/').pop()}`)), 'cover copied into the website');
  assert.match(az, /"name": "Gəncədə \\u003cimg src=x onerror=alert\(1\)> yeni yarımstansiya"/, 'JSON-LD cannot close the script tag');
  assert.match(read('en/news/new-substation-in-ganja/index.html'), /<h1 class="art-title">New substation in Ganja<\/h1>/);
  assert.match(read('ru/news/new-substation-in-ganja/index.html'), /<h1 class="art-title">Новая подстанция в Гяндже<\/h1>/);
  assert.match(read('xeberler/index.html'), new RegExp(`<a href="/xeberler/${n.slug}/">`));
  assert.match(read('en/news/index.html'), /<span class="tag">Projects<\/span><h2><a href="\/en\/news\/new-substation-in-ganja\/">/);
  assert.match(read('sitemap.xml'), /<loc>https:\/\/aeec\.az\/en\/news\/new-substation-in-ganja\/<\/loc>/);
  // the page is really served by the website
  const pv = new Client(T.base, '10.9.5.1');
  assert.equal((await pv.get(`/xeberler/${n.slug}/`)).status, 200);
  // the "more news" list of an old page now links to the new item
  assert.match(read('xeberler/iea-enerji-semereliliyi-cop29/index.html'), new RegExp(`/xeberler/${n.slug}/`));

  // 3. an item written only in Azerbaijani gets no EN/RU page; its language links go to the lists
  const only = (await admin.post('/api/news', { title: 'Yalnız Azərbaycan dilində', content: 'Mətn.', status: 'published' })).data.item;
  r = await publish();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p = read(`xeberler/${only.slug}/index.html`);
  assert.match(p, /<a href="\/en\/news\/" lang="en"/);
  assert.ok(!/hreflang="en"/.test(p.split('</head>')[0]));
  assert.ok(!fs.existsSync(site(`en/news/${only.slug}`)));
  assert.match(p, /<meta property="og:image" content="https:\/\/aeec\.az\/assets\/img\/og-image\.jpg">/);
  assert.ok(!p.includes('<picture class="art-img">'));

  // 4. archiving removes the pages (and only them)
  assert.equal((await admin.patch(`/api/news/${n.id}`, { status: 'archived' })).status, 200);
  r = await publish();
  assert.ok(r.removed.includes(`xeberler/${n.slug}/index.html`));
  assert.ok(!fs.existsSync(site(`xeberler/${n.slug}`)), 'empty folder removed');
  assert.ok(!fs.existsSync(site('en/news/new-substation-in-ganja')));
  assert.ok(!read('sitemap.xml').includes('new-substation-in-ganja'));
  assert.ok(fs.existsSync(site('xeberler/iea-enerji-semereliliyi-cop29/index.html')));
  assert.equal((await pv.get(`/xeberler/${n.slug}/`)).status, 404);

  // 5. a page the panel did not create is never overwritten
  fs.mkdirSync(site('xeberler/el-ile-yazilmis'), { recursive: true });
  fs.writeFileSync(site('xeberler/el-ile-yazilmis/index.html'), 'ƏL İLƏ');
  await admin.post('/api/news', { title: 'Əl ilə yazılmış', slug: 'el-ile-yazilmis', content: 'x', status: 'published' });
  r = await publish();
  assert.equal(r.ok, false);
  assert.ok(r.skipped.includes('xeberler/el-ile-yazilmis/index.html'));
  assert.equal(read('xeberler/el-ile-yazilmis/index.html'), 'ƏL İLƏ');
  const st = (await admin.get('/api/site/status')).data;
  assert.equal(st.enabled, true); assert.ok(st.last.errors.length);

  // 6. a hand-damaged managed page is repaired; editing an imported item updates its pages
  fs.writeFileSync(site('xeberler/iea-enerji-semereliliyi-cop29/index.html'), 'pozulub');
  await publish();
  assert.match(read('xeberler/iea-enerji-semereliliyi-cop29/index.html'), /<h1 class="art-title">IEA ilə enerji səmərəliliyi və COP29 üzrə əməkdaşlıq müzakirə edilib<\/h1>/);
  assert.equal((await admin.patch(`/api/news/${iea.id}`, { title: 'IEA ilə əməkdaşlıq — yenilənmiş başlıq' })).status, 200);
  await publish();
  assert.match(read('xeberler/iea-enerji-semereliliyi-cop29/index.html'), /<h1 class="art-title">IEA ilə əməkdaşlıq — yenilənmiş başlıq<\/h1>/);
  assert.match(read('en/news/iea-energy-efficiency-cop29/index.html'), /Cooperation with the IEA on energy efficiency and COP29 discussed/);

  // a sitemap saved with Windows line endings is handled (no duplicate entries)
  fs.writeFileSync(site('sitemap.xml'), read('sitemap.xml').replace(/\n/g, '\r\n'));
  await publish();
  const locsNow = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locsNow.length, new Set(locsNow).size, 'no duplicate sitemap entries');

  // 7. validation: slugs and site image paths cannot point outside their folders
  for (const body of [{ title: 'a', slug: '../../etc' }, { title: 'a', slug_en: 'a/b' }, { title: 'a', site_image: '/../../etc/passwd' }, { title: 'a', site_image: 'https://evil.example/x.jpg' }])
    assert.equal((await admin.post('/api/news', body)).status, 422, JSON.stringify(body));
  // EN/RU addresses are unique on the website, not only per column
  const A = (await admin.post('/api/news', { title: 'Günəş stansiyası A', slug_en: 'solar-plant', i18n: { en: { title: 'Solar plant', content: 'x' } } })).data.item;
  assert.equal(A.slug_en, 'solar-plant');
  assert.equal((await admin.post('/api/news', { title: 'Günəş stansiyası B', slug_ru: 'solar-plant' })).status, 422);
  const B = (await admin.post('/api/news', { title: 'Günəş stansiyası C', i18n: { en: { title: 'Solar plant', content: 'y' }, ru: { title: 'Солнечная станция', content: 'z' } } })).data.item;
  assert.equal(B.slug_en, 'solar-plant-2');
  assert.notEqual(B.slug_ru || B.slug_en, 'solar-plant');
  // viewers may look at the status but not trigger publication
  assert.equal((await new Client(T.base, '10.9.6.1').post('/api/site/publish')).status, 401);
});
