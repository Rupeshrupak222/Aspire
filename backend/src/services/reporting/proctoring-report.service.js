// ============================================================================
// ASPIRE DAY 20: PROCTORING REPORT SERVICE
// ============================================================================
// Assessment integrity auditing, behavioral violation tracking, and
// candidate proctoring risk classification.
// Reuses Day 11 non-punitive risk classification matrix.
// ============================================================================

const { db } = require('../../db');
const { classifyRisk, RISK_LEVELS } = require('../proctoring-risk.service');
const {
  resolveReportDateFilter,
  buildTenantFilter,
  normalizeCollegeName,
  paginateRecords
} = require('./report-query.service');

function getProctoringReport({ organizationId = null, isSuperAdmin = false, filters = {}, isExport = false }) {
  const tenantFilter = buildTenantFilter(organizationId, isSuperAdmin, 'a.');
  const dateFilter = resolveReportDateFilter(filters, 'a.');

  const conditions = ['a.id IS NOT NULL'];
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

  if (filters.search) {
    const sTerm = `%${filters.search.toLowerCase().trim()}%`;
    conditions.push('(LOWER(s.name) LIKE ? OR LOWER(s.email) LIKE ? OR s.phone LIKE ? OR LOWER(s.college) LIKE ?)');
    params.push(sTerm, sTerm, sTerm, sTerm);
  }

  // Query distinct attempts with candidate and exam info
  const attemptsQuery = `
    SELECT
      a.id AS attempt_id,
      a.student_id,
      s.name AS candidate_name,
      s.email,
      s.phone AS mobile,
      s.college,
      COALESCE(e.name, 'General Assessment') AS exam_name,
      a.started_at,
      a.submitted_at,
      a.tab_switches
    FROM attempts a
    JOIN students s ON s.id = a.student_id
    LEFT JOIN exams e ON e.id = a.exam_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.started_at DESC, a.id DESC
  `;

  const attemptRows = db.prepare(attemptsQuery).all(...params);

  // Retrieve proctoring events for these attempts
  const records = [];
  let normalCount = 0;
  let warningCount = 0;
  let suspiciousCount = 0;
  let highRiskCount = 0;
  let totalEventsAll = 0;

  for (const att of attemptRows) {
    const events = db.prepare(`
      SELECT
        event_type,
        risk_points,
        event_timestamp,
        created_at
      FROM proctoring_events
      WHERE attempt_id = ?
      ORDER BY event_timestamp ASC
    `).all(att.attempt_id);

    let tabSwitchCount = att.tab_switches || 0;
    let windowBlurCount = 0;
    let fullscreenExitCount = 0;
    let copyCount = 0;
    let pasteCount = 0;
    let contextMenuCount = 0;
    let suspiciousPatternCount = 0;
    let calculatedRiskScore = 0;
    let firstEventAt = null;
    let lastEventAt = null;

    if (events.length > 0) {
      firstEventAt = events[0].event_timestamp || events[0].created_at;
      lastEventAt = events[events.length - 1].event_timestamp || events[events.length - 1].created_at;
    }

    for (const ev of events) {
      totalEventsAll++;
      calculatedRiskScore += (ev.risk_points || 0);

      const type = ev.event_type;
      if (type === 'TAB_SWITCH') tabSwitchCount++;
      else if (type === 'WINDOW_BLUR') windowBlurCount++;
      else if (type === 'FULLSCREEN_EXIT') fullscreenExitCount++;
      else if (type === 'COPY_ATTEMPT') copyCount++;
      else if (type === 'PASTE_ATTEMPT') pasteCount++;
      else if (type === 'CONTEXT_MENU_ATTEMPT') contextMenuCount++;
      else if (type === 'SUSPICIOUS_PATTERN') suspiciousPatternCount++;
    }

    // Tab switches recorded directly on attempt row if events table had fewer
    if (att.tab_switches && events.filter((e) => e.event_type === 'TAB_SWITCH').length === 0) {
      calculatedRiskScore += att.tab_switches * 10;
    }

    const riskClassification = classifyRisk(calculatedRiskScore);

    // Apply risk_level filter if specified
    if (filters.risk_level && filters.risk_level !== riskClassification) {
      continue;
    }

    if (riskClassification === RISK_LEVELS.NORMAL) normalCount++;
    else if (riskClassification === RISK_LEVELS.WARNING) warningCount++;
    else if (riskClassification === RISK_LEVELS.SUSPICIOUS) suspiciousCount++;
    else if (riskClassification === RISK_LEVELS.HIGH_RISK) highRiskCount++;

    records.push({
      candidate_id: att.student_id,
      candidate_name: att.candidate_name,
      college: normalizeCollegeName(att.college),
      exam_name: att.exam_name,
      attempt_id: att.attempt_id,
      total_events: events.length || (att.tab_switches > 0 ? att.tab_switches : 0),
      tab_switch_count: tabSwitchCount,
      window_blur_count: windowBlurCount,
      fullscreen_exit_count: fullscreenExitCount,
      copy_count: copyCount,
      paste_count: pasteCount,
      context_menu_count: contextMenuCount,
      suspicious_pattern_count: suspiciousPatternCount,
      risk_score: calculatedRiskScore,
      risk_classification: riskClassification,
      first_event_at: firstEventAt ? new Date(firstEventAt).toLocaleString('en-GB') : '—',
      last_event_at: lastEventAt ? new Date(lastEventAt).toLocaleString('en-GB') : '—',
      review_status: calculatedRiskScore > 20 ? 'PENDING_REVIEW' : 'NORMAL'
    });
  }

  // Sort by risk score descending by default
  records.sort((a, b) => b.risk_score - a.risk_score);

  const summary = {
    total_monitored_sessions: records.length,
    normal_risk_count: normalCount,
    warning_risk_count: warningCount,
    suspicious_risk_count: suspiciousCount,
    high_risk_count: highRiskCount,
    total_violations_recorded: totalEventsAll
  };

  const columns = [
    { key: 'candidate_id', label: 'Candidate ID' },
    { key: 'candidate_name', label: 'Candidate Name' },
    { key: 'college', label: 'College' },
    { key: 'exam_name', label: 'Exam' },
    { key: 'risk_score', label: 'Risk Score' },
    { key: 'risk_classification', label: 'Risk Level' },
    { key: 'total_events', label: 'Total Events' },
    { key: 'tab_switch_count', label: 'Tab Switches' },
    { key: 'window_blur_count', label: 'Window Blurs' },
    { key: 'fullscreen_exit_count', label: 'Fullscreen Exit' },
    { key: 'copy_count', label: 'Copy' },
    { key: 'paste_count', label: 'Paste' },
    { key: 'review_status', label: 'Review Flag' }
  ];

  if (isExport) {
    return {
      reportType: 'proctoring',
      title: 'Proctoring Integrity & Behavioral Risk Audit Report',
      summary,
      columns,
      records: records.slice(0, filters.limit || 10000),
      totalRecords: records.length
    };
  }

  const paginated = paginateRecords(records, filters.page, filters.limit);
  return {
    reportType: 'proctoring',
    title: 'Proctoring Integrity & Behavioral Risk Audit Report',
    summary,
    columns,
    records: paginated.records,
    pagination: paginated.pagination
  };
}

module.exports = { getProctoringReport };
