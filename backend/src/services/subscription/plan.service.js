// ============================================================================
// ASPIRE DAY 21: SUBSCRIPTION PLAN SERVICE
// ============================================================================
// Centralized plan catalog, configuration, and feature/quota definitions.
// Supports STARTER, GROWTH, ENTERPRISE and custom platform plans.
// ============================================================================

const { db } = require('../../db');
const { NotFoundError, ConflictError, ValidationError } = require('../../errors/app-error');
const { recordAuditEvent } = require('../audit.service');

function deserializePlan(row) {
  if (!row) return null;
  let features = [];
  let quotas = {};
  try {
    features = JSON.parse(row.features_json || '[]');
  } catch {
    features = [];
  }
  try {
    quotas = JSON.parse(row.quotas_json || '{}');
  } catch {
    quotas = {};
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || '',
    features,
    quotas,
    softLimitPct: row.soft_limit_pct ?? 80,
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listPlans({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  const rows = db.prepare(`
    SELECT * FROM subscription_plans
    ${where}
    ORDER BY sort_order ASC, id ASC
  `).all();
  return rows.map(deserializePlan);
}

function getPlanById(id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(id);
  return deserializePlan(row);
}

function getPlanByCode(code) {
  if (!code) return null;
  const row = db.prepare('SELECT * FROM subscription_plans WHERE UPPER(code) = ?').get(String(code).toUpperCase().trim());
  return deserializePlan(row);
}

function createPlan(data, actorId = null) {
  const cleanCode = String(data.code).toUpperCase().trim();
  const existing = getPlanByCode(cleanCode);
  if (existing) {
    throw new ConflictError(`Subscription plan with code "${cleanCode}" already exists.`, 'PLAN_CODE_EXISTS');
  }

  const featuresJson = JSON.stringify(Array.isArray(data.features) ? data.features : []);
  const quotasJson = JSON.stringify(data.quotas && typeof data.quotas === 'object' ? data.quotas : {});
  const softLimit = typeof data.soft_limit_pct === 'number' ? data.soft_limit_pct : 80;
  const isActive = data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1;
  const sortOrder = typeof data.sort_order === 'number' ? data.sort_order : 0;

  const res = db.prepare(`
    INSERT INTO subscription_plans (code, name, description, features_json, quotas_json, soft_limit_pct, is_active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanCode,
    data.name.trim(),
    (data.description || '').trim(),
    featuresJson,
    quotasJson,
    softLimit,
    isActive,
    sortOrder
  );

  const newPlan = getPlanById(res.lastInsertRowid);

  recordAuditEvent({
    event: 'subscription_plan_created',
    userId: actorId,
    details: { planId: newPlan.id, code: newPlan.code, name: newPlan.name }
  });

  return newPlan;
}

function updatePlan(id, updates, actorId = null) {
  const plan = getPlanById(id);
  if (!plan) {
    throw new NotFoundError(`Subscription plan #${id} not found.`);
  }

  const fields = [];
  const params = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name.trim());
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    params.push(updates.description.trim());
  }
  if (updates.features !== undefined) {
    fields.push('features_json = ?');
    params.push(JSON.stringify(updates.features));
  }
  if (updates.quotas !== undefined) {
    fields.push('quotas_json = ?');
    params.push(JSON.stringify(updates.quotas));
  }
  if (updates.soft_limit_pct !== undefined) {
    fields.push('soft_limit_pct = ?');
    params.push(updates.soft_limit_pct);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    params.push(updates.is_active ? 1 : 0);
  }
  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?');
    params.push(updates.sort_order);
  }

  if (fields.length === 0) {
    return plan;
  }

  fields.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`
    UPDATE subscription_plans SET ${fields.join(', ')} WHERE id = ?
  `).run(...params);

  recordAuditEvent({
    event: 'subscription_plan_updated',
    userId: actorId,
    details: { planId: id, code: plan.code, updates }
  });

  return getPlanById(id);
}

module.exports = {
  listPlans,
  getPlanById,
  getPlanByCode,
  createPlan,
  updatePlan
};

