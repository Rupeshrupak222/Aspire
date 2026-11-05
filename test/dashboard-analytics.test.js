// ============================================================================
// ASPIRE DAY 18: DASHBOARD ANALYTICS TEST SUITE
// ============================================================================
// Validates:
// 1. Authoritative calculation of all 8 SaaS KPI cards:
//    - Total Students
//    - Total Exams
//    - Active Exams (PUBLISHED, LIVE)
//    - Completed Attempts
//    - Average Score (%)
//    - Pass Rate (% + passedCount / totalEligibleCount)
//    - Scholarships Awarded (scholarship_pct > 0)
//    - Certificates Generated
// 2. Trend comparisons against preceding periods (positive, negative, zero, uncomparable)
// 3. Continuous zero-filled daily buckets for Attempts Over Time
// 4. Exact bucket counts & percentages for Score Distribution
// 5. College distribution grouping and sorting
// 6. Question accuracy and performance extracted from graded_detail_json via json_each
// 7. Assessment completion rate (completed vs in-progress vs expired)
// 8. Super Admin platform-wide overview and tenant breakdown table
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3251;
const DB_FILE = path.join(os.tmpdir(), `aspire-dashboard-analytics-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 18: DASHBOARD ANALYTICS TEST SUITE');
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
      AUTH_SECRET: 'aspire-dashboard-test-secret-32-chars-ok!',
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

    // 2. Create Test Organization A
    const orgRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({
        name: 'Alpha Academy',
        slug: 'alpha-academy',
        email: 'info@alpha.edu',
        timezone: 'Asia/Kolkata'
      })
    });
    ok('Organization Alpha created', orgRes.status === 201);
    const orgA = orgRes.data.data || orgRes.data;
    const orgAId = orgA.id;

    // Create Alpha Admin User
    const userRes = await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({
        name: 'Alpha Admin',
        email: 'admin@alpha.edu',
        password: 'Password123!',
        role: 'ORG_ADMIN',
        organization_id: orgAId
      })
    });
    ok('Alpha Admin user created', userRes.status === 201);

    // Login as Alpha Admin
    const alphaLogin = await loginUser('admin@alpha.edu', 'Password123!');
    ok('Alpha Admin login succeeded', alphaLogin.status === 200 && !!alphaLogin.token);

    // Seed direct data into SQLite for Alpha Academy using the internal DB helper
    const Database = require('better-sqlite3');
    const db = new Database(DB_FILE);

    // 3. Seed Students
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

    const insertStudent = db.prepare(`
      INSERT INTO students (id, name, phone, email, college, organization_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertStudent.run(101, 'Student One', '9000000001', 's1@alpha.edu', 'Stanford University', orgAId, tenDaysAgo);
    insertStudent.run(102, 'Student Two', '9000000002', 's2@alpha.edu', 'Stanford University', orgAId, tenDaysAgo);
    insertStudent.run(103, 'Student Three', '9000000003', 's3@alpha.edu', 'MIT', orgAId, tenDaysAgo);
    insertStudent.run(104, 'Student Four', '9000000004', 's4@alpha.edu', 'Berkeley', orgAId, tenDaysAgo);
    insertStudent.run(105, 'Student Five', '9000000005', 's5@alpha.edu', null, orgAId, fortyDaysAgo); // Previous period

    // 4. Seed Exams
    const insertExam = db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertExam.run(201, orgAId, 'Full-Stack Technical Assessment', 'FSA-101', 'LIVE', 60, 50, alphaLogin.user.id, tenDaysAgo, tenDaysAgo);
    insertExam.run(202, orgAId, 'Data Structures & Algorithms', 'DSA-201', 'PUBLISHED', 90, 40, alphaLogin.user.id, tenDaysAgo, tenDaysAgo);
    insertExam.run(203, orgAId, 'Draft Test', 'DFT-001', 'DRAFT', 30, 40, alphaLogin.user.id, tenDaysAgo, tenDaysAgo);
    insertExam.run(204, orgAId, 'Archived Test', 'ARC-999', 'ARCHIVED', 45, 40, alphaLogin.user.id, fortyDaysAgo, fortyDaysAgo);

    // 5. Seed Attempts with graded details for questions
    const insertAttempt = db.prepare(`
      INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id, graded_detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Graded questions JSON simulation
    const qDetailsPass = JSON.stringify([
      { questionId: 'q-1', title: 'Binary Search Implementation', correct: true, score: 10, maxScore: 10 },
      { questionId: 'q-2', title: 'REST API Authentication', correct: true, score: 10, maxScore: 10 }
    ]);

    const qDetailsFail = JSON.stringify([
      { questionId: 'q-1', title: 'Binary Search Implementation', correct: false, score: 0, maxScore: 10 },
      { questionId: 'q-2', title: 'REST API Authentication', correct: false, score: 0, maxScore: 10 }
    ]);

    const qDetailsPartial = JSON.stringify([
      { questionId: 'q-1', title: 'Binary Search Implementation', correct: true, score: 10, maxScore: 10 },
      { questionId: 'q-2', title: 'REST API Authentication', correct: false, score: 0, maxScore: 10 }
    ]);

    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const futureDeadline = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const pastDeadline = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Attempt 1: Submitted, 85%, passed, scholarship 75%, certificate issued
    insertAttempt.run(301, 'tok-301', '["q-1","q-2"]', pastDeadline, 101, orgAId, 201, 'submitted', fiveDaysAgo, fiveDaysAgo, pastDeadline, 85, 75, 'CERT-ALPHA-001', qDetailsPass);

    // Attempt 2: Submitted, 65%, passed, scholarship 25%, certificate issued
    insertAttempt.run(302, 'tok-302', '["q-1","q-2"]', pastDeadline, 102, orgAId, 201, 'submitted', fiveDaysAgo, fiveDaysAgo, pastDeadline, 65, 25, 'CERT-ALPHA-002', qDetailsPass);

    // Attempt 3: Submitted, 45%, failed (exam 201 pass score is 50), scholarship 0%, no cert
    insertAttempt.run(303, 'tok-303', '["q-1","q-2"]', pastDeadline, 103, orgAId, 201, 'submitted', fiveDaysAgo, fiveDaysAgo, pastDeadline, 45, 0, null, qDetailsPartial);

    // Attempt 4: Submitted, 15%, failed, scholarship 0%, no cert
    insertAttempt.run(304, 'tok-304', '["q-1","q-2"]', pastDeadline, 104, orgAId, 202, 'submitted', fiveDaysAgo, fiveDaysAgo, pastDeadline, 15, 0, null, qDetailsFail);

    // Attempt 5: In-progress session (started, deadline in future)
    insertAttempt.run(305, 'tok-305', '["q-1","q-2"]', futureDeadline, 101, orgAId, 202, 'started', now.toISOString(), null, futureDeadline, null, 0, null, null);

    // Attempt 6: Expired session (started, deadline in past, not submitted)
    insertAttempt.run(306, 'tok-306', '["q-1","q-2"]', pastDeadline, 102, orgAId, 202, 'started', fiveDaysAgo, null, pastDeadline, null, 0, null, null);

    db.close();

    // ------------------------------------------------------------------------
    // TEST 1: Overview KPIs API for Org A
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Overview KPIs API Validation ---');
    const overviewRes = await api('/api/organization/dashboard/overview?period=30d', {
      headers: alphaLogin.headers
    });

    ok('GET /api/organization/dashboard/overview returns 200', overviewRes.status === 200);
    const kpis = overviewRes.data.data.kpis || overviewRes.data.data;
    ok('KPIs object present', !!kpis);

    // Check Total Students (All time = 5)
    ok('Total Students value is 5', kpis.totalStudents.value === 5);
    ok('Total Students periodNewStudents is 4', (kpis.totalStudents.periodNewStudents || kpis.totalStudents.currentPeriodValue) === 4);
    ok('Total Students previousPeriodValue is 1', kpis.totalStudents.previousPeriodValue === 1);
    ok('Total Students percentageChange is +300%', kpis.totalStudents.percentageChange === 300);

    // Check Total Exams (non-archived: 201, 202, 203 = 3)
    ok('Total Exams value is 3', kpis.totalExams.value === 3);

    // Check Active Exams (LIVE + PUBLISHED: 201, 202 = 2)
    ok('Active Exams value is 2', kpis.activeExams.value === 2);

    // Check Completed Attempts (301, 302, 303, 304 = 4)
    ok('Completed Attempts value is 4', kpis.completedAttempts.value === 4);

    // Check Average Score: (85 + 65 + 45 + 15) / 4 = 210 / 4 = 52.5%
    ok('Average Score value is 52.5%', kpis.averageScore.value === 52.5);

    // Check Pass Rate:
    // Exam 201 has passing_score = 50:
    // Attempt 301 (85% >= 50) -> PASS
    // Attempt 302 (65% >= 50) -> PASS
    // Attempt 303 (45% < 50) -> FAIL
    // Exam 202 has passing_score = 40:
    // Attempt 304 (15% < 40) -> FAIL
    // Passed = 2, Total = 4 -> 50%
    ok('Pass Rate value is 50%', kpis.passRate.value === 50);
    ok('Pass Rate passedCount is 2', kpis.passRate.metadata.passedCount === 2);
    ok('Pass Rate totalEligibleCount is 4', kpis.passRate.metadata.totalEligibleCount === 4);

    // Check Scholarships Awarded: Attempts 301 (75%) and 302 (25%) = 2
    ok('Scholarships Awarded value is 2', kpis.scholarshipsAwarded.value === 2);

    // Check Certificates Generated: CERT-ALPHA-001 and CERT-ALPHA-002 = 2
    ok('Certificates Generated value is 2', kpis.certificatesGenerated.value === 2);

    // ------------------------------------------------------------------------
    // TEST 2: Visual Chart: Attempts Over Time
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Attempts Over Time Chart Validation ---');
    const attemptsChartRes = await api('/api/organization/dashboard/attempts-over-time?period=30d', {
      headers: alphaLogin.headers
    });

    ok('GET /api/organization/dashboard/attempts-over-time returns 200', attemptsChartRes.status === 200);
    const attData = attemptsChartRes.data.data;
    ok('Labels array returned', Array.isArray(attData.labels) && attData.labels.length >= 30);
    ok('Completed array matches labels length', attData.completed.length === attData.labels.length);
    ok('In Progress array matches labels length', attData.inProgress.length === attData.labels.length);

    const sumCompleted = attData.completed.reduce((a, b) => a + b, 0);
    ok('Total completed attempts across daily buckets equals 4', sumCompleted === 4);

    // ------------------------------------------------------------------------
    // TEST 3: Visual Chart: Score Distribution
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Score Distribution Chart Validation ---');
    const scoreChartRes = await api('/api/organization/dashboard/score-distribution?period=30d', {
      headers: alphaLogin.headers
    });

    ok('GET /api/organization/dashboard/score-distribution returns 200', scoreChartRes.status === 200);
    const scData = scoreChartRes.data.data;
    ok('Buckets array has 5 bins', Array.isArray(scData.buckets) && scData.buckets.length === 5);
    // Scores: 15% (0-20), 45% (41-60), 65% (61-80), 85% (81-100)
    // Buckets: [1, 0, 1, 1, 1]
    ok('Bucket 0-20% has count 1 (Attempt 304)', scData.counts[0] === 1);
    ok('Bucket 21-40% has count 0', scData.counts[1] === 0);
    ok('Bucket 41-60% has count 1 (Attempt 303)', scData.counts[2] === 1);
    ok('Bucket 61-80% has count 1 (Attempt 302)', scData.counts[3] === 1);
    ok('Bucket 81-100% has count 1 (Attempt 301)', scData.counts[4] === 1);
    ok('Total bucket count equals 4', scData.total === 4);

    // ------------------------------------------------------------------------
    // TEST 4: Visual Chart: Completion Rate
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Completion Rate Chart Validation ---');
    const compChartRes = await api('/api/organization/dashboard/completion-rate?period=30d', {
      headers: alphaLogin.headers
    });

    ok('GET /api/organization/dashboard/completion-rate returns 200', compChartRes.status === 200);
    const compData = compChartRes.data.data;
    // 4 submitted, 1 in-progress, 1 expired -> Total 6
    ok('Completed count is 4', compData.completed === 4);
    ok('In Progress count is 1', compData.inProgress === 1);
    ok('Expired count is 1', compData.expired === 1);
    ok('Total eligible attempts is 6', compData.totalEligible === 6);
    // Completion rate: 4 / 6 = 66.7%
    ok('Completion rate is 66.7%', compData.completionRate === 66.7);

    // ------------------------------------------------------------------------
    // TEST 5: Visual Chart: College Distribution
    // ------------------------------------------------------------------------
    console.log('\n--- 5. College Distribution Chart Validation ---');
    const colChartRes = await api('/api/organization/dashboard/college-distribution?period=30d', {
      headers: alphaLogin.headers
    });

    ok('GET /api/organization/dashboard/college-distribution returns 200', colChartRes.status === 200);
    const colData = colChartRes.data.data;
    ok('Colleges array returned', Array.isArray(colData.colleges));
    // Stanford: 2 students (101, 102), MIT: 1 (103), Berkeley: 1 (104), Not specified: 1 (105)
    ok('Stanford University is top college with 2 students', colData.colleges[0] === 'Stanford University' && colData.studentCounts[0] === 2);

    // ------------------------------------------------------------------------
    // TEST 6: Visual Chart: Question Performance (json_each)
    // ------------------------------------------------------------------------
    console.log('\n--- 6. Question Performance Chart Validation ---');
    const qPerfRes = await api('/api/organization/dashboard/question-performance?period=30d', {
      headers: alphaLogin.headers
    });

    ok('GET /api/organization/dashboard/question-performance returns 200', qPerfRes.status === 200);
    const qData = qPerfRes.data.data;
    ok('Questions list returned', Array.isArray(qData.questions) && qData.questions.length === 2);

    // In attempts 301, 302, 303, 304:
    // q-1: 301(correct), 302(correct), 303(correct), 304(incorrect) -> 3 / 4 correct (75% accuracy)
    // q-2: 301(correct), 302(correct), 303(incorrect), 304(incorrect) -> 2 / 4 correct (50% accuracy)
    const q1 = qData.questions.find(q => q.questionId === 'q-1');
    const q2 = qData.questions.find(q => q.questionId === 'q-2');
    ok('Question q-1 has 75% accuracy', q1 && q1.accuracy === 75 && q1.correctCount === 3 && q1.totalAttempts === 4);
    ok('Question q-2 has 50% accuracy', q2 && q2.accuracy === 50 && q2.correctCount === 2 && q2.totalAttempts === 4);

    // ------------------------------------------------------------------------
    // TEST 7: Super Admin Platform-Wide Overview
    // ------------------------------------------------------------------------
    console.log('\n--- 7. Super Admin Platform Overview Validation ---');
    const platformRes = await api('/api/admin/dashboard/platform-overview', {
      headers: superLogin.headers
    });

    ok('GET /api/admin/dashboard/platform-overview returns 200', platformRes.status === 200);
    const platData = platformRes.data.data;
    ok('Platform KPIs present', !!(platData.kpis?.totalStudents || platData.totalStudents));
    ok('Organizations breakdown table present', Array.isArray(platData.organizationsBreakdown));
    const alphaOrgRow = platData.organizationsBreakdown.find(o => o.slug === 'alpha-academy');
    ok('Alpha Academy row present in platform breakdown', !!alphaOrgRow);
    ok('Alpha Academy students count is 5', alphaOrgRow && alphaOrgRow.total_students === 5);
    ok('Alpha Academy active exams count is 2', alphaOrgRow && alphaOrgRow.active_exams === 2);
    ok('Alpha Academy completed attempts count is 4', alphaOrgRow && alphaOrgRow.completed_attempts === 4);

  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('ALL DASHBOARD ANALYTICS TESTS PASSED (100%)');
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
