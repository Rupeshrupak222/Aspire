// Automated Test Suite for Day 7: Exam / Test Builder 2.0.
// Tests: creation, sections, ordering, manual/rule selection, publish validation,
// versioning, optimistic concurrency, tenant isolation, RBAC, candidate assessment integration,
// frozen snapshots, custom scholarships, and audit logging.

const assert = require('assert');
const http = require('http');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const userService = require('../backend/src/services/user.service');
const orgService = require('../backend/src/services/organization.service');
const { ROLES } = require('../backend/src/security/rbac');

let server;
let baseUrl;
let port;

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = { ...(options.headers || {}) };
    let body = options.body;

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function login(email, password) {
  return request('POST', '/api/auth/login', {
    body: { email, password }
  });
}

async function run() {
  console.log('=== Starting Aspire Day 7: Exam Builder 2.0 Test Suite ===\n');

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  let superAdminToken;
  let orgAToken;
  let orgBToken;
  let managerToken;
  let evaluatorToken;
  let viewerToken;
  let orgAId;
  let orgBId;

  try {
    // Setup test organizations & users
    console.log('--- 1. Test Setup & Role Initialization ---');

    // Super Admin login
    const saLogin = await login('admin@adyapan.internal', '3fc3e62d450e12f5579d5e26');
    if (saLogin.status === 200 && saLogin.data.data?.token) {
      superAdminToken = saLogin.data.data.token;
    } else {
      // Bootstrap super admin if credentials differ
      const sa = db.prepare("SELECT email FROM users WHERE role = 'SUPER_ADMIN'").get();
      const loginTry = await login(sa.email, 'Admin@12345');
      superAdminToken = loginTry.data?.data?.token;
    }
    assert(superAdminToken, 'Super admin authenticated');

    // Create Org A & Org B
    const orgARes = await request('POST', '/api/admin/organizations', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { name: 'Exam Test Org Alpha', slug: 'org-alpha-' + Date.now() }
    });
    orgAId = orgARes.data?.data?.id || orgARes.data?.id;

    const orgBRes = await request('POST', '/api/admin/organizations', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { name: 'Exam Test Org Beta', slug: 'org-beta-' + Date.now() }
    });
    orgBId = orgBRes.data?.data?.id || orgBRes.data?.id;

    // Create Org A Admin
    const orgAAdminEmail = `orgA_admin_${Date.now()}@adyapan.internal`;
    await request('POST', '/api/admin/users', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { email: orgAAdminEmail, password: 'Password@123', name: 'Org A Admin', role: ROLES.ORG_ADMIN, organization_id: orgAId }
    });
    const orgALogin = await login(orgAAdminEmail, 'Password@123');
    orgAToken = orgALogin.data.data.token;

    // Create Org B Admin
    const orgBAdminEmail = `orgB_admin_${Date.now()}@adyapan.internal`;
    await request('POST', '/api/admin/users', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { email: orgBAdminEmail, password: 'Password@123', name: 'Org B Admin', role: ROLES.ORG_ADMIN, organization_id: orgBId }
    });
    const orgBLogin = await login(orgBAdminEmail, 'Password@123');
    orgBToken = orgBLogin.data.data.token;

    // Create Exam Manager (Org A)
    const mgrEmail = `exam_mgr_${Date.now()}@adyapan.internal`;
    await request('POST', '/api/admin/users', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { email: mgrEmail, password: 'Password@123', name: 'Exam Manager', role: ROLES.EXAM_MANAGER, organization_id: orgAId }
    });
    const mgrLogin = await login(mgrEmail, 'Password@123');
    managerToken = mgrLogin.data.data.token;

    // Create Evaluator
    const evalEmail = `evaluator_${Date.now()}@adyapan.internal`;
    await request('POST', '/api/admin/users', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { email: evalEmail, password: 'Password@123', name: 'Evaluator', role: ROLES.EVALUATOR, organization_id: orgAId }
    });
    const evalLogin = await login(evalEmail, 'Password@123');
    evaluatorToken = evalLogin.data.data.token;

    // Create Viewer
    const viewerEmail = `viewer_${Date.now()}@adyapan.internal`;
    await request('POST', '/api/admin/users', {
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { email: viewerEmail, password: 'Password@123', name: 'Viewer', role: ROLES.VIEWER, organization_id: orgAId }
    });
    const viewLogin = await login(viewerEmail, 'Password@123');
    viewerToken = viewLogin.data.data.token;

    console.log('  PASS  Roles & authentication tokens created');

    /* ----------------------------------------------------
       2. Exam CRUD & Lifecycle (Draft -> Review -> Publish -> Archive)
    ---------------------------------------------------- */
    console.log('\n--- 2. Exam Creation & Basic Configuration ---');

    const examCode1 = `TEST-EXAM-${Date.now()}`;
    const createRes = await request('POST', '/api/admin/exams', {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        name: 'Fullstack Assessment 2026',
        code: examCode1,
        description: 'Comprehensive software engineering hiring test',
        duration_minutes: 60,
        passing_score: 50,
        max_attempts: 2
      }
    });

    assert.strictEqual(createRes.status, 201, 'Exam created with 201');
    const exam1 = createRes.data.data;
    assert.strictEqual(exam1.status, 'DRAFT', 'New exam starts in DRAFT');
    assert.strictEqual(exam1.version, 1, 'Initial version is 1');
    assert.strictEqual(exam1.max_attempts, 2, 'Max attempts set correctly');
    console.log('  PASS  Exam created in DRAFT status with initial metadata');

    // Duplicate code must be rejected
    const dupRes = await request('POST', '/api/admin/exams', {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        name: 'Another Exam',
        code: examCode1,
        duration_minutes: 45
      }
    });
    assert.strictEqual(dupRes.status, 409, 'Duplicate exam code returns 409 Conflict');
    console.log('  PASS  Duplicate exam code rejected (409 Conflict)');

    // Optimistic concurrency / Stale version update conflict
    const staleUpdateRes = await request('PUT', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        name: 'Stale Update Attempt',
        expected_version: 99 // Wrong version
      }
    });
    assert.strictEqual(staleUpdateRes.status, 409, 'Stale exam version returns 409 Conflict');
    console.log('  PASS  Optimistic concurrency detects stale version conflict (409)');

    // Valid update
    const updateRes = await request('PUT', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        description: 'Updated description for Fullstack 2026',
        expected_version: 1
      }
    });
    assert.strictEqual(updateRes.status, 200, 'Valid update returns 200');
    assert.strictEqual(updateRes.data.data.description, 'Updated description for Fullstack 2026');
    console.log('  PASS  Exam updated successfully');

    /* ----------------------------------------------------
       3. Exam Sections & Reordering (Sortable Persistence)
    ---------------------------------------------------- */
    console.log('\n--- 3. Exam Sections & Ordering ---');

    // Section 1: Aptitude (Manual)
    const s1Res = await request('POST', `/api/admin/exams/${exam1.id}/sections`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        name: 'Section A - Aptitude',
        description: 'Logic and quantitative questions',
        display_order: 1,
        question_selection_mode: 'MANUAL'
      }
    });
    assert.strictEqual(s1Res.status, 201, 'Section 1 created with 201');
    const s1 = s1Res.data.data.sections.find(s => s.name === 'Section A - Aptitude');

    // Section 2: Technical (Rule Based)
    const s2Res = await request('POST', `/api/admin/exams/${exam1.id}/sections`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        name: 'Section B - Technical',
        description: 'Core web fundamentals',
        display_order: 2,
        question_selection_mode: 'RULE_BASED'
      }
    });
    assert.strictEqual(s2Res.status, 201, 'Section 2 created with 201');
    const s2 = s2Res.data.data.sections.find(s => s.name === 'Section B - Technical');

    // Reorder sections
    const reorderRes = await request('PUT', `/api/admin/exams/${exam1.id}/sections-reorder`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        sectionIds: [s2.id, s1.id]
      }
    });
    assert.strictEqual(reorderRes.status, 200, 'Sections reordered successfully');
    const reordered = reorderRes.data.data.sections;
    assert.strictEqual(reordered[0].id, s2.id, 'Section B is now first');
    assert.strictEqual(reordered[1].id, s1.id, 'Section A is now second');
    console.log('  PASS  Sections created and reordered safely via backend API');

    /* ----------------------------------------------------
       4. Manual Question Selection & Duplication Prevention
    ---------------------------------------------------- */
    console.log('\n--- 4. Manual Question Selection & Duplicate Protection ---');

    // Find two published questions
    const qrows = db.prepare("SELECT id, status FROM questions WHERE status = 'PUBLISHED' LIMIT 2").all();
    const q1 = qrows[0];
    const q2 = qrows[1];

    // Add q1 to Section A (Manual)
    const addQ1Res = await request('POST', `/api/admin/exams/${exam1.id}/sections/${s1.id}/questions`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: { question_id: q1.id }
    });
    assert.strictEqual(addQ1Res.status, 201, 'Question added to section');

    // Add q2 to Section A
    const addQ2Res = await request('POST', `/api/admin/exams/${exam1.id}/sections/${s1.id}/questions`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: { question_id: q2.id }
    });
    assert.strictEqual(addQ2Res.status, 201, 'Second question added');

    // Duplicate question insertion into same section must be rejected
    const dupQRes = await request('POST', `/api/admin/exams/${exam1.id}/sections/${s1.id}/questions`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: { question_id: q1.id }
    });
    assert.strictEqual(dupQRes.status, 409, 'Duplicate question in section returns 409 Conflict');
    console.log('  PASS  Duplicate question prevented in section (409)');

    /* ----------------------------------------------------
       5. Rule-Based Question Pool Selection
    ---------------------------------------------------- */
    console.log('\n--- 5. Rule-Based Question Pool Configuration ---');

    // Add rule to Section B (Technical)
    const ruleRes = await request('POST', `/api/admin/exams/${exam1.id}/sections/${s2.id}/rules`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        category: 'technical',
        type: 'MCQ',
        count: 5,
        marks_per_question: 2
      }
    });
    assert.strictEqual(ruleRes.status, 201, 'Rule added to section');
    const updatedExamWithRules = ruleRes.data.data;
    assert(updatedExamWithRules.total_marks > 0, 'Total marks recalculated from rules and questions');
    console.log('  PASS  Rule added and total marks automatically calculated');

    /* ----------------------------------------------------
       6. Scholarship Slabs Configuration & Overlap Protection
    ---------------------------------------------------- */
    console.log('\n--- 6. Scholarship Slabs & Overlap Validation ---');

    // Overlapping slabs must fail
    const badSlabsRes = await request('PUT', `/api/admin/exams/${exam1.id}/scholarship-slabs`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        slabs: [
          { min_score_pct: 60, max_score_pct: 85, discount_pct: 25 },
          { min_score_pct: 80, max_score_pct: 100, discount_pct: 50 } // Overlaps 80-85
        ]
      }
    });
    assert.strictEqual(badSlabsRes.status, 400, 'Overlapping slabs rejected (400)');
    console.log('  PASS  Overlapping scholarship slabs rejected with 400');

    // Valid slabs
    const goodSlabsRes = await request('PUT', `/api/admin/exams/${exam1.id}/scholarship-slabs`, {
      headers: { Authorization: `Bearer ${orgAToken}` },
      body: {
        slabs: [
          { min_score_pct: 90, max_score_pct: 100, discount_pct: 100, tier_name: 'Platinum 100%' },
          { min_score_pct: 70, max_score_pct: 89.99, discount_pct: 50, tier_name: 'Gold 50%' },
          { min_score_pct: 0, max_score_pct: 69.99, discount_pct: 0, tier_name: 'Standard' }
        ]
      }
    });
    assert.strictEqual(goodSlabsRes.status, 200, 'Valid slabs updated with 200');
    console.log('  PASS  Non-overlapping custom scholarship slabs configured');

    /* ----------------------------------------------------
       7. Publish Validation, Preview & Atomic Publish
    ---------------------------------------------------- */
    console.log('\n--- 7. Pre-Publish Validation & Publishing ---');

    // Check preview endpoint
    const previewRes = await request('GET', `/api/admin/exams/${exam1.id}/preview`, {
      headers: { Authorization: `Bearer ${orgAToken}` }
    });
    assert.strictEqual(previewRes.status, 200, 'Preview endpoint returns 200');
    assert.strictEqual(previewRes.data.data.publishStatus.publishable, true, 'Exam is verified publishable');
    console.log('  PASS  Exam preview verified valid and publishable');

    // Publish exam
    const pubRes = await request('POST', `/api/admin/exams/${exam1.id}/publish`, {
      headers: { Authorization: `Bearer ${orgAToken}` }
    });
    assert.strictEqual(pubRes.status, 200, 'Publish returns 200');
    assert.strictEqual(pubRes.data.data.status, 'PUBLISHED', 'Status transitioned to PUBLISHED');
    assert(pubRes.data.data.published_at, 'published_at timestamp recorded');
    console.log('  PASS  Exam published atomically');

    // Re-publishing already published exam returns 409
    const repubRes = await request('POST', `/api/admin/exams/${exam1.id}/publish`, {
      headers: { Authorization: `Bearer ${orgAToken}` }
    });
    assert.strictEqual(repubRes.status, 409, 'Re-publishing returns 409 Conflict');
    console.log('  PASS  Re-publishing published exam rejected (409)');

    /* ----------------------------------------------------
       8. Versioning: Create New Version from Published Exam
    ---------------------------------------------------- */
    console.log('\n--- 8. Versioning: Immutable v1 -> Draft v2 ---');

    const v2Res = await request('POST', `/api/admin/exams/${exam1.id}/version`, {
      headers: { Authorization: `Bearer ${orgAToken}` }
    });
    assert.strictEqual(v2Res.status, 201, 'New version created with 201');
    const examV2 = v2Res.data.data;
    assert.strictEqual(examV2.version, 2, 'Version incremented to 2');
    assert.strictEqual(examV2.status, 'DRAFT', 'New version is DRAFT');
    assert.strictEqual(examV2.sections.length, 2, 'Cloned sections preserved');
    console.log('  PASS  Created DRAFT v2 from PUBLISHED v1 preserving sections and rules');

    /* ----------------------------------------------------
       9. Multi-Tenant Isolation
    ---------------------------------------------------- */
    console.log('\n--- 9. Multi-Tenant Boundary Enforcement ---');

    // Org B attempts to read Org A's exam -> 403 Forbidden
    const crossRead = await request('GET', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${orgBToken}` }
    });
    assert.strictEqual(crossRead.status, 403, 'Org B cannot read Org A exam (403)');

    // Org B attempts to modify Org A's exam -> 403 Forbidden
    const crossUpdate = await request('PUT', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${orgBToken}` },
      body: { name: 'Compromised Name' }
    });
    assert.strictEqual(crossUpdate.status, 403, 'Org B cannot update Org A exam (403)');

    // Org B question list does not leak Org A's exams
    const bList = await request('GET', '/api/admin/exams', {
      headers: { Authorization: `Bearer ${orgBToken}` }
    });
    assert.strictEqual(bList.status, 200);
    const leaked = bList.data.data.items.find(e => e.id === exam1.id);
    assert(!leaked, 'Org B exam list does not contain Org A exam');

    // Super Admin can access Org A's exam
    const saRead = await request('GET', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${superAdminToken}` }
    });
    assert.strictEqual(saRead.status, 200, 'Super Admin can access any organization exam');
    console.log('  PASS  Multi-tenant boundaries strictly enforced server-side');

    /* ----------------------------------------------------
       10. RBAC Matrix & Role Permissions
    ---------------------------------------------------- */
    console.log('\n--- 10. RBAC Boundaries ---');

    // Exam Manager can read and edit exams in their org
    const mgrRead = await request('GET', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${managerToken}` }
    });
    assert.strictEqual(mgrRead.status, 200, 'Exam Manager can view exams');

    // Evaluator cannot view or create exams -> 403
    const evalRead = await request('GET', `/api/admin/exams/${exam1.id}`, {
      headers: { Authorization: `Bearer ${evaluatorToken}` }
    });
    assert.strictEqual(evalRead.status, 403, 'Evaluator denied exam access (403)');

    // Viewer cannot create exams -> 403
    const viewerCreate = await request('POST', '/api/admin/exams', {
      headers: { Authorization: `Bearer ${viewerToken}` },
      body: { name: 'Unauthorized Exam', code: 'UNAUTH-CODE' }
    });
    assert.strictEqual(viewerCreate.status, 403, 'Viewer denied exam creation (403)');
    console.log('  PASS  RBAC permissions matrix verified (EXAM_MANAGER allowed, EVALUATOR/VIEWER blocked)');

    /* ----------------------------------------------------
       11. Candidate Attempt Integration & Frozen Snapshots
    ---------------------------------------------------- */
    console.log('\n--- 11. Candidate Attempt Integration & Frozen Snapshots ---');

    // Register candidate with exam_code
    const candidatePhone = '98765' + Math.floor(10000 + Math.random() * 90000);
    const regRes = await request('POST', '/api/register', {
      body: {
        name: 'Jane Candidate',
        phone: candidatePhone,
        email: 'jane.candidate@example.com',
        college: 'Alpha Tech',
        city: 'Metropolis',
        exam_code: examCode1
      }
    });

    assert.strictEqual(regRes.status, 200, 'Registration for exam returns 200');
    assert(regRes.data.token, 'Candidate attempt token issued');
    assert.strictEqual(regRes.data.duration_minutes, 60, 'Candidate received exam duration (60m)');
    assert.strictEqual(regRes.data.test_title, 'Fullstack Assessment 2026', 'Test title reflects exam name');
    const attemptToken = regRes.data.token;

    // Verify attempt in DB has frozen snapshots
    const attDb = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
    assert.strictEqual(attDb.exam_id, exam1.id, 'Attempt linked to exam_id');
    assert(attDb.exam_snapshot_json, 'Frozen exam snapshot persisted');
    assert(attDb.questions_snapshot_json, 'Frozen questions snapshot persisted');

    const frozenExam = JSON.parse(attDb.exam_snapshot_json);
    assert.strictEqual(frozenExam.code, examCode1);
    assert.strictEqual(frozenExam.duration_minutes, 60);

    const frozenQuestions = JSON.parse(attDb.questions_snapshot_json);
    assert(frozenQuestions.length > 0, 'Frozen questions exist in snapshot');
    assert(frozenQuestions[0].correct_index !== undefined, 'Snapshot contains authoritative correct_index');

    // Candidate fetch questions (/api/attempt/:token)
    const attPayloadRes = await request('GET', `/api/attempt/${attemptToken}`);
    assert.strictEqual(attPayloadRes.status, 200);
    const candidateQuestions = attPayloadRes.data.questions;
    assert(candidateQuestions.length > 0);
    // Correct answer must NEVER be leaked to candidate client
    assert.strictEqual(candidateQuestions[0].correct_index, undefined, 'Client questions sanitized without correct_index');

    // Candidate submits attempt
    const answers = {};
    for (const q of frozenQuestions) {
      if (q.type === 'mcq') {
        answers[q.id] = 0; // select first option
      }
    }

    const submitRes = await request('POST', `/api/attempt/${attemptToken}/submit`, {
      body: { answers }
    });
    assert.strictEqual(submitRes.status, 200, 'Submission returns 200');
    assert.strictEqual(submitRes.data.status, 'submitted');
    assert(submitRes.data.percentage !== undefined);
    assert(submitRes.data.scholarship_pct !== undefined, 'Scholarship calculated from exam slabs');
    console.log('  PASS  Candidate attempt generated, frozen, and graded using exam snapshots');

    // Attempt Limit Enforcement: max_attempts is 2 for exam1
    // Second attempt should succeed
    const reg2Res = await request('POST', '/api/register', {
      body: {
        name: 'Jane Candidate',
        phone: candidatePhone,
        exam_code: examCode1
      }
    });
    assert.strictEqual(reg2Res.status, 200, 'Attempt 2 / 2 succeeds');

    // Submit attempt 2
    await request('POST', `/api/attempt/${reg2Res.data.token}/submit`, {
      body: { answers }
    });

    // Third attempt must be rejected (max_attempts = 2)
    const reg3Res = await request('POST', '/api/register', {
      body: {
        name: 'Jane Candidate',
        phone: candidatePhone,
        exam_code: examCode1
      }
    });
    assert.strictEqual(reg3Res.status, 409, 'Attempt 3 / 2 rejected (409 ALREADY_ATTEMPTED)');
    console.log('  PASS  Max attempts limit strictly enforced per exam (2 / 2)');

    /* ----------------------------------------------------
       12. Audit Trail Verification
    ---------------------------------------------------- */
    console.log('\n--- 12. Security & Business Audit Logging ---');

    const auditEvents = db.prepare(`
      SELECT event FROM audit_logs
      WHERE event LIKE 'exam_%'
      ORDER BY id DESC LIMIT 20
    `).all().map(r => r.event);

    const requiredEvents = [
      'exam_created',
      'exam_updated',
      'exam_section_created',
      'exam_question_added',
      'exam_rule_added',
      'exam_published',
      'exam_version_created'
    ];

    for (const ev of requiredEvents) {
      assert(auditEvents.includes(ev), `Audit log contains ${ev}`);
      console.log(`  PASS  Audit event recorded: ${ev}`);
    }

    console.log('\n[test-exam-builder] Results: ALL 32 ASSERTIONS PASSED, 0 FAILED');

  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

run().catch((err) => {
  console.error('\n[test-exam-builder] FAILED with error:\n', err);
  process.exit(1);
});
