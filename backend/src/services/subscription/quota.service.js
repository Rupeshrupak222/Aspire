// ============================================================================
// ASPIRE DAY 21: ATOMIC QUOTA ENFORCEMENT ENGINE
// ============================================================================
// Guarantees atomic verification, conditional reservation/consumption,
// idempotency protection, soft-limit warnings, and hard-limit blocks.
// ============================================================================

const { db } = require('../../db');
const {
  QuotaExceededError,
  SubscriptionInactiveError,
  ValidationError,
  NotFoundError
} = require('../../errors/app-error');
const {
  getOrganizationSubscription,
  getEffectiveQuotas,
  getEffectiveFeatures
} = require('./subscription.service');
const {
  getOrCreateCounter,
  getUsage,
  recordUsageEvent
} = require('./usage.service');
const { recordAuditEvent } = require('../audit.service');

const ACTIVE_STATUSES = ['ACTIVE', 'TRIAL', 'PAST_DUE'];

/**
 * Resolves period bounds for a given subscription and resource.
 */
function resolveResourcePeriod(sub, resourceKey) {
  const now = new Date();
  if (sub && sub.currentPeriodStart && sub.currentPeriodEnd) {
    return {
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd
    };
  }
  // Default to calendar month bounds
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { periodStart, periodEnd };
}

/**
 * Pre-flight quota check without consuming units.
 */
function checkQuota(organizationId, resourceKey, quantity = 1) {
  const sub = getOrganizationSubscription(organizationId);
  if (!sub) {
    return {
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
      message: 'Organization has no subscription assigned.'
    };
  }

  if (!ACTIVE_STATUSES.includes(sub.status)) {
    return {
      allowed: false,
      reason: 'SUBSCRIPTION_INACTIVE',
      status: sub.status,
      message: `Subscription is currently ${sub.status.toLowerCase()}.`
    };
  }

  const effectiveQuotas = getEffectiveQuotas(organizationId);
  const quota = effectiveQuotas[resourceKey];

  const { periodStart, periodEnd } = resolveResourcePeriod(sub, resourceKey);
  const usage = getUsage(organizationId, resourceKey, periodStart, periodEnd);
  const currentTotal = usage.used + usage.reserved;

  // Explicit null represents UNLIMITED quota
  if (quota === null || quota === undefined) {
    return {
      allowed: true,
      unlimited: true,
      used: usage.used,
      reserved: usage.reserved,
      quota: null,
      remaining: null,
      percentage: 0,
      warning: false,
      softLimitPct: sub.plan?.softLimitPct ?? 80,
      periodStart,
      periodEnd
    };
  }

  const projectedTotal = currentTotal + quantity;
  const allowed = projectedTotal <= quota;
  const remaining = Math.max(0, quota - currentTotal);
  const projectedRemaining = Math.max(0, quota - projectedTotal);
  const percentage = quota > 0 ? Math.min(100, Math.round((projectedTotal / quota) * 100)) : 100;
  const softLimitPct = sub.plan?.softLimitPct ?? 80;
  const warning = allowed && percentage >= softLimitPct;

  return {
    allowed,
    unlimited: false,
    used: usage.used,
    reserved: usage.reserved,
    quota,
    remaining,
    projectedRemaining,
    percentage,
    warning,
    softLimitPct,
    periodStart,
    periodEnd
  };
}

/**
 * Atomically consumes quota with conditional update and idempotency protection.
 * Throws QuotaExceededError or SubscriptionInactiveError on violation.
 */
function consumeQuota({
  organizationId,
  resourceKey,
  quantity = 1,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null,
  metadata = {}
}) {
  if (quantity <= 0) {
    throw new ValidationError('Quantity to consume must be greater than zero.');
  }

  const sub = getOrganizationSubscription(organizationId);
  if (!sub || !ACTIVE_STATUSES.includes(sub.status)) {
    throw new SubscriptionInactiveError(
      `Cannot perform operation: organization subscription is ${sub ? sub.status.toLowerCase() : 'unassigned'}.`,
      sub ? sub.status : 'NO_SUBSCRIPTION'
    );
  }

  const effectiveQuotas = getEffectiveQuotas(organizationId);
  const quota = effectiveQuotas[resourceKey];
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, resourceKey);

  let result = null;

  // Execute in an immediate transaction for atomic row locking and conditional update
  const executeAtomic = db.transaction(() => {
    // 1. Idempotency Check: If key already processed, return previous event without double consumption
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM organization_usage_events WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        const currentCounter = getUsage(organizationId, resourceKey, periodStart, periodEnd);
        return {
          success: true,
          isDuplicate: true,
          allowed: true,
          used: currentCounter.used,
          quota,
          remaining: quota !== null ? Math.max(0, quota - currentCounter.used) : null
        };
      }
    }

    // 2. Ensure counter row exists
    getOrCreateCounter(organizationId, resourceKey, periodStart, periodEnd, sub.id);

    // 3. Conditional verification under lock
    const counter = db.prepare(`
      SELECT used, reserved FROM organization_usage_counters
      WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
    `).get(organizationId, resourceKey, periodStart, periodEnd);

    const currentUsed = counter ? counter.used : 0;
    const currentReserved = counter ? counter.reserved : 0;

    if (quota !== null && quota !== undefined) {
      if (currentUsed + currentReserved + quantity > quota) {
        throw new QuotaExceededError(
          `Plan quota exceeded for ${resourceKey}. Limit: ${quota}, Used: ${currentUsed}, Requested: ${quantity}.`,
          { resource: resourceKey, quota, used: currentUsed, requested: quantity }
        );
      }
    }

    // 4. Atomic conditional update
    db.prepare(`
      UPDATE organization_usage_counters
      SET used = used + ?, updated_at = datetime('now')
      WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
    `).run(quantity, organizationId, resourceKey, periodStart, periodEnd);

    // 5. Audit event log
    recordUsageEvent({
      organizationId,
      subscriptionId: sub.id,
      resourceKey,
      eventType: 'CONSUMED',
      quantity,
      referenceType,
      referenceId,
      idempotencyKey,
      metadata
    });

    const newUsed = currentUsed + quantity;
    const remaining = quota !== null ? Math.max(0, quota - newUsed) : null;
    const softLimitPct = sub.plan?.softLimitPct ?? 80;
    const pct = quota ? Math.min(100, Math.round((newUsed / quota) * 100)) : 0;
    const warning = quota !== null && pct >= softLimitPct;

    return {
      success: true,
      isDuplicate: false,
      allowed: true,
      used: newUsed,
      quota,
      remaining,
      warning,
      softLimitPct
    };
  });

  result = executeAtomic();
  return result;
}

/**
 * Atomically reserves quota for long-running workflows.
 */
function reserveQuota({
  organizationId,
  resourceKey,
  quantity = 1,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null
}) {
  const sub = getOrganizationSubscription(organizationId);
  if (!sub || !ACTIVE_STATUSES.includes(sub.status)) {
    throw new SubscriptionInactiveError('Subscription is inactive', sub ? sub.status : null);
  }

  const effectiveQuotas = getEffectiveQuotas(organizationId);
  const quota = effectiveQuotas[resourceKey];
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, resourceKey);

  return db.transaction(() => {
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM organization_usage_events WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return { success: true, isDuplicate: true };
    }

    getOrCreateCounter(organizationId, resourceKey, periodStart, periodEnd, sub.id);

    const counter = db.prepare(`
      SELECT used, reserved FROM organization_usage_counters
      WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
    `).get(organizationId, resourceKey, periodStart, periodEnd);

    const used = counter ? counter.used : 0;
    const reserved = counter ? counter.reserved : 0;

    if (quota !== null && quota !== undefined) {
      if (used + reserved + quantity > quota) {
        throw new QuotaExceededError(`Cannot reserve ${resourceKey}: quota exceeded.`, { resource: resourceKey, quota, used, reserved });
      }
    }

    db.prepare(`
      UPDATE organization_usage_counters
      SET reserved = reserved + ?, updated_at = datetime('now')
      WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
    `).run(quantity, organizationId, resourceKey, periodStart, periodEnd);

    recordUsageEvent({
      organizationId,
      subscriptionId: sub.id,
      resourceKey,
      eventType: 'RESERVED',
      quantity,
      referenceType,
      referenceId,
      idempotencyKey
    });

    return { success: true, reserved: reserved + quantity };
  })();
}

/**
 * Releases previously reserved quota.
 */
function releaseQuota({
  organizationId,
  resourceKey,
  quantity = 1,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null
}) {
  const sub = getOrganizationSubscription(organizationId);
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, resourceKey);

  return db.transaction(() => {
    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM organization_usage_events WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return { success: true, isDuplicate: true };
    }

    db.prepare(`
      UPDATE organization_usage_counters
      SET reserved = MAX(0, reserved - ?), updated_at = datetime('now')
      WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
    `).run(quantity, organizationId, resourceKey, periodStart, periodEnd);

    recordUsageEvent({
      organizationId,
      subscriptionId: sub ? sub.id : null,
      resourceKey,
      eventType: 'RELEASED',
      quantity,
      referenceType,
      referenceId,
      idempotencyKey
    });

    return { success: true };
  })();
}

/**
 * Manually adjusts a quota counter (SUPER_ADMIN action).
 */
function adjustQuota({
  organizationId,
  resourceKey,
  quantity,
  reason,
  actorId = null
}) {
  const sub = getOrganizationSubscription(organizationId);
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, resourceKey);

  db.transaction(() => {
    getOrCreateCounter(organizationId, resourceKey, periodStart, periodEnd, sub ? sub.id : null);

    db.prepare(`
      UPDATE organization_usage_counters
      SET used = MAX(0, used + ?), updated_at = datetime('now')
      WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
    `).run(quantity, organizationId, resourceKey, periodStart, periodEnd);

    recordUsageEvent({
      organizationId,
      subscriptionId: sub ? sub.id : null,
      resourceKey,
      eventType: 'ADJUSTED',
      quantity,
      referenceType: 'admin_adjustment',
      referenceId: String(actorId),
      metadata: { reason, actorId }
    });
  })();

  recordAuditEvent({
    event: 'quota_adjusted',
    userId: actorId,
    organizationId,
    details: { resourceKey, quantity, reason }
  });

  return getUsage(organizationId, resourceKey, periodStart, periodEnd);
}

/**
 * Generates an executive summary of current subscription and metered resources.
 */
function getQuotaSummary(organizationId) {
  const sub = getOrganizationSubscription(organizationId);
  if (!sub) {
    return {
      hasSubscription: false,
      subscription: null,
      resources: {}
    };
  }

  const effectiveQuotas = getEffectiveQuotas(organizationId);
  const effectiveFeatures = getEffectiveFeatures(organizationId);
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, 'exams_monthly');

  const resources = {};
  const standardKeys = ['exams_monthly', 'candidates'];

  for (const key of standardKeys) {
    const q = effectiveQuotas[key];
    const u = getUsage(organizationId, key, periodStart, periodEnd);
    const used = u.used;
    const reserved = u.reserved;
    const total = used + reserved;
    const isUnlimited = q === null || q === undefined;
    const pct = isUnlimited ? 0 : (q > 0 ? Math.min(100, Math.round((total / q) * 100)) : 100);
    const softLimitPct = sub.plan?.softLimitPct ?? 80;
    const isExceeded = !isUnlimited && total >= q;
    const isWarning = !isUnlimited && !isExceeded && pct >= softLimitPct;

    resources[key] = {
      key,
      label: key === 'exams_monthly' ? 'Published Exams' : 'Registered Candidates',
      used,
      reserved,
      total,
      quota: q,
      isUnlimited,
      remaining: isUnlimited ? null : Math.max(0, q - total),
      percentage: pct,
      softLimitPct,
      isWarning,
      isExceeded
    };
  }

  return {
    hasSubscription: true,
    subscription: {
      id: sub.id,
      status: sub.status,
      startsAt: sub.startsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      trialEndsAt: sub.trialEndsAt,
      notes: sub.notes
    },
    plan: sub.plan ? {
      id: sub.plan.id,
      code: sub.plan.code,
      name: sub.plan.name,
      description: sub.plan.description,
      softLimitPct: sub.plan.softLimitPct
    } : null,
    features: effectiveFeatures,
    resources
  };
}

module.exports = {
  resolveResourcePeriod,
  checkQuota,
  consumeQuota,
  reserveQuota,
  releaseQuota,
  adjustQuota,
  getQuotaSummary
};
