// Judge0 code-execution adapter (server-side only — keys never reach the browser).
// Supports both RapidAPI-hosted Judge0 and self-hosted Judge0 CE.
// API: POST {endpoint}/submissions?base64_encoded=true&wait=true
// Docs: https://ce.judge0.com/  and  https://rapidapi.com/judge0-official/api/judge0-ce
const ENDPOINT = (process.env.JUDGE0_ENDPOINT || '').replace(/\/+$/, '');
const API_KEY = process.env.JUDGE0_API_KEY || '';
const RAPIDAPI_HOST = process.env.JUDGE0_RAPIDAPI_HOST || '';

function isConfigured() {
  return ENDPOINT.length > 0;
}

function status() {
  return {
    configured: isConfigured(),
    mode: !isConfigured() ? 'disabled'
      : RAPIDAPI_HOST ? 'rapidapi' : 'self-hosted',
    endpoint: isConfigured() ? ENDPOINT : null
  };
}

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const unb64 = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    if (RAPIDAPI_HOST) {
      h['x-rapidapi-key'] = API_KEY;
      h['x-rapidapi-host'] = RAPIDAPI_HOST;
    } else {
      h['Authorization'] = `Bearer ${API_KEY}`;
    }
  }
  return h;
}

// Run one submission against Judge0, wait for the verdict.
// Returns { accepted, statusDescription, stdout, stderr, time }
async function runSubmission({ source_code, language_id, stdin = '', expected_output = '', timeoutMs = 15000 }) {
  if (!isConfigured()) throw new Error('Judge0 is not configured (JUDGE0_ENDPOINT missing)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}/submissions?base64_encoded=true&wait=true`, {
      method: 'POST',
      headers: headers(),
      signal: ctrl.signal,
      body: JSON.stringify({
        source_code: b64(source_code),
        language_id,
        stdin: b64(stdin),
        expected_output: b64(expected_output)
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Judge0 HTTP ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const sid = data.status && data.status.id;
    return {
      accepted: sid === 3, // 3 = Accepted
      statusDescription: (data.status && data.status.description) || 'unknown',
      stdout: unb64(data.stdout).trim(),
      stderr: unb64(data.stderr || data.compile_output || ''),
      time: data.time
    };
  } finally {
    clearTimeout(timer);
  }
}

// Grade one code question against its hidden test cases.
// Returns { passed, total, error? }. Any transport error -> error set, partial progress kept.
async function gradeCodeQuestion({ source_code, language_id = 71, test_cases = [] }) {
  const total = test_cases.length;
  let passed = 0;
  for (const tc of test_cases) {
    try {
      const r = await runSubmission({
        source_code,
        language_id,
        stdin: tc.input,
        expected_output: tc.expected
      });
      if (r.accepted) passed++;
    } catch (e) {
      return { passed, total, error: e.message };
    }
  }
  return { passed, total };
}

module.exports = { isConfigured, status, runSubmission, gradeCodeQuestion };
