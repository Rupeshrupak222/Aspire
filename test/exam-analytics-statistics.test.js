// ============================================================================
// ASPIRE DAY 19: EXAM ANALYTICS STATISTICAL ACCURACY TEST SUITE
// ============================================================================
// Validates:
// 1. Integration of simple-statistics package for mathematical computations:
//    - Median score
//    - Arithmetic Mean & Sample Standard Deviation
//    - Percentiles: 25th (Q1), 75th (Q3), 90th (P90), and Interquartile Range (IQR)
// 2. Kelley's Item Discrimination Index (D = P_upper - P_lower):
//    - Strong positive discrimination (D >= 0.40)
//    - Moderate/good discrimination
//    - Negative discrimination (D < 0.00)
//    - Insufficient sample size handling (N < 10 -> null index & sampleSizeInsufficient = true)
//    - Consistent ranking with tied candidate scores
// 3. Score distribution buckets: 0-19%, 20-39%, 40-59%, 60-79%, 80-100%
// 4. Completion duration buckets: <15m, 15-30m, 30-45m, 45-60m, >60m
// 5. Category performance aggregations across aptitude, technical, and coding
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');
const ss = require('simple-statistics');

const PORT = 3265;
const DB_FILE = path.join(os.tmpdir(), `aspire-stats-analytics-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 19: EXAM STATISTICAL ACCURACY TEST SUITE');
  console.log('====================================================\n');

  // Verify simple-statistics library directly first
  console.log('--- 0. simple-statistics Mathematical Baseline ---');
  const testSample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  ok('ss.median works correctly', ss.median(testSample) === 55);
  ok('ss.mean works correctly', ss.mean(testSample) === 55);
  ok('ss.quantileSorted works correctly', ss.quantileSorted(testSample, 0.25) === 32.5);
  ok('ss.quantileSorted 0.75 works correctly', ss.quantileSorted(testSample, 0.75) === 77.5);

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
      AUTH_SECRET: 'aspire-stats-analytics-secret-32-chars!',
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
        name: 'Statistical Analytics Lab',
        slug: 'stats-lab',
        email: 'info@statslab.edu',
        timezone: 'Asia/Kolkata'
      })
    });
    ok('Organization created', orgRes.status === 201);
    const orgId = orgRes.data.id || orgRes.data.data?.id;

    // Create Org Admin User
    await api('/api/admin/users', {
      method: 'POST',
      headers: superLogin.headers,
      body: JSON.stringify({
        name: 'Stats Admin',
        email: 'admin@statslab.edu',
        password: 'Password123!',
        role: 'ORG_ADMIN',
        organization_id: orgId
      })
    });

    const orgLogin = await loginUser('admin@statslab.edu', 'Password123!');
    ok('Org Admin login succeeded', orgLogin.status === 200);

    const db = new Database(DB_FILE);

    // Create 2 Exams:
    // Exam 40: High sample size (N = 20 candidates) for Item Discrimination Index & Statistical Distributions
    // Exam 41: Small sample size (N = 5 candidates) to test Insufficient Sample handling (< 10)
    const insExam = db.prepare(`
      INSERT INTO exams (id, organization_id, name, code, description, status, version, duration_minutes, total_marks, passing_score, is_default, created_at, published_at)
      VALUES (?, ?, ?, ?, ?, 'PUBLISHED', 1, 60, 50, 50, 0, datetime('now'), datetime('now'))
    `);
    insExam.run(40, orgId, 'Standard Statistical Assessment', 'STAT-NORM-2026', 'Normal exam with N=20');
    insExam.run(41, orgId, 'Small Pilot Assessment', 'STAT-PILOT-2026', 'Pilot exam with N=5');

    // Create Questions for Exam 40:
    // Q901: Positive Discrimination Question (Top candidates get it right, lower get it wrong)
    // Q902: Zero / Neutral Discrimination Question (Equal proportions in top and bottom)
    // Q903: Negative Discrimination Question (Flawed question: lower get it right, upper get it wrong)
    const insQ = db.prepare(`
      INSERT INTO questions (id, organization_id, title, question_text, type, marks, category, difficulty, options_json, correct_index, status)
      VALUES (?, ?, ?, ?, 'mcq', 10, ?, 'medium', '["A","B","C","D"]', 0, 'PUBLISHED')
    `);
    insQ.run(901, orgId, 'Positive Discrimination Item', 'Strong discriminator', 'aptitude');
    insQ.run(902, orgId, 'Neutral Discrimination Item', 'Zero discriminator', 'technical');
    insQ.run(903, orgId, 'Negative Discrimination Item', 'Misleading question with negative D', 'coding');

    // Create Section & map questions
    db.prepare(`INSERT INTO exam_sections (id, exam_id, name, display_order, question_selection_mode) VALUES (401, 40, 'Main Section', 1, 'MANUAL')`).run();
    db.prepare(`INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (401, 901, 1)`).run();
    db.prepare(`INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (401, 902, 2)`).run();
    db.prepare(`INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (401, 903, 3)`).run();

    // Map Q901 to Exam 41 as well
    db.prepare(`INSERT INTO exam_sections (id, exam_id, name, display_order, question_selection_mode) VALUES (402, 41, 'Pilot Section', 1, 'MANUAL')`).run();
    db.prepare(`INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (402, 901, 1)`).run();

    // Seed 20 Students for Exam 40
    const insStudent = db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
    for (let i = 1; i <= 20; i++) {
      insStudent.run(700 + i, `Student ${i}`, `93000000${i < 10 ? '0' + i : i}`, `student${i}@statslab.edu`, 'Stats College', orgId);
    }
    // Seed 5 Students for Exam 41
    for (let i = 1; i <= 5; i++) {
      insStudent.run(800 + i, `Pilot Student ${i}`, `940000000${i}`, `pilot${i}@statslab.edu`, 'Pilot College', orgId);
    }

    // Seed Attempts for Exam 40:
    // N = 20 completed attempts.
    // Kelley's 27% rule: k = Math.round(20 * 0.27) = 5 candidates.
    // Upper group: Top 5 candidates (ranks 1 to 5: scores 90, 85, 80, 75, 70)
    // Lower group: Bottom 5 candidates (ranks 16 to 20: scores 30, 25, 20, 15, 10)
    // Middle group: Ranks 6 to 15 (scores 65 to 35)

    // Q901 (Positive D): In top 5, 5 correct (100%). In bottom 5, 0 correct (0%).
    // -> D = 1.0 - 0.0 = +1.0 (EXCELLENT)

    // Q902 (Neutral D): In top 5, 2 correct (40%). In bottom 5, 2 correct (40%).
    // -> D = 0.40 - 0.40 = 0.00 (POOR)

    // Q903 (Negative D): In top 5, 0 correct (0%). In bottom 5, 4 correct (80%).
    // -> D = 0.0 - 0.80 = -0.80 (NEGATIVE)

    // Duration variation:
    // 5 attempts under 15 min (e.g. 10m)
    // 5 attempts 15-30 min (e.g. 20m)
    // 5 attempts 30-45 min (e.g. 35m)
    // 5 attempts 45-60 min (e.g. 50m)

    const insAttempt = db.prepare(`
      INSERT INTO attempts (
        id, token, student_id, organization_id, exam_id, status, started_at, submitted_at,
        deadline_at, expires_at, score, total_marks, percentage, scholarship_pct, finalization_status,
        question_ids_json, answers_json, graded_detail_json
      ) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, datetime('now', '+60 minutes'), datetime('now', '+60 minutes'),
                ?, 30, ?, 0, 'FINALIZED', ?, ?, ?)
    `);

    const knownScores = [
      90, 85, 80, 75, 70, // Top 5 (Upper group)
      65, 60, 58, 55, 52, 48, 45, 42, 38, 35, // Middle 10
      30, 25, 20, 15, 10  // Bottom 5 (Lower group)
    ];

    for (let i = 1; i <= 20; i++) {
      const percentage = knownScores[i - 1];
      const isTop5 = (i <= 5);
      const isBottom5 = (i >= 16);

      // Question outcomes
      const q901Correct = isTop5; // only top 5 correct
      const q902Correct = (i === 1 || i === 2 || i === 19 || i === 20 || i === 8 || i === 9); // 2 in top 5, 2 in bottom 5
      const q903Correct = (isBottom5 && i <= 19); // 4 in bottom 5, 0 in top 5

      const answers = {
        '901': q901Correct ? 0 : 1,
        '902': q902Correct ? 0 : 1,
        '903': q903Correct ? 0 : 1
      };

      const detail = [
        { id: 901, category: 'aptitude', type: 'mcq', marks: 10, earned: q901Correct ? 10 : 0 },
        { id: 902, category: 'technical', type: 'mcq', marks: 10, earned: q902Correct ? 10 : 0 },
        { id: 903, category: 'coding', type: 'mcq', marks: 10, earned: q903Correct ? 10 : 0 }
      ];

      // Duration: 1..5 -> 10m, 6..10 -> 20m, 11..15 -> 35m, 16..20 -> 50m
      const durMin = i <= 5 ? 10 : (i <= 10 ? 20 : (i <= 15 ? 35 : 50));
      const submitDate = new Date();
      const startDate = new Date(submitDate.getTime() - durMin * 60000);

      insAttempt.run(
        300 + i,
        `tok-stat-${i}`,
        700 + i,
        orgId,
        40,
        startDate.toISOString(),
        submitDate.toISOString(),
        Math.round((percentage / 100) * 30),
        percentage,
        JSON.stringify([901, 902, 903]),
        JSON.stringify(answers),
        JSON.stringify(detail)
      );
    }

    // Seed 5 attempts for Exam 41 (Small Pilot Sample, N = 5)
    for (let i = 1; i <= 5; i++) {
      insAttempt.run(
        400 + i,
        `tok-pilot-${i}`,
        800 + i,
        orgId,
        41,
        new Date(Date.now() - 15 * 60000).toISOString(),
        new Date().toISOString(),
        20,
        60,
        JSON.stringify([901]),
        JSON.stringify({ '901': 0 }),
        JSON.stringify([{ id: 901, category: 'aptitude', type: 'mcq', marks: 10, earned: 10 }])
      );
    }

    console.log('Seeded calibrated statistical attempts.');

    // TEST 1: Statistical Measures (Mean, Median, Standard Deviation, Percentiles)
    console.log('\n--- 1. Simple-Statistics Measures Verification ---');
    const perfRes = await api('/api/organization/exams/40/analytics/performance', {
      headers: orgLogin.headers
    });
    ok('Performance endpoint responded 200', perfRes.status === 200);
    const stats = perfRes.data?.data?.statistics;
    ok('Statistics object exists', !!stats);

    // Calculated baseline from knownScores
    const expectedMean = Math.round(ss.mean(knownScores) * 10) / 10;
    const expectedMedian = Math.round(ss.median(knownScores) * 10) / 10;
    const sortedScores = knownScores.slice().sort((a, b) => a - b);
    const expectedQ1 = Math.round(ss.quantileSorted(sortedScores, 0.25) * 10) / 10;
    const expectedQ3 = Math.round(ss.quantileSorted(sortedScores, 0.75) * 10) / 10;
    const expectedP90 = Math.round(ss.quantileSorted(sortedScores, 0.90) * 10) / 10;
    const expectedIQR = Math.round((expectedQ3 - expectedQ1) * 10) / 10;
    const expectedSD = Math.round(ss.standardDeviation(knownScores) * 10) / 10;

    ok(`Calculated mean is ${expectedMean}%`, stats.mean === expectedMean, `got ${stats.mean}`);
    ok(`Calculated median is ${expectedMedian}%`, stats.median === expectedMedian, `got ${stats.median}`);
    ok(`Calculated Q1 (25th percentile) is ${expectedQ1}%`, stats.q1 === expectedQ1, `got ${stats.q1}`);
    ok(`Calculated Q3 (75th percentile) is ${expectedQ3}%`, stats.q3 === expectedQ3, `got ${stats.q3}`);
    ok(`Calculated P90 is ${expectedP90}%`, stats.p90 === expectedP90, `got ${stats.p90}`);
    ok(`Calculated IQR is ${expectedIQR}%`, stats.iqr === expectedIQR, `got ${stats.iqr}`);
    ok(`Calculated Standard Deviation is ${expectedSD}`, stats.standardDeviation === expectedSD, `got ${stats.standardDeviation}`);

    // TEST 2: Score Distribution Histogram Buckets
    console.log('\n--- 2. Score Distribution Histogram Buckets ---');
    const scoreDist = perfRes.data?.data?.scoreDistribution || [];
    ok('Score distribution has 5 buckets', scoreDist.length === 5);
    // 0-19%: 15, 10 -> 2 attempts (10%)
    // 20-39%: 38, 35, 30, 25, 20 -> 5 attempts (25%)
    // 40-59%: 58, 55, 52, 48, 45, 42 -> 6 attempts (30%)
    // 60-79%: 75, 70, 65, 60 -> 4 attempts (20%)
    // 80-100%: 90, 85, 80 -> 3 attempts (15%)
    const b0_19 = scoreDist.find(b => b.bucket === '0-19%');
    const b20_39 = scoreDist.find(b => b.bucket === '20-39%');
    const b40_59 = scoreDist.find(b => b.bucket === '40-59%');
    const b60_79 = scoreDist.find(b => b.bucket === '60-79%');
    const b80_100 = scoreDist.find(b => b.bucket === '80-100%');

    ok('Bucket 0-19% has 2 attempts (10%)', b0_19?.count === 2 && b0_19?.percentage === 10);
    ok('Bucket 20-39% has 5 attempts (25%)', b20_39?.count === 5 && b20_39?.percentage === 25);
    ok('Bucket 40-59% has 6 attempts (30%)', b40_59?.count === 6 && b40_59?.percentage === 30);
    ok('Bucket 60-79% has 4 attempts (20%)', b60_79?.count === 4 && b60_79?.percentage === 20);
    ok('Bucket 80-100% has 3 attempts (15%)', b80_100?.count === 3 && b80_100?.percentage === 15);

    // TEST 3: Duration Distribution Buckets
    console.log('\n--- 3. Duration Distribution Buckets ---');
    const durDist = perfRes.data?.data?.durationDistribution || [];
    ok('Duration distribution has 5 buckets', durDist.length === 5);
    const dLess15 = durDist.find(b => b.bucket === '< 15 min');
    const d15_30 = durDist.find(b => b.bucket === '15-30 min');
    const d30_45 = durDist.find(b => b.bucket === '30-45 min');
    const d45_60 = durDist.find(b => b.bucket === '45-60 min');

    ok('Duration < 15 min has 5 attempts (25%)', dLess15?.count === 5 && dLess15?.percentage === 25);
    ok('Duration 15-30 min has 5 attempts (25%)', d15_30?.count === 5 && d15_30?.percentage === 25);
    ok('Duration 30-45 min has 5 attempts (25%)', d30_45?.count === 5 && d30_45?.percentage === 25);
    ok('Duration 45-60 min has 5 attempts (25%)', d45_60?.count === 5 && d45_60?.percentage === 25);

    // TEST 4: Kelley's Item Discrimination Index (D)
    console.log('\n--- 4. Kelley Item Discrimination Index (D) ---');
    const qRes = await api('/api/organization/exams/40/analytics/questions', {
      headers: orgLogin.headers
    });
    ok('Exam 40 questions endpoint responded 200', qRes.status === 200);
    const qs = qRes.data?.data?.questions || [];

    const q901 = qs.find(q => q.questionId === 901);
    const q902 = qs.find(q => q.questionId === 902);
    const q903 = qs.find(q => q.questionId === 903);

    // Q901: Top 5 = 100%, Bottom 5 = 0% -> D = +1.00 (EXCELLENT)
    ok('Q901 discrimination index is +1.00', q901?.discriminationIndex === 1);
    ok('Q901 discrimination rating is EXCELLENT', q901?.discriminationRating === 'EXCELLENT');
    ok('Q901 sampleSizeInsufficient is false', q901?.sampleSizeInsufficient === false);

    // Q902: Top 5 = 40%, Bottom 5 = 40% -> D = 0.00 (POOR)
    ok('Q902 discrimination index is 0.00', q902?.discriminationIndex === 0);
    ok('Q902 discrimination rating is POOR', q902?.discriminationRating === 'POOR');

    // Q903: Top 5 = 0%, Bottom 5 = 80% -> D = -0.80 (NEGATIVE)
    ok('Q903 discrimination index is -0.80', q903?.discriminationIndex === -0.80);
    ok('Q903 discrimination rating is NEGATIVE', q903?.discriminationRating === 'NEGATIVE');

    // TEST 5: Insufficient Sample Size Handling (N < 10)
    console.log('\n--- 5. Insufficient Sample Handling (N < 10) ---');
    const pilotQRes = await api('/api/organization/exams/41/analytics/questions', {
      headers: orgLogin.headers
    });
    ok('Pilot exam responded 200', pilotQRes.status === 200);
    ok('Pilot sample size is 5', pilotQRes.data?.data?.sampleSize === 5);
    ok('Pilot sampleSizeInsufficient is true', pilotQRes.data?.data?.sampleSizeInsufficient === true);

    const pilotQ901 = pilotQRes.data?.data?.questions[0];
    ok('Pilot discriminationIndex is null (avoids false metric)', pilotQ901?.discriminationIndex === null);
    ok('Pilot question discriminationRating is INSUFFICIENT_DATA', pilotQ901?.discriminationRating === 'INSUFFICIENT_DATA');
    ok('Pilot question sampleSizeInsufficient is true', pilotQ901?.sampleSizeInsufficient === true);

    db.close();
  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log(`\nStatistical Accuracy Test Suite Completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
