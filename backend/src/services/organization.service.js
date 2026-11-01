// Organization / Tenant management service.
const { db } = require('../db');
const { ConflictError, NotFoundError, ValidationError } = require('../errors/app-error');
const { normalizeEmail, hashPassword } = require('../security/jwt');

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

/**
 * Transactional organization onboarding:
 * Creates organization and initial ORG_ADMIN membership.
 * Rolls back atomically if any step fails.
 */
async function onboardOrganization({ name, slug, adminName, adminEmail, adminPassword }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ValidationError('Organization name is required');
  }
  if (!adminEmail || typeof adminEmail !== 'string') {
    throw new ValidationError('Admin email is required');
  }
  if (!adminPassword || typeof adminPassword !== 'string' || adminPassword.length < 8) {
    throw new ValidationError('Admin password must be at least 8 characters long');
  }

  const normEmail = normalizeEmail(adminEmail);
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
  if (existingUser) {
    throw new ConflictError('A user with this email already exists', 'EMAIL_IN_USE');
  }

  const cleanSlug = (slug || name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!cleanSlug) {
    throw new ValidationError('Valid organization slug is required');
  }

  const existingOrg = findOrganizationBySlug(cleanSlug);
  if (existingOrg) {
    throw new ConflictError(`Organization with slug "${cleanSlug}" already exists`, 'SLUG_IN_USE');
  }

  const passwordHash = await hashPassword(adminPassword);
  let newOrgId;
  let newAdminId;

  const runOnboardingTx = db.transaction(() => {
    const orgRes = db.prepare(`
      INSERT INTO organizations (name, slug, status)
      VALUES (?, ?, 'ACTIVE')
    `).run(name.trim(), cleanSlug);
    newOrgId = orgRes.lastInsertRowid;

    const userRes = db.prepare(`
      INSERT INTO users (email, password_hash, name, role, organization_id, status)
      VALUES (?, ?, ?, 'ORG_ADMIN', ?, 'ACTIVE')
    `).run(normEmail, passwordHash, (adminName || `${name.trim()} Admin`).trim(), newOrgId);
    newAdminId = userRes.lastInsertRowid;
  });

  runOnboardingTx();

  const org = findOrganizationById(newOrgId);
  const admin = db.prepare(`
    SELECT id, email, name, role, organization_id, status, created_at
    FROM users WHERE id = ?
  `).get(newAdminId);

  return {
    organization: org,
    admin
  };
}

module.exports = {
  findOrganizationById,
  findOrganizationBySlug,
  listOrganizations,
  createOrganization,
  updateOrganization,
  getOrCreateDefaultOrganization,
  onboardOrganization
};
