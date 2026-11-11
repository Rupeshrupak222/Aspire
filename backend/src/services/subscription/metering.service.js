// ============================================================================
// ASPIRE DAY 22: USAGE METERING & DAILY AGGREGATION SERVICE
// ============================================================================
// Authoritative measurement across all 7 resource categories:
// Candidates, Attempts, Exams, Questions, Certificates, Code Executions, Storage.
// Implements idempotent event ingestion, daily rollups, trends, and snapshots.
// ============================================================================

const { db } = require('../../db');
const { ValidationError, NotFoundError } = require('../../errors/app-error');
const { getOrganizationSubscription, getEffectiveQuotas } = require('./subscription.service');
const { getOrCreateCounter, getUsage } = require('./usage.service');
const { resolveResourcePeriod } = require('./quota.service');

const METERED_RESOURCES = [
  'candidates',
  'attempts',
  'exams_created',
  'exams_published',
  'questions',
  'certificates',
  'code_executions',
  'storage_bytes',
  'storage_objects'
];

/**
 * Normalizes event date according to organization timezone.
 */
function getUsageDateString(dateInput = new Date(), timezone = 'UTC') {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];

  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(d);
  } catch (err) {
    return d.toISOString().split('T')[0];
  }
}

/**
 * Retrieves the organization's configured timezone.
 */
function getOrgTimezone(organizationId) {
  if (!organizationId) return 'UTC';
  try {
    const org = db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(organizationId);
    return org?.timezone || 'Asia/Kolkata';
  } catch {
    return 'UTC';
  }
}

/**
 * Records an authoritative, idempotent resource lifecycle event.
 * Atomically updates:
 * 1. organization_usage_events (immutable audit log)
 * 2. organization_usage_daily (pre-aggregated daily rollup)
 * 3. organization_usage_counters (current billing period quota tracking)
 */
function recordUsageEvent({
  organizationId,
  subscriptionId = null,
  resourceKey,
  eventType = 'INCREMENT',
  quantity = 1,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null,
  metadata = {},
  occurredAt = new Date().toISOString()
}) {
  if (!organizationId) {
    throw new ValidationError('organizationId is required to record usage event.');
  }
  if (!resourceKey) {
    throw new ValidationError('resourceKey is required to record usage event.');
  }

  // Idempotency check: Return existing event if already processed
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM organization_usage_events WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      let meta = {};
      try { meta = JSON.parse(existing.metadata_json || '{}'); } catch {}
      return {
        success: true,
        event: { ...existing, metadata: meta },
        isDuplicate: true
      };
    }
  }

  const sub = subscriptionId ? { id: subscriptionId } : getOrganizationSubscription(organizationId);
  const actualSubId = sub?.id || null;

  // Determine positive vs negative delta
  const normType = String(eventType).toUpperCase();
  let consumedDelta = 0;
  let releasedDelta = 0;
  let netDelta = 0;

  if (normType === 'DECREMENT' || normType === 'RELEASED') {
    releasedDelta = Math.abs(quantity);
    netDelta = -releasedDelta;
  } else if (normType === 'INCREMENT' || normType === 'CONSUMED') {
    consumedDelta = Math.abs(quantity);
    netDelta = consumedDelta;
  } else if (normType === 'ADJUSTED') {
    netDelta = quantity;
    if (quantity >= 0) consumedDelta = quantity;
    else releasedDelta = Math.abs(quantity);
  } else if (normType === 'REVERSED') {
    releasedDelta = Math.abs(quantity);
    netDelta = -releasedDelta;
  } else {
    // SNAPSHOT / generic
    netDelta = quantity;
    consumedDelta = Math.max(0, quantity);
  }

  const tz = getOrgTimezone(organizationId);
  const usageDate = getUsageDateString(occurredAt, tz);
  const metaStr = JSON.stringify(metadata || {});

  let createdEvent = null;

  const executeAtomic = db.transaction(() => {
    // 1. Insert into organization_usage_events
    const ins = db.prepare(`
      INSERT INTO organization_usage_events (
        organization_id, subscription_id, resource_key, event_type, quantity,
        reference_type, reference_id, idempotency_key, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      organizationId,
      actualSubId,
      resourceKey,
      normType,
      quantity,
      referenceType,
      referenceId ? String(referenceId) : null,
      idempotencyKey,
      metaStr,
      occurredAt
    );

    createdEvent = db.prepare('SELECT * FROM organization_usage_events WHERE id = ?').get(ins.lastInsertRowid);

    // 2. Upsert into organization_usage_daily
    db.prepare(`
      INSERT INTO organization_usage_daily (
        organization_id, resource_key, usage_date, consumed, released, net_usage, event_count, metadata_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(organization_id, resource_key, usage_date) DO UPDATE SET
        consumed = consumed + excluded.consumed,
        released = released + excluded.released,
        net_usage = net_usage + excluded.net_usage,
        event_count = event_count + 1,
        updated_at = datetime('now')
    `).run(
      organizationId,
      resourceKey,
      usageDate,
      consumedDelta,
      releasedDelta,
      netDelta,
      metaStr
    );

    // 3. Update period counters if applicable
    if (sub) {
      const { periodStart, periodEnd } = resolveResourcePeriod(sub, resourceKey);
      const counter = getOrCreateCounter(organizationId, resourceKey, periodStart, periodEnd, actualSubId);
      if (counter && netDelta !== 0) {
        db.prepare(`
          UPDATE organization_usage_counters
          SET used = MAX(0, used + ?),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(netDelta, counter.id);
      }
    }
  });

  executeAtomic();

  let meta = {};
  try { meta = JSON.parse(createdEvent?.metadata_json || '{}'); } catch {}

  return {
    success: true,
    event: { ...createdEvent, metadata: meta },
    isDuplicate: false,
    usageDate
  };
}

/**
 * Rebuilds daily aggregate for a specific organization, resource, and date.
 * Idempotently recalculates from the immutable event ledger.
 */
function rebuildDailyAggregate(organizationId, targetDate, resourceKey = null) {
  if (!organizationId || !targetDate) return null;

  const tz = getOrgTimezone(organizationId);
  const where = ['organization_id = ?', 'date(created_at) = ?'];
  const params = [organizationId, targetDate];

  if (resourceKey) {
    where.push('resource_key = ?');
    params.push(resourceKey);
  }

  const rows = db.prepare(`
    SELECT resource_key,
           SUM(CASE WHEN event_type IN ('INCREMENT', 'CONSUMED') THEN quantity
                    WHEN event_type = 'ADJUSTED' AND quantity > 0 THEN quantity
                    ELSE 0 END) as total_consumed,
           SUM(CASE WHEN event_type IN ('DECREMENT', 'RELEASED', 'REVERSED') THEN ABS(quantity)
                    WHEN event_type = 'ADJUSTED' AND quantity < 0 THEN ABS(quantity)
                    ELSE 0 END) as total_released,
           SUM(CASE WHEN event_type IN ('DECREMENT', 'RELEASED', 'REVERSED') THEN -ABS(quantity)
                    ELSE quantity END) as total_net,
           COUNT(*) as event_count
    FROM organization_usage_events
    WHERE ${where.join(' AND ')}
    GROUP BY resource_key
  `).all(...params);

  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare(`
        INSERT INTO organization_usage_daily (
          organization_id, resource_key, usage_date, consumed, released, net_usage, event_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(organization_id, resource_key, usage_date) DO UPDATE SET
          consumed = excluded.consumed,
          released = excluded.released,
          net_usage = excluded.net_usage,
          event_count = excluded.event_count,
          updated_at = datetime('now')
      `).run(
        organizationId,
        r.resource_key,
        targetDate,
        r.total_consumed || 0,
        r.total_released || 0,
        r.total_net || 0,
        r.event_count || 0
      );
    }
  });

  tx();
  return rows;
}

/**
 * Aggregates daily usage across a date range.
 */
function aggregateDailyUsage({ organizationId, resourceKey = null, startDate, endDate, timezone = null }) {
  if (!organizationId) throw new ValidationError('organizationId is required');

  const tz = timezone || getOrgTimezone(organizationId);
  const start = startDate ? getUsageDateString(startDate, tz) : getUsageDateString(new Date(Date.now() - 30 * 86400000), tz);
  const end = endDate ? getUsageDateString(endDate, tz) : getUsageDateString(new Date(), tz);

  const where = ['organization_id = ?', 'usage_date >= ?', 'usage_date <= ?'];
  const params = [organizationId, start, end];

  if (resourceKey) {
    where.push('resource_key = ?');
    params.push(resourceKey);
  }

  return db.prepare(`
    SELECT resource_key, usage_date, consumed, released, net_usage, event_count, updated_at
    FROM organization_usage_daily
    WHERE ${where.join(' AND ')}
    ORDER BY usage_date ASC, resource_key ASC
  `).all(...params);
}

/**
 * Returns the current comprehensive real-time usage snapshot across all 7 resource categories.
 */
function getCurrentUsageSnapshot(organizationId) {
  if (!organizationId) throw new ValidationError('organizationId is required');

  const org = db.prepare('SELECT id, name, slug, status, timezone FROM organizations WHERE id = ?').get(organizationId);
  if (!org) throw new NotFoundError('Organization not found');

  const sub = getOrganizationSubscription(organizationId);
  const effectiveQuotas = getEffectiveQuotas(organizationId);
  const softLimitPct = sub?.plan?.softLimitPct ?? 80;

  // 1. Candidates (distinct human students)
  const candidateCountRow = db.prepare('SELECT COUNT(DISTINCT id) as c FROM students WHERE organization_id = ?').get(organizationId);
  const candidateUsed = candidateCountRow?.c || 0;
  const candidateLimit = effectiveQuotas.candidates ?? null; // null = unlimited
  const candidateRemaining = candidateLimit !== null ? Math.max(0, candidateLimit - candidateUsed) : null;
  const candidatePct = candidateLimit !== null && candidateLimit > 0 ? Math.round((candidateUsed / candidateLimit) * 100) : 0;

  // 2. Assessment Attempts
  const attemptsSummary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'started' AND datetime(expires_at) >= datetime('now') THEN 1 ELSE 0 END) as started,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN status = 'started' AND datetime(expires_at) < datetime('now') THEN 1 ELSE 0 END) as abandoned,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired
    FROM attempts
    WHERE organization_id = ?
  `).get(organizationId);

  // 3. Exams
  const examsSummary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('DRAFT', 'IN_REVIEW') THEN 1 ELSE 0 END) as drafts,
      SUM(CASE WHEN status IN ('PUBLISHED', 'LIVE') THEN 1 ELSE 0 END) as published,
      SUM(CASE WHEN status = 'ARCHIVED' THEN 1 ELSE 0 END) as archived
    FROM exams
    WHERE organization_id = ?
  `).get(organizationId);

  // Monthly published quota tracking (from Day 21 counter)
  const { periodStart, periodEnd } = resolveResourcePeriod(sub, 'exams_monthly');
  const monthlyExamUsage = getUsage(organizationId, 'exams_monthly', periodStart, periodEnd);
  const monthlyExamLimit = effectiveQuotas.exams_monthly ?? null;
  const monthlyExamRemaining = monthlyExamLimit !== null ? Math.max(0, monthlyExamLimit - monthlyExamUsage.used) : null;
  const monthlyExamPct = monthlyExamLimit !== null && monthlyExamLimit > 0 ? Math.round((monthlyExamUsage.used / monthlyExamLimit) * 100) : 0;

  // 4. Questions (Question Bank)
  const questionsSummary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'PUBLISHED' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'ARCHIVED' THEN 1 ELSE 0 END) as archived,
      SUM(CASE WHEN type = 'code' THEN 1 ELSE 0 END) as coding_count
    FROM questions
    WHERE organization_id = ?
  `).get(organizationId);

  const allocatedQuestionsRow = db.prepare(`
    SELECT COUNT(DISTINCT sq.question_id) as c
    FROM exam_section_questions sq
    JOIN exam_sections es ON es.id = sq.section_id
    JOIN exams e ON e.id = es.exam_id
    WHERE e.organization_id = ?
  `).get(organizationId);

  // 5. Certificates
  const certSummary = db.prepare(`
    SELECT
      COUNT(*) as issued,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as verified
    FROM attempts
    WHERE organization_id = ? AND certificate_id IS NOT NULL
  `).get(organizationId);

  // 6. Code Executions
  const codeExecSummary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN submission_status = 'ALL_TESTS_PASSED' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN submission_status = 'COMPILATION_ERROR' THEN 1 ELSE 0 END) as compilation_error,
      SUM(CASE WHEN submission_status = 'RUNTIME_ERROR' THEN 1 ELSE 0 END) as runtime_error,
      SUM(CASE WHEN submission_status = 'TIME_LIMIT_EXCEEDED' THEN 1 ELSE 0 END) as timeout,
      SUM(CASE WHEN submission_status = 'PROVIDER_ERROR' THEN 1 ELSE 0 END) as provider_error,
      SUM(CASE WHEN lifecycle_status IN ('QUEUED', 'PROCESSING') THEN 1 ELSE 0 END) as pending
    FROM coding_submissions
    WHERE organization_id = ?
  `).get(organizationId);

  // 7. Storage (actual stored objects in bytes)
  const storageSummary = db.prepare(`
    SELECT
      COALESCE(SUM(size_bytes), 0) as total_bytes,
      COUNT(*) as total_objects
    FROM organization_storage_objects
    WHERE organization_id = ?
  `).get(organizationId);

  const storageCategories = db.prepare(`
    SELECT category, COALESCE(SUM(size_bytes), 0) as bytes, COUNT(*) as count
    FROM organization_storage_objects
    WHERE organization_id = ?
    GROUP BY category
  `).all(organizationId);

  // Default storage limits: Starter: 1GB, Growth: 10GB, Enterprise: 100GB (or null)
  let defaultStorageLimit = 10 * 1024 * 1024 * 1024; // 10 GB
  if (sub?.plan?.code === 'STARTER') defaultStorageLimit = 1 * 1024 * 1024 * 1024;
  else if (sub?.plan?.code === 'ENTERPRISE') defaultStorageLimit = 100 * 1024 * 1024 * 1024;
  const storageLimit = effectiveQuotas.storage_bytes !== undefined ? effectiveQuotas.storage_bytes : defaultStorageLimit;
  const storageUsed = storageSummary?.total_bytes || 0;
  const storageRemaining = storageLimit !== null ? Math.max(0, storageLimit - storageUsed) : null;
  const storagePct = storageLimit !== null && storageLimit > 0 ? Math.round((storageUsed / storageLimit) * 100) : 0;

  // Determine warning states
  const hasSoftLimitWarning =
    (candidateLimit !== null && candidatePct >= softLimitPct && candidatePct < 100) ||
    (monthlyExamLimit !== null && monthlyExamPct >= softLimitPct && monthlyExamPct < 100) ||
    (storageLimit !== null && storagePct >= softLimitPct && storagePct < 100);

  const hasHardLimitExceeded =
    (candidateLimit !== null && candidateUsed >= candidateLimit) ||
    (monthlyExamLimit !== null && monthlyExamUsage.used >= monthlyExamLimit) ||
    (storageLimit !== null && storageUsed >= storageLimit);

  return {
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      timezone: org.timezone || 'Asia/Kolkata'
    },
    subscription: {
      id: sub?.id || null,
      status: sub?.status || 'NO_SUBSCRIPTION',
      planCode: sub?.plan?.code || 'UNASSIGNED',
      planName: sub?.plan?.name || 'Unassigned',
      softLimitPct,
      periodStart,
      periodEnd
    },
    alerts: {
      softLimitWarning: hasSoftLimitWarning,
      hardLimitExceeded: hasHardLimitExceeded,
      warningMessage: hasHardLimitExceeded
        ? 'One or more resource quotas have reached 100% capacity.'
        : hasSoftLimitWarning
        ? `Approaching plan quota limit (${softLimitPct}% threshold reached).`
        : null
    },
    resources: {
      candidates: {
        used: candidateUsed,
        current: candidateUsed,
        limit: candidateLimit,
        remaining: candidateRemaining,
        percentage: candidatePct,
        unlimited: candidateLimit === null,
        status: candidateLimit !== null && candidateUsed >= candidateLimit ? 'EXCEEDED' : candidatePct >= softLimitPct ? 'WARNING' : 'NORMAL'
      },
      attempts: {
        total: attemptsSummary?.total || 0,
        started: attemptsSummary?.started || 0,
        submitted: attemptsSummary?.submitted || 0,
        abandoned: attemptsSummary?.abandoned || 0,
        expired: attemptsSummary?.expired || 0,
        limit: null,
        unlimited: true,
        status: 'NORMAL'
      },
      exams: {
        total: examsSummary?.total || 0,
        drafts: examsSummary?.drafts || 0,
        published: examsSummary?.published || 0,
        archived: examsSummary?.archived || 0,
        monthlyPublished: {
          used: monthlyExamUsage.used,
          limit: monthlyExamLimit,
          remaining: monthlyExamRemaining,
          percentage: monthlyExamPct,
          unlimited: monthlyExamLimit === null,
          status: monthlyExamLimit !== null && monthlyExamUsage.used >= monthlyExamLimit ? 'EXCEEDED' : monthlyExamPct >= softLimitPct ? 'WARNING' : 'NORMAL'
        }
      },
      questions: {
        total: questionsSummary?.total || 0,
        active: questionsSummary?.active || 0,
        archived: questionsSummary?.archived || 0,
        allocatedToExams: allocatedQuestionsRow?.c || 0,
        codingCount: questionsSummary?.coding_count || 0,
        limit: null,
        unlimited: true,
        status: 'NORMAL'
      },
      certificates: {
        issued: certSummary?.issued || 0,
        verified: certSummary?.verified || 0,
        limit: effectiveQuotas.certificates ?? null,
        unlimited: effectiveQuotas.certificates === undefined || effectiveQuotas.certificates === null,
        status: 'NORMAL'
      },
      codeExecutions: {
        total: codeExecSummary?.total || 0,
        passed: codeExecSummary?.passed || 0,
        compilationError: codeExecSummary?.compilation_error || 0,
        runtimeError: codeExecSummary?.runtime_error || 0,
        timeout: codeExecSummary?.timeout || 0,
        providerError: codeExecSummary?.provider_error || 0,
        pending: codeExecSummary?.pending || 0,
        limit: null,
        unlimited: true,
        status: 'NORMAL'
      },
      storage: {
        totalBytes: storageUsed,
        totalMegabytes: Number((storageUsed / (1024 * 1024)).toFixed(2)),
        totalGigabytes: Number((storageUsed / (1024 * 1024 * 1024)).toFixed(3)),
        totalObjects: storageSummary?.total_objects || 0,
        limitBytes: storageLimit,
        limitGigabytes: storageLimit !== null ? Number((storageLimit / (1024 * 1024 * 1024)).toFixed(1)) : null,
        remainingBytes: storageRemaining,
        percentage: storagePct,
        unlimited: storageLimit === null,
        categories: storageCategories.map((c) => ({
          category: c.category,
          bytes: c.bytes,
          count: c.count
        })),
        status: storageLimit !== null && storageUsed >= storageLimit ? 'EXCEEDED' : storagePct >= softLimitPct ? 'WARNING' : 'NORMAL'
      }
    }
  };
}

/**
 * Returns time series usage trends suitable for Chart.js visualization.
 * Seamlessly fills dates with zero activity to maintain smooth timeline curves.
 */
function getUsageTrends({ organizationId, resourceKey = null, startDate, endDate, interval = 'daily' }) {
  if (!organizationId) throw new ValidationError('organizationId is required');

  const tz = getOrgTimezone(organizationId);
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 29 * 86400000); // 30 days default

  const startStr = startDate ? getUsageDateString(startDate, tz) : getUsageDateString(defaultStart, tz);
  const endStr = endDate ? getUsageDateString(endDate, tz) : getUsageDateString(now, tz);

  // Fetch recorded daily aggregates
  const where = ['organization_id = ?', 'usage_date >= ?', 'usage_date <= ?'];
  const params = [organizationId, startStr, endStr];

  if (resourceKey) {
    where.push('resource_key = ?');
    params.push(resourceKey);
  }

  const recordedRows = db.prepare(`
    SELECT resource_key, usage_date, consumed, released, net_usage, event_count
    FROM organization_usage_daily
    WHERE ${where.join(' AND ')}
    ORDER BY usage_date ASC
  `).all(...params);

  // Build index by date and resource
  const recordedMap = new Map();
  for (const row of recordedRows) {
    const key = `${row.usage_date}_${row.resource_key}`;
    recordedMap.set(key, row);
  }

  // Generate contiguous dates array
  const dateList = [];
  const curr = new Date(startStr + 'T00:00:00Z');
  const endD = new Date(endStr + 'T00:00:00Z');

  while (curr <= endD) {
    dateList.push(curr.toISOString().split('T')[0]);
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  // Target resources to track in trend series
  const resourcesToMap = resourceKey ? [resourceKey] : ['candidates', 'attempts', 'exams_published', 'certificates', 'code_executions', 'storage_bytes'];

  const series = {};
  for (const res of resourcesToMap) {
    series[res] = [];
  }

  for (const dt of dateList) {
    for (const res of resourcesToMap) {
      const match = recordedMap.get(`${dt}_${res}`);
      series[res].push({
        date: dt,
        consumed: match ? match.consumed : 0,
        released: match ? match.released : 0,
        netUsage: match ? match.net_usage : 0,
        eventCount: match ? match.event_count : 0
      });
    }
  }

  return {
    organizationId,
    startDate: startStr,
    endDate: endStr,
    interval,
    dates: dateList,
    series
  };
}

/**
 * Returns paginated usage event audit history.
 */
function getUsageHistory({ organizationId, resourceKey = null, page = 1, limit = 20, startDate = null, endDate = null }) {
  if (!organizationId) throw new ValidationError('organizationId is required');

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const where = ['organization_id = ?'];
  const params = [organizationId];

  if (resourceKey) {
    where.push('resource_key = ?');
    params.push(resourceKey);
  }
  if (startDate) {
    where.push('created_at >= ?');
    params.push(startDate);
  }
  if (endDate) {
    where.push('created_at <= ?');
    params.push(endDate);
  }

  const countRow = db.prepare(`SELECT count(*) as c FROM organization_usage_events WHERE ${where.join(' AND ')}`).get(...params);
  const total = countRow?.c || 0;
  const totalPages = Math.ceil(total / safeLimit) || 1;

  const rows = db.prepare(`
    SELECT * FROM organization_usage_events
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);

  const events = rows.map((r) => {
    let meta = {};
    try { meta = JSON.parse(r.metadata_json || '{}'); } catch {}
    // Sanitize metadata to never leak student contact details, passwords, or code
    delete meta.password;
    delete meta.hash;
    delete meta.token;
    delete meta.answerKey;

    return {
      id: r.id,
      resourceKey: r.resource_key,
      eventType: r.event_type,
      quantity: r.quantity,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      idempotencyKey: r.idempotency_key,
      metadata: meta,
      createdAt: r.created_at
    };
  });

  return {
    events,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages
    }
  };
}

/**
 * Returns detailed storage footprint and category allocations.
 */
function getStorageFootprint(organizationId) {
  if (!organizationId) throw new ValidationError('organizationId is required');

  const totals = db.prepare(`
    SELECT COALESCE(SUM(size_bytes), 0) as total_bytes, COUNT(*) as total_objects
    FROM organization_storage_objects
    WHERE organization_id = ?
  `).get(organizationId);

  const categories = db.prepare(`
    SELECT category, COALESCE(SUM(size_bytes), 0) as bytes, COUNT(*) as count
    FROM organization_storage_objects
    WHERE organization_id = ?
    GROUP BY category
    ORDER BY bytes DESC
  `).all(organizationId);

  const objects = db.prepare(`
    SELECT id, storage_key, category, file_name, mime_type, size_bytes, provider, created_at
    FROM organization_storage_objects
    WHERE organization_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(organizationId);

  const totalBytes = totals?.total_bytes || 0;

  return {
    totalBytes,
    totalMegabytes: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    totalGigabytes: Number((totalBytes / (1024 * 1024 * 1024)).toFixed(3)),
    totalObjects: totals?.total_objects || 0,
    categories: categories.map((c) => ({
      category: c.category,
      bytes: c.bytes,
      megabytes: Number((c.bytes / (1024 * 1024)).toFixed(2)),
      count: c.count,
      percentage: totalBytes > 0 ? Number(((c.bytes / totalBytes) * 100).toFixed(1)) : 0
    })),
    recentObjects: objects
  };
}

module.exports = {
  METERED_RESOURCES,
  getUsageDateString,
  getOrgTimezone,
  recordUsageEvent,
  rebuildDailyAggregate,
  aggregateDailyUsage,
  getCurrentUsageSnapshot,
  getUsageTrends,
  getUsageHistory,
  getStorageFootprint
};

