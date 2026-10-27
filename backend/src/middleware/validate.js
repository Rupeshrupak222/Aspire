// Reusable request validation middleware using Zod.
// Validates body, params, and/or query, assigning sanitized parsed data back to req.
const { ValidationError } = require('../errors/app-error');

function validate(schemaOrConfig) {
  return (req, res, next) => {
    try {
      // If a raw Zod schema is passed directly, default to validating req.body
      if (schemaOrConfig && typeof schemaOrConfig.parse === 'function') {
        req.body = schemaOrConfig.parse(req.body || {});
        return next();
      }

      if (schemaOrConfig.params && typeof schemaOrConfig.params.parse === 'function') {
        req.params = schemaOrConfig.params.parse(req.params || {});
      }

      if (schemaOrConfig.query && typeof schemaOrConfig.query.parse === 'function') {
        req.query = schemaOrConfig.query.parse(req.query || {});
      }

      if (schemaOrConfig.body && typeof schemaOrConfig.body.parse === 'function') {
        req.body = schemaOrConfig.body.parse(req.body || {});
      }

      next();
    } catch (err) {
      if (err.name === 'ZodError') {
        const fields = {};
        for (const issue of err.issues) {
          const path = issue.path.join('.') || 'root';
          fields[path] = issue.message;
        }
        const message = Object.values(fields).join('; ') || 'Request validation failed';
        return next(new ValidationError(message, fields));
      }
      next(err);
    }
  };
}

module.exports = validate;
