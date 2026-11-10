// ============================================================================
// ASPIRE DAY 21: SUBSCRIPTION LIFECYCLE SERVICE
// ============================================================================
// Manages organization plan attachments, subscription state transitions,
// trial periods, and per-tenant feature/quota overrides.
// ============================================================================

const { db } = require('../../db');
const { NotFoundError, ValidationError, ConflictError } = require('../../errors/app-error');
const { getPlanById, getPlanByCode } = require('./plan.service');
const { recordAuditEvent } = require('../audit.service');

function deserializeSubscription(row) {
  if (!row) return null;
  let overrideQuotas = null;
  let overrideFeatures = null;

  if (row.override_quotas_json) {
    try {
      overrideQuotas = JSON.parse(row.override_quotas_json);
    } catch {
      overrideQuotas = null;
    }
  }
  if (row.override_features_json) {
    try {
      overrideFeatures = JSON.parse(row.override_features_json);
    } catch {
      overrideFeatures = null;
    }
  }

  let planFeatures = [];
  let planQuotas = {};
  if (row.plan_features_json) {
    try { planFeatures = JSON.parse(row.plan_features_json); } catch {}
  }
  if (row.plan_quotas_json) {
    try { planQuotas = JSON.parse(row.plan_quotas_json); } catch {}
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    planId: row.plan_id,
    status: row.status,
    startsAt: row.starts_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at || null,
    gracePeriodEndsAt: row.grace_period_ends_at || null,
    overrideQuotas,
    overrideFeatures,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    plan: row.plan_code ? {
      id: row.plan_id,
      code: row.plan_code,
      name: row.plan_name,
      description: row.plan_description,
      features: planFeatures,
      quotas: planQuotas,
      softLimitPct: row.plan_soft_limit ?? 80
    } : null
  };
}

/**
 * Retrieves the currently active subscription for an organization.
 */
function getOrganizationSubscription(organizationId) {
  if (!organizationId) return null;
  const row = db.prepare(`
    SELECT s.*,
           p.code as plan_code,
           p.name as plan_name,
           p.description as plan_description,
           p.features_json as plan_features_json,
           p.quotas_json as plan_quotas_json,
           p.soft_limit_pct as plan_soft_limit
    FROM organization_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.organization_id = ? AND s.status IN ('ACTIVE', 'TRIAL', 'PAST_DUE')
    ORDER BY s.id DESC
    LIMIT 1
  `).get(organizationId);

  if (row) return deserializeSubscription(row);

  // If no active/trial subscription, fetch latest subscription (e.g. suspended, cancelled, expired)
  const fallbackRow = db.prepare(`
    SELECT s.*,
           p.code as plan_code,
           p.name as plan_name,
           p.description as plan_description,
           p.features_json as plan_features_json,
           p.quotas_json as plan_quotas_json,
           p.soft_limit_pct as plan_soft_limit
    FROM organization_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.organization_id = ?
    ORDER BY s.id DESC
    LIMIT 1
  `).get(organizationId);

  if (fallbackRow) return deserializeSubscription(fallbackRow);

  // Auto-provision ENTERPRISE for existing orgs without subscription
  try {
    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationId);
    if (org) {
      const enterprisePlan = db.prepare("SELECT * FROM subscription_plans WHERE code = 'ENTERPRISE'").get();
      if (enterprisePlan) {
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
        db.prepare(`
          INSERT INTO organization_subscriptions (
            organization_id, plan_id, status, starts_at, current_period_start, current_period_end, created_at, updated_at
          ) VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
        `).run(organizationId, enterprisePlan.id, now.toISOString(), periodStart, periodEnd, now.toISOString(), now.toISOString());

        const newSub = db.prepare(`
          SELECT s.*,
                 p.code as plan_code,
                 p.name as plan_name,
                 p.description as plan_description,
                 p.features_json as plan_features_json,
                 p.quotas_json as plan_quotas_json,
                 p.soft_limit_pct as plan_soft_limit
          FROM organization_subscriptions s
          JOIN subscription_plans p ON p.id = s.plan_id
          WHERE s.organization_id = ? AND s.status IN ('ACTIVE', 'TRIAL', 'PAST_DUE')
          ORDER BY s.id DESC
          LIMIT 1
        `).get(organizationId);
        if (newSub) return deserializeSubscription(newSub);
      }
    }
  } catch (err) {}

  return null;
}

/**
 * Returns effective quotas for an organization by merging base plan quotas with overrides.
 * Note: null represents UNLIMITED quota.
 */
function getEffectiveQuotas(organizationId) {
  const sub = getOrganizationSubscription(organizationId);
  if (!sub || !sub.plan) {
    // Default fallback to Starter quotas if unassigned
    return { exams_monthly: 3, candidates: 500 };
  }

  const baseQuotas = { ...sub.plan.quotas };
  if (sub.overrideQuotas && typeof sub.overrideQuotas === 'object') {
    for (const [key, val] of Object.entries(sub.overrideQuotas)) {
      baseQuotas[key] = val; // null overrides to unlimited, number overrides to specific limit
    }
  }

  return baseQuotas;
}

/**
 * Returns effective features array for an organization.
 */
function getEffectiveFeatures(organizationId) {
  const sub = getOrganizationSubscription(organizationId);
  if (!sub || !sub.plan) {
    return ['BASIC_ANALYTICS', 'STANDARD_ASSESSMENT'];
  }

  const featureSet = new Set(sub.plan.features || []);
  if (Array.isArray(sub.overrideFeatures)) {
    for (const feat of sub.overrideFeatures) {
      featureSet.add(feat);
    }
  }

  return Array.from(featureSet);
}

/**
 * Assigns or switches subscription for an organization.
 */
function assignSubscription({
  organizationId,
  planCodeOrId,
  status = 'ACTIVE',
  startsAt = null,
  periodStart = null,
  periodEnd = null,
  trialEndsAt = null,
  gracePeriodEndsAt = null,
  overrideQuotas = null,
  overrideFeatures = null,
  notes = '',
  actorId = null
}) {
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(organizationId);
  if (!org) {
    throw new NotFoundError(`Organization #${organizationId} not found.`);
  }

  let plan = null;
  if (typeof planCodeOrId === 'number' || /^\d+$/.test(planCodeOrId)) {
    plan = getPlanById(Number(planCodeOrId));
  } else {
    plan = getPlanByCode(planCodeOrId);
  }

  if (!plan) {
    throw new NotFoundError(`Subscription plan "${planCodeOrId}" not found.`);
  }

  const now = new Date();
  const actualStartsAt = startsAt || now.toISOString();
  const actualPeriodStart = periodStart || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const actualPeriodEnd = periodEnd || new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

  let newSubId = null;

  db.transaction(() => {
    // If active subscription already exists, close/expire it
    db.prepare(`
      UPDATE organization_subscriptions
      SET status = 'CANCELLED', updated_at = datetime('now')
      WHERE organization_id = ? AND status IN ('ACTIVE', 'TRIAL', 'PAST_DUE')
    `).run(organizationId);

    const res = db.prepare(`
      INSERT INTO organization_subscriptions (
        organization_id, plan_id, status, starts_at, current_period_start, current_period_end,
        trial_ends_at, grace_period_ends_at, override_quotas_json, override_features_json, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      organizationId,
      plan.id,
      status,
      actualStartsAt,
      actualPeriodStart,
      actualPeriodEnd,
      trialEndsAt,
      gracePeriodEndsAt,
      overrideQuotas ? JSON.stringify(overrideQuotas) : null,
      overrideFeatures ? JSON.stringify(overrideFeatures) : null,
      notes
    );

    newSubId = res.lastInsertRowid;
  })();

  recordAuditEvent({
    event: 'subscription_assigned',
    userId: actorId,
    organizationId,
    details: {
      subscriptionId: newSubId,
      planCode: plan.code,
      status,
      periodStart: actualPeriodStart,
      periodEnd: actualPeriodEnd
    }
  });

  return getOrganizationSubscription(organizationId);
}

/**
 * Updates subscription metadata, status, or overrides.
 */
function updateSubscription(organizationId, updates, actorId = null) {
  const current = getOrganizationSubscription(organizationId);
  if (!current) {
    throw new NotFoundError(`No subscription found for organization #${organizationId}`);
  }

  const fields = [];
  const params = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.plan_id !== undefined || updates.plan_code !== undefined) {
    const p = updates.plan_id ? getPlanById(updates.plan_id) : getPlanByCode(updates.plan_code);
    if (!p) throw new NotFoundError('Target plan not found');
    fields.push('plan_id = ?');
    params.push(p.id);
  }
  if (updates.current_period_start !== undefined) {
    fields.push('current_period_start = ?');
    params.push(updates.current_period_start);
  }
  if (updates.current_period_end !== undefined) {
    fields.push('current_period_end = ?');
    params.push(updates.current_period_end);
  }
  if (updates.trial_ends_at !== undefined) {
    fields.push('trial_ends_at = ?');
    params.push(updates.trial_ends_at);
  }
  if (updates.grace_period_ends_at !== undefined) {
    fields.push('grace_period_ends_at = ?');
    params.push(updates.grace_period_ends_at);
  }
  if (updates.override_quotas !== undefined) {
    fields.push('override_quotas_json = ?');
    params.push(updates.override_quotas ? JSON.stringify(updates.override_quotas) : null);
  }
  if (updates.override_features !== undefined) {
    fields.push('override_features_json = ?');
    params.push(updates.override_features ? JSON.stringify(updates.override_features) : null);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    params.push(updates.notes);
  }

  if (fields.length === 0) return current;

  fields.push("updated_at = datetime('now')");
  params.push(current.id);

  db.prepare(`
    UPDATE organization_subscriptions SET ${fields.join(', ')} WHERE id = ?
  `).run(...params);

  recordAuditEvent({
    event: 'subscription_updated',
    userId: actorId,
    organizationId,
    details: { subscriptionId: current.id, updates }
  });

  return getOrganizationSubscription(organizationId);
}

function suspendSubscription(organizationId, reason = '', actorId = null) {
  return updateSubscription(organizationId, { status: 'SUSPENDED', notes: reason }, actorId);
}

function resumeSubscription(organizationId, actorId = null) {
  return updateSubscription(organizationId, { status: 'ACTIVE' }, actorId);
}

function cancelSubscription(organizationId, reason = '', actorId = null) {
  return updateSubscription(organizationId, { status: 'CANCELLED', notes: reason }, actorId);
}

function getSubscriptionHistory(organizationId) {
  const rows = db.prepare(`
    SELECT s.*, p.code as plan_code, p.name as plan_name
    FROM organization_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.organization_id = ?
    ORDER BY s.id DESC
  `).all(organizationId);

  return rows.map((r) => ({
    id: r.id,
    planCode: r.plan_code,
    planName: r.plan_name,
    status: r.status,
    startsAt: r.starts_at,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    notes: r.notes || '',
    createdAt: r.created_at
  }));
}

module.exports = {
  getOrganizationSubscription,
  getEffectiveQuotas,
  getEffectiveFeatures,
  assignSubscription,
  updateSubscription,
  suspendSubscription,
  resumeSubscription,
  cancelSubscription,
  getSubscriptionHistory
};
