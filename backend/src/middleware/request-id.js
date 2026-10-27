// Middleware to attach a correlation Request ID and request-scoped logger.
const crypto = require('crypto');
const logger = require('../utils/logger');

function requestIdMiddleware(req, res, next) {
  const reqId = req.headers['x-request-id'] || `req_${crypto.randomBytes(8).toString('hex')}`;
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);

  req.log = logger.child({
    requestId: reqId,
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
