// Aspire Test Platform — entry point.
// Loads env, ensures an admin token, seeds the DB, then starts the HTTP server.
require('./src/config/env').loadEnv();

const crypto = require('crypto');

const { db } = require('./src/db');
const { seedIfEmpty } = require('./src/data/seed');
const createApp = require('./src/app');

// Authentication secret: require an explicit value in production; generate one for local dev.
if (!process.env.AUTH_SECRET && !process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] AUTH_SECRET environment variable must be set in production!');
    process.exit(1);
  }
  process.env.AUTH_SECRET = crypto.randomBytes(32).toString('hex');
}

// OnlineCompiler API key validation on startup (never logs or exposes the secret)
if (process.env.ONLINECOMPILER_REQUIRED === 'true' && !process.env.ONLINECOMPILER_API_KEY) {
  console.error('[FATAL] ONLINECOMPILER_API_KEY environment variable is required but missing!');
  process.exit(1);
}

seedIfEmpty(db);

const app = createApp();
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const { closeDatabase } = require('./src/db');
  const server = app.listen(PORT, () => console.log(`[aspire] listening on port ${PORT}`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[aspire] Error: Port ${PORT} is already in use by another process.`);
      console.error(`[aspire] Kill the process using port ${PORT} or specify a different PORT in .env.`);
    } else {
      console.error('[aspire] Server error:', err);
    }
    process.exit(1);
  });

  function gracefulShutdown(signal) {
    console.log(`[aspire] Received ${signal}. Initiating graceful shutdown...`);
    server.close(() => {
      console.log('[aspire] HTTP server closed.');
      closeDatabase();
      console.log('[aspire] Database connection closed cleanly.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[aspire] Forceful shutdown initiated after timeout.');
      closeDatabase();
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = app;
