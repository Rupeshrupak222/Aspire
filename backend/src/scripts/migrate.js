// Standalone database migration CLI tool for Aspire.
require('../config/env').loadEnv();

const { db, DB_PATH } = require('../db');
const { runMigrations, getMigrationsStatus } = require('../db/migrations');

function main() {
  const isStatusOnly = process.argv.includes('--status');

  console.log(`[migrate] Database target: ${DB_PATH}`);

  const beforeStatus = getMigrationsStatus(db);
  const beforeApplied = new Set(beforeStatus.map((m) => m.version));

  if (isStatusOnly) {
    console.log('[migrate] Applied migrations:');
    if (beforeStatus.length === 0) {
      console.log('  (none)');
    } else {
      for (const m of beforeStatus) {
        console.log(`  ✓ ${m.version} (applied at ${m.applied_at})`);
      }
    }
    process.exit(0);
  }

  console.log('[migrate] Checking for pending migrations...');
  runMigrations(db);

  const afterStatus = getMigrationsStatus(db);
  const newlyApplied = afterStatus.filter((m) => !beforeApplied.has(m.version));

  if (newlyApplied.length === 0) {
    console.log('[migrate] Database is up to date. No pending migrations.');
  } else {
    for (const m of newlyApplied) {
      console.log(`[migrate] Successfully applied: ${m.version}`);
    }
  }

  console.log(`[migrate] Current schema version: ${afterStatus[afterStatus.length - 1]?.version || 'none'}`);
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[migrate] Migration failure:', err);
    process.exit(1);
  }
}

module.exports = { main };
