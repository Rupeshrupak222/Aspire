// ============================================================================
// ASPIRE DAY 20: REPORTING PERFORMANCE & SCALE BENCHMARK TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-report-perf-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const { getCandidateReport } = require('../backend/src/services/reporting/candidate-report.service');
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
  console.log('DAY 20: REPORTING PERFORMANCE & BENCHMARK SUITE');
  console.log('====================================================\n');

  // Seed organization and exams
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Scale Benchmark Academy', 'scale-bench', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'National Tech Olympiad 2026', 'NTO-2026', 'PUBLISHED')
  `).run();

  const RECORD_COUNT = 2000;
  console.log(`Seeding ${RECORD_COUNT} synthetic candidates & attempts in a single transaction...`);
  const seedStart = Date.now();

  const insertStudent = db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college, track, grad_year)
    VALUES (?, 10, ?, ?, ?, ?, 'Computer Science', '2026')
  `);

  const insertAttempt = db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (?, 10, ?, ?, 101, 'submitted', '2026-01-15T10:00:00Z', '2026-01-15T12:00:00Z', '2026-01-15T11:45:00Z', '[]', ?, ?)
  `);

  const colleges = ['IIT Bombay', 'BITS Pilani', 'NIT Trichy', 'Delhi University', 'Anna University'];

  db.transaction(() => {
    for (let i = 1; i <= RECORD_COUNT; i++) {
      const col = colleges[i % colleges.length];
      const pct = (i * 37) % 101;
      let sch = 0;
      if (pct >= 90) sch = 100;
      else if (pct >= 75) sch = 50;
      else if (pct >= 60) sch = 25;
      else if (pct >= 40) sch = 10;

      insertStudent.run(i, `Candidate ${i}`, `91000${String(i).padStart(5, '0')}`, `cand${i}@scale.edu`, col);
      insertAttempt.run(10000 + i, `tok_${i}`, i, pct, sch);
    }
  })();

  const seedTime = Date.now() - seedStart;
  console.log(`Seeded ${RECORD_COUNT} records in ${seedTime}ms.\n`);

  try {
    console.log('--- 1. Preview Query Latency & Pagination (25 per page) ---');
    const t0 = Date.now();
    const page1 = getCandidateReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { page: 1, limit: 25 }
    });
    const queryTime = Date.now() - t0;
    console.log(`  Pagination query executed in ${queryTime}ms`);
    ok('Preview query completes in < 150ms', queryTime < 150);
    ok('Correct pagination limit returned', page1.records.length === 25);
    ok('Total record count matches dataset', page1.pagination.totalRecords === RECORD_COUNT);
    ok('Total pages calculated correctly', page1.pagination.totalPages === Math.ceil(RECORD_COUNT / 25));

    console.log('\n--- 2. Filtered Query Performance (min_score: 75, college: "IIT") ---');
    const t1 = Date.now();
    const filteredRep = getCandidateReport({
      organizationId: 10,
      isSuperAdmin: false,
      filters: { min_score: 75, college: 'IIT', page: 1, limit: 50 }
    });
    const filterTime = Date.now() - t1;
    console.log(`  Filtered query executed in ${filterTime}ms`);
    ok('Filtered query completes in < 150ms', filterTime < 150);
    ok('All returned records match score threshold', filteredRep.records.every((r) => r.raw_percentage >= 75));
    ok('All returned records match college filter', filteredRep.records.every((r) => r.college.includes('IIT')));

    console.log('\n--- 3. CSV Export Generation Benchmark (1,000 records) ---');
    const memBeforeCsv = process.memoryUsage().heapUsed;
    const tCsvStart = Date.now();
    const csvResult = await exportReport({
      reportType: 'candidates',
      format: 'csv',
      organizationId: 10,
      isSuperAdmin: false,
      filters: { limit: 1000 },
      actorId: 999
    });
    const csvDuration = Date.now() - tCsvStart;
    const memAfterCsv = process.memoryUsage().heapUsed;
    const memDeltaCsvMB = (memAfterCsv - memBeforeCsv) / (1024 * 1024);

    console.log(`  CSV Export: 1,000 rows in ${csvDuration}ms | Buffer: ${(csvResult.buffer.length / 1024).toFixed(1)} KB | Heap delta: ${memDeltaCsvMB.toFixed(2)} MB`);
    ok('CSV export generates in < 300ms', csvDuration < 300);
    ok('CSV output buffer contains expected record count', csvResult.recordCount === 1000);
    ok('CSV starts with UTF-8 BOM', csvResult.buffer.toString('utf-8').startsWith('\uFEFF'));

    console.log('\n--- 4. Excel (XLSX) Export Generation Benchmark (1,000 records) ---');
    const tXlsxStart = Date.now();
    const xlsxResult = await exportReport({
      reportType: 'candidates',
      format: 'xlsx',
      organizationId: 10,
      isSuperAdmin: false,
      filters: { limit: 1000 },
      actorId: 999
    });
    const xlsxDuration = Date.now() - tXlsxStart;
    console.log(`  Excel Export: 1,000 rows in ${xlsxDuration}ms | Buffer: ${(xlsxResult.buffer.length / 1024).toFixed(1)} KB`);
    ok('Excel export completes in < 1500ms', xlsxDuration < 1500);
    ok('Excel output is a valid binary Buffer', Buffer.isBuffer(xlsxResult.buffer) && xlsxResult.buffer.length > 5000);
    ok('Excel export reports exact recordCount', xlsxResult.recordCount === 1000);

    console.log('\n--- 5. Memory Safety & Heap Stability ---');
    if (global.gc) global.gc();
    const heapUsedMB = process.memoryUsage().heapUsed / (1024 * 1024);
    console.log(`  Final heap usage: ${heapUsedMB.toFixed(2)} MB`);
    ok('Heap memory remains stable and under 250MB', heapUsedMB < 250);

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`REPORTING PERFORMANCE SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
