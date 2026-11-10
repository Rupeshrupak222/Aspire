// ============================================================================
// ASPIRE DAY 20: QUESTION REPORT SERVICE
// ============================================================================
// Psychometric item analysis, question difficulty classification,
// and Kelley's Item Discrimination Index (D) across assessments.
// Reuses Day 19 psychometric evaluation engine.
// ============================================================================

const ss = require('simple-statistics');
const { db } = require('../../db');
const {
  classifyDifficulty,
  rateDiscrimination,
  MIN_DISCRIMINATION_SAMPLE_SIZE
} = require('../exam-analytics.service');
const {
  buildTenantFilter,
  formatPercentage,
  paginateRecords
} = require('./report-query.service');

const KELLEY_PERCENTILE_RATIO = 0.27;

function getQuestionReport({ organizationId = null, isSuperAdmin = false, filters = {}, isExport = false }) {
  const tenantFilter = buildTenantFilter(organizationId, isSuperAdmin, 'q.');

  const conditions = ['1=1'];
  const params = [];

  if (tenantFilter.sql) {
    conditions.push(tenantFilter.sql.replace(/^AND\s+/, ''));
    params.push(...tenantFilter.params);
  }

  if (filters.category && filters.category !== 'ALL') {
    conditions.push('LOWER(q.category) = ?');
    params.push(filters.category.toLowerCase().trim());
  }

  if (filters.question_type && filters.question_type !== 'all') {
    conditions.push('q.type = ?');
    params.push(filters.question_type.trim());
  }

  if (filters.search) {
    const sTerm = `%${filters.search.toLowerCase().trim()}%`;
    conditions.push('(LOWER(q.question_text) LIKE ? OR LOWER(q.category) LIKE ?)');
    params.push(sTerm, sTerm);
  }

  // Retrieve base questions
  const questionsQuery = `
    SELECT
      q.id,
      q.type,
      q.category,
      q.question_text,
      q.marks,
      q.created_at
    FROM questions q
    WHERE ${conditions.join(' AND ')}
    ORDER BY q.id ASC
  `;

  const questions = db.prepare(questionsQuery).all(...params);

  // Retrieve completed attempts to grade questions
  const attConditions = [
    "a.status = 'submitted'",
    "a.finalization_status = 'FINALIZED'"
  ];
  const attParams = [];

  const attTenantFilter = buildTenantFilter(organizationId, isSuperAdmin, 'a.');
  if (attTenantFilter.sql) {
    attConditions.push(attTenantFilter.sql.replace(/^AND\s+/, ''));
    attParams.push(...attTenantFilter.params);
  }

  if (filters.exam_id) {
    attConditions.push('a.exam_id = ?');
    attParams.push(filters.exam_id);
  }

  const completedAttempts = db.prepare(`
    SELECT
      a.id,
      a.exam_id,
      COALESCE(e.name, 'General Assessment') AS exam_title,
      a.percentage,
      a.graded_detail_json
    FROM attempts a
    LEFT JOIN exams e ON e.id = a.exam_id
    WHERE ${attConditions.join(' AND ')}
    ORDER BY a.percentage DESC
  `).all(...attParams);

  const N = completedAttempts.length;
  const k = Math.max(1, Math.round(N * KELLEY_PERCENTILE_RATIO));
  const hasSufficientSample = N >= MIN_DISCRIMINATION_SAMPLE_SIZE;

  // Map to accumulate question metrics
  const statsMap = new Map();

  for (const q of questions) {
    statsMap.set(q.id, {
      id: q.id,
      title: q.question_text.length > 80 ? `${q.question_text.slice(0, 77)}...` : q.question_text,
      type: q.type,
      category: q.category || 'General',
      marks: q.marks || 1,
      examTitles: new Set(),
      totalAttempts: 0,
      correctCount: 0,
      wrongCount: 0,
      unansweredCount: 0,
      upperCorrect: 0,
      upperTotal: 0,
      lowerCorrect: 0,
      lowerTotal: 0
    });
  }

  // Process completed attempts
  for (let i = 0; i < completedAttempts.length; i++) {
    const att = completedAttempts[i];
    const isUpper = hasSufficientSample && i < k;
    const isLower = hasSufficientSample && i >= N - k;

    let detail = [];
    try {
      detail = JSON.parse(att.graded_detail_json || '[]');
    } catch {}

    for (const item of detail) {
      const qid = item.id;
      const stat = statsMap.get(qid);
      if (!stat) continue;

      stat.examTitles.add(att.exam_title);
      stat.totalAttempts++;

      const isCorrect = Boolean(item.isCorrect);
      const isAnswered = item.userAnswer !== undefined && item.userAnswer !== null && item.userAnswer !== '';

      if (isCorrect) {
        stat.correctCount++;
      } else if (isAnswered) {
        stat.wrongCount++;
      } else {
        stat.unansweredCount++;
      }

      if (isUpper) {
        stat.upperTotal++;
        if (isCorrect) stat.upperCorrect++;
      }

      if (isLower) {
        stat.lowerTotal++;
        if (isCorrect) stat.lowerCorrect++;
      }
    }
  }

  const records = [];
  let totalAccSum = 0;
  let totalEvaluatedQ = 0;
  let lowDiscriminationCount = 0;
  let flaggedReviewCount = 0;

  for (const stat of statsMap.values()) {
    // If filtered by exam_id, only include questions that appeared in that exam
    if (filters.exam_id && stat.totalAttempts === 0 && !stat.examTitles.size) {
      continue;
    }

    const total = stat.totalAttempts;
    const accuracy = total > 0 ? (stat.correctCount / total) * 100 : 0;
    const wrongPct = total > 0 ? (stat.wrongCount / total) * 100 : 0;
    const unansPct = total > 0 ? (stat.unansweredCount / total) * 100 : 0;

    let d = null;
    let discriminationRating = 'INSUFFICIENT_DATA';

    if (hasSufficientSample && stat.upperTotal > 0 && stat.lowerTotal > 0) {
      const pUpper = stat.upperCorrect / stat.upperTotal;
      const pLower = stat.lowerCorrect / stat.lowerTotal;
      d = Math.round((pUpper - pLower) * 100) / 100;
      discriminationRating = rateDiscrimination(d);
    }

    const diffClassification = classifyDifficulty(accuracy);

    if (filters.difficulty && filters.difficulty !== 'ALL') {
      if (diffClassification !== filters.difficulty) continue;
    }

    if (total > 0) {
      totalAccSum += accuracy;
      totalEvaluatedQ++;
    }

    const isLowD = d !== null && d < 0.2;
    const isFlagged = isLowD || (total >= 5 && accuracy < 20);

    if (isLowD) lowDiscriminationCount++;
    if (isFlagged) flaggedReviewCount++;

    records.push({
      question_id: stat.id,
      title: stat.title,
      category: stat.category,
      question_type: stat.type.toUpperCase(),
      exam_name: Array.from(stat.examTitles).join(', ') || 'General Question Bank',
      total_attempts: total,
      correct_responses: stat.correctCount,
      wrong_responses: stat.wrongCount,
      unanswered_responses: stat.unansweredCount,
      accuracy_percentage: `${formatPercentage(accuracy)}%`,
      raw_accuracy: accuracy,
      wrong_percentage: `${formatPercentage(wrongPct)}%`,
      unanswered_percentage: `${formatPercentage(unansPct)}%`,
      difficulty: diffClassification,
      discrimination_d: d !== null ? d.toFixed(2) : '—',
      raw_d: d,
      discrimination_rating: discriminationRating,
      sample_size: N,
      timing_available: 'Not Recorded',
      average_time: '—',
      flagged_for_review: isFlagged ? 'FLAGGED' : 'NORMAL'
    });
  }

  const summary = {
    total_questions: records.length,
    average_accuracy: totalEvaluatedQ > 0 ? formatPercentage(totalAccSum / totalEvaluatedQ) : 0,
    low_discrimination_count: lowDiscriminationCount,
    flagged_for_review_count: flaggedReviewCount
  };

  const columns = [
    { key: 'question_id', label: 'ID' },
    { key: 'title', label: 'Question' },
    { key: 'category', label: 'Category' },
    { key: 'question_type', label: 'Type' },
    { key: 'total_attempts', label: 'Attempts' },
    { key: 'accuracy_percentage', label: 'Accuracy' },
    { key: 'wrong_percentage', label: 'Wrong %' },
    { key: 'difficulty', label: 'Difficulty' },
    { key: 'discrimination_d', label: 'D Index' },
    { key: 'discrimination_rating', label: 'Discrimination' },
    { key: 'flagged_for_review', label: 'Status' }
  ];

  if (isExport) {
    return {
      reportType: 'questions',
      title: 'Question Psychometric Quality & Item Discrimination Report',
      summary,
      columns,
      records: records.slice(0, filters.limit || 10000),
      totalRecords: records.length
    };
  }

  const paginated = paginateRecords(records, filters.page, filters.limit);
  return {
    reportType: 'questions',
    title: 'Question Psychometric Quality & Item Discrimination Report',
    summary,
    columns,
    records: paginated.records,
    pagination: paginated.pagination
  };
}

module.exports = { getQuestionReport };
