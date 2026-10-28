// Validation schemas for Exam Builder 2.0.
const { z } = require('zod');

const EXAM_STATUSES = ['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'];
const SELECTION_MODES = ['MANUAL', 'POOL_RANDOM', 'RULE_BASED'];
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];
const QUESTION_TYPES = ['MCQ', 'CODING'];

const createExamSchema = z.object({
  name: z.string({ required_error: 'Exam name is required' })
    .trim()
    .min(3, 'Exam name must be at least 3 characters')
    .max(150, 'Exam name cannot exceed 150 characters'),
  code: z.string({ required_error: 'Exam code is required' })
    .trim()
    .min(3, 'Exam code must be at least 3 characters')
    .max(50, 'Exam code cannot exceed 50 characters')
    .regex(/^[A-Z0-9_-]+$/i, 'Exam code must contain only letters, numbers, underscores, and dashes')
    .transform(c => c.toUpperCase()),
  description: z.string().trim().max(1000).optional().nullable(),
  duration_minutes: z.coerce.number().int().min(1, 'Duration must be at least 1 minute').max(1440, 'Duration cannot exceed 24 hours').default(90),
  passing_score: z.coerce.number().min(0, 'Passing score must be at least 0').max(1000, 'Passing score cannot exceed 1000').default(40),
  max_attempts: z.coerce.number().int().min(1, 'Max attempts must be at least 1').max(10, 'Max attempts cannot exceed 10').default(1),
  shuffle_questions: z.coerce.boolean().default(true).transform(v => v ? 1 : 0),
  shuffle_options: z.coerce.boolean().default(true).transform(v => v ? 1 : 0),
  organization_id: z.coerce.number().int().positive().optional().nullable()
});

const updateExamSchema = z.object({
  name: z.string().trim().min(3).max(150).optional(),
  code: z.string().trim().min(3).max(50).regex(/^[A-Z0-9_-]+$/i).transform(c => c.toUpperCase()).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  duration_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  passing_score: z.coerce.number().min(0).max(1000).optional(),
  max_attempts: z.coerce.number().int().min(1).max(10).optional(),
  shuffle_questions: z.coerce.boolean().optional().transform(v => v !== undefined ? (v ? 1 : 0) : undefined),
  shuffle_options: z.coerce.boolean().optional().transform(v => v !== undefined ? (v ? 1 : 0) : undefined),
  expected_version: z.coerce.number().int().min(1).optional() // For optimistic concurrency check
});

const createSectionSchema = z.object({
  name: z.string({ required_error: 'Section name is required' })
    .trim()
    .min(2, 'Section name must be at least 2 characters')
    .max(100, 'Section name cannot exceed 100 characters'),
  description: z.string().trim().max(500).optional().nullable(),
  display_order: z.coerce.number().int().min(0).optional(),
  question_selection_mode: z.enum(SELECTION_MODES).default('RULE_BASED'),
  total_questions: z.coerce.number().int().min(0).default(0),
  total_marks: z.coerce.number().min(0).default(0)
});

const updateSectionSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  display_order: z.coerce.number().int().min(0).optional(),
  question_selection_mode: z.enum(SELECTION_MODES).optional(),
  total_questions: z.coerce.number().int().min(0).optional(),
  total_marks: z.coerce.number().min(0).optional()
});

const reorderSectionsSchema = z.object({
  sectionIds: z.array(z.coerce.number().int().positive())
    .min(1, 'At least one section ID must be provided')
});

const addSectionQuestionSchema = z.object({
  question_id: z.coerce.number().int().positive({ message: 'Valid question ID is required' }),
  display_order: z.coerce.number().int().min(0).optional()
});

const addSectionRuleSchema = z.object({
  topic: z.string().trim().max(100).optional().nullable(),
  skill: z.string().trim().max(100).optional().nullable(),
  difficulty: z.enum(DIFFICULTIES).optional().nullable(),
  type: z.enum(QUESTION_TYPES).optional().nullable(),
  category: z.string().trim().max(50).optional().nullable(),
  count: z.coerce.number().int().min(1, 'Count must be at least 1').default(1),
  marks_per_question: z.coerce.number().min(0.5, 'Marks per question must be at least 0.5').optional().nullable()
});

const scholarshipSlabSchema = z.object({
  min_score_pct: z.coerce.number().min(0).max(100),
  max_score_pct: z.coerce.number().min(0).max(100),
  discount_pct: z.coerce.number().min(0).max(100),
  tier_name: z.string().trim().max(100).optional().nullable()
}).refine(data => data.min_score_pct <= data.max_score_pct, {
  message: 'Minimum score percentage cannot be greater than maximum score percentage',
  path: ['min_score_pct']
});

const setScholarshipSlabsSchema = z.object({
  slabs: z.array(scholarshipSlabSchema).min(1, 'At least one scholarship slab is required')
});

const listExamsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  status: z.enum(EXAM_STATUSES).optional(),
  organization_id: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['created_at', 'updated_at', 'name', 'code', 'status', 'duration_minutes', 'total_marks']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc', 'ASC', 'DESC']).default('desc').transform(v => v.toUpperCase())
});

module.exports = {
  EXAM_STATUSES,
  SELECTION_MODES,
  createExamSchema,
  updateExamSchema,
  createSectionSchema,
  updateSectionSchema,
  reorderSectionsSchema,
  addSectionQuestionSchema,
  addSectionRuleSchema,
  setScholarshipSlabsSchema,
  listExamsQuerySchema
};
