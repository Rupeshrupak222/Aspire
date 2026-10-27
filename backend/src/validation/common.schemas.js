// Common reusable Zod schemas and validation helpers.
const { z } = require('zod');

// Normalizes and validates Indian 10-digit mobile numbers
const phoneSchema = z.string()
  .trim()
  .refine((raw) => /^[+]?[\d\s-]{10,15}$/.test(raw), {
    message: 'A valid 10-digit mobile number is required'
  })
  .transform((raw) => {
    let d = String(raw).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d;
  })
  .refine((d) => /^[6-9]\d{9}$/.test(d), {
    message: 'A valid 10-digit mobile number is required'
  });

const tokenParamSchema = z.object({
  token: z.string().trim().min(16, 'Token is too short').max(128, 'Token is too long')
});

const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'ID must be an integer').transform((v) => parseInt(v, 10))
});

const paginationQuerySchema = z.object({
  limit: z.string().optional().transform((v) => (v ? Math.min(Math.max(1, parseInt(v, 10) || 500), 5000) : 500)),
  page: z.string().optional().transform((v) => (v ? Math.max(1, parseInt(v, 10) || 1) : 1))
});

module.exports = {
  phoneSchema,
  tokenParamSchema,
  idParamSchema,
  paginationQuerySchema
};
