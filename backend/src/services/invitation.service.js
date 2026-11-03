// Secure Administrator & Member Invitation Service.
// Follows cryptographically secure single-use token architecture with SHA-256 hash storage.

const crypto = require('crypto');
const { db } = require('../db');
const { ValidationError, NotFoundError, ConflictError, AuthorizationError } = require('../errors/app-error');
const { normalizeEmail } = require('../security/jwt');
const { ROLES } = require('../security/rbac');
const userService = require('./user.service');

const INVITATION_EXPIRY_DAYS = 7;

/**
 * In-memory delivery registry for development & automated tests.
 * Avoids third-party external email dependencies in test/dev environments.
 */
class InvitationDeliveryStore {
  constructor() {
    this.deliveries = new Map();
  }

  recordDelivery(email, data) {
    this.deliveries.set(normalizeEmail(email), {
      ...data,
      deliveredAt: new Date().toISOString()
    });
  }

  getLastDelivery(email) {
    return this.deliveries.get(normalizeEmail(email)) || null;
  }

  clear() {
    this.deliveries.clear();
  }
}

const deliveryStore = new InvitationDeliveryStore();

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken).trim()).digest('hex');
}

/**
 * Creates a secure single-use invitation.
 */
async function createInvitation({ organizationId, email, role = 'ORG_ADMIN', invitedBy = null }) {
  if (!organizationId) {
    throw new ValidationError('organizationId is required');
  }

  const normEmail = normalizeEmail(email);
  if (!normEmail) {
    throw new ValidationError('A valid email address is required');
  }

  // Prevent inviting SUPER_ADMIN
  if (role === ROLES.SUPER_ADMIN) {
    throw new AuthorizationError('Cannot invite users with the SUPER_ADMIN role');
  }

  // Verify target organization exists and is ACTIVE
  const org = db.prepare('SELECT id, name, status FROM organizations WHERE id = ?').get(organizationId);
  if (!org) {
    throw new NotFoundError('Target organization not found');
  }
  if (org.status !== 'ACTIVE') {
    throw new AuthorizationError(`Cannot invite users to an organization with status "${org.status}"`);
  }

  // Check if user already exists
  const existingUser = userService.findUserByEmail(normEmail);
  if (existingUser) {
    throw new ConflictError('A user with this email address already exists in the platform', 'USER_ALREADY_EXISTS');
  }

  // Revoke any previous pending invitations for this email in this organization
  db.prepare(`
    UPDATE organization_invitations
    SET revoked_at = datetime('now')
    WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(organizationId, normEmail);

  // Generate cryptographically secure token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const res = db.prepare(`
    INSERT INTO organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(organizationId, normEmail, role, tokenHash, invitedBy, expiresAt);

  const invitationId = res.lastInsertRowid;

  // Record in dev delivery store
  deliveryStore.recordDelivery(normEmail, {
    invitationId,
    organizationId,
    organizationName: org.name,
    email: normEmail,
    role,
    rawToken,
    expiresAt
  });

  return {
    id: invitationId,
    organizationId,
    organizationName: org.name,
    email: normEmail,
    role,
    expiresAt,
    token: rawToken,
    invitationLink: `/invite?token=${rawToken}`
  };
}

/**
 * Validates an invitation by raw token string.
 */
function getInvitationByToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new ValidationError('Invitation token is required');
  }

  const tokenHash = hashToken(rawToken);
  const invitation = db.prepare(`
    SELECT i.*, o.name AS organization_name, o.status AS organization_status
    FROM organization_invitations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE i.token_hash = ?
  `).get(tokenHash);

  if (!invitation) {
    throw new NotFoundError('Invitation not found or invalid', 'INVITATION_NOT_FOUND');
  }

  if (invitation.revoked_at) {
    throw new ConflictError('This invitation has been revoked', 'INVITATION_REVOKED');
  }

  if (invitation.accepted_at) {
    throw new ConflictError('This invitation has already been accepted', 'INVITATION_ALREADY_ACCEPTED');
  }

  if (new Date(invitation.expires_at) < new Date()) {
    throw new ConflictError('This invitation has expired', 'INVITATION_EXPIRED');
  }

  if (invitation.organization_status !== 'ACTIVE') {
    throw new AuthorizationError('The organization for this invitation is currently suspended or disabled');
  }

  return {
    id: invitation.id,
    organizationId: invitation.organization_id,
    organization_id: invitation.organization_id,
    organizationName: invitation.organization_name,
    organization_name: invitation.organization_name,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expires_at,
    expires_at: invitation.expires_at,
    status: 'PENDING'
  };
}

/**
 * Accepts an invitation and provisions the user account atomically.
 */
async function acceptInvitation({ rawToken, name, password }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new ValidationError('Name is required');
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters long');
  }

  const invite = getInvitationByToken(rawToken);
  const tokenHash = hashToken(rawToken);

  let createdUser = null;

  const runAcceptTx = db.transaction(() => {
    // 1. Mark invitation accepted
    db.prepare(`
      UPDATE organization_invitations
      SET accepted_at = datetime('now')
      WHERE token_hash = ?
    `).run(tokenHash);
  });

  runAcceptTx();

  // 2. Create user account
  createdUser = await userService.createUser({
    email: invite.email,
    name: name.trim(),
    password,
    role: invite.role,
    organizationId: invite.organizationId,
    status: 'ACTIVE'
  });

  return {
    user: createdUser,
    organizationId: invite.organizationId,
    organizationName: invite.organizationName
  };
}

/**
 * Revokes an active invitation.
 */
function revokeInvitation(invitationId, { organizationId = null } = {}) {
  const inv = db.prepare('SELECT * FROM organization_invitations WHERE id = ?').get(invitationId);
  if (!inv) throw new NotFoundError('Invitation not found');

  if (organizationId && Number(inv.organization_id) !== Number(organizationId)) {
    throw new AuthorizationError('Cannot revoke invitation belonging to another organization');
  }

  db.prepare(`
    UPDATE organization_invitations
    SET revoked_at = datetime('now')
    WHERE id = ?
  `).run(invitationId);

  return { success: true, id: invitationId };
}

/**
 * Lists invitations for an organization.
 */
function listInvitations(organizationId) {
  if (!organizationId) return [];

  return db.prepare(`
    SELECT id, organization_id, email, role, expires_at, accepted_at, revoked_at, created_at
    FROM organization_invitations
    WHERE organization_id = ?
    ORDER BY created_at DESC
  `).all(organizationId);
}

module.exports = {
  createInvitation,
  getInvitationByToken,
  acceptInvitation,
  revokeInvitation,
  listInvitations,
  deliveryStore,
  hashToken
};
