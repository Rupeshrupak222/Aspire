// ============================================================================
// ASPIRE DAY 24: DIGITAL CERTIFICATE LIFECYCLE SERVICE
// Issuance, Cryptographic Verification, Revocation, Reissuance & Audit Events
// ============================================================================

const { db } = require('../../db');
const { ValidationError, NotFoundError, AuthorizationError } = require('../../errors/app-error');
const certCrypto = require('../../utils/certificate-crypto');
const logger = require('../../utils/logger');

// Clear cache hook
let clearCacheHook = null;
function setClearCacheHook(fn) {
  clearCacheHook = fn;
}

/**
 * Returns canonical public base URL.
 */
function getPublicBaseUrl() {
  return process.env.CERTIFICATE_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://aspire.adyapan.com';
}

/**
 * Issues a cryptographically signed, immutable digital certificate.
 * Strictly idempotent: returns existing certificate if attemptId already has one.
 */
function issueCertificate({
  attemptId = null,
  organizationId = null,
  studentId = null,
  studentName,
  examId = null,
  examTitle,
  score = 0,
  totalMarks = 100,
  percentage = 0,
  scholarshipPct = 0,
  actorId = null,
  issuedAt = null
}) {
  if (!studentName || typeof studentName !== 'string') {
    throw new ValidationError('studentName is required to issue certificate');
  }
  if (!examTitle || typeof examTitle !== 'string') {
    throw new ValidationError('examTitle is required to issue certificate');
  }

  // 1. Idempotency Check & Foreign Key Verification
  let effectiveAttemptId = null;
  if (attemptId) {
    const existing = db.prepare(`
      SELECT * FROM certificates 
      WHERE attempt_id = ? AND verification_status = 'VALID'
    `).get(attemptId);

    if (existing) {
      return { certificate: existing, isDuplicate: true };
    }

    // Check attempt table for existing certificate_id
    const att = db.prepare('SELECT id, certificate_id FROM attempts WHERE id = ?').get(attemptId);
    if (att) {
      effectiveAttemptId = att.id;
      if (att.certificate_id) {
        const existingById = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(att.certificate_id);
        if (existingById) {
          return { certificate: existingById, isDuplicate: true };
        }
      }
    }
  }

  let effectiveOrgId = null;
  if (organizationId) {
    const org = db.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationId);
    if (org) effectiveOrgId = org.id;
  }

  let effectiveStudentId = null;
  if (studentId) {
    const st = db.prepare('SELECT id FROM students WHERE id = ?').get(studentId);
    if (st) effectiveStudentId = st.id;
  }

  let effectiveExamId = null;
  if (examId) {
    const ex = db.prepare('SELECT id FROM exams WHERE id = ?').get(examId);
    if (ex) effectiveExamId = ex.id;
  }

  // 2. Generate Collision-Resistant Unique Certificate ID
  let certificateId = null;
  let attemptsCount = 0;
  while (!certificateId && attemptsCount < 10) {
    attemptsCount++;
    const candidateId = certCrypto.generateCertificateId('ASP26');
    const row = db.prepare('SELECT id FROM certificates WHERE certificate_id = ?').get(candidateId);
    if (!row) {
      certificateId = candidateId;
    }
  }

  if (!certificateId) {
    throw new Error('Failed generating unique certificate ID after multiple attempts');
  }

  // 3. Construct Canonical Immutable Issuance Snapshot
  const dateStr = issuedAt ? new Date(issuedAt).toISOString() : new Date().toISOString();
  const payload = certCrypto.createCertificatePayload({
    certificateId,
    organizationId,
    studentId,
    studentName,
    examId,
    examTitle,
    finalScore: score,
    maximumScore: totalMarks,
    scorePercentage: percentage,
    scholarshipPercentage: scholarshipPct,
    issuedAt: dateStr,
    certificateVersion: 'v1'
  });

  // 4. Calculate Payload Hash & HMAC-SHA256 Signature
  const payloadJson = certCrypto.canonicalizePayload(payload);
  const payloadHash = certCrypto.createPayloadHash(payload);
  const { signature, signingKeyId } = certCrypto.signCertificatePayload(payload);
  const verificationUrl = `${getPublicBaseUrl()}/verify/${certificateId}`;

  let createdCertificate = null;

  // 5. Atomic SQLite Commit
  const tx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT INTO certificates (
        certificate_id, organization_id, attempt_id, student_id, exam_id,
        student_name, exam_title, score, total_marks, percentage, scholarship_pct,
        verification_status, payload_json, payload_hash, signature, signing_key_id,
        verification_url, issued_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALID', ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      certificateId,
      effectiveOrgId,
      effectiveAttemptId,
      effectiveStudentId,
      effectiveExamId,
      studentName.trim(),
      examTitle.trim(),
      Number(score || 0),
      Number(totalMarks || 100),
      Number(percentage || 0),
      Number(scholarshipPct || 0),
      payloadJson,
      payloadHash,
      signature,
      signingKeyId,
      verificationUrl,
      dateStr,
      dateStr,
      dateStr
    );

    // Sync to attempt record if present
    if (effectiveAttemptId) {
      db.prepare(`
        UPDATE attempts 
        SET certificate_id = ? 
        WHERE id = ? AND (certificate_id IS NULL OR certificate_id = '')
      `).run(certificateId, effectiveAttemptId);
    }

    // Record audit event
    db.prepare(`
      INSERT INTO certificate_verification_events (
        certificate_id, event_type, verification_result, verifier_source, safe_metadata_json, created_at
      ) VALUES (?, 'CERTIFICATE_ISSUED', 'VALID', ?, ?, ?)
    `).run(
      certificateId,
      actorId ? `actor_${actorId}` : 'system',
      JSON.stringify({ attemptId, organizationId, score, scholarshipPct }),
      dateStr
    );

    createdCertificate = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(certificateId);
  });

  tx();

  // Invalidate any cache
  if (clearCacheHook) {
    try { clearCacheHook(organizationId, certificateId); } catch {}
  }

  logger.info({ certificateId, organizationId, attemptId }, 'Issued digital certificate successfully');
  return { certificate: createdCertificate, isDuplicate: false };
}

/**
 * Publicly verifies a certificate by its unique Certificate ID.
 * Performs cryptographic integrity and revocation checks.
 * Absolutely NEVER exposes candidate PII (email, phone, student ID, address).
 */
function verifyCertificate(certificateId, verifierSource = 'public_api') {
  if (!certificateId || typeof certificateId !== 'string') {
    return {
      status: 'NOT_FOUND',
      message: 'Certificate not found. A valid Certificate ID is required.'
    };
  }

  const cleanId = certificateId.trim().toUpperCase();

  // 1. Look up certificate in database
  const cert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(cleanId);
  if (!cert) {
    try {
      db.prepare(`
        INSERT INTO certificate_verification_events (
          certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
        ) VALUES (?, 'CERTIFICATE_VERIFIED', 'NOT_FOUND', ?, '{}')
      `).run(cleanId, verifierSource);
    } catch {}

    return {
      status: 'NOT_FOUND',
      certificateId: cleanId,
      message: 'Certificate not found. Please check the Certificate ID and try again.'
    };
  }

  // 2. Validate Canonical Payload Integrity via Hash
  let computedHash;
  try {
    computedHash = certCrypto.createPayloadHash(cert.payload_json);
  } catch (err) {
    return {
      status: 'INVALID',
      certificateId: cleanId,
      message: 'Certificate payload could not be parsed. Integrity check failed.'
    };
  }

  if (computedHash !== cert.payload_hash) {
    try {
      db.prepare(`
        INSERT INTO certificate_verification_events (
          certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
        ) VALUES (?, 'SIGNATURE_VALIDATION_FAILED', 'HASH_MISMATCH', ?, '{}')
      `).run(cleanId, verifierSource);
    } catch {}

    return {
      status: 'INVALID',
      certificateId: cleanId,
      message: 'Integrity check failed: Certificate issuance data has been altered.'
    };
  }

  // 3. Cryptographic Signature Verification
  const signingKey = certCrypto.getSigningKey(cert.signing_key_id);
  if (!signingKey) {
    try {
      db.prepare(`
        INSERT INTO certificate_verification_events (
          certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
        ) VALUES (?, 'SIGNATURE_VALIDATION_FAILED', 'UNVERIFIABLE_KEY', ?, '{}')
      `).run(cleanId, verifierSource);
    } catch {}

    return {
      status: 'INVALID',
      certificateId: cleanId,
      message: 'Cryptographic signature could not be verified: Historical signing key unavailable.'
    };
  }

  const isSignatureValid = certCrypto.verifyCertificateSignature(
    cert.payload_json,
    cert.signature,
    signingKey
  );

  if (!isSignatureValid) {
    try {
      db.prepare(`
        INSERT INTO certificate_verification_events (
          certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
        ) VALUES (?, 'SIGNATURE_VALIDATION_FAILED', 'INVALID_SIGNATURE', ?, '{}')
      `).run(cleanId, verifierSource);
    } catch {}

    return {
      status: 'INVALID',
      certificateId: cleanId,
      message: 'Cryptographic signature verification failed: Invalid credential signature.'
    };
  }

  // 4. Check Revocation Status
  if (cert.verification_status === 'REVOKED') {
    try {
      db.prepare(`
        INSERT INTO certificate_verification_events (
          certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
        ) VALUES (?, 'CERTIFICATE_VERIFIED', 'REVOKED', ?, '{}')
      `).run(cleanId, verifierSource);
    } catch {}

    return {
      status: 'REVOKED',
      certificateId: cleanId,
      revokedAt: cert.revoked_at,
      revocationReason: cert.revocation_reason || 'Revoked by the issuing institution.',
      reissuedAsCertificateId: cert.reissued_as_certificate_id || null,
      message: 'This certificate has been revoked by the issuing authority and is no longer valid.'
    };
  }

  // 5. Check Expiration (if expired status present)
  if (cert.verification_status === 'EXPIRED') {
    try {
      db.prepare(`
        INSERT INTO certificate_verification_events (
          certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
        ) VALUES (?, 'CERTIFICATE_VERIFIED', 'EXPIRED', ?, '{}')
      `).run(cleanId, verifierSource);
    } catch {}

    return {
      status: 'EXPIRED',
      certificateId: cleanId,
      message: 'This certificate has expired.'
    };
  }

  // 6. Valid Certificate: Fetch Organization Public Information
  let orgName = 'Aspire by Adyapan';
  let orgLogo = null;
  if (cert.organization_id) {
    const org = db.prepare('SELECT name, logo_url FROM organizations WHERE id = ?').get(cert.organization_id);
    if (org) {
      orgName = org.name || orgName;
      orgLogo = org.logo_url || null;
    }
  }

  // Record successful verification event
  try {
    db.prepare(`
      INSERT INTO certificate_verification_events (
        certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
      ) VALUES (?, 'CERTIFICATE_VERIFIED', 'VALID', ?, '{}')
    `).run(cleanId, verifierSource);
  } catch {}

  let payloadData = {};
  try { payloadData = JSON.parse(cert.payload_json); } catch {}

  return {
    status: 'VALID',
    certificateId: cleanId,
    studentName: payloadData.studentName || cert.student_name,
    examTitle: payloadData.examTitle || cert.exam_title,
    finalScore: payloadData.finalScore !== undefined ? payloadData.finalScore : cert.score,
    maximumScore: payloadData.maximumScore !== undefined ? payloadData.maximumScore : cert.total_marks,
    scorePercentage: payloadData.scorePercentage !== undefined ? payloadData.scorePercentage : cert.percentage,
    scholarshipPercentage: payloadData.scholarshipPercentage !== undefined ? payloadData.scholarshipPercentage : cert.scholarship_pct,
    issuedAt: cert.issued_at,
    organizationName: orgName,
    organizationLogo: orgLogo,
    verificationUrl: cert.verification_url,
    verificationTimestamp: new Date().toISOString(),
    message: 'This certificate is authentic and has been successfully verified by Aspire by Adyapan.'
  };
}

/**
 * Revokes an existing certificate with a mandatory reason.
 * Scoped to organization unless Super Admin.
 */
function revokeCertificate({
  certificateId,
  organizationId = null,
  reason,
  revokedByUserId = null
}) {
  if (!certificateId) throw new ValidationError('certificateId is required');
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ValidationError('A mandatory revocation reason is required');
  }

  const cleanId = certificateId.trim().toUpperCase();
  const cert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(cleanId);
  if (!cert) {
    throw new NotFoundError(`Certificate ${cleanId} not found`);
  }

  // Multi-tenant check: org admin can only revoke certificates for their organization
  if (organizationId !== null && cert.organization_id !== null && Number(cert.organization_id) !== Number(organizationId)) {
    throw new AuthorizationError('Cannot revoke certificate belonging to another organization');
  }

  if (cert.verification_status === 'REVOKED') {
    return cert; // already revoked
  }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE certificates
      SET verification_status = 'REVOKED',
          revoked_at = ?,
          revoked_by = ?,
          revocation_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(now, revokedByUserId, reason.trim(), now, cert.id);

    db.prepare(`
      INSERT INTO certificate_verification_events (
        certificate_id, event_type, verification_result, verifier_source, safe_metadata_json, created_at
      ) VALUES (?, 'CERTIFICATE_REVOKED', 'REVOKED', ?, ?, ?)
    `).run(
      cleanId,
      revokedByUserId ? `user_${revokedByUserId}` : 'admin',
      JSON.stringify({ reason: reason.trim(), organizationId: cert.organization_id }),
      now
    );
  });

  tx();

  // Invalidate cached PDF
  if (clearCacheHook) {
    try { clearCacheHook(cert.organization_id, cleanId); } catch {}
  }

  logger.warn({ certificateId: cleanId, reason, revokedByUserId }, 'Certificate revoked successfully');
  return db.prepare('SELECT * FROM certificates WHERE id = ?').get(cert.id);
}

/**
 * Reissues a corrected certificate after revocation.
 */
function reissueCertificate({
  oldCertificateId,
  organizationId = null,
  reason,
  modifiedData = {},
  actorId = null
}) {
  const oldCert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(oldCertificateId);
  if (!oldCert) {
    throw new NotFoundError(`Original certificate ${oldCertificateId} not found`);
  }

  // Revoke old certificate if not already revoked
  if (oldCert.verification_status !== 'REVOKED') {
    revokeCertificate({
      certificateId: oldCertificateId,
      organizationId,
      reason: `Reissued: ${reason || 'Data correction'}`,
      revokedByUserId: actorId
    });
  }

  // Issue new certificate with updated data
  const { certificate: newCert } = issueCertificate({
    attemptId: oldCert.attempt_id,
    organizationId: oldCert.organization_id,
    studentId: oldCert.student_id,
    studentName: modifiedData.studentName || oldCert.student_name,
    examId: oldCert.exam_id,
    examTitle: modifiedData.examTitle || oldCert.exam_title,
    score: modifiedData.score !== undefined ? modifiedData.score : oldCert.score,
    totalMarks: modifiedData.totalMarks !== undefined ? modifiedData.totalMarks : oldCert.total_marks,
    percentage: modifiedData.percentage !== undefined ? modifiedData.percentage : oldCert.percentage,
    scholarshipPct: modifiedData.scholarshipPct !== undefined ? modifiedData.scholarshipPct : oldCert.scholarship_pct,
    actorId
  });

  // Link old and new certificates
  db.transaction(() => {
    db.prepare(`
      UPDATE certificates 
      SET reissued_as_certificate_id = ?, updated_at = datetime('now') 
      WHERE id = ?
    `).run(newCert.certificate_id, oldCert.id);

    db.prepare(`
      UPDATE certificates 
      SET reissued_from_certificate_id = ?, updated_at = datetime('now') 
      WHERE id = ?
    `).run(oldCert.certificate_id, newCert.id);

    db.prepare(`
      INSERT INTO certificate_verification_events (
        certificate_id, event_type, verification_result, verifier_source, safe_metadata_json
      ) VALUES (?, 'CERTIFICATE_REISSUED', 'VALID', ?, ?)
    `).run(
      newCert.certificate_id,
      actorId ? `actor_${actorId}` : 'admin',
      JSON.stringify({ reissuedFrom: oldCert.certificate_id, reason })
    );
  })();

  logger.info({ oldCertificateId, newCertificateId: newCert.certificate_id }, 'Certificate reissued successfully');
  return db.prepare('SELECT * FROM certificates WHERE id = ?').get(newCert.id);
}

/**
 * Returns certificate record by ID.
 */
function getCertificateById(certificateId, organizationId = null) {
  if (!certificateId) return null;
  const cert = db.prepare('SELECT * FROM certificates WHERE certificate_id = ?').get(certificateId);
  if (!cert) return null;

  if (organizationId !== null && cert.organization_id !== null && Number(cert.organization_id) !== Number(organizationId)) {
    throw new AuthorizationError('Cannot access certificate from another organization');
  }

  return cert;
}

/**
 * Returns paginated list of certificates for organization admin or Super Admin.
 */
function listCertificates({
  organizationId = null,
  examId = null,
  studentId = null,
  status = null,
  search = null,
  page = 1,
  limit = 20
}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const where = [];
  const params = [];

  if (organizationId) {
    where.push('c.organization_id = ?');
    params.push(organizationId);
  }
  if (examId) {
    where.push('c.exam_id = ?');
    params.push(examId);
  }
  if (studentId) {
    where.push('c.student_id = ?');
    params.push(studentId);
  }
  if (status && status !== 'ALL') {
    where.push('c.verification_status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(c.certificate_id LIKE ? OR c.student_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM certificates c ${whereClause}`).get(...params);
  const total = countRow?.c || 0;
  const totalPages = Math.ceil(total / safeLimit) || 1;

  const rows = db.prepare(`
    SELECT c.*, o.name as organization_name
    FROM certificates c
    LEFT JOIN organizations o ON o.id = c.organization_id
    ${whereClause}
    ORDER BY c.issued_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);

  return {
    certificates: rows,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages
    }
  };
}

/**
 * Returns verification event log for a certificate.
 */
function getVerificationHistory(certificateId, organizationId = null) {
  const cert = getCertificateById(certificateId, organizationId);
  if (!cert) throw new NotFoundError(`Certificate ${certificateId} not found`);

  return db.prepare(`
    SELECT * FROM certificate_verification_events 
    WHERE certificate_id = ? 
    ORDER BY created_at DESC 
    LIMIT 50
  `).all(certificateId);
}

module.exports = {
  setClearCacheHook,
  issueCertificate,
  verifyCertificate,
  revokeCertificate,
  reissueCertificate,
  getCertificateById,
  listCertificates,
  getVerificationHistory
};
