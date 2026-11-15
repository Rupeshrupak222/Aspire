// ============================================================================
// ASPIRE DAY 27: CENTRALIZED ALERT SERVICE WITH DEDUPLICATION & RECOVERY
// ============================================================================

const { db } = require('../../db');
const logger = require('../../utils/logger');
const { SEVERITIES, DEFAULT_THRESHOLDS } = require('./alert-thresholds');
const DiscordAlertProvider = require('./providers/discord.provider');
const TelegramAlertProvider = require('./providers/telegram.provider');
const MockAlertProvider = require('./providers/mock.provider');

class AlertService {
  constructor(options = {}) {
    this.environment = process.env.NODE_ENV || 'development';
    this.cooldownMinutes = options.cooldownMinutes || DEFAULT_THRESHOLDS.cooldownMinutes;
    this.providers = [];
    this.mockProvider = new MockAlertProvider();

    // Register active channels
    if (options.useMock || process.env.NODE_ENV === 'test') {
      this.providers.push(this.mockProvider);
    }

    if (process.env.DISCORD_WEBHOOK_URL) {
      this.providers.push(new DiscordAlertProvider(process.env.DISCORD_WEBHOOK_URL));
    }

    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      this.providers.push(new TelegramAlertProvider(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID));
    }
  }

  /**
   * Register an alert provider instance.
   */
  registerProvider(provider) {
    this.providers.push(provider);
  }

  /**
   * Clear all registered providers.
   */
  clearProviders() {
    this.providers = [];
  }

  /**
   * Trigger an alert with deduplication and cooldown controls.
   *
   * @param {Object} alertSpec
   * @returns {Promise<{ triggered: boolean, suppressed: boolean, incidentId: number }>}
   */
  async triggerAlert({
    dedupKey,
    severity = SEVERITIES.P2,
    service = 'aspire-backend',
    title,
    message,
    correlationId,
    recommendedAction,
    details = {}
  }) {
    if (!dedupKey || !title || !message) {
      return { triggered: false, reason: 'INVALID_ALERT_SPEC' };
    }

    const safeTitle = String(title).slice(0, 200);
    const safeMessage = String(message).slice(0, 1000);
    const safeDetails = logger.sanitizePayload(details);
    const safeCorrelationId = correlationId ? String(correlationId).slice(0, 64) : null;
    const nowIso = new Date().toISOString();

    let incident = null;
    let shouldNotify = false;
    let isNewIncident = false;
    let triggerCount = 1;

    try {
      incident = db.prepare('SELECT * FROM alert_incidents WHERE dedup_key = ?').get(dedupKey);
    } catch {}

    if (incident && incident.status === 'TRIGGERED') {
      // Check if cooldown has expired
      const lastNotifiedTime = new Date(incident.last_notified_at + 'Z').getTime();
      const cooldownMs = this.cooldownMinutes * 60 * 1000;
      const timeSinceNotified = Date.now() - lastNotifiedTime;

      triggerCount = incident.trigger_count + 1;

      if (timeSinceNotified > cooldownMs) {
        shouldNotify = true;
        try {
          db.prepare(`
            UPDATE alert_incidents
            SET trigger_count = ?, last_triggered_at = datetime('now'), last_notified_at = datetime('now'),
                message = ?, details_json = ?
            WHERE id = ?
          `).run(triggerCount, safeMessage, JSON.stringify(safeDetails), incident.id);
        } catch {}
      } else {
        // Suppress duplicate storm; update count only
        try {
          db.prepare(`
            UPDATE alert_incidents
            SET trigger_count = ?, last_triggered_at = datetime('now')
            WHERE id = ?
          `).run(triggerCount, incident.id);
        } catch {}
      }
    } else {
      // Insert new or reactivated incident
      isNewIncident = true;
      shouldNotify = true;
      try {
        const stmt = db.prepare(`
          INSERT INTO alert_incidents (
            dedup_key, severity, service, title, message, status, trigger_count,
            last_triggered_at, last_notified_at, details_json
          ) VALUES (?, ?, ?, ?, ?, 'TRIGGERED', 1, datetime('now'), datetime('now'), ?)
          ON CONFLICT(dedup_key) DO UPDATE SET
            severity = excluded.severity,
            title = excluded.title,
            message = excluded.message,
            status = 'TRIGGERED',
            trigger_count = 1,
            last_triggered_at = datetime('now'),
            resolved_at = NULL,
            last_notified_at = datetime('now'),
            details_json = excluded.details_json
        `);
        const info = stmt.run(dedupKey, severity, service, safeTitle, safeMessage, JSON.stringify(safeDetails));
        incident = { id: info.lastInsertRowid };
      } catch (err) {
        logger.error({ err: err.message, dedupKey }, 'Failed to persist alert incident');
      }
    }

    if (shouldNotify) {
      const alertPayload = {
        dedupKey,
        severity,
        service,
        title: isNewIncident ? safeTitle : `${safeTitle} (Triggered ${triggerCount}x)`,
        message: safeMessage,
        correlationId: safeCorrelationId,
        recommendedAction,
        environment: this.environment,
        timestamp: nowIso,
        dashboardUrl: process.env.OPERATIONS_DASHBOARD_URL || null,
        isRecovery: false,
        details: safeDetails
      };

      logger.warn({ alert: alertPayload }, `[ALERT TRIGGERED] [${severity}] ${safeTitle}`);

      // Dispatch to all configured providers concurrently
      await Promise.allSettled(this.providers.map(p => p.sendAlert(alertPayload)));

      return { triggered: true, suppressed: false, incidentId: incident?.id, triggerCount };
    }

    return { triggered: false, suppressed: true, incidentId: incident?.id, triggerCount };
  }

  /**
   * Mark an active incident as resolved and send an auto-recovery notification.
   */
  async resolveAlert({ dedupKey, resolutionMessage, service = 'aspire-backend' }) {
    if (!dedupKey) return { resolved: false };

    let incident = null;
    try {
      incident = db.prepare('SELECT * FROM alert_incidents WHERE dedup_key = ?').get(dedupKey);
    } catch {}

    if (!incident || incident.status !== 'TRIGGERED') {
      return { resolved: false, reason: 'NOT_ACTIVE' };
    }

    const message = resolutionMessage || `Incident has cleared and service ${service} has returned to normal operational health.`;
    const nowIso = new Date().toISOString();

    try {
      db.prepare(`
        UPDATE alert_incidents
        SET status = 'RESOLVED', resolved_at = datetime('now')
        WHERE id = ?
      `).run(incident.id);
    } catch (err) {
      logger.error({ err: err.message, dedupKey }, 'Failed updating incident resolution in database');
    }

    const recoveryPayload = {
      dedupKey,
      severity: incident.severity,
      service,
      title: `Resolved: ${incident.title}`,
      message,
      environment: this.environment,
      timestamp: nowIso,
      isRecovery: true
    };

    logger.info({ alert: recoveryPayload }, `[ALERT RESOLVED] ${incident.title}`);

    await Promise.allSettled(this.providers.map(p => p.sendAlert(recoveryPayload)));

    return { resolved: true, incidentId: incident.id };
  }

  /**
   * Retrieve all currently active (unresolved) incidents.
   */
  getActiveIncidents() {
    try {
      return db.prepare(`
        SELECT id, dedup_key, severity, service, title, message, status, trigger_count,
               last_triggered_at, last_notified_at, details_json, created_at
        FROM alert_incidents
        WHERE status = 'TRIGGERED'
        ORDER BY last_triggered_at DESC
      `).all();
    } catch {
      return [];
    }
  }

  /**
   * Retrieve recent incident history.
   */
  getIncidentHistory(limit = 50) {
    try {
      return db.prepare(`
        SELECT id, dedup_key, severity, service, title, message, status, trigger_count,
               last_triggered_at, resolved_at, last_notified_at, created_at
        FROM alert_incidents
        ORDER BY last_triggered_at DESC
        LIMIT ?
      `).all(limit);
    } catch {
      return [];
    }
  }
}

const alertService = new AlertService();

module.exports = {
  AlertService,
  alertService
};

