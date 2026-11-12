// ============================================================================
// DAY 24 TEST 6: PUBLIC CERTIFICATE VERIFICATION STATES
// ============================================================================

const assert = require('assert');
const { db } = require('../backend/src/db');
const certService = require('../backend/src/services/certificate/certificate.service');
const certCrypto = require('../backend/src/utils/certificate-crypto');

console.log('====================================================');
console.log('DAY 24: PUBLIC CERTIFICATE VERIFICATION SUITE');
console.log('====================================================');

// 1. Setup Valid Certificate
const { certificate: validCert } = certService.issueCertificate({
  attemptId: 88881,
  organizationId: 1,
  studentId: 6661,
  studentName: 'Nikola Tesla',
  examId: 301,
  examTitle: 'Electromagnetic Systems Engineering',
  score: 99.0,
  totalMarks: 100,
  percentage: 99.0,
  scholarshipPct: 100
});

// --- 1. Verify Authentic Valid Certificate ---
console.log('\n--- 1. Verify Authentic Valid Certificate ---');
const validRes = certService.verifyCertificate(validCert.certificate_id, 'test_suite');
assert.strictEqual(validRes.status, 'VALID', 'Status must be VALID');
assert.strictEqual(validRes.certificateId, validCert.certificate_id, 'Certificate ID matches');
assert.strictEqual(validRes.studentName, 'Nikola Tesla', 'Student name matches');
assert.strictEqual(validRes.examTitle, 'Electromagnetic Systems Engineering', 'Exam title matches');
assert.strictEqual(validRes.finalScore, 99.0, 'Final score matches');
assert.strictEqual(validRes.scholarshipPercentage, 100, 'Scholarship matches');
assert(validRes.verificationUrl.includes(validCert.certificate_id), 'Verification URL present');
assert(validRes.verificationTimestamp !== undefined, 'Timestamp present');

// Verify NO candidate PII leaked
assert.strictEqual(validRes.email, undefined, 'Email must NOT be exposed');
assert.strictEqual(validRes.phone, undefined, 'Phone must NOT be exposed');
assert.strictEqual(validRes.studentId, undefined, 'Student internal ID must NOT be exposed');
console.log('  PASS  Valid certificate verified successfully with zero PII exposure');

// --- 2. Verify Revoked Certificate ---
console.log('\n--- 2. Verify Revoked Certificate ---');
const { certificate: certToRevoke } = certService.issueCertificate({
  attemptId: 88882,
  organizationId: 1,
  studentId: 6662,
  studentName: 'Candidate To Revoke',
  examId: 301,
  examTitle: 'Test Exam',
  score: 80,
  totalMarks: 100,
  percentage: 80.0,
  scholarshipPct: 50
});

certService.revokeCertificate({
  certificateId: certToRevoke.certificate_id,
  organizationId: 1,
  reason: 'Proctoring behavioral infraction detected post-evaluation',
  revokedByUserId: 1
});

const revokedRes = certService.verifyCertificate(certToRevoke.certificate_id, 'test_suite');
assert.strictEqual(revokedRes.status, 'REVOKED', 'Status must be REVOKED');
assert.strictEqual(revokedRes.certificateId, certToRevoke.certificate_id, 'Certificate ID matches');
assert(revokedRes.revokedAt !== null, 'Revocation date present');
assert.strictEqual(revokedRes.revocationReason, 'Proctoring behavioral infraction detected post-evaluation');
assert.strictEqual(revokedRes.studentName, undefined, 'Revoked response does not present student as valid');
console.log('  PASS  Revoked certificate verified and returns explicit revocation notice');

// --- 3. Verify Tampered Payload (Integrity Failure) ---
console.log('\n--- 3. Verify Tampered Payload (Integrity Failure) ---');
const { certificate: tamperedCert } = certService.issueCertificate({
  attemptId: 88883,
  organizationId: 1,
  studentId: 6663,
  studentName: 'Original Name',
  examId: 301,
  examTitle: 'Test Exam',
  score: 50,
  totalMarks: 100,
  percentage: 50.0,
  scholarshipPct: 10
});

// Directly corrupt the stored payload_json in SQLite
db.prepare(`
  UPDATE certificates 
  SET payload_json = json_set(payload_json, '$.studentName', 'Hacked Fraudulent Name')
  WHERE certificate_id = ?
`).run(tamperedCert.certificate_id);

const tamperedRes = certService.verifyCertificate(tamperedCert.certificate_id, 'test_suite');
assert.strictEqual(tamperedRes.status, 'INVALID', 'Tampered record must return INVALID');
assert(tamperedRes.message.includes('altered') || tamperedRes.message.includes('Integrity'), 'Integrity failure message');
console.log('  PASS  Direct database payload tampering detected and flagged INVALID');

// --- 4. Verify Unknown / Non-Existent Certificate ---
console.log('\n--- 4. Verify Unknown / Non-Existent Certificate ---');
const notFoundRes = certService.verifyCertificate('ASP26-UNKNOWN9999', 'test_suite');
assert.strictEqual(notFoundRes.status, 'NOT_FOUND', 'Unknown ID must return NOT_FOUND');
console.log('  PASS  Non-existent certificate ID returns NOT_FOUND');

// Clean up
db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id IN (?, ?, ?)').run(
  validCert.certificate_id, certToRevoke.certificate_id, tamperedCert.certificate_id
);
db.prepare('DELETE FROM certificates WHERE certificate_id IN (?, ?, ?)').run(
  validCert.certificate_id, certToRevoke.certificate_id, tamperedCert.certificate_id
);
console.log('  PASS  Test fixtures cleaned up');

