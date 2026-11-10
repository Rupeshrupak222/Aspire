// ============================================================================
// ASPIRE DAY 20: REPORTING SYSTEM VALIDATION SCHEMAS
// ============================================================================
// Zod schemas for report type parameters, preview filters, and export queries.
// Validates tenant boundaries, date ranges, numeric bounds, and sanitizes input.
// ============================================================================

const { z } = require('zod');

const REPORT_TYPES = ['candidates', 'exams', 'colleges', 'scholarships', 'questions', 'proctoring'];
const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'];
const RISK_LEVELS = ['NORMAL', 'WARNING', 'SUSPICIOUS', 'HIGH_RISK'];

// Param schema for report type routes: /api/organization/reports/:reportType
const reportTypeParamSchema = z.object({
  reportType: z.enum(REPORT_TYPES, {
    errorMap: () => ({
      message: `Invalid report type. Supported types: ${REPORT_TYPES.join(', ')}`
    })
  })
});

// Common date-range and pagination filter schema shape
const baseReportFilterObject = z.object({
  // Date filtering
  period: z.enum(['today', '7d', '30d', '90d', 'all', 'custom']).optional().default('all'),
  start_date: z.string().optional().refine((val) => {
    if (!val) return true;
    return !isNaN(Date.parse(val));
  }, { message: 'start_date must be a valid ISO date string' }),
  end_date: z.string().optional().refine((val) => {
    if (!val) return true;
    return !isNaN(Date.parse(val));
  }, { message: 'end_date must be a valid ISO date string' }),

  // Entity filters
  exam_id: z.coerce.number().int().positive().optional(),
  college: z.string().trim().max(150).optional(),
  branch: z.string().trim().max(100).optional(),
  grad_year: z.string().trim().max(10).optional(),

  // Academic & Score filters
  min_score: z.coerce.number().min(0).max(100).optional(),
  max_score: z.coerce.number().min(0).max(100).optional(),
  scholarship_pct: z.coerce.number().int().min(0).max(100).optional(),
  status: z.string().trim().max(50).optional(),

  // Question psychometrics filters
  category: z.string().trim().max(100).optional(),
  question_type: z.enum(['mcq', 'code', 'all']).optional(),
  difficulty: z.enum(['EASY', 'MODERATE', 'DIFFICULT', 'VERY_DIFFICULT', 'ALL']).optional(),

  // Proctoring filters
  risk_level: z.enum(RISK_LEVELS).optional(),

  // Search & text query
  search: z.string().trim().max(100).optional(),

  // Super Admin scope switch
  organization_id: z.coerce.number().int().positive().optional(),

  // Pagination & Sorting for Preview
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort_by: z.string().trim().max(50).optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc').optional()
});

function applyFilterRefinements(schema) {
  return schema.refine((data) => {
    if (data.start_date && data.end_date) {
      const start = new Date(data.start_date).getTime();
      const end = new Date(data.end_date).getTime();
      return start <= end;
    }
    return true;
  }, {
    message: 'start_date cannot be after end_date',
    path: ['start_date']
  }).refine((data) => {
    if (data.min_score !== undefined && data.max_score !== undefined) {
      return data.min_score <= data.max_score;
    }
    return true;
  }, {
    message: 'min_score cannot exceed max_score',
    path: ['min_score']
  });
}

const reportFilterSchema = applyFilterRefinements(baseReportFilterObject);

// Export query schema (extends baseReportFilterObject with format & higher limit)
const reportExportSchema = applyFilterRefinements(baseReportFilterObject.extend({
  format: z.enum(EXPORT_FORMATS, {
    errorMap: () => ({
      message: `Invalid export format. Supported formats: ${EXPORT_FORMATS.join(', ')}`
    })
  }),
  limit: z.coerce.number().int().min(1).max(10000).default(10000)
}));

module.exports = {
  REPORT_TYPES,
  EXPORT_FORMATS,
  RISK_LEVELS,
  reportTypeParamSchema,
  reportFilterSchema,
  reportExportSchema
};
