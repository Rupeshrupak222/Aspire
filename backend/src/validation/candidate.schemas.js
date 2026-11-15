// ============================================================================
// ASPIRE DAY 25: CANDIDATE & PUBLIC EXAM VALIDATION SCHEMAS
// ============================================================================

const { z } = require('zod');

// 10-digit Indian standard mobile number validation
const phoneRegex = /^[6-9]\d{9}$/;

const candidateRegisterSchema = z.object({
  name: z.string().trim().min(2, 'Full name must be at least 2 characters').max(100, 'Full name cannot exceed 100 characters'),
  phone: z.string().trim().regex(/^\d{10}$/, 'A valid 10-digit mobile number is required'),
  email: z.string().trim().email('A valid email address is required').max(150, 'Email cannot exceed 150 characters').optional().nullable(),
  college: z.string().trim().max(150, 'College name cannot exceed 150 characters').optional().nullable(),
  city: z.string().trim().max(100, 'City cannot exceed 100 characters').optional().nullable(),
  degree: z.string().trim().max(100, 'Degree or course cannot exceed 100 characters').optional().nullable(),
  grad_year: z.union([z.string(), z.number()]).optional().nullable(),
  graduation_year: z.union([z.string(), z.number()]).optional().nullable(),
  track: z.string().trim().max(100).optional().nullable(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128).optional().nullable(),
  campaign_code: z.string().trim().max(50).optional().nullable(),
  exam_code: z.string().trim().max(50).optional().nullable(),
  exam_id: z.union([z.string(), z.number()]).optional().nullable(),
  invitation_token: z.string().trim().optional().nullable(),
  // Campaign attribution fields
  utm_source: z.string().trim().max(100).optional().nullable(),
  utm_medium: z.string().trim().max(100).optional().nullable(),
  utm_campaign: z.string().trim().max(100).optional().nullable(),
  utm_term: z.string().trim().max(100).optional().nullable(),
  utm_content: z.string().trim().max(100).optional().nullable(),
  referral_code: z.string().trim().max(50).optional().nullable(),
  landing_source: z.string().trim().max(100).optional().nullable()
});

const sendOtpSchema = z.object({
  phone: z.string().trim().regex(/^\d{10}$/, 'A valid 10-digit mobile number is required')
});

const verifyOtpSchema = z.object({
  phone: z.string().trim().regex(/^\d{10}$/, 'A valid 10-digit mobile number is required'),
  otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be a 6-digit numeric code')
});

const sendEmailVerificationSchema = z.object({
  email: z.string().trim().email('A valid email address is required')
});

const verifyEmailSchema = z.object({
  token: z.string().trim().min(32, 'Invalid verification token').max(128, 'Invalid verification token')
});

const collegeSearchQuerySchema = z.object({
  q: z.string().trim().optional().default(''),
  limit: z.coerce.number().min(1).max(50).optional().default(10)
});

const campaignAttributionSchema = z.object({
  student_id: z.number().int().positive().optional().nullable(),
  utm_source: z.string().trim().max(100).optional().nullable(),
  utm_medium: z.string().trim().max(100).optional().nullable(),
  utm_campaign: z.string().trim().max(100).optional().nullable(),
  utm_term: z.string().trim().max(100).optional().nullable(),
  utm_content: z.string().trim().max(100).optional().nullable(),
  referral_code: z.string().trim().max(50).optional().nullable(),
  landing_source: z.string().trim().max(100).optional().nullable()
});

module.exports = {
  candidateRegisterSchema,
  sendOtpSchema,
  verifyOtpSchema,
  sendEmailVerificationSchema,
  verifyEmailSchema,
  collegeSearchQuerySchema,
  campaignAttributionSchema
};

