// ============================================================================
// ASPIRE DAY 20: EXCEL (.XLSX) EXPORT TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const DB_FILE = path.join(os.tmpdir(), `aspire-excel-export-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { sanitizeExcelCell } = require('../backend/src/services/reporting/excel-export.service');
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
  console.log('DAY 20: EXCEL EXPORT (SHEETJS) TEST SUITE');
  console.log('====================================================\n');

  console.log('--- 1. Unit Tests: Excel Formula Injection Protection ---');
  ok('Neutralize "=" formula in Excel', sanitizeExcelCell('=SUM(A1:A10)') === "'=SUM(A1:A10)");
  ok('Neutralize "+cmd" in Excel', sanitizeExcelCell('+cmd') === "'+cmd");
  ok('Neutralize "-5" string formula in Excel', sanitizeExcelCell('-5') === "'-5");
  ok('Neutralize "@HYPERLINK" in Excel', sanitizeExcelCell('@HYPERLINK("http://evil.com")') === "'@HYPERLINK(\"http://evil.com\")");
  ok('Numbers remain numbers', sanitizeExcelCell(88.5) === 88.5);
  ok('Safe strings remain safe', sanitizeExcelCell('Computer Science') === 'Computer Science');

  console.log('\n--- 2. End-to-End Excel Workbook Generation (6 Report Types) ---');
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Polytechnic College', 'poly-college', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'Polytechnic Merit Exam', 'PME-2026', 'PUBLISHED')
  `).run();

  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (1, 10, 'Candidate One', '9890000001', 'c1@poly.edu', 'Polytechnic Main'),
           (2, 10, '=DDE("cmd";"/C calc";"A0")', '9890000002', 'c2@poly.edu', 'Polytechnic North')
  `).run();

  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (901, 10, 'tok_xl_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 85, 50),
           (902, 10, 'tok_xl_2', 2, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 92, 100)
  `).run();

  const reportTypes = ['candidates', 'exams', 'colleges', 'scholarships', 'questions', 'proctoring'];

  for (const rType of reportTypes) {
    const exp = await exportReport({
      reportType: rType,
      format: 'xlsx',
      organizationId: 10,
      isSuperAdmin: false,
      filters: {}
    });

    ok(`[${rType}] Generated non-empty buffer`, exp.buffer && exp.buffer.length > 0);
    ok(`[${rType}] Correct MIME type (spreadsheetml.sheet)`, exp.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    ok(`[${rType}] Filename ends with .xlsx`, exp.filename.endsWith('.xlsx'));

    // Parse workbook using SheetJS to verify structure
    const wb = XLSX.read(exp.buffer, { type: 'buffer' });
    ok(`[${rType}] Valid workbook parsed with at least 2 sheets`, wb.SheetNames.length >= 2);
    ok(`[${rType}] Contains "Summary & KPIs" sheet`, wb.SheetNames.includes('Summary & KPIs'));

    // Verify primary sheet has data
    const primarySheet = wb.Sheets[wb.SheetNames[0]];
    const primaryJson = XLSX.utils.sheet_to_json(primarySheet);
    ok(`[${rType}] Primary sheet is readable by SheetJS`, Array.isArray(primaryJson));

    // Verify formula injection neutralized in candidate report
    if (rType === 'candidates') {
      const rows = XLSX.utils.sheet_to_json(primarySheet, { header: 1 });
      const malRow = rows.find((r) => r.some((cell) => typeof cell === 'string' && cell.includes('DDE')));
      ok('Malicious formula cell neutralized with prepended quote in Excel', malRow && malRow.some((c) => typeof c === 'string' && c.startsWith("'=")));
    }
  }

  try { fs.unlinkSync(DB_FILE); } catch {}

  console.log('\n====================================================');
  console.log(`EXCEL EXPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
