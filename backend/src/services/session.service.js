// Server-side session tracking and immediate token revocation service.
const { db } = require('../db');
const { generateSessionId, hashToken } = require('../security/jwt');

function createSession({ userId, ipAddress = null, userAgent = null, expiresAt }) {
  const sessionId = generateSessionId();
  const tokenHash = hashToken(sessionId);

  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, userId, tokenHash, expiresAt, ipAddress, userAgent);

  return sessionId;
}

function findSession(sessionId) {
  if (!sessionId) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  // Check expiration
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    deleteSession(sessionId);
    return null;
  }

  return session;
}

function touchSession(sessionId) {
  if (!sessionId) return;
  db.prepare(`UPDATE sessions SET last_used_at = datetime('now') WHERE id = ?`).run(sessionId);
}

function deleteSession(sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function deleteAllUserSessions(userId) {
  if (!userId) return;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function cleanupExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')").run();
}

module.exports = {
  createSession,
  findSession,
  touchSession,
  deleteSession,
  deleteAllUserSessions,
  cleanupExpiredSessions
};
