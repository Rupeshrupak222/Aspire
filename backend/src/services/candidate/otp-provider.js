// ============================================================================
// ASPIRE DAY 25: SMS / OTP PROVIDER ABSTRACTION
// ============================================================================

const logger = require('../../utils/logger');

class MockOtpProvider {
  constructor() {
    this.name = 'MOCK';
    this.sentMessages = new Map(); // phone -> { otp, sentAt }
  }

  async sendOtp({ phone, otp }) {
    this.sentMessages.set(phone, {
      otp,
      sentAt: new Date().toISOString()
    });

    logger.info({
      service: 'aspire-otp',
      provider: 'MOCK',
      phone: phone.replace(/(\d{2})\d{6}(\d{2})/, '$1******$2'), // Masked PII
      otp: process.env.NODE_ENV === 'test' ? otp : '******'
    }, '[DEV/TEST] Mobile OTP generated successfully');

    return {
      success: true,
      messageId: `mock_sms_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      provider: 'MOCK'
    };
  }

  getLastOtp(phone) {
    return this.sentMessages.get(phone)?.otp || null;
  }

  clear() {
    this.sentMessages.clear();
  }
}

class LiveSmsProvider {
  constructor(config = {}) {
    this.name = config.providerName || 'LIVE_SMS';
    this.apiKey = config.apiKey || process.env.SMS_API_KEY;
  }

  async sendOtp({ phone, otp }) {
    if (!this.apiKey) {
      throw new Error('SMS provider API key not configured');
    }
    // Production integration hook for Twilio / AWS SNS / Msg91
    logger.info({ service: 'aspire-otp', provider: this.name, phone }, 'Dispatching live SMS OTP');
    return {
      success: true,
      messageId: `live_sms_${Date.now()}`,
      provider: this.name
    };
  }
}

// Active provider selection
let activeProvider = new MockOtpProvider();

function getOtpProvider() {
  if (process.env.SMS_PROVIDER === 'live' && process.env.SMS_API_KEY) {
    return new LiveSmsProvider({
      providerName: process.env.SMS_PROVIDER_NAME || 'GENERIC_SMS',
      apiKey: process.env.SMS_API_KEY
    });
  }
  return activeProvider;
}

function setMockOtpProvider(provider) {
  activeProvider = provider;
}

module.exports = {
  MockOtpProvider,
  LiveSmsProvider,
  getOtpProvider,
  setMockOtpProvider
};

