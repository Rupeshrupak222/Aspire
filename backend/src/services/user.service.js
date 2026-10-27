// User identity and administration management service.
const { db } = require('../db');
const { ConflictError, NotFoundError, ValidationError } = require('../errors/app-error');
const { normalizeEmail, hashPassword } = require('../security/jwt');
const { isValidRole, ROLES } = require('../security/rbac');
const { deleteAllUserSessions } = require('./session.service');

function sanitizeUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

function findUserById(id, { includeHash = false } = {}) {
  if (!id) return null;
  const row = db.prepare(`
    SELECT u.*, o.name AS organization_name, o.slug AS organization_slug
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE u.id = ?
  `).get(id);

  if (!row) return null;
  return includeHash ? row : sanitizeUser(row);
}

function findUserByEmail(email, { includeHash = false } = {}) {
  const norm = normalizeEmail(email);
  if (!norm) return null;

  const row = db.prepare(`
    SELECT u.*, o.name AS organization_name, o.slug AS organization_slug
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE u.email = ?
  `).get(norm);

  if (!row) return null;
  return includeHash ? row : sanitizeUser(row);
}

function listUsers({ organizationId = null, role = null } = {}) {
  const conditions = [];
  const params = [];

  if (organizationId !== null) {
    conditions.push('u.organization_id = ?');
    params.push(organizationId);
  }

  if (role) {
    conditions.push('u.role = ?');
    params.push(role);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.organization_id, u.status,
           u.last_login_at, u.created_at, u.updated_at,
           o.name AS organization_name, o.slug AS organization_slug
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    ${whereClause}
    ORDER BY u.id ASC
  `).all(...params);

  return rows;
}

async function createUser({ email, password, name, role, organizationId = null, status = 'ACTIVE' }) {
  const normEmail = normalizeEmail(email);
  if (!normEmail) throw new ValidationError('A valid email address is required');
  if (!name || typeof name !== 'string' || !name.trim()) throw new ValidationError('Name is required');
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }
  if (!isValidRole(role)) {
    throw new ValidationError(`Invalid role: ${role}`);
  }

  // Non-super-admin users should belong to an organization
  if (role !== ROLES.SUPER_ADMIN && !organizationId) {
    throw new ValidationError(`Role "${role}" must be assigned to an organization`);
  }

  const existing = findUserByEmail(normEmail);
  if (existing) {
    throw new ConflictError('A user with this email already exists', 'EMAIL_IN_USE');
  }

  const passwordHash = await hashPassword(password);
  const userStatus = status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';

  const result = db.prepare(`
    INSERT INTO users (email, password_hash, name, role, organization_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(normEmail, passwordHash, name.trim(), role, organizationId || null, userStatus);

  return findUserById(result.lastInsertRowid);
}

function updateUser(id, { name, role, organizationId, status }) {
  const current = findUserById(id, { includeHash: true });
  if (!current) throw new NotFoundError('User not found');

  const newName = name !== undefined ? String(name).trim() : current.name;
  const newRole = role !== undefined ? role : current.role;
  const newOrgId = organizationId !== undefined ? organizationId : current.organization_id;
  const newStatus = status !== undefined ? (status === 'DISABLED' ? 'DISABLED' : 'ACTIVE') : current.status;

  if (role !== undefined && !isValidRole(role)) {
    throw new ValidationError(`Invalid role: ${role}`);
  }

  // If role is changing or user is disabled, invalidate existing sessions
  const roleChanged = newRole !== current.role;
  const wasDisabled = newStatus === 'DISABLED' && current.status !== 'DISABLED';
  let tokenVersion = current.token_version;

  if (roleChanged || wasDisabled) {
    tokenVersion += 1;
    deleteAllUserSessions(id);
  }

  db.prepare(`
    UPDATE users
    SET name = ?, role = ?, organization_id = ?, status = ?,
        token_version = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newName, newRole, newOrgId, newStatus, tokenVersion, id);

  return findUserById(id);
}

async function updatePassword(id, newPassword) {
  const user = findUserById(id, { includeHash: true });
  if (!user) throw new NotFoundError('User not found');

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }

  const passwordHash = await hashPassword(newPassword);
  const nextTokenVersion = (user.token_version || 1) + 1;

  // Invalidate all active sessions for this user on password change
  deleteAllUserSessions(id);

  db.prepare(`
    UPDATE users
    SET password_hash = ?, token_version = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(passwordHash, nextTokenVersion, id);

  return { success: true };
}

function recordLogin(id) {
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(id);
}

function countSuperAdmins() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE'").get().c;
}

module.exports = {
  findUserById,
  findUserByEmail,
  listUsers,
  createUser,
  updateUser,
  updatePassword,
  recordLogin,
  countSuperAdmins,
  sanitizeUser
};
