// ============================================================================
// ASPIRE DAY 20: REPORTING FILTERS & QUERY VALIDATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-report-filter-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  reportTypeParamSchema,
  reportFilterSchema,
  reportExportSchema,
  REPORT_TYPES,
  EXPORT_FORMATS
} = require('../backend/src/validation/reporting.schemas');
const { resolveReportDateFilter } = require('../backend/src/services/reporting/report-query.service');
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
  console.log('DAY 20: REPORTING FILTERS & VALIDATION TEST SUITE');
  console.log('====================================================\n');

  console.log('--- 1. Report Type Parameter Validation ---');
  for (const t of REPORT_TYPES) {
    const res = reportTypeParamSchema.safeParse({ reportType: t });
    ok(`Accepts valid report type "${t}"`, res.success);
  }
  const badType = reportTypeParamSchema.safeParse({ reportType: 'not_a_report' });
  ok('Rejects invalid report type "not_a_report"', !badType.success);

  console.log('\n--- 2. Date Range Filter Validation ---');
  // Valid ISO dates where start <= end
  const validDates = reportFilterSchema.safeParse({
    start_date: '2026-01-01T00:00:00Z',
    end_date: '2026-01-10T23:59:59Z'
  });
  ok('Accepts valid date range start_date <= end_date', validDates.success);

  // Inverted date range (start > end)
  const invertedDates = reportFilterSchema.safeParse({
    start_date: '2026-02-15T00:00:00Z',
    end_date: '2026-01-15T00:00:00Z'
  });
  ok('Rejects inverted date range start_date > end_date', !invertedDates.success);
  if (!invertedDates.success) {
    const msg = invertedDates.error.issues[0]?.message;
    ok('Provides explicit error message for inverted dates', msg && msg.includes('start_date cannot be after end_date'));
  }

  // Non-date string
  const malformedDate = reportFilterSchema.safeParse({
    start_date: 'not-a-real-date'
  });
  ok('Rejects non-ISO date string', !malformedDate.success);

  console.log('\n--- 3. Score Range & Numeric Boundary Validation ---');
  const validScores = reportFilterSchema.safeParse({
    min_score: 20,
    max_score: 80
  });
  ok('Accepts valid score range min_score <= max_score', validScores.success);

  const invertedScores = reportFilterSchema.safeParse({
    min_score: 90,
    max_score: 50
  });
  ok('Rejects inverted score range min_score > max_score', !invertedScores.success);

  const negativeScore = reportFilterSchema.safeParse({
    min_score: -10
  });
  ok('Rejects negative score', !negativeScore.success);

  const excessiveScore = reportFilterSchema.safeParse({
    max_score: 150
  });
  ok('Rejects score > 100', !excessiveScore.success);

  console.log('\n--- 4. Export Format & Limits Validation ---');
  for (const fmt of EXPORT_FORMATS) {
    const res = reportExportSchema.safeParse({ format: fmt });
    ok(`Accepts valid export format "${fmt}"`, res.success);
  }
  const invalidFmt = reportExportSchema.safeParse({ format: 'docx' });
  ok('Rejects invalid format "docx"', !invalidFmt.success);

  const validLimit = reportExportSchema.safeParse({ format: 'csv', limit: 5000 });
  ok('Accepts limit 5000 within 10,000 threshold', validLimit.success);

  const excessiveLimit = reportExportSchema.safeParse({ format: 'csv', limit: 25000 });
  ok('Rejects limit > 10,000 to prevent OOM/DoS', !excessiveLimit.success);

  console.log('\n--- 5. Period Helper Functions ---');
  const pToday = resolveReportDateFilter({ period: 'today' });
  ok('Period "today" yields start_date and end_date', Boolean(pToday.startDateStr && pToday.endDateStr));
  ok('Period "today" start_date is before or equal end_date', new Date(pToday.startDateStr) <= new Date(pToday.endDateStr));

  const p7d = resolveReportDateFilter({ period: '7d' });
  ok('Period "7d" yields a date ~7 days before now', () => {
    const start = new Date(p7d.startDateStr).getTime();
    const end = new Date(p7d.endDateStr).getTime();
    const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
    return diffDays >= 6 && diffDays <= 8;
  });

  const pAll = resolveReportDateFilter({ period: 'all' });
  ok('Period "all" returns null bounds', pAll.startDateStr === null && pAll.endDateStr === null);

  console.log('\n--- 6. Filter Execution Against Database ---');
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Filter Org', 'filter-org', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'Exam Alpha', 'EX-A', 'PUBLISHED'),
           (102, 10, 'Exam Beta', 'EX-B', 'PUBLISHED')
  `).run();

  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (1, 10, 'Alice Wonderland', '9888800001', 'alice@filter.com', 'Harvard University'),
           (2, 10, 'Bob Builder', '9888800002', 'bob@filter.com', 'MIT Institute'),
           (3, 10, 'Charlie Chaplin', '9888800003', 'charlie@filter.com', 'Stanford University')
  `).run();

  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (1001, 10, 'tok_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 95, 100),
           (1002, 10, 'tok_2', 2, 101, 'submitted', '2026-01-11T10:00:00Z', '2026-01-11T12:00:00Z', '2026-01-11T11:00:00Z', '[]', 60, 25),
           (1003, 10, 'tok_3', 3, 102, 'submitted', '2026-01-12T10:00:00Z', '2026-01-12T12:00:00Z', '2026-01-12T11:00:00Z', '[]', 40, 0)
  `).run();

  // Test exam_id filter
  const repExam = getCandidateReport({ organizationId: 10, isSuperAdmin: false, filters: { exam_id: 101 } });
  ok('Filters by exam_id', repExam.records.length === 2 && repExam.records.every((r) => r.exam_name === 'Exam Alpha'));

  // Test min_score filter
  const repScore = getCandidateReport({ organizationId: 10, isSuperAdmin: false, filters: { min_score: 70 } });
  ok('Filters by min_score >= 70', repScore.records.length === 1 && repScore.records[0].candidate_name === 'Alice Wonderland');

  // Test college search
  const repCollege = getCandidateReport({ organizationId: 10, isSuperAdmin: false, filters: { college: 'MIT' } });
  ok('Filters by college substring', repCollege.records.length === 1 && repCollege.records[0].college === 'MIT Institute');

  // Test candidate search text
  const repSearch = getCandidateReport({ organizationId: 10, isSuperAdmin: false, filters: { search: 'charlie' } });
  ok('Filters by candidate search text', repSearch.records.length === 1 && repSearch.records[0].candidate_name === 'Charlie Chaplin');

  // Clean up
  try { fs.unlinkSync(DB_FILE); } catch {}

  console.log('\n====================================================');
  console.log(`REPORTING FILTERS SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
