// Autocannon Production-Scale Benchmarking Engine (Day 15)
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const autocannon = require('autocannon');
const ProcessMonitor = require('../metrics/process-monitor');

const DB_PATH = path.join(os.tmpdir(), `aspire-day15-bench-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
process.env.AUTH_SECRET = 'day15_load_testing_secret_key_32bytes_min!';

const { db } = require('../../backend/src/db');
const createApp = require('../../backend/src/app');
const { seedIfEmpty } = require('../../backend/src/data/seed');

function runAutocannonAsync(options) {
  return new Promise((resolve, reject) => {
    autocannon(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/**
 * Accurately extracts latency percentiles from Autocannon result.
 * Fixes Day 14 percentile bug where missing p95 was falsely reported as 0.0 ms.
 */
function extractLatencies(resLatency) {
  if (!resLatency) {
    return { avg: 0, p50: 0, p90: 0, p95: 0, p97_5: 0, p99: 0, max: 0 };
  }
  const avg = Number((resLatency.average || 0).toFixed(1));
  const p50 = Number((resLatency.p50 || 0).toFixed(1));
  const p90 = Number((resLatency.p90 || 0).toFixed(1));
  const p97_5 = Number((resLatency.p97_5 || 0).toFixed(1));
  const p99 = Number((resLatency.p99 || 0).toFixed(1));
  const max = Number((resLatency.max || 0).toFixed(1));

  // Compute linear interpolation between p90 and p97.5 for accurate p95
  const p95 = Number((p90 + (p97_5 - p90) * (5 / 7.5)).toFixed(1));

  return { avg, p50, p90, p95, p97_5, p99, max };
}

function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));
  const pad = (str, len, alignRight = false) => {
    const s = String(str);
    return alignRight ? s.padStart(len) : s.padEnd(len);
  };

  const sep = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const headerLine = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';

  console.log(sep);
  console.log(headerLine);
  console.log(sep);
  for (const row of rows) {
    console.log('| ' + row.map((c, i) => pad(c, colWidths[i], i >= 1 && i <= colWidths.length - 1)).join(' | ') + ' |');
  }
  console.log(sep);
}

async function runAutocannonSuite(targetConcurrency = null) {
  console.log('========================================================================');
  console.log('ASPIRE DAY 15: PRODUCTION-SCALE LOAD TESTING & CAPACITY BENCHMARKING');
  console.log('========================================================================\n');

  seedIfEmpty(db);
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[SAFETY CHECK] Target Base URL: ${baseUrl}`);
  console.log(`[SAFETY CHECK] Environment: ${process.env.NODE_ENV}`);
  console.log(`[SAFETY CHECK] Database Path: ${DB_PATH}`);
  console.log(`[SAFETY CHECK] Provider Mode: MOCK\n`);

  const monitor = new ProcessMonitor(250, DB_PATH);
  const benchmarkRows = [];
  const reportData = [];

  try {
    // 1. Setup candidate test token & certificate
    console.log('--- Setting up benchmark fixtures ---');
    const exam = db.prepare("SELECT * FROM exams WHERE status = 'PUBLISHED' LIMIT 1").get() ||
                 db.prepare("SELECT * FROM exams LIMIT 1").get();

    let testToken = null;
    let testCertId = null;
    let firstQId = 1;

    const regResp = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Benchmark Candidate',
        email: `bench.${Date.now()}@adyapan.test`,
        phone: '9811223344'
      })
    });
    if (regResp.ok) {
      const regData = await regResp.json();
      testToken = regData.token;
      console.log(`Active benchmark token: ${testToken.substring(0, 16)}...`);

      // Fetch questions
      const qResp = await fetch(`${baseUrl}/api/attempt/${testToken}`);
      if (qResp.ok) {
        const qData = await qResp.json();
        if (qData.questions && qData.questions.length > 0) {
          firstQId = qData.questions[0].id;
        }
      }

      // Submit another candidate to produce a valid certificate
      const certCandResp = await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Cert Benchmark Candidate',
          email: `certbench.${Date.now()}@adyapan.test`,
          phone: '9855667788'
        })
      });
      if (certCandResp.ok) {
        const cData = await certCandResp.json();
        const subResp = await fetch(`${baseUrl}/api/attempt/${cData.token}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answers: { [String(firstQId)]: 0 } })
        });
        if (subResp.ok) {
          const sData = await subResp.json();
          testCertId = sData.certificate_id;
          console.log(`Active certificate fixture: ${testCertId}\n`);
        }
      }
    }

    // Determine concurrency levels to test
    const vusList = targetConcurrency
      ? [targetConcurrency]
      : [10, 100, 500, 1000];

    console.log('--- Executing Staged Concurrency Benchmarks ---');

    for (const vus of vusList) {
      console.log(`\n>>> Testing Stage: ${vus} Concurrent Virtual Users <<<`);

      const scenarios = [
        {
          name: 'GET /api/health',
          url: `${baseUrl}/api/health`,
          method: 'GET',
          duration: 4
        },
        {
          name: 'GET /api/config/public',
          url: `${baseUrl}/api/config/public`,
          method: 'GET',
          duration: 4
        },
        {
          name: 'GET /api/attempt/:token',
          url: `${baseUrl}/api/attempt/${testToken}`,
          method: 'GET',
          duration: 4
        },
        {
          name: 'POST /api/attempt/:token/heartbeat',
          url: `${baseUrl}/api/attempt/${testToken}/heartbeat`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tabSwitches: 1, clientSessionId: 'csess_bench' }),
          duration: 4
        },
        {
          name: 'POST /api/attempt/:token/progress/sync',
          url: `${baseUrl}/api/attempt/${testToken}/progress/sync`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientSessionId: 'client_session_bench',
            lastKnownRevision: 0,
            changes: [{
              changeId: 'bench_change_001',
              type: 'MCQ_ANSWER',
              questionId: firstQId,
              selectedOption: 0,
              revision: 1,
              clientTimestamp: new Date().toISOString()
            }]
          }),
          duration: 4
        },
        {
          name: 'POST /api/attempt/:token/submit (idempotent)',
          url: `${baseUrl}/api/attempt/${testToken}/submit`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ answers: { [String(firstQId)]: 0 } }),
          duration: 4
        }
      ];

      if (testCertId) {
        scenarios.push({
          name: 'GET /api/certificate/:certId',
          url: `${baseUrl}/api/certificate/${testCertId}`,
          method: 'GET',
          duration: 4
        });
      }

      for (const sc of scenarios) {
        monitor.start();
        const startT = Date.now();

        const opts = {
          url: sc.url,
          method: sc.method || 'GET',
          headers: {
            ...(sc.headers || {}),
            'X-Forwarded-For': `198.51.100.${vus % 250}`
          },
          connections: vus,
          duration: sc.duration || 4,
          pipelining: 1
        };
        if (sc.body) opts.body = sc.body;

        const result = await runAutocannonAsync(opts);
        const sysStats = monitor.stop();

        const lat = extractLatencies(result.latency);
        const reqSec = Math.round(result.requests.average || 0);
        const successCount = result['2xx'] || 0;
        const non2xx = result.non2xx || 0;
        const error5xx = result['5xx'] || 0;

        benchmarkRows.push([
          sc.name,
          vus,
          `${sc.duration}s`,
          reqSec,
          `${lat.avg} ms`,
          `${lat.p50} ms`,
          `${lat.p90} ms`,
          `${lat.p95} ms`,
          `${lat.p99} ms`,
          successCount,
          non2xx,
          error5xx,
          `${sysStats.peakCpu}%`,
          `${sysStats.peakRssMb}MB`
        ]);

        reportData.push({
          endpoint: sc.name,
          vus,
          durationSec: sc.duration,
          reqSec,
          latencies: lat,
          successCount,
          non2xx,
          error5xx,
          system: sysStats
        });

        console.log(`  ✓ ${sc.name.padEnd(38)} | ${reqSec} req/s | avg: ${lat.avg}ms | p95: ${lat.p95}ms | 5xx: ${error5xx}`);
      }
    }

    // Output formatted results table
    console.log('\n=========================================================================================================================');
    console.log('PRODUCTION-SCALE AUTOCANNON BENCHMARK RESULTS');
    console.log('=========================================================================================================================\n');

    const headers = [
      'Endpoint', 'VUs', 'Dur', 'Req/s', 'Avg', 'p50', 'p90', 'p95', 'p99', '2xx', 'Non-2xx', '5xx', 'Peak CPU', 'Peak RSS'
    ];
    formatTable(headers, benchmarkRows);

    // Persist JSON report
    const reportDir = path.join(__dirname, '..', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `autocannon-results-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results: reportData }, null, 2));
    console.log(`\n[Report Saved] ${reportPath}\n`);

    return reportData;

  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  }
}

if (require.main === module) {
  const customVus = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  runAutocannonSuite(customVus).catch((err) => {
    console.error('Fatal autocannon runner error:', err);
    process.exit(1);
  });
}

module.exports = { runAutocannonSuite, extractLatencies };
