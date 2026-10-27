// Environment-driven Cross-Origin Resource Sharing (CORS) configuration.
const cors = require('cors');

const isProd = process.env.NODE_ENV === 'production';

function getApprovedOrigins() {
  const envOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (isProd) {
    return envOrigins;
  }

  // Development / test defaults
  const devDefaults = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3210',
    'http://127.0.0.1:3210',
    'http://localhost:3211',
    'http://127.0.0.1:3211',
    'http://localhost:3212',
    'http://127.0.0.1:3212'
  ];

  return Array.from(new Set([...devDefaults, ...envOrigins]));
}

function corsMiddleware() {
  const allowed = getApprovedOrigins();

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, same-origin browser navigations)
      if (!origin) return callback(null, true);

      if (!isProd && allowed.includes(origin)) {
        return callback(null, true);
      }

      if (isProd && allowed.includes(origin)) {
        return callback(null, true);
      }

      // If in dev and no origins were configured, allow localhost pattern
      if (!isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      callback(new Error(`Origin '${origin}' not permitted by CORS policy`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'x-request-id'],
    maxAge: 86400 // 24 hours preflight cache
  });
}

module.exports = corsMiddleware;
