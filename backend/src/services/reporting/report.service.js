// ============================================================================
// ASPIRE DAY 20: CENTRAL REPORTING ORCHESTRATION SERVICE
// ============================================================================
// Unified orchestration for report generation, preview data pipelines,
// filter resolution, and multi-format export streaming.
// Enforces tenant isolation, audit logging, and safe memory limits.
// ============================================================================

const { db } = require('../../db');
const { ValidationError, NotFoundError } = require('../../errors/app-error');
const { recordAuditEvent } = require('../audit.service');
const orgService = require('../organization.service');

const { getCandidateReport } = require('./candidate-report.service');
const { getExamReport } = require('./exam-report.service');
const { getCollegeReport } = require('./college-report.service');
const { getScholarshipReport } = require('./scholarship-report.service');
const { getQuestionReport } = require('./question-report.service');
const { getProctoringReport } = require('./proctoring-report.service');

const { generateCsv } = require('./csv-export.service');
const { generateExcel } = require('./excel-export.service');
const { generatePdf } = require('./pdf-export.service');

const REPORT_DISPATCHER = {
  candidates: getCandidateReport,
  exams: getExamReport,
  colleges: getCollegeReport,
  scholarships: getScholarshipReport,
  questions: getQuestionReport,
  proctoring: getProctoringReport
};

/**
 * Retrieves preview report data with server-side pagination and KPIs.
 */
function getReportPreview({
  reportType,
  organizationId = null,
  isSuperAdmin = false,
  filters = {}
}) {
  const handler = REPORT_DISPATCHER[reportType];
  if (!handler) {
    throw new ValidationError(`Unsupported report type: '${reportType}'`);
  }

  const organization = organizationId ? orgService.findOrganizationById(organizationId) : null;

  const result = handler({
    organizationId,
    isSuperAdmin,
    filters,
    isExport: false
  });

  return {
    ...result,
    organization: organization ? {
      id: organization.id,
      name: organization.name,
      slug: organization.slug
    } : { id: 0, name: 'Aspire Platform', slug: 'aspire-platform' },
    filtersApplied: filters
  };
}

/**
 * Generates an export file buffer (CSV, Excel, or PDF) for the complete filtered dataset.
 */
async function exportReport({
  reportType,
  format,
  organizationId = null,
  isSuperAdmin = false,
  filters = {},
  actorId = null,
  req = null
}) {
  const handler = REPORT_DISPATCHER[reportType];
  if (!handler) {
    throw new ValidationError(`Unsupported report type: '${reportType}'`);
  }

  const organization = organizationId ? orgService.findOrganizationById(organizationId) : null;

  // Retrieve complete filtered dataset up to safe limit (10,000 records)
  const reportData = handler({
    organizationId,
    isSuperAdmin,
    filters: { ...filters, limit: Math.min(10000, filters.limit || 10000) },
    isExport: true
  });

  reportData.organization = organization ? {
    id: organization.id,
    name: organization.name,
    slug: organization.slug
  } : { id: 0, name: 'Aspire Platform', slug: 'aspire-platform' };

  let buffer;
  let contentType;
  let extension;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const orgSlug = organization ? organization.slug : 'aspire';
  const filename = `${orgSlug}-${reportType}-report-${timestamp}`;

  if (format === 'csv') {
    const csvContent = generateCsv(reportData);
    buffer = Buffer.from(csvContent, 'utf-8');
    contentType = 'text/csv; charset=utf-8';
    extension = 'csv';
  } else if (format === 'xlsx') {
    buffer = generateExcel(reportData);
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    extension = 'xlsx';
  } else if (format === 'pdf') {
    buffer = await generatePdf(reportData);
    contentType = 'application/pdf';
    extension = 'pdf';
  } else {
    throw new ValidationError(`Unsupported export format: '${format}'`);
  }

  // Audit logging for export event
  try {
    recordAuditEvent({
      req,
      event: 'report_exported',
      organizationId: organizationId || (organization ? organization.id : null),
      details: {
        reportType,
        format,
        recordCount: reportData.records.length,
        actorId,
        filters: sanitizeFilterDetails(filters)
      }
    });
  } catch {
    // Non-blocking for audit failure
  }

  return {
    buffer,
    contentType,
    filename: `${filename}.${extension}`,
    recordCount: reportData.records.length
  };
}

/**
 * Retrieves dynamic filter options (exams list, colleges list, etc.) for UI controls.
 */
function getReportOptions({ organizationId = null, isSuperAdmin = false }) {
  const tenantExamFilter = isSuperAdmin && !organizationId ? '' : 'WHERE organization_id = ?';
  const tenantExamParams = isSuperAdmin && !organizationId ? [] : [organizationId];

  const exams = db.prepare(`
    SELECT id, name AS title, status FROM exams ${tenantExamFilter} ORDER BY name ASC
  `).all(...tenantExamParams);

  const studentWhere = isSuperAdmin && !organizationId ? 'WHERE college IS NOT NULL' : 'WHERE organization_id = ? AND college IS NOT NULL';
  const tenantStudentParams = isSuperAdmin && !organizationId ? [] : [organizationId];

  const collegesRaw = db.prepare(`
    SELECT DISTINCT college FROM students ${studentWhere} ORDER BY college ASC
  `).all(...tenantStudentParams);

  const colleges = collegesRaw
    .map((c) => (c.college ? c.college.trim() : ''))
    .filter((c) => c.length > 0);

  const categoriesRaw = db.prepare(`
    SELECT DISTINCT category FROM questions ORDER BY category ASC
  `).all();
  const categories = categoriesRaw.map((c) => c.category).filter(Boolean);

  return {
    reportTypes: [
      { id: 'candidates', label: 'Candidate Report', description: 'Registration, participation, performance, and scholarship outcomes.' },
      { id: 'exams', label: 'Exam Report', description: 'Consolidated assessment completion funnel and statistics.' },
      { id: 'colleges', label: 'College Report', description: 'Institutional benchmark and collegiate participation comparison.' },
      { id: 'scholarships', label: 'Scholarship Report', description: 'Scholarship tiers, award percentages, and recipient claim verification.' },
      { id: 'questions', label: 'Question Report', description: 'Psychometrics, item difficulty, and Kelley discrimination index.' },
      { id: 'proctoring', label: 'Proctoring Report', description: 'Integrity monitoring, violation frequency, and behavioral risk audit.' }
    ],
    formats: ['csv', 'xlsx', 'pdf'],
    exams,
    colleges,
    categories,
    riskLevels: ['NORMAL', 'WARNING', 'SUSPICIOUS', 'HIGH_RISK'],
    scholarshipTiers: [
      { pct: 100, label: '100% Scholarship' },
      { pct: 50, label: '50% Scholarship' },
      { pct: 25, label: '25% Scholarship' },
      { pct: 10, label: '10% Scholarship' },
      { pct: 0, label: 'No Scholarship' }
    ]
  };
}

function sanitizeFilterDetails(filters = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') {
      safe[k] = v;
    }
  }
  return safe;
}

module.exports = {
  getReportPreview,
  exportReport,
  getReportOptions
};
