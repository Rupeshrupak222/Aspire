// ============================================================================
// ASPIRE DAY 22: USAGE METERING — ATTEMPTS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-attempts-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
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
  console.log('DAY 22: USAGE METERING — ATTEMPTS TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Alpha Institute of Testing', 'alpha-inst', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });

    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status)
      VALUES (101, 10, 'Full Stack Assessment', 'FSA-101', 'PUBLISHED')
    `).run();

    db.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college)
      VALUES (501, 10, 'Candidate Alice', 'alice@test.com', '9876543210', 'Alpha College')
    `).run();

    console.log('--- 1. Initial State ---');
    const snapInit = getCurrentUsageSnapshot(10);
    ok('Initial attempts count is 0', snapInit.resources.attempts.total === 0);

    console.log('\n--- 2. Valid Attempt Creation ---');
    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, question_ids_json)
      VALUES (1001, 10, 'token_alice_1', 501, 101, 'started', datetime('now'), datetime('now', '+2 hours'), '[]')
    `).run();

    const evAttempt1 = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'attempts',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'attempt_created_1001',
      referenceType: 'attempt',
      referenceId: '1001',
      metadata: { examId: 101, studentId: 501 }
    });
    ok('Attempt event recorded', evAttempt1.success);
    ok('Attempt event not flagged as duplicate', !evAttempt1.isDuplicate);

    const snap1 = getCurrentUsageSnapshot(10);
    ok('Total attempts is 1', snap1.resources.attempts.total === 1);
    ok('Started attempts is 1', snap1.resources.attempts.started === 1);

    console.log('\n--- 3. Resumes / Heartbeats / Reloads Do NOT Increment Attempts ---');
    // Candidate reconnects, heartbeat updates or page reload occurred
    db.prepare(`
      UPDATE attempts SET token = 'token_alice_1_resumed' WHERE id = 1001
    `).run();

    // Replay attempt creation event with same idempotency key
    const evRetry = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'attempts',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'attempt_created_1001',
      referenceType: 'attempt',
      referenceId: '1001'
    });
    ok('Re-sent attempt event flagged duplicate', evRetry.isDuplicate === true);

    const snapAfterHeartbeat = getCurrentUsageSnapshot(10);
    ok('Attempts count remains 1 after resume/heartbeat', snapAfterHeartbeat.resources.attempts.total === 1);

    console.log('\n--- 4. Attempt Status Transition to Submitted ---');
    db.prepare(`
      UPDATE attempts
      SET status = 'submitted', submitted_at = datetime('now')
      WHERE id = 1001
    `).run();

    const snapSubmitted = getCurrentUsageSnapshot(10);
    ok('Total attempts remains 1', snapSubmitted.resources.attempts.total === 1);
    ok('Submitted attempts is 1', snapSubmitted.resources.attempts.submitted === 1);
    ok('Started attempts transitioned to 0', snapSubmitted.resources.attempts.started === 0);

    console.log('\n--- 5. Retake Is a Distinct Assessment Attempt ---');
    // Alice retakes the exam -> Creates attempt 1002
    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, question_ids_json)
      VALUES (1002, 10, 'token_alice_2', 501, 101, 'started', datetime('now'), datetime('now', '+2 hours'), '[]')
    `).run();

    const evAttempt2 = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'attempts',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'attempt_created_1002',
      referenceType: 'attempt',
      referenceId: '1002',
      metadata: { examId: 101, studentId: 501, isRetake: true }
    });
    ok('Second attempt event recorded', evAttempt2.success);

    const snapRetake = getCurrentUsageSnapshot(10);
    ok('Total attempts is now 2', snapRetake.resources.attempts.total === 2);
    ok('Candidate count remains 1 (distinct identity)', snapRetake.resources.candidates.current === 1);

    console.log('\n--- 6. Abandoned and Expired Attempt Tracking ---');
    // Create an expired attempt
    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, question_ids_json)
      VALUES (1003, 10, 'token_alice_3', 501, 101, 'expired', datetime('now', '-3 hours'), datetime('now', '-1 hour'), '[]')
    `).run();

    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'attempts',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'attempt_created_1003',
      referenceType: 'attempt',
      referenceId: '1003'
    });

    const snapState = getCurrentUsageSnapshot(10);
    ok('Total attempts is now 3', snapState.resources.attempts.total === 3);
    ok('Expired attempts count is 1', snapState.resources.attempts.expired === 1);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`ATTEMPTS METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
