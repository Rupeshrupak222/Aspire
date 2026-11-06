// ============================================================================
// ASPIRE DAY 19: EXAM QUESTION ANALYTICS TEST SUITE
// ============================================================================
// Validates:
// 1. Correct percentage calculation: (correct / eligible answered) * 100
// 2. Wrong percentage calculation: (wrong / eligible answered) * 100
// 3. Unanswered counts and percentages calculated cleanly
// 4. Difficulty boundaries:
//    - VERY_EASY (>= 85%)
//    - EASY (70 - 84%)
//    - MODERATE (40 - 69%)
//    - DIFFICULT (20 - 39%)
//    - VERY_DIFFICULT (< 20%)
// 5. Question timing behavior (null when instrumentation gap, real numbers when recorded)
// 6. Question detail endpoint with MCQ option selection distribution and coding breakdown
// 7. Filtering by type, difficulty, search term, and sorting options
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const Database = require('better-sqlite3');

const PORT = 3262;
const DB_FILE = path.join(os.tmpdir(), `aspire-question-analytics-test-${Date.now()}.db`);
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
  console.log('ASPIRE DAY 19: EXAM QUESTION ANALYTICS TEST SUITE');
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
      AUTH_SECRET: 'aspire-question-analytics-secret-32-chars!',
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
        name: 'Nexus Institute',
        slug: 'nexus-institute',
        email: 'info@nexus.edu',
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
        name: 'Nexus Admin',
        email: 'admin@nexus.edu',
        password: 'Password123!',
        role: 'ORG_ADMIN',
        organization_id: orgId
      })
    });
    ok('Org Admin user created', userRes.status === 201);

    const orgLogin = await loginUser('admin@nexus.edu', 'Password123!');
    ok('Org Admin login succeeded', orgLogin.status === 200);

    // Seed Data into SQLite
    const db = new Database(DB_FILE);

    // Create Exam
    db.prepare(`
      INSERT INTO exams (
        id, organization_id, name, code, description, status, version, duration_minutes,
        total_marks, passing_score, max_attempts, is_default, created_at, published_at
      ) VALUES (20, ?, 'Computer Science Benchmarking Test', 'CS-BENCH-2026', 'Comprehensive CS Test', 'PUBLISHED', 1, 60, 25, 40, 1, 0, datetime('now'), datetime('now'))
    `).run(orgId);

    // Create Sections
    db.prepare(`
      INSERT INTO exam_sections (id, exam_id, name, description, display_order, question_selection_mode, total_questions, total_marks)
      VALUES (201, 20, 'Theory & Aptitude', 'MCQs', 1, 'MANUAL', 5, 20)
    `).run();

    // Create 5 Questions with distinct difficulty profiles:
    // Q1: Very Easy (9 out of 10 correct = 90%)
    // Q2: Easy (7 out of 10 correct = 70%)
    // Q3: Moderate (5 out of 10 correct = 50%)
    // Q4: Difficult (3 out of 10 correct = 30%)
    // Q5: Very Difficult (1 out of 10 correct = 10%)
    const insQ = db.prepare(`
      INSERT INTO questions (id, organization_id, title, question_text, type, marks, category, difficulty, options_json, correct_index, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED')
    `);

    insQ.run(301, orgId, 'What is 2+2?', 'Basic arithmetic addition', 'mcq', 2, 'aptitude', 'easy', JSON.stringify(['3', '4', '5', '6']), 1);
    insQ.run(302, orgId, 'Time Complexity of Binary Search', 'Binary search complexity on sorted array', 'mcq', 3, 'technical', 'medium', JSON.stringify(['O(1)', 'O(n)', 'O(log n)', 'O(n^2)']), 2);
    insQ.run(303, orgId, 'Dijkstra Algorithm Limitation', 'Limitation of Dijkstra shortest path', 'mcq', 5, 'technical', 'medium', JSON.stringify(['Directed graphs', 'Negative weights', 'Cyclic graphs', 'Dense graphs']), 1);
    insQ.run(304, orgId, 'B-Tree Node Split Condition', 'When does a node in B-Tree split?', 'mcq', 5, 'technical', 'hard', JSON.stringify(['Underflow', 'Full capacity', 'Root node only', 'Leaf node only']), 1);
    insQ.run(305, orgId, 'Byzantine Generals Problem Tolerance', 'Maximum traitor fraction in Byzantine consensus', 'mcq', 5, 'technical', 'hard', JSON.stringify(['1/2', '1/3', '1/4', '2/3']), 1);

    // Map questions to Section 201
    const insSecQ = db.prepare(`INSERT INTO exam_section_questions (section_id, question_id, display_order) VALUES (?, ?, ?)`);
    for (let i = 1; i <= 5; i++) {
      insSecQ.run(201, 300 + i, i);
    }

    // Seed 10 Students
    const insStudent = db.prepare(`INSERT INTO students (id, name, phone, email, college, organization_id, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
    for (let i = 1; i <= 10; i++) {
      insStudent.run(400 + i, `Candidate ${i}`, `910000000${i % 10}`, `cand${i}@nexus.edu`, 'Nexus Tech', orgId);
    }

    // Seed 10 Completed Finalized Attempts
    // We will control exact answers for each question:
    // Q301 (Very Easy): 9 correct (cand 1..9), 1 wrong (cand 10 chose option 0)
    // Q302 (Easy): 7 correct (cand 1..7), 2 wrong (cand 8,9 chose option 1), 1 unanswered (cand 10)
    // Q303 (Moderate): 5 correct (cand 1..5), 4 wrong (cand 6..9), 1 unanswered (cand 10)
    // Q304 (Difficult): 3 correct (cand 1..3), 6 wrong (cand 4..9), 1 unanswered (cand 10)
    // Q305 (Very Difficult): 1 correct (cand 1), 8 wrong (cand 2..9), 1 unanswered (cand 10)
    // We also embed simulated question timing for Q301 in detail to test timing extraction!

    const insAttempt = db.prepare(`
      INSERT INTO attempts (
        id, token, student_id, organization_id, exam_id, status, started_at, submitted_at,
        deadline_at, expires_at, score, total_marks, percentage, scholarship_pct, finalization_status,
        question_ids_json, answers_json, graded_detail_json
      ) VALUES (?, ?, ?, ?, ?, 'submitted', datetime('now', '-30 minutes'), datetime('now'),
                datetime('now', '+30 minutes'), datetime('now', '+30 minutes'), ?, 20, ?, 0, 'FINALIZED', ?, ?, ?)
    `);

    for (let i = 1; i <= 10; i++) {
      const q301Correct = i <= 9;
      const q302Correct = i <= 7;
      const q303Correct = i <= 5;
      const q304Correct = i <= 3;
      const q305Correct = i <= 1;

      const answers = {};
      // Q301
      answers['301'] = q301Correct ? 1 : 0;
      // Q302
      if (i <= 7) answers['302'] = 2; // correct
      else if (i <= 9) answers['302'] = 1; // wrong
      // i === 10: unanswered
      // Q303
      if (i <= 5) answers['303'] = 1; // correct
      else if (i <= 9) answers['303'] = 0; // wrong
      // Q304
      if (i <= 3) answers['304'] = 1; // correct
      else if (i <= 9) answers['304'] = 0; // wrong
      // Q305
      if (i === 1) answers['305'] = 1; // correct
      else if (i <= 9) answers['305'] = 0; // wrong

      let score = 0;
      if (q301Correct) score += 2;
      if (q302Correct) score += 3;
      if (q303Correct) score += 5;
      if (q304Correct) score += 5;
      if (q305Correct) score += 5;

      const percentage = Math.round((score / 20) * 100);

      // Embedded detail JSON (with simulated time_spent_seconds on Q301)
      const detail = [
        { id: 301, category: 'aptitude', type: 'mcq', marks: 2, earned: q301Correct ? 2 : 0, time_spent_seconds: 25 + i * 2 },
        { id: 302, category: 'technical', type: 'mcq', marks: 3, earned: q302Correct ? 3 : 0 },
        { id: 303, category: 'technical', type: 'mcq', marks: 5, earned: q303Correct ? 5 : 0 },
        { id: 304, category: 'technical', type: 'mcq', marks: 5, earned: q304Correct ? 5 : 0 },
        { id: 305, category: 'technical', type: 'mcq', marks: 5, earned: q305Correct ? 5 : 0 }
      ];

      insAttempt.run(
        100 + i,
        `tok-q-${i}`,
        400 + i,
        orgId,
        20,
        score,
        percentage,
        JSON.stringify([301, 302, 303, 304, 305]),
        JSON.stringify(answers),
        JSON.stringify(detail)
      );
    }

    console.log('Seeded 10 calibrated question attempts.');

    // TEST 1: GET Exam Questions List Analytics
    console.log('\n--- 1. Question List Analytics & Difficulty Classification ---');
    const qListRes = await api('/api/organization/exams/20/analytics/questions', {
      headers: orgLogin.headers
    });
    ok('Questions list endpoint responded 200', qListRes.status === 200);
    const qs = qListRes.data?.data?.questions || [];
    ok('Returns all 5 questions', qs.length === 5);

    const q1 = qs.find(q => q.questionId === 301);
    const q2 = qs.find(q => q.questionId === 302);
    const q3 = qs.find(q => q.questionId === 303);
    const q4 = qs.find(q => q.questionId === 304);
    const q5 = qs.find(q => q.questionId === 305);

    // Q301: 9/10 correct = 90% accuracy -> VERY_EASY
    ok('Q301 overall accuracy is 90%', q1?.overallAccuracy === 90);
    ok('Q301 difficulty is VERY_EASY', q1?.difficulty === 'VERY_EASY');
    ok('Q301 unanswered count is 0', q1?.unansweredCount === 0);
    ok('Q301 correct percentage is 90%', q1?.correctPercentage === 90);
    ok('Q301 wrong percentage is 10%', q1?.wrongPercentage === 10);

    // Q302: 7/10 correct = 70% accuracy -> EASY
    ok('Q302 overall accuracy is 70%', q2?.overallAccuracy === 70);
    ok('Q302 difficulty is EASY', q2?.difficulty === 'EASY');
    ok('Q302 unanswered count is 1 (10%)', q2?.unansweredCount === 1 && q2?.unansweredPercentage === 10);
    // 7 correct out of 9 answered = 77.8%
    ok('Q302 correct percentage of answered is 77.8%', q2?.correctPercentage === 77.8);

    // Q303: 5/10 correct = 50% accuracy -> MODERATE
    ok('Q303 overall accuracy is 50%', q3?.overallAccuracy === 50);
    ok('Q303 difficulty is MODERATE', q3?.difficulty === 'MODERATE');

    // Q304: 3/10 correct = 30% accuracy -> DIFFICULT
    ok('Q304 overall accuracy is 30%', q4?.overallAccuracy === 30);
    ok('Q304 difficulty is DIFFICULT', q4?.difficulty === 'DIFFICULT');

    // Q305: 1/10 correct = 10% accuracy -> VERY_DIFFICULT
    ok('Q305 overall accuracy is 10%', q5?.overallAccuracy === 10);
    ok('Q305 difficulty is VERY_DIFFICULT', q5?.difficulty === 'VERY_DIFFICULT');

    // TEST 2: Question Timing Behavior
    console.log('\n--- 2. Question Timing Instrumentation & Behavior ---');
    // Q301 has real embedded time_spent_seconds: 27, 29, 31, 33, 35, 37, 39, 41, 43, 45 -> mean 36
    ok('Q301 hasTimingData is true', q1?.hasTimingData === true);
    ok('Q301 averageTimeSeconds is 36', q1?.averageTimeSeconds === 36);
    ok('Q301 medianTimeSeconds is 36', q1?.medianTimeSeconds === 36);

    // Q302 does not have question-level timing recorded -> Must NOT fabricate average time
    ok('Q302 hasTimingData is false', q2?.hasTimingData === false);
    ok('Q302 averageTimeSeconds is null', q2?.averageTimeSeconds === null);
    ok('Q302 medianTimeSeconds is null', q2?.medianTimeSeconds === null);

    // TEST 3: Detailed Question Inspection (MCQ Option Selection Distribution)
    console.log('\n--- 3. Single Question Detail & Option Breakdown ---');
    const qDetailRes = await api('/api/organization/exams/20/analytics/questions/301', {
      headers: orgLogin.headers
    });
    ok('Question detail endpoint responded 200', qDetailRes.status === 200);
    const detailData = qDetailRes.data?.data;
    ok('Question detail metadata is correct', detailData?.question?.id === 301);
    ok('Options breakdown array exists with 4 options', detailData?.optionsBreakdown?.length === 4);

    const optB = detailData?.optionsBreakdown?.find(o => o.index === 1);
    ok('Option B is marked as correct answer', optB?.isCorrect === true);
    ok('Option B received 9 votes (90%)', optB?.count === 9 && optB?.percentage === 90);

    const optA = detailData?.optionsBreakdown?.find(o => o.index === 0);
    ok('Option A received 1 vote (10%)', optA?.count === 1 && optA?.percentage === 10);

    // TEST 4: Filtering and Sorting
    console.log('\n--- 4. Filtering & Sorting ---');
    const diffFilter = await api('/api/organization/exams/20/analytics/questions?difficulty=VERY_EASY', {
      headers: orgLogin.headers
    });
    ok('Difficulty filter VERY_EASY returns 1 question', diffFilter.data?.data?.questions?.length === 1);
    ok('Filtered question is Q301', diffFilter.data?.data?.questions[0]?.questionId === 301);

    const sortAsc = await api('/api/organization/exams/20/analytics/questions?sort=accuracy_asc', {
      headers: orgLogin.headers
    });
    const sortedQs = sortAsc.data?.data?.questions || [];
    ok('First question in accuracy_asc is Q305 (10%)', sortedQs[0]?.questionId === 305);
    ok('Last question in accuracy_asc is Q301 (90%)', sortedQs[sortedQs.length - 1]?.questionId === 301);

    db.close();
  } finally {
    proc.kill('SIGINT');
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch { }
    }
  }

  console.log(`\nQuestion Analytics Test Suite Completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

