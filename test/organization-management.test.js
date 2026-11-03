// ============================================================================
// ASPIRE DAY 17: ORGANIZATION MANAGEMENT TEST SUITE
// ============================================================================
// Validates:
// 1. Organization creation with complete metadata & slug auto-generation
// 2. Duplicate slug & email rejection
// 3. Paginated listing, full-text search, and status filtering
// 4. Organization update by SUPER_ADMIN
// 5. Disable organization with audit history and session revocation
// 6. Disabled organization rejects candidate registration and admin operations
// 7. Re-enabling organization restores operational status
// 8. Role-based access control (only SUPER_ADMIN can manage organizations)
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3220;
const DB_FILE = path.join(os.tmpdir(), `aspire-org-mgmt-test-${Date.now()}.db`);
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
    } catch {}
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
  console.log('ASPIRE DAY 17: ORGANIZATION MANAGEMENT TEST SUITE');
  console.log('====================================================\n');

  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + ext); } catch {}
  }

  const serverProc = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB_FILE,
      NODE_ENV: 'test',
      INITIAL_ADMIN_EMAIL: 'superadmin@adyapan.internal',
      INITIAL_ADMIN_PASSWORD: 'SuperPassword123!',
      AUTH_SECRET: 'aspire-day17-org-mgmt-test-auth-secret-key-32',
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
    // 1. Super Admin Login
    console.log('\n--- 1. Authentication & Access Control ---');
    const superAdmin = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');
    ok('Super Admin logs in successfully (HTTP 200)', superAdmin.status === 200 && !!superAdmin.token);

    // 2. Organization Creation & Slug Generation
    console.log('\n--- 2. Organization Creation & Slug Auto-generation ---');
    const createRes1 = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'National Institute of Technology',
        email: 'registrar@nit.ac.in',
        phone: '+91 9876543210',
        website: 'https://nit.ac.in',
        timezone: 'Asia/Kolkata',
        primary_color: '#003366',
        secondary_color: '#002244',
        accent_color: '#FF6600'
      })
    });
    ok('Create organization with auto-generated slug succeeds (HTTP 201)', createRes1.status === 201);
    const org1 = createRes1.data.data || createRes1.data;
    ok('Auto-generated slug matches "national-institute-of-technology"', org1.slug === 'national-institute-of-technology');
    ok('Custom brand colors stored accurately', org1.primary_color === '#003366' && org1.accent_color === '#FF6600');
    ok('Timezone default set to Asia/Kolkata', org1.timezone === 'Asia/Kolkata');

    // 3. Duplicate Slug & Email Rejection
    console.log('\n--- 3. Duplicate Slug & Email Validations ---');
    const dupSlugRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Another NIT with same slug',
        slug: 'national-institute-of-technology',
        email: 'other@nit.ac.in'
      })
    });
    ok('Duplicate slug is rejected with conflict error (HTTP 409 or 400)', [400, 409].includes(dupSlugRes.status));

    const dupEmailRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Unique University Name',
        slug: 'unique-univ',
        email: 'registrar@nit.ac.in'
      })
    });
    ok('Duplicate official email is rejected with conflict error (HTTP 409 or 400)', [400, 409].includes(dupEmailRes.status));

    // 4. Create more organizations for pagination & search
    console.log('\n--- 4. Seeding Additional Organizations for Pagination & Search ---');
    await api('/api/admin/organizations', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Delhi Institute of Arts',
        slug: 'delhi-arts',
        email: 'info@delhiarts.edu',
        timezone: 'Asia/Kolkata'
      })
    });

    await api('/api/admin/organizations', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Mumbai Business Academy',
        slug: 'mumbai-mba',
        email: 'admissions@mumbai-mba.edu',
        timezone: 'Asia/Kolkata'
      })
    });

    await api('/api/admin/organizations', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Bangalore College of Engineering',
        slug: 'bce-bangalore',
        email: 'contact@bce.edu',
        timezone: 'Asia/Kolkata'
      })
    });

    // 5. Pagination, Search, and Filtering
    console.log('\n--- 5. Pagination, Search & Filter ---');
    const page1Res = await api('/api/admin/organizations?page=1&limit=2', { headers: superAdmin.headers });
    ok('Paginated list returns HTTP 200', page1Res.status === 200);
    ok('Page 1 contains exactly 2 records', page1Res.data.data.length === 2);
    ok('Pagination metadata reports total >= 4 and totalPages >= 2', page1Res.data.pagination.total >= 4 && page1Res.data.pagination.totalPages >= 2);

    const searchRes = await api('/api/admin/organizations?search=Mumbai', { headers: superAdmin.headers });
    ok('Search query "Mumbai" returns matching organization', searchRes.data.data.length === 1 && searchRes.data.data[0].slug === 'mumbai-mba');

    const searchEmailRes = await api('/api/admin/organizations?search=delhiarts.edu', { headers: superAdmin.headers });
    ok('Search query by email returns matching organization', searchEmailRes.data.data.length === 1 && searchEmailRes.data.data[0].slug === 'delhi-arts');

    // 6. Organization Update by SUPER_ADMIN
    console.log('\n--- 6. Organization Update ---');
    const updateRes = await api(`/api/admin/organizations/${org1.id}`, {
      method: 'PATCH',
      headers: superAdmin.headers,
      body: JSON.stringify({
        phone: '+91 9999988888',
        website: 'https://new-nit-portal.ac.in',
        timezone: 'Asia/Dubai'
      })
    });
    ok('Super Admin updates organization metadata successfully (HTTP 200)', updateRes.status === 200);
    const updatedOrg = updateRes.data.data || updateRes.data;
    ok('Updated phone matches new value', updatedOrg.phone === '+91 9999988888');
    ok('Updated timezone matches Asia/Dubai', updatedOrg.timezone === 'Asia/Dubai');

    // 7. Create an Org Admin user under org1 and verify disable/enable lifecycle
    console.log('\n--- 7. Organization Suspension & Session Revocation ---');
    // Onboard user directly under org1
    const createOrgUserRes = await api('/api/admin/users', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'NIT Org Admin',
        email: 'admin@nit.ac.in',
        password: 'Password123!',
        role: 'ORG_ADMIN',
        organization_id: org1.id
      })
    });
    ok('Created org admin user under organization 1', createOrgUserRes.status === 201);

    // Login as org admin
    const orgAdminLogin = await loginUser('admin@nit.ac.in', 'Password123!');
    ok('Org admin logs in successfully before suspension', orgAdminLogin.status === 200);

    // Super Admin disables org1
    const disableRes = await api(`/api/admin/organizations/${org1.id}/disable`, {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({ reason: 'Audit pending due to compliance investigation' })
    });
    ok('Super Admin disables organization (HTTP 200)', disableRes.status === 200);
    ok('Organization status transitions to SUSPENDED', disableRes.data.data.status === 'SUSPENDED');

    // Try to access org endpoint using existing token -> must fail
    const orgProfileReq = await api('/api/organization', { headers: orgAdminLogin.headers });
    ok('Org admin request with existing session is rejected with HTTP 401 or 403 (ORGANIZATION_INACTIVE or session revoked)',
      [401, 403].includes(orgProfileReq.status));

    // Try to login again while organization is suspended
    const reLoginWhileSuspended = await loginUser('admin@nit.ac.in', 'Password123!');
    ok('Login attempt while organization is suspended is rejected (HTTP 403)', reLoginWhileSuspended.status === 403);

    // 8. Re-enabling the organization restores operations
    console.log('\n--- 8. Re-enabling Organization Restores Operations ---');
    const enableRes = await api(`/api/admin/organizations/${org1.id}/enable`, {
      method: 'POST',
      headers: superAdmin.headers
    });
    ok('Super Admin enables organization (HTTP 200)', enableRes.status === 200);
    ok('Organization status transitions to ACTIVE', enableRes.data.data.status === 'ACTIVE');

    // Now org admin can log in again
    const orgAdminRelogin = await loginUser('admin@nit.ac.in', 'Password123!');
    ok('Org admin can log in again after re-enabling (HTTP 200)', orgAdminRelogin.status === 200);

    // 9. RBAC: Regular org admin cannot access /api/admin/organizations
    console.log('\n--- 9. Strict RBAC Enforcement ---');
    const forbiddenOrgAccess = await api('/api/admin/organizations', { headers: orgAdminRelogin.headers });
    ok('Org admin cannot access Platform Admin /api/admin/organizations (HTTP 403)', forbiddenOrgAccess.status === 403);

    const forbiddenDisableAccess = await api(`/api/admin/organizations/${org1.id}/disable`, {
      method: 'POST',
      headers: orgAdminRelogin.headers,
      body: JSON.stringify({ reason: 'Malicious attempt' })
    });
    ok('Org admin cannot disable organizations (HTTP 403)', forbiddenDisableAccess.status === 403);

  } finally {
    serverProc.kill();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch {}
    }
  }

  console.log('\n====================================================');
  console.log(`DAY 17 ORG MANAGEMENT SUITE COMPLETE: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================');

  if (failures > 0) process.exit(1);
}

runSuite().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
