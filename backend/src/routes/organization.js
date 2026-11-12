// Organization Administrator & Tenant Self-Management Routes.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const { db } = require('../db');

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
const reportingService = require('../services/reporting/report.service');
const {
  reportTypeParamSchema,
  reportFilterSchema,
  reportExportSchema
} = require('../validation/reporting.schemas');
const subscriptionService = require('../services/subscription/subscription.service');
const quotaService = require('../services/subscription/quota.service');
const planService = require('../services/subscription/plan.service');
const usageService = require('../services/subscription/usage.service');
const meteringService = require('../services/subscription/metering.service');
const {
  usageTrendsQuerySchema,
  usageHistoryQuerySchema
} = require('../validation/metering.schemas');
const { requireFeature } = require('../middleware/quota-enforcement');
const notificationService = require('../services/notifications/notification.service');
const notificationDeliveryService = require('../services/notifications/notification-delivery.service');
const notificationPreferencesService = require('../services/notifications/notification-preferences.service');
const {
  listNotificationsQuerySchema,
  updatePreferencesSchema,
  deliveryIdParamSchema
} = require('../validation/notification.schemas');

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

  // Feature Gating: Custom color palettes require CUSTOM_BRANDING
  if (req.body.primary_color || req.body.secondary_color || req.body.accent_color) {
    const features = subscriptionService.getEffectiveFeatures(orgId);
    if (!features.includes('CUSTOM_BRANDING') && req.user.role !== ROLES.SUPER_ADMIN) {
      const { FeatureNotAvailableError } = require('../errors/app-error');
      return next(new FeatureNotAvailableError('Custom branding colors require the CUSTOM_BRANDING feature entitlement. Please upgrade your plan.', 'CUSTOM_BRANDING'));
    }
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
 * GET /api/organization/subscription
 * Get current organization subscription details, plan metadata, and effective quotas.
 */
router.get('/subscription', requirePermission(PERMISSIONS.ORGANIZATIONS_READ, PERMISSIONS.SETTINGS_READ), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const sub = subscriptionService.getOrganizationSubscription(orgId);
  const effectiveQuotas = subscriptionService.getEffectiveQuotas(orgId);
  const effectiveFeatures = subscriptionService.getEffectiveFeatures(orgId);

  res.json({
    success: true,
    data: {
      subscription: sub,
      effectiveQuotas,
      effectiveFeatures
    }
  });
});

/**
 * GET /api/organization/plans
 * Available subscription plans catalog for tier comparison.
 */
router.get('/plans', requirePermission(PERMISSIONS.ORGANIZATIONS_READ, PERMISSIONS.SETTINGS_READ), (req, res, next) => {
  const plans = planService.listPlans();
  res.json({ success: true, data: plans });
});

/**
 * GET /api/organization/plan/features
 * Effective feature entitlements for the current organization.
 */
router.get('/plan/features', requirePermission(PERMISSIONS.ORGANIZATIONS_READ, PERMISSIONS.SETTINGS_READ), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const features = subscriptionService.getEffectiveFeatures(orgId);
  res.json({ success: true, data: features });
});

/**
 * GET /api/organization/usage
 * GET /api/organization/usage/overview
 * Get comprehensive real-time usage snapshot across all 7 resource categories.
 */
function handleUsageOverview(req, res, next) {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const rawUsage = orgService.getOrganizationUsage(orgId);
  const quotaSummary = quotaService.getQuotaSummary(orgId);
  const snapshot = meteringService.getCurrentUsageSnapshot(orgId);

  res.json({
    success: true,
    data: {
      ...rawUsage,
      ...quotaSummary,
      ...snapshot
    }
  });
}

router.get('/usage', requirePermission(PERMISSIONS.ANALYTICS_READ), handleUsageOverview);
router.get('/usage/overview', requirePermission(PERMISSIONS.ANALYTICS_READ), handleUsageOverview);

/**
 * GET /api/organization/usage/resources
 * Detailed resource metrics and limits for all 7 resources.
 */
router.get('/usage/resources', requirePermission(PERMISSIONS.ANALYTICS_READ), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const snapshot = meteringService.getCurrentUsageSnapshot(orgId);
  res.json({
    success: true,
    data: snapshot.resources
  });
});

/**
 * GET /api/organization/usage/trends
 * Time series usage trends suitable for Chart.js visualization.
 */
router.get('/usage/trends', requirePermission(PERMISSIONS.ANALYTICS_READ), validate({ query: usageTrendsQuerySchema }), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const trends = meteringService.getUsageTrends({
    organizationId: orgId,
    resourceKey: req.query.resource_key || null,
    startDate: req.query.start_date || null,
    endDate: req.query.end_date || null,
    interval: req.query.interval || 'daily'
  });

  res.json({
    success: true,
    data: trends
  });
});

/**
 * GET /api/organization/usage/history
 * Paginated usage audit event ledger.
 */
router.get('/usage/history', requirePermission(PERMISSIONS.ANALYTICS_READ), validate({ query: usageHistoryQuerySchema }), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const history = meteringService.getUsageHistory({
    organizationId: orgId,
    resourceKey: req.query.resource_key || null,
    page: req.query.page,
    limit: req.query.limit,
    startDate: req.query.start_date || null,
    endDate: req.query.end_date || null
  });

  res.json({
    success: true,
    data: history
  });
});

/**
 * GET /api/organization/usage/storage
 * Total storage footprint, object categories, and recent uploads.
 */
router.get('/usage/storage', requirePermission(PERMISSIONS.ANALYTICS_READ), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const footprint = meteringService.getStorageFootprint(orgId);
  res.json({
    success: true,
    data: footprint
  });
});

/**
 * GET /api/organization/usage/:resourceKey
 * Specific resource breakdown and recent usage events.
 */
router.get('/usage/:resourceKey', requirePermission(PERMISSIONS.ANALYTICS_READ), (req, res, next) => {
  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not assigned to an organization'));
  }

  const { resourceKey } = req.params;
  const quotaCheck = quotaService.checkQuota(orgId, resourceKey, 0);
  const events = usageService.getUsageEvents(orgId, { resourceKey, limit: 25 });

  res.json({
    success: true,
    data: {
      resource: quotaCheck,
      events
    }
  });
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
 * Upload and update organization logo (requires CUSTOM_BRANDING feature entitlement).
 */
router.post('/branding/logo', requirePermission(PERMISSIONS.ORGANIZATIONS_UPDATE), requireFeature('CUSTOM_BRANDING'), upload.single('logo'), async (req, res, next) => {
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
 * Upload certificate branding assets (logo or signature) (requires CUSTOM_BRANDING feature entitlement).
 */
router.post('/branding/certificate', requirePermission(PERMISSIONS.ORGANIZATIONS_UPDATE), requireFeature('CUSTOM_BRANDING'), upload.single('asset'), async (req, res, next) => {
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

// ============================================================================
// DAY 20: REPORTING SYSTEM ROUTES (ORGANIZATION SCOPE)
// ============================================================================

/**
 * GET /api/organization/reports
 * Returns report catalog, descriptions, and dynamic filter options (exams, colleges).
 */
router.get(
  '/reports',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
      const options = reportingService.getReportOptions({ organizationId: orgId, isSuperAdmin });
      res.json({ success: true, data: options });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/reports/:reportType/export
 * Downloads complete report in CSV, Excel, or PDF format with tenant boundary enforcement.
 * Note: Placed BEFORE /:reportType to avoid Express routing collision.
 */
router.get(
  '/reports/:reportType/export',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: reportTypeParamSchema, query: reportExportSchema }),
  async (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;

      const exportResult = await reportingService.exportReport({
        reportType: req.params.reportType,
        format: req.query.format,
        organizationId: orgId,
        isSuperAdmin,
        filters: req.query,
        actorId: req.user.id,
        req
      });

      res.setHeader('Content-Type', exportResult.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Report-Records', exportResult.recordCount);
      res.send(exportResult.buffer);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/reports/:reportType
 * Returns server-side paginated preview dataset, active filters, and summary KPIs.
 */
router.get(
  '/reports/:reportType',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ params: reportTypeParamSchema, query: reportFilterSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));
      const isSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;

      const report = reportingService.getReportPreview({
        reportType: req.params.reportType,
        organizationId: orgId,
        isSuperAdmin,
        filters: req.query
      });

      res.json({ success: true, data: report });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// DAY 23: CANDIDATE EXAM INVITATIONS & TRANSACTIONAL NOTIFICATIONS
// ============================================================================

/**
 * POST /api/organization/exams/:id/invite
 * Invites one or more candidates to take an assessment, generating secure tokens
 * and triggering transactional email delivery with scheduled reminders.
 */
router.post(
  '/exams/:id/invite',
  requirePermission(PERMISSIONS.EXAMS_CREATE, PERMISSIONS.EXAMS_UPDATE),
  async (req, res, next) => {
    try {
      const examId = parseInt(req.params.id, 10);
      if (isNaN(examId)) return next(new ValidationError('Invalid exam id'));

      const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId);
      if (!exam) return next(new NotFoundError('Exam not found'));

      // Tenant boundary enforcement
      if (req.user.role !== ROLES.SUPER_ADMIN && exam.organization_id !== req.user.organization_id) {
        return next(new AuthorizationError('Cannot invite candidates to an exam belonging to another organization'));
      }

      const orgId = exam.organization_id || req.user.organization_id || 1;

      // Normalize candidate list from body
      let candidateList = [];
      if (Array.isArray(req.body.candidates)) {
        candidateList = req.body.candidates;
      } else if (Array.isArray(req.body)) {
        candidateList = req.body;
      } else if (req.body.email) {
        candidateList = [{
          email: req.body.email,
          name: req.body.name,
          studentId: req.body.studentId
        }];
      }

      if (!candidateList.length) {
        return next(new ValidationError('At least one candidate email is required'));
      }

      const reminderHours = Array.isArray(req.body.scheduledReminderHours)
        ? req.body.scheduledReminderHours
        : (req.body.reminderHours ? [req.body.reminderHours] : []);

      const results = [];

      for (const cand of candidateList) {
        const cleanEmail = String(cand.email || '').trim().toLowerCase();
        if (!cleanEmail || !cleanEmail.includes('@')) continue;

        const candName = cand.name ? String(cand.name).trim() : 'Candidate';
        const invToken = crypto.randomBytes(24).toString('hex');

        // Check if student exists
        let studentId = cand.studentId || null;
        if (!studentId) {
          const sRow = db.prepare('SELECT id FROM students WHERE email = ?').get(cleanEmail);
          if (sRow) studentId = sRow.id;
        }

        // Insert invitation record
        const insertRes = db.prepare(`
          INSERT INTO exam_candidate_invitations (
            organization_id, exam_id, student_id, email, name, invitation_token,
            status, invited_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, datetime('now'), datetime('now'))
        `).run(orgId, examId, studentId, cleanEmail, candName, invToken, req.user.id);

        const invitationId = insertRes.lastInsertRowid;

        // Trigger invitation email
        notificationService.sendExamInvitation({
          organizationId: orgId,
          examId,
          studentId,
          email: cleanEmail,
          name: candName,
          examTitle: exam.name,
          durationMinutes: exam.duration_minutes || 90,
          invitationToken: invToken
        });

        // Schedule optional reminders if requested
        for (const rh of reminderHours) {
          const delayHours = parseInt(rh, 10);
          if (delayHours > 0) {
            const scheduledAt = new Date(Date.now() + delayHours * 3600 * 1000).toISOString();
            notificationService.scheduleExamReminder({
              organizationId: orgId,
              examId,
              studentId,
              email: cleanEmail,
              name: candName,
              examTitle: exam.name,
              startTime: exam.scheduled_start_time || null,
              durationMinutes: exam.duration_minutes || 90,
              reminderType: `${delayHours}h`,
              scheduledAt
            });
          }
        }

        // Mark invitation sent
        db.prepare("UPDATE exam_candidate_invitations SET status = 'SENT', updated_at = datetime('now') WHERE id = ?").run(invitationId);

        results.push({
          id: invitationId,
          email: cleanEmail,
          name: candName,
          invitationToken: invToken,
          status: 'SENT'
        });
      }

      res.status(201).json({
        success: true,
        data: {
          count: results.length,
          invitations: results
        },
        message: `Successfully invited ${results.length} candidate(s)`
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/notifications
 * Lists transactional notification history with tenant isolation, pagination, and status filters.
 */
router.get(
  '/notifications',
  requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.SETTINGS_READ, PERMISSIONS.ORGANIZATIONS_READ),
  validate({ query: listNotificationsQuerySchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

      const result = notificationDeliveryService.listDeliveries({
        organizationId: orgId,
        page: req.query.page,
        limit: req.query.limit,
        eventType: req.query.event_type,
        status: req.query.status,
        search: req.query.search,
        startDate: req.query.start_date,
        endDate: req.query.end_date
      });

      const metrics = notificationDeliveryService.getNotificationMetrics(orgId);

      res.json({
        success: true,
        data: result.deliveries,
        pagination: result.pagination,
        metrics
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/notifications/preferences
 * Returns communication preferences for the authenticated organization user.
 */
router.get(
  '/notifications/preferences',
  requirePermission(PERMISSIONS.SETTINGS_READ, PERMISSIONS.ORGANIZATIONS_READ),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

      const preferences = notificationPreferencesService.getNotificationPreferences(orgId, req.user.id);
      res.json({ success: true, data: preferences });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/organization/notifications/preferences
 * Updates communication preferences for the authenticated organization user.
 */
router.put(
  '/notifications/preferences',
  requirePermission(PERMISSIONS.SETTINGS_UPDATE, PERMISSIONS.ORGANIZATIONS_UPDATE),
  validate({ body: updatePreferencesSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.organization_id;
      if (!orgId) return next(new AuthorizationError('User account is not assigned to an organization'));

      const updated = notificationPreferencesService.updateNotificationPreferences(orgId, req.user.id, req.body);
      res.json({
        success: true,
        data: updated,
        message: 'Notification preferences updated successfully'
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/organization/notifications/:id
 * Retrieves detail for a specific notification delivery with strict tenant scoping.
 */
router.get(
  '/notifications/:id',
  requirePermission(PERMISSIONS.ANALYTICS_READ, PERMISSIONS.SETTINGS_READ),
  validate({ params: deliveryIdParamSchema }),
  (req, res, next) => {
    try {
      const orgId = req.user.role === ROLES.SUPER_ADMIN ? null : req.user.organization_id;
      const delivery = notificationDeliveryService.getDelivery(req.params.id, orgId);
      res.json({ success: true, data: delivery });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/organization/notifications/:id/retry
 * Initiates an authorized manual retry for a failed notification delivery.
 */
router.post(
  '/notifications/:id/retry',
  requirePermission(PERMISSIONS.SETTINGS_UPDATE, PERMISSIONS.ORGANIZATIONS_UPDATE),
  validate({ params: deliveryIdParamSchema }),
  async (req, res, next) => {
    try {
      const orgId = req.user.role === ROLES.SUPER_ADMIN ? null : req.user.organization_id;
      const result = await notificationDeliveryService.retryDelivery(req.params.id, orgId);
      res.json({
        success: true,
        data: result,
        message: 'Notification delivery retry scheduled successfully'
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
