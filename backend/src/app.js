// Express application wiring (no network listen here — see server.js).
const express = require('express');
const path = require('path');
const requestIdMiddleware = require('./middleware/request-id');
const errorHandler = require('./middleware/error-handler');
const { NotFoundError } = require('./errors/app-error');
const { securityHeaders, permissionsPolicy } = require('./security/headers');
const corsMiddleware = require('./security/cors');
const { publicApiLimiter } = require('./security/rate-limit');
const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();

  // 1. Trust proxy for rate limiting & secure cookies behind reverse proxy (Nginx / Cloudflare)
  app.set('trust proxy', 1);

  // 2. Correlation Request ID & structured child logger
  app.use(requestIdMiddleware);

  // 3. Security HTTP headers via Helmet + Permissions Policy
  app.use(securityHeaders());
  app.use(permissionsPolicy);

  // 4. Cross-Origin Resource Sharing (CORS) with allowlist
  app.use(corsMiddleware());

  // 5. Global API Rate Limiter
  app.use('/api', publicApiLimiter);

  // 6. Request Body Size Limits
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '128kb' }));

  // 7. Static frontend. Served from ../frontend by default; override with FRONTEND_DIR.
  const frontendDir = process.env.FRONTEND_DIR
    ? path.resolve(process.env.FRONTEND_DIR)
    : path.join(__dirname, '..', '..', 'frontend');
  app.use(express.static(frontendDir));

  // 8. Health check & API Routes
  const { checkDbHealth } = require('./db');
  const healthHandler = (req, res) => {
    const dbStatus = checkDbHealth();
    if (!dbStatus.healthy) {
      return res.status(503).json({
        success: false,
        ok: false,
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database health check failed.'
        }
      });
    }
    res.json({
      ok: true,
      success: true,
      time: new Date().toISOString(),
      data: {
        database: 'ok',
        status: 'UP'
      }
    });
  };

  app.get('/health', healthHandler);
  app.get('/health/db', healthHandler);
  app.get('/api/health', healthHandler);
  app.get('/api/health/db', healthHandler);
  app.use('/api/auth', authRoutes);
  app.use('/api', publicRoutes);
  app.use('/api/admin', adminRoutes);

  // 9. Fallback for unknown API routes
  app.use('/api', (req, res, next) => next(new NotFoundError('Not found')));

  // 10. Centralized error handling middleware
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
