// ============================================================================
// ASPIRE DAY 22: USAGE RECONCILIATION ENGINE
// ============================================================================
// Compares source-of-truth business records, period quota counters,
// event ledgers, daily aggregate rollups, and physical disk storage.
// Provides dry-run analysis and authorized correction execution.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../../db');
const { ValidationError, NotFoundError } = require('../../errors/app-error');
const { recordUsageEvent, rebuildDailyAggregate } = require('./metering.service');
const { getOrganizationSubscription } = require('./subscription.service');
const { resolveResourcePeriod } = require('./quota.service');
const { recordAuditEvent } = require('../audit.service');

/**
 * Calculates physical directory size recursively for tenant storage inspection.
 */
function getDirectoryDiskSize(dirPath) {
  let totalBytes = 0;
  let fileCount = 0;

  if (!fs.existsSync(dirPath)) return { totalBytes: 0, fileCount: 0 };

  function scan(currentDir) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(full);
            totalBytes += stat.size;
            fileCount++;
          } catch {}
        }
      }
    } catch {}
  }

  scan(dirPath);
  return { totalBytes, fileCount };
}

/**
 * Performs reconciliation check on a single organization.
 */
function reconcileOrganization(organizationId, { mode = 'DRY_RUN', actorId = null, req = null } = {}) {
  const org = db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(organizationId);
  if (!org) throw new NotFoundError(`Organization ${organizationId} not found`);

  const sub = getOrganizationSubscription(organizationId);
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, 'exams_monthly');

  const discrepancies = [];
  const corrections = [];

  // -------------------------------------------------------------
  // 1. CANDIDATES RECONCILIATION
  // -------------------------------------------------------------
  const sourceCandidates = db.prepare('SELECT COUNT(DISTINCT id) as c FROM students WHERE organization_id = ?').get(organizationId)?.c || 0;
  const counterCandidatesRow = db.prepare(`
    SELECT used FROM organization_usage_counters
    WHERE organization_id = ? AND resource_key = 'candidates'
    ORDER BY id DESC LIMIT 1
  `).get(organizationId);
  const counterCandidates = counterCandidatesRow?.used ?? 0;

  if (sourceCandidates !== counterCandidates) {
    discrepancies.push({
      resourceKey: 'candidates',
      issue: 'COUNTER_MISMATCH',
      sourceValue: sourceCandidates,
      counterValue: counterCandidates,
      delta: sourceCandidates - counterCandidates,
      severity: 'WARNING'
    });

    if (mode === 'APPLY_CORRECTIONS') {
      const delta = sourceCandidates - counterCandidates;
      recordUsageEvent({
        organizationId,
        subscriptionId: sub?.id,
        resourceKey: 'candidates',
        eventType: 'ADJUSTED',
        quantity: delta,
        referenceType: 'reconciliation',
        referenceId: `reconcile_cand_${Date.now()}`,
        idempotencyKey: `reconcile_cand_${organizationId}_${Date.now()}`,
        metadata: { reason: 'Reconciliation correction against students table', previous: counterCandidates, corrected: sourceCandidates, actorId }
      });
      corrections.push({ resourceKey: 'candidates', action: 'COUNTER_UPDATED', from: counterCandidates, to: sourceCandidates });
    }
  }

  // -------------------------------------------------------------
  // 2. ATTEMPTS RECONCILIATION
  // -------------------------------------------------------------
  const sourceAttempts = db.prepare('SELECT COUNT(*) as c FROM attempts WHERE organization_id = ?').get(organizationId)?.c || 0;
  const eventAttempts = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as s
    FROM organization_usage_events
    WHERE organization_id = ? AND resource_key = 'attempts' AND event_type IN ('INCREMENT', 'CONSUMED', 'ADJUSTED')
  `).get(organizationId)?.s || 0;

  if (sourceAttempts !== eventAttempts) {
    discrepancies.push({
      resourceKey: 'attempts',
      issue: 'EVENT_LEDGER_MISMATCH',
      sourceValue: sourceAttempts,
      eventsValue: eventAttempts,
      delta: sourceAttempts - eventAttempts,
      severity: 'INFO'
    });

    if (mode === 'APPLY_CORRECTIONS') {
      const delta = sourceAttempts - eventAttempts;
      recordUsageEvent({
        organizationId,
        subscriptionId: sub?.id,
        resourceKey: 'attempts',
        eventType: 'ADJUSTED',
        quantity: delta,
        referenceType: 'reconciliation',
        referenceId: `reconcile_att_${Date.now()}`,
        idempotencyKey: `reconcile_att_${organizationId}_${Date.now()}`,
        metadata: { reason: 'Reconciliation backfill against attempts table', previous: eventAttempts, corrected: sourceAttempts, actorId }
      });
      corrections.push({ resourceKey: 'attempts', action: 'EVENT_LEDGER_SYNCED', from: eventAttempts, to: sourceAttempts });
    }
  }

  // -------------------------------------------------------------
  // 3. MONTHLY PUBLISHED EXAMS RECONCILIATION
  // -------------------------------------------------------------
  const sourceMonthlyExams = db.prepare(`
    SELECT COUNT(*) as c FROM exams
    WHERE organization_id = ? AND published_at IS NOT NULL
      AND published_at >= ? AND published_at < ?
  `).get(organizationId, periodStart, periodEnd)?.c || 0;

  const counterMonthlyExamsRow = db.prepare(`
    SELECT used FROM organization_usage_counters
    WHERE organization_id = ? AND resource_key = 'exams_monthly' AND period_start = ? AND period_end = ?
  `).get(organizationId, periodStart, periodEnd);
  const counterMonthlyExams = counterMonthlyExamsRow?.used ?? 0;

  if (sourceMonthlyExams !== counterMonthlyExams) {
    discrepancies.push({
      resourceKey: 'exams_monthly',
      issue: 'MONTHLY_EXAM_COUNTER_MISMATCH',
      sourceValue: sourceMonthlyExams,
      counterValue: counterMonthlyExams,
      delta: sourceMonthlyExams - counterMonthlyExams,
      severity: 'WARNING'
    });

    if (mode === 'APPLY_CORRECTIONS') {
      const delta = sourceMonthlyExams - counterMonthlyExams;
      recordUsageEvent({
        organizationId,
        subscriptionId: sub?.id,
        resourceKey: 'exams_monthly',
        eventType: 'ADJUSTED',
        quantity: delta,
        referenceType: 'reconciliation',
        referenceId: `reconcile_exam_${Date.now()}`,
        idempotencyKey: `reconcile_exam_${organizationId}_${Date.now()}`,
        metadata: { reason: 'Reconciliation correction for monthly exams counter', previous: counterMonthlyExams, corrected: sourceMonthlyExams, actorId }
      });
      corrections.push({ resourceKey: 'exams_monthly', action: 'COUNTER_UPDATED', from: counterMonthlyExams, to: sourceMonthlyExams });
    }
  }

  // -------------------------------------------------------------
  // 4. STORAGE RECONCILIATION (DATABASE VS PHYSICAL DISK)
  // -------------------------------------------------------------
  const dbStorageSummary = db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) as total_bytes, COUNT(*) as count
    FROM organization_storage_objects
    WHERE organization_id = ?
  `).get(organizationId);

  const localUploadDir = path.resolve(process.env.STORAGE_LOCAL_DIR || './data/uploads', `organizations/${organizationId}`);
  const diskStorage = getDirectoryDiskSize(localUploadDir);

  const dbBytes = dbStorageSummary?.total_bytes || 0;
  const diskBytes = diskStorage.totalBytes;

  if (diskBytes > 0 && Math.abs(dbBytes - diskBytes) > 1024) { // allow 1KB slack for filesystem metadata
    discrepancies.push({
      resourceKey: 'storage_bytes',
      issue: 'PHYSICAL_STORAGE_DRIFT',
      databaseBytes: dbBytes,
      diskBytes,
      delta: diskBytes - dbBytes,
      severity: 'INFO'
    });

    if (mode === 'APPLY_CORRECTIONS' && dbBytes === 0 && diskBytes > 0) {
      // Auto-catalog untracked disk objects for tenant
      try {
        const delta = diskBytes - dbBytes;
        recordUsageEvent({
          organizationId,
          subscriptionId: sub?.id,
          resourceKey: 'storage_bytes',
          eventType: 'ADJUSTED',
          quantity: delta,
          referenceType: 'reconciliation',
          referenceId: `reconcile_storage_${Date.now()}`,
          idempotencyKey: `reconcile_storage_${organizationId}_${Date.now()}`,
          metadata: { reason: 'Physical storage drift adjustment', previous: dbBytes, corrected: diskBytes, actorId }
        });
        corrections.push({ resourceKey: 'storage_bytes', action: 'STORAGE_ALIGNED_WITH_DISK', from: dbBytes, to: diskBytes });
      } catch {}
    }
  }

  // -------------------------------------------------------------
  // 5. DAILY AGGREGATE CONSISTENCY CHECK
  // -------------------------------------------------------------
  const today = new Date().toISOString().split('T')[0];
  rebuildDailyAggregate(organizationId, today);

  const report = {
    organizationId,
    organizationName: org.name,
    reconciledAt: new Date().toISOString(),
    mode,
    discrepanciesCount: discrepancies.length,
    correctionsCount: corrections.length,
    discrepancies,
    corrections,
    status: discrepancies.length === 0 ? 'CLEAN' : (mode === 'APPLY_CORRECTIONS' ? 'REPAIRED' : 'DISCREPANCIES_FOUND')
  };

  recordAuditEvent({
    req,
    userId: actorId,
    organizationId,
    event: 'usage_reconciliation_executed',
    details: {
      mode,
      discrepanciesCount: discrepancies.length,
      correctionsCount: corrections.length,
      status: report.status
    }
  });

  return report;
}

/**
 * Executes platform-wide or tenant-specific reconciliation job.
 */
function startReconciliationJob({ organizationId = null, mode = 'DRY_RUN', actorId = null, req = null } = {}) {
  const jobId = `reconcile_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO reconciliation_jobs (id, organization_id, status, mode, initiated_by, started_at)
    VALUES (?, ?, 'RUNNING', ?, ?, ?)
  `).run(jobId, organizationId, mode, actorId, now);

  try {
    let targetOrgIds = [];
    if (organizationId) {
      targetOrgIds = [organizationId];
    } else {
      const orgRows = db.prepare('SELECT id FROM organizations WHERE status = ?').all('ACTIVE');
      targetOrgIds = orgRows.map((r) => r.id);
    }

    const orgReports = [];
    let totalDiscrepancies = 0;
    let totalCorrections = 0;

    for (const orgId of targetOrgIds) {
      const rep = reconcileOrganization(orgId, { mode, actorId, req });
      orgReports.push(rep);
      totalDiscrepancies += rep.discrepanciesCount;
      totalCorrections += rep.correctionsCount;
    }

    const finalReport = {
      jobId,
      organizationId,
      mode,
      totalOrganizationsChecked: targetOrgIds.length,
      totalDiscrepancies,
      totalCorrections,
      completedAt: new Date().toISOString(),
      reports: orgReports
    };

    db.prepare(`
      UPDATE reconciliation_jobs
      SET status = 'COMPLETED',
          discrepancies_count = ?,
          corrections_count = ?,
          report_json = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(totalDiscrepancies, totalCorrections, JSON.stringify(finalReport), jobId);

    return finalReport;
  } catch (err) {
    db.prepare(`
      UPDATE reconciliation_jobs
      SET status = 'FAILED',
          report_json = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify({ error: err.message }), jobId);
    throw err;
  }
}

/**
 * Retrieves past reconciliation job status and detailed report.
 */
function getReconciliationJob(jobId) {
  if (!jobId) throw new ValidationError('jobId is required');
  const job = db.prepare('SELECT * FROM reconciliation_jobs WHERE id = ?').get(jobId);
  if (!job) throw new NotFoundError(`Reconciliation job ${jobId} not found`);

  let report = {};
  try { report = JSON.parse(job.report_json || '{}'); } catch {}

  return {
    id: job.id,
    organizationId: job.organization_id,
    status: job.status,
    mode: job.mode,
    discrepanciesCount: job.discrepancies_count,
    correctionsCount: job.corrections_count,
    initiatedBy: job.initiated_by,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    report
  };
}

module.exports = {
  reconcileOrganization,
  startReconciliationJob,
  getReconciliationJob
};

