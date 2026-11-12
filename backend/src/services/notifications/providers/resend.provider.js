// ============================================================================
// ASPIRE DAY 23: RESEND EMAIL PROVIDER IMPLEMENTATION
// ============================================================================

const crypto = require('crypto');
const { Resend } = require('resend');
const logger = require('../../../utils/logger');

class ResendEmailProvider {
  constructor(config = {}) {
    this.name = 'resend';
    this.apiKey = config.apiKey || process.env.RESEND_API_KEY || null;
    this.fromAddress = config.fromAddress || process.env.EMAIL_FROM_ADDRESS || 'notifications@aspire.adyapan.internal';
    this.fromName = config.fromName || process.env.EMAIL_FROM_NAME || 'Aspire by Adyapan';
    this.webhookSecret = config.webhookSecret || process.env.EMAIL_WEBHOOK_SECRET || null;
    this.client = this.apiKey ? new Resend(this.apiKey) : null;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  getProviderStatus() {
    return {
      provider: this.name,
      configured: this.isConfigured(),
      senderName: this.fromName,
      senderAddress: this.fromAddress,
      isReady: this.isConfigured()
    };
  }

  /**
   * Sends transactional email using official Resend SDK.
   *
   * @param {Object} message
   * @param {string} message.to
   * @param {string} message.subject
   * @param {string} message.html
   * @param {string} [message.text]
   * @param {string} [message.from]
   * @param {string} [message.replyTo]
   * @returns {Promise<{ success: boolean, providerMessageId: string, provider: string }>}
   */
  async sendEmail(message) {
    if (!this.isConfigured() || !this.client) {
      const err = new Error('Resend email provider is not configured (missing RESEND_API_KEY).');
      err.code = 'PROVIDER_NOT_CONFIGURED';
      err.isPermanent = true;
      throw err;
    }

    if (!message || !message.to) {
      const err = new Error('Recipient email address (to) is required.');
      err.code = 'INVALID_RECIPIENT';
      err.isPermanent = true;
      throw err;
    }

    const fromFormatted = message.from || `"${this.fromName}" <${this.fromAddress}>`;

    try {
      const response = await this.client.emails.send({
        from: fromFormatted,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text || undefined,
        reply_to: message.replyTo || undefined
      });

      if (response.error) {
        const errorMsg = response.error.message || 'Resend delivery failed';
        const err = new Error(`Resend API Error: ${errorMsg}`);
        err.providerError = response.error;
        err.code = response.error.name || 'PROVIDER_ERROR';
        // Classify permanent vs transient error
        if (response.error.name === 'validation_error' || response.error.statusCode === 422) {
          err.isPermanent = true;
        } else if (response.error.statusCode === 429) {
          err.isTransient = true;
        }
        throw err;
      }

      return {
        success: true,
        providerMessageId: response.data.id,
        provider: this.name
      };
    } catch (err) {
      logger.warn({ recipient: message.to, provider: this.name, error: err.message }, 'Failed sending email through Resend');
      if (err.isPermanent !== undefined) throw err;

      // Classify network errors
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        err.isTransient = true;
      }
      throw err;
    }
  }

  /**
   * Verifies incoming Resend / Svix webhook signature.
   *
   * @param {string|Buffer} rawBody
   * @param {Object} headers
   * @returns {boolean}
   */
  verifyWebhook(rawBody, headers = {}) {
    const secret = this.webhookSecret;
    if (!secret) {
      return false;
    }

    const msgId = headers['svix-id'] || headers['webhook-id'];
    const msgTimestamp = headers['svix-timestamp'] || headers['webhook-timestamp'];
    const msgSignature = headers['svix-signature'] || headers['webhook-signature'];

    if (!msgId || !msgTimestamp || !msgSignature) {
      return false;
    }

    // Verify timestamp within 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(msgTimestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 300) {
      return false;
    }

    try {
      // Svix signature format: v1,<base64_hmac>
      const bodyStr = typeof rawBody === 'string'
        ? rawBody
        : (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : JSON.stringify(rawBody));
      const signedContent = `${msgId}.${msgTimestamp}.${bodyStr}`;

      // Secret may have "whsec_" prefix (base64 encoded key)
      const cleanSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
      const keyBuffer = Buffer.from(cleanSecret, 'base64');

      const expectedSig = crypto
        .createHmac('sha256', keyBuffer)
        .update(signedContent)
        .digest('base64');

      const passedSignatures = msgSignature.split(' ').map((s) => s.split(',')[1] || s);
      return passedSignatures.some((sig) => {
        try {
          return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
        } catch {
          return false;
        }
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'Webhook signature verification failed');
      return false;
    }
  }
}

module.exports = { ResendEmailProvider };
