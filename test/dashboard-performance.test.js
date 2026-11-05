// ============================================================================
// ASPIRE DAY 18: DASHBOARD PERFORMANCE & INDEX OPTIMIZATION TEST SUITE
// ============================================================================
// Validates:
// 1. Database Index Optimization:
//    - Confirms composite indexes from migration 014 exist and are utilized by
//      SQLite query planner (EXPLAIN QUERY PLAN).
// 2. High-Throughput Latency Benchmark:
//    - Scales organization dataset to hundreds of attempts and students.
//    - Verifies all 6 dashboard endpoints respond within sub-150ms thresholds.
// 3. Concurrent Request Resilience:
//    - Executes 25 concurrent multi-endpoint analytics queries under load.
//    - Asserts 100% success rate with 0 database lock timeouts (SQLITE_BUSY).
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3254;
const DB_FILE = path.join(os.tmpdir(), `aspire-dashboard-performance-test-${Date.now()}.db`);
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
  const start = Date.now();
  const res = await fetch(BASE + endpoint, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const durationMs = Date.now() - start;
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data, raw: text, headers: res.headers, durationMs };
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
  console.log('ASPIRE DAY 18: DASHBOARD PERFORMANCE TEST SUITE');
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
      AUTH_SECRET: 'aspire-perf-dashboard-secret-32-chars-min!',
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
      body: JSON.stringify({ name: 'Epsilon Tech', slug: 'epsilon-perf', email: 'admin@epsilonperf.edu', timezone: 'Asia/Kolkata' })
    });
    const orgId = (orgRes.data.data || orgRes.data).id;

    // Create Org Admin
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({ name: 'Epsilon Admin', email: 'admin@epsilonperf.edu', password: 'Password123!', role: 'ORG_ADMIN', organization_id: orgId })
    });

    const adminLogin = await loginUser('admin@epsilonperf.edu', 'Password123!');
    ok('Org Admin login succeeded', adminLogin.status === 200 && !!adminLogin.token);

    // ------------------------------------------------------------------------
    // TEST 1: Migration 014 Index Verification & Query Plan Analysis
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Database Index Verification (EXPLAIN QUERY PLAN) ---');
    const Database = require('better-sqlite3');
    const db = new Database(DB_FILE);

    // Verify composite index existence
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map(r => r.name);
    ok('Index idx_attempts_org_status_sub exists', indexes.includes('idx_attempts_org_status_sub'));
    ok('Index idx_attempts_org_exam exists', indexes.includes('idx_attempts_org_exam'));
    ok('Index idx_students_org_created exists', indexes.includes('idx_students_org_created'));
    ok('Index idx_exams_org_status exists', indexes.includes('idx_exams_org_status'));

    // Check query plan on attempts status lookup
    const queryPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT count(*) FROM attempts
      WHERE organization_id = ? AND status = 'submitted' AND submitted_at >= '2026-01-01'
    `).all(orgId);

    const planDetail = queryPlan.map(p => p.detail).join('; ');
    ok('Query plan utilizes index on attempts', planDetail.includes('USING INDEX') || planDetail.includes('idx_attempts'));

    // ------------------------------------------------------------------------
    // TEST 2: Seed Scale Dataset (500 Attempts, 200 Students)
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Seeding Scale Dataset (500 Attempts, 200 Students) ---');
    const colleges = ['IIT Bombay', 'IIT Delhi', 'BITS Pilani', 'NIT Trichy', 'Anna University', 'IIIT Hyderabad', 'Manipal Institute'];
    const now = new Date();

    const insertStudent = db.prepare(`
      INSERT INTO students (id, name, phone, email, college, organization_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertExam = db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 60, 40, ?, ?, ?)
    `);

    const insertAttempt = db.prepare(`
      INSERT INTO attempts (id, token, question_ids_json, expires_at, student_id, organization_id, exam_id, status, started_at, submitted_at, deadline_at, percentage, scholarship_pct, certificate_id, graded_detail_json)
      VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seedTx = db.transaction(() => {
      // 5 Exams
      for (let e = 1; e <= 5; e++) {
        const status = e <= 3 ? 'LIVE' : (e === 4 ? 'PUBLISHED' : 'DRAFT');
        insertExam.run(100 + e, orgId, `Benchmark Exam ${e}`, `BENCH-${e}`, status, adminLogin.user.id, now.toISOString(), now.toISOString());
      }

      // 200 Students
      for (let s = 1; s <= 200; s++) {
        const college = colleges[s % colleges.length];
        const daysAgo = (s % 60);
        const createdAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
        insertStudent.run(1000 + s, `Candidate ${s}`, `99900${s.toString().padStart(4, '0')}`, `candidate${s}@perf.edu`, college, orgId, createdAt);
      }

      // 500 Attempts
      for (let a = 1; a <= 500; a++) {
        const studentId = 1000 + (a % 200) + 1;
        const examId = 100 + (a % 5) + 1;
        const daysAgo = (a % 45);
        const startTime = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
        const score = (a * 17) % 100;
        const scholarship = score >= 75 ? 50 : (score >= 50 ? 20 : 0);
        const cert = score >= 60 ? `CERT-PERF-${a}` : null;
        const status = (a % 20 === 0) ? 'started' : 'submitted';

        const qJson = JSON.stringify([
          { id: 1, marks: 10, earned: score >= 50 ? 10 : 0, correct: score >= 50 },
          { id: 2, marks: 10, earned: score >= 75 ? 10 : 0, correct: score >= 75 }
        ]);

        insertAttempt.run(
          5000 + a,
          `tok-perf-${a}`,
          startTime,
          studentId,
          orgId,
          examId,
          status,
          startTime,
          status === 'submitted' ? startTime : null,
          startTime,
          status === 'submitted' ? score : null,
          scholarship,
          cert,
          qJson
        );
      }
    });

    seedTx();
    db.close();
    ok('500 attempts and 200 students successfully committed in transaction', true);

    // ------------------------------------------------------------------------
    // TEST 3: Latency Benchmark across all 6 Endpoints
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Single-Request Sub-150ms Latency Benchmark ---');
    const endpoints = [
      { name: 'Overview KPIs', url: '/api/organization/dashboard/overview?period=30d' },
      { name: 'Attempts Over Time', url: '/api/organization/dashboard/attempts-over-time?period=30d' },
      { name: 'Score Distribution', url: '/api/organization/dashboard/score-distribution?period=30d' },
      { name: 'Completion Rate', url: '/api/organization/dashboard/completion-rate?period=30d' },
      { name: 'College Distribution', url: '/api/organization/dashboard/college-distribution?period=30d' },
      { name: 'Question Performance', url: '/api/organization/dashboard/question-performance?period=30d' }
    ];

    for (const ep of endpoints) {
      const res = await api(ep.url, { headers: adminLogin.headers });
      ok(`${ep.name} returns 200`, res.status === 200);
      ok(`${ep.name} responds within 150ms (actual: ${res.durationMs}ms)`, res.durationMs < 150);
    }

    // ------------------------------------------------------------------------
    // TEST 4: Concurrent Load Resilience (25 Parallel Analytics Requests)
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Concurrent Request Resilience (25 Parallel Queries) ---');
    const concurrentRequests = [];
    for (let i = 0; i < 25; i++) {
      const targetEp = endpoints[i % endpoints.length];
      concurrentRequests.push(api(targetEp.url, { headers: adminLogin.headers }));
    }

    const startBench = Date.now();
    const results = await Promise.all(concurrentRequests);
    const totalBenchMs = Date.now() - startBench;

    const allSuccessful = results.every(r => r.status === 200);
    ok('All 25 concurrent requests succeeded with HTTP 200', allSuccessful);

    const maxDuration = Math.max(...results.map(r => r.durationMs));
    const avgDuration = Math.round(results.reduce((acc, r) => acc + r.durationMs, 0) / results.length);
    console.log(`  Bench: Total 25 requests completed in ${totalBenchMs}ms (avg: ${avgDuration}ms, max: ${maxDuration}ms)`);
    ok('Max latency under concurrent load is within acceptable bounds (< 300ms)', maxDuration < 300);

  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch {}
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('ALL DASHBOARD PERFORMANCE TESTS PASSED (100%)');
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

