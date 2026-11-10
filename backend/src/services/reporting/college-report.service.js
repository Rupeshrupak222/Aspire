// ============================================================================
// ASPIRE DAY 20: COLLEGE REPORT SERVICE
// ============================================================================
// Institutional benchmarking, candidate participation, academic outcomes,
// and scholarship allocation grouped by collegiate campus.
// ============================================================================

const ss = require('simple-statistics');
const { db } = require('../../db');
const {
  resolveReportDateFilter,
  buildTenantFilter,
  normalizeCollegeName,
  formatPercentage,
  paginateRecords
} = require('./report-query.service');

function getCollegeReport({ organizationId = null, isSuperAdmin = false, filters = {}, isExport = false }) {
  const tenantFilter = buildTenantFilter(organizationId, isSuperAdmin, 's.');
  const dateFilter = resolveReportDateFilter(filters, 's.');

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
    conditions.push('a.exam_id = ?');
    params.push(filters.exam_id);
  }

  if (filters.college) {
    conditions.push('LOWER(s.college) LIKE ?');
    params.push(`%${filters.college.toLowerCase().trim()}%`);
  }

  const query = `
    SELECT
      s.id AS candidate_id,
      s.college,
      a.id AS attempt_id,
      a.status AS attempt_status,
      a.started_at,
      a.submitted_at,
      a.percentage,
      a.scholarship_pct,
      a.certificate_id,
      COALESCE(e.passing_score, 40) AS passing_score
    FROM students s
    LEFT JOIN attempts a ON a.student_id = s.id
    LEFT JOIN exams e ON e.id = a.exam_id
    WHERE ${conditions.join(' AND ')}
  `;

  const rows = db.prepare(query).all(...params);

  // Group by normalized college name
  const collegeMap = new Map();

  for (const row of rows) {
    const collegeName = normalizeCollegeName(row.college);
    if (!collegeMap.has(collegeName)) {
      collegeMap.set(collegeName, {
        college_name: collegeName,
        candidateIds: new Set(),
        startedAttemptIds: new Set(),
        completedAttemptIds: new Set(),
        abandonedCount: 0,
        scores: [],
        passCandidateIds: new Set(),
        failCandidateIds: new Set(),
        certCount: 0,
        scholarshipCount: 0,
        dist100: 0,
        dist50: 0,
        dist25: 0,
        dist10: 0
      });
    }

    const cData = collegeMap.get(collegeName);
    cData.candidateIds.add(row.candidate_id);

    if (row.attempt_id) {
      if (row.started_at) {
        cData.startedAttemptIds.add(row.attempt_id);
      }

      if (row.attempt_status === 'submitted') {
        cData.completedAttemptIds.add(row.attempt_id);
        if (row.percentage !== null && row.percentage !== undefined) {
          cData.scores.push(row.percentage);
          if (row.percentage >= row.passing_score) {
            cData.passCandidateIds.add(row.candidate_id);
          } else {
            cData.failCandidateIds.add(row.candidate_id);
          }
        }
        if (row.certificate_id) cData.certCount++;

        const pct = row.scholarship_pct || 0;
        if (pct > 0) cData.scholarshipCount++;
        if (pct === 100) cData.dist100++;
        else if (pct === 50) cData.dist50++;
        else if (pct === 25) cData.dist25++;
        else if (pct === 10) cData.dist10++;
      } else if (row.attempt_status === 'abandoned') {
        cData.abandonedCount++;
      }
    }
  }

  // Convert map to records array
  const records = [];
  let topCollege = '—';
  let topAvg = -1;
  let totalInstitutionalCandidates = 0;
  let totalInstitutionalScholarships = 0;

  for (const [name, d] of collegeMap.entries()) {
    const regCount = d.candidateIds.size;
    const startCount = d.startedAttemptIds.size;
    const compCount = d.completedAttemptIds.size;
    const passCount = d.passCandidateIds.size;
    const failCount = d.failCandidateIds.size;

    totalInstitutionalCandidates += regCount;
    totalInstitutionalScholarships += d.scholarshipCount;

    const passRate = compCount > 0 ? formatPercentage((passCount / compCount) * 100) : 0;

    let avgScore = 0;
    let medianScore = 0;
    let highestScore = 0;

    if (d.scores.length > 0) {
      avgScore = formatPercentage(ss.mean(d.scores));
      medianScore = formatPercentage(ss.median(d.scores));
      highestScore = formatPercentage(ss.max(d.scores));

      if (avgScore > topAvg && compCount >= 2) {
        topAvg = avgScore;
        topCollege = name;
      }
    }

    records.push({
      college_name: name,
      registered_candidates: regCount,
      started_attempts: startCount,
      completed_attempts: compCount,
      abandoned_attempts: d.abandonedCount,
      avg_score: `${avgScore}%`,
      raw_avg_score: avgScore,
      median_score: `${medianScore}%`,
      highest_score: `${highestScore}%`,
      pass_count: passCount,
      fail_count: failCount,
      pass_rate: `${passRate}%`,
      raw_pass_rate: passRate,
      scholarships_awarded: d.scholarshipCount,
      scholarship_100: d.dist100,
      scholarship_50: d.dist50,
      scholarship_25: d.dist25,
      scholarship_10: d.dist10,
      certificates_generated: d.certCount
    });
  }

  // Sorting
  const sortBy = filters.sort_by || 'registered_candidates';
  const sortOrder = filters.sort_order === 'asc' ? 1 : -1;

  records.sort((a, b) => {
    let aVal = a[sortBy];
    let bVal = b[sortBy];
    if (sortBy === 'avg_score') { aVal = a.raw_avg_score; bVal = b.raw_avg_score; }
    if (sortBy === 'pass_rate') { aVal = a.raw_pass_rate; bVal = b.raw_pass_rate; }
    if (typeof aVal === 'string') return aVal.localeCompare(bVal) * sortOrder;
    return ((aVal || 0) - (bVal || 0)) * sortOrder;
  });

  const summary = {
    total_colleges: records.length,
    top_performing_college: topCollege,
    total_candidates: totalInstitutionalCandidates,
    total_scholarships_awarded: totalInstitutionalScholarships
  };

  const columns = [
    { key: 'college_name', label: 'College / Institution' },
    { key: 'registered_candidates', label: 'Registered' },
    { key: 'started_attempts', label: 'Started' },
    { key: 'completed_attempts', label: 'Completed' },
    { key: 'abandoned_attempts', label: 'Abandoned' },
    { key: 'avg_score', label: 'Avg Score' },
    { key: 'median_score', label: 'Median' },
    { key: 'highest_score', label: 'Highest' },
    { key: 'pass_count', label: 'Passed' },
    { key: 'pass_rate', label: 'Pass %' },
    { key: 'scholarships_awarded', label: 'Scholarships' },
    { key: 'certificates_generated', label: 'Certificates' }
  ];

  if (isExport) {
    return {
      reportType: 'colleges',
      title: 'Institutional College Performance Benchmark Report',
      summary,
      columns,
      records: records.slice(0, filters.limit || 10000),
      totalRecords: records.length
    };
  }

  const paginated = paginateRecords(records, filters.page, filters.limit);
  return {
    reportType: 'colleges',
    title: 'Institutional College Performance Benchmark Report',
    summary,
    columns,
    records: paginated.records,
    pagination: paginated.pagination
  };
}

module.exports = { getCollegeReport };

