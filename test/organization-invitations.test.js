// ============================================================================
// ASPIRE DAY 17: ADMINISTRATOR INVITATIONS TEST SUITE
// ============================================================================
// Validates:
// 1. Secure invitation creation with SHA-256 hashed storage & 7-day expiration
// 2. Privilege escalation prevention (cannot invite SUPER_ADMIN)
// 3. Public invitation verification endpoint (/api/auth/invitations/:token)
// 4. Invitation acceptance, user provisioning, and session issuance
// 5. Single-use token enforcement (replay attack rejected)
// 6. Expiration enforcement (past expires_at rejected)
// 7. Revocation by organization administrator
// 8. Strict cross-tenant isolation (Org A cannot revoke Org B invitations)
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const crypto = require('crypto');

const PORT = 3222;
const DB_FILE = path.join(os.tmpdir(), `aspire-org-invites-test-${Date.now()}.db`);
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

async function api(endpoint, opts = {}) {
  const res = await fetch(BASE + endpoint, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data, raw: text, headers: res.headers };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { }
    await wait(250);
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

async function runSuite() {
  console.log('====================================================');
  console.log('ASPIRE DAY 17: ADMINISTRATOR INVITATIONS TEST SUITE');
  console.log('====================================================\n');

  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + ext); } catch { }
  }

  const serverProc = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB_FILE,
      NODE_ENV: 'test',
      INITIAL_ADMIN_EMAIL: 'superadmin@adyapan.internal',
      INITIAL_ADMIN_PASSWORD: 'SuperPassword123!',
      AUTH_SECRET: 'aspire-day17-invites-test-auth-secret-key-32',
      CODE_EXECUTION_PROVIDER: 'MOCK',
      CODE_EXECUTION_FALLBACK: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverErr = '';
  serverProc.stderr.on('data', (d) => { serverErr += d.toString(); });

  const ready = await waitForServer();
  if (!ready) {
    console.error('Failed to start test server on port ' + PORT + ':', serverErr);
    serverProc.kill();
    process.exit(1);
  }
  ok('Test server initialized and ready at ' + BASE, true);

  try {
    const superAdmin = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');

    // 1. Setup Organizations A and B
    console.log('\n--- 1. Setting Up Test Organizations ---');
    const orgARes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Zenith Institute of Engineering',
        slug: 'zenith-eng',
        admin_name: 'Zenith Admin',
        admin_email: 'admin@zenith.test',
        admin_password: 'Password123!'
      })
    });
    ok('Organization A onboarded successfully', orgARes.status === 201);
    const orgA = orgARes.data.organization;
    const orgAdminA = await loginUser('admin@zenith.test', 'Password123!');

    const orgBRes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Horizon College of Technology',
        slug: 'horizon-tech',
        admin_name: 'Horizon Admin',
        admin_email: 'admin@horizon.test',
        admin_password: 'Password123!'
      })
    });
    ok('Organization B onboarded successfully', orgBRes.status === 201);
    const orgB = orgBRes.data.organization;
    const orgAdminB = await loginUser('admin@horizon.test', 'Password123!');

    // 2. Privilege Escalation Prevention
    console.log('\n--- 2. Privilege Escalation Prevention ---');
    const escalateRes = await api('/api/organization/invitations', {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        email: 'malicious@hacker.io',
        role: 'SUPER_ADMIN'
      })
    });
    ok('Attempt to invite SUPER_ADMIN role is rejected (HTTP 400)', escalateRes.status === 400);

    // 3. Create Valid Invitation
    console.log('\n--- 3. Create Valid Invitation ---');
    const inviteRes = await api('/api/organization/invitations', {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        email: 'examiner1@zenith.edu',
        role: 'EXAM_MANAGER'
      })
    });
    ok('Create invitation for EXAM_MANAGER succeeds (HTTP 201)', inviteRes.status === 201);
    const inviteData = inviteRes.data.data;
    ok('Response contains raw one-time token', typeof inviteData.token === 'string' && inviteData.token.length >= 32);
    ok('Response contains full invitation link', inviteData.invitationLink.includes(inviteData.token));
    const token1 = inviteData.token;
    const inviteId1 = inviteData.id || inviteData.invitation?.id;

    // 4. Verify Database Security (Raw token is NOT stored; only SHA-256 hash)
    console.log('\n--- 4. Cryptographic Storage Security ---');
    const Database = require('better-sqlite3');
    const testDb = new Database(DB_FILE);
    const rowInDb = testDb.prepare('SELECT * FROM organization_invitations WHERE id = ?').get(inviteId1);
    ok('Database record exists', !!rowInDb);
    ok('Raw token is NOT in database token_hash column', rowInDb.token_hash !== token1);
    const expectedHash = crypto.createHash('sha256').update(token1).digest('hex');
    ok('token_hash matches SHA-256 digest of raw token', rowInDb.token_hash === expectedHash);
    ok('DB record is in pending state (accepted_at & revoked_at null)', rowInDb.accepted_at === null && rowInDb.revoked_at === null);
    testDb.close();

    // 5. Public Verification Endpoint
    console.log('\n--- 5. Public Verification Endpoint ---');
    const verifyRes = await api(`/api/auth/invitations/${token1}`);
    ok('Verify token succeeds without auth (HTTP 200)', verifyRes.status === 200);
    ok('Returns matching email', verifyRes.data.data.email === 'examiner1@zenith.edu');
    ok('Returns matching role', verifyRes.data.data.role === 'EXAM_MANAGER');
    ok('Returns organization metadata', verifyRes.data.data.organization_name === 'Zenith Institute of Engineering');

    // Invalid token returns 404
    const bogusVerifyRes = await api('/api/auth/invitations/non-existent-token-1234567890');
    ok('Bogus token verification returns HTTP 404', bogusVerifyRes.status === 404);

    // 6. Accept Invitation
    console.log('\n--- 6. Accept Invitation & Account Creation ---');
    const acceptRes = await api('/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        token: token1,
        name: 'Dr. Examiner One',
        password: 'ExaminerPass123!'
      })
    });
    ok('Accept invitation succeeds (HTTP 200 or 201)', [200, 201].includes(acceptRes.status));
    ok('Returns authenticated user', acceptRes.data.data.user.email === 'examiner1@zenith.edu');
    ok('User assigned to Organization A', acceptRes.data.data.user.organization_id === orgA.id);
    ok('User assigned role EXAM_MANAGER', acceptRes.data.data.user.role === 'EXAM_MANAGER');
    ok('Returns active JWT token', typeof acceptRes.data.data.token === 'string');

    // Newly created user can immediately call protected API
    const examinerHeaders = { Authorization: `Bearer ${acceptRes.data.data.token}` };
    const examinerOrgRes = await api('/api/organization', { headers: examinerHeaders });
    ok('New user session is immediately authenticated (HTTP 200)', examinerOrgRes.status === 200);

    // 7. Single-Use Token Enforcement (Replay Attack)
    console.log('\n--- 7. Single-Use Token Enforcement ---');
    const replayAcceptRes = await api('/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        token: token1,
        name: 'Hacker Duplicate',
        password: 'HackerPass123!'
      })
    });
    ok('Re-accepting already accepted invitation is rejected (HTTP 400 or 409)', [400, 409].includes(replayAcceptRes.status));

    // 8. Expiration Enforcement
    console.log('\n--- 8. Expiration Enforcement ---');
    const invite2Res = await api('/api/organization/invitations', {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        email: 'expired_user@zenith.edu',
        role: 'VIEWER'
      })
    });
    const token2 = invite2Res.data.data.token;
    const inviteId2 = invite2Res.data.data.id || invite2Res.data.data.invitation?.id;

    // Manually backdate expiration in DB to simulate expired invitation
    const db2 = new Database(DB_FILE);
    db2.prepare("UPDATE organization_invitations SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(inviteId2);
    db2.close();

    const acceptExpiredRes = await api('/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        token: token2,
        name: 'Late User',
        password: 'LatePassword123!'
      })
    });
    ok('Accepting expired invitation is rejected (HTTP 400 or 409)', [400, 409].includes(acceptExpiredRes.status));

    // 9. Invitation Revocation & Cross-Tenant Security
    console.log('\n--- 9. Revocation & Multi-Tenant Isolation ---');
    // Org B creates an invitation
    const inviteBRes = await api('/api/organization/invitations', {
      method: 'POST',
      headers: orgAdminB.headers,
      body: JSON.stringify({
        email: 'staff@horizon.edu',
        role: 'EVALUATOR'
      })
    });
    const tokenB = inviteBRes.data.data.token;
    const inviteIdB = inviteBRes.data.data.id || inviteBRes.data.data.invitation?.id;

    // Cross-tenant attack: Org Admin A attempts to revoke Org B's invitation
    const crossRevokeRes = await api(`/api/organization/invitations/${inviteIdB}/revoke`, {
      method: 'POST',
      headers: orgAdminA.headers
    });
    ok('Org Admin A cannot revoke Org B invitation (HTTP 403 or 404)', [403, 404].includes(crossRevokeRes.status));

    // Org B revokes its own invitation
    const legitimateRevokeRes = await api(`/api/organization/invitations/${inviteIdB}/revoke`, {
      method: 'POST',
      headers: orgAdminB.headers
    });
    ok('Org Admin B revokes invitation successfully (HTTP 200)', legitimateRevokeRes.status === 200);

    // Trying to accept revoked invitation fails
    const acceptRevokedRes = await api('/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        token: tokenB,
        name: 'Revoked Person',
        password: 'RevokedPass123!'
      })
    });
    ok('Accepting revoked invitation is rejected (HTTP 400 or 409)', [400, 409].includes(acceptRevokedRes.status));

  } finally {
    serverProc.kill();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log('\n====================================================');
  console.log(`DAY 17 INVITATIONS SUITE COMPLETE: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================');

  if (failures > 0) process.exit(1);
}

runSuite().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
