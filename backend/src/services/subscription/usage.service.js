// ============================================================================
// ASPIRE DAY 21: USAGE TRACKING SERVICE
// ============================================================================
// Manages period-scoped usage counters and idempotent usage audit events.
// Supports CONSUMED, RESERVED, RELEASED, ADJUSTED, and REVERSED events.
// ============================================================================

const { db } = require('../../db');
const { ConflictError, ValidationError } = require('../../errors/app-error');

/**
 * Returns or creates the counter for an organization, resource, and period.
 */
function getOrCreateCounter(organizationId, resourceKey, periodStart, periodEnd, subscriptionId = null) {
  let counter = db.prepare(`
    SELECT * FROM organization_usage_counters
    WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
  `).get(organizationId, resourceKey, periodStart, periodEnd);

  if (!counter) {
    try {
      const res = db.prepare(`
        INSERT INTO organization_usage_counters (
          organization_id, subscription_id, resource_key, period_start, period_end, used, reserved
        ) VALUES (?, ?, ?, ?, ?, 0, 0)
      `).run(organizationId, subscriptionId, resourceKey, periodStart, periodEnd);

      counter = db.prepare('SELECT * FROM organization_usage_counters WHERE id = ?').get(res.lastInsertRowid);
    } catch (err) {
      // Handle race condition where another concurrent worker created it
      counter = db.prepare(`
        SELECT * FROM organization_usage_counters
        WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
      `).get(organizationId, resourceKey, periodStart, periodEnd);
    }
  }

  return counter;
}

/**
 * Gets usage metrics for an organization and resource in a specific period.
 */
function getUsage(organizationId, resourceKey, periodStart, periodEnd) {
  const counter = db.prepare(`
    SELECT * FROM organization_usage_counters
    WHERE organization_id = ? AND resource_key = ? AND period_start = ? AND period_end = ?
  `).get(organizationId, resourceKey, periodStart, periodEnd);

  if (!counter) {
    return {
      used: 0,
      reserved: 0,
      total: 0,
      periodStart,
      periodEnd
    };
  }

  return {
    used: counter.used,
    reserved: counter.reserved,
    total: counter.used + counter.reserved,
    periodStart: counter.period_start,
    periodEnd: counter.period_end,
    updatedAt: counter.updated_at
  };
}

/**
 * Records an idempotent usage audit event.
 * If the idempotency key already exists, returns the existing record.
 */
function recordUsageEvent({
  organizationId,
  subscriptionId = null,
  resourceKey,
  eventType,
  quantity,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null,
  metadata = {}
}) {
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM organization_usage_events WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      return { event: existing, isDuplicate: true };
    }
  }

  const metaStr = JSON.stringify(metadata || {});
  const res = db.prepare(`
    INSERT INTO organization_usage_events (
      organization_id, subscription_id, resource_key, event_type, quantity,
      reference_type, reference_id, idempotency_key, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    organizationId,
    subscriptionId,
    resourceKey,
    eventType,
    quantity,
    referenceType,
    referenceId ? String(referenceId) : null,
    idempotencyKey,
    metaStr
  );

  const event = db.prepare('SELECT * FROM organization_usage_events WHERE id = ?').get(res.lastInsertRowid);
  return { event, isDuplicate: false };
}

/**
 * Retrieves recent usage events for an organization.
 */
function getUsageEvents(organizationId, { limit = 20, resourceKey = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const where = ['organization_id = ?'];
  const params = [organizationId];

  if (resourceKey) {
    where.push('resource_key = ?');
    params.push(resourceKey);
  }

  const rows = db.prepare(`
    SELECT * FROM organization_usage_events
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, safeLimit);

  return rows.map((r) => {
    let meta = {};
    try { meta = JSON.parse(r.metadata_json || '{}'); } catch {}
    return {
      id: r.id,
      resourceKey: r.resource_key,
      eventType: r.event_type,
      quantity: r.quantity,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      idempotencyKey: r.idempotency_key,
      metadata: meta,
      createdAt: r.created_at
    };
  });
}

module.exports = {
  getOrCreateCounter,
  getUsage,
  recordUsageEvent,
  getUsageEvents
};

