// ============================================================================
// ASPIRE DAY 23: NOTIFICATION PREFERENCES SERVICE
// ============================================================================

const { db } = require('../../db');
const { ValidationError, NotFoundError } = require('../../errors/app-error');

const MANDATORY_EVENT_TYPES = [
  'REGISTRATION_CONFIRMED'
];

/**
 * Retrieves preferences for a user, creating defaults if not yet initialized.
 */
function getNotificationPreferences(organizationId, userId) {
  if (!organizationId || !userId) {
    // If no specific userId, return default permissive preferences
    return {
      emailEnabled: true,
      registrationUpdates: true,
      examInvitations: true,
      examReminders: true,
      resultUpdates: true,
      certificateUpdates: true
    };
  }

  let row = db.prepare(`
    SELECT * FROM notification_preferences
    WHERE organization_id = ? AND user_id = ?
  `).get(organizationId, userId);

  if (!row) {
    db.prepare(`
      INSERT INTO notification_preferences (
        organization_id, user_id, email_enabled,
        registration_updates, exam_invitations, exam_reminders,
        result_updates, certificate_updates
      ) VALUES (?, ?, 1, 1, 1, 1, 1, 1)
      ON CONFLICT(organization_id, user_id) DO NOTHING
    `).run(organizationId, userId);

    row = db.prepare(`
      SELECT * FROM notification_preferences
      WHERE organization_id = ? AND user_id = ?
    `).get(organizationId, userId);
  }

  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    emailEnabled: Boolean(row.email_enabled),
    registrationUpdates: Boolean(row.registration_updates),
    examInvitations: Boolean(row.exam_invitations),
    examReminders: Boolean(row.exam_reminders),
    resultUpdates: Boolean(row.result_updates),
    certificateUpdates: Boolean(row.certificate_updates),
    updatedAt: row.updated_at
  };
}

/**
 * Updates notification preferences for an authorized user.
 */
function updateNotificationPreferences(organizationId, userId, updates = {}) {
  if (!organizationId || !userId) {
    throw new ValidationError('organizationId and userId are required');
  }

  getNotificationPreferences(organizationId, userId);

  const fields = [];
  const params = [];

  if (updates.email_enabled !== undefined) {
    fields.push('email_enabled = ?');
    params.push(updates.email_enabled ? 1 : 0);
  }
  if (updates.registration_updates !== undefined) {
    fields.push('registration_updates = ?');
    params.push(updates.registration_updates ? 1 : 0);
  }
  if (updates.exam_invitations !== undefined) {
    fields.push('exam_invitations = ?');
    params.push(updates.exam_invitations ? 1 : 0);
  }
  if (updates.exam_reminders !== undefined) {
    fields.push('exam_reminders = ?');
    params.push(updates.exam_reminders ? 1 : 0);
  }
  if (updates.result_updates !== undefined) {
    fields.push('result_updates = ?');
    params.push(updates.result_updates ? 1 : 0);
  }
  if (updates.certificate_updates !== undefined) {
    fields.push('certificate_updates = ?');
    params.push(updates.certificate_updates ? 1 : 0);
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    params.push(organizationId, userId);

    db.prepare(`
      UPDATE notification_preferences
      SET ${fields.join(', ')}
      WHERE organization_id = ? AND user_id = ?
    `).run(...params);
  }

  return getNotificationPreferences(organizationId, userId);
}

/**
 * Evaluates whether an email should be delivered given the recipient's preferences.
 * Enforces mandatory communication rules (REGISTRATION_CONFIRMED is always delivered).
 */
function isNotificationPermitted(organizationId, userId, eventType) {
  const normType = String(eventType || '').toUpperCase().trim();

  // Mandatory account and verification communications cannot be opted out of
  if (MANDATORY_EVENT_TYPES.includes(normType)) {
    return true;
  }

  if (!userId) {
    return true;
  }

  const prefs = getNotificationPreferences(organizationId, userId);
  if (!prefs.emailEnabled) {
    return false;
  }

  switch (normType) {
    case 'EXAM_INVITATION':
      return prefs.examInvitations;
    case 'EXAM_REMINDER':
      return prefs.examReminders;
    case 'RESULT_AVAILABLE':
      return prefs.resultUpdates;
    case 'CERTIFICATE_AVAILABLE':
      return prefs.certificateUpdates;
    case 'EXAM_COMPLETED':
      return true; // Assessment completion receipt is account activity
    default:
      return true;
  }
}

module.exports = {
  MANDATORY_EVENT_TYPES,
  getNotificationPreferences,
  updateNotificationPreferences,
  isNotificationPermitted
};

