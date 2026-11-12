// ============================================================================
// ASPIRE DAY 23: EXAM COMPLETION NOTIFICATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-comp-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { sendExamCompleted } = require('../backend/src/services/notifications/notification.service');
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
  console.log('DAY 23: EXAM COMPLETION NOTIFICATION TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. Exam Completion Receipt Generation ---');
    const submittedAt = new Date().toISOString();
    const result = sendExamCompleted({
      organizationId: 1,
      attemptId: 501,
      studentId: 303,
      email: 'completer.student@example.com',
      name: 'Completer Student',
      examTitle: 'Advanced Backend Engineering Exam',
      submittedAt
    });

    ok('sendExamCompleted returns non-null result', Boolean(result));
    ok('Event type is EXAM_COMPLETED', result.event.event_type === 'EXAM_COMPLETED');
    ok('Recipient recorded', result.event.recipient_email === 'completer.student@example.com');
    ok('Delivery ID generated', Boolean(result.deliveryId));

    console.log('\n--- 2. Security Check: No Score Leakage in Completion Receipt ---');
    const payload = JSON.parse(result.event.payload_json);
    ok('Payload does NOT expose score property', payload.score === undefined);
    ok('Payload does NOT expose percentage property', payload.percentage === undefined);
    ok('Payload does NOT expose answers property', payload.answers === undefined);
    ok('Payload contains examTitle', payload.examTitle === 'Advanced Backend Engineering Exam');
    ok('Payload contains attemptId', payload.attemptId === 501);

    console.log('\n--- 3. Template Delivery & Content Verification ---');
    const delRes = await deliverNotification(result.deliveryId);
    ok('Delivery succeeded', delRes.success === true);

    const sent = mock.findMessagesFor('completer.student@example.com');
    ok('Mock provider captured completion email', sent.length === 1);
    ok('Subject acknowledges submission receipt', sent[0].subject.includes('Completed') || sent[0].subject.includes('Received') || sent[0].subject.includes('Submission'));
    ok('Body contains candidate name', sent[0].html.includes('Completer Student'));
    ok('Body does NOT contain score or grades text', !sent[0].html.includes('Your score is') && !sent[0].html.includes('Marks obtained'));

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

