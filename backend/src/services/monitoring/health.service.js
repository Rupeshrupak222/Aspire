// ============================================================================
// ASPIRE DAY 27: COMPREHENSIVE SERVICE HEALTH & DIAGNOSTICS
// ============================================================================

const { db, checkDbHealth } = require('../../db');
const { testRedisConnection } = require('../../config/redis');
const { codeExecutionQueue } = require('../../queues/code-execution.queue');
const { notificationQueue } = require('../../queues/notification.queue');
const { executionService } = require('../code-execution/execution.service');
const certCrypto = require('../../utils/certificate-crypto');

class HealthService {
  /**
   * Lightweight Liveness Probe (process survival only, zero external I/O)
   */
  getLiveness() {
    return {
      ok: true,
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      pid: process.pid
    };
  }

  /**
   * Readiness Probe (verifies primary database and essential subsystems)
   */
  async getReadiness() {
    const dbStatus = checkDbHealth();
    let redisStatus = { connected: false };
    try {
      redisStatus = await testRedisConnection(1000);
    } catch {
      redisStatus = { connected: false };
    }

    const isReady = dbStatus.healthy;

    return {
      ok: isReady,
      status: isReady ? 'READY' : 'NOT_READY',
      timestamp: new Date().toISOString(),
      dependencies: {
        database: dbStatus.healthy ? 'UP' : 'DOWN',
        redis: redisStatus.connected ? 'UP' : 'DEGRADED'
      }
    };
  }

  /**
   * Full Protected Diagnostic Health Report
   */
  async getDetailedHealth() {
    const timestamp = new Date().toISOString();

    // 1. SQLite Health & Diagnostics
    const dbHealth = checkDbHealth();
    let dbDetails = {
      status: dbHealth.healthy ? 'UP' : 'DOWN',
      journalMode: dbHealth.journalMode || 'UNKNOWN',
      foreignKeys: dbHealth.foreignKeys || false,
      latestMigration: dbHealth.latestMigration || 'none'
    };

    // 2. Redis Diagnostic
    const redisTest = await testRedisConnection(2000);
    const redisDetails = {
      status: redisTest.connected ? 'UP' : 'DOWN',
      error: redisTest.error || null
    };

    // 3. Queue Telemetry
    let codeQueueMetrics = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    let notifQueueMetrics = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

    try {
      codeQueueMetrics = await codeExecutionQueue.getQueueMetrics();
    } catch {}

    try {
      notifQueueMetrics = await notificationQueue.getQueueMetrics();
    } catch {}

    // 4. Worker Heartbeats & Fleet Telemetry
    let workers = [];
    try {
      const rows = db.prepare(`
        SELECT worker_name, status, last_heartbeat_at, started_at, pid, hostname, metadata_json,
               CAST((julianday('now') - julianday(last_heartbeat_at)) * 86400 AS INTEGER) as seconds_since_heartbeat
        FROM worker_heartbeats
        ORDER BY worker_name ASC
      `).all();

      workers = rows.map((w) => {
        let healthState = 'ONLINE';
        if (w.seconds_since_heartbeat > 60) {
          healthState = 'DEAD';
        } else if (w.seconds_since_heartbeat > 30) {
          healthState = 'STALE';
        }

        let metadata = {};
        try { metadata = JSON.parse(w.metadata_json); } catch {}

        return {
          name: w.worker_name,
          reportedStatus: w.status,
          healthState,
          lastHeartbeatAt: w.last_heartbeat_at,
          startedAt: w.started_at,
          secondsSinceHeartbeat: w.seconds_since_heartbeat,
          pid: w.pid,
          hostname: w.hostname,
          metadata
        };
      });
    } catch {}

    // 5. Transactional Outbox Backlog
    let outboxBacklog = { pending: 0, retrying: 0, failed: 0, oldestPendingSeconds: 0 };
    try {
      const row = db.prepare(`
        SELECT 
          SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN attempt_count > 0 AND status = 'PENDING' THEN 1 ELSE 0 END) as retrying,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
          MAX(CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER)) as oldest_age
        FROM outbox_events
        WHERE status IN ('PENDING', 'FAILED')
      `).get();

      if (row) {
        outboxBacklog = {
          pending: row.pending || 0,
          retrying: row.retrying || 0,
          failed: row.failed || 0,
          oldestPendingSeconds: row.oldest_age || 0
        };
      }
    } catch {}

    // 6. Providers Status
    const codeExecStatus = executionService.getStatus();
    const hasResend = !!process.env.RESEND_API_KEY;

    let certStatus = { configured: true, activeKeyId: 'k2026_1' };
    try {
      const activeKey = certCrypto.getActiveKey();
      certStatus.activeKeyId = activeKey.keyId;
    } catch {}

    // Overall platform health evaluation
    const isOverallHealthy = dbHealth.healthy;
    const isDegraded = !redisTest.connected || workers.some(w => w.healthState === 'DEAD');

    return {
      ok: isOverallHealthy,
      status: !isOverallHealthy ? 'DOWN' : (isDegraded ? 'DEGRADED' : 'HEALTHY'),
      timestamp,
      subsystems: {
        database: dbDetails,
        redis: redisDetails,
        queues: {
          codeExecution: codeQueueMetrics,
          notifications: notifQueueMetrics
        },
        workers,
        outbox: outboxBacklog,
        providers: {
          codeExecution: {
            provider: codeExecStatus.provider,
            configured: codeExecStatus.configured
          },
          email: {
            provider: process.env.NOTIFICATION_EMAIL_PROVIDER || 'resend',
            configured: hasResend
          },
          certificates: certStatus
        }
      }
    };
  }
}

const healthService = new HealthService();

module.exports = {
  HealthService,
  healthService
};

