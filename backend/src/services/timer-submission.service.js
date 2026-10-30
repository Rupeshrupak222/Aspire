// Timer Integrity, Server-Authoritative Deadlines & Atomic Assessment Submission (Day 13)
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const crypto = require('crypto');
const { db, getConfig } = require('../db');
const { ConflictError, NotFoundError, ValidationError, AppError } = require('../errors/app-error');
const logger = require('../utils/logger');
const snapshotService = require('./snapshot.service');
const shuffleService = require('./shuffle.service');
const judge0 = require('./judge0');
const outboxDispatcher = require('../workers/outbox-dispatcher');
const { recordAuditEvent } = require('./audit.service');

const randHex = (n) => crypto.randomBytes(n).toString('hex');
const randAlnum = (n) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
};

function tierFor(percentage, slabsJson) {
  let slabs;
  try {
    slabs = JSON.parse(slabsJson);
    if (!Array.isArray(slabs) || slabs.length === 0) throw new Error('bad slabs');
  } catch {
    slabs = [
      { min: 90, scholarship: 100 },
      { min: 75, scholarship: 50 },
      { min: 60, scholarship: 25 },
      { min: 40, scholarship: 10 },
      { min: 0, scholarship: 0 }
    ];
  }
  const sorted = slabs.slice().sort((a, b) => b.min - a.min);
  for (const s of sorted) {
    if (percentage >= s.min) return s.scholarship;
  }
  return 0;
}

function resultSummary(att, studentName) {
  return {
    status: att.status,
    score: att.score,
    total_marks: att.total_marks,
    percentage: att.percentage,
    scholarship_pct: att.scholarship_pct,
    certificate_id: att.certificate_id,
    claim_code: att.claim_code,
    was_late: !!att.was_late,
    tab_switches: att.tab_switches,
    proctoring_risk_score: att.proctoring_risk_score ?? 0,
    proctoring_risk_level: att.proctoring_risk_level || 'NORMAL',
    submitted_at: att.submitted_at,
    finalization_status: att.finalization_status || 'FINALIZED',
    student_name: studentName || undefined
  };
}

/**
 * Calculates authoritative server deadline including configured grace period.
 * deadline = startedAt + durationMinutes + gracePeriodSeconds
 */
function calculateAuthoritativeDeadline(startedAtDate, durationMinutes, gracePeriodSeconds = 60) {
  const startMs = new Date(startedAtDate).getTime();
  const durMs = Math.max(1, durationMinutes) * 60 * 1000;
  const graceMs = Math.max(0, gracePeriodSeconds) * 1000;
  return new Date(startMs + durMs + graceMs).toISOString();
}

/**
 * Returns effective deadline considering both deadline_at and legacy expires_at overrides.
 */
function getEffectiveDeadline(attempt) {
  if (!attempt) return { deadlineStr: new Date().toISOString(), deadlineMs: Date.now() };

  const deadlineMs = attempt.deadline_at ? new Date(attempt.deadline_at).getTime() : null;
  const expiresMs = attempt.expires_at ? new Date(attempt.expires_at).getTime() : null;

  // If expires_at was explicitly backdated earlier than deadline_at (e.g. in tests)
  if (deadlineMs && expiresMs && expiresMs < deadlineMs - 10000) {
    return { deadlineStr: attempt.expires_at, deadlineMs: expiresMs };
  }

  const effectiveStr = attempt.deadline_at || attempt.expires_at || new Date().toISOString();
  return { deadlineStr: effectiveStr, deadlineMs: new Date(effectiveStr).getTime() };
}

/**
 * Derives authoritative timing for an attempt relative to server clock.
 */
function getAuthoritativeTiming(attempt, serverNowMs = Date.now()) {
  if (!attempt) throw new NotFoundError('Attempt not found');

  const startMs = new Date(attempt.started_at || Date.now()).getTime();
  const graceSec = attempt.grace_period_seconds !== undefined ? Number(attempt.grace_period_seconds) : 60;
  const { deadlineStr, deadlineMs } = getEffectiveDeadline(attempt);

  const remainingSeconds = Math.max(0, Math.floor((deadlineMs - serverNowMs) / 1000));
  const isExpired = serverNowMs > deadlineMs;

  return {
    serverTime: new Date(serverNowMs).toISOString(),
    startedAt: attempt.started_at,
    deadlineAt: deadlineStr,
    expiresAt: attempt.expires_at,
    gracePeriodSeconds: graceSec,
    remainingSeconds,
    isExpired,
    status: attempt.status,
    finalizationStatus: attempt.finalization_status || 'PENDING'
  };
}

/**
 * Checks whether an attempt has exceeded its authoritative deadline.
 */
function isAttemptExpired(attempt, serverNowMs = Date.now()) {
  if (!attempt) return true;
  const { deadlineMs } = getEffectiveDeadline(attempt);
  return serverNowMs > deadlineMs;
}

/**
 * Atomically submits and grades an assessment attempt with strict idempotency,
 * concurrency locking, snapshot HMAC verification, and grace-period boundary checks.
 */
async function atomicSubmitAttempt(attemptToken, options = {}) {
  const targetDb = options.db || db;
  const body = options.body || {};
  const req = options.req || null;
  const isAutoFinalize = Boolean(options.autoFinalize);

  // 1. Fetch attempt and student
  const att = targetDb.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
  if (!att) throw new NotFoundError('Attempt not found');

  // Verify Snapshot HMAC Integrity
  snapshotService.verifySnapshotIntegrity(att);

  const student = targetDb.prepare('SELECT * FROM students WHERE id = ?').get(att.student_id);

  // 2. Already Submitted: Idempotent Return
  if (att.status === 'submitted') {
    return resultSummary(att, student ? student.name : '');
  }

  // 3. Concurrency Lock: Transition 'started' -> 'grading'
  // Ensures only 1 concurrent execution thread grades this attempt
  const subId = body.submissionId || body.idempotencyKey || (`sub_${att.id}_${crypto.randomBytes(8).toString('hex')}`);

  const lockCondition = isAutoFinalize ? "status IN ('started', 'grading')" : "status = 'started'";
  const lockRes = targetDb.prepare(`
    UPDATE attempts SET
      status = 'grading',
      finalization_status = 'FINALIZING',
      submission_id = COALESCE(submission_id, ?)
    WHERE id = ? AND ${lockCondition}
  `).run(subId, att.id);

  if (lockRes.changes === 0) {
    // Another request already acquired grading lock or completed submission
    // Poll up to 6000ms for concurrent grading to finish
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const current = targetDb.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
      if (current.status === 'submitted') {
        return resultSummary(current, student ? student.name : '');
      }
    }
    const current = targetDb.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
    if (current.status === 'submitted') {
      return resultSummary(current, student ? student.name : '');
    }
    // If still stuck in grading after 3 seconds, take over lock
    const takeover = targetDb.prepare(`
      UPDATE attempts SET
        status = 'grading',
        finalization_status = 'FINALIZING',
        submission_id = COALESCE(submission_id, ?)
      WHERE id = ? AND status = 'grading'
    `).run(subId, att.id);
    if (takeover.changes === 0) {
      const finalCheck = targetDb.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
      return resultSummary(finalCheck, student ? student.name : '');
    }
  }

  try {
    // 4. Drain any in-flight asynchronous coding submissions (Day 10 BullMQ coordination)
    // Done without holding an open SQLite write transaction so workers can write without lock contention
    try {
      await outboxDispatcher.drainAttemptSubmissions(att.id, 8000);
    } catch (drainErr) {
      logger.warn({ attemptId: att.id, err: drainErr.message }, 'Notice during drainAttemptSubmissions');
    }

    // 5. Authoritative Expiration & Grace Period Boundary Check
    const serverNowMs = Date.now();
    const { deadlineMs } = getEffectiveDeadline(att);
    const isLate = serverNowMs > deadlineMs;

    // Answer selection:
    // If NOT late: merge saved answers with submitted body answers
    // If LATE: strictly IGNORE late body answers; evaluate ONLY pre-saved answers
    let savedAnswers = {};
    try {
      savedAnswers = att.answers_json ? JSON.parse(att.answers_json) : {};
    } catch {}

    let answers = {};
    if (isLate) {
      answers = savedAnswers;
    } else {
      answers = { ...savedAnswers, ...(body.answers || {}) };
    }

    const codeAnswers = isLate ? {} : (body.codeAnswers || {});

    if (typeof body.tabSwitches === 'number' && body.tabSwitches > att.tab_switches) {
      targetDb.prepare('UPDATE attempts SET tab_switches = ? WHERE id = ?').run(Math.floor(body.tabSwitches), att.id);
    }

    const cfg = getConfig(targetDb);
    const qids = JSON.parse(att.question_ids_json || '[]');
    const maps = JSON.parse(att.shuffle_map_json || '{}');

    // Load questions from frozen snapshot
    let frozenList = null;
    if (att.questions_snapshot_json) {
      try {
        const parsed = JSON.parse(att.questions_snapshot_json);
        if (Array.isArray(parsed) && parsed.length > 0) frozenList = parsed;
      } catch {}
    }

    const qmap = new Map();
    if (frozenList) {
      for (const q of frozenList) qmap.set(q.id, q);
    } else if (qids.length) {
      const qs = targetDb.prepare(`SELECT * FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`).all(...qids);
      for (const q of qs) qmap.set(q.id, q);
    }

    let score = 0, total = 0;
    const detail = [];

    for (const qid of qids) {
      const q = qmap.get(qid);
      if (!q) continue;
      total += q.marks;
      let earned = 0;

      if (q.type === 'mcq') {
        const sel = answers[qid] ?? answers[String(qid)];
        if (sel !== undefined && sel !== null && sel !== '') {
          const optMap = (maps.options ? (maps.options[qid] || maps.options[String(qid)]) : null) || maps[qid] || maps[String(qid)];
          const origIdx = shuffleService.reverseOptionIndex(sel, optMap);
          if (origIdx === q.correct_index) {
            earned = q.marks;
          } else if (q.negative_marks) {
            earned = -Math.abs(q.negative_marks);
          }
        }
        detail.push({ id: q.id, category: q.category, type: 'mcq', marks: q.marks, earned });
      } else {
        // Authoritative check: Look up completed coding submission from coding_submissions
        const sub = targetDb.prepare(`
          SELECT * FROM coding_submissions
          WHERE attempt_id = ? AND question_id = ? AND lifecycle_status = 'COMPLETED'
          ORDER BY score DESC, completed_at DESC LIMIT 1
        `).get(att.id, q.id);

        if (sub) {
          earned = sub.score;
          detail.push({
            id: q.id,
            category: q.category,
            type: 'code',
            marks: q.marks,
            earned: sub.score,
            passed: sub.test_cases_passed,
            total: sub.test_cases_total,
            error: sub.error_message || null
          });
        } else {
          const src = (codeAnswers[qid] ?? codeAnswers[String(qid)] ?? '').toString();
          const tcs = q.test_cases || (q.test_cases_json ? JSON.parse(q.test_cases_json) : []);
          if (src.trim() && judge0.isConfigured() && tcs.length) {
            const g = await judge0.gradeCodeQuestion({ source_code: src, language_id: q.language_id || 71, test_cases: tcs });
            earned = Math.round((q.marks * (g.total ? g.passed / g.total : 0)) * 100) / 100;
            detail.push({ id: q.id, category: q.category, type: 'code', marks: q.marks, earned, passed: g.passed, total: g.total, error: g.error || null });
          } else {
            detail.push({ id: q.id, category: q.category, type: 'code', marks: q.marks, earned: 0, passed: 0, total: tcs.length, error: src.trim() ? 'no_completed_submission' : 'no_answer' });
          }
        }
      }
      score += earned;
    }

    score = Math.round(score * 100) / 100;
    const percentage = total > 0 ? Math.round((score / total) * 1000) / 10 : 0;

    // Determine scholarship percentage
    let scholarship_pct = 0;
    let customSlabs = null;
    if (att.exam_snapshot_json) {
      try {
        const snap = JSON.parse(att.exam_snapshot_json);
        if (Array.isArray(snap.scholarship_slabs) && snap.scholarship_slabs.length > 0) {
          customSlabs = snap.scholarship_slabs;
        }
      } catch {}
    }

    if (customSlabs) {
      const sorted = customSlabs.slice().sort((a, b) => b.min_score_pct - a.min_score_pct);
      for (const s of sorted) {
        if (percentage >= s.min_score_pct) {
          scholarship_pct = s.discount_pct;
          break;
        }
      }
    } else {
      scholarship_pct = tierFor(percentage, cfg.scholarship_slabs);
    }

    const was_late = isLate ? 1 : 0;
    const finalized_by = isAutoFinalize ? 'AUTO_TIMEOUT' : (isLate ? 'AUTO_TIMEOUT' : 'CANDIDATE');

    // 6. Atomic Finalization Commit Transaction
    const commitTx = targetDb.transaction(() => {
      // Re-read attempt within transaction to check certificate idempotency
      const existingAtt = targetDb.prepare('SELECT certificate_id, claim_code FROM attempts WHERE id = ?').get(att.id);
      const certificate_id = existingAtt.certificate_id || ('ASP26-' + randHex(4).toUpperCase());
      const claim_code = existingAtt.claim_code || ('ASP-' + randAlnum(6));

      targetDb.prepare(`
        UPDATE attempts SET
          status = 'submitted',
          finalization_status = 'FINALIZED',
          finalized_by = ?,
          submitted_at = COALESCE(submitted_at, datetime('now')),
          answers_json = ?,
          code_answers_json = ?,
          score = ?,
          total_marks = ?,
          percentage = ?,
          scholarship_pct = ?,
          certificate_id = ?,
          claim_code = ?,
          was_late = ?,
          graded_detail_json = ?
        WHERE id = ?
      `).run(
        finalized_by,
        JSON.stringify(answers),
        JSON.stringify(codeAnswers),
        score,
        total,
        percentage,
        scholarship_pct,
        certificate_id,
        claim_code,
        was_late,
        JSON.stringify(detail),
        att.id
      );

      return { certificate_id, claim_code };
    });

    commitTx();

    if (req) {
      recordAuditEvent({
        req,
        event: 'exam_submitted',
        details: { attemptId: att.id, score, total, percentage, scholarship_pct, was_late, finalized_by }
      });
    }

    const finalRow = targetDb.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
    const summary = resultSummary(finalRow, student ? student.name : '');
    summary.detail = detail;
    return summary;

  } catch (err) {
    // If error occurs, revert status back to 'started' so attempt can retry
    logger.error({ attemptId: att.id, err: err.message }, 'Failed during attempt grading finalization');
    targetDb.prepare(`
      UPDATE attempts SET status = 'started', finalization_status = 'FAILED' WHERE id = ? AND status = 'grading'
    `).run(att.id);
    throw err;
  }
}

/**
 * Reconciles expired but unfinalized attempts (e.g. after server restart or candidate abandonment).
 * Finds attempts where deadline + gracePeriod has elapsed and finalizes them using authoritative saved answers.
 */
async function reconcileExpiredAttempts(options = {}) {
  const targetDb = options.db || db;
  const limit = options.limit || 50;

  let query = `
    SELECT token, id, expires_at, deadline_at, status FROM attempts
    WHERE status IN ('started', 'grading')
      AND datetime('now') > datetime(COALESCE(deadline_at, expires_at))
  `;
  const params = [];

  if (options.token) {
    query += ' AND token = ?';
    params.push(options.token);
  }

  query += ' ORDER BY expires_at DESC LIMIT ?';
  params.push(limit);

  const expiredAttempts = targetDb.prepare(query).all(...params);

  let reconciledCount = 0;
  for (const exp of expiredAttempts) {
    try {
      await atomicSubmitAttempt(exp.token, {
        db: targetDb,
        autoFinalize: true,
        body: { autoFinalize: true }
      });
      reconciledCount++;
    } catch (e) {
      logger.warn({ attemptId: exp.id, err: e.message }, 'Failed reconciling expired attempt');
      if (e.code === 'SNAPSHOT_INTEGRITY_COMPROMISED') {
        targetDb.prepare(`
          UPDATE attempts SET status = 'abandoned', finalization_status = 'FAILED' WHERE id = ?
        `).run(exp.id);
      }
    }
  }

  return { reconciledCount, totalFound: expiredAttempts.length };
}

module.exports = {
  calculateAuthoritativeDeadline,
  getEffectiveDeadline,
  getAuthoritativeTiming,
  isAttemptExpired,
  atomicSubmitAttempt,
  reconcileExpiredAttempts,
  resultSummary
};
