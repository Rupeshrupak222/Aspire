// ============================================================================
// ASPIRE DAY 21: QUOTA POLICY & ENFORCEMENT TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-sub-quota-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;

const { db } = require('../backend/src/db');
const {
  checkQuota,
  consumeQuota,
  getQuotaSummary
} = require('../backend/src/services/subscription/quota.service');
const { assignSubscription } = require('../backend/src/services/subscription/subscription.service');
const examService = require('../backend/src/services/exam.service');

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
  console.log('DAY 21: QUOTA POLICY & ENFORCEMENT TEST SUITE');
  console.log('====================================================\n');

  // Seed super admin user and test organization
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (1, 'superadmin@test.com', 'hash', 'Super Admin', 'SUPER_ADMIN', 'ACTIVE'),
           (2, 'orgadmin@test.com', 'hash', 'Org Admin', 'ORG_ADMIN', 'ACTIVE')
  `).run();

  db.prepare(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES (10, 'Quota Enforcement Academy', 'quota-acad', 'ACTIVE')
  `).run();

  db.prepare(`
    UPDATE users SET organization_id = 10 WHERE id = 2
  `).run();

  // Assign STARTER plan (3 monthly exams, 500 candidates, 80% soft limit)
  assignSubscription({
    organizationId: 10,
    planCodeOrId: 'STARTER',
    status: 'ACTIVE',
    actorId: 1
  });

  try {
    console.log('--- 1. Soft-Limit Warning Threshold (80%) ---');
    // Starter has 500 candidates quota. 80% is 400.
    // Check below threshold (350 used)
    const checkBefore = checkQuota(10, 'candidates', 350);
    ok('Check 350 is allowed', checkBefore.allowed === true);
    ok('Check 350 warning is false (70% < 80%)', checkBefore.warning === false);

    // Check at threshold (400 used = 80%)
    const checkAtThreshold = checkQuota(10, 'candidates', 400);
    ok('Check 400 is allowed', checkAtThreshold.allowed === true);
    ok('Check 400 triggers soft-limit warning (80% reached)', checkAtThreshold.warning === true);
    ok('Soft-limit percentage is 80%', checkAtThreshold.softLimitPct === 80);

    console.log('\n--- 2. Hard-Limit Enforcement & Blocking ---');
    // Consume 498 units
    consumeQuota({
      organizationId: 10,
      resourceKey: 'candidates',
      quantity: 498,
      referenceType: 'batch_seed'
    });

    const checkNearCap = checkQuota(10, 'candidates', 2);
    ok('Check last 2 units is allowed', checkNearCap.allowed === true);
    ok('Remaining units is 2', checkNearCap.remaining === 2);

    // Consume 2 units -> reaches exact limit 500
    consumeQuota({
      organizationId: 10,
      resourceKey: 'candidates',
      quantity: 2,
      referenceType: 'batch_seed'
    });

    const summaryCap = getQuotaSummary(10);
    ok('Candidate quota marked exceeded/full at 500', summaryCap.resources.candidates.isExceeded === true);
    ok('Remaining candidate quota is 0', summaryCap.resources.candidates.remaining === 0);

    // Attempt to consume 1 more unit -> MUST BE BLOCKED
    let blocked = false;
    let errCode = null;
    try {
      consumeQuota({
        organizationId: 10,
        resourceKey: 'candidates',
        quantity: 1,
        referenceType: 'candidate',
        referenceId: 'cand_overflow'
      });
    } catch (err) {
      blocked = true;
      errCode = err.code;
    }
    ok('Operation rejected when quota is exhausted', blocked);
    ok('Error code is QUOTA_EXCEEDED', errCode === 'QUOTA_EXCEEDED');

    console.log('\n--- 3. Monthly Exam Publication Quota ---');
    // Starter plan allows 3 monthly published exams
    // Seed 4 draft exams with questions and scholarship slabs
    db.prepare(`
      INSERT INTO questions (id, type, category, question_text, marks, status)
      VALUES (1, 'mcq', 'General', 'What is 2+2?', 1, 'PUBLISHED')
    `).run();

    const adminUser = { id: 2, role: 'ORG_ADMIN', organization_id: 10 };

    for (let i = 1; i <= 4; i++) {
      db.prepare(`
        INSERT INTO exams (id, organization_id, name, code, status, created_by)
        VALUES (${100 + i}, 10, 'Exam ${i}', 'EX-${i}', 'DRAFT', 2)
      `).run();

      db.prepare(`
        INSERT INTO exam_sections (id, exam_id, name, display_order, question_selection_mode)
        VALUES (${100 + i}, ${100 + i}, 'Section A', 1, 'MANUAL')
      `).run();

      db.prepare(`
        INSERT INTO exam_section_questions (section_id, question_id, display_order)
        VALUES (${100 + i}, 1, 1)
      `).run();

      db.prepare(`
        INSERT INTO exam_scholarship_slabs (exam_id, min_score_pct, max_score_pct, discount_pct)
        VALUES (${100 + i}, 40, 100, 50)
      `).run();
    }

    // Verify draft creation did NOT consume quota
    const usageExamDraft = getQuotaSummary(10);
    ok('Draft creation consumed 0 monthly exam quota', usageExamDraft.resources.exams_monthly.used === 0);

    // Publish Exam 1 (consumes 1)
    examService.publishExam(101, adminUser);
    const u1 = getQuotaSummary(10);
    ok('Publishing Exam 1 consumed 1 quota unit', u1.resources.exams_monthly.used === 1);

    // Setting Exam 1 to LIVE does NOT consume additional quota
    examService.makeExamLive(101, adminUser);
    const u1Live = getQuotaSummary(10);
    ok('Transitioning to LIVE does NOT consume additional quota (still 1)', u1Live.resources.exams_monthly.used === 1);

    // Publish Exam 2 (consumes 1)
    examService.publishExam(102, adminUser);
    // Publish Exam 3 (consumes 1 -> reaches 3/3 cap)
    examService.publishExam(103, adminUser);

    const uCap = getQuotaSummary(10);
    ok('Exam quota reached maximum allowed (3/3)', uCap.resources.exams_monthly.used === 3);

    // Attempt to publish Exam 4 -> MUST BE BLOCKED
    let examBlocked = false;
    let examErrCode = null;
    try {
      examService.publishExam(104, adminUser);
    } catch (err) {
      examBlocked = true;
      examErrCode = err.code;
    }

    ok('4th exam publication blocked by quota engine', examBlocked);
    ok('Exam publication error code is QUOTA_EXCEEDED', examErrCode === 'QUOTA_EXCEEDED');

    // Verify Exam 4 remains in DRAFT status
    const exam4 = db.prepare('SELECT status FROM exams WHERE id = 104').get();
    ok('Blocked exam remains in DRAFT status safely', exam4.status === 'DRAFT');

  } finally {
    try { fs.unlinkSync(DB_FILE); } catch {}
  }

  console.log('\n====================================================');
  console.log(`SUBSCRIPTION QUOTA SUMMARY: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
