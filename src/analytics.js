'use strict';
// Privacy-friendly visitor analytics.
// - No cookies and no IP address are stored. A visitor is counted through a hash of
//   (daily random salt + IP + browser string); the salt is deleted after two days, so the hash
//   cannot be traced back to a person or linked across days.
// - The session id lives in the browser tab's sessionStorage only.
const config = require('./config');
const { get, all, run, tx, now, dayOf } = require('./db');
const { hmac, randomToken, rateLimit } = require('./security');
const { getSetting } = require('./settings');
const { TZ, isDay } = require('./crud');

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|scrapy|httpclient|java\/|go-http|phantom|selenium|puppeteer|playwright/i;
const TZ_COUNTRY = {
  'Asia/Baku': 'Azərbaycan', 'Europe/Istanbul': 'Türkiyə', 'Asia/Istanbul': 'Türkiyə', 'Asia/Tbilisi': 'Gürcüstan', 'Asia/Yerevan': 'Ermənistan', 'Asia/Tehran': 'İran',
  'Europe/Moscow': 'Rusiya', 'Europe/Samara': 'Rusiya', 'Europe/Volgograd': 'Rusiya', 'Europe/Kaliningrad': 'Rusiya', 'Asia/Yekaterinburg': 'Rusiya', 'Asia/Novosibirsk': 'Rusiya', 'Asia/Krasnoyarsk': 'Rusiya',
  'Asia/Almaty': 'Qazaxıstan', 'Asia/Aqtau': 'Qazaxıstan', 'Asia/Aqtobe': 'Qazaxıstan', 'Asia/Atyrau': 'Qazaxıstan', 'Asia/Qyzylorda': 'Qazaxıstan', 'Asia/Oral': 'Qazaxıstan',
  'Asia/Tashkent': 'Özbəkistan', 'Asia/Samarkand': 'Özbəkistan', 'Asia/Ashgabat': 'Türkmənistan', 'Asia/Bishkek': 'Qırğızıstan', 'Asia/Dushanbe': 'Tacikistan',
  'Europe/Kyiv': 'Ukrayna', 'Europe/Kiev': 'Ukrayna', 'Europe/Minsk': 'Belarus', 'Europe/Berlin': 'Almaniya', 'Europe/London': 'Böyük Britaniya', 'Europe/Paris': 'Fransa',
  'Europe/Rome': 'İtaliya', 'Europe/Madrid': 'İspaniya', 'Europe/Amsterdam': 'Niderland', 'Europe/Brussels': 'Belçika', 'Europe/Vienna': 'Avstriya', 'Europe/Zurich': 'İsveçrə',
  'Europe/Warsaw': 'Polşa', 'Europe/Prague': 'Çexiya', 'Europe/Budapest': 'Macarıstan', 'Europe/Bucharest': 'Rumıniya', 'Europe/Sofia': 'Bolqarıstan', 'Europe/Athens': 'Yunanıstan',
  'Europe/Stockholm': 'İsveç', 'Europe/Oslo': 'Norveç', 'Europe/Helsinki': 'Finlandiya', 'Europe/Copenhagen': 'Danimarka', 'Europe/Dublin': 'İrlandiya', 'Europe/Lisbon': 'Portuqaliya',
  'Asia/Dubai': 'BƏƏ', 'Asia/Riyadh': 'Səudiyyə Ərəbistanı', 'Asia/Qatar': 'Qətər', 'Asia/Kuwait': 'Küveyt', 'Asia/Jerusalem': 'İsrail', 'Asia/Baghdad': 'İraq',
  'Asia/Shanghai': 'Çin', 'Asia/Hong_Kong': 'Honq Konq', 'Asia/Tokyo': 'Yaponiya', 'Asia/Seoul': 'Cənubi Koreya', 'Asia/Kolkata': 'Hindistan', 'Asia/Calcutta': 'Hindistan', 'Asia/Karachi': 'Pakistan', 'Asia/Singapore': 'Sinqapur',
  'America/New_York': 'ABŞ', 'America/Chicago': 'ABŞ', 'America/Denver': 'ABŞ', 'America/Los_Angeles': 'ABŞ', 'America/Phoenix': 'ABŞ', 'America/Toronto': 'Kanada', 'America/Vancouver': 'Kanada',
  'Australia/Sydney': 'Avstraliya', 'Australia/Melbourne': 'Avstraliya', 'Africa/Cairo': 'Misir',
};
const ISO_COUNTRY = { AZ: 'Azərbaycan', TR: 'Türkiyə', GE: 'Gürcüstan', RU: 'Rusiya', KZ: 'Qazaxıstan', UZ: 'Özbəkistan', TM: 'Türkmənistan', IR: 'İran', UA: 'Ukrayna', DE: 'Almaniya',
  GB: 'Böyük Britaniya', FR: 'Fransa', IT: 'İtaliya', ES: 'İspaniya', NL: 'Niderland', US: 'ABŞ', CA: 'Kanada', AE: 'BƏƏ', CN: 'Çin', IN: 'Hindistan', PL: 'Polşa', AM: 'Ermənistan' };
const SOCIAL = /(^|\.)(facebook|fb|instagram|linkedin|lnkd|twitter|x|t|youtube|youtu|tiktok|telegram|whatsapp|vk|ok|pinterest|threads)\.(com|co|in|me|ru|be|net)$|(^|\.)t\.me$/i;
const SEARCH_OTHER = /(^|\.)(bing|yandex|ya|duckduckgo|yahoo|baidu|ecosia|brave)\./i;
const SOURCES = { direct: 'Birbaşa giriş', google: 'Google', social: 'Sosial şəbəkələr', referral: 'Digər saytlar', other: 'Digər' };
const DEVICES = { desktop: 'Masaüstü', mobile: 'Mobil', tablet: 'Planşet' };

function parseUa(ua, sw) {
  let browser = 'Digər';
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera|YaBrowser|SamsungBrowser|UCBrowser/.test(ua)) browser = 'Digər';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = 'Digər';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux|CrOS/.test(ua)) os = 'Linux';
  let device = 'desktop';
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = 'tablet';
  else if (/Mobi|iPhone|iPod|Android/.test(ua)) device = 'mobile';
  else if (os === 'macOS' && sw && sw <= 1366 && /Mobile\//.test(ua)) device = 'tablet';
  return { browser, os, device };
}
function classifySource(refHost, siteHosts, utm) {
  const u = String(utm || '').toLowerCase();
  if (u) {
    if (/google/.test(u)) return 'google';
    if (/facebook|instagram|linkedin|twitter|telegram|whatsapp|youtube|tiktok|social/.test(u)) return 'social';
    return 'other';
  }
  if (!refHost || siteHosts.has(refHost)) return 'direct';
  if (/(^|\.)google\./i.test(refHost)) return 'google';
  if (SOCIAL.test(refHost)) return 'social';
  if (SEARCH_OTHER.test(refHost)) return 'other';
  return 'referral';
}
function saltFor(day) {
  let r = get('SELECT salt FROM analytics_salts WHERE day = ?', day);
  if (!r) {
    run('INSERT OR IGNORE INTO analytics_salts (day, salt) VALUES (?, ?)', day, randomToken(24));
    run('DELETE FROM analytics_salts WHERE day < ?', dayOf(Date.now() - 2 * 86400000));
    r = get('SELECT salt FROM analytics_salts WHERE day = ?', day);
  }
  return r.salt;
}
const siteHosts = () => { const s = new Set(); for (const u of [config.siteUrl, config.baseUrl, ...config.siteOrigins]) { try { s.add(new URL(u).hostname.replace(/^www\./, '')); } catch { /* ignore */ } } return s; };
const cleanPath = (p) => { let s = String(p || '/').split(/[?#]/)[0].slice(0, 300); if (!s.startsWith('/')) s = '/'; return s.replace(/[\x00-\x1f<>"'`\\]/g, ''); };

// Records one event. Returns false when the event is ignored.
function collect(ctx, e) {
  const s = getSetting('analytics');
  if (!s.enabled) return false;
  if (s.respect_dnt && (ctx.req.headers.dnt === '1' || ctx.req.headers['sec-gpc'] === '1')) return false;
  if (ctx.user || !ctx.ua || BOT.test(ctx.ua)) return false; // logged-in staff and robots are not counted
  if (typeof e.sid !== 'string' || !/^[A-Za-z0-9_-]{16,48}$/.test(e.sid)) return false;
  const ts = now(), day = dayOf();
  const id = hmac('sid|' + e.sid).slice(0, 32);
  const path = cleanPath(e.path);
  if (path.startsWith('/admin') || path.startsWith('/api')) return false;
  const existing = get('SELECT id, started_at, pageviews FROM analytics_sessions WHERE id = ?', id);
  if (e.t === 'ping') {
    if (!existing) return false;
    const dur = Math.min(4 * 3600, Math.max(0, Math.round((Date.now() - Date.parse(existing.started_at)) / 1000)));
    run('UPDATE analytics_sessions SET last_at = ?, duration_sec = ? WHERE id = ?', ts, dur, id);
    return true;
  }
  if (existing && existing.pageviews >= 300) return false;
  // One address cannot create an unlimited number of sessions per day (keeps the tables bounded).
  if (!existing && !rateLimit('collect-new', ctx.ip, 300, 86400).ok) return false;
  tx(() => {
    if (!existing) {
      const sw = Math.min(10000, Math.max(0, parseInt(e.sw, 10) || 0)), sh = Math.min(10000, Math.max(0, parseInt(e.sh, 10) || 0));
      const ua = parseUa(ctx.ua, sw);
      let refHost = '';
      try { if (e.ref) refHost = new URL(String(e.ref).slice(0, 500)).hostname.replace(/^www\./, '').toLowerCase().slice(0, 100); } catch { refHost = ''; }
      const hosts = siteHosts();
      const tzName = typeof e.tz === 'string' ? e.tz.slice(0, 40) : '';
      const h = ctx.req.headers;
      const iso = config.geoHeaders.country ? String(h[config.geoHeaders.country] || '').toUpperCase().slice(0, 2) : '';
      const country = iso ? (Object.hasOwn(ISO_COUNTRY, iso) ? ISO_COUNTRY[iso] : iso.replace(/[^A-Z]/g, '')) : (Object.hasOwn(TZ_COUNTRY, tzName) ? TZ_COUNTRY[tzName] : (tzName ? 'Digər' : ''));
      let city = '';
      if (config.geoHeaders.city) { try { city = decodeURIComponent(String(h[config.geoHeaders.city] || '')).replace(/[^\p{L}\s.'-]/gu, '').slice(0, 60); } catch { city = ''; } }
      run(`INSERT INTO analytics_sessions (id, visitor_hash, day, started_at, last_at, landing_page, exit_page, referrer, source, browser, os, device, screen, country, city, lang, is_returning)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, hmac(`${saltFor(day)}|${ctx.ip}|${ctx.ua}`).slice(0, 24), day, ts, ts, path, path, hosts.has(refHost) ? '' : refHost,
      classifySource(refHost, hosts, e.utm), ua.browser, ua.os, ua.device, sw && sh ? `${sw}×${sh}` : '', country, city,
      String(e.lang || '').replace(/[^A-Za-z-]/g, '').slice(0, 10), e.ret ? 1 : 0);
    }
    run('INSERT INTO page_views (session_id, path, title, day, ts) VALUES (?,?,?,?,?)', id, path, String(e.title || '').replace(/[\x00-\x1f]/g, ' ').slice(0, 200), day, ts);
    const started = existing ? existing.started_at : ts;
    run('UPDATE analytics_sessions SET last_at = ?, exit_page = ?, pageviews = pageviews + 1, duration_sec = ? WHERE id = ?', ts, path,
      Math.min(4 * 3600, Math.max(0, Math.round((Date.parse(ts) - Date.parse(started)) / 1000))), id);
  });
  return true;
}

/* ------------------------------------------------------------- reports */
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
const MON = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'İyn', 'İyl', 'Avq', 'Sen', 'Okt', 'Noy', 'Dek'];
const MONF = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun', 'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
const dm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const dmy = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

function range(query) {
  const today = dayOf();
  let to = isDay(query.to) ? query.to : today;
  let from = isDay(query.from) ? query.from : addDays(to, -29);
  if (to > today) to = today;
  if (from > to) from = to;
  if (daysBetween(from, to) > 1830) from = addDays(to, -1829);
  const n = daysBetween(from, to);
  return { from, to, n, prevFrom: addDays(from, -n), prevTo: addDays(from, -1), today };
}
function totals(from, to) {
  const s = get(`SELECT COUNT(*) AS sessions, COALESCE(SUM(is_returning), 0) AS ret, COALESCE(AVG(duration_sec), 0) AS avg_duration,
                        COALESCE(SUM(CASE WHEN pageviews <= 1 THEN 1 ELSE 0 END), 0) AS bounces
                 FROM analytics_sessions WHERE day BETWEEN ? AND ?`, from, to);
  const vis = get('SELECT COALESCE(SUM(v), 0) AS n FROM (SELECT COUNT(DISTINCT visitor_hash) AS v FROM analytics_sessions WHERE day BETWEEN ? AND ? GROUP BY day)', from, to).n;
  const pv = get('SELECT COUNT(*) AS n FROM page_views WHERE day BETWEEN ? AND ?', from, to).n;
  return { visitors: vis, sessions: s.sessions, pageviews: pv, returning: s.ret, new_visitors: Math.max(0, s.sessions - s.ret),
    avg_duration: Math.round(s.avg_duration), bounce_rate: s.sessions ? Math.round((s.bounces / s.sessions) * 1000) / 10 : 0 };
}
const pctChange = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

// Time series for the range: hourly for one day, daily up to 31 days, weekly up to 92, else monthly.
function series(r) {
  const zero = () => ({ visitors: 0, sessions: 0, pageviews: 0, returning: 0 });
  if (r.n === 1) {
    const pts = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, full: `${dmy(r.from)}, ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`, ...zero() }));
    for (const x of all(`SELECT CAST(strftime('%H', started_at, '${TZ}') AS INTEGER) AS h, COUNT(DISTINCT visitor_hash) AS v, COUNT(*) AS s, SUM(is_returning) AS ret FROM analytics_sessions WHERE day = ? GROUP BY h`, r.from)) Object.assign(pts[x.h], { visitors: x.v, sessions: x.s, returning: x.ret });
    for (const x of all(`SELECT CAST(strftime('%H', ts, '${TZ}') AS INTEGER) AS h, COUNT(*) AS n FROM page_views WHERE day = ? GROUP BY h`, r.from)) pts[x.h].pageviews = x.n;
    const lastHour = r.from === r.today ? new Date(Date.now() + config.tzOffsetMin * 60000).getUTCHours() : 23;
    return { bucket: 'hour', points: pts.slice(0, lastHour + 1) };
  }
  const byDay = new Map();
  for (const x of all('SELECT day, COUNT(DISTINCT visitor_hash) AS v, COUNT(*) AS s, SUM(is_returning) AS ret FROM analytics_sessions WHERE day BETWEEN ? AND ? GROUP BY day', r.from, r.to)) byDay.set(x.day, { visitors: x.v, sessions: x.s, returning: x.ret, pageviews: 0 });
  for (const x of all('SELECT day, COUNT(*) AS n FROM page_views WHERE day BETWEEN ? AND ? GROUP BY day', r.from, r.to)) { const o = byDay.get(x.day) || zero(); o.pageviews = x.n; byDay.set(x.day, o); }
  const bucket = r.n <= 31 ? 'day' : r.n <= 92 ? 'week' : 'month';
  const pts = [];
  let cur = null;
  for (let i = 0; i < r.n; i++) {
    const d = addDays(r.from, i), o = byDay.get(d) || zero();
    const key = bucket === 'day' ? d : bucket === 'week' ? Math.floor(i / 7) : d.slice(0, 7);
    if (!cur || cur.key !== key) {
      cur = { key, start: d, end: d, label: bucket === 'month' ? MON[+d.slice(5, 7) - 1] : dm(d), ...zero() };
      pts.push(cur);
    }
    cur.end = d;
    for (const k of ['visitors', 'sessions', 'pageviews', 'returning']) cur[k] += o[k];
  }
  for (const p of pts) {
    p.full = bucket === 'day' ? dmy(p.start) : bucket === 'week' ? `${dmy(p.start)} – ${dmy(p.end)}` : `${MONF[+p.start.slice(5, 7) - 1]} ${p.start.slice(0, 4)}`;
    delete p.key;
  }
  return { bucket, points: pts };
}
function breakdown(col, r, labels, limit = 10) {
  const rows = all(`SELECT ${col} AS k, COUNT(*) AS n FROM analytics_sessions WHERE day BETWEEN ? AND ? GROUP BY ${col} ORDER BY n DESC`, r.from, r.to);
  let out = rows.map((x) => ({ key: x.k || '', label: (labels && Object.hasOwn(labels, x.k) && labels[x.k]) || x.k || 'Naməlum', value: x.n }));
  if (out.length > limit) { const rest = out.slice(limit - 1).reduce((a, b) => a + b.value, 0); out = out.slice(0, limit - 1).concat([{ key: '_rest', label: 'Digər', value: rest }]); }
  return out;
}
const fixedOrder = (items, labels) => Object.keys(labels).map((k) => ({ key: k, label: labels[k], value: (items.find((i) => i.key === k) || { value: 0 }).value }));
function topPages(r, col = 'path', table = 'page_views', limit = 10) {
  if (table === 'page_views') {
    return all('SELECT path AS k, COUNT(*) AS n, MAX(title) AS title FROM page_views WHERE day BETWEEN ? AND ? GROUP BY path ORDER BY n DESC LIMIT ?', r.from, r.to, limit)
      .map((x) => ({ key: x.k, label: x.k, title: x.title, value: x.n }));
  }
  return all(`SELECT ${col} AS k, COUNT(*) AS n FROM analytics_sessions WHERE day BETWEEN ? AND ? GROUP BY ${col} ORDER BY n DESC LIMIT ?`, r.from, r.to, limit).map((x) => ({ key: x.k, label: x.k, value: x.n }));
}
function overview(query) {
  const r = range(query);
  const cur = totals(r.from, r.to), prev = totals(r.prevFrom, r.prevTo);
  const monthStart = r.today.slice(0, 8) + '01';
  return {
    range: { from: r.from, to: r.to, days: r.n },
    totals: cur,
    change: { visitors: pctChange(cur.visitors, prev.visitors), pageviews: pctChange(cur.pageviews, prev.pageviews), sessions: pctChange(cur.sessions, prev.sessions) },
    all_time_visitors: get('SELECT COALESCE(SUM(v), 0) AS n FROM (SELECT COUNT(DISTINCT visitor_hash) AS v FROM analytics_sessions GROUP BY day)').n,
    today_visitors: totals(r.today, r.today).visitors,
    yesterday_visitors: totals(addDays(r.today, -1), addDays(r.today, -1)).visitors,
    month_visitors: totals(monthStart, r.today).visitors,
    series: series(r),
    sources: fixedOrder(breakdown('source', r, SOURCES, 20), SOURCES),
    devices: fixedOrder(breakdown('device', r, DEVICES, 20), DEVICES),
    browsers: breakdown('browser', r, null, 6),
    systems: breakdown('os', r, null, 6),
    countries: all("SELECT country AS c, city AS ci, COUNT(*) AS n FROM analytics_sessions WHERE day BETWEEN ? AND ? GROUP BY country, city ORDER BY n DESC LIMIT 15", r.from, r.to).map((x) => ({ country: x.c || 'Naməlum', city: x.ci || '—', value: x.n })),
    pages: topPages(r),
    landing: topPages(r, 'landing_page', 'analytics_sessions'),
    exits: topPages(r, 'exit_page', 'analytics_sessions'),
    referrers: all("SELECT referrer AS k, COUNT(*) AS n FROM analytics_sessions WHERE day BETWEEN ? AND ? AND referrer <> '' GROUP BY referrer ORDER BY n DESC LIMIT 10", r.from, r.to).map((x) => ({ label: x.k, value: x.n })),
  };
}
function purge() {
  const s = getSetting('analytics');
  const before = dayOf(Date.now() - (s.retention_days || 400) * 86400000);
  run('DELETE FROM analytics_sessions WHERE day < ?', before); // page_views go with them (ON DELETE CASCADE)
  run('DELETE FROM page_views WHERE day < ?', before);
}

module.exports = { collect, overview, range, totals, purge, SOURCES, DEVICES, addDays, parseUa, classifySource, MON };
