// ============================================================================
// ASPIRE DAY 20: PDF EXPORT (PDFKIT) TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-pdf-export-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { generatePdf } = require('../backend/src/services/reporting/pdf-export.service');
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
  console.log('DAY 20: PDF EXPORT (PDFKIT) TEST SUITE');
  console.log('====================================================\n');

  console.log('--- 1. Multi-Page Document & Visual Layout Tests ---');
  // Generate dummy report with 60 records to force multiple pages
  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Candidate Name' },
    { key: 'college', label: 'College' },
    { key: 'score', label: 'Score' },
    { key: 'pct', label: 'Percentage' },
    { key: 'status', label: 'Status' }
  ];

  const dummyRecords = [];
  for (let i = 1; i <= 60; i++) {
    dummyRecords.push({
      id: i,
      name: `Test Candidate Number ${i}`,
      college: `Institute of Engineering Campus ${i % 5}`,
      score: 80 + (i % 20),
      pct: `${70 + (i % 30)}%`,
      status: i % 2 === 0 ? 'SUBMITTED' : 'FINALIZED'
    });
  }

  const dummyData = {
    reportType: 'candidates',
    title: 'Candidate Multi-Page Verification Report',
    summary: {
      total_candidates: 60,
      average_percentage: 82.4,
      passed_count: 55,
      scholarships_awarded: 40
    },
    columns,
    records: dummyRecords,
    organization: { name: 'Imperial Academy of Science' }
  };

  const multiPagePdfBuffer = await generatePdf(dummyData);
  ok('Multi-page PDF buffer generated', multiPagePdfBuffer && multiPagePdfBuffer.length > 0);
  ok('Valid PDF magic bytes %PDF', multiPagePdfBuffer.toString('utf-8', 0, 4) === '%PDF');
  ok('Buffer size reflects multi-page content (> 5KB)', multiPagePdfBuffer.length > 5000);

  console.log('\n--- 2. End-to-End PDF Export Generation across 6 Report Types ---');
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Imperial Academy', 'imperial-acad', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'Entrance Scholarship', 'ES-2026', 'PUBLISHED')
  `).run();

  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (1, 10, 'Alice Walker', '9811111111', 'alice@imperial.edu', 'Imperial College'),
           (2, 10, 'Bob Smith', '9811111112', 'bob@imperial.edu', 'Imperial College')
  `).run();

  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (1001, 10, 'tok_pdf_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 92, 100),
           (1002, 10, 'tok_pdf_2', 2, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 78, 50)
  `).run();

  const reportTypes = ['candidates', 'exams', 'colleges', 'scholarships', 'questions', 'proctoring'];

  for (const rType of reportTypes) {
    const exp = await exportReport({
      reportType: rType,
      format: 'pdf',
      organizationId: 10,
      isSuperAdmin: false,
      filters: {}
    });

    ok(`[${rType}] Generated valid PDF buffer`, exp.buffer && exp.buffer.length > 0);
    ok(`[${rType}] Correct Content-Type (application/pdf)`, exp.contentType === 'application/pdf');
    ok(`[${rType}] Filename ends with .pdf`, exp.filename.endsWith('.pdf'));
    ok(`[${rType}] Starts with %PDF magic bytes`, exp.buffer.toString('utf-8', 0, 4) === '%PDF');
  }

  try { fs.unlinkSync(DB_FILE); } catch {}

  console.log('\n====================================================');
  console.log(`PDF EXPORT SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
