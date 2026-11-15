const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('../../utils/logger');
const { db: defaultDb, DB_PATH: defaultDbPath } = require('../../db');

class DatabaseBackupService {
  /**
   * Take a consistent online backup snapshot of SQLite in WAL mode.
   * @param {object} options
   * @param {import('better-sqlite3').Database} [options.db]
   * @param {string} [options.dbPath]
   * @param {string} options.targetPath Destination file path
   * @returns {Promise<{snapshotPath: string, sizeBytes: number, schemaVersion: string, tableCounts: Record<string, number>, integrityCheck: string, foreignKeyCheck: boolean}>}
   */
  async createSnapshot(options) {
    const activeDb = options.db || defaultDb;
    const activeDbPath = options.dbPath || defaultDbPath;
    const targetPath = options.targetPath;

    if (!targetPath) {
      throw new Error('targetPath is required for database snapshot.');
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    logger.info({ source: activeDbPath, target: targetPath }, 'Starting SQLite online backup snapshot');

    // 1. Perform online SQLite backup (WAL-safe, non-blocking)
    await activeDb.backup(targetPath);

    // 2. Validate output file
    if (!fs.existsSync(targetPath)) {
      throw new Error(`SQLite backup failed: destination file does not exist at ${targetPath}`);
    }

    const stat = fs.statSync(targetPath);
    if (stat.size === 0) {
      throw new Error(`SQLite backup failed: destination file is 0 bytes at ${targetPath}`);
    }

    // 3. Open snapshot in read-only mode to verify integrity and foreign keys
    const snapshotDb = new Database(targetPath, { readonly: true });
    let schemaVersion = 'unknown';
    let tableCounts = {};
    let integrityCheck = 'unknown';
    let foreignKeyCheck = false;

    try {
      // Run SQLite integrity check
      integrityCheck = snapshotDb.pragma('integrity_check', { simple: true });
      if (integrityCheck !== 'ok') {
        throw new Error(`SQLite snapshot failed integrity check: ${integrityCheck}`);
      }

      // Run foreign key check
      const fkViolations = snapshotDb.pragma('foreign_key_check');
      if (Array.isArray(fkViolations) && fkViolations.length > 0) {
        throw new Error(`SQLite snapshot has ${fkViolations.length} foreign key violation(s)`);
      }
      foreignKeyCheck = true;

      // Extract schema migration version
      try {
        const row = snapshotDb.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1').get();
        if (row && row.version) {
          schemaVersion = row.version;
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Could not read schema_migrations from snapshot');
      }

      // Collect record counts for core operational tables
      const coreTables = [
        'organizations',
        'users',
        'students',
        'exams',
        'questions',
        'attempts',
        'attempt_answers',
        'results',
        'certificates',
        'organization_subscriptions',
        'outbox_events',
        'notification_events',
        'audit_logs'
      ];

      for (const table of coreTables) {
        try {
          const countRow = snapshotDb.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
          tableCounts[table] = countRow ? countRow.cnt : 0;
        } catch {
          // Table may not exist in early schemas
        }
      }
    } finally {
      snapshotDb.close();
    }

    logger.info(
      { target: targetPath, sizeBytes: stat.size, schemaVersion, tableCounts },
      'SQLite backup snapshot verified successfully'
    );

    return {
      snapshotPath: targetPath,
      sizeBytes: stat.size,
      schemaVersion,
      tableCounts,
      integrityCheck,
      foreignKeyCheck
    };
  }

  /**
   * Verify an existing SQLite database snapshot file.
   * @param {string} filePath 
   * @returns {{valid: boolean, integrityCheck: string, foreignKeyCheck: boolean, schemaVersion: string, tableCounts: Record<string, number>, error?: string}}
   */
  verifySnapshot(filePath) {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: `File not found: ${filePath}` };
    }

    let snapshotDb;
    try {
      snapshotDb = new Database(filePath, { readonly: true });
      const integrityCheck = snapshotDb.pragma('integrity_check', { simple: true });
      if (integrityCheck !== 'ok') {
        return { valid: false, integrityCheck, error: `Integrity check failed: ${integrityCheck}` };
      }

      const fkViolations = snapshotDb.pragma('foreign_key_check');
      if (Array.isArray(fkViolations) && fkViolations.length > 0) {
        return { valid: false, integrityCheck: 'ok', foreignKeyCheck: false, error: `${fkViolations.length} foreign key violation(s)` };
      }

      let schemaVersion = 'unknown';
      try {
        const row = snapshotDb.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1').get();
        if (row) schemaVersion = row.version;
      } catch {}

      const tableCounts = {};
      const checkTables = ['organizations', 'users', 'students', 'attempts', 'certificates'];
      for (const table of checkTables) {
        try {
          const r = snapshotDb.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
          tableCounts[table] = r ? r.cnt : 0;
        } catch {}
      }

      return {
        valid: true,
        integrityCheck: 'ok',
        foreignKeyCheck: true,
        schemaVersion,
        tableCounts
      };
    } catch (err) {
      return { valid: false, error: err.message };
    } finally {
      if (snapshotDb) snapshotDb.close();
    }
  }
}

module.exports = new DatabaseBackupService();

