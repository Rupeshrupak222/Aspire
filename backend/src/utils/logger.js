// Production structured logger using Pino.
// Uses pino-pretty for development if available; produces standard JSON in production.
const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const forceJson = process.env.LOG_FORMAT === 'json' || isTest;
const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : (isTest ? 'silent' : 'debug'));

let transport;
if (!isProd && !forceJson) {
  try {
    transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname'
      }
    });
  } catch {
    // pino-pretty transport not available, default to stdout
    transport = undefined;
  }
}

const REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers["x-admin-token"]',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  '*.ADMIN_TOKEN',
  '*.AUTH_SECRET',
  '*.JWT_SECRET',
  '*.JUDGE0_API_KEY',
  '*.ONLINECOMPILER_API_KEY',
  '*.onlinecompiler_api_key',
  '*.RESEND_API_KEY',
  '*.DISCORD_WEBHOOK_URL',
  '*.TELEGRAM_BOT_TOKEN',
  '*.SENTRY_DSN',
  '*.GLITCHTIP_DSN',
  '*.CERTIFICATE_SIGNING_SECRET',
  'ONLINECOMPILER_API_KEY',
  'apiKey',
  'api_key',
  'sourceCode',
  'source_code',
  'candidate_code',
  'code',
  'test_cases',
  'password',
  'password_hash',
  'new_password',
  'current_password',
  'token_hash',
  'secret',
  'token',
  'otp',
  'mobile_otp',
  'email_token',
  'verification_token',
  'code_hash',
  'clipboard',
  'clipboard_data',
  '*.password',
  '*.password_hash',
  '*.otp',
  '*.token',
  '*.token_hash',
  '*.secret'
];

const logger = pino(
  {
    level: logLevel,
    base: {
      service: 'aspire-api',
      env: process.env.NODE_ENV || 'development'
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACTION_PATHS,
      censor: '[REDACTED]'
    }
  },
  transport
);

/**
 * Create a specialized child logger for workers
 */
logger.createWorkerLogger = function (workerName, meta = {}) {
  return logger.child({
    service: 'aspire-worker',
    worker: workerName,
    ...meta
  });
};

/**
 * Create a specialized child logger for queue operations
 */
logger.createQueueLogger = function (queueName, meta = {}) {
  return logger.child({
    service: 'aspire-queue',
    queue: queueName,
    ...meta
  });
};

/**
 * Safely scrub sensitive keys from an arbitrary object before external dispatch
 */
logger.sanitizePayload = function (data) {
  if (!data || typeof data !== 'object') return data;
  const sensitiveKeys = new Set([
    'password', 'password_hash', 'passwordHash', 'new_password', 'current_password',
    'token', 'token_hash', 'tokenHash', 'secret', 'auth_secret', 'jwt_secret',
    'otp', 'mobile_otp', 'email_token', 'verification_token', 'code_hash',
    'apiKey', 'api_key', 'authorization', 'cookie',
    'sourceCode', 'source_code', 'candidate_code', 'test_cases', 'clipboard'
  ]);

  function sanitize(val, depth = 0) {
    if (depth > 6 || val === null || val === undefined) return val;
    if (Array.isArray(val)) return val.map(item => sanitize(item, depth + 1));
    if (typeof val === 'object') {
      const copy = {};
      for (const [k, v] of Object.entries(val)) {
        if (sensitiveKeys.has(k) || sensitiveKeys.has(k.toLowerCase())) {
          copy[k] = '[REDACTED]';
        } else {
          copy[k] = sanitize(v, depth + 1);
        }
      }
      return copy;
    }
    return val;
  }

  return sanitize(data);
};

module.exports = logger;
