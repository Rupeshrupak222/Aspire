// ============================================================================
// ASPIRE DAY 20: SCHOLARSHIP REPORT SERVICE
// ============================================================================
// Authoritative reporting on scholarship tiers, awarded funding rates,
// recipient candidate rosters, and institutional allocation.
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

function getScholarshipReport({ organizationId = null, isSuperAdmin = false, filters = {}, isExport = false }) {
  const tenantFilter = buildTenantFilter(organizationId, isSuperAdmin, 'a.');
  const dateFilter = resolveReportDateFilter(filters, 'a.');

  const conditions = [
    "a.status = 'submitted'",
    'a.percentage IS NOT NULL'
  ];
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

  if (filters.scholarship_pct !== undefined && filters.scholarship_pct !== null) {
    conditions.push('a.scholarship_pct = ?');
    params.push(filters.scholarship_pct);
  } else {
    // By default, list candidates who were awarded scholarships or qualify for review
    if (filters.status === 'awarded_only') {
      conditions.push('a.scholarship_pct > 0');
    }
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
      a.id AS attempt_id,
      COALESCE(e.name, 'Aspire Scholarship Assessment') AS exam_name,
      a.score,
      a.total_marks AS max_marks,
      a.percentage,
      a.scholarship_pct,
      a.claim_code,
      a.certificate_id,
      a.submitted_at AS award_date,
      CASE
        WHEN a.certificate_id IS NOT NULL THEN 'VERIFIED'
        WHEN a.scholarship_pct > 0 THEN 'AWARDED'
        ELSE 'NOT_ELIGIBLE'
      END AS verification_status,
      CASE
        WHEN a.scholarship_pct = 100 THEN '100% Top Tier'
        WHEN a.scholarship_pct = 50 THEN '50% Distinguished Tier'
        WHEN a.scholarship_pct = 25 THEN '25% Merit Tier'
        WHEN a.scholarship_pct = 10 THEN '10% Foundation Tier'
        ELSE 'No Scholarship'
      END AS scholarship_tier
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    LEFT JOIN exams e ON e.id = a.exam_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.scholarship_pct DESC, a.percentage DESC, a.submitted_at DESC
  `;

  const rows = db.prepare(query).all(...params);

  let totalEligible = 0;
  let totalAwarded = 0;
  let count100 = 0;
  let count50 = 0;
  let count25 = 0;
  let count10 = 0;
  const awardedPercentages = [];

  const records = rows.map((r) => {
    totalEligible++;
    const pct = r.scholarship_pct || 0;
    if (pct > 0) {
      totalAwarded++;
      awardedPercentages.push(pct);
      if (pct === 100) count100++;
      else if (pct === 50) count50++;
      else if (pct === 25) count25++;
      else if (pct === 10) count10++;
    }

    return {
      candidate_id: r.candidate_id,
      candidate_name: r.candidate_name,
      email: r.email || '—',
      mobile: r.mobile || '—',
      college: normalizeCollegeName(r.college),
      exam_name: r.exam_name,
      score: r.score !== null ? formatPercentage(r.score) : '—',
      max_marks: r.max_marks !== null ? r.max_marks : '—',
      percentage: `${formatPercentage(r.percentage)}%`,
      scholarship_tier: r.scholarship_tier,
      scholarship_pct: `${pct}%`,
      raw_scholarship_pct: pct,
      claim_code: r.claim_code || '—',
      certificate_id: r.certificate_id || '—',
      award_date: r.award_date ? new Date(r.award_date).toLocaleDateString('en-GB') : '—',
      verification_status: r.verification_status
    };
  });

  const summary = {
    total_evaluated_candidates: totalEligible,
    total_scholarships_awarded: totalAwarded,
    scholarship_100_count: count100,
    scholarship_50_count: count50,
    scholarship_25_count: count25,
    scholarship_10_count: count10,
    average_awarded_percentage: awardedPercentages.length > 0 ? formatPercentage(ss.mean(awardedPercentages)) : 0
  };

  const columns = [
    { key: 'candidate_id', label: 'Candidate ID' },
    { key: 'candidate_name', label: 'Candidate Name' },
    { key: 'college', label: 'College' },
    { key: 'exam_name', label: 'Exam' },
    { key: 'percentage', label: 'Score %' },
    { key: 'scholarship_tier', label: 'Awarded Tier' },
    { key: 'scholarship_pct', label: 'Grant %' },
    { key: 'claim_code', label: 'Claim Code' },
    { key: 'certificate_id', label: 'Certificate' },
    { key: 'award_date', label: 'Award Date' },
    { key: 'verification_status', label: 'Status' }
  ];

  if (isExport) {
    return {
      reportType: 'scholarships',
      title: 'Scholarship Allocation & Recipient Roster Report',
      summary,
      columns,
      records: records.slice(0, filters.limit || 10000),
      totalRecords: records.length
    };
  }

  const paginated = paginateRecords(records, filters.page, filters.limit);
  return {
    reportType: 'scholarships',
    title: 'Scholarship Allocation & Recipient Roster Report',
    summary,
    columns,
    records: paginated.records,
    pagination: paginated.pagination
  };
}

module.exports = { getScholarshipReport };
