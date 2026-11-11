// ============================================================================
// ASPIRE DAY 22: USAGE METERING — RECONCILIATION ENGINE TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-recon-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const {
  reconcileOrganization,
  startReconciliationJob,
  getReconciliationJob
} = require('../backend/src/services/subscription/reconciliation.service');

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
  console.log('DAY 22: USAGE METERING — RECONCILIATION ENGINE TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Recon University', 'recon-univ', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    console.log('--- 1. Seed Intentional Counter Drift ---');
    // Actual business table: 3 distinct candidates
    db.prepare(`
      INSERT INTO students (id, organization_id, name, email, phone, college)
      VALUES (1, 10, 'Cand 1', 'c1@test.com', '9876543201', 'College A'),
             (2, 10, 'Cand 2', 'c2@test.com', '9876543202', 'College A'),
             (3, 10, 'Cand 3', 'c3@test.com', '9876543203', 'College A')
    `).run();

    // Counter table: contains drifted value (used = 1 instead of 3)
    db.prepare(`
      INSERT INTO organization_usage_counters (
        organization_id, subscription_id, resource_key, period_start, period_end, used, reserved
      ) VALUES (
        10, 1, 'candidates', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 1, 0
      )
    `).run();

    console.log('\n--- 2. Dry-Run Mode (Detects Discrepancy, No Mutations) ---');
    const dryRunResult = reconcileOrganization(10, { mode: 'DRY_RUN', actorId: 1 });

    ok('Dry-run reports DISCREPANCIES_FOUND', dryRunResult.status === 'DISCREPANCIES_FOUND');
    ok('Dry-run found discrepancies', dryRunResult.discrepanciesCount > 0);
    ok('Candidates mismatch flagged', dryRunResult.discrepancies.some((d) => d.resourceKey === 'candidates' && d.sourceValue === 3 && d.counterValue === 1));
    ok('Dry-run made zero corrections', dryRunResult.correctionsCount === 0);

    // Verify counter is STILL drifted (used = 1)
    const checkCounterBefore = db.prepare(`
      SELECT used FROM organization_usage_counters
      WHERE organization_id = 10 AND resource_key = 'candidates'
    `).get();
    ok('Counter was not modified in DRY_RUN mode', checkCounterBefore.used === 1);

    console.log('\n--- 3. Apply Corrections Mode (Repairs Drift) ---');
    const applyResult = reconcileOrganization(10, { mode: 'APPLY_CORRECTIONS', actorId: 1 });

    ok('Apply corrections reports status REPAIRED', applyResult.status === 'REPAIRED');
    ok('Apply corrections repaired candidates counter', applyResult.corrections.some((c) => c.resourceKey === 'candidates' && c.to === 3));

    // Verify counter now matches source-of-truth (used = 3)
    const checkCounterAfter = db.prepare(`
      SELECT used FROM organization_usage_counters
      WHERE organization_id = 10 AND resource_key = 'candidates'
      ORDER BY id DESC LIMIT 1
    `).get();
    ok('Counter now reflects authoritative value (used = 3)', checkCounterAfter.used === 3);

    console.log('\n--- 4. Secondary Reconciliation (Zero Discrepancies) ---');
    const cleanResult = reconcileOrganization(10, { mode: 'DRY_RUN', actorId: 1 });
    ok('No candidates discrepancy remains after repair', !cleanResult.discrepancies.some((d) => d.resourceKey === 'candidates'));

    console.log('\n--- 5. Job Creation and Retrieval ---');
    const job = startReconciliationJob({ organizationId: 10, mode: 'DRY_RUN', actorId: 1 });
    ok('Job created with id', !!job.jobId);
    ok('Job completed with total checked', job.totalOrganizationsChecked === 1);

    const fetchedJob = getReconciliationJob(job.jobId);
    ok('Job fetched successfully by ID', fetchedJob && fetchedJob.id === job.jobId);
    ok('Job status in DB is COMPLETED', fetchedJob.status === 'COMPLETED');
    ok('Job report exists in retrieved record', !!fetchedJob.report);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`RECONCILIATION SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
