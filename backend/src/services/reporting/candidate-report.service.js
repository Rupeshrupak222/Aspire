// ============================================================================
// ASPIRE DAY 20: CANDIDATE REPORT SERVICE
// ============================================================================
// Generates comprehensive candidate registration, participation, performance,
// and scholarship allocation reports with tenant boundary enforcement.
// ============================================================================

const { db } = require('../../db');
const {
  resolveReportDateFilter,
  buildTenantFilter,
  normalizeCollegeName,
  formatPercentage,
  paginateRecords
} = require('./report-query.service');

function getCandidateReport({ organizationId = null, isSuperAdmin = false, filters = {}, isExport = false }) {
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
    conditions.push('(a.exam_id = ? OR (a.exam_id IS NULL AND ? IS NULL))');
    params.push(filters.exam_id, filters.exam_id);
  }

  if (filters.college) {
    conditions.push('LOWER(s.college) LIKE ?');
    params.push(`%${filters.college.toLowerCase().trim()}%`);
  }

  if (filters.branch) {
    conditions.push('LOWER(s.track) LIKE ?');
    params.push(`%${filters.branch.toLowerCase().trim()}%`);
  }

  if (filters.grad_year) {
    conditions.push('s.grad_year = ?');
    params.push(filters.grad_year.trim());
  }

  if (filters.status) {
    conditions.push("LOWER(COALESCE(a.status, 'unattempted')) = ?");
    params.push(filters.status.toLowerCase().trim());
  }

  if (filters.min_score !== undefined && filters.min_score !== null) {
    conditions.push('a.percentage >= ?');
    params.push(filters.min_score);
  }

  if (filters.max_score !== undefined && filters.max_score !== null) {
    conditions.push('a.percentage <= ?');
    params.push(filters.max_score);
  }

  if (filters.scholarship_pct !== undefined && filters.scholarship_pct !== null) {
    conditions.push('a.scholarship_pct = ?');
    params.push(filters.scholarship_pct);
  }

  if (filters.search) {
    const sTerm = `%${filters.search.toLowerCase().trim()}%`;
    conditions.push('(LOWER(s.name) LIKE ? OR LOWER(s.email) LIKE ? OR s.phone LIKE ? OR LOWER(s.college) LIKE ?)');
    params.push(sTerm, sTerm, sTerm, sTerm);
  }

  const query = `
    SELECT
      s.id AS candidate_id,
      s.name AS candidate_name,
      s.email,
      s.phone AS mobile,
      s.college,
      s.track AS branch,
      s.grad_year,
      s.created_at AS registration_date,
      a.id AS attempt_id,
      COALESCE(e.name, 'General Assessment') AS exam_name,
      a.started_at AS attempt_started_at,
      a.submitted_at,
      COALESCE(a.status, 'unattempted') AS attempt_status,
      a.score,
      a.total_marks AS max_marks,
      a.percentage,
      a.scholarship_pct,
      a.certificate_id,
      CASE
        WHEN a.certificate_id IS NOT NULL THEN 'ISSUED'
        WHEN a.status = 'submitted' AND a.percentage >= COALESCE(e.passing_score, 40) THEN 'ELIGIBLE'
        ELSE 'NOT_ISSUED'
      END AS certificate_status,
      CASE
        WHEN a.scholarship_pct = 100 THEN '100% Scholarship (Distinguished Achiever)'
        WHEN a.scholarship_pct = 50 THEN '50% Scholarship (Honours Tier)'
        WHEN a.scholarship_pct = 25 THEN '25% Scholarship (Merit Tier)'
        WHEN a.scholarship_pct = 10 THEN '10% Scholarship (Foundation Grant)'
        ELSE 'None'
      END AS scholarship_tier
    FROM students s
    LEFT JOIN attempts a ON a.student_id = s.id
    LEFT JOIN exams e ON e.id = a.exam_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.created_at DESC, a.id DESC
  `;

  const rows = db.prepare(query).all(...params);

  // Compute summary metrics across unique candidates and completed attempts
  const uniqueCandidateIds = new Set();
  let totalAttempts = 0;
  let completedAttempts = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  let passCount = 0;
  let scholarshipCount = 0;

  const records = rows.map((r) => {
    uniqueCandidateIds.add(r.candidate_id);
    if (r.attempt_id) totalAttempts++;
    if (r.attempt_status === 'submitted') {
      completedAttempts++;
      if (r.percentage !== null && r.percentage !== undefined) {
        scoreSum += r.percentage;
        scoreCount++;
        if (r.percentage >= 40) passCount++;
      }
      if (r.scholarship_pct && r.scholarship_pct > 0) scholarshipCount++;
    }

    return {
      candidate_id: r.candidate_id,
      candidate_name: r.candidate_name,
      email: r.email || '—',
      mobile: r.mobile || '—',
      college: normalizeCollegeName(r.college),
      branch: r.branch || 'General',
      grad_year: r.grad_year || '—',
      exam_name: r.exam_name,
      registration_date: r.registration_date ? new Date(r.registration_date).toLocaleDateString('en-GB') : '—',
      attempt_started_at: r.attempt_started_at ? new Date(r.attempt_started_at).toLocaleString('en-GB') : '—',
      submitted_at: r.submitted_at ? new Date(r.submitted_at).toLocaleString('en-GB') : '—',
      attempt_status: (r.attempt_status || 'unattempted').toUpperCase(),
      score: r.score !== null ? formatPercentage(r.score) : '—',
      max_marks: r.max_marks !== null ? r.max_marks : '—',
      percentage: r.percentage !== null ? `${formatPercentage(r.percentage)}%` : '—',
      raw_percentage: r.percentage,
      scholarship_tier: r.scholarship_tier,
      scholarship_pct: r.scholarship_pct !== null ? `${r.scholarship_pct}%` : '0%',
      certificate_status: r.certificate_status
    };
  });

  const summary = {
    total_candidates: uniqueCandidateIds.size,
    total_attempts: totalAttempts,
    completed_attempts: completedAttempts,
    average_percentage: scoreCount > 0 ? formatPercentage(scoreSum / scoreCount) : 0,
    passed_candidates: passCount,
    scholarships_awarded: scholarshipCount
  };

  const columns = [
    { key: 'candidate_id', label: 'Candidate ID' },
    { key: 'candidate_name', label: 'Candidate Name' },
    { key: 'email', label: 'Email' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'college', label: 'College' },
    { key: 'branch', label: 'Branch / Track' },
    { key: 'grad_year', label: 'Grad Year' },
    { key: 'exam_name', label: 'Exam' },
    { key: 'registration_date', label: 'Registered On' },
    { key: 'attempt_status', label: 'Status' },
    { key: 'score', label: 'Score' },
    { key: 'max_marks', label: 'Max Marks' },
    { key: 'percentage', label: 'Percentage' },
    { key: 'scholarship_tier', label: 'Scholarship Tier' },
    { key: 'certificate_status', label: 'Certificate' }
  ];

  if (isExport) {
    return {
      reportType: 'candidates',
      title: 'Candidate Participation & Performance Report',
      summary,
      columns,
      records: records.slice(0, filters.limit || 10000),
      totalRecords: records.length
    };
  }

  const paginated = paginateRecords(records, filters.page, filters.limit);
  return {
    reportType: 'candidates',
    title: 'Candidate Participation & Performance Report',
    summary,
    columns,
    records: paginated.records,
    pagination: paginated.pagination
  };
}

module.exports = { getCandidateReport };
