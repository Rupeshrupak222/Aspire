// ============================================================================
// ASPIRE DAY 20: COLLEGE REPORTING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-college-report-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getCollegeReport } = require('../backend/src/services/reporting/college-report.service');

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
  console.log('DAY 20: COLLEGE REPORT CORRECTNESS TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Consortium Admin', 'consortium-admin', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status, passing_score)
    VALUES (101, 10, 'State Assessment', 'STA-2026', 'PUBLISHED', 40)
  `).run();

  // College A: 2 students, 3 attempts, high scores
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (1, 10, 'Student A1', '9000000001', 'a1@collega.edu', 'Stanford University'),
           (2, 10, 'Student A2', '9000000002', 'a2@collega.edu', ' Stanford University  ')
  `).run();

  // Student A1 has 2 attempts (retake)
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, certificate_id)
    VALUES (401, 10, 'c_tok_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 90, 100, 90, 100, 'CERT-COL-1'),
           (402, 10, 'c_tok_2', 1, 101, 'submitted', '2026-01-11T10:00:00Z', '2026-01-11T12:00:00Z', '2026-01-11T11:00:00Z', '[]', 96, 100, 96, 100, 'CERT-COL-2'),
           (403, 10, 'c_tok_3', 2, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 84, 100, 84, 50, 'CERT-COL-3')
  `).run();

  // College B: 1 student, 1 attempt, lower score
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (3, 10, 'Student B1', '9000000003', 'b1@collegb.edu', 'Berkeley College')
  `).run();
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, certificate_id)
    VALUES (404, 10, 'c_tok_4', 3, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 50, 100, 50, 10, NULL)
  `).run();

  // College NULL: 1 student, no college specified
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (4, 10, 'Student Independent', '9000000004', 'ind@mail.com', NULL)
  `).run();
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, certificate_id)
    VALUES (405, 10, 'c_tok_5', 4, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 35, 100, 35, 0, NULL)
  `).run();

  try {
    console.log('--- 1. College Normalization & Metric Aggregation ---');
    const rep = getCollegeReport({ organizationId: 10, isSuperAdmin: false, filters: {} });
    ok('Report type is colleges', rep.reportType === 'colleges');
    ok('Exactly 3 college records returned (Stanford, Berkeley, Not Specified)', rep.records.length === 3);

    const stanford = rep.records.find((r) => r.college_name === 'Stanford University');
    ok('Stanford has normalized trimmed name', !!stanford);
    ok('Stanford unique candidates is 2 (not 3 attempts)', stanford.registered_candidates === 2);
    ok('Stanford completed attempts is 3', stanford.completed_attempts === 3);
    ok('Stanford pass count is 2 unique students', stanford.pass_count === 2);
    ok('Stanford pass rate is 66.7% (2 / 3)', stanford.pass_rate === '66.7%');
    ok('Stanford highest score is 96%', stanford.highest_score === '96%');
    ok('Stanford certificates generated is 3', stanford.certificates_generated === 3);
    ok('Stanford scholarships awarded is 3', stanford.scholarships_awarded === 3);

    console.log('\n--- 2. Unspecified College Handling ---');
    const unspec = rep.records.find((r) => r.college_name === 'Not Specified');
    ok('NULL college mapped cleanly to Not Specified', !!unspec);
    ok('Not Specified candidate count is 1', unspec.registered_candidates === 1);
    ok('Not Specified fail count is 1', unspec.fail_count === 1);

    console.log('\n--- 3. Sorting By Metric ---');
    const sortedByAvg = getCollegeReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { sort_by: 'avg_score', sort_order: 'desc' }
    });
    ok('First college sorted by avg_score is Stanford', sortedByAvg.records[0].college_name === 'Stanford University');

    console.log('\n--- 4. Summary Key Metrics ---');
    ok('Total colleges in summary is 3', rep.summary.total_colleges === 3);
    ok('Top performing college is Stanford University', rep.summary.top_performing_college === 'Stanford University');
    ok('Total institutional candidates is 4', rep.summary.total_candidates === 4);
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`COLLEGE REPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

