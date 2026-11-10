// ============================================================================
// ASPIRE DAY 21: USAGE TRACKING & PERIOD COUNTER TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-usage-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  getOrCreateCounter,
  getUsage,
  recordUsageEvent,
  getUsageEvents
} = require('../backend/src/services/subscription/usage.service');
const {
  consumeQuota,
  reserveQuota,
  releaseQuota,
  adjustQuota
} = require('../backend/src/services/subscription/quota.service');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');

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
  console.log('DAY 21: USAGE TRACKING & COUNTERS TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Usage Org Alpha', 'usage-org-alpha', 'ACTIVE')
  `).run();

  // Assign Growth plan
  assignSubscription({
    organizationId: 10,
    planCodeOrId: 'GROWTH',
    status: 'ACTIVE',
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
    actorId: 1
  });

  try {
    console.log('--- 1. Counter Initialization & Retrieval ---');
    const c1 = getOrCreateCounter(10, 'exams_monthly', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 1);
    ok('Counter created with 0 used', c1.used === 0);
    ok('Counter created with 0 reserved', c1.reserved === 0);

    const u1 = getUsage(10, 'exams_monthly', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    ok('getUsage returns used = 0', u1.used === 0);

    console.log('\n--- 2. Consumption & Idempotency Key Protection ---');
    const res1 = consumeQuota({
      organizationId: 10,
      resourceKey: 'exams_monthly',
      quantity: 1,
      referenceType: 'exam',
      referenceId: '101',
      idempotencyKey: 'pub_exam_101',
      metadata: { examName: 'Midterm Assessment' }
    });
    ok('First consumption succeeded', res1.success && res1.used === 1);
    ok('isDuplicate is false for new consumption', res1.isDuplicate === false);

    // Duplicate call with exact same idempotency key (simulating network retry)
    const resDuplicate = consumeQuota({
      organizationId: 10,
      resourceKey: 'exams_monthly',
      quantity: 1,
      referenceType: 'exam',
      referenceId: '101',
      idempotencyKey: 'pub_exam_101'
    });
    ok('Duplicate request returned successfully', resDuplicate.success);
    ok('Duplicate request flagged as isDuplicate: true', resDuplicate.isDuplicate === true);

    const uAfterDup = getUsage(10, 'exams_monthly', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    ok('Counter NOT incremented twice on duplicate retry (used still 1)', uAfterDup.used === 1);

    console.log('\n--- 3. Period Boundary Isolation (Monthly Reset) ---');
    // November period has used = 1
    // Now simulate December period
    const uDec = getUsage(10, 'exams_monthly', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    ok('December period starts clean with 0 used', uDec.used === 0);

    const uNov = getUsage(10, 'exams_monthly', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    ok('November period preserved with used = 1', uNov.used === 1);

    console.log('\n--- 4. Reservation and Release Lifecycle ---');
    const resReserve = reserveQuota({
      organizationId: 10,
      resourceKey: 'candidates',
      quantity: 25,
      idempotencyKey: 'batch_reserve_candidates_1'
    });
    ok('Reserved 25 candidate units', resReserve.success && resReserve.reserved === 25);

    const uCand = getUsage(10, 'candidates', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    ok('Counter reserved count is 25', uCand.reserved === 25);
    ok('Total candidate consumption projected includes reserved (25)', uCand.total === 25);

    // Release 10 units
    const resRelease = releaseQuota({
      organizationId: 10,
      resourceKey: 'candidates',
      quantity: 10,
      idempotencyKey: 'batch_release_candidates_1'
    });
    ok('Released candidate units', resRelease.success);

    const uCandAfterRel = getUsage(10, 'candidates', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
    ok('Reserved count decremented to 15', uCandAfterRel.reserved === 15);

    console.log('\n--- 5. Manual Usage Adjustment by Administrator ---');
    const adjResult = adjustQuota({
      organizationId: 10,
      resourceKey: 'exams_monthly',
      quantity: 2,
      reason: 'Manual grant for failed exam rerun',
      actorId: 1
    });
    ok('Usage counter adjusted (+2)', adjResult.used === 3);

    console.log('\n--- 6. Usage Events Audit Trail ---');
    const events = getUsageEvents(10, { limit: 10 });
    ok('Usage events recorded in audit log', events.length >= 3);
    ok('Audit events distinguish CONSUMED', events.some((e) => e.eventType === 'CONSUMED'));
    ok('Audit events distinguish RESERVED', events.some((e) => e.eventType === 'RESERVED'));
    ok('Audit events distinguish ADJUSTED', events.some((e) => e.eventType === 'ADJUSTED'));

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SUBSCRIPTION USAGE SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

