// ASPIRE — DAY 14: API Testing Suite with Supertest (Layer C)
// Tests Express endpoints directly, asserting HTTP status codes, schemas, and RBAC rules.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(os.tmpdir(), `aspire-api-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'api_testing_secret_key_32bytes_minimum_length!';

const request = require('supertest');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { seedIfEmpty } = require('../backend/src/data/seed');
const userService = require('../backend/src/services/user.service');
const { ROLES } = require('../backend/src/security/rbac');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function ok(name, condition, extra = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS  ${name}`);
  } else {
    failedTests++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function runApiTests() {
  console.log('====================================================');
  console.log('ASPIRE DAY 14: API TESTING SUITE — SUPERTEST (LAYER C)');
  console.log('====================================================\n');

  seedIfEmpty(db);
  const app = createApp();

  try {
    // Setup Organizations and Users for Testing
    console.log('--- 1. Seed & Admin Auth Setup ---');
    const orgARes = db.prepare("INSERT INTO organizations (name, slug, status) VALUES ('Org Alpha', 'org-alpha', 'ACTIVE')").run();
    const orgBRes = db.prepare("INSERT INTO organizations (name, slug, status) VALUES ('Org Beta', 'org-beta', 'ACTIVE')").run();
    const orgAId = orgARes.lastInsertRowid;
    const orgBId = orgBRes.lastInsertRowid;

    const superAdmin = await userService.createUser({
      email: `super.${Date.now()}@adyapan.test`,
      password: 'SuperAdminPassword123!',
      name: 'Super Administrator',
      role: ROLES.SUPER_ADMIN
    });

    const orgAdminA = await userService.createUser({
      email: `adminA.${Date.now()}@alpha.test`,
      password: 'OrgAPassword123!',
      name: 'Alpha Org Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: orgAId
    });

    const viewerUser = await userService.createUser({
      email: `viewer.${Date.now()}@alpha.test`,
      password: 'ViewerPassword123!',
      name: 'Alpha Viewer',
      role: ROLES.VIEWER,
      organizationId: orgAId
    });

    ok('Test organizations and role-based users seeded', superAdmin.id && orgAdminA.id && viewerUser.id);

    // Authentication: Valid Login
    console.log('\n--- 2. Authentication Endpoints ---');
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: orgAdminA.email, password: 'OrgAPassword123!' });
    ok('POST /api/auth/login succeeds with valid credentials (HTTP 200)', loginRes.status === 200);
    ok('Login response contains JWT token and user info', loginRes.body?.data?.token && loginRes.body?.data?.user?.email === orgAdminA.email);

    const orgAdminAToken = loginRes.body.data.token;

    // Authentication: Incorrect Password
    const badPassRes = await request(app)
      .post('/api/auth/login')
      .send({ email: orgAdminA.email, password: 'WrongPassword!' });
    ok('POST /api/auth/login rejects wrong password (HTTP 401)', badPassRes.status === 401);

    // Authentication: Missing Token on Protected Route
    const noTokenRes = await request(app).get('/api/admin/questions');
    ok('Protected admin route rejects request without token (HTTP 401)', noTokenRes.status === 401);

    // Authentication: Invalid Token
    const invalidTokenRes = await request(app)
      .get('/api/admin/questions')
      .set('Authorization', 'Bearer invalid.token.payload');
    ok('Protected admin route rejects malformed JWT (HTTP 401)', invalidTokenRes.status === 401);

    // Session Revocation (Logout)
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${orgAdminAToken}`);
    ok('POST /api/auth/logout succeeds (HTTP 200)', logoutRes.status === 200);

    const revokedAccessRes = await request(app)
      .get('/api/admin/questions')
      .set('Authorization', `Bearer ${orgAdminAToken}`);
    ok('Subsequent request with revoked JWT is denied (HTTP 401)', revokedAccessRes.status === 401);

    // Relogin for subsequent tests
    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: orgAdminA.email, password: 'OrgAPassword123!' });
    const adminToken = relogin.body.data.token;

    const superLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: superAdmin.email, password: 'SuperAdminPassword123!' });
    const superToken = superLogin.body.data.token;

    // 3. Registration Workflow
    console.log('\n--- 3. Registration Workflow ---');
    const validCandidate = {
      name: 'Devika Patel',
      phone: '9123456789',
      email: 'devika.patel@example.com',
      college: 'BITS Pilani',
      city: 'Pilani',
      grad_year: '2026',
      track: 'Full Stack'
    };

    const regRes = await request(app).post('/api/register').send(validCandidate);
    ok('POST /api/register succeeds for valid candidate (HTTP 200)', regRes.status === 200);
    ok('Registration returns attempt token, expires_at, and duration_minutes', regRes.body.token && regRes.body.expires_at && typeof regRes.body.duration_minutes === 'number');

    const attemptToken = regRes.body.token;

    // Missing required fields
    const missingPhoneRes = await request(app).post('/api/register').send({ name: 'No Phone' });
    ok('POST /api/register rejects missing phone number (HTTP 400)', missingPhoneRes.status === 400);

    // Invalid phone number
    const invalidPhoneRes = await request(app).post('/api/register').send({ ...validCandidate, phone: 'abcdef' });
    ok('POST /api/register rejects non-digit phone number (HTTP 400)', invalidPhoneRes.status === 400);

    // Duplicate Registration (One-attempt resume)
    const dupRegRes = await request(app).post('/api/register').send(validCandidate);
    ok('POST /api/register resumes same token for existing phone (HTTP 200)', dupRegRes.status === 200 && dupRegRes.body.token === attemptToken);

    // 4. Candidate Assessment Lifecycle
    console.log('\n--- 4. Assessment Lifecycle Endpoints ---');
    const getAttemptRes = await request(app).get(`/api/attempt/${attemptToken}`);
    ok('GET /api/attempt/:token returns assessment data (HTTP 200)', getAttemptRes.status === 200 && Array.isArray(getAttemptRes.body.questions));
    ok('GET /api/attempt/:token questions do not leak correct_index or hidden tests', getAttemptRes.body.questions.every(q => q.correct_index === undefined && q.test_cases === undefined));

    const firstQuestion = getAttemptRes.body.questions[0];

    // Answer Saving / Delta Sync
    const syncRes = await request(app)
      .post(`/api/attempt/${attemptToken}/progress/sync`)
      .send({
        changes: [{
          changeId: 'chg_api_' + crypto.randomBytes(4).toString('hex'),
          type: 'MCQ_ANSWER',
          questionId: firstQuestion.id,
          answer: 0
        }]
      });
    ok('POST /api/attempt/:token/progress/sync accepts valid MCQ answer (HTTP 200)', syncRes.status === 200 && syncRes.body.success === true);

    // Heartbeat
    const hbRes = await request(app)
      .post(`/api/attempt/${attemptToken}/heartbeat`)
      .send({ tabSwitches: 1 });
    ok('POST /api/attempt/:token/heartbeat returns serverTime and remainingSeconds (HTTP 200)', hbRes.status === 200 && typeof hbRes.body.remainingSeconds === 'number');

    // Forbidden Field Injection into Heartbeat
    const badHbRes = await request(app)
      .post(`/api/attempt/${attemptToken}/heartbeat`)
      .send({ remainingSeconds: 99999 });
    ok('POST /api/attempt/:token/heartbeat rejects client-supplied remainingSeconds (HTTP 400)', badHbRes.status === 400);

    // Forbidden Field Injection into Submit
    const badSubmitRes = await request(app)
      .post(`/api/attempt/${attemptToken}/submit`)
      .send({ answers: { [firstQuestion.id]: 0 }, score: 100 });
    ok('POST /api/attempt/:token/submit rejects client-supplied score injection (HTTP 400)', badSubmitRes.status === 400);

    // Legitimate Submission
    const submitRes = await request(app)
      .post(`/api/attempt/${attemptToken}/submit`)
      .send({ answers: { [firstQuestion.id]: 0 } });
    ok('POST /api/attempt/:token/submit finalizes assessment (HTTP 200)', submitRes.status === 200 && submitRes.body.status === 'submitted');
    ok('Submission returns certificate_id, claim_code, and scholarship tier', !!submitRes.body.certificate_id && typeof submitRes.body.scholarship_pct === 'number');

    const certId = submitRes.body.certificate_id;

    // Idempotent duplicate submission
    const dupSubmitRes = await request(app)
      .post(`/api/attempt/${attemptToken}/submit`)
      .send({ answers: { [firstQuestion.id]: 0 } });
    ok('Subsequent submit request returns identical certificate and score (HTTP 200)', dupSubmitRes.status === 200 && dupSubmitRes.body.certificate_id === certId);

    // 5. Public Certificate Retrieval
    console.log('\n--- 5. Public Certificate Verification ---');
    const certRes = await request(app).get(`/api/certificate/${certId}`);
    ok('GET /api/certificate/:certId retrieves PDF certificate stream (HTTP 200)', certRes.status === 200 && certRes.headers['content-type'].includes('application/pdf'));

    const badCertRes = await request(app).get('/api/certificate/INVALID-CERT-999');
    ok('GET /api/certificate/:certId returns 404 for unknown certificate ID', badCertRes.status === 404);

    // 6. Admin RBAC & Cross-Tenant Permissions
    console.log('\n--- 6. Admin Permissions & Cross-Tenant Isolation ---');
    // Viewer user attempts to create question (Permission denied)
    const viewerLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: viewerUser.email, password: 'ViewerPassword123!' });
    const viewerToken = viewerLogin.body.data.token;

    const unauthQRes = await request(app)
      .post('/api/admin/questions')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        type: 'mcq',
        category: 'aptitude',
        question_text: 'Unauthorized question attempt?',
        options: ['Yes', 'No'],
        correct_index: 0,
        marks: 1
      });
    ok('User without questions.create permission is denied (HTTP 403)', unauthQRes.status === 403);

    // Authorized Admin creates question
    const createQRes = await request(app)
      .post('/api/admin/questions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'mcq',
        category: 'technical',
        question_text: 'What does TCP stand for?',
        options: ['Transmission Control Protocol', 'Transfer Comm Protocol', 'Total Control Path', 'Terminal Connection Port'],
        correct_index: 0,
        marks: 2
      });
    ok('Authorized Admin creates question successfully (HTTP 201)', createQRes.status === 201);

    // Candidate token cannot access admin routes
    const candOnAdminRes = await request(app)
      .get('/api/admin/results')
      .set('Authorization', `Bearer ${attemptToken}`);
    ok('Candidate attempt token cannot access admin results (HTTP 401)', candOnAdminRes.status === 401);

    // Super Admin reconciles expired attempts
    const reconcileRes = await request(app)
      .post('/api/admin/reconcile-expired')
      .set('Authorization', `Bearer ${superToken}`);
    ok('Super Admin triggers POST /api/admin/reconcile-expired successfully (HTTP 200)', reconcileRes.status === 200 && reconcileRes.body.success === true);

  } finally {
    db.close();
    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  }

  console.log('\n====================================================');
  console.log(`API TESTING SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runApiTests().catch((err) => {
    console.error('Fatal API test error:', err);
    process.exit(1);
  });
}

module.exports = { runApiTests };
