// ============================================================================
// ASPIRE DAY 20: EXAM REPORTING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-exam-report-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getExamReport } = require('../backend/src/services/reporting/exam-report.service');

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
  console.log('DAY 20: EXAM REPORT CORRECTNESS TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Zenith University', 'zenith-uni', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status, duration_minutes, passing_score, created_at)
    VALUES (101, 10, 'Fullstack Engineering Entrance', 'FEE-2026', 'PUBLISHED', 90, 50, '2026-01-01T00:00:00Z'),
           (102, 10, 'Data Science Fellowship', 'DSF-2026', 'LIVE', 60, 60, '2026-01-05T00:00:00Z')
  `).run();

  // Seed 5 students
  for (let i = 1; i <= 5; i++) {
    db.prepare(`
      INSERT INTO students (id, organization_id, name, phone, email, college)
      VALUES (?, 10, ?, ?, ?, 'Zenith Institute')
    `).run(i, `Candidate ${i}`, `987000000${i}`, `cand${i}@zenith.edu`);
  }

  // Exam 101: 4 students attempted:
  // Candidate 1: 90% (Pass, 100% scholarship, CERT)
  // Candidate 2: 70% (Pass, 50% scholarship)
  // Candidate 3: 40% (Fail, 0% scholarship)
  // Candidate 4: Abandoned
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, certificate_id)
    VALUES (301, 10, 'tok_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T11:30:00Z', '2026-01-10T11:00:00Z', '[]', 90, 100, 90, 100, 'CERT-EX1'),
           (302, 10, 'tok_2', 2, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T11:30:00Z', '2026-01-10T11:00:00Z', '[]', 70, 100, 70, 50, NULL),
           (303, 10, 'tok_3', 3, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T11:30:00Z', '2026-01-10T11:00:00Z', '[]', 40, 100, 40, 0, NULL),
           (304, 10, 'tok_4', 4, 101, 'abandoned', '2026-01-10T10:00:00Z', '2026-01-10T11:30:00Z', NULL, '[]', NULL, 100, NULL, NULL, NULL)
  `).run();

  // Exam 102: Candidate 5 registered and submitted 80% (Pass)
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, certificate_id)
    VALUES (305, 10, 'tok_5', 5, 102, 'submitted', '2026-01-12T10:00:00Z', '2026-01-12T11:00:00Z', '2026-01-12T10:50:00Z', '[]', 80, 100, 80, 50, 'CERT-EX2')
  `).run();

  try {
    console.log('--- 1. Examination Funnel & Performance Metrics ---');
    const rep = getExamReport({ organizationId: 10, isSuperAdmin: false, filters: {} });
    ok('Report returned type exams', rep.reportType === 'exams');
    ok('Exactly 2 exams returned', rep.records.length === 2);

    const ex1 = rep.records.find((r) => r.exam_id === 101);
    ok('Exam 101 registered candidates is 4', ex1.registered_candidates === 4);
    ok('Exam 101 completed attempts is 3', ex1.completed_attempts === 3);
    ok('Exam 101 abandoned attempts is 1', ex1.abandoned_attempts === 1);
    ok('Exam 101 passed candidates is 2', ex1.passed_candidates === 2);
    ok('Exam 101 failed candidates is 1', ex1.failed_candidates === 1);
    ok('Exam 101 completion rate is 75%', ex1.completion_rate === '75%');
    ok('Exam 101 pass rate is 66.7%', ex1.pass_rate === '66.7%');
    ok('Exam 101 highest score is 90%', ex1.highest_score === '90%');
    ok('Exam 101 lowest score is 40%', ex1.lowest_score === '40%');
    ok('Exam 101 certificates count is 1', ex1.certificates_issued === 1);

    console.log('\n--- 2. Aggregate Summary Across Exams ---');
    ok('Total exams in summary is 2', rep.summary.total_exams === 2);
    ok('Total completed across exams is 4', rep.summary.total_completed === 4);
    ok('Total passed across exams is 3', rep.summary.total_passed === 3);
    ok('Overall pass rate is 75%', rep.summary.overall_pass_rate === 75);

    console.log('\n--- 3. Single Exam Filter ---');
    const singleExamRep = getExamReport({ organizationId: 10, isSuperAdmin: false, filters: { exam_id: 102 } });
    ok('Filtered by exam_id returns 1 exam record', singleExamRep.records.length === 1);
    ok('Exam title is Data Science Fellowship', singleExamRep.records[0].title === 'Data Science Fellowship');
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`EXAM REPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

