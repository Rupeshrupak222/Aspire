// Aspire Test Platform — entry point.
// Loads env, ensures an admin token, seeds the DB, then starts the HTTP server.
require('./src/config/env').loadEnv();

const crypto = require('crypto');

const { db } = require('./src/db');
const { seedIfEmpty } = require('./src/data/seed');
const createApp = require('./src/app');

// Admin token: require an explicit value in production; generate one for local dev.
if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
  console.log('[aspire] ADMIN_TOKEN was not set — generated for this run:');
  console.log('[aspire]   ' + process.env.ADMIN_TOKEN);
  console.log('[aspire]   Set ADMIN_TOKEN in .env for a stable token.');
}

seedIfEmpty(db);

const app = createApp();
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => console.log(`[aspire] listening on port ${PORT}`));
}

module.exports = app;
