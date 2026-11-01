// Tenant Context Management using Node.js native AsyncLocalStorage.
// Provides secure, asynchronous thread-local context for multi-tenant SaaS isolation.
// Prevents cross-tenant data leakage across asynchronous execution flows.

const { AsyncLocalStorage } = require('node:async_hooks');
const { AuthorizationError, AppError } = require('../errors/app-error');

const tenantStorage = new AsyncLocalStorage();

/**
 * Create a structured tenant context object.
 *
 * @param {Object} params
 * @param {number|null} params.organizationId
 * @param {number|null} [params.userId]
 * @param {string|null} [params.role]
 * @param {string|null} [params.requestId]
 * @param {boolean} [params.isPlatformAdmin=false]
 * @returns {Object}
 */
function createTenantContext({
  organizationId = null,
  userId = null,
  role = null,
  requestId = null,
  isPlatformAdmin = false
} = {}) {
  return {
    organizationId: organizationId !== null ? Number(organizationId) : null,
    userId: userId !== null ? Number(userId) : null,
    role: role || null,
    requestId: requestId || null,
    isPlatformAdmin: Boolean(isPlatformAdmin),
    createdAt: Date.now()
  };
}

/**
 * Execute a callback within an explicit tenant context.
 *
 * @template T
 * @param {Object} tenantContext
 * @param {() => T} callback
 * @returns {T}
 */
function runWithTenant(tenantContext, callback) {
  const context = tenantContext && typeof tenantContext === 'object' && tenantContext.createdAt
    ? tenantContext
    : createTenantContext(tenantContext || {});
  return tenantStorage.run(context, callback);
}

/**
 * Retrieve the current active tenant context, or null if outside context.
 *
 * @returns {Object|null}
 */
function getTenantContext() {
  return tenantStorage.getStore() || null;
}

/**
 * Retrieve the current organization ID.
 *
 * @param {Object} [options]
 * @param {boolean} [options.required=true]
 * @returns {number|null}
 * @throws {AppError} If required is true and tenant context is missing.
 */
function getOrganizationId({ required = true } = {}) {
  const context = getTenantContext();

  if (!context?.organizationId) {
    if (context?.isPlatformAdmin) {
      // Platform admin without a targeted org
      return null;
    }
    if (required) {
      throw new AppError('Tenant context is required for this operation', 403, 'TENANT_CONTEXT_MISSING');
    }
    return null;
  }

  return context.organizationId;
}

/**
 * Check if the active context is a platform super-administrator.
 *
 * @returns {boolean}
 */
function isPlatformAdmin() {
  const context = getTenantContext();
  return Boolean(context?.isPlatformAdmin);
}

module.exports = {
  tenantStorage,
  createTenantContext,
  runWithTenant,
  getTenantContext,
  getOrganizationId,
  isPlatformAdmin
};
