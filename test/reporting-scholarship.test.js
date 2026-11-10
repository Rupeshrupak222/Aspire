// ============================================================================
// ASPIRE DAY 20: SCHOLARSHIP REPORTING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-scholarship-report-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getScholarshipReport } = require('../backend/src/services/reporting/scholarship-report.service');

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
  console.log('DAY 20: SCHOLARSHIP REPORT CORRECTNESS TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Premier Scholarship Trust', 'premier-trust', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status, passing_score)
    VALUES (101, 10, 'Global Merit Scholarship', 'GMS-2026', 'PUBLISHED', 40)
  `).run();

  // Insert 4 students with varying scholarship allocations
  const testData = [
    { id: 1, name: 'Devendra Sharma', pct: 95, grant: 100, code: 'CLM-100-DEV', cert: 'CERT-100' },
    { id: 2, name: 'Ananya Reddy', pct: 82, grant: 50, code: 'CLM-50-ANA', cert: 'CERT-50' },
    { id: 3, name: 'Rohit Verma', pct: 65, grant: 25, code: 'CLM-25-ROH', cert: NULL = null },
    { id: 4, name: 'Kavita Pillai', pct: 45, grant: 10, code: 'CLM-10-KAV', cert: NULL = null },
    { id: 5, name: 'Sameer Khan', pct: 30, grant: 0, code: NULL = null, cert: NULL = null }
  ];

  for (const s of testData) {
    db.prepare(`
      INSERT INTO students (id, organization_id, name, phone, email, college)
      VALUES (?, 10, ?, ?, ?, 'Indian Institute of Tech')
    `).run(s.id, s.name, `910000000${s.id}`, `user${s.id}@iit.ac.in`);

    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, score, total_marks, percentage, scholarship_pct, claim_code, certificate_id)
      VALUES (?, 10, ?, ?, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', ?, 100, ?, ?, ?, ?)
    `).run(500 + s.id, `tok_sch_${s.id}`, s.id, s.pct, s.pct, s.grant, s.code, s.cert);
  }

  try {
    console.log('--- 1. Scholarship Allocation & Tier Breakdown ---');
    const rep = getScholarshipReport({ organizationId: 10, isSuperAdmin: false, filters: {} });
    ok('Report type is scholarships', rep.reportType === 'scholarships');
    ok('All 5 evaluated candidates returned', rep.records.length === 5);
    ok('Summary exists', typeof rep.summary === 'object');
    ok('Total evaluated candidates is 5', rep.summary.total_evaluated_candidates === 5);
    ok('Total scholarships awarded is 4 (grants > 0)', rep.summary.total_scholarships_awarded === 4);
    ok('100% scholarship count is 1', rep.summary.scholarship_100_count === 1);
    ok('50% scholarship count is 1', rep.summary.scholarship_50_count === 1);
    ok('25% scholarship count is 1', rep.summary.scholarship_25_count === 1);
    ok('10% scholarship count is 1', rep.summary.scholarship_10_count === 1);
    ok('Average awarded percentage is 46.3% ( (100+50+25+10)/4 )', rep.summary.average_awarded_percentage === 46.3);

    console.log('\n--- 2. Recipient Claim Codes & Verification Status ---');
    const devendra = rep.records.find((r) => r.candidate_name === 'Devendra Sharma');
    ok('Devendra has 100% Top Tier', devendra.scholarship_tier.includes('100%'));
    ok('Devendra claim code is preserved', devendra.claim_code === 'CLM-100-DEV');
    ok('Devendra status is VERIFIED (certificate issued)', devendra.verification_status === 'VERIFIED');

    const rohit = rep.records.find((r) => r.candidate_name === 'Rohit Verma');
    ok('Rohit status is AWARDED (no cert yet)', rohit.verification_status === 'AWARDED');

    const sameer = rep.records.find((r) => r.candidate_name === 'Sameer Khan');
    ok('Sameer status is NOT_ELIGIBLE', sameer.verification_status === 'NOT_ELIGIBLE');

    console.log('\n--- 3. Filter by Specific Tier ---');
    const filtered50 = getScholarshipReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { scholarship_pct: 50 }
    });
    ok('Filtered by 50% returns exactly 1 candidate', filtered50.records.length === 1);
    ok('Candidate is Ananya Reddy', filtered50.records[0].candidate_name === 'Ananya Reddy');
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SCHOLARSHIP REPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

