// ============================================================================
// ASPIRE DAY 22: USAGE METERING — SECURITY & RBAC TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-sec-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'metering_security_secret_32bytes_min_length!';

const request = require('supertest');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const userService = require('../backend/src/services/user.service');
const { ROLES } = require('../backend/src/security/rbac');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
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
  console.log('DAY 22: USAGE METERING — SECURITY & RBAC TEST SUITE');
  console.log('====================================================\n');

  const app = createApp();

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Tenant Alpha Corp', 'alpha-corp', 'ACTIVE'),
             (20, 'Tenant Beta Inc', 'beta-inc', 'ACTIVE')
    `).run();

    // 2. Setup Users
    const superAdmin = await userService.createUser({
      email: 'super@adyapan.test',
      password: 'SuperPassword123!',
      name: 'Super Admin',
      role: ROLES.SUPER_ADMIN
    });

    const orgAdminA = await userService.createUser({
      email: 'admin@alpha.test',
      password: 'OrgAPassword123!',
      name: 'Alpha Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: 10
    });

    const orgAdminB = await userService.createUser({
      email: 'admin@beta.test',
      password: 'OrgBPassword123!',
      name: 'Beta Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: 20
    });

    assignSubscription({ organizationId: 10, planCodeOrId: 'STARTER', status: 'ACTIVE', actorId: superAdmin.id });
    assignSubscription({ organizationId: 20, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: superAdmin.id });

    // Login tokens
    const superRes = await request(app).post('/api/auth/login').send({ email: 'super@adyapan.test', password: 'SuperPassword123!' });
    const superToken = superRes.body.data.token;

    const adminARes = await request(app).post('/api/auth/login').send({ email: 'admin@alpha.test', password: 'OrgAPassword123!' });
    const tokenA = adminARes.body.data.token;

    const adminBRes = await request(app).post('/api/auth/login').send({ email: 'admin@beta.test', password: 'OrgBPassword123!' });
    const tokenB = adminBRes.body.data.token;

    console.log('--- 1. Unauthenticated Access Rejection ---');
    const unauthOverview = await request(app).get('/api/organization/usage/overview');
    ok('Unauthenticated tenant overview rejected (HTTP 401)', unauthOverview.status === 401);

    const unauthRecon = await request(app).post('/api/admin/usage/reconcile').send({ mode: 'DRY_RUN' });
    ok('Unauthenticated admin reconcile rejected (HTTP 401)', unauthRecon.status === 401);

    console.log('\n--- 2. RBAC: Org Admin Cannot Trigger Admin Reconciliation ---');
    const forbiddenRecon = await request(app)
      .post('/api/admin/usage/reconcile')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ mode: 'DRY_RUN' });
    ok('Org Admin rejected from Super Admin reconcile endpoint (HTTP 403)', forbiddenRecon.status === 403);

    const forbiddenAdminOverview = await request(app)
      .get('/api/admin/usage/overview')
      .set('Authorization', `Bearer ${tokenA}`);
    ok('Org Admin rejected from Super Admin usage overview (HTTP 403)', forbiddenAdminOverview.status === 403);

    console.log('\n--- 3. Tenant Isolation: Org A and Org B Scoping ---');
    // Record usage for Org A and Org B
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 5,
      idempotencyKey: 'sec_cand_a_1'
    });
    recordUsageEvent({
      organizationId: 20,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 12,
      idempotencyKey: 'sec_cand_b_1'
    });

    const resA = await request(app)
      .get('/api/organization/usage/overview')
      .set('Authorization', `Bearer ${tokenA}`);
    ok('Org A overview returns HTTP 200', resA.status === 200);
    ok('Org A only sees its own organizationId', resA.body.data.organization.id === 10);

    const resB = await request(app)
      .get('/api/organization/usage/overview')
      .set('Authorization', `Bearer ${tokenB}`);
    ok('Org B overview returns HTTP 200', resB.status === 200);
    ok('Org B only sees its own organizationId', resB.body.data.organization.id === 20);

    console.log('\n--- 4. Super Admin Can Access Usage Cross-Tenant & Run Reconcile ---');
    const superOrgA = await request(app)
      .get('/api/admin/usage/organizations/10')
      .set('Authorization', `Bearer ${superToken}`);
    ok('Super Admin can view Org A usage (HTTP 200)', superOrgA.status === 200);
    ok('Super Admin Org A response matches org 10', superOrgA.body.data.organization.id === 10);

    const superReconRes = await request(app)
      .post('/api/admin/usage/reconcile')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ organizationId: 10, mode: 'DRY_RUN' });
    ok('Super Admin can execute reconciliation (HTTP 200)', superReconRes.status === 200);
    ok('Super Admin reconciliation report returned', !!superReconRes.body.data.jobId);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SECURITY METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

