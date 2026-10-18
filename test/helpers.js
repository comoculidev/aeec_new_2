'use strict';
// Test harness: starts the real server on a random port with a throw-away data directory and a
// fake SMTP server that records every message.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const mails = [];
function fakeSmtp() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = '', data = false, msg = { from: '', to: [], body: '' };
      sock.write('220 test ESMTP\r\n');
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        for (;;) {
          if (data) {
            const i = buf.indexOf('\r\n.\r\n');
            if (i === -1) return;
            msg.body = buf.slice(0, i); buf = buf.slice(i + 5); data = false;
            const m = /\r\n\r\n([\s\S]*)$/.exec(msg.body);
            msg.text = m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
            const s = /^Subject: (.*)$/m.exec(msg.body);
            msg.subject = s ? s[1].replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8')) : '';
            mails.push(msg); msg = { from: '', to: [], body: '' };
            sock.write('250 queued\r\n');
            continue;
          }
          const i = buf.indexOf('\r\n');
          if (i === -1) return;
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          let m;
          if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (/^AUTH/i.test(line)) sock.write('235 ok\r\n');
          else if ((m = /^MAIL FROM:<(.*)>/i.exec(line))) { msg.from = m[1]; sock.write('250 ok\r\n'); }
          else if ((m = /^RCPT TO:<(.*)>/i.exec(line))) { msg.to.push(m[1]); sock.write('250 ok\r\n'); }
          else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
          else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let ctx = null;
async function boot() {
  if (ctx) return ctx;
  // The tests run on a private copy of the whole project (site included), exactly as it would be
  // copied to a server - so they never change the real site/ or data/ folders.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aeec-test-'));
  for (const f of ['server.js', 'package.json', 'src', 'admin', 'site', 'site-templates']) fs.cpSync(path.join(__dirname, '..', f), path.join(proj, f), { recursive: true });
  const dataDir = path.join(proj, 'data'), siteDir = path.join(proj, 'site');
  const smtp = await fakeSmtp();
  Object.assign(process.env, {
    PORT: '0', HOST: '127.0.0.1', BASE_URL: 'http://admin.test', COOKIE_SECURE: '0',
    ADMIN_EMAIL: 'office@aeec.az', ADMIN_PASSWORD: 'Sinaq-Parol-2026!', ADMIN_NAME: 'Tayfun Hacılı',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_FROM: 'AEEC Sayt <noreply@aeec.az>', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_ALLOW_INSECURE: '1',
    TRUST_PROXY: '1', LOGIN_MAX_FAILS: '5', SENDMAIL_PATH: '',
  });
  const { start } = require(path.join(proj, 'server.js'));
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  ctx = { base, proj, dataDir, siteDir, origSite: path.join(__dirname, '..', 'site'), req: (m) => require(path.join(proj, m)), server, smtp, mails, stop: () => { server.close(); smtp.close(); } };
  return ctx;
}

// Minimal HTTP client with a cookie jar and CSRF handling.
class Client {
  constructor(base, ip) { this.base = base; this.cookie = ''; this.csrf = ''; this.ip = ip || '10.0.0.1'; }
  async req(method, url, { json, form, headers = {}, raw } = {}) {
    const h = { 'X-Real-IP': this.ip, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36', ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) body = form;
    else if (raw !== undefined) body = raw;
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); const val = kv.slice(i + 1); this.cookie = val ? kv : ''; this.lastSetCookie = c; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(u, o) { return this.req('GET', u, o); }
  post(u, json, o) { return this.req('POST', u, { json: json === undefined ? {} : json, ...o }); }
  put(u, json) { return this.req('PUT', u, { json }); }
  patch(u, json) { return this.req('PATCH', u, { json }); }
  del(u) { return this.req('DELETE', u); }
  async login(email, password, extra = {}) {
    const r = await this.post('/api/auth/login', { email, password, ...extra });
    if (r.status === 200 && r.data.ok) { const me = await this.get('/api/auth/me'); this.csrf = me.data.csrf; this.me = me.data; }
    return r;
  }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const fileForm = (fields, files) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(fields || {})) f.append(k, String(val));
  for (const [k, name, buf, type] of files || []) f.append(k, new Blob([buf], { type: type || 'application/octet-stream' }), name);
  return f;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { boot, Client, PNG, PDF, fileForm, sleep, mails };
