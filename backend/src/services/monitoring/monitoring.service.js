// ============================================================================
// ASPIRE DAY 27: COMPREHENSIVE MONITORING & TELEMETRY ENGINE
// ============================================================================

const { healthService } = require('./health.service');
const { workerHeartbeatService } = require('./worker-heartbeat.service');
const { alertService } = require('./alert.service');
const { SEVERITIES, DEFAULT_THRESHOLDS } = require('./alert-thresholds');
const { codeExecutionQueue } = require('../../queues/code-execution.queue');
const { notificationQueue } = require('../../queues/notification.queue');
const metrics = require('../../utils/metrics');
const logger = require('../../utils/logger');

class MonitoringService {
  constructor(thresholds = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.checkTimer = null;
  }

  /**
   * Run automated telemetry check across queues, workers, and infrastructure.
   */
  async runTelemetryCheck() {
    const detailed = await healthService.getDetailedHealth();
    const alertsTriggered = [];

    // 1. Evaluate SQLite Health
    if (detailed.subsystems.database.status !== 'UP') {
      await alertService.triggerAlert({
        dedupKey: 'incident_database_down',
        severity: SEVERITIES.P0,
        service: 'sqlite-primary',
        title: 'Primary Database Unavailable',
        message: 'SQLite database health check failed or connection was lost.',
        recommendedAction: 'Inspect file permissions on aspire.db, disk space, and WAL lock state immediately.'
      });
      alertsTriggered.push('database_down');
    } else {
      await alertService.resolveAlert({
        dedupKey: 'incident_database_down',
        service: 'sqlite-primary',
        resolutionMessage: 'SQLite database is now online, responsive, and accepting queries.'
      });
    }

    // 2. Evaluate Redis Health
    if (detailed.subsystems.redis.status !== 'UP') {
      await alertService.triggerAlert({
        dedupKey: 'incident_redis_down',
        severity: SEVERITIES.P0,
        service: 'redis-broker',
        title: 'Redis Connection Unavailable',
        message: 'Redis server is unreachable. Background queue workers and BullMQ operations are degraded.',
        recommendedAction: 'Verify Redis container/daemon is running, inspect network ports, and check Redis auth credentials.'
      });
      alertsTriggered.push('redis_down');
    } else {
      await alertService.resolveAlert({
        dedupKey: 'incident_redis_down',
        service: 'redis-broker',
        resolutionMessage: 'Redis connection has been restored successfully.'
      });
    }

    // 3. Evaluate Worker Fleet Health
    const fleet = workerHeartbeatService.getFleetHealth();
    for (const w of fleet.workers) {
      const dedupKey = `incident_worker_${w.name}`;
      if (w.healthState === 'DEAD') {
        await alertService.triggerAlert({
          dedupKey,
          severity: SEVERITIES.P1,
          service: w.name,
          title: `Worker Dead: ${w.name}`,
          message: `Worker ${w.name} has not emitted a heartbeat in ${w.secondsSinceHeartbeat}s (exceeds threshold ${this.thresholds.workerHeartbeatDeadSeconds}s).`,
          recommendedAction: `Inspect process logs for ${w.name}, check memory limits, and restart worker service.`
        });
        alertsTriggered.push(`worker_dead:${w.name}`);
      } else if (w.healthState === 'ONLINE') {
        await alertService.resolveAlert({
          dedupKey,
          service: w.name,
          resolutionMessage: `Worker ${w.name} is back online and reporting valid heartbeats.`
        });
      }
    }

    // 4. Evaluate Queues (Code Execution & Notifications)
    const codeQueue = detailed.subsystems.queues.codeExecution;
    if (codeQueue.failed >= this.thresholds.failedJobsThreshold) {
      await alertService.triggerAlert({
        dedupKey: 'incident_code_queue_failed_jobs',
        severity: SEVERITIES.P1,
        service: 'bullmq-code-execution',
        title: 'Code Execution Failed Jobs Exceed Threshold',
        message: `Queue has ${codeQueue.failed} failed jobs (threshold: ${this.thresholds.failedJobsThreshold}).`,
        recommendedAction: 'Check code execution provider configuration and worker error logs.'
      });
      alertsTriggered.push('code_queue_failed');
    }

    if (codeQueue.waiting >= this.thresholds.queueBacklogThreshold) {
      await alertService.triggerAlert({
        dedupKey: 'incident_code_queue_backlog',
        severity: SEVERITIES.P1,
        service: 'bullmq-code-execution',
        title: 'High Code Execution Queue Backlog',
        message: `Queue has ${codeQueue.waiting} waiting jobs (threshold: ${this.thresholds.queueBacklogThreshold}).`,
        recommendedAction: 'Scale code worker concurrency or inspect worker processing latency.'
      });
      alertsTriggered.push('code_queue_backlog');
    }

    // 5. Evaluate Transactional Outbox Backlog
    const outbox = detailed.subsystems.outbox;
    if (outbox.pending >= this.thresholds.outboxBacklogThreshold || outbox.oldestPendingSeconds >= this.thresholds.outboxOldestPendingSeconds) {
      await alertService.triggerAlert({
        dedupKey: 'incident_outbox_backlog',
        severity: SEVERITIES.P1,
        service: 'transactional-outbox',
        title: 'Transactional Outbox Backlog Warning',
        message: `Outbox has ${outbox.pending} pending events; oldest is ${outbox.oldestPendingSeconds}s old.`,
        recommendedAction: 'Ensure outbox dispatcher loop is running and Redis connection is healthy.'
      });
      alertsTriggered.push('outbox_backlog');
    } else {
      await alertService.resolveAlert({
        dedupKey: 'incident_outbox_backlog',
        service: 'transactional-outbox',
        resolutionMessage: 'Outbox backlog has drained and is operating within normal parameters.'
      });
    }

    return {
      timestamp: new Date().toISOString(),
      alertsTriggered,
      health: detailed
    };
  }

  /**
   * Start recurring background monitoring loop
   */
  startMonitoringLoop(intervalMs = 30000) {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      this.runTelemetryCheck().catch((err) => {
        logger.warn({ err: err.message }, 'Error in automated telemetry monitor loop');
      });
    }, intervalMs);
    this.checkTimer.unref();
  }

  stopMonitoringLoop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Consolidated Platform Monitoring Snapshot for Admin Operations Dashboard
   */
  async getDashboardSummary() {
    const health = await healthService.getDetailedHealth();
    const systemSnapshot = metrics.getSnapshot();
    const activeIncidents = alertService.getActiveIncidents();
    const incidentHistory = alertService.getIncidentHistory(15);
    const fleet = workerHeartbeatService.getFleetHealth();

    return {
      timestamp: new Date().toISOString(),
      overallStatus: health.status,
      application: {
        uptimeSeconds: systemSnapshot.uptimeSeconds,
        cpuPercent: systemSnapshot.system.cpuPercent,
        memoryMb: systemSnapshot.system.memoryMb,
        eventLoopLagMs: systemSnapshot.system.eventLoopLagMs
      },
      http: systemSnapshot.http,
      database: {
        ...health.subsystems.database,
        stats: systemSnapshot.database
      },
      redis: health.subsystems.redis,
      queues: health.subsystems.queues,
      workers: fleet.workers,
      outbox: health.subsystems.outbox,
      providers: health.subsystems.providers,
      errors: systemSnapshot.errors,
      incidents: {
        active: activeIncidents,
        recent: incidentHistory
      }
    };
  }
}

const monitoringService = new MonitoringService();

module.exports = {
  MonitoringService,
  monitoringService
};

