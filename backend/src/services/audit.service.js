// Audit logging service.
// Records security-relevant events to Pino structured logs and the SQLite audit_logs table.
const { db } = require('../db');
const logger = require('../utils/logger');

function recordAuditEvent({
  req = null,
  requestId = null,
  userId = null,
  organizationId = null,
  event,
  details = null,
  ipAddress = null
}) {
  const reqId = requestId || (req && (req.id || req.headers?.['x-request-id'])) || null;
  const ip = ipAddress || (req && (req.ip || req.connection?.remoteAddress)) || null;
  const uid = userId !== undefined && userId !== null ? userId : (req && req.user ? req.user.id : null);
  const orgId = organizationId !== undefined && organizationId !== null ? organizationId : (req && req.user ? req.user.organization_id : null);

  // 1. Structured Pino log
  const logData = {
    service: 'aspire-api',
    securityEvent: event,
    requestId: reqId || undefined,
    userId: uid || undefined,
    organizationId: orgId || undefined,
    ip: ip || undefined,
    details: details || undefined
  };

  if (event.includes('denied') || event.includes('failure') || event.includes('invalid')) {
    logger.warn(logData, `[SECURITY AUDIT] ${event}`);
  } else {
    logger.info(logData, `[SECURITY AUDIT] ${event}`);
  }

  // 2. Persistent SQLite audit log
  try {
    db.prepare(`
      INSERT INTO audit_logs (request_id, user_id, organization_id, event, details_json, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      reqId,
      uid,
      orgId,
      event,
      details ? JSON.stringify(details) : null,
      ip
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to persist audit log to database');
  }
}

module.exports = { recordAuditEvent };
