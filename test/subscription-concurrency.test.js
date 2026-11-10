// ============================================================================
// ASPIRE DAY 21: CONCURRENCY & ATOMIC RACE-CONDITION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-concurrency-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { consumeQuota } = require('../backend/src/services/subscription/quota.service');
const { assignSubscription, getOrganizationSubscription } = require('../backend/src/services/subscription/subscription.service');
const { getUsage } = require('../backend/src/services/subscription/usage.service');

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
  console.log('DAY 21: CONCURRENCY & ATOMIC QUOTA RACE TEST');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Race Academy', 'race-acad', 'ACTIVE')
  `).run();

  // Assign custom plan with tight quota of 10 candidates
  assignSubscription({
    organizationId: 10,
    planCodeOrId: 'STARTER',
    status: 'ACTIVE',
    overrideQuotas: { candidates: 10 },
    actorId: 1
  });

  try {
    console.log('--- 1. Baseline Consumption to 9 / 10 Units ---');
    consumeQuota({
      organizationId: 10,
      resourceKey: 'candidates',
      quantity: 9,
      referenceType: 'seed'
    });

    const sub = getOrganizationSubscription(10);
    const usageBefore = getUsage(10, 'candidates', sub.currentPeriodStart, sub.currentPeriodEnd);
    ok('Initial usage is 9', usageBefore.used === 9);
    ok('Exact 1 quota unit remains', 10 - usageBefore.used === 1);

    console.log('\n--- 2. Firing 10 Concurrent Requests for the Final 1 Unit ---');
    const CONCURRENT_REQUESTS = 10;
    const promises = [];

    for (let i = 1; i <= CONCURRENT_REQUESTS; i++) {
      promises.push(
        new Promise((resolve) => {
          // Microtask yield to ensure all promises start concurrently
          setImmediate(() => {
            try {
              const res = consumeQuota({
                organizationId: 10,
                resourceKey: 'candidates',
                quantity: 1,
                referenceType: 'concurrent_candidate',
                referenceId: `cand_concurrent_${i}`,
                idempotencyKey: `req_concurrency_${i}`
              });
              resolve({ success: true, result: res });
            } catch (err) {
              resolve({ success: false, error: err.code || err.message });
            }
          });
        })
      );
    }

    const results = await Promise.all(promises);

    const succeeded = results.filter((r) => r.success);
    const rejected = results.filter((r) => !r.success);

    console.log(`  Succeeded: ${succeeded.length}`);
    console.log(`  Rejected: ${rejected.length}`);

    ok('Exactly 1 concurrent request succeeded for the final unit', succeeded.length === 1);
    ok(`Exactly ${CONCURRENT_REQUESTS - 1} concurrent requests rejected with QUOTA_EXCEEDED`, rejected.length === CONCURRENT_REQUESTS - 1);
    ok('All rejections have QUOTA_EXCEEDED code', rejected.every((r) => r.error === 'QUOTA_EXCEEDED'));

    const usageAfter = getUsage(10, 'candidates', sub.currentPeriodStart, sub.currentPeriodEnd);
    ok('Final database usage is exactly at the hard limit (10)', usageAfter.used === 10);
    ok('Hard limit was NEVER breached (> 10)', usageAfter.used <= 10);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch { }
  }

  console.log('\n====================================================');
  console.log(`CONCURRENCY RACE SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
