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
    totalDurationMs: 0
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
        avgDurationMs:
          state.certificates.count > 0
            ? (state.certificates.totalDurationMs / state.certificates.count).toFixed(1)
            : 0
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
    state.certificates = { count: 0, totalDurationMs: 0 };
    if (elHistogram && typeof elHistogram.reset === 'function') {
      try { elHistogram.reset(); } catch {}
    }
    cpuStart = process.cpuUsage();
    cpuTimeStart = Date.now();
  }
};

module.exports = metrics;

