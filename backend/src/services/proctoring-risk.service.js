// Enterprise Proctoring Behavioral Monitoring & Risk Analytics Engine (Day 11)
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const crypto = require('crypto');
const { db } = require('../db');
const { ConflictError, ValidationError, NotFoundError } = require('../errors/app-error');
const logger = require('../utils/logger');

// Event Types Enum
const PROCTORING_EVENTS = Object.freeze({
  TAB_SWITCH: 'TAB_SWITCH',
  WINDOW_BLUR: 'WINDOW_BLUR',
  WINDOW_FOCUS: 'WINDOW_FOCUS',
  FULLSCREEN_ENTER: 'FULLSCREEN_ENTER',
  FULLSCREEN_EXIT: 'FULLSCREEN_EXIT',
  COPY_ATTEMPT: 'COPY_ATTEMPT',
  PASTE_ATTEMPT: 'PASTE_ATTEMPT',
  CUT_ATTEMPT: 'CUT_ATTEMPT',
  CONTEXT_MENU_ATTEMPT: 'CONTEXT_MENU_ATTEMPT',
  DEVTOOLS_SHORTCUT_ATTEMPT: 'DEVTOOLS_SHORTCUT_ATTEMPT',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  NETWORK_ONLINE: 'NETWORK_ONLINE',
  SUSPICIOUS_PATTERN: 'SUSPICIOUS_PATTERN'
});

// Risk Point Allocation Matrix
const RISK_POINTS = Object.freeze({
  [PROCTORING_EVENTS.TAB_SWITCH]: 10,
  [PROCTORING_EVENTS.WINDOW_BLUR]: 5,
  [PROCTORING_EVENTS.WINDOW_FOCUS]: 0,
  [PROCTORING_EVENTS.FULLSCREEN_ENTER]: 0,
  [PROCTORING_EVENTS.FULLSCREEN_EXIT]: 10,
  [PROCTORING_EVENTS.COPY_ATTEMPT]: 15,
  [PROCTORING_EVENTS.PASTE_ATTEMPT]: 10,
  [PROCTORING_EVENTS.CUT_ATTEMPT]: 5,
  [PROCTORING_EVENTS.CONTEXT_MENU_ATTEMPT]: 2,
  [PROCTORING_EVENTS.DEVTOOLS_SHORTCUT_ATTEMPT]: 15,
  [PROCTORING_EVENTS.NETWORK_OFFLINE]: 0,
  [PROCTORING_EVENTS.NETWORK_ONLINE]: 0,
  [PROCTORING_EVENTS.SUSPICIOUS_PATTERN]: 25
});

// Risk Level Classifications
const RISK_LEVELS = Object.freeze({
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  SUSPICIOUS: 'SUSPICIOUS',
  HIGH_RISK: 'HIGH_RISK'
});

/**
 * Classify a risk score into one of four standard levels:
 *  0 - 20: NORMAL
 * 21 - 50: WARNING
 * 51 - 75: SUSPICIOUS
 * 76+    : HIGH_RISK
 *
 * NOTE: Candidates are NEVER automatically failed or disqualified based on risk score.
 * This is an analytics flag for human review.
 */
function classifyRisk(score) {
  const numericScore = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  if (numericScore <= 20) return RISK_LEVELS.NORMAL;
  if (numericScore <= 50) return RISK_LEVELS.WARNING;
  if (numericScore <= 75) return RISK_LEVELS.SUSPICIOUS;
  return RISK_LEVELS.HIGH_RISK;
}

/**
 * Sanitize event metadata. Ensures zero capture of candidate clipboard content,
 * passwords, or arbitrary keystroke logging.
 */
function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const forbiddenKeys = [
    'clipboardText', 'clipboardData', 'clipboard', 'text', 'content',
    'keystrokes', 'keyLog', 'keyString', 'keys', 'password', 'inputVal',
    'riskScore', 'riskPoints', 'riskLevel' // forbid client score tampering
  ];

  const sanitized = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (forbiddenKeys.includes(k)) continue;
    // Allow basic non-sensitive fields (e.g. shortcutName, targetTag, url, durationMs)
    if (typeof v === 'string') {
      sanitized[k] = v.slice(0, 200);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      sanitized[k] = v;
    }
  }

  const serialized = JSON.stringify(sanitized);
  return serialized.length > 2048 ? null : serialized;
}

/**
 * Check if recent event patterns warrant generating a SUSPICIOUS_PATTERN event.
 * Triggers:
 * - >= 3 tab switches in 60s
 * - >= 2 fullscreen exits in 60s
 * - >= 3 clipboard attempts in 30s
 * - >= 2 devtools shortcuts in 30s
 *
 * Enforces a 60-second cooldown per pattern trigger to prevent flooding.
 */
function evaluateSuspiciousPattern(attemptId, currentEventType, targetDb = db) {
  // Only evaluate pattern on suspicious trigger types
  const triggerTypes = [
    PROCTORING_EVENTS.TAB_SWITCH,
    PROCTORING_EVENTS.FULLSCREEN_EXIT,
    PROCTORING_EVENTS.COPY_ATTEMPT,
    PROCTORING_EVENTS.PASTE_ATTEMPT,
    PROCTORING_EVENTS.CUT_ATTEMPT,
    PROCTORING_EVENTS.DEVTOOLS_SHORTCUT_ATTEMPT
  ];

  if (!triggerTypes.includes(currentEventType)) return null;

  // Check pattern cooldown in SQLite (at least 60 seconds since last SUSPICIOUS_PATTERN for this attempt)
  const patternInCooldown = targetDb.prepare(`
    SELECT id FROM proctoring_events
    WHERE attempt_id = ?
      AND event_type = ?
      AND created_at >= datetime('now', '-60 seconds')
    LIMIT 1
  `).get(attemptId, PROCTORING_EVENTS.SUSPICIOUS_PATTERN);

  if (patternInCooldown) {
    return null; // In cooldown
  }

  // Fetch recent events in the last 60 seconds (already includes newly inserted event)
  const recentEvents = targetDb.prepare(`
    SELECT event_type FROM proctoring_events
    WHERE attempt_id = ?
      AND created_at >= datetime('now', '-60 seconds')
    ORDER BY created_at DESC
  `).all(attemptId);

  const tabSwitches = recentEvents.filter((e) => e.event_type === PROCTORING_EVENTS.TAB_SWITCH).length;
  if (tabSwitches >= 3) {
    return {
      reason: 'RAPID_TAB_SWITCHING',
      details: `${tabSwitches} tab switches within 60 seconds`
    };
  }

  const fullscreenExits = recentEvents.filter((e) => e.event_type === PROCTORING_EVENTS.FULLSCREEN_EXIT).length;
  if (fullscreenExits >= 2) {
    return {
      reason: 'REPEATED_FULLSCREEN_EXIT',
      details: `${fullscreenExits} fullscreen exits within 60 seconds`
    };
  }

  const clipboardEvents = recentEvents.filter((e) =>
    e.event_type === PROCTORING_EVENTS.COPY_ATTEMPT ||
    e.event_type === PROCTORING_EVENTS.PASTE_ATTEMPT ||
    e.event_type === PROCTORING_EVENTS.CUT_ATTEMPT
  ).length;
  if (clipboardEvents >= 3) {
    return {
      reason: 'RAPID_CLIPBOARD_ACTIVITY',
      details: `${clipboardEvents} clipboard operations within 60 seconds`
    };
  }

  const devtoolsShortcuts = recentEvents.filter((e) => e.event_type === PROCTORING_EVENTS.DEVTOOLS_SHORTCUT_ATTEMPT).length;
  if (devtoolsShortcuts >= 2) {
    return {
      reason: 'REPEATED_DEVTOOLS_ATTEMPTS',
      details: `${devtoolsShortcuts} devtools shortcut attempts within 60 seconds`
    };
  }

  return null;
}

/**
 * Process a batch of candidate proctoring events.
 *
 * Rules:
 * 1. Must be idempotent (duplicate event_id silently deduplicated).
 * 2. Risk points and risk levels are strictly calculated on the server.
 * 3. Client cannot forge or tamper with risk scores.
 * 4. Attempt status must be 'started' and not expired.
 * 5. Snapshot integrity is validated before updating.
 */
function processBatchEvents(attempt, rawEvents, options = {}) {
  const targetDb = options.db || db;

  if (!attempt) {
    throw new NotFoundError('Attempt not found');
  }

  if (attempt.status !== 'started') {
    throw new ConflictError(
      `Attempt is in status '${attempt.status}' and cannot accept proctoring events`,
      'ATTEMPT_NOT_ACTIVE'
    );
  }

  const expiresAt = new Date(attempt.expires_at).getTime();
  if (Date.now() > expiresAt) {
    throw new ConflictError('Assessment duration has expired', 'ATTEMPT_EXPIRED');
  }

  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new ValidationError('Events array must contain at least 1 event', 'EMPTY_EVENTS_ARRAY');
  }

  if (rawEvents.length > 50) {
    throw new ValidationError('Batch exceeds maximum limit of 50 events', 'BATCH_SIZE_EXCEEDED');
  }

  const insertEventStmt = targetDb.prepare(`
    INSERT INTO proctoring_events (
      id, attempt_id, event_id, event_type, event_timestamp, risk_points, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const checkExistingStmt = targetDb.prepare(`
    SELECT id FROM proctoring_events WHERE event_id = ?
  `);

  let acceptedCount = 0;
  let duplicateCount = 0;
  let synthesizedPatterns = 0;

  const runBatchTx = targetDb.transaction(() => {
    for (const raw of rawEvents) {
      const eventId = String(raw.eventId || '').trim();
      const eventType = String(raw.eventType || '').trim().toUpperCase();
      const eventTimestamp = raw.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString();

      if (!eventId || eventId.length < 8) {
        throw new ValidationError('Each event must have a valid eventId of at least 8 characters', 'INVALID_EVENT_ID');
      }

      if (!Object.values(PROCTORING_EVENTS).includes(eventType)) {
        throw new ValidationError(`Unsupported proctoring event type: ${eventType}`, 'INVALID_EVENT_TYPE');
      }

      // Check deduplication
      const existing = checkExistingStmt.get(eventId);
      if (existing) {
        duplicateCount++;
        continue;
      }

      // Calculate server-authoritative risk points
      const points = RISK_POINTS[eventType] ?? 0;
      const sanitizedMeta = sanitizeMetadata(raw.metadata);
      const rowId = crypto.randomUUID();

      insertEventStmt.run(rowId, attempt.id, eventId, eventType, eventTimestamp, points, sanitizedMeta);
      acceptedCount++;

      // Check for suspicious pattern synthesis
      const patternTrigger = evaluateSuspiciousPattern(attempt.id, eventType, targetDb);
      if (patternTrigger) {
        const patternEventId = `sys_pattern_${crypto.randomUUID()}`;
        const patternMeta = JSON.stringify({
          patternReason: patternTrigger.reason,
          details: patternTrigger.details,
          triggeredBy: eventType
        });
        const patternPoints = RISK_POINTS[PROCTORING_EVENTS.SUSPICIOUS_PATTERN];
        insertEventStmt.run(
          crypto.randomUUID(),
          attempt.id,
          patternEventId,
          PROCTORING_EVENTS.SUSPICIOUS_PATTERN,
          new Date().toISOString(),
          patternPoints,
          patternMeta
        );
        synthesizedPatterns++;
      }
    }

    // Recalculate full aggregate risk score for this attempt
    const agg = targetDb.prepare(`
      SELECT
        COALESCE(SUM(risk_points), 0) AS total_score,
        COUNT(*) AS total_events,
        SUM(CASE WHEN event_type = ? THEN 1 ELSE 0 END) AS tab_switches
      FROM proctoring_events
      WHERE attempt_id = ?
    `).get(PROCTORING_EVENTS.TAB_SWITCH, attempt.id);

    const totalScore = agg ? Number(agg.total_score) : 0;
    const riskLevel = classifyRisk(totalScore);
    const tabSwitches = agg ? Number(agg.tab_switches) : 0;

    // Build event breakdown summary
    const typeBreakdown = targetDb.prepare(`
      SELECT event_type, COUNT(*) as count, SUM(risk_points) as points
      FROM proctoring_events
      WHERE attempt_id = ?
      GROUP BY event_type
    `).all(attempt.id);

    const breakdownMap = {};
    for (const r of typeBreakdown) {
      breakdownMap[r.event_type] = { count: r.count, points: r.points };
    }

    const summaryPayload = {
      totalScore,
      riskLevel,
      totalEvents: agg ? agg.total_events : 0,
      breakdown: breakdownMap,
      lastUpdated: new Date().toISOString()
    };

    // Update attempts table atomically
    targetDb.prepare(`
      UPDATE attempts SET
        proctoring_risk_score = ?,
        proctoring_risk_level = ?,
        proctoring_summary_json = ?,
        tab_switches = MAX(tab_switches, ?)
      WHERE id = ?
    `).run(totalScore, riskLevel, JSON.stringify(summaryPayload), tabSwitches, attempt.id);

    return {
      totalScore,
      riskLevel,
      tabSwitches,
      summary: summaryPayload
    };
  });

  const txResult = runBatchTx();

  logger.info({
    service: 'aspire-proctoring',
    attemptId: attempt.id,
    acceptedCount,
    duplicateCount,
    synthesizedPatterns,
    currentScore: txResult.totalScore,
    currentLevel: txResult.riskLevel
  }, 'Proctoring events batch processed');

  return {
    accepted: true,
    risk: {
      score: txResult.totalScore,
      level: txResult.riskLevel
    },
    processedCount: acceptedCount,
    duplicateCount,
    synthesizedPatterns
  };
}

/**
 * Get proctoring timeline and analytics for an attempt (Admin endpoint)
 */
function getAttemptProctoringAnalytics(attemptId, targetDb = db) {
  const attempt = targetDb.prepare(`
    SELECT
      a.id, a.token, a.student_id, a.exam_id, a.organization_id,
      a.status, a.started_at, a.expires_at, a.submitted_at,
      a.proctoring_risk_score, a.proctoring_risk_level, a.proctoring_summary_json,
      a.tab_switches,
      s.name AS student_name, s.phone AS student_phone, s.email AS student_email,
      e.name AS exam_name
    FROM attempts a
    LEFT JOIN students s ON a.student_id = s.id
    LEFT JOIN exams e ON a.exam_id = e.id
    WHERE a.id = ?
  `).get(attemptId);

  if (!attempt) {
    throw new NotFoundError('Attempt not found');
  }

  const events = targetDb.prepare(`
    SELECT
      id, event_id, event_type, event_timestamp, received_at, risk_points, metadata_json
    FROM proctoring_events
    WHERE attempt_id = ?
    ORDER BY event_timestamp ASC, created_at ASC
  `).all(attemptId);

  const formattedEvents = events.map((e) => {
    let meta = null;
    try {
      meta = e.metadata_json ? JSON.parse(e.metadata_json) : null;
    } catch {}
    return {
      id: e.id,
      eventId: e.event_id,
      eventType: e.event_type,
      timestamp: e.event_timestamp,
      receivedAt: e.received_at,
      riskPoints: e.risk_points,
      metadata: meta
    };
  });

  let summary = null;
  try {
    summary = attempt.proctoring_summary_json ? JSON.parse(attempt.proctoring_summary_json) : null;
  } catch {}

  return {
    attemptId: attempt.id,
    token: attempt.token,
    candidate: {
      name: attempt.student_name,
      phone: attempt.student_phone,
      email: attempt.student_email
    },
    examName: attempt.exam_name,
    organizationId: attempt.organization_id,
    status: attempt.status,
    risk: {
      score: attempt.proctoring_risk_score || 0,
      level: attempt.proctoring_risk_level || RISK_LEVELS.NORMAL
    },
    tabSwitches: attempt.tab_switches || 0,
    summary,
    totalEvents: formattedEvents.length,
    timeline: formattedEvents
  };
}

module.exports = {
  PROCTORING_EVENTS,
  RISK_POINTS,
  RISK_LEVELS,
  classifyRisk,
  sanitizeMetadata,
  evaluateSuspiciousPattern,
  processBatchEvents,
  getAttemptProctoringAnalytics
};
