// ============================================================================
// ASPIRE DAY 19: EXAM ANALYTICS VALIDATION SCHEMAS
// ============================================================================
const { z } = require('zod');

const examIdParamSchema = z.object({
  examId: z.coerce.number().int().positive({ message: 'examId must be a positive integer' })
});

const questionAnalyticsParamSchema = z.object({
  examId: z.coerce.number().int().positive({ message: 'examId must be a positive integer' }),
  questionId: z.coerce.number().int().positive({ message: 'questionId must be a positive integer' })
});

const examAnalyticsFilterSchema = z.object({
  period: z.enum(['today', '7d', '30d', '90d', 'all', 'custom']).default('all'),
  start_date: z.string().datetime().optional().nullable(),
  end_date: z.string().datetime().optional().nullable()
});

const examCandidatesFilterSchema = examAnalyticsFilterSchema.extend({
  status: z.enum(['all', 'started', 'submitted', 'abandoned', 'passed', 'failed', 'in_progress']).default('all'),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum([
    'score_desc',
    'score_asc',
    'name_asc',
    'name_desc',
    'submitted_desc',
    'submitted_asc',
    'started_desc'
  ]).default('score_desc')
});

const examQuestionsFilterSchema = z.object({
  type: z.enum(['all', 'mcq', 'code']).default('all'),
  difficulty: z.enum(['all', 'VERY_EASY', 'EASY', 'MODERATE', 'DIFFICULT', 'VERY_DIFFICULT']).default('all'),
  category: z.string().trim().max(100).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum([
    'order_asc',
    'accuracy_asc',
    'accuracy_desc',
    'discrimination_desc',
    'discrimination_asc',
    'marks_desc'
  ]).default('order_asc')
});

module.exports = {
  examIdParamSchema,
  questionAnalyticsParamSchema,
  examAnalyticsFilterSchema,
  examCandidatesFilterSchema,
  examQuestionsFilterSchema
};

