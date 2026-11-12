// ============================================================================
// ASPIRE DAY 23: WEBHOOK INGESTION ROUTES (RESEND & EMAIL PROVIDERS)
// ============================================================================

const express = require('express');
const router = express.Router();
const { verifyWebhook } = require('../services/notifications/email.service');
const { updateDeliveryFromWebhook } = require('../services/notifications/notification-delivery.service');
const logger = require('../utils/logger');

/**
 * POST /api/webhooks/email/resend
 * Ingests transactional email delivery events (delivered, bounced, complained, etc.)
 */
router.post('/email/resend', async (req, res) => {
  const isValid = verifyWebhook(req.body, req.headers);

  if (!isValid) {
    logger.warn({ ip: req.ip }, 'Received Resend webhook with invalid or missing signature');
    return res.status(401).json({
      success: false,
      error: 'INVALID_SIGNATURE',
      message: 'Webhook signature verification failed'
    });
  }

  const payload = req.body || {};
  const eventType = payload.type || payload.event || 'unknown';
  const data = payload.data || {};
  const providerMessageId = data.email_id || data.id || payload.email_id || payload.id;
  const timestamp = payload.created_at || data.created_at || new Date().toISOString();

  if (!providerMessageId) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_MESSAGE_ID',
      message: 'Provider message id was not found in webhook payload'
    });
  }

  try {
    const updateResult = updateDeliveryFromWebhook({
      providerMessageId,
      eventType,
      timestamp,
      metadata: data
    });

    return res.status(200).json({
      success: true,
      received: true,
      result: updateResult
    });
  } catch (err) {
    logger.error({ err: err.message, providerMessageId }, 'Error processing email webhook event');
    return res.status(500).json({
      success: false,
      error: 'WEBHOOK_PROCESSING_ERROR',
      message: err.message
    });
  }
});

module.exports = router;

