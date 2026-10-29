// OnlineCompiler.io Execution Provider
// Implements code compilation and execution using OnlineCompiler.io REST API.
// Keys are read strictly from process.env and NEVER exposed to clients or logged.

const ExecutionProvider = require('./base.provider');
const {
  EXECUTION_STATUS,
  ONLINECOMPILER_LANGUAGE_MAP,
  normalizeLanguage,
  LIMITS
} = require('../constants');
const { ExternalServiceError, PayloadTooLargeError } = require('../../../errors/app-error');
const defaultLogger = require('../../../utils/logger');

const DEFAULT_ENDPOINT = 'https://api.onlinecompiler.io';

class OnlineCompilerProvider extends ExecutionProvider {
  constructor(options = {}) {
    super('onlinecompiler');
    this.endpoint = (options.endpoint || process.env.ONLINECOMPILER_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.ONLINECOMPILER_API_KEY || '';
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
    this.logger = options.logger || defaultLogger;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  getStatus() {
    return {
      provider: 'onlinecompiler',
      configured: this.isConfigured(),
      endpoint: this.isConfigured() ? this.endpoint : null
    };
  }

  /**
   * Resolve OnlineCompiler compiler identifier for a canonical language.
   */
  resolveCompiler(language) {
    const canonical = normalizeLanguage(language);
    const compiler = ONLINECOMPILER_LANGUAGE_MAP[canonical];
    if (!compiler) {
      throw new ExternalServiceError(`OnlineCompiler does not support canonical language: ${canonical}`, 'UNSUPPORTED_LANGUAGE');
    }
    return compiler;
  }

  /**
   * Execute code on OnlineCompiler.io
   */
  async executeCode({
    language,
    sourceCode,
    stdin = '',
    timeoutMs = LIMITS.DEFAULT_TIMEOUT_MS,
    memoryLimit = null,
    signal = null
  }) {
    if (!this.isConfigured()) {
      throw new ExternalServiceError(
        'OnlineCompiler execution engine is not configured (ONLINECOMPILER_API_KEY missing)',
        'CODE_EXECUTION_UNAVAILABLE'
      );
    }

    const compiler = this.resolveCompiler(language);
    const timeLimitSec = Math.min(30, Math.max(1, Math.ceil(timeoutMs / 1000)));

    const requestBody = {
      compiler,
      code: sourceCode,
      input: stdin || '',
      time_limit: timeLimitSec
    };

    const serializedBody = JSON.stringify(requestBody);
    if (Buffer.byteLength(serializedBody, 'utf8') > LIMITS.MAX_RESPONSE_BYTES) {
      throw new PayloadTooLargeError('Execution request exceeds payload limit', 'PAYLOAD_TOO_LARGE');
    }

    let lastError = null;
    const maxAttempts = 1 + this.maxRetries;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const abortCtrl = new AbortController();
      const effectiveTimeout = timeoutMs + 5000; // 5s grace period for HTTP overhead
      const timeoutTimer = setTimeout(() => abortCtrl.abort(), effectiveTimeout);

      // Chain incoming cancellation signal if provided
      const onParentAbort = () => abortCtrl.abort();
      if (signal) signal.addEventListener('abort', onParentAbort, { once: true });

      const startTime = Date.now();

      try {
        const response = await fetch(`${this.endpoint}/api/run-code-sync/`, {
          method: 'POST',
          headers: {
            'Authorization': this.apiKey,
            'x-api-key': this.apiKey.replace(/^Bearer\s+/i, ''),
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: serializedBody,
          signal: abortCtrl.signal
        });

        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener('abort', onParentAbort);

        const durationMs = Date.now() - startTime;

        // Check HTTP response code
        if (!response.ok) {
          const respText = await response.text().catch(() => '');

          // Do NOT retry 4xx errors
          if (response.status === 401 || response.status === 403) {
            this.logger.error({ status: response.status }, 'OnlineCompiler authentication failed');
            throw new ExternalServiceError(
              'OnlineCompiler authentication failed. Please check server configuration.',
              'CODE_EXECUTION_UNAVAILABLE'
            );
          }

          if (response.status === 429) {
            throw new ExternalServiceError('OnlineCompiler quota or rate limit exceeded.', 'CODE_EXECUTION_QUOTA_EXCEEDED');
          }

          if (response.status >= 400 && response.status < 500) {
            throw new ExternalServiceError(
              `OnlineCompiler rejected execution request (HTTP ${response.status}): ${this.sanitizeMessage(respText.slice(0, 200))}`,
              'CODE_EXECUTION_PROVIDER_ERROR'
            );
          }

          // 5xx Server errors - retryable
          lastError = new ExternalServiceError(
            `OnlineCompiler HTTP ${response.status}: ${this.sanitizeMessage(respText.slice(0, 200))}`,
            'CODE_EXECUTION_PROVIDER_ERROR'
          );

          if (attempt < maxAttempts) {
            const backoff = attempt * 200;
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          throw lastError;
        }

        const rawText = await response.text().catch(() => '');
        if (Buffer.byteLength(rawText, 'utf8') > LIMITS.MAX_RESPONSE_BYTES) {
          throw new PayloadTooLargeError('Provider response exceeded safe limits', 'PROVIDER_RESPONSE_TOO_LARGE');
        }

        let data;
        try {
          data = JSON.parse(rawText);
        } catch {
          return {
            success: false,
            status: EXECUTION_STATUS.PROVIDER_ERROR,
            stdout: '',
            stderr: 'Failed to parse provider response',
            compileOutput: '',
            exitCode: null,
            executionTimeMs: durationMs,
            memoryUsedKb: null,
            providerSubmissionId: null,
            error: 'Failed to parse provider response'
          };
        }
        return this._normalizeResponse(data, durationMs, timeoutMs);

      } catch (err) {
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener('abort', onParentAbort);

        // Check if aborted by timeout
        if (err.name === 'AbortError') {
          return {
            success: false,
            status: EXECUTION_STATUS.TIME_LIMIT_EXCEEDED,
            stdout: '',
            stderr: 'Execution timed out',
            compileOutput: '',
            exitCode: null,
            executionTimeMs: timeoutMs,
            memoryUsedKb: null,
            providerSubmissionId: null,
            error: 'Time limit exceeded'
          };
        }

        // If operational AppError was thrown above (e.g. 401/403/429), rethrow immediately
        if (err.isOperational) throw err;

        lastError = err;
        if (attempt < maxAttempts) {
          const backoff = attempt * 200;
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
      }
    }

    // Retries exhausted
    this.logger.error({ err: lastError }, 'OnlineCompiler request failed after retries');
    throw new ExternalServiceError(
      'OnlineCompiler code execution service is temporarily unavailable.',
      'CODE_EXECUTION_UNAVAILABLE'
    );
  }

  /**
   * Convert OnlineCompiler response to normalized internal structure
   */
  _normalizeResponse(data, fallbackDurationMs, timeoutMs) {
    if (!data || typeof data !== 'object') {
      return {
        success: false,
        status: EXECUTION_STATUS.PROVIDER_ERROR,
        stdout: '',
        stderr: 'Malformed provider response',
        compileOutput: '',
        exitCode: null,
        executionTimeMs: fallbackDurationMs,
        memoryUsedKb: null,
        providerSubmissionId: null,
        error: 'Malformed provider response'
      };
    }

    const rawOutput = this.truncateOutput(data.output || '');
    const rawError = this.truncateOutput(data.error || '');
    const exitCode = typeof data.exit_code === 'number' ? data.exit_code : (data.exitCode ?? 0);
    const signal = data.signal || null;
    const statusStr = String(data.status || '').toLowerCase();

    const executionTimeSec = parseFloat(data.time) || (parseFloat(data.total) || 0);
    const executionTimeMs = executionTimeSec > 0
      ? Math.round(executionTimeSec * 1000)
      : fallbackDurationMs;

    const memoryKb = parseInt(data.memory, 10) || null;
    const providerSubmissionId = data.id || data.submission_id || null;

    // Detect TIMEOUT
    if (
      statusStr === 'timeout' ||
      signal === 'SIGKILL' ||
      signal === 'SIGXCPU' ||
      rawError.toLowerCase().includes('time limit exceeded') ||
      rawError.toLowerCase().includes('timed out') ||
      executionTimeMs >= timeoutMs
    ) {
      return {
        success: false,
        status: EXECUTION_STATUS.TIME_LIMIT_EXCEEDED,
        stdout: rawOutput,
        stderr: this.sanitizeMessage(rawError || 'Time limit exceeded'),
        compileOutput: '',
        exitCode: exitCode || 124,
        executionTimeMs: Math.max(executionTimeMs, timeoutMs),
        memoryUsedKb: memoryKb,
        providerSubmissionId,
        error: 'Time limit exceeded'
      };
    }

    // Detect MEMORY LIMIT EXCEEDED
    if (
      statusStr === 'memory_limit' ||
      signal === 'SIGSEGV' && rawError.toLowerCase().includes('memory') ||
      rawError.toLowerCase().includes('out of memory') ||
      rawError.toLowerCase().includes('memory limit exceeded')
    ) {
      return {
        success: false,
        status: EXECUTION_STATUS.MEMORY_LIMIT_EXCEEDED,
        stdout: rawOutput,
        stderr: this.sanitizeMessage(rawError || 'Memory limit exceeded'),
        compileOutput: '',
        exitCode,
        executionTimeMs,
        memoryUsedKb: memoryKb,
        providerSubmissionId,
        error: 'Memory limit exceeded'
      };
    }

    // Detect COMPILATION ERROR
    const isCompileError =
      statusStr === 'compilation_error' ||
      statusStr === 'compile_error' ||
      (exitCode !== 0 && (
        rawError.toLowerCase().includes('syntaxerror') ||
        rawError.toLowerCase().includes('compilation error') ||
        rawError.toLowerCase().includes('error: ') && (rawError.includes('.cpp') || rawError.includes('.java')) ||
        rawError.toLowerCase().includes('javac') ||
        rawError.toLowerCase().includes('g++:')
      ));

    if (isCompileError) {
      const sanitizedCompile = this.sanitizeMessage(rawError || 'Compilation failed');
      return {
        success: false,
        status: EXECUTION_STATUS.COMPILATION_ERROR,
        stdout: '',
        stderr: sanitizedCompile,
        compileOutput: sanitizedCompile,
        exitCode: exitCode || 1,
        executionTimeMs,
        memoryUsedKb: memoryKb,
        providerSubmissionId,
        error: 'Compilation error'
      };
    }

    // Detect RUNTIME ERROR
    if (exitCode !== 0 || statusStr === 'error' || signal) {
      const sanitizedStderr = this.sanitizeMessage(rawError || `Process exited with code ${exitCode}`);
      return {
        success: false,
        status: EXECUTION_STATUS.RUNTIME_ERROR,
        stdout: rawOutput,
        stderr: sanitizedStderr,
        compileOutput: '',
        exitCode,
        executionTimeMs,
        memoryUsedKb: memoryKb,
        providerSubmissionId,
        error: sanitizedStderr || 'Runtime error'
      };
    }

    // Process finished successfully with exitCode 0
    return {
      success: true,
      status: EXECUTION_STATUS.ACCEPTED,
      stdout: rawOutput,
      stderr: this.sanitizeMessage(rawError),
      compileOutput: '',
      exitCode: 0,
      executionTimeMs,
      memoryUsedKb: memoryKb,
      providerSubmissionId,
      error: null
    };
  }
}

module.exports = OnlineCompilerProvider;

