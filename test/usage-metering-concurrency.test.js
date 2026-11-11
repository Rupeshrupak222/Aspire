// ============================================================================
// ASPIRE DAY 22: USAGE METERING — CONCURRENCY & RACE SAFETY TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-conc-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const { recordUsageEvent, getCurrentUsageSnapshot } = require('../backend/src/services/subscription/metering.service');

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
  console.log('DAY 22: USAGE METERING — CONCURRENCY & RACE SAFETY');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Concurrent Tech Institute', 'conc-tech', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    console.log('--- 1. Parallel Event Ingestion (Zero Lost Updates) ---');
    const NUM_PARALLEL = 50;
    const promises = [];

    for (let i = 1; i <= NUM_PARALLEL; i++) {
      promises.push(
        new Promise((resolve) => {
          // Asynchronously record distinct events
          setImmediate(() => {
            const res = recordUsageEvent({
              organizationId: 10,
              resourceKey: 'code_executions',
              eventType: 'CONSUMED',
              quantity: 1,
              idempotencyKey: `conc_exec_${i}`,
              referenceType: 'coding_submission',
              referenceId: String(1000 + i)
            });
            resolve(res);
          });
        })
      );
    }

    const results = await Promise.all(promises);
    ok('All 50 concurrent events completed successfully', results.length === NUM_PARALLEL && results.every((r) => r.success));
    ok('None of 50 distinct events flagged as duplicate', results.every((r) => !r.isDuplicate));

    // Verify counter
    const counterRow = db.prepare(`
      SELECT used FROM organization_usage_counters
      WHERE organization_id = 10 AND resource_key = 'code_executions'
    `).get();
    ok('Counter recorded exactly 50 used (no lost updates)', counterRow?.used === NUM_PARALLEL);

    // Verify daily aggregate
    const dailyRow = db.prepare(`
      SELECT consumed, net_usage, event_count FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'code_executions'
    `).get();
    ok('Daily aggregate consumed is exactly 50', dailyRow?.consumed === NUM_PARALLEL);
    ok('Daily aggregate event_count is exactly 50', dailyRow?.event_count === NUM_PARALLEL);

    console.log('\n--- 2. Race Conditions on Identical Idempotency Key ---');
    const RACE_ATTEMPTS = 20;
    const sameKey = 'race_identical_key_999';
    const racePromises = [];

    for (let i = 0; i < RACE_ATTEMPTS; i++) {
      racePromises.push(
        new Promise((resolve) => {
          setImmediate(() => {
            try {
              const res = recordUsageEvent({
                organizationId: 10,
                resourceKey: 'code_executions',
                eventType: 'CONSUMED',
                quantity: 1,
                idempotencyKey: sameKey,
                referenceType: 'coding_submission',
                referenceId: '999'
              });
              resolve(res);
            } catch (err) {
              resolve({ error: err.message });
            }
          });
        })
      );
    }

    const raceResults = await Promise.all(racePromises);
    const nonDuplicates = raceResults.filter((r) => !r.isDuplicate && r.success);
    const duplicates = raceResults.filter((r) => r.isDuplicate);

    ok('Exactly one caller succeeded as non-duplicate', nonDuplicates.length === 1);
    ok('Remaining 19 callers returned isDuplicate: true', duplicates.length === RACE_ATTEMPTS - 1);

    // Verify counter incremented by only 1 unit for the identical key
    const counterAfterRace = db.prepare(`
      SELECT used FROM organization_usage_counters
      WHERE organization_id = 10 AND resource_key = 'code_executions'
    `).get();
    ok('Counter incremented by exactly 1 (50 + 1 = 51)', counterAfterRace?.used === 51);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`CONCURRENCY METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

