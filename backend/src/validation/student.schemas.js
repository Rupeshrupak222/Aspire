// Validation schema for candidate registration.
const { z } = require('zod');
const { phoneSchema } = require('./common.schemas');

const registerSchema = z.object({
  name: z.string({ required_error: 'Name is required' })
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name must be 120 characters or fewer'),
  phone: phoneSchema,
  email: z.string().trim().email('Invalid email address').max(150).optional().or(z.literal('')).transform(v => v || null),
  college: z.string().trim().max(150, 'College name too long').optional().or(z.literal('')).transform(v => v || null),
  city: z.string().trim().max(100, 'City name too long').optional().or(z.literal('')).transform(v => v || null),
  grad_year: z.string().trim().max(20).optional().or(z.literal('')).transform(v => v || null),
  track: z.string().trim().max(60).optional().or(z.literal('')).transform(v => v || null),
  campaign_code: z.string().trim().max(60).optional().or(z.literal('')).transform(v => v || null)
}).passthrough(); // Allow passthrough to avoid dropping any client metadata

module.exports = {
  registerSchema
};
