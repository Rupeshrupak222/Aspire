// ============================================================================
// ASPIRE DAY 23: TEMPLATE RENDERER SERVICE
// ============================================================================

const { renderRegistrationConfirmation } = require('./registration-confirmation');
const { renderExamInvitation } = require('./exam-invitation');
const { renderExamReminder } = require('./exam-reminder');
const { renderExamCompleted } = require('./exam-completed');
const { renderResultAvailable } = require('./result-available');
const { renderCertificateAvailable } = require('./certificate-available');
const { ValidationError } = require('../../../errors/app-error');

const TEMPLATE_MAP = {
  REGISTRATION_CONFIRMED: renderRegistrationConfirmation,
  EXAM_INVITATION: renderExamInvitation,
  EXAM_REMINDER: renderExamReminder,
  EXAM_COMPLETED: renderExamCompleted,
  RESULT_AVAILABLE: renderResultAvailable,
  CERTIFICATE_AVAILABLE: renderCertificateAvailable
};

/**
 * Renders an email template given a valid templateKey and parameters.
 *
 * @param {string} templateKey
 * @param {Object} data
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderTemplate(templateKey, data = {}) {
  const normKey = String(templateKey || '').toUpperCase().trim();
  const renderer = TEMPLATE_MAP[normKey];

  if (!renderer) {
    throw new ValidationError(`Unknown notification template key: ${templateKey}`);
  }

  return renderer(data);
}

function getRegisteredTemplates() {
  return Object.keys(TEMPLATE_MAP);
}

module.exports = {
  TEMPLATE_MAP,
  renderTemplate,
  getRegisteredTemplates
};
