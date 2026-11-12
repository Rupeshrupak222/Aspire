// ============================================================================
// ASPIRE DAY 24: CERTIFICATE VALIDATION SCHEMAS (ZOD)
// ============================================================================

const { z } = require('zod');

const certificateParamSchema = z.object({
  certificateId: z.string().trim().min(4, 'Invalid certificate identifier').max(64, 'Invalid certificate identifier')
});

const verifyCertificateParamSchema = z.object({
  certificateId: z.string().trim().min(4, 'Invalid certificate identifier').max(64, 'Invalid certificate identifier')
});

const revokeCertificateSchema = z.object({
  reason: z.string().trim().min(3, 'A valid revocation reason must be at least 3 characters').max(500, 'Revocation reason must not exceed 500 characters')
});

const reissueCertificateSchema = z.object({
  reason: z.string().trim().min(3, 'A valid reissuance reason must be at least 3 characters').max(500),
  studentName: z.string().trim().min(1).max(150).optional(),
  examTitle: z.string().trim().min(1).max(200).optional(),
  score: z.number().min(0).max(1000).optional(),
  totalMarks: z.number().min(1).max(1000).optional(),
  percentage: z.number().min(0).max(100).optional(),
  scholarshipPct: z.number().min(0).max(100).optional()
});

const listCertificatesQuerySchema = z.object({
  examId: z.preprocess((val) => (val !== undefined && val !== '' ? Number(val) : undefined), z.number().positive().optional()),
  studentId: z.preprocess((val) => (val !== undefined && val !== '' ? Number(val) : undefined), z.number().positive().optional()),
  status: z.enum(['ALL', 'VALID', 'REVOKED', 'EXPIRED']).optional().default('ALL'),
  search: z.string().trim().max(100).optional(),
  page: z.preprocess((val) => (val !== undefined && val !== '' ? parseInt(val, 10) : 1), z.number().int().min(1).default(1)),
  limit: z.preprocess((val) => (val !== undefined && val !== '' ? parseInt(val, 10) : 20), z.number().int().min(1).max(100).default(20))
});

module.exports = {
  certificateParamSchema,
  verifyCertificateParamSchema,
  revokeCertificateSchema,
  reissueCertificateSchema,
  listCertificatesQuerySchema
};
