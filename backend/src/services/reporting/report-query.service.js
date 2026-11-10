// ============================================================================
// ASPIRE DAY 20: REPORT QUERY UTILITY SERVICE
// ============================================================================
// Authoritative parameterized SQL builders, tenant context scoping,
// and date boundary handlers for the Reporting System.
// ============================================================================

const { ValidationError } = require('../../errors/app-error');

/**
 * Resolves start/end UTC dates based on filter period and optional explicit ISO strings.
 */
function resolveReportDateFilter(filters = {}, prefix = 'a.') {
  const { period = 'all', start_date, end_date } = filters;
  const now = new Date();
  let startMs = null;
  let endMs = null;

  if (period === 'today') {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    startMs = today.getTime();
    endMs = now.getTime();
  } else if (period === '7d') {
    startMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    endMs = now.getTime();
  } else if (period === '30d') {
    startMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
    endMs = now.getTime();
  } else if (period === '90d') {
    startMs = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    endMs = now.getTime();
  } else if (period === 'custom' || start_date || end_date) {
    if (start_date) startMs = new Date(start_date).getTime();
    if (end_date) endMs = new Date(end_date).getTime();
  }

  const clauses = [];
  const params = [];

  if (startMs !== null && !isNaN(startMs)) {
    clauses.push(`${prefix}created_at >= ?`);
    params.push(new Date(startMs).toISOString());
  }

  if (endMs !== null && !isNaN(endMs)) {
    clauses.push(`${prefix}created_at <= ?`);
    params.push(new Date(endMs).toISOString());
  }

  return {
    sql: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '',
    params,
    startDateStr: startMs ? new Date(startMs).toISOString() : null,
    endDateStr: endMs ? new Date(endMs).toISOString() : null
  };
}

/**
 * Builds tenant-isolation SQL condition and parameters.
 */
function buildTenantFilter(organizationId, isSuperAdmin = false, prefix = 'a.') {
  if (isSuperAdmin && !organizationId) {
    return { sql: '', params: [] };
  }
  return {
    sql: `AND ${prefix}organization_id = ?`,
    params: [organizationId]
  };
}

/**
 * Normalizes college name to prevent duplicate buckets or null display issues.
 */
function normalizeCollegeName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'Not Specified';
  const trimmed = rawName.trim();
  return trimmed.length > 0 ? trimmed : 'Not Specified';
}

/**
 * Formats a percentage safely to 1 decimal place.
 */
function formatPercentage(num) {
  if (num === null || num === undefined || isNaN(num)) return 0;
  return Math.round(Number(num) * 10) / 10;
}

/**
 * Paginate an in-memory array of records safely.
 */
function paginateRecords(records, page = 1, limit = 25) {
  const totalRecords = records.length;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.max(1, parseInt(limit, 10) || 25);
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageLimit));
  const offset = (pageNum - 1) * pageLimit;
  const paginated = records.slice(offset, offset + pageLimit);

  return {
    records: paginated,
    pagination: {
      page: pageNum,
      limit: pageLimit,
      totalRecords,
      totalPages,
      hasNext: pageNum < totalPages,
      hasPrev: pageNum > 1
    }
  };
}

module.exports = {
  resolveReportDateFilter,
  buildTenantFilter,
  normalizeCollegeName,
  formatPercentage,
  paginateRecords
};

