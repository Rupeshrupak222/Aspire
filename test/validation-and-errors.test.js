// Automated test suite for validation, error handling, structured logging, and security regressions.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3211;
const DB = path.join(os.tmpdir(), `aspire-validation-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
const ADMIN_EMAIL = 'valtest-admin@adyapan.internal';
const ADMIN_PASSWORD = 'ValTestPassword123!';
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

  console.log('[test-val] Starting server on port ' + PORT);
  const proc = spawn('node', ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      AUTH_SECRET: 'valtest-auth-secret-32-chars-long!',
      INITIAL_ADMIN_EMAIL: ADMIN_EMAIL,
      INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
      LOG_LEVEL: 'warn'
    }
  });

  let serverOutput = '';
  proc.stdout?.on('data', (d) => { serverOutput += d; });
  proc.stderr?.on('data', (d) => { serverOutput += d; });

  if (!await waitForServer()) {
    console.error('FAIL: Server failed to start. Output:\n' + serverOutput);
    proc.kill();
    process.exit(1);
  }

  try {
    console.log('\n--- 1. Registration Request Validation ---');
    {
      // Missing name
      const r1 = await api('/api/register', { method: 'POST', body: JSON.stringify({ phone: '9876543210' }) });
      ok('missing name rejected (400)', r1.status === 400);
      ok('error response has success=false', r1.data.success === false);
      ok('error response has code=VALIDATION_ERROR', r1.data.code === 'VALIDATION_ERROR');
      ok('error response has fields.name', !!(r1.data.fields && r1.data.fields.name));

      // Empty name
      const r2 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: '   ', phone: '9876543210' }) });
      ok('empty name rejected (400)', r2.status === 400);

      // Name too long (>120 chars)
      const r3 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'A'.repeat(121), phone: '9876543210' }) });
      ok('oversized name rejected (400)', r3.status === 400);

      // Invalid phone numbers
      const r4 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'Bob', phone: '123' }) });
      ok('short phone rejected (400)', r4.status === 400);
      const r5 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'Bob', phone: 'abc1234567' }) });
      ok('alphanumeric phone rejected (400)', r5.status === 400);
      const r6 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'Bob', phone: '1234567890' }) });
      ok('invalid starting digit phone rejected (400)', r6.status === 400);

      // Invalid email format
      const r7 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'Bob', phone: '9876543210', email: 'not-an-email' }) });
      ok('invalid email format rejected (400)', r7.status === 400);
      ok('email error flagged in fields', !!(r7.data.fields && r7.data.fields.email));

      // Valid registration succeeds
      const r8 = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'Valid Student', phone: '9876543210', email: 'valid@example.com' }) });
      ok('valid registration returns 200', r8.status === 200);
      ok('valid registration returns token', typeof r8.data.token === 'string');
    }

    console.log('\n--- 2. Attempt Token Validation ---');
    {
      // Malformed / short token
      const r1 = await api('/api/attempt/short');
      ok('short token rejected (400)', r1.status === 400);
      ok('token error flagged', r1.data.code === 'VALIDATION_ERROR');

      // Non-existent valid-length token
      const r2 = await api('/api/attempt/0123456789abcdef0123456789abcdef');
      ok('unknown token returns 404', r2.status === 404);
      ok('404 response has code=NOT_FOUND', r2.data.code === 'NOT_FOUND');
    }

    console.log('\n--- 3. Submission Validation & Bounds ---');
    {
      const reg = await api('/api/register', { method: 'POST', body: JSON.stringify({ name: 'Sub Candidate', phone: '9876543211' }) });
      const token = reg.data.token;

      // Oversized code (>64KB)
      const oversizedCode = 'x = 1\n'.repeat(15000); // ~90KB
      const r1 = await api(`/api/attempt/${token}/submit`, {
        method: 'POST',
        body: JSON.stringify({ answers: {}, codeAnswers: { '1': oversizedCode } })
      });
      ok('oversized code submission rejected (400)', r1.status === 400);
      ok('error mentions code size', r1.data.message.includes('64KB') || (r1.data.fields && JSON.stringify(r1.data.fields).includes('64KB')));

      // Negative tabSwitches rejected
      const r2 = await api(`/api/attempt/${token}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ tabSwitches: -5 })
      });
      ok('negative tabSwitches rejected (400)', r2.status === 400);
    }

    console.log('\n--- 4. Admin Validation & RBAC ---');
    {
      // Missing admin token
      const r1 = await api('/api/admin/questions');
      ok('admin request without token returns 401', r1.status === 401);
      ok('401 response has code=AUTHENTICATION_REQUIRED', r1.data.code === 'AUTHENTICATION_REQUIRED');

      // Old admin token rejected
      const rOld = await api('/api/admin/questions', { headers: { 'x-admin-token': 'old-admin-token' } });
      ok('old admin token rejected (401)', rOld.status === 401);

      // Login to obtain valid Bearer token
      const login = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      });
      adminH = { Authorization: `Bearer ${login.data.data.token}` };

      // Non-integer question ID
      const r2 = await api('/api/admin/questions/abc', { method: 'DELETE', headers: adminH });
      ok('non-integer question ID returns 400', r2.status === 400);

      // Question text too long (>10,000 chars)
      const r3 = await api('/api/admin/questions', {
        method: 'POST', headers: adminH,
        body: JSON.stringify({ type: 'mcq', category: 'aptitude', question_text: 'Q'.repeat(10001), options: ['A', 'B'], correct_index: 0 })
      });
      ok('oversized question text returns 400', r3.status === 400);

      // College report without college query param
      const r4 = await api('/api/admin/report/college', { headers: adminH });
      ok('report query without college returns 400', r4.status === 400);
    }

    console.log('\n--- 5. Security Regression & Information Leakage ---');
    {
      // Trigger a 400 and inspect body
      const r1 = await api('/api/register', { method: 'POST', body: JSON.stringify({ phone: '123' }) });
      const raw1 = r1.raw;
      ok('no stack trace in 400 response', !raw1.includes('    at ') && !raw1.includes('node_modules'));
      ok('no SQL syntax in 400 response', !raw1.toLowerCase().includes('select ') && !raw1.toLowerCase().includes('insert into'));
      ok('no file paths in 400 response', !raw1.includes('backend/src') && !raw1.includes('c:\\'));

      // Trigger 404 on API
      const r2 = await api('/api/non-existent-route');
      ok('unknown API route returns 404', r2.status === 404);
      ok('unknown API route has code=NOT_FOUND', r2.data.code === 'NOT_FOUND');
      ok('no internal details in 404', !r2.raw.includes('Cannot GET'));

      // X-Request-Id header check
      const r3 = await api('/api/config/public');
      ok('response includes X-Request-Id header', !!r3.headers.get('x-request-id'));
    }

  } finally {
    proc.kill();
    await wait(400);
    try { fs.unlinkSync(DB); } catch {}
    try { fs.unlinkSync(DB + '-wal'); } catch {}
    try { fs.unlinkSync(DB + '-shm'); } catch {}
  }

  console.log(`\n[test-val] Results: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
