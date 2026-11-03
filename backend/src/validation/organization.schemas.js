// Zod validation schemas for Organization Management & Branding.
const { z } = require('zod');

// Validates 3-digit or 6-digit hex color format (e.g. #FFF, #0B1F3A)
const hexColorSchema = z.string().trim().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a valid hex color code (e.g. #0B1F3A)');

// Validates IANA timezone identifiers
const timezoneSchema = z.string().trim().refine((val) => {
  if (!val) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: val });
    return true;
  } catch (err) {
    return false;
  }
}, { message: 'Must be a valid IANA timezone identifier (e.g. Asia/Kolkata, Europe/London, America/New_York)' });

const certificateBrandingSchema = z.object({
  title: z.string().trim().max(100).optional(),
  certificate_title: z.string().trim().max(100).optional(),
  org_name: z.string().trim().max(100).optional(),
  certificate_organization_name: z.string().trim().max(100).optional(),
  certificate_logo_url: z.string().trim().max(500).optional(),
  logo_url: z.string().trim().max(500).optional(),
  certificate_signature_url: z.string().trim().max(500).optional(),
  signature_url: z.string().trim().max(500).optional(),
  signatory_name: z.string().trim().max(100).optional(),
  authorized_signatory_name: z.string().trim().max(100).optional(),
  signatory_title: z.string().trim().max(100).optional(),
  authorized_signatory_title: z.string().trim().max(100).optional(),
  footer_text: z.string().trim().max(255).optional()
}).transform((data) => {
  if (!data) return {};
  const title = data.title || data.certificate_title;
  const orgName = data.org_name || data.certificate_organization_name;
  const logoUrl = data.logo_url || data.certificate_logo_url;
  const sigUrl = data.signature_url || data.certificate_signature_url;
  const sigName = data.signatory_name || data.authorized_signatory_name;
  const sigTitle = data.signatory_title || data.authorized_signatory_title;

  return {
    ...data,
    title,
    certificate_title: title,
    org_name: orgName,
    certificate_organization_name: orgName,
    logo_url: logoUrl,
    certificate_logo_url: logoUrl,
    signature_url: sigUrl,
    certificate_signature_url: sigUrl,
    signatory_name: sigName,
    authorized_signatory_name: sigName,
    signatory_title: sigTitle,
    authorized_signatory_title: sigTitle,
    footer_text: data.footer_text
  };
}).optional();

const createOrganizationFullSchema = z.object({
  name: z.string().trim().min(1, 'Organization name is required').max(100),
  slug: z.string().trim().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase alphanumeric characters and hyphens').optional(),
  email: z.string().trim().email('Invalid official email format').max(255).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  website: z.string().trim().max(255).optional().nullable(),
  timezone: timezoneSchema.optional(),
  logo_url: z.string().trim().max(500).optional().nullable(),
  primary_color: hexColorSchema.optional(),
  secondary_color: hexColorSchema.optional(),
  accent_color: hexColorSchema.optional(),
  certificate_branding: certificateBrandingSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional()
});

const updateOrganizationAdminSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  slug: z.string().trim().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  email: z.string().trim().email('Invalid official email format').max(255).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  website: z.string().trim().max(255).optional().nullable(),
  timezone: timezoneSchema.optional(),
  logo_url: z.string().trim().max(500).optional().nullable(),
  primary_color: hexColorSchema.optional(),
  secondary_color: hexColorSchema.optional(),
  accent_color: hexColorSchema.optional(),
  certificate_branding: certificateBrandingSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional()
});

const updateOrganizationProfileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email('Invalid official email format').max(255).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  website: z.string().trim().max(255).optional().nullable(),
  timezone: timezoneSchema.optional(),
  logo_url: z.string().trim().max(500).optional().nullable(),
  primary_color: hexColorSchema.optional(),
  secondary_color: hexColorSchema.optional(),
  accent_color: hexColorSchema.optional(),
  certificate_branding: certificateBrandingSchema
});

const disableOrganizationSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required for audit tracking').max(255).optional()
});

const inviteAdminSchema = z.object({
  email: z.string().trim().email('Invalid invitee email format').max(255),
  role: z.enum(['ORG_ADMIN', 'EXAM_MANAGER', 'EVALUATOR', 'VIEWER']).default('ORG_ADMIN')
});

const acceptInvitationSchema = z.object({
  token: z.string().trim().min(16, 'Invalid invitation token'),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(128)
});

const queryOrganizationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  search: z.string().trim().optional(),
  status: z.enum(['ALL', 'ACTIVE', 'SUSPENDED', 'DISABLED']).default('ALL'),
  sort: z.enum(['id', 'name', 'created_at', 'status']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc')
});

module.exports = {
  hexColorSchema,
  timezoneSchema,
  certificateBrandingSchema,
  createOrganizationFullSchema,
  updateOrganizationAdminSchema,
  updateOrganizationProfileSchema,
  disableOrganizationSchema,
  inviteAdminSchema,
  acceptInvitationSchema,
  queryOrganizationsSchema
};
