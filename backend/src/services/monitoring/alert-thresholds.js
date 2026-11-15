// ============================================================================
// ASPIRE DAY 27: ALERT SEVERITIES & CONFIGURABLE THRESHOLDS
// ============================================================================

const SEVERITIES = {
  P0: 'P0', // Critical: Platform Down, Data Integrity Breach, Database Loss
  P1: 'P1', // Severe: Worker Outage, High Queue Stagnation, Outbox Frozen
  P2: 'P2', // Degraded: Provider Rate Limit / Outage, Error Rate Spike
  P3: 'P3'  // Warning / Informational: Stale Worker Heartbeat, Auto-Recovery
};

const DEFAULT_THRESHOLDS = {
  failedJobsThreshold: parseInt(process.env.ALERT_FAILED_JOBS_THRESHOLD, 10) || 5,
  queueBacklogThreshold: parseInt(process.env.ALERT_QUEUE_BACKLOG_THRESHOLD, 10) || 25,
  oldestWaitingJobSeconds: parseInt(process.env.ALERT_OLDEST_JOB_SECONDS, 10) || 180,
  outboxBacklogThreshold: parseInt(process.env.ALERT_OUTBOX_BACKLOG_THRESHOLD, 10) || 20,
  outboxOldestPendingSeconds: parseInt(process.env.ALERT_OUTBOX_OLDEST_SECONDS, 10) || 120,
  workerHeartbeatStaleSeconds: parseInt(process.env.ALERT_WORKER_STALE_SECONDS, 10) || 30,
  workerHeartbeatDeadSeconds: parseInt(process.env.ALERT_WORKER_DEAD_SECONDS, 10) || 60,
  api5xxErrorRateThreshold: parseFloat(process.env.ALERT_5XX_RATE_THRESHOLD || '0.05'),
  cooldownMinutes: parseInt(process.env.ALERT_COOLDOWN_MINUTES, 10) || 5
};

module.exports = {
  SEVERITIES,
  DEFAULT_THRESHOLDS
};

