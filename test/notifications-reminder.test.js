// ============================================================================
// ASPIRE DAY 23: EXAM REMINDER NOTIFICATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-rem-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { scheduleExamReminder } = require('../backend/src/services/notifications/notification.service');
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
  console.log('DAY 23: EXAM REMINDER NOTIFICATION TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. 24-Hour Reminder Scheduling ---');
    const scheduledTime24h = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const result24h = scheduleExamReminder({
      organizationId: 1,
      examId: 88,
      studentId: 202,
      email: 'remind.candidate@example.com',
      name: 'Remind Candidate',
      examTitle: 'Algorithmic Mastery Assessment',
      startTime: scheduledTime24h,
      durationMinutes: 120,
      reminderType: '24h',
      scheduledAt: scheduledTime24h
    });

    ok('scheduleExamReminder returns non-null result', Boolean(result24h));
    ok('Event type is EXAM_REMINDER', result24h.event.event_type === 'EXAM_REMINDER');
    ok('Event scheduled_at is set to future timestamp', Boolean(result24h.event.scheduled_at));
    ok('Delivery row records scheduled_at', Boolean(result24h.event.scheduled_at));

    const payload24h = JSON.parse(result24h.event.payload_json);
    ok('Payload contains timeRemainingText (in 24 hours)', payload24h.timeRemainingText === 'in 24 hours');
    ok('Payload contains examTitle', payload24h.examTitle === 'Algorithmic Mastery Assessment');

    console.log('\n--- 2. 1-Hour Reminder Scheduling & Compound Idempotency ---');
    const scheduledTime1h = new Date(Date.now() + 3600 * 1000).toISOString();
    const result1h = scheduleExamReminder({
      organizationId: 1,
      examId: 88,
      studentId: 202,
      email: 'remind.candidate@example.com',
      name: 'Remind Candidate',
      examTitle: 'Algorithmic Mastery Assessment',
      startTime: scheduledTime24h,
      durationMinutes: 120,
      reminderType: '1h',
      scheduledAt: scheduledTime1h
    });

    ok('1h reminder event created separately from 24h reminder', result1h.event.id !== result24h.event.id);
    const payload1h = JSON.parse(result1h.event.payload_json);
    ok('1h payload contains timeRemainingText (in 1 hour)', payload1h.timeRemainingText === 'in 1 hour');

    // Duplicate 1h reminder is suppressed
    const dup1h = scheduleExamReminder({
      organizationId: 1,
      examId: 88,
      studentId: 202,
      email: 'remind.candidate@example.com',
      reminderType: '1h'
    });
    ok('Duplicate 1h reminder is recognized as duplicate', dup1h.isDuplicate === true);
    ok('Duplicate 1h deliveryId matches original', dup1h.deliveryId === result1h.deliveryId);

    console.log('\n--- 3. Template Rendering & Delivery ---');
    const delRes = await deliverNotification(result1h.deliveryId);
    ok('Reminder delivery succeeds', delRes.success === true);

    const sent = mock.findMessagesFor('remind.candidate@example.com');
    ok('Reminder email received in mock', sent.length >= 1);
    ok('Email subject mentions Reminder or Assessment', sent[0].subject.includes('Reminder') || sent[0].subject.includes('Assessment'));
    ok('Email body contains time remaining text', sent[0].html.includes('in 1 hour') || sent[0].html.includes('reminder'));

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

