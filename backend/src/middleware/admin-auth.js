// Administrative Authentication & Role-Based Authorization Middleware.
// Enforces: Identity (JWT + Session) -> Account Status -> RBAC Permissions -> Tenant Isolation.
const { AuthenticationError, AuthorizationError } = require('../errors/app-error');
const { verifyAccessToken } = require('../security/jwt');
const { hasPermission, getRolePermissions, ROLES } = require('../security/rbac');
const { findUserById, sanitizeUser } = require('../services/user.service');
const { findSession, touchSession } = require('../services/session.service');
const { recordAuditEvent } = require('../services/audit.service');

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  let token = null;

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // Strictly reject requests without a Bearer token.
  // Note: Old x-admin-token header is NOT accepted.
  if (!token) {
    return next(new AuthenticationError('Authentication is required.'));
  }

  try {
    // 1. Cryptographic token verification (via jose)
    const payload = await verifyAccessToken(token);

    // 2. Immediate revocation check via server-side session
    if (payload.jti) {
      const session = findSession(payload.jti);
      if (!session) {
        recordAuditEvent({ req, event: 'auth_revoked_session_used', details: { jti: payload.jti } });
        return next(new AuthenticationError('Session has expired or was revoked. Please log in again.'));
      }
      touchSession(payload.jti);
    }

    // 3. User verification and account status check
    const user = findUserById(payload.sub, { includeHash: true });
    if (!user) {
      recordAuditEvent({ req, event: 'auth_user_not_found', details: { sub: payload.sub } });
      return next(new AuthenticationError('User identity not found.'));
    }

    if (user.status !== 'ACTIVE') {
      recordAuditEvent({ req, event: 'auth_disabled_account_attempt', userId: user.id });
      return next(new AuthenticationError('Account is disabled. Please contact an administrator.'));
    }

    // 4. Token version check (invalidates tokens issued prior to password/role change)
    if (payload.token_version !== undefined && payload.token_version !== user.token_version) {
      recordAuditEvent({ req, event: 'auth_stale_token_version', userId: user.id });
      return next(new AuthenticationError('Session invalidated due to security changes. Please log in again.'));
    }

    // 5. Attach safe identity and permissions to request context
    req.user = sanitizeUser(user);
    req.user.permissions = getRolePermissions(user.role);
    req.user.sessionId = payload.jti || null;

    next();
  } catch (err) {
    recordAuditEvent({ req, event: 'auth_token_verification_failed', details: { error: err.message } });
    next(err instanceof AuthenticationError ? err : new AuthenticationError('Invalid authentication token.'));
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthenticationError('Authentication is required.'));
    }

    if (!hasPermission(req.user.role, permission)) {
      recordAuditEvent({
        req,
        event: 'permission_denied',
        userId: req.user.id,
        organizationId: req.user.organization_id,
        details: {
          role: req.user.role,
          requiredPermission: permission,
          endpoint: req.originalUrl,
          method: req.method
        }
      });
      return next(new AuthorizationError('You do not have permission to perform this action.'));
    }

    next();
  };
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthenticationError('Authentication is required.'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      recordAuditEvent({
        req,
        event: 'role_forbidden',
        userId: req.user.id,
        organizationId: req.user.organization_id,
        details: {
          role: req.user.role,
          allowedRoles,
          endpoint: req.originalUrl,
          method: req.method
        }
      });
      return next(new AuthorizationError('You do not have access to this resource.'));
    }

    next();
  };
}

module.exports = {
  requireAuth,
  requirePermission,
  requireRole,
  // Alias for backward compatibility if imported as default or adminAuth
  adminAuth: requireAuth
};
