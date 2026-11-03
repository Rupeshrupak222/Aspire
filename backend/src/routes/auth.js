// Authentication API routes: Login, Logout, and Identity.
const express = require('express');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/admin-auth');
const { loginSchema } = require('../validation/auth.schemas');
const { authLoginLimiter } = require('../security/rate-limit');
const { AuthenticationError, AuthorizationError } = require('../errors/app-error');
const { findUserByEmail, recordLogin, sanitizeUser } = require('../services/user.service');
const { findOrganizationById } = require('../services/organization.service');
const { verifyPassword, signAccessToken } = require('../security/jwt');
const { createSession, deleteSession } = require('../services/session.service');
const { recordAuditEvent } = require('../services/audit.service');
const { getRolePermissions } = require('../security/rbac');
const invitationService = require('../services/invitation.service');
const { acceptInvitationSchema } = require('../validation/organization.schemas');

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

    if (user.organization_id) {
      const org = findOrganizationById(user.organization_id);
      if (org && (org.status === 'SUSPENDED' || org.status === 'DISABLED')) {
        recordAuditEvent({
          req,
          event: 'login_suspended_organization',
          userId: user.id,
          organizationId: user.organization_id,
          ipAddress: ip
        });
        return next(new AuthorizationError('Your organization account is currently suspended or disabled. Please contact support.', 'ORGANIZATION_INACTIVE'));
      }
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

// 4. Inspect invitation details (Public)
router.get('/invitations/:token', (req, res, next) => {
  try {
    const invite = invitationService.getInvitationByToken(req.params.token);
    res.json({
      success: true,
      data: invite
    });
  } catch (err) {
    next(err);
  }
});

// 5. Accept invitation and create account (Public)
router.post('/invitations/accept', validate({ body: acceptInvitationSchema }), async (req, res, next) => {
  try {
    const result = await invitationService.acceptInvitation({
      rawToken: req.body.token,
      name: req.body.name,
      password: req.body.password
    });

    const ip = req.ip || req.connection?.remoteAddress;
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const sessionId = createSession({
      userId: result.user.id,
      ipAddress: ip,
      userAgent: req.headers['user-agent'] || null,
      expiresAt
    });

    const token = await signAccessToken({
      sub: String(result.user.id),
      role: result.user.role,
      organization_id: result.user.organization_id || null,
      token_version: result.user.token_version,
      jti: sessionId
    });

    recordLogin(result.user.id);

    recordAuditEvent({
      req,
      event: 'invitation_accepted',
      userId: result.user.id,
      organizationId: result.organizationId,
      details: { email: result.user.email, role: result.user.role }
    });

    res.status(201).json({
      success: true,
      data: {
        ...result,
        token
      },
      message: 'Invitation accepted and account created successfully.'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
