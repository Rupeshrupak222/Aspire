// Admin API routes with Authentication, RBAC, and Multi-Tenant Isolation.
const express = require('express');
const { db, getConfig, setConfig } = require('../db');
const judge0 = require('../services/judge0');
const { requireAuth, requirePermission } = require('../middleware/admin-auth');
const validate = require('../middleware/validate');
const { NotFoundError, ValidationError, AuthorizationError } = require('../errors/app-error');
const { idParamSchema } = require('../validation/common.schemas');
const {
  createQuestionSchema,
  updateQuestionSchema,
  listQuestionsQuerySchema,
  checkDuplicatesSchema,
  updateStatusSchema,
  updateConfigSchema,
  resultsQuerySchema,
  collegeReportQuerySchema
} = require('../validation/admin.schemas');
const {
  createUserSchema,
  updateUserSchema,
  createOrganizationSchema,
  updateOrganizationSchema
} = require('../validation/auth.schemas');

const { adminAuthLimiter } = require('../security/rate-limit');
const { PERMISSIONS, ROLES } = require('../security/rbac');
const { escapeLike } = require('../security/sanitizer');
const userService = require('../services/user.service');
const orgService = require('../services/organization.service');
const questionService = require('../services/question.service');
const { recordAuditEvent } = require('../services/audit.service');

const router = express.Router();

// 1. Rate limiting on all admin operations
router.use(adminAuthLimiter);

// 2. Authentication enforcement on all admin routes
router.use(requireAuth);

/* ---------- Judge0 Status ---------- */
router.get('/judge0-status', requirePermission(PERMISSIONS.QUESTIONS_READ), (req, res) => {
  res.json(judge0.status());
});

/* ---------- Question Bank 2.0 CRUD & Lifecycle ---------- */

// Export questions to CSV (tenant-scoped)
router.get('/questions/export', requirePermission(PERMISSIONS.QUESTIONS_READ), (req, res) => {
  const csv = questionService.exportQuestionsCSV({ user: req.user, query: req.query });

  recordAuditEvent({
    req,
    event: 'question_bulk_exported',
    details: { filters: req.query }
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="questions-export.csv"');
  res.send(csv);
});

// Duplicate question detection check
router.post('/questions/duplicates', requirePermission(PERMISSIONS.QUESTIONS_READ), validate(checkDuplicatesSchema), (req, res) => {
  const result = questionService.findDuplicates({
    question_text: req.body.question_text,
    type: req.body.type,
    organization_id: req.user.role === ROLES.SUPER_ADMIN ? null : req.user.organization_id,
    excludeId: req.body.exclude_id
  });

  res.json({ success: true, data: result });
});

// Bulk CSV import preview (dry run)
router.post('/questions/import/preview', requirePermission(PERMISSIONS.QUESTIONS_CREATE), (req, res) => {
  const csvContent = typeof req.body === 'string' ? req.body : (req.body.csv || '');
  const result = questionService.bulkImportCSV({
    user: req.user,
    csvContent,
    dryRun: true
  });

  res.json({ success: true, data: result });
});

// Bulk CSV import execute
router.post('/questions/import', requirePermission(PERMISSIONS.QUESTIONS_CREATE), (req, res) => {
  const csvContent = typeof req.body === 'string' ? req.body : (req.body.csv || '');
  const result = questionService.bulkImportCSV({
    user: req.user,
    csvContent,
    dryRun: false
  });

  recordAuditEvent({
    req,
    event: 'question_bulk_imported',
    details: { totalRows: result.totalRows, importedCount: result.importedCount, failedCount: result.failedCount }
  });

  res.json({ success: true, data: result });
});

// List questions with search, filtering, and pagination
router.get('/questions', requirePermission(PERMISSIONS.QUESTIONS_READ), validate({ query: listQuestionsQuerySchema }), (req, res) => {
  const result = questionService.listQuestions({ user: req.user, query: req.query });

  if (result.pagination) {
    res.json({
      success: true,
      data: {
        items: result.items,
        pagination: result.pagination
      }
    });
  } else {
    // Return array directly for legacy callers and tests
    res.json(result.items);
  }
});

// Create question
router.post('/questions', requirePermission(PERMISSIONS.QUESTIONS_CREATE), validate(createQuestionSchema), (req, res) => {
  const result = questionService.createQuestion({ user: req.user, data: req.body });

  recordAuditEvent({
    req,
    event: 'question_created',
    details: { questionId: result.id, title: result.title, status: result.status }
  });

  res.status(201).json({ id: result.id, title: result.title, status: result.status });
});

// Get single question by ID
router.get('/questions/:id', requirePermission(PERMISSIONS.QUESTIONS_READ), validate({ params: idParamSchema }), (req, res) => {
  const q = questionService.getQuestionById({ id: req.params.id, user: req.user });
  res.json(q);
});

// Question candidate preview
router.get('/questions/:id/preview', requirePermission(PERMISSIONS.QUESTIONS_READ), validate({ params: idParamSchema }), (req, res) => {
  const q = questionService.getQuestionById({ id: req.params.id, user: req.user });

  // Candidate preview hides correct answers & private test cases
  const candidatePreview = {
    id: q.id,
    type: q.type,
    category: q.category,
    title: q.title,
    question_text: q.question_text,
    difficulty: q.difficulty,
    topic: q.topic,
    skill: q.skill,
    marks: q.marks,
    time_estimate: q.time_estimate,
    status: q.status,
    version: q.version,
    options: q.type === 'mcq' ? (q.options || []) : undefined,
    code_starter: q.type === 'code' ? (q.code_starter || '') : undefined,
    sample_test_case: q.type === 'code' && Array.isArray(q.test_cases) && q.test_cases.length > 0 ? q.test_cases[0] : null
  };

  res.json({ success: true, data: candidatePreview });
});

// Update question
router.put('/questions/:id', requirePermission(PERMISSIONS.QUESTIONS_UPDATE), validate({ params: idParamSchema, body: updateQuestionSchema }), (req, res) => {
  const result = questionService.updateQuestion({ id: req.params.id, user: req.user, data: req.body });

  recordAuditEvent({
    req,
    event: 'question_updated',
    details: { questionId: req.params.id, version: result.version, status: result.status }
  });

  res.json({ ok: true, version: result.version, status: result.status });
});

// Publish question
router.post('/questions/:id/publish', requirePermission(PERMISSIONS.QUESTIONS_UPDATE), validate({ params: idParamSchema }), (req, res) => {
  const result = questionService.publishQuestion({ id: req.params.id, user: req.user });

  recordAuditEvent({
    req,
    event: 'question_published',
    details: { questionId: req.params.id }
  });

  res.json({ ok: true, status: result.status });
});

// Archive question
router.post('/questions/:id/archive', requirePermission(PERMISSIONS.QUESTIONS_DELETE), validate({ params: idParamSchema }), (req, res) => {
  const result = questionService.archiveQuestion({ id: req.params.id, user: req.user });

  recordAuditEvent({
    req,
    event: 'question_archived',
    details: { questionId: req.params.id }
  });

  res.json({ ok: true, status: result.status });
});

// Delete or archive question
router.delete('/questions/:id', requirePermission(PERMISSIONS.QUESTIONS_DELETE), validate({ params: idParamSchema }), (req, res, next) => {
  const cur = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!cur) return next(new NotFoundError('Question not found'));

  // Tenant Isolation Check
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    if (cur.organization_id === null) {
      recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { target: 'platform_question', id: cur.id } });
      return next(new AuthorizationError('Cannot delete platform-level question'));
    }
    if (cur.organization_id !== req.user.organization_id) {
      recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { target: 'question', id: cur.id, targetOrg: cur.organization_id } });
      return next(new AuthorizationError('Cannot delete question belonging to another organization'));
    }
  }

  // Check if historical attempts reference this question
  const isUsed = db.prepare('SELECT 1 FROM attempts WHERE question_ids_json LIKE ? LIMIT 1').get(`%${req.params.id}%`);
  if (isUsed) {
    // Preserve historical assessment integrity by archiving instead of hard-deleting
    questionService.archiveQuestion({ id: req.params.id, user: req.user });
    recordAuditEvent({
      req,
      event: 'question_archived',
      details: { questionId: req.params.id, reason: 'historical_reference_preserved' }
    });
    return res.json({ ok: true, archived: true, message: 'Question has historical assessment attempts and was archived.' });
  }

  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);

  recordAuditEvent({
    req,
    event: 'question_deleted',
    details: { questionId: req.params.id }
  });

  res.json({ ok: true });
});

/* ---------- Config (Settings) ---------- */

router.get('/config', requirePermission(PERMISSIONS.SETTINGS_READ), (req, res) => {
  res.json(getConfig());
});

router.put('/config', requirePermission(PERMISSIONS.SETTINGS_UPDATE), validate(updateConfigSchema), (req, res, next) => {
  const body = req.body || {};

  // For Org Admin: restrict platform-wide settings (only Super Admin can alter global slabs/credentials)
  if (req.user.role === ROLES.ORG_ADMIN) {
    const allowedOrgAdminKeys = [
      'test_title',
      'duration_minutes',
      'quota_aptitude',
      'quota_technical',
      'quota_coding',
      'shuffle_questions',
      'shuffle_options',
      'brand_name',
      'accent_color'
    ];
    for (const key of Object.keys(body)) {
      if (!allowedOrgAdminKeys.includes(key)) {
        return next(new AuthorizationError(`Organization Admins are not permitted to modify platform setting: "${key}"`));
      }
    }
  }

  for (const [k, v] of Object.entries(body)) {
    if (k === 'scholarship_slabs') {
      setConfig(k, typeof v === 'string' ? v : JSON.stringify(v));
    } else {
      setConfig(k, String(v));
    }
  }

  recordAuditEvent({
    req,
    event: 'config_updated',
    details: { updatedKeys: Object.keys(body) }
  });

  res.json(getConfig());
});

/* ---------- Results & Reports (Tenant Scoped) ---------- */

function buildResultsQuery(filters, user) {
  const where = ["a.status = 'submitted'"];
  const params = [];

  // Tenant scoping: Non-super-admins only see results for their organization
  if (user.role !== ROLES.SUPER_ADMIN && user.organization_id) {
    where.push('(a.organization_id = ? OR s.organization_id = ?)');
    params.push(user.organization_id, user.organization_id);
  } else if (filters.organization_id) {
    where.push('(a.organization_id = ? OR s.organization_id = ?)');
    params.push(Number(filters.organization_id), Number(filters.organization_id));
  }

  if (filters.college) {
    where.push("s.college LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(filters.college)}%`);
  }
  if (filters.track) {
    where.push('s.track = ?');
    params.push(filters.track);
  }
  if (filters.min_percentage !== undefined && filters.min_percentage !== '') {
    where.push('a.percentage >= ?');
    params.push(Number(filters.min_percentage));
  }

  return { where: where.join(' AND '), params };
}

router.get('/results', requirePermission(PERMISSIONS.RESULTS_READ), validate({ query: resultsQuerySchema }), (req, res) => {
  const { where, params } = buildResultsQuery(req.query, req.user);
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);

  const rows = db.prepare(`SELECT a.id AS attempt_id, s.name, s.phone, s.email, s.college, s.city,
    s.grad_year, s.track, s.campaign_code, a.started_at, a.submitted_at, a.tab_switches,
    a.score, a.total_marks, a.percentage, a.scholarship_pct, a.certificate_id, a.claim_code, a.was_late
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE ${where} ORDER BY a.submitted_at DESC LIMIT ?`).all(...params, limit);

  res.json(rows);
});

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/results.csv', requirePermission(PERMISSIONS.RESULTS_EXPORT), validate({ query: resultsQuerySchema }), (req, res) => {
  const { where, params } = buildResultsQuery(req.query, req.user);
  const rows = db.prepare(`SELECT a.id AS attempt_id, s.name, s.phone, s.email, s.college, s.city,
    s.grad_year, s.track, s.campaign_code, a.started_at, a.submitted_at, a.tab_switches,
    a.score, a.total_marks, a.percentage, a.scholarship_pct, a.certificate_id, a.claim_code, a.was_late
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE ${where} ORDER BY a.submitted_at DESC LIMIT 5000`).all(...params);

  const cols = ['attempt_id', 'name', 'phone', 'email', 'college', 'city', 'grad_year', 'track', 'campaign_code', 'started_at', 'submitted_at', 'tab_switches', 'score', 'total_marks', 'percentage', 'scholarship_pct', 'certificate_id', 'claim_code', 'was_late'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));

  recordAuditEvent({
    req,
    event: 'results_exported',
    details: { rowsExported: rows.length }
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="aspire-results.csv"');
  res.send(lines.join('\n'));
});

router.get('/report/college', requirePermission(PERMISSIONS.ANALYTICS_READ), validate({ query: collegeReportQuerySchema }), (req, res) => {
  const college = req.query.college.trim();
  const safeCollegePattern = `%${escapeLike(college)}%`;

  let tenantFilter = '';
  const queryParams = [safeCollegePattern];
  const countParams = [safeCollegePattern];

  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.organization_id) {
    tenantFilter = ' AND (a.organization_id = ? OR s.organization_id = ?)';
    queryParams.push(req.user.organization_id, req.user.organization_id);
    countParams.push(req.user.organization_id, req.user.organization_id);
  }

  const rows = db.prepare(`SELECT s.name, s.phone, s.track, a.percentage, a.scholarship_pct,
    a.score, a.total_marks, a.graded_detail_json, a.submitted_at
    FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted' AND s.college LIKE ? ESCAPE '\\' ${tenantFilter}
    ORDER BY a.percentage DESC`).all(...queryParams);

  const started = db.prepare(`SELECT COUNT(*) AS c FROM attempts a JOIN students s ON s.id = a.student_id
    WHERE s.college LIKE ? ESCAPE '\\' ${tenantFilter}`).get(...countParams).c;

  const catAgg = {};
  for (const r of rows) {
    try {
      const detail = JSON.parse(r.graded_detail_json || '[]');
      for (const d of detail) {
        const c = d.category || 'General';
        catAgg[c] = catAgg[c] || { earned: 0, marks: 0 };
        catAgg[c].earned += d.earned || 0;
        catAgg[c].marks += d.marks || 0;
      }
    } catch { /* ignore malformed detail */ }
  }
  const category_avg = {};
  for (const [c, v] of Object.entries(catAgg)) {
    category_avg[c] = v.marks ? Math.round((v.earned / v.marks) * 1000) / 10 : 0;
  }
  const avg = rows.length ? Math.round((rows.reduce((s, r) => s + r.percentage, 0) / rows.length) * 10) / 10 : 0;

  res.json({
    college,
    started_attempts: started,
    submitted: rows.length,
    avg_percentage: avg,
    category_avg,
    top10: rows.slice(0, 10).map((r) => ({ name: r.name, track: r.track, percentage: r.percentage, scholarship_pct: r.scholarship_pct }))
  });
});

/* ---------- User Management CRUD (Tenant-Scoped) ---------- */

router.get('/users', requirePermission(PERMISSIONS.USERS_READ), (req, res) => {
  let users;
  if (req.user.role === ROLES.SUPER_ADMIN) {
    const orgId = req.query.organization_id ? Number(req.query.organization_id) : null;
    users = userService.listUsers({ organizationId: orgId, role: req.query.role });
  } else {
    // Org Admin can only list users in their own organization
    users = userService.listUsers({ organizationId: req.user.organization_id, role: req.query.role });
  }
  res.json(users);
});

router.post('/users', requirePermission(PERMISSIONS.USERS_CREATE), validate(createUserSchema), async (req, res, next) => {
  const { email, password, name, role, organization_id, status } = req.body;

  // Tenant Boundary & Escalation Protection:
  // Org Admin cannot create SUPER_ADMIN users, and can only create users in their own organization.
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    if (role === ROLES.SUPER_ADMIN) {
      recordAuditEvent({ req, event: 'privilege_escalation_attempt', details: { targetRole: role } });
      return next(new AuthorizationError('Only Super Admins can create Super Admin users.'));
    }
    if (organization_id && Number(organization_id) !== Number(req.user.organization_id)) {
      recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { targetOrg: organization_id } });
      return next(new AuthorizationError('Cannot create users for another organization.'));
    }
  }

  const assignedOrgId = req.user.role === ROLES.SUPER_ADMIN ? (organization_id || null) : req.user.organization_id;

  try {
    const user = await userService.createUser({
      email,
      password,
      name,
      role,
      organizationId: assignedOrgId,
      status: status || 'ACTIVE'
    });

    recordAuditEvent({
      req,
      event: 'user_created',
      details: { createdUserId: user.id, role: user.role, organizationId: user.organization_id }
    });

    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', requirePermission(PERMISSIONS.USERS_READ), validate({ params: idParamSchema }), (req, res, next) => {
  const targetUser = userService.findUserById(req.params.id);
  if (!targetUser) return next(new NotFoundError('User not found'));

  // IDOR Protection: Org Admin can only access users within their organization
  if (req.user.role !== ROLES.SUPER_ADMIN && targetUser.organization_id !== req.user.organization_id) {
    recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { targetUser: targetUser.id } });
    return next(new AuthorizationError('Access denied: user belongs to another organization.'));
  }

  res.json(targetUser);
});

router.put('/users/:id', requirePermission(PERMISSIONS.USERS_UPDATE), validate({ params: idParamSchema, body: updateUserSchema }), (req, res, next) => {
  const targetUser = userService.findUserById(req.params.id);
  if (!targetUser) return next(new NotFoundError('User not found'));

  // IDOR Protection
  if (req.user.role !== ROLES.SUPER_ADMIN) {
    if (targetUser.organization_id !== req.user.organization_id) {
      recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { targetUser: targetUser.id } });
      return next(new AuthorizationError('Access denied: cannot update user from another organization.'));
    }
    if (req.body.role === ROLES.SUPER_ADMIN) {
      recordAuditEvent({ req, event: 'privilege_escalation_attempt', details: { targetUser: targetUser.id } });
      return next(new AuthorizationError('Organization Admins cannot elevate users to Super Admin.'));
    }
    if (req.body.organization_id && Number(req.body.organization_id) !== Number(req.user.organization_id)) {
      return next(new AuthorizationError('Cannot reassign user to another organization.'));
    }
  }

  const updated = userService.updateUser(req.params.id, req.body);

  recordAuditEvent({
    req,
    event: 'user_updated',
    details: { updatedUserId: targetUser.id, changes: Object.keys(req.body) }
  });

  res.json(updated);
});

router.post('/users/:id/disable', requirePermission(PERMISSIONS.USERS_DISABLE), validate({ params: idParamSchema }), (req, res, next) => {
  const targetUser = userService.findUserById(req.params.id);
  if (!targetUser) return next(new NotFoundError('User not found'));

  // IDOR Protection
  if (req.user.role !== ROLES.SUPER_ADMIN && targetUser.organization_id !== req.user.organization_id) {
    recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { targetUser: targetUser.id } });
    return next(new AuthorizationError('Access denied: cannot disable user from another organization.'));
  }

  // Prevent disabling the last Super Admin
  if (targetUser.role === ROLES.SUPER_ADMIN && userService.countSuperAdmins() <= 1) {
    return next(new ValidationError('Cannot disable the last active Super Admin account.'));
  }

  const updated = userService.updateUser(req.params.id, { status: 'DISABLED' });

  recordAuditEvent({
    req,
    event: 'user_disabled',
    details: { disabledUserId: targetUser.id }
  });

  res.json({ ok: true, user: updated });
});

router.post('/users/:id/enable', requirePermission(PERMISSIONS.USERS_DISABLE), validate({ params: idParamSchema }), (req, res, next) => {
  const targetUser = userService.findUserById(req.params.id);
  if (!targetUser) return next(new NotFoundError('User not found'));

  if (req.user.role !== ROLES.SUPER_ADMIN && targetUser.organization_id !== req.user.organization_id) {
    return next(new AuthorizationError('Access denied: cannot enable user from another organization.'));
  }

  const updated = userService.updateUser(req.params.id, { status: 'ACTIVE' });

  recordAuditEvent({
    req,
    event: 'user_enabled',
    details: { enabledUserId: targetUser.id }
  });

  res.json({ ok: true, user: updated });
});

/* ---------- Organizations Management (Multi-Tenancy) ---------- */

router.get('/organizations', requirePermission(PERMISSIONS.ORGANIZATIONS_READ), (req, res) => {
  if (req.user.role === ROLES.SUPER_ADMIN) {
    return res.json(orgService.listOrganizations());
  }
  // Org Admin only sees their own organization
  const org = orgService.findOrganizationById(req.user.organization_id);
  res.json(org ? [org] : []);
});

router.post('/organizations', requirePermission(PERMISSIONS.ORGANIZATIONS_CREATE), validate(createOrganizationSchema), (req, res) => {
  const org = orgService.createOrganization(req.body);

  recordAuditEvent({
    req,
    event: 'organization_created',
    details: { orgId: org.id, name: org.name, slug: org.slug }
  });

  res.status(201).json(org);
});

router.get('/organizations/:id', requirePermission(PERMISSIONS.ORGANIZATIONS_READ), validate({ params: idParamSchema }), (req, res, next) => {
  const org = orgService.findOrganizationById(req.params.id);
  if (!org) return next(new NotFoundError('Organization not found'));

  // IDOR Protection
  if (req.user.role !== ROLES.SUPER_ADMIN && Number(req.user.organization_id) !== Number(org.id)) {
    recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { targetOrg: org.id } });
    return next(new AuthorizationError('Access denied: cannot access another organization.'));
  }

  res.json(org);
});

router.put('/organizations/:id', requirePermission(PERMISSIONS.ORGANIZATIONS_UPDATE), validate({ params: idParamSchema, body: updateOrganizationSchema }), (req, res, next) => {
  const org = orgService.findOrganizationById(req.params.id);
  if (!org) return next(new NotFoundError('Organization not found'));

  // IDOR Protection
  if (req.user.role !== ROLES.SUPER_ADMIN && Number(req.user.organization_id) !== Number(org.id)) {
    recordAuditEvent({ req, event: 'cross_tenant_access_denied', details: { targetOrg: org.id } });
    return next(new AuthorizationError('Access denied: cannot update another organization.'));
  }

  const updated = orgService.updateOrganization(req.params.id, req.body);

  recordAuditEvent({
    req,
    event: 'organization_updated',
    details: { orgId: org.id }
  });

  res.json(updated);
});

module.exports = router;
