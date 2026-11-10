// ============================================================================
// ASPIRE DAY 20: CSV EXPORT & FORMULA INJECTION MITIGATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-csv-export-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { sanitizeCsvCell, generateCsv } = require('../backend/src/services/reporting/csv-export.service');
const { exportReport } = require('../backend/src/services/reporting/report.service');

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
  console.log('DAY 20: CSV EXPORT & FORMULA INJECTION TEST SUITE');
  console.log('====================================================\n');

  console.log('--- 1. Unit Tests: CSV Formula Injection Mitigation ---');
  ok('Neutralize "=" prefix', sanitizeCsvCell('=1+1') === "'=1+1");
  ok('Neutralize "+cmd" prefix', sanitizeCsvCell('+cmd') === "'+cmd");
  ok('Neutralize "-2+5" prefix', sanitizeCsvCell('-2+5') === "'-2+5");
  ok('Neutralize "@SUM" prefix', sanitizeCsvCell('@SUM(A1:A5)') === "'@SUM(A1:A5)");
  ok('Neutralize tab character prefix', sanitizeCsvCell('\t=calc') === "'\t=calc");
  ok('Neutralize carriage return prefix with quote wrapping', sanitizeCsvCell('\r=calc') === "\"'\r=calc\"");
  ok('Preserve safe alphanumeric text', sanitizeCsvCell('Adyapan Aspire') === 'Adyapan Aspire');
  ok('Preserve numbers untouched', sanitizeCsvCell(95.5) === '95.5');
  ok('Escape quotes and wrap comma in RFC-4180 quotes', sanitizeCsvCell('Hello, "World"') === '"Hello, ""World"""');
  ok('Handle null and undefined safely', sanitizeCsvCell(null) === '' && sanitizeCsvCell(undefined) === '');

  console.log('\n--- 2. End-to-End CSV Export Generation across 6 Report Types ---');
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Global Institute', 'global-inst', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'Entrance Exam', 'EE-2026', 'PUBLISHED')
  `).run();

  // Insert candidate with malicious name payload to verify DDE attack neutralization in real query output
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (1, 10, '=cmd|'' /C calc''!A0', '9888888881', 'malicious@evil.com', '+IIT Bombay'),
           (2, 10, 'Normal Student', '9888888882', 'normal@good.com', 'BITS Pilani')
  `).run();

  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (801, 10, 'tok_csv_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 80, 50),
           (802, 10, 'tok_csv_2', 2, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 90, 100)
  `).run();

  const reportTypes = ['candidates', 'exams', 'colleges', 'scholarships', 'questions', 'proctoring'];

  for (const rType of reportTypes) {
    const exp = await exportReport({
      reportType: rType,
      format: 'csv',
      organizationId: 10,
      isSuperAdmin: false,
      filters: {}
    });

    ok(`[${rType}] CSV export generated valid buffer`, exp.buffer && exp.buffer.length > 0);
    ok(`[${rType}] Correct content-type (text/csv; charset=utf-8)`, exp.contentType === 'text/csv; charset=utf-8');
    ok(`[${rType}] Safe filename with .csv extension`, exp.filename.endsWith('.csv'));

    const csvText = exp.buffer.toString('utf-8');
    ok(`[${rType}] Has UTF-8 BOM indicator`, csvText.charCodeAt(0) === 0xFEFF);

    // In candidate and college reports, verify that the malicious payload was neutralized
    if (rType === 'candidates') {
      ok('Malicious candidate name was sanitized with prepended single-quote in CSV', csvText.includes("'=cmd|"));
      ok('Malicious college name (+IIT) was sanitized with prepended single-quote in CSV', csvText.includes("'+IIT Bombay"));
    }
  }

  try { fs.unlinkSync(DB_FILE); } catch {}

  console.log('\n====================================================');
  console.log(`CSV EXPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
