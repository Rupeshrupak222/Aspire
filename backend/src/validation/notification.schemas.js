// ============================================================================
// ASPIRE DAY 23: NOTIFICATION & EMAIL VALIDATION SCHEMAS
// ============================================================================

const { z } = require('zod');

const NOTIFICATION_EVENT_TYPES = [
  'REGISTRATION_CONFIRMED',
  'EXAM_INVITATION',
  'EXAM_REMINDER',
  'EXAM_COMPLETED',
  'RESULT_AVAILABLE',
  'CERTIFICATE_AVAILABLE'
];

const DELIVERY_STATUSES = [
  'PENDING',
  'QUEUED',
  'PROCESSING',
  'SENT',
  'DELIVERED',
  'BOUNCED',
  'COMPLAINED',
  'FAILED',
  'CANCELLED'
];

const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  event_type: z.enum(NOTIFICATION_EVENT_TYPES).optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  search: z.string().trim().optional(),
  start_date: z.string().trim().optional(),
  end_date: z.string().trim().optional()
});

const updatePreferencesSchema = z.object({
  email_enabled: z.boolean().optional(),
  registration_updates: z.boolean().optional(),
  exam_invitations: z.boolean().optional(),
  exam_reminders: z.boolean().optional(),
  result_updates: z.boolean().optional(),
  certificate_updates: z.boolean().optional()
});

const inviteCandidatesSchema = z.object({
  examId: z.coerce.number().int().positive(),
  candidates: z.array(
    z.object({
      email: z.string().email().trim(),
      name: z.string().trim().min(1).max(100).optional(),
      studentId: z.coerce.number().int().positive().optional()
    })
  ).min(1).max(500),
  scheduledReminderHours: z.array(z.number().int().positive()).optional()
});

const deliveryIdParamSchema = z.object({
  id: z.string().trim().min(1)
});

module.exports = {
  NOTIFICATION_EVENT_TYPES,
  DELIVERY_STATUSES,
  listNotificationsQuerySchema,
  updatePreferencesSchema,
  inviteCandidatesSchema,
  deliveryIdParamSchema
};

