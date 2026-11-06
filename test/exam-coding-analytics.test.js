// ============================================================================
// ASPIRE DAY 19: EXAM CODING ANALYTICS TEST SUITE
// ============================================================================
// Validates:
// 1. Total coding submissions and unique candidates count
// 2. Compilation failures count (submission_status = 'COMPILATION_ERROR')
// 3. Runtime failures count (submission_status = 'RUNTIME_ERROR')
// 4. Execution timeouts count (submission_status = 'TIME_LIMIT_EXCEEDED')
// 5. Provider / infrastructure failures (last_error_code = 'PROVIDER_UNAVAILABLE')
// 6. Successful executions count (submission_status = 'ACCEPTED')
// 7. Partially passed test cases count (WRONG_ANSWER with test_cases_passed > 0)
// 8. Pending/evaluating submissions (lifecycle_status IN ('QUEUED', 'RUNNING'))
// 9. Test case pass percentage: (passed / evaluated) * 100
// 10. Average execution time in ms
// 11. Programming language distribution (python, cpp, java)
// 12. Coding questions breakdown table
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');

const PORT = 3263;
const DB_FILE = path.join(os.tmpdir(), `aspire-coding-analytics-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 19: EXAM CODING ANALYTICS TEST SUITE');
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
      AUTH_SECRET: 'aspire-coding-analytics-secret-32-chars!',
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

    // 2. Create Test Organization
    const orgRes = await api('/api/admin/organizations', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({
        name: 'Apex Coders Academy',
        slug: 'apex-coders',
        email: 'info@apexcoders.edu',
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
        name: 'Apex Admin',
        email: 'admin@apexcoders.edu',
        password: 'Password123!',
        role: 'ORG_ADMIN',
        organization_id: orgId
      })
    });
    ok('Org Admin user created', userRes.status === 201);

    const orgLogin = await loginUser('admin@apexcoders.edu', 'Password123!');
    ok('Org Admin login succeeded', orgLogin.status === 200);

    // Seed Data into SQLite
    const db = new Database(DB_FILE);

    // Create Coding Assessment Exam
    db.prepare(`
      INSERT INTO exams (
        id, organization_id, name, code, description, status, version, duration_minutes,
        total_marks, passing_score, max_attempts, is_default, created_at, published_at
      ) VALUES (30, ?, 'Algorithms & Data Structures Practical', 'ALGO-PRAC-2026', 'Practical coding exam', 'PUBLISHED', 1, 90, 50, 40, 1, 0, datetime('now'), datetime('now'))
    `).run(orgId);

    // Create Coding Questions
    const insQ = db.prepare(`
      INSERT INTO questions (id, organization_id, title, question_text, type, marks, category, difficulty, status)
      VALUES (?, ?, ?, ?, 'code', ?, 'coding', 'medium', 'PUBLISHED')
    `);
    insQ.run(501, orgId, 'Two Sum in Linear Time', 'Find indices that sum to target', 25);
    insQ.run(502, orgId, 'Merge K Sorted Lists', 'Merge k linked lists in optimal time', 25);

    // Seed Students
    const insStudent = db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
    for (let i = 1; i <= 6; i++) {
      insStudent.run(600 + i, `Coder ${i}`, `920000000${i}`, `coder${i}@apex.edu`, 'Apex Engineering', orgId);
    }

    // Seed Attempts for Students
    const insAttempt = db.prepare(`
      INSERT INTO attempts (
        id, token, student_id, organization_id, exam_id, status, started_at, submitted_at,
        deadline_at, expires_at, score, total_marks, percentage, scholarship_pct, finalization_status, question_ids_json
      ) VALUES (?, ?, ?, ?, 30, 'submitted', datetime('now', '-60 minutes'), datetime('now'),
                datetime('now', '+30 minutes'), datetime('now', '+30 minutes'), 25, 50, 50, 10, 'FINALIZED', ?)
    `);
    for (let i = 1; i <= 6; i++) {
      insAttempt.run(200 + i, `tok-c-${i}`, 600 + i, orgId, JSON.stringify([501, 502]));
    }

    // Seed Coding Submissions with diverse real-world outcomes:
    // Sub 1: ACCEPTED (Python, 4/4 test cases, 120ms, score 25) on Q501 by Coder 1
    // Sub 2: COMPILATION_ERROR (C++, 0/4 test cases, 15ms, score 0) on Q501 by Coder 2
    // Sub 3: RUNTIME_ERROR (Python, 0/4 test cases, 80ms, score 0) on Q501 by Coder 3
    // Sub 4: TIME_LIMIT_EXCEEDED (Java, 0/4 test cases, 30000ms, score 0) on Q501 by Coder 4
    // Sub 5: PROVIDER_UNAVAILABLE (last_error_code = 'PROVIDER_UNAVAILABLE', score 0) on Q501 by Coder 5
    // Sub 6: QUEUED / PENDING (lifecycle_status = 'QUEUED') on Q501 by Coder 6
    // Sub 7: WRONG_ANSWER with PARTIALLY PASSED test cases (Python, 2/4 test cases passed, 150ms, score 12.5) on Q502 by Coder 1
    // Sub 8: ACCEPTED (C++, 4/4 test cases passed, 45ms, score 25) on Q502 by Coder 2
    const insSub = db.prepare(`
      INSERT INTO coding_submissions (
        id, attempt_id, question_id, organization_id, language, submission_status, provider,
        test_cases_passed, test_cases_total, score, execution_time_ms, lifecycle_status, last_error_code,
        source_hash, source_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'MockEngine', ?, ?, ?, ?, ?, ?, 'hash-xyz', 'def solution(): pass', datetime('now'))
    `);

    // Q501 submissions
    insSub.run('csub-1', 201, 501, orgId, 'python', 'ACCEPTED', 4, 4, 25, 120, 'COMPLETED', null);
    insSub.run('csub-2', 202, 501, orgId, 'cpp', 'COMPILATION_ERROR', 0, 4, 0, 15, 'COMPLETED', 'COMPILATION_ERROR');
    insSub.run('csub-3', 203, 501, orgId, 'python', 'RUNTIME_ERROR', 0, 4, 0, 80, 'COMPLETED', 'RUNTIME_ERROR');
    insSub.run('csub-4', 204, 501, orgId, 'java', 'TIME_LIMIT_EXCEEDED', 0, 4, 0, 30000, 'COMPLETED', 'TIME_LIMIT_EXCEEDED');
    insSub.run('csub-5', 205, 501, orgId, 'python', 'PROVIDER_ERROR', 0, 4, 0, 0, 'FAILED', 'PROVIDER_UNAVAILABLE');
    insSub.run('csub-6', 206, 501, orgId, 'python', 'PENDING', 0, 0, 0, null, 'QUEUED', null);

    // Q502 submissions
    insSub.run('csub-7', 201, 502, orgId, 'python', 'WRONG_ANSWER', 2, 4, 12.5, 150, 'COMPLETED', null);
    insSub.run('csub-8', 202, 502, orgId, 'cpp', 'ACCEPTED', 4, 4, 25, 45, 'COMPLETED', null);

    console.log('Seeded 8 realistic coding submissions across 6 candidates.');

    // TEST 1: GET Exam Coding Analytics
    console.log('\n--- 1. Aggregated Coding Execution Analytics ---');
    const codingRes = await api('/api/organization/exams/30/analytics/coding', {
      headers: orgLogin.headers
    });
    ok('Coding analytics endpoint responded 200', codingRes.status === 200);
    const summary = codingRes.data?.data?.summary;
    const questions = codingRes.data?.data?.questions;

    // Total submissions = 8
    ok('Total coding submissions is 8', summary?.totalCodingSubmissions === 8);
    // Unique candidates submitting = 6
    ok('Unique candidates submitting is 6', summary?.uniqueCandidatesSubmitting === 6);
    // Accepted executions = 2 (csub-1 and csub-8)
    ok('Successful executions count is 2', summary?.successfulExecutions === 2);
    // Compilation failures = 1 (csub-2)
    ok('Compilation failures count is 1', summary?.compilationFailures === 1);
    // Runtime failures = 1 (csub-3)
    ok('Runtime failures count is 1', summary?.runtimeFailures === 1);
    // Timeouts = 1 (csub-4)
    ok('Timeouts count is 1', summary?.timeouts === 1);
    // Provider failures = 1 (csub-5)
    ok('Provider failures count is 1', summary?.providerFailures === 1);
    // Pending submissions = 1 (csub-6) - must NOT be classified as failure
    ok('Pending submissions count is 1', summary?.pendingSubmissions === 1);
    // Partially passed test cases = 1 (csub-7 with 2/4 passed)
    ok('Partially passed test cases count is 1', summary?.partiallyPassed === 1);

    // Test case pass rate:
    // Total evaluated test cases: 4 * 7 submissions = 28 test cases
    // Total passed test cases: 4 (csub-1) + 0 + 0 + 0 + 0 + 2 (csub-7) + 4 (csub-8) = 10 test cases
    // Pass rate: (10 / 28) * 100 = 35.7%
    ok('Total test cases evaluated is 28', summary?.testCasesEvaluated === 28);
    ok('Total test cases passed is 10', summary?.testCasesPassed === 10);
    ok('Test case pass rate is 35.7%', summary?.testCasePassRate === 35.7);

    // Language breakdown:
    // python: 5 submissions (csub-1, 3, 5, 6, 7) = (5/8) * 100 = 62.5%
    // cpp: 2 submissions (csub-2, 8) = (2/8) * 100 = 25.0%
    // java: 1 submission (csub-4) = (1/8) * 100 = 12.5%
    const langs = summary?.languageBreakdown || [];
    ok('Language breakdown has 3 languages', langs.length === 3);
    const py = langs.find(l => l.language === 'python');
    const cpp = langs.find(l => l.language === 'cpp');
    const java = langs.find(l => l.language === 'java');
    ok('Python count is 5 (62.5%)', py?.count === 5 && py?.percentage === 62.5);
    ok('C++ count is 2 (25.0%)', cpp?.count === 2 && cpp?.percentage === 25.0);
    ok('Java count is 1 (12.5%)', java?.count === 1 && java?.percentage === 12.5);

    // TEST 2: Per-Question Coding Metrics
    console.log('\n--- 2. Per-Question Coding Analytics Breakdown ---');
    ok('Questions array has 2 coding questions', questions?.length === 2);
    const q501 = questions?.find(q => q.questionId === 501);
    const q502 = questions?.find(q => q.questionId === 502);

    ok('Q501 total submissions is 6', q501?.submissionsCount === 6);
    ok('Q501 accepted count is 1', q501?.acceptedCount === 1);
    ok('Q501 compile errors count is 1', q501?.compilationFailures === 1);
    ok('Q501 runtime errors count is 1', q501?.runtimeFailures === 1);
    ok('Q501 timeouts count is 1', q501?.timeouts === 1);
    ok('Q501 provider failures count is 1', q501?.providerFailures === 1);

    ok('Q502 total submissions is 2', q502?.submissionsCount === 2);
    ok('Q502 test case pass rate is 75.0%', q502?.testCasePassRate === 75.0); // (6/8) * 100 = 75.0%
    ok('Q502 average score is 18.8', q502?.averageScore === 18.8); // mean(12.5, 25) = 18.75 -> 18.8

    // TEST 3: Single Coding Question Inspect Detail
    console.log('\n--- 3. Single Coding Question Detail Modal Payload ---');
    const qDetailRes = await api('/api/organization/exams/30/analytics/questions/501', {
      headers: orgLogin.headers
    });
    ok('Question 501 detail endpoint responded 200', qDetailRes.status === 200);
    const codingBreakdown = qDetailRes.data?.data?.codingBreakdown;
    ok('optionsBreakdown is null for coding question', qDetailRes.data?.data?.optionsBreakdown === null);
    ok('codingBreakdown is populated for code question', !!codingBreakdown);
    ok('codingBreakdown total submissions is 6', codingBreakdown?.totalSubmissions === 6);
    ok('codingBreakdown accepted count is 1', codingBreakdown?.acceptedCount === 1);
    ok('codingBreakdown compilation failures is 1', codingBreakdown?.compilationFailures === 1);

    db.close();
  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log(`\nCoding Analytics Test Suite Completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
