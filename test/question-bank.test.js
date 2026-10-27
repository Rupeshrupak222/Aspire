// Day 6 — Question Bank 2.0 Test Suite
// Verifies metadata, lifecycle transitions, publish validation, search, filtering,
// pagination, duplicate detection, bulk CSV import/export, preview, versioning,
// multi-tenant isolation, RBAC matrix, and audit logging.

const path = require('path');
const fs = require('fs');

const TEST_DB = path.join(__dirname, 'question-bank-test.db');
process.env.DB_PATH = TEST_DB;
process.env.NODE_ENV = 'test';
process.env.PORT = '3217';
process.env.AUTH_SECRET = 'day6-question-bank-test-secret-32-chars!';
process.env.RATE_LIMIT_DISABLED = '1';

// Clean test db files if leftover
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB + ext)) fs.unlinkSync(TEST_DB + ext);
}

const Database = require('better-sqlite3');
const { db, closeDatabase } = require('../backend/src/db');
const { runMigrations } = require('../backend/src/db/migrations');
const { seedIfEmpty } = require('../backend/src/data/seed');
const createApp = require('../backend/src/app');
const { ROLES } = require('../backend/src/security/rbac');

// Seed test database
seedIfEmpty(db);

let server;
const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

async function request(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });
  let data;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    data = await res.text();
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data };
}

async function run() {
  console.log(`[test-qb] Starting Question Bank 2.0 tests on port ${PORT}`);
  const app = createApp();

  await new Promise((resolve, reject) => {
    server = app.listen(PORT, resolve);
    server.on('error', reject);
  });

  // Wait for server health
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  try {
    /* ----------------------------------------------------
       0. Auth Setup: Super Admin, Org Admins, Evaluator, Viewer
    ---------------------------------------------------- */
    console.log('\n--- 0. Authentication & Role Provisioning ---');

    // Login as default Super Admin
    const superLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@adyapan.internal', password: 'admin' }
    });
    // In case password was randomly generated during bootstrap:
    let superToken;
    if (superLogin.ok && superLogin.data?.data?.token) {
      superToken = superLogin.data.data.token;
    } else {
      // Direct token generation for test via db
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync('SuperPass123!', 10);
      db.prepare(`UPDATE users SET password_hash = ? WHERE email = 'admin@adyapan.internal'`).run(hash);
      const reLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { email: 'admin@adyapan.internal', password: 'SuperPass123!' }
      });
      superToken = reLogin.data.data.token;
    }
    const superH = { Authorization: `Bearer ${superToken}` };
    assert(!!superToken, 'Super Admin logged in successfully');

    // Create Org A & Org B
    const orgARes = await request('/api/admin/organizations', {
      method: 'POST', headers: superH,
      body: { name: 'Acme Academy', slug: 'acme-academy' }
    });
    const orgAId = orgARes.data?.data?.id || orgARes.data?.id;

    const orgBRes = await request('/api/admin/organizations', {
      method: 'POST', headers: superH,
      body: { name: 'Beta Institute', slug: 'beta-institute' }
    });
    const orgBId = orgBRes.data?.data?.id || orgBRes.data?.id;

    // Create Org Admin A
    await request('/api/admin/users', {
      method: 'POST', headers: superH,
      body: { email: 'orgadmin_a@acme.edu', password: 'Password123!', name: 'Org Admin A', role: 'ORG_ADMIN', organization_id: orgAId }
    });
    const loginA = await request('/api/auth/login', {
      method: 'POST', body: { email: 'orgadmin_a@acme.edu', password: 'Password123!' }
    });
    const orgAH = { Authorization: `Bearer ${loginA.data.data.token}` };
    assert(!!loginA.data?.data?.token, 'Org Admin A created and authenticated');

    // Create Org Admin B
    await request('/api/admin/users', {
      method: 'POST', headers: superH,
      body: { email: 'orgadmin_b@beta.edu', password: 'Password123!', name: 'Org Admin B', role: 'ORG_ADMIN', organization_id: orgBId }
    });
    const loginB = await request('/api/auth/login', {
      method: 'POST', body: { email: 'orgadmin_b@beta.edu', password: 'Password123!' }
    });
    const orgBH = { Authorization: `Bearer ${loginB.data.data.token}` };
    assert(!!loginB.data?.data?.token, 'Org Admin B created and authenticated');

    // Create Evaluator & Viewer in Org A
    await request('/api/admin/users', {
      method: 'POST', headers: superH,
      body: { email: 'evaluator@acme.edu', password: 'Password123!', name: 'Evaluator', role: 'EVALUATOR', organization_id: orgAId }
    });
    const loginEval = await request('/api/auth/login', {
      method: 'POST', body: { email: 'evaluator@acme.edu', password: 'Password123!' }
    });
    const evalH = { Authorization: `Bearer ${loginEval.data.data.token}` };

    await request('/api/admin/users', {
      method: 'POST', headers: superH,
      body: { email: 'viewer@acme.edu', password: 'Password123!', name: 'Viewer', role: 'VIEWER', organization_id: orgAId }
    });
    const loginView = await request('/api/auth/login', {
      method: 'POST', body: { email: 'viewer@acme.edu', password: 'Password123!' }
    });
    const viewH = { Authorization: `Bearer ${loginView.data.data.token}` };

    /* ----------------------------------------------------
       1. Question Bank 2.0 Metadata & Creation
    ---------------------------------------------------- */
    console.log('\n--- 1. Question Bank 2.0 Metadata & Creation ---');

    const createRes = await request('/api/admin/questions', {
      method: 'POST',
      headers: orgAH,
      body: {
        type: 'mcq',
        category: 'technical',
        title: 'Binary Search Time Complexity',
        question_text: 'What is the average time complexity of binary search on a sorted array?',
        difficulty: 'EASY',
        topic: 'Algorithms',
        skill: 'Searching',
        time_estimate: 60,
        tags: ['Algorithms', 'binary search', 'Complexity'],
        status: 'DRAFT',
        marks: 2,
        options: ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'],
        correct_index: 1
      }
    });

    assert(createRes.status === 201, 'Create question returns 201');
    assert(!!createRes.data.id, 'Response includes new question ID');
    const q1Id = createRes.data.id;

    // Verify database record metadata
    const qRow = db.prepare('SELECT * FROM questions WHERE id = ?').get(q1Id);
    assert(qRow.title === 'Binary Search Time Complexity', 'Title persisted correctly');
    assert(qRow.difficulty === 'EASY', 'Difficulty persisted');
    assert(qRow.topic === 'Algorithms', 'Topic persisted');
    assert(qRow.skill === 'Searching', 'Skill persisted');
    assert(qRow.time_estimate === 60, 'Time estimate persisted');
    assert(qRow.status === 'DRAFT', 'Initial status is DRAFT');
    assert(qRow.version === 1, 'Initial version is 1');
    assert(qRow.organization_id === orgAId, 'Organization ID automatically scoped from authenticated user');

    const tagsArr = JSON.parse(qRow.tags);
    assert(tagsArr.includes('algorithms') && tagsArr.includes('binary search'), 'Tags normalized to lowercase array');

    /* ----------------------------------------------------
       2. Lifecycle State Machine & Publishing Validation
    ---------------------------------------------------- */
    console.log('\n--- 2. Lifecycle State Machine & Publishing Validation ---');

    // 2.1 Create an incomplete draft MCQ (no options)
    const draftRes = await request('/api/admin/questions', {
      method: 'POST',
      headers: orgAH,
      body: {
        type: 'mcq',
        category: 'aptitude',
        title: 'Incomplete Draft Question',
        question_text: 'Draft Question text without options yet...',
        status: 'DRAFT'
      }
    });
    assert(draftRes.status === 201, 'Incomplete question allowed in DRAFT status');
    const draftId = draftRes.data.id;

    // 2.2 Attempt to publish incomplete question -> must fail validation
    const badPublish = await request(`/api/admin/questions/${draftId}/publish`, {
      method: 'POST',
      headers: orgAH
    });
    assert(badPublish.status === 400, 'Publishing incomplete MCQ rejected with 400');
    assert(badPublish.data.code === 'VALIDATION_ERROR', 'Error code is VALIDATION_ERROR');

    // 2.3 Transition DRAFT -> REVIEW
    const reviewRes = await request(`/api/admin/questions/${q1Id}`, {
      method: 'PUT',
      headers: orgAH,
      body: { status: 'REVIEW' }
    });
    assert(reviewRes.status === 200, 'Transition DRAFT -> REVIEW returns 200');

    // 2.4 Transition REVIEW -> PUBLISHED
    const pubRes = await request(`/api/admin/questions/${q1Id}/publish`, {
      method: 'POST',
      headers: orgAH
    });
    assert(pubRes.status === 200, 'Publishing valid question returns 200');
    assert(pubRes.data.status === 'PUBLISHED', 'Status updated to PUBLISHED');

    // 2.5 Transition PUBLISHED -> ARCHIVED
    const archRes = await request(`/api/admin/questions/${q1Id}/archive`, {
      method: 'POST',
      headers: orgAH
    });
    assert(archRes.status === 200, 'Archiving published question returns 200');
    assert(archRes.data.status === 'ARCHIVED', 'Status updated to ARCHIVED');

    // 2.6 Transition ARCHIVED -> DRAFT
    const unarchRes = await request(`/api/admin/questions/${q1Id}`, {
      method: 'PUT',
      headers: orgAH,
      body: { status: 'DRAFT' }
    });
    assert(unarchRes.status === 200, 'Transition ARCHIVED -> DRAFT returns 200');

    // Re-publish q1 for subsequent tests
    await request(`/api/admin/questions/${q1Id}/publish`, { method: 'POST', headers: orgAH });

    /* ----------------------------------------------------
       3. Historical Assessment Protection & Versioning
    ---------------------------------------------------- */
    console.log('\n--- 3. Historical Assessment Protection & Versioning ---');

    // Simulate an attempt referencing question q1Id
    const simToken = 'test_sim_attempt_token_' + Date.now();
    const studentRes = db.prepare(`INSERT INTO students (name, phone, organization_id) VALUES ('Sim Student', '9870000001', ?)`).run(orgAId);
    db.prepare(`
      INSERT INTO attempts (token, student_id, expires_at, question_ids_json, organization_id)
      VALUES (?, ?, datetime('now', '+1 hour'), ?, ?)
    `).run(simToken, studentRes.lastInsertRowid, JSON.stringify([q1Id]), orgAId);

    // Edit the published question referenced by the attempt
    const editRes = await request(`/api/admin/questions/${q1Id}`, {
      method: 'PUT',
      headers: orgAH,
      body: { marks: 5 }
    });
    assert(editRes.status === 200, 'Editing referenced question returns 200');
    assert(editRes.data.version === 2, 'Question version incremented to 2 due to historical references');

    // Attempt to DELETE the referenced question -> should archive instead of break history
    const delRes = await request(`/api/admin/questions/${q1Id}`, {
      method: 'DELETE',
      headers: orgAH
    });
    assert(delRes.status === 200, 'Delete request completed');
    assert(delRes.data.archived === true, 'Referenced question archived instead of hard-deleted to preserve history');

    const checkArchived = db.prepare('SELECT status FROM questions WHERE id = ?').get(q1Id);
    assert(checkArchived.status === 'ARCHIVED', 'Database record status set to ARCHIVED');

    /* ----------------------------------------------------
       4. Search, Filtering, Sorting & Pagination
    ---------------------------------------------------- */
    console.log('\n--- 4. Search, Filtering, Sorting & Pagination ---');

    // Create multiple questions with diverse metadata in Org A
    await request('/api/admin/questions', {
      method: 'POST', headers: orgAH,
      body: {
        type: 'mcq', category: 'aptitude', title: 'Speed and Distance Problem',
        question_text: 'A train traveling at 60 km/h crosses a pole in 9 seconds. What is length of train?',
        difficulty: 'MEDIUM', topic: 'Aptitude', skill: 'Arithmetic', marks: 3,
        options: ['120m', '150m', '180m', '200m'], correct_index: 1, status: 'PUBLISHED'
      }
    });

    await request('/api/admin/questions', {
      method: 'POST', headers: orgAH,
      body: {
        type: 'code', category: 'coding', title: 'Reverse a Linked List',
        question_text: 'Given the head of a singly linked list, reverse the list and return its head.',
        difficulty: 'HARD', topic: 'Data Structures', skill: 'Linked Lists', marks: 10,
        language: 'python', language_id: 71,
        test_cases: [{ input: '[1,2,3]', expected: '[3,2,1]' }],
        status: 'PUBLISHED'
      }
    });

    // 4.1 Filter by difficulty=HARD
    const hardRes = await request('/api/admin/questions?difficulty=HARD&paginate=true', { headers: orgAH });
    assert(hardRes.status === 200, 'Difficulty filter request returns 200');
    assert(hardRes.data.data.items.every((q) => q.difficulty === 'HARD'), 'All returned questions have difficulty HARD');

    // 4.2 Filter by topic=Algorithms
    const topicRes = await request('/api/admin/questions?topic=Algorithms&paginate=true', { headers: orgAH });
    assert(topicRes.status === 200, 'Topic filter request returns 200');
    assert(topicRes.data.data.items.length >= 1, 'Found questions matching topic Algorithms');

    // 4.3 Search by keyword
    const searchRes = await request('/api/admin/questions?search=train&paginate=true', { headers: orgAH });
    assert(searchRes.status === 200, 'Search request returns 200');
    assert(searchRes.data.data.items.some((q) => q.question_text.includes('train')), 'Found question matching keyword "train"');

    // 4.4 Pagination
    const pageRes = await request('/api/admin/questions?page=1&limit=2', { headers: orgAH });
    assert(pageRes.status === 200, 'Pagination request returns 200');
    assert(pageRes.data.data.items.length === 2, 'Page size restricted to limit=2');
    assert(pageRes.data.data.pagination.page === 1, 'Pagination reports page 1');
    assert(pageRes.data.data.pagination.limit === 2, 'Pagination reports limit 2');
    assert(pageRes.data.data.pagination.total >= 2, 'Pagination reports total count');

    /* ----------------------------------------------------
       5. Duplicate Question Detection
    ---------------------------------------------------- */
    console.log('\n--- 5. Duplicate Question Detection ---');

    // 5.1 Exact duplicate check
    const dupExact = await request('/api/admin/questions/duplicates', {
      method: 'POST',
      headers: orgAH,
      body: {
        question_text: 'A train traveling at 60 km/h crosses a pole in 9 seconds. What is length of train?'
      }
    });
    assert(dupExact.status === 200, 'Duplicate check returns 200');
    assert(dupExact.data.data.exactDuplicate === true, 'Exact duplicate detected correctly');

    // 5.2 Fuzzy duplicate check (case & punctuation variation)
    const dupFuzzy = await request('/api/admin/questions/duplicates', {
      method: 'POST',
      headers: orgAH,
      body: {
        question_text: 'a train traveling at 60 kmh crosses a pole in 9 seconds'
      }
    });
    assert(dupFuzzy.data.data.exactDuplicate === true || dupFuzzy.data.data.matches.length > 0, 'Normalized/fuzzy duplicate detected');

    // 5.3 Unique question check
    const dupUnique = await request('/api/admin/questions/duplicates', {
      method: 'POST',
      headers: orgAH,
      body: {
        question_text: 'Completely novel question about quantum computing and qubits.'
      }
    });
    assert(dupUnique.data.data.exactDuplicate === false, 'Unique question identified as non-duplicate');

    /* ----------------------------------------------------
       6. Multi-Tenant Isolation
    ---------------------------------------------------- */
    console.log('\n--- 6. Multi-Tenant Isolation ---');

    // Create question in Org B
    const qBRes = await request('/api/admin/questions', {
      method: 'POST',
      headers: orgBH,
      body: {
        type: 'mcq', category: 'technical', title: 'Org B Secret Question',
        question_text: 'Proprietary question belonging exclusively to Beta Institute',
        options: ['Yes', 'No'], correct_index: 0, status: 'PUBLISHED'
      }
    });
    const qBId = qBRes.data.id;
    assert(!!qBId, 'Created question in Org B');

    // Org A tries to READ Org B question directly
    const crossRead = await request(`/api/admin/questions/${qBId}`, { headers: orgAH });
    assert(crossRead.status === 403, 'Org A cannot read Org B question (403 Forbidden)');

    // Org A tries to UPDATE Org B question
    const crossUpdate = await request(`/api/admin/questions/${qBId}`, {
      method: 'PUT', headers: orgAH,
      body: { marks: 99 }
    });
    assert(crossUpdate.status === 403, 'Org A cannot update Org B question (403 Forbidden)');

    // Org A tries to ARCHIVE Org B question
    const crossArch = await request(`/api/admin/questions/${qBId}/archive`, {
      method: 'POST', headers: orgAH
    });
    assert(crossArch.status === 403, 'Org A cannot archive Org B question (403 Forbidden)');

    // Org A question listing does NOT leak Org B question
    const listA = await request('/api/admin/questions?search=Proprietary', { headers: orgAH });
    const foundInA = Array.isArray(listA.data) ? listA.data : (listA.data?.data?.items || []);
    assert(foundInA.length === 0, 'Org A question list does not leak Org B questions');

    // Super Admin CAN access Org B question
    const superRead = await request(`/api/admin/questions/${qBId}`, { headers: superH });
    assert(superRead.status === 200, 'Super Admin can access Org B question');

    /* ----------------------------------------------------
       7. RBAC Matrix & Role Boundaries
    ---------------------------------------------------- */
    console.log('\n--- 7. RBAC Matrix & Role Boundaries ---');

    // Evaluator cannot create or edit questions
    const evalCreate = await request('/api/admin/questions', {
      method: 'POST', headers: evalH,
      body: { type: 'mcq', category: 'aptitude', question_text: 'Eval question', options: ['A', 'B'], correct_index: 0 }
    });
    assert(evalCreate.status === 403, 'EVALUATOR cannot create questions (403 Forbidden)');

    const evalRead = await request('/api/admin/questions', { headers: evalH });
    assert(evalRead.status === 403, 'EVALUATOR cannot read questions (403 Forbidden)');

    // Viewer cannot create or edit questions
    const viewCreate = await request('/api/admin/questions', {
      method: 'POST', headers: viewH,
      body: { type: 'mcq', category: 'aptitude', question_text: 'Viewer question', options: ['A', 'B'], correct_index: 0 }
    });
    assert(viewCreate.status === 403, 'VIEWER cannot create questions (403 Forbidden)');

    /* ----------------------------------------------------
       8. Bulk CSV Import & Export
    ---------------------------------------------------- */
    console.log('\n--- 8. Bulk CSV Import & Export ---');

    const sampleCsv = `type,category,title,question_text,difficulty,topic,skill,marks,time_estimate,options,correct_index,status
mcq,aptitude,Percentage Problem,What is 25% of 200?,EASY,Aptitude,Percentages,1,60,"40;50;60;70",1,PUBLISHED
mcq,technical,SQL Primary Key,What does a PRIMARY KEY constraint enforce?,MEDIUM,Database,SQL,2,90,"Uniqueness only;Not null only;Uniqueness and Not Null;Auto increment only",2,PUBLISHED
code,coding,Two Sum,Find two numbers in array that add up to target.,EASY,Algorithms,Arrays,5,300,"",,"[{\"input\":\"[2,7,11,15], 9\",\"expected\":\"[0,1]\"}]",PUBLISHED`;

    // 8.1 Preview CSV (dry run)
    const previewRes = await request('/api/admin/questions/import/preview', {
      method: 'POST',
      headers: orgAH,
      body: { csv: sampleCsv }
    });
    assert(previewRes.status === 200, 'CSV preview returns 200');
    assert(previewRes.data.data.totalRows === 3, 'Preview parsed 3 rows');
    assert(previewRes.data.data.validCount === 3, 'Preview identified 3 valid rows');
    assert(previewRes.data.data.dryRun === true, 'Preview confirms dryRun=true');

    // 8.2 Import CSV
    const importRes = await request('/api/admin/questions/import', {
      method: 'POST',
      headers: orgAH,
      body: { csv: sampleCsv }
    });
    assert(importRes.status === 200, 'CSV import returns 200');
    assert(importRes.data.data.importedCount === 3, 'All 3 questions imported successfully');

    // 8.3 Export CSV (tenant scoped)
    const exportRes = await request('/api/admin/questions/export', {
      headers: orgAH
    });
    assert(exportRes.status === 200, 'CSV export returns 200');
    assert(exportRes.headers.get('content-type').includes('text/csv'), 'Export returns text/csv Content-Type');
    assert(exportRes.data.includes('Percentage Problem'), 'Export CSV contains imported Org A question');
    assert(!exportRes.data.includes('Org B Secret Question'), 'Export CSV does NOT leak Org B questions');

    /* ----------------------------------------------------
       9. Question Preview Endpoint
    ---------------------------------------------------- */
    console.log('\n--- 9. Question Preview Endpoint ---');

    const previewItemRes = await request(`/api/admin/questions/${draftId}/preview`, {
      headers: orgAH
    });
    assert(previewItemRes.status === 200, 'Question preview endpoint returns 200');
    assert(previewItemRes.data.data.question_text !== undefined, 'Preview returns question text');
    assert(previewItemRes.data.data.correct_index === undefined, 'Preview sanitizes correct answer from response');

    /* ----------------------------------------------------
       10. Audit Logging Verification
    ---------------------------------------------------- */
    console.log('\n--- 10. Audit Logging Verification ---');

    const auditRows = db.prepare('SELECT DISTINCT event FROM audit_logs').all().map((r) => r.event);
    assert(auditRows.includes('question_created'), 'question_created recorded in audit log');
    assert(auditRows.includes('question_updated'), 'question_updated recorded in audit log');
    assert(auditRows.includes('question_published'), 'question_published recorded in audit log');
    assert(auditRows.includes('question_archived'), 'question_archived recorded in audit log');
    assert(auditRows.includes('question_bulk_imported'), 'question_bulk_imported recorded in audit log');
    assert(auditRows.includes('question_bulk_exported'), 'question_bulk_exported recorded in audit log');

    /* ----------------------------------------------------
       11. Summary & Teardown
    ---------------------------------------------------- */
    console.log(`\n[test-qb] Results: ${passed} PASSED, ${failed} FAILED`);
  } finally {
    if (server) {
      await new Promise((r) => server.close(r));
    }
    closeDatabase();
    for (const ext of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(TEST_DB + ext)) fs.unlinkSync(TEST_DB + ext);
      } catch {}
    }
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('[test-qb] Unexpected test runner error:', err);
  if (server) server.close();
  process.exit(1);
});
