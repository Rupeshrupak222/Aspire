// ============================================================================
// ASPIRE DAY 19: EXAM CANDIDATE ANALYTICS & FUNNEL TEST SUITE
// ============================================================================
// Validates:
// 1. Registered candidates count (unique student IDs registered)
// 2. Started candidates count (candidates who initiated an attempt)
// 3. Completed candidates count (finalized submitted attempts)
// 4. Abandoned candidates count (expired or explicitly abandoned attempts)
// 5. Active/In-progress candidates NOT classified as abandoned
// 6. Passed candidates count (evaluated using exam passing_score threshold)
// 7. Failed candidates count (evaluated using exam passing_score threshold)
// 8. Conversion rates & drop-off metrics in Candidate Funnel
// 9. Retake statistics (distinguishing unique candidates from attempt counts)
// 10. Empty exams handling (clean zero values, no division by zero or errors)
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');

const PORT = 3261;
const DB_FILE = path.join(os.tmpdir(), `aspire-exam-analytics-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 19: EXAM CANDIDATE ANALYTICS TEST SUITE');
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
      AUTH_SECRET: 'aspire-exam-analytics-test-secret-32-chars!',
      CODE_EXECUTION_PROVIDER: 'MOCK',
      CODE_EXECUTION_FALLBACK: 'true',
      RATE_LIMIT_DISABLED: 'true'
    },
    stdio: 'inherit'
  });

  try {
    const ready = await waitForServer();
    assert(ready, 'Test server failed to start within timeout');
    console.log(`Server started on ${BASE} with DB: ${DB_FILE}\n`);

    // 1. Authenticate as Super Admin
    const superLogin = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');
    ok('Super Admin login succeeded', superLogin.status === 200 && !!superLogin.token);

    // 2. Create Test Organization
    const orgRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({
        name: 'Vanguard Academy',
        slug: 'vanguard-academy',
        email: 'info@vanguard.edu',
        timezone: 'Asia/Kolkata'
      })
    });
    ok('Organization created', orgRes.status === 201);
    const orgId = orgRes.data.id || orgRes.data.data?.id;

    // Create Org Admin User
    const userRes = await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({
        name: 'Vanguard Admin',
        email: 'admin@vanguard.edu',
        password: 'Password123!',
        role: 'ORG_ADMIN',
        organization_id: orgId
      })
    });
    ok('Org Admin user created', userRes.status === 201);

    // Login as Vanguard Admin
    const orgLogin = await loginUser('admin@vanguard.edu', 'Password123!');
    ok('Org Admin login succeeded', orgLogin.status === 200 && !!orgLogin.token);

    // Seed Data into SQLite
    const db = new Database(DB_FILE);

    // Create Exam with passing score 50
    const insExam = db.prepare(`
      INSERT INTO exams (
        id, organization_id, name, code, description, status, version, duration_minutes,
        total_marks, passing_score, max_attempts, is_default, created_at, published_at
      ) VALUES (?, ?, ?, ?, ?, 'PUBLISHED', 1, 60, 100, 50, 3, 0, datetime('now'), datetime('now'))
    `);
    insExam.run(10, orgId, 'Engineering Aptitude Test', 'ENG-APT-2026', 'Official assessment');

    // Create Empty Exam (to test empty state handling)
    insExam.run(11, orgId, 'Empty Future Exam', 'EMPTY-2026', 'Zero candidate exam');

    // Seed Students (10 students)
    const insStudent = db.prepare(`
      INSERT INTO students (id, name, phone, email, college, organization_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (let i = 1; i <= 10; i++) {
      insStudent.run(100 + i, `Student ${i}`, `987654321${i % 10}`, `student${i}@test.com`, 'Tech Institute', orgId);
    }

    // Seed Attempts for Exam 10:
    // Candidate 1: Completed, Passed (score 80, pct 80)
    // Candidate 2: Completed, Passed (score 65, pct 65)
    // Candidate 3: Completed, Failed (score 40, pct 40) (< passing_score 50)
    // Candidate 4: Completed, Failed (score 30, pct 30) (< passing_score 50)
    // Candidate 5: Abandoned (explicit status = 'abandoned')
    // Candidate 6: Expired / Timed out (status = 'started', deadline in past)
    // Candidate 7: In-progress / Active (status = 'started', deadline in future)
    // Candidate 8: Registered with retake! Attempt 1: submitted 45% (failed), Attempt 2: submitted 75% (passed)
    // Candidate 9: Registered, started_at is NULL (registered but never started)
    // Candidate 10: Registered, started_at is NULL (registered but never started)

    const insAttempt = db.prepare(`
      INSERT INTO attempts (
        id, token, student_id, organization_id, exam_id, status, started_at, submitted_at,
        deadline_at, expires_at, score, total_marks, percentage, scholarship_pct, finalization_status, question_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const pastDate = new Date(Date.now() - 3600000).toISOString();
    const futureDate = new Date(Date.now() + 3600000).toISOString();
    const nowIso = new Date().toISOString();

    // 1. Completed Passed
    insAttempt.run(1, 'tok-1', 101, orgId, 10, 'submitted', pastDate, nowIso, futureDate, futureDate, 80, 100, 80, 50, 'FINALIZED', '[]');
    // 2. Completed Passed
    insAttempt.run(2, 'tok-2', 102, orgId, 10, 'submitted', pastDate, nowIso, futureDate, futureDate, 65, 100, 65, 25, 'FINALIZED', '[]');
    // 3. Completed Failed
    insAttempt.run(3, 'tok-3', 103, orgId, 10, 'submitted', pastDate, nowIso, futureDate, futureDate, 40, 100, 40, 0, 'FINALIZED', '[]');
    // 4. Completed Failed
    insAttempt.run(4, 'tok-4', 104, orgId, 10, 'submitted', pastDate, nowIso, futureDate, futureDate, 30, 100, 30, 0, 'FINALIZED', '[]');
    // 5. Explicitly abandoned
    insAttempt.run(5, 'tok-5', 105, orgId, 10, 'abandoned', pastDate, null, pastDate, pastDate, null, 100, null, 0, 'FAILED', '[]');
    // 6. Timed out / expired (status started, deadline past)
    insAttempt.run(6, 'tok-6', 106, orgId, 10, 'started', pastDate, null, pastDate, pastDate, null, 100, null, 0, 'PENDING', '[]');
    // 7. Active / in-progress (deadline in future)
    insAttempt.run(7, 'tok-7', 107, orgId, 10, 'started', pastDate, null, futureDate, futureDate, null, 100, null, 0, 'PENDING', '[]');
    // 8. Candidate 8 (Retake):
    // Attempt 8a: submitted 45%
    insAttempt.run(8, 'tok-8a', 108, orgId, 10, 'submitted', pastDate, pastDate, futureDate, futureDate, 45, 100, 45, 0, 'FINALIZED', '[]');
    // Attempt 8b: submitted 75%
    insAttempt.run(9, 'tok-8b', 108, orgId, 10, 'submitted', pastDate, nowIso, futureDate, futureDate, 75, 100, 75, 50, 'FINALIZED', '[]');
    // 9. Registered only (not started yet, status = 'registered')
    insAttempt.run(10, 'tok-9', 109, orgId, 10, 'registered', pastDate, null, futureDate, futureDate, null, 100, null, 0, 'PENDING', '[]');
    // 10. Registered only (not started yet, status = 'registered')
    insAttempt.run(11, 'tok-10', 110, orgId, 10, 'registered', pastDate, null, futureDate, futureDate, null, 100, null, 0, 'PENDING', '[]');

    console.log('Seeded test assessment attempts.');

    // TEST 1: GET Exam Analytics Overview
    console.log('\n--- 1. Exam Analytics Overview & Funnel ---');
    const overviewRes = await api('/api/organization/exams/10/analytics/overview', {
      headers: orgLogin.headers
    });
    ok('Overview endpoint responded 200', overviewRes.status === 200);
    const kpis = overviewRes.data?.data?.kpis;
    const funnel = overviewRes.data?.data?.funnel;

    // Unique Candidates Check:
    // Total registered unique students = 10 (101 to 110)
    ok('Registered candidates count is 10', kpis?.registered === 10, `got ${kpis?.registered}`);
    // Started unique students = 8 (101 to 108 have started_at set)
    ok('Started candidates count is 8', kpis?.started === 8, `got ${kpis?.started}`);
    // Completed unique students = 5 (101, 102, 103, 104, 108)
    ok('Completed candidates count is 5', kpis?.completed === 5, `got ${kpis?.completed}`);
    // Completed attempts total = 6 (101, 102, 103, 104, 108[2 attempts])
    ok('Completed attempts total is 6', kpis?.completedAttempts === 6, `got ${kpis?.completedAttempts}`);
    // Passed candidates count: 101(80), 102(65), 108(75) -> 3 candidates
    ok('Passed candidates count is 3', kpis?.passed === 3, `got ${kpis?.passed}`);
    // Failed candidates count: 103(40), 104(30), 108(has one 45%) -> 3 unique candidates failed an attempt
    ok('Failed candidates count is 3', kpis?.failed === 3, `got ${kpis?.failed}`);
    // Pass rate = (3 / 5) * 100 = 60.0%
    ok('Pass rate is 60.0%', kpis?.passRate === 60, `got ${kpis?.passRate}`);
    // Abandoned candidates count = 2 (Candidate 105 explicit, Candidate 106 deadline expired)
    ok('Abandoned candidates count is 2', kpis?.abandoned === 2, `got ${kpis?.abandoned}`);
    // In-progress active candidate = 1 (Candidate 107)
    ok('In-progress candidates count is 1', kpis?.inProgress === 1, `got ${kpis?.inProgress}`);
    // Active candidate must NOT be counted as abandoned
    ok('Active candidate is not classified as abandoned', kpis?.abandoned !== 3);

    // Funnel Stage Checks
    ok('Funnel has 4 stages', Array.isArray(funnel) && funnel.length === 4);
    const regStage = funnel.find(s => s.stage === 'Registered');
    const startStage = funnel.find(s => s.stage === 'Started');
    const compStage = funnel.find(s => s.stage === 'Completed');
    const passStage = funnel.find(s => s.stage === 'Passed');

    ok('Registered stage count is 10', regStage?.count === 10);
    ok('Started stage count is 8', startStage?.count === 8);
    ok('Started drop-off from registered is 2 (20%)', regStage?.dropOff === 2 && regStage?.dropOffRate === 20);
    ok('Completed stage count is 5', compStage?.count === 5);
    ok('Completed drop-off from started is 3 (37.5%)', startStage?.dropOff === 3 && startStage?.dropOffRate === 37.5);
    ok('Passed stage count is 3', passStage?.count === 3);

    // TEST 2: Candidate Roster & Retake Analytics
    console.log('\n--- 2. Candidate Roster & Retake Analytics ---');
    const candRes = await api('/api/organization/exams/10/analytics/candidates', {
      headers: orgLogin.headers
    });
    ok('Candidates endpoint responded 200', candRes.status === 200);
    const summary = candRes.data?.data?.summary;
    const candidateList = candRes.data?.data?.candidates;

    ok('Unique candidates count is 10', summary?.uniqueCandidates === 10);
    ok('Total attempts count is 11', summary?.totalAttempts === 11);
    ok('Multiple attempt candidates count is 1', summary?.multipleAttemptCandidates === 1);
    ok('Max attempts single candidate is 2', summary?.maxAttemptsBySingleCandidate === 2);
    ok('Average attempts per candidate is 1.1', summary?.averageAttemptsPerCandidate === 1.1);

    // Verify candidate list rows
    const c108 = candidateList.find(c => c.student_id === 108);
    ok('Candidate 108 found with 2 attempts', c108 && c108.attemptCount === 2);
    ok('Candidate 108 best percentage is 75%', c108 && c108.percentage === 75);
    ok('Candidate 108 passed is true', c108 && c108.passed === true);

    // TEST 3: Candidate Filtering
    console.log('\n--- 3. Candidate Status Filtering ---');
    const passedOnly = await api('/api/organization/exams/10/analytics/candidates?status=passed', {
      headers: orgLogin.headers
    });
    ok('Passed filter returned 3 candidates', passedOnly.data?.data?.candidates?.length === 3);

    const abandonedOnly = await api('/api/organization/exams/10/analytics/candidates?status=abandoned', {
      headers: orgLogin.headers
    });
    ok('Abandoned filter returned 2 candidates', abandonedOnly.data?.data?.candidates?.length === 2);

    // TEST 4: Empty Exam Handling
    console.log('\n--- 4. Empty Exam Handling ---');
    const emptyRes = await api('/api/organization/exams/11/analytics/overview', {
      headers: orgLogin.headers
    });
    ok('Empty exam overview responded 200', emptyRes.status === 200);
    const emptyKpis = emptyRes.data?.data?.kpis;
    ok('Empty registered is 0', emptyKpis?.registered === 0);
    ok('Empty started is 0', emptyKpis?.started === 0);
    ok('Empty completed is 0', emptyKpis?.completed === 0);
    ok('Empty passRate is 0', emptyKpis?.passRate === 0);
    ok('Empty medianScore is null', emptyKpis?.medianScore === null);
    ok('Empty highestScore is null', emptyKpis?.highestScore === null);

    db.close();
  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log(`\nCandidate Analytics Test Suite Completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
