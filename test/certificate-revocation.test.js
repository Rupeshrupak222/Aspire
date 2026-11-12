// ============================================================================
// DAY 24 TEST 7: CERTIFICATE REVOCATION & REISSUANCE WORKFLOW
// ============================================================================

const assert = require('assert');
const { db } = require('../backend/src/db');
const certService = require('../backend/src/services/certificate/certificate.service');
const { getCachedCertificate } = require('../backend/src/services/certificate');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE REVOCATION & REISSUANCE SUITE');
console.log('====================================================');

(async () => {
  // 1. Issue fresh certificate
  const { certificate: cert } = certService.issueCertificate({
    attemptId: 77771,
    organizationId: 1,
    studentId: 5551,
    studentName: 'Hypatia of Alexandria',
    examId: 201,
    examTitle: 'Mathematical Philosophy',
    score: 88,
    totalMarks: 100,
    percentage: 88.0,
    scholarshipPct: 75
  });

  // --- 1. Mandatory Reason Enforcement ---
  console.log('\n--- 1. Mandatory Reason Enforcement ---');
  let errEmpty = false;
  try {
    certService.revokeCertificate({
      certificateId: cert.certificate_id,
      organizationId: 1,
      reason: ''
    });
  } catch (err) {
    errEmpty = true;
  }
  assert.strictEqual(errEmpty, true, 'Empty revocation reason must throw ValidationError');
  console.log('  PASS  Empty revocation reason rejected');

  // --- 2. Authorized Revocation ---
  console.log('\n--- 2. Authorized Revocation ---');
  const revocationReason = 'Candidate name typographical correction required';
  const revokedCert = certService.revokeCertificate({
    certificateId: cert.certificate_id,
    organizationId: 1,
    reason: revocationReason,
    revokedByUserId: 42
  });

  assert.strictEqual(revokedCert.verification_status, 'REVOKED', 'Status changed to REVOKED');
  assert.strictEqual(revokedCert.revoked_by, 42, 'Revoked by user ID recorded');
  assert.strictEqual(revokedCert.revocation_reason, revocationReason, 'Revocation reason recorded');
  assert(revokedCert.revoked_at !== null, 'Revocation timestamp recorded');

  // Verify record is preserved, never deleted
  const dbCert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(cert.certificate_id);
  assert(dbCert !== null, 'Original record must be preserved in database');
  assert.strictEqual(dbCert.verification_status, 'REVOKED');
  console.log('  PASS  Certificate revoked with full audit attribution and record preservation');

  // --- 3. Cache Invalidation ---
  console.log('\n--- 3. Cache Invalidation ---');
  const cachedPdf = getCachedCertificate(1, cert.certificate_id);
  assert.strictEqual(cachedPdf, null, 'Cache entry must be invalidated upon revocation');
  console.log('  PASS  PDF cache cleared for revoked certificate');

  // --- 4. Reissuance Workflow ---
  console.log('\n--- 4. Reissuance Workflow ---');
  const reissuedCert = certService.reissueCertificate({
    oldCertificateId: cert.certificate_id,
    organizationId: 1,
    reason: 'Corrected student name spelling',
    modifiedData: {
      studentName: 'Hypatia Alexandria (Corrected)'
    },
    actorId: 42
  });

  assert(reissuedCert !== null, 'Reissued certificate created');
  assert.notStrictEqual(reissuedCert.certificate_id, cert.certificate_id, 'New certificate has fresh ID');
  assert.strictEqual(reissuedCert.student_name, 'Hypatia Alexandria (Corrected)', 'New name applied');
  assert.strictEqual(reissuedCert.verification_status, 'VALID', 'Reissued certificate is VALID');
  assert.strictEqual(reissuedCert.reissued_from_certificate_id, cert.certificate_id, 'Links back to original');

  // Verify old certificate links forward to replacement
  const updatedOldCert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(cert.certificate_id);
  assert.strictEqual(updatedOldCert.reissued_as_certificate_id, reissuedCert.certificate_id, 'Old cert links to replacement');
  console.log('  PASS  Reissuance bidirectional linkage verified');

  // Clean up
  db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id IN (?, ?)').run(
    cert.certificate_id, reissuedCert.certificate_id
  );
  db.prepare('DELETE FROM certificates WHERE certificate_id IN (?, ?)').run(
    cert.certificate_id, reissuedCert.certificate_id
  );
  console.log('  PASS  Test fixtures cleaned up');
})();

