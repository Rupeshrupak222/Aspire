// Automated Test Suite for Day 10: Asynchronous Code Execution with Redis, BullMQ & Dedicated Workers.
// Verifies:
// 1. Transactional outbox durability & SQLite authoritative persistence.
// 2. HTTP 202 Async Acknowledgment (immediate response with statusUrl & retryAfterMs).
// 3. Queue publication with stable submissionId deduplication.
// 4. Worker job processor & lifecycle state transitions (QUEUED -> RUNNING -> COMPLETED).
// 5. Candidate status polling endpoint (authorization, snapshot HMAC verification, zero test leakage).
// 6. Error-aware retry behavior (deterministic verdicts like WRONG_ANSWER / COMPILATION_ERROR do NOT retry; transient 5xx retries).
// 7. Dual-write gap protection & Redis outage resilience (outbox retention and fallback execution).
// 8. 15-second idempotency on async submissions.
// 9. Final exam submit coordination (draining in-flight jobs, authoritative coding_submissions scoring).
// 10. Admin observability endpoints (queue & outbox metrics, full lifecycle audit).
// 11. Worker graceful shutdown.

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { executionService } = require('../backend/src/services/code-execution/execution.service');
const {
  EXECUTION_STATUS,
  SUBMISSION_LIFECYCLE,
  OUTBOX_STATUS
} = require('../backend/src/services/code-execution/constants');
const BaseProvider = require('../backend/src/services/code-execution/providers/base.provider');
const { codeExecutionQueue } = require('../backend/src/queues/code-execution.queue');
const { processCodeJob } = require('../backend/src/workers/code-execution.processor');
const outboxDispatcher = require('../backend/src/workers/outbox-dispatcher');
const { shutdown: shutdownWorker } = require('../backend/src/workers/code-execution.worker');
const userService = require('../backend/src/services/user.service');
const orgService = require('../backend/src/services/organization.service');
const examService = require('../backend/src/services/exam.service');
const snapshotService = require('../backend/src/services/snapshot.service');
const { ROLES } = require('../backend/src/security/rbac');
const { ExternalServiceError } = require('../backend/src/errors/app-error');

let server;
let baseUrl;

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = {
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
      ...(options.headers || {})
    };
    let body = options.body;

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(data); } catch {}
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed,
          text: data
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class MockCodeProvider extends BaseProvider {
  constructor() {
    super('mock-provider');
    this.nextResponse = null;
    this.failureMode = null;
  }

  setNextResponse(res) {
    this.nextResponse = res;
  }

  setFailureMode(mode) {
    this.failureMode = mode;
  }

  clear() {
    this.nextResponse = null;
    this.failureMode = null;
  }

  isConfigured() {
    return true;
  }

  async executeCode({ language, sourceCode, stdin = '' }) {
    if (this.failureMode === '503') {
      throw new ExternalServiceError('OnlineCompiler HTTP 503: Service Unavailable', 503, 'CODE_EXECUTION_UNAVAILABLE');
    }
    if (this.failureMode === 'NETWORK_ERROR') {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
      err.code = 'ECONNREFUSED';
      throw err;
    }

    if (this.nextResponse) {
      const r = this.nextResponse;
      this.nextResponse = null;
      return r;
    }

    // Default: Simple Python Adder simulator
    if (sourceCode.includes('a + b') || sourceCode.includes('print(a + b)')) {
      const parts = stdin.trim().split(/\s+/).map(Number);
      const sum = parts.length >= 2 ? parts[0] + parts[1] : 0;
      return {
        success: true,
        status: EXECUTION_STATUS.ACCEPTED,
        stdout: String(sum) + '\n',
        stderr: '',
        compileOutput: '',
        exitCode: 0,
        executionTimeMs: 42,
        memoryUsedKb: 1024,
        providerSubmissionId: 'mock_sub_' + Math.random().toString(36).substring(7)
      };
    }

    // Fallback: Echo stdout
    return {
      success: true,
      status: EXECUTION_STATUS.ACCEPTED,
      stdout: stdin,
      stderr: '',
      compileOutput: '',
      exitCode: 0,
      executionTimeMs: 30,
      memoryUsedKb: 1024,
      providerSubmissionId: 'mock_sub_default'
    };
  }
}

async function run() {
  console.log('=== Starting Aspire Day 10: Asynchronous Code Execution Test Suite ===\n');

  // Configure mock provider for deterministic test runs
  const mockProvider = new MockCodeProvider();
  executionService.setMockProvider(mockProvider);

  // Enable queue mock mode so tests run deterministically without external Redis server
  codeExecutionQueue.setMockMode(true);

  const app = createApp();
  server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[test-server] Running on ${baseUrl}`);
      resolve();
    });
  });

  try {
    /* ----------------------------------------------------
       1. Fixtures Setup (Tenant, Exam, Question with Private Tests)
    ---------------------------------------------------- */
    console.log('--- 1. Test Fixtures Setup ---');
    const testRunId = crypto.randomBytes(4).toString('hex');

    const org = orgService.createOrganization({
      name: `Async Code Org ${testRunId}`,
      slug: `async-org-${testRunId}`
    });

    const admin = await userService.createUser({
      email: `async-admin-${testRunId}@test.com`,
      password: 'StrongPassword123!',
      name: 'Async Org Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: org.id
    });

    const loginRes = await request('POST', '/api/auth/login', {
      body: { email: admin.email, password: 'StrongPassword123!' }
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login succeeded');
    const adminToken = loginRes.data.data.token;

    // Create MCQ Question (2 marks)
    const qMcq = db.prepare(`
      INSERT INTO questions (
        organization_id, category, type, title, question_text, marks,
        options_json, correct_index, status, created_by
      ) VALUES (?, 'aptitude', 'mcq', 'Algorithm Complexity', 'What is the time complexity of binary search?', 2, ?, 1, 'PUBLISHED', ?)
      RETURNING *
    `).get(
      org.id,
      JSON.stringify(['O(1)', 'O(log n)', 'O(n)', 'O(n^2)']),
      admin.id
    );

    // Create Coding Question (5 marks) with 1 public sample test and 2 private hidden tests
    const testCases = [
      { input: '3 5', expected_output: '8', is_hidden: 0 },
      { input: '10 20', expected_output: '30', is_hidden: 1 },
      { input: '-5 15', expected_output: '10', is_hidden: 1 }
    ];

    const qCode = db.prepare(`
      INSERT INTO questions (
        organization_id, category, type, title, question_text, marks,
        language, code_starter, test_cases_json, status, created_by
      ) VALUES (?, 'coding', 'code', 'Add Two Numbers Async', 'Read two integers and print sum.', 5, 'python', '# code here', ?, 'PUBLISHED', ?)
      RETURNING *
    `).get(
      org.id,
      JSON.stringify(testCases),
      admin.id
    );

    const qCodeId = qCode.id;
    const qMcqId = qMcq.id;

    // Create and Publish Exam
    const examRes = await request('POST', '/api/admin/exams', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        code: `ASYNC-${testRunId.toUpperCase()}`,
        name: 'Day 10 Async Execution Scholarship Assessment',
        duration_minutes: 60,
        passing_score: 40
      }
    });
    assert.strictEqual(examRes.status, 201, 'Exam created');
    const exam = examRes.data.data;

    const secRes = await request('POST', `/api/admin/exams/${exam.id}/sections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Async Coding Section',
        display_order: 1,
        question_selection_mode: 'MANUAL'
      }
    });
    assert.strictEqual(secRes.status, 201, 'Section created');
    const examWithSec = secRes.data.data;
    const sec = examWithSec.sections[examWithSec.sections.length - 1];

    await request('POST', `/api/admin/exams/${exam.id}/sections/${sec.id}/questions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { question_id: qMcqId, display_order: 1 }
    });
    await request('POST', `/api/admin/exams/${exam.id}/sections/${sec.id}/questions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { question_id: qCodeId, display_order: 2 }
    });

    await request('PUT', `/api/admin/exams/${exam.id}/scholarship-slabs`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        slabs: [
          { min_score_pct: 80, max_score_pct: 100, discount_pct: 100 },
          { min_score_pct: 50, max_score_pct: 79.99, discount_pct: 50 },
          { min_score_pct: 0, max_score_pct: 49.99, discount_pct: 25 }
        ]
      }
    });

    await request('POST', `/api/admin/exams/${exam.id}/publish`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    // Register candidate and get attempt token
    const candidatePhone = '98' + Math.floor(10000000 + Math.random() * 89999999);
    const regRes = await request('POST', '/api/register', {
      body: {
        exam_code: exam.code,
        name: 'Bob Async Coder',
        email: `bob-${testRunId}@test.com`,
        phone: candidatePhone
      }
    });
    assert.strictEqual(regRes.status, 200, 'Candidate registered');
    const attemptToken = regRes.data.token;
    const attRow = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
    const attemptId = attRow.id;

    console.log('  PASS  Test fixtures initialized with published exam and candidate attempt');

    /* ----------------------------------------------------
       2. Asynchronous Submission & HTTP 202 Acknowledgment
    ---------------------------------------------------- */
    console.log('\n--- 2. HTTP 202 Async Acknowledgment ---');

    const validCode = 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)';
    const submitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: validCode
      }
    });

    assert.strictEqual(submitRes.status, 202, 'Immediate HTTP 202 response returned');
    assert.strictEqual(submitRes.data.success, true);
    assert.strictEqual(submitRes.data.status, SUBMISSION_LIFECYCLE.QUEUED, 'Lifecycle status is QUEUED');
    assert(submitRes.data.submissionId.startsWith('csub_'), 'Generates csub_ submission ID');
    assert.strictEqual(
      submitRes.data.statusUrl,
      `/api/attempt/${attemptToken}/code-submissions/${submitRes.data.submissionId}`,
      'Correct statusUrl returned for candidate polling'
    );
    assert.strictEqual(submitRes.data.retryAfterMs, 1500, 'Includes polling hint retryAfterMs');

    const submissionId = submitRes.data.submissionId;
    console.log('  PASS  POST /code-submit promptly returns HTTP 202 with QUEUED status and polling URL');

    /* ----------------------------------------------------
       3. Transactional Outbox Durability & Dual-Write Atomicity
    ---------------------------------------------------- */
    console.log('\n--- 3. Transactional Outbox Durability ---');

    // 1. Verify SQLite record in coding_submissions
    const dbSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(submissionId);
    assert(dbSub, 'Record exists in coding_submissions');
    assert.strictEqual(dbSub.attempt_id, attemptId);
    assert.strictEqual(dbSub.question_id, qCodeId);
    assert.strictEqual(dbSub.lifecycle_status, SUBMISSION_LIFECYCLE.QUEUED);
    assert.strictEqual(dbSub.submission_status, EXECUTION_STATUS.PENDING);
    assert(dbSub.source_hash, 'Source hash persisted');
    assert.strictEqual(dbSub.source_code, validCode, 'Source code persisted');

    // 2. Verify SQLite record in outbox_events
    const outboxEvent = db.prepare(`
      SELECT * FROM outbox_events WHERE aggregate_id = ?
    `).get(submissionId);
    assert(outboxEvent, 'Outbox event created in same transaction');
    assert.strictEqual(outboxEvent.event_type, 'CODE_EXECUTION_REQUESTED');
    assert(outboxEvent.payload_json.includes(submissionId), 'Payload contains submissionId');

    console.log('  PASS  Atomic dual-write into coding_submissions and outbox_events verified');

    /* ----------------------------------------------------
       4. Candidate Status Polling Endpoint (QUEUED State)
    ---------------------------------------------------- */
    console.log('\n--- 4. Polling Endpoint in QUEUED State ---');

    const pollQueuedRes = await request('GET', `/api/attempt/${attemptToken}/code-submissions/${submissionId}`);
    assert.strictEqual(pollQueuedRes.status, 200, 'Polling endpoint responds 200');
    assert.strictEqual(pollQueuedRes.data.success, true);
    assert.strictEqual(pollQueuedRes.data.submissionId, submissionId);
    assert.strictEqual(pollQueuedRes.data.status, SUBMISSION_LIFECYCLE.QUEUED);
    assert.strictEqual(pollQueuedRes.data.verdict, EXECUTION_STATUS.PENDING);
    assert.strictEqual(pollQueuedRes.data.retryAfterMs, 1500);

    console.log('  PASS  GET /code-submissions/:id reports QUEUED status with polling hint');

    /* ----------------------------------------------------
       5. Worker Processing & Lifecycle State Transitions (QUEUED -> RUNNING -> COMPLETED)
    ---------------------------------------------------- */
    console.log('\n--- 5. Worker Processing & Lifecycle State Machine ---');

    // Process job via worker processor
    const jobResult = await processCodeJob({
      submissionId,
      attemptId,
      questionId: qCodeId,
      submissionType: 'FINAL'
    });

    assert.strictEqual(jobResult.success, true);
    assert.strictEqual(jobResult.status, SUBMISSION_LIFECYCLE.COMPLETED);
    assert.strictEqual(jobResult.verdict, EXECUTION_STATUS.ACCEPTED);
    assert.strictEqual(jobResult.score, 5);
    assert.strictEqual(jobResult.testsPassed, 3);
    assert.strictEqual(jobResult.testsTotal, 3);

    // Verify SQLite updated authoritatively
    const completedSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(submissionId);
    assert.strictEqual(completedSub.lifecycle_status, SUBMISSION_LIFECYCLE.COMPLETED);
    assert.strictEqual(completedSub.submission_status, EXECUTION_STATUS.ACCEPTED);
    assert.strictEqual(completedSub.score, 5);
    assert.strictEqual(completedSub.test_cases_passed, 3);
    assert.strictEqual(completedSub.test_cases_total, 3);
    assert(completedSub.started_at, 'started_at timestamp recorded');
    assert(completedSub.completed_at, 'completed_at timestamp recorded');
    assert(completedSub.execution_time_ms > 0, 'execution_time_ms recorded');

    // Verify attempt code_answers_json updated
    const updatedAtt = db.prepare('SELECT code_answers_json FROM attempts WHERE id = ?').get(attemptId);
    const codeAns = JSON.parse(updatedAtt.code_answers_json || '{}');
    assert.strictEqual(codeAns[qCodeId], validCode, 'attempt.code_answers_json updated with submitted code');

    console.log('  PASS  Worker transitions QUEUED -> RUNNING -> COMPLETED and updates SQLite authoritatively');

    /* ----------------------------------------------------
       6. Polling Endpoint in COMPLETED State & Hidden Test Privacy
    ---------------------------------------------------- */
    console.log('\n--- 6. Polling Endpoint (COMPLETED) & Hidden Test Case Privacy ---');

    const pollCompletedRes = await request('GET', `/api/attempt/${attemptToken}/code-submissions/${submissionId}`);
    assert.strictEqual(pollCompletedRes.status, 200);
    assert.strictEqual(pollCompletedRes.data.status, SUBMISSION_LIFECYCLE.COMPLETED);
    assert.strictEqual(pollCompletedRes.data.verdict, EXECUTION_STATUS.ACCEPTED);
    assert.strictEqual(pollCompletedRes.data.score, 5);
    assert.strictEqual(pollCompletedRes.data.marks, 5);
    assert.strictEqual(pollCompletedRes.data.testsPassed, 3);
    assert.strictEqual(pollCompletedRes.data.testsTotal, 3);
    assert.strictEqual(pollCompletedRes.data.retryAfterMs, undefined, 'No retryAfterMs once completed');

    // CRITICAL SECURITY ASSERTION: Zero leakage of private test case inputs/outputs
    const pollBodyStr = JSON.stringify(pollCompletedRes.data);
    assert(!pollBodyStr.includes('10 20'), 'CRITICAL: Private test input #1 is NEVER leaked in polling response');
    assert(!pollBodyStr.includes('-5 15'), 'CRITICAL: Private test input #2 is NEVER leaked in polling response');
    assert(!pollBodyStr.includes('"expectedOutput"'), 'CRITICAL: expectedOutput field is NEVER leaked');
    assert(!pollBodyStr.includes('"actualOutput"'), 'CRITICAL: actualOutput field is NEVER leaked');
    assert(!pollBodyStr.includes('"test_cases"'), 'CRITICAL: test_cases is NEVER leaked');
    assert.strictEqual(pollCompletedRes.data.results, undefined, 'CRITICAL: results array is undefined');

    console.log('  PASS  Completed submission exposes verdict and scores with ZERO hidden test case leakage');

    /* ----------------------------------------------------
       7. Authorization & IDOR Protection on Polling Endpoint
    ---------------------------------------------------- */
    console.log('\n--- 7. Polling Authorization & IDOR Protection ---');

    // Another candidate registering
    const candidate2Phone = '97' + Math.floor(10000000 + Math.random() * 89999999);
    const reg2Res = await request('POST', '/api/register', {
      body: {
        exam_code: exam.code,
        name: 'Charlie Candidate',
        email: `charlie-${testRunId}@test.com`,
        phone: candidate2Phone
      }
    });
    const candidate2Token = reg2Res.data.token;

    // Candidate 2 trying to access Candidate 1's submission ID
    const crossPollRes = await request('GET', `/api/attempt/${candidate2Token}/code-submissions/${submissionId}`);
    assert.strictEqual(crossPollRes.status, 404, 'IDOR blocked: Cannot access submission from different attempt');

    // Invalid attempt token
    const invalidTokenRes = await request('GET', `/api/attempt/invalid_token_1234567890/code-submissions/${submissionId}`);
    assert.strictEqual(invalidTokenRes.status, 404);

    console.log('  PASS  Attempt isolation and IDOR protection enforced on status polling');

    /* ----------------------------------------------------
       8. Snapshot Integrity Verification in Async Flow
    ---------------------------------------------------- */
    console.log('\n--- 8. Snapshot HMAC Integrity Check ---');

    // Candidate 2 submits code
    const c2SubRes = await request('POST', `/api/attempt/${candidate2Token}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: 'print(42)'
      }
    });
    assert.strictEqual(c2SubRes.status, 202);
    const c2SubId = c2SubRes.data.submissionId;

    // Tamper with Candidate 2's snapshot JSON in DB
    db.prepare("UPDATE attempts SET questions_snapshot_json = '[]' WHERE token = ?").run(candidate2Token);

    // Polling tampered attempt should fail snapshot verification
    const tamperedPollRes = await request('GET', `/api/attempt/${candidate2Token}/code-submissions/${c2SubId}`);
    assert.strictEqual(tamperedPollRes.status, 409, 'Tampered snapshot HMAC rejected by polling endpoint');
    assert.strictEqual(tamperedPollRes.data.code, 'SNAPSHOT_INTEGRITY_FAILURE');

    console.log('  PASS  Snapshot HMAC tampering intercepted and rejected');

    /* ----------------------------------------------------
       9. Error-Aware Retries vs Deterministic Execution Failures
    ---------------------------------------------------- */
    console.log('\n--- 9. Error-Aware Retries vs Deterministic Failures ---');

    // A. Wrong Answer: Deterministic failure -> COMPLETED (NO retry)
    mockProvider.setNextResponse({
      success: true,
      status: EXECUTION_STATUS.WRONG_ANSWER,
      stdout: '999\n',
      stderr: '',
      compileOutput: '',
      exitCode: 0,
      executionTimeMs: 25,
      memoryUsedKb: 1024,
      providerSubmissionId: 'mock_wa'
    });

    const waSubRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: 'print(999)' // wrong answer
      }
    });
    assert.strictEqual(waSubRes.status, 202);
    const waSubId = waSubRes.data.submissionId;

    await processCodeJob({
      submissionId: waSubId,
      attemptId,
      questionId: qCodeId,
      submissionType: 'FINAL'
    });

    const waDbSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(waSubId);
    assert.strictEqual(waDbSub.lifecycle_status, SUBMISSION_LIFECYCLE.COMPLETED, 'Lifecycle is COMPLETED (not retrying)');
    assert.strictEqual(waDbSub.submission_status, EXECUTION_STATUS.WRONG_ANSWER, 'Verdict is WRONG_ANSWER');
    assert.strictEqual(waDbSub.score, 0, 'Score is 0 for wrong answer');

    // B. Transient Provider Outage (503): Retryable error -> RETRYING status + throws for BullMQ
    mockProvider.setFailureMode('503');

    const outageSubRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: 'print(100 + 200)'
      }
    });
    assert.strictEqual(outageSubRes.status, 202);
    const outageSubId = outageSubRes.data.submissionId;

    let threwExpected = false;
    try {
      await processCodeJob({
        submissionId: outageSubId,
        attemptId,
        questionId: qCodeId,
        submissionType: 'FINAL'
      });
    } catch (err) {
      threwExpected = true;
      assert(err.message.includes('503') || err instanceof ExternalServiceError);
    }
    assert(threwExpected, 'Worker threw retryable error to trigger BullMQ backoff');

    const outageDbSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(outageSubId);
    assert.strictEqual(outageDbSub.lifecycle_status, SUBMISSION_LIFECYCLE.RETRYING, 'Status marked RETRYING in SQLite');
    assert.strictEqual(outageDbSub.last_error_code, 'PROVIDER_UNAVAILABLE');

    mockProvider.clear();
    console.log('  PASS  Deterministic verdicts (WRONG_ANSWER) complete without retry; transient 503s flag RETRYING and throw');

    /* ----------------------------------------------------
       10. Redis Outage Resilience & Outbox Retention
    ---------------------------------------------------- */
    console.log('\n--- 10. Redis Outage Resilience & Outbox Retention ---');

    // Simulate queue error during dispatch
    codeExecutionQueue.setMockMode(false); // disable mock to test redis connection failure handling

    const offlineSubRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b) # offline test'
      }
    });

    assert.strictEqual(offlineSubRes.status, 202, 'HTTP 202 returned even if Redis is unreachable');
    const offlineSubId = offlineSubRes.data.submissionId;

    // Verify submission is safely in SQLite coding_submissions
    const offlineDbSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(offlineSubId);
    assert(offlineDbSub, 'Submission preserved in SQLite');
    assert.strictEqual(offlineDbSub.lifecycle_status, SUBMISSION_LIFECYCLE.QUEUED);

    // Verify outbox event is preserved with status PENDING
    const offlineOutbox = db.prepare('SELECT * FROM outbox_events WHERE aggregate_id = ?').get(offlineSubId);
    assert(offlineOutbox, 'Outbox event preserved in SQLite');
    assert.strictEqual(offlineOutbox.status, OUTBOX_STATUS.PENDING);

    // Restore mock mode
    codeExecutionQueue.setMockMode(true);

    // Test recovery / drain: outbox dispatcher drains pending submissions
    await outboxDispatcher.drainAttemptSubmissions(attemptId, 5000);

    const recoveredDbSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(offlineSubId);
    assert.strictEqual(recoveredDbSub.lifecycle_status, SUBMISSION_LIFECYCLE.COMPLETED, 'Recovered from outbox and completed');
    assert.strictEqual(recoveredDbSub.submission_status, EXECUTION_STATUS.ACCEPTED);

    console.log('  PASS  Submissions safely retained in SQLite outbox during Redis outage and processed on recovery');

    /* ----------------------------------------------------
       11. 15-Second Idempotency Protection
    ---------------------------------------------------- */
    console.log('\n--- 11. 15-Second Idempotency Protection ---');

    const duplicateCode = 'import sys\nprint("idempotent test")';
    const sub1 = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: duplicateCode
      }
    });
    assert.strictEqual(sub1.status, 202);

    const sub2 = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: duplicateCode
      }
    });
    assert.strictEqual(sub2.status, 202);
    assert.strictEqual(sub2.data.submissionId, sub1.data.submissionId, 'Duplicate request returned identical submission ID');
    assert.strictEqual(sub2.data.idempotent, true, 'Flagged as idempotent response');

    console.log('  PASS  15-second duplicate submission window cleanly returns existing job');

    /* ----------------------------------------------------
       12. Final Exam Submit Coordination & Authoritative Scoring
    ---------------------------------------------------- */
    console.log('\n--- 12. Final Exam Submit Coordination & Scoring ---');

    // Register a fresh candidate for full end-to-end exam submission
    const finalCandidatePhone = '99' + Math.floor(10000000 + Math.random() * 89999999);
    const finalRegRes = await request('POST', '/api/register', {
      body: {
        exam_code: exam.code,
        name: 'Dana Final Coder',
        email: `dana-${testRunId}@test.com`,
        phone: finalCandidatePhone
      }
    });
    const finalToken = finalRegRes.data.token;

    // Get candidate's attempt to look up deterministically shuffled MCQ option index
    const danaAttemptRes = await request('GET', `/api/attempt/${finalToken}`);
    const danaMcq = danaAttemptRes.data.questions.find(q => q.type === 'mcq');
    const correctOptionIdx = danaMcq ? danaMcq.options.indexOf('O(log n)') : 1;

    // Dana submits correct code for coding question (asynchronous 202)
    const danaCodeRes = await request('POST', `/api/attempt/${finalToken}/code-submit`, {
      body: {
        questionId: qCodeId,
        language: 'python',
        sourceCode: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)'
      }
    });
    assert.strictEqual(danaCodeRes.status, 202);

    // Dana immediately clicks "Submit Exam" while coding job is in-flight!
    // The submit endpoint coordinates with outboxDispatcher.drainAttemptSubmissions()
    const examSubmitRes = await request('POST', `/api/attempt/${finalToken}/submit`, {
      body: {
        answers: { [qMcqId]: correctOptionIdx }, // Correct MCQ answer (Option = O(log n)) -> 2 marks
        tabSwitches: 0
      }
    });

    assert.strictEqual(examSubmitRes.status, 200, 'Final exam submitted successfully');
    assert.strictEqual(examSubmitRes.data.status, 'submitted');

    // Verify combined score: MCQ (2 marks) + Code (5 marks) = 7/7 (100%)
    assert.strictEqual(examSubmitRes.data.score, 7, 'Combined score is 7');
    assert.strictEqual(examSubmitRes.data.total_marks, 7, 'Total marks is 7');
    assert.strictEqual(examSubmitRes.data.percentage, 100, 'Scored 100%');
    assert.strictEqual(examSubmitRes.data.scholarship_pct, 100, 'Awarded 100% scholarship slab');
    assert(examSubmitRes.data.certificate_id.startsWith('ASP26-'), 'Certificate issued');

    // Verify detailed breakdown
    const codeDetail = examSubmitRes.data.detail.find(d => d.type === 'code');
    assert(codeDetail, 'Code detail present in graded results');
    assert.strictEqual(codeDetail.earned, 5, 'Earned 5/5 on coding question');
    assert.strictEqual(codeDetail.passed, 3, 'Passed 3/3 test cases');

    console.log('  PASS  Final exam submit coordinates with pending coding jobs and awards authoritative score');

    /* ----------------------------------------------------
       13. Admin Observability & Queue Metrics
    ---------------------------------------------------- */
    console.log('\n--- 13. Admin Observability (Queue Metrics & Submissions) ---');

    const metricsRes = await request('GET', '/api/admin/code-execution/queue-metrics', {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(metricsRes.status, 200, 'Queue metrics endpoint responded');
    assert.strictEqual(metricsRes.data.success, true);
    assert(metricsRes.data.data.queue, 'Queue metrics included');
    assert(metricsRes.data.data.outbox, 'Outbox metrics included');
    assert(metricsRes.data.data.lifecycle, 'Lifecycle breakdown included');
    assert(metricsRes.data.data.lifecycle.COMPLETED > 0, 'Reports completed submissions');

    // Inspect attempt coding submissions
    const finalAttRow = db.prepare('SELECT id FROM attempts WHERE token = ?').get(finalToken);
    const adminSubsRes = await request('GET', `/api/admin/attempts/${finalAttRow.id}/coding-submissions`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(adminSubsRes.status, 200);
    assert.strictEqual(adminSubsRes.data.success, true);
    assert(adminSubsRes.data.data.length > 0);
    const subRecord = adminSubsRes.data.data[0];
    assert.strictEqual(subRecord.lifecycle_status, SUBMISSION_LIFECYCLE.COMPLETED);
    assert.strictEqual(subRecord.submission_status, EXECUTION_STATUS.ACCEPTED);
    assert(subRecord.job_id, 'job_id exposed to admin');
    assert(subRecord.queued_at, 'queued_at exposed to admin');

    console.log('  PASS  Admin observability metrics and candidate submission inspection verified');

    /* ----------------------------------------------------
       14. Worker Graceful Shutdown
    ---------------------------------------------------- */
    console.log('\n--- 14. Worker Graceful Shutdown ---');

    await shutdownWorker('SIGTERM');
    console.log('  PASS  Worker responds to shutdown signal and closes cleanly');

    console.log('\n=== Aspire Day 10: Asynchronous Code Execution Test Suite PASSED (All assertions green) ===');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

run().catch((err) => {
  console.error('\n❌ Day 10 Test Suite Failed:', err);
  process.exit(1);
});
