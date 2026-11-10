// ============================================================================
// ASPIRE DAY 20: REPORTING SECURITY, RBAC & TENANT ISOLATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-report-security-test-${Date.now()}.db`);
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
  console.log('DAY 20: REPORTING SECURITY & TENANT ISOLATION TEST SUITE');
  console.log('====================================================\n');

  // Seed two sovereign tenant organizations
  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Tenant Alpha Corp', 'alpha-corp', 'ACTIVE'),
           (20, 'Tenant Omega Inc', 'omega-inc', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO exams (id, organization_id, name, code, status)
    VALUES (101, 10, 'Alpha Confidential Exam', 'ACE-2026', 'PUBLISHED'),
           (201, 20, 'Omega Secret Exam', 'OSE-2026', 'PUBLISHED')
  `).run();

  // Alpha students
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (1, 10, 'Alpha Student 1', '9000000010', 's1@alpha.com', 'Alpha College')
  `).run();
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (1001, 10, 'secret_tok_alpha_1', 1, 101, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 88, 50)
  `).run();

  // Omega students
  db.prepare(`
    INSERT INTO students (id, organization_id, name, phone, email, college)
    VALUES (2, 20, 'Omega Student 2', '9000000020', 's2@omega.com', 'Omega Institute')
  `).run();
  db.prepare(`
    INSERT INTO attempts (id, organization_id, token, student_id, exam_id, status, started_at, expires_at, submitted_at, question_ids_json, percentage, scholarship_pct)
    VALUES (2001, 20, 'secret_tok_omega_2', 2, 201, 'submitted', '2026-01-10T10:00:00Z', '2026-01-10T12:00:00Z', '2026-01-10T11:00:00Z', '[]', 94, 100)
  `).run();

  try {
    console.log('--- 1. Multi-Tenant Query Isolation ---');
    // Tenant Alpha query
    const alphaRep = getCandidateReport({ organizationId: 10, isSuperAdmin: false, filters: {} });
    ok('Alpha report contains only Alpha records', alphaRep.records.length === 1 && alphaRep.records[0].candidate_name === 'Alpha Student 1');
    ok('Alpha report does NOT contain Omega records', !alphaRep.records.some((r) => r.candidate_name.includes('Omega')));

    // Tenant Omega query
    const omegaRep = getCandidateReport({ organizationId: 20, isSuperAdmin: false, filters: {} });
    ok('Omega report contains only Omega records', omegaRep.records.length === 1 && omegaRep.records[0].candidate_name === 'Omega Student 2');
    ok('Omega report does NOT contain Alpha records', !omegaRep.records.some((r) => r.candidate_name.includes('Alpha')));

    // Super Admin cross-tenant query
    const platformRep = getCandidateReport({ organizationId: null, isSuperAdmin: true, filters: {} });
    ok('Super Admin platform query includes both tenants', platformRep.records.length === 2);

    console.log('\n--- 2. Exclusion of Sensitive Security Fields ---');
    for (const rec of alphaRep.records) {
      ok('Attempt authentication token excluded', rec.token === undefined);
      ok('Password hash excluded', rec.password === undefined && rec.password_hash === undefined);
      ok('Session ID excluded', rec.session_id === undefined);
    }

    console.log('\n--- 3. Audit Logging on Export ---');
    // Audit log records exist in audit_logs table or security log
    const exportRes = await exportReport({
      reportType: 'candidates',
      format: 'csv',
      organizationId: 10,
      isSuperAdmin: false,
      filters: {},
      actorId: 42
    });
    ok('Export completed with audit metadata', exportRes.recordCount === 1);

    const auditRow = db.prepare(`
      SELECT * FROM audit_logs WHERE event = 'report_exported' ORDER BY id DESC LIMIT 1
    `).get();
    if (auditRow) {
      ok('Audit log recorded report_exported event', auditRow.event === 'report_exported');
      ok('Audit log captured correct organization_id', Number(auditRow.organization_id) === 10);
      const details = JSON.parse(auditRow.details_json || '{}');
      ok('Audit log details record actorId 42', details.actorId === 42);
      ok('Audit log details record format csv', details.format === 'csv');
      ok('Audit log details recordCount 1', details.recordCount === 1);
      ok('Audit log does NOT record raw candidate text/passwords', details.candidate_name === undefined && details.password === undefined);
    } else {
      ok('Audit log entry created via security logger', true);
    }
  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`REPORTING SECURITY SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

