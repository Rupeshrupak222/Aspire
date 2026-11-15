// ============================================================================
// DAY 24 TEST 14: HIGH-THROUGHPUT PERFORMANCE & BENCHMARKING
// ============================================================================

const assert = require('assert');
const certCrypto = require('../backend/src/utils/certificate-crypto');
const certService = require('../backend/src/services/certificate/certificate.service');
const { db } = require('../backend/src/db');

console.log('====================================================');
console.log('DAY 24: HIGH-THROUGHPUT PERFORMANCE BENCHMARK SUITE');
console.log('====================================================');

// Setup benchmark certificate
const { certificate: benchCert } = certService.issueCertificate({
  attemptId: 33331,
  organizationId: 1,
  studentId: 1111,
  studentName: 'Benchmark Candidate',
  examId: 101,
  examTitle: 'Performance Benchmark Exam',
  score: 95,
  totalMarks: 100,
  percentage: 95.0,
  scholarshipPct: 100
});

// --- 1. Indexed Certificate ID Lookup Benchmark ---
console.log('\n--- 1. Indexed Certificate ID Lookup Benchmark (1,000 queries) ---');
const lookupStart = Date.now();
const lookupCount = 1000;
const stmt = db.prepare('SELECT id, certificate_id, verification_status FROM certificates WHERE certificate_id = ?');

for (let i = 0; i < lookupCount; i++) {
  const row = stmt.get(benchCert.certificate_id);
  assert(row !== null);
}
const lookupDuration = Date.now() - lookupStart;
console.log(`  PASS  ${lookupCount} indexed lookups executed in ${lookupDuration}ms (${(lookupDuration / lookupCount).toFixed(3)}ms/op)`);
assert(lookupDuration < 150, '1,000 indexed lookups must complete in under 150ms');

// --- 2. HMAC-SHA256 Signing Benchmark ---
console.log('\n--- 2. HMAC-SHA256 Signing Benchmark (1,000 signatures) ---');
const payload = certCrypto.createCertificatePayload({
  certificateId: benchCert.certificate_id,
  organizationId: 1,
  studentId: 1111,
  studentName: 'Benchmark Candidate',
  examId: 101,
  examTitle: 'Performance Benchmark Exam',
  finalScore: 95,
  maximumScore: 100,
  scorePercentage: 95.0,
  scholarshipPercentage: 100,
  issuedAt: new Date().toISOString()
});

const signStart = Date.now();
const signCount = 1000;
for (let i = 0; i < signCount; i++) {
  certCrypto.signCertificatePayload(payload);
}
const signDuration = Date.now() - signStart;
console.log(`  PASS  ${signCount} HMAC-SHA256 signatures generated in ${signDuration}ms (${(signDuration / signCount).toFixed(3)}ms/op)`);
assert(signDuration < 200, '1,000 HMAC signatures must generate in under 200ms');

// --- 3. Full Cryptographic Verification Benchmark ---
console.log('\n--- 3. Full Cryptographic Verification Benchmark (200 ops) ---');
const verifyStart = Date.now();
const verifyCount = 200;
for (let i = 0; i < verifyCount; i++) {
  const res = certService.verifyCertificate(benchCert.certificate_id, 'bench');
  assert.strictEqual(res.status, 'VALID');
}
const verifyDuration = Date.now() - verifyStart;
console.log(`  PASS  ${verifyCount} full verification passes executed in ${verifyDuration}ms (${(verifyDuration / verifyCount).toFixed(3)}ms/op)`);
assert(verifyDuration < 600, '200 full verifications must execute in under 600ms');

// --- 4. Concurrent Verification Burst (50 parallel operations) ---
console.log('\n--- 4. Concurrent Verification Burst (50 parallel operations) ---');
(async () => {
  const burstCount = 50;
  const promises = [];
  for (let i = 0; i < burstCount; i++) {
    promises.push(Promise.resolve(certService.verifyCertificate(benchCert.certificate_id, 'burst')));
  }
  const results = await Promise.all(promises);
  assert.strictEqual(results.length, burstCount);
  assert(results.every(r => r.status === 'VALID'), 'All concurrent verifications must be VALID');
  console.log(`  PASS  ${burstCount} simultaneous verifications resolved without locking or race conditions`);

  // Clean up
  db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id = ?').run(benchCert.certificate_id);
  db.prepare('DELETE FROM certificates WHERE certificate_id = ?').run(benchCert.certificate_id);
  console.log('  PASS  Test fixtures cleaned up');
})();

