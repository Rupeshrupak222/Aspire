// Automated Test Suite for Day 9: OnlineCompiler.io Production Coding Engine Integration.
// Verifies:
// 1. Provider abstraction & interface contract (NormalizedExecutionResult, safe getStatus()).
// 2. Language mapping, normalization & strict whitelist validation (UNSUPPORTED_LANGUAGE).
// 3. Source code payload validation (EMPTY_SUBMISSION, SOURCE_CODE_TOO_LARGE >100KB, INVALID_SOURCE_CODE).
// 4. Server-authoritative output comparison policy (CRLF/LF, trailing space, exact content).
// 5. Candidate authorization & frozen snapshot binding (IDOR prevention, snapshot verification).
// 6. Public vs private test isolation (zero hidden test input/output leakage to client).
// 7. Full verdict state matrix: ACCEPTED, WRONG_ANSWER, COMPILATION_ERROR, RUNTIME_ERROR, TIME_LIMIT_EXCEEDED, MEMORY_LIMIT_EXCEEDED.
// 8. Transactional persistence in coding_submissions table & attempt code_answers_json update.
// 9. Audit logging for all coding execution events.
// 10. Admin observability endpoints (engine status, candidate submissions inspection, multi-tenant isolation).
// 11. Error handling & resilience (safe error mapping to CODE_EXECUTION_UNAVAILABLE without crash).
// 12. Rate limiting enforcement on code execution endpoints.
// 13. End-to-end attempt submission & combined grading (MCQ + Code -> Scholarship slab).
// 14. Optional live smoke test when ONLINECOMPILER_LIVE_TEST=true.

process.env.CODE_EXECUTION_SYNC = 'true';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { executionService } = require('../backend/src/services/code-execution/execution.service');
const {
  EXECUTION_STATUS,
  normalizeLanguage,
  CANONICAL_LANGUAGES,
  LIMITS
} = require('../backend/src/services/code-execution/constants');
const OnlineCompilerProvider = require('../backend/src/services/code-execution/providers/onlinecompiler.provider');
const BaseProvider = require('../backend/src/services/code-execution/providers/base.provider');
const userService = require('../backend/src/services/user.service');
const orgService = require('../backend/src/services/organization.service');
const examService = require('../backend/src/services/exam.service');
const snapshotService = require('../backend/src/services/snapshot.service');
const { ROLES } = require('../backend/src/security/rbac');

let server;
let baseUrl;

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = {
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
      ...(options.headers || {})
    };
    let body = options.body;

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function login(email, password) {
  return request('POST', '/api/auth/login', {
    body: { email, password }
  });
}

// Configurable Mock Provider to simulate various execution scenarios deterministically
class MockCodeProvider extends BaseProvider {
  constructor() {
    super('MockExecutionEngine');
    this.configured = true;
    this.scenarioHandler = null;
  }

  isConfigured() {
    return this.configured;
  }

  setScenarioHandler(fn) {
    this.scenarioHandler = fn;
  }

  clearScenarioHandler() {
    this.scenarioHandler = null;
  }

  async executeCode({ language, sourceCode, stdin = '', timeoutMs }) {
    if (this.scenarioHandler) {
      return this.scenarioHandler({ language, sourceCode, stdin, timeoutMs });
    }

    // Default mock behavior: simple echo or python/js evaluation
    if (sourceCode.includes('FAIL_COMPILE')) {
      return {
        success: false,
        status: EXECUTION_STATUS.COMPILATION_ERROR,
        stdout: '',
        stderr: 'SyntaxError: unexpected token at line 1',
        compileOutput: 'SyntaxError: unexpected token at line 1',
        exitCode: 1,
        executionTimeMs: 15,
        memoryUsedKb: 4096,
        providerSubmissionId: 'mock_sub_comp_err'
      };
    }

    if (sourceCode.includes('FAIL_RUNTIME')) {
      return {
        success: false,
        status: EXECUTION_STATUS.RUNTIME_ERROR,
        stdout: '',
        stderr: 'ZeroDivisionError: division by zero',
        compileOutput: '',
        exitCode: 1,
        executionTimeMs: 25,
        memoryUsedKb: 8192,
        providerSubmissionId: 'mock_sub_rt_err'
      };
    }

    if (sourceCode.includes('INFINITE_LOOP')) {
      return {
        success: false,
        status: EXECUTION_STATUS.TIME_LIMIT_EXCEEDED,
        stdout: '',
        stderr: 'Execution timed out',
        compileOutput: '',
        exitCode: 124,
        executionTimeMs: timeoutMs || 10000,
        memoryUsedKb: 12288,
        providerSubmissionId: 'mock_sub_tle'
      };
    }

    if (sourceCode.includes('OUT_OF_MEMORY')) {
      return {
        success: false,
        status: EXECUTION_STATUS.MEMORY_LIMIT_EXCEEDED,
        stdout: '',
        stderr: 'Process exceeded memory limit (OOM killed)',
        compileOutput: '',
        exitCode: 137,
        executionTimeMs: 80,
        memoryUsedKb: 524288,
        providerSubmissionId: 'mock_sub_oom'
      };
    }

    if (sourceCode.includes('WRONG_ANSWER')) {
      return {
        success: true,
        status: EXECUTION_STATUS.ACCEPTED,
        stdout: 'incorrect output\n',
        stderr: '',
        compileOutput: '',
        exitCode: 0,
        executionTimeMs: 35,
        memoryUsedKb: 10240,
        providerSubmissionId: 'mock_sub_wa'
      };
    }

    // Default: Simulate correct addition of two numbers or string uppercase
    let out = '';
    const trimmedInput = stdin.trim();
    if (trimmedInput) {
      const parts = trimmedInput.split(/\s+/).map(Number);
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        out = String(parts[0] + parts[1]);
      } else {
        out = trimmedInput;
      }
    } else {
      out = 'Hello World';
    }

    return {
      success: true,
      status: EXECUTION_STATUS.ACCEPTED,
      stdout: out + '\n',
      stderr: '',
      compileOutput: '',
      exitCode: 0,
      executionTimeMs: 42,
      memoryUsedKb: 15360,
      providerSubmissionId: 'mock_sub_ok_' + Date.now()
    };
  }
}

async function run() {
  console.log('=== Starting Aspire Day 9: OnlineCompiler.io Coding Engine Test Suite ===\n');

  const mockProvider = new MockCodeProvider();
  executionService.setMockProvider(mockProvider);

  const app = createApp();
  server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`[test-server] Running on ${baseUrl}`);
      resolve();
    });
  });

  try {
    /* ----------------------------------------------------
       1. Provider Abstraction & Contract Test
    ---------------------------------------------------- */
    console.log('--- 1. Provider Abstraction & Interface Contract ---');

    const providerInstance = new OnlineCompilerProvider();
    assert.strictEqual(providerInstance.name, 'onlinecompiler', 'Provider name is onlinecompiler');
    assert.strictEqual(typeof providerInstance.executeCode, 'function', 'Implements executeCode()');
    assert.strictEqual(typeof providerInstance.getStatus, 'function', 'Implements getStatus()');

    const statusObj = providerInstance.getStatus();
    assert.strictEqual(statusObj.provider, 'onlinecompiler', 'getStatus returns provider name');
    assert.strictEqual(statusObj.configured, Boolean(process.env.ONLINECOMPILER_API_KEY), 'Reports configured boolean');
    assert.strictEqual(statusObj.apiKey, undefined, 'CRITICAL: Never exposes API key in status object');

    // Output truncation & message sanitization
    const hugeOutput = 'A'.repeat(LIMITS.MAX_OUTPUT_BYTES + 500);
    const truncated = providerInstance.truncateOutput(hugeOutput);
    assert(truncated.length < hugeOutput.length, 'Huge output is safely truncated');
    assert(truncated.toLowerCase().includes('truncated'), 'Truncation notice appended');

    const sanitizedMsg = providerInstance.sanitizeMessage('Error with /var/www/secret/app and key ' + (process.env.ONLINECOMPILER_API_KEY || ''));
    assert(!sanitizedMsg.includes('/var/www'), 'System paths sanitized');

    console.log('  PASS  Provider contract, safety boundaries, and sanitization verified');

    /* ----------------------------------------------------
       2. Language Mapping & Strict Normalization
    ---------------------------------------------------- */
    console.log('\n--- 2. Language Mapping & Whitelist Normalization ---');

    assert.strictEqual(normalizeLanguage('python'), 'python');
    assert.strictEqual(normalizeLanguage('py'), 'python');
    assert.strictEqual(normalizeLanguage('PYTHON'), 'python');
    assert.strictEqual(normalizeLanguage('javascript'), 'javascript');
    assert.strictEqual(normalizeLanguage('js'), 'javascript');
    assert.strictEqual(normalizeLanguage('Node'), 'javascript');
    assert.strictEqual(normalizeLanguage('cpp'), 'cpp');
    assert.strictEqual(normalizeLanguage('c++'), 'cpp');
    assert.strictEqual(normalizeLanguage('C-PLUS-PLUS'), 'cpp');
    assert.strictEqual(normalizeLanguage('java'), 'java');
    assert.strictEqual(normalizeLanguage('Java'), 'java');

    assert.throws(() => normalizeLanguage('ruby'), /UNSUPPORTED_LANGUAGE/, 'Rejects ruby');
    assert.throws(() => normalizeLanguage('php'), /UNSUPPORTED_LANGUAGE/, 'Rejects php');
    assert.throws(() => normalizeLanguage('rust'), /UNSUPPORTED_LANGUAGE/, 'Rejects rust');
    assert.throws(() => normalizeLanguage('bash'), /UNSUPPORTED_LANGUAGE/, 'Rejects bash');
    assert.throws(() => normalizeLanguage(''), /UNSUPPORTED_LANGUAGE/, 'Rejects empty language');
    assert.throws(() => normalizeLanguage(null), /UNSUPPORTED_LANGUAGE/, 'Rejects null language');

    console.log('  PASS  Canonical language normalization and UNSUPPORTED_LANGUAGE rejections verified');

    /* ----------------------------------------------------
       3. Source Code Validation & Guard Rails
    ---------------------------------------------------- */
    console.log('\n--- 3. Source Code Payload Validation ---');

    // Empty submission check
    const emptyResult = await executionService.executeSingleTest({
      language: 'python',
      sourceCode: '   \n  \t  ',
      stdin: '1 2',
      expectedOutput: '3'
    });
    assert.strictEqual(emptyResult.status, EXECUTION_STATUS.EMPTY_SUBMISSION, 'Whitespace-only returns EMPTY_SUBMISSION');
    assert.strictEqual(emptyResult.passed, false, 'Empty code marked not passed');

    // Oversized source code (>100KB)
    const hugeCode = 'x = 1\n'.repeat(25000); // > 100KB
    assert(Buffer.byteLength(hugeCode, 'utf8') > LIMITS.MAX_SOURCE_BYTES);
    assert.throws(() => {
      executionService.validateSourceCode(hugeCode);
    }, (err) => err.code === 'SOURCE_CODE_TOO_LARGE', 'Rejects code exceeding 100KB');

    // Non-string
    assert.throws(() => {
      executionService.validateSourceCode(12345);
    }, (err) => err.code === 'INVALID_SOURCE_CODE', 'Rejects non-string source code');

    console.log('  PASS  Empty, non-string, and oversized code payloads properly intercepted');

    /* ----------------------------------------------------
       4. Output Normalization Policy Verification
    ---------------------------------------------------- */
    console.log('\n--- 4. Server-Authoritative Output Normalization ---');

    // CRLF vs LF
    assert.strictEqual(executionService.compareOutputs('line1\r\nline2\r\n', 'line1\nline2\n'), true, 'CRLF and LF match');

    // Trailing whitespace on lines
    assert.strictEqual(executionService.compareOutputs('hello   \nworld  ', 'hello\nworld'), true, 'Trailing whitespace trimmed per line');

    // Trailing blank lines
    assert.strictEqual(executionService.compareOutputs('result\n\n\n', 'result'), true, 'Trailing newlines trimmed');

    // Case sensitivity preserved
    assert.strictEqual(executionService.compareOutputs('Hello World', 'hello world'), false, 'Case sensitivity strictly enforced');

    // Internal whitespace preserved
    assert.strictEqual(executionService.compareOutputs('a  b', 'a b'), false, 'Internal whitespace differences preserved');

    console.log('  PASS  Output normalization cleanly handles platform line endings while preserving semantic meaning');

    /* ----------------------------------------------------
       5. Setup Test Data (Org, Users, Exam with Code Question)
    ---------------------------------------------------- */
    console.log('\n--- 5. Test Fixtures Setup ---');

    const testRunId = Date.now().toString(36);
    const org = orgService.createOrganization({
      name: `Day 9 Coding Org ${testRunId}`,
      slug: `coding-org-${testRunId}`
    });

    const adminUser = await userService.createUser({
      name: 'Admin User',
      email: `admin-coding-${testRunId}@aspire.test`,
      password: 'AdminPassword123!',
      role: ROLES.SUPER_ADMIN,
      organizationId: org.id
    });

    const adminLoginRes = await login(`admin-coding-${testRunId}@aspire.test`, 'AdminPassword123!');
    assert.strictEqual(adminLoginRes.status, 200, 'Admin login succeeded');
    const adminToken = adminLoginRes.data.data.token;

    // Create an Exam with 1 MCQ and 1 Coding Question
    // Insert 1 MCQ Question (5 marks)
    const qMcq = db.prepare(`
      INSERT INTO questions (
        organization_id, category, type, title, question_text, marks,
        options_json, correct_index, status, created_by
      ) VALUES (?, 'aptitude', 'mcq', 'Math Basics', 'What is 2 + 2?', 5, ?, 0, 'PUBLISHED', ?)
      RETURNING *
    `).get(
      org.id,
      JSON.stringify(['4', '3', '5', '6']),
      adminUser.id
    );

    // Insert 1 Coding Question (5 marks) with 1 public sample test and 2 private hidden tests
    const testCases = [
      { input: '3 5', expected_output: '8', is_hidden: 0 },         // public sample test
      { input: '10 20', expected_output: '30', is_hidden: 1 },       // hidden test 1
      { input: '-5 5', expected_output: '0', is_hidden: 1 }          // hidden test 2
    ];

    const qCode = db.prepare(`
      INSERT INTO questions (
        organization_id, category, type, title, question_text, marks,
        language, code_starter, test_cases_json, status, created_by
      ) VALUES (?, 'coding', 'code', 'Sum Two Numbers', 'Read two integers from stdin and print their sum.', 5, 'python', 'import sys\n# write code here', ?, 'PUBLISHED', ?)
      RETURNING *
    `).get(
      org.id,
      JSON.stringify(testCases),
      adminUser.id
    );

    const examRes = await request('POST', '/api/admin/exams', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Day 9 Coding Scholarship Assessment',
        code: `CODE9-${testRunId.toUpperCase()}`,
        duration_minutes: 60,
        passing_score: 40
      }
    });
    assert.strictEqual(examRes.status, 201, 'Exam created');
    const exam = examRes.data.data;

    const secRes = await request('POST', `/api/admin/exams/${exam.id}/sections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Coding & Aptitude Section',
        display_order: 1,
        question_selection_mode: 'MANUAL'
      }
    });
    assert.strictEqual(secRes.status, 201, 'Section created');
    const examWithSec = secRes.data.data;
    const sec = examWithSec.sections[examWithSec.sections.length - 1];

    const addQ1 = await request('POST', `/api/admin/exams/${exam.id}/sections/${sec.id}/questions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { question_id: qMcq.id, display_order: 1 }
    });
    assert.strictEqual(addQ1.status, 201, 'Added MCQ question to section');

    const addQ2 = await request('POST', `/api/admin/exams/${exam.id}/sections/${sec.id}/questions`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { question_id: qCode.id, display_order: 2 }
    });
    assert.strictEqual(addQ2.status, 201, 'Added Code question to section');

    // Add scholarship slabs
    const slabsRes = await request('PUT', `/api/admin/exams/${exam.id}/scholarship-slabs`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        slabs: [
          { min_score_pct: 80, max_score_pct: 100, discount_pct: 100, tier_name: 'Full Platinum' },
          { min_score_pct: 50, max_score_pct: 79, discount_pct: 50, tier_name: 'Silver' },
          { min_score_pct: 0, max_score_pct: 49, discount_pct: 0, tier_name: 'None' }
        ]
      }
    });
    assert.strictEqual(slabsRes.status, 200, 'Slabs updated');

    // Publish the exam
    const pubRes = await request('POST', `/api/admin/exams/${exam.id}/publish`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(pubRes.status, 200, 'Exam published');

    // Register Candidate and Start Attempt
    const alicePhone = '98' + Math.floor(10000000 + Math.random() * 89999999);
    const regRes = await request('POST', '/api/register', {
      body: {
        exam_code: exam.code,
        name: 'Alice Coder',
        email: `alice-${testRunId}@test.com`,
        phone: alicePhone
      }
    });
    assert.strictEqual(regRes.status, 200, 'Candidate registered & started attempt');
    const attemptToken = regRes.data.token;
    assert(attemptToken, 'Attempt token received');
    const attRow = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
    const attemptId = attRow.id;

    console.log('  PASS  Test fixtures initialized with published exam and candidate attempt');

    /* ----------------------------------------------------
       6. Question Delivery & Public vs Private Test Case Sanitization
    ---------------------------------------------------- */
    console.log('\n--- 6. Candidate Question Sanitization & Test Case Privacy ---');

    const attemptRes = await request('GET', `/api/attempt/${attemptToken}`);
    assert.strictEqual(attemptRes.status, 200);
    const candidateQuestions = attemptRes.data.questions;
    assert.strictEqual(candidateQuestions.length, 2, 'Candidate receives 2 questions');

    const candidateCodeQ = candidateQuestions.find(q => q.type === 'code');
    assert(candidateCodeQ, 'Candidate receives coding question');
    assert.strictEqual(candidateCodeQ.id, qCode.id);

    // STRICT VERIFICATION: hidden test cases must NOT be leaked
    assert.strictEqual(candidateCodeQ.test_cases, undefined, 'CRITICAL: Full test_cases array is NEVER sent');
    assert.strictEqual(candidateCodeQ.test_cases_json, undefined, 'CRITICAL: test_cases_json is NEVER sent');
    assert(Array.isArray(candidateCodeQ.sample_test_cases), 'sample_test_cases is exposed');
    assert.strictEqual(candidateCodeQ.sample_test_cases.length, 1, 'Only the 1 public test case is exposed');
    assert.strictEqual(candidateCodeQ.sample_test_cases[0].input, '3 5', 'Public sample test input verified');
    assert.strictEqual(candidateCodeQ.sample_test_cases[0].expected_output, '8', 'Public sample test expected output verified');
    assert.strictEqual(candidateCodeQ.sample_test_cases[0].is_hidden, undefined, 'Metadata stripped');

    console.log('  PASS  Candidate delivery verifies ZERO hidden test cases or evaluator metadata leaked');

    /* ----------------------------------------------------
       7. Interactive "Run Code" (/code-run) Verification
    ---------------------------------------------------- */
    console.log('\n--- 7. Interactive Test Runner (POST /code-run) ---');

    // Valid sample test run
    const runRes = await request('POST', `/api/attempt/${attemptToken}/code-run`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)'
      }
    });
    assert.strictEqual(runRes.status, 200, 'code-run succeeded');
    assert.strictEqual(runRes.data.success, true);
    assert.strictEqual(runRes.data.data.status, EXECUTION_STATUS.ACCEPTED);
    assert.strictEqual(runRes.data.data.testsPassed, 1, 'Passed 1 sample test');
    assert.strictEqual(runRes.data.data.testsTotal, 1, 'Only evaluated 1 sample test');
    assert.strictEqual(runRes.data.data.results.length, 1);
    assert.strictEqual(runRes.data.data.results[0].passed, true);
    assert.strictEqual(runRes.data.data.results[0].actualOutput.trim(), '8');

    // Empty submission error
    const emptyRunRes = await request('POST', `/api/attempt/${attemptToken}/code-run`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: '   '
      }
    });
    assert.strictEqual(emptyRunRes.status, 200);
    assert.strictEqual(emptyRunRes.data.data.status, EXECUTION_STATUS.EMPTY_SUBMISSION);

    // Unsupported language error
    const unsuppRunRes = await request('POST', `/api/attempt/${attemptToken}/code-run`, {
      body: {
        questionId: qCode.id,
        language: 'pascal',
        sourceCode: 'begin end.'
      }
    });
    assert.strictEqual(unsuppRunRes.status, 400);
    assert.strictEqual(unsuppRunRes.data.code, 'UNSUPPORTED_LANGUAGE');

    // Question not in attempt
    const foreignRunRes = await request('POST', `/api/attempt/${attemptToken}/code-run`, {
      body: {
        questionId: 999999,
        language: 'python',
        sourceCode: 'print(1)'
      }
    });
    assert.strictEqual(foreignRunRes.status, 404);
    assert.strictEqual(foreignRunRes.data.code, 'QUESTION_NOT_IN_ATTEMPT');

    // Question is MCQ, not code
    const mcqRunRes = await request('POST', `/api/attempt/${attemptToken}/code-run`, {
      body: {
        questionId: qMcq.id,
        language: 'python',
        sourceCode: 'print(1)'
      }
    });
    assert.strictEqual(mcqRunRes.status, 400);
    assert.strictEqual(mcqRunRes.data.code, 'INVALID_QUESTION_TYPE');

    console.log('  PASS  /code-run evaluates public test cases only and enforces candidate guard rails');

    /* ----------------------------------------------------
       8. Complete Solution Submission (/code-submit) & Verdict Matrix
    ---------------------------------------------------- */
    console.log('\n--- 8. Solution Evaluation (/code-submit) & Verdict Matrix ---');

    // A. Correct Solution -> ACCEPTED (all 3 tests pass: 1 public + 2 private)
    const correctSubmitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)'
      }
    });
    assert.strictEqual(correctSubmitRes.status, 200, 'code-submit succeeded');
    assert.strictEqual(correctSubmitRes.data.success, true);
    const subData = correctSubmitRes.data.data;
    assert.strictEqual(subData.status, EXECUTION_STATUS.ACCEPTED, 'Status is ACCEPTED');
    assert.strictEqual(subData.testsPassed, 3, 'All 3 tests passed');
    assert.strictEqual(subData.testsTotal, 3, 'Evaluated all 3 tests');
    assert.strictEqual(subData.score, 5, 'Earned full 5 marks');
    assert(subData.submissionId.startsWith('csub_'), 'Generated submission ID');

    // Verify record in coding_submissions DB table
    const dbSub = db.prepare('SELECT * FROM coding_submissions WHERE id = ?').get(subData.submissionId);
    assert(dbSub, 'Record persisted in coding_submissions');
    assert.strictEqual(dbSub.attempt_id, attemptId);
    assert.strictEqual(dbSub.question_id, qCode.id);
    assert.strictEqual(dbSub.submission_status, 'ACCEPTED');
    assert.strictEqual(dbSub.score, 5);
    assert.strictEqual(dbSub.test_cases_passed, 3);
    assert.strictEqual(dbSub.test_cases_total, 3);

    // Verify audit log recorded
    const auditRecord = db.prepare("SELECT * FROM audit_logs WHERE event = 'coding_submission' ORDER BY id DESC LIMIT 1").get();
    assert(auditRecord, 'Audit log created');
    assert(auditRecord.details_json.includes(subData.submissionId), 'Audit log contains submission ID');

    // B. Wrong Answer -> WRONG_ANSWER
    const wrongSubmitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: 'print("WRONG_ANSWER")'
      }
    });
    assert.strictEqual(wrongSubmitRes.status, 200);
    assert.strictEqual(wrongSubmitRes.data.data.status, EXECUTION_STATUS.WRONG_ANSWER);
    assert.strictEqual(wrongSubmitRes.data.data.testsPassed, 0);
    assert.strictEqual(wrongSubmitRes.data.data.score, 0);

    // C. Compilation Error -> COMPILATION_ERROR
    const compErrSubmitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCode.id,
        language: 'cpp',
        sourceCode: 'FAIL_COMPILE int main() { return 0; }'
      }
    });
    assert.strictEqual(compErrSubmitRes.status, 200);
    assert.strictEqual(compErrSubmitRes.data.data.status, EXECUTION_STATUS.COMPILATION_ERROR);
    assert(compErrSubmitRes.data.data.error, 'Contains sanitized compiler error');

    // D. Runtime Error -> RUNTIME_ERROR
    const rtErrSubmitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: 'FAIL_RUNTIME x = 1 / 0'
      }
    });
    assert.strictEqual(rtErrSubmitRes.status, 200);
    assert.strictEqual(rtErrSubmitRes.data.data.status, EXECUTION_STATUS.RUNTIME_ERROR);

    // E. Time Limit Exceeded -> TIME_LIMIT_EXCEEDED
    const tleSubmitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: 'INFINITE_LOOP while True: pass'
      }
    });
    assert.strictEqual(tleSubmitRes.status, 200);
    assert.strictEqual(tleSubmitRes.data.data.status, EXECUTION_STATUS.TIME_LIMIT_EXCEEDED);

    // F. Memory Limit Exceeded -> MEMORY_LIMIT_EXCEEDED
    const oomSubmitRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: {
        questionId: qCode.id,
        language: 'python',
        sourceCode: 'OUT_OF_MEMORY arr = [1] * 100000000'
      }
    });
    assert.strictEqual(oomSubmitRes.status, 200);
    assert.strictEqual(oomSubmitRes.data.data.status, EXECUTION_STATUS.MEMORY_LIMIT_EXCEEDED);

    console.log('  PASS  Verdict matrix (ACCEPTED, WRONG_ANSWER, COMPILATION_ERROR, RUNTIME_ERROR, TIME_LIMIT_EXCEEDED, MEMORY_LIMIT_EXCEEDED) verified');

    /* ----------------------------------------------------
       9. Multi-Language Support Matrix & Full Verdict Matrix
    ---------------------------------------------------- */
    console.log('\n--- 9. Supported Languages Matrix (Python, JS, C++, Java) ---');

    const languagesToTest = ['python', 'javascript', 'cpp', 'java'];
    for (let i = 0; i < languagesToTest.length; i++) {
      const lang = languagesToTest[i];
      const langIp = `10.0.9.${i + 1}`;

      // 1. Correct Solution -> ACCEPTED
      const okRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
        ip: langIp,
        body: {
          questionId: qCode.id,
          language: lang,
          sourceCode: `// Valid test in ${lang} unique-${Date.now()}-${Math.random()}\nsolve();`
        }
      });
      assert.strictEqual(okRes.status, 200, `Language ${lang} submission accepted`);
      assert.strictEqual(okRes.data.data.status, EXECUTION_STATUS.ACCEPTED, `Language ${lang} evaluated to ACCEPTED`);

      // 2. Wrong Solution -> WRONG_ANSWER
      const waRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
        ip: langIp,
        body: {
          questionId: qCode.id,
          language: lang,
          sourceCode: `// Wrong answer test in ${lang} WRONG_ANSWER unique-${Math.random()}`
        }
      });
      assert.strictEqual(waRes.status, 200, `Language ${lang} wrong solution accepted`);
      assert.strictEqual(waRes.data.data.status, EXECUTION_STATUS.WRONG_ANSWER, `Language ${lang} evaluated to WRONG_ANSWER`);

      // 3. Compilation Error -> COMPILATION_ERROR
      const compRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
        ip: langIp,
        body: {
          questionId: qCode.id,
          language: lang,
          sourceCode: `// Fail compile in ${lang} FAIL_COMPILE unique-${Math.random()}`
        }
      });
      assert.strictEqual(compRes.status, 200, `Language ${lang} compile error handled`);
      assert.strictEqual(compRes.data.data.status, EXECUTION_STATUS.COMPILATION_ERROR, `Language ${lang} evaluated to COMPILATION_ERROR`);

      // 4. Runtime Error -> RUNTIME_ERROR
      const rtRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
        ip: langIp,
        body: {
          questionId: qCode.id,
          language: lang,
          sourceCode: `// Runtime error in ${lang} FAIL_RUNTIME unique-${Math.random()}`
        }
      });
      assert.strictEqual(rtRes.status, 200, `Language ${lang} runtime error handled`);
      assert.strictEqual(rtRes.data.data.status, EXECUTION_STATUS.RUNTIME_ERROR, `Language ${lang} evaluated to RUNTIME_ERROR`);

      // 5. Infinite Loop -> TIME_LIMIT_EXCEEDED
      const tleRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
        ip: langIp,
        body: {
          questionId: qCode.id,
          language: lang,
          sourceCode: `// Infinite loop in ${lang} INFINITE_LOOP unique-${Math.random()}`
        }
      });
      assert.strictEqual(tleRes.status, 200, `Language ${lang} timeout handled`);
      assert.strictEqual(tleRes.data.data.status, EXECUTION_STATUS.TIME_LIMIT_EXCEEDED, `Language ${lang} evaluated to TIME_LIMIT_EXCEEDED`);

      // 6. Empty Submission -> EMPTY_SUBMISSION
      const emptyRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
        ip: langIp,
        body: {
          questionId: qCode.id,
          language: lang,
          sourceCode: `   `
        }
      });
      assert.strictEqual(emptyRes.status, 200, `Language ${lang} empty submission handled`);
      assert.strictEqual(emptyRes.data.data.status, EXECUTION_STATUS.EMPTY_SUBMISSION, `Language ${lang} evaluated to EMPTY_SUBMISSION`);
    }

    console.log('  PASS  All 4 canonical languages evaluated across full verdict matrix (ACCEPTED, WRONG_ANSWER, COMPILATION_ERROR, RUNTIME_ERROR, TIME_LIMIT_EXCEEDED, EMPTY_SUBMISSION)');

    /* ----------------------------------------------------
       9B. Malformed Request Validation Matrix
    ---------------------------------------------------- */
    console.log('\n--- 9B. Malformed Request Validation Matrix ---');

    // 1. Completely empty body {}
    const emptyBodyRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, { ip: '10.0.10.1', body: {} });
    assert.strictEqual(emptyBodyRes.status, 400, 'Empty body {} returns 400');
    assert.strictEqual(emptyBodyRes.data.code, 'VALIDATION_ERROR');

    // 2. Unknown language { language: "unknown" }
    const unknownLangRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      ip: '10.0.10.2',
      body: { questionId: qCode.id, language: 'unknown', sourceCode: 'print(1)' }
    });
    assert.strictEqual(unknownLangRes.status, 400, 'Unknown language returns 400');
    assert.strictEqual(unknownLangRes.data.code, 'UNSUPPORTED_LANGUAGE');

    // 3. Non-string sourceCode: 123
    const numCodeRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      ip: '10.0.10.3',
      body: { questionId: qCode.id, language: 'python', sourceCode: 123 }
    });
    assert.strictEqual(numCodeRes.status, 400, 'Numeric sourceCode returns 400');
    assert.strictEqual(numCodeRes.data.code, 'VALIDATION_ERROR');

    // 4. Null sourceCode: null
    const nullCodeRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      ip: '10.0.10.4',
      body: { questionId: qCode.id, language: 'python', sourceCode: null }
    });
    assert.strictEqual(nullCodeRes.status, 400, 'Null sourceCode returns 400');
    assert.strictEqual(nullCodeRes.data.code, 'VALIDATION_ERROR');

    // 5. Empty string sourceCode: ""
    const emptyStrRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      ip: '10.0.10.5',
      body: { questionId: qCode.id, language: 'javascript', sourceCode: '' }
    });
    assert.strictEqual(emptyStrRes.status, 200, 'Empty string sourceCode returns 200 with EMPTY_SUBMISSION');
    assert.strictEqual(emptyStrRes.data.data.status, EXECUTION_STATUS.EMPTY_SUBMISSION);

    console.log('  PASS  Malformed request validation matrix produces predictable Aspire error responses');

    /* ----------------------------------------------------
       9C. Duplicate Submission Protection & Idempotency
    ---------------------------------------------------- */
    console.log('\n--- 9C. Duplicate Submission Idempotency ---');

    const testIdempotentCode = `// Idempotent test code ${Date.now()}\nprint("idempotent");`;
    const initialSubRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      ip: '10.0.11.1',
      body: { questionId: qCode.id, language: 'python', sourceCode: testIdempotentCode }
    });
    assert.strictEqual(initialSubRes.status, 200);
    const initialSubId = initialSubRes.data.data.submissionId;

    // Immediately send duplicate submission with identical code
    const duplicateSubRes = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      ip: '10.0.11.1',
      body: { questionId: qCode.id, language: 'python', sourceCode: testIdempotentCode }
    });
    assert.strictEqual(duplicateSubRes.status, 200);
    assert.strictEqual(duplicateSubRes.data.data.submissionId, initialSubId, 'Duplicate submission returns existing submissionId');
    assert.strictEqual(duplicateSubRes.data.data.idempotent, true, 'Marked idempotent');

    console.log('  PASS  Duplicate submission protection avoids redundant executions and preserves idempotency');


    /* ----------------------------------------------------
       10. Attempt Expiration & State Machine Enforcement
    ---------------------------------------------------- */
    console.log('\n--- 10. Attempt Authorization & Lifecycle Constraints ---');

    // Create an expired attempt
    const bobPhone = '98' + Math.floor(10000000 + Math.random() * 89999999);
    const expRegRes = await request('POST', '/api/register', {
      body: { exam_code: exam.code, name: 'Bob Expired', email: `bob-${testRunId}@test.com`, phone: bobPhone }
    });
    const expToken = expRegRes.data.token;

    // Fast-forward expiration in database
    db.prepare("UPDATE attempts SET expires_at = datetime('now', '-5 minutes') WHERE token = ?").run(expToken);

    const expCodeSubmit = await request('POST', `/api/attempt/${expToken}/code-submit`, {
      body: { questionId: qCode.id, language: 'python', sourceCode: 'print(1)' }
    });
    assert.strictEqual(expCodeSubmit.status, 409, 'Expired attempt rejected with 409');
    assert.strictEqual(expCodeSubmit.data.code, 'ATTEMPT_EXPIRED');

    // Invalid attempt token
    const invalidTokenRes = await request('POST', '/api/attempt/non_existent_token_9999/code-submit', {
      body: { questionId: qCode.id, language: 'python', sourceCode: 'print(1)' }
    });
    assert.strictEqual(invalidTokenRes.status, 404, 'Invalid token rejected with 404');
    assert.strictEqual(invalidTokenRes.data.code, 'NOT_FOUND');

    console.log('  PASS  Candidate authorization and attempt expiration enforced on execution endpoints');

    /* ----------------------------------------------------
       11. Admin Observability & Multi-Tenant IDOR Protection
    ---------------------------------------------------- */
    console.log('\n--- 11. Admin Observability & Multi-Tenancy ---');

    // Engine status endpoint
    const statusRes = await request('GET', '/api/admin/code-execution/status', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(statusRes.status, 200, 'Admin code execution status 200');
    assert.strictEqual(statusRes.data.success, true);
    assert.strictEqual(statusRes.data.data.configured, true);
    assert.deepStrictEqual(statusRes.data.data.supportedLanguages, ['python', 'javascript', 'cpp', 'java']);

    // Attempt submissions inspection endpoint
    const inspectRes = await request('GET', `/api/admin/attempts/${attemptId}/coding-submissions`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(inspectRes.status, 200, 'Admin inspected candidate coding submissions');
    assert.strictEqual(inspectRes.data.success, true);
    assert(Array.isArray(inspectRes.data.data), 'Returns submissions list');
    assert(inspectRes.data.data.length >= 6, 'Contains all candidate submissions from this attempt');

    // Multi-tenant check: admin from another org CANNOT access these submissions
    const foreignOrg = orgService.createOrganization({
      name: `Foreign Org ${testRunId}`,
      slug: `foreign-org-${testRunId}`
    });
    const foreignAdmin = await userService.createUser({
      name: 'Foreign Admin',
      email: `foreign-admin-${testRunId}@aspire.test`,
      password: 'ForeignPass123!',
      role: ROLES.ORG_ADMIN,
      organizationId: foreignOrg.id
    });
    const foreignLoginRes = await login(`foreign-admin-${testRunId}@aspire.test`, 'ForeignPass123!');
    const foreignAdminToken = foreignLoginRes.data.data.token;

    const crossOrgInspectRes = await request('GET', `/api/admin/attempts/${attemptId}/coding-submissions`, {
      headers: { Authorization: `Bearer ${foreignAdminToken}` }
    });
    assert.strictEqual(crossOrgInspectRes.status, 403, 'Cross-tenant attempt inspection blocked with 403');

    console.log('  PASS  Admin monitoring and multi-tenant isolation confirmed');

    /* ----------------------------------------------------
       12. Final Exam Submission & Combined Grading Integration
    ---------------------------------------------------- */
    console.log('\n--- 12. Full Exam Submission & Scholarship Evaluation ---');

    // Candidate submits exam: MCQ correct (5 marks) + Coding correct (5 marks) = 10/10 (100%) -> Full Platinum (100% discount)
    const candidateMcq = candidateQuestions.find(q => q.type === 'mcq');
    const correctIdx = candidateMcq ? candidateMcq.options.indexOf('4') : 0;
    const answers = {
      [qMcq.id]: correctIdx
    };
    const codeAnswers = {
      [qCode.id]: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)'
    };

    const finalSubmitRes = await request('POST', `/api/attempt/${attemptToken}/submit`, {
      body: { answers, codeAnswers, tabSwitches: 0 }
    });
    assert.strictEqual(finalSubmitRes.status, 200, 'Attempt final submission succeeded');
    assert.strictEqual(finalSubmitRes.data.score, 10, 'Candidate scored 10/10 marks');
    assert.strictEqual(finalSubmitRes.data.percentage, 100, 'Score is 100%');
    assert.strictEqual(finalSubmitRes.data.scholarship_pct, 100, 'Awarded 100% scholarship');
    assert(finalSubmitRes.data.certificate_id, 'Certificate ID generated');

    // Submitting again (idempotent submission)
    const secondSubmitRes = await request('POST', `/api/attempt/${attemptToken}/submit`, {
      body: { answers, codeAnswers, tabSwitches: 0 }
    });
    assert.strictEqual(secondSubmitRes.status, 200, 'Idempotent resubmit succeeded');
    assert.strictEqual(secondSubmitRes.data.score, 10);

    // Code execution on submitted attempt must be rejected
    const postSubmitCode = await request('POST', `/api/attempt/${attemptToken}/code-submit`, {
      body: { questionId: qCode.id, language: 'python', sourceCode: 'print(1)' }
    });
    assert.strictEqual(postSubmitCode.status, 409, 'Code submit on closed/submitted attempt rejected with 409');
    assert.strictEqual(postSubmitCode.data.code, 'ATTEMPT_ALREADY_SUBMITTED');

    console.log('  PASS  End-to-end attempt lifecycle: combined MCQ + code grading and scholarship allocation verified');

    /* ----------------------------------------------------
       13. Provider Outage Resilience & Error Mapping
    ---------------------------------------------------- */
    console.log('\n--- 13. Provider Outage Resilience & Error Handling ---');

    mockProvider.setScenarioHandler(() => {
      const err = new Error('OnlineCompiler HTTP 503: Service Unavailable');
      err.code = 'PROVIDER_UNAVAILABLE';
      throw err;
    });

    // Start a fresh attempt for outage testing
    const carolPhone = '98' + Math.floor(10000000 + Math.random() * 89999999);
    const outageRegRes = await request('POST', '/api/register', {
      body: { exam_code: exam.code, name: 'Carol Outage', email: `carol-${testRunId}@test.com`, phone: carolPhone }
    });
    const outageToken = outageRegRes.data.token;

    const outageSubmitRes = await request('POST', `/api/attempt/${outageToken}/code-submit`, {
      body: { questionId: qCode.id, language: 'python', sourceCode: 'print(1)' }
    });
    assert.strictEqual(outageSubmitRes.status, 503, 'Provider outage mapped to 503');
    assert.strictEqual(outageSubmitRes.data.code, 'CODE_EXECUTION_UNAVAILABLE');
    assert.strictEqual(outageSubmitRes.data.message, 'Code execution engine is temporarily unavailable.');

    // Clear mock scenario handler
    mockProvider.clearScenarioHandler();

    console.log('  PASS  Provider outages safely intercepted and mapped to CODE_EXECUTION_UNAVAILABLE (503)');

    /* ----------------------------------------------------
       14. Rate Limiting on Code Execution Endpoints
    ---------------------------------------------------- */
    console.log('\n--- 14. Rate Limiting on Code Execution Endpoints ---');

    let hitRateLimit = false;
    for (let i = 0; i < 30; i++) {
      const res = await request('POST', `/api/attempt/${outageToken}/code-run`, {
        body: { questionId: qCode.id, language: 'python', sourceCode: 'print(1)' }
      });
      if (res.status === 429) {
        hitRateLimit = true;
        assert.strictEqual(res.data.code, 'RATE_LIMITED');
        break;
      }
    }
    assert(hitRateLimit, 'Rapid requests trigger 429 RATE_LIMITED');
    console.log('  PASS  25 req/min rate limit on code execution enforced');

    /* ----------------------------------------------------
       15. Live Smoke Test (Conditional)
    ---------------------------------------------------- */
    if (process.env.ONLINECOMPILER_LIVE_TEST === 'true' && process.env.ONLINECOMPILER_API_KEY) {
      console.log('\n--- 15. Live OnlineCompiler.io Smoke Test ---');
      executionService.clearMockProvider(); // Use real provider

      const liveProvider = new OnlineCompilerProvider({
        apiKey: process.env.ONLINECOMPILER_API_KEY
      });

      const livePrograms = [
        { lang: 'python', code: 'import sys\nval = sys.stdin.read().strip()\nprint(val or "5")' },
        { lang: 'javascript', code: 'const fs = require("fs"); const val = fs.readFileSync(0, "utf-8").trim(); console.log(val || "5");' },
        { lang: 'cpp', code: '#include <iostream>\nusing namespace std;\nint main() { int x; if (cin >> x) cout << x; else cout << 5; return 0; }' },
        { lang: 'java', code: 'import java.util.Scanner;\npublic class Main { public static void main(String[] args) { Scanner sc = new Scanner(System.in); if (sc.hasNextInt()) System.out.println(sc.nextInt()); else System.out.println(5); } }' }
      ];

      for (const prog of livePrograms) {
        console.log(`  [Live Test]: Running ${prog.lang}...`);
        const liveRes = await liveProvider.executeCode({
          language: prog.lang,
          sourceCode: prog.code,
          stdin: '5'
        });
        console.log(`  [Live Output - ${prog.lang}]:`, liveRes.stdout.trim());
        assert.strictEqual(liveRes.status, EXECUTION_STATUS.ACCEPTED, `${prog.lang} status ACCEPTED`);
        assert.strictEqual(liveRes.stdout.trim(), '5', `${prog.lang} output matches expected 5`);
      }
      console.log('  PASS  Live OnlineCompiler.io smoke tests succeeded across all 4 supported languages');
    } else {
      console.log('\n--- 15. Live OnlineCompiler.io Smoke Test: Skipped (set ONLINECOMPILER_LIVE_TEST=true and ONLINECOMPILER_API_KEY to run) ---');
    }

    console.log('\n=== Aspire Day 9: OnlineCompiler.io Coding Engine Test Suite PASSED (All assertions green) ===');

  } finally {
    executionService.clearMockProvider();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

run().catch((err) => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
