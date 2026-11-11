// ============================================================================
// ASPIRE DAY 22: USAGE METERING — CANDIDATES TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-candidates-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const { getCurrentUsageSnapshot, getUsageHistory } = require('../backend/src/services/subscription/metering.service');
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
  console.log('DAY 22: USAGE METERING — CANDIDATES TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Alpha College of Tech', 'alpha-tech', 'ACTIVE'),
             (20, 'Beta Engineering Institute', 'beta-eng', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });
    assignSubscription({ organizationId: 20, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    console.log('--- 1. Initial State ---');
    const snap1 = getCurrentUsageSnapshot(10);
    ok('Initial candidates usage is 0', snap1.resources.candidates.used === 0);

    console.log('\n--- 2. First Candidate Registration ---');
    // Register candidate 1 for Org 10
    db.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college)
      VALUES (101, 10, 'Student One', 's1@alpha.test', '9876543210', 'Alpha Institute')
    `).run();

    const ev1 = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'candidate_registered_101',
      referenceType: 'student',
      referenceId: '101',
      metadata: { email: 's1@alpha.test', college: 'Alpha Institute' }
    });
    ok('Candidate usage event recorded', ev1.success);
    ok('Candidate event not flagged as duplicate', !ev1.isDuplicate);

    const snap2 = getCurrentUsageSnapshot(10);
    ok('Candidates used count is now 1', snap2.resources.candidates.used === 1);

    console.log('\n--- 3. Duplicate Registration Idempotency Protection ---');
    // Simulating identical registration event replay or retried submission
    const evDup = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'candidate_registered_101',
      referenceType: 'student',
      referenceId: '101',
      metadata: { email: 's1@alpha.test', college: 'Alpha Institute' }
    });
    ok('Duplicate registration returns successfully', evDup.success);
    ok('Duplicate registration flagged isDuplicate', evDup.isDuplicate === true);

    const snapDup = getCurrentUsageSnapshot(10);
    ok('Candidates used remains 1 after duplicate registration', snapDup.resources.candidates.used === 1);

    console.log('\n--- 4. Profile Update Does Not Increment Usage ---');
    // Updating student profile details (name, college)
    db.prepare(`
      UPDATE students SET name = 'Student One Updated', college = 'Alpha Tech University'
      WHERE id = 101
    `).run();

    const snapAfterUpdate = getCurrentUsageSnapshot(10);
    ok('Candidates used remains 1 after student profile update', snapAfterUpdate.resources.candidates.used === 1);

    console.log('\n--- 5. Retakes & Additional Attempts by Same Student Do Not Increment Candidate Usage ---');
    // Student 101 takes an exam attempt
    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status)
      VALUES (501, 10, 'General Assessment', 'GEN-01', 'PUBLISHED')
    `).run();

    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, question_ids_json)
      VALUES (1001, 10, 'tok_1', 101, 501, 'submitted', '2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z', '[]')
    `).run();

    // Student 101 takes a retake
    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, question_ids_json)
      VALUES (1002, 10, 'tok_2', 101, 501, 'started', '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', '[]')
    `).run();

    const snapAfterRetake = getCurrentUsageSnapshot(10);
    ok('Candidates usage remains 1 after retakes/multiple attempts by same student', snapAfterRetake.resources.candidates.used === 1);

    console.log('\n--- 6. Multi-Tenant Candidate Metering Isolation ---');
    // Org 20 registers 2 distinct candidates
    db.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college)
      VALUES (201, 20, 'Beta Student A', 'a@beta.test', '9123456780', 'Beta College'),
             (202, 20, 'Beta Student B', 'b@beta.test', '9123456781', 'Beta College')
    `).run();

    recordUsageEvent({
      organizationId: 20,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'candidate_registered_201',
      referenceType: 'student',
      referenceId: '201'
    });
    recordUsageEvent({
      organizationId: 20,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'candidate_registered_202',
      referenceType: 'student',
      referenceId: '202'
    });

    const snapOrg10 = getCurrentUsageSnapshot(10);
    const snapOrg20 = getCurrentUsageSnapshot(20);

    ok('Org 10 candidates count is exactly 1', snapOrg10.resources.candidates.used === 1);
    ok('Org 20 candidates count is exactly 2', snapOrg20.resources.candidates.used === 2);

    console.log('\n--- 7. Daily Rollup Verification ---');
    const dailyOrg10 = db.prepare(`
      SELECT * FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'candidates'
    `).all();
    ok('Org 10 daily rollup record exists', dailyOrg10.length === 1);
    ok('Org 10 net_usage is 1', dailyOrg10[0].net_usage === 1);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`CANDIDATES METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

