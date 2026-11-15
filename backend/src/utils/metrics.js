// Lightweight Performance Metrics Instrumentation (Day 15)
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const { monitorEventLoopDelay } = require('perf_hooks');

// Initialize event-loop delay monitor if supported
let elHistogram = null;
try {
  if (typeof monitorEventLoopDelay === 'function') {
    elHistogram = monitorEventLoopDelay({ resolution: 20 });
    elHistogram.enable();
  }
} catch {
  elHistogram = null;
}

let cpuStart = process.cpuUsage();
let cpuTimeStart = Date.now();

const state = {
  requestsTotal: 0,
  requestsByStatus: {
    '2xx': 0,
    '4xx': 0,
    '5xx': 0,
    '429': 0
  },
  routes: new Map(), // key -> { count, durations: [] }
  db: {
    queries: 0,
    transactions: 0,
    busyErrors: 0,
    totalDurationMs: 0
  },
  finalization: {
    count: 0,
    totalDurationMs: 0
  },
  certificates: {
    count: 0,
    failures: 0,
    totalDurationMs: 0
  },
  errors: {
    total: 0,
    byCategory: new Map(), // category -> count
    byCode: new Map() // code -> count
  },
  outbox: {
    dispatched: 0,
    failed: 0
  },
  providers: {
    coding: { success: 0, failed: 0, totalDurationMs: 0 },
    email: { success: 0, failed: 0 }
  }
};

/**
 * Calculate percentiles from an array of numbers
 */
function calculatePercentiles(sortedArr) {
  if (!sortedArr.length) return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const getP = (p) => {
    const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
    return sortedArr[idx];
  };
  return {
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
    max: sortedArr[sortedArr.length - 1]
  };
}

const metrics = {
  /**
   * Record an HTTP request lifecycle
   */
  recordRequest(method, route, statusCode, durationMs) {
    state.requestsTotal++;

    // Track status buckets
    if (statusCode === 429) {
      state.requestsByStatus['429']++;
      state.requestsByStatus['4xx']++;
    } else if (statusCode >= 500) {
      state.requestsByStatus['5xx']++;
    } else if (statusCode >= 400) {
      state.requestsByStatus['4xx']++;
    } else if (statusCode >= 200 && statusCode < 300) {
      state.requestsByStatus['2xx']++;
    }

    // Track per-route metrics
    const routeKey = `${method} ${route || 'unknown'}`;
    let routeData = state.routes.get(routeKey);
    if (!routeData) {
      routeData = { count: 0, totalDurationMs: 0, durations: [] };
      state.routes.set(routeKey, routeData);
    }
    routeData.count++;
    routeData.totalDurationMs += durationMs;

    // Keep bounded sample for accurate percentiles (up to 2000 samples per route)
    if (routeData.durations.length < 2000) {
      routeData.durations.push(durationMs);
    } else {
      // Reservoir sampling replacement
      const r = Math.floor(Math.random() * routeData.count);
      if (r < 2000) routeData.durations[r] = durationMs;
    }
  },

  /**
   * Record a database query or transaction
   */
  recordDbOperation(type, durationMs = 0, isBusyError = false) {
    if (type === 'transaction') {
      state.db.transactions++;
    } else {
      state.db.queries++;
    }
    state.db.totalDurationMs += durationMs;
    if (isBusyError) {
      state.db.busyErrors++;
    }
  },

  /**
   * Record assessment finalization duration
   */
  recordFinalization(durationMs) {
    state.finalization.count++;
    state.finalization.totalDurationMs += durationMs;
  },

  /**
   * Record PDF certificate generation duration
   */
  recordCertGeneration(durationMs) {
    state.certificates.count++;
    state.certificates.totalDurationMs += durationMs;
  },

  /**
   * Record a certificate generation failure
   */
  recordCertFailure() {
    state.certificates.failures++;
  },

  /**
   * Record an error occurrence with category and code
   */
  recordError(category = 'general', code = 'UNKNOWN') {
    state.errors.total++;
    const catCount = state.errors.byCategory.get(category) || 0;
    state.errors.byCategory.set(category, catCount + 1);

    const codeStr = String(code);
    const codeCount = state.errors.byCode.get(codeStr) || 0;
    state.errors.byCode.set(codeStr, codeCount + 1);
  },

  /**
   * Record an outbox dispatch result
   */
  recordOutboxDelivery(success) {
    if (success) {
      state.outbox.dispatched++;
    } else {
      state.outbox.failed++;
    }
  },

  /**
   * Record coding execution provider metrics
   */
  recordCodingExecution(success, durationMs = 0) {
    if (success) {
      state.providers.coding.success++;
    } else {
      state.providers.coding.failed++;
    }
    state.providers.coding.totalDurationMs += durationMs;
  },

  /**
   * Record email notification delivery metrics
   */
  recordEmailDelivery(success) {
    if (success) {
      state.providers.email.success++;
    } else {
      state.providers.email.failed++;
    }
  },

  /**
   * Generate point-in-time metrics snapshot
   */
  getSnapshot() {
    // Calculate CPU usage since last sample
    const cpuEnd = process.cpuUsage(cpuStart);
    const timeDelta = Date.now() - cpuTimeStart;
    const cpuTotalMicro = cpuEnd.user + cpuEnd.system;
    const cpuPercent = timeDelta > 0 ? ((cpuTotalMicro / (timeDelta * 1000)) * 100).toFixed(1) : 0;

    // Reset CPU interval
    cpuStart = process.cpuUsage();
    cpuTimeStart = Date.now();

    // Memory usage
    const mem = process.memoryUsage();

    // Event loop delay
    const elLag = elHistogram
      ? {
          p50: (elHistogram.percentile(50) / 1e6).toFixed(2),
          p90: (elHistogram.percentile(90) / 1e6).toFixed(2),
          p99: (elHistogram.percentile(99) / 1e6).toFixed(2),
          max: (elHistogram.max / 1e6).toFixed(2)
        }
      : { p50: '0.00', p90: '0.00', p99: '0.00', max: '0.00' };

    // Route breakdown
    const routeStats = {};
    for (const [key, data] of state.routes.entries()) {
      const sorted = [...data.durations].sort((a, b) => a - b);
      const percentiles = calculatePercentiles(sorted);
      routeStats[key] = {
        requests: data.count,
        avgLatencyMs: data.count > 0 ? (data.totalDurationMs / data.count).toFixed(1) : 0,
        p50LatencyMs: percentiles.p50,
        p90LatencyMs: percentiles.p90,
        p95LatencyMs: percentiles.p95,
        p99LatencyMs: percentiles.p99,
        maxLatencyMs: percentiles.max
      };
    }

    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      http: {
        totalRequests: state.requestsTotal,
        statusDistribution: { ...state.requestsByStatus },
        routes: routeStats
      },
      database: {
        queriesExecuted: state.db.queries,
        transactionsCommitted: state.db.transactions,
        busyLockErrors: state.db.busyErrors,
        totalDurationMs: state.db.totalDurationMs
      },
      finalization: {
        totalFinalized: state.finalization.count,
        avgDurationMs:
          state.finalization.count > 0
            ? (state.finalization.totalDurationMs / state.finalization.count).toFixed(1)
            : 0
      },
      certificates: {
        totalGenerated: state.certificates.count,
        totalFailures: state.certificates.failures,
        avgDurationMs:
          state.certificates.count > 0
            ? (state.certificates.totalDurationMs / state.certificates.count).toFixed(1)
            : 0
      },
      errors: {
        total: state.errors.total,
        byCategory: Object.fromEntries(state.errors.byCategory),
        byCode: Object.fromEntries(state.errors.byCode)
      },
      outbox: {
        dispatched: state.outbox.dispatched,
        failed: state.outbox.failed
      },
      providers: {
        coding: {
          success: state.providers.coding.success,
          failed: state.providers.coding.failed,
          avgDurationMs:
            state.providers.coding.success > 0
              ? (state.providers.coding.totalDurationMs / state.providers.coding.success).toFixed(1)
              : 0
        },
        email: {
          success: state.providers.email.success,
          failed: state.providers.email.failed
        }
      },
      system: {
        cpuPercent: Number(cpuPercent),
        memoryMb: {
          rss: (mem.rss / 1024 / 1024).toFixed(1),
          heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
          heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(1),
          external: (mem.external / 1024 / 1024).toFixed(1)
        },
        eventLoopLagMs: elLag
      }
    };
  },

  /**
   * Reset all counters for an isolated test run
   */
  reset() {
    state.requestsTotal = 0;
    state.requestsByStatus = { '2xx': 0, '4xx': 0, '5xx': 0, '429': 0 };
    state.routes.clear();
    state.db = { queries: 0, transactions: 0, busyErrors: 0, totalDurationMs: 0 };
    state.finalization = { count: 0, totalDurationMs: 0 };
    state.certificates = { count: 0, failures: 0, totalDurationMs: 0 };
    state.errors.total = 0;
    state.errors.byCategory.clear();
    state.errors.byCode.clear();
    state.outbox = { dispatched: 0, failed: 0 };
    state.providers = {
      coding: { success: 0, failed: 0, totalDurationMs: 0 },
      email: { success: 0, failed: 0 }
    };
    if (elHistogram && typeof elHistogram.reset === 'function') {
      try { elHistogram.reset(); } catch {}
    }
    cpuStart = process.cpuUsage();
    cpuTimeStart = Date.now();
  }
};

module.exports = metrics;

