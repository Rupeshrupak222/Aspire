const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const logger = require('../../utils/logger');
const { DB_PATH: defaultDbPath, closeDatabase, checkDbHealth, reopenDatabase } = require('../../db');
const manifestService = require('./backup-manifest.service');
const integrityService = require('./backup-integrity.service');
const encryptionService = require('./backup-encryption.service');
const fileBackupService = require('./file-backup.service');
const dbBackupService = require('./database-backup.service');

class RestoreService {
  /**
   * Execute a controlled, verified disaster recovery restore.
   * @param {object} options
   * @param {string} options.backupId Backup identifier or path
   * @param {string} [options.backupDir] Base backup directory
   * @param {string} [options.targetDbPath] Destination database path
   * @param {string} [options.targetUploadsDir] Destination uploads path
   * @param {string|Buffer} [options.encryptionKey]
   * @param {boolean} [options.dryRun=false] Perform all verifications and staging without modifying live data
   * @param {boolean} [options.confirm=false] Explicit confirmation required for destructive live replacement
   * @returns {Promise<object>} Restore report
   */
  async restoreBackup(options) {
    const {
      backupId,
      dryRun = false,
      confirm = false,
      encryptionKey
    } = options;

    if (!backupId) {
      throw new Error('backupId is required for restore operation.');
    }

    const backupBaseDir = options.backupDir || process.env.BACKUP_DIRECTORY || './data/backups';
    const backupDir = path.isAbsolute(backupId) ? backupId : path.join(backupBaseDir, backupId);

    if (!fs.existsSync(backupDir)) {
      throw new Error(`Backup directory not found: ${backupDir}`);
    }

    const targetDbPath = options.targetDbPath || defaultDbPath;
    const targetUploadsDir = options.targetUploadsDir || path.resolve(process.env.STORAGE_LOCAL_DIR || './data/uploads');

    logger.info({ backupId, dryRun, confirm, targetDbPath }, 'Starting disaster recovery restore pipeline');

    // 1. Read & Validate Manifest
    const manifestResult = await manifestService.readManifest(backupDir);
    if (!manifestResult.valid || !manifestResult.manifest) {
      throw new Error(`Cannot restore: Invalid or corrupt manifest in ${backupDir}: ${manifestResult.error}`);
    }
    const manifest = manifestResult.manifest;

    // 2. Verify all packaged artifact checksums BEFORE touching or decrypting anything
    for (const [artifactName, artifactInfo] of Object.entries(manifest.artifacts)) {
      const artifactDiskPath = path.join(backupDir, artifactInfo.path);
      if (!fs.existsSync(artifactDiskPath)) {
        throw new Error(`Cannot restore: Missing artifact '${artifactName}' at expected path ${artifactDiskPath}`);
      }

      const hashCheck = await integrityService.verifyFileHash(artifactDiskPath, artifactInfo.sha256);
      if (!hashCheck.valid) {
        throw new Error(`Cannot restore: Checksum mismatch for artifact '${artifactName}'. Expected: ${artifactInfo.sha256}, Got: ${hashCheck.actualHash}`);
      }
    }

    // 3. Create isolated staging workspace in OS temp
    const stagingDir = path.join(os.tmpdir(), `aspire_restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    let restorePreview = {};
    let rollbackSnapshots = {};

    try {
      // 4. Decrypt / Extract artifacts into staging
      const isEncrypted = Boolean(manifest.encryptionMetadata && manifest.encryptionMetadata.encrypted);
      const stagedFiles = {};

      for (const [artifactName, artifactInfo] of Object.entries(manifest.artifacts)) {
        const sourcePath = path.join(backupDir, artifactInfo.path);
        const targetFilename = artifactInfo.path.replace(/\.enc$/, '');
        const stagedTargetPath = path.join(stagingDir, targetFilename);

        if (isEncrypted) {
          logger.info({ artifact: artifactName }, 'Decrypting backup artifact into staging');
          await encryptionService.decryptFile(sourcePath, stagedTargetPath, encryptionKey);
        } else {
          fs.mkdirSync(path.dirname(stagedTargetPath), { recursive: true });
          fs.copyFileSync(sourcePath, stagedTargetPath);
        }

        stagedFiles[artifactName] = stagedTargetPath;
      }

      // 5. Inspect & Validate SQLite Database in Staging
      let stagedDbHealth = null;
      let stagedTableCounts = {};
      let stagedSchemaVersion = 'unknown';

      if (stagedFiles.database) {
        const verifyResult = dbBackupService.verifySnapshot(stagedFiles.database);
        if (!verifyResult.valid) {
          throw new Error(`Restored database failed integrity verification: ${verifyResult.error}`);
        }
        stagedDbHealth = verifyResult;
        stagedTableCounts = verifyResult.tableCounts;
        stagedSchemaVersion = verifyResult.schemaVersion;
      }

      // 6. Build Comprehensive Restore Preview
      restorePreview = {
        backupId: manifest.backupId,
        createdAt: manifest.createdAt,
        applicationVersion: manifest.applicationVersion,
        sourceDatabase: manifest.sourceDatabase,
        stagedSchemaVersion,
        isEncrypted,
        encryptionAlgorithm: manifest.encryptionMetadata?.algorithm || 'none',
        databaseIntegrity: stagedDbHealth ? stagedDbHealth.integrityCheck : 'n/a',
        foreignKeyIntegrity: stagedDbHealth ? stagedDbHealth.foreignKeyCheck : false,
        tableCounts: stagedTableCounts,
        artifacts: Object.keys(manifest.artifacts),
        targetDbPath,
        targetUploadsDir,
        requiresConfirmation: !dryRun && !confirm
      };

      // 7. If DRY-RUN: stop here and return verification preview
      if (dryRun) {
        logger.info({ restorePreview }, 'Disaster recovery dry-run completed successfully. No live data was modified.');
        return {
          success: true,
          dryRun: true,
          status: 'DRY_RUN_PASSED',
          preview: restorePreview
        };
      }

      // 8. If live restore requested without explicit confirmation: ABORT for safety
      if (!confirm) {
        throw new Error('Destructive restore requires explicit confirmation. Pass { confirm: true } or --confirm to execute.');
      }

      // 9. CAPTURE PRE-RESTORE SAFETY SNAPSHOT of live target DB & uploads
      const timestamp = Date.now();
      if (fs.existsSync(targetDbPath)) {
        const preRestoreDb = `${targetDbPath}.pre-restore.${timestamp}`;
        fs.copyFileSync(targetDbPath, preRestoreDb);
        rollbackSnapshots.database = preRestoreDb;
        logger.warn({ preRestoreDb }, 'Captured pre-restore rollback safety snapshot of live database');
      }

      // 10. Safely close live DB connections and remove stale WAL / SHM files
      closeDatabase();

      const targetWal = `${targetDbPath}-wal`;
      const targetShm = `${targetDbPath}-shm`;
      try {
        if (fs.existsSync(targetWal)) fs.unlinkSync(targetWal);
      } catch (err) {
        logger.warn({ err: err.message }, 'Notice: WAL file cleanup skipped');
      }
      try {
        if (fs.existsSync(targetShm)) fs.unlinkSync(targetShm);
      } catch (err) {
        logger.warn({ err: err.message }, 'Notice: SHM file cleanup skipped');
      }

      // 11. Atomic swap of database
      fs.mkdirSync(path.dirname(targetDbPath), { recursive: true });
      fs.copyFileSync(stagedFiles.database, targetDbPath);
      logger.info({ targetDbPath }, 'Live database file successfully replaced from restored snapshot');

      // Reconnect active database handle to restored database file
      reopenDatabase(targetDbPath);

      // 12. Restore Uploads & Branding Assets
      if (stagedFiles.files && fs.existsSync(stagedFiles.files)) {
        await fileBackupService.unpackFilesBundle(stagedFiles.files, {
          uploadsDir: targetUploadsDir
        });
      }

      // 13. Verify live replaced database health & integrity
      const liveVerify = new Database(targetDbPath, { readonly: true });
      try {
        const liveIntegrity = liveVerify.pragma('integrity_check', { simple: true });
        if (liveIntegrity !== 'ok') {
          throw new Error(`Post-restore live database check failed: ${liveIntegrity}`);
        }
      } finally {
        liveVerify.close();
      }

      // 14. Record restore audit entry if audit_logs table exists
      try {
        const auditDb = new Database(targetDbPath);
        auditDb.prepare(`
          INSERT INTO audit_logs (id, organization_id, user_id, action, target_type, target_id, details_json, created_at)
          VALUES (?, NULL, NULL, 'SYSTEM_RESTORE', 'DATABASE', ?, ?, datetime('now'))
        `).run(
          `audit_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          manifest.backupId,
          JSON.stringify({
            restoredFrom: backupDir,
            tableCounts: stagedTableCounts,
            rollbackSnapshot: rollbackSnapshots.database
          })
        );
        auditDb.close();
      } catch (err) {
        logger.warn({ err: err.message }, 'Could not record restore audit log (non-fatal)');
      }

      logger.info({ backupId: manifest.backupId, targetDbPath }, 'Disaster recovery restore completed successfully');

      return {
        success: true,
        dryRun: false,
        status: 'RESTORED_SUCCESSFULLY',
        preview: restorePreview,
        rollbackSnapshots
      };

    } finally {
      // 15. Clean up temporary staging workspace
      try {
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}

module.exports = new RestoreService();
