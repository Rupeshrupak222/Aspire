// ============================================================================
// ASPIRE DAY 22: USAGE METERING — REST API TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-meter-api-${Date.now()}-${Math.floor(Math.random() * 1000)}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'metering_api_secret_key_32bytes_min_length!';

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
  console.log('DAY 22: USAGE METERING — REST API TEST SUITE');
  console.log('====================================================\n');

  const app = createApp();

  try {
    // 1. Setup Orgs
    db.prepare(`
      INSERT INTO organizations (id, name, slug, status)
      VALUES (10, 'Apex Assessment Academy', 'apex-academy', 'ACTIVE')
    `).run();

    // 2. Setup Users
    const superAdmin = await userService.createUser({
      email: 'super@adyapan.test',
      password: 'SuperPassword123!',
      name: 'Super Admin',
      role: ROLES.SUPER_ADMIN
    });

    const orgAdmin = await userService.createUser({
      email: 'admin@apex.test',
      password: 'ApexPassword123!',
      name: 'Apex Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: 10
    });

    assignSubscription({ organizationId: 10, planCodeOrId: 'GROWTH', status: 'ACTIVE', actorId: superAdmin.id });

    // Seed some usage data
    recordUsageEvent({
      organizationId: 10,
      resourceKey: 'candidates',
      eventType: 'CONSUMED',
      quantity: 15,
      idempotencyKey: 'seed_cand_15',
      occurredAt: '2026-11-05T12:00:00.000Z'
    });

    db.prepare(`
      INSERT INTO organization_storage_objects (
        organization_id, storage_key, category, file_name, mime_type, size_bytes, provider
      ) VALUES (
        10, 'organizations/10/branding/logo.png', 'branding', 'logo.png', 'image/png', 1048576, 'LOCAL'
      )
    `).run();

    // 3. Authenticate
    const superLogin = await request(app).post('/api/auth/login').send({ email: 'super@adyapan.test', password: 'SuperPassword123!' });
    const superToken = superLogin.body.data.token;

    const adminLogin = await request(app).post('/api/auth/login').send({ email: 'admin@apex.test', password: 'ApexPassword123!' });
    const adminToken = adminLogin.body.data.token;

    console.log('--- 1. Organization Usage Overview ---');
    const overviewRes = await request(app)
      .get('/api/organization/usage/overview')
      .set('Authorization', `Bearer ${adminToken}`);
    ok('GET /api/organization/usage/overview returns 200', overviewRes.status === 200);
    ok('Overview returns organization metadata', overviewRes.body.data.organization.name === 'Apex Assessment Academy');
    ok('Overview returns resources snapshot', !!overviewRes.body.data.resources.candidates);
    ok('Overview returns plan and subscription', overviewRes.body.data.subscription.planCode === 'GROWTH');

    console.log('\n--- 2. Organization Usage Resources Breakdown ---');
    const resourcesRes = await request(app)
      .get('/api/organization/usage/resources')
      .set('Authorization', `Bearer ${adminToken}`);
    ok('GET /api/organization/usage/resources returns 200', resourcesRes.status === 200);
    ok('Resources breakdown returns candidates, attempts, exams, questions, certificates, codeExecutions, storage',
      !!resourcesRes.body.data.candidates &&
      !!resourcesRes.body.data.attempts &&
      !!resourcesRes.body.data.exams &&
      !!resourcesRes.body.data.questions &&
      !!resourcesRes.body.data.certificates &&
      !!resourcesRes.body.data.codeExecutions &&
      !!resourcesRes.body.data.storage
    );

    console.log('\n--- 3. Organization Usage Trends ---');
    const trendsRes = await request(app)
      .get('/api/organization/usage/trends?resource_key=candidates&start_date=2026-11-01&end_date=2026-11-10')
      .set('Authorization', `Bearer ${adminToken}`);
    ok('GET /api/organization/usage/trends returns 200', trendsRes.status === 200);
    ok('Trends returns dates list', Array.isArray(trendsRes.body.data.dates) && trendsRes.body.data.dates.length === 10);
    ok('Trends returns series for candidates', Array.isArray(trendsRes.body.data.series.candidates));

    console.log('\n--- 4. Organization Usage History ---');
    const historyRes = await request(app)
      .get('/api/organization/usage/history?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    ok('GET /api/organization/usage/history returns 200', historyRes.status === 200);
    ok('History returns pagination metadata', historyRes.body.data.pagination.page === 1 && historyRes.body.data.pagination.limit === 10);
    ok('History events array returned', Array.isArray(historyRes.body.data.events) && historyRes.body.data.events.length > 0);

    console.log('\n--- 5. Organization Storage Footprint ---');
    const storageRes = await request(app)
      .get('/api/organization/usage/storage')
      .set('Authorization', `Bearer ${adminToken}`);
    ok('GET /api/organization/usage/storage returns 200', storageRes.status === 200);
    ok('Storage total bytes is 1048576', storageRes.body.data.totalBytes === 1048576);
    ok('Storage total objects is 1', storageRes.body.data.totalObjects === 1);
    ok('Branding category present', storageRes.body.data.categories.some((c) => c.category === 'branding'));

    console.log('\n--- 6. Super Admin Usage Overview ---');
    const adminOverviewRes = await request(app)
      .get('/api/admin/usage/overview')
      .set('Authorization', `Bearer ${superToken}`);
    ok('GET /api/admin/usage/overview returns 200', adminOverviewRes.status === 200);
    ok('Platform totals returned', !!adminOverviewRes.body.data.platformTotals);
    ok('Organization snapshots returned', Array.isArray(adminOverviewRes.body.data.organizationSnapshots));

    console.log('\n--- 7. Super Admin Organization Usage Snapshot ---');
    const adminOrgRes = await request(app)
      .get('/api/admin/usage/organizations/10')
      .set('Authorization', `Bearer ${superToken}`);
    ok('GET /api/admin/usage/organizations/10 returns 200', adminOrgRes.status === 200);
    ok('Organization 10 snapshot matches', adminOrgRes.body.data.organization.id === 10);

    console.log('\n--- 8. Super Admin Usage Trends ---');
    const adminTrendsRes = await request(app)
      .get('/api/admin/usage/trends?organization_id=10&resource_key=candidates&start_date=2026-11-01&end_date=2026-11-05')
      .set('Authorization', `Bearer ${superToken}`);
    ok('GET /api/admin/usage/trends returns 200', adminTrendsRes.status === 200);
    ok('Admin trends returns dates', Array.isArray(adminTrendsRes.body.data.dates));

    console.log('\n--- 9. Super Admin Reconciliation Trigger & Report Fetch ---');
    const reconPostRes = await request(app)
      .post('/api/admin/usage/reconcile')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ organizationId: 10, mode: 'DRY_RUN' });
    ok('POST /api/admin/usage/reconcile returns 200', reconPostRes.status === 200);
    ok('Reconciliation job ID returned', !!reconPostRes.body.data.jobId);

    const jobId = reconPostRes.body.data.jobId;
    const reconGetRes = await request(app)
      .get(`/api/admin/usage/reconciliation/${jobId}`)
      .set('Authorization', `Bearer ${superToken}`);
    ok('GET /api/admin/usage/reconciliation/:jobId returns 200', reconGetRes.status === 200);
    ok('Reconciliation job details returned with status COMPLETED', reconGetRes.body.data.status === 'COMPLETED');
    ok('Job report includes organization reports', !!reconGetRes.body.data.report);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`API METERING SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
