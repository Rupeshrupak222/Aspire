// ============================================================================
// ASPIRE DAY 21: FEATURE ENTITLEMENTS & GATING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-features-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  getEffectiveFeatures,
  assignSubscription,
  updateSubscription
} = require('../backend/src/services/subscription/subscription.service');
const { requireFeature } = require('../backend/src/middleware/quota-enforcement');

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
  console.log('DAY 21: FEATURE ENTITLEMENTS TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE'),
           (10, 'orgadmin@starter.com', 'hash', 'Starter Admin', 'ORG_ADMIN', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Starter Academy', 'starter-acad', 'ACTIVE'),
           (20, 'Growth Academy', 'growth-acad', 'ACTIVE'),
           (30, 'Enterprise Academy', 'enterprise-acad', 'ACTIVE')
  `).run();

  db.prepare('UPDATE users SET organization_id = 10 WHERE id = 10').run();

  // Assign plans
  assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });
  assignSubscription({ organizationId: 20, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });
  assignSubscription({ organizationId: 30, planCodeOrId: 'ENTERPRISE', status: 'ACTIVE', actorId: 1 });

  try {
    console.log('--- 1. Plan-Specific Feature Entitlements ---');
    const fStarter = getEffectiveFeatures(10);
    ok('Starter has BASIC_ANALYTICS', fStarter.includes('BASIC_ANALYTICS'));
    ok('Starter lacks CUSTOM_BRANDING', !fStarter.includes('CUSTOM_BRANDING'));
    ok('Starter lacks PROCTORING', !fStarter.includes('PROCTORING'));
    ok('Starter lacks CERTIFICATES', !fStarter.includes('CERTIFICATES'));

    const fGrowth = getEffectiveFeatures(20);
    ok('Growth has CERTIFICATES', fGrowth.includes('CERTIFICATES'));
    ok('Growth has PROCTORING', fGrowth.includes('PROCTORING'));
    ok('Growth has ADVANCED_ANALYTICS', fGrowth.includes('ADVANCED_ANALYTICS'));
    ok('Growth lacks CUSTOM_BRANDING', !fGrowth.includes('CUSTOM_BRANDING'));

    const fEnterprise = getEffectiveFeatures(30);
    ok('Enterprise has CUSTOM_BRANDING', fEnterprise.includes('CUSTOM_BRANDING'));
    ok('Enterprise has PRIORITY_SUPPORT', fEnterprise.includes('PRIORITY_SUPPORT'));
    ok('Enterprise has DEDICATED_INFRASTRUCTURE', fEnterprise.includes('DEDICATED_INFRASTRUCTURE'));

    console.log('\n--- 2. Middleware Enforcement (requireFeature) ---');
    const brandingMiddleware = requireFeature('CUSTOM_BRANDING');

    // Test 1: Starter Org Admin attempting to access CUSTOM_BRANDING
    let starterError = null;
    const reqStarter = { user: { id: 10, role: 'ORG_ADMIN', organization_id: 10 } };
    const resMock = {};
    brandingMiddleware(reqStarter, resMock, (err) => {
      starterError = err;
    });

    ok('Starter access to CUSTOM_BRANDING rejected', Boolean(starterError));
    ok('Rejection code is FEATURE_NOT_AVAILABLE', starterError && starterError.code === 'FEATURE_NOT_AVAILABLE');
    ok('Error status is 403', starterError && starterError.statusCode === 403);

    // Test 2: Enterprise Org Admin attempting to access CUSTOM_BRANDING
    let enterpriseError = null;
    let enterprisePassed = false;
    const reqEnterprise = { user: { id: 30, role: 'ORG_ADMIN', organization_id: 30 } };
    brandingMiddleware(reqEnterprise, resMock, (err) => {
      if (err) enterpriseError = err;
      else enterprisePassed = true;
    });

    ok('Enterprise access to CUSTOM_BRANDING allowed', enterprisePassed && !enterpriseError);

    // Test 3: Super Admin bypass override
    let superAdminPassed = false;
    const reqSuper = { user: { id: 1, role: 'SUPER_ADMIN', organization_id: null } };
    brandingMiddleware(reqSuper, resMock, (err) => {
      if (!err) superAdminPassed = true;
    });
    ok('Super Admin bypasses feature restrictions globally', superAdminPassed);

    console.log('\n--- 3. Tenant-Level Feature Override ---');
    // Grant Starter Academy CUSTOM_BRANDING via override
    updateSubscription(10, {
      override_features: ['CUSTOM_BRANDING']
    }, 1);

    const fStarterOverridden = getEffectiveFeatures(10);
    ok('Starter Academy now has CUSTOM_BRANDING via override', fStarterOverridden.includes('CUSTOM_BRANDING'));

    let overriddenPassed = false;
    brandingMiddleware(reqStarter, resMock, (err) => {
      if (!err) overriddenPassed = true;
    });
    ok('Middleware allows access after feature override granted', overriddenPassed);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SUBSCRIPTION FEATURES SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

