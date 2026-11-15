const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

class BackupSchedulerService {
  constructor() {
    this.lockFilePath = path.resolve(process.env.BACKUP_LOCK_FILE || './data/backups/.backup.lock');
    this.lockMaxAgeMs = 30 * 60 * 1000; // 30 minutes stale threshold
    this.lastRun = null;
    this.lastResult = null;
    this.lastError = null;
  }

  /**
   * Attempt to acquire an exclusive lock for backup generation.
   * Throws if another backup is actively running.
   */
  acquireLock() {
    fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true });

    if (fs.existsSync(this.lockFilePath)) {
      try {
        const stat = fs.statSync(this.lockFilePath);
        const ageMs = Date.now() - stat.mtimeMs;

        if (ageMs > this.lockMaxAgeMs) {
          logger.warn({ lockAgeMs: ageMs }, 'Removing stale backup lock file');
          fs.unlinkSync(this.lockFilePath);
        } else {
          const content = fs.readFileSync(this.lockFilePath, 'utf8');
          throw new Error(`Another backup operation is currently in progress (Locked at: ${content})`);
        }
      } catch (err) {
        if (err.message.includes('Another backup operation')) throw err;
      }
    }

    const lockData = JSON.stringify({
      pid: process.pid,
      lockedAt: new Date().toISOString()
    });

    fs.writeFileSync(this.lockFilePath, lockData, { flag: 'wx' });
    return true;
  }

  /**
   * Release the exclusive backup lock.
   */
  releaseLock() {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to release backup lock file');
    }
  }

  /**
   * Execute an operation under the exclusive backup lock.
   * @param {Function} taskFn 
   */
  async withLock(taskFn) {
    this.acquireLock();
    const startTime = Date.now();
    try {
      this.lastRun = new Date().toISOString();
      const result = await taskFn();
      this.lastResult = {
        success: true,
        durationMs: Date.now() - startTime,
        completedAt: new Date().toISOString()
      };
      this.lastError = null;
      return result;
    } catch (err) {
      this.lastError = {
        message: err.message,
        failedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime
      };
      throw err;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Get scheduler health & telemetry status.
   */
  getStatus() {
    const isLocked = fs.existsSync(this.lockFilePath);
    return {
      isLocked,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }
}

module.exports = new BackupSchedulerService();

