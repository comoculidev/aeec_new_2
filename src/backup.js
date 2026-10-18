'use strict';
// Database and file backups. The database snapshot is taken with VACUUM INTO, which produces a
// consistent copy while the application keeps running.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const config = require('./config');
const { db, get, all, run, now, dayOf } = require('./db');
const { getSetting } = require('./settings');

const stamp = () => new Date(Date.now() + config.tzOffsetMin * 60000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const NAME = /^aeec-(db|files)-\d{8}-\d{6}\.(sqlite\.gz|tar\.gz)$/;
let running = false;

function tarFiles(target) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-czf', target, '-C', config.dataDir, path.basename(config.uploadDir), path.basename(config.privateDir)], { timeout: 10 * 60000 }, (e) => (e ? reject(e) : resolve()));
  });
}
async function createBackup(kind, userId) {
  if (running) throw new Error('Başqa bir ehtiyat nüsxə hazırlanır');
  running = true;
  const s = getSetting('backup'), id = stamp();
  const tmp = path.join(config.backupDir, `tmp-${id}.sqlite`);
  const dbFile = `aeec-db-${id}.sqlite.gz`;
  const created = [];
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(path.join(config.backupDir, dbFile), { mode: 0o600 }));
    fs.rmSync(tmp, { force: true });
    created.push(dbFile);
    let note = 'Verilənlər bazası';
    if (s.include_files) {
      const f = `aeec-files-${id}.tar.gz`;
      try { await tarFiles(path.join(config.backupDir, f)); fs.chmodSync(path.join(config.backupDir, f), 0o600); created.push(f); note += ' + fayllar'; }
      catch (e) { fs.rmSync(path.join(config.backupDir, f), { force: true }); note += ' (fayllar arxivlənmədi: ' + String(e.message).slice(0, 80) + ')'; }
    }
    const size = created.reduce((a, f) => a + fs.statSync(path.join(config.backupDir, f)).size, 0);
    const rid = run('INSERT INTO backups (file, size, kind, status, message, created_by, created_at) VALUES (?,?,?,?,?,?,?)', created.join(','), size, kind, 'ok', note, userId || null, now()).lastInsertRowid;
    prune(s.keep);
    return get('SELECT * FROM backups WHERE id = ?', rid);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    run('INSERT INTO backups (file, size, kind, status, message, created_by, created_at) VALUES (?,?,?,?,?,?,?)', '', 0, kind, 'failed', String(e.message).slice(0, 300), userId || null, now());
    throw e;
  } finally { running = false; }
}
function removeFiles(row) {
  for (const f of String(row.file || '').split(',')) if (NAME.test(f)) fs.rmSync(path.join(config.backupDir, f), { force: true });
}
function prune(keep) {
  const rows = all("SELECT * FROM backups WHERE status = 'ok' ORDER BY id DESC");
  for (const r of rows.slice(Math.max(1, keep || 14))) { removeFiles(r); run('DELETE FROM backups WHERE id = ?', r.id); }
  const failed = all("SELECT id FROM backups WHERE status = 'failed' ORDER BY id DESC");
  for (const r of failed.slice(20)) run('DELETE FROM backups WHERE id = ?', r.id);
}
// Called periodically: makes the daily automatic backup once the configured hour has passed.
async function autoBackupTick(onError) {
  const s = getSetting('backup');
  if (!s.auto || running) return;
  const local = new Date(Date.now() + config.tzOffsetMin * 60000);
  if (local.getUTCHours() < s.hour) return;
  const today = dayOf();
  const last = get("SELECT created_at FROM backups WHERE kind = 'auto' ORDER BY id DESC LIMIT 1");
  if (last && dayOf(last.created_at) === today) return;
  try { await createBackup('auto', null); } catch (e) { console.error('[backup]', e.message); if (onError) onError(e); }
}
module.exports = { createBackup, autoBackupTick, removeFiles, NAME };
