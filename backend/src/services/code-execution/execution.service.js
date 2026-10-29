// Code Execution Service Orchestrator
// Coordinates providers, output normalization, test evaluation, frozen snapshot grading,
// and transactional persistence in coding_submissions.

const crypto = require('crypto');
const { db } = require('../../db');
const {
  EXECUTION_STATUS,
  normalizeLanguage,
  LIMITS
} = require('./constants');
const OnlineCompilerProvider = require('./providers/onlinecompiler.provider');
const Judge0Provider = require('./providers/judge0.provider');
const {
  ValidationError,
  ConflictError,
  PayloadTooLargeError,
  NotFoundError,
  ExternalServiceError
} = require('../../errors/app-error');
const defaultLogger = require('../../utils/logger');

class ExecutionService {
  constructor(options = {}) {
    this.onlineCompiler = options.onlineCompiler || new OnlineCompilerProvider();
    this.judge0 = options.judge0 || new Judge0Provider();
    this.mockProvider = options.mockProvider || null;
    this.logger = options.logger || defaultLogger;
  }

  /**
   * Selects active execution provider based on environment configuration.
   * Priority: Mock (in tests) -> OnlineCompiler.io -> Judge0 -> fallback
   */
  getActiveProvider() {
    if (this.mockProvider) return this.mockProvider;
    if (this.onlineCompiler.isConfigured()) return this.onlineCompiler;
    if (this.judge0.isConfigured()) return this.judge0;
    return this.onlineCompiler; // default provider instance
  }

  setMockProvider(provider) {
    this.mockProvider = provider;
  }

  clearMockProvider() {
    this.mockProvider = null;
  }

  isConfigured() {
    if (this.mockProvider) return true;
    return this.onlineCompiler.isConfigured() || this.judge0.isConfigured();
  }

  getStatus() {
    const active = this.getActiveProvider();
    return {
      configured: this.isConfigured(),
      provider: active ? active.name : 'none',
      details: active ? active.getStatus() : null,
      supportedLanguages: ['python', 'javascript', 'cpp', 'java']
    };
  }

  /**
   * Server-authoritative comparison policy.
   * Handles:
   * - CRLF vs LF (\r\n -> \n)
   * - Trailing whitespace on each line (.trimEnd())
   * - Leading and trailing whitespace/newlines (.trim())
   * Preserves case and internal spacing.
   */
  compareOutputs(actual, expected) {
    const actStr = String(actual ?? '').replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim();
    const expStr = String(expected ?? '').replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim();
    return actStr === expStr;
  }

  /**
   * Validate source code payload before calling any external provider.
   */
  validateSourceCode(sourceCode) {
    if (sourceCode === undefined || sourceCode === null) {
      throw new ValidationError('Source code is required', 'INVALID_SOURCE_CODE');
    }
    if (typeof sourceCode !== 'string') {
      throw new ValidationError('Source code must be a string', 'INVALID_SOURCE_CODE');
    }
    const byteLength = Buffer.byteLength(sourceCode, 'utf8');
    if (byteLength > LIMITS.MAX_SOURCE_BYTES) {
      throw new PayloadTooLargeError('Source code exceeds 100KB limit', 'SOURCE_CODE_TOO_LARGE');
    }
    if (sourceCode.trim().length === 0) {
      return { isEmpty: true };
    }
    return { isEmpty: false };
  }

  /**
   * Execute code against a single test case.
   */
  async executeSingleTest({
    language,
    sourceCode,
    stdin = '',
    expectedOutput = '',
    timeoutMs = LIMITS.DEFAULT_TIMEOUT_MS,
    signal = null
  }) {
    const { isEmpty } = this.validateSourceCode(sourceCode);
    if (isEmpty) {
      return {
        status: EXECUTION_STATUS.EMPTY_SUBMISSION,
        passed: false,
        stdout: '',
        stderr: 'Code submission is empty',
        compileOutput: '',
        exitCode: 0,
        executionTimeMs: 0,
        memoryUsedKb: null,
        error: 'Empty submission'
      };
    }

    const canonicalLang = normalizeLanguage(language);
    const provider = this.getActiveProvider();

    const result = await provider.executeCode({
      language: canonicalLang,
      sourceCode,
      stdin,
      timeoutMs,
      signal
    });

    // Check for execution-level failures
    if (result.status === EXECUTION_STATUS.COMPILATION_ERROR) {
      return { ...result, passed: false };
    }
    if (result.status === EXECUTION_STATUS.TIME_LIMIT_EXCEEDED) {
      return { ...result, passed: false };
    }
    if (result.status === EXECUTION_STATUS.MEMORY_LIMIT_EXCEEDED) {
      return { ...result, passed: false };
    }
    if (result.status === EXECUTION_STATUS.RUNTIME_ERROR) {
      return { ...result, passed: false };
    }

    // Process completed normally - compare stdout against expected output
    const matches = this.compareOutputs(result.stdout, expectedOutput);
    return {
      ...result,
      status: matches ? EXECUTION_STATUS.ACCEPTED : EXECUTION_STATUS.WRONG_ANSWER,
      passed: matches
    };
  }

  /**
   * Evaluate a question against an array of test cases.
   *
   * @param {Object} params
   * @param {string} params.language - Language string
   * @param {string} params.sourceCode - Candidate source code
   * @param {Array} params.testCases - Array of { input, expected, hidden? }
   * @param {boolean} [params.sampleOnly=false] - If true, only runs sample test cases
   * @param {number} [params.timeoutMs] - Timeout per test case
   */
  async evaluateQuestion({
    language,
    sourceCode,
    testCases = [],
    sampleOnly = false,
    timeoutMs = LIMITS.DEFAULT_TIMEOUT_MS
  }) {
    const { isEmpty } = this.validateSourceCode(sourceCode);
    if (isEmpty) {
      return {
        status: EXECUTION_STATUS.EMPTY_SUBMISSION,
        testsPassed: 0,
        testsTotal: testCases.length,
        results: [],
        executionTimeMs: 0,
        memoryUsedKb: null,
        error: 'Empty submission'
      };
    }

    const canonicalLang = normalizeLanguage(language);

    // Determine target test cases
    let targets = Array.isArray(testCases) ? testCases : [];
    if (sampleOnly) {
      targets = targets.filter(tc => !tc.is_hidden && !tc.hidden);
      // Fallback: if none are marked hidden, use the first test case as sample
      if (targets.length === 0 && testCases.length > 0) {
        targets = [testCases[0]];
      }
    }

    const total = targets.length;
    let passed = 0;
    const testResults = [];
    let overallStatus = EXECUTION_STATUS.ACCEPTED;
    let totalTimeMs = 0;
    let maxMemoryKb = 0;
    let executionError = null;

    for (let i = 0; i < targets.length; i++) {
      const tc = targets[i];
      const stdin = tc.input !== undefined ? String(tc.input) : '';
      const expectedOutput = tc.expected_output !== undefined ? String(tc.expected_output) : String(tc.expected || '');
      const isHidden = Boolean(tc.is_hidden || tc.hidden);

      const r = await this.executeSingleTest({
        language: canonicalLang,
        sourceCode,
        stdin,
        expectedOutput,
        timeoutMs
      });

      if (r.executionTimeMs) totalTimeMs += r.executionTimeMs;
      if (r.memoryUsedKb && r.memoryUsedKb > maxMemoryKb) maxMemoryKb = r.memoryUsedKb;

      if (r.passed) {
        passed++;
      } else {
        // Track the most severe non-accepted status
        if (r.status === EXECUTION_STATUS.COMPILATION_ERROR) {
          overallStatus = EXECUTION_STATUS.COMPILATION_ERROR;
          executionError = r.compileOutput || r.stderr || 'Compilation error';
        } else if (r.status === EXECUTION_STATUS.TIME_LIMIT_EXCEEDED && overallStatus !== EXECUTION_STATUS.COMPILATION_ERROR) {
          overallStatus = EXECUTION_STATUS.TIME_LIMIT_EXCEEDED;
          executionError = 'Time limit exceeded';
        } else if (r.status === EXECUTION_STATUS.MEMORY_LIMIT_EXCEEDED && overallStatus !== EXECUTION_STATUS.COMPILATION_ERROR) {
          overallStatus = EXECUTION_STATUS.MEMORY_LIMIT_EXCEEDED;
          executionError = 'Memory limit exceeded';
        } else if (r.status === EXECUTION_STATUS.RUNTIME_ERROR && overallStatus !== EXECUTION_STATUS.COMPILATION_ERROR) {
          overallStatus = EXECUTION_STATUS.RUNTIME_ERROR;
          executionError = r.stderr || 'Runtime error';
        } else if (overallStatus === EXECUTION_STATUS.ACCEPTED) {
          overallStatus = EXECUTION_STATUS.WRONG_ANSWER;
        }
      }

      // Format test result record
      // STRICT PRIVACY: Hidden test cases NEVER leak input, expected output, or stdout
      if (sampleOnly || !isHidden) {
        testResults.push({
          testIndex: i + 1,
          passed: r.passed,
          status: r.status,
          input: stdin,
          expectedOutput,
          actualOutput: r.stdout,
          error: r.stderr || null,
          executionTimeMs: r.executionTimeMs
        });
      } else {
        // Hidden test case - scrubbed
        testResults.push({
          testIndex: i + 1,
          passed: r.passed,
          status: r.status,
          hidden: true,
          executionTimeMs: r.executionTimeMs
        });
      }

      // Optimization: if compilation error occurs on test 1, all subsequent tests will also fail to compile
      if (r.status === EXECUTION_STATUS.COMPILATION_ERROR) {
        break;
      }
    }

    if (overallStatus === EXECUTION_STATUS.ACCEPTED && passed < total) {
      overallStatus = EXECUTION_STATUS.WRONG_ANSWER;
    }

    return {
      status: overallStatus,
      testsPassed: passed,
      testsTotal: total,
      results: testResults,
      executionTimeMs: totalTimeMs,
      memoryUsedKb: maxMemoryKb || null,
      error: executionError
    };
  }

  /**
   * Run sample/public test cases only for candidate interactive feedback ("Run Code").
   */
  async runCandidateCode({ attempt, questionId, language, sourceCode }) {
    this._validateAttemptForExecution(attempt);

    const question = this._resolveQuestionFromAttempt(attempt, questionId);
    if (question.type !== 'code') {
      throw new ValidationError('Question is not a coding question', 'INVALID_QUESTION_TYPE');
    }

    const testCases = this._extractTestCases(question);
    const result = await this.evaluateQuestion({
      language,
      sourceCode,
      testCases,
      sampleOnly: true
    });

    return {
      status: result.status,
      testsPassed: result.testsPassed,
      testsTotal: result.testsTotal,
      results: result.results,
      executionTimeMs: result.executionTimeMs,
      memoryUsedKb: result.memoryUsedKb,
      error: result.error
    };
  }

  /**
   * Submit coding solution for candidate evaluation ("Code Submit").
   * Runs all test cases, records into coding_submissions table, and updates attempt.
   */
  async submitCandidateCode({
    attempt,
    questionId,
    language,
    sourceCode,
    requestId = null
  }) {
    this._validateAttemptForExecution(attempt);

    const question = this._resolveQuestionFromAttempt(attempt, questionId);
    if (question.type !== 'code') {
      throw new ValidationError('Question is not a coding question', 'INVALID_QUESTION_TYPE');
    }

    const canonicalLang = normalizeLanguage(language);
    const marks = question.marks || 1;
    const sourceHash = crypto.createHash('sha256').update(sourceCode || '').digest('hex');

    // Idempotency: Return existing completed submission if submitted within the last 15 seconds with identical code & language
    const recent = db.prepare(`
      SELECT * FROM coding_submissions
      WHERE attempt_id = ? AND question_id = ? AND language = ? AND source_hash = ?
        AND submission_status NOT IN ('SYSTEM_ERROR', 'PROVIDER_ERROR')
        AND created_at >= datetime('now', '-15 seconds')
      ORDER BY created_at DESC LIMIT 1
    `).get(attempt.id, question.id, canonicalLang, sourceHash);

    if (recent) {
      return {
        submissionId: recent.id,
        status: recent.submission_status,
        testsPassed: recent.test_cases_passed,
        testsTotal: recent.test_cases_total,
        score: recent.score,
        marks,
        executionTimeMs: recent.execution_time_ms,
        error: recent.error_message,
        idempotent: true
      };
    }

    const testCases = this._extractTestCases(question);

    const evaluation = await this.evaluateQuestion({
      language: canonicalLang,
      sourceCode,
      testCases,
      sampleOnly: false
    });

    const ratio = evaluation.testsTotal > 0 ? evaluation.testsPassed / evaluation.testsTotal : 0;
    const score = Math.round((marks * ratio) * 100) / 100;

    const submissionId = 'csub_' + crypto.randomBytes(12).toString('hex');
    const providerName = this.getActiveProvider().name;

    // Transactionally record submission and update attempt's code_answers_json
    const persistSubmission = db.transaction(() => {
      // 1. Insert into coding_submissions
      db.prepare(`
        INSERT INTO coding_submissions (
          id, attempt_id, question_id, organization_id, language,
          submission_status, provider, provider_submission_id, source_hash, source_code,
          test_cases_passed, test_cases_total, score, execution_time_ms, memory_used_kb,
          error_message, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        submissionId,
        attempt.id,
        question.id,
        attempt.organization_id || null,
        canonicalLang,
        evaluation.status,
        providerName,
        null,
        sourceHash,
        sourceCode,
        evaluation.testsPassed,
        evaluation.testsTotal,
        score,
        evaluation.executionTimeMs,
        evaluation.memoryUsedKb,
        evaluation.error
      );

      // 2. Update code_answers_json on the attempt
      let currentCodeAnswers = {};
      try {
        currentCodeAnswers = JSON.parse(attempt.code_answers_json || '{}');
      } catch {}
      currentCodeAnswers[question.id] = sourceCode;

      db.prepare('UPDATE attempts SET code_answers_json = ? WHERE id = ?')
        .run(JSON.stringify(currentCodeAnswers), attempt.id);

      // 3. Record Audit Log
      try {
        db.prepare(`
          INSERT INTO audit_logs (request_id, organization_id, event, details_json)
          VALUES (?, ?, ?, ?)
        `).run(
          requestId,
          attempt.organization_id || null,
          'coding_submission',
          JSON.stringify({
            attemptId: attempt.id,
            questionId: question.id,
            submissionId,
            language: canonicalLang,
            status: evaluation.status,
            testsPassed: evaluation.testsPassed,
            testsTotal: evaluation.testsTotal,
            score
          })
        );
      } catch {}
    });

    persistSubmission();

    this.logger.info({
      requestId,
      attemptId: attempt.id,
      questionId: question.id,
      submissionId,
      language: canonicalLang,
      status: evaluation.status,
      score,
      testsPassed: evaluation.testsPassed,
      testsTotal: evaluation.testsTotal
    }, 'Candidate coding submission processed successfully');

    return {
      submissionId,
      status: evaluation.status,
      testsPassed: evaluation.testsPassed,
      testsTotal: evaluation.testsTotal,
      score,
      marks,
      executionTimeMs: evaluation.executionTimeMs,
      error: evaluation.error
    };
  }

  /**
   * Helper for final attempt submit grading (backward-compatible adapter method).
   */
  async gradeCodeQuestion({ source_code, language_id, language, test_cases = [] }) {
    let lang = language;
    if (!lang && language_id) {
      const { JUDGE0_LANGUAGE_MAP } = require('./constants');
      for (const [k, v] of Object.entries(JUDGE0_LANGUAGE_MAP)) {
        if (v === language_id) { lang = k; break; }
      }
    }
    if (!lang) lang = 'python';

    const res = await this.evaluateQuestion({
      language: lang,
      sourceCode: source_code,
      testCases: test_cases,
      sampleOnly: false
    });

    return {
      passed: res.testsPassed,
      total: res.testsTotal,
      status: res.status,
      error: res.error
    };
  }

  // --- Internal Authorization & Snapshot Helpers ---

  _validateAttemptForExecution(attempt) {
    if (!attempt) {
      throw new NotFoundError('Attempt not found');
    }
    if (attempt.status === 'submitted') {
      throw new ConflictError('This assessment has already been submitted', 'ATTEMPT_ALREADY_SUBMITTED');
    }
    if (attempt.status !== 'started') {
      throw new ConflictError(`Attempt is in status '${attempt.status}' and cannot accept submissions`, 'ATTEMPT_NOT_ACTIVE');
    }
    const expiresAt = new Date(attempt.expires_at).getTime();
    if (Date.now() > expiresAt) {
      throw new ConflictError('Assessment duration has expired', 'ATTEMPT_EXPIRED');
    }
  }

  _resolveQuestionFromAttempt(attempt, questionId) {
    const qidNum = Number(questionId);
    if (!Number.isInteger(qidNum) || qidNum <= 0) {
      throw new ValidationError('A valid numeric questionId is required', 'INVALID_QUESTION_ID');
    }

    // 1. Prefer frozen snapshot
    if (attempt.questions_snapshot_json) {
      try {
        const frozen = JSON.parse(attempt.questions_snapshot_json);
        if (Array.isArray(frozen) && frozen.length > 0) {
          const match = frozen.find(q => q.id === qidNum);
          if (match) return match;
          throw new NotFoundError('Question does not belong to this assessment attempt', 'QUESTION_NOT_IN_ATTEMPT');
        }
      } catch (err) {
        if (err instanceof NotFoundError) throw err;
      }
    }

    // 2. Legacy fallback to question_ids_json
    const qids = JSON.parse(attempt.question_ids_json || '[]');
    if (!qids.includes(qidNum)) {
      throw new NotFoundError('Question does not belong to this assessment attempt', 'QUESTION_NOT_IN_ATTEMPT');
    }

    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(qidNum);
    if (!row) {
      throw new NotFoundError('Question not found');
    }
    return row;
  }

  _extractTestCases(question) {
    if (Array.isArray(question.test_cases)) return question.test_cases;
    if (typeof question.test_cases_json === 'string') {
      try { return JSON.parse(question.test_cases_json); } catch {}
    }
    return [];
  }
}

// Singleton instance
const executionService = new ExecutionService();

module.exports = {
  ExecutionService,
  executionService
};

