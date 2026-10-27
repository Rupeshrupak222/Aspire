// Validation schemas for attempt heartbeat and submission.
const { z } = require('zod');
const { tokenParamSchema } = require('./common.schemas');

const heartbeatSchema = z.object({
  tabSwitches: z.number().int().min(0).max(100000).optional().or(z.string().regex(/^\d+$/).transform(Number))
});

const submitSchema = z.object({
  answers: z.record(z.union([z.number(), z.string(), z.null()])).optional().default({}),
  codeAnswers: z.record(
    z.string().max(65536, 'Code submission exceeds maximum permitted size (64KB)')
  ).optional().default({}),
  tabSwitches: z.number().int().min(0).max(100000).optional().default(0)
});

module.exports = {
  attemptTokenParamSchema: tokenParamSchema,
  heartbeatSchema,
  submitSchema
};
