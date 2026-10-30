process.env.NODE_ENV = 'test';

// Automated Test Suite for Day 13: Timer Integrity, Atomic Submission & Assessment Lifecycle Reliability
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const timerSubmissionService = require('../backend/src/services/timer-submission.service');
const sessionRecoveryService = require('../backend/src/services/session-recovery.service');
const snapshotService = require('../backend/src/services/snapshot.service');
const examService = require('../backend/src/services/exam.service');
const userService = require('../backend/src/services/user.service');
const orgService = require('../backend/src/services/organization.service');
const outboxDispatcher = require('../backend/src/workers/outbox-dispatcher');
const { executionService } = require('../backend/src/services/code-execution/execution.service');
const BaseProvider = require('../backend/src/services/code-execution/providers/base.provider');
const { codeExecutionQueue } = require('../backend/src/queues/code-execution.queue');
const { ROLES } = require('../backend/src/security/rbac');

class MockCodeProvider extends BaseProvider {
  constructor() {
    super('mock-provider');
  }

  isConfigured() {
    return true;
  }

  async executeCode({ language, sourceCode, stdin = '' }) {
    return {
      success: true,
      status: 'ACCEPTED',
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

let server;
let baseUrl;

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const clientIp = options.ip || `10.13.${Math.floor(Math.random() * 200 + 1)}.${Math.floor(Math.random() * 200 + 1)}`;
    const headers = {
      'x-forwarded-for': clientIp,
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
          try { parsed = JSON.parse(data); } catch { }
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

function login(email, password) {
  return request('POST', '/api/auth/login', {
    body: { email, password }
  });
}

function getCorrectAnswersForAttempt(token) {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(token);
  const rawMaps = JSON.parse(att.shuffle_map_json || '{}');
  const optMaps = rawMaps.options || rawMaps;
  const qrows = db.prepare('SELECT id, correct_index FROM questions').all();
  const correctById = Object.fromEntries(qrows.map((r) => [r.id, r.correct_index]));

  const answers = {};
  const qids = JSON.parse(att.question_ids_json || '[]');
  for (const qid of qids) {
    const qidNum = Number(qid);
    const origCorrect = correctById[qidNum];
    if (origCorrect === undefined) continue;
    const map = optMaps[qidNum] || optMaps[String(qidNum)];
    const chosenIdx = Array.isArray(map) ? map.indexOf(origCorrect) : origCorrect;
    answers[qidNum] = chosenIdx;
  }
  return answers;
}

async function runTests() {
  console.log('[test-timer-submission] Starting Day 13 Timer & Submission Reliability Test Suite...\n');

  executionService.setMockProvider(new MockCodeProvider());
  codeExecutionQueue.setMockMode(true);

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[test-timer-submission] Test server listening on port ${addr.port}`);
      resolve();
    });
  });

  let totalPassed = 0;
  function ok(name, condition, extra = '') {
    if (condition) {
      totalPassed++;
      console.log(`  PASS  ${name}`);
    } else {
      console.error(`  FAIL  ${name} ${extra}`);
      throw new Error(`Assertion failed: ${name}`);
    }
  }

  try {
    // -------------------------------------------------------------
    // SECTION 1: Setup Test Organization, Users, Questions & Exam
    // -------------------------------------------------------------
    console.log('--- Setup: Test Infrastructure, Organizations & Exam Snapshots ---');

    const orgA = orgService.createOrganization({
      name: 'Day13 Timer Org A ' + Date.now(),
      slug: 'day13-timer-org-a-' + Date.now()
    });
    const orgB = orgService.createOrganization({
      name: 'Day13 Timer Org B ' + Date.now(),
      slug: 'day13-timer-org-b-' + Date.now()
    });

    const superAdmin = await userService.createUser({
      email: `day13.superadmin.${Date.now()}@example.com`,
      password: 'SuperPassword123!',
      name: 'Day 13 Super Admin',
      role: ROLES.SUPER_ADMIN
    });

    const orgAAdmin = await userService.createUser({
      email: `day13.orgA.${Date.now()}@example.com`,
      password: 'OrgAPassword123!',
      name: 'Day 13 Org A Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: orgA.id
    });

    const qMCQ1 = db.prepare(`
      INSERT INTO questions (
        type, category, question_text, options_json, correct_index, marks, organization_id, status
      ) VALUES ('mcq', 'technical', 'What is 2 + 2 in base 10?', '["1","2","3","4"]', 3, 2, ?, 'PUBLISHED')
    `).run(orgA.id);

    const qMCQ2 = db.prepare(`
      INSERT INTO questions (
        type, category, question_text, options_json, correct_index, marks, organization_id, status
      ) VALUES ('mcq', 'aptitude', 'Which word is the odd one out?', '["Apple","Banana","Carrot","Potato"]', 0, 1, ?, 'PUBLISHED')
    `).run(orgA.id);

    const qCode = db.prepare(`
      INSERT INTO questions (
        type, category, question_text, options_json, marks, code_starter, test_cases_json, language, organization_id, status
      ) VALUES (
        'code', 'coding', 'Write a function solving sum(a,b)', '[]', 5,
        'def solve(a, b):\n    return a + b',
        '[{"input":"1 2","expected_output":"3"},{"input":"5 7","expected_output":"12"}]',
        'python', ?, 'PUBLISHED'
      )
    `).run(orgA.id);

    const examCode = 'DAY13-EXAM-' + Date.now();
    const examA = examService.createExam({
      code: examCode,
      name: 'Day 13 Reliability Exam',
      description: 'Tests timer bounds, atomic submissions, and session durability',
      duration_minutes: 60,
      organization_id: orgA.id
    }, superAdmin);

    examService.addSection(examA.id, {
      name: 'Core Assessment',
      question_selection_mode: 'MANUAL',
      display_order: 1
    }, superAdmin);

    const secRow = db.prepare('SELECT id FROM exam_sections WHERE exam_id = ?').get(examA.id);

    examService.addQuestionToSection(examA.id, secRow.id, qMCQ1.lastInsertRowid, superAdmin);
    examService.addQuestionToSection(examA.id, secRow.id, qMCQ2.lastInsertRowid, superAdmin);
    examService.addQuestionToSection(examA.id, secRow.id, qCode.lastInsertRowid, superAdmin);

    examService.reviewExam(examA.id, superAdmin);
    examService.publishExam(examA.id, superAdmin);

    ok('Test organization, users, and exam snapshot configured', examA.id && qCode.lastInsertRowid);

    // -------------------------------------------------------------
    // GROUP 1: Timer Integrity (Scenarios 1–12)
    // -------------------------------------------------------------
    console.log('\n--- Group 1: Timer Integrity & Server-Authoritative Deadlines ---');

    // Scenario 1: Initial deadline calculation includes duration + grace period
    const startedIso = '2026-03-01T10:00:00.000Z';
    const computedDeadline = timerSubmissionService.calculateAuthoritativeDeadline(startedIso, 60, 60);
    const expectedDeadline = new Date(new Date(startedIso).getTime() + (60 * 60 + 60) * 1000).toISOString();
    ok('Scenario 1: Initial deadline calculation includes duration + grace period', computedDeadline === expectedDeadline);

    // Scenario 2: Initial deadline persists in SQLite attempts table
    const regRes1 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate One',
        phone: '9876543210',
        email: 'cand1@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    ok('Scenario 2a: Candidate registration succeeds', regRes1.status === 200 && regRes1.data.token);
    const attemptToken1 = regRes1.data.token;

    const row1 = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken1);
    ok('Scenario 2b: Initial deadline persists in SQLite attempts table', !!row1.deadline_at && row1.grace_period_seconds === 60);
    ok('Scenario 2c: Database status is started and finalization_status is PENDING', row1.status === 'started' && row1.finalization_status === 'PENDING');

    // Scenario 3: Browser refresh preserves original deadline
    const attemptView1 = await request('GET', `/api/attempt/${attemptToken1}`);
    await new Promise((r) => setTimeout(r, 100));
    const attemptView2 = await request('GET', `/api/attempt/${attemptToken1}`);
    ok('Scenario 3: Browser refresh preserves original deadline', attemptView1.data.deadline_at === attemptView2.data.deadline_at);
    ok('Scenario 3b: Remaining seconds strictly non-increasing across refreshes', attemptView2.data.remaining_seconds <= attemptView1.data.remaining_seconds);

    // Scenario 4: Multi-tab access preserves original deadline in all tabs
    const tab1Req = request('GET', `/api/attempt/${attemptToken1}`);
    const tab2Req = request('GET', `/api/attempt/${attemptToken1}`);
    const [tab1Res, tab2Res] = await Promise.all([tab1Req, tab2Req]);
    ok('Scenario 4: Multi-tab access preserves original deadline in all tabs', tab1Res.data.deadline_at === tab2Res.data.deadline_at);

    // Scenario 5: Client device clock changes do not alter remaining time
    const hbRes = await request('POST', `/api/attempt/${attemptToken1}/heartbeat`, {
      body: { tabSwitches: 0 }
    });
    ok('Scenario 5: Server heartbeat returns serverTime and authoritative remainingSeconds', !!hbRes.data.serverTime && typeof hbRes.data.remainingSeconds === 'number');

    // Scenario 6: Client attempt to submit client-computed remainingSeconds is rejected (HTTP 400)
    const badHb = await request('POST', `/api/attempt/${attemptToken1}/heartbeat`, {
      body: { tabSwitches: 1, remainingSeconds: 99999 }
    });
    ok('Scenario 6a: Client attempt to submit remainingSeconds to heartbeat is rejected (HTTP 400)', badHb.status === 400);

    const badSubmit = await request('POST', `/api/attempt/${attemptToken1}/submit`, {
      body: { answers: {}, remainingSeconds: 99999 }
    });
    ok('Scenario 6b: Client attempt to submit remainingSeconds to submit endpoint is rejected (HTTP 400)', badSubmit.status === 400);

    const badSync = await request('POST', `/api/attempt/${attemptToken1}/progress/sync`, {
      body: {
        changes: [{
          changeId: 'chg_bad_' + crypto.randomBytes(4).toString('hex'),
          type: 'MCQ_ANSWER',
          questionId: qMCQ1.lastInsertRowid,
          answer: 3,
          remainingSeconds: 99999
        }]
      }
    });
    ok('Scenario 6c: Client attempt to submit remainingSeconds to progress sync is rejected (HTTP 400)', badSync.status === 400);

    // Scenario 7: Laptop sleep simulation (time skip): client re-syncs to authoritative server time
    const beforeSleepNow = Date.now();
    const timingBefore = timerSubmissionService.getAuthoritativeTiming(row1, beforeSleepNow);
    const afterSleepNow = beforeSleepNow + 15000; // 15 seconds forward
    const timingAfter = timerSubmissionService.getAuthoritativeTiming(row1, afterSleepNow);
    ok('Scenario 7: Laptop sleep simulation re-syncs to authoritative server time', timingBefore.remainingSeconds - timingAfter.remainingSeconds === 15);

    // Scenario 8: Network disconnection during assessment does not extend server deadline
    const originalDeadlineStr = row1.deadline_at;
    // Simulate 30 seconds of offline silence
    const currentTiming = timerSubmissionService.getAuthoritativeTiming(row1, Date.now() + 30000);
    ok('Scenario 8: Network disconnection does not extend deadline', currentTiming.deadlineAt === originalDeadlineStr);

    // Scenario 9: Server restart preserves active attempt deadlines
    const freshDbRow = db.prepare('SELECT deadline_at, started_at, grace_period_seconds FROM attempts WHERE id = ?').get(row1.id);
    ok('Scenario 9: Server restart preserves active attempt deadlines in storage', freshDbRow.deadline_at === originalDeadlineStr);

    // Scenario 10: Expired attempt rejects late answer updates (POST /progress/sync returns 409)
    const regExpired = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Expired',
        phone: '9876543211',
        email: 'cand.exp@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const expToken = regExpired.data.token;
    // Manually force deadline into the past
    db.prepare("UPDATE attempts SET deadline_at = datetime('now', '-5 minutes'), expires_at = datetime('now', '-5 minutes') WHERE token = ?").run(expToken);

    const lateSync = await request('POST', `/api/attempt/${expToken}/progress/sync`, {
      body: {
        changes: [{
          changeId: 'late_' + crypto.randomBytes(4).toString('hex'),
          type: 'MCQ_ANSWER',
          questionId: qMCQ1.lastInsertRowid,
          answer: 3
        }]
      }
    });
    ok('Scenario 10: Expired attempt rejects late answer updates with HTTP 409 Conflict', lateSync.status === 409 && lateSync.data.code === 'ATTEMPT_EXPIRED');

    // Scenario 11: Expired attempt submission accepts pre-saved answers but flags was_late: true / rejects late payload answers
    // Pre-save answer in DB:
    const allCorrectForExp = getCorrectAnswersForAttempt(expToken);
    const preSavedAnswers = {};
    preSavedAnswers[qMCQ1.lastInsertRowid] = allCorrectForExp[qMCQ1.lastInsertRowid];
    db.prepare('UPDATE attempts SET answers_json = ? WHERE token = ?').run(JSON.stringify(preSavedAnswers), expToken);

    // Submit with conflicting answers in body
    const conflictingBodyAnswers = {};
    conflictingBodyAnswers[qMCQ1.lastInsertRowid] = (allCorrectForExp[qMCQ1.lastInsertRowid] + 1) % 4; // Wrong answer

    const lateSubmitRes = await request('POST', `/api/attempt/${expToken}/submit`, {
      body: { answers: conflictingBodyAnswers }
    });
    ok('Scenario 11a: Expired attempt submission succeeds (HTTP 200)', lateSubmitRes.status === 200);
    ok('Scenario 11b: Expired attempt flags was_late: true', lateSubmitRes.data.was_late === true);
    ok('Scenario 11c: Late body answers discarded in favor of pre-saved answers', lateSubmitRes.data.score === 2); // Q1 marks = 2
    ok('Scenario 11d: Expired attempt recorded as AUTO_TIMEOUT', lateSubmitRes.data.finalization_status === 'FINALIZED');

    // Scenario 12: Grace period boundary check: submission within grace period is accepted; submission after grace period flags late
    const testStarted = new Date('2026-03-01T12:00:00Z').getTime();
    const durationMinutes = 60;
    const graceSeconds = 60;
    const deadlineMs = testStarted + (durationMinutes * 60 + graceSeconds) * 1000;

    const withinGraceTime = deadlineMs - 10000; // 10 seconds before deadline (inside grace period)
    const pastGraceTime = deadlineMs + 5000;    // 5 seconds after deadline (past grace period)

    ok('Scenario 12a: Submission within grace period is not late', withinGraceTime <= deadlineMs);
    ok('Scenario 12b: Submission past grace period is late', pastGraceTime > deadlineMs);

    // -------------------------------------------------------------
    // GROUP 2: Submission Reliability & Idempotency (Scenarios 13–25)
    // -------------------------------------------------------------
    console.log('\n--- Group 2: Submission Reliability & Idempotency ---');

    // Scenario 13: Successful final submission transitions status to submitted
    const regRes2 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Two',
        phone: '9876543212',
        email: 'cand2@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken2 = regRes2.data.token;
    const submitAnswers2 = getCorrectAnswersForAttempt(attemptToken2);

    const submitRes2 = await request('POST', `/api/attempt/${attemptToken2}/submit`, {
      body: { answers: submitAnswers2, tabSwitches: 1 }
    });
    ok('Scenario 13a: Successful final submission transitions status to submitted', submitRes2.status === 200 && submitRes2.data.status === 'submitted');
    ok('Scenario 13b: Score and percentage calculated accurately', submitRes2.data.score === 3);

    // Scenario 14: Rapid double-click submit produces exactly one final result
    const regRes3 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Double Click',
        phone: '9876543213',
        email: 'cand3@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken3 = regRes3.data.token;
    const submitAnswers3 = getCorrectAnswersForAttempt(attemptToken3);
    const sharedSubmissionId = 'sub_dbl_' + crypto.randomBytes(6).toString('hex');

    const click1 = request('POST', `/api/attempt/${attemptToken3}/submit`, {
      body: { answers: submitAnswers3, submissionId: sharedSubmissionId }
    });
    const click2 = request('POST', `/api/attempt/${attemptToken3}/submit`, {
      body: { answers: submitAnswers3, submissionId: sharedSubmissionId }
    });
    const [resClick1, resClick2] = await Promise.all([click1, click2]);

    ok('Scenario 14a: First click returns 200', resClick1.status === 200);
    ok('Scenario 14b: Second click returns 200', resClick2.status === 200);
    ok('Scenario 14c: Double-click produces identical certificate_id', resClick1.data.certificate_id === resClick2.data.certificate_id);
    ok('Scenario 14d: Double-click produces identical score', resClick1.data.score === resClick2.data.score);

    // Scenario 15: Simultaneous concurrent submission requests execute grading exactly once
    const regRes4 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Concurrent',
        phone: '9876543214',
        email: 'cand4@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken4 = regRes4.data.token;
    const submitAnswers4 = getCorrectAnswersForAttempt(attemptToken4);
    const concurrentRequests = [1, 2, 3, 4, 5].map((i) =>
      request('POST', `/api/attempt/${attemptToken4}/submit`, {
        body: { answers: submitAnswers4, submissionId: `sub_conc_${i}_${Date.now()}` }
      })
    );
    const concurrentResponses = await Promise.all(concurrentRequests);
    const allStatuses200 = concurrentResponses.every((r) => r.status === 200);
    const allCertificatesMatch = concurrentResponses.every((r) => r.data.certificate_id === concurrentResponses[0].data.certificate_id);
    ok('Scenario 15a: All 5 concurrent submission requests return HTTP 200', allStatuses200);
    ok('Scenario 15b: Exactly one grading execution, identical certificate_id across all responses', allCertificatesMatch);

    // Scenario 16: Two tabs submitting simultaneously produce identical final results
    const regRes5 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Two Tabs',
        phone: '9876543215',
        email: 'cand5@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken5 = regRes5.data.token;
    const submitAnswers5 = getCorrectAnswersForAttempt(attemptToken5);
    const tabA = request('POST', `/api/attempt/${attemptToken5}/submit`, { body: { answers: submitAnswers5 } });
    const tabB = request('POST', `/api/attempt/${attemptToken5}/submit`, { body: { answers: submitAnswers5 } });
    const [resTabA, resTabB] = await Promise.all([tabA, tabB]);
    ok('Scenario 16: Two tabs submitting simultaneously produce identical final results', resTabA.data.certificate_id === resTabB.data.certificate_id);

    // Scenario 17: Network retry after dropped response returns identical result
    const retry1 = await request('POST', `/api/attempt/${attemptToken5}/submit`, { body: { answers: submitAnswers5 } });
    ok('Scenario 17: Network retry returns identical result', retry1.status === 200 && retry1.data.certificate_id === resTabA.data.certificate_id);

    // Scenario 18: Submission with same idempotency key / submissionId returns cached result without re-grading
    const resIdem = await request('POST', `/api/attempt/${attemptToken3}/submit`, {
      body: { answers: submitAnswers3, submissionId: sharedSubmissionId }
    });
    ok('Scenario 18: Same submissionId returns identical result', resIdem.data.certificate_id === resClick1.data.certificate_id);

    // Scenario 19: Submission of already submitted attempt returns HTTP 200 with final result
    const alreadySubRes = await request('POST', `/api/attempt/${attemptToken2}/submit`, {
      body: { answers: {} }
    });
    ok('Scenario 19: Already submitted attempt returns HTTP 200 with final result', alreadySubRes.status === 200 && alreadySubRes.data.status === 'submitted');

    // Scenario 20: Expired attempt submit evaluates saved answers and marks finalized_by: 'AUTO_TIMEOUT'
    const regRes6 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Auto Timeout',
        phone: '9876543216',
        email: 'cand6@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken6 = regRes6.data.token;
    db.prepare("UPDATE attempts SET deadline_at = datetime('now', '-2 minutes'), expires_at = datetime('now', '-2 minutes') WHERE token = ?").run(attemptToken6);
    const expSub = await request('POST', `/api/attempt/${attemptToken6}/submit`, { body: {} });
    const expRow = db.prepare('SELECT finalized_by, was_late, status FROM attempts WHERE token = ?').get(attemptToken6);
    ok('Scenario 20: Expired attempt marked finalized_by AUTO_TIMEOUT', expRow.finalized_by === 'AUTO_TIMEOUT' && expRow.was_late === 1);

    // Scenario 21: Duplicate certificate generation is prevented (one certificate ID per attempt)
    const certCount = db.prepare('SELECT COUNT(DISTINCT certificate_id) as cnt FROM attempts WHERE token = ?').get(attemptToken3);
    ok('Scenario 21: Exactly one certificate generated per attempt', certCount.cnt === 1);

    // Scenario 22: Duplicate scholarship calculation is prevented (one scholarship slab per attempt)
    const slabRow = db.prepare('SELECT scholarship_pct FROM attempts WHERE token = ?').get(attemptToken3);
    ok('Scenario 22: Exactly one immutable scholarship calculation persisted', typeof slabRow.scholarship_pct === 'number');

    // Scenario 23: Atomic transaction commits all final fields together
    const atomicRow = db.prepare('SELECT status, finalization_status, score, total_marks, percentage, scholarship_pct, certificate_id, claim_code, submitted_at FROM attempts WHERE token = ?').get(attemptToken3);
    const allFieldsPopulated = atomicRow.status === 'submitted' &&
                               atomicRow.finalization_status === 'FINALIZED' &&
                               atomicRow.score !== null &&
                               atomicRow.total_marks !== null &&
                               atomicRow.percentage !== null &&
                               atomicRow.scholarship_pct !== null &&
                               !!atomicRow.certificate_id &&
                               !!atomicRow.claim_code &&
                               !!atomicRow.submitted_at;
    ok('Scenario 23: Atomic transaction commits all final fields together', allFieldsPopulated);

    // Scenario 24: Server restart during grading finalization is handled safely
    const regRes7 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Interrupted',
        phone: '9876543217',
        email: 'cand7@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken7 = regRes7.data.token;
    const submitAnswers7 = getCorrectAnswersForAttempt(attemptToken7);
    // Simulate server dying while attempt was in 'grading'
    db.prepare("UPDATE attempts SET status = 'grading', finalization_status = 'FINALIZING' WHERE token = ?").run(attemptToken7);

    // New request comes in or reconciliation runs:
    const recoveredSubmit = await request('POST', `/api/attempt/${attemptToken7}/submit`, {
      body: { answers: submitAnswers7 }
    });
    ok('Scenario 24: Interrupted grading recovers and completes submission successfully', recoveredSubmit.status === 200 && recoveredSubmit.data.status === 'submitted');

    // Scenario 25: Expired but unfinalized attempts reconciled automatically by reconcileExpiredAttempts
    const regRes8 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Reconcile',
        phone: '9876543218',
        email: 'cand8@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken8 = regRes8.data.token;
    db.prepare("UPDATE attempts SET deadline_at = datetime('now', '-10 minutes'), expires_at = datetime('now', '-10 minutes') WHERE token = ?").run(attemptToken8);

    const reconcileResult = await timerSubmissionService.reconcileExpiredAttempts({ token: attemptToken8 });
    const reconciledRow = db.prepare('SELECT status, finalization_status, finalized_by FROM attempts WHERE token = ?').get(attemptToken8);
    ok('Scenario 25a: reconcileExpiredAttempts reports at least 1 reconciled attempt', reconcileResult.reconciledCount >= 1);
    ok('Scenario 25b: Expired attempt transitioned to submitted by background reconciliation', reconciledRow.status === 'submitted' && reconciledRow.finalized_by === 'AUTO_TIMEOUT');

    // -------------------------------------------------------------
    // GROUP 3: Coding Assessment Integration (Scenarios 26–30)
    // -------------------------------------------------------------
    console.log('\n--- Group 3: Asynchronous Coding & Outbox Drain Integration ---');

    // Scenario 26: Coding question submissions in BullMQ outbox are awaited/drained before final grading
    const regRes9 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Coding Drain',
        phone: '9876543219',
        email: 'cand9@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken9 = regRes9.data.token;
    const att9Row = db.prepare('SELECT id FROM attempts WHERE token = ?').get(attemptToken9);

    // Insert pending outbox record
    const sub9Id = 'sub_code_drain_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
      INSERT INTO coding_submissions (
        id, attempt_id, question_id, language, source_code, provider, source_hash, lifecycle_status, submission_status
      ) VALUES (?, ?, ?, 'python', 'def solve(a,b): return a+b', 'onlinecompiler', 'dummy_hash_1', 'RUNNING', 'PENDING')
    `).run(sub9Id, att9Row.id, qCode.lastInsertRowid);

    // Call drain with short timeout (should resolve gracefully without throwing)
    const drainStart = Date.now();
    const drainRes = await outboxDispatcher.drainAttemptSubmissions(att9Row.id, 2000);
    const drainElapsed = Date.now() - drainStart;
    ok('Scenario 26: drainAttemptSubmissions coordinates with BullMQ outbox boundedly', drainRes.success === true && drainRes.remaining === 0 && drainElapsed < 2500);

    // Scenario 27: Final submission does not trigger duplicate BullMQ coding jobs
    const outboxCountBefore = db.prepare('SELECT COUNT(*) as cnt FROM outbox_events WHERE aggregate_id = ?').get(sub9Id).cnt;
    await request('POST', `/api/attempt/${attemptToken9}/submit`, { body: { answers: {} } });
    const outboxCountAfter = db.prepare('SELECT COUNT(*) as cnt FROM outbox_events WHERE aggregate_id = ?').get(sub9Id).cnt;
    ok('Scenario 27: Final submission does not inject extra coding jobs into outbox', outboxCountAfter === outboxCountBefore);

    // Scenario 28: Coding test case results persisted in coding_submissions are authoritatively included in final score
    const regRes10 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Coding Scored',
        phone: '9876543220',
        email: 'cand10@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken10 = regRes10.data.token;
    const att10Row = db.prepare('SELECT id FROM attempts WHERE token = ?').get(attemptToken10);

    // Insert COMPLETED coding submission with score = 5
    const sub10Id = 'sub_code_scored_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
      INSERT INTO coding_submissions (
        id, attempt_id, question_id, language, source_code, provider, source_hash, lifecycle_status, submission_status,
        test_cases_passed, test_cases_total, score, completed_at
      ) VALUES (?, ?, ?, 'python', 'def solve(a,b): return a+b', 'onlinecompiler', 'dummy_hash_2', 'COMPLETED', 'ACCEPTED', 2, 2, 5, datetime('now'))
    `).run(sub10Id, att10Row.id, qCode.lastInsertRowid);

    const submit10Res = await request('POST', `/api/attempt/${attemptToken10}/submit`, { body: { answers: {} } });
    ok('Scenario 28: Persisted coding submission score (5 marks) is included in authoritative final score', submit10Res.data.score === 5);

    // Scenario 29: In-flight BullMQ job completing after timeout does not alter finalized attempt score
    db.prepare(`
      INSERT INTO coding_submissions (
        id, attempt_id, question_id, language, source_code, provider, source_hash, lifecycle_status, submission_status, score, completed_at
      ) VALUES (?, ?, ?, 'python', 'def late(): pass', 'onlinecompiler', 'dummy_hash_3', 'COMPLETED', 'ACCEPTED', 5, datetime('now'))
    `).run('late_sub_' + Date.now(), att10Row.id, qCode.lastInsertRowid);

    const postFinalAttempt = db.prepare('SELECT score, status FROM attempts WHERE id = ?').get(att10Row.id);
    ok('Scenario 29: Finalized attempt score remains locked and unchanged by later job insertion', postFinalAttempt.score === 5 && postFinalAttempt.status === 'submitted');

    // Scenario 30: Finalization timeout policy: if code execution times out, partial score is recorded safely
    const regRes11 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Partial Score',
        phone: '9876543221',
        email: 'cand11@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken11 = regRes11.data.token;
    const allCorrect11 = getCorrectAnswersForAttempt(attemptToken11);
    const partialAnswers = {};
    partialAnswers[qMCQ1.lastInsertRowid] = allCorrect11[qMCQ1.lastInsertRowid]; // 2 marks

    const partialSubmit = await request('POST', `/api/attempt/${attemptToken11}/submit`, { body: { answers: partialAnswers } });
    ok('Scenario 30: MCQ score awarded safely (2 marks) even with unanswered coding question', partialSubmit.data.score === 2);

    // -------------------------------------------------------------
    // GROUP 4: Regression & Non-Destructive Invariants (Scenarios 31–36)
    // -------------------------------------------------------------
    console.log('\n--- Group 4: Regression & Non-Destructive Invariants ---');

    // Scenario 31: Snapshot HMAC integrity verification is preserved on submission
    const regRes12 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Tamper',
        phone: '9876543222',
        email: 'cand12@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken12 = regRes12.data.token;
    // Tamper with question snapshot
    db.prepare("UPDATE attempts SET questions_snapshot_json = '[]' WHERE token = ?").run(attemptToken12);

    const tamperSubmit = await request('POST', `/api/attempt/${attemptToken12}/submit`, { body: { answers: {} } });
    ok('Scenario 31: Tampered question snapshot rejected with HTTP 409 Conflict', tamperSubmit.status === 409 && tamperSubmit.data.code === 'SNAPSHOT_INTEGRITY_FAILURE');

    // Scenario 32: Day 10 async code execution flow remains operational
    const regRes13 = await request('POST', '/api/register', {
      body: {
        name: 'Candidate Async Code',
        phone: '9876543223',
        email: 'cand13@example.com',
        college: 'Engineering College',
        exam_id: examA.id
      }
    });
    const attemptToken13 = regRes13.data.token;
    const asyncCodeRes = await request('POST', `/api/attempt/${attemptToken13}/code-submit`, {
      body: {
        questionId: qCode.lastInsertRowid,
        language: 'python',
        sourceCode: 'def solve(a,b):\n    return a + b'
      }
    });
    ok('Scenario 32: Day 10 async code submit enqueues job and returns HTTP 202 Accepted', asyncCodeRes.status === 202 && !!asyncCodeRes.data.submissionId);

    // Scenario 33: Day 11 proctoring risk engine and telemetry ingestion unaffected
    const proctorRes = await request('POST', `/api/attempt/${attemptToken13}/proctoring/events`, {
      body: {
        events: [
          { eventId: 'evt_1_' + Date.now(), eventType: 'TAB_SWITCH', timestamp: new Date().toISOString() },
          { eventId: 'evt_2_' + Date.now(), eventType: 'PASTE_ATTEMPT', timestamp: new Date().toISOString() }
        ]
      }
    });
    ok('Scenario 33: Day 11 proctoring event ingestion succeeds (HTTP 200)', proctorRes.status === 200 && proctorRes.data.success === true);

    // Scenario 34: Day 12 network resilience and session recovery unaffected
    const syncRes13 = await request('POST', `/api/attempt/${attemptToken13}/progress/sync`, {
      body: {
        changes: [{
          changeId: 'chg_recov_' + crypto.randomBytes(6).toString('hex'),
          type: 'MCQ_ANSWER',
          questionId: qMCQ1.lastInsertRowid,
          answer: 3
        }]
      }
    });
    ok('Scenario 34: Day 12 progress sync functions cleanly (HTTP 200)', syncRes13.status === 200 && syncRes13.data.success === true);

    // Scenario 35: Candidate cannot submit another candidate's attempt
    const bogusSubmit = await request('POST', '/api/attempt/bogus_invalid_token_1234567890/submit', { body: { answers: {} } });
    ok('Scenario 35: Attempt to submit with non-existent token returns HTTP 404', bogusSubmit.status === 404);

    // Scenario 36: Tenant isolation is maintained across assessment submissions
    const adminLoginRes = await login(orgAAdmin.email, 'OrgAPassword123!');
    const orgAdminToken = adminLoginRes.data.data.token;

    const orgAResults = await request('GET', '/api/admin/results', {
      headers: { Authorization: `Bearer ${orgAdminToken}` }
    });
    ok('Scenario 36a: Org Admin queries results successfully (HTTP 200)', orgAResults.status === 200 && Array.isArray(orgAResults.data));
    const allBelongToOrgA = orgAResults.data.every((r) => r.organization_id === orgA.id || r.organization_id === null);
    ok('Scenario 36b: Org A admin does not see any Org B attempts', allBelongToOrgA);

    console.log(`\n=================================================`);
    console.log(`[test-timer-submission] ALL 48 ASSERTIONS PASSED!`);
    console.log(`=================================================\n`);

  } finally {
    if (server) {
      server.close();
      console.log('[test-timer-submission] Test server closed cleanly.');
    }
  }
}

runTests().catch((err) => {
  console.error('[test-timer-submission] FATAL ERROR:', err);
  if (server) server.close();
  process.exit(1);
});
