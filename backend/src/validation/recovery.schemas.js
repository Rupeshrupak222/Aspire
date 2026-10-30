// Validation schemas for assessment session recovery and progress synchronization (Day 12)
const { z } = require('zod');

const CHANGE_TYPES = ['MCQ_ANSWER', 'CODE_DRAFT', 'NAVIGATION'];

const singleChangeSchema = z.object({
  changeId: z.string({ required_error: 'changeId is required' })
    .trim()
    .min(8, 'changeId must be at least 8 characters')
    .max(128, 'changeId cannot exceed 128 characters'),
  type: z.enum(CHANGE_TYPES, {
    required_error: 'type is required',
    invalid_type_error: 'Invalid change type'
  }),
  questionId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number)
  ]).optional().nullable(),
  answer: z.union([
    z.number().int(),
    z.string(),
    z.null()
  ]).optional(),
  code: z.string()
    .max(102400, 'Code draft exceeds maximum permitted size (100KB)')
    .optional(),
  language: z.string().trim().max(50).optional(),
  revision: z.number().int().min(1).optional().default(1),
  timestamp: z.string().max(100).optional()
}).passthrough().refine((data) => {
  // Reject attempt to forge server-authoritative fields from client
  if (
    data.remainingSeconds !== undefined ||
    data.score !== undefined ||
    data.marks !== undefined ||
    data.scholarship !== undefined ||
    data.serverRevision !== undefined
  ) {
    return false;
  }
  return true;
}, {
  message: 'Client-supplied assessment evaluation or timer fields are forbidden; server is authoritative',
  path: ['remainingSeconds']
});

const navigationSchema = z.object({
  questionId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number)
  ]).optional().nullable(),
  sectionId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number)
  ]).optional().nullable()
});

const progressSyncSchema = z.object({
  clientSessionId: z.string().trim().min(8).max(128).optional(),
  localRevision: z.number().int().min(0).optional().default(0),
  changes: z.array(singleChangeSchema)
    .max(50, 'Cannot exceed 50 changes per sync batch')
    .optional()
    .default([]),
  navigation: navigationSchema.optional()
}).passthrough().refine((data) => {
  if (
    data.remainingSeconds !== undefined ||
    data.score !== undefined ||
    data.marks !== undefined ||
    data.scholarship !== undefined ||
    data.serverRevision !== undefined
  ) {
    return false;
  }
  return true;
}, {
  message: 'Client-supplied assessment evaluation or timer fields are forbidden',
  path: ['remainingSeconds']
}).refine((data) => {
  const hasChanges = Array.isArray(data.changes) && data.changes.length > 0;
  const hasNav = data.navigation && (data.navigation.questionId !== undefined || data.navigation.sectionId !== undefined);
  return hasChanges || hasNav;
}, {
  message: 'Sync payload must include at least one change or navigation update',
  path: ['changes']
});

const extendedHeartbeatSchema = z.object({
  tabSwitches: z.union([
    z.number().int().min(0).max(100000),
    z.string().regex(/^\d+$/).transform(Number)
  ]).optional(),
  clientSessionId: z.string().trim().min(8).max(128).optional(),
  currentQuestionId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number)
  ]).optional()
}).passthrough().refine((data) => {
  if (
    data.remainingSeconds !== undefined ||
    data.score !== undefined ||
    data.marks !== undefined ||
    data.scholarship !== undefined ||
    data.serverRevision !== undefined
  ) {
    return false;
  }
  return true;
}, {
  message: 'Client-supplied assessment evaluation or timer fields are forbidden',
  path: ['remainingSeconds']
});

module.exports = {
  CHANGE_TYPES,
  singleChangeSchema,
  navigationSchema,
  progressSyncSchema,
  extendedHeartbeatSchema
};

