// ============================================================================
// ASPIRE DAY 21: SUBSCRIPTION LIFECYCLE TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-lifecycle-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  assignSubscription,
  getOrganizationSubscription,
  getEffectiveQuotas,
  getEffectiveFeatures,
  updateSubscription,
  suspendSubscription,
  resumeSubscription,
  cancelSubscription,
  getSubscriptionHistory
} = require('../backend/src/services/subscription/subscription.service');

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
  console.log('DAY 21: SUBSCRIPTION LIFECYCLE TEST SUITE');
  console.log('====================================================\n');

  // Seed super admin user and test organizations
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'LifeCycle Academy', 'lifecycle-acad', 'ACTIVE'),
           (20, 'Downgrade Institute', 'downgrade-inst', 'ACTIVE')
  `).run();

  try {
    console.log('--- 1. Initial Plan Assignment (Starter Plan) ---');
    const subStarter = assignSubscription({
      organizationId: 10,
      planCodeOrId: 'STARTER',
      status: 'ACTIVE',
      notes: 'Initial onboarding to Starter tier',
      actorId: 1
    });

    ok('Subscription assigned successfully', Boolean(subStarter && subStarter.id));
    ok('Subscription status is ACTIVE', subStarter.status === 'ACTIVE');
    ok('Assigned plan is STARTER', subStarter.plan.code === 'STARTER');

    const quotas = getEffectiveQuotas(10);
    ok('Effective monthly exams quota is 3', quotas.exams_monthly === 3);
    ok('Effective candidates quota is 500', quotas.candidates === 500);

    const features = getEffectiveFeatures(10);
    ok('Effective features include BASIC_ANALYTICS', features.includes('BASIC_ANALYTICS'));
    ok('Effective features do not include PROCTORING', !features.includes('PROCTORING'));

    console.log('\n--- 2. Trial Period & State Transitions ---');
    const trialSub = assignSubscription({
      organizationId: 10,
      planCodeOrId: 'GROWTH',
      status: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      notes: '14-day free trial of Growth',
      actorId: 1
    });

    ok('Switched to Growth trial', trialSub.plan.code === 'GROWTH' && trialSub.status === 'TRIAL');
    ok('Trial ends at date is preserved', Boolean(trialSub.trialEndsAt));

    const growthQuotas = getEffectiveQuotas(10);
    ok('Growth exams quota is unlimited (null)', growthQuotas.exams_monthly === null);
    ok('Growth candidates quota is 5000', growthQuotas.candidates === 5000);

    console.log('\n--- 3. Suspension and Resumption ---');
    const suspended = suspendSubscription(10, 'Payment past due simulation', 1);
    ok('Subscription suspended', suspended.status === 'SUSPENDED');
    ok('Suspension reason stored in notes', suspended.notes.includes('Payment past due'));

    const resumed = resumeSubscription(10, 1);
    ok('Subscription resumed to ACTIVE', resumed.status === 'ACTIVE');

    console.log('\n--- 4. Per-Tenant Quota & Feature Overrides ---');
    // Give tenant 10 a custom candidate limit of 1,200 and custom feature 'DEDICATED_INFRASTRUCTURE'
    const overridden = updateSubscription(10, {
      override_quotas: { candidates: 1200 },
      override_features: ['DEDICATED_INFRASTRUCTURE']
    }, 1);

    ok('Override quotas saved on subscription', overridden.overrideQuotas.candidates === 1200);
    ok('Override features saved on subscription', overridden.overrideFeatures.includes('DEDICATED_INFRASTRUCTURE'));

    const effectiveOverriddenQuotas = getEffectiveQuotas(10);
    ok('Effective candidate quota reflects override (1200)', effectiveOverriddenQuotas.candidates === 1200);
    ok('Monthly exams quota remains from plan (null)', effectiveOverriddenQuotas.exams_monthly === null);

    const effectiveOverriddenFeatures = getEffectiveFeatures(10);
    ok('Effective features include DEDICATED_INFRASTRUCTURE', effectiveOverriddenFeatures.includes('DEDICATED_INFRASTRUCTURE'));
    ok('Effective features still include PROCTORING from Growth', effectiveOverriddenFeatures.includes('PROCTORING'));

    console.log('\n--- 5. Upgrade and Downgrade Data Preservation ---');
    // Seed 10 candidates in Org 20 under Growth
    assignSubscription({ organizationId: 20, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO students (organization_id, name, phone, email)
        VALUES (20, 'Student ${i}', '990000000${i}', 's${i}@org20.com')
      `).run();
    }
    const studentCountBefore = db.prepare('SELECT count(*) as c FROM students WHERE organization_id = 20').get().c;
    ok('Pre-downgrade student count is 5', studentCountBefore === 5);

    // Downgrade to Starter
    assignSubscription({ organizationId: 20, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });
    const subDowngraded = getOrganizationSubscription(20);
    ok('Downgraded to Starter', subDowngraded.plan.code === 'STARTER');

    // Verify ZERO data loss
    const studentCountAfter = db.prepare('SELECT count(*) as c FROM students WHERE organization_id = 20').get().c;
    ok('No candidate records deleted during downgrade (still 5)', studentCountAfter === 5);

    console.log('\n--- 6. Subscription Audit History ---');
    const history = getSubscriptionHistory(10);
    ok('History contains multiple past subscription records', history.length >= 2);
    ok('History includes Starter plan record', history.some((h) => h.planCode === 'STARTER'));
    ok('History includes Growth plan record', history.some((h) => h.planCode === 'GROWTH'));

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SUBSCRIPTION LIFECYCLE SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

