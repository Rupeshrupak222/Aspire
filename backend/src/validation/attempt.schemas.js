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

const codeExecutionSchema = z.object({
  questionId: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number)
  ], { required_error: 'questionId is required' }),
  language: z.string({ required_error: 'language is required' }).trim().min(1, 'language cannot be empty').max(50),
  sourceCode: z.string({ required_error: 'sourceCode is required' })
    .max(102400, 'Source code exceeds maximum permitted size (100KB)')
});

const codeSubmissionParamsSchema = z.object({
  token: z.string().trim().min(16, 'Token is too short').max(128, 'Token is too long'),
  submissionId: z.string().trim().min(5, 'submissionId is required').max(100)
});

module.exports = {
  attemptTokenParamSchema: tokenParamSchema,
  heartbeatSchema,
  submitSchema,
  codeExecutionSchema,
  codeSubmissionParamsSchema
};
