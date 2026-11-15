const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const integrityService = require('./backup-integrity.service');

class FileBackupService {
  constructor() {
    this.defaultUploadsDir = path.resolve(process.env.STORAGE_LOCAL_DIR || './data/uploads');
    this.defaultLogoDir = path.resolve('./data/logo');
  }

  /**
   * Scan a directory recursively and return file descriptors.
   * @param {string} dirPath 
   * @param {string} [baseDir]
   * @returns {Array<{relativePath: string, fullPath: string, sizeBytes: number}>}
   */
  scanDirectory(dirPath, baseDir = dirPath) {
    const list = [];
    if (!fs.existsSync(dirPath)) return list;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        list.push(...this.scanDirectory(fullPath, baseDir));
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const stat = fs.statSync(fullPath);
        list.push({ relativePath, fullPath, sizeBytes: stat.size });
      }
    }
    return list;
  }

  /**
   * Package all uploads and logos into a single unified JSON bundle.
   * @param {string} destinationBundlePath 
   * @param {object} [customSources]
   * @returns {Promise<{bundlePath: string, fileCount: number, totalSizeBytes: number, fileMap: Record<string, {hash: string, sizeBytes: number}>, sha256: string}>}
   */
  async packageFilesBundle(destinationBundlePath, customSources = {}) {
    const uploadsSource = customSources.uploadsDir || this.defaultUploadsDir;
    const logosSource = customSources.logoDir || this.defaultLogoDir;

    logger.info({ uploadsSource, logosSource }, 'Packaging files and assets into archive bundle');

    const uploadsFiles = this.scanDirectory(uploadsSource);
    const logosFiles = this.scanDirectory(logosSource);

    const bundleEntries = [];
    const fileMap = {};
    let totalSizeBytes = 0;

    // Process uploads
    for (const file of uploadsFiles) {
      const buffer = fs.readFileSync(file.fullPath);
      const hash = integrityService.computeBufferHash(buffer);
      const relKey = `uploads/${file.relativePath}`;

      bundleEntries.push({
        category: 'uploads',
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        sha256: hash,
        dataBase64: buffer.toString('base64')
      });

      fileMap[relKey] = { hash, sizeBytes: file.sizeBytes };
      totalSizeBytes += file.sizeBytes;
    }

    // Process logos
    for (const file of logosFiles) {
      const buffer = fs.readFileSync(file.fullPath);
      const hash = integrityService.computeBufferHash(buffer);
      const relKey = `logos/${file.relativePath}`;

      bundleEntries.push({
        category: 'logos',
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        sha256: hash,
        dataBase64: buffer.toString('base64')
      });

      fileMap[relKey] = { hash, sizeBytes: file.sizeBytes };
      totalSizeBytes += file.sizeBytes;
    }

    const bundlePayload = {
      version: '1.0',
      createdAt: new Date().toISOString(),
      fileCount: bundleEntries.length,
      totalSizeBytes,
      entries: bundleEntries
    };

    fs.mkdirSync(path.dirname(destinationBundlePath), { recursive: true });
    await fs.promises.writeFile(destinationBundlePath, JSON.stringify(bundlePayload), 'utf8');

    const bundleHash = await integrityService.computeFileHash(destinationBundlePath);

    return {
      bundlePath: destinationBundlePath,
      fileCount: bundleEntries.length,
      uploadsCount: uploadsFiles.length,
      logosCount: logosFiles.length,
      totalSizeBytes,
      fileMap,
      sha256: bundleHash
    };
  }

  /**
   * Unpack a files bundle into target directories.
   * @param {string} sourceBundlePath 
   * @param {object} [customTargets]
   * @returns {Promise<{restoredUploadsCount: number, restoredLogosCount: number, totalRestored: number}>}
   */
  async unpackFilesBundle(sourceBundlePath, customTargets = {}) {
    const uploadsTarget = customTargets.uploadsDir || this.defaultUploadsDir;
    const logosTarget = customTargets.logoDir || this.defaultLogoDir;

    if (!fs.existsSync(sourceBundlePath)) {
      return { restoredUploadsCount: 0, restoredLogosCount: 0, totalRestored: 0 };
    }

    const raw = await fs.promises.readFile(sourceBundlePath, 'utf8');
    const bundle = JSON.parse(raw);

    let restoredUploadsCount = 0;
    let restoredLogosCount = 0;

    for (const entry of bundle.entries || []) {
      const targetBase = entry.category === 'uploads' ? uploadsTarget : logosTarget;
      const targetFilePath = path.join(targetBase, entry.relativePath);

      fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
      const buffer = Buffer.from(entry.dataBase64, 'base64');
      fs.writeFileSync(targetFilePath, buffer);

      if (entry.category === 'uploads') restoredUploadsCount++;
      else restoredLogosCount++;
    }

    logger.info({ restoredUploadsCount, restoredLogosCount }, 'Unpacked assets from backup bundle');

    return {
      restoredUploadsCount,
      restoredLogosCount,
      totalRestored: restoredUploadsCount + restoredLogosCount
    };
  }

  /**
   * Backward-compatible backupFiles delegating to packageFilesBundle
   */
  async backupFiles(destinationStageDir, customSources = {}) {
    const bundlePath = path.join(destinationStageDir, 'files-bundle.json');
    const result = await this.packageFilesBundle(bundlePath, customSources);
    return {
      bundlePath,
      uploads: { fileCount: result.uploadsCount, totalSizeBytes: result.totalSizeBytes, fileMap: result.fileMap },
      logos: { fileCount: result.logosCount, totalSizeBytes: result.totalSizeBytes, fileMap: result.fileMap }
    };
  }
}

module.exports = new FileBackupService();
