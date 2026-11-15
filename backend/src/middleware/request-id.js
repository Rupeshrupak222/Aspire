// Middleware to attach a validated correlation Request ID and request-scoped logger.
const crypto = require('crypto');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

const SAFE_ID_REGEX = /^[a-zA-Z0-9_\-\.]{8,64}$/;

function normalizePath(originalUrl) {
  if (!originalUrl) return 'unknown';
  const pathOnly = originalUrl.split('?')[0];
  return pathOnly
    .replace(/[0-9a-fA-F]{24,64}/g, ':token')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function validateOrGenerateId(headerValue, prefix = 'req_') {
  if (headerValue && typeof headerValue === 'string') {
    const trimmed = headerValue.trim();
    if (SAFE_ID_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function requestIdMiddleware(req, res, next) {
  const reqId = validateOrGenerateId(req.headers['x-request-id'], 'req_');
  const correlationId = validateOrGenerateId(req.headers['x-correlation-id'], 'corr_');

  req.id = reqId;
  req.correlationId = correlationId;

  res.setHeader('X-Request-Id', reqId);
  res.setHeader('X-Correlation-Id', correlationId);

  req.log = logger.child({
    requestId: reqId,
    correlationId: correlationId,
    method: req.method,
    url: req.originalUrl || req.url
  });

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      statusCode: res.statusCode,
      durationMs: duration
    };

    metrics.recordRequest(req.method, normalizePath(req.originalUrl || req.url), res.statusCode, duration);

    if (res.statusCode >= 500) {
      req.log.error(logData, 'Request completed with server error');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'Request completed with client error');
    } else {
      req.log.info(logData, 'Request completed successfully');
    }
  });

  next();
}

module.exports = requestIdMiddleware;
