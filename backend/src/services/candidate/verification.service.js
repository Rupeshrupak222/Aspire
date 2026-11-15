// ============================================================================
// ASPIRE DAY 25: CANDIDATE VERIFICATION SERVICE
// ============================================================================
// Handles mobile SMS OTP and email token verification workflows with:
// - Cryptographically secure generation
// - SHA-256 hashed persistence (zero plaintext secrets stored in DB)
// - Expiration boundaries (OTP: 10 mins, Email: 24 hours)
// - Maximum attempt limits & brute-force defense
// - 60-second resend cooldowns
// - Single-use consumption
// ============================================================================

const crypto = require('crypto');
const { db } = require('../../db');
const { getOtpProvider } = require('./otp-provider');
const logger = require('../../utils/logger');
const { ValidationError, ConflictError, AppError } = require('../../errors/app-error');

// Configuration
const OTP_EXPIRY_MINUTES = 10;
const EMAIL_EXPIRY_HOURS = 24;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const MAX_OTP_ATTEMPTS = 5;

/**
 * SHA-256 hash helper for code storage.
 */
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret).trim(), 'utf8').digest('hex');
}

/**
 * Sends a 6-digit numeric OTP to the specified mobile phone.
 */
async function sendMobileOtp({ phone, studentId = null }) {
  const normPhone = String(phone).trim();
  const now = new Date();

  // 1. Check existing active verification and rate-limiting cooldown
  const existing = db.prepare(`
    SELECT * FROM candidate_verifications
    WHERE identifier = ? AND type = 'MOBILE_OTP' AND verified_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(normPhone);

  if (existing) {
    const resendAvailableAt = new Date(existing.resend_available_at);
    if (now < resendAvailableAt) {
      const waitSec = Math.ceil((resendAvailableAt.getTime() - now.getTime()) / 1000);
      throw new ValidationError(`Please wait ${waitSec}s before requesting a new OTP.`, {
        phone: `Resend cooldown active. Try again in ${waitSec} seconds.`
      });
    }
  }

  // 2. Generate 6-digit cryptographically random OTP
  const rawOtp = String(crypto.randomInt(100000, 1000000));
  const codeHash = hashSecret(rawOtp);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();
  const resendAvailableAt = new Date(now.getTime() + OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString();

  // 3. Persist hashed OTP record
  db.prepare(`
    INSERT INTO candidate_verifications
      (identifier, type, code_hash, student_id, expires_at, attempts, max_attempts, resend_available_at)
    VALUES (?, 'MOBILE_OTP', ?, ?, ?, 0, ?, ?)
  `).run(normPhone, codeHash, studentId, expiresAt, MAX_OTP_ATTEMPTS, resendAvailableAt);

  // 4. Dispatch through active OTP provider
  const provider = getOtpProvider();
  await provider.sendOtp({ phone: normPhone, otp: rawOtp });

  logger.info({
    service: 'aspire-verification',
    type: 'MOBILE_OTP',
    phone: normPhone.replace(/(\d{2})\d{6}(\d{2})/, '$1******$2')
  }, 'Dispatched mobile OTP code');

  return {
    success: true,
    message: 'Verification code sent successfully',
    expiresInSeconds: OTP_EXPIRY_MINUTES * 60,
    resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS
  };
}

/**
 * Verifies the mobile OTP for a given phone number.
 */
function verifyMobileOtp({ phone, otp }) {
  const normPhone = String(phone).trim();
  const rawOtp = String(otp).trim();
  const codeHash = hashSecret(rawOtp);
  const now = new Date();

  const record = db.prepare(`
    SELECT * FROM candidate_verifications
    WHERE identifier = ? AND type = 'MOBILE_OTP' AND verified_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(normPhone);

  if (!record) {
    throw new ValidationError('No active OTP request found for this mobile number. Please request a new code.');
  }

  // Check expiration
  if (now > new Date(record.expires_at)) {
    throw new ValidationError('Verification code has expired. Please request a new OTP.');
  }

  // Check maximum attempts
  if (record.attempts >= record.max_attempts) {
    throw new ValidationError('Maximum OTP verification attempts exceeded. Please request a new code.');
  }

  // Validate constant-time hash
  const isValid = crypto.timingSafeEqual(Buffer.from(record.code_hash, 'hex'), Buffer.from(codeHash, 'hex'));

  if (!isValid) {
    const updatedAttempts = record.attempts + 1;
    db.prepare('UPDATE candidate_verifications SET attempts = ? WHERE id = ?').run(updatedAttempts, record.id);
    const remaining = record.max_attempts - updatedAttempts;
    throw new ValidationError(`Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
  }

  // Mark verified
  const verifiedAt = now.toISOString();
  db.prepare('UPDATE candidate_verifications SET verified_at = ? WHERE id = ?').run(verifiedAt, record.id);

  // Update student table if associated student exists
  if (record.student_id) {
    db.prepare('UPDATE students SET phone_verified = 1 WHERE id = ?').run(record.student_id);
  } else {
    db.prepare('UPDATE students SET phone_verified = 1 WHERE phone = ?').run(normPhone);
  }

  logger.info({
    service: 'aspire-verification',
    type: 'MOBILE_OTP',
    phone: normPhone.replace(/(\d{2})\d{6}(\d{2})/, '$1******$2')
  }, 'Mobile OTP verified successfully');

  return {
    success: true,
    verified: true,
    message: 'Mobile number verified successfully'
  };
}

/**
 * Generates and dispatches an email verification link using the notification outbox.
 */
async function sendEmailVerification({ email, studentId = null, studentName = null }) {
  const normEmail = String(email).trim().toLowerCase();
  const now = new Date();

  // Check cooldown
  const existing = db.prepare(`
    SELECT * FROM candidate_verifications
    WHERE identifier = ? AND type = 'EMAIL_TOKEN' AND verified_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(normEmail);

  if (existing) {
    const resendAvailableAt = new Date(existing.resend_available_at);
    if (now < resendAvailableAt) {
      const waitSec = Math.ceil((resendAvailableAt.getTime() - now.getTime()) / 1000);
      throw new ValidationError(`Please wait ${waitSec}s before requesting a new verification email.`);
    }
  }

  // Generate 64-character secure hex token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const codeHash = hashSecret(rawToken);
  const expiresAt = new Date(now.getTime() + EMAIL_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  const resendAvailableAt = new Date(now.getTime() + 60 * 1000).toISOString();

  // Persist verification record
  db.prepare(`
    INSERT INTO candidate_verifications
      (identifier, type, code_hash, student_id, expires_at, attempts, max_attempts, resend_available_at)
    VALUES (?, 'EMAIL_TOKEN', ?, ?, ?, 0, 10, ?)
  `).run(normEmail, codeHash, studentId, expiresAt, resendAvailableAt);

  // Dispatch via Day 23 notification system if available
  const verificationUrl = `${process.env.APP_BASE_URL || 'https://aspire.adyapan.com'}/api/auth/candidate/verify-email?token=${rawToken}`;
  try {
    const notifService = require('../notifications/notification.service');
    notifService.createNotificationEvent({
      organizationId: 1,
      eventType: 'CANDIDATE_EMAIL_VERIFICATION',
      recipientEmail: normEmail,
      recipientName: studentName || 'Candidate',
      template: 'EMAIL_VERIFICATION',
      payload: {
        email: normEmail,
        verificationUrl,
        expiresInHours: EMAIL_EXPIRY_HOURS
      },
      idempotencyKey: `email_verif_${normEmail}_${Date.now()}`
    });
  } catch (err) {
    logger.warn({ service: 'aspire-verification', err: err.message }, 'Failed enqueueing notification outbox event for email verification');
  }

  logger.info({
    service: 'aspire-verification',
    type: 'EMAIL_TOKEN',
    email: normEmail
  }, 'Dispatched email verification token');

  return {
    success: true,
    message: 'Verification link sent to your email address',
    rawToken: process.env.NODE_ENV === 'test' ? rawToken : undefined,
    verificationUrl: process.env.NODE_ENV === 'test' ? verificationUrl : undefined
  };
}

/**
 * Verifies email using the token from the query parameter.
 */
function verifyEmailToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new ValidationError('A valid verification token is required.');
  }

  const codeHash = hashSecret(rawToken);
  const now = new Date();

  const record = db.prepare(`
    SELECT * FROM candidate_verifications
    WHERE code_hash = ? AND type = 'EMAIL_TOKEN'
    LIMIT 1
  `).get(codeHash);

  if (!record) {
    throw new ValidationError('Invalid or unknown email verification token.');
  }

  if (record.verified_at) {
    return {
      success: true,
      alreadyVerified: true,
      message: 'Email address has already been verified.'
    };
  }

  if (now > new Date(record.expires_at)) {
    throw new ValidationError('This verification link has expired. Please request a new verification email.');
  }

  const verifiedAt = now.toISOString();
  db.prepare('UPDATE candidate_verifications SET verified_at = ? WHERE id = ?').run(verifiedAt, record.id);

  if (record.student_id) {
    db.prepare('UPDATE students SET email_verified = 1 WHERE id = ?').run(record.student_id);
  } else {
    db.prepare('UPDATE students SET email_verified = 1 WHERE email = ?').run(record.identifier);
  }

  logger.info({
    service: 'aspire-verification',
    type: 'EMAIL_TOKEN',
    email: record.identifier
  }, 'Email verified successfully via token');

  return {
    success: true,
    verified: true,
    email: record.identifier,
    message: 'Your email address has been verified successfully!'
  };
}

module.exports = {
  sendMobileOtp,
  verifyMobileOtp,
  sendEmailVerification,
  verifyEmailToken,
  hashSecret
};

