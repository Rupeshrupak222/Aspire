// Express application wiring (no network listen here — see server.js).
const express = require('express');
const path = require('path');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Static frontend. Served from ../frontend by default; override with FRONTEND_DIR.
  const frontendDir = process.env.FRONTEND_DIR
    ? path.resolve(process.env.FRONTEND_DIR)
    : path.join(__dirname, '..', '..', 'frontend');
  app.use(express.static(frontendDir));

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api', publicRoutes);
  app.use('/api/admin', adminRoutes);

  // Fallback for unknown API routes.
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

module.exports = createApp;
