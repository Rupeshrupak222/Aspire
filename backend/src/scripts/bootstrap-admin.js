#!/usr/bin/env node
// Secure Super Admin bootstrap command for Aspire.
// Usage:
//   node backend/src/scripts/bootstrap-admin.js --email=admin@example.com --password=SecurePassword123! --name="Platform Admin"
// Or provide via environment variables:
//   INITIAL_ADMIN_EMAIL=... INITIAL_ADMIN_PASSWORD=... node backend/src/scripts/bootstrap-admin.js

require('../config/env').loadEnv();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db } = require('../db');
const { runMigrations } = require('../db/migrations');
const { ROLES } = require('../security/rbac');

// Ensure database schema is migrated
runMigrations(db);

const args = process.argv.slice(2);
function getArg(flag) {
  const prefix = `--${flag}=`;
  const match = args.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const email = (getArg('email') || process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
let password = getArg('password') || process.env.INITIAL_ADMIN_PASSWORD || '';
const name = (getArg('name') || process.env.INITIAL_ADMIN_NAME || 'Super Administrator').trim();

if (!email) {
  console.error('[aspire-bootstrap] ERROR: Admin email is required.');
  console.error('[aspire-bootstrap] Usage: node backend/src/scripts/bootstrap-admin.js --email=admin@domain.com [--password=YourPassword] [--name="Name"]');
  process.exit(1);
}

if (!password) {
  password = crypto.randomBytes(16).toString('hex');
  console.log('[aspire-bootstrap] No password provided — generated secure one-time password.');
}

if (password.length < 8) {
  console.error('[aspire-bootstrap] ERROR: Password must be at least 8 characters long.');
  process.exit(1);
}

const rounds = 12;
const hash = bcrypt.hashSync(password, rounds);

// Check if user already exists
const existing = db.prepare('SELECT id, role, email FROM users WHERE email = ?').get(email);

if (existing) {
  db.prepare(`
    UPDATE users
    SET password_hash = ?, role = 'SUPER_ADMIN', name = ?, status = 'ACTIVE',
        token_version = token_version + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(hash, name, existing.id);

  // Invalidate any old sessions
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`[aspire-bootstrap] SUCCESS: Updated existing user (${email}) to active SUPER_ADMIN role with new password.`);
} else {
  db.prepare(`
    INSERT INTO users (email, password_hash, name, role, organization_id, status)
    VALUES (?, ?, ?, 'SUPER_ADMIN', NULL, 'ACTIVE')
  `).run(email, hash, name);
  console.log(`[aspire-bootstrap] SUCCESS: Created new SUPER_ADMIN user (${email}).`);
}

console.log(`[aspire-bootstrap] Credentials:`);
console.log(`[aspire-bootstrap]   Email:    ${email}`);
console.log(`[aspire-bootstrap]   Password: ${password}`);
console.log(`[aspire-bootstrap] Keep these credentials safe!`);
