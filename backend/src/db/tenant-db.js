// Tenant-Aware Database Helper for SQLite.
// Enforces database-level organization isolation and guarantees fail-closed queries.

const { getTenantContext, getOrganizationId, isPlatformAdmin } = require('../utils/tenant-context');
const { AuthorizationError, NotFoundError, AppError } = require('../errors/app-error');

/**
 * Build a tenant-scoped SQL WHERE clause fragment.
 *
 * @param {string} [columnName='organization_id']
 * @param {Object} [options]
 * @param {string|null} [options.tableAlias=null]
 * @param {boolean} [options.required=true]
 * @returns {{ sql: string, params: any[] }}
 */
function buildTenantFilter(columnName = 'organization_id', { tableAlias = null, required = true } = {}) {
  const col = tableAlias ? `${tableAlias}.${columnName}` : columnName;
  const context = getTenantContext();

  if (isPlatformAdmin()) {
    // If Super Admin targeted a specific organization, filter to that org; otherwise open
    if (context?.organizationId) {
      return { sql: `${col} = ?`, params: [context.organizationId] };
    }
    return { sql: '1=1', params: [] };
  }

  const orgId = getOrganizationId({ required });
  if (orgId === null) {
    if (required) {
      throw new AppError('Tenant context is required for this query', 403, 'TENANT_CONTEXT_MISSING');
    }
    return { sql: '1=1', params: [] };
  }

  return { sql: `${col} = ?`, params: [orgId] };
}

/**
 * Asserts that the entity's organization matches the active tenant context.
 *
 * @param {number|null} entityOrgId
 * @param {string} [resourceName='resource']
 * @throws {AuthorizationError} if access is forbidden across tenant boundaries
 */
function assertTenantAccess(entityOrgId, resourceName = 'resource') {
  if (isPlatformAdmin()) {
    return true;
  }

  const activeOrgId = getOrganizationId({ required: true });

  if (entityOrgId === null || Number(entityOrgId) !== Number(activeOrgId)) {
    throw new AuthorizationError(`Access denied: ${resourceName} belongs to another organization.`);
  }

  return true;
}

/**
 * Prepare an insert record by automatically binding the active organization ID.
 * Prevents client overrides of organization ownership.
 *
 * @param {Object} record
 * @param {string} [orgColumn='organization_id']
 * @returns {Object}
 */
function scopeInsert(record, orgColumn = 'organization_id') {
  const context = getTenantContext();
  let assignedOrgId;

  if (isPlatformAdmin()) {
    assignedOrgId = record[orgColumn] || context?.organizationId || 1;
  } else {
    assignedOrgId = getOrganizationId({ required: true });
  }

  return {
    ...record,
    [orgColumn]: assignedOrgId
  };
}

module.exports = {
  buildTenantFilter,
  assertTenantAccess,
  scopeInsert,
  getOrganizationId,
  isPlatformAdmin
};

