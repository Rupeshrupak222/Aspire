// Organization / Tenant management service.
const { db } = require('../db');
const { ConflictError, NotFoundError, ValidationError } = require('../errors/app-error');

function findOrganizationById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) || null;
}

function findOrganizationBySlug(slug) {
  if (!slug) return null;
  return db.prepare('SELECT * FROM organizations WHERE slug = ?').get(slug.toLowerCase().trim()) || null;
}

function listOrganizations() {
  return db.prepare('SELECT id, name, slug, status, created_at, updated_at FROM organizations ORDER BY id').all();
}

function createOrganization({ name, slug, status = 'ACTIVE' }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ValidationError('Organization name is required');
  }
  const cleanSlug = (slug || name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!cleanSlug) {
    throw new ValidationError('Valid organization slug is required');
  }

  const existing = findOrganizationBySlug(cleanSlug);
  if (existing) {
    throw new ConflictError(`Organization with slug "${cleanSlug}" already exists`, 'SLUG_IN_USE');
  }

  const result = db.prepare(`
    INSERT INTO organizations (name, slug, status)
    VALUES (?, ?, ?)
  `).run(name.trim(), cleanSlug, status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE');

  return findOrganizationById(result.lastInsertRowid);
}

function updateOrganization(id, { name, status }) {
  const org = findOrganizationById(id);
  if (!org) throw new NotFoundError('Organization not found');

  const newName = name !== undefined ? String(name).trim() : org.name;
  const newStatus = status !== undefined ? (status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE') : org.status;

  db.prepare(`
    UPDATE organizations
    SET name = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newName, newStatus, id);

  return findOrganizationById(id);
}

function getOrCreateDefaultOrganization() {
  let org = db.prepare('SELECT * FROM organizations ORDER BY id ASC LIMIT 1').get();
  if (!org) {
    const res = db.prepare(`
      INSERT INTO organizations (name, slug, status)
      VALUES ('Adyapan Academy', 'adyapan', 'ACTIVE')
    `).run();
    org = findOrganizationById(res.lastInsertRowid);
  }
  return org;
}

module.exports = {
  findOrganizationById,
  findOrganizationBySlug,
  listOrganizations,
  createOrganization,
  updateOrganization,
  getOrCreateDefaultOrganization
};
