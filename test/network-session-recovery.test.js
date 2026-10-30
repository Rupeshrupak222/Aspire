// Automated Test Suite for Day 12: Network Resilience, Automatic Saving & Assessment Session Recovery
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const sessionRecoveryService = require('../backend/src/services/session-recovery.service');
const snapshotService = require('../backend/src/services/snapshot.service');
const examService = require('../backend/src/services/exam.service');
const userService = require('../backend/src/services/user.service');
const orgService = require('../backend/src/services/organization.service');
const AssessmentStorage = require('../frontend/js/assessment-storage');
const { ROLES } = require('../backend/src/security/rbac');

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

function login(email, password) {
  return request('POST', '/api/auth/login', {
    body: { email, password }
  });
}

async function runTests() {
  console.log('[test-recovery] Starting Day 12 Network & Session Recovery Test Suite...\n');

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[test-recovery] Test server listening on port ${addr.port}`);
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
    // SECTION 1: Frontend Storage Abstraction Unit Tests
    // -------------------------------------------------------------
    console.log('--- 1. Frontend Storage Abstraction (AssessmentStorage) ---');

    const mockToken = 'mock_token_' + crypto.randomBytes(8).toString('hex');
    const initState = await AssessmentStorage.init(mockToken);
    ok('AssessmentStorage initializes with token', initState.token === mockToken);
    ok('AssessmentStorage assigns clientSessionId', typeof initState.clientSessionId === 'string' && initState.clientSessionId.startsWith('sess_'));
    ok('AssessmentStorage starts with revision 0', initState.localRevision === 0);

    // Save MCQ answer
    const mcqChange = await AssessmentStorage.saveMCQAnswer(101, 2);
    ok('saveMCQAnswer creates change object with unique changeId', typeof mcqChange.changeId === 'string' && mcqChange.changeId.startsWith('mcq_'));
    ok('saveMCQAnswer sets type MCQ_ANSWER', mcqChange.type === 'MCQ_ANSWER');
    ok('saveMCQAnswer sets questionId and answer', mcqChange.questionId === 101 && mcqChange.answer === 2);
    ok('saveMCQAnswer increments localRevision', mcqChange.revision === 1);

    // Save Draft Code
    const draftChange = await AssessmentStorage.saveDraftCode(202, 'python', 'def solution():\n    return 42');
    ok('saveDraftCode creates CODE_DRAFT change', draftChange.type === 'CODE_DRAFT');
    ok('saveDraftCode preserves code buffer', draftChange.code.includes('return 42'));
    ok('saveDraftCode sets language to python', draftChange.language === 'python');
    ok('saveDraftCode increments localRevision to 2', draftChange.revision === 2);

    // Save Navigation
    const navChange = await AssessmentStorage.saveCurrentQuestion(101, 1);
    ok('saveCurrentQuestion creates NAVIGATION change', navChange.type === 'NAVIGATION');
    ok('saveCurrentQuestion records questionId and sectionId', navChange.questionId === 101 && navChange.sectionId === 1);

    // Pending changes inspection
    const pending = await AssessmentStorage.getPendingChanges();
    ok('getPendingChanges returns all 3 queued changes', Array.isArray(pending) && pending.length === 3);

    // Mark changes synced
    await AssessmentStorage.markChangesSynced([mcqChange.changeId, draftChange.changeId], 5);
    const pendingAfterSync = await AssessmentStorage.getPendingChanges();
    ok('markChangesSynced removes acknowledged changes', pendingAfterSync.length === 1 && pendingAfterSync[0].changeId === navChange.changeId);
    const updatedState = await AssessmentStorage.getAssessmentState();
    ok('markChangesSynced updates serverRevision', updatedState.serverRevision === 5);
    ok('markChangesSynced records lastSyncedAt', typeof updatedState.lastSyncedAt === 'string');

    // Clean up
    await AssessmentStorage.clearAssessmentState();
    const clearedState = await AssessmentStorage.getAssessmentState();
    ok('clearAssessmentState clears local state', clearedState.pendingChanges.length === 0);

    // -------------------------------------------------------------
    // SECTION 2: Setup Assessment and Exam with Snapshot for E2E
    // -------------------------------------------------------------
    console.log('\n--- 2. Setting Up Exam, Student & Attempt for Recovery E2E ---');

    // Fetch existing live questions
    const qMCQ1 = db.prepare("SELECT * FROM questions WHERE type = 'mcq' LIMIT 1").get();
    const qMCQ2 = db.prepare("SELECT * FROM questions WHERE type = 'mcq' AND id != ? LIMIT 1").get(qMCQ1.id);
    const qCode = db.prepare("SELECT * FROM questions WHERE type = 'code' LIMIT 1").get();

    ok('Found test questions in DB', qMCQ1 && qMCQ2 && qCode);

    // Register a student for testing
    const testPhone = '987654' + Math.floor(1000 + Math.random() * 9000);
    const regRes = await request('POST', '/api/register', {
      body: {
        name: 'Recovery Test Candidate',
        phone: testPhone,
        email: 'recovery@adyapan.internal'
      }
    });

    ok('Candidate registered successfully', regRes.status === 200 && regRes.data.token);
    const attemptToken = regRes.data.token;

    // Load attempt to inspect snapshot
    const attemptRow = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
    ok('Attempt record exists in DB', !!attemptRow);

    // Ensure our test questions are part of attempt questions_snapshot_json for testing
    const questionsSnapshot = [
      {
        id: qMCQ1.id,
        type: 'mcq',
        category: qMCQ1.category,
        question_text: qMCQ1.question_text,
        options_json: qMCQ1.options_json,
        marks: qMCQ1.marks,
        correct_index: qMCQ1.correct_index
      },
      {
        id: qMCQ2.id,
        type: 'mcq',
        category: qMCQ2.category,
        question_text: qMCQ2.question_text,
        options_json: qMCQ2.options_json,
        marks: qMCQ2.marks,
        correct_index: qMCQ2.correct_index
      },
      {
        id: qCode.id,
        type: 'code',
        category: qCode.category,
        question_text: qCode.question_text,
        marks: qCode.marks,
        code_starter: qCode.code_starter || '# starter code'
      }
    ];

    const newHash = snapshotService.computeSnapshotHash(
      attemptRow.exam_snapshot_json,
      JSON.stringify(questionsSnapshot),
      attemptRow.shuffle_map_json
    );

    db.prepare(`
      UPDATE attempts SET
        question_ids_json = ?,
        questions_snapshot_json = ?,
        snapshot_hash = ?
      WHERE id = ?
    `).run(
      JSON.stringify([qMCQ1.id, qMCQ2.id, qCode.id]),
      JSON.stringify(questionsSnapshot),
      newHash,
      attemptRow.id
    );

    // -------------------------------------------------------------
    // SECTION 3: Heartbeat & Authoritative Assessment Timer
    // -------------------------------------------------------------
    console.log('\n--- 3. Authoritative Heartbeat & Timer Validation ---');

    const hbRes = await request('POST', `/api/attempt/${attemptToken}/heartbeat`, {
      body: {
        tabSwitches: 2,
        clientSessionId: 'sess_client_test_123',
        currentQuestionId: qMCQ1.id
      }
    });

    ok('Heartbeat returns HTTP 200', hbRes.status === 200);
    ok('Heartbeat acknowledges request', hbRes.data.ok === true && hbRes.data.acknowledged === true);
    ok('Heartbeat includes authoritative serverTime ISO string', typeof hbRes.data.serverTime === 'string');
    ok('Heartbeat includes remainingSeconds as positive integer', typeof hbRes.data.remainingSeconds === 'number' && hbRes.data.remainingSeconds > 0);
    ok('Heartbeat indicates isExpired: false', hbRes.data.isExpired === false);
    ok('Heartbeat reports serverRevision 0', hbRes.data.serverRevision === 0);
    ok('Heartbeat reports tabSwitches 2', hbRes.data.tabSwitches === 2);

    const reloadedAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptRow.id);
    ok('Heartbeat persisted last_heartbeat_at timestamp', typeof reloadedAttempt.last_heartbeat_at === 'string');
    ok('Heartbeat persisted client_session_id', reloadedAttempt.client_session_id === 'sess_client_test_123');
    ok('Heartbeat persisted current_question_id', reloadedAttempt.current_question_id === qMCQ1.id);

    // Security: Reject client attempt to forge timer/scores in heartbeat
    const forgedHbRes = await request('POST', `/api/attempt/${attemptToken}/heartbeat`, {
      body: {
        remainingSeconds: 999999,
        score: 100
      }
    });
    ok('Heartbeat rejects client-supplied remainingSeconds/score with HTTP 400', forgedHbRes.status === 400);

    // -------------------------------------------------------------
    // SECTION 4: Progress Synchronization API & Batching
    // -------------------------------------------------------------
    console.log('\n--- 4. Batch Progress Synchronization (MCQ, Draft Code, Navigation) ---');

    const changeId1 = 'mcq_change_' + crypto.randomBytes(6).toString('hex');
    const changeId2 = 'code_change_' + crypto.randomBytes(6).toString('hex');

    const syncRes1 = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        clientSessionId: 'sess_client_test_123',
        localRevision: 1,
        changes: [
          {
            changeId: changeId1,
            type: 'MCQ_ANSWER',
            questionId: qMCQ1.id,
            answer: 1,
            revision: 1
          },
          {
            changeId: changeId2,
            type: 'CODE_DRAFT',
            questionId: qCode.id,
            language: 'python',
            code: 'def add(a, b):\n    return a + b',
            revision: 1
          }
        ],
        navigation: {
          questionId: qMCQ1.id,
          sectionId: null
        }
      }
    });

    ok('Progress sync returns HTTP 200', syncRes1.status === 200);
    ok('Progress sync returns success: true', syncRes1.data.success === true);
    ok('Progress sync increments serverRevision to 1', syncRes1.data.serverRevision === 1);
    ok('Progress sync acknowledges both changeIds', syncRes1.data.acknowledgedChanges.includes(changeId1) && syncRes1.data.acknowledgedChanges.includes(changeId2));
    ok('Progress sync reports 0 conflicts', Array.isArray(syncRes1.data.conflicts) && syncRes1.data.conflicts.length === 0);

    // Verify DB persistence of answers and drafts
    const syncedAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptRow.id);
    const savedAnswers = JSON.parse(syncedAttempt.answers_json || '{}');
    const savedDrafts = JSON.parse(syncedAttempt.draft_code_json || '{}');

    ok('MCQ answer persisted in attempts.answers_json', savedAnswers[qMCQ1.id] === 1);
    ok('Code draft persisted in attempts.draft_code_json', savedDrafts[qCode.id] && savedDrafts[qCode.id].code.includes('return a + b'));
    ok('attempts table recorded server_revision = 1', syncedAttempt.server_revision === 1);
    ok('attempts table recorded last_synced_at timestamp', typeof syncedAttempt.last_synced_at === 'string');

    // Verify attempt_sync_changes audit records
    const changeRows = db.prepare('SELECT * FROM attempt_sync_changes WHERE attempt_id = ?').all(attemptRow.id);
    ok('attempt_sync_changes contains 2 recorded changes', changeRows.length === 2);

    // -------------------------------------------------------------
    // SECTION 5: Idempotency & Revision Conflict Handling
    // -------------------------------------------------------------
    console.log('\n--- 5. Idempotency & Revision Conflict Handling ---');

    // 5.1 Idempotency: Retransmitting changeId1 and changeId2 must be acknowledged without error or state duplication
    const duplicateSyncRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        clientSessionId: 'sess_client_test_123',
        localRevision: 1,
        changes: [
          {
            changeId: changeId1,
            type: 'MCQ_ANSWER',
            questionId: qMCQ1.id,
            answer: 1,
            revision: 1
          }
        ]
      }
    });

    ok('Retransmitting duplicate changeId succeeds (HTTP 200)', duplicateSyncRes.status === 200);
    ok('Duplicate change acknowledged idempotently', duplicateSyncRes.data.acknowledgedChanges.includes(changeId1));
    const totalChangeCountAfterDup = db.prepare('SELECT COUNT(*) AS c FROM attempt_sync_changes WHERE attempt_id = ?').get(attemptRow.id).c;
    ok('No duplicate row inserted in attempt_sync_changes', totalChangeCountAfterDup === 2);

    // 5.2 Conflict Handling: Submitting stale revision (revision <= last revision for same question)
    const staleChangeId = 'stale_change_' + crypto.randomBytes(6).toString('hex');
    const staleSyncRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        clientSessionId: 'sess_client_test_123',
        localRevision: 1,
        changes: [
          {
            changeId: staleChangeId,
            type: 'MCQ_ANSWER',
            questionId: qMCQ1.id,
            answer: 2,
            revision: 1 // revision 1 was already applied for qMCQ1!
          }
        ]
      }
    });

    ok('Stale revision batch handled safely (HTTP 200)', staleSyncRes.status === 200);
    ok('Stale change recorded as conflict in response', staleSyncRes.data.conflicts.length === 1);
    ok('Conflict reason is STALE_REVISION', staleSyncRes.data.conflicts[0].reason === 'STALE_REVISION');
    ok('Conflict specifies rejectedRevision and currentServerRevision', staleSyncRes.data.conflicts[0].rejectedRevision === 1 && staleSyncRes.data.conflicts[0].currentServerRevision === 1);

    // Verify existing answer in DB was NOT corrupted by stale revision
    const afterStaleAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptRow.id);
    const answersAfterStale = JSON.parse(afterStaleAttempt.answers_json || '{}');
    ok('DB answer retained original value and was not overwritten by stale revision', answersAfterStale[qMCQ1.id] === 1);
    ok('sync_conflict_count incremented in DB', afterStaleAttempt.sync_conflict_count >= 1);

    // 5.3 Higher revision succeeds
    const higherChangeId = 'high_rev_' + crypto.randomBytes(6).toString('hex');
    const higherSyncRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        clientSessionId: 'sess_client_test_123',
        localRevision: 2,
        changes: [
          {
            changeId: higherChangeId,
            type: 'MCQ_ANSWER',
            questionId: qMCQ1.id,
            answer: 3,
            revision: 2 // monotonically higher!
          }
        ]
      }
    });

    ok('Higher revision accepted successfully (HTTP 200)', higherSyncRes.status === 200);
    ok('Higher revision acknowledged', higherSyncRes.data.acknowledgedChanges.includes(higherChangeId));
    const afterHigherAttempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptRow.id);
    const answersAfterHigher = JSON.parse(afterHigherAttempt.answers_json || '{}');
    ok('DB answer successfully updated to revision 2 value', answersAfterHigher[qMCQ1.id] === 3);

    // -------------------------------------------------------------
    // SECTION 6: Snapshot Validation & Input Boundaries
    // -------------------------------------------------------------
    console.log('\n--- 6. Snapshot Validation & Input Boundaries ---');

    // 6.1 Question not in snapshot rejected
    const invalidQId = 99999999;
    const invalidQRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        changes: [
          {
            changeId: 'inv_q_' + crypto.randomBytes(6).toString('hex'),
            type: 'MCQ_ANSWER',
            questionId: invalidQId,
            answer: 0,
            revision: 5
          }
        ]
      }
    });
    ok('Sync with questionId not in snapshot rejected (HTTP 400)', invalidQRes.status === 400);

    // 6.2 Invalid MCQ option index rejected
    const invalidOptRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        changes: [
          {
            changeId: 'inv_opt_' + crypto.randomBytes(6).toString('hex'),
            type: 'MCQ_ANSWER',
            questionId: qMCQ1.id,
            answer: 99, // out of range
            revision: 5
          }
        ]
      }
    });
    ok('Sync with out-of-range option index rejected (HTTP 400)', invalidOptRes.status === 400);

    // 6.3 Code draft exceeding 100KB rejected
    const oversizedCode = 'x'.repeat(105000);
    const oversizedRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        changes: [
          {
            changeId: 'oversized_' + crypto.randomBytes(6).toString('hex'),
            type: 'CODE_DRAFT',
            questionId: qCode.id,
            language: 'python',
            code: oversizedCode,
            revision: 5
          }
        ]
      }
    });
    ok('Sync with code draft > 100KB rejected (HTTP 400)', oversizedRes.status === 400);

    // 6.4 Client attempt to forge marks/scores in sync payload rejected
    const forgedSyncRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        changes: [
          {
            changeId: 'forged_' + crypto.randomBytes(6).toString('hex'),
            type: 'MCQ_ANSWER',
            questionId: qMCQ2.id,
            answer: 0,
            score: 100, // forbidden!
            revision: 5
          }
        ]
      }
    });
    ok('Sync payload with client-supplied score/marks rejected (HTTP 400)', forgedSyncRes.status === 400);

    // -------------------------------------------------------------
    // SECTION 7: Session Recovery on Page Load / Refresh
    // -------------------------------------------------------------
    console.log('\n--- 7. Session Recovery on Page Load / Reconnect ---');

    // Simulate candidate reloading the page / resuming after crash
    const getAttemptRes = await request('GET', `/api/attempt/${attemptToken}`);
    ok('GET /api/attempt/:token returns HTTP 200', getAttemptRes.status === 200);
    ok('Recovery payload includes answers object', typeof getAttemptRes.data.answers === 'object');
    ok('Recovery payload restores MCQ answers accurately', getAttemptRes.data.answers[qMCQ1.id] === 3);
    ok('Recovery payload includes draft_code object', typeof getAttemptRes.data.draft_code === 'object');
    ok('Recovery payload restores draft code buffer accurately', getAttemptRes.data.draft_code[qCode.id] && getAttemptRes.data.draft_code[qCode.id].code.includes('return a + b'));
    ok('Recovery payload includes server_revision', typeof getAttemptRes.data.server_revision === 'number');
    ok('Recovery payload includes server_time', typeof getAttemptRes.data.server_time === 'string');
    ok('Recovery payload includes remaining_seconds', typeof getAttemptRes.data.remaining_seconds === 'number');

    // -------------------------------------------------------------
    // SECTION 8: Deadline Safety & Expiration Authority
    // -------------------------------------------------------------
    console.log('\n--- 8. Strict Deadline Safety & Expiration Authority ---');

    // Set attempt to expired
    db.prepare("UPDATE attempts SET expires_at = datetime('now', '-5 minutes') WHERE id = ?").run(attemptRow.id);

    // Expired attempt heartbeat
    const expiredHbRes = await request('POST', `/api/attempt/${attemptToken}/heartbeat`, {
      body: { tabSwitches: 5 }
    });
    ok('Expired attempt heartbeat reports isExpired: true', expiredHbRes.data.isExpired === true);
    ok('Expired attempt heartbeat reports remainingSeconds: 0', expiredHbRes.data.remainingSeconds === 0);

    // Expired attempt progress sync must be rejected with 409 Conflict
    const expiredSyncRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        changes: [
          {
            changeId: 'late_sync_' + crypto.randomBytes(6).toString('hex'),
            type: 'MCQ_ANSWER',
            questionId: qMCQ2.id,
            answer: 1,
            revision: 10
          }
        ]
      }
    });
    ok('Progress sync on expired assessment rejected (HTTP 409 Conflict)', expiredSyncRes.status === 409);
    ok('Conflict error code is ATTEMPT_EXPIRED', expiredSyncRes.data.code === 'ATTEMPT_EXPIRED');

    // -------------------------------------------------------------
    // SECTION 9: Completed Assessment Protection & Submission Merge
    // -------------------------------------------------------------
    console.log('\n--- 9. Completed Assessment Protection & Auto-Saved Answer Evaluation ---');

    // Reset expiration for final submit test
    db.prepare("UPDATE attempts SET expires_at = datetime('now', '+1 hour') WHERE id = ?").run(attemptRow.id);

    // Submit assessment without re-sending answers (simulating quick submit or partial packet)
    const submitRes = await request('POST', `/api/attempt/${attemptToken}/submit`, {
      body: {
        answers: {}, // empty body answers! Must fall back to auto-saved answers_json in DB!
        tabSwitches: 3
      }
    });

    ok('Submit succeeds (HTTP 200)', submitRes.status === 200);
    ok('Assessment status transitioned to submitted', submitRes.data.status === 'submitted');
    ok('Certificate ID generated', typeof submitRes.data.certificate_id === 'string');

    // Attempting to sync progress after submission must be rejected with 409
    const postSubmitSyncRes = await request('POST', `/api/attempt/${attemptToken}/progress/sync`, {
      body: {
        changes: [
          {
            changeId: 'post_sub_' + crypto.randomBytes(6).toString('hex'),
            type: 'MCQ_ANSWER',
            questionId: qMCQ2.id,
            answer: 0,
            revision: 20
          }
        ]
      }
    });
    ok('Progress sync on submitted assessment rejected with HTTP 409', postSubmitSyncRes.status === 409);
    ok('Conflict code is ATTEMPT_ALREADY_SUBMITTED', postSubmitSyncRes.data.code === 'ATTEMPT_ALREADY_SUBMITTED');

    // -------------------------------------------------------------
    // SECTION 10: Independence from Day 10 Async Execution & Day 11 Proctoring
    // -------------------------------------------------------------
    console.log('\n--- 10. Separation of Concerns (Day 10 Async Execution & Day 11 Proctoring) ---');

    // Verify draft saving created ZERO records in coding_submissions
    const codingSubmissionsCount = db.prepare('SELECT COUNT(*) AS c FROM coding_submissions WHERE attempt_id = ?').get(attemptRow.id).c;
    ok('Draft code auto-saving did NOT create records in coding_submissions (strictly isolated from BullMQ execution)', codingSubmissionsCount === 0);

    // Verify proctoring table remains clean of assessment state mutations
    const proctoringCount = db.prepare('SELECT COUNT(*) AS c FROM proctoring_events WHERE attempt_id = ?').get(attemptRow.id).c;
    ok('Proctoring events table remains dedicated to telemetry only', proctoringCount === 0);

    // -------------------------------------------------------------
    // SECTION 11: Admin Results & CSV Export Metadata
    // -------------------------------------------------------------
    console.log('\n--- 11. Admin Results & CSV Export Metadata Verification ---');

    // Super admin credentials from bootstrap
    const adminUser = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get();
    ok('Found super admin user in DB', !!adminUser);

    // Temporary password reset or token issuance for admin login
    const adminToken = userService.generateToken(adminUser);

    const adminResultsRes = await request('GET', '/api/admin/results', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    ok('Admin GET /api/admin/results returns HTTP 200', adminResultsRes.status === 200);
    const targetResult = adminResultsRes.data.find(r => r.attempt_id === attemptRow.id);
    ok('Admin results includes test attempt', !!targetResult);
    ok('Admin result includes last_heartbeat_at', targetResult.last_heartbeat_at !== undefined);
    ok('Admin result includes last_synced_at', targetResult.last_synced_at !== undefined);
    ok('Admin result includes server_revision', targetResult.server_revision !== undefined);

    const csvRes = await request('GET', '/api/admin/results.csv', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    ok('Admin GET /api/admin/results.csv returns HTTP 200', csvRes.status === 200);
    ok('CSV export content-type is text/csv', csvRes.headers['content-type'].includes('text/csv'));
    const headerLine = csvRes.text.split('\n')[0];
    ok('CSV header includes last_heartbeat_at', headerLine.includes('last_heartbeat_at'));
    ok('CSV header includes last_synced_at', headerLine.includes('last_synced_at'));
    ok('CSV header includes server_revision', headerLine.includes('server_revision'));

    console.log(`\n=================================================`);
    console.log(`[test-recovery] ALL ${totalPassed} ASSERTIONS PASSED!`);
    console.log(`=================================================\n`);

  } finally {
    if (server) {
      server.close();
    }
  }
}

runTests().catch((err) => {
  console.error('\n[test-recovery] FATAL ERROR:', err);
  process.exit(1);
});
