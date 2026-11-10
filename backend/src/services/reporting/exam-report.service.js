// ============================================================================
// ASPIRE DAY 20: EXAM REPORT SERVICE
// ============================================================================
// Consolidated performance, participation funnel, and statistical evaluation
// for examinations across tenant boundaries.
// ============================================================================

const ss = require('simple-statistics');
const { db } = require('../../db');
const {
  resolveReportDateFilter,
  buildTenantFilter,
  formatPercentage,
  paginateRecords
} = require('./report-query.service');

function getExamReport({ organizationId = null, isSuperAdmin = false, filters = {}, isExport = false }) {
  const tenantFilter = buildTenantFilter(organizationId, isSuperAdmin, 'e.');
  const dateFilter = resolveReportDateFilter(filters, 'e.');

  const conditions = ['1=1'];
  const params = [];

  if (tenantFilter.sql) {
    conditions.push(tenantFilter.sql.replace(/^AND\s+/, ''));
    params.push(...tenantFilter.params);
  }

  if (dateFilter.sql) {
    conditions.push(dateFilter.sql.replace(/^AND\s+/, ''));
    params.push(...dateFilter.params);
  }

  if (filters.exam_id) {
    conditions.push('e.id = ?');
    params.push(filters.exam_id);
  }

  if (filters.status) {
    conditions.push('UPPER(e.status) = ?');
    params.push(filters.status.toUpperCase().trim());
  }

  const examsQuery = `
    SELECT
      e.id,
      e.name AS title,
      e.status,
      e.duration_minutes,
      COALESCE(e.passing_score, 40) AS passing_score,
      e.created_at,
      o.name AS organization_name
    FROM exams e
    LEFT JOIN organizations o ON o.id = e.organization_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.created_at DESC
  `;

  const examsList = db.prepare(examsQuery).all(...params);

  // Compute metrics per exam
  const examRecords = [];
  let aggregateRegistered = 0;
  let aggregateCompleted = 0;
  let aggregatePassed = 0;
  let aggregateScholarships = 0;
  let allPercentages = [];

  for (const ex of examsList) {
    // Attempt stats for this exam
    const attRows = db.prepare(`
      SELECT
        a.id,
        a.student_id,
        a.status,
        a.percentage,
        a.scholarship_pct,
        a.certificate_id,
        a.started_at,
        a.expires_at
      FROM attempts a
      WHERE a.exam_id = ?
    `).all(ex.id);

    const registeredCandidates = new Set();
    const startedCandidates = new Set();
    const completedCandidates = new Set();
    const passedCandidates = new Set();
    const failedCandidates = new Set();
    let abandonedCount = 0;
    let expiredCount = 0;
    let inProgressCount = 0;
    let certCount = 0;
    const scores = [];
    const scholarshipDist = { '100%': 0, '50%': 0, '25%': 0, '10%': 0, '0%': 0 };

    const nowIso = new Date().toISOString();

    for (const a of attRows) {
      registeredCandidates.add(a.student_id);

      if (a.started_at) {
        startedCandidates.add(a.student_id);
      }

      if (a.status === 'submitted') {
        completedCandidates.add(a.student_id);
        if (a.percentage !== null && a.percentage !== undefined) {
          scores.push(a.percentage);
          allPercentages.push(a.percentage);
          if (a.percentage >= ex.passing_score) {
            passedCandidates.add(a.student_id);
          } else {
            failedCandidates.add(a.student_id);
          }
        }
        if (a.certificate_id) certCount++;
        const pct = a.scholarship_pct || 0;
        if (pct === 100) scholarshipDist['100%']++;
        else if (pct === 50) scholarshipDist['50%']++;
        else if (pct === 25) scholarshipDist['25%']++;
        else if (pct === 10) scholarshipDist['10%']++;
        else scholarshipDist['0%']++;

        if (pct > 0) aggregateScholarships++;
      } else if (a.status === 'abandoned') {
        abandonedCount++;
      } else if (a.status === 'started') {
        if (a.expires_at && a.expires_at < nowIso) {
          expiredCount++;
        } else {
          inProgressCount++;
        }
      }
    }

    const regCount = registeredCandidates.size;
    const startCount = startedCandidates.size;
    const compCount = completedCandidates.size;
    const passCount = passedCandidates.size;
    const failCount = failedCandidates.size;

    aggregateRegistered += regCount;
    aggregateCompleted += compCount;
    aggregatePassed += passCount;

    const completionRate = startCount > 0 ? formatPercentage((compCount / startCount) * 100) : 0;
    const passRate = compCount > 0 ? formatPercentage((passCount / compCount) * 100) : 0;

    let avgScore = 0;
    let medianScore = 0;
    let maxScore = 0;
    let minScore = 0;

    if (scores.length > 0) {
      avgScore = formatPercentage(ss.mean(scores));
      medianScore = formatPercentage(ss.median(scores));
      maxScore = formatPercentage(ss.max(scores));
      minScore = formatPercentage(ss.min(scores));
    }

    examRecords.push({
      exam_id: ex.id,
      title: ex.title,
      organization: ex.organization_name || 'Aspire Core',
      status: ex.status,
      duration_minutes: ex.duration_minutes,
      passing_score: `${ex.passing_score}%`,
      created_at: ex.created_at ? new Date(ex.created_at).toLocaleDateString('en-GB') : '—',
      registered_candidates: regCount,
      started_candidates: startCount,
      completed_attempts: compCount,
      abandoned_attempts: abandonedCount,
      expired_attempts: expiredCount,
      in_progress_attempts: inProgressCount,
      passed_candidates: passCount,
      failed_candidates: failCount,
      completion_rate: `${completionRate}%`,
      pass_rate: `${passRate}%`,
      avg_score: `${avgScore}%`,
      median_score: `${medianScore}%`,
      highest_score: `${maxScore}%`,
      lowest_score: `${minScore}%`,
      certificates_issued: certCount,
      scholarship_100: scholarshipDist['100%'],
      scholarship_50: scholarshipDist['50%'],
      scholarship_25: scholarshipDist['25%'],
      scholarship_10: scholarshipDist['10%']
    });
  }

  const summary = {
    total_exams: examRecords.length,
    total_registered: aggregateRegistered,
    total_completed: aggregateCompleted,
    total_passed: aggregatePassed,
    overall_pass_rate: aggregateCompleted > 0 ? formatPercentage((aggregatePassed / aggregateCompleted) * 100) : 0,
    overall_avg_percentage: allPercentages.length > 0 ? formatPercentage(ss.mean(allPercentages)) : 0,
    total_scholarships_awarded: aggregateScholarships
  };

  const columns = [
    { key: 'exam_id', label: 'Exam ID' },
    { key: 'title', label: 'Exam Title' },
    { key: 'status', label: 'Status' },
    { key: 'created_at', label: 'Created On' },
    { key: 'registered_candidates', label: 'Registered' },
    { key: 'completed_attempts', label: 'Completed' },
    { key: 'completion_rate', label: 'Completion %' },
    { key: 'passed_candidates', label: 'Passed' },
    { key: 'pass_rate', label: 'Pass %' },
    { key: 'avg_score', label: 'Avg Score' },
    { key: 'median_score', label: 'Median' },
    { key: 'highest_score', label: 'High' },
    { key: 'lowest_score', label: 'Low' },
    { key: 'certificates_issued', label: 'Certificates' }
  ];

  if (isExport) {
    return {
      reportType: 'exams',
      title: 'Consolidated Examination Performance Report',
      summary,
      columns,
      records: examRecords.slice(0, filters.limit || 10000),
      totalRecords: examRecords.length
    };
  }

  const paginated = paginateRecords(examRecords, filters.page, filters.limit);
  return {
    reportType: 'exams',
    title: 'Consolidated Examination Performance Report',
    summary,
    columns,
    records: paginated.records,
    pagination: paginated.pagination
  };
}

module.exports = { getExamReport };
