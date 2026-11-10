// ============================================================================
// ASPIRE DAY 20: PROCTORING REPORTING TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-proctoring-report-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getProctoringReport } = require('../backend/src/services/reporting/proctoring-report.service');

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
  console.log('DAY 20: PROCTORING INTEGRITY REPORT TEST SUITE');
  console.log('====================================================\n');

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Secure Exam Authority', 'secure-exam', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'High-Stakes Certification', 'HSC-2026', 'PUBLISHED')
  `).run();

  // Create 4 candidates with varying risk profiles:
  // 1. Normal (0 points)
  // 2. Warning (30 points: 3 tab switches)
  // 3. Suspicious (60 points: 6 tab switches)
  // 4. High Risk (95 points: 5 tab switches + 3 copy attempts)
  for (let i = 1; i <= 4; i++) {
    db.prepare(`
      INSERT INTO students (id, organization_id, name, phone, email, college)
      VALUES (?, 10, ?, ?, ?, 'Tech University')
    `).run(i, `Candidate Risk ${i}`, `991100000${i}`, `risk${i}@tech.edu`);

    db.prepare(`
      INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json)
      VALUES (?, 10, ?, ?, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]')
    `).run(700 + i, `tok_p_${i}`, i);
  }

  // Seed proctoring events:
  // Candidate 2 (Attempt 702): 3 TAB_SWITCH (30 pts -> WARNING)
  for (let k = 1; k <= 3; k++) {
    db.prepare(`
      INSERT INTO proctoring_events (event_id, organization_id, attempt_id, event_type, risk_points, event_timestamp)
      VALUES (?, 10, 702, 'TAB_SWITCH', 10, '2026-01-10T10:1${k}:00Z')
    `).run(`ev_702_${k}`);
  }

  // Candidate 3 (Attempt 703): 6 TAB_SWITCH (60 pts -> SUSPICIOUS)
  for (let k = 1; k <= 6; k++) {
    db.prepare(`
      INSERT INTO proctoring_events (event_id, organization_id, attempt_id, event_type, risk_points, event_timestamp)
      VALUES (?, 10, 703, 'TAB_SWITCH', 10, '2026-01-10T10:2${k}:00Z')
    `).run(`ev_703_${k}`);
  }

  // Candidate 4 (Attempt 704): 5 TAB_SWITCH + 3 COPY_ATTEMPT (50 + 45 = 95 pts -> HIGH_RISK)
  for (let k = 1; k <= 5; k++) {
    db.prepare(`
      INSERT INTO proctoring_events (event_id, organization_id, attempt_id, event_type, risk_points, event_timestamp)
      VALUES (?, 10, 704, 'TAB_SWITCH', 10, '2026-01-10T10:3${k}:00Z')
    `).run(`ev_704_t_${k}`);
  }
  for (let k = 1; k <= 3; k++) {
    db.prepare(`
      INSERT INTO proctoring_events (event_id, organization_id, attempt_id, event_type, risk_points, event_timestamp)
      VALUES (?, 10, 704, 'COPY_ATTEMPT', 15, '2026-01-10T10:4${k}:00Z')
    `).run(`ev_704_c_${k}`);
  }

  try {
    console.log('--- 1. Proctoring Risk Classification (Day 11 Thresholds) ---');
    const rep = getProctoringReport({ organizationId: 10, isSuperAdmin: false, filters: {} });
    ok('Report type is proctoring', rep.reportType === 'proctoring');
    ok('4 sessions monitored', rep.records.length === 4);

    const normalCand = rep.records.find((r) => r.candidate_id === 1);
    ok('Candidate 1 score is 0 and classification NORMAL', normalCand.risk_score === 0 && normalCand.risk_classification === 'NORMAL');

    const warningCand = rep.records.find((r) => r.candidate_id === 2);
    ok('Candidate 2 score is 30 and classification WARNING', warningCand.risk_score === 30 && warningCand.risk_classification === 'WARNING');

    const suspCand = rep.records.find((r) => r.candidate_id === 3);
    ok('Candidate 3 score is 60 and classification SUSPICIOUS', suspCand.risk_score === 60 && suspCand.risk_classification === 'SUSPICIOUS');

    const highCand = rep.records.find((r) => r.candidate_id === 4);
    ok('Candidate 4 score is 95 and classification HIGH_RISK', highCand.risk_score === 95 && highCand.risk_classification === 'HIGH_RISK');
    ok('Candidate 4 review status is PENDING_REVIEW', highCand.review_status === 'PENDING_REVIEW');

    console.log('\n--- 2. Filter by Risk Level ---');
    const highRiskOnly = getProctoringReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { risk_level: 'HIGH_RISK' }
    });
    ok('Filtered by HIGH_RISK returns exactly 1 candidate', highRiskOnly.records.length === 1);
    ok('High risk candidate is Candidate Risk 4', highRiskOnly.records[0].candidate_id === 4);

    console.log('\n--- 3. Data Privacy & Zero Clipboard Content ---');
    for (const rec of rep.records) {
      ok(`Candidate ${rec.candidate_id} has no clipboard data`, rec.clipboardText === undefined && rec.clipboardData === undefined);
      ok(`Candidate ${rec.candidate_id} has no keystroke data`, rec.keystrokes === undefined);
    }
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`PROCTORING REPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
