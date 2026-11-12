// ============================================================================
// DAY 24 TEST 2: CRYPTOGRAPHIC SIGNING & INTEGRITY VERIFICATION
// ============================================================================

const assert = require('assert');
const certCrypto = require('../backend/src/utils/certificate-crypto');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE CRYPTOGRAPHIC INTEGRITY SUITE');
console.log('====================================================');

const sampleCert = {
  certificateId: 'ASP26-A1B2C3D4E5F6',
  organizationId: 42,
  studentId: 101,
  studentName: 'Eleanor Vance',
  examId: 88,
  examTitle: 'Advanced Distributed Systems Fellowship',
  finalScore: 94.50,
  maximumScore: 100.00,
  scorePercentage: 94.50,
  scholarshipPercentage: 100,
  issuedAt: '2026-11-12T10:00:00.000Z',
  certificateVersion: 'v1'
};

// --- 1. Canonical Payload Determinism ---
console.log('\n--- 1. Canonical Payload Determinism ---');
const payload1 = certCrypto.createCertificatePayload(sampleCert);
const json1 = certCrypto.canonicalizePayload(payload1);

// Construct same payload with keys in reversed order
const reversedData = {
  certificateVersion: 'v1',
  issuedAt: '2026-11-12T10:00:00.000Z',
  scholarshipPercentage: 100,
  scorePercentage: 94.50,
  maximumScore: 100.00,
  finalScore: 94.50,
  examTitle: 'Advanced Distributed Systems Fellowship',
  examId: 88,
  studentName: 'Eleanor Vance',
  studentId: 101,
  organizationId: 42,
  certificateId: 'ASP26-A1B2C3D4E5F6'
};
const payload2 = certCrypto.createCertificatePayload(reversedData);
const json2 = certCrypto.canonicalizePayload(payload2);

assert.strictEqual(json1, json2, 'Canonical serialization must be identical regardless of property insertion order');
console.log('  PASS  Deterministic sorted JSON canonicalization verified');

// --- 2. HMAC-SHA256 Signing & Verification ---
console.log('\n--- 2. HMAC-SHA256 Signing & Verification ---');
const testKey = 'test_secret_key_for_hmac_sha256_aspire_2026';
const { signature, signingKeyId } = certCrypto.signCertificatePayload(payload1, testKey);

assert(typeof signature === 'string', 'Signature must be a string');
assert.strictEqual(signature.length, 64, 'HMAC-SHA256 signature must be 64 hex characters');
assert.strictEqual(signingKeyId, certCrypto.DEFAULT_KEY_ID, 'Default key ID returned');

const isValid = certCrypto.verifyCertificateSignature(payload1, signature, testKey);
assert.strictEqual(isValid, true, 'Valid payload and signature must return true');
console.log('  PASS  HMAC-SHA256 generation and verification matches');

// --- 3. Tamper Detection Across Immutable Fields ---
console.log('\n--- 3. Tamper Detection Across Immutable Fields ---');

// A. Tampered Student Name
const tamperedName = { ...payload1, studentName: 'Eleanor Vance (Fraudulent)' };
assert.strictEqual(certCrypto.verifyCertificateSignature(tamperedName, signature, testKey), false);
console.log('  PASS  Tampered studentName rejected');

// B. Tampered Score
const tamperedScore = { ...payload1, finalScore: 99.00 };
assert.strictEqual(certCrypto.verifyCertificateSignature(tamperedScore, signature, testKey), false);
console.log('  PASS  Tampered finalScore rejected');

// C. Tampered Scholarship Percentage
const tamperedScholarship = { ...payload1, scholarshipPercentage: 1000 };
assert.strictEqual(certCrypto.verifyCertificateSignature(tamperedScholarship, signature, testKey), false);
console.log('  PASS  Tampered scholarshipPercentage rejected');

// D. Tampered Issue Date
const tamperedDate = { ...payload1, issuedAt: '2026-11-01T00:00:00.000Z' };
assert.strictEqual(certCrypto.verifyCertificateSignature(tamperedDate, signature, testKey), false);
console.log('  PASS  Tampered issuedAt rejected');

// E. Wrong Key Rejection
assert.strictEqual(certCrypto.verifyCertificateSignature(payload1, signature, 'wrong_key_12345'), false);
console.log('  PASS  Wrong signing key rejected');

// --- 4. Constant-Time Comparison Timing Safety ---
console.log('\n--- 4. Constant-Time Comparison Timing Safety ---');
assert.strictEqual(certCrypto.constantTimeSignatureCompare(signature, signature), true);
assert.strictEqual(certCrypto.constantTimeSignatureCompare(signature, signature.slice(0, 63) + '0'), false);
assert.strictEqual(certCrypto.constantTimeSignatureCompare(signature, 'short_sig'), false);
assert.strictEqual(certCrypto.constantTimeSignatureCompare('', ''), false);
console.log('  PASS  constantTimeSignatureCompare operates correctly with timingSafeEqual');

// --- 5. Payload Hash Consistency ---
console.log('\n--- 5. Payload Hash Consistency ---');
const hash1 = certCrypto.createPayloadHash(payload1);
const hash2 = certCrypto.createPayloadHash(payload2);
assert.strictEqual(hash1, hash2, 'SHA-256 payload hash must match for identical canonical payloads');
assert.strictEqual(hash1.length, 64, 'SHA-256 hash must be 64 characters');
console.log('  PASS  Payload hash computation is deterministic and stable');

