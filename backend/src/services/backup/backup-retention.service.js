const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

class BackupRetentionService {
  constructor() {
    this.dailyDays = parseInt(process.env.BACKUP_RETENTION_DAILY_DAYS || '7', 10);
    this.weeklyWeeks = parseInt(process.env.BACKUP_RETENTION_WEEKLY_WEEKS || '4', 10);
    this.monthlyMonths = parseInt(process.env.BACKUP_RETENTION_MONTHLY_MONTHS || '6', 10);
  }

  /**
   * Determine whether a backup should be retained under GFS policy.
   * @param {Date} backupDate 
   * @param {Date} now 
   * @param {{isWeeklyCandidate: boolean, isMonthlyCandidate: boolean}} categorization 
   * @returns {{retain: boolean, reason: string}}
   */
  evaluateRetention(backupDate, now, categorization) {
    const ageMs = now.getTime() - backupDate.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    // Rule 1: Within Daily Retention Window
    if (ageDays <= this.dailyDays) {
      return { retain: true, reason: `Within daily retention window (${ageDays.toFixed(1)} <= ${this.dailyDays} days)` };
    }

    // Rule 2: Weekly Retention (if it represents a weekly recovery point, e.g. Sunday)
    const maxWeeklyDays = this.weeklyWeeks * 7;
    if (categorization.isWeeklyCandidate && ageDays <= maxWeeklyDays) {
      return { retain: true, reason: `Preserved weekly point (${ageDays.toFixed(1)} <= ${maxWeeklyDays} days)` };
    }

    // Rule 3: Monthly Retention (e.g. 1st of month)
    const maxMonthlyDays = this.monthlyMonths * 30.5;
    if (categorization.isMonthlyCandidate && ageDays <= maxMonthlyDays) {
      return { retain: true, reason: `Preserved monthly point (${ageDays.toFixed(1)} <= ${maxMonthlyDays.toFixed(0)} days)` };
    }

    return { retain: false, reason: `Exceeded retention thresholds (Age: ${ageDays.toFixed(1)} days)` };
  }

  /**
   * Apply GFS retention policy over a list of backup descriptors.
   * @param {Array<{backupId: string, createdAt: string, directoryPath: string, isValid: boolean}>} backups 
   * @param {object} [options]
   * @param {string} [options.activeRestoreBackupId] Backup ID currently being restored (immune to deletion)
   * @param {boolean} [options.dryRun=false] If true, does not unlink files
   * @returns {Promise<{evaluatedCount: number, retainedCount: number, deletedCount: number, deletedBackups: string[], retainedBackups: string[]}>}
   */
  async applyRetention(backups, options = {}) {
    const now = new Date();
    const dryRun = Boolean(options.dryRun);
    const activeRestoreId = options.activeRestoreBackupId;

    if (!Array.isArray(backups) || backups.length === 0) {
      return { evaluatedCount: 0, retainedCount: 0, deletedCount: 0, deletedBackups: [], retainedBackups: [] };
    }

    // Sort backups ascending by date (oldest first)
    const sorted = [...backups].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Filter valid candidates
    const validBackups = sorted.filter(b => b.isValid !== false);

    // CRITICAL SAFETY RULE 1: Never delete if there is only 1 valid backup left
    if (validBackups.length <= 1) {
      logger.info({ validCount: validBackups.length }, 'Only 1 or fewer valid backups exist. Retaining all backups.');
      return {
        evaluatedCount: sorted.length,
        retainedCount: sorted.length,
        deletedCount: 0,
        deletedBackups: [],
        retainedBackups: sorted.map(b => b.backupId)
      };
    }

    const retained = [];
    const deleted = [];

    // Identify weekly candidates (e.g., first backup of each Sunday or calendar week)
    // and monthly candidates (first backup of each month)
    const weeklyBuckets = new Set();
    const monthlyBuckets = new Set();

    // Map candidates from newest to oldest for bucket selection
    for (let i = sorted.length - 1; i >= 0; i--) {
      const b = sorted[i];
      const d = new Date(b.createdAt);
      const weekKey = `${d.getUTCFullYear()}-W${Math.floor(d.getUTCDate() / 7)}`;
      const monthKey = `${d.getUTCFullYear()}-M${d.getUTCMonth() + 1}`;

      b._isWeeklyCandidate = false;
      b._isMonthlyCandidate = false;

      if (!weeklyBuckets.has(weekKey)) {
        weeklyBuckets.add(weekKey);
        b._isWeeklyCandidate = true;
      }

      if (!monthlyBuckets.has(monthKey)) {
        monthlyBuckets.add(monthKey);
        b._isMonthlyCandidate = true;
      }
    }

    for (const backup of sorted) {
      // CRITICAL SAFETY RULE 2: Never delete an active restore backup
      if (activeRestoreId && backup.backupId === activeRestoreId) {
        retained.push(backup.backupId);
        continue;
      }

      const backupDate = new Date(backup.createdAt);
      const decision = this.evaluateRetention(backupDate, now, {
        isWeeklyCandidate: backup._isWeeklyCandidate,
        isMonthlyCandidate: backup._isMonthlyCandidate
      });

      if (decision.retain) {
        retained.push(backup.backupId);
      } else {
        // Double check safety: do not prune if this would drop below 1 valid backup
        const remainingValid = sorted.filter(s => !deleted.includes(s.backupId) && s.isValid !== false);
        if (remainingValid.length <= 1) {
          retained.push(backup.backupId);
          continue;
        }

        deleted.push(backup.backupId);

        if (!dryRun && backup.directoryPath && fs.existsSync(backup.directoryPath)) {
          try {
            fs.rmSync(backup.directoryPath, { recursive: true, force: true });
            logger.info({ backupId: backup.backupId, reason: decision.reason }, 'Pruned expired backup');
          } catch (err) {
            logger.warn({ backupId: backup.backupId, err: err.message }, 'Failed to delete expired backup directory');
          }
        }
      }
    }

    return {
      evaluatedCount: sorted.length,
      retainedCount: retained.length,
      deletedCount: deleted.length,
      deletedBackups: deleted,
      retainedBackups: retained
    };
  }
}

module.exports = new BackupRetentionService();

