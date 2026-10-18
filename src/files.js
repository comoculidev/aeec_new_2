'use strict';
// File uploads. Rules applied to every upload:
// - extension allow-list, per-type size limit, and a content ("magic bytes") check so that a
//   renamed file is rejected;
// - files are stored under random names, never under the name supplied by the user;
// - SVG files are rejected if they contain scripts or event handlers;
// - private files (documents, request attachments) are only reachable through authenticated,
//   permission-checked download routes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { get, run, now } = require('./db');
const { err } = require('./http');
const { cleanString } = require('./validate');

const MB = 1024 * 1024;
const ascii = (b, start, len) => b.subarray(start, start + len).toString('latin1');
const zipHas = (b, name) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && b.includes(Buffer.from(name, 'latin1'));
// Checked against a copy of the file in which every run of whitespace is a single space, so the
// optional-space parts below cannot backtrack.
const SVG_BAD = /<script|<foreignObject|<iframe|<embed|<object|<!ENTITY|<!DOCTYPE|<\?xml-stylesheet|[ /"']on[a-z]{1,30} ?=|javascript:|&#|@import|url\( ?["']? ?(?:https?:|\/\/)|href ?= ?["']? ?(?:https?:|\/\/|data:(?!image\/(?:png|jpe?g|gif|webp)[;,]))/i;

const TYPES = {
  jpg: { mime: 'image/jpeg', kind: 'image', max: 10, ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: 'image/png', kind: 'image', max: 10, ok: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  webp: { mime: 'image/webp', kind: 'image', max: 10, ok: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' },
  gif: { mime: 'image/gif', kind: 'image', max: 10, ok: (b) => /^GIF8[79]a$/.test(ascii(b, 0, 6)) },
  svg: { mime: 'image/svg+xml', kind: 'image', max: 1, ok: (b) => { const t = b.toString('utf8').replace(/\s+/g, ' '); return /<svg[ >]/i.test(t) && !SVG_BAD.test(t) && !t.includes(String.fromCharCode(0)); } },
  pdf: { mime: 'application/pdf', kind: 'file', max: 1000, ok: (b) => ascii(b, 0, 5) === '%PDF-' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'file', max: 1000, ok: (b) => zipHas(b, 'word/') },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'file', max: 1000, ok: (b) => zipHas(b, 'xl/') },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'file', max: 1000, ok: (b) => zipHas(b, 'ppt/') },
  mp4: { mime: 'video/mp4', kind: 'video', max: 1000, ok: (b) => ascii(b, 4, 4) === 'ftyp' },
  webm: { mime: 'video/webm', kind: 'video', max: 1000, ok: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
};
const ALIASES = { jpeg: 'jpg' };
const MEDIA_EXT = Object.keys(TYPES);
const DOC_EXT = ['pdf', 'docx', 'xlsx', 'pptx', 'jpg', 'png'];
const REQUEST_EXT = ['pdf', 'docx', 'xlsx', 'jpg', 'png'];
const INLINE_EXT = new Set(['jpg', 'png', 'webp', 'gif', 'svg', 'pdf', 'mp4', 'webm']);

const dirOf = (isPrivate) => (isPrivate ? config.privateDir : config.uploadDir);

// file: a File object from FormData. Returns the inserted media row.
async function storeUpload(file, { allowed = MEDIA_EXT, isPrivate = false, userId = null, folder = '', maxMb = config.maxUploadMb } = {}) {
  if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') throw err(422, 'Fayl seçilməyib');
  const original = cleanString(file.name || 'fayl', false).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150) || 'fayl';
  let ext = path.extname(original).slice(1).toLowerCase();
  if (Object.hasOwn(ALIASES, ext)) ext = ALIASES[ext];
  const type = Object.hasOwn(TYPES, ext) ? TYPES[ext] : null;
  if (!type || !allowed.includes(ext)) throw err(422, `Bu fayl növü qəbul edilmir. İcazəli: ${allowed.join(', ').toUpperCase()}`);
  const limit = Math.min(maxMb, type.max) * MB;
  if (file.size > limit) throw err(413, `Fayl çox böyükdür (ən çox ${Math.min(maxMb, type.max)} MB)`);
  if (file.size === 0) throw err(422, 'Fayl boşdur');
  const buf = Buffer.from(await file.arrayBuffer());
  if (!type.ok(buf)) throw err(422, 'Faylın məzmunu uzantısına uyğun deyil və ya təhlükəli məzmun var');
  const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(dirOf(isPrivate), stored), buf, { mode: 0o640, flag: 'wx' });
  const id = run('INSERT INTO media (kind, original_name, stored_name, mime, ext, size, folder, is_private, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    type.kind, original, stored, type.mime, ext, buf.length, cleanString(folder, false).slice(0, 60), isPrivate ? 1 : 0, userId, now()).lastInsertRowid;
  return get('SELECT * FROM media WHERE id = ?', id);
}
function removeMedia(m) {
  if (!m) return;
  run('DELETE FROM media WHERE id = ?', m.id);
  if (/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(m.stored_name)) fs.rm(path.join(dirOf(m.is_private), m.stored_name), { force: true }, () => {});
}
const mediaUrl = (m) => (m && !m.is_private ? `/media/${m.stored_name}` : null);
function mediaById(id) {
  if (!id) return null;
  const m = get('SELECT * FROM media WHERE id = ? AND is_private = 0', id);
  return m ? { id: m.id, url: mediaUrl(m), name: m.original_name, alt: m.alt, kind: m.kind, mime: m.mime, size: m.size } : null;
}
const mediaList = (ids) => (Array.isArray(ids) ? ids.map(mediaById).filter(Boolean) : []);

module.exports = { TYPES, MEDIA_EXT, DOC_EXT, REQUEST_EXT, INLINE_EXT, storeUpload, removeMedia, mediaUrl, mediaById, mediaList, dirOf, MB };
