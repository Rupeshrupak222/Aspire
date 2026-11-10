// ============================================================================
// ASPIRE DAY 20: CANDIDATE REPORTING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-candidate-report-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getCandidateReport } = require('../backend/src/services/reporting/candidate-report.service');

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
  console.log('DAY 20: CANDIDATE REPORT CORRECTNESS TEST SUITE');
  console.log('====================================================\n');

  // Seed sample organizations, exams, candidates, and attempts
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Apex Institute', 'apex-inst', 'ACTIVE'),
           (20, 'Beta Tech', 'beta-tech', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status, passing_score)
    VALUES (101, 10, 'National CS Scholarship', 'NCS-2026', 'PUBLISHED', 50),
           (102, 20, 'Data Analytics Exam', 'DAE-2026', 'PUBLISHED', 45)
  `).run();

  // Insert 3 students for Org 10 (one has retakes)
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college, track, grad_year, created_at)
    VALUES (1, 10, 'Aarav Patel', '9876543210', 'aarav@apex.edu', 'Apex College', 'Computer Science', '2026', '2026-01-10T10:00:00Z'),
           (2, 10, 'Bhavya Sharma', '9876543211', 'bhavya@apex.edu', 'Apex College', 'Information Tech', '2026', '2026-01-12T10:00:00Z'),
           (3, 10, 'Chirag Rao', '9876543212', 'chirag@other.edu', 'Other Institute', 'Electronics', '2027', '2026-01-15T10:00:00Z')
  `).run();

  // Student 1 has 2 attempts (retake)
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, certificate_id)
    VALUES (201, 10, 'tok_att_1', 1, 101, 'submitted', '2026-01-10T10:05:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 85, 100, 85, 50, 'CERT-001'),
           (202, 10, 'tok_att_2', 1, 101, 'submitted', '2026-01-11T10:05:00Z', '2026-01-11T12:00:00Z', '2026-01-11T11:00:00Z', '[]', 95, 100, 95, 100, 'CERT-002'),
           (203, 10, 'tok_att_3', 2, 101, 'submitted', '2026-01-12T10:05:00Z', '2026-01-12T12:00:00Z', '2026-01-12T11:00:00Z', '[]', 40, 100, 40, 0, NULL),
           (204, 10, 'tok_att_4', 3, 101, 'started', '2026-01-15T10:05:00Z', '2026-01-15T12:00:00Z', NULL, '[]', NULL, 100, NULL, NULL, NULL)
  `).run();

  try {
    // Test 1: Complete report generation
    console.log('--- 1. Candidate Roster & Metrics ---');
    const rep = getCandidateReport({ organizationId: 10, isSuperAdmin: false, filters: {} });
    ok('Candidate report returned correct reportType', rep.reportType === 'candidates');
    ok('Report columns defined', Array.isArray(rep.columns) && rep.columns.length >= 10);
    ok('Records returned', rep.records.length === 4); // 4 attempt rows
    ok('Summary exists', typeof rep.summary === 'object');
    ok('Unique candidates count is 3', rep.summary.total_candidates === 3);
    ok('Total attempts count is 4', rep.summary.total_attempts === 4);
    ok('Completed attempts count is 3', rep.summary.completed_attempts === 3);

    // Test 2: Retake handling & candidate detail verification
    console.log('\n--- 2. Retake Handling & Student Details ---');
    const s1Attempts = rep.records.filter((r) => r.candidate_id === 1);
    ok('Student 1 has exactly 2 attempt records', s1Attempts.length === 2);
    ok('First attempt percentage is 95% (sorted desc)', s1Attempts[0].percentage === '95%');
    ok('Scholarship tier is Top Tier for 100%', s1Attempts[0].scholarship_tier.includes('100%'));
    ok('Certificate status is ISSUED for CERT-002', s1Attempts[0].certificate_status === 'ISSUED');

    // Test 3: Filters
    console.log('\n--- 3. Filter Application ---');
    const filteredByCollege = getCandidateReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { college: 'Apex' }
    });
    ok('Filtered by college returns 3 records', filteredByCollege.records.length === 3);

    const filteredByScholarship = getCandidateReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { scholarship_pct: 100 }
    });
    ok('Filtered by 100% scholarship returns 1 record', filteredByScholarship.records.length === 1);
    ok('Candidate is Aarav Patel', filteredByScholarship.records[0].candidate_name === 'Aarav Patel');

    // Test 4: Empty organization
    console.log('\n--- 4. Empty Organization Behavior ---');
    const emptyRep = getCandidateReport({ organizationId: 999, isSuperAdmin: false, filters: {} });
    ok('Empty org returns 0 records cleanly', emptyRep.records.length === 0);
    ok('Summary has 0 total candidates', emptyRep.summary.total_candidates === 0);
    ok('Average percentage is 0 without error', emptyRep.summary.average_percentage === 0);
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`CANDIDATE REPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
