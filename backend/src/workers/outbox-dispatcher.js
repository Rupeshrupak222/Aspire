// Outbox Dispatcher
// Solves dual-write problems between SQLite and Redis/BullMQ.
// Guarantees at-least-once delivery of coding execution requests to the queue.
// In the event of Redis downtime, outbox events persist safely in SQLite and are retried with exponential backoff.

require('dotenv').config();
const { db } = require('../db');
const { codeExecutionQueue } = require('../queues/code-execution.queue');
const { testRedisConnection } = require('../config/redis');
const { processCodeJob } = require('./code-execution.processor');
const { OUTBOX_STATUS } = require('../services/code-execution/constants');
const logger = require('../utils/logger');

let loopTimer = null;
let isRunning = false;

/**
 * Dispatch an individual outbox event immediately (e.g. right after SQLite commit).
 *
 * @param {string} submissionId
 * @returns {Promise<{ dispatched: boolean, fallbackExecuted?: boolean, error?: string }>}
 */
async function dispatchImmediate(submissionId) {
  const event = db.prepare(`
    SELECT * FROM outbox_events
    WHERE aggregate_id = ? AND status = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(submissionId, OUTBOX_STATUS.PENDING);

  if (!event) {
    return { dispatched: false, reason: 'NO_PENDING_OUTBOX_EVENT' };
  }

  let payload;
  try {
    payload = JSON.parse(event.payload_json);
  } catch (err) {
    db.prepare(`
      UPDATE outbox_events
      SET status = ?, last_error_code = 'CORRUPTED_PAYLOAD', last_error_message = ?, processed_at = datetime('now')
      WHERE id = ?
    `).run(OUTBOX_STATUS.FAILED, err.message, event.id);
    return { dispatched: false, error: 'CORRUPTED_PAYLOAD' };
  }

  try {
    // Attempt BullMQ enqueue
    const { jobId } = await codeExecutionQueue.enqueueSubmissionJob(payload);

    db.transaction(() => {
      db.prepare(`
        UPDATE outbox_events
        SET status = ?, processed_at = datetime('now')
        WHERE id = ?
      `).run(OUTBOX_STATUS.DISPATCHED, event.id);

      db.prepare(`
        UPDATE coding_submissions
        SET job_id = ?
        WHERE id = ?
      `).run(jobId, submissionId);
    })();

    logger.info({ submissionId, eventId: event.id, jobId }, 'Outbox event dispatched immediately to BullMQ');
    return { dispatched: true, jobId };
  } catch (err) {
    // Redis unavailable or queue error: Record backoff in outbox
    const attemptCount = (event.attempt_count || 0) + 1;
    const backoffSeconds = Math.min(attemptCount * 5, 60);

    db.prepare(`
      UPDATE outbox_events
      SET attempt_count = ?,
          last_error_code = 'REDIS_UNAVAILABLE',
          last_error_message = ?,
          available_at = datetime('now', '+' || ? || ' seconds')
      WHERE id = ?
    `).run(attemptCount, err.message, backoffSeconds, event.id);

    logger.warn({
      submissionId,
      eventId: event.id,
      attemptCount,
      backoffSeconds,
      err: err.message
    }, 'Immediate outbox dispatch failed; event preserved in SQLite outbox for retry');

    // Offline / fallback processing: If fallback mode enabled or if queue is mocked, execute directly
    if (process.env.CODE_EXECUTION_FALLBACK === 'true' || codeExecutionQueue.mockMode) {
      try {
        await processCodeJob(payload);
        db.prepare(`
          UPDATE outbox_events
          SET status = ?, processed_at = datetime('now')
          WHERE id = ?
        `).run(OUTBOX_STATUS.DISPATCHED, event.id);
        return { dispatched: true, fallbackExecuted: true };
      } catch (fallbackErr) {
        logger.error({ submissionId, err: fallbackErr.message }, 'Fallback direct execution failed');
      }
    }

    return { dispatched: false, error: err.message };
  }
}

/**
 * Dispatch batch of pending outbox events.
 *
 * @param {number} [limit=50]
 * @returns {Promise<{ processed: number, dispatched: number, failed: number }>}
 */
async function dispatchPendingEvents(limit = 50) {
  const events = db.prepare(`
    SELECT * FROM outbox_events
    WHERE status = ? AND available_at <= datetime('now')
    ORDER BY created_at ASC
    LIMIT ?
  `).all(OUTBOX_STATUS.PENDING, limit);

  if (!events.length) {
    return { processed: 0, dispatched: 0, failed: 0 };
  }

  // Quick Redis check before processing batch
  const redisHealth = await testRedisConnection(1500);
  const redisAvailable = redisHealth.connected || codeExecutionQueue.mockMode;

  let dispatchedCount = 0;
  let failedCount = 0;

  for (const event of events) {
    let payload;
    try {
      payload = JSON.parse(event.payload_json);
    } catch (parseErr) {
      db.prepare(`
        UPDATE outbox_events
        SET status = ?, last_error_code = 'CORRUPTED_PAYLOAD', last_error_message = ?, processed_at = datetime('now')
        WHERE id = ?
      `).run(OUTBOX_STATUS.FAILED, parseErr.message, event.id);
      failedCount++;
      continue;
    }

    if (!redisAvailable) {
      // If Redis is not available, check if fallback direct processing is requested
      if (process.env.CODE_EXECUTION_FALLBACK === 'true') {
        try {
          await processCodeJob(payload);
          db.prepare(`
            UPDATE outbox_events
            SET status = ?, processed_at = datetime('now')
            WHERE id = ?
          `).run(OUTBOX_STATUS.DISPATCHED, event.id);
          dispatchedCount++;
          continue;
        } catch (fbErr) {
          logger.error({ eventId: event.id, err: fbErr.message }, 'Direct processing failed in outbox fallback');
        }
      }

      // Schedule backoff
      const nextAttempt = (event.attempt_count || 0) + 1;
      const backoffSecs = Math.min(nextAttempt * 5, 120);
      db.prepare(`
        UPDATE outbox_events
        SET attempt_count = ?,
            last_error_code = 'REDIS_UNAVAILABLE',
            last_error_message = 'Redis ping failed',
            available_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(nextAttempt, backoffSecs, event.id);
      failedCount++;
      continue;
    }

    try {
      const { jobId } = await codeExecutionQueue.enqueueSubmissionJob(payload);

      db.transaction(() => {
        db.prepare(`
          UPDATE outbox_events
          SET status = ?, processed_at = datetime('now')
          WHERE id = ?
        `).run(OUTBOX_STATUS.DISPATCHED, event.id);

        db.prepare(`
          UPDATE coding_submissions
          SET job_id = ?
          WHERE id = ?
        `).run(jobId, event.aggregate_id);
      })();

      dispatchedCount++;
    } catch (dispatchErr) {
      const nextAttempt = (event.attempt_count || 0) + 1;
      const backoffSecs = Math.min(nextAttempt * 5, 120);
      db.prepare(`
        UPDATE outbox_events
        SET attempt_count = ?,
            last_error_code = 'ENQUEUE_FAILED',
            last_error_message = ?,
            available_at = datetime('now', '+' || ? || ' seconds')
        WHERE id = ?
      `).run(nextAttempt, dispatchErr.message, backoffSecs, event.id);
      failedCount++;
    }
  }

  logger.info({
    batchSize: events.length,
    dispatched: dispatchedCount,
    failed: failedCount
  }, 'Completed outbox dispatch sweep');

  return { processed: events.length, dispatched: dispatchedCount, failed: failedCount };
}

/**
 * Drain and process all pending submissions for an attempt (called on final submit).
 * Ensures pending code submissions finish being scored before final exam calculation.
 *
 * @param {number} attemptId
 * @param {number} [timeoutMs=8000]
 */
async function drainAttemptSubmissions(attemptId, timeoutMs = 8000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const pendingSubs = db.prepare(`
      SELECT * FROM coding_submissions
      WHERE attempt_id = ? AND lifecycle_status IN ('QUEUED', 'RUNNING', 'RETRYING')
    `).all(attemptId);

    if (pendingSubs.length === 0) {
      // All submissions for this attempt reached terminal state
      return { success: true, remaining: 0 };
    }

    // Process any uncompleted submissions directly to ensure timely grading
    for (const sub of pendingSubs) {
      try {
        await processCodeJob({
          submissionId: sub.id,
          attemptId: sub.attempt_id,
          questionId: sub.question_id,
          submissionType: 'FINAL'
        });

        // Mark associated outbox event as dispatched if still pending
        db.prepare(`
          UPDATE outbox_events
          SET status = ?, processed_at = datetime('now')
          WHERE aggregate_id = ? AND status = ?
        `).run(OUTBOX_STATUS.DISPATCHED, sub.id, OUTBOX_STATUS.PENDING);
      } catch (err) {
        logger.warn({ submissionId: sub.id, err: err.message }, 'Error in drainAttemptSubmissions processing');
      }
    }

    // Check again
    const remaining = db.prepare(`
      SELECT COUNT(*) as count FROM coding_submissions
      WHERE attempt_id = ? AND lifecycle_status IN ('QUEUED', 'RUNNING', 'RETRYING')
    `).get(attemptId).count;

    if (remaining === 0) {
      return { success: true, remaining: 0 };
    }

    // Brief pause before re-checking
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const finalRemaining = db.prepare(`
    SELECT COUNT(*) as count FROM coding_submissions
    WHERE attempt_id = ? AND lifecycle_status IN ('QUEUED', 'RUNNING', 'RETRYING')
  `).get(attemptId).count;

  return { success: finalRemaining === 0, remaining: finalRemaining };
}

/**
 * Start recurring outbox poller.
 */
function startOutboxPoller(intervalMs = 2000) {
  if (isRunning) return;
  isRunning = true;

  logger.info({ intervalMs }, 'Starting background Outbox Dispatcher loop...');
  loopTimer = setInterval(async () => {
    try {
      await dispatchPendingEvents();
    } catch (err) {
      logger.error({ err: err.message }, 'Unhandled error in outbox dispatch loop');
    }
  }, intervalMs);
}

/**
 * Stop recurring poller.
 */
function stopOutboxPoller() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  isRunning = false;
  logger.info('Outbox Dispatcher loop stopped');
}

// Standalone execution if invoked from command line
if (require.main === module) {
  startOutboxPoller(2000);

  const shutdown = () => {
    logger.info('Outbox dispatcher shutting down...');
    stopOutboxPoller();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  dispatchImmediate,
  dispatchPendingEvents,
  drainAttemptSubmissions,
  startOutboxPoller,
  stopOutboxPoller
};

