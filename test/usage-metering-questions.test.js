// ============================================================================
// ASPIRE DAY 22: USAGE METERING — QUESTIONS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-questions-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
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
  console.log('DAY 22: USAGE METERING — QUESTIONS TEST SUITE');
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

    console.log('--- 1. Initial State ---');
    const snapInit = getCurrentUsageSnapshot(10);
    ok('Initial questions count is 0', snapInit.resources.questions.total === 0);

    console.log('\n--- 2. Question Creation ---');
    db.prepare(`
      INSERT INTO questions (id, organization_id, type, question_text, options_json, correct_index, status)
      VALUES (101, 10, 'mcq', 'What is O(log n)?', '[]', 0, 'PUBLISHED')
    `).run();

    const evQ1 = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'questions',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'question_created_101',
      referenceType: 'question',
      referenceId: '101'
    });
    ok('Question created event recorded', evQ1.success);

    const snap1 = getCurrentUsageSnapshot(10);
    ok('Total questions is 1', snap1.resources.questions.total === 1);
    ok('Active questions is 1', snap1.resources.questions.active === 1);

    console.log('\n--- 3. Question Update Does NOT Increment Question Count ---');
    db.prepare(`
      UPDATE questions
      SET question_text = 'What is the time complexity of binary search?'
      WHERE id = 101
    `).run();

    // Replay creation event with same idempotency key
    const evDup = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'questions',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'question_created_101',
      referenceType: 'question',
      referenceId: '101'
    });
    ok('Re-sent question event flagged duplicate', evDup.isDuplicate === true);

    const snapAfterEdit = getCurrentUsageSnapshot(10);
    ok('Total questions remains 1 after prompt edit', snapAfterEdit.resources.questions.total === 1);

    console.log('\n--- 4. Exam Allocation Does NOT Create New Questions ---');
    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status)
      VALUES (501, 10, 'Midterm Exam', 'MDT-01', 'PUBLISHED')
    `).run();

    const secRes = db.prepare(`
      INSERT INTO exam_sections (exam_id, name, display_order)
      VALUES (501, 'Section A', 1)
    `).run();
    const sectionId = secRes.lastInsertRowid;

    db.prepare(`
      INSERT INTO exam_section_questions (section_id, question_id, display_order)
      VALUES (?, 101, 1)
    `).run(sectionId);

    const snapAlloc = getCurrentUsageSnapshot(10);
    ok('Total questions bank count remains 1', snapAlloc.resources.questions.total === 1);
    ok('Allocated to exams is 1', snapAlloc.resources.questions.allocatedToExams === 1);

    console.log('\n--- 5. Archiving Question Bank Item ---');
    db.prepare(`
      UPDATE questions SET status = 'ARCHIVED' WHERE id = 101
    `).run();

    const snapArchived = getCurrentUsageSnapshot(10);
    ok('Total questions remains 1', snapArchived.resources.questions.total === 1);
    ok('Archived questions is 1', snapArchived.resources.questions.archived === 1);
    ok('Active questions transitioned to 0', snapArchived.resources.questions.active === 0);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`QUESTIONS METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
