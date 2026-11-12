// ============================================================================
// ASPIRE DAY 24: CERTIFICATE CRYPTOGRAPHIC INTEGRITY UTILITIES
// HMAC-SHA256 Signing, Canonicalization, Constant-Time Comparison, Key Rotation
// ============================================================================

const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_KEY_ID = 'k2026_1';
const TEST_DEFAULT_SECRET = 'aspire_cert_signing_secret_dev_test_2026_x89a0f44bc19';

// In-memory registry for historical/dynamic keys (supports rotation & hermetic tests)
const historicalKeysRegistry = new Map();

/**
 * Validates whether an identifier conforms to the Aspire certificate format.
 * Format: ASP<YY>-<8 to 16 uppercase hex or alphanumeric chars>
 * e.g. ASP26-A1B2C3D4 or ASP26-7F3A9C128D4E
 */
function isValidCertificateId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^ASP[0-9]{2}-[A-F0-9]{8,16}$/.test(id.trim().toUpperCase());
}

/**
 * Generates an unpredictable certificate identifier with cryptographically secure randomness.
 * Provides >= 48 bits of entropy (6 random bytes = 12 hex characters = 2^48 combinations).
 * 
 * @param {string} prefix - Optional program/year prefix (default 'ASP26')
 * @returns {string} Unique Certificate ID
 */
function generateCertificateId(prefix = 'ASP26') {
  const cleanPrefix = (prefix || 'ASP26').trim().toUpperCase();
  // 6 bytes = 12 hex chars: balance between print readability and collision resistance
  const randomHex = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${cleanPrefix}-${randomHex}`;
}

/**
 * Retrieves the signing key for a given keyId.
 * Supports current active key and historical keys for key rotation.
 */
function getSigningKey(keyId = null) {
  const currentKeyId = process.env.CERTIFICATE_SIGNING_KEY_ID || DEFAULT_KEY_ID;
  const targetKeyId = keyId || currentKeyId;

  // 1. Check in-memory historical registry first
  if (historicalKeysRegistry.has(targetKeyId)) {
    return historicalKeysRegistry.get(targetKeyId);
  }

  // 2. If target matches active key ID
  if (targetKeyId === currentKeyId) {
    const envSecret = process.env.CERTIFICATE_SIGNING_SECRET;
    if (envSecret && envSecret.trim().length > 0) {
      return envSecret.trim();
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CERTIFICATE_SIGNING_SECRET must be configured in production');
    }
    return TEST_DEFAULT_SECRET;
  }

  // 3. Check JSON-configured historical keys
  if (process.env.CERTIFICATE_HISTORICAL_KEYS_JSON) {
    try {
      const parsed = JSON.parse(process.env.CERTIFICATE_HISTORICAL_KEYS_JSON);
      if (parsed[targetKeyId]) {
        return parsed[targetKeyId];
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed parsing CERTIFICATE_HISTORICAL_KEYS_JSON');
    }
  }

  return null;
}

/**
 * Registers a historical or rotated signing key (used in tests and runtime key configuration).
 */
function registerSigningKey(keyId, secret) {
  if (!keyId || !secret) throw new Error('keyId and secret are required');
  historicalKeysRegistry.set(String(keyId).trim(), String(secret).trim());
}

/**
 * Clears the dynamic signing key registry.
 */
function resetSigningKeys() {
  historicalKeysRegistry.clear();
}

/**
 * Deterministically sorts object keys recursively to ensure strictly identical JSON serialization.
 */
function canonicalizeObject(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalizeObject);
  }
  const sorted = {};
  const keys = Object.keys(val).sort();
  for (const k of keys) {
    sorted[k] = val[k] === undefined ? null : canonicalizeObject(val[k]);
  }
  return sorted;
}

/**
 * Produces deterministic JSON string with sorted keys.
 */
function canonicalizePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be an object');
  }
  const clean = canonicalizeObject(payload);
  return JSON.stringify(clean);
}

/**
 * Creates canonical, immutable certificate payload representing authoritative issuance snapshot.
 */
function createCertificatePayload({
  certificateId,
  organizationId = null,
  studentId = null,
  studentName,
  examId = null,
  examTitle,
  finalScore = 0,
  maximumScore = 100,
  scorePercentage = 0,
  scholarshipPercentage = 0,
  issuedAt = null,
  certificateVersion = 'v1'
}) {
  if (!certificateId) throw new Error('certificateId is required');
  if (!studentName) throw new Error('studentName is required');
  if (!examTitle) throw new Error('examTitle is required');

  const normalizedDate = issuedAt ? new Date(issuedAt).toISOString() : new Date().toISOString();

  return {
    certificateId: String(certificateId).trim().toUpperCase(),
    organizationId: organizationId !== null && organizationId !== undefined ? Number(organizationId) : null,
    studentId: studentId !== null && studentId !== undefined ? Number(studentId) : null,
    studentName: String(studentName).trim(),
    examId: examId !== null && examId !== undefined ? Number(examId) : null,
    examTitle: String(examTitle).trim(),
    finalScore: Number(Number(finalScore || 0).toFixed(2)),
    maximumScore: Number(Number(maximumScore || 100).toFixed(2)),
    scorePercentage: Number(Number(scorePercentage || 0).toFixed(2)),
    scholarshipPercentage: Number(Number(scholarshipPercentage || 0).toFixed(2)),
    issuedAt: normalizedDate,
    certificateVersion: String(certificateVersion || 'v1').trim()
  };
}

/**
 * Generates SHA-256 digest of the canonicalized certificate payload.
 */
function createPayloadHash(payload) {
  const jsonStr = typeof payload === 'string' ? payload : canonicalizePayload(payload);
  return crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

/**
 * Signs the canonical certificate payload with HMAC-SHA256.
 * Returns the hex signature string and the active keyId used.
 */
function signCertificatePayload(payload, key = null, keyId = null) {
  const effectiveKeyId = keyId || process.env.CERTIFICATE_SIGNING_KEY_ID || DEFAULT_KEY_ID;
  const secret = key || getSigningKey(effectiveKeyId);

  if (!secret) {
    throw new Error(`Signing secret not found for keyId: ${effectiveKeyId}`);
  }

  const jsonStr = typeof payload === 'string' ? payload : canonicalizePayload(payload);
  const signature = crypto.createHmac('sha256', secret).update(jsonStr, 'utf8').digest('hex');

  return {
    signature,
    signingKeyId: effectiveKeyId
  };
}

/**
 * Performs constant-time comparison of two hex signatures to protect against timing attacks.
 */
function constantTimeSignatureCompare(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') {
    return false;
  }

  const bufExpected = Buffer.from(expected.trim().toLowerCase(), 'hex');
  const bufSupplied = Buffer.from(supplied.trim().toLowerCase(), 'hex');

  if (bufExpected.length === 0 || bufSupplied.length === 0) {
    return false;
  }

  // Length mismatch: compare against dummy buffer of equal length to maintain constant time
  if (bufExpected.length !== bufSupplied.length) {
    crypto.timingSafeEqual(bufExpected, bufExpected);
    return false;
  }

  return crypto.timingSafeEqual(bufExpected, bufSupplied);
}

/**
 * Verifies that a certificate payload matches its HMAC-SHA256 signature using the specified key.
 */
function verifyCertificateSignature(payload, signature, key) {
  if (!signature || !key) return false;
  try {
    const jsonStr = typeof payload === 'string' ? payload : canonicalizePayload(payload);
    const expectedSignature = crypto.createHmac('sha256', key).update(jsonStr, 'utf8').digest('hex');
    return constantTimeSignatureCompare(expectedSignature, signature);
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed verifying certificate signature');
    return false;
  }
}

module.exports = {
  DEFAULT_KEY_ID,
  isValidCertificateId,
  generateCertificateId,
  getSigningKey,
  registerSigningKey,
  resetSigningKeys,
  canonicalizePayload,
  createCertificatePayload,
  createPayloadHash,
  signCertificatePayload,
  constantTimeSignatureCompare,
  verifyCertificateSignature
};

