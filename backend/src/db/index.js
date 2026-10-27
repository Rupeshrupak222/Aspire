// SQLite database layer (better-sqlite3). File DB; swap to Postgres later if needed.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'data', 'aspire.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB memory cache for fast index/table lookups
db.pragma('temp_store = MEMORY');

const { runMigrations } = require('./migrations');
runMigrations(db);

const DEFAULT_CONFIG = {
  test_title: 'Aspire Scholarship Test',
  duration_minutes: '90',
  // Per-category quotas: each attempt draws up to quota questions from each
  // category (random subset, shuffled). Coding requires Judge0; when Judge0
  // is not configured the coding quota is skipped (test runs with 35).
  quota_aptitude: '10',
  quota_technical: '25',
  quota_coding: '5',
  shuffle_questions: '1',
  shuffle_options: '1',
  // Ordered high -> low. First slab whose min <= percentage wins.
  scholarship_slabs: JSON.stringify([
    { min: 90, scholarship: 100 },
    { min: 75, scholarship: 50 },
    { min: 60, scholarship: 25 },
    { min: 40, scholarship: 10 },
    { min: 0, scholarship: 0 }
  ]),
  brand_name: 'Adyapan',
  accent_color: '#F97316'
};

function getConfig(targetDb = db) {
  const rows = targetDb.prepare('SELECT key, value FROM config').all();
  const cfg = { ...DEFAULT_CONFIG };
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

function setConfig(key, value, targetDb = db) {
  targetDb.prepare(`INSERT INTO config(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function checkDbHealth(targetDb = db) {
  try {
    const alive = targetDb.prepare('SELECT 1 AS alive').get();
    if (!alive || alive.alive !== 1) return { healthy: false, error: 'Database ping failed' };

    const fk = targetDb.pragma('foreign_keys', { simple: true });
    const jm = targetDb.pragma('journal_mode', { simple: true });

    let latestMigration = null;
    try {
      const row = targetDb.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1').get();
      if (row) latestMigration = row.version;
    } catch {
      // migrations table might not exist yet during initial boot
    }

    return {
      healthy: true,
      journalMode: jm,
      foreignKeys: fk === 1,
      latestMigration
    };
  } catch (err) {
    return {
      healthy: false,
      error: err.message
    };
  }
}

function getDbStats(targetDb = db) {
  try {
    const counts = {};
    const tables = ['organizations', 'users', 'sessions', 'audit_logs', 'questions', 'students', 'attempts'];
    for (const t of tables) {
      try {
        const r = targetDb.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
        counts[t] = r.c;
      } catch {
        counts[t] = 0;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

function closeDatabase(targetDb = db) {
  if (targetDb && targetDb.open) {
    try {
      targetDb.close();
      return true;
    } catch (e) {
      console.error('[db] Error closing database:', e.message);
      return false;
    }
  }
  return false;
}

module.exports = {
  db,
  getConfig,
  setConfig,
  checkDbHealth,
  getDbStats,
  closeDatabase,
  DEFAULT_CONFIG,
  DB_PATH
};

