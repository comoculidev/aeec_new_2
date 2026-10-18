'use strict';
// Append-only audit trail of critical operations.
const { run, now } = require('./db');

const SECRET_KEYS = /pass|secret|token|hash|csrf/i;
function redact(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return String(value).slice(0, 4000);
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      const r = {};
      for (const [k, v] of Object.entries(o)) r[k] = SECRET_KEYS.test(k) ? '***' : clean(v);
      return r;
    }
    return typeof o === 'string' && o.length > 500 ? o.slice(0, 500) + '…' : o;
  };
  return JSON.stringify(clean(value)).slice(0, 4000);
}
// Only the fields that actually changed are stored as previous/new value.
function diff(before, after) {
  const prev = {}, next = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (['updated_at', 'created_at'].includes(k)) continue;
    const a = before ? before[k] : undefined, b = after ? after[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) { if (a !== undefined) prev[k] = a; if (b !== undefined) next[k] = b; }
  }
  return { prev, next, changed: Object.keys(prev).length + Object.keys(next).length > 0 };
}
function audit(ctx, e) {
  const u = (ctx && ctx.user) || e.user || null;
  run(`INSERT INTO audit_logs (user_id, user_name, action, module, record_id, summary, previous_value, new_value, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
  u ? u.id : null, u ? u.name : (e.userName || 'Sistem'), e.action, e.module, e.recordId === undefined || e.recordId === null ? '' : String(e.recordId),
  String(e.summary || '').slice(0, 500), redact(e.prev), redact(e.next), (ctx && ctx.ip) || '', now());
}
module.exports = { audit, diff };
