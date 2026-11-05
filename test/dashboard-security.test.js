// ============================================================================
// ASPIRE DAY 18: DASHBOARD SECURITY & TENANT ISOLATION TEST SUITE
// ============================================================================
// Validates:
// 1. Strict multi-tenant data isolation across organizations (Org A vs Org B)
// 2. Cross-tenant query tampering prevention (IDOR): URL param tampering rejected/ignored
// 3. Platform overview protection (SUPER_ADMIN only; non-super admins receive 403)
// 4. Authentication enforcement (unauthenticated requests rejected with 401)
// 5. RBAC role-level permissions (VIEWER can read dashboard, cannot mutate exams/config)
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3252;
const DB_FILE = path.join(os.tmpdir(), `aspire-dashboard-security-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 18: DASHBOARD SECURITY TEST SUITE');
  console.log('====================================================\n');

  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + ext); } catch {}
  }

  const proc = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB_FILE,
      NODE_ENV: 'test',
      INITIAL_ADMIN_EMAIL: 'superadmin@adyapan.internal',
      INITIAL_ADMIN_PASSWORD: 'SuperPassword123!',
      AUTH_SECRET: 'aspire-sec-dashboard-secret-32-chars-min!',
      CODE_EXECUTION_PROVIDER: 'MOCK',
      CODE_EXECUTION_FALLBACK: 'true',
      RATE_LIMIT_DISABLED: 'true'
    },
    stdio: 'inherit'
  });

  try {
    const ready = await waitForServer();
    assert(ready, 'Test server failed to start within timeout');

    // 1. Authenticate as Super Admin
    const superLogin = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');
    ok('Super Admin login succeeded', superLogin.status === 200 && !!superLogin.token);

    // 2. Create Organization A (Alpha Academy)
    const orgResA = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Alpha Academy', slug: 'alpha-sec', email: 'info@alphasec.edu' })
    });
    const orgAId = (orgResA.data.data || orgResA.data).id;

    // Create Org A Admin
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Alpha Admin', email: 'admin@alphasec.edu', password: 'Password123!', role: 'ORG_ADMIN', organization_id: orgAId })
    });

    // Create Org A Viewer
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Alpha Viewer', email: 'viewer@alphasec.edu', password: 'Password123!', role: 'VIEWER', organization_id: orgAId })
    });

    // 3. Create Organization B (Beta College)
    const orgResB = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Beta College', slug: 'beta-sec', email: 'info@betasec.edu' })
    });
    const orgBId = (orgResB.data.data || orgResB.data).id;

    // Create Org B Admin
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Beta Admin', email: 'admin@betasec.edu', password: 'Password123!', role: 'ORG_ADMIN', organization_id: orgBId })
    });

    // Login accounts
    const alphaAdminLogin = await loginUser('admin@alphasec.edu', 'Password123!');
    const alphaViewerLogin = await loginUser('viewer@alphasec.edu', 'Password123!');
    const betaAdminLogin = await loginUser('admin@betasec.edu', 'Password123!');

    // 4. Seed Direct Data for Org A and Org B
    const Database = require('better-sqlite3');
    const db = new Database(DB_FILE);

    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

    // Org A: 2 students, 1 exam, 2 attempts (scores: 80, 90 -> avg 85)
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (1, 'Alpha Student 1', '90001', 'as1@a.edu', 'Alpha Uni', ?, ?)`).run(orgAId, tenDaysAgo);
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (2, 'Alpha Student 2', '90002', 'as2@a.edu', 'Alpha Uni', ?, ?)`).run(orgAId, tenDaysAgo);
    db.prepare(`INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at) VALUES (10, ?, 'Alpha Exam', 'ALP-1', 'LIVE', 60, 40, ?, ?, ?)`).run(orgAId, alphaAdminLogin.user.id, tenDaysAgo, tenDaysAgo);
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (100, 'tok-a1', '[]', ?, 1, ?, 10, 'submitted', ?, ?, ?, 80, 50, 'CERT-A1')`).run(fiveDaysAgo, orgAId, fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (101, 'tok-a2', '[]', ?, 2, ?, 10, 'submitted', ?, ?, ?, 90, 50, 'CERT-A2')`).run(fiveDaysAgo, orgAId, fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);

    // Org B: 5 students, 2 exams, 3 attempts (scores: 30, 40, 50 -> avg 40)
    for (let i = 1; i <= 5; i++) {
      db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (?, ?, ?, ?, 'Beta Tech', ?, ?)`).run(10 + i, `Beta Student ${i}`, `8000${i}`, `bs${i}@b.edu`, orgBId, tenDaysAgo);
    }
    db.prepare(`INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at) VALUES (20, ?, 'Beta Exam 1', 'BET-1', 'PUBLISHED', 60, 40, ?, ?, ?)`).run(orgBId, betaAdminLogin.user.id, tenDaysAgo, tenDaysAgo);
    db.prepare(`INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at) VALUES (21, ?, 'Beta Exam 2', 'BET-2', 'LIVE', 60, 40, ?, ?, ?)`).run(orgBId, betaAdminLogin.user.id, tenDaysAgo, tenDaysAgo);
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (200, 'tok-b1', '[]', ?, 11, ?, 20, 'submitted', ?, ?, ?, 30, 0, null)`).run(fiveDaysAgo, orgBId, fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (201, 'tok-b2', '[]', ?, 12, ?, 20, 'submitted', ?, ?, ?, 40, 0, null)`).run(fiveDaysAgo, orgBId, fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (202, 'tok-b3', '[]', ?, 13, ?, 21, 'submitted', ?, ?, ?, 50, 20, 'CERT-B1')`).run(fiveDaysAgo, orgBId, fiveDaysAgo, fiveDaysAgo, fiveDaysAgo);

    db.close();

    // ------------------------------------------------------------------------
    // TEST 1: Tenant Data Isolation
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Multi-Tenant Data Isolation ---');
    const alphaOverview = await api('/api/organization/dashboard/overview?period=30d', { headers: alphaAdminLogin.headers });
    ok('Org A overview returns 200', alphaOverview.status === 200);
    const aKpis = alphaOverview.data.data.kpis || alphaOverview.data.data;
    ok('Org A Total Students is 2 (0 leakage of Org B 5 students)', aKpis.totalStudents.value === 2);
    ok('Org A Total Exams is 1 (0 leakage of Org B 2 exams)', aKpis.totalExams.value === 1);
    ok('Org A Completed Attempts is 2 (0 leakage of Org B 3 attempts)', aKpis.completedAttempts.value === 2);
    ok('Org A Average Score is 85% (0 contamination by Org B)', aKpis.averageScore.value === 85);

    const betaOverview = await api('/api/organization/dashboard/overview?period=30d', { headers: betaAdminLogin.headers });
    ok('Org B overview returns 200', betaOverview.status === 200);
    const bKpis = betaOverview.data.data.kpis || betaOverview.data.data;
    ok('Org B Total Students is 5', bKpis.totalStudents.value === 5);
    ok('Org B Total Exams is 2', bKpis.totalExams.value === 2);
    ok('Org B Completed Attempts is 3', bKpis.completedAttempts.value === 3);
    ok('Org B Average Score is 40%', bKpis.averageScore.value === 40);

    // ------------------------------------------------------------------------
    // TEST 2: Cross-Tenant Tampering Prevention (IDOR)
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Cross-Tenant Tampering & IDOR Protection ---');
    // Org A Admin tries to pass ?organization_id=<OrgB_Id> to tenant route
    const tamperRes = await api(`/api/organization/dashboard/overview?period=30d&organization_id=${orgBId}`, {
      headers: alphaAdminLogin.headers
    });
    ok('Tenant route rejects cross-tenant parameter injection (HTTP 403 Forbidden)', tamperRes.status === 403);
    ok('Rejection error indicates cross-tenant manipulation', (tamperRes.data.message || '').includes('Cross-tenant parameter manipulation'));

    // Org A Admin calls Super Admin endpoint for Org B: /api/admin/dashboard/organizations/:orgBId
    const crossAdminRes = await api(`/api/admin/dashboard/organizations/${orgBId}`, {
      headers: alphaAdminLogin.headers
    });
    ok('Org A Admin is denied access to Org B metrics (HTTP 403 Forbidden)', crossAdminRes.status === 403);

    // Super Admin CAN access Org B metrics: /api/admin/dashboard/organizations/:orgBId
    const superOrgBRes = await api(`/api/admin/dashboard/organizations/${orgBId}`, {
      headers: superLogin.headers
    });
    ok('Super Admin can access Org B metrics (HTTP 200)', superOrgBRes.status === 200);
    const superBKpis = superOrgBRes.data.data.kpis;
    ok('Super Admin retrieves Org B metrics accurately (5 students)', (superBKpis.kpis || superBKpis).totalStudents.value === 5);

    // ------------------------------------------------------------------------
    // TEST 3: Platform Overview Protection
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Platform-Wide Metrics Protection ---');
    const orgAdminPlatformRes = await api('/api/admin/dashboard/platform-overview', {
      headers: alphaAdminLogin.headers
    });
    ok('Org Admin is denied platform-wide overview (HTTP 403 Forbidden)', orgAdminPlatformRes.status === 403);

    const viewerPlatformRes = await api('/api/admin/dashboard/platform-overview', {
      headers: alphaViewerLogin.headers
    });
    ok('Viewer is denied platform-wide overview (HTTP 403 Forbidden)', viewerPlatformRes.status === 403);

    // ------------------------------------------------------------------------
    // TEST 4: Unauthenticated Request Rejection
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Authentication Enforcement ---');
    const unauthOverview = await api('/api/organization/dashboard/overview');
    ok('Unauthenticated overview request is rejected (HTTP 401 Unauthorized)', unauthOverview.status === 401);

    const unauthPlatform = await api('/api/admin/dashboard/platform-overview');
    ok('Unauthenticated platform request is rejected (HTTP 401 Unauthorized)', unauthPlatform.status === 401);

    // ------------------------------------------------------------------------
    // TEST 5: Viewer Role Permissions
    // ------------------------------------------------------------------------
    console.log('\n--- 5. RBAC VIEWER Role Permissions ---');
    const viewerOverview = await api('/api/organization/dashboard/overview?period=30d', {
      headers: alphaViewerLogin.headers
    });
    ok('Viewer can read organization dashboard overview (HTTP 200)', viewerOverview.status === 200);

    const viewerAttempts = await api('/api/organization/dashboard/attempts-over-time?period=30d', {
      headers: alphaViewerLogin.headers
    });
    ok('Viewer can read organization attempts-over-time (HTTP 200)', viewerAttempts.status === 200);

    // Viewer cannot mutate (e.g. create exam)
    const viewerMutate = await api('/api/admin/exams', {
      method: 'POST',
      headers: alphaViewerLogin.headers,
      body: JSON.stringify({ name: 'Hacked Exam', code: 'HCK-1' })
    });
    ok('Viewer is denied exam creation mutation (HTTP 403 Forbidden)', viewerMutate.status === 403);

  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch {}
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('ALL DASHBOARD SECURITY TESTS PASSED (100%)');
    console.log('====================================================');
    process.exit(0);
  } else {
    console.error(`FAILED: ${failures} test assertion(s) failed`);
    console.log('====================================================');
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Unhandled suite error:', err);
  process.exit(1);
});
