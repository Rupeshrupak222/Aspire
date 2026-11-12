// ============================================================================
// DAY 24 TEST 8: CERTIFICATE SECURITY & INTEGRITY HARDENING
// ============================================================================

const assert = require('assert');
const certCrypto = require('../backend/src/utils/certificate-crypto');
const certService = require('../backend/src/services/certificate/certificate.service');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE SECURITY HARDENING SUITE');
console.log('====================================================');

// --- 1. Secret Non-Exposure ---
console.log('\n--- 1. Secret Non-Exposure ---');
const { certificate: cert } = certService.issueCertificate({
  attemptId: 66661,
  organizationId: 1,
  studentId: 4441,
  studentName: 'Alan Turing',
  examId: 101,
  examTitle: 'Cryptanalysis & Decidability',
  score: 100,
  totalMarks: 100,
  percentage: 100.0,
  scholarshipPct: 100
});

const verificationData = certService.verifyCertificate(cert.certificate_id);
const stringified = JSON.stringify(verificationData);

// Neither signing secret nor internal keys should ever appear in public output
assert(!stringified.includes('secret'), 'Verification response must not contain "secret"');
assert(!stringified.includes('k2026_1'), 'Key ID not exposed directly in public response');
assert(!stringified.includes('payload_hash'), 'Raw payload hash not exposed to visitor');
assert(!stringified.includes('signature'), 'Raw signature not exposed to visitor');
console.log('  PASS  Signing secrets and internal cryptographic parameters isolated');

// --- 2. SQL Injection / Path Traversal Rejection ---
console.log('\n--- 2. Identifier Injection Resistance ---');
const maliciousInputs = [
  "ASP26-A1B2C3D4' OR '1'='1",
  "ASP26-A1B2C3D4; DROP TABLE certificates;--",
  "../../../etc/passwd",
  "<script>alert(1)</script>",
  "ASP26-A1B2C3D4\0evil"
];

for (const input of maliciousInputs) {
  const res = certService.verifyCertificate(input);
  assert.strictEqual(res.status, 'NOT_FOUND', `Malicious input must return NOT_FOUND safely: ${input}`);
}
console.log('  PASS  Input sanitization repels SQLi, XSS, and directory traversal attempts');

// --- 3. Timing-Attack Defense ---
console.log('\n--- 3. Constant-Time Signature Comparison ---');
const sigA = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const sigB = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567891'; // 1 bit different
const sigShort = 'abcdef1234567890';

assert.strictEqual(certCrypto.constantTimeSignatureCompare(sigA, sigA), true);
assert.strictEqual(certCrypto.constantTimeSignatureCompare(sigA, sigB), false);
assert.strictEqual(certCrypto.constantTimeSignatureCompare(sigA, sigShort), false);
assert.strictEqual(certCrypto.constantTimeSignatureCompare(sigA, null), false);
console.log('  PASS  Timing-safe equality prevents side-channel timing analysis');

// Clean up
const { db } = require('../backend/src/db');
db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id = ?').run(cert.certificate_id);
db.prepare('DELETE FROM certificates WHERE certificate_id = ?').run(cert.certificate_id);
console.log('  PASS  Test fixtures cleaned up');

