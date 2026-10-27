// Zod validation schemas for Authentication & Identity.
const { z } = require('zod');

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address format').max(255),
  password: z.string().min(1, 'Password is required').max(128)
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required').max(128).optional(),
  new_password: z.string().min(8, 'New password must be at least 8 characters long').max(128)
});

const createUserSchema = z.object({
  email: z.string().trim().email('Invalid email address format').max(255),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128),
  name: z.string().trim().min(1, 'Name is required').max(100),
  role: z.enum(['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER', 'EVALUATOR', 'VIEWER']),
  organization_id: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional()
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(100).optional(),
  role: z.enum(['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER', 'EVALUATOR', 'VIEWER']).optional(),
  organization_id: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional()
});

const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, 'Organization name is required').max(100),
  slug: z.string().trim().min(1, 'Slug is required').max(50).regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase alphanumeric characters and hyphens').optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional()
});

const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1, 'Organization name is required').max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional()
});

module.exports = {
  loginSchema,
  changePasswordSchema,
  createUserSchema,
  updateUserSchema,
  createOrganizationSchema,
  updateOrganizationSchema
};
