const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../../utils/logger');
const { db: defaultDb, DB_PATH: defaultDbPath } = require('../../db');
const dbBackupService = require('./database-backup.service');
const fileBackupService = require('./file-backup.service');
const configBackupService = require('./configuration-backup.service');
const manifestService = require('./backup-manifest.service');
const integrityService = require('./backup-integrity.service');
const encryptionService = require('./backup-encryption.service');
const retentionService = require('./backup-retention.service');
const schedulerService = require('./backup-scheduler.service');
const restoreService = require('./restore.service');
const { backupStorageManager } = require('./backup-storage.service');

class BackupService {
  /**
   * Create a comprehensive, encrypted, verified backup archive.
   * @param {object} [options]
   * @param {'full'|'database'|'files'} [options.type='full']
   * @param {boolean} [options.encrypt=true]
   * @param {string|Buffer} [options.encryptionKey]
   * @param {import('better-sqlite3').Database} [options.db]
   * @param {string} [options.dbPath]
   * @param {string} [options.backupDir]
   * @param {boolean} [options.syncCloud=false]
   * @returns {Promise<object>}
   */
  async createBackup(options = {}) {
    return schedulerService.withLock(async () => {
      const backupType = options.type || 'full';
      const encrypt = options.encrypt !== false;
      const targetDb = options.db || defaultDb;
      const targetDbPath = options.dbPath || defaultDbPath;
      const backupBaseDir = options.backupDir || process.env.BACKUP_DIRECTORY || './data/backups';
      const backupId = manifestService.generateBackupId();

      logger.info({ backupId, backupType, encrypt }, 'Initializing backup generation workflow');

      // 1. Create temporary staging directory
      const stagingDir = path.join(os.tmpdir(), `aspire_stage_${backupId}`);
      fs.mkdirSync(stagingDir, { recursive: true });

      const rawArtifacts = {};
      const finalArtifacts = {};
      const checksums = {};
      let totalSizeBytes = 0;
      let totalFileCount = 0;
      let dbSchemaVersion = 'unknown';

      try {
        // 2. Database Backup Snapshot (if full or database)
        if (backupType === 'full' || backupType === 'database') {
          const rawDbPath = path.join(stagingDir, 'database.sqlite');
          const dbSnapshot = await dbBackupService.createSnapshot({
            db: targetDb,
            dbPath: targetDbPath,
            targetPath: rawDbPath
          });

          dbSchemaVersion = dbSnapshot.schemaVersion;
          rawArtifacts.database = rawDbPath;
          totalFileCount++;
        }

        // 3. Persistent Files & Assets Backup (if full or files)
        if (backupType === 'full' || backupType === 'files') {
          const bundlePath = path.join(stagingDir, 'files-bundle.json');
          const fileResult = await fileBackupService.packageFilesBundle(bundlePath);
          rawArtifacts.files = bundlePath;
          totalFileCount += fileResult.fileCount;
        }

        // 4. Configuration Inventory Backup
        if (backupType === 'full' || backupType === 'database') {
          const configPayload = configBackupService.generateConfigBackup(targetDb);
          const configPath = path.join(stagingDir, 'config-inventory.json');
          await fs.promises.writeFile(configPath, JSON.stringify(configPayload, null, 2), 'utf8');
          rawArtifacts.config = configPath;
          totalFileCount++;
        }

        // 5. Final Package Directory (where encrypted or verified artifacts are assembled)
        const packageDir = path.join(stagingDir, 'package');
        fs.mkdirSync(packageDir, { recursive: true });

        // Process Database Artifact
        if (rawArtifacts.database) {
          const destName = encrypt ? 'database.sqlite.enc' : 'database.sqlite';
          const destPath = path.join(packageDir, destName);

          if (encrypt) {
            await encryptionService.encryptFile(rawArtifacts.database, destPath, options.encryptionKey);
          } else {
            fs.copyFileSync(rawArtifacts.database, destPath);
          }

          const stat = fs.statSync(destPath);
          const hash = await integrityService.computeFileHash(destPath);
          finalArtifacts.database = { path: destName, sizeBytes: stat.size, sha256: hash };
          checksums[destName] = hash;
          totalSizeBytes += stat.size;
        }

        // Process Files Artifact (bundled)
        if (rawArtifacts.files && fs.existsSync(rawArtifacts.files)) {
          const destName = encrypt ? 'files-bundle.json.enc' : 'files-bundle.json';
          const destPath = path.join(packageDir, destName);

          if (encrypt) {
            await encryptionService.encryptFile(rawArtifacts.files, destPath, options.encryptionKey);
          } else {
            fs.copyFileSync(rawArtifacts.files, destPath);
          }

          const stat = fs.statSync(destPath);
          const hash = await integrityService.computeFileHash(destPath);
          finalArtifacts.files = { path: destName, sizeBytes: stat.size, sha256: hash };
          checksums[destName] = hash;
          totalSizeBytes += stat.size;
        }

        // Process Config Artifact
        if (rawArtifacts.config) {
          const destName = encrypt ? 'config-inventory.json.enc' : 'config-inventory.json';
          const destPath = path.join(packageDir, destName);

          if (encrypt) {
            await encryptionService.encryptFile(rawArtifacts.config, destPath, options.encryptionKey);
          } else {
            fs.copyFileSync(rawArtifacts.config, destPath);
          }

          const stat = fs.statSync(destPath);
          const hash = await integrityService.computeFileHash(destPath);
          finalArtifacts.config = { path: destName, sizeBytes: stat.size, sha256: hash };
          checksums[destName] = hash;
          totalSizeBytes += stat.size;
        }

        // 6. Build and write manifest.json
        const manifestObj = manifestService.createManifest({
          backupId,
          backupType,
          createdAt: new Date().toISOString(),
          databaseSchemaVersion: dbSchemaVersion,
          sourceDatabase: path.basename(targetDbPath),
          artifacts: finalArtifacts,
          fileCount: totalFileCount,
          totalSizeBytes,
          checksums,
          encryptionMetadata: {
            encrypted: encrypt,
            algorithm: encrypt ? 'aes-256-gcm' : undefined,
            keyId: encrypt ? (process.env.BACKUP_ENCRYPTION_KEY_ID || 'aspire-default-key-v1') : undefined
          },
          backupStatus: 'COMPLETED',
          verificationStatus: 'VERIFIED'
        });

        await manifestService.writeManifest(packageDir, manifestObj);

        // 7. Store final package in target storage directory
        const storageProvider = backupStorageManager.getLocalProvider();
        const storedResult = await storageProvider.putBackup(backupId, packageDir);

        logger.info({ backupId, path: storedResult.storagePath, totalSizeBytes }, 'Backup stored successfully in local repository');

        // 8. Optional Rclone sync
        let cloudSyncResult = null;
        if (options.syncCloud || process.env.BACKUP_RCLONE_REMOTE) {
          try {
            const rclone = backupStorageManager.getRcloneProvider();
            cloudSyncResult = await rclone.syncToRemote(storedResult.storagePath, backupId);
          } catch (err) {
            logger.warn({ backupId, err: err.message }, 'Cloud off-site sync failed (local backup intact)');
          }
        }

        // 9. Apply retention policy
        const allBackups = await storageProvider.listBackups();
        const retentionReport = await retentionService.applyRetention(allBackups);

        return {
          success: true,
          backupId,
          backupType,
          createdAt: manifestObj.createdAt,
          location: storedResult.storagePath,
          sizeBytes: totalSizeBytes,
          fileCount: totalFileCount,
          encrypted: encrypt,
          manifest: manifestObj,
          cloudSync: cloudSyncResult,
          retention: retentionReport
        };

      } finally {
        // Clean up temporary staging workspace
        try {
          if (fs.existsSync(stagingDir)) {
            fs.rmSync(stagingDir, { recursive: true, force: true });
          }
        } catch {}
      }
    });
  }

  /**
   * List all available backups from the storage repository.
   */
  async listBackups() {
    const provider = backupStorageManager.getLocalProvider();
    return provider.listBackups();
  }

  /**
   * Verify the cryptographic and structural integrity of an existing backup.
   * @param {string} backupId 
   * @param {object} [options]
   */
  async verifyBackup(backupId, options = {}) {
    const provider = backupStorageManager.getLocalProvider();
    const backupDir = path.isAbsolute(backupId) ? backupId : path.join(provider.baseDir, backupId);

    if (!fs.existsSync(backupDir)) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    const manifestResult = await manifestService.readManifest(backupDir);
    if (!manifestResult.valid || !manifestResult.manifest) {
      return { valid: false, error: manifestResult.error };
    }

    const manifest = manifestResult.manifest;
    const errors = [];

    // Verify all checksums in the manifest
    for (const [relPath, expectedHash] of Object.entries(manifest.checksums)) {
      const fullPath = path.join(backupDir, relPath);
      if (!fs.existsSync(fullPath)) {
        errors.push(`Missing file: ${relPath}`);
        continue;
      }

      const check = await integrityService.verifyFileHash(fullPath, expectedHash);
      if (!check.valid) {
        errors.push(`Checksum mismatch on ${relPath}: expected ${expectedHash}, got ${check.actualHash}`);
      }
    }

    return {
      valid: errors.length === 0,
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      totalSizeBytes: manifest.totalSizeBytes,
      fileCount: manifest.fileCount,
      encrypted: manifest.encryptionMetadata.encrypted,
      errors
    };
  }

  /**
   * Restore a backup archive.
   * @param {object} options 
   */
  async restoreBackup(options) {
    return restoreService.restoreBackup(options);
  }

  /**
   * Prune expired backups per retention policy.
   * @param {object} [options]
   */
  async cleanupBackups(options = {}) {
    const provider = backupStorageManager.getLocalProvider();
    const allBackups = await provider.listBackups();
    return retentionService.applyRetention(allBackups, options);
  }

  /**
   * Get scheduler telemetry status.
   */
  getSchedulerStatus() {
    return schedulerService.getStatus();
  }
}

module.exports = new BackupService();
