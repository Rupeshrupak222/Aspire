// ============================================================================
// ASPIRE DAY 17: ORGANIZATION USAGE & ANALYTICS TEST SUITE
// ============================================================================
// Validates:
// 1. Tenant-scoped usage metrics via /api/organization/usage
// 2. Multi-tenant usage isolation (Org B events do not affect Org A metrics)
// 3. Super Admin individual org usage inspection via /api/admin/organizations/:id/usage
// 4. Cross-tenant IDOR defense (Org Admin A cannot inspect Org B usage)
// 5. Platform-wide usage aggregates via /api/admin/organizations-platform-usage
// 6. Access control restrictions on platform usage endpoint
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3223;
const DB_FILE = path.join(os.tmpdir(), `aspire-org-usage-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 17: ORGANIZATION USAGE & METRICS TEST SUITE');
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
      AUTH_SECRET: 'aspire-day17-usage-test-auth-secret-key-32',
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

    // 1. Setup Org A and Org B
    console.log('\n--- 1. Setting Up Organizations A and B ---');
    const onboardARes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Quantum Institute of Science',
        slug: 'quantum-sci',
        admin_name: 'Quantum Admin',
        admin_email: 'admin@quantum.test',
        admin_password: 'Password123!'
      })
    });
    ok('Organization A onboarded successfully', onboardARes.status === 201);
    const orgA = onboardARes.data.organization;
    const orgAdminA = await loginUser('admin@quantum.test', 'Password123!');

    const onboardBRes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Nexus Institute of Technology',
        slug: 'nexus-tech',
        admin_name: 'Nexus Admin',
        admin_email: 'admin@nexus.test',
        admin_password: 'Password123!'
      })
    });
    ok('Organization B onboarded successfully', onboardBRes.status === 201);
    const orgB = onboardBRes.data.organization;
    const orgAdminB = await loginUser('admin@nexus.test', 'Password123!');

    // 2. Initial Usage State
    console.log('\n--- 2. Initial Tenant-Scoped Usage ---');
    const initialUsageA = await api('/api/organization/usage', { headers: orgAdminA.headers });
    ok('Get usage for Org A succeeds (HTTP 200)', initialUsageA.status === 200);
    const usageA = initialUsageA.data.data;
    ok('Initial candidates count is 0', usageA.candidatesCount === 0);
    ok('Initial exams count is 0', usageA.examsCount === 0);
    ok('Users count reflects 1 admin user', usageA.usersCount === 1);

    // 3. Seed Activities into Org A
    console.log('\n--- 3. Seeding Exams & Candidates into Org A ---');
    // Questions in Org A
    const qARes = await api('/api/admin/questions', {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        type: 'mcq',
        category: 'aptitude',
        title: 'Quantum Physics Q1',
        question_text: 'What is the speed of light?',
        options: ['3x10^8 m/s', '1x10^6 m/s', 'Zero', 'Infinite'],
        correct_index: 0,
        marks: 1
      })
    });
    ok('Org A creates question (HTTP 201)', qARes.status === 201);
    const qAId = qARes.data?.data?.id || qARes.data?.id;
    await api(`/api/admin/questions/${qAId}/publish`, { method: 'POST', headers: orgAdminA.headers });

    // Org A creates an exam
    const examARes = await api('/api/admin/exams', {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        name: 'Quantum Physics Entrance Test',
        code: 'QPET-2026',
        duration_minutes: 60,
        passing_score: 1
      })
    });
    ok('Org A creates exam (HTTP 201)', examARes.status === 201);
    const examAId = examARes.data?.data?.id || examARes.data?.id;

    // Add Section and Question
    const secARes = await api(`/api/admin/exams/${examAId}/sections`, {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        name: 'Physics Core',
        display_order: 1,
        question_selection_mode: 'MANUAL',
        total_questions: 1,
        total_marks: 1
      })
    });
    const secAId = secARes.data?.data?.sections?.[0]?.id || secARes.data?.sections?.[0]?.id || secARes.data?.data?.id || secARes.data?.id;

    await api(`/api/admin/exams/${examAId}/sections/${secAId}/questions`, {
      method: 'POST',
      headers: orgAdminA.headers,
      body: JSON.stringify({ question_id: qAId })
    });

    // Add Scholarship Slabs
    await api(`/api/admin/exams/${examAId}/scholarship-slabs`, {
      method: 'PUT',
      headers: orgAdminA.headers,
      body: JSON.stringify({
        slabs: [
          { min_score_pct: 0, max_score_pct: 100, discount_pct: 100, tier_name: 'Full' }
        ]
      })
    });

    // Publish & Make LIVE
    await api(`/api/admin/exams/${examAId}/publish`, { method: 'POST', headers: orgAdminA.headers });
    await api(`/api/admin/exams/${examAId}/live`, { method: 'POST', headers: orgAdminA.headers });

    // Candidate registers under Org A's exam
    const candARes = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Candidate Quantum',
        email: 'cand1@quantum.test',
        phone: '9876543210',
        exam_code: 'QPET-2026'
      })
    });
    if (candARes.status !== 200) {
      console.log('Registration failed:', candARes.status, candARes.data);
    }
    ok('Candidate registers under Org A (HTTP 200)', candARes.status === 200);

    // 4. Verify Org A usage incremented while Org B remains at 0
    console.log('\n--- 4. Multi-Tenant Metrics Isolation ---');
    const updatedUsageA = await api('/api/organization/usage', { headers: orgAdminA.headers });
    const uA = updatedUsageA.data.data;
    ok('Org A examsCount is now 1', uA.examsCount === 1);
    ok('Org A candidatesCount is now 1', uA.candidatesCount === 1);
    ok('Org A attemptsCount is now 1', uA.attemptsCount === 1);

    // Check Org B usage -> must remain untouched
    const usageB = await api('/api/organization/usage', { headers: orgAdminB.headers });
    const uB = usageB.data.data;
    ok('Org B examsCount remains 0', uB.examsCount === 0);
    ok('Org B candidatesCount remains 0', uB.candidatesCount === 0);
    ok('Org B attemptsCount remains 0', uB.attemptsCount === 0);

    // 5. Super Admin Inspection of Org Usage
    console.log('\n--- 5. Super Admin Single-Org Usage Endpoint ---');
    const saOrgAUsage = await api(`/api/admin/organizations/${orgA.id}/usage`, { headers: superAdmin.headers });
    ok('Super Admin can query Org A usage (HTTP 200)', saOrgAUsage.status === 200);
    ok('Super Admin sees accurate examsCount for Org A', saOrgAUsage.data.data.examsCount === 1);

    // IDOR protection: Org Admin A cannot query /api/admin/organizations/:id/usage
    const idorUsageRes = await api(`/api/admin/organizations/${orgB.id}/usage`, { headers: orgAdminA.headers });
    ok('Org Admin A cannot inspect Org B usage via admin endpoint (HTTP 403)', idorUsageRes.status === 403);

    // 6. Platform-Wide Aggregated Usage
    console.log('\n--- 6. Platform-Wide Aggregated Usage Analytics ---');
    const platformUsageRes = await api('/api/admin/organizations-platform-usage', { headers: superAdmin.headers });
    ok('Super Admin retrieves platform-wide usage (HTTP 200)', platformUsageRes.status === 200);
    const pu = platformUsageRes.data.data;
    ok('Platform reports total organizations >= 2', pu.totalOrganizations >= 2);
    ok('Platform reports active organizations >= 2', pu.activeOrganizations >= 2);
    ok('Platform reports total candidates >= 1', pu.totalCandidates >= 1);
    ok('Platform reports total attempts >= 1', pu.totalAttempts >= 1);

    // Org Admin cannot access platform-wide usage
    const forbiddenPlatformUsage = await api('/api/admin/organizations-platform-usage', { headers: orgAdminA.headers });
    ok('Org Admin cannot access platform-wide usage metrics (HTTP 403)', forbiddenPlatformUsage.status === 403);

  } finally {
    serverProc.kill();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch {}
    }
  }

  console.log('\n====================================================');
  console.log(`DAY 17 USAGE SUITE COMPLETE: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================');

  if (failures > 0) process.exit(1);
}

runSuite().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
