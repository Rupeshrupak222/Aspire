// ============================================================================
// ASPIRE DAY 23: REGISTRATION CONFIRMATION NOTIFICATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-reg-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { sendRegistrationConfirmation, queueNotification } = require('../backend/src/services/notifications/notification.service');
const { getNotificationPreferences, updateNotificationPreferences } = require('../backend/src/services/notifications/notification-preferences.service');
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
  console.log('DAY 23: REGISTRATION CONFIRMATION NOTIFICATIONS');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  // Ensure organization 1 and user 1 exist in temporary test database
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Test Org', 'test-org')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, organization_id) VALUES (1, 'admin@test.internal', 'hash', 'Test Admin', 'SUPER_ADMIN', 1)").run();

  try {
    console.log('--- 1. Registration Confirmation Event Queueing ---');
    const result = sendRegistrationConfirmation({
      organizationId: 1,
      studentId: 101,
      email: 'alex.rivera@example.com',
      name: 'Alex Rivera',
      college: 'Metropolitan Institute of Technology'
    });

    ok('sendRegistrationConfirmation returns non-null result', Boolean(result));
    ok('Event object returned', Boolean(result.event));
    ok('Event type is REGISTRATION_CONFIRMED', result.event.event_type === 'REGISTRATION_CONFIRMED');
    ok('Recipient email recorded', result.event.recipient_email === 'alex.rivera@example.com');
    ok('Delivery ID returned', Boolean(result.deliveryId));
    ok('isDuplicate is false on first send', result.isDuplicate === false);

    // Verify database state
    const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(result.deliveryId);
    ok('Delivery row exists in SQLite', Boolean(delivery));
    ok('Channel is EMAIL', delivery.channel === 'EMAIL');
    ok('Template key is REGISTRATION_CONFIRMED', delivery.template_key === 'REGISTRATION_CONFIRMED');

    // Verify outbox entry
    const outbox = db.prepare("SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'NOTIFICATION_EMAIL'").get(result.deliveryId);
    ok('Outbox event generated for transactional consistency', Boolean(outbox));
    ok('Outbox status is PENDING or DISPATCHED', ['PENDING', 'DISPATCHED'].includes(outbox.status));

    console.log('\n--- 2. Idempotency Key Duplicate Prevention ---');
    const dupResult = sendRegistrationConfirmation({
      organizationId: 1,
      studentId: 101,
      email: 'alex.rivera@example.com',
      name: 'Alex Rivera'
    });

    ok('Duplicate send detects existing record', dupResult.isDuplicate === true);
    ok('Duplicate deliveryId matches original', dupResult.deliveryId === result.deliveryId);

    const eventCount = db.prepare("SELECT COUNT(*) as c FROM notification_events WHERE idempotency_key = 'registration_confirmed_101'").get();
    ok('Exactly one event row exists in database for idempotency key', eventCount.c === 1);

    console.log('\n--- 3. Mandatory Receipt Delivery (Cannot Be Muted) ---');
    // Set preferences to disabled email for an existing admin user
    updateNotificationPreferences(1, 1, { email_enabled: false, registration_updates: false });
    const prefs = getNotificationPreferences(1, 1);
    ok('User explicitly disabled email preferences', prefs.emailEnabled === false);

    // Deliver notification
    const delRes = await deliverNotification(result.deliveryId);
    ok('Delivery execution succeeds', delRes.success === true);
    ok('Registration receipt delivered despite muted preferences (Mandatory Rule)', delRes.status === 'SENT' || delRes.status === 'DELIVERED');

    const sent = mock.findMessagesFor('alex.rivera@example.com');
    ok('Mock provider received registration email', sent.length >= 1);
    ok('Email subject contains Welcome or Registration', sent[0].subject.includes('Welcome') || sent[0].subject.includes('Registration'));
    ok('Email body contains recipient name', sent[0].html.includes('Alex Rivera'));

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
