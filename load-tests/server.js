// Dedicated Isolated Load Test Server (Day 15)
// Boots an isolated instance on configurable PORT and temporary DB_PATH

const path = require('path');
const os = require('os');
const http = require('http');

const PORT = parseInt(process.env.PORT, 10) || 3310;
const DB_PATH = process.env.DB_PATH || path.join(os.tmpdir(), `aspire-loadtest-${PORT}.db`);

process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'day15_load_test_auth_secret_key_32chars_min!';

const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { seedIfEmpty } = require('../backend/src/data/seed');

seedIfEmpty(db);
const app = createApp();
const server = http.createServer(app);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[aspire-load-server] Listening on http://127.0.0.1:${PORT} (PID ${process.pid})`);
  console.log(`[aspire-load-server] Database: ${DB_PATH}`);
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

