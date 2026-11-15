// ============================================================================
// ASPIRE DAY 25: FIRST-PARTY CAMPAIGN ATTRIBUTION SERVICE
// ============================================================================

const { db } = require('../../db');
const logger = require('../../utils/logger');

/**
 * Sanitizes and trims attribution query string parameters.
 */
function sanitizeField(val, maxLen = 100) {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  return trimmed.substring(0, maxLen);
}

/**
 * Records first-touch and last-touch attribution for a candidate.
 * @param {Object} params
 * @param {number} params.studentId - Student identifier
 * @param {Object} params.attribution - UTM and referral data
 * @param {string} [params.ip] - Request IP address
 * @param {string} [params.userAgent] - Browser User Agent
 */
function recordAttribution({ studentId, attribution = {}, ip = null, userAgent = null }) {
  if (!studentId || isNaN(studentId)) return null;

  const utmSource = sanitizeField(attribution.utm_source);
  const utmMedium = sanitizeField(attribution.utm_medium);
  const utmCampaign = sanitizeField(attribution.utm_campaign);
  const utmTerm = sanitizeField(attribution.utm_term);
  const utmContent = sanitizeField(attribution.utm_content);
  const referralCode = sanitizeField(attribution.referral_code || attribution.campaign_code, 50);
  const landingSource = sanitizeField(attribution.landing_source);
  const safeIp = sanitizeField(ip, 45);
  const safeUA = sanitizeField(userAgent, 255);

  // If all parameters are completely empty, no attribution event to record
  const hasData = utmSource || utmMedium || utmCampaign || utmTerm || utmContent || referralCode || landingSource;
  if (!hasData) return null;

  // 1. Check if FIRST_TOUCH exists for this student
  const existingFirst = db.prepare(`
    SELECT id FROM campaign_attributions
    WHERE student_id = ? AND touch_type = 'FIRST_TOUCH'
    LIMIT 1
  `).get(studentId);

  const insertStmt = db.prepare(`
    INSERT INTO campaign_attributions
      (student_id, touch_type, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referral_code, landing_source, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (!existingFirst) {
    // Record immutable FIRST_TOUCH
    insertStmt.run(
      studentId,
      'FIRST_TOUCH',
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      referralCode,
      landingSource,
      safeIp,
      safeUA
    );
  }

  // 2. Always record or refresh LAST_TOUCH
  const existingLast = db.prepare(`
    SELECT id FROM campaign_attributions
    WHERE student_id = ? AND touch_type = 'LAST_TOUCH'
    LIMIT 1
  `).get(studentId);

  if (existingLast) {
    db.prepare(`
      UPDATE campaign_attributions
      SET utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?,
          referral_code = ?, landing_source = ?, ip = ?, user_agent = ?, created_at = datetime('now')
      WHERE id = ?
    `).run(
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      referralCode,
      landingSource,
      safeIp,
      safeUA,
      existingLast.id
    );
  } else {
    insertStmt.run(
      studentId,
      'LAST_TOUCH',
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm,
      utmContent,
      referralCode,
      landingSource,
      safeIp,
      safeUA
    );
  }

  logger.info({
    service: 'aspire-campaign',
    studentId,
    utmSource,
    utmCampaign,
    referralCode
  }, 'Recorded campaign attribution touchpoints');

  return { studentId, utmSource, utmCampaign };
}

/**
 * Retrieves attribution profile for a candidate.
 */
function getStudentAttribution(studentId) {
  return db.prepare(`
    SELECT * FROM campaign_attributions
    WHERE student_id = ?
    ORDER BY id ASC
  `).all(studentId);
}

module.exports = {
  recordAttribution,
  getStudentAttribution
};

