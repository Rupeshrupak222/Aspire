// Validation schema for certificate retrieval.
const { z } = require('zod');

const certificateParamSchema = z.object({
  certificateId: z.string().trim().min(4, 'Invalid certificate identifier').max(64, 'Invalid certificate identifier')
});

module.exports = {
  certificateParamSchema
};
