// ============================================================================
// ASPIRE DAY 18: SAAS DASHBOARD ANALYTICS SERVICE
// ============================================================================
// Authoritative SQL aggregations for SaaS KPI metrics, visual charts, and
// multi-tenant analytics.
// All queries strictly enforce organization_id isolation at the database level.
// ============================================================================

const { db } = require('../db');
const { NotFoundError, ValidationError, AuthorizationError } = require('../errors/app-error');
const orgService = require('./organization.service');

/**
 * Resolves start/end UTC dates and preceding comparison period based on filter and org timezone.
 */
function resolveDateRange({ period = '30d', start_date = null, end_date = null, timezone = 'Asia/Kolkata' }) {
  const now = new Date();

  let startMs = 0;
  let endMs = now.getTime();

  if (period === 'today') {
    // Current day in organization timezone
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const todayStr = formatter.format(now);
    const startLocal = new Date(`${todayStr}T00:00:00`);
    startMs = startLocal.getTime();
  } else if (period === '7d') {
    startMs = endMs - 7 * 24 * 60 * 60 * 1000;
  } else if (period === '30d') {
    startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  } else if (period === '90d') {
    startMs = endMs - 90 * 24 * 60 * 60 * 1000;
  } else if (period === 'custom') {
    if (!start_date || !end_date) {
      throw new ValidationError("Both start_date and end_date are required when period is 'custom'");
    }
    startMs = new Date(start_date).getTime();
    endMs = new Date(end_date).getTime();
    if (endMs < startMs) {
      throw new ValidationError('end_date must be greater than or equal to start_date');
    }
  } else {
    // Default 30d
    startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  }

  const durationMs = Math.max(1000, endMs - startMs);
  const prevEndMs = startMs;
  const prevStartMs = prevEndMs - durationMs;

  return {
    period,
    startDateStr: new Date(startMs).toISOString(),
    endDateStr: new Date(endMs).toISOString(),
    prevStartDateStr: new Date(prevStartMs).toISOString(),
    prevEndDateStr: new Date(prevEndMs).toISOString(),
    durationDays: Math.ceil(durationMs / (24 * 60 * 60 * 1000)),
    timezone
  };
}

/**
 * Calculates percentage trend comparison safely (avoids division by zero and NaN).
 */
function calculateTrend(current, previous) {
  if (previous === null || previous === undefined || previous === 0) {
    return {
      percentageChange: null,
      comparisonAvailable: false
    };
  }
  const change = ((current - previous) / previous) * 100;
  return {
    percentageChange: Math.round(change * 10) / 10,
    comparisonAvailable: true
  };
}

/**
 * 1. Overview KPIs (8 Cards)
 */
function getOverviewKPIs(organizationId, filters = {}) {
  const org = organizationId ? orgService.findOrganizationById(organizationId) : null;
  const timezone = (org && org.timezone) || 'Asia/Kolkata';

  const range = resolveDateRange({
    period: filters.period,
    start_date: filters.start_date,
    end_date: filters.end_date,
    timezone
  });

  // Base scope params
  const orgFilter = organizationId ? 'AND a.organization_id = ?' : '';
  const orgParam = organizationId ? [organizationId] : [];

  const examFilter = filters.exam_id ? 'AND a.exam_id = ?' : '';
  const examParam = filters.exam_id ? [filters.exam_id] : [];

  const collegeFilter = filters.college ? 'AND s.college = ?' : '';
  const collegeParam = filters.college ? [filters.college] : [];

  // --- KPI A: Total Students ---
  const studentOrgFilter = organizationId ? 'WHERE organization_id = ?' : '';
  const studentOrgParam = organizationId ? [organizationId] : [];
  const totalStudentsAllTime = db.prepare(`SELECT count(DISTINCT id) as c FROM students ${studentOrgFilter}`).get(...studentOrgParam)?.c || 0;

  const currentStudentsCount = db.prepare(`
    SELECT count(DISTINCT id) as c FROM students 
    ${studentOrgFilter ? studentOrgFilter + ' AND' : 'WHERE'} created_at >= ? AND created_at <= ?
  `).get(...studentOrgParam, range.startDateStr, range.endDateStr)?.c || 0;

  const prevStudentsCount = db.prepare(`
    SELECT count(DISTINCT id) as c FROM students 
    ${studentOrgFilter ? studentOrgFilter + ' AND' : 'WHERE'} created_at >= ? AND created_at <= ?
  `).get(...studentOrgParam, range.prevStartDateStr, range.prevEndDateStr)?.c || 0;

  const studentTrend = calculateTrend(currentStudentsCount, prevStudentsCount);

  // --- KPI B: Total Exams ---
  const examOrgFilter = organizationId ? "WHERE organization_id = ? AND status != 'ARCHIVED'" : "WHERE status != 'ARCHIVED'";
  const totalExamsCount = db.prepare(`SELECT count(*) as c FROM exams ${examOrgFilter}`).get(...studentOrgParam)?.c || 0;

  // --- KPI C: Active Exams ---
  const activeExamFilter = organizationId ? "WHERE organization_id = ? AND status IN ('PUBLISHED', 'LIVE')" : "WHERE status IN ('PUBLISHED', 'LIVE')";
  const activeExamsCount = db.prepare(`SELECT count(*) as c FROM exams ${activeExamFilter}`).get(...studentOrgParam)?.c || 0;

  // --- KPI D: Completed Attempts ---
  const completedAttemptsQuery = `
    SELECT count(*) as c FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted'
      ${orgFilter} ${examFilter} ${collegeFilter}
      AND a.submitted_at >= ? AND a.submitted_at <= ?
  `;
  const completedAttemptsCurrent = db.prepare(completedAttemptsQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.startDateStr, range.endDateStr)?.c || 0;

  const completedAttemptsPrev = db.prepare(completedAttemptsQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.prevStartDateStr, range.prevEndDateStr)?.c || 0;

  const completedTrend = calculateTrend(completedAttemptsCurrent, completedAttemptsPrev);

  // --- KPI E: Average Score (%) ---
  const avgScoreQuery = `
    SELECT AVG(a.percentage) as avg_score, count(*) as count FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted' AND a.percentage IS NOT NULL
      ${orgFilter} ${examFilter} ${collegeFilter}
      AND a.submitted_at >= ? AND a.submitted_at <= ?
  `;
  const avgScoreResCurrent = db.prepare(avgScoreQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.startDateStr, range.endDateStr);
  const avgScoreCurrent = avgScoreResCurrent?.count > 0 ? Math.round(avgScoreResCurrent.avg_score * 10) / 10 : 0;

  const avgScoreResPrev = db.prepare(avgScoreQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.prevStartDateStr, range.prevEndDateStr);
  const avgScorePrev = avgScoreResPrev?.count > 0 ? Math.round(avgScoreResPrev.avg_score * 10) / 10 : 0;

  const avgScoreTrend = calculateTrend(avgScoreCurrent, avgScorePrev);

  // --- KPI F: Pass Rate ---
  const passRateQuery = `
    SELECT 
      count(CASE WHEN a.percentage >= COALESCE(e.passing_score, 40) THEN 1 END) as passed_count,
      count(*) as total_eligible
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    LEFT JOIN exams e ON e.id = a.exam_id
    WHERE a.status = 'submitted' AND a.percentage IS NOT NULL
      ${orgFilter} ${examFilter} ${collegeFilter}
      AND a.submitted_at >= ? AND a.submitted_at <= ?
  `;
  const passResCurrent = db.prepare(passRateQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.startDateStr, range.endDateStr);
  const passedCountCurrent = passResCurrent?.passed_count || 0;
  const totalEligibleCurrent = passResCurrent?.total_eligible || 0;
  const passRateCurrent = totalEligibleCurrent > 0 ? Math.round((passedCountCurrent / totalEligibleCurrent) * 1000) / 10 : 0;

  const passResPrev = db.prepare(passRateQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.prevStartDateStr, range.prevEndDateStr);
  const passedCountPrev = passResPrev?.passed_count || 0;
  const totalEligiblePrev = passResPrev?.total_eligible || 0;
  const passRatePrev = totalEligiblePrev > 0 ? Math.round((passedCountPrev / totalEligiblePrev) * 1000) / 10 : 0;

  const passRateTrend = calculateTrend(passRateCurrent, passRatePrev);

  // --- KPI G: Scholarships Awarded ---
  const scholarshipQuery = `
    SELECT count(*) as c FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted' AND a.scholarship_pct > 0
      ${orgFilter} ${examFilter} ${collegeFilter}
      AND a.submitted_at >= ? AND a.submitted_at <= ?
  `;
  const scholarshipCurrent = db.prepare(scholarshipQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.startDateStr, range.endDateStr)?.c || 0;
  const scholarshipPrev = db.prepare(scholarshipQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.prevStartDateStr, range.prevEndDateStr)?.c || 0;
  const scholarshipTrend = calculateTrend(scholarshipCurrent, scholarshipPrev);

  // --- KPI H: Certificates Generated ---
  const certQuery = `
    SELECT count(DISTINCT a.certificate_id) as c FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted' AND a.certificate_id IS NOT NULL
      ${orgFilter} ${examFilter} ${collegeFilter}
      AND a.submitted_at >= ? AND a.submitted_at <= ?
  `;
  const certCurrent = db.prepare(certQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.startDateStr, range.endDateStr)?.c || 0;
  const certPrev = db.prepare(certQuery)
    .get(...orgParam, ...examParam, ...collegeParam, range.prevStartDateStr, range.prevEndDateStr)?.c || 0;
  const certTrend = calculateTrend(certCurrent, certPrev);

  return {
    kpis: {
      totalStudents: {
        value: totalStudentsAllTime,
        periodNewStudents: currentStudentsCount,
        previousPeriodValue: prevStudentsCount,
        percentageChange: studentTrend.percentageChange,
        comparisonAvailable: studentTrend.comparisonAvailable,
        metadata: { periodNew: currentStudentsCount }
      },
      totalExams: {
        value: totalExamsCount,
        previousPeriodValue: null,
        percentageChange: null,
        comparisonAvailable: false,
        metadata: { activeExams: activeExamsCount }
      },
      activeExams: {
        value: activeExamsCount,
        previousPeriodValue: null,
        percentageChange: null,
        comparisonAvailable: false,
        metadata: { totalExams: totalExamsCount }
      },
      completedAttempts: {
        value: completedAttemptsCurrent,
        previousPeriodValue: completedAttemptsPrev,
        percentageChange: completedTrend.percentageChange,
        comparisonAvailable: completedTrend.comparisonAvailable,
        metadata: { period: range.period }
      },
      averageScore: {
        value: avgScoreCurrent,
        previousPeriodValue: avgScorePrev,
        percentageChange: avgScoreTrend.percentageChange,
        comparisonAvailable: avgScoreTrend.comparisonAvailable,
        metadata: { unit: 'percentage' }
      },
      passRate: {
        value: passRateCurrent,
        previousPeriodValue: passRatePrev,
        percentageChange: passRateTrend.percentageChange,
        comparisonAvailable: passRateTrend.comparisonAvailable,
        metadata: {
          passedCount: passedCountCurrent,
          totalEligibleCount: totalEligibleCurrent,
          defaultThresholdPct: 40
        }
      },
      scholarshipsAwarded: {
        value: scholarshipCurrent,
        previousPeriodValue: scholarshipPrev,
        percentageChange: scholarshipTrend.percentageChange,
        comparisonAvailable: scholarshipTrend.comparisonAvailable,
        metadata: { awardCondition: 'scholarship_pct > 0' }
      },
      certificatesGenerated: {
        value: certCurrent,
        previousPeriodValue: certPrev,
        percentageChange: certTrend.percentageChange,
        comparisonAvailable: certTrend.comparisonAvailable,
        metadata: { status: 'submitted' }
      }
    },
    meta: {
      organizationId: organizationId || null,
      organizationName: org ? org.name : 'Platform Wide',
      organizationTimezone: timezone,
      dateRange: {
        period: range.period,
        startDate: range.startDateStr,
        endDate: range.endDateStr,
        durationDays: range.durationDays
      },
      generatedAt: new Date().toISOString()
    }
  };
}

/**
 * 2. Visual Analytics: Attempts Over Time (Line Chart)
 */
function getAttemptsOverTime(organizationId, filters = {}) {
  const org = organizationId ? orgService.findOrganizationById(organizationId) : null;
  const timezone = (org && org.timezone) || 'Asia/Kolkata';

  const range = resolveDateRange({
    period: filters.period,
    start_date: filters.start_date,
    end_date: filters.end_date,
    timezone
  });

  const orgFilter = organizationId ? 'AND a.organization_id = ?' : '';
  const orgParam = organizationId ? [organizationId] : [];
  const examFilter = filters.exam_id ? 'AND a.exam_id = ?' : '';
  const examParam = filters.exam_id ? [filters.exam_id] : [];
  const collegeFilter = filters.college ? 'AND s.college = ?' : '';
  const collegeParam = filters.college ? [filters.college] : [];

  // Query raw daily totals
  const rows = db.prepare(`
    SELECT 
      substr(a.started_at, 1, 10) as day,
      SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN a.status = 'started' THEN 1 ELSE 0 END) as in_progress,
      count(*) as total
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.started_at >= ? AND a.started_at <= ?
      ${orgFilter} ${examFilter} ${collegeFilter}
    GROUP BY day
    ORDER BY day ASC
  `).all(range.startDateStr, range.endDateStr, ...orgParam, ...examParam, ...collegeParam);

  const rowMap = new Map();
  for (const r of rows) {
    rowMap.set(r.day, r);
  }

  // Generate continuous daily buckets from start to end
  const labels = [];
  const completed = [];
  const inProgress = [];
  const total = [];

  const startMs = new Date(range.startDateStr).getTime();
  const endMs = new Date(range.endDateStr).getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  for (let t = startMs; t <= endMs; t += oneDayMs) {
    const dayStr = new Date(t).toISOString().slice(0, 10);
    if (!labels.includes(dayStr)) {
      labels.push(dayStr);
      const match = rowMap.get(dayStr);
      completed.push(match ? match.completed : 0);
      inProgress.push(match ? match.in_progress : 0);
      total.push(match ? match.total : 0);
    }
  }

  return {
    labels,
    completed,
    inProgress,
    total,
    datasets: {
      completed,
      inProgress,
      total
    },
    meta: {
      totalDataPoints: labels.length,
      timezone
    }
  };
}

/**
 * 3. Visual Analytics: Score Distribution (Bar Chart)
 */
function getScoreDistribution(organizationId, filters = {}) {
  const org = organizationId ? orgService.findOrganizationById(organizationId) : null;
  const timezone = (org && org.timezone) || 'Asia/Kolkata';

  const range = resolveDateRange({
    period: filters.period,
    start_date: filters.start_date,
    end_date: filters.end_date,
    timezone
  });

  const orgFilter = organizationId ? 'AND a.organization_id = ?' : '';
  const orgParam = organizationId ? [organizationId] : [];
  const examFilter = filters.exam_id ? 'AND a.exam_id = ?' : '';
  const examParam = filters.exam_id ? [filters.exam_id] : [];
  const collegeFilter = filters.college ? 'AND s.college = ?' : '';
  const collegeParam = filters.college ? [filters.college] : [];

  const rows = db.prepare(`
    SELECT 
      CASE 
        WHEN a.percentage <= 20 THEN '0–20%'
        WHEN a.percentage <= 40 THEN '21–40%'
        WHEN a.percentage <= 60 THEN '41–60%'
        WHEN a.percentage <= 80 THEN '61–80%'
        ELSE '81–100%'
      END as bucket,
      count(*) as count
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.status = 'submitted' AND a.percentage IS NOT NULL
      ${orgFilter} ${examFilter} ${collegeFilter}
      AND a.submitted_at >= ? AND a.submitted_at <= ?
    GROUP BY bucket
  `).all(...orgParam, ...examParam, ...collegeParam, range.startDateStr, range.endDateStr);

  const bucketMap = {
    '0–20%': 0,
    '21–40%': 0,
    '41–60%': 0,
    '61–80%': 0,
    '81–100%': 0
  };

  let totalAttempts = 0;
  for (const r of rows) {
    if (bucketMap[r.bucket] !== undefined) {
      bucketMap[r.bucket] = r.count;
      totalAttempts += r.count;
    }
  }

  const labels = Object.keys(bucketMap);
  const counts = Object.values(bucketMap);
  const percentages = counts.map(c => totalAttempts > 0 ? Math.round((c / totalAttempts) * 1000) / 10 : 0);

  return {
    labels,
    buckets: labels,
    counts,
    percentages,
    totalAttempts,
    total: totalAttempts
  };
}

/**
 * 4. Visual Analytics: College Distribution (Doughnut Chart)
 */
function getCollegeDistribution(organizationId, filters = {}) {
  const limit = Math.min(filters.limit || 8, 20);

  const orgFilter = organizationId ? 'WHERE s.organization_id = ?' : '';
  const orgParam = organizationId ? [organizationId] : [];

  const examJoin = filters.exam_id ? 'JOIN attempts a ON a.student_id = s.id AND a.exam_id = ?' : '';
  const examParam = filters.exam_id ? [filters.exam_id] : [];

  const rows = db.prepare(`
    SELECT 
      COALESCE(NULLIF(TRIM(s.college), ''), 'Not specified') as college,
      count(DISTINCT s.id) as count
    FROM students s
    ${examJoin}
    ${orgFilter}
    GROUP BY college
    ORDER BY count DESC
  `).all(...examParam, ...orgParam);

  const totalStudents = rows.reduce((acc, r) => acc + r.count, 0);

  const labels = [];
  const counts = [];

  let topTotal = 0;
  const topRows = rows.slice(0, limit);
  for (const r of topRows) {
    labels.push(r.college);
    counts.push(r.count);
    topTotal += r.count;
  }

  const remainder = totalStudents - topTotal;
  if (remainder > 0) {
    labels.push('Other');
    counts.push(remainder);
  }

  const percentages = counts.map(c => totalStudents > 0 ? Math.round((c / totalStudents) * 1000) / 10 : 0);

  return {
    labels,
    colleges: labels,
    counts,
    studentCounts: counts,
    percentages,
    totalStudents
  };
}

/**
 * 5. Visual Analytics: Question Performance (Horizontal Bar Chart)
 */
function getQuestionPerformance(organizationId, filters = {}) {
  const org = organizationId ? orgService.findOrganizationById(organizationId) : null;
  const timezone = (org && org.timezone) || 'Asia/Kolkata';

  const range = resolveDateRange({
    period: filters.period,
    start_date: filters.start_date,
    end_date: filters.end_date,
    timezone
  });

  const orgFilter = organizationId ? 'AND a.organization_id = ?' : '';
  const orgParam = organizationId ? [organizationId] : [];
  const examFilter = filters.exam_id ? 'AND a.exam_id = ?' : '';
  const examParam = filters.exam_id ? [filters.exam_id] : [];

  const limit = Math.min(filters.limit || 15, 50);

  // Unpack graded_detail_json using json_each
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT 
        COALESCE(json_extract(j.value, '$.id'), json_extract(j.value, '$.questionId')) as question_id,
        COALESCE(json_extract(j.value, '$.title'), json_extract(j.value, '$.name')) as inline_title,
        count(*) as total_responses,
        SUM(CASE 
          WHEN json_extract(j.value, '$.correct') = 1 OR json_extract(j.value, '$.correct') = true THEN 1
          WHEN CAST(json_extract(j.value, '$.earned') AS REAL) >= CAST(COALESCE(json_extract(j.value, '$.marks'), json_extract(j.value, '$.maxScore'), 1) AS REAL) AND CAST(json_extract(j.value, '$.earned') AS REAL) > 0 THEN 1 
          ELSE 0 
        END) as correct_responses,
        SUM(CASE 
          WHEN json_extract(j.value, '$.correct') = 0 OR json_extract(j.value, '$.correct') = false THEN 1
          WHEN CAST(json_extract(j.value, '$.earned') AS REAL) < CAST(COALESCE(json_extract(j.value, '$.marks'), json_extract(j.value, '$.maxScore'), 1) AS REAL) OR CAST(json_extract(j.value, '$.earned') AS REAL) <= 0 THEN 1 
          ELSE 0 
        END) as incorrect_responses,
        ROUND(AVG(CAST(COALESCE(json_extract(j.value, '$.earned'), json_extract(j.value, '$.score'), 0) AS REAL)), 2) as avg_score
      FROM attempts a, json_each(a.graded_detail_json) j
      WHERE a.status = 'submitted' AND a.graded_detail_json IS NOT NULL
        ${orgFilter} ${examFilter}
        AND a.submitted_at >= ? AND a.submitted_at <= ?
      GROUP BY question_id
      ORDER BY total_responses DESC
      LIMIT ?
    `).all(...orgParam, ...examParam, range.startDateStr, range.endDateStr, limit);
  } catch (err) {
    // If table is empty or json_each encounters no rows
    rows = [];
  }

  if (rows.length === 0) {
    return {
      questions: [],
      summary: {
        totalEvaluated: 0,
        lowestPerforming: null,
        highestPerforming: null
      }
    };
  }

  // Join questions to attach titles and categories
  const integerQids = rows.map(r => Number(r.question_id)).filter(n => Number.isInteger(n) && n > 0);
  const qmetaMap = new Map();
  if (integerQids.length > 0) {
    const qmeta = db.prepare(`
      SELECT id, title, question_text, category, type, marks FROM questions 
      WHERE id IN (${integerQids.map(() => '?').join(',')})
    `).all(...integerQids);
    for (const q of qmeta) {
      qmetaMap.set(q.id, q);
    }
  }

  const questions = rows.map((r) => {
    const meta = qmetaMap.get(Number(r.question_id)) || {};
    const accuracy = r.total_responses > 0 ? Math.round((r.correct_responses / r.total_responses) * 1000) / 10 : 0;
    const title = r.inline_title || meta.title || (meta.question_text ? meta.question_text.slice(0, 40) + '...' : `Question #${r.question_id}`);

    return {
      questionId: r.question_id,
      title,
      category: meta.category || 'General',
      type: meta.type || 'MCQ',
      marks: meta.marks || 1,
      totalResponses: r.total_responses,
      totalAttempts: r.total_responses,
      correctResponses: r.correct_responses,
      correctCount: r.correct_responses,
      incorrectResponses: r.incorrect_responses,
      incorrectCount: r.incorrect_responses,
      accuracy,
      avgScore: r.avg_score !== null ? r.avg_score : 0
    };
  });

  const sortedByAccuracy = questions.slice().sort((a, b) => a.accuracy - b.accuracy);
  const lowestPerforming = sortedByAccuracy[0] || null;
  const highestPerforming = sortedByAccuracy[sortedByAccuracy.length - 1] || null;

  return {
    questions,
    summary: {
      totalEvaluated: questions.length,
      lowestPerforming,
      highestPerforming
    }
  };
}

/**
 * 6. Visual Analytics: Completion Rate (Doughnut / Stacked Bar)
 */
function getCompletionRate(organizationId, filters = {}) {
  const org = organizationId ? orgService.findOrganizationById(organizationId) : null;
  const timezone = (org && org.timezone) || 'Asia/Kolkata';

  const range = resolveDateRange({
    period: filters.period,
    start_date: filters.start_date,
    end_date: filters.end_date,
    timezone
  });

  const orgFilter = organizationId ? 'AND a.organization_id = ?' : '';
  const orgParam = organizationId ? [organizationId] : [];
  const examFilter = filters.exam_id ? 'AND a.exam_id = ?' : '';
  const examParam = filters.exam_id ? [filters.exam_id] : [];
  const collegeFilter = filters.college ? 'AND s.college = ?' : '';
  const collegeParam = filters.college ? [filters.college] : [];

  const rows = db.prepare(`
    SELECT 
      a.status,
      a.finalized_by,
      CASE 
        WHEN a.status = 'submitted' THEN 'completed'
        WHEN datetime('now') > COALESCE(a.deadline_at, a.expires_at) THEN 'expired'
        ELSE 'in_progress'
      END as state,
      count(*) as count
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    WHERE a.started_at >= ? AND a.started_at <= ?
      ${orgFilter} ${examFilter} ${collegeFilter}
    GROUP BY state
  `).all(range.startDateStr, range.endDateStr, ...orgParam, ...examParam, ...collegeParam);

  let completed = 0;
  let inProgress = 0;
  let expired = 0;

  for (const r of rows) {
    if (r.state === 'completed') completed += r.count;
    else if (r.state === 'in_progress') inProgress += r.count;
    else if (r.state === 'expired') expired += r.count;
  }

  const totalEligible = completed + inProgress + expired;
  const completionRate = totalEligible > 0 ? Math.round((completed / totalEligible) * 1000) / 10 : 0;

  return {
    completionRate,
    completed,
    inProgress,
    expired,
    totalEligible,
    labels: ['Completed', 'In Progress', 'Expired / Timed Out'],
    counts: [completed, inProgress, expired],
    percentages: [
      totalEligible > 0 ? Math.round((completed / totalEligible) * 1000) / 10 : 0,
      totalEligible > 0 ? Math.round((inProgress / totalEligible) * 1000) / 10 : 0,
      totalEligible > 0 ? Math.round((expired / totalEligible) * 1000) / 10 : 0
    ]
  };
}

/**
 * 7. Platform-Wide Analytics Overview (SUPER_ADMIN Only)
 */
function getPlatformOverview(filters = {}) {
  // Aggregate overview across all organizations
  const overview = getOverviewKPIs(null, filters);

  // Per-organization summary table
  const orgs = db.prepare(`
    SELECT o.id, o.name, o.slug, o.status, o.created_at,
           (SELECT count(*) FROM students s WHERE s.organization_id = o.id) as total_students,
           (SELECT count(*) FROM exams e WHERE e.organization_id = o.id AND e.status IN ('PUBLISHED', 'LIVE')) as active_exams,
           (SELECT count(*) FROM attempts a WHERE a.organization_id = o.id AND a.status = 'submitted') as completed_attempts,
           (SELECT ROUND(AVG(a.percentage), 1) FROM attempts a WHERE a.organization_id = o.id AND a.status = 'submitted' AND a.percentage IS NOT NULL) as avg_score
    FROM organizations o
    ORDER BY total_students DESC, completed_attempts DESC
  `).all();

  return {
    ...overview,
    organizationsBreakdown: orgs
  };
}

module.exports = {
  resolveDateRange,
  calculateTrend,
  getOverviewKPIs,
  getAttemptsOverTime,
  getScoreDistribution,
  getCollegeDistribution,
  getQuestionPerformance,
  getCompletionRate,
  getPlatformOverview
};
