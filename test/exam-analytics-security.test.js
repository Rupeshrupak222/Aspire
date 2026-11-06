// ============================================================================
// ASPIRE DAY 19: EXAM ANALYTICS SECURITY & TENANT ISOLATION TEST SUITE
// ============================================================================
// Validates:
// 1. Strict multi-tenant isolation across Organizations A, B, and C
// 2. Org A cannot access Org B's exam analytics (fail-closed 404)
// 3. Org A cannot access Org B's question analytics or coding metrics
// 4. Org A cannot access Org B's candidate roster or performance distributions
// 5. Client IDOR manipulations on examId or questionId are cleanly rejected
// 6. Role-Based Access Control:
//    - Unauthenticated calls rejected with 401 Unauthorized
//    - VIEWER role rejected with 403 Forbidden (lacks analytics.read permission)
//    - EVALUATOR role granted access (has analytics.read permission)
//    - ORG_ADMIN scoped strictly to own tenant
//    - SUPER_ADMIN authorized across all exams via /api/admin/exams/:id/analytics
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');

const PORT = 3264;
const DB_FILE = path.join(os.tmpdir(), `aspire-analytics-sec-test-${Date.now()}.db`);
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
    headers: res.data?.data?.token ? { Authorization: `Bearer ${res.data.data.token}` } : {}
  };
}

async function runSuite() {
  console.log('====================================================');
  console.log('ASPIRE DAY 19: EXAM ANALYTICS SECURITY TEST SUITE');
  console.log('====================================================\n');

  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + ext); } catch { }
  }

  const proc = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB_FILE,
      NODE_ENV: 'test',
      INITIAL_ADMIN_EMAIL: 'superadmin@adyapan.internal',
      INITIAL_ADMIN_PASSWORD: 'SuperPassword123!',
      AUTH_SECRET: 'aspire-analytics-sec-secret-32-chars!',
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
    ok('Super Admin login succeeded', superLogin.status === 200);

    // 2. Create Organizations A, B, and C
    const orgARes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Org A Alpha', slug: 'org-a', email: 'admin@orga.com' })
    });
    const orgBRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Org B Beta', slug: 'org-b', email: 'admin@orgb.com' })
    });
    const orgCRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Org C Gamma', slug: 'org-c', email: 'admin@orgc.com' })
    });

    const orgAId = orgARes.data.id || orgARes.data.data?.id;
    const orgBId = orgBRes.data.id || orgBRes.data.data?.id;
    const orgCId = orgCRes.data.id || orgCRes.data.data?.id;
    ok('Organizations A, B, and C created', !!orgAId && !!orgBId && !!orgCId);

    // 3. Create Users for Org A and Org B
    // Org A Admin
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Admin A', email: 'admin@orga.com', password: 'Password123!', role: 'ORG_ADMIN', organization_id: orgAId })
    });
    // Org A Viewer
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Viewer A', email: 'viewer@orga.com', password: 'Password123!', role: 'VIEWER', organization_id: orgAId })
    });
    // Org A Evaluator
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Evaluator A', email: 'eval@orga.com', password: 'Password123!', role: 'EVALUATOR', organization_id: orgAId })
    });
    // Org B Admin
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Admin B', email: 'admin@orgb.com', password: 'Password123!', role: 'ORG_ADMIN', organization_id: orgBId })
    });

    // Logins
    const loginAdminA = await loginUser('admin@orga.com', 'Password123!');
    const loginViewerA = await loginUser('viewer@orga.com', 'Password123!');
    const loginEvalA = await loginUser('eval@orga.com', 'Password123!');
    const loginAdminB = await loginUser('admin@orgb.com', 'Password123!');

    ok('Logins succeeded for all roles', !!loginAdminA.token && !!loginViewerA.token && !!loginEvalA.token && !!loginAdminB.token);

    // Seed Exams for Org A and Org B
    const db = new Database(DB_FILE);

    // Exam 101 belongs to Org A
    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, description, status, duration_minutes, total_marks, passing_score, is_default, created_at, published_at)
      VALUES (101, ?, 'Exam Alpha', 'EX-ALPHA', 'Exam A', 'PUBLISHED', 60, 100, 40, 0, datetime('now'), datetime('now'))
    `).run(orgAId);

    // Exam 201 belongs to Org B
    db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, description, status, duration_minutes, total_marks, passing_score, is_default, created_at, published_at)
      VALUES (201, ?, 'Exam Beta', 'EX-BETA', 'Exam B', 'PUBLISHED', 60, 100, 40, 0, datetime('now'), datetime('now'))
    `).run(orgBId);

    // Questions
    db.prepare(`
      INSERT INTO questions (id, organization_id, title, question_text, type, marks, category, difficulty, status)
      VALUES (801, ?, 'Q Alpha', 'Question A', 'mcq', 2, 'general', 'easy', 'PUBLISHED')
    `).run(orgAId);
    db.prepare(`
      INSERT INTO questions (id, organization_id, title, question_text, type, marks, category, difficulty, status)
      VALUES (802, ?, 'Q Beta', 'Question B', 'mcq', 2, 'general', 'easy', 'PUBLISHED')
    `).run(orgBId);

    // Section mapping for Exam 201
    db.prepare(`INSERT INTO exam_sections (id, exam_id, name, display_order, question_selection_mode) VALUES (901, 201, 'Sec B', 1, 'MANUAL')`).run();
    db.prepare(`INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (901, 802, 1)`).run();

    console.log('Seeded multi-tenant test records.');

    // TEST 1: Cross-Tenant Isolation (Org A trying to access Org B's Exam)
    console.log('\n--- 1. Cross-Tenant IDOR Protection ---');
    // Org A accessing Org B's Exam 201 overview -> Must fail closed with 404
    const crossOverview = await api('/api/organization/exams/201/analytics/overview', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing Org B overview returns 404 Not Found', crossOverview.status === 404);

    // Org A accessing Org B's questions analytics
    const crossQuestions = await api('/api/organization/exams/201/analytics/questions', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing Org B questions returns 404 Not Found', crossQuestions.status === 404);

    // Org A accessing Org B's question detail
    const crossQDetail = await api('/api/organization/exams/201/analytics/questions/802', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing Org B question detail returns 404 Not Found', crossQDetail.status === 404);

    // Org A accessing Org B's coding analytics
    const crossCoding = await api('/api/organization/exams/201/analytics/coding', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing Org B coding analytics returns 404 Not Found', crossCoding.status === 404);

    // Org A accessing Org B's performance distributions
    const crossPerf = await api('/api/organization/exams/201/analytics/performance', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing Org B performance returns 404 Not Found', crossPerf.status === 404);

    // Org A accessing Org B's candidate roster
    const crossCand = await api('/api/organization/exams/201/analytics/candidates', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing Org B candidates returns 404 Not Found', crossCand.status === 404);

    // Org A accessing non-existent exam ID (99999)
    const nonExistent = await api('/api/organization/exams/99999/analytics/overview', {
      headers: loginAdminA.headers
    });
    ok('Non-existent exam returns 404 Not Found', nonExistent.status === 404);

    // Org A accessing their own Exam 101 -> Must succeed (200 OK)
    const ownExam = await api('/api/organization/exams/101/analytics/overview', {
      headers: loginAdminA.headers
    });
    ok('Org A accessing own Exam 101 returns 200 OK', ownExam.status === 200);

    // Org B accessing own Exam 201 -> Must succeed (200 OK)
    const orgBExam = await api('/api/organization/exams/201/analytics/overview', {
      headers: loginAdminB.headers
    });
    ok('Org B accessing own Exam 201 returns 200 OK', orgBExam.status === 200);

    // TEST 2: Role-Based Access Control (RBAC)
    console.log('\n--- 2. RBAC Enforcement on Analytics ---');
    // VIEWER role lacks analytics.read -> 403 Forbidden
    const viewerAttempt = await api('/api/organization/exams/101/analytics/overview', {
      headers: loginViewerA.headers
    });
    ok('VIEWER role accessing analytics returns 403 Forbidden', viewerAttempt.status === 403);

    // EVALUATOR role has analytics.read -> 200 OK
    const evalAttempt = await api('/api/organization/exams/101/analytics/overview', {
      headers: loginEvalA.headers
    });
    ok('EVALUATOR role accessing analytics returns 200 OK', evalAttempt.status === 200);

    // Unauthenticated request -> 401 Unauthorized
    const unauthAttempt = await api('/api/organization/exams/101/analytics/overview');
    ok('Unauthenticated request returns 401 Unauthorized', unauthAttempt.status === 401);

    // TEST 3: Super Admin Platform Access
    console.log('\n--- 3. Platform Admin Inspection Route ---');
    // Super admin can access Exam 201 (belonging to Org B) via /api/admin/exams/:id/analytics
    const superAdminExamB = await api('/api/admin/exams/201/analytics', {
      headers: superLogin.headers
    });
    ok('Super Admin can access Org B analytics via admin route', superAdminExamB.status === 200);
    ok('Super Admin response includes overview data', !!superAdminExamB.data?.data?.overview);

    // Org Admin trying to access /api/admin/exams/:id/analytics (admin route)
    // Note: /api/admin/* requires appropriate admin permissions
    const orgAdminOnPlatform = await api('/api/admin/exams/201/analytics', {
      headers: loginAdminA.headers
    });
    // Org A admin trying to inspect Org B exam on admin route must be blocked (404/fail closed)
    ok('Org A admin cannot inspect Org B exam on admin route', orgAdminOnPlatform.status === 404);

    db.close();
  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log(`\nSecurity Test Suite Completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

