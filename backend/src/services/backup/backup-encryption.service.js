const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const MAGIC_BYTES = Buffer.from('ASPIRE_ENC_V1'); // 13 bytes
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits for GCM
const HEADER_LENGTH = MAGIC_BYTES.length + IV_LENGTH + TAG_LENGTH; // 13 + 12 + 16 = 41 bytes

class BackupEncryptionService {
  constructor() {
    this.defaultKeyId = process.env.BACKUP_ENCRYPTION_KEY_ID || 'aspire-default-key-v1';
  }

  /**
   * Resolve a 32-byte encryption key buffer from input or environment.
   * Supports 64-char hex, 44-char base64, or general string derived via sha256.
   * @param {string|Buffer} [customKey] 
   * @returns {Buffer} 32-byte Buffer
   */
  resolveKey(customKey) {
    const rawKey = customKey || process.env.BACKUP_ENCRYPTION_KEY;
    if (!rawKey) {
      // In development / testing, if not explicitly provided, provide a deterministic warning
      if (process.env.NODE_ENV !== 'production') {
        return crypto.createHash('sha256').update('aspire-insecure-dev-backup-key-32b!').digest();
      }
      throw new Error('BACKUP_ENCRYPTION_KEY is required for encrypted backup operations.');
    }

    if (Buffer.isBuffer(rawKey) && rawKey.length === 32) {
      return rawKey;
    }

    if (typeof rawKey === 'string') {
      const trimmed = rawKey.trim();
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
      }
      if (/^[A-Za-z0-9+/=]{44}$/.test(trimmed)) {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length === 32) return buf;
      }
      // Derive 32-byte key via SHA-256
      return crypto.createHash('sha256').update(trimmed).digest();
    }

    throw new Error('Invalid BACKUP_ENCRYPTION_KEY format. Expected 32-byte Buffer or string.');
  }

  /**
   * Encrypt a buffer with AES-256-GCM.
   * Output: [MAGIC_BYTES (13B)][IV (12B)][AUTH_TAG (16B)][CIPHERTEXT]
   * @param {Buffer} plaintext 
   * @param {string|Buffer} [key] 
   * @returns {{encryptedBuffer: Buffer, algorithm: string, keyId: string}}
   */
  encryptBuffer(plaintext, key) {
    const keyBuf = this.resolveKey(key);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv, { authTagLength: TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const output = Buffer.concat([MAGIC_BYTES, iv, tag, ciphertext]);

    return {
      encryptedBuffer: output,
      algorithm: ALGORITHM,
      keyId: this.defaultKeyId
    };
  }

  /**
   * Decrypt an AES-256-GCM buffer.
   * @param {Buffer} encryptedBuffer 
   * @param {string|Buffer} [key] 
   * @returns {Buffer} decrypted plaintext
   */
  decryptBuffer(encryptedBuffer, key) {
    if (encryptedBuffer.length < HEADER_LENGTH) {
      throw new Error('Invalid encrypted backup payload: file size is less than minimum header length.');
    }

    const magic = encryptedBuffer.subarray(0, MAGIC_BYTES.length);
    if (!magic.equals(MAGIC_BYTES)) {
      throw new Error('Unrecognized backup encryption format: missing ASPIRE_ENC_V1 magic header.');
    }

    const keyBuf = this.resolveKey(key);
    const iv = encryptedBuffer.subarray(MAGIC_BYTES.length, MAGIC_BYTES.length + IV_LENGTH);
    const tag = encryptedBuffer.subarray(MAGIC_BYTES.length + IV_LENGTH, HEADER_LENGTH);
    const ciphertext = encryptedBuffer.subarray(HEADER_LENGTH);

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      throw new Error(`Backup decryption failed. Authentication tag verification failed or wrong encryption key: ${err.message}`);
    }
  }

  /**
   * Encrypt a file on disk to a target path.
   * @param {string} sourcePath 
   * @param {string} destinationPath 
   * @param {string|Buffer} [key] 
   * @returns {Promise<{destinationPath: string, sizeBytes: number, algorithm: string, keyId: string}>}
   */
  async encryptFile(sourcePath, destinationPath, key) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found for encryption: ${sourcePath}`);
    }

    const plaintext = await fs.promises.readFile(sourcePath);
    const { encryptedBuffer, algorithm, keyId } = this.encryptBuffer(plaintext, key);

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, encryptedBuffer);

    return {
      destinationPath,
      sizeBytes: encryptedBuffer.length,
      algorithm,
      keyId
    };
  }

  /**
   * Decrypt an encrypted file on disk to a target path.
   * @param {string} sourcePath 
   * @param {string} destinationPath 
   * @param {string|Buffer} [key] 
   * @returns {Promise<{destinationPath: string, sizeBytes: number}>}
   */
  async decryptFile(sourcePath, destinationPath, key) {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found for decryption: ${sourcePath}`);
    }

    const encryptedData = await fs.promises.readFile(sourcePath);
    const decrypted = this.decryptBuffer(encryptedData, key);

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, decrypted);

    return {
      destinationPath,
      sizeBytes: decrypted.length
    };
  }
}

module.exports = new BackupEncryptionService();
