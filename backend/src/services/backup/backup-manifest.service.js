const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const packageJson = require('../../../../package.json');

const ManifestSchema = z.object({
  backupId: z.string().min(8),
  backupType: z.enum(['full', 'database', 'files']),
  createdAt: z.string().datetime(),
  applicationVersion: z.string(),
  environment: z.string(),
  databaseEngine: z.string(),
  databaseSchemaVersion: z.string(),
  sourceDatabase: z.string(),
  artifacts: z.record(z.string(), z.object({
    path: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().length(64)
  })),
  fileCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  checksums: z.record(z.string(), z.string().length(64)),
  encryptionMetadata: z.object({
    encrypted: z.boolean(),
    algorithm: z.string().optional(),
    keyId: z.string().optional()
  }),
  backupStatus: z.enum(['IN_PROGRESS', 'COMPLETED', 'FAILED']),
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED', 'FAILED']),
  metadata: z.record(z.string(), z.any()).optional()
});

class BackupManifestService {
  /**
   * Generate a unique, non-guessable backup ID.
   * @param {string} [prefix='bak'] 
   * @returns {string} e.g. bak_20261114_172030_a1b2c3d4
   */
  generateBackupId(prefix = 'bak') {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
    const rand = crypto.randomBytes(4).toString('hex');
    return `${prefix}_${dateStr}_${rand}`;
  }

  /**
   * Create a structured manifest object.
   * @param {object} params 
   * @returns {object} Validated manifest object
   */
  createManifest(params) {
    const rawManifest = {
      backupId: params.backupId || this.generateBackupId(),
      backupType: params.backupType || 'full',
      createdAt: params.createdAt || new Date().toISOString(),
      applicationVersion: packageJson.version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      databaseEngine: 'SQLite 3 (better-sqlite3)',
      databaseSchemaVersion: params.databaseSchemaVersion || 'unknown',
      sourceDatabase: params.sourceDatabase || 'aspire.db',
      artifacts: params.artifacts || {},
      fileCount: params.fileCount || 0,
      totalSizeBytes: params.totalSizeBytes || 0,
      checksums: params.checksums || {},
      encryptionMetadata: params.encryptionMetadata || { encrypted: false },
      backupStatus: params.backupStatus || 'COMPLETED',
      verificationStatus: params.verificationStatus || 'VERIFIED',
      metadata: params.metadata || {}
    };

    return ManifestSchema.parse(rawManifest);
  }

  /**
   * Write manifest to disk at specified directory.
   * @param {string} destinationDir 
   * @param {object} manifestData 
   * @returns {Promise<string>} Path to written manifest.json
   */
  async writeManifest(destinationDir, manifestData) {
    fs.mkdirSync(destinationDir, { recursive: true });
    const validated = ManifestSchema.parse(manifestData);
    const manifestPath = path.join(destinationDir, 'manifest.json');
    await fs.promises.writeFile(manifestPath, JSON.stringify(validated, null, 2), 'utf8');
    return manifestPath;
  }

  /**
   * Read and validate manifest from a directory or file path.
   * @param {string} manifestOrDir 
   * @returns {Promise<{valid: boolean, manifest?: object, error?: string}>}
   */
  async readManifest(manifestOrDir) {
    let filePath = manifestOrDir;
    if (fs.existsSync(manifestOrDir) && fs.statSync(manifestOrDir).isDirectory()) {
      filePath = path.join(manifestOrDir, 'manifest.json');
    }

    if (!fs.existsSync(filePath)) {
      return { valid: false, error: `Manifest file not found at ${filePath}` };
    }

    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      const validated = ManifestSchema.parse(parsed);
      return { valid: true, manifest: validated };
    } catch (err) {
      return { valid: false, error: `Invalid backup manifest: ${err.message}` };
    }
  }
}

module.exports = new BackupManifestService();

