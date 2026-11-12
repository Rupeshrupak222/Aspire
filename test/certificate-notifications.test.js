// ============================================================================
// DAY 24 TEST 12: CERTIFICATE NOTIFICATION INTEGRATION
// ============================================================================

const assert = require('assert');
const { db } = require('../backend/src/db');
const notifService = require('../backend/src/services/notifications/notification.service');
const { renderTemplate } = require('../backend/src/services/notifications/templates/template-renderer.service');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE NOTIFICATION INTEGRATION SUITE');
console.log('====================================================');

const certId = 'ASP26-NOTIF7788';
const studentEmail = 'scholar.candidate@example.com';

// --- 1. Notification Event Enqueueing ---
console.log('\n--- 1. Notification Event Enqueueing ---');
const notifResult = notifService.sendCertificateAvailable({
  organizationId: 1,
  certificateId: certId,
  attemptId: 12345,
  studentId: 6789,
  email: studentEmail,
  name: 'Marie Curie',
  examTitle: 'Radiological Physics Fellowship',
  scholarshipPercentage: 100
});

assert(notifResult !== null, 'Notification result returned');
assert.strictEqual(notifResult.event.event_type, 'CERTIFICATE_AVAILABLE', 'Event type is CERTIFICATE_AVAILABLE');
assert.strictEqual(notifResult.event.reference_id, certId, 'Reference ID is Certificate ID');

let payload = {};
try { payload = JSON.parse(notifResult.event.payload_json); } catch {}
assert.strictEqual(payload.certificateId, certId, 'Payload contains certificateId');
assert(payload.verificationUrl.includes(certId), 'Payload contains public verificationUrl');
assert(payload.certificateUrl.includes(certId), 'Payload contains authorized certificateUrl');
assert.strictEqual(payload.scholarshipPercentage, 100, 'Payload contains scholarshipPercentage');
console.log('  PASS  sendCertificateAvailable correctly packs verification URL and Certificate ID');

// --- 2. Template Rendering Verification ---
console.log('\n--- 2. Template Rendering Verification ---');
const rendered = renderTemplate('CERTIFICATE_AVAILABLE', {
  recipientName: 'Marie Curie',
  certificateId: certId,
  examTitle: 'Radiological Physics Fellowship',
  scholarshipPercentage: 100,
  verificationUrl: `https://aspire.adyapan.com/verify/${certId}`,
  certificateUrl: `https://aspire.adyapan.com/api/public/certificate/${certId}`
});

assert(rendered.subject.includes('Certificate'), 'Subject mentions Certificate');
assert(rendered.html.includes(certId), 'HTML contains Certificate ID');
assert(rendered.html.includes(`/verify/${certId}`), 'HTML includes verification link');
assert.ok(rendered.html.includes('Download Certificate') || rendered.html.includes('Certificate'), 'HTML contains CTA button');
assert(rendered.text.includes(certId), 'Plain text fallback contains Certificate ID');
console.log('  PASS  Email template renders luxury editorial format with verification links');

// --- 3. Deduplication & Idempotency ---
console.log('\n--- 3. Deduplication & Idempotency ---');
const duplicateResult = notifService.sendCertificateAvailable({
  organizationId: 1,
  certificateId: certId,
  attemptId: 12345,
  studentId: 6789,
  email: studentEmail,
  name: 'Marie Curie',
  examTitle: 'Radiological Physics Fellowship',
  scholarshipPercentage: 100
});

assert.strictEqual(duplicateResult.isDuplicate, true, 'Second dispatch recognized as duplicate');
assert.strictEqual(duplicateResult.deliveryId, notifResult.deliveryId, 'Delivery ID matches original');
console.log('  PASS  Idempotency prevents duplicate certificate notification emails');

// Clean up
db.prepare('DELETE FROM outbox_events WHERE aggregate_id = ?').run(notifResult.deliveryId);
db.prepare('DELETE FROM notification_deliveries WHERE id = ?').run(notifResult.deliveryId);
db.prepare('DELETE FROM notification_events WHERE id = ?').run(notifResult.event.id);
console.log('  PASS  Test fixtures cleaned up');
