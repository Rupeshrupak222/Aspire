// Public student API: register -> attempt -> submit -> certificate.
const express = require('express');
const crypto = require('crypto');
const { db, getConfig } = require('../db');
const judge0 = require('../services/judge0');
const { generateCertificate } = require('../services/certificate');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/async-handler');
const { NotFoundError, ConflictError, AppError } = require('../errors/app-error');
const { registerSchema } = require('../validation/student.schemas');
const { attemptTokenParamSchema, heartbeatSchema, submitSchema, codeExecutionSchema, codeSubmissionParamsSchema } = require('../validation/attempt.schemas');
const { certificateParamSchema } = require('../validation/certificate.schemas');
const { registerLimiter, submitLimiter, certificateLimiter, codeExecutionLimiter } = require('../security/rate-limit');
const examService = require('../services/exam.service');
const shuffleService = require('../services/shuffle.service');
const snapshotService = require('../services/snapshot.service');
const { executionService } = require('../services/code-execution/execution.service');
const outboxDispatcher = require('../workers/outbox-dispatcher');
const {
  SUBMISSION_LIFECYCLE,
  EXECUTION_STATUS,
  OUTBOX_STATUS,
  normalizeLanguage
} = require('../services/code-execution/constants');

const router = express.Router();

/* ---------------- helpers ---------------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
    submitted_at: att.submitted_at,
    student_name: studentName || undefined
  };
}

// Read per-category quotas from config (integers >= 0).
function readQuotas(cfg) {
  const q = (k) => Math.max(0, parseInt(cfg[k], 10) || 0);
  return {
    aptitude: q('quota_aptitude'),
    technical: q('quota_technical'),
    coding: q('quota_coding')
  };
}

function buildAttemptQuestions() {
  const cfg = getConfig();
  const quotas = readQuotas(cfg);
  const codeAllowed = judge0.isConfigured();

  const plan = [
    { category: 'aptitude', type: 'mcq', n: quotas.aptitude },
    { category: 'technical', type: 'mcq', n: quotas.technical }
  ];
  if (codeAllowed && quotas.coding > 0) {
    plan.push({ category: 'coding', type: 'code', n: quotas.coding });
  }

  const selected = [];
  for (const p of plan) {
    if (p.n <= 0) continue;
    const pool = db.prepare("SELECT id FROM questions WHERE category = ? AND type = ? AND (status = 'PUBLISHED' OR status IS NULL)")
      .all(p.category, p.type).map((r) => r.id);
    const ids = cfg.shuffle_questions !== '0' ? shuffle(pool) : pool.slice();
    selected.push(...ids.slice(0, Math.min(p.n, ids.length)));
  }
  if (selected.length === 0) throw new AppError('Question bank is empty — add questions via the admin panel', 500, 'QUESTION_BANK_EMPTY');

  // Interleave categories so the test feels mixed.
  const ordered = cfg.shuffle_questions !== '0' ? shuffle(selected) : selected;

  const doShuffleO = cfg.shuffle_options !== '0';
  const maps = {};
  if (ordered.length) {
    const qs = db.prepare(`SELECT id, type, options_json FROM questions WHERE id IN (${ordered.map(() => '?').join(',')})`).all(...ordered);
    for (const q of qs) {
      if (q.type === 'mcq') {
        const opts = JSON.parse(q.options_json || '[]');
        const idx = opts.map((_, i) => i);
        maps[q.id] = doShuffleO ? shuffle(idx) : idx;
      }
    }
  }
  return { selected: ordered, maps };
}

/* ---------------- routes ---------------- */

// Public test metadata (for the instructions page)
router.get('/config/public', (req, res) => {
  const cfg = getConfig();
  let targetExam = null;

  if (req.query.exam_code) {
    targetExam = examService.getExamByCode(req.query.exam_code);
  } else {
    targetExam = examService.getDefaultPublishedExam();
  }

  const quotas = readQuotas(cfg);
  const codeOn = judge0.isConfigured();
  const qc = codeOn ? quotas.coding : 0;
  const total = quotas.aptitude + quotas.technical + qc;
  const duration = targetExam ? targetExam.duration_minutes : (parseInt(cfg.duration_minutes, 10) || 90);
  const title = targetExam ? targetExam.name : cfg.test_title;

  res.json({
    test_title: title,
    brand_name: cfg.brand_name,
    accent_color: cfg.accent_color,
    duration_minutes: duration,
    question_count: total,
    exam_code: targetExam ? targetExam.code : null,
    quotas: { aptitude: quotas.aptitude, technical: quotas.technical, coding: qc },
    breakdown: `${quotas.aptitude} aptitude · ${quotas.technical} technical · ${qc} coding`,
    code_questions_enabled: codeOn,
    coding_disabled_note: codeOn ? null : 'Coding questions are disabled until Judge0 is configured by the administrator.'
  });
});

// Register a student. Support multi-exam and attempt limits.
router.post('/register', registerLimiter, validate(registerSchema), (req, res, next) => {
  const { name, phone: normPhone, email, college, city, grad_year, track, campaign_code, exam_code, exam_id } = req.body;

  // Resolve target exam (by exam_code, exam_id, or default active published exam)
  let targetExam = null;
  if (exam_code) {
    targetExam = examService.getExamByCode(exam_code);
    if (!targetExam) {
      return res.status(404).json({
        success: false,
        error: 'EXAM_NOT_FOUND',
        code: 'EXAM_NOT_FOUND',
        message: `Exam with code "${exam_code}" was not found or is not active.`
      });
    }
  } else if (exam_id) {
    try {
      targetExam = examService.getExamById(exam_id);
    } catch {}
  }

  if (!targetExam) {
    targetExam = examService.getDefaultPublishedExam();
  }

  // Validate exam availability status
  if (targetExam) {
    if (targetExam.status === 'CLOSED') {
      return res.status(409).json({
        success: false,
        error: 'EXAM_CLOSED',
        code: 'EXAM_CLOSED',
        message: 'This exam is closed for new attempts.'
      });
    }
    if (targetExam.status === 'ARCHIVED') {
      return res.status(409).json({
        success: false,
        error: 'EXAM_CLOSED',
        code: 'EXAM_CLOSED',
        message: 'This exam has been archived and cannot accept new attempts.'
      });
    }
    if (targetExam.status !== 'PUBLISHED' && targetExam.status !== 'LIVE') {
      return res.status(409).json({
        success: false,
        error: 'EXAM_NOT_LIVE',
        code: 'EXAM_NOT_LIVE',
        message: 'This exam is not currently active for candidate attempts.'
      });
    }
  }

  const targetExamId = targetExam ? targetExam.id : null;
  const maxAttempts = targetExam ? (targetExam.max_attempts || 1) : 1;

  // Check existing student and attempts
  const student = db.prepare('SELECT * FROM students WHERE phone = ?').get(normPhone);
  if (student) {
    // Check in-progress attempt for this exam
    const ongoingAtt = db.prepare(`
      SELECT * FROM attempts
      WHERE student_id = ? AND (exam_id = ? OR exam_id IS NULL) AND status = 'started' AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).get(student.id, targetExamId);

    if (ongoingAtt) {
      // Resume an in-progress attempt
      const cfg = getConfig();
      return res.json({
        token: ongoingAtt.token,
        resumed: true,
        expires_at: ongoingAtt.expires_at,
        test_title: targetExam ? targetExam.name : cfg.test_title
      });
    }

    // Check attempt quota
    const countRow = db.prepare(`
      SELECT count(*) as c FROM attempts
      WHERE student_id = ? AND (exam_id = ? OR exam_id IS NULL)
    `).get(student.id, targetExamId);

    if (countRow && countRow.c >= maxAttempts) {
      return res.status(409).json({
        success: false,
        error: 'ALREADY_ATTEMPTED',
        code: 'ALREADY_ATTEMPTED',
        message: 'This phone number has already been used for the test. One attempt per student.'
      });
    }
  }

  const cfg = getConfig();
  const codeAllowed = judge0.isConfigured();

  let selected, maps, frozenQuestions = null, examSnapshot = null, shuffleSeed = null, shuffleMap = null, snapshotHash = null;
  let durationMin = targetExam ? targetExam.duration_minutes : (parseInt(cfg.duration_minutes, 10) || 90);

  try {
    if (targetExam) {
      const generated = examService.generateExamAttemptQuestions(targetExam.id, codeAllowed);
      selected = generated.orderedIds;
      maps = generated.shuffleMaps;
      shuffleSeed = generated.shuffleSeed;
      shuffleMap = generated.shuffleMap;
      frozenQuestions = generated.frozenQuestions;
      examSnapshot = generated.examSnapshot;
      snapshotHash = generated.snapshotHash;
      durationMin = generated.durationMinutes;
    } else {
      ({ selected, maps } = buildAttemptQuestions());
    }
  } catch (e) {
    return next(e);
  }

  // Transactionally register student and attempt with frozen snapshots
  const executeRegistration = db.transaction(() => {
    let studentId;
    if (student) {
      studentId = student.id;
      // Update any updated contact details
      db.prepare(`
        UPDATE students SET name = ?, email = COALESCE(?, email), college = COALESCE(?, college),
                            city = COALESCE(?, city), grad_year = COALESCE(?, grad_year),
                            track = COALESCE(?, track), campaign_code = COALESCE(?, campaign_code)
        WHERE id = ?
      `).run(name, email || null, college || null, city || null, grad_year || null, track || null, campaign_code || null, studentId);
    } else {
      const ins = db.prepare(`INSERT INTO students
        (name, phone, email, college, city, grad_year, track, campaign_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const s = ins.run(
        name, normPhone,
        email || null, college || null,
        city || null, grad_year || null,
        track || null, campaign_code || null
      );
      studentId = s.lastInsertRowid;
    }

    const token = randHex(24);
    const expires_at = new Date(Date.now() + durationMin * 60000).toISOString();
    const assignedOrgId = targetExam ? targetExam.organization_id : null;
    db.prepare(`
      INSERT INTO attempts (
        token, student_id, exam_id, exam_version, organization_id, expires_at,
        question_ids_json, shuffle_map_json, exam_snapshot_json, questions_snapshot_json,
        shuffle_seed, snapshot_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token,
      studentId,
      targetExamId,
      targetExam ? targetExam.version : 1,
      assignedOrgId,
      expires_at,
      JSON.stringify(selected),
      JSON.stringify(shuffleMap || maps),
      examSnapshot ? JSON.stringify(examSnapshot) : null,
      frozenQuestions ? JSON.stringify(frozenQuestions) : null,
      shuffleSeed || null,
      snapshotHash || null
    );

    return { token, expires_at, durationMin };
  });

  try {
    const result = executeRegistration();
    res.json({
      token: result.token,
      resumed: false,
      expires_at: result.expires_at,
      duration_minutes: result.durationMin,
      question_count: selected.length,
      test_title: targetExam ? targetExam.name : cfg.test_title
    });
  } catch (err) {
    if (err && err.message && err.message.includes('UNIQUE constraint failed: students.phone')) {
      return res.status(409).json({
        success: false,
        error: 'ALREADY_ATTEMPTED',
        code: 'ALREADY_ATTEMPTED',
        message: 'This phone number has already been used for the test. One attempt per student.'
      });
    }
    next(err);
  }
});

// Fetch attempt + questions (answers and test cases are NEVER sent)
router.get('/attempt/:token', validate({ params: attemptTokenParamSchema }), (req, res, next) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return next(new NotFoundError('Attempt not found'));

  // Snapshot integrity check
  try {
    snapshotService.verifySnapshotIntegrity(att);
  } catch (err) {
    return next(err);
  }

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(att.student_id);
  const cfg = getConfig();

  let testTitle = cfg.test_title;
  let durationMinutes = parseInt(cfg.duration_minutes, 10) || 90;
  let examSnap = null;
  if (att.exam_snapshot_json) {
    try {
      examSnap = JSON.parse(att.exam_snapshot_json);
      if (examSnap && examSnap.name) testTitle = examSnap.name;
      if (examSnap && examSnap.duration_minutes) durationMinutes = examSnap.duration_minutes;
    } catch {}
  }

  let questions = [];

  // 1. Prefer frozen questions snapshot (guarantees historical assessment integrity)
  if (att.questions_snapshot_json) {
    try {
      const frozen = JSON.parse(att.questions_snapshot_json);
      if (Array.isArray(frozen) && frozen.length > 0) {
        questions = snapshotService.sanitizeCandidateQuestions(frozen);
      }
    } catch {}
  }

  // 2. Fallback to live questions table for legacy attempts without snapshot
  if (!questions.length) {
    const qids = JSON.parse(att.question_ids_json || '[]');
    const maps = JSON.parse(att.shuffle_map_json || '{}');
    if (qids.length) {
      const qs = db.prepare(`SELECT id, type, category, question_text, options_json, marks, code_starter
                             FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`).all(...qids);
      const byId = new Map(qs.map((q) => [q.id, q]));
      questions = qids.map((qid) => {
        const q = byId.get(qid);
        if (!q) return null;
        const out = { id: q.id, type: q.type, category: q.category, question_text: q.question_text, marks: q.marks };
        if (q.type === 'mcq') {
          const opts = JSON.parse(q.options_json || '[]');
          const map = maps[q.id] || opts.map((_, i) => i);
          out.options = map.map((i) => opts[i]);
        } else {
          out.code_starter = q.code_starter || '';
        }
        return out;
      }).filter(Boolean);
    }
  }

  const payload = {
    test_title: testTitle,
    brand_name: cfg.brand_name,
    student_name: student ? student.name : '',
    status: att.status,
    expires_at: att.expires_at,
    duration_minutes: durationMinutes,
    tab_switches: att.tab_switches,
    questions
  };
  if (att.status === 'submitted') Object.assign(payload, resultSummary(att, student ? student.name : ''));
  res.json(payload);
});

// Heartbeat: persist tab-switch count during the test
router.post('/attempt/:token/heartbeat', validate({ params: attemptTokenParamSchema, body: heartbeatSchema }), (req, res, next) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return next(new NotFoundError('Attempt not found'));
  if (att.status !== 'started') return res.json({ ok: true });
  const n = parseInt(req.body && req.body.tabSwitches, 10);
  if (Number.isFinite(n) && n > att.tab_switches) {
    db.prepare('UPDATE attempts SET tab_switches = ? WHERE id = ?').run(n, att.id);
  }
  res.json({ ok: true });
});

// Run candidate code against public/sample test cases only (interactive IDE feedback)
router.post('/attempt/:token/code-run', codeExecutionLimiter, validate({ params: attemptTokenParamSchema, body: codeExecutionSchema }), asyncHandler(async (req, res, next) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return next(new NotFoundError('Attempt not found'));

  // Snapshot integrity check
  try {
    snapshotService.verifySnapshotIntegrity(att);
  } catch (err) {
    return next(err);
  }

  const { questionId, language, sourceCode } = req.body;
  const result = await executionService.runCandidateCode({
    attempt: att,
    questionId,
    language,
    sourceCode
  });

  res.json({
    success: true,
    data: result
  });
}));

// Submit candidate code for a specific question (evaluates all test cases, records in DB)
router.post('/attempt/:token/code-submit', codeExecutionLimiter, validate({ params: attemptTokenParamSchema, body: codeExecutionSchema }), asyncHandler(async (req, res, next) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return next(new NotFoundError('Attempt not found'));

  // Snapshot integrity check
  try {
    snapshotService.verifySnapshotIntegrity(att);
  } catch (err) {
    return next(err);
  }

  const { questionId, language, sourceCode } = req.body;

  // Backwards compatibility for synchronous execution when explicitly requested
  const isSync = req.query.sync === 'true' || req.body.sync === true || process.env.CODE_EXECUTION_SYNC === 'true';
  if (isSync) {
    const result = await executionService.submitCandidateCode({
      attempt: att,
      questionId,
      language,
      sourceCode,
      requestId: req.id
    });

    return res.json({
      success: true,
      data: result
    });
  }

  // --- Asynchronous Execution Flow (Day 10) ---
  if (att.status === 'submitted') {
    throw new ConflictError('This assessment has already been submitted', 'ATTEMPT_ALREADY_SUBMITTED');
  }
  if (att.status !== 'started') {
    throw new ConflictError(`Attempt is in status '${att.status}' and cannot accept submissions`, 'ATTEMPT_NOT_ACTIVE');
  }
  const expiresAt = new Date(att.expires_at).getTime();
  if (Date.now() > expiresAt) {
    throw new ConflictError('Assessment duration has expired', 'ATTEMPT_EXPIRED');
  }

  const question = executionService._resolveQuestionFromAttempt(att, questionId);
  if (question.type !== 'code') {
    throw new ValidationError('Question is not a coding question', 'INVALID_QUESTION_TYPE');
  }

  executionService.validateSourceCode(sourceCode);
  const canonicalLang = normalizeLanguage(language);
  const sourceHash = crypto.createHash('sha256').update(sourceCode || '').digest('hex');

  // Idempotency check: Return existing completed/queued submission if submitted within last 15s with identical code
  const recent = db.prepare(`
    SELECT * FROM coding_submissions
    WHERE attempt_id = ? AND question_id = ? AND language = ? AND source_hash = ?
      AND submission_status NOT IN ('SYSTEM_ERROR', 'PROVIDER_ERROR')
      AND created_at >= datetime('now', '-15 seconds')
    ORDER BY created_at DESC LIMIT 1
  `).get(att.id, question.id, canonicalLang, sourceHash);

  if (recent) {
    const isDone = recent.lifecycle_status === SUBMISSION_LIFECYCLE.COMPLETED;
    return res.status(isDone ? 200 : 202).json({
      success: true,
      submissionId: recent.id,
      status: recent.lifecycle_status,
      verdict: recent.submission_status,
      statusUrl: `/api/attempt/${req.params.token}/code-submissions/${recent.id}`,
      retryAfterMs: 1500,
      idempotent: true
    });
  }

  const submissionId = 'csub_' + crypto.randomBytes(12).toString('hex');
  const outboxId = 'outbox_' + crypto.randomBytes(12).toString('hex');
  const providerName = executionService.getActiveProvider().name;

  // Atomic SQLite Transaction: Insert durable submission record + outbox event
  const persistJob = db.transaction(() => {
    db.prepare(`
      INSERT INTO coding_submissions (
        id, attempt_id, question_id, organization_id, language,
        submission_status, lifecycle_status, provider, job_id, source_hash, source_code,
        queued_at, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0)
    `).run(
      submissionId,
      att.id,
      question.id,
      att.organization_id || null,
      canonicalLang,
      EXECUTION_STATUS.PENDING,
      SUBMISSION_LIFECYCLE.QUEUED,
      providerName,
      submissionId,
      sourceHash,
      sourceCode
    );

    db.prepare(`
      INSERT INTO outbox_events (
        id, event_type, aggregate_id, payload_json, status, attempt_count, available_at
      ) VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(
      outboxId,
      'CODE_EXECUTION_REQUESTED',
      submissionId,
      JSON.stringify({
        submissionId,
        attemptId: att.id,
        questionId: question.id,
        submissionType: 'FINAL'
      }),
      OUTBOX_STATUS.PENDING
    );
  });

  persistJob();

  // Trigger immediate dispatch (non-blocking)
  outboxDispatcher.dispatchImmediate(submissionId).catch((err) => {
    req.log?.warn?.({ submissionId, err: err.message }, 'Failed immediate outbox dispatch');
  });

  res.status(202).json({
    success: true,
    submissionId,
    status: SUBMISSION_LIFECYCLE.QUEUED,
    statusUrl: `/api/attempt/${req.params.token}/code-submissions/${submissionId}`,
    retryAfterMs: 1500
  });
}));

// Poll status of an asynchronous coding submission
router.get('/attempt/:token/code-submissions/:submissionId', validate({ params: codeSubmissionParamsSchema }), asyncHandler(async (req, res, next) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return next(new NotFoundError('Attempt not found'));

  // Snapshot integrity check
  try {
    snapshotService.verifySnapshotIntegrity(att);
  } catch (err) {
    return next(err);
  }

  const sub = db.prepare(`
    SELECT * FROM coding_submissions
    WHERE id = ? AND attempt_id = ?
  `).get(req.params.submissionId, att.id);

  if (!sub) {
    return next(new NotFoundError('Submission not found'));
  }

  let marks = 1;
  try {
    const question = executionService._resolveQuestionFromAttempt(att, sub.question_id);
    marks = question.marks || 1;
  } catch {}

  const isPending = sub.lifecycle_status === SUBMISSION_LIFECYCLE.QUEUED ||
                    sub.lifecycle_status === SUBMISSION_LIFECYCLE.RUNNING ||
                    sub.lifecycle_status === SUBMISSION_LIFECYCLE.RETRYING;

  const payload = {
    success: true,
    submissionId: sub.id,
    status: sub.lifecycle_status,
    verdict: sub.submission_status,
    language: sub.language,
    testsPassed: sub.test_cases_passed,
    testsTotal: sub.test_cases_total,
    score: sub.score,
    marks,
    executionTimeMs: sub.execution_time_ms,
    error: sub.error_message,
    createdAt: sub.created_at,
    queuedAt: sub.queued_at,
    startedAt: sub.started_at,
    completedAt: sub.completed_at
  };

  if (isPending) {
    payload.retryAfterMs = 1500;
  }

  res.json(payload);
}));

// Submit + grade (idempotent + concurrency locked)
router.post('/attempt/:token/submit', submitLimiter, validate({ params: attemptTokenParamSchema, body: submitSchema }), asyncHandler(async (req, res, next) => {
  const att = db.prepare('SELECT * FROM attempts WHERE token = ?').get(req.params.token);
  if (!att) return next(new NotFoundError('Attempt not found'));

  // Snapshot integrity check
  try {
    snapshotService.verifySnapshotIntegrity(att);
  } catch (err) {
    return next(err);
  }

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(att.student_id);
  if (att.status === 'submitted') return res.json(resultSummary(att, student ? student.name : ''));

  // Drain and wait for any pending in-flight coding submissions for this attempt
  try {
    await outboxDispatcher.drainAttemptSubmissions(att.id, 8000);
  } catch {}

  // Atomic state lock: transitions 'started' -> 'grading'
  const lock = db.prepare("UPDATE attempts SET status = 'grading' WHERE id = ? AND status = 'started'").run(att.id);
  if (lock.changes === 0) {
    // Another concurrent submission already acquired the grading lock or completed
    const current = db.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
    return res.json(resultSummary(current, student ? student.name : ''));
  }

  const body = req.body || {};
  const answers = body.answers || {};
  const codeAnswers = body.codeAnswers || {};
  if (typeof body.tabSwitches === 'number' && body.tabSwitches > att.tab_switches) {
    db.prepare('UPDATE attempts SET tab_switches = ? WHERE id = ?').run(Math.floor(body.tabSwitches), att.id);
  }

  const cfg = getConfig();
  const qids = JSON.parse(att.question_ids_json || '[]');
  const maps = JSON.parse(att.shuffle_map_json || '{}');

  // Load questions: prefer frozen questions snapshot if present
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
    const qs = db.prepare(`SELECT * FROM questions WHERE id IN (${qids.map(() => '?').join(',')})`).all(...qids);
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
      // 1. Authoritative check: Look up completed coding submission from coding_submissions
      const sub = db.prepare(`
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

  // Determine scholarship: use exam's frozen slabs if available
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

  const was_late = Date.now() > new Date(att.expires_at).getTime() ? 1 : 0;
  const certificate_id = 'ASP26-' + randHex(4).toUpperCase();
  const claim_code = 'ASP-' + randAlnum(6);

  db.prepare(`UPDATE attempts SET status='submitted', submitted_at=datetime('now'),
    answers_json=?, code_answers_json=?, score=?, total_marks=?, percentage=?,
    scholarship_pct=?, certificate_id=?, claim_code=?, was_late=?, graded_detail_json=?
    WHERE id=?`).run(
    JSON.stringify(answers), JSON.stringify(codeAnswers), score, total, percentage,
    scholarship_pct, certificate_id, claim_code, was_late, JSON.stringify(detail), att.id
  );

  const updated = db.prepare('SELECT * FROM attempts WHERE id = ?').get(att.id);
  const summary = resultSummary(updated, student ? student.name : '');
  summary.detail = detail;
  res.json(summary);
}));

// Download the branded PDF certificate
router.get('/certificate/:certificateId', certificateLimiter, validate({ params: certificateParamSchema }), asyncHandler(async (req, res, next) => {
  const att = db.prepare(`SELECT a.*, s.name AS student_name FROM attempts a
                          JOIN students s ON s.id = a.student_id
                          WHERE a.certificate_id = ? AND a.status = 'submitted'`).get(req.params.certificateId);
  if (!att) return next(new NotFoundError('Certificate not found'));
  const cfg = getConfig();
  try {
    const pdf = await generateCertificate({
      name: att.student_name,
      percentage: att.percentage,
      scholarshipPct: att.scholarship_pct,
      certificateId: att.certificate_id,
      dateStr: new Date(att.submitted_at + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      brandName: cfg.brand_name || 'Adyapan'
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${att.certificate_id}.pdf"`);
    res.send(pdf);
  } catch (e) {
    next(new AppError('Failed to generate certificate', 500, 'CERTIFICATE_GENERATION_FAILED'));
  }
}));

module.exports = router;
