// Organization Administrator & Tenant Self-Management Routes.
const express = require('express');
const router = express.Router();
const multer = require('multer');

const { requireAuth, requirePermission } = require('../middleware/admin-auth');
const { tenantContextMiddleware } = require('../middleware/tenant-context');
const validate = require('../middleware/validate');
const { PERMISSIONS, ROLES } = require('../security/rbac');
const { recordAuditEvent } = require('../services/audit.service');
const { AuthorizationError, NotFoundError, ValidationError } = require('../errors/app-error');
const orgService = require('../services/organization.service');
const invitationService = require('../services/invitation.service');
const { storageService } = require('../services/storage.service');

const {
  updateOrganizationProfileSchema,
  inviteAdminSchema
} = require('../validation/organization.schemas');

// Memory storage for file uploads (max 2MB)
const upload = multer({
  limits: { fileSize: 2 * 1024 * 1024 },
  storage: multer.memoryStorage()
});

// All organization routes require authentication and tenant context
router.use(requireAuth);
router.use(tenantContextMiddleware);

/**
 * GET /api/organization
 * Retrieve current organization profile.
 */
router.get('/', (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }
  const org = orgService.findOrganizationById(orgId);
  if (!org) return next(new NotFoundError('Organization not found'));
  res.json({ success: true, data: org });
});

/**
 * PATCH /api/organization
 * Update current organization profile and branding (ORG_ADMIN only).
 */
router.patch('/', requirePermission(PERMISSIONS.ORGANIZATIONS_UPDATE), validate({ body: updateOrganizationProfileSchema }), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const updated = orgService.updateOrganization(orgId, req.body, {
    actorId: req.user.id,
    isSuperAdmin: false
  });

  recordAuditEvent({
    req,
    event: 'organization_profile_updated',
    organizationId: orgId,
    details: { updatedFields: Object.keys(req.body) }
  });

  res.json({ success: true, data: updated });
});

/**
 * GET /api/organization/usage
 * Get tenant-scoped usage analytics.
 */
router.get('/usage', requirePermission(PERMISSIONS.ANALYTICS_READ), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }
  const usage = orgService.getOrganizationUsage(orgId);
  res.json({ success: true, data: usage });
});

/**
 * Helper to extract file buffer from multipart or base64 JSON payload.
 */
function extractUploadPayload(req) {
  if (req.file && req.file.buffer) {
    return {
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype
    };
  }

  if (req.body && req.body.data) {
    const raw = String(req.body.data);
    const base64Data = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    const buffer = Buffer.from(base64Data, 'base64');
    return {
      buffer,
      originalFilename: req.body.filename || 'upload.png',
      mimeType: req.body.contentType || 'image/png'
    };
  }

  throw new ValidationError('No image file or base64 data provided for upload');
}

/**
 * POST /api/organization/branding/logo
 * Upload and update organization logo.
 */
router.post('/branding/logo', requirePermission(PERMISSIONS.ORGANIZATIONS_UPDATE), upload.single('logo'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) {
      return next(new AuthorizationError('User account is not assigned to an organization'));
    }

    const { buffer, originalFilename, mimeType } = extractUploadPayload(req);
    const result = await storageService.uploadAsset({
      organizationId: orgId,
      assetType: 'logo',
      buffer,
      originalFilename,
      claimedMimeType: mimeType
    });

    const updated = orgService.updateOrganization(orgId, { logo_url: result.url }, { actorId: req.user.id });

    recordAuditEvent({
      req,
      event: 'organization_logo_uploaded',
      organizationId: orgId,
      details: { url: result.url, key: result.key }
    });

    res.status(201).json({
      success: true,
      data: {
        logo_url: result.url,
        key: result.key,
        organization: updated
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/organization/branding/certificate
 * Upload certificate branding assets (logo or signature).
 */
router.post('/branding/certificate', requirePermission(PERMISSIONS.ORGANIZATIONS_UPDATE), upload.single('asset'), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) {
      return next(new AuthorizationError('User account is not assigned to an organization'));
    }

    const assetType = req.body && req.body.type === 'signature' ? 'signature' : 'certificate-logo';
    const { buffer, originalFilename, mimeType } = extractUploadPayload(req);

    const result = await storageService.uploadAsset({
      organizationId: orgId,
      assetType,
      buffer,
      originalFilename,
      claimedMimeType: mimeType
    });

    const certUpdate = {};
    if (assetType === 'signature') {
      certUpdate.certificate_signature_url = result.url;
    } else {
      certUpdate.certificate_logo_url = result.url;
    }

    const updated = orgService.updateOrganization(orgId, { certificate_branding: certUpdate }, { actorId: req.user.id });

    recordAuditEvent({
      req,
      event: 'certificate_branding_asset_uploaded',
      organizationId: orgId,
      details: { assetType, url: result.url, key: result.key }
    });

    res.status(201).json({
      success: true,
      data: {
        asset_url: result.url,
        key: result.key,
        type: assetType,
        organization: updated
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/organization/invitations
 * Invite an administrator or staff member to own organization.
 */
router.post('/invitations', requirePermission(PERMISSIONS.USERS_CREATE), validate({ body: inviteAdminSchema }), async (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) {
      return next(new AuthorizationError('User account is not assigned to an organization'));
    }

    const result = await invitationService.createInvitation({
      organizationId: orgId,
      email: req.body.email,
      role: req.body.role || 'ORG_ADMIN',
      invitedBy: req.user.id
    });

    recordAuditEvent({
      req,
      event: 'admin_invited',
      organizationId: orgId,
      details: { inviteeEmail: req.body.email, role: req.body.role }
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organization/invitations
 * List all invitations for own organization.
 */
router.get('/invitations', requirePermission(PERMISSIONS.USERS_READ), (req, res) => {
  const orgId = req.user.organization_id;
  const list = invitationService.listInvitations(orgId);
  res.json({ success: true, data: list });
});

/**
 * POST /api/organization/invitations/:id/revoke
 * Revoke an active invitation in own organization.
 */
router.post('/invitations/:id/revoke', requirePermission(PERMISSIONS.USERS_CREATE), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    const result = invitationService.revokeInvitation(req.params.id, { organizationId: orgId });

    recordAuditEvent({
      req,
      event: 'invitation_revoked',
      organizationId: orgId,
      details: { invitationId: req.params.id }
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
