// ============================================================================
// ASPIRE DAY 23: NOTIFICATION RETRY & BACKOFF TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-retry-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { queueNotification } = require('../backend/src/services/notifications/notification.service');
const { deliverNotification, retryDelivery, MAX_DELIVERY_ATTEMPTS } = require('../backend/src/services/notifications/notification-delivery.service');
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
  console.log('DAY 23: NOTIFICATION RETRY & BACKOFF TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. Transient Error & Attempt Counter Increment ---');
    const { deliveryId } = queueNotification({
      organizationId: 1,
      eventType: 'EXAM_COMPLETED',
      recipientEmail: 'transient.fail@example.com',
      payload: { name: 'Retry Candidate' }
    });

    // Simulate transient failure
    mock.simulateFailure(new Error('503 Service Unavailable from mail provider'), 'TRANSIENT');

    const attempt1 = await deliverNotification(deliveryId);
    ok('Attempt 1 fails with transient flag', attempt1.success === false);
    ok('attempt1.canRetry is true', attempt1.canRetry === true);

    const rowAfterAttempt1 = db.prepare('SELECT attempt_count, status, last_error_code FROM notification_deliveries WHERE id = ?').get(deliveryId);
    ok('attempt_count incremented to 1', rowAfterAttempt1.attempt_count === 1);
    ok('status remained QUEUED for backoff retry', rowAfterAttempt1.status === 'QUEUED');

    console.log('\n--- 2. Successful Recovery on Subsequent Attempt ---');
    const attempt2 = await deliverNotification(deliveryId);
    ok('Attempt 2 succeeds upon provider recovery', attempt2.success === true);
    ok('status updated to SENT', attempt2.status === 'SENT');

    const rowAfterAttempt2 = db.prepare('SELECT attempt_count, status, sent_at FROM notification_deliveries WHERE id = ?').get(deliveryId);
    ok('attempt_count incremented to 2', rowAfterAttempt2.attempt_count === 2);
    ok('sent_at recorded', Boolean(rowAfterAttempt2.sent_at));

    console.log('\n--- 3. Permanent Failure (No Retry) ---');
    const { deliveryId: permDelId } = queueNotification({
      organizationId: 1,
      eventType: 'EXAM_INVITATION',
      recipientEmail: 'permanent.fail@example.com',
      payload: { name: 'Permanent Fail' }
    });

    mock.simulateFailure(new Error('Recipient domain does not exist: NXDOMAIN'), 'PERMANENT');
    const permAttempt = await deliverNotification(permDelId);

    ok('Permanent attempt fails', permAttempt.success === false);
    ok('canRetry is false for permanent failure', permAttempt.canRetry === false);

    const permRow = db.prepare('SELECT status, last_error_code, failed_at FROM notification_deliveries WHERE id = ?').get(permDelId);
    ok('Status immediately marked FAILED', permRow.status === 'FAILED');
    ok('failed_at timestamp recorded', Boolean(permRow.failed_at));

    console.log('\n--- 4. Max Delivery Attempts Boundary ---');
    const { deliveryId: maxDelId } = queueNotification({
      organizationId: 1,
      eventType: 'RESULT_AVAILABLE',
      recipientEmail: 'max.attempts@example.com',
      payload: { name: 'Max Attempts' }
    });

    // Artificially set attempt_count to MAX - 1
    db.prepare('UPDATE notification_deliveries SET attempt_count = ? WHERE id = ?').run(MAX_DELIVERY_ATTEMPTS - 1, maxDelId);

    mock.simulateFailure(new Error('Final transient failure before exhausting attempts'), 'TRANSIENT');
    const exhaustedAttempt = await deliverNotification(maxDelId);

    ok('Attempt fails at max limit', exhaustedAttempt.success === false);
    ok('canRetry is false when max attempts reached', exhaustedAttempt.canRetry === false);

    const exhaustedRow = db.prepare('SELECT status, attempt_count FROM notification_deliveries WHERE id = ?').get(maxDelId);
    ok('Status marked FAILED at threshold', exhaustedRow.status === 'FAILED');
    ok('Attempt count reached MAX_DELIVERY_ATTEMPTS', exhaustedRow.attempt_count === MAX_DELIVERY_ATTEMPTS);

    console.log('\n--- 5. Authorized Manual Retry Reset ---');
    const retryResult = await retryDelivery(maxDelId, 1);
    ok('retryDelivery returns success: true', retryResult.success === true);
    ok('Status transitioned to SENT', retryResult.status === 'SENT');

    const resetRow = db.prepare('SELECT status FROM notification_deliveries WHERE id = ?').get(maxDelId);
    ok('Database delivery status updated to SENT upon retry', resetRow.status === 'SENT');

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
