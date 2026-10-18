'use strict';
// Module-based permission catalogue and the four built-in roles.
const { get, all, run, tx, now } = require('./db');

// [key, module label, permission label]
const PERMISSIONS = [
  ['dashboard.view', 'İdarə paneli', 'Baxış'],
  ['analytics.view', 'Analitika', 'Baxış'], ['analytics.export', 'Analitika', 'Eksport'],
  ['leads.view', 'Layihə sorğuları', 'Baxış'], ['leads.edit', 'Layihə sorğuları', 'Redaktə (status, qeyd, cavab)'],
  ['leads.delete', 'Layihə sorğuları', 'Silmə'], ['leads.export', 'Layihə sorğuları', 'Eksport'],
  ['contacts.view', 'Əlaqə sorğuları', 'Baxış'], ['contacts.edit', 'Əlaqə sorğuları', 'Redaktə (status, cavab)'],
  ['contacts.delete', 'Əlaqə sorğuları', 'Silmə'], ['contacts.export', 'Əlaqə sorğuları', 'Eksport'],
  ['news.view', 'Xəbərlər', 'Baxış'], ['news.create', 'Xəbərlər', 'Yaratma'], ['news.edit', 'Xəbərlər', 'Redaktə'], ['news.delete', 'Xəbərlər', 'Silmə'],
  ['projects.view', 'Layihələr', 'Baxış'], ['projects.create', 'Layihələr', 'Yaratma'], ['projects.edit', 'Layihələr', 'Redaktə'], ['projects.delete', 'Layihələr', 'Silmə'],
  ['services.view', 'Xidmətlər', 'Baxış'], ['services.create', 'Xidmətlər', 'Yaratma'], ['services.edit', 'Xidmətlər', 'Redaktə'], ['services.delete', 'Xidmətlər', 'Silmə'],
  ['company.view', 'Şirkət məlumatları', 'Baxış'], ['company.edit', 'Şirkət məlumatları', 'Redaktə'],
  ['team.view', 'Komanda', 'Baxış'], ['team.create', 'Komanda', 'Yaratma'], ['team.edit', 'Komanda', 'Redaktə'], ['team.delete', 'Komanda', 'Silmə'],
  ['documents.view', 'Sənədlər', 'Baxış'], ['documents.create', 'Sənədlər', 'Yükləmə'], ['documents.edit', 'Sənədlər', 'Redaktə'], ['documents.delete', 'Sənədlər', 'Silmə'],
  ['media.view', 'Media kitabxanası', 'Baxış'], ['media.upload', 'Media kitabxanası', 'Yükləmə'], ['media.edit', 'Media kitabxanası', 'Redaktə'], ['media.delete', 'Media kitabxanası', 'Silmə'],
  ['users.view', 'İstifadəçilər', 'Baxış'], ['users.manage', 'İstifadəçilər', 'İdarəetmə'],
  ['roles.manage', 'Rollar', 'İcazələrin idarəsi'],
  ['settings.view', 'Tənzimləmələr', 'Baxış'], ['settings.manage', 'Tənzimləmələr', 'Dəyişmə'],
  ['seo.manage', 'SEO', 'İdarəetmə'],
  ['backup.manage', 'Ehtiyat nüsxə', 'İdarəetmə'],
  ['audit.view', 'Audit jurnalı', 'Baxış (yalnız Super Admin)'],
];
// These can never be granted to a role other than Super Admin.
const SUPER_ONLY = new Set(['audit.view', 'roles.manage', 'backup.manage']);

const allKeys = PERMISSIONS.map((p) => p[0]);
const except = (...deny) => allKeys.filter((k) => !deny.includes(k) && !SUPER_ONLY.has(k));
const content = ['news', 'projects', 'services', 'team', 'documents'].flatMap((m) => ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`))
  .concat(['company.view', 'company.edit', 'media.view', 'media.upload', 'media.edit', 'media.delete']);

const ROLES = [
  { key: 'super_admin', name: 'Super Admin', description: 'Tam giriş. Audit jurnalı, rollar və ehtiyat nüsxə yalnız bu rolda.', perms: allKeys },
  { key: 'administrator', name: 'Administrator', description: 'Əsas idarəetmə funksiyaları.', perms: except('users.manage') },
  { key: 'editor', name: 'Editor', description: 'Xəbərlər, layihələr, xidmətlər və məzmun.', perms: ['dashboard.view', 'analytics.view', 'leads.view', 'contacts.view', ...content] },
  { key: 'viewer', name: 'Viewer', description: 'Yalnız baxış.', perms: allKeys.filter((k) => k.endsWith('.view') && !SUPER_ONLY.has(k) && !['users.view', 'settings.view'].includes(k)) },
];

function seedPermissions() {
  tx(() => {
    PERMISSIONS.forEach(([key, module, label], i) => {
      run('INSERT INTO permissions (key, module, label, sort) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET module=excluded.module, label=excluded.label, sort=excluded.sort', key, module, label, i);
    });
    for (const r of ROLES) {
      if (get('SELECT id FROM roles WHERE key = ?', r.key)) continue; // never overwrite customised roles
      const id = run('INSERT INTO roles (key, name, description, is_system, created_at) VALUES (?,?,?,1,?)', r.key, r.name, r.description, now()).lastInsertRowid;
      for (const k of r.perms) run('INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE key = ?', id, k);
    }
  });
}

function permsForRole(role) {
  if (!role) return new Set();
  if (role.key === 'super_admin') return new Set(allKeys);
  return new Set(all('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?', role.id)
    .map((r) => r.key).filter((k) => !SUPER_ONLY.has(k)));
}
// Users holding a permission (for notifications).
function usersWith(perm) {
  return all(`SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
              WHERE u.is_active = 1 AND (r.key = 'super_admin' OR EXISTS (
                SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id AND p.key = ?))`, perm);
}

module.exports = { PERMISSIONS, SUPER_ONLY, ROLES, seedPermissions, permsForRole, usersWith };
