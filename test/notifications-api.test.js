// ============================================================================
// ASPIRE DAY 23: NOTIFICATIONS REST API TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-api-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'notification_api_secret_key_32bytes_min!';

const request = require('supertest');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const userService = require('../backend/src/services/user.service');
const { ROLES } = require('../backend/src/security/rbac');
const { setEmailProvider, resetEmailProvider } = require('../backend/src/services/notifications/email.service');
const { MockEmailProvider } = require('../backend/src/services/notifications/providers/mock.provider');
const { queueNotification } = require('../backend/src/services/notifications/notification.service');

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
  console.log('DAY 23: NOTIFICATIONS REST API TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  const app = createApp();

  try {
    // 1. Setup Organization & Users
    db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

    const superAdmin = await userService.createUser({
      email: 'super@notif.test',
      password: 'SuperPassword123!',
      name: 'Super Admin',
      role: ROLES.SUPER_ADMIN
    });

    const orgAdmin = await userService.createUser({
      email: 'admin@notif.test',
      password: 'OrgPassword123!',
      name: 'Org Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: 1
    });

    // Seed test exam
    db.prepare(`
      INSERT INTO exams (id, organization_id, code, name, duration_minutes, status, is_default, created_by)
      VALUES (77, 1, 'EXAM-API-77', 'Computer Science Scholarship Evaluation', 90, 'PUBLISHED', 0, ${orgAdmin.id})
    `).run();

    // Authenticate
    const superLogin = await request(app).post('/api/auth/login').send({ email: 'super@notif.test', password: 'SuperPassword123!' });
    const superToken = superLogin.body.data.token;

    const orgLogin = await request(app).post('/api/auth/login').send({ email: 'admin@notif.test', password: 'OrgPassword123!' });
    const orgToken = orgLogin.body.data.token;

    console.log('--- 1. POST /api/organization/exams/:id/invite ---');
    const inviteRes = await request(app)
      .post('/api/organization/exams/77/invite')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({
        candidates: [
          { email: 'api.candidate1@example.com', name: 'API Candidate One' },
          { email: 'api.candidate2@example.com', name: 'API Candidate Two' }
        ],
        scheduledReminderHours: [24]
      });

    ok('POST /exams/:id/invite status is 201', inviteRes.status === 201);
    ok('Invite response returns count 2', inviteRes.body.data.count === 2);
    ok('Invitations list returned with tokens', inviteRes.body.data.invitations.length === 2);
    ok('Tokens are unique', inviteRes.body.data.invitations[0].invitationToken !== inviteRes.body.data.invitations[1].invitationToken);

    console.log('\n--- 2. GET /api/organization/notifications ---');
    const listRes = await request(app)
      .get('/api/organization/notifications')
      .set('Authorization', `Bearer ${orgToken}`);

    ok('GET /notifications status is 200', listRes.status === 200);
    ok('Deliveries array returned', Array.isArray(listRes.body.data));
    ok('Deliveries list contains generated invitations', listRes.body.data.length >= 2);
    ok('Metrics object included in response', Boolean(listRes.body.metrics));
    ok('Pagination metadata included', Boolean(listRes.body.pagination));

    const sampleDeliveryId = listRes.body.data[0].id;

    console.log('\n--- 3. GET /api/organization/notifications/:id ---');
    const detailRes = await request(app)
      .get(`/api/organization/notifications/${sampleDeliveryId}`)
      .set('Authorization', `Bearer ${orgToken}`);

    ok('GET /notifications/:id status is 200', detailRes.status === 200);
    ok('Detail matches requested ID', detailRes.body.data.id === sampleDeliveryId);
    ok('Channel is EMAIL', detailRes.body.data.channel === 'EMAIL');

    console.log('\n--- 4. Preferences GET & PUT ---');
    const getPrefRes = await request(app)
      .get('/api/organization/notifications/preferences')
      .set('Authorization', `Bearer ${orgToken}`);

    ok('GET /notifications/preferences status is 200', getPrefRes.status === 200);
    ok('Preferences returned with emailEnabled: true', getPrefRes.body.data.emailEnabled === true);

    const updatePrefRes = await request(app)
      .put('/api/organization/notifications/preferences')
      .set('Authorization', `Bearer ${orgToken}`)
      .send({ exam_reminders: false, certificate_updates: false });

    ok('PUT /notifications/preferences status is 200', updatePrefRes.status === 200);
    ok('Preferences updated examReminders: false', updatePrefRes.body.data.examReminders === false);
    ok('Preferences updated certificateUpdates: false', updatePrefRes.body.data.certificateUpdates === false);

    console.log('\n--- 5. POST /api/organization/notifications/:id/retry ---');
    const retryRes = await request(app)
      .post(`/api/organization/notifications/${sampleDeliveryId}/retry`)
      .set('Authorization', `Bearer ${orgToken}`);

    ok('POST /notifications/:id/retry status is 200', retryRes.status === 200);
    ok('Retry response confirms success', retryRes.body.success === true);

    console.log('\n--- 6. Super Admin Notification Endpoints ---');
    const superOverviewRes = await request(app)
      .get('/api/admin/notifications/overview')
      .set('Authorization', `Bearer ${superToken}`);

    ok('GET /admin/notifications/overview status is 200', superOverviewRes.status === 200);
    ok('Provider status returned', Boolean(superOverviewRes.body.data.provider));
    ok('Platform metrics returned', Boolean(superOverviewRes.body.data.metrics));

    const superDeliveriesRes = await request(app)
      .get('/api/admin/notifications/deliveries?limit=10')
      .set('Authorization', `Bearer ${superToken}`);

    ok('GET /admin/notifications/deliveries status is 200', superDeliveriesRes.status === 200);
    ok('Super Admin can list deliveries platform-wide', superDeliveriesRes.body.data.length >= 2);

    const superOrgMetricsRes = await request(app)
      .get('/api/admin/notifications/organizations/1')
      .set('Authorization', `Bearer ${superToken}`);

    ok('GET /admin/notifications/organizations/:id status is 200', superOrgMetricsRes.status === 200);
    ok('Organization metrics returned', Boolean(superOrgMetricsRes.body.data.metrics));

    console.log('\n--- 7. POST /api/webhooks/email/resend ---');
    // Unsigned webhook should be rejected with 401
    const unsignedRes = await request(app)
      .post('/api/webhooks/email/resend')
      .send({ type: 'email.delivered', data: { email_id: 'some_msg_id' } });

    ok('Unsigned webhook returns 401', unsignedRes.status === 401);

    // Mock-signed webhook in test mode
    const signedRes = await request(app)
      .post('/api/webhooks/email/resend')
      .set('x-mock-signature', 'valid_mock_signature')
      .send({ type: 'email.delivered', data: { email_id: 'sample_msg_mock_001' } });

    ok('Signed webhook returns 200', signedRes.status === 200);
    ok('Webhook confirms receipt', signedRes.body.received === true);

  } catch (err) {
    failures++;
    console.error('Unexpected test error:', err);
  } finally {
    resetEmailProvider();
    try {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    } catch {}
    process.exit(failures > 0 ? 1 : 0);
  }
}

run();

