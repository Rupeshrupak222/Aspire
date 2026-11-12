// ============================================================================
// DAY 24 TEST 10: SIGNING KEY ROTATION & HISTORICAL VERIFICATION
// ============================================================================

const assert = require('assert');
const certCrypto = require('../backend/src/utils/certificate-crypto');
const certService = require('../backend/src/services/certificate/certificate.service');
const { db } = require('../backend/src/db');

console.log('====================================================');
console.log('DAY 24: SIGNING KEY ROTATION SUITE');
console.log('====================================================');

certCrypto.resetSigningKeys();

// 1. Setup Historical Keys
const HISTORICAL_KEY_ID = 'k2025_1';
const HISTORICAL_SECRET = 'historical_signing_secret_for_2025_aspire_exams';
certCrypto.registerSigningKey(HISTORICAL_KEY_ID, HISTORICAL_SECRET);

// --- 1. Sign & Verify with Historical Key ---
console.log('\n--- 1. Historical Key Verification ---');
const historicalPayload = certCrypto.createCertificatePayload({
  certificateId: 'ASP25-HIST00112233',
  organizationId: 1,
  studentId: 1001,
  studentName: 'Katherine Johnson',
  examId: 99,
  examTitle: 'Orbital Mechanics 2025',
  finalScore: 100,
  maximumScore: 100,
  scorePercentage: 100.0,
  scholarshipPercentage: 100,
  issuedAt: '2025-11-12T10:00:00.000Z'
});

const { signature: histSig, signingKeyId: histKeyId } = certCrypto.signCertificatePayload(
  historicalPayload,
  HISTORICAL_SECRET,
  HISTORICAL_KEY_ID
);

assert.strictEqual(histKeyId, HISTORICAL_KEY_ID, 'Signed with historical key ID');
const histVerified = certCrypto.verifyCertificateSignature(historicalPayload, histSig, HISTORICAL_SECRET);
assert.strictEqual(histVerified, true, 'Historical certificate verifies with historical secret');
console.log('  PASS  Historical signature verifies against registered historical key');

// --- 2. Database Verification with Historical Key ---
console.log('\n--- 2. Database Verification with Historical Key ---');
const histJson = certCrypto.canonicalizePayload(historicalPayload);
const histHash = certCrypto.createPayloadHash(historicalPayload);

db.prepare(`
  INSERT INTO certificates (
    certificate_id, organization_id, student_name, exam_title, score, total_marks,
    percentage, scholarship_pct, verification_status, payload_json, payload_hash,
    signature, signing_key_id, verification_url, issued_at
  ) VALUES (?, 1, 'Katherine Johnson', 'Orbital Mechanics 2025', 100, 100, 100.0, 100, 'VALID', ?, ?, ?, ?, 'https://aspire.adyapan.com/verify/ASP25-HIST00112233', '2025-11-12T10:00:00.000Z')
`).run('ASP25-HIST00112233', histJson, histHash, histSig, HISTORICAL_KEY_ID);

const verifyRes = certService.verifyCertificate('ASP25-HIST00112233');
assert.strictEqual(verifyRes.status, 'VALID', 'Historical certificate in DB must verify as VALID');
assert.strictEqual(verifyRes.studentName, 'Katherine Johnson');
console.log('  PASS  Database verification resolves historical key ID correctly');

// --- 3. Missing Historical Key Safety ---
console.log('\n--- 3. Missing Historical Key Safety ---');
// Unregister historical key to simulate missing secret
certCrypto.resetSigningKeys();

const missingKeyRes = certService.verifyCertificate('ASP25-HIST00112233');
assert.strictEqual(missingKeyRes.status, 'INVALID', 'Missing historical key must yield INVALID, not VALID');
assert(missingKeyRes.message.includes('unavailable') || missingKeyRes.message.includes('signature'), 'Clear reason provided');
console.log('  PASS  Missing historical key fails safely as INVALID rather than falsely validating');

// Clean up
db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id = ?').run('ASP25-HIST00112233');
db.prepare('DELETE FROM certificates WHERE certificate_id = ?').run('ASP25-HIST00112233');
console.log('  PASS  Test fixtures cleaned up');

