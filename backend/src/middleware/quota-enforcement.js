// ============================================================================
// ASPIRE DAY 21: QUOTA & FEATURE ENFORCEMENT MIDDLEWARE
// ============================================================================
// Enforces feature entitlements, subscription status, and pre-flight quota checks.
// Supports SUPER_ADMIN platform overrides.
// ============================================================================

const { ROLES } = require('../security/rbac');
const {
  FeatureNotAvailableError,
  SubscriptionInactiveError,
  QuotaExceededError,
  AuthorizationError
} = require('../errors/app-error');
const {
  getEffectiveFeatures,
  getOrganizationSubscription
} = require('../services/subscription/subscription.service');
const { checkQuota } = require('../services/subscription/quota.service');

/**
 * Middleware requiring a specific feature entitlement.
 * Super Admin bypasses feature restrictions for platform testing and administration.
 */
function requireFeature(featureCode) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthorizationError('Authentication required'));
    }

    // Super Admin has global entitlement
    if (req.user.role === ROLES.SUPER_ADMIN) {
      return next();
    }

    const orgId = req.user.organization_id;
    if (!orgId) {
      return next(new AuthorizationError('User account is not associated with an organization'));
    }

    const features = getEffectiveFeatures(orgId);
    if (!features.includes(featureCode)) {
      return next(new FeatureNotAvailableError(
        `Feature "${featureCode}" is not included in your organization's subscription plan. Please upgrade to access this feature.`,
        featureCode
      ));
    }

    next();
  };
}

/**
 * Middleware ensuring organization has an active or trial subscription.
 */
function requireActiveSubscription(req, res, next) {
  if (!req.user) {
    return next(new AuthorizationError('Authentication required'));
  }

  if (req.user.role === ROLES.SUPER_ADMIN) {
    return next();
  }

  const orgId = req.user.organization_id;
  if (!orgId) {
    return next(new AuthorizationError('User account is not associated with an organization'));
  }

  const sub = getOrganizationSubscription(orgId);
  const activeStatuses = ['ACTIVE', 'TRIAL', 'PAST_DUE'];

  if (!sub || !activeStatuses.includes(sub.status)) {
    return next(new SubscriptionInactiveError(
      `Your organization's subscription is currently ${sub ? sub.status.toLowerCase() : 'unassigned'}. Please contact your administrator.`,
      sub ? sub.status : 'NO_SUBSCRIPTION'
    ));
  }

  next();
}

/**
 * Pre-flight quota check middleware.
 */
function enforceQuota(resourceKey, quantityResolver = () => 1) {
  return (req, res, next) => {
    if (!req.user || req.user.role === ROLES.SUPER_ADMIN) {
      return next();
    }

    const orgId = req.user.organization_id;
    if (!orgId) {
      return next(new AuthorizationError('User account is not associated with an organization'));
    }

    const qty = typeof quantityResolver === 'function' ? quantityResolver(req) : quantityResolver;
    const check = checkQuota(orgId, resourceKey, qty);

    if (!check.allowed) {
      return next(new QuotaExceededError(
        `Quota limit reached for ${resourceKey}. Limit: ${check.quota}, Used: ${check.used}.`,
        { resource: resourceKey, quota: check.quota, used: check.used }
      ));
    }

    if (check.warning) {
      res.setHeader('X-Quota-Warning', '1');
      res.setHeader('X-Quota-Resource', resourceKey);
      res.setHeader('X-Quota-Percentage', String(check.percentage));
    }

    next();
  };
}

module.exports = {
  requireFeature,
  requireActiveSubscription,
  enforceQuota
};

