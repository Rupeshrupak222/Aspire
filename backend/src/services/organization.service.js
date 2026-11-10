// Organization / Tenant management service.
const { db } = require('../db');
const { ConflictError, NotFoundError, ValidationError, AuthorizationError } = require('../errors/app-error');
const { normalizeEmail, hashPassword } = require('../security/jwt');
const { deleteAllUserSessions } = require('./session.service');

function deserializeOrg(org) {
  if (!org) return null;
  let certificateBranding = {};
  if (org.certificate_branding_json) {
    try {
      certificateBranding = JSON.parse(org.certificate_branding_json);
    } catch {
      certificateBranding = {};
    }
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    email: org.email || null,
    phone: org.phone || null,
    website: org.website || null,
    logo_url: org.logo_url || null,
    primary_color: org.primary_color || '#0B1F3A',
    secondary_color: org.secondary_color || '#13294B',
    accent_color: org.accent_color || '#F97316',
    timezone: org.timezone || 'Asia/Kolkata',
    certificate_branding: certificateBranding,
    created_by: org.created_by || null,
    updated_by: org.updated_by || null,
    created_at: org.created_at,
    updated_at: org.updated_at
  };
}

function findOrganizationById(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
  return deserializeOrg(row);
}

function findOrganizationBySlug(slug) {
  if (!slug) return null;
  const row = db.prepare('SELECT * FROM organizations WHERE slug = ?').get(String(slug).toLowerCase().trim());
  return deserializeOrg(row);
}

function findOrganizationByEmail(email) {
  if (!email) return null;
  const norm = normalizeEmail(email);
  const row = db.prepare('SELECT * FROM organizations WHERE email = ?').get(norm);
  return deserializeOrg(row);
}

function listOrganizations() {
  const rows = db.prepare('SELECT * FROM organizations ORDER BY id ASC').all();
  return rows.map(deserializeOrg);
}

/**
 * Paginated, searchable, and filtered organization listing for SUPER_ADMIN.
 */
function listOrganizationsPaginated({
  page = 1,
  limit = 10,
  search = '',
  status = 'ALL',
  sort = 'id',
  order = 'asc'
} = {}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];
  const params = [];

  if (search && search.trim()) {
    const term = `%${search.trim().toLowerCase()}%`;
    conditions.push('(LOWER(name) LIKE ? OR LOWER(slug) LIKE ? OR LOWER(email) LIKE ?)');
    params.push(term, term, term);
  }

  if (status && status !== 'ALL') {
    conditions.push('status = ?');
    params.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = db.prepare(`SELECT count(*) as count FROM organizations ${whereClause}`).get(...params);
  const total = totalRow ? totalRow.count : 0;
  const totalPages = Math.ceil(total / safeLimit) || 1;

  const allowedSortCols = {
    id: 'id',
    name: 'name',
    status: 'status',
    created_at: 'created_at'
  };
  const sortCol = allowedSortCols[sort] || 'id';
  const sortOrder = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const rows = db.prepare(`
    SELECT * FROM organizations
    ${whereClause}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);

  return {
    data: rows.map(deserializeOrg),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages
    }
  };
}

/**
 * Creates a new organization with complete profile & branding metadata.
 */
function createOrganization({
  name,
  slug,
  email = null,
  phone = null,
  website = null,
  timezone = 'Asia/Kolkata',
  logo_url = null,
  primary_color = '#0B1F3A',
  secondary_color = '#13294B',
  accent_color = '#F97316',
  certificate_branding = {},
  status = 'ACTIVE',
  created_by = null
}) {
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

  const existingSlug = findOrganizationBySlug(cleanSlug);
  if (existingSlug) {
    throw new ConflictError(`Organization with slug "${cleanSlug}" already exists`, 'SLUG_IN_USE');
  }

  const normEmail = email ? normalizeEmail(email) : null;
  if (normEmail) {
    const existingEmail = findOrganizationByEmail(normEmail);
    if (existingEmail) {
      throw new ConflictError(`Organization with email "${normEmail}" already exists`, 'EMAIL_IN_USE');
    }
  }

  const brandingJson = typeof certificate_branding === 'object' && certificate_branding !== null
    ? JSON.stringify(certificate_branding)
    : '{}';

  const validStatus = status === 'SUSPENDED' || status === 'DISABLED' ? 'SUSPENDED' : 'ACTIVE';

  const result = db.prepare(`
    INSERT INTO organizations (
      name, slug, status, email, phone, website, logo_url,
      primary_color, secondary_color, accent_color, certificate_branding_json,
      timezone, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    cleanSlug,
    validStatus,
    normEmail,
    phone ? String(phone).trim() : null,
    website ? String(website).trim() : null,
    logo_url ? String(logo_url).trim() : null,
    primary_color || '#0B1F3A',
    secondary_color || '#13294B',
    accent_color || '#F97316',
    brandingJson,
    timezone || 'Asia/Kolkata',
    created_by || null,
    created_by || null
  );

  const orgId = result.lastInsertRowid;
  try {
    const plan = db.prepare("SELECT * FROM subscription_plans WHERE code = 'ENTERPRISE'").get()
              || db.prepare("SELECT * FROM subscription_plans WHERE is_active = 1 ORDER BY id ASC LIMIT 1").get();
    if (plan) {
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
      db.prepare(`
        INSERT INTO organization_subscriptions (
          organization_id, plan_id, status, starts_at, current_period_start, current_period_end, created_at, updated_at
        ) VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
      `).run(orgId, plan.id, now.toISOString(), periodStart, periodEnd, now.toISOString(), now.toISOString());
    }
  } catch (err) {}

  return findOrganizationById(orgId);
}

/**
 * Updates an organization's profile, branding, and metadata.
 */
function updateOrganization(id, updates = {}, { actorId = null, isSuperAdmin = false } = {}) {
  const org = findOrganizationById(id);
  if (!org) throw new NotFoundError('Organization not found');

  const fields = [];
  const params = [];

  if (updates.name !== undefined) {
    const cleanName = String(updates.name).trim();
    if (!cleanName) throw new ValidationError('Organization name cannot be empty');
    fields.push('name = ?');
    params.push(cleanName);
  }

  if (isSuperAdmin && updates.slug !== undefined) {
    const cleanSlug = String(updates.slug).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!cleanSlug) throw new ValidationError('Organization slug cannot be empty');
    const existing = findOrganizationBySlug(cleanSlug);
    if (existing && existing.id !== org.id) {
      throw new ConflictError(`Slug "${cleanSlug}" is already in use by another organization`, 'SLUG_IN_USE');
    }
    fields.push('slug = ?');
    params.push(cleanSlug);
  }

  if (updates.email !== undefined) {
    const normEmail = updates.email ? normalizeEmail(updates.email) : null;
    if (normEmail) {
      const existing = findOrganizationByEmail(normEmail);
      if (existing && existing.id !== org.id) {
        throw new ConflictError(`Email "${normEmail}" is already in use by another organization`, 'EMAIL_IN_USE');
      }
    }
    fields.push('email = ?');
    params.push(normEmail);
  }

  if (updates.phone !== undefined) {
    fields.push('phone = ?');
    params.push(updates.phone ? String(updates.phone).trim() : null);
  }

  if (updates.website !== undefined) {
    fields.push('website = ?');
    params.push(updates.website ? String(updates.website).trim() : null);
  }

  if (updates.timezone !== undefined) {
    fields.push('timezone = ?');
    params.push(String(updates.timezone).trim());
  }

  if (updates.logo_url !== undefined) {
    fields.push('logo_url = ?');
    params.push(updates.logo_url ? String(updates.logo_url).trim() : null);
  }

  if (updates.primary_color !== undefined) {
    fields.push('primary_color = ?');
    params.push(updates.primary_color);
  }

  if (updates.secondary_color !== undefined) {
    fields.push('secondary_color = ?');
    params.push(updates.secondary_color);
  }

  if (updates.accent_color !== undefined) {
    fields.push('accent_color = ?');
    params.push(updates.accent_color);
  }

  if (updates.certificate_branding !== undefined) {
    const mergedBranding = {
      ...(org.certificate_branding || {}),
      ...(updates.certificate_branding || {})
    };
    fields.push('certificate_branding_json = ?');
    params.push(JSON.stringify(mergedBranding));
  }

  if (isSuperAdmin && updates.status !== undefined) {
    const newStatus = updates.status === 'SUSPENDED' || updates.status === 'DISABLED' ? 'SUSPENDED' : 'ACTIVE';
    fields.push('status = ?');
    params.push(newStatus);
  }

  if (fields.length === 0) {
    return org;
  }

  fields.push("updated_at = datetime('now')");
  if (actorId) {
    fields.push('updated_by = ?');
    params.push(actorId);
  }

  params.push(id);

  db.prepare(`
    UPDATE organizations
    SET ${fields.join(', ')}
    WHERE id = ?
  `).run(...params);

  // Invalidate certificate cache if branding was touched
  if (
    updates.primary_color !== undefined ||
    updates.secondary_color !== undefined ||
    updates.accent_color !== undefined ||
    updates.logo_url !== undefined ||
    updates.certificate_branding !== undefined
  ) {
    try {
      const { clearCertificateCache } = require('./certificate');
      clearCertificateCache();
    } catch {}
  }

  return findOrganizationById(id);
}

/**
 * Disables or suspends an organization and revokes active user sessions.
 */
function disableOrganization(id, { reason = 'Suspended by platform administrator', actorId = null } = {}) {
  const org = findOrganizationById(id);
  if (!org) throw new NotFoundError('Organization not found');

  const previousStatus = org.status;
  const newStatus = 'SUSPENDED';

  const runDisableTx = db.transaction(() => {
    db.prepare(`
      UPDATE organizations
      SET status = ?, updated_at = datetime('now'), updated_by = ?
      WHERE id = ?
    `).run(newStatus, actorId, id);

    db.prepare(`
      INSERT INTO organization_status_history (organization_id, previous_status, new_status, reason, changed_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, previousStatus, newStatus, reason, actorId);
  });

  runDisableTx();

  // Invalidate all active user sessions belonging to this organization
  try {
    const orgUsers = db.prepare('SELECT id FROM users WHERE organization_id = ?').all(id);
    for (const u of orgUsers) {
      deleteAllUserSessions(u.id);
    }
  } catch (err) {
    console.warn(`[organization] Warning revoking sessions for org ${id}:`, err.message);
  }

  return findOrganizationById(id);
}

/**
 * Enables / reactivates an organization.
 */
function enableOrganization(id, { reason = 'Reactivated by platform administrator', actorId = null } = {}) {
  const org = findOrganizationById(id);
  if (!org) throw new NotFoundError('Organization not found');

  const previousStatus = org.status;
  const newStatus = 'ACTIVE';

  const runEnableTx = db.transaction(() => {
    db.prepare(`
      UPDATE organizations
      SET status = ?, updated_at = datetime('now'), updated_by = ?
      WHERE id = ?
    `).run(newStatus, actorId, id);

    db.prepare(`
      INSERT INTO organization_status_history (organization_id, previous_status, new_status, reason, changed_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, previousStatus, newStatus, reason, actorId);
  });

  runEnableTx();

  return findOrganizationById(id);
}

/**
 * Retrieves aggregate usage analytics for a single organization.
 */
function getOrganizationUsage(organizationId) {
  const org = findOrganizationById(organizationId);
  if (!org) throw new NotFoundError('Organization not found');

  const candidatesCount = db.prepare('SELECT count(*) as count FROM students WHERE organization_id = ?').get(organizationId)?.count || 0;
  const examsCount = db.prepare('SELECT count(*) as count FROM exams WHERE organization_id = ?').get(organizationId)?.count || 0;
  const totalAttempts = db.prepare('SELECT count(*) as count FROM attempts WHERE organization_id = ?').get(organizationId)?.count || 0;
  const completedAttempts = db.prepare("SELECT count(*) as count FROM attempts WHERE organization_id = ? AND status = 'submitted'").get(organizationId)?.count || 0;
  const inProgressAttempts = db.prepare("SELECT count(*) as count FROM attempts WHERE organization_id = ? AND status = 'started'").get(organizationId)?.count || 0;
  const certificatesIssued = db.prepare("SELECT count(*) as count FROM attempts WHERE organization_id = ? AND certificate_id IS NOT NULL AND status = 'submitted'").get(organizationId)?.count || 0;
  const activeAdmins = db.prepare("SELECT count(*) as count FROM users WHERE organization_id = ? AND status = 'ACTIVE'").get(organizationId)?.count || 0;

  return {
    organizationId: org.id,
    organizationName: org.name,
    organizationSlug: org.slug,
    status: org.status,
    timezone: org.timezone,
    createdAt: org.created_at,
    candidatesCount,
    examsCount,
    attemptsCount: totalAttempts,
    certificatesCount: certificatesIssued,
    questionsCount: db.prepare('SELECT count(*) as count FROM questions WHERE organization_id = ?').get(organizationId)?.count || 0,
    usersCount: activeAdmins,
    usage: {
      totalCandidates: candidatesCount,
      totalExams: examsCount,
      totalAttempts,
      completedAttempts,
      inProgressAttempts,
      certificatesIssued,
      activeAdmins
    }
  };
}

/**
 * Retrieves platform-wide usage summaries for SUPER_ADMIN.
 */
function getPlatformOrganizationsUsage() {
  const totalOrgs = db.prepare('SELECT count(*) as count FROM organizations').get()?.count || 0;
  const activeOrgs = db.prepare("SELECT count(*) as count FROM organizations WHERE status = 'ACTIVE'").get()?.count || 0;
  const suspendedOrgs = db.prepare("SELECT count(*) as count FROM organizations WHERE status IN ('SUSPENDED', 'DISABLED')").get()?.count || 0;

  const totalCandidates = db.prepare('SELECT count(*) as count FROM students').get()?.count || 0;
  const totalExams = db.prepare('SELECT count(*) as count FROM exams').get()?.count || 0;
  const totalAttempts = db.prepare('SELECT count(*) as count FROM attempts').get()?.count || 0;
  const totalCertificates = db.prepare("SELECT count(*) as count FROM attempts WHERE certificate_id IS NOT NULL AND status = 'submitted'").get()?.count || 0;

  const orgSummaries = db.prepare(`
    SELECT o.id, o.name, o.slug, o.status, o.created_at,
           (SELECT count(*) FROM students s WHERE s.organization_id = o.id) as candidate_count,
           (SELECT count(*) FROM exams e WHERE e.organization_id = o.id) as exam_count,
           (SELECT count(*) FROM attempts a WHERE a.organization_id = o.id) as attempt_count,
           (SELECT count(*) FROM attempts a WHERE a.organization_id = o.id AND a.certificate_id IS NOT NULL) as certificate_count
    FROM organizations o
    ORDER BY o.id ASC
  `).all();

  return {
    totalOrganizations: totalOrgs,
    activeOrganizations: activeOrgs,
    suspendedOrganizations: suspendedOrgs,
    totalCandidates,
    totalExams,
    totalAttempts,
    totalCertificates,
    platformTotals: {
      totalOrganizations: totalOrgs,
      activeOrganizations: activeOrgs,
      suspendedOrganizations: suspendedOrgs,
      totalCandidates,
      totalExams,
      totalAttempts,
      totalCertificates
    },
    organizations: orgSummaries
  };
}

function getOrCreateDefaultOrganization() {
  let org = db.prepare('SELECT * FROM organizations ORDER BY id ASC LIMIT 1').get();
  if (!org) {
    const res = db.prepare(`
      INSERT INTO organizations (name, slug, status)
      VALUES ('Adyapan Academy', 'adyapan', 'ACTIVE')
    `).run();
    org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(res.lastInsertRowid);
  }
  return deserializeOrg(org);
}

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
      INSERT INTO organizations (name, slug, status, email)
      VALUES (?, ?, 'ACTIVE', ?)
    `).run(name.trim(), cleanSlug, normEmail);
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
  findOrganizationByEmail,
  listOrganizations,
  listOrganizationsPaginated,
  createOrganization,
  updateOrganization,
  disableOrganization,
  enableOrganization,
  getOrganizationUsage,
  getPlatformOrganizationsUsage,
  getOrCreateDefaultOrganization,
  onboardOrganization
};
