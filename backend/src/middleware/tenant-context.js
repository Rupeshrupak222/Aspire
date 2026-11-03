// Multi-Tenant Context Middleware.
// Resolves authenticated organization identity, validates tenant account status,
// prevents client-side tenant parameter injection/spoofing, and binds AsyncLocalStorage.

const { ROLES } = require('../security/rbac');
const { AuthorizationError, AuthenticationError } = require('../errors/app-error');
const { createTenantContext, runWithTenant } = require('../utils/tenant-context');
const { db } = require('../db');
const { recordAuditEvent } = require('../services/audit.service');

/**
 * Express middleware to establish AsyncLocalStorage tenant context.
 * Must be mounted immediately after authentication middleware (e.g. requireAuth).
 */
function tenantContextMiddleware(req, res, next) {
  if (!req.user) {
    return next();
  }

  const isPlatformSuperAdmin = req.user.role === ROLES.SUPER_ADMIN;
  let resolvedOrgId = null;

  if (isPlatformSuperAdmin) {
    // Platform Super Admin: Can optionally target a specific organization via query or header,
    // or operate in global platform mode.
    const requestedOrg = req.query.organization_id || req.headers['x-organization-id'];
    if (requestedOrg) {
      const parsedId = Number(requestedOrg);
      if (Number.isInteger(parsedId) && parsedId > 0) {
        const org = db.prepare('SELECT id, status FROM organizations WHERE id = ?').get(parsedId);
        if (org) {
          resolvedOrgId = org.id;
        }
      }
    }
  } else {
    // Ordinary organization member (ORG_ADMIN, EXAM_MANAGER, EVALUATOR, VIEWER):
    // Identity is strictly bound to server-authenticated membership.
    if (!req.user.organization_id) {
      return next(new AuthorizationError('User account is not assigned to an organization.'));
    }

    resolvedOrgId = Number(req.user.organization_id);

    // Defend against client-side parameter injection:
    // If client provided a differing organization_id in body, query, or headers, reject or sanitize.
    const clientHeaderOrg = req.headers['x-organization-id'];
    const clientBodyOrg = req.body && req.body.organization_id;
    const clientQueryOrg = req.query && req.query.organization_id;

    if (
      (clientHeaderOrg && Number(clientHeaderOrg) !== resolvedOrgId) ||
      (clientBodyOrg && Number(clientBodyOrg) !== resolvedOrgId) ||
      (clientQueryOrg && Number(clientQueryOrg) !== resolvedOrgId)
    ) {
      recordAuditEvent({
        req,
        event: 'cross_tenant_spoofing_attempt',
        userId: req.user.id,
        organizationId: resolvedOrgId,
        details: {
          attemptedOrgHeader: clientHeaderOrg,
          attemptedOrgBody: clientBodyOrg,
          attemptedOrgQuery: clientQueryOrg
        }
      });
      return next(new AuthorizationError('Cross-tenant parameter manipulation detected. Access denied.'));
    }

    // Verify organization active status in database
    const org = db.prepare('SELECT id, status FROM organizations WHERE id = ?').get(resolvedOrgId);
    if (!org) {
      return next(new AuthorizationError('Assigned organization does not exist.'));
    }

    if (org.status === 'SUSPENDED' || org.status === 'DISABLED') {
      recordAuditEvent({
        req,
        event: 'suspended_organization_access_attempt',
        userId: req.user.id,
        organizationId: resolvedOrgId,
        details: { status: org.status }
      });
      return next(new AuthorizationError(`Organization account is ${org.status.toLowerCase()}. Please contact platform support.`));
    }
  }

  // Build immutable AsyncLocalStorage context
  const tenantContext = createTenantContext({
    organizationId: resolvedOrgId,
    userId: req.user.id,
    role: req.user.role,
    requestId: req.id || req.headers['x-request-id'] || null,
    isPlatformAdmin: isPlatformSuperAdmin
  });

  // Attach context to req for inspection
  req.tenantContext = tenantContext;

  // Execute downstream middleware and route handlers inside the thread-local context
  runWithTenant(tenantContext, () => {
    next();
  });
}

module.exports = {
  tenantContextMiddleware
};

