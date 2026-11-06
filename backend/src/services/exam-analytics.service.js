// ============================================================================
// ASPIRE DAY 19: EXAM ANALYTICS SERVICE
// ============================================================================
// Authoritative SQL aggregations and statistical analysis for exam-level insights,
// candidate funnels, question psychometrics (Kelley's discrimination index D),
// asynchronous coding submission analytics, and performance distributions.
// Uses simple-statistics for statistical computations.
// Multi-tenant isolation is strictly enforced at the database layer.
// ============================================================================

const ss = require('simple-statistics');
const { db } = require('../db');
const { NotFoundError, ValidationError, AuthorizationError } = require('../errors/app-error');

/**
 * Standard difficulty thresholds based on candidate accuracy.
 */
const DIFFICULTY_THRESHOLDS = Object.freeze({
  VERY_EASY: 85,
  EASY: 70,
  MODERATE: 40,
  DIFFICULT: 20
});

/**
 * Minimum sample size required to compute a statistically meaningful discrimination index.
 */
const MIN_DISCRIMINATION_SAMPLE_SIZE = 10;

/**
 * Upper and lower percentile ratio for Kelley's method (standard 27%).
 */
const KELLEY_PERCENTILE_RATIO = 0.27;

/**
 * Verifies that the exam exists and belongs to the given organization.
 * Fails closed with NotFoundError if missing or if tenant mismatch occurs.
 */
function assertExamAccess(examId, organizationId, isSuperAdmin = false) {
  if (!examId) throw new ValidationError('examId is required');

  const exam = db.prepare(`
    SELECT id, organization_id, name, code, status, duration_minutes,
           passing_score, total_marks, max_attempts, created_at, published_at
    FROM exams
    WHERE id = ?
  `).get(examId);

  if (!exam) {
    throw new NotFoundError('Exam not found');
  }

  if (!isSuperAdmin) {
    if (!organizationId || exam.organization_id !== organizationId) {
      throw new NotFoundError('Exam not found');
    }
  }

  return exam;
}

/**
 * Resolves optional date range filtering for attempts.
 */
function buildDateFilter(filters = {}, prefix = 'a.') {
  const clauses = [];
  const params = [];

  if (filters.period && filters.period !== 'all') {
    const now = Date.now();
    let startMs = null;
    let endMs = now;

    if (filters.period === 'today') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      startMs = today.getTime();
    } else if (filters.period === '7d') {
      startMs = now - 7 * 24 * 60 * 60 * 1000;
    } else if (filters.period === '30d') {
      startMs = now - 30 * 24 * 60 * 60 * 1000;
    } else if (filters.period === '90d') {
      startMs = now - 90 * 24 * 60 * 60 * 1000;
    } else if (filters.period === 'custom') {
      if (filters.start_date) startMs = new Date(filters.start_date).getTime();
      if (filters.end_date) endMs = new Date(filters.end_date).getTime();
    }

    if (startMs !== null) {
      clauses.push(`${prefix}started_at >= ?`);
      params.push(new Date(startMs).toISOString());
    }
    if (endMs !== null) {
      clauses.push(`${prefix}started_at <= ?`);
      params.push(new Date(endMs).toISOString());
    }
  }

  return {
    clause: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    params
  };
}

/**
 * Classifies difficulty from numerical correct accuracy rate.
 */
function classifyDifficulty(accuracyPercentage) {
  if (accuracyPercentage >= DIFFICULTY_THRESHOLDS.VERY_EASY) return 'VERY_EASY';
  if (accuracyPercentage >= DIFFICULTY_THRESHOLDS.EASY) return 'EASY';
  if (accuracyPercentage >= DIFFICULTY_THRESHOLDS.MODERATE) return 'MODERATE';
  if (accuracyPercentage >= DIFFICULTY_THRESHOLDS.DIFFICULT) return 'DIFFICULT';
  return 'VERY_DIFFICULT';
}

/**
 * Evaluates item discrimination index rating.
 */
function rateDiscrimination(d) {
  if (d === null || d === undefined) return 'INSUFFICIENT_DATA';
  if (d >= 0.40) return 'EXCELLENT';
  if (d >= 0.30) return 'GOOD';
  if (d >= 0.20) return 'ACCEPTABLE';
  if (d >= 0.00) return 'POOR';
  return 'NEGATIVE';
}

/**
 * 1. Overview Analytics (KPIs + Candidate Funnel)
 */
function getExamOverview(examId, organizationId, filters = {}, isSuperAdmin = false) {
  const exam = assertExamAccess(examId, organizationId, isSuperAdmin);
  const passingScore = exam.passing_score !== null && exam.passing_score !== undefined ? exam.passing_score : 40;
  const dateFilter = buildDateFilter(filters, 'a.');

  // Base scope for attempts
  const tenantFilter = isSuperAdmin ? '' : 'AND a.organization_id = ?';
  const tenantParams = isSuperAdmin ? [] : [organizationId];

  // Unique Candidates and Funnel metrics
  const candidateCounts = db.prepare(`
    SELECT
      COUNT(DISTINCT a.student_id) AS registered_count,
      COUNT(DISTINCT CASE WHEN a.status != 'registered' AND a.started_at IS NOT NULL THEN a.student_id END) AS started_count,
      COUNT(DISTINCT CASE WHEN a.status = 'submitted' AND a.finalization_status = 'FINALIZED' THEN a.student_id END) AS completed_count,
      COUNT(DISTINCT CASE WHEN a.status = 'submitted' AND a.finalization_status = 'FINALIZED' AND a.percentage >= ? THEN a.student_id END) AS passed_count,
      COUNT(DISTINCT CASE WHEN a.status = 'submitted' AND a.finalization_status = 'FINALIZED' AND a.percentage < ? THEN a.student_id END) AS failed_count,
      COUNT(DISTINCT CASE
        WHEN a.status = 'abandoned'
          OR (a.status = 'started' AND datetime('now') > datetime(COALESCE(a.deadline_at, a.expires_at)))
        THEN a.student_id
      END) AS abandoned_count,
      COUNT(DISTINCT CASE
        WHEN a.status = 'started' AND datetime('now') <= datetime(COALESCE(a.deadline_at, a.expires_at))
        THEN a.student_id
      END) AS in_progress_count,
      COUNT(a.id) AS total_attempts,
      COUNT(CASE WHEN a.status = 'submitted' AND a.finalization_status = 'FINALIZED' THEN a.id END) AS completed_attempts,
      COUNT(CASE WHEN a.status = 'submitted' AND a.finalization_status = 'FINALIZED' AND a.scholarship_pct > 0 THEN a.id END) AS scholarships_awarded
    FROM attempts a
    WHERE a.exam_id = ? ${tenantFilter} ${dateFilter.clause}
  `).get(passingScore, passingScore, exam.id, ...tenantParams, ...dateFilter.params) || {
    registered_count: 0,
    started_count: 0,
    completed_count: 0,
    passed_count: 0,
    failed_count: 0,
    abandoned_count: 0,
    in_progress_count: 0,
    total_attempts: 0,
    completed_attempts: 0,
    scholarships_awarded: 0
  };

  // Completed attempts score metrics
  const completedAttempts = db.prepare(`
    SELECT a.percentage, a.started_at, a.submitted_at
    FROM attempts a
    WHERE a.exam_id = ?
      AND a.status = 'submitted'
      AND a.finalization_status = 'FINALIZED'
      ${tenantFilter}
      ${dateFilter.clause}
    ORDER BY a.percentage ASC
  `).all(exam.id, ...tenantParams, ...dateFilter.params);

  let averageScore = 0;
  let medianScore = null;
  let highestScore = null;
  let lowestScore = null;
  let averageDurationMinutes = null;

  if (completedAttempts.length > 0) {
    const percentages = completedAttempts.map(a => a.percentage);
    averageScore = Math.round(ss.mean(percentages) * 10) / 10;
    medianScore = Math.round(ss.median(percentages) * 10) / 10;
    highestScore = Math.max(...percentages);
    lowestScore = Math.min(...percentages);

    const validDurations = completedAttempts
      .filter(a => a.started_at && a.submitted_at)
      .map(a => (new Date(a.submitted_at).getTime() - new Date(a.started_at).getTime()) / 60000)
      .filter(d => d >= 0);

    if (validDurations.length > 0) {
      averageDurationMinutes = Math.round(ss.mean(validDurations) * 10) / 10;
    }
  }

  const registered = candidateCounts.registered_count || 0;
  const started = candidateCounts.started_count || 0;
  const completed = candidateCounts.completed_count || 0;
  const passed = candidateCounts.passed_count || 0;
  const failed = candidateCounts.failed_count || 0;
  const abandoned = candidateCounts.abandoned_count || 0;
  const inProgress = candidateCounts.in_progress_count || 0;

  const registrationToStartRate = registered > 0 ? Math.round((started / registered) * 1000) / 10 : 0;
  const startToCompletionRate = started > 0 ? Math.round((completed / started) * 1000) / 10 : 0;
  const passRate = completed > 0 ? Math.round((passed / completed) * 1000) / 10 : 0;
  const failRate = completed > 0 ? Math.round((failed / completed) * 1000) / 10 : 0;
  const abandonmentRate = started > 0 ? Math.round((abandoned / started) * 1000) / 10 : 0;

  const funnel = [
    {
      stage: 'Registered',
      count: registered,
      conversionRate: 100,
      dropOff: Math.max(0, registered - started),
      dropOffRate: registered > 0 ? Math.round(((registered - started) / registered) * 1000) / 10 : 0
    },
    {
      stage: 'Started',
      count: started,
      conversionRate: registrationToStartRate,
      dropOff: Math.max(0, started - completed),
      dropOffRate: started > 0 ? Math.round(((started - completed) / started) * 1000) / 10 : 0
    },
    {
      stage: 'Completed',
      count: completed,
      conversionRate: startToCompletionRate,
      dropOff: 0,
      dropOffRate: 0
    },
    {
      stage: 'Passed',
      count: passed,
      conversionRate: passRate,
      dropOff: failed,
      dropOffRate: failRate
    }
  ];

  return {
    exam: {
      id: exam.id,
      name: exam.name,
      code: exam.code,
      status: exam.status,
      duration_minutes: exam.duration_minutes,
      total_marks: exam.total_marks,
      passing_score: passingScore,
      max_attempts: exam.max_attempts,
      organization_id: exam.organization_id,
      published_at: exam.published_at,
      created_at: exam.created_at
    },
    kpis: {
      registered,
      started,
      completed,
      abandoned,
      inProgress,
      passed,
      failed,
      passRate,
      failRate,
      completionRate: startToCompletionRate,
      abandonmentRate,
      averageScore,
      medianScore,
      highestScore,
      lowestScore,
      averageDurationMinutes,
      scholarshipsAwarded: candidateCounts.scholarships_awarded || 0,
      totalAttempts: candidateCounts.total_attempts || 0,
      completedAttempts: candidateCounts.completed_attempts || 0
    },
    funnel
  };
}

/**
 * 2. Candidate Funnel & Candidate List Details
 */
function getExamCandidates(examId, organizationId, filters = {}, isSuperAdmin = false) {
  const overview = getExamOverview(examId, organizationId, filters, isSuperAdmin);
  const exam = overview.exam;
  const passingScore = exam.passing_score;
  const tenantFilter = isSuperAdmin ? '' : 'AND a.organization_id = ?';
  const tenantParams = isSuperAdmin ? [] : [organizationId];
  const dateFilter = buildDateFilter(filters, 'a.');

  // Retake metrics
  const retakeStats = db.prepare(`
    SELECT
      COUNT(DISTINCT student_id) as total_students,
      COUNT(id) as total_attempts,
      COUNT(DISTINCT CASE WHEN attempt_count > 1 THEN student_id END) as multiple_attempt_students,
      MAX(attempt_count) as max_attempts_single_student
    FROM (
      SELECT student_id, id, COUNT(*) OVER (PARTITION BY student_id) as attempt_count
      FROM attempts a
      WHERE a.exam_id = ? ${tenantFilter} ${dateFilter.clause}
    )
  `).get(exam.id, ...tenantParams, ...dateFilter.params) || {};

  const totalStudents = retakeStats.total_students || 0;
  const totalAttempts = retakeStats.total_attempts || 0;
  const multipleAttemptStudents = retakeStats.multiple_attempt_students || 0;
  const maxAttempts = retakeStats.max_attempts_single_student || 1;
  const averageAttemptsPerCandidate = totalStudents > 0 ? Math.round((totalAttempts / totalStudents) * 10) / 10 : 0;

  // Pagination and filtering for candidate table
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const candidateWhere = ['a.exam_id = ?'];
  const candidateParams = [exam.id];

  if (!isSuperAdmin) {
    candidateWhere.push('a.organization_id = ?');
    candidateParams.push(organizationId);
  }

  if (filters.search) {
    candidateWhere.push('(s.name LIKE ? OR s.email LIKE ? OR s.college LIKE ?)');
    const term = `%${filters.search.trim()}%`;
    candidateParams.push(term, term, term);
  }

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'started') {
      candidateWhere.push("a.status = 'started'");
    } else if (filters.status === 'submitted') {
      candidateWhere.push("a.status = 'submitted' AND a.finalization_status = 'FINALIZED'");
    } else if (filters.status === 'in_progress') {
      candidateWhere.push("a.status = 'started' AND datetime('now') <= datetime(COALESCE(a.deadline_at, a.expires_at))");
    } else if (filters.status === 'abandoned') {
      candidateWhere.push("(a.status = 'abandoned' OR (a.status = 'started' AND datetime('now') > datetime(COALESCE(a.deadline_at, a.expires_at))))");
    } else if (filters.status === 'passed') {
      candidateWhere.push("a.status = 'submitted' AND a.finalization_status = 'FINALIZED' AND a.percentage >= ?");
      candidateParams.push(passingScore);
    } else if (filters.status === 'failed') {
      candidateWhere.push("a.status = 'submitted' AND a.finalization_status = 'FINALIZED' AND a.percentage < ?");
      candidateParams.push(passingScore);
    }
  }

  const whereClause = candidateWhere.join(' AND ');

  const countRow = db.prepare(`
    SELECT COUNT(DISTINCT a.student_id) as total
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE ${whereClause}
  `).get(...candidateParams);

  const totalCandidates = countRow ? countRow.total : 0;

  const orderMap = {
    score_desc: 'best_percentage DESC NULLS LAST',
    score_asc: 'best_percentage ASC NULLS LAST',
    name_asc: 's.name ASC',
    name_desc: 's.name DESC',
    submitted_desc: 'last_submitted_at DESC NULLS LAST',
    submitted_asc: 'last_submitted_at ASC NULLS LAST',
    started_desc: 'first_started_at DESC NULLS LAST'
  };
  const orderBy = orderMap[filters.sort] || orderMap.score_desc;

  const candidateRows = db.prepare(`
    SELECT
      s.id as student_id,
      s.name,
      s.email,
      s.college,
      COUNT(a.id) as attempt_count,
      MAX(a.score) as best_score,
      MAX(a.total_marks) as total_marks,
      MAX(a.percentage) as best_percentage,
      MAX(a.scholarship_pct) as scholarship_pct,
      MIN(a.started_at) as first_started_at,
      MAX(a.submitted_at) as last_submitted_at,
      (
        SELECT a2.status FROM attempts a2
        WHERE a2.student_id = s.id AND a2.exam_id = a.exam_id
        ORDER BY a2.id DESC LIMIT 1
      ) as latest_status,
      (
        SELECT a2.finalization_status FROM attempts a2
        WHERE a2.student_id = s.id AND a2.exam_id = a.exam_id
        ORDER BY a2.id DESC LIMIT 1
      ) as finalization_status
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE ${whereClause}
    GROUP BY s.id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...candidateParams, limit, offset);

  const candidates = candidateRows.map(row => {
    const passed = row.best_percentage !== null && row.best_percentage >= passingScore;
    return {
      student_id: row.student_id,
      name: row.name,
      email: row.email,
      college: row.college,
      attemptCount: row.attempt_count,
      latestStatus: row.latest_status,
      finalizationStatus: row.finalization_status || 'PENDING',
      score: row.best_score,
      totalMarks: row.total_marks,
      percentage: row.best_percentage,
      scholarshipPct: row.scholarship_pct || 0,
      passed,
      firstStartedAt: row.first_started_at,
      lastSubmittedAt: row.last_submitted_at
    };
  });

  return {
    summary: {
      registered: overview.kpis.registered,
      started: overview.kpis.started,
      completed: overview.kpis.completed,
      abandoned: overview.kpis.abandoned,
      inProgress: overview.kpis.inProgress,
      passed: overview.kpis.passed,
      failed: overview.kpis.failed,
      uniqueCandidates: totalStudents,
      totalAttempts,
      multipleAttemptCandidates: multipleAttemptStudents,
      maxAttemptsBySingleCandidate: maxAttempts,
      averageAttemptsPerCandidate
    },
    funnel: overview.funnel,
    candidates,
    pagination: {
      page,
      limit,
      total: totalCandidates,
      totalPages: Math.ceil(totalCandidates / limit) || 1
    }
  };
}

/**
 * Helper to retrieve all question IDs and metadata associated with an exam.
 */
function getExamQuestionsList(examId) {
  // 1. Questions explicitly mapped in manual sections
  const manualQuestions = db.prepare(`
    SELECT
      q.id,
      q.title,
      q.question_text,
      q.type,
      q.marks,
      q.category,
      q.difficulty,
      q.options_json,
      q.correct_index,
      es.id as section_id,
      es.name as section_name,
      es.display_order as section_order,
      esq.display_order as question_order
    FROM exam_sections es
    JOIN exam_section_questions esq ON esq.section_id = es.id
    JOIN questions q ON q.id = esq.question_id
    WHERE es.exam_id = ?
    ORDER BY es.display_order ASC, esq.display_order ASC
  `).all(examId);

  const questionMap = new Map();
  for (const q of manualQuestions) {
    questionMap.set(q.id, q);
  }

  // 2. Questions evaluated in attempts (handles rule-based selection)
  const attemptRows = db.prepare(`
    SELECT question_ids_json, questions_snapshot_json
    FROM attempts
    WHERE exam_id = ? AND (question_ids_json IS NOT NULL OR questions_snapshot_json IS NOT NULL)
  `).all(examId);

  const missingQids = new Set();
  for (const row of attemptRows) {
    if (row.questions_snapshot_json) {
      try {
        const snap = JSON.parse(row.questions_snapshot_json);
        if (Array.isArray(snap)) {
          for (const sq of snap) {
            if (!questionMap.has(sq.id)) {
              questionMap.set(sq.id, {
                id: sq.id,
                title: sq.title || `Question #${sq.id}`,
                question_text: sq.question_text || '',
                type: sq.type || 'mcq',
                marks: sq.marks || 1,
                category: sq.category || 'general',
                difficulty: sq.difficulty || 'medium',
                options_json: sq.options_json || (sq.options ? JSON.stringify(sq.options) : '[]'),
                correct_index: sq.correct_index ?? null,
                section_id: null,
                section_name: sq.category || 'General',
                section_order: 1,
                question_order: sq.id
              });
            }
          }
        }
      } catch {}
    }

    if (row.question_ids_json) {
      try {
        const ids = JSON.parse(row.question_ids_json);
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (!questionMap.has(id)) missingQids.add(id);
          }
        }
      } catch {}
    }
  }

  if (missingQids.size > 0) {
    const ids = Array.from(missingQids);
    const qs = db.prepare(`
      SELECT id, title, question_text, type, marks, category, difficulty, options_json, correct_index
      FROM questions
      WHERE id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);

    for (const q of qs) {
      questionMap.set(q.id, {
        ...q,
        section_id: null,
        section_name: q.category || 'General',
        section_order: 1,
        question_order: q.id
      });
    }
  }

  return Array.from(questionMap.values());
}

/**
 * 3. Question-Level Analytics
 */
function getExamQuestions(examId, organizationId, filters = {}, isSuperAdmin = false) {
  const exam = assertExamAccess(examId, organizationId, isSuperAdmin);
  const questionsList = getExamQuestionsList(exam.id);

  const tenantFilter = isSuperAdmin ? '' : 'AND a.organization_id = ?';
  const tenantParams = isSuperAdmin ? [] : [organizationId];

  // Retrieve finalized attempts sorted by score descending for Upper/Lower Group calculation
  const completedAttempts = db.prepare(`
    SELECT id, percentage, graded_detail_json, answers_json, code_answers_json
    FROM attempts a
    WHERE a.exam_id = ?
      AND a.status = 'submitted'
      AND a.finalization_status = 'FINALIZED'
      ${tenantFilter}
    ORDER BY a.percentage DESC
  `).all(exam.id, ...tenantParams);

  const N = completedAttempts.length;
  const k = Math.max(1, Math.round(N * KELLEY_PERCENTILE_RATIO));
  const hasSufficientSample = (N >= MIN_DISCRIMINATION_SAMPLE_SIZE);

  // Initialize statistics container for each question
  const statsMap = new Map();
  for (const q of questionsList) {
    statsMap.set(q.id, {
      questionId: q.id,
      title: q.title || (q.question_text ? q.question_text.substring(0, 80) : `Question #${q.id}`),
      questionText: q.question_text || '',
      type: q.type || 'mcq',
      marks: q.marks || 1,
      category: q.category || 'general',
      sectionId: q.section_id,
      sectionName: q.section_name || 'General',
      sectionOrder: q.section_order || 1,
      questionOrder: q.question_order || q.id,
      totalEligibleAttempts: 0,
      answeredCount: 0,
      unansweredCount: 0,
      correctCount: 0,
      wrongCount: 0,
      upperCorrect: 0,
      lowerCorrect: 0,
      upperTotal: 0,
      lowerTotal: 0,
      timeDurations: []
    });
  }

  // Iterate over completed attempts once (O(N * Q))
  for (let i = 0; i < completedAttempts.length; i++) {
    const att = completedAttempts[i];
    const isUpper = hasSufficientSample && (i < k);
    const isLower = hasSufficientSample && (i >= N - k);

    let detail = [];
    try {
      detail = JSON.parse(att.graded_detail_json || '[]');
    } catch {}

    let answers = {};
    try {
      answers = JSON.parse(att.answers_json || '{}');
    } catch {}

    let codeAnswers = {};
    try {
      codeAnswers = JSON.parse(att.code_answers_json || '{}');
    } catch {}

    for (const item of detail) {
      const qid = item.id;
      let stat = statsMap.get(qid);
      if (!stat) {
        // Handle question present in attempt snapshot but not yet in map
        stat = {
          questionId: qid,
          title: `Question #${qid}`,
          questionText: '',
          type: item.type || 'mcq',
          marks: item.marks || 1,
          category: item.category || 'general',
          sectionId: null,
          sectionName: item.category || 'General',
          sectionOrder: 1,
          questionOrder: qid,
          totalEligibleAttempts: 0,
          answeredCount: 0,
          unansweredCount: 0,
          correctCount: 0,
          wrongCount: 0,
          upperCorrect: 0,
          lowerCorrect: 0,
          upperTotal: 0,
          lowerTotal: 0,
          timeDurations: []
        };
        statsMap.set(qid, stat);
      }

      stat.totalEligibleAttempts++;
      if (isUpper) stat.upperTotal++;
      if (isLower) stat.lowerTotal++;

      let isAnswered = false;
      let isCorrect = false;

      if (stat.type === 'mcq') {
        const sel = answers[qid] ?? answers[String(qid)];
        isAnswered = (sel !== undefined && sel !== null && sel !== '');
        if (isAnswered) {
          isCorrect = (item.earned >= stat.marks);
        }
      } else {
        const src = (codeAnswers[qid] ?? codeAnswers[String(qid)] ?? '').toString();
        isAnswered = src.trim().length > 0 || (item.error !== 'no_answer');
        if (isAnswered) {
          isCorrect = (item.earned >= stat.marks) || (item.passed && item.total && item.passed === item.total);
        }
      }

      if (isAnswered) {
        stat.answeredCount++;
        if (isCorrect) {
          stat.correctCount++;
          if (isUpper) stat.upperCorrect++;
          if (isLower) stat.lowerCorrect++;
        } else {
          stat.wrongCount++;
        }
      } else {
        stat.unansweredCount++;
      }

      if (item.time_spent_seconds !== undefined && item.time_spent_seconds !== null) {
        stat.timeDurations.push(Number(item.time_spent_seconds));
      }
    }
  }

  // Calculate percentages, difficulty, discrimination index, and timing for each question
  let analyzedQuestions = Array.from(statsMap.values()).map((s, idx) => {
    const eligible = s.totalEligibleAttempts;
    const answered = s.answeredCount;
    const unanswered = s.unansweredCount;
    const correct = s.correctCount;
    const wrong = s.wrongCount;

    const overallAccuracy = eligible > 0 ? Math.round((correct / eligible) * 1000) / 10 : 0;
    const correctPercentage = answered > 0 ? Math.round((correct / answered) * 1000) / 10 : 0;
    const wrongPercentage = answered > 0 ? Math.round((wrong / answered) * 1000) / 10 : 0;
    const unansweredPercentage = eligible > 0 ? Math.round((unanswered / eligible) * 1000) / 10 : 0;

    // Psychometric difficulty classification
    const difficulty = classifyDifficulty(overallAccuracy);

    // Kelley's Discrimination Index (D = P_upper - P_lower)
    let discriminationIndex = null;
    let sampleSizeInsufficient = true;
    let discriminationRating = 'INSUFFICIENT_DATA';

    if (hasSufficientSample && s.upperTotal > 0 && s.lowerTotal > 0) {
      const pUpper = s.upperCorrect / s.upperTotal;
      const pLower = s.lowerCorrect / s.lowerTotal;
      discriminationIndex = Math.round((pUpper - pLower) * 100) / 100;
      sampleSizeInsufficient = false;
      discriminationRating = rateDiscrimination(discriminationIndex);
    }

    // Question timing
    let averageTimeSeconds = null;
    let medianTimeSeconds = null;
    let hasTimingData = false;

    if (s.timeDurations.length > 0) {
      hasTimingData = true;
      averageTimeSeconds = Math.round(ss.mean(s.timeDurations) * 10) / 10;
      medianTimeSeconds = Math.round(ss.median(s.timeDurations) * 10) / 10;
    }

    return {
      questionId: s.questionId,
      questionNumber: idx + 1,
      sectionId: s.sectionId,
      sectionName: s.sectionName,
      type: s.type,
      title: s.title,
      marks: s.marks,
      category: s.category,
      totalEligibleAttempts: eligible,
      answeredCount: answered,
      unansweredCount: unanswered,
      correctCount: correct,
      wrongCount: wrong,
      correctPercentage,
      wrongPercentage,
      unansweredPercentage,
      overallAccuracy,
      averageTimeSeconds,
      medianTimeSeconds,
      hasTimingData,
      difficulty,
      difficultyScore: overallAccuracy,
      discriminationIndex,
      discriminationRating,
      sampleSize: N,
      sampleSizeInsufficient
    };
  });

  // Apply filters
  if (filters.type && filters.type !== 'all') {
    analyzedQuestions = analyzedQuestions.filter(q => q.type === filters.type);
  }

  if (filters.difficulty && filters.difficulty !== 'all') {
    analyzedQuestions = analyzedQuestions.filter(q => q.difficulty === filters.difficulty);
  }

  if (filters.category) {
    analyzedQuestions = analyzedQuestions.filter(q => q.category.toLowerCase() === filters.category.toLowerCase());
  }

  if (filters.search) {
    const term = filters.search.toLowerCase().trim();
    analyzedQuestions = analyzedQuestions.filter(q => q.title.toLowerCase().includes(term));
  }

  // Apply sorting
  if (filters.sort === 'accuracy_asc') {
    analyzedQuestions.sort((a, b) => a.overallAccuracy - b.overallAccuracy);
  } else if (filters.sort === 'accuracy_desc') {
    analyzedQuestions.sort((a, b) => b.overallAccuracy - a.overallAccuracy);
  } else if (filters.sort === 'discrimination_desc') {
    analyzedQuestions.sort((a, b) => (b.discriminationIndex ?? -999) - (a.discriminationIndex ?? -999));
  } else if (filters.sort === 'discrimination_asc') {
    analyzedQuestions.sort((a, b) => (a.discriminationIndex ?? 999) - (b.discriminationIndex ?? 999));
  } else if (filters.sort === 'marks_desc') {
    analyzedQuestions.sort((a, b) => b.marks - a.marks);
  } else {
    // order_asc
    analyzedQuestions.sort((a, b) => a.questionNumber - b.questionNumber);
  }

  return {
    totalQuestions: analyzedQuestions.length,
    sampleSize: N,
    sampleSizeInsufficient: !hasSufficientSample,
    minimumSampleRequired: MIN_DISCRIMINATION_SAMPLE_SIZE,
    questions: analyzedQuestions
  };
}

/**
 * 4. Detailed Single Question Analytics
 */
function getQuestionDetail(examId, questionId, organizationId, isSuperAdmin = false) {
  const exam = assertExamAccess(examId, organizationId, isSuperAdmin);
  const qid = parseInt(questionId, 10);
  if (isNaN(qid)) throw new ValidationError('Invalid questionId');

  // Verify question exists in question bank or attempt history
  const q = db.prepare(`
    SELECT id, title, question_text, type, marks, category, difficulty, options_json, correct_index, language_id
    FROM questions WHERE id = ?
  `).get(qid);

  if (!q) {
    throw new NotFoundError('Question not found');
  }

  // Get question stats across the exam
  const allQuestionsData = getExamQuestions(exam.id, organizationId, {}, isSuperAdmin);
  const questionStat = allQuestionsData.questions.find(item => item.questionId === qid);

  if (!questionStat) {
    throw new NotFoundError('Question does not belong to this exam');
  }

  const tenantFilter = isSuperAdmin ? '' : 'AND a.organization_id = ?';
  const tenantParams = isSuperAdmin ? [] : [organizationId];

  let optionsBreakdown = null;
  let codingBreakdown = null;

  if (q.type === 'mcq') {
    // Option selection breakdown
    let options = [];
    try {
      options = JSON.parse(q.options_json || '[]');
    } catch {}

    const optionCounts = new Map();
    for (let i = 0; i < options.length; i++) {
      optionCounts.set(i, 0);
    }

    const attempts = db.prepare(`
      SELECT answers_json, shuffle_map_json
      FROM attempts a
      WHERE a.exam_id = ?
        AND a.status = 'submitted'
        AND a.finalization_status = 'FINALIZED'
        ${tenantFilter}
    `).all(exam.id, ...tenantParams);

    for (const att of attempts) {
      let answers = {};
      try { answers = JSON.parse(att.answers_json || '{}'); } catch {}
      let maps = {};
      try { maps = JSON.parse(att.shuffle_map_json || '{}'); } catch {}

      const sel = answers[qid] ?? answers[String(qid)];
      if (sel !== undefined && sel !== null && sel !== '') {
        const optMap = (maps.options ? (maps.options[qid] || maps.options[String(qid)]) : null) || maps[qid] || maps[String(qid)];
        // Resolve original index using inverse shuffle mapping
        let origIdx = sel;
        if (optMap && Array.isArray(optMap)) {
          origIdx = optMap.indexOf(sel);
          if (origIdx === -1) origIdx = sel;
        }
        optionCounts.set(origIdx, (optionCounts.get(origIdx) || 0) + 1);
      }
    }

    const totalAnswered = questionStat.answeredCount;
    optionsBreakdown = options.map((optText, idx) => {
      const count = optionCounts.get(idx) || 0;
      const percentage = totalAnswered > 0 ? Math.round((count / totalAnswered) * 1000) / 10 : 0;
      return {
        index: idx,
        text: optText,
        count,
        percentage,
        isCorrect: (idx === q.correct_index)
      };
    });
  } else if (q.type === 'code') {
    // Coding submission outcomes
    const subs = db.prepare(`
      SELECT
        cs.submission_status,
        cs.lifecycle_status,
        cs.last_error_code,
        cs.test_cases_passed,
        cs.test_cases_total,
        cs.execution_time_ms,
        cs.score,
        a.student_id
      FROM coding_submissions cs
      JOIN attempts a ON a.id = cs.attempt_id
      WHERE a.exam_id = ? AND cs.question_id = ?
        ${tenantFilter}
    `).all(exam.id, qid, ...tenantParams);

    const totalSubmissions = subs.length;
    const uniqueStudents = new Set(subs.map(s => s.student_id)).size;
    let accepted = 0;
    let compilationFailures = 0;
    let runtimeFailures = 0;
    let timeouts = 0;
    let providerFailures = 0;
    let pending = 0;
    let totalTcPassed = 0;
    let totalTcEvaluated = 0;
    const validExecTimes = [];
    const validScores = [];

    for (const s of subs) {
      if (s.lifecycle_status === 'QUEUED' || s.lifecycle_status === 'RUNNING') {
        pending++;
      } else if (
        s.last_error_code === 'PROVIDER_UNAVAILABLE' ||
        s.last_error_code === 'PROVIDER_ERROR' ||
        s.submission_status === 'PROVIDER_ERROR'
      ) {
        providerFailures++;
      } else if (s.submission_status === 'COMPILATION_ERROR') {
        compilationFailures++;
      } else if (s.submission_status === 'RUNTIME_ERROR') {
        runtimeFailures++;
      } else if (s.submission_status === 'TIME_LIMIT_EXCEEDED') {
        timeouts++;
      } else if (s.submission_status === 'ACCEPTED') {
        accepted++;
      }

      if (s.test_cases_total !== null && s.test_cases_total > 0) {
        totalTcEvaluated += s.test_cases_total;
        totalTcPassed += (s.test_cases_passed || 0);
      }

      if (s.execution_time_ms !== null && s.execution_time_ms >= 0) {
        validExecTimes.push(s.execution_time_ms);
      }

      if (s.score !== null && s.score !== undefined) {
        validScores.push(s.score);
      }
    }

    const testCasePassRate = totalTcEvaluated > 0 ? Math.round((totalTcPassed / totalTcEvaluated) * 1000) / 10 : 0;
    const averageExecutionTimeMs = validExecTimes.length > 0 ? Math.round(ss.mean(validExecTimes) * 10) / 10 : null;
    const averageScore = validScores.length > 0 ? Math.round(ss.mean(validScores) * 10) / 10 : 0;

    codingBreakdown = {
      totalSubmissions,
      uniqueCandidates: uniqueStudents,
      acceptedCount: accepted,
      compilationFailures,
      runtimeFailures,
      timeouts,
      providerFailures,
      pendingCount: pending,
      testCasesEvaluated: totalTcEvaluated,
      testCasesPassed: totalTcPassed,
      testCasePassRate,
      averageExecutionTimeMs,
      averageScore
    };
  }

  return {
    question: {
      id: q.id,
      title: q.title,
      questionText: q.question_text,
      type: q.type,
      marks: q.marks,
      category: q.category,
      difficulty: q.difficulty
    },
    stats: questionStat,
    optionsBreakdown,
    codingBreakdown
  };
}

/**
 * 5. Coding Questions & Execution Architecture Analytics
 */
function getExamCodingAnalytics(examId, organizationId, filters = {}, isSuperAdmin = false) {
  const exam = assertExamAccess(examId, organizationId, isSuperAdmin);
  const tenantFilter = isSuperAdmin ? '' : 'AND a.organization_id = ?';
  const tenantParams = isSuperAdmin ? [] : [organizationId];
  const dateFilter = buildDateFilter(filters, 'cs.');

  // Aggregated coding metrics
  const subs = db.prepare(`
    SELECT
      cs.id,
      cs.question_id,
      cs.language,
      cs.submission_status,
      cs.lifecycle_status,
      cs.last_error_code,
      cs.test_cases_passed,
      cs.test_cases_total,
      cs.execution_time_ms,
      cs.score,
      a.student_id,
      q.title as question_title,
      q.marks as question_marks
    FROM coding_submissions cs
    JOIN attempts a ON a.id = cs.attempt_id
    JOIN questions q ON q.id = cs.question_id
    WHERE a.exam_id = ?
      ${tenantFilter}
      ${dateFilter.clause}
  `).all(exam.id, ...tenantParams, ...dateFilter.params);

  const totalCodingSubmissions = subs.length;
  const uniqueCandidates = new Set(subs.map(s => s.student_id)).size;

  let successfulExecutions = 0;
  let compilationFailures = 0;
  let runtimeFailures = 0;
  let timeouts = 0;
  let providerFailures = 0;
  let pendingSubmissions = 0;
  let partiallyPassed = 0;
  let wrongAnswerZeroPassed = 0;
  let testCasesEvaluated = 0;
  let testCasesPassed = 0;

  const validExecTimes = [];
  const languageCounts = new Map();
  const perQuestionMap = new Map();

  for (const s of subs) {
    // Language breakdown
    const lang = (s.language || 'unknown').toLowerCase();
    languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);

    // Per question container
    if (!perQuestionMap.has(s.question_id)) {
      perQuestionMap.set(s.question_id, {
        questionId: s.question_id,
        title: s.question_title,
        marks: s.question_marks,
        submissionsCount: 0,
        candidateIds: new Set(),
        acceptedCount: 0,
        compilationFailures: 0,
        runtimeFailures: 0,
        timeouts: 0,
        providerFailures: 0,
        testCasesEvaluated: 0,
        testCasesPassed: 0,
        scores: []
      });
    }

    const qStats = perQuestionMap.get(s.question_id);
    qStats.submissionsCount++;
    qStats.candidateIds.add(s.student_id);

    // Submission outcomes
    if (s.lifecycle_status === 'QUEUED' || s.lifecycle_status === 'RUNNING') {
      pendingSubmissions++;
    } else if (
      s.last_error_code === 'PROVIDER_UNAVAILABLE' ||
      s.last_error_code === 'PROVIDER_ERROR' ||
      s.submission_status === 'PROVIDER_ERROR'
    ) {
      providerFailures++;
      qStats.providerFailures++;
    } else if (s.submission_status === 'COMPILATION_ERROR') {
      compilationFailures++;
      qStats.compilationFailures++;
    } else if (s.submission_status === 'RUNTIME_ERROR') {
      runtimeFailures++;
      qStats.runtimeFailures++;
    } else if (s.submission_status === 'TIME_LIMIT_EXCEEDED') {
      timeouts++;
      qStats.timeouts++;
    } else if (s.submission_status === 'ACCEPTED') {
      successfulExecutions++;
      qStats.acceptedCount++;
    } else if (s.submission_status === 'WRONG_ANSWER') {
      if (s.test_cases_passed > 0) {
        partiallyPassed++;
      } else {
        wrongAnswerZeroPassed++;
      }
    }

    if (s.test_cases_total !== null && s.test_cases_total > 0) {
      testCasesEvaluated += s.test_cases_total;
      testCasesPassed += (s.test_cases_passed || 0);
      qStats.testCasesEvaluated += s.test_cases_total;
      qStats.testCasesPassed += (s.test_cases_passed || 0);
    }

    if (s.execution_time_ms !== null && s.execution_time_ms >= 0) {
      validExecTimes.push(s.execution_time_ms);
    }

    if (s.score !== null && s.score !== undefined) {
      qStats.scores.push(s.score);
    }
  }

  const testCasePassRate = testCasesEvaluated > 0 ? Math.round((testCasesPassed / testCasesEvaluated) * 1000) / 10 : 0;
  const averageExecutionTimeMs = validExecTimes.length > 0 ? Math.round(ss.mean(validExecTimes) * 10) / 10 : null;

  const languageBreakdown = Array.from(languageCounts.entries()).map(([language, count]) => ({
    language,
    count,
    percentage: totalCodingSubmissions > 0 ? Math.round((count / totalCodingSubmissions) * 1000) / 10 : 0
  })).sort((a, b) => b.count - a.count);

  const questions = Array.from(perQuestionMap.values()).map(q => ({
    questionId: q.questionId,
    title: q.title,
    marks: q.marks,
    submissionsCount: q.submissionsCount,
    uniqueCandidates: q.candidateIds.size,
    acceptedCount: q.acceptedCount,
    compilationFailures: q.compilationFailures,
    runtimeFailures: q.runtimeFailures,
    timeouts: q.timeouts,
    providerFailures: q.providerFailures,
    testCasesEvaluated: q.testCasesEvaluated,
    testCasesPassed: q.testCasesPassed,
    testCasePassRate: q.testCasesEvaluated > 0 ? Math.round((q.testCasesPassed / q.testCasesEvaluated) * 1000) / 10 : 0,
    averageScore: q.scores.length > 0 ? Math.round(ss.mean(q.scores) * 10) / 10 : 0
  }));

  return {
    summary: {
      totalCodingSubmissions,
      uniqueCandidatesSubmitting: uniqueCandidates,
      successfulExecutions,
      compilationFailures,
      runtimeFailures,
      timeouts,
      providerFailures,
      pendingSubmissions,
      partiallyPassed,
      wrongAnswerZeroPassed,
      testCasesEvaluated,
      testCasesPassed,
      testCasePassRate,
      averageExecutionTimeMs,
      languageBreakdown
    },
    questions
  };
}

/**
 * 6. Candidate Performance, Distributions & Statistical Metrics
 */
function getExamPerformance(examId, organizationId, filters = {}, isSuperAdmin = false) {
  const exam = assertExamAccess(examId, organizationId, isSuperAdmin);
  const passingScore = exam.passing_score !== null && exam.passing_score !== undefined ? exam.passing_score : 40;
  const tenantFilter = isSuperAdmin ? '' : 'AND a.organization_id = ?';
  const tenantParams = isSuperAdmin ? [] : [organizationId];
  const dateFilter = buildDateFilter(filters, 'a.');

  // Finalized attempts
  const attempts = db.prepare(`
    SELECT a.id, a.percentage, a.started_at, a.submitted_at, a.graded_detail_json
    FROM attempts a
    WHERE a.exam_id = ?
      AND a.status = 'submitted'
      AND a.finalization_status = 'FINALIZED'
      ${tenantFilter}
      ${dateFilter.clause}
    ORDER BY a.percentage ASC
  `).all(exam.id, ...tenantParams, ...dateFilter.params);

  const count = attempts.length;

  // 1. Score Distribution (Buckets)
  const scoreBuckets = [
    { bucket: '0-19%', min: 0, max: 19.9, count: 0, percentage: 0 },
    { bucket: '20-39%', min: 20, max: 39.9, count: 0, percentage: 0 },
    { bucket: '40-59%', min: 40, max: 59.9, count: 0, percentage: 0 },
    { bucket: '60-79%', min: 60, max: 79.9, count: 0, percentage: 0 },
    { bucket: '80-100%', min: 80, max: 100, count: 0, percentage: 0 }
  ];

  let passedCount = 0;
  let failedCount = 0;
  const durationsMinutes = [];
  const categoryStats = new Map();

  for (const att of attempts) {
    const pct = att.percentage !== null && att.percentage !== undefined ? att.percentage : 0;

    // Bucket placement
    if (pct < 20) scoreBuckets[0].count++;
    else if (pct < 40) scoreBuckets[1].count++;
    else if (pct < 60) scoreBuckets[2].count++;
    else if (pct < 80) scoreBuckets[3].count++;
    else scoreBuckets[4].count++;

    // Pass / Fail
    if (pct >= passingScore) passedCount++;
    else failedCount++;

    // Duration calculation
    if (att.started_at && att.submitted_at) {
      const dur = (new Date(att.submitted_at).getTime() - new Date(att.started_at).getTime()) / 60000;
      if (dur >= 0) durationsMinutes.push(dur);
    }

    // Category breakdown
    if (att.graded_detail_json) {
      try {
        const details = JSON.parse(att.graded_detail_json);
        if (Array.isArray(details)) {
          for (const item of details) {
            const cat = item.category || 'general';
            if (!categoryStats.has(cat)) {
              categoryStats.set(cat, {
                category: cat,
                totalMarks: 0,
                totalEarned: 0,
                occurrences: 0
              });
            }
            const cs = categoryStats.get(cat);
            cs.totalMarks += (item.marks || 0);
            cs.totalEarned += (item.earned || 0);
            cs.occurrences++;
          }
        }
      } catch {}
    }
  }

  // Calculate score bucket percentages
  for (const b of scoreBuckets) {
    b.percentage = count > 0 ? Math.round((b.count / count) * 1000) / 10 : 0;
  }

  // 2. Duration Distribution
  const durationBuckets = [
    { bucket: '< 15 min', count: 0, percentage: 0 },
    { bucket: '15-30 min', count: 0, percentage: 0 },
    { bucket: '30-45 min', count: 0, percentage: 0 },
    { bucket: '45-60 min', count: 0, percentage: 0 },
    { bucket: '> 60 min', count: 0, percentage: 0 }
  ];

  for (const dur of durationsMinutes) {
    if (dur < 15) durationBuckets[0].count++;
    else if (dur < 30) durationBuckets[1].count++;
    else if (dur < 45) durationBuckets[2].count++;
    else if (dur <= 60) durationBuckets[3].count++;
    else durationBuckets[4].count++;
  }

  const durationCount = durationsMinutes.length;
  for (const b of durationBuckets) {
    b.percentage = durationCount > 0 ? Math.round((b.count / durationCount) * 1000) / 10 : 0;
  }

  // 3. Statistical Metrics via simple-statistics
  let statistics = {
    count,
    mean: null,
    median: null,
    standardDeviation: null,
    min: null,
    max: null,
    q1: null,
    q3: null,
    p90: null,
    iqr: null,
    averageDurationMinutes: null,
    medianDurationMinutes: null
  };

  if (count > 0) {
    const scores = attempts.map(a => a.percentage); // already sorted asc
    const mean = Math.round(ss.mean(scores) * 10) / 10;
    const median = Math.round(ss.median(scores) * 10) / 10;
    const sd = scores.length > 1 ? Math.round(ss.standardDeviation(scores) * 10) / 10 : 0;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const q1 = Math.round(ss.quantileSorted(scores, 0.25) * 10) / 10;
    const q3 = Math.round(ss.quantileSorted(scores, 0.75) * 10) / 10;
    const p90 = Math.round(ss.quantileSorted(scores, 0.90) * 10) / 10;
    const iqr = Math.round((q3 - q1) * 10) / 10;

    let avgDur = null;
    let medDur = null;
    if (durationsMinutes.length > 0) {
      durationsMinutes.sort((a, b) => a - b);
      avgDur = Math.round(ss.mean(durationsMinutes) * 10) / 10;
      medDur = Math.round(ss.median(durationsMinutes) * 10) / 10;
    }

    statistics = {
      count,
      mean,
      median,
      standardDeviation: sd,
      min,
      max,
      q1,
      q3,
      p90,
      iqr,
      averageDurationMinutes: avgDur,
      medianDurationMinutes: medDur
    };
  }

  // 4. Pass / Fail Summary
  const passFail = {
    passed: passedCount,
    failed: failedCount,
    passRate: count > 0 ? Math.round((passedCount / count) * 1000) / 10 : 0,
    failRate: count > 0 ? Math.round((failedCount / count) * 1000) / 10 : 0
  };

  // 5. Category Performance
  const categoryPerformance = Array.from(categoryStats.values()).map(cs => {
    const avgMarks = cs.occurrences > 0 ? Math.round((cs.totalEarned / cs.occurrences) * 10) / 10 : 0;
    const maxMarks = cs.occurrences > 0 ? Math.round((cs.totalMarks / cs.occurrences) * 10) / 10 : 0;
    const avgPct = cs.totalMarks > 0 ? Math.round((cs.totalEarned / cs.totalMarks) * 1000) / 10 : 0;
    return {
      category: cs.category,
      totalMarks: maxMarks,
      averageMarksEarned: avgMarks,
      averagePercentage: avgPct
    };
  });

  return {
    scoreDistribution: scoreBuckets,
    durationDistribution: durationBuckets,
    passFail,
    statistics,
    categoryPerformance
  };
}

module.exports = {
  assertExamAccess,
  classifyDifficulty,
  rateDiscrimination,
  getExamOverview,
  getExamCandidates,
  getExamQuestions,
  getQuestionDetail,
  getExamCodingAnalytics,
  getExamPerformance,
  DIFFICULTY_THRESHOLDS,
  MIN_DISCRIMINATION_SAMPLE_SIZE
};
