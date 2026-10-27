// Comprehensive Automated Test Suite for Day 4 Authentication, RBAC, Multi-Tenancy, and Security Acceptance.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SignJWT } = require('jose');

const PORT = 3215;
const DB = path.join(os.tmpdir(), 'aspire-auth-rbac-test.db');
const AUTH_SECRET = 'aspire-super-secret-auth-key-32-chars-long!';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: r.status, data, raw: text, headers: r.headers };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {}
    await wait(300);
  }
  return false;
}

async function loginUser(email, password) {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  return {
    status: res.status,
    data: res.data,
    token: res.data?.data?.token,
    user: res.data?.data?.user,
    headers: res.data?.data?.token ? { Authorization: `Bearer ${res.data.data.token}` } : {}
  };
}

async function run() {
  try { fs.unlinkSync(DB); } catch {}
  try { fs.unlinkSync(DB + '-wal'); } catch {}
  try { fs.unlinkSync(DB + '-shm'); } catch {}

  console.log('[test-auth] Starting Aspire test server on port ' + PORT);
  const proc = spawn('node', ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      AUTH_SECRET,
      INITIAL_ADMIN_EMAIL: 'superadmin@adyapan.internal',
      INITIAL_ADMIN_PASSWORD: 'SuperPassword123!',
      INITIAL_ADMIN_NAME: 'Platform Super Admin',
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn'
    }
  });

  if (!await waitForServer()) {
    console.error('FAIL: Server failed to start');
    proc.kill();
    process.exit(1);
  }

  try {
    console.log('\n--- 1. Authentication & Login Security ---');
    {
      // 1.1 Valid Super Admin login
      const l1 = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');
      ok('valid credentials return 200', l1.status === 200);
      ok('response includes JWT token', typeof l1.token === 'string' && l1.token.length > 20);
      ok('response includes safe user object', l1.user && l1.user.email === 'superadmin@adyapan.internal');
      ok('response does not expose password_hash', l1.user && l1.user.password_hash === undefined);
      ok('user has role SUPER_ADMIN', l1.user && l1.user.role === 'SUPER_ADMIN');

      // 1.2 Case-insensitive email normalization
      const lCase = await loginUser('SuperAdmin@Adyapan.Internal', 'SuperPassword123!');
      ok('email normalization handles mixed case', lCase.status === 200);

      // 1.3 Wrong password
      const l2 = await loginUser('superadmin@adyapan.internal', 'WrongPassword!');
      ok('wrong password returns 401', l2.status === 401);
      ok('error code is AUTHENTICATION_REQUIRED', l2.data.code === 'AUTHENTICATION_REQUIRED');
      ok('generic error message prevents enumeration', l2.data.message.includes('Invalid email or password'));

      // 1.4 Unknown email
      const l3 = await loginUser('nonexistent@adyapan.internal', 'SuperPassword123!');
      ok('unknown email returns 401', l3.status === 401);
      ok('unknown email returns same generic message', l3.data.message.includes('Invalid email or password'));

      // 1.5 Missing fields
      const l4 = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'superadmin@adyapan.internal' }) });
      ok('missing password returns 400', l4.status === 400);
      ok('code is VALIDATION_ERROR', l4.data.code === 'VALIDATION_ERROR');

      // 1.6 Malformed email
      const l5 = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'not-an-email', password: 'abc' }) });
      ok('malformed email returns 400', l5.status === 400);

      // 1.7 /api/auth/me returns current user
      const meRes = await api('/api/auth/me', { headers: l1.headers });
      ok('/api/auth/me returns 200', meRes.status === 200);
      ok('/api/auth/me returns correct user', meRes.data.data.user.email === 'superadmin@adyapan.internal');
      ok('/api/auth/me includes permissions array', Array.isArray(meRes.data.data.user.permissions));
    }

    console.log('\n--- 2. Token Security, Expiration & Revocation ---');
    {
      const superAuth = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');

      // 2.1 No token
      const t1 = await api('/api/admin/questions');
      ok('no token returns 401', t1.status === 401);

      // 2.2 Invalid / garbage token
      const t2 = await api('/api/admin/questions', { headers: { Authorization: 'Bearer not.a.valid.jwt' } });
      ok('invalid token returns 401', t2.status === 401);

      // 2.3 Tampered token signature
      const validToken = superAuth.token;
      const parts = validToken.split('.');
      // Tamper signature
      const tampered = parts[0] + '.' + parts[1] + '.invalidsignature';
      const t3 = await api('/api/admin/questions', { headers: { Authorization: `Bearer ${tampered}` } });
      ok('tampered token signature returns 401', t3.status === 401);

      // 2.4 Token signed with wrong secret
      const wrongKey = new TextEncoder().encode('wrong-secret-key-that-does-not-match!');
      const rogueToken = await new SignJWT({ sub: '1', role: 'SUPER_ADMIN' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(wrongKey);
      const t4 = await api('/api/admin/questions', { headers: { Authorization: `Bearer ${rogueToken}` } });
      ok('token with wrong secret returns 401', t4.status === 401);

      // 2.5 Expired token
      const secretKey = new TextEncoder().encode(AUTH_SECRET);
      const expiredToken = await new SignJWT({ sub: '1', role: 'SUPER_ADMIN' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
        .sign(secretKey);
      const t5 = await api('/api/admin/questions', { headers: { Authorization: `Bearer ${expiredToken}` } });
      ok('expired token returns 401', t5.status === 401);
      ok('expired token message identifies expiration', t5.data.message.toLowerCase().includes('expired'));

      // 2.6 Old development admin token rejection
      const tOld = await api('/api/admin/questions', { headers: { 'x-admin-token': 'aspire_admin_secret_token' } });
      ok('old x-admin-token header returns 401', tOld.status === 401);

      // 2.7 Logout revokes session immediately
      const sessionUser = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');
      const sessionToken = sessionUser.token;
      const validBefore = await api('/api/admin/questions', { headers: { Authorization: `Bearer ${sessionToken}` } });
      ok('token valid before logout', validBefore.status === 200);

      const logoutRes = await api('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
      ok('logout returns 200', logoutRes.status === 200);

      const invalidAfter = await api('/api/admin/questions', { headers: { Authorization: `Bearer ${sessionToken}` } });
      ok('token rejected after logout (401)', invalidAfter.status === 401);
      ok('logout message identifies revocation', invalidAfter.data.message.includes('revoked') || invalidAfter.data.message.includes('expired'));
    }

    console.log('\n--- 3. Provisioning Roles & Multi-Tenancy Hierarchy ---');
    let orgAId, orgBId;
    let orgAdminAHeaders, orgAdminBHeaders, examMgrHeaders, evaluatorHeaders, viewerHeaders;
    let orgAdminAId, evaluatorId;
    {
      const superAuth = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');

      // Create Organization A (Alpha University)
      const orgARes = await api('/api/admin/organizations', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({ name: 'Alpha University', slug: 'alpha-univ' })
      });
      ok('create Organization A returns 201', orgARes.status === 201);
      orgAId = orgARes.data.id;

      // Create Organization B (Beta Institute)
      const orgBRes = await api('/api/admin/organizations', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({ name: 'Beta Institute', slug: 'beta-inst' })
      });
      ok('create Organization B returns 201', orgBRes.status === 201);
      orgBId = orgBRes.data.id;

      // Provision Organization Admin A
      const uOrgA = await api('/api/admin/users', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({
          email: 'admin@alpha.edu',
          password: 'AlphaPassword123!',
          name: 'Alpha Admin',
          role: 'ORG_ADMIN',
          organization_id: orgAId
        })
      });
      ok('create ORG_ADMIN A returns 201', uOrgA.status === 201);
      orgAdminAId = uOrgA.data.id;

      // Provision Organization Admin B
      const uOrgB = await api('/api/admin/users', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({
          email: 'admin@beta.edu',
          password: 'BetaPassword123!',
          name: 'Beta Admin',
          role: 'ORG_ADMIN',
          organization_id: orgBId
        })
      });
      ok('create ORG_ADMIN B returns 201', uOrgB.status === 201);

      // Provision Exam Manager (Org A)
      const uMgr = await api('/api/admin/users', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({
          email: 'manager@alpha.edu',
          password: 'ManagerPassword123!',
          name: 'Alpha Exam Manager',
          role: 'EXAM_MANAGER',
          organization_id: orgAId
        })
      });
      ok('create EXAM_MANAGER returns 201', uMgr.status === 201);

      // Provision Evaluator (Org A)
      const uEval = await api('/api/admin/users', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({
          email: 'evaluator@alpha.edu',
          password: 'EvalPassword123!',
          name: 'Alpha Evaluator',
          role: 'EVALUATOR',
          organization_id: orgAId
        })
      });
      ok('create EVALUATOR returns 201', uEval.status === 201);
      evaluatorId = uEval.data.id;

      // Provision Viewer (Org A)
      const uView = await api('/api/admin/users', {
        method: 'POST',
        headers: superAuth.headers,
        body: JSON.stringify({
          email: 'viewer@alpha.edu',
          password: 'ViewerPassword123!',
          name: 'Alpha Viewer',
          role: 'VIEWER',
          organization_id: orgAId
        })
      });
      ok('create VIEWER returns 201', uView.status === 201);

      // Login all personas
      orgAdminAHeaders = (await loginUser('admin@alpha.edu', 'AlphaPassword123!')).headers;
      orgAdminBHeaders = (await loginUser('admin@beta.edu', 'BetaPassword123!')).headers;
      examMgrHeaders = (await loginUser('manager@alpha.edu', 'ManagerPassword123!')).headers;
      evaluatorHeaders = (await loginUser('evaluator@alpha.edu', 'EvalPassword123!')).headers;
      viewerHeaders = (await loginUser('viewer@alpha.edu', 'ViewerPassword123!')).headers;
    }

    console.log('\n--- 4. RBAC Matrix & Role Boundaries ---');
    {
      const superAuth = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');

      // 4.1 Questions permissions
      // SUPER_ADMIN: can create question
      const qSuper = await api('/api/admin/questions', {
        method: 'POST', headers: superAuth.headers,
        body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'Super Q', options: ['A', 'B'], correct_index: 0 })
      });
      ok('SUPER_ADMIN can create questions', qSuper.status === 201);

      // ORG_ADMIN: can create question
      const qOrgA = await api('/api/admin/questions', {
        method: 'POST', headers: orgAdminAHeaders,
        body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'Org A Q', options: ['A', 'B'], correct_index: 0 })
      });
      ok('ORG_ADMIN can create questions', qOrgA.status === 201);
      const qOrgAId = qOrgA.data.id;

      // EXAM_MANAGER: can create question
      const qMgr = await api('/api/admin/questions', {
        method: 'POST', headers: examMgrHeaders,
        body: JSON.stringify({ type: 'mcq', category: 'technical', question_text: 'Mgr Q', options: ['A', 'B'], correct_index: 0 })
      });
      ok('EXAM_MANAGER can create questions', qMgr.status === 201);

      // EVALUATOR: CANNOT create questions
      const qEval = await api('/api/admin/questions', {
        method: 'POST', headers: evaluatorHeaders,
        body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'Eval Q', options: ['A', 'B'], correct_index: 0 })
      });
      ok('EVALUATOR cannot create questions (403)', qEval.status === 403);
      ok('EVALUATOR cannot read questions (403)', (await api('/api/admin/questions', { headers: evaluatorHeaders })).status === 403);

      // VIEWER: CANNOT create or read questions
      const qView = await api('/api/admin/questions', {
        method: 'POST', headers: viewerHeaders,
        body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'View Q', options: ['A', 'B'], correct_index: 0 })
      });
      ok('VIEWER cannot create questions (403)', qView.status === 403);
      ok('VIEWER cannot read questions (403)', (await api('/api/admin/questions', { headers: viewerHeaders })).status === 403);

      // 4.2 Results & Exports
      // All 5 roles can read results
      ok('SUPER_ADMIN can read results', (await api('/api/admin/results', { headers: superAuth.headers })).status === 200);
      ok('ORG_ADMIN can read results', (await api('/api/admin/results', { headers: orgAdminAHeaders })).status === 200);
      ok('EXAM_MANAGER can read results', (await api('/api/admin/results', { headers: examMgrHeaders })).status === 200);
      ok('EVALUATOR can read results', (await api('/api/admin/results', { headers: evaluatorHeaders })).status === 200);
      ok('VIEWER can read results', (await api('/api/admin/results', { headers: viewerHeaders })).status === 200);

      // Results export (CSV)
      ok('SUPER_ADMIN can export results', (await api('/api/admin/results.csv', { headers: superAuth.headers })).status === 200);
      ok('ORG_ADMIN can export results', (await api('/api/admin/results.csv', { headers: orgAdminAHeaders })).status === 200);
      ok('EXAM_MANAGER cannot export results (403)', (await api('/api/admin/results.csv', { headers: examMgrHeaders })).status === 403);
      ok('EVALUATOR cannot export results (403)', (await api('/api/admin/results.csv', { headers: evaluatorHeaders })).status === 403);
      ok('VIEWER cannot export results (403)', (await api('/api/admin/results.csv', { headers: viewerHeaders })).status === 403);

      // Analytics (College report)
      ok('SUPER_ADMIN can view college report', (await api('/api/admin/report/college?college=Test', { headers: superAuth.headers })).status === 200);
      ok('ORG_ADMIN can view college report', (await api('/api/admin/report/college?college=Test', { headers: orgAdminAHeaders })).status === 200);
      ok('EXAM_MANAGER can view college report', (await api('/api/admin/report/college?college=Test', { headers: examMgrHeaders })).status === 200);
      ok('EVALUATOR can view college report', (await api('/api/admin/report/college?college=Test', { headers: evaluatorHeaders })).status === 200);
      ok('VIEWER cannot view college report (403)', (await api('/api/admin/report/college?college=Test', { headers: viewerHeaders })).status === 403);

      // 4.3 Settings (Config)
      // SUPER_ADMIN can update platform settings
      const cfgSuper = await api('/api/admin/config', {
        method: 'PUT', headers: superAuth.headers,
        body: JSON.stringify({ test_title: 'Global Test', scholarship_slabs: JSON.stringify([{ min: 90, scholarship: 100 }]) })
      });
      ok('SUPER_ADMIN can update platform settings', cfgSuper.status === 200);

      // ORG_ADMIN can update allowed org config (test_title, duration), but NOT platform scholarship_slabs
      const cfgOrgAllowed = await api('/api/admin/config', {
        method: 'PUT', headers: orgAdminAHeaders,
        body: JSON.stringify({ test_title: 'Alpha Test Title', duration_minutes: '60' })
      });
      ok('ORG_ADMIN can update allowed org config', cfgOrgAllowed.status === 200);

      const cfgOrgDenied = await api('/api/admin/config', {
        method: 'PUT', headers: orgAdminAHeaders,
        body: JSON.stringify({ scholarship_slabs: JSON.stringify([{ min: 50, scholarship: 100 }]) })
      });
      ok('ORG_ADMIN denied platform scholarship_slabs update (403)', cfgOrgDenied.status === 403);

      // EXAM_MANAGER cannot update config
      const cfgMgr = await api('/api/admin/config', { method: 'PUT', headers: examMgrHeaders, body: JSON.stringify({ test_title: 'Hacked' }) });
      ok('EXAM_MANAGER cannot update config (403)', cfgMgr.status === 403);

      // EVALUATOR cannot update config
      const cfgEval = await api('/api/admin/config', { method: 'PUT', headers: evaluatorHeaders, body: JSON.stringify({ test_title: 'Hacked' }) });
      ok('EVALUATOR cannot update config (403)', cfgEval.status === 403);

      // VIEWER cannot update config
      const cfgView = await api('/api/admin/config', { method: 'PUT', headers: viewerHeaders, body: JSON.stringify({ test_title: 'Hacked' }) });
      ok('VIEWER cannot update config (403)', cfgView.status === 403);

      // 4.4 User Management
      ok('SUPER_ADMIN can list users', (await api('/api/admin/users', { headers: superAuth.headers })).status === 200);
      ok('ORG_ADMIN can list users', (await api('/api/admin/users', { headers: orgAdminAHeaders })).status === 200);
      ok('EXAM_MANAGER cannot list users (403)', (await api('/api/admin/users', { headers: examMgrHeaders })).status === 403);
      ok('EVALUATOR cannot list users (403)', (await api('/api/admin/users', { headers: evaluatorHeaders })).status === 403);
      ok('VIEWER cannot list users (403)', (await api('/api/admin/users', { headers: viewerHeaders })).status === 403);
    }

    console.log('\n--- 5. Multi-Tenant Isolation & IDOR Defenses ---');
    {
      const superAuth = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');

      // Create a question owned by Org B
      const qBRes = await api('/api/admin/questions', {
        method: 'POST', headers: orgAdminBHeaders,
        body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'Org B Secret Question', options: ['A', 'B'], correct_index: 0 })
      });
      const qBId = qBRes.data.id;

      // Cross-Tenant Attack 1: Org Admin A tries to modify Org B question
      const crossQPut = await api(`/api/admin/questions/${qBId}`, {
        method: 'PUT', headers: orgAdminAHeaders,
        body: JSON.stringify({ question_text: 'Modified by Org A' })
      });
      ok('Org A cannot modify Org B question (403 Forbidden)', crossQPut.status === 403);

      // Cross-Tenant Attack 2: Org Admin A tries to delete Org B question
      const crossQDel = await api(`/api/admin/questions/${qBId}`, {
        method: 'DELETE', headers: orgAdminAHeaders
      });
      ok('Org A cannot delete Org B question (403 Forbidden)', crossQDel.status === 403);

      // Cross-Tenant Attack 3: Org Admin A tries to create Super Admin user
      const crossEscalate = await api('/api/admin/users', {
        method: 'POST', headers: orgAdminAHeaders,
        body: JSON.stringify({
          email: 'attacker@alpha.edu',
          password: 'Password123!',
          name: 'Attacker',
          role: 'SUPER_ADMIN'
        })
      });
      ok('Org Admin cannot elevate user to SUPER_ADMIN (403 Forbidden)', crossEscalate.status === 403);

      // Cross-Tenant Attack 4: Org Admin A tries to create user in Org B
      const crossCreateUser = await api('/api/admin/users', {
        method: 'POST', headers: orgAdminAHeaders,
        body: JSON.stringify({
          email: 'intruder@beta.edu',
          password: 'Password123!',
          name: 'Intruder',
          role: 'VIEWER',
          organization_id: orgBId
        })
      });
      ok('Org Admin cannot create user in another organization (403 Forbidden)', crossCreateUser.status === 403);

      // Cross-Tenant Attack 5: Org Admin A tries to view Org B user
      const betaUser = (await api('/api/admin/users', { headers: orgAdminBHeaders })).data[0];
      const crossViewUser = await api(`/api/admin/users/${betaUser.id}`, { headers: orgAdminAHeaders });
      ok('Org Admin cannot view user from another organization (403 Forbidden)', crossViewUser.status === 403);

      // Cross-Tenant Attack 6: Org Admin A tries to disable Org B user
      const crossDisableUser = await api(`/api/admin/users/${betaUser.id}/disable`, { method: 'POST', headers: orgAdminAHeaders });
      ok('Org Admin cannot disable user from another organization (403 Forbidden)', crossDisableUser.status === 403);

      // Cross-Tenant Attack 7: Org Admin A tries to modify Organization B details
      const crossOrgUpdate = await api(`/api/admin/organizations/${orgBId}`, {
        method: 'PUT', headers: orgAdminAHeaders,
        body: JSON.stringify({ name: 'Hacked Beta Inst' })
      });
      ok('Org Admin cannot modify another organization (403 Forbidden)', crossOrgUpdate.status === 403);

      // Org Admin A question list only includes Org A and global questions (not Org B questions)
      const listOrgA = await api('/api/admin/questions', { headers: orgAdminAHeaders });
      const containsQB = listOrgA.data.some((q) => q.id === qBId);
      ok('Org A questions list does not leak Org B questions', containsQB === false);

      // Super Admin CAN access and manage Org B question
      const superEditQB = await api(`/api/admin/questions/${qBId}`, {
        method: 'PUT', headers: superAuth.headers,
        body: JSON.stringify({ question_text: 'Updated by Super Admin' })
      });
      ok('SUPER_ADMIN can modify Org B question', superEditQB.status === 200);
    }

    console.log('\n--- 6. Account Disabling & Immediate Invalidation ---');
    {
      const superAuth = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');

      // Create a temporary user
      const tempUser = (await api('/api/admin/users', {
        method: 'POST', headers: superAuth.headers,
        body: JSON.stringify({
          email: 'disposable@adyapan.internal',
          password: 'Password12345!',
          name: 'Disposable User',
          role: 'EXAM_MANAGER',
          organization_id: orgAId
        })
      })).data;

      // Log in as temp user
      const tempAuth = await loginUser('disposable@adyapan.internal', 'Password12345!');
      ok('temp user logged in successfully', tempAuth.status === 200);

      // Verify temp user can make an authorized request
      const reqBefore = await api('/api/admin/questions', { headers: tempAuth.headers });
      ok('temp user can access API prior to disable', reqBefore.status === 200);

      // Disable temp user
      const disableRes = await api(`/api/admin/users/${tempUser.id}/disable`, { method: 'POST', headers: superAuth.headers });
      ok('super admin can disable user', disableRes.status === 200 && disableRes.data.user.status === 'DISABLED');

      // Attempt API request with disabled user token -> MUST BE REJECTED
      const reqAfter = await api('/api/admin/questions', { headers: tempAuth.headers });
      ok('disabled user token rejected immediately (401)', reqAfter.status === 401);

      // Attempt login with disabled account -> MUST BE REJECTED
      const loginDisabled = await loginUser('disposable@adyapan.internal', 'Password12345!');
      ok('disabled account login rejected (401)', loginDisabled.status === 401);
      ok('disabled login error message is safe', loginDisabled.data.message.toLowerCase().includes('disabled'));
    }

    console.log('\n--- 7. Security Audit Logging Persistence ---');
    {
      const Database = require('better-sqlite3');
      const testDb = new Database(DB);
      const auditRows = testDb.prepare('SELECT DISTINCT event FROM audit_logs').all();
      testDb.close();
      ok('audit_logs table has recorded events', auditRows.length > 0);

      const events = auditRows.map((r) => r.event);
      ok('login_success recorded in audit log', events.includes('login_success'));
      ok('login_failure recorded in audit log', events.includes('login_failure'));
      ok('logout recorded in audit log', events.includes('logout'));
      ok('permission_denied recorded in audit log', events.includes('permission_denied'));
      ok('cross_tenant_access_denied recorded in audit log', events.includes('cross_tenant_access_denied'));
      ok('user_created recorded in audit log', events.includes('user_created'));
      ok('user_disabled recorded in audit log', events.includes('user_disabled'));
    }

  } finally {
    proc.kill();
    await wait(400);
    try { fs.unlinkSync(DB); } catch {}
    try { fs.unlinkSync(DB + '-wal'); } catch {}
    try { fs.unlinkSync(DB + '-shm'); } catch {}
  }

  console.log(`\n[test-auth] Results: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('[test-auth] Crash:', e);
  process.exit(1);
});
