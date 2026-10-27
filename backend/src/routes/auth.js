// Authentication API routes: Login, Logout, and Identity.
const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/admin-auth');
const { loginSchema } = require('../validation/auth.schemas');
const { authLoginLimiter } = require('../security/rate-limit');
const { AuthenticationError } = require('../errors/app-error');
const { findUserByEmail, recordLogin, sanitizeUser } = require('../services/user.service');
const { verifyPassword, signAccessToken } = require('../security/jwt');
const { createSession, deleteSession } = require('../services/session.service');
const { recordAuditEvent } = require('../services/audit.service');
const { getRolePermissions } = require('../security/rbac');

const router = express.Router();

// 1. Admin login endpoint
router.post('/login', authLoginLimiter, validate(loginSchema), async (req, res, next) => {
  const { email, password } = req.body;
  const ip = req.ip || req.connection?.remoteAddress;

  try {
    const user = findUserByEmail(email, { includeHash: true });

    // Timing-consistent check: always verify password even if user is not found to deter timing attacks
    const dummyHash = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const hashToVerify = user ? user.password_hash : dummyHash;
    const isValidPassword = await verifyPassword(password, hashToVerify);

    if (!user || !isValidPassword) {
      recordAuditEvent({
        req,
        event: 'login_failure',
        details: { emailAttempted: email },
        ipAddress: ip
      });
      // Generic error message to prevent account enumeration
      return next(new AuthenticationError('Invalid email or password.'));
    }

    if (user.status !== 'ACTIVE') {
      recordAuditEvent({
        req,
        event: 'login_disabled_account',
        userId: user.id,
        organizationId: user.organization_id,
        ipAddress: ip
      });
      return next(new AuthenticationError('This account is disabled. Please contact your administrator.'));
    }

    // Determine session expiration (e.g. 2 hours from now)
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    // 1. Create server-side session for immediate revocation capability
    const sessionId = createSession({
      userId: user.id,
      ipAddress: ip,
      userAgent: req.headers['user-agent'] || null,
      expiresAt
    });

    // 2. Sign JWT with jose
    const token = await signAccessToken({
      sub: String(user.id),
      role: user.role,
      organization_id: user.organization_id || null,
      token_version: user.token_version,
      jti: sessionId
    });

    // 3. Update last login timestamp
    recordLogin(user.id);

    // 4. Record audit success
    recordAuditEvent({
      req,
      event: 'login_success',
      userId: user.id,
      organizationId: user.organization_id,
      ipAddress: ip
    });

    const safeUser = sanitizeUser(user);
    safeUser.permissions = getRolePermissions(user.role);

    res.json({
      success: true,
      data: {
        user: safeUser,
        token
      }
    });
  } catch (err) {
    next(err);
  }
});

// 2. Admin logout endpoint
router.post('/logout', requireAuth, (req, res, next) => {
  try {
    if (req.user && req.user.sessionId) {
      deleteSession(req.user.sessionId);
    }

    recordAuditEvent({
      req,
      event: 'logout',
      userId: req.user?.id,
      organizationId: req.user?.organization_id
    });

    res.json({
      success: true,
      message: 'Logged out successfully.'
    });
  } catch (err) {
    next(err);
  }
});

// 3. Current authenticated user profile and permissions
router.get('/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    data: {
      user: req.user
    }
  });
});

module.exports = router;
