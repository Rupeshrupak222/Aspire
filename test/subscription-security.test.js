// ============================================================================
// ASPIRE DAY 21: SUBSCRIPTION SECURITY & TENANT ISOLATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-security-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  getOrganizationSubscription,
  assignSubscription
} = require('../backend/src/services/subscription/subscription.service');
const {
  consumeQuota
} = require('../backend/src/services/subscription/quota.service');

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
  console.log('DAY 21: SUBSCRIPTION SECURITY & TENANT ISOLATION');
  console.log('====================================================\n');

  // Seed two distinct tenant organizations
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE'),
           (101, 'admin10@alpha.com', 'hash', 'Alpha Admin', 'ORG_ADMIN', 'ACTIVE'),
           (201, 'admin20@beta.com', 'hash', 'Beta Admin', 'ORG_ADMIN', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Tenant Alpha Corp', 'alpha-corp', 'ACTIVE'),
           (20, 'Tenant Beta Inc', 'beta-inc', 'ACTIVE')
  `).run();

  db.prepare('UPDATE users SET organization_id = 10 WHERE id = 101').run();
  db.prepare('UPDATE users SET organization_id = 20 WHERE id = 201').run();

  // Assign Starter to Alpha and Growth to Beta
  assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: 1 });
  assignSubscription({ organizationId: 20, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: 1 });

  try {
    console.log('--- 1. Multi-Tenant Query Scoping ---');
    const subAlpha = getOrganizationSubscription(10);
    const subBeta = getOrganizationSubscription(20);

    ok('Alpha subscription belongs to Org 10', subAlpha.organizationId === 10);
    ok('Alpha plan is STARTER', subAlpha.plan.code === 'STARTER');
    ok('Beta subscription belongs to Org 20', subBeta.organizationId === 20);
    ok('Beta plan is GROWTH', subBeta.plan.code === 'GROWTH');
    ok('Alpha cannot see Beta subscription ID', subAlpha.id !== subBeta.id);

    console.log('\n--- 2. Usage Isolation ---');
    consumeQuota({
      organizationId: 10,
      resourceKey: 'candidates',
      quantity: 50,
      referenceType: 'test'
    });

    const counterAlpha = db.prepare('SELECT used FROM organization_usage_counters WHERE organization_id = 10 AND resource_key = ?').get('candidates');
    const counterBeta = db.prepare('SELECT used FROM organization_usage_counters WHERE organization_id = 20 AND resource_key = ?').get('candidates');

    ok('Alpha candidates counter recorded 50', counterAlpha.used === 50);
    ok('Beta candidates counter is null/0 (unaffected by Alpha usage)', !counterBeta || counterBeta.used === 0);

    console.log('\n--- 3. Suspended Subscription Enforcement ---');
    assignSubscription({
      organizationId: 10,
      planCodeOrId: 'STARTER',
      status: 'SUSPENDED',
      notes: 'Suspended for audit testing',
      actorId: 1
    });

    let suspendedBlocked = false;
    let suspendedErrCode = null;
    try {
      consumeQuota({
        organizationId: 10,
        resourceKey: 'candidates',
        quantity: 1,
        referenceType: 'test'
      });
    } catch (err) {
      suspendedBlocked = true;
      suspendedErrCode = err.code;
    }

    ok('Suspended organization quota consumption blocked', suspendedBlocked);
    ok('Error code is SUBSCRIPTION_INACTIVE', suspendedErrCode === 'SUBSCRIPTION_INACTIVE');

    console.log('\n--- 4. Cross-Tenant Subscription Re-activation Defense ---');
    // Re-activate Alpha cleanly
    assignSubscription({
      organizationId: 10,
      planCodeOrId: 'STARTER',
      status: 'ACTIVE',
      actorId: 1
    });
    const subAlphaReactivated = getOrganizationSubscription(10);
    ok('Alpha re-activated successfully', subAlphaReactivated.status === 'ACTIVE');

    // Ensure Beta subscription remained undisturbed
    const subBetaCheck = getOrganizationSubscription(20);
    ok('Beta subscription still GROWTH and ACTIVE', subBetaCheck.plan.code === 'GROWTH' && subBetaCheck.status === 'ACTIVE');

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SUBSCRIPTION SECURITY SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

