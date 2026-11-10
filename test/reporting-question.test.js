// ============================================================================
// ASPIRE DAY 20: QUESTION REPORTING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-question-report-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getQuestionReport } = require('../backend/src/services/reporting/question-report.service');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function run() {
  console.log('====================================================');
  console.log('DAY 20: QUESTION PSYCHOMETRICS REPORT TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Psychometrics Lab', 'psych-lab', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'Psychometric Assessment', 'PSA-2026', 'PUBLISHED')
  `).run();

  // Create 3 questions:
  // Q1: Easy question (90% accuracy)
  // Q2: Moderate/good discrimination
  // Q3: Very difficult/flagged question (10% accuracy)
  db.prepare(`
    INSERT INTO questions (id, organization_id, type, category, question_text, marks)
    VALUES (1, 10, 'mcq', 'Technical', 'What is the time complexity of binary search?', 1),
           (2, 10, 'mcq', 'Technical', 'Explain closures in JavaScript.', 2),
           (3, 10, 'mcq', 'Aptitude', 'Solve complex cryptographic puzzle.', 3)
  `).run();

  // Seed 12 students and finalized attempts to test Kelley's method (N >= 10)
  for (let i = 1; i <= 12; i++) {
    db.prepare(`
      INSERT INTO students (id, organization_id, name, phone, email)
      VALUES (?, 10, ?, ?, ?)
    `).run(i, `Student ${i}`, `99000000${i < 10 ? '0' + i : i}`, `s${i}@test.com`);

    // Top students (1-4) score 90-100%, get Q1 and Q2 correct
    // Bottom students (9-12) score 20-30%, get Q1 correct but Q2 wrong
    // Q3 is answered wrong by almost everyone (accuracy < 20%)
    const isTop = i <= 4;
    const isBottom = i >= 9;
    const score = isTop ? 90 : (isBottom ? 30 : 60);

    const graded = [
      { id: 1, isCorrect: true, userAnswer: 'O(log n)' },
      { id: 2, isCorrect: isTop, userAnswer: isTop ? 'function with scope' : 'wrong answer' },
      { id: 3, isCorrect: (i === 1), userAnswer: (i === 1) ? 'key' : 'wrong' }
    ];

    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, finalization_status, graded_detail_json)
      VALUES (?, 10, ?, ?, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', ?, 'FINALIZED', ?)
    `).run(600 + i, `tok_q_${i}`, i, score, JSON.stringify(graded));
  }

  try {
    console.log('--- 1. Question Accuracy & Difficulty Classification ---');
    const rep = getQuestionReport({ organizationId: 10, isSuperAdmin: false, filters: { exam_id: 101 } });
    ok('Report type is questions', rep.reportType === 'questions');
    ok('3 questions returned', rep.records.length === 3);

    const q1 = rep.records.find((r) => r.question_id === 1);
    ok('Q1 accuracy is 100%', q1.accuracy_percentage === '100%');
    ok('Q1 difficulty classified as VERY_EASY or EASY', q1.difficulty === 'VERY_EASY' || q1.difficulty === 'EASY');
    ok('Q1 timing available is explicitly Not Recorded', q1.timing_available === 'Not Recorded');

    const q3 = rep.records.find((r) => r.question_id === 3);
    ok('Q3 accuracy is 8.3% (1/12)', q3.accuracy_percentage === '8.3%');
    ok('Q3 classified as VERY_DIFFICULT', q3.difficulty === 'VERY_DIFFICULT');
    ok('Q3 flagged for review', q3.flagged_for_review === 'FLAGGED');

    console.log("\n--- 2. Kelley's Item Discrimination Index (D) ---");
    const q2 = rep.records.find((r) => r.question_id === 2);
    ok('Sample size N is 12 (meets N >= 10 requirement)', q2.sample_size === 12);
    ok('Q2 discrimination D is defined and positive (top scored higher than bottom)', parseFloat(q2.discrimination_d) > 0);
    ok('Q2 discrimination rating is EXCELLENT or GOOD', q2.discrimination_rating === 'EXCELLENT' || q2.discrimination_rating === 'GOOD');

    console.log('\n--- 3. Confidentiality & Security: No Correct Answer Leakage ---');
    for (const rec of rep.records) {
      ok(`Q${rec.question_id} does not contain correct_index or correct_answer`, rec.correct_index === undefined && rec.correct_answer === undefined);
      ok(`Q${rec.question_id} does not contain test_cases_json`, rec.test_cases_json === undefined);
    }
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`QUESTION REPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

