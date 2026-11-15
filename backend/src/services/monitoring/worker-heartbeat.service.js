// ============================================================================
// ASPIRE DAY 27: WORKER HEARTBEAT & FLEET TELEMETRY SERVICE
// ============================================================================

const os = require('os');
const { db } = require('../../db');
const { getRedisConnection } = require('../../config/redis');
const logger = require('../../utils/logger');

class WorkerHeartbeatService {
  /**
   * Record a single heartbeat pulse into SQLite and optionally Redis.
   */
  recordHeartbeat({ workerName, status = 'ONLINE', pid = process.pid, hostname = os.hostname(), metadata = {} }) {
    if (!workerName) return;

    try {
      const metadataStr = JSON.stringify(metadata || {});
      db.prepare(`
        INSERT INTO worker_heartbeats (worker_name, status, last_heartbeat_at, started_at, pid, hostname, metadata_json)
        VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, ?)
        ON CONFLICT(worker_name) DO UPDATE SET
          status = excluded.status,
          last_heartbeat_at = datetime('now'),
          pid = excluded.pid,
          hostname = excluded.hostname,
          metadata_json = excluded.metadata_json
      `).run(workerName, status, pid, hostname, metadataStr);
    } catch (err) {
      logger.warn({ err: err.message, workerName }, 'Failed recording worker heartbeat to database');
    }

    // Ephemeral Redis heartbeat key with 30s TTL
    try {
      const redis = getRedisConnection('heartbeat');
      if (redis && (redis.status === 'ready' || redis.status === 'connect')) {
        redis.set(`aspire:hb:${workerName}`, JSON.stringify({ status, pid, timestamp: Date.now() }), 'EX', 30).catch(() => {});
      }
    } catch {}
  }

  /**
   * Mark a worker as gracefully stopped.
   */
  recordWorkerStopped(workerName) {
    if (!workerName) return;
    try {
      db.prepare(`
        UPDATE worker_heartbeats
        SET status = 'STOPPED', last_heartbeat_at = datetime('now')
        WHERE worker_name = ?
      `).run(workerName);
    } catch {}
  }

  /**
   * Start a recurring heartbeat pulse for a background worker.
   */
  startHeartbeat({ workerName, intervalMs = 10000, metadata = {} }) {
    // Record initial pulse immediately
    this.recordHeartbeat({ workerName, status: 'ONLINE', metadata });

    const timer = setInterval(() => {
      this.recordHeartbeat({ workerName, status: 'ONLINE', metadata });
    }, intervalMs);

    timer.unref();

    return () => {
      clearInterval(timer);
      this.recordWorkerStopped(workerName);
    };
  }

  /**
   * Retrieve current fleet health summary and identify any dead or stale workers.
   */
  getFleetHealth() {
    try {
      const rows = db.prepare(`
        SELECT worker_name, status, last_heartbeat_at, started_at, pid, hostname, metadata_json,
               CAST((julianday('now') - julianday(last_heartbeat_at)) * 86400 AS INTEGER) as seconds_since_heartbeat
        FROM worker_heartbeats
        ORDER BY worker_name ASC
      `).all();

      const workers = rows.map((w) => {
        let healthState = 'ONLINE';
        if (w.status === 'STOPPED') {
          healthState = 'STOPPED';
        } else if (w.seconds_since_heartbeat > 60) {
          healthState = 'DEAD';
        } else if (w.seconds_since_heartbeat > 30) {
          healthState = 'STALE';
        }

        return {
          name: w.worker_name,
          reportedStatus: w.status,
          healthState,
          lastHeartbeatAt: w.last_heartbeat_at,
          secondsSinceHeartbeat: w.seconds_since_heartbeat,
          pid: w.pid
        };
      });

      const staleOrDead = workers.filter(w => w.healthState === 'DEAD' || w.healthState === 'STALE');

      return {
        totalRegistered: workers.length,
        onlineCount: workers.filter(w => w.healthState === 'ONLINE').length,
        staleOrDeadCount: staleOrDead.length,
        hasIssues: staleOrDead.length > 0,
        workers
      };
    } catch (err) {
      return { totalRegistered: 0, onlineCount: 0, staleOrDeadCount: 0, hasIssues: false, workers: [] };
    }
  }
}

const workerHeartbeatService = new WorkerHeartbeatService();

module.exports = {
  WorkerHeartbeatService,
  workerHeartbeatService
};

