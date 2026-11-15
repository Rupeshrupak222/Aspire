const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class BackupIntegrityService {
  /**
   * Compute SHA-256 hash for a buffer or string.
   * @param {Buffer|string} data 
   * @returns {string} 64-char hex digest
   */
  computeBufferHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Compute SHA-256 hash for a file on disk using streaming.
   * @param {string} filePath 
   * @returns {Promise<string>} 64-char hex digest
   */
  async computeFileHash(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found for checksum calculation: ${filePath}`);
    }

    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => reject(new Error(`Failed to compute hash for ${filePath}: ${err.message}`)));
    });
  }

  /**
   * Verify a file's hash against the expected hash.
   * @param {string} filePath 
   * @param {string} expectedHash 
   * @returns {Promise<{valid: boolean, actualHash: string, expectedHash: string}>}
   */
  async verifyFileHash(filePath, expectedHash) {
    const actualHash = await this.computeFileHash(filePath);
    return {
      valid: actualHash.toLowerCase() === expectedHash.toLowerCase(),
      actualHash,
      expectedHash
    };
  }

  /**
   * Compute checksums for all files in a directory recursively.
   * @param {string} dirPath 
   * @param {string} [baseDir] Internal parameter for relative paths
   * @returns {Promise<Record<string, {hash: string, sizeBytes: number}>>}
   */
  async computeDirectoryChecksums(dirPath, baseDir = dirPath) {
    const results = {};
    if (!fs.existsSync(dirPath)) return results;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const subResults = await this.computeDirectoryChecksums(fullPath, baseDir);
        Object.assign(results, subResults);
      } else if (entry.isFile()) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const hash = await this.computeFileHash(fullPath);
        const stat = fs.statSync(fullPath);
        results[relativePath] = {
          hash,
          sizeBytes: stat.size
        };
      }
    }

    return results;
  }

  /**
   * Verify all files in a directory against expected checksums.
   * @param {string} dirPath 
   * @param {Record<string, {hash: string, sizeBytes: number}>} expectedTree 
   * @returns {Promise<{valid: boolean, missing: string[], corrupted: string[], extra: string[]}>}
   */
  async verifyDirectoryChecksums(dirPath, expectedTree) {
    const actualTree = await this.computeDirectoryChecksums(dirPath);
    const missing = [];
    const corrupted = [];
    const extra = [];

    for (const [relPath, exp] of Object.entries(expectedTree)) {
      if (!actualTree[relPath]) {
        missing.push(relPath);
      } else if (actualTree[relPath].hash !== exp.hash) {
        corrupted.push(relPath);
      }
    }

    for (const relPath of Object.keys(actualTree)) {
      if (!expectedTree[relPath]) {
        extra.push(relPath);
      }
    }

    const valid = missing.length === 0 && corrupted.length === 0;
    return { valid, missing, corrupted, extra };
  }
}

module.exports = new BackupIntegrityService();

