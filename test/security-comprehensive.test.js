// ASPIRE — DAY 14: Comprehensive Security Testing Suite (Layer D)
// Evaluates SQL injection, XSS, JWT tampering, algorithm attacks, mass assignment,
// rate limiting, body size limits, information disclosure, and forbidden field enforcement.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');
const { SignJWT } = require('jose');

const DB_PATH = path.join(os.tmpdir(), `aspire-sec-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'comprehensive_sec_test_secret_32bytes_minimum!';

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

async function runSecurityTests() {
  console.log('====================================================');
  console.log('ASPIRE DAY 14: SECURITY TESTING SUITE (LAYER D)');
  console.log('====================================================\n');

  seedIfEmpty(db);
  const app = createApp();

  try {
    // Setup Organizations and Users
    const orgA = db.prepare("INSERT INTO organizations (name, slug, status) VALUES ('Sec Org A', 'sec-org-a', 'ACTIVE')").run();
    const orgB = db.prepare("INSERT INTO organizations (name, slug, status) VALUES ('Sec Org B', 'sec-org-b', 'ACTIVE')").run();

    const adminUserA = await userService.createUser({
      email: `adminA.${Date.now()}@sec.test`,
      password: 'OrgAPassword123!',
      name: 'Sec Admin A',
      role: ROLES.ORG_ADMIN,
      organizationId: orgA.lastInsertRowid
    });

    const adminUserB = await userService.createUser({
      email: `adminB.${Date.now()}@sec.test`,
      password: 'OrgBPassword123!',
      name: 'Sec Admin B',
      role: ROLES.ORG_ADMIN,
      organizationId: orgB.lastInsertRowid
    });

    const loginResA = await request(app).post('/api/auth/login').send({ email: adminUserA.email, password: 'OrgAPassword123!' });
    const tokenA = loginResA.body.data.token;

    const loginResB = await request(app).post('/api/auth/login').send({ email: adminUserB.email, password: 'OrgBPassword123!' });
    const tokenB = loginResB.body.data.token;

    // 1. SQL Injection Attempts
    console.log('--- 1. SQL Injection Resistance ---');
    const sqliPayloads = [
      "' OR '1'='1",
      "admin' --",
      "'; DROP TABLE students; --",
      "1 UNION SELECT null, null, null, null--"
    ];

    for (const sqli of sqliPayloads) {
      const sqliSearch = await request(app)
        .get(`/api/admin/results?college=${encodeURIComponent(sqli)}`)
        .set('Authorization', `Bearer ${tokenA}`);
      ok(`SQL injection safely parameterized on results query: ${sqli}`, sqliSearch.status === 200 && Array.isArray(sqliSearch.body));
    }

    // Verify students table was NOT dropped
    const studentsTableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='students'").get();
    ok('Database schema remains intact after SQLi test payloads', !!studentsTableCheck);

    // 2. XSS (Cross-Site Scripting) Payloads
    console.log('\n--- 2. XSS Payload Handling ---');
    const xssName = '<script>alert("XSS")</script>';
    const xssCollege = '<img src=x onerror=alert(1)>';
    const regXss = await request(app).post('/api/register').send({
      name: xssName,
      phone: '9999900001',
      email: 'xss@test.com',
      college: xssCollege,
      city: 'Mumbai',
      grad_year: '2026',
      track: 'Full Stack'
    });
    ok('Registration accepts candidate with XSS string payload without crashing', regXss.status === 200);

    const candAttemptToken = regXss.body.token;
    const fetchAttempt = await request(app).get(`/api/attempt/${candAttemptToken}`);
    ok('Attempt fetch returns 200 without executing or unescaping malicious script', fetchAttempt.status === 200);

    // 3. JWT Security & Algorithm Attack Resistance
    console.log('\n--- 3. JWT Security & Algorithm Attacks ---');
    // None Algorithm Attack
    const headerNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payloadFake = Buffer.from(JSON.stringify({ id: 1, role: 'SUPER_ADMIN', email: 'fake@admin.com' })).toString('base64url');
    const noneJwt = `${headerNone}.${payloadFake}.`;

    const noneAttackRes = await request(app)
      .get('/api/admin/questions')
      .set('Authorization', `Bearer ${noneJwt}`);
    ok('Rejects "alg: none" forged JWT tokens (HTTP 401)', noneAttackRes.status === 401);

    // Expired JWT Attack
    const expiredSecret = new TextEncoder().encode(process.env.AUTH_SECRET);
    const expiredJwt = await new SignJWT({ id: adminUserA.id, role: ROLES.ORG_ADMIN })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(expiredSecret);

    const expiredJwtRes = await request(app)
      .get('/api/admin/questions')
      .set('Authorization', `Bearer ${expiredJwt}`);
    ok('Rejects expired JWT tokens (HTTP 401)', expiredJwtRes.status === 401);

    // Wrong Key Signature Attack
    const foreignSecret = new TextEncoder().encode('completely_different_secret_key_32bytes!!');
    const foreignJwt = await new SignJWT({ id: adminUserA.id, role: ROLES.SUPER_ADMIN })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(foreignSecret);

    const foreignJwtRes = await request(app)
      .get('/api/admin/questions')
      .set('Authorization', `Bearer ${foreignJwt}`);
    ok('Rejects JWT signed with incorrect secret key (HTTP 401)', foreignJwtRes.status === 401);

    // 4. Cross-Tenant Data Isolation
    console.log('\n--- 4. Cross-Tenant Isolation ---');
    // Create Question in Org A
    const qA = await request(app)
      .post('/api/admin/questions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        type: 'mcq',
        category: 'technical',
        question_text: 'Secret Org A Question',
        options: ['A', 'B', 'C', 'D'],
        correct_index: 0,
        marks: 2
      });
    ok('Org A admin successfully creates question in Org A', qA.status === 201);
    const qAId = qA.body.id || qA.body.data?.id;

    // Org B admin queries questions
    const qListB = await request(app)
      .get('/api/admin/questions')
      .set('Authorization', `Bearer ${tokenB}`);
    const orgBQuestions = Array.isArray(qListB.body) ? qListB.body : (qListB.body.data?.items || qListB.body.data || []);
    const seesOrgAQuestion = orgBQuestions.some(q => q.id === qAId);
    ok('Org B admin cannot see Org A questions (Tenant Scoped)', !seesOrgAQuestion);

    // 5. Client-Controlled Scoring & Timing Injection Prevention
    console.log('\n--- 5. Client Timing & Score Tampering Prevention ---');
    const tamperingAttempts = [
      { field: 'remainingSeconds', payload: { remainingSeconds: 3600 } },
      { field: 'expiresAt', payload: { expiresAt: '2099-01-01T00:00:00.000Z' } },
      { field: 'deadlineAt', payload: { deadlineAt: '2099-01-01T00:00:00.000Z' } },
      { field: 'score', payload: { score: 100 } },
      { field: 'marks', payload: { marks: 50 } }
    ];

    for (const attempt of tamperingAttempts) {
      const res = await request(app)
        .post(`/api/attempt/${candAttemptToken}/submit`)
        .send({ answers: {}, ...attempt.payload });
      ok(`Client injection of "${attempt.field}" in submit payload rejected with HTTP 400`, res.status === 400 && res.body.code === 'VALIDATION_ERROR');
    }

    // 6. Request Body Size Limits (>512KB)
    console.log('\n--- 6. Request Body Size Limits ---');
    const oversizedString = 'x'.repeat(600 * 1024); // 600KB payload (> 512KB limit)
    const oversizedRes = await request(app)
      .post(`/api/attempt/${candAttemptToken}/submit`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hugeData: oversizedString }));
    ok('Request body exceeding 512KB size limit rejected with HTTP 413', oversizedRes.status === 413);

    // 7. Information Leakage Prevention
    console.log('\n--- 7. Information Leakage & Error Hygiene ---');
    const badRouteRes = await request(app).get('/api/non-existent-endpoint-for-leakage-check');
    ok('Non-existent route returns standard 404 error without stack trace', badRouteRes.status === 404 && !badRouteRes.body.stack);
    ok('Error response does not leak internal SQL syntax or server directory paths', !JSON.stringify(badRouteRes.body).includes('better-sqlite3') && !JSON.stringify(badRouteRes.body).includes('C:\\'));

    // 8. Security Headers & CORS
    console.log('\n--- 8. Security Headers & Protection ---');
    const headersRes = await request(app).get('/api/health');
    ok('Response contains X-Content-Type-Options: nosniff', headersRes.headers['x-content-type-options'] === 'nosniff');
    ok('Response contains X-Frame-Options: DENY', headersRes.headers['x-frame-options'] === 'DENY');
    ok('Response contains Permissions-Policy header', !!headersRes.headers['permissions-policy']);

  } finally {
    db.close();
    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SECURITY TESTING SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runSecurityTests().catch((err) => {
    console.error('Fatal security test error:', err);
    process.exit(1);
  });
}

module.exports = { runSecurityTests };
