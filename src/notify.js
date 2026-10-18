'use strict';
// In-panel notifications and e-mail alerts for new requests.
const config = require('./config');
const { run, all, now } = require('./db');
const { usersWith } = require('./permissions');
const { getSetting } = require('./settings');
const { queueMail } = require('./mail');
const { rateLimit } = require('./security');
// At most 40 notification e-mails per hour in total, so a flood of form submissions cannot flood
// the mailbox. Requests are still stored and shown in the panel.
const mailAllowed = () => rateLimit('notify-mail', 'all', 40, 3600).ok;

function notify(perm, { type, title, body = '', link = '' }, exceptUserId) {
  for (const u of usersWith(perm)) {
    if (u.id === exceptUserId) continue;
    run('INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES (?,?,?,?,?,?)', u.id, type, title.slice(0, 200), body.slice(0, 400), link, now());
  }
}
function recipients(perm) {
  const s = getSetting('notifications');
  if (s.emails && s.emails.length) return s.emails;
  // Fallback: Super Admins, so that a new request is never missed before the list is configured.
  return all("SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1 AND r.key = 'super_admin'").map((r) => r.email);
}
const fmtDate = (iso) => new Date(Date.parse(iso) + config.tzOffsetMin * 60000).toISOString().replace('T', ' ').slice(0, 16);

function newLead(lead) {
  const name = `${lead.first_name} ${lead.last_name}`.trim();
  const link = `#/layihe-sorgulari/${lead.id}`;
  notify('leads.view', { type: 'new_lead', title: 'Yeni layihə sorğusu', body: `${name} — ${lead.project_name || lead.company || lead.email}`, link });
  const s = getSetting('notifications');
  if (!s.email_on_lead || !mailAllowed()) return;
  const text = [
    'Saytdan yeni "Layihənizi müzakirə edək" sorğusu daxil olub.', '',
    `Ad, soyad: ${name}`, `Şirkət: ${lead.company || '—'}`, `Vəzifə: ${lead.position || '—'}`, `E-poçt: ${lead.email}`, `Telefon: ${lead.phone || '—'}`,
    `Layihə: ${lead.project_name || '—'}`, `İstiqamət: ${lead.direction || '—'}`, `Büdcə: ${lead.budget || '—'}`, '',
    'Qısa təsvir:', lead.description || '—', '',
    `Göndərilmə tarixi: ${fmtDate(lead.created_at)} (Bakı vaxtı)`, '',
    `Sorğuya baxmaq üçün: ${config.baseUrl}/admin/${link}`, '',
    'Bu məktub avtomatik göndərilib.',
  ].join('\n');
  queueMail({ to: recipients('leads.view'), subject: s.lead_subject, text, replyTo: lead.email });
}
function newContact(c) {
  const link = `#/elaqe-sorgulari/${c.id}`;
  notify('contacts.view', { type: 'new_contact', title: 'Yeni əlaqə sorğusu', body: `${c.name} — ${c.subject || c.email}`, link });
  const s = getSetting('notifications');
  if (!s.email_on_contact || !mailAllowed()) return;
  const text = [
    'Saytın əlaqə formasından yeni müraciət daxil olub.', '',
    `Ad: ${c.name}`, `Şirkət: ${c.company || '—'}`, `E-poçt: ${c.email}`, `Telefon: ${c.phone || '—'}`, `Mövzu: ${c.subject || '—'}`, '',
    'Mesaj:', c.message || '—', '',
    `Göndərilmə tarixi: ${fmtDate(c.created_at)} (Bakı vaxtı)`, '',
    `Müraciətə baxmaq üçün: ${config.baseUrl}/admin/${link}`, '',
    'Bu məktub avtomatik göndərilib.',
  ].join('\n');
  queueMail({ to: recipients('contacts.view'), subject: s.contact_subject, text, replyTo: c.email });
}
const systemAlert = (title, body, link = '') => notify('settings.manage', { type: 'system', title, body, link });

module.exports = { notify, newLead, newContact, systemAlert, fmtDate };
