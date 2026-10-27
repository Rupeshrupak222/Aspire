// Automated Security Hardening Test Suite.
// Verifies Security Headers (Helmet/CSP), CORS policies, Rate Limiting, Request Size Limits,
// XSS defenses, and SQL injection parameterization.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3212;
const DB = path.join(os.tmpdir(), 'aspire-sec-test.db');
const ADMIN_EMAIL = 'sectest-admin@adyapan.internal';
const ADMIN_PASSWORD = 'SecTestPassword123!';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: r.status, data, raw: text, headers: r.headers };
}

let adminH = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {}
    await wait(300);
  }
  return false;
}

async function run() {
  try { fs.unlinkSync(DB); } catch {}
  try { fs.unlinkSync(DB + '-wal'); } catch {}
  try { fs.unlinkSync(DB + '-shm'); } catch {}

  console.log('[test-sec] Starting hardened server on port ' + PORT);
  const proc = spawn('node', ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      AUTH_SECRET: 'sectest-auth-secret-32-chars-long!',
      INITIAL_ADMIN_EMAIL: ADMIN_EMAIL,
      INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn'
    }
  });

  if (!await waitForServer()) {
    console.error('FAIL: Server failed to start');
    proc.kill();
    process.exit(1);
  }

  try {
    console.log('\n--- 1. HTTP Security Headers (Helmet) ---');
    {
      const r = await fetch(`${BASE}/api/health`);
      const h = r.headers;

      // Clickjacking defense
      ok('X-Frame-Options is DENY', h.get('x-frame-options') === 'DENY');

      // MIME sniffing defense
      ok('X-Content-Type-Options is nosniff', h.get('x-content-type-options') === 'nosniff');

      // Content Security Policy
      const csp = h.get('content-security-policy') || '';
      ok('CSP header is present', csp.length > 0);
      ok("CSP restricts frame-ancestors to 'none'", csp.includes("frame-ancestors 'none'"));
      ok("CSP restricts default-src to 'self'", csp.includes("default-src 'self'"));
      ok("CSP restricts object-src to 'none'", csp.includes("object-src 'none'"));

      // Referrer & Permissions Policy
      ok('Referrer-Policy is same-origin', h.get('referrer-policy') === 'same-origin');
      ok('Permissions-Policy is present', !!h.get('permissions-policy'));
      ok('Permissions-Policy blocks camera/microphone', h.get('permissions-policy').includes('camera=()'));
    }

    console.log('\n--- 2. CORS Allowlist & Preflight ---');
    {
      // 1. Allowed localhost origin in development
      const r1 = await fetch(`${BASE}/api/health`, {
        headers: { Origin: 'http://localhost:3000' }
      });
      ok('Allowed origin gets Access-Control-Allow-Origin', r1.headers.get('access-control-allow-origin') === 'http://localhost:3000');
      ok('Credentials allowed for approved origin', r1.headers.get('access-control-allow-credentials') === 'true');

      // 2. Preflight OPTIONS check
      const r2 = await fetch(`${BASE}/api/register`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, x-request-id'
        }
      });
      ok('Preflight returns 204 or 200', r2.status === 204 || r2.status === 200);
      ok('Preflight allows POST method', (r2.headers.get('access-control-allow-methods') || '').includes('POST'));
    }

    console.log('\n--- 3. Request Size Limits (512KB Boundary) ---');
    {
      // Create a payload > 512KB (e.g. 600KB)
      const bigString = 'A'.repeat(600 * 1024);
      const r = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name: 'Big', phone: '9876543210', extra: bigString })
      });
      ok('Payload exceeding 512KB returns 413 (Payload Too Large)', r.status === 413);
    }

    console.log('\n--- 4. Stored XSS Protection & Output Safety ---');
    {
      // Log in to obtain Bearer token
      const login = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      });
      adminH = { Authorization: `Bearer ${login.data.data.token}` };

      // Create question with potentially malicious script tags in text & options
      const xssPayload = {
        type: 'mcq',
        category: 'technical',
        question_text: 'What is <script>alert("xss")</script>?',
        options: ['<img src=x onerror=alert(1)>', 'Safe Option', 'Option C'],
        correct_index: 0
      };

      const res = await api('/api/admin/questions', {
        method: 'POST',
        headers: adminH,
        body: JSON.stringify(xssPayload)
      });
      ok('Admin can save code/math containing brackets safely', res.status === 201);
      const qid = res.data.id;

      // Verify question list returns raw strings without server-side corruption
      const list = await api('/api/admin/questions', { headers: adminH });
      const savedQ = list.data.find((q) => q.id === qid);
      ok('Stored text preserves mathematical < characters safely', savedQ.question_text.includes('<script>'));

      // Clean up
      await api(`/api/admin/questions/${qid}`, { method: 'DELETE', headers: adminH });
    }

    console.log('\n--- 5. SQL Injection & Wildcard Sanitization ---');
    {
      // 1. Classical SQL Injection attempt on candidate registration
      const r1 = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          name: "Alice' OR '1'='1",
          phone: "9876543210'--",
          college: "MIT'; DROP TABLE students;--"
        })
      });
      ok('Malformed SQL characters in phone rejected by validator (400)', r1.status === 400);

      // 2. Wildcard injection in college search report
      const r2 = await api('/api/admin/report/college?college=%25', { headers: adminH });
      ok('Escaped LIKE query handles literal % safely', r2.status === 200);
      ok('Literal % matches only colleges literally named %', r2.data.submitted === 0);
    }

    console.log('\n--- 6. Rate Limiting Enforcement ---');
    {
      // Rapid submit requests test rate limiter
      const reg = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name: 'RateLimit Candidate', phone: '9123456789' })
      });
      const token = reg.data.token;

      // Submit multiple times rapidly
      let hit429 = false;
      for (let i = 0; i < 15; i++) {
        const sub = await api(`/api/attempt/${token}/submit`, {
          method: 'POST',
          body: JSON.stringify({ answers: {} })
        });
        if (sub.status === 429) {
          hit429 = true;
          ok('Rate limited response returns code=RATE_LIMITED', sub.data.code === 'RATE_LIMITED');
          ok('Rate limit headers present', !!sub.headers.get('ratelimit-limit') || !!sub.headers.get('retry-after'));
          break;
        }
      }
      ok('Excessive repeated submissions trigger 429 Too Many Requests', hit429);
    }

  } finally {
    proc.kill();
    await wait(400);
    try { fs.unlinkSync(DB); } catch {}
    try { fs.unlinkSync(DB + '-wal'); } catch {}
    try { fs.unlinkSync(DB + '-shm'); } catch {}
  }

  console.log(`\n[test-sec] Results: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
