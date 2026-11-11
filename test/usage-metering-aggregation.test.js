// ============================================================================
// ASPIRE DAY 22: USAGE METERING — AGGREGATION & TRENDS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-agg-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const {
  recordUsageEvent,
  getUsageTrends,
  rebuildDailyAggregate,
  getUsageDateString
} = require('../backend/src/services/subscription/metering.service');

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
  console.log('DAY 22: USAGE METERING — AGGREGATION & TRENDS TEST SUITE');
  console.log('====================================================\n');

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, status)
      VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
    `).run();

    db.prepare(`
      INSERT INTO organizations (id, name, slug, timezone, status)
      VALUES (10, 'Daily Agg Org Alpha', 'daily-agg-alpha', 'Asia/Kolkata', 'ACTIVE')
    `).run();

    assignSubscription({ organizationId: 10, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

    console.log('--- 1. Timezone Date String Normalization ---');
    // An event occurring at 2026-11-10T19:00:00Z is 2026-11-11 00:30:00 in Asia/Kolkata (+05:30)
    const dtUtc = new Date('2026-11-10T19:00:00Z');
    const dateInKolkata = getUsageDateString(dtUtc, 'Asia/Kolkata');
    const dateInUtc = getUsageDateString(dtUtc, 'UTC');
    ok('Kolkata date is next day (2026-11-11)', dateInKolkata === '2026-11-11');
    ok('UTC date is previous day (2026-11-10)', dateInUtc === '2026-11-10');

    console.log('\n--- 2. Daily Rollup Upsert with Multiple Events ---');
    // Ingest events on specific dates
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 5,
      idempotencyKey: 'agg_cand_1',
      occurredAt: '2026-11-05T10:00:00.000Z'
    });
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 3,
      idempotencyKey: 'agg_cand_2',
      occurredAt: '2026-11-05T14:00:00.000Z'
    });
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 10,
      idempotencyKey: 'agg_cand_3',
      occurredAt: '2026-11-08T09:00:00.000Z'
    });

    const day5 = db.prepare(`
      SELECT * FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'candidates' AND usage_date = '2026-11-05'
    `).get();
    ok('Day 2026-11-05 aggregate exists', !!day5);
    ok('Day 2026-11-05 consumed sum is 8', day5.consumed === 8);
    ok('Day 2026-11-05 event_count is 2', day5.event_count === 2);

    console.log('\n--- 3. Trend Contiguous Date Filling (Zero-Activity Days) ---');
    const trends = getUsageTrends({
      organizationId: 10,
      resourceKey: 'candidates',
      startDate: '2026-11-04',
      endDate: '2026-11-09'
    });

    ok('Trends returns 6 contiguous days (Nov 4 to Nov 9)', trends.dates.length === 6);
    ok('Nov 04 has 0 candidates', trends.series.candidates[0].consumed === 0);
    ok('Nov 05 has 8 candidates', trends.series.candidates[1].consumed === 8);
    ok('Nov 06 has 0 candidates (zero filled)', trends.series.candidates[2].consumed === 0);
    ok('Nov 07 has 0 candidates (zero filled)', trends.series.candidates[3].consumed === 0);
    ok('Nov 08 has 10 candidates', trends.series.candidates[4].consumed === 10);
    ok('Nov 09 has 0 candidates (zero filled)', trends.series.candidates[5].consumed === 0);

    console.log('\n--- 4. Daily Aggregate Rebuild from Ledger ---');
    // Clear the daily aggregate for 2026-11-05
    db.prepare(`
      DELETE FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'candidates' AND usage_date = '2026-11-05'
    `).run();

    const checkDeleted = db.prepare(`
      SELECT * FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'candidates' AND usage_date = '2026-11-05'
    `).get();
    ok('Day 2026-11-05 aggregate was deleted', !checkDeleted);

    // Rebuild from immutable event ledger
    const rebuildResult = rebuildDailyAggregate(10, '2026-11-05', 'candidates');
    ok('Rebuild result returned', !!rebuildResult && rebuildResult.length > 0);
    ok('Rebuilt aggregate net_usage is 8', rebuildResult[0].total_net === 8);
    ok('Rebuilt aggregate event_count is 2', rebuildResult[0].event_count === 2);

    const recheckRow = db.prepare(`
      SELECT * FROM organization_usage_daily
      WHERE organization_id = 10 AND resource_key = 'candidates' AND usage_date = '2026-11-05'
    `).get();
    ok('Aggregate restored in table with correct net_usage (8)', recheckRow.net_usage === 8);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`AGGREGATION METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
