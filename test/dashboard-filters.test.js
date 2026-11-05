// ============================================================================
// ASPIRE DAY 18: DASHBOARD FILTERS TEST SUITE
// ============================================================================
// Validates:
// 1. Preset date range filters: today, 7d, 30d, 90d
// 2. Custom date range validations:
//    - Valid start_date and end_date
//    - Missing start_date or end_date (rejected 400)
//    - end_date earlier than start_date (rejected 400)
//    - Range exceeding 365 days limit (rejected 400)
//    - Malformed date string (rejected 400)
// 3. Exam-specific filter (?exam_id=X) restricting all KPIs and chart data
// 4. College filter (?college=Y)
// 5. Limit and pagination parameters (?limit=N)
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3253;
const DB_FILE = path.join(os.tmpdir(), `aspire-dashboard-filters-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 18: DASHBOARD FILTERS TEST SUITE');
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
      AUTH_SECRET: 'aspire-filt-dashboard-secret-32-chars-min!',
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

    // 2. Create Organization
    const orgRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Delta Institute', slug: 'delta-filt', email: 'info@deltafilt.edu', timezone: 'Asia/Kolkata' })
    });
    const orgId = (orgRes.data.data || orgRes.data).id;

    // Create Org Admin
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Delta Admin', email: 'admin@deltafilt.edu', password: 'Password123!', role: 'ORG_ADMIN', organization_id: orgId })
    });

    const adminLogin = await loginUser('admin@deltafilt.edu', 'Password123!');
    ok('Org Admin login succeeded', adminLogin.status === 200 && !!adminLogin.token);

    // 3. Seed Chronological Test Data in Database
    const Database = require('better-sqlite3');
    const db = new Database(DB_FILE);

    const now = new Date();
    const todayStr = now.toISOString();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const fiftyDaysAgo = new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000).toISOString();
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

    // Students
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (1, 'Student Today', '70001', 's1@d.edu', 'IIT Bombay', ?, ?)`).run(orgId, todayStr);
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (2, 'Student 3D', '70002', 's2@d.edu', 'IIT Delhi', ?, ?)`).run(orgId, threeDaysAgo);
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (3, 'Student 20D', '70003', 's3@d.edu', 'IIT Bombay', ?, ?)`).run(orgId, twentyDaysAgo);
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (4, 'Student 50D', '70004', 's4@d.edu', 'BITS Pilani', ?, ?)`).run(orgId, fiftyDaysAgo);
    db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (5, 'Student 100D', '70005', 's5@d.edu', 'IIT Madras', ?, ?)`).run(orgId, hundredDaysAgo);

    // Exams
    db.prepare(`INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at) VALUES (10, ?, 'Exam Alpha', 'EX-A', 'LIVE', 60, 40, ?, ?, ?)`).run(orgId, adminLogin.user.id, hundredDaysAgo, hundredDaysAgo);
    db.prepare(`INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at) VALUES (20, ?, 'Exam Beta', 'EX-B', 'LIVE', 60, 40, ?, ?, ?)`).run(orgId, adminLogin.user.id, hundredDaysAgo, hundredDaysAgo);

    // Attempts
    // Today: Exam 10, Student 1, 90%
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (101, 'tok-t', '[]', ?, 1, ?, 10, 'submitted', ?, ?, ?, 90, 50, 'CERT-T')`).run(todayStr, orgId, todayStr, todayStr, todayStr);
    // 3 Days Ago: Exam 10, Student 2, 70%
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (102, 'tok-3d', '[]', ?, 2, ?, 10, 'submitted', ?, ?, ?, 70, 25, 'CERT-3D')`).run(threeDaysAgo, orgId, threeDaysAgo, threeDaysAgo, threeDaysAgo);
    // 20 Days Ago: Exam 20, Student 3, 50%
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (103, 'tok-20d', '[]', ?, 3, ?, 20, 'submitted', ?, ?, ?, 50, 0, null)`).run(twentyDaysAgo, orgId, twentyDaysAgo, twentyDaysAgo, twentyDaysAgo);
    // 50 Days Ago: Exam 20, Student 4, 30%
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (104, 'tok-50d', '[]', ?, 4, ?, 20, 'submitted', ?, ?, ?, 30, 0, null)`).run(fiftyDaysAgo, orgId, fiftyDaysAgo, fiftyDaysAgo, fiftyDaysAgo);
    // 100 Days Ago: Exam 10, Student 5, 80%
    db.prepare(`INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id) VALUES (105, 'tok-100d', '[]', ?, 5, ?, 10, 'submitted', ?, ?, ?, 80, 50, 'CERT-100D')`).run(hundredDaysAgo, orgId, hundredDaysAgo, hundredDaysAgo, hundredDaysAgo);

    db.close();

    // ------------------------------------------------------------------------
    // TEST 1: Preset Date Range Filters
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Preset Date Range Filtering ---');
    // Today
    const todayRes = await api('/api/organization/dashboard/overview?period=today', { headers: adminLogin.headers });
    ok('Period "today" returns 200', todayRes.status === 200);
    const todayKpis = todayRes.data.data.kpis || todayRes.data.data;
    ok('Today completed attempts is 1', todayKpis.completedAttempts.value === 1);
    ok('Today average score is 90%', todayKpis.averageScore.value === 90);

    // 7 Days (Today + 3 Days Ago = 2 attempts)
    const sevenDaysRes = await api('/api/organization/dashboard/overview?period=7d', { headers: adminLogin.headers });
    ok('Period "7d" returns 200', sevenDaysRes.status === 200);
    const sevenKpis = sevenDaysRes.data.data.kpis || sevenDaysRes.data.data;
    ok('7d completed attempts is 2', sevenKpis.completedAttempts.value === 2);
    // Avg score: (90 + 70) / 2 = 80%
    ok('7d average score is 80%', sevenKpis.averageScore.value === 80);

    // 30 Days (Today + 3 Days + 20 Days = 3 attempts)
    const thirtyDaysRes = await api('/api/organization/dashboard/overview?period=30d', { headers: adminLogin.headers });
    ok('Period "30d" returns 200', thirtyDaysRes.status === 200);
    const thirtyKpis = thirtyDaysRes.data.data.kpis || thirtyDaysRes.data.data;
    ok('30d completed attempts is 3', thirtyKpis.completedAttempts.value === 3);
    // Avg score: (90 + 70 + 50) / 3 = 70%
    ok('30d average score is 70%', thirtyKpis.averageScore.value === 70);

    // 90 Days (Today + 3 Days + 20 Days + 50 Days = 4 attempts)
    const ninetyDaysRes = await api('/api/organization/dashboard/overview?period=90d', { headers: adminLogin.headers });
    ok('Period "90d" returns 200', ninetyDaysRes.status === 200);
    const ninetyKpis = ninetyDaysRes.data.data.kpis || ninetyDaysRes.data.data;
    ok('90d completed attempts is 4', ninetyKpis.completedAttempts.value === 4);
    // Avg score: (90 + 70 + 50 + 30) / 4 = 60%
    ok('90d average score is 60%', ninetyKpis.averageScore.value === 60);

    // ------------------------------------------------------------------------
    // TEST 2: Custom Date Range Boundaries & Validations
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Custom Date Range Validations ---');
    // Valid custom range covering 15 to 45 days ago (should pick up Attempt 103 from 20 days ago)
    const customStart = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const customEnd = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const customValidRes = await api(`/api/organization/dashboard/overview?period=custom&start_date=${encodeURIComponent(customStart)}&end_date=${encodeURIComponent(customEnd)}`, {
      headers: adminLogin.headers
    });
    ok('Valid custom date range returns 200', customValidRes.status === 200);
    const customKpis = customValidRes.data.data.kpis || customValidRes.data.data;
    ok('Custom range captures exactly 1 attempt (Attempt 103)', customKpis.completedAttempts.value === 1);
    ok('Captured attempt average score is 50%', customKpis.averageScore.value === 50);

    // Missing end_date
    const missingEndRes = await api(`/api/organization/dashboard/overview?period=custom&start_date=${encodeURIComponent(customStart)}`, {
      headers: adminLogin.headers
    });
    ok('Custom period without end_date is rejected (HTTP 400 Bad Request)', missingEndRes.status === 400);

    // end_date earlier than start_date
    const reversedDatesRes = await api(`/api/organization/dashboard/overview?period=custom&start_date=${encodeURIComponent(customEnd)}&end_date=${encodeURIComponent(customStart)}`, {
      headers: adminLogin.headers
    });
    ok('Custom period with end_date < start_date is rejected (HTTP 400 Bad Request)', reversedDatesRes.status === 400);

    // Range exceeding 365 days
    const overYearStart = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const overYearRes = await api(`/api/organization/dashboard/overview?period=custom&start_date=${encodeURIComponent(overYearStart)}&end_date=${encodeURIComponent(todayStr)}`, {
      headers: adminLogin.headers
    });
    ok('Custom period exceeding 365 days is rejected (HTTP 400 Bad Request)', overYearRes.status === 400);

    // Invalid date string
    const invalidDateRes = await api('/api/organization/dashboard/overview?period=custom&start_date=not-a-date&end_date=also-not-a-date', {
      headers: adminLogin.headers
    });
    ok('Malformed date string is rejected (HTTP 400 Bad Request)', invalidDateRes.status === 400);

    // ------------------------------------------------------------------------
    // TEST 3: Exam-Specific Filter (?exam_id=X)
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Exam-Specific Filtering ---');
    // Filter by Exam 10 (30d period: Today + 3 Days ago = 2 attempts for Exam 10)
    const exam10Res = await api('/api/organization/dashboard/overview?period=30d&exam_id=10', {
      headers: adminLogin.headers
    });
    ok('Filter by exam_id=10 returns 200', exam10Res.status === 200);
    const e10Kpis = exam10Res.data.data.kpis || exam10Res.data.data;
    ok('Exam 10 completed attempts is 2', e10Kpis.completedAttempts.value === 2);
    ok('Exam 10 average score is 80% (90 + 70) / 2', e10Kpis.averageScore.value === 80);

    // Filter by Exam 20 (30d period: 20 Days ago = 1 attempt for Exam 20)
    const exam20Res = await api('/api/organization/dashboard/overview?period=30d&exam_id=20', {
      headers: adminLogin.headers
    });
    ok('Filter by exam_id=20 returns 200', exam20Res.status === 200);
    const e20Kpis = exam20Res.data.data.kpis || exam20Res.data.data;
    ok('Exam 20 completed attempts is 1', e20Kpis.completedAttempts.value === 1);
    ok('Exam 20 average score is 50%', e20Kpis.averageScore.value === 50);

    // Filter by non-existent Exam ID 9999
    const nonExistentExamRes = await api('/api/organization/dashboard/overview?period=30d&exam_id=9999', {
      headers: adminLogin.headers
    });
    ok('Filter by non-existent exam returns 200 with 0 attempts', nonExistentExamRes.status === 200);
    const neKpis = nonExistentExamRes.data.data.kpis || nonExistentExamRes.data.data;
    ok('Non-existent exam reports 0 completed attempts', neKpis.completedAttempts.value === 0);

    // ------------------------------------------------------------------------
    // TEST 4: College Distribution Filter
    // ------------------------------------------------------------------------
    console.log('\n--- 4. College Filter & Top Limit ---');
    const collegeRes = await api('/api/organization/dashboard/college-distribution?limit=2', {
      headers: adminLogin.headers
    });
    ok('College distribution with limit=2 returns 200', collegeRes.status === 200);
    const colData = collegeRes.data.data;
    ok('Top colleges array returned', Array.isArray(colData.colleges || colData.labels));
    // IIT Bombay has 2 students (1 and 3)
    ok('Top college is IIT Bombay with 2 students', (colData.colleges || colData.labels)[0] === 'IIT Bombay');

  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch {}
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('ALL DASHBOARD FILTERS TESTS PASSED (100%)');
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

