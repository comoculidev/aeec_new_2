'use strict';
// Small SMTP client (STARTTLS or implicit TLS, AUTH PLAIN/LOGIN) plus a persistent outbox with
// retries. Messages are plain text; header values are stripped of line breaks so user input can
// never inject extra headers or recipients.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = require('./config');
const { all, run, now } = require('./db');

const ADDR = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,6}$/i;
const oneLine = (s) => String(s || '').replace(/[\r\n\x00]+/g, ' ').trim();
const addrOf = (s) => { const m = /<([^<>]+)>\s*$/.exec(String(s)); return (m ? m[1] : String(s)).trim(); };
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
function encodeFrom(s) {
  const m = /^(.*)<([^<>]+)>\s*$/.exec(s);
  if (!m) return s;
  const name = m[1].trim().replace(/^"|"$/g, '');
  return name ? `${encodeWord(name)} <${m[2].trim()}>` : m[2].trim();
}
// Delivery: the SMTP server from .env, or - when SMTP_HOST is empty - the server's own local mail
// program (/usr/sbin/sendmail, e.g. postfix), which is what the old api/contact.php used.
const fromOk = () => Boolean(config.smtp.from && ADDR.test(addrOf(config.smtp.from)));
const sendmailOk = () => { try { return Boolean(config.sendmailPath) && fs.statSync(config.sendmailPath).isFile(); } catch { return false; } };
const transport = () => (!fromOk() ? '' : config.smtp.host ? 'smtp' : sendmailOk() ? 'sendmail' : '');
const isConfigured = () => transport() !== '';

function sendmailSend(rcpt, message) {
  return new Promise((resolve, reject) => {
    let done = false, errText = '';
    const finish = (e) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(); };
    const p = spawn(config.sendmailPath, ['-i', '-f', addrOf(config.smtp.from), '--', ...rcpt], { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { p.kill('SIGKILL'); finish(new Error('sendmail cavab vermədi')); }, 30000);
    p.stderr.on('data', (d) => { errText = (errText + d).slice(0, 300); });
    p.stdin.on('error', (e) => finish(new Error(`sendmail məktubu qəbul etmədi (${e.code || e.message})`))); // EPIPE must not crash the server
    p.on('error', (e) => finish(e));
    p.on('close', (code) => finish(code === 0 ? null : new Error(`sendmail xətası (${code}) ${errText}`.trim())));
    p.stdin.end(message);
  });
}

function buildMessage({ from, to, subject, text, replyTo }) {
  const domain = addrOf(from).split('@')[1] || os.hostname();
  const headers = [
    `From: ${encodeFrom(oneLine(from))}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeWord(oneLine(subject).slice(0, 200))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  if (replyTo && ADDR.test(replyTo)) headers.push(`Reply-To: ${replyTo}`);
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

function smtpSend({ to, subject, text, replyTo }) {
  const c = config.smtp;
  const rcpt = (Array.isArray(to) ? to : [to]).map((a) => addrOf(oneLine(a))).filter((a) => ADDR.test(a));
  if (!isConfigured()) return Promise.reject(new Error('SMTP qurulmayıb'));
  if (!rcpt.length) return Promise.reject(new Error('Alıcı ünvanı düzgün deyil'));
  if (transport() === 'sendmail') return sendmailSend(rcpt, buildMessage({ from: c.from, to: rcpt, subject, text, replyTo }));
  const fromAddr = addrOf(c.from);
  return new Promise((resolve, reject) => {
    let socket, buf = '', waiting = null, finished = false;
    const done = (e) => { if (finished) return; finished = true; clearTimeout(timer); try { socket.destroy(); } catch { /* ignore */ } e ? reject(e) : resolve(); };
    const timer = setTimeout(() => done(new Error('SMTP vaxt limiti bitdi')), 30000);
    // A complete SMTP reply ends with a line of the form "NNN text" (continuation lines use "NNN-").
    const pump = () => {
      if (!waiting) return;
      const m = /(?:^|\r\n)\d{3} [^\r\n]*\r\n/.exec(buf);
      if (!m) return;
      const end = m.index + m[0].length;
      const reply = buf.slice(0, end).trim();
      buf = buf.slice(end);
      const w = waiting; waiting = null; w(reply);
    };
    const onData = (d) => { buf += d.toString('utf8'); if (buf.length > 65536) return done(new Error('SMTP cavabı çox uzundur')); pump(); };
    const attach = (s) => { socket = s; s.on('data', onData); s.on('error', done); s.on('close', () => done(new Error('SMTP bağlantısı kəsildi'))); };
    const read = () => new Promise((res) => { waiting = res; pump(); });
    const cmd = async (line, expect) => {
      if (line !== null) socket.write(line + '\r\n');
      const reply = await read();
      const code = reply.split('\r\n').pop().slice(0, 3);
      if (!expect.includes(code)) throw new Error(`SMTP: ${reply.slice(0, 200)}`);
      return reply;
    };
    const flow = async () => {
      await cmd(null, ['220']);
      const host = 'aeec-admin.local';
      let ehlo = await cmd(`EHLO ${host}`, ['250']);
      if (!c.secure) {
        if (/STARTTLS/i.test(ehlo)) {
          await cmd('STARTTLS', ['220']);
          socket.removeAllListeners('data'); socket.removeAllListeners('close'); socket.removeAllListeners('error');
          const plain = socket;
          await new Promise((res, rej) => { const t = tls.connect({ socket: plain, servername: c.host }, res); t.on('error', rej); attach(t); });
          ehlo = await cmd(`EHLO ${host}`, ['250']);
        } else if (!c.allowInsecure) throw new Error('SMTP server şifrələnmiş bağlantını (STARTTLS) dəstəkləmir');
      }
      if (c.user) {
        if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await cmd('AUTH PLAIN ' + Buffer.concat([Buffer.from([0]), Buffer.from(c.user), Buffer.from([0]), Buffer.from(c.pass)]).toString('base64'), ['235']);
        else { await cmd('AUTH LOGIN', ['334']); await cmd(Buffer.from(c.user).toString('base64'), ['334']); await cmd(Buffer.from(c.pass).toString('base64'), ['235']); }
      }
      await cmd(`MAIL FROM:<${fromAddr}>`, ['250']);
      for (const r of rcpt) await cmd(`RCPT TO:<${r}>`, ['250', '251']);
      await cmd('DATA', ['354']);
      socket.write(buildMessage({ from: c.from, to: rcpt, subject, text, replyTo }));
      await cmd('.', ['250']);
      socket.write('QUIT\r\n');
    };
    const start = () => flow().then(() => done(), done);
    if (c.secure) attach(tls.connect({ host: c.host, port: c.port, servername: c.host }, start));
    else attach(net.connect({ host: c.host, port: c.port }, start));
  });
}

/* ------------------------------------------------------------ outbox */
let busy = false;
async function processOutbox() {
  if (busy) return;
  busy = true;
  try {
    const rows = all("SELECT * FROM outbox WHERE status = 'pending' AND attempts < 5 ORDER BY id LIMIT 20");
    for (const m of rows) {
      try {
        await smtpSend({ to: m.to_addr.split(','), subject: m.subject, text: m.body_text, replyTo: m.reply_to });
        run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = '' WHERE id = ?", now(), m.id);
      } catch (e) {
        const final = m.attempts + 1 >= 5 || !isConfigured();
        run('UPDATE outbox SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?', final ? 'failed' : 'pending', String(e.message).slice(0, 300), m.id);
        if (final) console.error('[mail] göndərilmədi:', m.subject, '-', e.message);
      }
    }
  } finally { busy = false; }
}
function queueMail({ to, subject, text, replyTo }) {
  const rcpt = (Array.isArray(to) ? to : [to]).map((a) => addrOf(oneLine(a))).filter((a) => ADDR.test(a));
  if (!rcpt.length) return false;
  run('INSERT INTO outbox (to_addr, subject, body_text, reply_to, created_at) VALUES (?,?,?,?,?)', rcpt.join(','), oneLine(subject).slice(0, 200), String(text).slice(0, 20000), replyTo && ADDR.test(replyTo) ? replyTo : '', now());
  setImmediate(() => processOutbox().catch((e) => console.error('[mail]', e)));
  return true;
}
function startMailLoop() { const t = setInterval(() => processOutbox().catch(() => {}), 5 * 60 * 1000); t.unref(); }

module.exports = { smtpSend, queueMail, processOutbox, startMailLoop, isConfigured, transport, ADDR };
