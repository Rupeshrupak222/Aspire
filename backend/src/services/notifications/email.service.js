// ============================================================================
// ASPIRE DAY 23: CENTRAL EMAIL SERVICE & PROVIDER ABSTRACTION
// ============================================================================

const { ResendEmailProvider } = require('./providers/resend.provider');
const { MockEmailProvider } = require('./providers/mock.provider');
const logger = require('../../utils/logger');

let activeProvider = null;

/**
 * Initializes and returns the active email provider.
 * Follows zero-crash fallback to Mock provider when credentials are absent.
 */
function getEmailProvider() {
  if (activeProvider) {
    return activeProvider;
  }

  const configuredProvider = (process.env.EMAIL_PROVIDER || '').toLowerCase().trim();
  const hasResendKey = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim().length > 0);
  const isTestEnv = process.env.NODE_ENV === 'test';

  if (configuredProvider === 'resend' && hasResendKey && !isTestEnv) {
    try {
      activeProvider = new ResendEmailProvider();
      logger.info({ provider: 'resend' }, 'Initialized Resend email provider');
    } catch (err) {
      logger.warn({ error: err.message }, 'Failed initializing Resend provider, falling back to Mock');
      activeProvider = new MockEmailProvider();
    }
  } else {
    activeProvider = new MockEmailProvider();
  }

  return activeProvider;
}

/**
 * Allows overriding provider explicitly (essential for hermetic unit & integration tests).
 */
function setEmailProvider(provider) {
  activeProvider = provider;
}

/**
 * Reset provider instance to default auto-detection.
 */
function resetEmailProvider() {
  activeProvider = null;
}

/**
 * Primary email dispatch method.
 */
async function sendEmail(message) {
  const provider = getEmailProvider();
  return provider.sendEmail(message);
}

/**
 * Returns safe provider metadata without leaking secrets.
 */
function getProviderStatus() {
  const provider = getEmailProvider();
  return provider.getProviderStatus();
}

/**
 * Verifies webhook signature against active provider.
 */
function verifyWebhook(rawBody, headers) {
  const provider = getEmailProvider();
  return provider.verifyWebhook(rawBody, headers);
}

module.exports = {
  getEmailProvider,
  setEmailProvider,
  resetEmailProvider,
  sendEmail,
  getProviderStatus,
  verifyWebhook
};

