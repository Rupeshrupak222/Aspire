// ============================================================================
// ASPIRE DAY 21: SUBSCRIPTION & USAGE VALIDATION SCHEMAS
// ============================================================================

const { z } = require('zod');

const PLAN_CODES = ['STARTER', 'GROWTH', 'ENTERPRISE'];
const SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];
const STANDARD_RESOURCES = ['exams_monthly', 'candidates'];
const STANDARD_FEATURES = [
  'BASIC_ANALYTICS',
  'ADVANCED_ANALYTICS',
  'STANDARD_ASSESSMENT',
  'CERTIFICATES',
  'PROCTORING',
  'CUSTOM_BRANDING',
  'PRIORITY_SUPPORT',
  'DEDICATED_INFRASTRUCTURE',
  'CUSTOM_INTEGRATIONS'
];

// Helper for quota values (positive integer or null for unlimited)
const quotaValueSchema = z.union([
  z.number().int().min(0),
  z.null()
]);

const createPlanSchema = z.object({
  code: z.string().trim().min(2).max(50).toUpperCase(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional().default(''),
  features: z.array(z.string().trim()).default([]),
  quotas: z.record(z.string(), quotaValueSchema).default({}),
  soft_limit_pct: z.coerce.number().int().min(10).max(100).default(80),
  is_active: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional().default(true),
  sort_order: z.coerce.number().int().default(0)
});

const updatePlanSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  features: z.array(z.string().trim()).optional(),
  quotas: z.record(z.string(), quotaValueSchema).optional(),
  soft_limit_pct: z.coerce.number().int().min(10).max(100).optional(),
  is_active: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  sort_order: z.coerce.number().int().optional()
});

const assignSubscriptionSchema = z.object({
  plan_id: z.coerce.number().int().positive().optional(),
  plan_code: z.string().trim().toUpperCase().optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional().default('ACTIVE'),
  starts_at: z.string().optional().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid starts_at date' }),
  current_period_start: z.string().optional().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid current_period_start date' }),
  current_period_end: z.string().optional().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid current_period_end date' }),
  trial_ends_at: z.string().optional().nullable().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid trial_ends_at date' }),
  grace_period_ends_at: z.string().optional().nullable().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid grace_period_ends_at date' }),
  override_quotas: z.record(z.string(), quotaValueSchema).optional().nullable(),
  override_features: z.array(z.string().trim()).optional().nullable(),
  notes: z.string().trim().max(500).optional().default('')
}).refine((data) => data.plan_id || data.plan_code, {
  message: 'Either plan_id or plan_code must be provided'
});

const updateSubscriptionSchema = z.object({
  plan_id: z.coerce.number().int().positive().optional(),
  plan_code: z.string().trim().toUpperCase().optional(),
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  current_period_start: z.string().optional().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid current_period_start date' }),
  current_period_end: z.string().optional().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid current_period_end date' }),
  trial_ends_at: z.string().optional().nullable().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid trial_ends_at date' }),
  grace_period_ends_at: z.string().optional().nullable().refine((val) => !val || !isNaN(Date.parse(val)), { message: 'Invalid grace_period_ends_at date' }),
  override_quotas: z.record(z.string(), quotaValueSchema).optional().nullable(),
  override_features: z.array(z.string().trim()).optional().nullable(),
  notes: z.string().trim().max(500).optional()
});

const adjustUsageSchema = z.object({
  resource_key: z.string().trim().min(1).max(50),
  quantity: z.coerce.number().int(),
  reason: z.string().trim().min(3).max(255)
});

const planParamSchema = z.object({
  planId: z.coerce.number().int().positive()
});

const organizationParamSchema = z.object({
  organizationId: z.coerce.number().int().positive()
});

module.exports = {
  PLAN_CODES,
  SUBSCRIPTION_STATUSES,
  STANDARD_RESOURCES,
  STANDARD_FEATURES,
  createPlanSchema,
  updatePlanSchema,
  assignSubscriptionSchema,
  updateSubscriptionSchema,
  adjustUsageSchema,
  planParamSchema,
  organizationParamSchema
};

