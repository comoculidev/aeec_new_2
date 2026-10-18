'use strict';
// Creates a Super Admin or resets the password of an existing user.
// Usage: npm run create-admin            (asks for e-mail, name and password)
//        npm run create-admin -- email@aeec.az "Ad Soyad"   (asks only for the password)
const readline = require('node:readline');
const { get, run, now, migrate } = require('../src/db');
const { seedPermissions } = require('../src/permissions');
const { hashPassword, passwordProblem } = require('../src/security');

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}
(async () => {
  migrate(); seedPermissions();
  const email = (process.argv[2] || await ask('E-poçt: ')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('E-poçt düzgün deyil'); process.exit(1); }
  const existing = get('SELECT * FROM users WHERE email = ?', email);
  const name = existing ? existing.name : (process.argv[3] || await ask('Ad, soyad: ') || 'Super Admin');
  const pw = process.env.NEW_PASSWORD || await ask('Şifrə: ', true);
  const problem = passwordProblem(pw, { email });
  if (problem) { console.error(problem); process.exit(1); }
  const hash = await hashPassword(pw);
  if (existing) {
    run('UPDATE users SET password_hash = ?, is_active = 1, failed_logins = 0, locked_until = NULL, totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?', hash, now(), now(), existing.id);
    run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    run("INSERT INTO audit_logs (user_id, user_name, action, module, record_id, summary, ip, created_at) VALUES (?,?,?,?,?,?,?,?)", existing.id, 'Server (CLI)', 'Şifrə sıfırlandı', 'Auth', String(existing.id), `${email} şifrəsi serverdə əmrlə yeniləndi (2FA söndürüldü)`, '', now());
    console.log(`Şifrə yeniləndi: ${email}. İlk girişdə yeni şifrə təyin etmək tələb olunacaq.`);
  } else {
    const role = get("SELECT id FROM roles WHERE key = 'super_admin'");
    const id = run('INSERT INTO users (email, name, password_hash, role_id, is_active, password_changed_at, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)', email, name, hash, role.id, now(), now(), now()).lastInsertRowid;
    run("INSERT INTO audit_logs (user_id, user_name, action, module, record_id, summary, ip, created_at) VALUES (?,?,?,?,?,?,?,?)", id, 'Server (CLI)', 'Yaratma', 'İstifadəçilər', String(id), `Super Admin serverdə əmrlə yaradıldı: ${email}`, '', now());
    console.log(`Super Admin yaradıldı: ${email}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
