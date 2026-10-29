// Code Execution Worker Processor
// Evaluates queued coding submissions against test cases, updates SQLite authoritatively,
// updates attempt state, and handles retryable vs fatal errors.

const { db } = require('../db');
const { executionService } = require('../services/code-execution/execution.service');
const {
  SUBMISSION_LIFECYCLE,
  EXECUTION_STATUS
} = require('../services/code-execution/constants');
const snapshotService = require('../services/snapshot.service');
const { ExternalServiceError } = require('../errors/app-error');
const logger = require('../utils/logger');

/**
 * Process a single code execution job.
 * Authoritative record of truth is SQLite.
 *
 * @param {Object} jobData
 * @param {string} jobData.submissionId
 * @param {number} jobData.attemptId
 * @param {number} jobData.questionId
 * @param {string} [jobData.submissionType='FINAL']
 * @returns {Promise<{ success: boolean, submissionId: string, status: string, verdict?: string, score?: number }>}
 */
async function processCodeJob(jobData) {
  const { submissionId, attemptId, questionId, submissionType = 'FINAL' } = jobData;

  if (!submissionId) {
    throw new Error('processCodeJob: submissionId is required');
  }

  // 1. Fetch submission record from SQLite
  const submission = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(submissionId);
  if (!submission) {
    logger.error({ submissionId }, 'Submission record not found in SQLite');
    return { success: false, submissionId, status: SUBMISSION_LIFECYCLE.FAILED, error: 'SUBMISSION_NOT_FOUND' };
  }

  // 2. Idempotency guard: If already completed or failed, do not re-process
  if (submission.lifecycle_status === SUBMISSION_LIFECYCLE.COMPLETED) {
    logger.info({ submissionId }, 'Submission already completed, skipping');
    return {
      success: true,
      submissionId,
      status: SUBMISSION_LIFECYCLE.COMPLETED,
      verdict: submission.submission_status,
      score: submission.score
    };
  }

  // 3. Fetch attempt record
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId || submission.attempt_id);
  if (!attempt) {
    logger.error({ submissionId, attemptId: submission.attempt_id }, 'Attempt record not found');
    db.prepare(`
      UPDATE coding_submissions
      SET lifecycle_status = ?, submission_status = ?, error_message = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(SUBMISSION_LIFECYCLE.FAILED, EXECUTION_STATUS.SYSTEM_ERROR, 'Associated attempt not found', submissionId);
    return { success: false, submissionId, status: SUBMISSION_LIFECYCLE.FAILED, error: 'ATTEMPT_NOT_FOUND' };
  }

  // 4. Verify snapshot HMAC integrity
  try {
    snapshotService.verifySnapshotIntegrity(attempt);
  } catch (snapErr) {
    logger.error({ submissionId, err: snapErr.message }, 'Attempt snapshot integrity check failed in worker');
    db.prepare(`
      UPDATE coding_submissions
      SET lifecycle_status = ?, submission_status = ?, error_message = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(SUBMISSION_LIFECYCLE.FAILED, EXECUTION_STATUS.SYSTEM_ERROR, 'Snapshot integrity verification failed', submissionId);
    return { success: false, submissionId, status: SUBMISSION_LIFECYCLE.FAILED, error: 'SNAPSHOT_TAMPERED' };
  }

  // 5. Transition to RUNNING status
  db.prepare(`
    UPDATE coding_submissions
    SET lifecycle_status = ?,
        started_at = COALESCE(started_at, datetime('now')),
        attempt_count = attempt_count + 1
    WHERE id = ?
  `).run(SUBMISSION_LIFECYCLE.RUNNING, submissionId);

  // 6. Resolve target question and test cases
  let question;
  try {
    question = executionService._resolveQuestionFromAttempt(attempt, questionId || submission.question_id);
  } catch (qErr) {
    logger.error({ submissionId, err: qErr.message }, 'Failed to resolve question from attempt snapshot');
    db.prepare(`
      UPDATE coding_submissions
      SET lifecycle_status = ?, submission_status = ?, error_message = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(SUBMISSION_LIFECYCLE.FAILED, EXECUTION_STATUS.SYSTEM_ERROR, qErr.message, submissionId);
    return { success: false, submissionId, status: SUBMISSION_LIFECYCLE.FAILED, error: qErr.message };
  }

  const testCases = executionService._extractTestCases(question);
  const marks = question.marks || 1;
  const canonicalLang = submission.language;
  const sourceCode = submission.source_code || '';

  // 7. Execute code against test suite
  let evaluation;
  try {
    evaluation = await executionService.evaluateQuestion({
      language: canonicalLang,
      sourceCode,
      testCases,
      sampleOnly: submissionType === 'SAMPLE'
    });
  } catch (execErr) {
    const isRetryable = execErr instanceof ExternalServiceError ||
      execErr.statusCode >= 500 ||
      execErr.code === 'ECONNREFUSED' ||
      execErr.code === 'ETIMEDOUT' ||
      execErr.message?.includes('503') ||
      execErr.message?.includes('502') ||
      execErr.message?.includes('504');

    if (isRetryable) {
      logger.warn({
        submissionId,
        attemptCount: submission.attempt_count + 1,
        err: execErr.message
      }, 'Transient provider error encountered, flagging for retry');

      db.prepare(`
        UPDATE coding_submissions
        SET lifecycle_status = ?,
            last_error_code = 'PROVIDER_UNAVAILABLE',
            last_error_at = datetime('now'),
            error_message = ?
        WHERE id = ?
      `).run(SUBMISSION_LIFECYCLE.RETRYING, execErr.message, submissionId);

      // Re-throw so BullMQ performs exponential backoff retry
      throw execErr;
    }

    // Non-retryable error (e.g. fatal unhandled bug)
    logger.error({ submissionId, err: execErr.message }, 'Fatal unrecoverable code execution error');
    db.prepare(`
      UPDATE coding_submissions
      SET lifecycle_status = ?,
          submission_status = ?,
          last_error_code = 'EXECUTION_FAILED',
          last_error_at = datetime('now'),
          error_message = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(SUBMISSION_LIFECYCLE.FAILED, EXECUTION_STATUS.SYSTEM_ERROR, execErr.message, submissionId);

    return { success: false, submissionId, status: SUBMISSION_LIFECYCLE.FAILED, error: execErr.message };
  }

  // 8. Calculate score based on passed ratio
  const ratio = evaluation.testsTotal > 0 ? evaluation.testsPassed / evaluation.testsTotal : 0;
  const score = Math.round((marks * ratio) * 100) / 100;
  const providerName = executionService.getActiveProvider().name;

  // 9. Transactionally persist results to SQLite and update attempt state
  const finalizeTransaction = db.transaction(() => {
    // A. Update coding_submissions to COMPLETED
    db.prepare(`
      UPDATE coding_submissions
      SET lifecycle_status = ?,
          submission_status = ?,
          provider = ?,
          test_cases_passed = ?,
          test_cases_total = ?,
          score = ?,
          execution_time_ms = ?,
          memory_used_kb = ?,
          error_message = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(
      SUBMISSION_LIFECYCLE.COMPLETED,
      evaluation.status,
      providerName,
      evaluation.testsPassed,
      evaluation.testsTotal,
      score,
      evaluation.executionTimeMs,
      evaluation.memoryUsedKb,
      evaluation.error,
      submissionId
    );

    // B. Update attempt's code_answers_json
    let currentCodeAnswers = {};
    try {
      currentCodeAnswers = JSON.parse(attempt.code_answers_json || '{}');
    } catch {}
    currentCodeAnswers[question.id] = sourceCode;

    db.prepare('UPDATE attempts SET code_answers_json = ? WHERE id = ?')
      .run(JSON.stringify(currentCodeAnswers), attempt.id);

    // C. Write Audit Log
    try {
      db.prepare(`
        INSERT INTO audit_logs (organization_id, event, details_json)
        VALUES (?, ?, ?)
      `).run(
        attempt.organization_id || null,
        'coding_submission_completed',
        JSON.stringify({
          submissionId,
          attemptId: attempt.id,
          questionId: question.id,
          language: canonicalLang,
          status: evaluation.status,
          testsPassed: evaluation.testsPassed,
          testsTotal: evaluation.testsTotal,
          score
        })
      );
    } catch {}
  });

  finalizeTransaction();

  logger.info({
    submissionId,
    attemptId: attempt.id,
    questionId: question.id,
    verdict: evaluation.status,
    testsPassed: evaluation.testsPassed,
    testsTotal: evaluation.testsTotal,
    score
  }, 'Code execution job completed and persisted to SQLite');

  return {
    success: true,
    submissionId,
    status: SUBMISSION_LIFECYCLE.COMPLETED,
    verdict: evaluation.status,
    score,
    testsPassed: evaluation.testsPassed,
    testsTotal: evaluation.testsTotal
  };
}

module.exports = {
  processCodeJob
};

