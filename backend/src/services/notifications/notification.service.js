// ============================================================================
// ASPIRE DAY 23: MASTER NOTIFICATION SERVICE & TRANSACTIONAL OUTBOX INTEGRATION
// ============================================================================

const crypto = require('crypto');
const { db } = require('../../db');
const { ValidationError, NotFoundError } = require('../../errors/app-error');
const { deliverNotification } = require('./notification-delivery.service');
const logger = require('../../utils/logger');

const SUPPORTED_EVENT_TYPES = [
  'REGISTRATION_CONFIRMED',
  'EXAM_INVITATION',
  'EXAM_REMINDER',
  'EXAM_COMPLETED',
  'RESULT_AVAILABLE',
  'CERTIFICATE_AVAILABLE'
];

/**
 * Normalizes email address.
 */
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.toLowerCase().trim();
}

/**
 * Persists notification event, delivery record, and outbox record within the current SQLite transaction.
 * Guarantees zero duplicate emails via idempotency_key protection.
 */
function queueNotification({
  organizationId = null,
  eventType,
  recipientEmail,
  recipientUserId = null,
  templateKey = null,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null,
  payload = {},
  scheduledAt = null
}) {
  const normType = String(eventType || '').toUpperCase().trim();
  if (!SUPPORTED_EVENT_TYPES.includes(normType)) {
    throw new ValidationError(`Unsupported notification event type: ${eventType}`);
  }

  const cleanEmail = normalizeEmail(recipientEmail);
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new ValidationError('A valid recipient email address is required');
  }

  // Idempotency check: Return existing event if already processed
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM notification_events WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      let meta = {};
      try { meta = JSON.parse(existing.payload_json || '{}'); } catch {}
      const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE notification_event_id = ?').get(existing.id);
      return {
        event: { ...existing, payload: meta },
        deliveryId: delivery?.id || null,
        isDuplicate: true
      };
    }
  }

  const eventId = `notif_evt_${crypto.randomBytes(12).toString('hex')}`;
  const deliveryId = `notif_del_${crypto.randomBytes(12).toString('hex')}`;
  const outboxId = `outbox_notif_${crypto.randomBytes(12).toString('hex')}`;
  const effectiveTemplate = templateKey || normType;
  const payloadStr = JSON.stringify(payload || {});

  let createdEvent = null;

  const tx = db.transaction(() => {
    // 1. Insert into notification_events
    db.prepare(`
      INSERT INTO notification_events (
        id, organization_id, event_type, recipient_user_id, recipient_email,
        template_key, reference_type, reference_id, payload_json, idempotency_key,
        status, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `).run(
      eventId,
      organizationId,
      normType,
      recipientUserId,
      cleanEmail,
      effectiveTemplate,
      referenceType,
      referenceId ? String(referenceId) : null,
      payloadStr,
      idempotencyKey,
      scheduledAt
    );

    // 2. Insert into notification_deliveries
    db.prepare(`
      INSERT INTO notification_deliveries (
        id, organization_id, notification_event_id, recipient_user_id, recipient_email,
        channel, provider, template_key, status, scheduled_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'EMAIL', 'resend', ?, 'PENDING', ?, ?)
    `).run(
      deliveryId,
      organizationId,
      eventId,
      recipientUserId,
      cleanEmail,
      effectiveTemplate,
      scheduledAt,
      payloadStr
    );

    // 3. Insert into outbox_events for transactional dual-write reliability
    db.prepare(`
      INSERT INTO outbox_events (
        id, event_type, aggregate_id, payload_json, status, organization_id
      ) VALUES (?, 'NOTIFICATION_EMAIL', ?, ?, 'PENDING', ?)
    `).run(
      outboxId,
      deliveryId,
      JSON.stringify({ deliveryId, eventId, eventType: normType, recipientEmail: cleanEmail, scheduledAt }),
      organizationId
    );

    createdEvent = db.prepare('SELECT * FROM notification_events WHERE id = ?').get(eventId);
  });

  tx();

  // If synchronous execution is requested or in local test environment without worker,
  // we attempt delivery immediately outside the transaction
  setImmediate(async () => {
    if (!scheduledAt || new Date(scheduledAt) <= new Date()) {
      try {
        await deliverNotification(deliveryId);
      } catch (err) {
        logger.warn({ deliveryId, err: err.message }, 'Background delivery attempt failed');
      }
    }
  });

  return {
    event: createdEvent,
    deliveryId,
    isDuplicate: false
  };
}

// ----------------------------------------------------------------------------
// DOMAIN-SPECIFIC CONVENIENCE EVENT HELPERS
// ----------------------------------------------------------------------------

function sendRegistrationConfirmation({ organizationId, studentId, email, name, college = null }) {
  if (!email) return null;
  return queueNotification({
    organizationId,
    eventType: 'REGISTRATION_CONFIRMED',
    recipientEmail: email,
    referenceType: 'student',
    referenceId: studentId,
    idempotencyKey: `registration_confirmed_${studentId}`,
    payload: {
      studentId,
      name: name || 'Candidate',
      college: college || null,
      dashboardUrl: `${process.env.APP_BASE_URL || 'https://aspire.adyapan.internal'}/dashboard.html`
    }
  });
}

function sendExamInvitation({
  organizationId,
  examId,
  studentId = null,
  email,
  name = 'Candidate',
  examTitle,
  examDate = null,
  durationMinutes = 90,
  instructions = null,
  invitationToken = null
}) {
  if (!email) return null;
  const baseUrl = process.env.APP_BASE_URL || 'https://aspire.adyapan.internal';
  const invitationUrl = invitationToken
    ? `${baseUrl}/test.html?invitation=${invitationToken}`
    : `${baseUrl}/test.html?examId=${examId}`;

  return queueNotification({
    organizationId,
    eventType: 'EXAM_INVITATION',
    recipientEmail: email,
    referenceType: 'exam',
    referenceId: examId,
    idempotencyKey: `exam_invitation_${examId}_${studentId || normalizeEmail(email)}`,
    payload: {
      examId,
      studentId,
      name,
      examTitle,
      examDate,
      durationMinutes,
      instructions,
      invitationUrl
    }
  });
}

function scheduleExamReminder({
  organizationId,
  examId,
  studentId = null,
  email,
  name = 'Candidate',
  examTitle,
  startTime,
  durationMinutes = 90,
  reminderType = '24h',
  scheduledAt = null
}) {
  if (!email) return null;
  const timeText = reminderType === '1h' ? 'in 1 hour' : (reminderType === '24h' ? 'in 24 hours' : 'soon');

  return queueNotification({
    organizationId,
    eventType: 'EXAM_REMINDER',
    recipientEmail: email,
    referenceType: 'exam',
    referenceId: examId,
    idempotencyKey: `exam_reminder_${examId}_${studentId || normalizeEmail(email)}_${reminderType}`,
    scheduledAt,
    payload: {
      examId,
      studentId,
      name,
      examTitle,
      startTime,
      durationMinutes,
      timeRemainingText: timeText,
      dashboardUrl: `${process.env.APP_BASE_URL || 'https://aspire.adyapan.internal'}/dashboard.html`
    }
  });
}

function sendExamCompleted({ organizationId, attemptId, studentId, email, name = 'Candidate', examTitle, submittedAt }) {
  if (!email) return null;
  return queueNotification({
    organizationId,
    eventType: 'EXAM_COMPLETED',
    recipientEmail: email,
    referenceType: 'attempt',
    referenceId: attemptId,
    idempotencyKey: `exam_completed_${attemptId}`,
    payload: {
      attemptId,
      studentId,
      name,
      examTitle,
      submittedAt: submittedAt ? new Date(submittedAt).toUTCString() : new Date().toUTCString(),
      dashboardUrl: `${process.env.APP_BASE_URL || 'https://aspire.adyapan.internal'}/dashboard.html`
    }
  });
}

function sendResultAvailable({
  organizationId,
  attemptId,
  studentId,
  email,
  name = 'Candidate',
  examTitle,
  score = null,
  totalMarks = null,
  percentage = null,
  scholarshipPercentage = 0,
  scholarshipTier = null
}) {
  if (!email) return null;
  const baseUrl = process.env.APP_BASE_URL || 'https://aspire.adyapan.internal';

  return queueNotification({
    organizationId,
    eventType: 'RESULT_AVAILABLE',
    recipientEmail: email,
    referenceType: 'attempt',
    referenceId: attemptId,
    idempotencyKey: `result_available_${attemptId}`,
    payload: {
      attemptId,
      studentId,
      name,
      examTitle,
      score,
      totalMarks,
      percentage,
      scholarshipPercentage,
      scholarshipTier,
      resultUrl: `${baseUrl}/results.html?attemptId=${attemptId}`
    }
  });
}

function sendCertificateAvailable({
  organizationId,
  certificateId,
  attemptId,
  studentId,
  email,
  name = 'Candidate',
  examTitle,
  scholarshipPercentage = null
}) {
  if (!email || !certificateId) return null;
  const baseUrl = process.env.APP_BASE_URL || 'https://aspire.adyapan.internal';

  return queueNotification({
    organizationId,
    eventType: 'CERTIFICATE_AVAILABLE',
    recipientEmail: email,
    referenceType: 'certificate',
    referenceId: certificateId,
    idempotencyKey: `certificate_available_${certificateId}`,
    payload: {
      certificateId,
      attemptId,
      studentId,
      name,
      examTitle,
      scholarshipPercentage,
      certificateUrl: `${baseUrl}/certificate.html?id=${certificateId}`,
      verificationUrl: `${baseUrl}/api/public/verify/${certificateId}`
    }
  });
}

module.exports = {
  SUPPORTED_EVENT_TYPES,
  normalizeEmail,
  queueNotification,
  sendRegistrationConfirmation,
  sendExamInvitation,
  scheduleExamReminder,
  sendExamCompleted,
  sendResultAvailable,
  sendCertificateAvailable
};

