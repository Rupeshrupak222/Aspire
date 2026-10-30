// Validation schemas for proctoring events and risk analytics (Day 11)
const { z } = require('zod');

const VALID_EVENT_TYPES = [
  'TAB_SWITCH',
  'WINDOW_BLUR',
  'WINDOW_FOCUS',
  'FULLSCREEN_ENTER',
  'FULLSCREEN_EXIT',
  'COPY_ATTEMPT',
  'PASTE_ATTEMPT',
  'CUT_ATTEMPT',
  'CONTEXT_MENU_ATTEMPT',
  'DEVTOOLS_SHORTCUT_ATTEMPT',
  'NETWORK_OFFLINE',
  'NETWORK_ONLINE',
  'SUSPICIOUS_PATTERN'
];

const singleProctoringEventSchema = z.object({
  eventId: z.string({ required_error: 'eventId is required' })
    .trim()
    .min(8, 'eventId must be at least 8 characters')
    .max(128, 'eventId cannot exceed 128 characters'),
  eventType: z.enum(VALID_EVENT_TYPES, {
    required_error: 'eventType is required',
    invalid_type_error: 'Invalid proctoring eventType'
  }),
  timestamp: z.string().max(100).optional(),
  metadata: z.record(z.any()).optional()
}).passthrough().refine((data) => {
  // Reject attempt to forge risk scores or points from the client
  if (data.riskScore !== undefined || data.riskPoints !== undefined || data.riskLevel !== undefined) {
    return false;
  }
  return true;
}, {
  message: 'Client-supplied risk scores or points are forbidden; scoring is server-authoritative',
  path: ['riskScore']
});

const proctoringBatchSchema = z.object({
  events: z.array(singleProctoringEventSchema, {
    required_error: 'events array is required'
  })
    .min(1, 'events array must contain at least 1 event')
    .max(50, 'events array cannot exceed 50 events per batch')
});

const proctoringAttemptParamSchema = z.object({
  id: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number)
  ], { required_error: 'Attempt ID is required' })
});

module.exports = {
  VALID_EVENT_TYPES,
  singleProctoringEventSchema,
  proctoringBatchSchema,
  proctoringAttemptParamSchema
};
