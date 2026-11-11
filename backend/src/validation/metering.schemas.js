// ============================================================================
// ASPIRE DAY 22: USAGE METERING & RECONCILIATION VALIDATION SCHEMAS
// ============================================================================

const { z } = require('zod');

const METERED_RESOURCES = [
  'candidates',
  'attempts',
  'exams_created',
  'exams_published',
  'questions',
  'certificates',
  'code_executions',
  'storage_bytes',
  'storage_objects'
];

const EVENT_TYPES = [
  'CONSUMED',
  'RESERVED',
  'RELEASED',
  'ADJUSTED',
  'REVERSED',
  'INCREMENT',
  'DECREMENT',
  'SNAPSHOT'
];

const usageTrendsQuerySchema = z.object({
  organization_id: z.coerce.number().int().positive().optional(),
  resource_key: z.string().trim().optional(),
  start_date: z.string().trim().optional(),
  end_date: z.string().trim().optional(),
  interval: z.enum(['daily', 'monthly', 'day', 'month']).optional().default('daily')
}).refine((data) => {
  if (data.start_date && data.end_date) {
    return new Date(data.start_date) <= new Date(data.end_date);
  }
  return true;
}, {
  message: 'start_date must be before or equal to end_date',
  path: ['start_date']
});

const usageHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  resource_key: z.string().trim().optional(),
  start_date: z.string().trim().optional(),
  end_date: z.string().trim().optional()
});

const reconcileRequestSchema = z.object({
  organization_id: z.coerce.number().int().positive().optional().nullable(),
  mode: z.enum(['DRY_RUN', 'APPLY_CORRECTIONS']).optional().default('DRY_RUN')
});

const manualRecordEventSchema = z.object({
  resource_key: z.string().trim().min(1),
  event_type: z.enum(EVENT_TYPES).default('INCREMENT'),
  quantity: z.coerce.number().int().default(1),
  reference_type: z.string().trim().optional().nullable(),
  reference_id: z.string().trim().optional().nullable(),
  idempotency_key: z.string().trim().optional().nullable(),
  metadata: z.record(z.any()).optional().default({})
});

module.exports = {
  METERED_RESOURCES,
  EVENT_TYPES,
  usageTrendsQuerySchema,
  usageHistoryQuerySchema,
  reconcileRequestSchema,
  manualRecordEventSchema
};

