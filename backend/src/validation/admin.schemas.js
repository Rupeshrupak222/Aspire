// Validation schemas for administrative operations.
const { z } = require('zod');

const VALID_CATEGORIES = ['aptitude', 'technical', 'coding'];
const VALID_TYPES = ['mcq', 'code'];

const createQuestionSchema = z.object({
  type: z.enum(['mcq', 'code'], { errorMap: () => ({ message: 'type must be mcq or code' }) }),
  category: z.enum(['aptitude', 'technical', 'coding'], {
    errorMap: () => ({ message: 'category must be one of: aptitude, technical, coding' })
  }),
  title: z.string().trim().max(200).optional(),
  question_text: z.string({ required_error: 'question_text is required' })
    .trim()
    .min(1, 'question_text is required')
    .max(10000, 'question_text is too long'),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional().default('MEDIUM'),
  topic: z.string().trim().max(100).optional().nullable(),
  skill: z.string().trim().max(100).optional().nullable(),
  time_estimate: z.number().int().positive().optional().default(120),
  tags: z.union([z.array(z.string()), z.string()]).optional().default([]),
  language: z.string().trim().max(50).optional().nullable(),
  status: z.enum(['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED']).optional().default('PUBLISHED'),
  options: z.array(z.string()).min(2, 'mcq options must be an array of 2-6 strings').max(6, 'mcq options must be an array of 2-6 strings').optional(),
  correct_index: z.number().int().min(0).optional(),
  code_starter: z.string().max(10000).optional().nullable(),
  language_id: z.number().int().positive().optional().default(71),
  test_cases: z.array(
    z.object({
      input: z.string({ required_error: 'each test case must be {input: string, expected: string}' }),
      expected: z.string({ required_error: 'each test case must be {input: string, expected: string}' })
    })
  ).min(1, 'code questions need at least one test case {input, expected}').optional(),
  marks: z.number().positive('marks must be a positive number').optional().default(1),
  is_sample: z.union([z.boolean(), z.number()]).optional().default(0),
  organization_id: z.number().int().positive().optional().nullable()
}).superRefine((val, ctx) => {
  // Category <-> Type strict coupling
  if (val.category === 'coding' && val.type !== 'code') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'coding-category questions must be type "code"', path: ['category'] });
  }
  if (val.category !== 'coding' && val.type !== 'mcq') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${val.category}-category questions must be type "mcq"`, path: ['category'] });
  }

  // MCQ validations: strictly enforce when PUBLISHED or unspecified
  if (val.type === 'mcq') {
    if (val.status === 'PUBLISHED' || val.status === 'REVIEW') {
      if (!Array.isArray(val.options) || val.options.length < 2 || val.options.length > 6) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mcq options must be an array of 2-6 strings', path: ['options'] });
      }
      if (val.correct_index === undefined || val.correct_index === null || val.correct_index < 0 || (val.options && val.correct_index >= val.options.length)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'correct_index must be a valid option index', path: ['correct_index'] });
      }
    }
  }

  // Code validations: strictly enforce when PUBLISHED or unspecified
  if (val.type === 'code') {
    if (val.status === 'PUBLISHED' || val.status === 'REVIEW') {
      if (!Array.isArray(val.test_cases) || val.test_cases.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'code questions need at least one test case {input, expected}', path: ['test_cases'] });
      }
    }
  }
});

const updateQuestionSchema = z.object({
  type: z.enum(['mcq', 'code']).optional(),
  category: z.enum(['aptitude', 'technical', 'coding']).optional(),
  title: z.string().trim().max(200).optional(),
  question_text: z.string().trim().min(1).max(10000).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  topic: z.string().trim().max(100).optional().nullable(),
  skill: z.string().trim().max(100).optional().nullable(),
  time_estimate: z.number().int().positive().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  language: z.string().trim().max(50).optional().nullable(),
  status: z.enum(['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED']).optional(),
  options: z.array(z.string()).min(2).max(6).optional(),
  correct_index: z.number().int().min(0).optional(),
  code_starter: z.string().max(10000).optional().nullable(),
  language_id: z.number().int().positive().optional(),
  test_cases: z.array(
    z.object({ input: z.string(), expected: z.string() })
  ).min(1).optional(),
  marks: z.number().positive().optional(),
  is_sample: z.union([z.boolean(), z.number()]).optional()
});

const listQuestionsQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional(),
  search: z.string().trim().max(200).optional(),
  status: z.string().optional(),
  difficulty: z.string().optional(),
  topic: z.string().trim().max(100).optional(),
  skill: z.string().trim().max(100).optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  organization_id: z.string().regex(/^\d+$/).transform(Number).optional(),
  sort: z.enum(['id', 'title', 'created_at', 'updated_at', 'difficulty', 'marks', 'status']).optional().default('id'),
  order: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional().default('asc'),
  paginate: z.string().optional()
});

const checkDuplicatesSchema = z.object({
  question_text: z.string({ required_error: 'question_text is required' }).trim().min(1).max(10000),
  type: z.enum(['mcq', 'code']).optional(),
  exclude_id: z.number().int().positive().optional()
});

const updateStatusSchema = z.object({
  status: z.enum(['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'], {
    errorMap: () => ({ message: 'status must be DRAFT, REVIEW, PUBLISHED, or ARCHIVED' })
  })
});

const CONFIG_KEYS = [
  'test_title', 'duration_minutes', 'quota_aptitude', 'quota_technical',
  'quota_coding', 'shuffle_questions', 'shuffle_options', 'scholarship_slabs',
  'brand_name', 'accent_color'
];

const updateConfigSchema = z.record(z.any()).superRefine((val, ctx) => {
  for (const [k, v] of Object.entries(val)) {
    if (!CONFIG_KEYS.includes(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown config key: ${k}`, path: [k] });
      continue;
    }
    if (k === 'scholarship_slabs') {
      try {
        const arr = typeof v === 'string' ? JSON.parse(v) : v;
        if (!Array.isArray(arr) || !arr.every((s) => typeof s.min === 'number' && typeof s.scholarship === 'number')) {
          throw new Error();
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scholarship_slabs must be a JSON array of {min, scholarship}', path: [k] });
      }
    }
  }
});

const resultsQuerySchema = z.object({
  college: z.string().optional(),
  track: z.string().optional(),
  min_percentage: z.string().regex(/^\d+(\.\d+)?$/).optional().or(z.number().optional()),
  limit: z.string().optional().or(z.number().optional())
});

const collegeReportQuerySchema = z.object({
  college: z.string({ required_error: 'college query param is required' })
    .trim()
    .min(1, 'college query param is required')
    .max(150, 'college query param is too long')
});

module.exports = {
  createQuestionSchema,
  updateQuestionSchema,
  listQuestionsQuerySchema,
  checkDuplicatesSchema,
  updateStatusSchema,
  updateConfigSchema,
  resultsQuerySchema,
  collegeReportQuerySchema
};
