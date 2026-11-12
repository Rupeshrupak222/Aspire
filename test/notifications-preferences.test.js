// ============================================================================
// ASPIRE DAY 23: NOTIFICATION PREFERENCES TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-pref-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const {
  getNotificationPreferences,
  updateNotificationPreferences,
  isNotificationPermitted,
  MANDATORY_EVENT_TYPES
} = require('../backend/src/services/notifications/notification-preferences.service');
const { queueNotification } = require('../backend/src/services/notifications/notification.service');
const { deliverNotification } = require('../backend/src/services/notifications/notification-delivery.service');
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
  console.log('DAY 23: NOTIFICATION PREFERENCES TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, organization_id) VALUES (1, 'admin@adyapan.internal', 'hash', 'Admin', 'ORG_ADMIN', 1)").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, organization_id) VALUES (2, 'student@adyapan.internal', 'hash', 'Staff Viewer', 'VIEWER', 1)").run();

  try {
    console.log('--- 1. Default Preferences Initialization ---');
    const prefs = getNotificationPreferences(1, 2);
    ok('Preferences object created', Boolean(prefs));
    ok('emailEnabled defaults to true', prefs.emailEnabled === true);
    ok('registrationUpdates defaults to true', prefs.registrationUpdates === true);
    ok('examInvitations defaults to true', prefs.examInvitations === true);
    ok('examReminders defaults to true', prefs.examReminders === true);
    ok('resultUpdates defaults to true', prefs.resultUpdates === true);
    ok('certificateUpdates defaults to true', prefs.certificateUpdates === true);

    console.log('\n--- 2. Updating Granular Preferences ---');
    const updated = updateNotificationPreferences(1, 2, {
      exam_reminders: false,
      result_updates: false
    });

    ok('examReminders updated to false', updated.examReminders === false);
    ok('resultUpdates updated to false', updated.resultUpdates === false);
    ok('examInvitations remains true', updated.examInvitations === true);

    console.log('\n--- 3. Mandatory vs Optional Communication Rules ---');
    ok('REGISTRATION_CONFIRMED is in MANDATORY_EVENT_TYPES', MANDATORY_EVENT_TYPES.includes('REGISTRATION_CONFIRMED'));
    ok('isNotificationPermitted returns true for REGISTRATION_CONFIRMED even with muted categories', isNotificationPermitted(1, 2, 'REGISTRATION_CONFIRMED') === true);

    ok('isNotificationPermitted returns false for EXAM_REMINDER when muted', isNotificationPermitted(1, 2, 'EXAM_REMINDER') === false);
    ok('isNotificationPermitted returns false for RESULT_AVAILABLE when muted', isNotificationPermitted(1, 2, 'RESULT_AVAILABLE') === false);
    ok('isNotificationPermitted returns true for EXAM_INVITATION when enabled', isNotificationPermitted(1, 2, 'EXAM_INVITATION') === true);

    console.log('\n--- 4. Master Global Email Toggle ---');
    updateNotificationPreferences(1, 2, { email_enabled: false });
    ok('isNotificationPermitted returns false for EXAM_INVITATION when global email is off', isNotificationPermitted(1, 2, 'EXAM_INVITATION') === false);
    ok('isNotificationPermitted STILL returns true for REGISTRATION_CONFIRMED (Mandatory account receipt)', isNotificationPermitted(1, 2, 'REGISTRATION_CONFIRMED') === true);

    console.log('\n--- 5. Delivery Muting Lifecycle (CANCELLED Status) ---');
    const { deliveryId } = queueNotification({
      organizationId: 1,
      recipientUserId: 2,
      eventType: 'EXAM_REMINDER',
      recipientEmail: 'muted.user@example.com',
      payload: { name: 'Muted User' }
    });

    const delRes = await deliverNotification(deliveryId);
    ok('Delivery marked as CANCELLED when muted', delRes.status === 'CANCELLED');
    ok('Cancellation reason is MUTED_BY_PREFERENCES', delRes.reason === 'MUTED_BY_PREFERENCES');

    const dbRow = db.prepare('SELECT status, last_error_code FROM notification_deliveries WHERE id = ?').get(deliveryId);
    ok('Database delivery status recorded as CANCELLED', dbRow.status === 'CANCELLED');
    ok('Database last_error_code is MUTED_BY_PREFERENCES', dbRow.last_error_code === 'MUTED_BY_PREFERENCES');

    // Email was NOT sent to provider
    const sent = mock.findMessagesFor('muted.user@example.com');
    ok('Zero emails dispatched to provider for muted notification', sent.length === 0);

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
