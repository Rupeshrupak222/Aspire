// ============================================================================
// ASPIRE DAY 21: SUBSCRIPTION PLANS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-plans-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  listPlans,
  getPlanById,
  getPlanByCode,
  createPlan,
  updatePlan
} = require('../backend/src/services/subscription/plan.service');

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
  console.log('DAY 21: SUBSCRIPTION PLANS TEST SUITE');
  console.log('====================================================\n');

  try {
    console.log('--- 1. Seeded Plans Catalog Verification ---');
    const plans = listPlans();
    ok('Active plans list returns standard plans', plans.length >= 3);

    const starter = getPlanByCode('STARTER');
    ok('Starter plan exists', Boolean(starter));
    ok('Starter name is Starter', starter.name === 'Starter');
    ok('Starter monthly exams quota is 3', starter.quotas.exams_monthly === 3);
    ok('Starter candidates quota is 500', starter.quotas.candidates === 500);
    ok('Starter features include BASIC_ANALYTICS', starter.features.includes('BASIC_ANALYTICS'));
    ok('Starter features include STANDARD_ASSESSMENT', starter.features.includes('STANDARD_ASSESSMENT'));
    ok('Starter does NOT include PROCTORING', !starter.features.includes('PROCTORING'));

    const growth = getPlanByCode('GROWTH');
    ok('Growth plan exists', Boolean(growth));
    ok('Growth monthly exams quota is null (unlimited)', growth.quotas.exams_monthly === null);
    ok('Growth candidates quota is 5000', growth.quotas.candidates === 5000);
    ok('Growth includes CERTIFICATES and PROCTORING', growth.features.includes('CERTIFICATES') && growth.features.includes('PROCTORING'));

    const enterprise = getPlanByCode('ENTERPRISE');
    ok('Enterprise plan exists', Boolean(enterprise));
    ok('Enterprise monthly exams is null (unlimited)', enterprise.quotas.exams_monthly === null);
    ok('Enterprise candidates is null (unlimited)', enterprise.quotas.candidates === null);
    ok('Enterprise includes CUSTOM_BRANDING', enterprise.features.includes('CUSTOM_BRANDING'));

    console.log('\n--- 2. Unlimited Quota vs Zero Invariant ---');
    // Ensure null is strictly distinguished from 0
    ok('Starter quota is NOT unlimited', starter.quotas.candidates !== null);
    ok('Enterprise candidates quota is strictly null', enterprise.quotas.candidates === null);
    ok('Enterprise candidates quota is NOT 0', enterprise.quotas.candidates !== 0);

    console.log('\n--- 3. Plan Creation by Administrator ---');
    const customPlan = createPlan({
      code: 'INSTITUTE_PLUS',
      name: 'Institute Plus',
      description: 'Special tier for colleges',
      features: ['BASIC_ANALYTICS', 'CERTIFICATES'],
      quotas: { exams_monthly: 10, candidates: 2000 },
      soft_limit_pct: 75,
      sort_order: 4
    }, 1);

    ok('Custom plan created successfully', Boolean(customPlan && customPlan.id));
    ok('Custom plan code is INSTITUTE_PLUS', customPlan.code === 'INSTITUTE_PLUS');
    ok('Custom plan monthly exams is 10', customPlan.quotas.exams_monthly === 10);
    ok('Custom plan soft limit is 75%', customPlan.softLimitPct === 75);

    // Duplicate code prevention
    let dupFailed = false;
    try {
      createPlan({ code: 'INSTITUTE_PLUS', name: 'Duplicate' });
    } catch (err) {
      dupFailed = err.code === 'PLAN_CODE_EXISTS' || err.statusCode === 409;
    }
    ok('Duplicate plan code rejected with conflict', dupFailed);

    console.log('\n--- 4. Plan Modification & Inactivation ---');
    const updated = updatePlan(customPlan.id, {
      name: 'Institute Plus Renamed',
      soft_limit_pct: 85,
      is_active: false
    }, 1);

    ok('Plan updated with new name', updated.name === 'Institute Plus Renamed');
    ok('Plan updated with new soft limit', updated.softLimitPct === 85);
    ok('Plan marked inactive', updated.isActive === false);

    const activeList = listPlans({ includeInactive: false });
    ok('Inactive plan excluded from public active list', !activeList.some((p) => p.id === customPlan.id));

    const fullList = listPlans({ includeInactive: true });
    ok('Inactive plan included when includeInactive: true', fullList.some((p) => p.id === customPlan.id));

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SUBSCRIPTION PLANS SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

