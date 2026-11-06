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
const dashboardService = require('../services/dashboard-analytics.service');
const examAnalyticsService = require('../services/exam-analytics.service');

const {
  updateOrganizationProfileSchema,
  inviteAdminSchema
} = require('../validation/organization.schemas');
const { dashboardFilterSchema } = require('../validation/dashboard.schemas');
const {
  examIdParamSchema,
  questionAnalyticsParamSchema,
  examAnalyticsFilterSchema,
  examCandidatesFilterSchema,
  examQuestionsFilterSchema
} = require('../validation/exam-analytics.schemas');

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

/* ---------- SaaS Analytics Dashboard Routes (Day 18) ---------- */

/**
 * GET /api/organization/dashboard/overview
 * Returns 8 KPIs for the authenticated organization.
 */
router.get('/dashboard/overview', requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.RESULTS_READ), validate({ query: dashboardFilterSchema }), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

    const data = dashboardService.getOverviewKPIs(orgId, req.query);
    res.json({ success: true, data: data.kpis, meta: data.meta });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organization/dashboard/attempts-over-time
 * Returns daily attempt time-series with zero-filled intervals.
 */
router.get('/dashboard/attempts-over-time', requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.RESULTS_READ), validate({ query: dashboardFilterSchema }), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

    const data = dashboardService.getAttemptsOverTime(orgId, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organization/dashboard/score-distribution
 * Returns percentage buckets (0-20%, 21-40%, 41-60%, 61-80%, 81-100%).
 */
router.get('/dashboard/score-distribution', requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.RESULTS_READ), validate({ query: dashboardFilterSchema }), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

    const data = dashboardService.getScoreDistribution(orgId, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organization/dashboard/college-distribution
 * Returns student count breakdown grouped by college/institution.
 */
router.get('/dashboard/college-distribution', requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.RESULTS_READ), validate({ query: dashboardFilterSchema }), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

    const data = dashboardService.getCollegeDistribution(orgId, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organization/dashboard/question-performance
 * Returns question accuracy, correct, and incorrect breakdown.
 */
router.get('/dashboard/question-performance', requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.RESULTS_READ), validate({ query: dashboardFilterSchema }), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

    const data = dashboardService.getQuestionPerformance(orgId, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/organization/dashboard/completion-rate
 * Returns completed, in-progress, and expired counts.
 */
router.get('/dashboard/completion-rate', requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.RESULTS_READ), validate({ query: dashboardFilterSchema }), (req, res, next) => {
  try {
    const orgId = req.user.organization_id;
    if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

    const data = dashboardService.getCompletionRate(orgId, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// DAY 19: EXAM-LEVEL ANALYTICS ROUTES
// ============================================================================

/**
 * GET /api/organization/exams/:examId/analytics/overview
 * Returns candidate funnel and high-level exam performance KPIs.
 */
router.get(
  '/exams/:examId/analytics/overview',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: examIdParamSchema, query: examAnalyticsFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getExamOverview(req.params.examId, orgId, req.query, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/exams/:examId/analytics/candidates
 * Returns candidate funnel, retake statistics, and candidate status list.
 */
router.get(
  '/exams/:examId/analytics/candidates',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: examIdParamSchema, query: examCandidatesFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getExamCandidates(req.params.examId, orgId, req.query, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/exams/:examId/analytics/questions
 * Returns psychometric question analytics, difficulty ratings, and Kelley's discrimination indices.
 */
router.get(
  '/exams/:examId/analytics/questions',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: examIdParamSchema, query: examQuestionsFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getExamQuestions(req.params.examId, orgId, req.query, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/exams/:examId/analytics/questions/:questionId
 * Returns detailed analytics for a single question including MCQ option selection or coding test case breakdown.
 */
router.get(
  '/exams/:examId/analytics/questions/:questionId',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: questionAnalyticsParamSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getQuestionDetail(req.params.examId, req.params.questionId, orgId, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/exams/:examId/analytics/coding
 * Returns coding question execution analytics, error categorizations, and test case pass rates.
 */
router.get(
  '/exams/:examId/analytics/coding',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: examIdParamSchema, query: examAnalyticsFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getExamCodingAnalytics(req.params.examId, orgId, req.query, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/exams/:examId/analytics/performance
 * Returns score distribution buckets, completion duration distribution, and simple-statistics metrics.
 */
router.get(
  '/exams/:examId/analytics/performance',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: examIdParamSchema, query: examAnalyticsFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getExamPerformance(req.params.examId, orgId, req.query, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/exams/:examId/analytics
 * Convenience endpoint returning overview for the exam.
 */
router.get(
  '/exams/:examId/analytics',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: examIdParamSchema, query: examAnalyticsFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const data = examAnalyticsService.getExamOverview(req.params.examId, orgId, req.query, isSuperAdmin);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
