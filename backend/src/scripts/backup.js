// SQLite-safe production database backup script.
// Uses better-sqlite3 db.backup() to produce consistent snapshots without blocking readers or writers.
require('../config/env').loadEnv();

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { db: defaultDb, DB_PATH: defaultDbPath } = require('../db');

async function performBackup(options = {}) {
  const db = options.db || defaultDb;
  const dbPath = options.dbPath || defaultDbPath;
  const backupDir = options.backupDir || process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
  const retentionCount = parseInt(options.retentionCount || process.env.BACKUP_RETENTION_COUNT || '10', 10);

  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `aspire-${timestamp}.sqlite`;
  const targetPath = path.join(backupDir, filename);

  console.log(`[backup] Starting SQLite online backup from ${dbPath} to ${targetPath}...`);

  // 1. Perform online SQLite backup (WAL-safe)
  await db.backup(targetPath);

  // 2. Verify backup file existence and size
  const stat = fs.statSync(targetPath);
  if (stat.size === 0) {
    throw new Error('Backup failed: output file is 0 bytes');
  }

  // 3. Verify backup database integrity
  const backupDb = new Database(targetPath, { readonly: true });
  try {
    const check = backupDb.pragma('integrity_check', { simple: true });
    if (check !== 'ok') {
      throw new Error(`Backup failed integrity check: ${check}`);
    }
  } finally {
    backupDb.close();
  }

  console.log(`[backup] Backup verified successfully: ${filename} (${stat.size} bytes)`);

  // 4. Apply retention policy
  const existingBackups = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith('aspire-') && f.endsWith('.sqlite'))
    .sort();

  if (existingBackups.length > retentionCount) {
    const toDelete = existingBackups.slice(0, existingBackups.length - retentionCount);
    for (const oldFile of toDelete) {
      const oldPath = path.join(backupDir, oldFile);
      try {
        fs.unlinkSync(oldPath);
        console.log(`[backup] Pruned old backup per retention policy: ${oldFile}`);
      } catch (err) {
        console.warn(`[backup] Warning: Could not delete ${oldFile}:`, err.message);
      }
    }
  }

  return {
    success: true,
    filename,
    filePath: targetPath,
    sizeBytes: stat.size,
    timestamp
  };
}

if (require.main === module) {
  performBackup()
    .then((result) => {
      console.log(`[backup] Complete: ${result.filePath}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[backup] FATAL ERROR:', err);
      process.exit(1);
    });
}

module.exports = { performBackup };
