// Standardized Application Error hierarchy for Aspire.
// Distinguishes expected operational errors from unexpected system bugs.

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', fields = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Request validation failed', fields = null) {
    super(message, 400, 'VALIDATION_ERROR', fields);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'AUTHENTICATION_REQUIRED');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(message, 404, code);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', code = 'PAYLOAD_TOO_LARGE') {
    super(message, 413, code);
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests, please slow down') {
    super(message, 429, 'RATE_LIMITED');
  }
}

class ExternalServiceError extends AppError {
  constructor(message = 'External service unavailable', code = 'EXTERNAL_SERVICE_ERROR') {
    super(message, 503, code);
  }
}

class InternalServerError extends AppError {
  constructor(message = 'Internal server error', code = 'INTERNAL_ERROR') {
    super(message, 500, code);
    this.isOperational = false;
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
  ExternalServiceError,
  InternalServerError
};
