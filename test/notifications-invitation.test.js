// ============================================================================
// ASPIRE DAY 23: CANDIDATE EXAM INVITATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-inv-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { sendExamInvitation } = require('../backend/src/services/notifications/notification.service');
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
  console.log('DAY 23: CANDIDATE EXAM INVITATION TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  // Setup test organization and test exam
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, organization_id) VALUES (1, 'admin@adyapan.internal', 'hash', 'Org Admin', 'ORG_ADMIN', 1)").run();
  
  db.prepare(`
    INSERT INTO exams (id, organization_id, code, name, duration_minutes, status, is_default, created_by)
    VALUES (55, 1, 'EXAM-INV-55', 'Full-Stack Engineering Scholarship Exam', 90, 'PUBLISHED', 0, 1)
  `).run();

  try {
    console.log('--- 1. Exam Invitation Event Queueing ---');
    const result = sendExamInvitation({
      organizationId: 1,
      examId: 55,
      studentId: null,
      email: 'candidate.jane@example.com',
      name: 'Jane Doe',
      examTitle: 'Full-Stack Engineering Scholarship Exam',
      durationMinutes: 90,
      invitationToken: 'tok_jane_invitation_secret_12345'
    });

    ok('sendExamInvitation returns non-null result', Boolean(result));
    ok('Event type is EXAM_INVITATION', result.event.event_type === 'EXAM_INVITATION');
    ok('Recipient email recorded', result.event.recipient_email === 'candidate.jane@example.com');
    ok('Delivery ID generated', Boolean(result.deliveryId));

    const payload = JSON.parse(result.event.payload_json);
    ok('Payload contains invitationUrl', Boolean(payload.invitationUrl));
    ok('invitationUrl includes token', payload.invitationUrl.includes('tok_jane_invitation_secret_12345'));
    ok('Payload contains examTitle', payload.examTitle === 'Full-Stack Engineering Scholarship Exam');
    ok('Payload contains durationMinutes', payload.durationMinutes === 90);

    console.log('\n--- 2. Delivery Execution & Template Rendering ---');
    const delRes = await deliverNotification(result.deliveryId);
    ok('Delivery succeeded', delRes.success === true);

    const sentMsgs = mock.findMessagesFor('candidate.jane@example.com');
    ok('Email delivered through provider', sentMsgs.length === 1);
    ok('Subject contains exam title or invitation', sentMsgs[0].subject.includes('Invitation') || sentMsgs[0].subject.includes('Full-Stack'));
    ok('Email body contains candidate name', sentMsgs[0].html.includes('Jane Doe'));
    ok('Email body contains test access link', sentMsgs[0].html.includes('tok_jane_invitation_secret_12345'));

    console.log('\n--- 3. Candidate Invitation Lifecycle (PENDING -> ACCEPTED) ---');
    // Insert into exam_candidate_invitations
    db.prepare(`
      INSERT INTO exam_candidate_invitations (
        organization_id, exam_id, email, name, invitation_token, status, invited_by
      ) VALUES (1, 55, 'candidate.jane@example.com', 'Jane Doe', 'tok_jane_invitation_secret_12345', 'SENT', 1)
    `).run();

    const invBefore = db.prepare("SELECT * FROM exam_candidate_invitations WHERE invitation_token = 'tok_jane_invitation_secret_12345'").get();
    ok('Invitation record exists with status SENT', invBefore.status === 'SENT');

    // Create student first to satisfy foreign key
    db.prepare("INSERT INTO students (id, name, phone, email, organization_id) VALUES (999, 'Jane Doe', '+19999999999', 'candidate.jane@example.com', 1)").run();

    // Simulate candidate acceptance (via registration)
    db.prepare(`
      UPDATE exam_candidate_invitations
      SET status = 'ACCEPTED', student_id = 999, updated_at = datetime('now')
      WHERE invitation_token = 'tok_jane_invitation_secret_12345'
    `).run();

    const invAfter = db.prepare("SELECT * FROM exam_candidate_invitations WHERE invitation_token = 'tok_jane_invitation_secret_12345'").get();
    ok('Invitation status updated to ACCEPTED', invAfter.status === 'ACCEPTED');
    ok('Invitation linked to student_id 999', invAfter.student_id === 999);

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
