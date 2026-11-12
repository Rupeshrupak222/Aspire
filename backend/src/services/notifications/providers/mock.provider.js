// ============================================================================
// ASPIRE DAY 23: MOCK EMAIL PROVIDER (FOR DEV, TESTING & HERMETIC RUNS)
// ============================================================================

const crypto = require('crypto');

class MockEmailProvider {
  constructor(config = {}) {
    this.name = 'mock';
    this.fromAddress = config.fromAddress || 'notifications@aspire.adyapan.internal';
    this.fromName = config.fromName || 'Aspire by Adyapan';
    this.sentMessages = [];
    this.simulatedError = null;
    this.shouldFailNext = false;
    this.failureType = 'TRANSIENT';
  }

  isConfigured() {
    return true;
  }

  getProviderStatus() {
    return {
      provider: this.name,
      configured: true,
      senderName: this.fromName,
      senderAddress: this.fromAddress,
      isReady: true,
      isMock: true,
      sentCount: this.sentMessages.length
    };
  }

  /**
   * Simulates email transmission and stores payload in memory.
   */
  async sendEmail(message) {
    if (!message || !message.to) {
      const err = new Error('Recipient email address (to) is required.');
      err.code = 'INVALID_RECIPIENT';
      err.isPermanent = true;
      throw err;
    }

    // Invalid email check simulation
    if (message.to.includes('invalid') || message.to.includes('bounce') || !message.to.includes('@')) {
      const err = new Error(`Recipient ${message.to} rejected: address does not exist.`);
      err.code = 'INVALID_RECIPIENT';
      err.isPermanent = true;
      throw err;
    }

    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      const err = this.simulatedError || new Error('Simulated email transmission error');
      if (this.failureType === 'PERMANENT') {
        err.isPermanent = true;
      } else {
        err.isTransient = true;
      }
      throw err;
    }

    const providerMessageId = `mock_msg_${crypto.randomBytes(8).toString('hex')}`;
    const sentRecord = {
      providerMessageId,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      from: message.from || `"${this.fromName}" <${this.fromAddress}>`,
      replyTo: message.replyTo,
      sentAt: new Date().toISOString()
    };

    this.sentMessages.push(sentRecord);

    return {
      success: true,
      providerMessageId,
      provider: this.name
    };
  }

  simulateFailure(error = null, type = 'TRANSIENT') {
    this.shouldFailNext = true;
    this.simulatedError = error;
    this.failureType = type;
  }

  getSentMessages() {
    return [...this.sentMessages];
  }

  getLastMessage() {
    return this.sentMessages[this.sentMessages.length - 1] || null;
  }

  findMessagesFor(recipientEmail) {
    const norm = String(recipientEmail || '').toLowerCase().trim();
    return this.sentMessages.filter((m) => String(m.to).toLowerCase().trim() === norm);
  }

  clear() {
    this.sentMessages = [];
    this.shouldFailNext = false;
    this.simulatedError = null;
  }

  verifyWebhook(rawBody, headers = {}) {
    return headers['x-mock-signature'] === 'valid_mock_signature';
  }
}

module.exports = { MockEmailProvider };

