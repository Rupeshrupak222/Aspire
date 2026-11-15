const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../../utils/logger');
const manifestService = require('./backup-manifest.service');

/**
 * 1. Local Filesystem Backup Storage Provider
 */
class LocalBackupStorageProvider {
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir || process.env.BACKUP_DIRECTORY || './data/backups');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async putBackup(backupId, sourceDir) {
    const targetDir = path.join(this.baseDir, backupId);
    if (sourceDir !== targetDir) {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(targetDir, { recursive: true });
      // Copy directory recursively
      fs.cpSync(sourceDir, targetDir, { recursive: true });
    }
    return { provider: 'local', backupId, storagePath: targetDir };
  }

  async getBackup(backupId, destinationDir) {
    const sourceDir = path.join(this.baseDir, backupId);
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Backup not found in local storage: ${backupId}`);
    }
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.cpSync(sourceDir, destinationDir, { recursive: true });
    return { provider: 'local', backupId, destinationDir };
  }

  async listBackups() {
    if (!fs.existsSync(this.baseDir)) return [];

    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const list = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(this.baseDir, entry.name);
        const manifestResult = await manifestService.readManifest(dirPath);
        if (manifestResult.valid && manifestResult.manifest) {
          list.push({
            backupId: entry.name,
            createdAt: manifestResult.manifest.createdAt,
            directoryPath: dirPath,
            sizeBytes: manifestResult.manifest.totalSizeBytes,
            fileCount: manifestResult.manifest.fileCount,
            isValid: true,
            manifest: manifestResult.manifest
          });
        } else {
          // Incomplete or corrupted backup directory
          list.push({
            backupId: entry.name,
            createdAt: fs.statSync(dirPath).mtime.toISOString(),
            directoryPath: dirPath,
            sizeBytes: 0,
            fileCount: 0,
            isValid: false,
            error: manifestResult.error
          });
        }
      }
    }

    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async deleteBackup(backupId) {
    const targetDir = path.join(this.baseDir, backupId);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return { deleted: true, backupId };
    }
    return { deleted: false, backupId };
  }

  async verifyBackupAvailability(backupId) {
    const targetDir = path.join(this.baseDir, backupId);
    if (!fs.existsSync(targetDir)) return { available: false, error: 'Directory does not exist' };
    const manifestResult = await manifestService.readManifest(targetDir);
    return { available: manifestResult.valid, error: manifestResult.error };
  }
}

/**
 * 2. Rclone Off-Site Synchronization Adapter
 */
class RcloneBackupStorageProvider {
  constructor(options = {}) {
    this.remote = options.remote || process.env.BACKUP_RCLONE_REMOTE;
    this.remotePath = options.path || process.env.BACKUP_RCLONE_PATH || 'aspire-backups';
    this.rcloneBinary = process.env.RCLONE_BINARY || 'rclone';
    this.isMock = Boolean(options.mock || process.env.BACKUP_RCLONE_MOCK === 'true');
    this.mockStorage = new Map();
  }

  /**
   * Check if rclone executable is installed and runnable.
   */
  async isRcloneInstalled() {
    if (this.isMock) return true;

    return new Promise((resolve) => {
      execFile(this.rcloneBinary, ['version'], { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Sync a local backup directory to the configured rclone remote.
   */
  async syncToRemote(localBackupDir, backupId) {
    if (this.isMock) {
      this.mockStorage.set(backupId, {
        remote: this.remote || 'mock-remote',
        path: `${this.remotePath}/${backupId}`,
        syncedAt: new Date().toISOString()
      });
      return { success: true, mock: true, remoteTarget: `${this.remote || 'mock-remote'}:${this.remotePath}/${backupId}` };
    }

    const installed = await this.isRcloneInstalled();
    if (!installed) {
      throw new Error('Rclone executable is not installed or not in PATH.');
    }

    if (!this.remote) {
      throw new Error('BACKUP_RCLONE_REMOTE is not configured.');
    }

    const destination = `${this.remote}:${this.remotePath}/${backupId}`;
    const args = ['copy', localBackupDir, destination, '--non-interactive', '--links'];

    return new Promise((resolve, reject) => {
      execFile(this.rcloneBinary, args, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) {
          logger.error({ remote: this.remote, err: err.message, stderr }, 'Rclone off-site synchronization failed');
          return reject(new Error(`Rclone sync failed: ${err.message}`));
        }
        logger.info({ destination }, 'Rclone backup sync completed successfully');
        resolve({ success: true, destination, stdout });
      });
    });
  }
}

/**
 * 3. S3 / R2 Cloud Storage Provider
 */
class S3BackupStorageProvider {
  constructor(options = {}) {
    this.bucket = options.bucket || process.env.BACKUP_S3_BUCKET || process.env.R2_BUCKET_NAME;
    this.prefix = options.prefix || process.env.BACKUP_S3_PREFIX || 'backups';
    this.s3Client = null;
    this.isConfigured = Boolean(
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
    ) && Boolean(this.bucket);

    if (this.isConfigured) {
      this._initClient();
    }
  }

  _initClient() {
    try {
      const { S3Client } = require('@aws-sdk/client-s3');
      const endpoint = process.env.BACKUP_S3_ENDPOINT || process.env.R2_ENDPOINT;
      const region = process.env.BACKUP_S3_REGION || 'auto';
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;

      this.s3Client = new S3Client({
        region,
        endpoint,
        credentials: { accessKeyId, secretAccessKey }
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to initialize AWS/R2 S3 client for backups');
    }
  }

  async isAvailable() {
    return Boolean(this.s3Client && this.bucket);
  }
}

/**
 * Unified Backup Storage Gateway
 */
class BackupStorageManager {
  constructor() {
    this.localProvider = new LocalBackupStorageProvider();
    this.rcloneProvider = new RcloneBackupStorageProvider();
    this.s3Provider = new S3BackupStorageProvider();
  }

  getLocalProvider() {
    return this.localProvider;
  }

  getRcloneProvider() {
    return this.rcloneProvider;
  }

  getS3Provider() {
    return this.s3Provider;
  }
}

module.exports = {
  LocalBackupStorageProvider,
  RcloneBackupStorageProvider,
  S3BackupStorageProvider,
  backupStorageManager: new BackupStorageManager()
};

