// ============================================================================
// ASPIRE DAY 23: CERTIFICATE AVAILABLE NOTIFICATION TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-cert-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { sendCertificateAvailable } = require('../backend/src/services/notifications/notification.service');
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
  console.log('DAY 23: CERTIFICATE AVAILABLE NOTIFICATION TEST SUITE');
  console.log('====================================================\n');

  const mock = new MockEmailProvider();
  setEmailProvider(mock);

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. Certificate Available Notification Emission ---');
    const certId = 'CERT-2026-ASP-778899';
    const result = sendCertificateAvailable({
      organizationId: 1,
      certificateId: certId,
      attemptId: 701,
      studentId: 505,
      email: 'scholar.candidate@example.com',
      name: 'Elena Rostova',
      examTitle: 'Distinguished Scholars Technical Evaluation',
      scholarshipPercentage: 100
    });

    ok('sendCertificateAvailable returns non-null result', Boolean(result));
    ok('Event type is CERTIFICATE_AVAILABLE', result.event.event_type === 'CERTIFICATE_AVAILABLE');
    ok('Recipient recorded', result.event.recipient_email === 'scholar.candidate@example.com');
    ok('Reference ID is certificate ID', result.event.reference_id === certId);

    const payload = JSON.parse(result.event.payload_json);
    ok('Payload contains certificateId', payload.certificateId === certId);
    ok('Payload contains certificateUrl', Boolean(payload.certificateUrl));
    ok('Payload contains verificationUrl', Boolean(payload.verificationUrl));
    ok('Payload contains scholarshipPercentage 100', payload.scholarshipPercentage === 100);

    console.log('\n--- 2. Non-Emission on Absent Certificate ID ---');
    const nullCertRes = sendCertificateAvailable({
      organizationId: 1,
      certificateId: null, // No certificate issued (e.g. failed attempt)
      attemptId: 702,
      studentId: 506,
      email: 'no.cert@example.com'
    });
    ok('sendCertificateAvailable returns null when certificateId is missing', nullCertRes === null);

    console.log('\n--- 3. Template Delivery & Credential Verification Link ---');
    const delRes = await deliverNotification(result.deliveryId);
    ok('Delivery succeeded', delRes.success === true);

    const sent = mock.findMessagesFor('scholar.candidate@example.com');
    ok('Certificate email received by mock provider', sent.length === 1);
    ok('Subject celebrates certificate achievement', sent[0].subject.includes('Certificate') || sent[0].subject.includes('Achievement'));
    ok('Email body displays certificate ID', sent[0].html.includes(certId));
    ok('Email body displays recipient name', sent[0].html.includes('Elena Rostova'));
    ok('Email body contains verification link', sent[0].html.includes('verify'));

    console.log('\n--- 4. Idempotency on Certificate ID ---');
    const dupRes = sendCertificateAvailable({
      organizationId: 1,
      certificateId: certId,
      email: 'scholar.candidate@example.com'
    });
    ok('Duplicate certificate email recognized as duplicate', dupRes.isDuplicate === true);
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

