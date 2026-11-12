// ============================================================================
// ASPIRE DAY 23: NOTIFICATION DELIVERY & LIFECYCLE SERVICE
// ============================================================================

const { db } = require('../../db');
const { ValidationError, NotFoundError, AuthorizationError } = require('../../errors/app-error');
const { renderTemplate } = require('./templates/template-renderer.service');
const { sendEmail } = require('./email.service');
const { isNotificationPermitted } = require('./notification-preferences.service');
const logger = require('../../utils/logger');

const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Executes delivery attempt for a specific notification_deliveries row.
 */
async function deliverNotification(deliveryId) {
  if (!deliveryId) throw new ValidationError('deliveryId is required');

  const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(deliveryId);
  if (!delivery) throw new NotFoundError(`Delivery ${deliveryId} not found`);

  // Idempotency: Skip if already finalized
  if (['SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'CANCELLED'].includes(delivery.status)) {
    return { success: true, status: delivery.status, alreadyFinalized: true };
  }

  // Fetch associated event
  const event = delivery.notification_event_id
    ? db.prepare('SELECT * FROM notification_events WHERE id = ?').get(delivery.notification_event_id)
    : null;

  let payload = {};
  if (event && event.payload_json) {
    try { payload = JSON.parse(event.payload_json); } catch {}
  }

  // Fetch organization branding if available
  let orgName = 'Aspire by Adyapan';
  let orgLogoUrl = null;
  if (delivery.organization_id) {
    const org = db.prepare('SELECT name, logo_url FROM organizations WHERE id = ?').get(delivery.organization_id);
    if (org) {
      orgName = org.name || orgName;
      orgLogoUrl = org.logo_url || null;
    }
  }

  // Check user notification preferences
  const isPermitted = isNotificationPermitted(
    delivery.organization_id,
    delivery.recipient_user_id,
    event ? event.event_type : delivery.template_key
  );

  if (!isPermitted) {
    db.prepare(`
      UPDATE notification_deliveries
      SET status = 'CANCELLED',
          last_error_code = 'MUTED_BY_PREFERENCES',
          last_error_message = 'Recipient disabled notifications for this category',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(delivery.id);
    return { success: true, status: 'CANCELLED', reason: 'MUTED_BY_PREFERENCES' };
  }

  // Mark PROCESSING
  db.prepare(`
    UPDATE notification_deliveries
    SET status = 'PROCESSING',
        attempt_count = attempt_count + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(delivery.id);

  try {
    // Render email template
    const templateData = {
      ...payload,
      recipientName: payload.recipientName || payload.name || 'Candidate',
      email: delivery.recipient_email,
      organizationName: orgName,
      organizationLogoUrl: orgLogoUrl
    };

    const rendered = renderTemplate(delivery.template_key, templateData);

    // Send email through active provider
    const sendResult = await sendEmail({
      to: delivery.recipient_email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text
    });

    const now = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE notification_deliveries
        SET status = 'SENT',
            provider = ?,
            provider_message_id = ?,
            sent_at = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(sendResult.provider, sendResult.providerMessageId, now, delivery.id);

      if (delivery.notification_event_id) {
        db.prepare(`
          UPDATE notification_events
          SET status = 'DISPATCHED'
          WHERE id = ?
        `).run(delivery.notification_event_id);
      }
    })();

    logger.info({ deliveryId, recipient: delivery.recipient_email, template: delivery.template_key }, 'Notification sent successfully');
    return {
      success: true,
      status: 'SENT',
      providerMessageId: sendResult.providerMessageId
    };
  } catch (err) {
    const isPermanent = err.isPermanent === true;
    const currentAttempts = (delivery.attempt_count || 0) + 1;
    const isExhausted = currentAttempts >= MAX_DELIVERY_ATTEMPTS;
    const finalStatus = (isPermanent || isExhausted) ? 'FAILED' : 'QUEUED';

    db.transaction(() => {
      db.prepare(`
        UPDATE notification_deliveries
        SET status = ?,
            last_error_code = ?,
            last_error_message = ?,
            failed_at = CASE WHEN ? = 'FAILED' THEN datetime('now') ELSE failed_at END,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(finalStatus, err.code || 'DELIVERY_ERROR', err.message || 'Transmission failed', finalStatus, delivery.id);

      if (finalStatus === 'FAILED' && delivery.notification_event_id) {
        db.prepare(`
          UPDATE notification_events
          SET status = 'FAILED'
          WHERE id = ?
        `).run(delivery.notification_event_id);
      }
    })();

    logger.warn({ deliveryId, recipient: delivery.recipient_email, error: err.message, status: finalStatus }, 'Notification delivery attempt failed');
    return {
      success: false,
      status: finalStatus,
      error: err.message,
      code: err.code || 'DELIVERY_ERROR',
      canRetry: !isPermanent && !isExhausted
    };
  }
}

/**
 * Retries an eligible failed or queued notification delivery.
 */
async function retryDelivery(deliveryId, organizationId = null) {
  const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(deliveryId);
  if (!delivery) throw new NotFoundError(`Delivery ${deliveryId} not found`);

  if (organizationId && delivery.organization_id !== organizationId) {
    throw new AuthorizationError('Cannot retry notifications belonging to another organization');
  }

  // Reset to PENDING and attempt immediate redelivery
  db.prepare(`
    UPDATE notification_deliveries
    SET status = 'PENDING',
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(deliveryId);

  return deliverNotification(deliveryId);
}

/**
 * Handles incoming provider webhook status update.
 */
function updateDeliveryFromWebhook({ providerMessageId, eventType, timestamp = null, metadata = {} }) {
  if (!providerMessageId) {
    throw new ValidationError('providerMessageId is required');
  }

  const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE provider_message_id = ?').get(providerMessageId);
  if (!delivery) {
    // Record unrecognized message id safely
    logger.warn({ providerMessageId, eventType }, 'Webhook received for untracked provider message ID');
    return { updated: false, reason: 'MESSAGE_NOT_FOUND' };
  }

  const normType = String(eventType || '').toLowerCase();
  let newStatus = delivery.status;
  const timeStr = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();

  if (normType.includes('deliver')) {
    newStatus = 'DELIVERED';
    db.prepare(`
      UPDATE notification_deliveries
      SET status = 'DELIVERED',
          delivered_at = COALESCE(delivered_at, ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(timeStr, delivery.id);
  } else if (normType.includes('bounce')) {
    newStatus = 'BOUNCED';
    db.prepare(`
      UPDATE notification_deliveries
      SET status = 'BOUNCED',
          last_error_code = 'PROVIDER_BOUNCED',
          last_error_message = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(metadata.bounceReason || 'Message bounced at destination mail server', delivery.id);
  } else if (normType.includes('complain')) {
    newStatus = 'COMPLAINED';
    db.prepare(`
      UPDATE notification_deliveries
      SET status = 'COMPLAINED',
          last_error_code = 'SPAM_COMPLAINT',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(delivery.id);
  } else if (normType.includes('fail') || normType.includes('reject')) {
    newStatus = 'FAILED';
    db.prepare(`
      UPDATE notification_deliveries
      SET status = 'FAILED',
          failed_at = COALESCE(failed_at, ?),
          last_error_code = 'PROVIDER_REJECTED',
          last_error_message = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(timeStr, metadata.reason || 'Delivery failed at provider', delivery.id);
  }

  logger.info({ deliveryId: delivery.id, providerMessageId, newStatus }, 'Updated delivery status from provider webhook');
  return { updated: true, deliveryId: delivery.id, status: newStatus };
}

/**
 * Returns single delivery details with tenant scoping.
 */
function getDelivery(deliveryId, organizationId = null) {
  if (!deliveryId) throw new ValidationError('deliveryId is required');

  const delivery = db.prepare('SELECT * FROM notification_deliveries WHERE id = ?').get(deliveryId);
  if (!delivery) throw new NotFoundError(`Delivery ${deliveryId} not found`);

  if (organizationId && delivery.organization_id !== organizationId) {
    throw new AuthorizationError('Cannot access notification belonging to another organization');
  }

  let meta = {};
  try { meta = JSON.parse(delivery.metadata_json || '{}'); } catch {}

  return {
    id: delivery.id,
    organizationId: delivery.organization_id,
    notificationEventId: delivery.notification_event_id,
    recipientEmail: delivery.recipient_email,
    recipientUserId: delivery.recipient_user_id,
    channel: delivery.channel,
    provider: delivery.provider,
    providerMessageId: delivery.provider_message_id,
    templateKey: delivery.template_key,
    status: delivery.status,
    attemptCount: delivery.attempt_count,
    lastErrorCode: delivery.last_error_code,
    lastErrorMessage: delivery.last_error_message,
    scheduledAt: delivery.scheduled_at,
    sentAt: delivery.sent_at,
    deliveredAt: delivery.delivered_at,
    failedAt: delivery.failed_at,
    createdAt: delivery.created_at,
    updatedAt: delivery.updated_at,
    metadata: meta
  };
}

/**
 * Returns paginated notification deliveries list for organization or Super Admin.
 */
function listDeliveries({
  organizationId = null,
  eventType = null,
  status = null,
  search = null,
  startDate = null,
  endDate = null,
  page = 1,
  limit = 20
}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const where = [];
  const params = [];

  if (organizationId) {
    where.push('d.organization_id = ?');
    params.push(organizationId);
  }
  if (eventType) {
    where.push('d.template_key = ?');
    params.push(eventType);
  }
  if (status) {
    where.push('d.status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(d.recipient_email LIKE ? OR d.provider_message_id LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (startDate) {
    where.push('d.created_at >= ?');
    params.push(startDate);
  }
  if (endDate) {
    where.push('d.created_at <= ?');
    params.push(endDate);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM notification_deliveries d ${whereClause}`).get(...params);
  const total = countRow?.c || 0;
  const totalPages = Math.ceil(total / safeLimit) || 1;

  const rows = db.prepare(`
    SELECT d.*, o.name as organization_name
    FROM notification_deliveries d
    LEFT JOIN organizations o ON o.id = d.organization_id
    ${whereClause}
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);

  return {
    deliveries: rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      organizationName: r.organization_name || 'Aspire by Adyapan',
      recipientEmail: r.recipient_email,
      templateKey: r.template_key,
      channel: r.channel,
      provider: r.provider,
      providerMessageId: r.provider_message_id,
      status: r.status,
      attemptCount: r.attempt_count,
      lastErrorCode: r.last_error_code,
      lastErrorMessage: r.last_error_message,
      sentAt: r.sent_at,
      deliveredAt: r.delivered_at,
      failedAt: r.failed_at,
      createdAt: r.created_at
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages
    }
  };
}

/**
 * Returns high-level platform or tenant notification delivery metrics.
 */
function getNotificationMetrics(organizationId = null) {
  const where = organizationId ? 'WHERE organization_id = ?' : '';
  const params = organizationId ? [organizationId] : [];

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
      SUM(CASE WHEN status = 'PENDING' OR status = 'QUEUED' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'BOUNCED' THEN 1 ELSE 0 END) as bounced,
      SUM(CASE WHEN status = 'COMPLAINED' THEN 1 ELSE 0 END) as complained,
      SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled
    FROM notification_deliveries
    ${where}
  `).get(...params);

  const total = counts?.total || 0;
  const successful = (counts?.sent || 0) + (counts?.delivered || 0);
  const deliveryRate = total > 0 ? Number(((successful / total) * 100).toFixed(1)) : 100.0;

  return {
    total,
    sent: counts?.sent || 0,
    delivered: counts?.delivered || 0,
    pending: counts?.pending || 0,
    processing: counts?.processing || 0,
    failed: counts?.failed || 0,
    bounced: counts?.bounced || 0,
    complained: counts?.complained || 0,
    cancelled: counts?.cancelled || 0,
    deliveryRate
  };
}

module.exports = {
  MAX_DELIVERY_ATTEMPTS,
  deliverNotification,
  retryDelivery,
  updateDeliveryFromWebhook,
  getDelivery,
  listDeliveries,
  getNotificationMetrics
};

