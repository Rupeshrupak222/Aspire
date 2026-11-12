// ============================================================================
// ASPIRE DAY 23: NOTIFICATION WORKER & OUTBOX DISPATCH TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-wrk-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { notificationQueue } = require('../backend/src/queues/notification.queue');
const { processNotificationJob, startNotificationWorker, stopNotificationWorker } = require('../backend/src/workers/notification.worker');
const { queueNotification } = require('../backend/src/services/notifications/notification.service');
const { dispatchPendingEvents, dispatchImmediate } = require('../backend/src/workers/outbox-dispatcher');
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
  console.log('DAY 23: NOTIFICATION WORKER & OUTBOX DISPATCH');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);
  notificationQueue.setMockMode(true);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. Notification Queue Mock Enqueueing ---');
    const { deliveryId, event } = queueNotification({
      organizationId: 1,
      eventType: 'REGISTRATION_CONFIRMED',
      recipientEmail: 'queue.test@example.com',
      payload: { name: 'Queue Candidate' }
    });

    ok('Notification queued into SQLite', Boolean(deliveryId));

    const enqueueResult = await notificationQueue.enqueueDeliveryJob({
      deliveryId,
      eventId: event.id,
      recipientEmail: 'queue.test@example.com',
      eventType: 'REGISTRATION_CONFIRMED'
    });

    ok('Job enqueued with jobId', Boolean(enqueueResult.jobId));
    ok('Mock queue stores job in memory', notificationQueue.mockJobs.has(enqueueResult.jobId));

    console.log('\n--- 2. Worker Job Execution Function ---');
    const mockJob = {
      id: enqueueResult.jobId,
      data: {
        deliveryId,
        recipientEmail: 'queue.test@example.com',
        eventType: 'REGISTRATION_CONFIRMED'
      }
    };

    const processRes = await processNotificationJob(mockJob);
    ok('Worker processNotificationJob returns success', processRes.success === true);
    ok('Delivery row updated to SENT', processRes.status === 'SENT' || processRes.status === 'DELIVERED');

    const sent = mock.findMessagesFor('queue.test@example.com');
    ok('Mock provider dispatched email via worker job', sent.length >= 1);

    console.log('\n--- 3. Outbox Dispatcher Integration ---');
    // Create another notification event that creates an outbox row
    const { deliveryId: delId2 } = queueNotification({
      organizationId: 1,
      eventType: 'EXAM_COMPLETED',
      recipientEmail: 'outbox.test@example.com',
      payload: { name: 'Outbox Candidate', examTitle: 'Outbox Exam' }
    });

    // Check outbox row exists
    const outboxRow = db.prepare("SELECT * FROM outbox_events WHERE aggregate_id = ? AND event_type = 'NOTIFICATION_EMAIL'").get(delId2);
    ok('Outbox row generated for notification', Boolean(outboxRow));

    // Dispatch outbox events batch
    const dispatchBatchRes = await dispatchPendingEvents(10);
    ok('dispatchPendingEvents processes batch', typeof dispatchBatchRes.processed === 'number');

    const updatedOutbox = db.prepare('SELECT status FROM outbox_events WHERE id = ?').get(outboxRow.id);
    ok('Outbox status updated to DISPATCHED', updatedOutbox.status === 'DISPATCHED');

  } catch (err) {
    failures++;
    console.error('Unexpected test error:', err);
  } finally {
    resetEmailProvider();
    notificationQueue.setMockMode(false);
    try {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    } catch {}
    process.exit(failures > 0 ? 1 : 0);
  }
}

run();

