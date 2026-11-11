// ============================================================================
// ASPIRE DAY 22: USAGE METERING — CERTIFICATES TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-certs-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const { getCurrentUsageSnapshot } = require('../backend/src/services/subscription/metering.service');
const { recordUsageEvent } = require('../backend/src/services/subscription/metering.service');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function run() {
  console.log('====================================================');
  console.log('DAY 22: USAGE METERING — CERTIFICATES TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Alpha Institute of Tech', 'alpha-tech', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status)
      VALUES (101, 10, 'Certification Exam', 'CERT-01', 'PUBLISHED')
    `).run();

    db.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college)
      VALUES (501, 10, 'Candidate Alice', 'alice@test.com', '9876543210', 'Alpha College')
    `).run();

    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json)
      VALUES (1001, 10, 'token_alice_1', 501, 101, 'submitted', datetime('now', '-1 hour'), datetime('now', '+1 hour'), datetime('now'), '[]')
    `).run();

    console.log('--- 1. Initial State ---');
    const snapInit = getCurrentUsageSnapshot(10);
    ok('Initial certificates issued is 0', snapInit.resources.certificates.issued === 0);

    console.log('\n--- 2. Certificate Issuance Event ---');
    // Issue certificate
    const certId = 'CERT-ALPHA-2026-1001';
    db.prepare(`
      UPDATE attempts
      SET certificate_id = ?
      WHERE id = 1001
    `).run(certId);

    const evCert = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'certificates',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: `certificate_issued_1001_${certId}`,
      referenceType: 'certificate',
      referenceId: certId,
      metadata: { attemptId: 1001, examId: 101, studentId: 501 }
    });
    ok('Certificate issuance event recorded', evCert.success);
    ok('Certificate issuance not duplicate', !evCert.isDuplicate);

    const snap1 = getCurrentUsageSnapshot(10);
    ok('Certificates issued is now 1', snap1.resources.certificates.issued === 1);

    console.log('\n--- 3. Subsequent Downloads / Previews Do NOT Increment Usage ---');
    // Candidate downloads PDF certificate or previews multiple times
    const evDownloadRetry = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'certificates',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: `certificate_issued_1001_${certId}`,
      referenceType: 'certificate',
      referenceId: certId
    });
    ok('Re-download / re-issued event is flagged duplicate', evDownloadRetry.isDuplicate === true);

    const snapAfterDownload = getCurrentUsageSnapshot(10);
    ok('Certificates count remains 1 after download', snapAfterDownload.resources.certificates.issued === 1);

    console.log('\n--- 4. Daily Aggregate for Certificates ---');
    const dailyCert = db.prepare(`
      SELECT * FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'certificates'
    `).get();
    ok('Daily aggregate record exists for certificates', !!dailyCert);
    ok('Daily aggregate net_usage is 1', dailyCert.net_usage === 1);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`CERTIFICATES METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
