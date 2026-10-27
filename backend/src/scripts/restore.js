// Production database restore script.
// Validates backup integrity, captures a pre-restore safety snapshot, and safely restores data.
require('../config/env').loadEnv();

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH: defaultDbPath, closeDatabase, checkDbHealth } = require('../db');

async function performRestore(options = {}) {
  const targetDbPath = options.targetDbPath || defaultDbPath;
  const backupDir = options.backupDir || process.env.BACKUP_DIR || path.join(path.dirname(targetDbPath), 'backups');

  let backupFile = options.backupFile || process.argv[2];

  if (!backupFile) {
    // Find the latest backup if none explicitly specified
    if (!fs.existsSync(backupDir)) {
      throw new Error(`Backup directory not found: ${backupDir}`);
    }
    const backups = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('aspire-') && f.endsWith('.sqlite'))
      .sort();
    if (backups.length === 0) {
      throw new Error(`No backup files found in: ${backupDir}`);
    }
    backupFile = path.join(backupDir, backups[backups.length - 1]);
  } else if (!path.isAbsolute(backupFile)) {
    backupFile = path.resolve(backupFile);
  }

  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file does not exist: ${backupFile}`);
  }

  console.log(`[restore] Validating backup integrity for: ${backupFile}...`);

  // 1. Verify backup file integrity BEFORE touching destination
  const sourceDb = new Database(backupFile, { readonly: true });
  try {
    const check = sourceDb.pragma('integrity_check', { simple: true });
    if (check !== 'ok') {
      throw new Error(`Source backup failed integrity check: ${check}`);
    }
  } finally {
    sourceDb.close();
  }

  console.log('[restore] Backup integrity verified (OK).');

  // 2. Ensure target directory exists
  fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });

  // 3. Take safety snapshot of existing destination if it exists
  if (fs.existsSync(targetDbPath)) {
    const preRestoreSnapshot = `${targetDbPath}.pre-restore.${Date.now()}`;
    fs.copyFileSync(targetDbPath, preRestoreSnapshot);
    console.log(`[restore] Saved pre-restore safety snapshot at: ${preRestoreSnapshot}`);
  }

  // 4. Close any open connections if restoring to the active DB
  if (targetDbPath === defaultDbPath) {
    closeDatabase();
  }

  // 5. Clean up any stale WAL or SHM files for target
  const walPath = `${targetDbPath}-wal`;
  const shmPath = `${targetDbPath}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  // 6. Copy backup file to target location
  fs.copyFileSync(backupFile, targetDbPath);
  console.log(`[restore] Restored ${backupFile} to ${targetDbPath}`);

  // 7. Verify restored database integrity and health
  const restoredDb = new Database(targetDbPath);
  try {
    restoredDb.pragma('journal_mode = WAL');
    restoredDb.pragma('foreign_keys = ON');
    const integrity = restoredDb.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Restored database failed integrity check: ${integrity}`);
    }

    const health = checkDbHealth(restoredDb);
    if (!health.healthy) {
      throw new Error(`Restored database health check failed: ${health.error}`);
    }
  } finally {
    restoredDb.close();
  }

  console.log('[restore] Restored database passed all health and integrity checks.');
  return {
    success: true,
    backupFile,
    targetDbPath
  };
}

if (require.main === module) {
  performRestore()
    .then((result) => {
      console.log(`[restore] Successfully restored database: ${result.targetDbPath}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[restore] FATAL ERROR:', err.message);
      process.exit(1);
    });
}

module.exports = { performRestore };
