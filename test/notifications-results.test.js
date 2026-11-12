// ============================================================================
// ASPIRE DAY 23: RESULT AVAILABLE NOTIFICATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-res-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { sendResultAvailable } = require('../backend/src/services/notifications/notification.service');
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
  console.log('DAY 23: RESULT AVAILABLE NOTIFICATION TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. Result Available Event Creation ---');
    const result = sendResultAvailable({
      organizationId: 1,
      attemptId: 601,
      studentId: 404,
      email: 'result.student@example.com',
      name: 'Samantha Ray',
      examTitle: 'National Technical Merit Scholarship Exam',
      score: 85,
      totalMarks: 100,
      percentage: 85.0,
      scholarshipPercentage: 50,
      scholarshipTier: 'Tier 1 Merit'
    });

    ok('sendResultAvailable returns non-null result', Boolean(result));
    ok('Event type is RESULT_AVAILABLE', result.event.event_type === 'RESULT_AVAILABLE');
    ok('Recipient recorded', result.event.recipient_email === 'result.student@example.com');

    const payload = JSON.parse(result.event.payload_json);
    ok('Payload contains score 85', payload.score === 85);
    ok('Payload contains totalMarks 100', payload.totalMarks === 100);
    ok('Payload contains percentage 85', payload.percentage === 85);
    ok('Payload contains scholarshipPercentage 50', payload.scholarshipPercentage === 50);
    ok('Payload contains resultUrl link', Boolean(payload.resultUrl));

    console.log('\n--- 2. Result Email Delivery & Template Rendering ---');
    const delRes = await deliverNotification(result.deliveryId);
    ok('Delivery succeeded', delRes.success === true);

    const sent = mock.findMessagesFor('result.student@example.com');
    ok('Result email delivered to mock provider', sent.length === 1);
    ok('Email subject announces result', sent[0].subject.includes('Result') || sent[0].subject.includes('Score') || sent[0].subject.includes('Published'));
    ok('Email body displays score', sent[0].html.includes('85'));
    ok('Email body displays scholarship tier', sent[0].html.includes('50%') || sent[0].html.includes('Scholarship'));
    ok('Email body contains result view link', sent[0].html.includes('results.html'));

    console.log('\n--- 3. Idempotency on Attempt ID ---');
    const dupRes = sendResultAvailable({
      organizationId: 1,
      attemptId: 601,
      studentId: 404,
      email: 'result.student@example.com'
    });
    ok('Duplicate sendResultAvailable recognized as duplicate', dupRes.isDuplicate === true);
    ok('Duplicate deliveryId matches original', dupRes.deliveryId === result.deliveryId);

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

