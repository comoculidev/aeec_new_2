'use strict';
// Input validation. Every API body goes through a schema: unknown keys are dropped, strings are
// cleaned (control characters removed, length-limited), and field errors are reported together.
const { err } = require('./http');

class VErr extends Error {}
const fail = (m) => { throw new VErr(m); };
const missing = (x) => x === undefined || x === null || x === '';

// Control characters, zero-width space, line/paragraph separators and BOM are never kept.
const CTRL_MULTI = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B\\u2028\\u2029\\uFEFF]', 'g');
const CTRL_LINE = new RegExp('[\\u0000-\\u001F\\u007F\\u200B\\u2028\\u2029\\uFEFF]', 'g');
function cleanString(s, multiline) {
  s = String(s).normalize('NFC').replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(CTRL_MULTI, '') : s.replace(CTRL_LINE, ' ');
  return s.trim();
}

const v = {
  str: (o = {}) => (x) => {
    if (missing(x)) { if (o.required) fail('Bu sahə mütləqdir'); return o.default !== undefined ? o.default : ''; }
    if (typeof x !== 'string' && typeof x !== 'number') fail('Mətn gözlənilir');
    const s = cleanString(x, o.multiline);
    if (!s && o.required) fail('Bu sahə mütləqdir');
    if (s.length > (o.max || 255)) fail(`Ən çox ${o.max || 255} simvol`);
    if (o.min && s.length < o.min) fail(`Ən azı ${o.min} simvol`);
    if (o.pattern && s && !o.pattern.test(s)) fail(o.message || 'Format düzgün deyil');
    return s;
  },
  text: (o = {}) => v.str({ max: 20000, ...o, multiline: true }),
  email: (o = {}) => (x) => {
    const s = v.str({ max: 254, required: o.required })(x).toLowerCase();
    // Conservative on purpose: characters such as ? & % = are refused so an address can never
    // carry extra mailto: parameters or header-like content.
    if (s && !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){1,6}$/i.test(s)) fail('E-poçt ünvanı düzgün deyil');
    return s;
  },
  phone: (o = {}) => (x) => {
    const s = v.str({ max: 40, required: o.required })(x);
    if (s && !/^[+()\d\s.-]{5,40}$/.test(s)) fail('Telefon nömrəsi düzgün deyil');
    return s;
  },
  url: (o = {}) => (x) => {
    const s = v.str({ max: 500, required: o.required })(x);
    if (!s) return s;
    let u;
    try { u = new URL(s); } catch { fail('Keçid düzgün deyil (https://… ilə başlamalıdır)'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('Yalnız http/https keçidləri');
    return s;
  },
  slug: (o = {}) => (x) => {
    const s = v.str({ max: 120, required: o.required })(x).toLowerCase();
    if (s && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) fail('Yalnız kiçik latın hərfləri, rəqəm və tire');
    return s;
  },
  int: (o = {}) => (x) => {
    if (missing(x)) { if (o.required) fail('Bu sahə mütləqdir'); return o.default !== undefined ? o.default : null; }
    const n = typeof x === 'number' ? x : /^-?\d{1,12}$/.test(String(x).trim()) ? parseInt(x, 10) : NaN;
    if (!Number.isInteger(n)) fail('Tam ədəd gözlənilir');
    if (o.min !== undefined && n < o.min) fail(`Ən azı ${o.min}`);
    if (o.max !== undefined && n > o.max) fail(`Ən çox ${o.max}`);
    return n;
  },
  bool: (o = {}) => (x) => {
    if (missing(x)) return o.default ? 1 : 0;
    if (x === true || x === 1 || x === '1' || x === 'true' || x === 'on') return 1;
    if (x === false || x === 0 || x === '0' || x === 'false') return 0;
    fail('Bəli/xeyr gözlənilir');
  },
  oneOf: (values, o = {}) => (x) => {
    if (missing(x)) { if (o.required) fail('Bu sahə mütləqdir'); return o.default !== undefined ? o.default : ''; }
    if (!values.includes(x)) fail('Yolverilməz dəyər');
    return x;
  },
  date: (o = {}) => (x) => {
    if (missing(x)) { if (o.required) fail('Bu sahə mütləqdir'); return null; }
    const s = String(x).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) fail('Tarix düzgün deyil');
    return s;
  },
  datetime: (o = {}) => (x) => {
    if (missing(x)) { if (o.required) fail('Bu sahə mütləqdir'); return null; }
    const t = Date.parse(String(x));
    if (Number.isNaN(t)) fail('Tarix düzgün deyil');
    return new Date(t).toISOString();
  },
  arr: (item, o = {}) => (x) => {
    if (missing(x)) return [];
    if (!Array.isArray(x)) fail('Siyahı gözlənilir');
    if (x.length > (o.max || 50)) fail(`Ən çox ${o.max || 50} element`);
    return x.map((e) => item(e)).filter((e) => !(o.dropEmpty !== false && (e === '' || e === null)));
  },
  obj: (shape) => (x) => {
    if (missing(x)) return check(shape, {});
    if (typeof x !== 'object' || Array.isArray(x)) fail('Obyekt gözlənilir');
    return check(shape, x);
  },
  // Translations: { en: {field: …}, ru: {field: …} } - same rules as the base fields, all optional.
  i18n: (shape, langs = ['en', 'ru']) => (x) => {
    const out = {};
    if (missing(x)) return out;
    if (typeof x !== 'object' || Array.isArray(x)) fail('Obyekt gözlənilir');
    for (const l of langs) {
      if (x[l] && typeof x[l] === 'object') {
        const c = check(shape, x[l]);
        for (const k of Object.keys(c)) if (c[k] === '' || c[k] === null || (Array.isArray(c[k]) && !c[k].length)) delete c[k];
        if (Object.keys(c).length) out[l] = c;
      }
    }
    return out;
  },
};

function check(shape, input, opts = {}) {
  const out = {}, fields = {};
  for (const [k, fn] of Object.entries(shape)) {
    if (opts.partial && !(k in input)) continue;
    try { out[k] = fn(input[k]); }
    catch (e) {
      if (e instanceof VErr) fields[k] = e.message;
      else if (e.fields) for (const [fk, fm] of Object.entries(e.fields)) fields[`${k}.${fk}`] = fm;
      else throw e;
    }
  }
  if (Object.keys(fields).length) throw err(422, 'Məlumatlar düzgün deyil', { fields });
  return out;
}
const validate = (shape, input, opts) => check(shape, input && typeof input === 'object' ? input : {}, opts);

module.exports = { v, validate, cleanString };
