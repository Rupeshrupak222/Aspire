// Centralized Express error handler.
// Maps known system/database errors to AppError, logs securely, and returns consistent JSON.
const { AppError, ValidationError, ConflictError, ExternalServiceError } = require('../errors/app-error');
const defaultLogger = require('../utils/logger');
const metrics = require('../utils/metrics');

function errorHandler(err, req, res, next) {
  const log = req.log || defaultLogger;
  let error = err;

  // 1. Map Zod validation errors if caught here
  if (err && err.name === 'ZodError') {
    const fields = {};
    if (Array.isArray(err.issues)) {
      for (const issue of err.issues) {
        const path = issue.path.join('.') || 'body';
        fields[path] = issue.message;
      }
    }
    const msg = Object.values(fields).join('; ') || 'Request validation failed';
    error = new ValidationError(msg, fields);
  }

  // 2. Map SQLite errors
  if (err && err.constructor && err.constructor.name === 'SqliteError') {
    if (err.message.includes('UNIQUE constraint failed: students.phone')) {
      error = new ConflictError(
        'This phone number has already been used for the test. One attempt per student.',
        'ALREADY_ATTEMPTED'
      );
    } else if (err.message.includes('UNIQUE constraint failed')) {
      error = new ConflictError('A record with these unique details already exists.', 'DUPLICATE_RECORD');
    } else if (err.message.includes('FOREIGN KEY constraint failed')) {
      error = new AppError('Related reference record not found.', 400, 'FOREIGN_KEY_VIOLATION');
    } else if (err.message.includes('CHECK constraint failed')) {
      error = new AppError('The requested operation violates database integrity constraints.', 400, 'CONSTRAINT_VIOLATION');
    } else if (err.code === 'SQLITE_BUSY' || err.message.includes('database is locked') || err.message.includes('resource busy')) {
      metrics.recordDbOperation('busy', 0, true);
      error = new AppError('Database is temporarily busy. Please retry shortly.', 503, 'DATABASE_BUSY');
    } else {
      error = new AppError('A database error occurred. Please try again.', 500, 'DATABASE_ERROR');
    }
  }

  // 3. Map Judge0 / OnlineCompiler / external service errors
  if (err && typeof err.message === 'string' && (
    err.message.includes('Judge0 HTTP') ||
    err.message.includes('Judge0 is not configured') ||
    err.message.includes('OnlineCompiler HTTP') ||
    err.message.includes('OnlineCompiler execution engine is not configured')
  )) {
    error = new ExternalServiceError('Code execution engine is temporarily unavailable.', 'CODE_EXECUTION_UNAVAILABLE');
  }

  // 4. Ensure error is an AppError instance
  const isOperational = error instanceof AppError && error.isOperational;
  const statusCode = error.statusCode || (isOperational ? 400 : 500);
  const code = error.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  const message = isOperational
    ? error.message
    : (statusCode === 404 ? 'Not found' : 'An internal error occurred. Please try again.');

  // 5. Log the error safely
  const logContext = {
    statusCode,
    code,
    message: err.message,
    stack: isOperational ? undefined : err.stack,
    fields: error.fields || undefined
  };

  if (statusCode >= 500) {
    log.error(logContext, 'Unhandled or server error');
  } else {
    log.warn(logContext, 'Operational API error');
  }

  // 6. Return standard client response (never exposing internal stack or SQL)
  res.status(statusCode).json({
    success: false,
    error: code,
    code,
    message,
    ...(error.fields ? { fields: error.fields } : {}),
    requestId: req.id || undefined
  });
}

module.exports = errorHandler;
