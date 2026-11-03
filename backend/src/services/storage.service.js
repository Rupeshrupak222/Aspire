// Cloudflare R2 / S3 Object Storage Service Abstraction.
// Supports Cloudflare R2 in production and a zero-dependency local/mock provider for tests/development.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { ValidationError, AuthorizationError, AppError } = require('../errors/app-error');

const MAX_UPLOAD_SIZE_BYTES = parseInt(process.env.STORAGE_MAX_UPLOAD_SIZE_BYTES || '2097152', 10); // 2 MB default

const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]);

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Validates image buffer using magic bytes to prevent file extension spoofing.
 */
function detectMimeTypeFromMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: RIFF .... WEBP
  const riff = buffer.toString('ascii', 0, 4);
  const webp = buffer.toString('ascii', 8, 12);
  if (riff === 'RIFF' && webp === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

function getExtensionForMimeType(mime) {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    case 'image/webp': return '.webp';
    default: return '.png';
  }
}

class StorageService {
  constructor() {
    this.r2Configured = Boolean(
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME
    );

    this.s3Client = null;
    this.localUploadsDir = path.resolve(process.env.STORAGE_LOCAL_DIR || './data/uploads');

    if (this.r2Configured) {
      this._initS3Client();
    } else {
      // Ensure local upload directory exists for mock/dev
      try {
        fs.mkdirSync(this.localUploadsDir, { recursive: true });
      } catch {}
    }

    // In-memory registry for rapid test inspection and fallback
    this.mockRegistry = new Map();
  }

  _initS3Client() {
    try {
      const { S3Client } = require('@aws-sdk/client-s3');
      const accountId = process.env.R2_ACCOUNT_ID;
      const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);

      this.s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
      });
    } catch (err) {
      console.warn('[storage] Failed to initialize S3 client:', err.message);
      this.r2Configured = false;
    }
  }

  isR2Configured() {
    return this.r2Configured && Boolean(this.s3Client);
  }

  /**
   * Validate image buffer size, extension, and magic bytes.
   */
  validateImage({ buffer, originalFilename, claimedMimeType }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new ValidationError('A valid file buffer is required for upload');
    }

    if (buffer.length === 0) {
      throw new ValidationError('Uploaded file is empty');
    }

    if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
      const mbLimit = (MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)).toFixed(1);
      throw new ValidationError(`File size exceeds maximum allowed limit of ${mbLimit} MB`, 'FILE_TOO_LARGE');
    }

    if (originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new ValidationError(`Unsupported file extension "${ext}". Allowed: .png, .jpg, .jpeg, .webp`, 'INVALID_FILE_TYPE');
      }
    }

    const detectedMime = detectMimeTypeFromMagicBytes(buffer);
    if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
      throw new ValidationError('Invalid image content. File signature does not match allowed image formats (PNG, JPEG, WebP)', 'INVALID_IMAGE_SIGNATURE');
    }

    return {
      valid: true,
      mimeType: detectedMime,
      sizeBytes: buffer.length
    };
  }

  /**
   * Generates a secure, unpredictable, tenant-isolated storage key.
   */
  generateKey(organizationId, assetType, extension) {
    if (!organizationId) {
      throw new ValidationError('Organization ID is required for storage key generation');
    }
    const cleanType = String(assetType).replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'general';
    const randomId = crypto.randomBytes(16).toString('hex');
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    return `organizations/${organizationId}/branding/${cleanType}/${randomId}${ext}`;
  }

  /**
   * Upload an asset to storage (R2 or Local Provider).
   */
  async uploadAsset({ organizationId, assetType = 'logo', buffer, originalFilename, claimedMimeType }) {
    if (!organizationId) {
      throw new ValidationError('organizationId is required for asset upload');
    }

    const validation = this.validateImage({ buffer, originalFilename, claimedMimeType });
    const extension = getExtensionForMimeType(validation.mimeType);
    const key = this.generateKey(organizationId, assetType, extension);

    if (this.isR2Configured()) {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: validation.mimeType,
        Metadata: {
          organizationId: String(organizationId),
          assetType
        }
      });

      await this.s3Client.send(command);

      const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      const url = publicBase ? `${publicBase}/${key}` : `/${key}`;

      return {
        key,
        url,
        mimeType: validation.mimeType,
        sizeBytes: validation.sizeBytes,
        provider: 'r2'
      };
    } else {
      // Local/Mock Provider for development and tests
      const fullPath = path.join(this.localUploadsDir, key);
      try {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, buffer);
      } catch {}

      this.mockRegistry.set(key, {
        buffer,
        mimeType: validation.mimeType,
        sizeBytes: validation.sizeBytes,
        organizationId: Number(organizationId),
        updatedAt: new Date().toISOString()
      });

      const url = `/api/storage/assets/${key}`;

      return {
        key,
        url,
        mimeType: validation.mimeType,
        sizeBytes: validation.sizeBytes,
        provider: 'local'
      };
    }
  }

  /**
   * Delete an asset with strict tenant boundary enforcement.
   */
  async deleteAsset({ organizationId, key }) {
    if (!key || typeof key !== 'string') return false;

    // Cross-tenant boundary check: an org can only delete assets inside its namespace
    const expectedPrefix = `organizations/${organizationId}/`;
    if (!key.startsWith(expectedPrefix)) {
      throw new AuthorizationError('Cross-tenant asset deletion denied: target key does not belong to your organization');
    }

    if (this.isR2Configured()) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const command = new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key
      });
      await this.s3Client.send(command);
    } else {
      const fullPath = path.join(this.localUploadsDir, key);
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {}
      this.mockRegistry.delete(key);
    }

    return true;
  }

  /**
   * Retrieve asset buffer from local storage or memory.
   */
  async getAssetBuffer(key) {
    if (this.mockRegistry.has(key)) {
      return this.mockRegistry.get(key);
    }
    const fullPath = path.join(this.localUploadsDir, key);
    if (fs.existsSync(fullPath)) {
      const buffer = fs.readFileSync(fullPath);
      const mimeType = detectMimeTypeFromMagicBytes(buffer) || 'application/octet-stream';
      return { buffer, mimeType, sizeBytes: buffer.length };
    }
    return null;
  }
}

const storageService = new StorageService();

module.exports = {
  storageService,
  StorageService,
  detectMimeTypeFromMagicBytes,
  MAX_UPLOAD_SIZE_BYTES
};

