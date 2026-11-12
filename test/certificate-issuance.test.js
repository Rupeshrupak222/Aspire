// ============================================================================
// DAY 24 TEST 3: CERTIFICATE ISSUANCE PIPELINE & IDEMPOTENCY
// ============================================================================

const assert = require('assert');
const { db } = require('../backend/src/db');
const certService = require('../backend/src/services/certificate/certificate.service');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE ISSUANCE & IDEMPOTENCY SUITE');
console.log('====================================================');

// Setup valid attempt and student in database
const randomPhone = '9' + Math.floor(100000000 + Math.random() * 900000000);
const randomEmail = `marcus_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;

const studentRes = db.prepare(`
  INSERT INTO students (organization_id, name, email, phone) 
  VALUES (1, 'Marcus Aurelius', ?, ?)
`).run(randomEmail, randomPhone);
const studentId = studentRes.lastInsertRowid;

const attemptToken = 'att_tok_' + Math.random().toString(36).substring(2);
const attemptRes = db.prepare(`
  INSERT INTO attempts (organization_id, student_id, token, expires_at, status, question_ids_json, shuffle_map_json)
  VALUES (1, ?, ?, datetime('now', '+2 hours'), 'submitted', '[]', '{}')
`).run(studentId, attemptToken);
const attemptId = attemptRes.lastInsertRowid;

// --- 1. Successful Certificate Issuance ---
console.log('\n--- 1. Successful Certificate Issuance ---');

const studentName = 'Marcus Aurelius';
const examTitle = 'Stoic Philosophy & Systems Architecture';

const { certificate: cert1, isDuplicate: dup1 } = certService.issueCertificate({
  attemptId,
  organizationId: 1,
  studentId,
  studentName,
  examId: null,
  examTitle,
  score: 95,
  totalMarks: 100,
  percentage: 95.0,
  scholarshipPct: 100
});

assert(cert1 !== null, 'Certificate must be issued');
assert.strictEqual(dup1, false, 'First issuance is not a duplicate');
assert(cert1.certificate_id.startsWith('ASP26-'), 'Certificate ID has ASP26 prefix');
assert.strictEqual(cert1.student_name, studentName, 'Student name matches');
assert.strictEqual(cert1.exam_title, examTitle, 'Exam title matches');
assert.strictEqual(cert1.score, 95, 'Score matches');
assert.strictEqual(cert1.verification_status, 'VALID', 'Status is VALID');
assert(cert1.payload_json.length > 0, 'Canonical payload JSON stored');
assert.strictEqual(cert1.payload_hash.length, 64, 'SHA-256 payload hash stored');
assert.strictEqual(cert1.signature.length, 64, 'HMAC-SHA256 signature stored');
assert(cert1.verification_url.includes(cert1.certificate_id), 'Verification URL includes Certificate ID');
console.log('  PASS  Certificate record persisted with cryptographic proof');

// --- 2. Audit Event Logging ---
console.log('\n--- 2. Audit Event Logging ---');
const auditEvent = db.prepare(`
  SELECT * FROM certificate_verification_events 
  WHERE certificate_id = ? AND event_type = 'CERTIFICATE_ISSUED'
`).get(cert1.certificate_id);

assert(auditEvent !== null, 'CERTIFICATE_ISSUED event must be recorded');
assert.strictEqual(auditEvent.verification_result, 'VALID', 'Audit result is VALID');
console.log('  PASS  Issuance audit event verified in database');

// --- 3. Idempotent Retry Safety ---
console.log('\n--- 3. Idempotent Retry Safety ---');
const { certificate: cert2, isDuplicate: dup2 } = certService.issueCertificate({
  attemptId, // Same attemptId
  organizationId: 1,
  studentId,
  studentName: 'Different Name Attempt', // Attempting to alter data on retry
  examId: null,
  examTitle,
  score: 95,
  totalMarks: 100,
  percentage: 95.0,
  scholarshipPct: 100
});

assert.strictEqual(dup2, true, 'Second call flagged as duplicate');
assert.strictEqual(cert2.certificate_id, cert1.certificate_id, 'Certificate ID must remain identical');
assert.strictEqual(cert2.student_name, studentName, 'Original student name preserved against tampering');

const totalRows = db.prepare('SELECT COUNT(*) as count FROM certificates WHERE attempt_id = ?').get(attemptId).count;
assert.strictEqual(totalRows, 1, 'Exactly one certificate record exists for the attempt');
console.log('  PASS  Idempotency prevents duplicate issuance and preserves immutable snapshot');

// Clean up test rows
db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id = ?').run(cert1.certificate_id);
db.prepare('DELETE FROM certificates WHERE certificate_id = ?').run(cert1.certificate_id);
db.prepare('DELETE FROM attempts WHERE id = ?').run(attemptId);
db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
console.log('  PASS  Test fixtures cleaned up');
