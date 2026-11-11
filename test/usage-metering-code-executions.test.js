// ============================================================================
// ASPIRE DAY 22: USAGE METERING — CODE EXECUTIONS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-code-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
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
  console.log('DAY 22: USAGE METERING — CODE EXECUTIONS TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Alpha Coding Academy', 'alpha-code', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status)
      VALUES (101, 10, 'Coding Assessment', 'CODE-01', 'PUBLISHED')
    `).run();

    db.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college)
      VALUES (501, 10, 'Dev Alice', 'dev@test.com', '9876543210', 'Alpha Institute')
    `).run();

    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, question_ids_json)
      VALUES (1001, 10, 'tok_dev_1', 501, 101, 'started', datetime('now'), datetime('now', '+2 hours'), '[]')
    `).run();

    db.prepare(`
      INSERT INTO questions (id, organization_id, type, question_text, language_id, status)
      VALUES (701, 10, 'code', 'Implement twoSum', 'javascript', 'PUBLISHED')
    `).run();

    console.log('--- 1. Initial State ---');
    const snapInit = getCurrentUsageSnapshot(10);
    ok('Initial code executions is 0', snapInit.resources.codeExecutions.total === 0);

    console.log('\n--- 2. Code Submission Ingestion ---');
    db.prepare(`
      INSERT INTO coding_submissions (
        id, organization_id, attempt_id, question_id, language,
        submission_status, provider, source_hash, source_code,
        test_cases_passed, test_cases_total, lifecycle_status
      ) VALUES (
        9001, 10, 1001, 701, 'javascript',
        'ALL_TESTS_PASSED', 'PISTON', 'hash_abc', 'function twoSum() {}',
        5, 5, 'COMPLETED'
      )
    `).run();

    const evSubmit = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'code_executions',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'code_execution_9001',
      referenceType: 'coding_submission',
      referenceId: '9001',
      metadata: { language: 'javascript', status: 'ALL_TESTS_PASSED' }
    });
    ok('Code execution event recorded', evSubmit.success);
    ok('Code execution event not flagged duplicate', !evSubmit.isDuplicate);

    const snap1 = getCurrentUsageSnapshot(10);
    ok('Total code executions is 1', snap1.resources.codeExecutions.total === 1);
    ok('Passed executions is 1', snap1.resources.codeExecutions.passed === 1);

    console.log('\n--- 3. Worker Polling / Status Checks Do NOT Increment Executions ---');
    // Frontend polls execution status or worker updates lifecycle
    db.prepare(`
      UPDATE coding_submissions
      SET completed_at = datetime('now')
      WHERE id = 9001
    `).run();

    // Replay submission event with same idempotency key
    const evPollRetry = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'code_executions',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'code_execution_9001',
      referenceType: 'coding_submission',
      referenceId: '9001'
    });
    ok('Re-sent code execution event flagged duplicate', evPollRetry.isDuplicate === true);

    const snapAfterPoll = getCurrentUsageSnapshot(10);
    ok('Code executions count remains 1 after status poll', snapAfterPoll.resources.codeExecutions.total === 1);

    console.log('\n--- 4. Error Submissions Categorization ---');
    // Insert submission with compilation error
    db.prepare(`
      INSERT INTO coding_submissions (
        id, organization_id, attempt_id, question_id, language,
        submission_status, provider, source_hash, source_code,
        lifecycle_status
      ) VALUES (
        9002, 10, 1001, 701, 'python',
        'COMPILATION_ERROR', 'PISTON', 'hash_err', 'def twoSum(:',
        'FAILED'
      )
    `).run();

    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'code_executions',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'code_execution_9002',
      referenceType: 'coding_submission',
      referenceId: '9002'
    });

    const snap2 = getCurrentUsageSnapshot(10);
    ok('Total executions is now 2', snap2.resources.codeExecutions.total === 2);
    ok('Compilation error count is 1', snap2.resources.codeExecutions.compilationError === 1);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`CODE EXECUTIONS METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

