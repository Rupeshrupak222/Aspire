// ============================================================================
// ASPIRE DAY 22: USAGE METERING — EXAMS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-exams-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
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
  console.log('DAY 22: USAGE METERING — EXAMS TEST SUITE');
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

    // Starter plan: 3 monthly published exams limit
    assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });

    console.log('--- 1. Initial State ---');
    const snapInit = getCurrentUsageSnapshot(10);
    ok('Initial total exams is 0', snapInit.resources.exams.total === 0);
    ok('Initial monthly published is 0', snapInit.resources.exams.monthlyPublished.used === 0);
    ok('Monthly published limit is 3', snapInit.resources.exams.monthlyPublished.limit === 3);

    console.log('\n--- 2. Draft Exam Creation ---');
    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status)
      VALUES (101, 10, 'Draft Scholarship Exam', 'DSE-01', 'DRAFT')
    `).run();

    const evCreate = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'exams_created',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'exam_created_101',
      referenceType: 'exam',
      referenceId: '101'
    });
    ok('Exam created event recorded', evCreate.success);

    const snapDraft = getCurrentUsageSnapshot(10);
    ok('Total exams is 1', snapDraft.resources.exams.total === 1);
    ok('Draft exams is 1', snapDraft.resources.exams.drafts === 1);
    ok('Published exams is 0', snapDraft.resources.exams.published === 0);
    ok('Monthly published quota NOT consumed by draft (used = 0)', snapDraft.resources.exams.monthlyPublished.used === 0);

    console.log('\n--- 3. First Publication Consumes Monthly Quota ---');
    db.prepare(`
      UPDATE exams SET status = 'PUBLISHED' WHERE id = 101
    `).run();

    const evPublish = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'exams_monthly',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'exam_published_101',
      referenceType: 'exam',
      referenceId: '101'
    });
    ok('Exam publication event recorded', evPublish.success);

    const snapPub = getCurrentUsageSnapshot(10);
    ok('Published exams is now 1', snapPub.resources.exams.published === 1);
    ok('Drafts is now 0', snapPub.resources.exams.drafts === 0);
    ok('Monthly published quota consumed (used = 1)', snapPub.resources.exams.monthlyPublished.used === 1);
    ok('Remaining monthly published quota is 2', snapPub.resources.exams.monthlyPublished.remaining === 2);

    console.log('\n--- 4. Unpublishing and Republishing Does NOT Consume Another Quota Unit ---');
    // Transition to DRAFT
    db.prepare(`UPDATE exams SET status = 'DRAFT' WHERE id = 101`).run();
    // Transition back to PUBLISHED
    db.prepare(`UPDATE exams SET status = 'PUBLISHED' WHERE id = 101`).run();

    // Replay publication event with original idempotency key
    const evRepublish = recordUsageEvent({
      organizationId: 10,
      resourceKey: 'exams_monthly',
      eventType: 'CONSUMED',
      quantity: 1,
      idempotencyKey: 'exam_published_101',
      referenceType: 'exam',
      referenceId: '101'
    });
    ok('Republish event flagged as duplicate', evRepublish.isDuplicate === true);

    const snapRepub = getCurrentUsageSnapshot(10);
    ok('Monthly published quota still exactly 1', snapRepub.resources.exams.monthlyPublished.used === 1);

    console.log('\n--- 5. Archiving Exam Preserves Historical Usage ---');
    db.prepare(`UPDATE exams SET status = 'ARCHIVED' WHERE id = 101`).run();

    const snapArchived = getCurrentUsageSnapshot(10);
    ok('Total exams remains 1', snapArchived.resources.exams.total === 1);
    ok('Archived exams count is 1', snapArchived.resources.exams.archived === 1);
    ok('Monthly published quota usage preserved at 1', snapArchived.resources.exams.monthlyPublished.used === 1);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`EXAMS METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

