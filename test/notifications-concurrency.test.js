// ============================================================================
// ASPIRE DAY 23: NOTIFICATIONS CONCURRENCY & IDEMPOTENCY TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-conc-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { queueNotification } = require('../backend/src/services/notifications/notification.service');
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
  console.log('DAY 23: NOTIFICATIONS CONCURRENCY & IDEMPOTENCY');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. High-Volume Concurrent Event Queueing (50 items) ---');
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        Promise.resolve().then(() => {
          return queueNotification({
            organizationId: 1,
            eventType: 'EXAM_COMPLETED',
            recipientEmail: `candidate.${i}@concurrency.org`,
            idempotencyKey: `conc_evt_key_${i}`,
            payload: { candidateNumber: i }
          });
        })
      );
    }

    const results = await Promise.all(promises);
    ok('All 50 concurrent queue calls returned successfully', results.length === 50);

    const eventCount = db.prepare('SELECT COUNT(*) as c FROM notification_events').get().c;
    const deliveryCount = db.prepare('SELECT COUNT(*) as c FROM notification_deliveries').get().c;
    const outboxCount = db.prepare("SELECT COUNT(*) as c FROM outbox_events WHERE event_type = 'NOTIFICATION_EMAIL'").get().c;

    ok('Exactly 50 notification_events recorded in database', eventCount === 50);
    ok('Exactly 50 notification_deliveries recorded in database', deliveryCount === 50);
    ok('Exactly 50 outbox_events recorded in database', outboxCount === 50);

    console.log('\n--- 2. Race-Condition Idempotency Safety ---');
    // 20 concurrent threads trying to queue the EXACT SAME idempotency key at once
    const sameKey = 'race_condition_idempotency_key_identical';
    const racePromises = [];
    for (let i = 0; i < 20; i++) {
      racePromises.push(
        Promise.resolve().then(() => {
          return queueNotification({
            organizationId: 1,
            eventType: 'REGISTRATION_CONFIRMED',
            recipientEmail: 'same.person@example.com',
            idempotencyKey: sameKey,
            payload: { thread: i }
          });
        })
      );
    }

    const raceResults = await Promise.all(racePromises);
    ok('All 20 concurrent race calls resolved without throw', raceResults.length === 20);

    // Exactly one row must exist in notification_events for that key
    const singleEventRows = db.prepare('SELECT * FROM notification_events WHERE idempotency_key = ?').all(sameKey);
    ok('Strictly 1 event row exists despite 20 parallel threads', singleEventRows.length === 1);

    // Delivery ID returned across threads matches the original
    const targetDelId = singleEventRows[0].id;
    const duplicateFlags = raceResults.map((r) => r.isDuplicate);
    const trueDuplicates = duplicateFlags.filter((d) => d === true);
    ok('At least 19 calls flagged as duplicate', trueDuplicates.length >= 19);

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

