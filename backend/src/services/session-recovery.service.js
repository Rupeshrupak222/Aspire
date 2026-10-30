// Assessment Session Recovery, Real-Time Progress Synchronization & Network Resilience (Day 12)
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const { db } = require('../db');
const { ConflictError, ValidationError, NotFoundError } = require('../errors/app-error');
const logger = require('../utils/logger');
const snapshotService = require('./snapshot.service');
const timerSubmissionService = require('./timer-submission.service');

const CHANGE_TYPES = Object.freeze({
  MCQ_ANSWER: 'MCQ_ANSWER',
  CODE_DRAFT: 'CODE_DRAFT',
  NAVIGATION: 'NAVIGATION'
});

/**
 * Resolve candidate questions from attempt snapshot or DB
 */
function resolveAttemptQuestions(attempt, targetDb = db) {
  if (attempt.questions_snapshot_json) {
    try {
      const snap = JSON.parse(attempt.questions_snapshot_json);
      if (Array.isArray(snap) && snap.length > 0) return snap;
    } catch {}
  }
  const qids = JSON.parse(attempt.question_ids_json || '[]');
  if (!qids.length) return [];
  return targetDb.prepare(`
    SELECT id, type, category, question_text, options_json, marks, code_starter
    FROM questions WHERE id IN (${qids.map(() => '?').join(',')})
  `).all(...qids);
}

/**
 * Process client heartbeat
 * Authoritative on server time, status, and expiration; does NOT alter deadlines.
 */
function processHeartbeat(attempt, data = {}, options = {}) {
  const targetDb = options.db || db;

  if (!attempt) {
    throw new NotFoundError('Attempt not found');
  }

  const nowMs = Date.now();
  const { deadlineStr, deadlineMs } = timerSubmissionService.getEffectiveDeadline(attempt);
  const remainingSeconds = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
  const isExpired = nowMs > deadlineMs;
  const graceSec = attempt.grace_period_seconds !== undefined ? Number(attempt.grace_period_seconds) : 60;

  if (attempt.status === 'started') {
    const tabSwitches = typeof data.tabSwitches === 'number' ? Math.floor(data.tabSwitches) : null;
    const clientSessionId = typeof data.clientSessionId === 'string' ? data.clientSessionId.slice(0, 128) : null;
    const currentQId = typeof data.currentQuestionId === 'number' ? data.currentQuestionId : null;

    targetDb.prepare(`
      UPDATE attempts SET
        last_heartbeat_at = datetime('now'),
        tab_switches = CASE WHEN ? IS NOT NULL AND ? > tab_switches THEN ? ELSE tab_switches END,
        client_session_id = COALESCE(?, client_session_id),
        current_question_id = COALESCE(?, current_question_id)
      WHERE id = ?
    `).run(tabSwitches, tabSwitches, tabSwitches, clientSessionId, currentQId, attempt.id);
  }

  // Reload attempt for latest revision & tab count
  const updated = targetDb.prepare('SELECT * FROM attempts WHERE id = ?').get(attempt.id);

  return {
    ok: true,
    acknowledged: true,
    serverTime: new Date(nowMs).toISOString(),
    startedAt: updated.started_at,
    deadlineAt: deadlineStr,
    expiresAt: updated.expires_at,
    gracePeriodSeconds: graceSec,
    remainingSeconds,
    isExpired,
    status: updated.status,
    finalizationStatus: updated.finalization_status || 'PENDING',
    serverRevision: updated.server_revision || 0,
    tabSwitches: updated.tab_switches || 0,
    lastSyncedAt: updated.last_synced_at || null
  };
}

/**
 * Process batch of assessment progress changes
 * Ensures:
 * 1. Idempotency (duplicate changeId skipped without state pollution).
 * 2. Revision monotonic ordering (stale revision rejected with conflict info).
 * 3. Atomic transaction updates to answers_json and draft_code_json.
 * 4. Question ID membership validation against attempt snapshot.
 * 5. Strict rejection of client-calculated marks, scores, or remaining time.
 */
function processProgressSync(attempt, syncPayload, options = {}) {
  const targetDb = options.db || db;

  if (!attempt) {
    throw new NotFoundError('Attempt not found');
  }

  if (attempt.status === 'submitted') {
    throw new ConflictError('This assessment has already been submitted', 'ATTEMPT_ALREADY_SUBMITTED');
  }

  if (attempt.status !== 'started') {
    throw new ConflictError(`Attempt is in status '${attempt.status}' and cannot accept progress updates`, 'ATTEMPT_NOT_ACTIVE');
  }

  const { deadlineMs } = timerSubmissionService.getEffectiveDeadline(attempt);
  if (Date.now() > deadlineMs) {
    throw new ConflictError('Assessment duration has expired', 'ATTEMPT_EXPIRED');
  }

  // Verify HMAC snapshot integrity
  snapshotService.verifySnapshotIntegrity(attempt);

  const questions = resolveAttemptQuestions(attempt, targetDb);
  const qMap = new Map(questions.map((q) => [Number(q.id), q]));

  const rawChanges = Array.isArray(syncPayload.changes) ? syncPayload.changes : [];
  if (rawChanges.length === 0 && !syncPayload.navigation) {
    throw new ValidationError('Sync payload must contain changes or navigation update', 'EMPTY_SYNC_PAYLOAD');
  }

  if (rawChanges.length > 50) {
    throw new ValidationError('Batch exceeds maximum limit of 50 changes', 'BATCH_SIZE_EXCEEDED');
  }

  // Prepared statements
  const checkChangeStmt = targetDb.prepare(`
    SELECT id, revision FROM attempt_sync_changes WHERE id = ?
  `);

  const insertChangeStmt = targetDb.prepare(`
    INSERT INTO attempt_sync_changes (
      id, attempt_id, change_type, question_id, revision, payload_json, client_session_id, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const getLatestRevisionStmt = targetDb.prepare(`
    SELECT MAX(revision) as max_rev FROM attempt_sync_changes
    WHERE attempt_id = ? AND question_id = ? AND change_type = ?
  `);

  let currentAnswers = {};
  try {
    currentAnswers = attempt.answers_json ? JSON.parse(attempt.answers_json) : {};
  } catch {}

  let currentDrafts = {};
  try {
    currentDrafts = attempt.draft_code_json ? JSON.parse(attempt.draft_code_json) : {};
  } catch {}

  const acknowledgedChanges = [];
  const conflicts = [];
  let stateChanged = false;
  let navQuestionId = syncPayload.navigation?.questionId ? Number(syncPayload.navigation.questionId) : null;
  let navSectionId = syncPayload.navigation?.sectionId ? Number(syncPayload.navigation.sectionId) : null;

  // Validate navigation question if provided
  if (navQuestionId && !qMap.has(navQuestionId)) {
    navQuestionId = null; // discard invalid navigation reference safely
  }

  const runSyncTx = targetDb.transaction(() => {
    for (const ch of rawChanges) {
      const changeId = String(ch.changeId || '').trim();
      const changeType = String(ch.type || '').trim().toUpperCase();
      const qid = ch.questionId !== undefined && ch.questionId !== null ? Number(ch.questionId) : null;
      const revision = typeof ch.revision === 'number' && Number.isFinite(ch.revision) ? Math.floor(ch.revision) : 1;

      if (!changeId || changeId.length < 8) {
        throw new ValidationError('Each change must have a unique changeId of at least 8 characters', 'INVALID_CHANGE_ID');
      }

      if (!Object.values(CHANGE_TYPES).includes(changeType)) {
        throw new ValidationError(`Unsupported change type: ${changeType}`, 'INVALID_CHANGE_TYPE');
      }

      // Check idempotency: already applied change
      const existing = checkChangeStmt.get(changeId);
      if (existing) {
        acknowledgedChanges.push(changeId);
        continue;
      }

      // Validate question belongs to attempt snapshot
      if (qid !== null && !qMap.has(qid)) {
        throw new ValidationError(`Question ID ${qid} does not belong to this assessment snapshot`, 'QUESTION_NOT_IN_SNAPSHOT');
      }

      const questionObj = qid !== null ? qMap.get(qid) : null;

      // Check revision monotonic ordering per (attempt, question, type)
      if (qid !== null) {
        const revRow = getLatestRevisionStmt.get(attempt.id, qid, changeType);
        const lastRev = revRow?.max_rev || 0;
        if (revision <= lastRev) {
          conflicts.push({
            changeId,
            questionId: qid,
            rejectedRevision: revision,
            currentServerRevision: lastRev,
            reason: 'STALE_REVISION'
          });
          continue;
        }
      }

      // Apply state mutation based on type
      if (changeType === CHANGE_TYPES.MCQ_ANSWER) {
        if (!questionObj || questionObj.type !== 'mcq') {
          throw new ValidationError(`Question ${qid} is not an MCQ question`, 'INVALID_QUESTION_TYPE');
        }

        // Validate allowed answer option index
        if (ch.answer !== undefined && ch.answer !== null && ch.answer !== '') {
          const optIdx = parseInt(ch.answer, 10);
          let optionsCount = 4;
          try {
            const opts = Array.isArray(questionObj.options)
              ? questionObj.options
              : JSON.parse(questionObj.options_json || '[]');
            if (Array.isArray(opts) && opts.length > 0) optionsCount = opts.length;
          } catch {}

          if (isNaN(optIdx) || optIdx < 0 || optIdx >= optionsCount) {
            throw new ValidationError(`Answer option index ${ch.answer} is invalid for question ${qid}`, 'INVALID_OPTION_INDEX');
          }
          currentAnswers[qid] = optIdx;
        } else {
          // Clear answer
          delete currentAnswers[qid];
          delete currentAnswers[String(qid)];
        }
        stateChanged = true;

      } else if (changeType === CHANGE_TYPES.CODE_DRAFT) {
        if (!questionObj || questionObj.type !== 'code') {
          throw new ValidationError(`Question ${qid} is not a coding question`, 'INVALID_QUESTION_TYPE');
        }

        const codeStr = typeof ch.code === 'string' ? ch.code : '';
        if (codeStr.length > 102400) {
          throw new ValidationError('Code draft exceeds maximum permitted size of 100KB', 'CODE_DRAFT_TOO_LARGE');
        }

        const lang = typeof ch.language === 'string' ? ch.language.trim().toLowerCase().slice(0, 30) : 'python';

        currentDrafts[qid] = {
          code: codeStr,
          language: lang,
          updatedAt: new Date().toISOString()
        };
        stateChanged = true;

      } else if (changeType === CHANGE_TYPES.NAVIGATION) {
        if (qid && qMap.has(qid)) {
          navQuestionId = qid;
        }
      }

      // Persist durable change record
      insertChangeStmt.run(
        changeId,
        attempt.id,
        changeType,
        qid,
        revision,
        JSON.stringify(ch),
        syncPayload.clientSessionId || null
      );

      acknowledgedChanges.push(changeId);
    }

    // Determine new server revision
    let newRevision = attempt.server_revision || 0;
    if (stateChanged || acknowledgedChanges.length > 0 || navQuestionId) {
      newRevision += 1;
    }

    const conflictCount = conflicts.length;

    // Atomically persist confirmed progress to attempts table
    targetDb.prepare(`
      UPDATE attempts SET
        answers_json = ?,
        draft_code_json = ?,
        server_revision = ?,
        last_synced_at = datetime('now'),
        current_question_id = COALESCE(?, current_question_id),
        current_section_id = COALESCE(?, current_section_id),
        client_session_id = COALESCE(?, client_session_id),
        sync_conflict_count = sync_conflict_count + ?
      WHERE id = ?
    `).run(
      JSON.stringify(currentAnswers),
      JSON.stringify(currentDrafts),
      newRevision,
      navQuestionId,
      navSectionId,
      syncPayload.clientSessionId || null,
      conflictCount,
      attempt.id
    );

    return {
      serverRevision: newRevision,
      answersCount: Object.keys(currentAnswers).length,
      draftsCount: Object.keys(currentDrafts).length
    };
  });

  const txRes = runSyncTx();

  logger.info({
    service: 'aspire-recovery',
    attemptId: attempt.id,
    acknowledgedCount: acknowledgedChanges.length,
    conflictCount: conflicts.length,
    serverRevision: txRes.serverRevision
  }, 'Assessment progress batch synchronized');

  return {
    success: true,
    accepted: true,
    serverRevision: txRes.serverRevision,
    serverTime: new Date().toISOString(),
    acknowledgedChanges,
    conflicts,
    currentAnswersCount: txRes.answersCount,
    currentDraftsCount: txRes.draftsCount
  };
}

/**
 * Get full attempt recovery state for page load / reconnection
 */
function getAttemptRecoveryData(attemptId, targetDb = db) {
  const attempt = targetDb.prepare(`
    SELECT
      id, token, student_id, exam_id, status, started_at, expires_at, deadline_at,
      grace_period_seconds, finalization_status, submitted_at,
      answers_json, draft_code_json, server_revision, current_question_id, current_section_id,
      client_session_id, last_heartbeat_at, last_synced_at, sync_conflict_count,
      tab_switches, proctoring_risk_score, proctoring_risk_level
    FROM attempts WHERE id = ?
  `).get(attemptId);

  if (!attempt) {
    throw new NotFoundError('Attempt not found');
  }

  let answers = {};
  try {
    answers = attempt.answers_json ? JSON.parse(attempt.answers_json) : {};
  } catch {}

  let draftCode = {};
  try {
    draftCode = attempt.draft_code_json ? JSON.parse(attempt.draft_code_json) : {};
  } catch {}

  const nowMs = Date.now();
  const { deadlineStr, deadlineMs } = timerSubmissionService.getEffectiveDeadline(attempt);
  const remainingSeconds = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));

  return {
    attemptId: attempt.id,
    token: attempt.token,
    status: attempt.status,
    finalizationStatus: attempt.finalization_status || 'PENDING',
    serverTime: new Date(nowMs).toISOString(),
    startedAt: attempt.started_at,
    deadlineAt: deadlineStr,
    expiresAt: attempt.expires_at,
    gracePeriodSeconds: attempt.grace_period_seconds || 60,
    remainingSeconds,
    isExpired: nowMs > deadlineMs,
    serverRevision: attempt.server_revision || 0,
    currentQuestionId: attempt.current_question_id,
    currentSectionId: attempt.current_section_id,
    lastHeartbeatAt: attempt.last_heartbeat_at,
    lastSyncedAt: attempt.last_synced_at,
    syncConflictCount: attempt.sync_conflict_count || 0,
    answers,
    draftCode,
    tabSwitches: attempt.tab_switches || 0,
    riskScore: attempt.proctoring_risk_score || 0,
    riskLevel: attempt.proctoring_risk_level || 'NORMAL'
  };
}

module.exports = {
  CHANGE_TYPES,
  processHeartbeat,
  processProgressSync,
  getAttemptRecoveryData,
  resolveAttemptQuestions
};

