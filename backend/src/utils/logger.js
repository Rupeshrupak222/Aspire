// Production structured logger using Pino.
// Uses pino-pretty for development if available; produces standard JSON in production.
const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

let transport;
if (!isProd) {
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

const logger = pino(
  {
    level: logLevel,
    base: {
      service: 'aspire-api',
      env: process.env.NODE_ENV || 'development'
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-admin-token"]',
        '*.ADMIN_TOKEN',
        '*.AUTH_SECRET',
        '*.JWT_SECRET',
        '*.JUDGE0_API_KEY',
        'password',
        'password_hash',
        'new_password',
        'current_password',
        'token_hash',
        'secret',
        'token'
      ],
      censor: '[REDACTED]'
    }
  },
  transport
);

module.exports = logger;
