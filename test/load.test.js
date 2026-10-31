// ASPIRE — DAY 14: Load Testing Suite with Autocannon (Layer F)
// Validates system stability, throughput, latency percentiles (p95, p99),
// and error rates under concurrent virtual user (VU) loads.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const autocannon = require('autocannon');

const DB_PATH = path.join(os.tmpdir(), `aspire-load-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'warn';
process.env.AUTH_SECRET = 'load_testing_secret_key_32bytes_minimum_length!';

const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { seedIfEmpty } = require('../backend/src/data/seed');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function ok(name, condition, extra = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS  ${name}`);
  } else {
    failedTests++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

function runAutocannonAsync(options) {
  return new Promise((resolve, reject) => {
    autocannon(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function formatTable(rows) {
  const headers = ['Endpoint / Test', 'VUs', 'Duration', 'Req/sec', 'Avg Latency', 'p95 Latency', 'p99 Latency', '2xx', 'Non-2xx', '5xx Errors'];
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
    console.log('| ' + row.map((c, i) => pad(c, colWidths[i], i >= 1 && i <= 9)).join(' | ') + ' |');
  }
  console.log(sep);
}

async function runLoadTests() {
  console.log('====================================================');
  console.log('ASPIRE DAY 14: LOAD TESTING SUITE — AUTOCANNON (LAYER F)');
  console.log('====================================================\n');

  seedIfEmpty(db);
  const app = createApp();

  // Create an ephemeral HTTP server
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Ephemeral test server running at ${baseUrl}\n`);

  const benchmarkResults = [];

  try {
    // Setup test attempt for candidate load test
    console.log('--- Setting Up Benchmark Test Data ---');
    const exam = db.prepare("SELECT * FROM exams WHERE status = 'PUBLISHED' LIMIT 1").get() ||
                 db.prepare("SELECT * FROM exams LIMIT 1").get();

    let attemptToken = null;
    const regResp = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Load Test Candidate',
        email: `loadtest.${Date.now()}@adyapan.test`,
        phone: '9876543210'
      })
    });
    if (regResp.ok) {
      const regData = await regResp.json();
      attemptToken = regData.token;
      console.log(`Created benchmark attempt token: ${attemptToken.substring(0, 16)}...\n`);
    }

    // Benchmark 1: Concurrency Scaling on /api/health (10, 25, 50, 100 VUs)
    console.log('--- Phase 1: Health Check Concurrency Scaling (10 -> 100 VUs) ---');
    const concurrencies = [10, 25, 50, 100];

    for (const vus of concurrencies) {
      console.log(`Running benchmark: /api/health at ${vus} concurrent connections for 4s...`);
      const result = await runAutocannonAsync({
        url: `${baseUrl}/api/health`,
        connections: vus,
        duration: 4,
        pipelining: 1
      });

      const avgReq = Math.round(result.requests.average || 0);
      const avgLat = `${(result.latency.average || 0).toFixed(1)} ms`;
      const p95Lat = `${(result.latency.p95 || 0).toFixed(1)} ms`;
      const p99Lat = `${(result.latency.p99 || 0).toFixed(1)} ms`;
      const successCount = result['2xx'] || 0;
      const non2xxCount = result.non2xx || 0;
      const error5xx = result['5xx'] || 0;

      benchmarkResults.push([
        'GET /api/health',
        vus,
        '4s',
        avgReq,
        avgLat,
        p95Lat,
        p99Lat,
        successCount,
        non2xxCount,
        error5xx
      ]);

      ok(`Health check under ${vus} VUs completed with 0 server 5xx errors`, error5xx === 0, `(5xx: ${error5xx})`);
      ok(`Health check under ${vus} VUs sustained throughput (>100 req/s)`, avgReq > 100, `(avg: ${avgReq} req/s)`);
      ok(`Health check under ${vus} VUs maintained acceptable p95 latency (<500ms)`, (result.latency.p95 || 0) < 500, `(p95: ${p95Lat})`);
    }

    // Benchmark 2: Public Read Endpoint Under 50 VUs
    console.log('\n--- Phase 2: Public Read Endpoint Under Load (GET /api/config/public) ---');
    console.log('Running benchmark: /api/config/public at 50 concurrent connections for 4s...');
    const configResult = await runAutocannonAsync({
      url: `${baseUrl}/api/config/public`,
      connections: 50,
      duration: 4,
      pipelining: 1
    });

    const cfgAvgReq = Math.round(configResult.requests.average || 0);
    const cfgAvgLat = `${(configResult.latency.average || 0).toFixed(1)} ms`;
    const cfgP95Lat = `${(configResult.latency.p95 || 0).toFixed(1)} ms`;
    const cfgP99Lat = `${(configResult.latency.p99 || 0).toFixed(1)} ms`;
    const cfgSuccess = configResult['2xx'] || 0;
    const cfgNon2xx = configResult.non2xx || 0;
    const cfg5xx = configResult['5xx'] || 0;

    benchmarkResults.push([
      'GET /api/config/public',
      50,
      '4s',
      cfgAvgReq,
      cfgAvgLat,
      cfgP95Lat,
      cfgP99Lat,
      cfgSuccess,
      cfgNon2xx,
      cfg5xx
    ]);

    ok('Public config endpoint under 50 VUs completed with 0 server 5xx errors', cfg5xx === 0);
    ok('Public config endpoint sustained high throughput (>100 req/s)', cfgAvgReq > 100, `(avg: ${cfgAvgReq} req/s)`);
    ok('Public config endpoint maintained low p95 latency (<500ms)', (configResult.latency.p95 || 0) < 500, `(p95: ${cfgP95Lat})`);

    // Benchmark 3: Candidate Assessment Fetch Under Load (25 VUs)
    if (attemptToken) {
      console.log('\n--- Phase 3: Candidate Assessment Fetch Under Load (GET /api/attempt/:token) ---');
      console.log('Running benchmark: /api/attempt/:token at 25 concurrent connections for 4s...');
      const attemptResult = await runAutocannonAsync({
        url: `${baseUrl}/api/attempt/${attemptToken}`,
        connections: 25,
        duration: 4,
        pipelining: 1
      });

      const attAvgReq = Math.round(attemptResult.requests.average || 0);
      const attAvgLat = `${(attemptResult.latency.average || 0).toFixed(1)} ms`;
      const attP95Lat = `${(attemptResult.latency.p95 || 0).toFixed(1)} ms`;
      const attP99Lat = `${(attemptResult.latency.p99 || 0).toFixed(1)} ms`;
      const attSuccess = attemptResult['2xx'] || 0;
      const attNon2xx = attemptResult.non2xx || 0;
      const att5xx = attemptResult['5xx'] || 0;

      benchmarkResults.push([
        'GET /api/attempt/:token',
        25,
        '4s',
        attAvgReq,
        attAvgLat,
        attP95Lat,
        attP99Lat,
        attSuccess,
        attNon2xx,
        att5xx
      ]);

      ok('Attempt fetch endpoint under 25 VUs completed with 0 server 5xx errors', att5xx === 0);
      ok('Attempt fetch endpoint returned 200 responses under load', attSuccess > 0, `(2xx: ${attSuccess})`);
      ok('Attempt fetch endpoint maintained acceptable p95 latency (<1000ms)', (attemptResult.latency.p95 || 0) < 1000, `(p95: ${attP95Lat})`);
    }

    // Benchmark 4: Verification of Rate Limiting and Resilience Under High Burst
    console.log('\n--- Phase 4: Rate Limiting & High Burst Resilience ---');
    console.log('Running burst load test against registration endpoint (50 VUs, 3s)...');
    const burstResult = await runAutocannonAsync({
      url: `${baseUrl}/api/register`,
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        exam_id: 1,
        name: 'Burst Candidate',
        email: 'invalid-email',
        phone: '123'
      }),
      connections: 50,
      duration: 3
    });

    const burst5xx = burstResult['5xx'] || 0;
    benchmarkResults.push([
      'POST /api/register (burst)',
      50,
      '3s',
      Math.round(burstResult.requests.average || 0),
      `${(burstResult.latency.average || 0).toFixed(1)} ms`,
      `${(burstResult.latency.p95 || 0).toFixed(1)} ms`,
      `${(burstResult.latency.p99 || 0).toFixed(1)} ms`,
      burstResult['2xx'] || 0,
      burstResult.non2xx || 0,
      burst5xx
    ]);

    ok('High burst traffic against registration causes zero 500 server crashes', burst5xx === 0, `(5xx count: ${burst5xx})`);
    ok('System handled burst traffic with proper client error responses (4xx/429)', (burstResult.non2xx || 0) > 0);

    // Summary Table
    console.log('\n========================================================================================');
    console.log('AUTOCANNON BENCHMARK PERFORMANCE RESULTS');
    console.log('========================================================================================\n');
    formatTable(benchmarkResults);

  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  }

  console.log('\n====================================================');
  console.log(`LOAD TESTING SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runLoadTests().catch((err) => {
    console.error('Fatal load test error:', err);
    process.exit(1);
  });
}

module.exports = { runLoadTests };
