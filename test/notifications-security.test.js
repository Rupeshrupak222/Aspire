// ============================================================================
// ASPIRE DAY 23: NOTIFICATIONS SECURITY & TENANT ISOLATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-sec-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { queueNotification } = require('../backend/src/services/notifications/notification.service');
const {
  listDeliveries,
  getDelivery,
  retryDelivery,
  getNotificationMetrics
} = require('../backend/src/services/notifications/notification-delivery.service');
const { setEmailProvider, resetEmailProvider } = require('../backend/src/services/notifications/email.service');
const { MockEmailProvider } = require('../backend/src/services/notifications/providers/mock.provider');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function run() {
  console.log('====================================================');
  console.log('DAY 23: NOTIFICATIONS SECURITY & TENANT ISOLATION');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  // Setup two distinct organizations
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Alpha Corp', 'alpha')").run();
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (2, 'Beta Ltd', 'beta')").run();

  try {
    console.log('--- 1. Seed Tenant-Scoped Notifications ---');
    const { deliveryId: org1DelId } = queueNotification({
      organizationId: 1,
      eventType: 'EXAM_INVITATION',
      recipientEmail: 'candidate@alpha.org',
      payload: { name: 'Alpha Candidate' }
    });

    const { deliveryId: org2DelId } = queueNotification({
      organizationId: 2,
      eventType: 'EXAM_INVITATION',
      recipientEmail: 'candidate@beta.org',
      payload: { name: 'Beta Candidate' }
    });

    ok('Org 1 delivery created', Boolean(org1DelId));
    ok('Org 2 delivery created', Boolean(org2DelId));

    console.log('\n--- 2. Tenant Isolation in Notification Listing ---');
    const org1List = listDeliveries({ organizationId: 1 });
    ok('Org 1 list contains Org 1 delivery', org1List.deliveries.some((d) => d.id === org1DelId));
    ok('Org 1 list does NOT contain Org 2 delivery', !org1List.deliveries.some((d) => d.id === org2DelId));

    const org2List = listDeliveries({ organizationId: 2 });
    ok('Org 2 list contains Org 2 delivery', org2List.deliveries.some((d) => d.id === org2DelId));
    ok('Org 2 list does NOT contain Org 1 delivery', !org2List.deliveries.some((d) => d.id === org1DelId));

    console.log('\n--- 3. Cross-Tenant Direct Access Prevention (getDelivery) ---');
    // Org 1 accesses Org 1 -> OK
    const org1Self = getDelivery(org1DelId, 1);
    ok('Org 1 can read its own delivery', org1Self.id === org1DelId);

    // Org 2 tries to access Org 1 -> AuthorizationError
    let crossTenantBlocked = false;
    try {
      getDelivery(org1DelId, 2);
    } catch (err) {
      crossTenantBlocked = true;
      ok('Cross-tenant getDelivery throws AuthorizationError', err.status === 403 || err.message.includes('another organization'));
    }
    ok('Cross-tenant read access strictly blocked', crossTenantBlocked);

    console.log('\n--- 4. Cross-Tenant Unauthorized Retry Prevention (retryDelivery) ---');
    let crossRetryBlocked = false;
    try {
      await retryDelivery(org1DelId, 2); // Org 2 attempts to retry Org 1 delivery
    } catch (err) {
      crossRetryBlocked = true;
      ok('Cross-tenant retryDelivery throws AuthorizationError', err.status === 403 || err.message.includes('another organization'));
    }
    ok('Cross-tenant retry strictly blocked', crossRetryBlocked);

    console.log('\n--- 5. Super Admin Global Visibility ---');
    const superAdminList = listDeliveries({ organizationId: null });
    ok('Super Admin can list notifications across all tenants', superAdminList.deliveries.length >= 2);
    ok('Super Admin list includes Org 1', superAdminList.deliveries.some((d) => d.id === org1DelId));
    ok('Super Admin list includes Org 2', superAdminList.deliveries.some((d) => d.id === org2DelId));

    const superAdminGet = getDelivery(org1DelId, null);
    ok('Super Admin can access any tenant delivery directly', superAdminGet.id === org1DelId);

    console.log('\n--- 6. Tenant-Scoped Metric Isolation ---');
    const org1Metrics = getNotificationMetrics(1);
    const org2Metrics = getNotificationMetrics(2);
    const globalMetrics = getNotificationMetrics(null);

    ok('Org 1 metrics only count Org 1 notifications', org1Metrics.total === 1);
    ok('Org 2 metrics only count Org 2 notifications', org2Metrics.total === 1);
    ok('Global metrics count total across both orgs', globalMetrics.total === 2);

  } catch (err) {
    failures++;
    console.error('Unexpected test error:', err);
  } finally {
    resetEmailProvider();
    try {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    } catch {}
    process.exit(failures > 0 ? 1 : 0);
  }
}

run();

