// Validation schemas for SaaS Analytics Dashboard query parameters.
const { z } = require('zod');

const isoDateString = z.string().trim().refine((val) => {
  const d = new Date(val);
  return !isNaN(d.getTime());
}, { message: 'Must be a valid ISO-8601 date string' });

const dashboardFilterSchema = z.object({
  period: z.enum(['today', '7d', '30d', '90d', 'custom']).default('30d'),
  start_date: isoDateString.optional(),
  end_date: isoDateString.optional(),
  exam_id: z.coerce.number().int().positive().optional(),
  college: z.string().trim().max(150).optional(),
  interval: z.enum(['day', 'week', 'month']).optional(),
  limit: z.coerce.number().int().positive().max(50).default(8)
}).refine((data) => {
  if (data.period === 'custom') {
    if (!data.start_date || !data.end_date) {
      return false;
    }
    const start = new Date(data.start_date).getTime();
    const end = new Date(data.end_date).getTime();
    if (end < start) return false;
    const maxDays = 365;
    if ((end - start) > maxDays * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}, {
  message: "When period is 'custom', start_date and end_date must be valid, end_date >= start_date, and range cannot exceed 365 days",
  path: ['start_date']
});

module.exports = {
  dashboardFilterSchema
};

