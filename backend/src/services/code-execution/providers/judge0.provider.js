// Judge0 Execution Provider Adapter
// Integrates Judge0 CE / RapidAPI behind the unified ExecutionProvider interface.

const ExecutionProvider = require('./base.provider');
const {
  EXECUTION_STATUS,
  JUDGE0_LANGUAGE_MAP,
  normalizeLanguage,
  LIMITS
} = require('../constants');
const { ExternalServiceError } = require('../../../errors/app-error');

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const unb64 = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

class Judge0Provider extends ExecutionProvider {
  constructor(options = {}) {
    super('judge0');
    this.endpoint = (options.endpoint || process.env.JUDGE0_ENDPOINT || '').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.JUDGE0_API_KEY || '';
    this.rapidapiHost = options.rapidapiHost || process.env.JUDGE0_RAPIDAPI_HOST || '';
  }

  isConfigured() {
    return Boolean(this.endpoint && this.endpoint.length > 0);
  }

  getStatus() {
    return {
      provider: 'judge0',
      configured: this.isConfigured(),
      mode: !this.isConfigured() ? 'disabled' : (this.rapidapiHost ? 'rapidapi' : 'self-hosted'),
      endpoint: this.isConfigured() ? this.endpoint : null
    };
  }

  resolveLanguageId(language) {
    if (typeof language === 'number') return language;
    const canonical = normalizeLanguage(language);
    const id = JUDGE0_LANGUAGE_MAP[canonical];
    if (!id) {
      throw new ExternalServiceError(`Judge0 does not support canonical language: ${canonical}`, 'UNSUPPORTED_LANGUAGE');
    }
    return id;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      if (this.rapidapiHost) {
        h['x-rapidapi-key'] = this.apiKey;
        h['x-rapidapi-host'] = this.rapidapiHost;
      } else {
        h['Authorization'] = `Bearer ${this.apiKey}`;
      }
    }
    return h;
  }

  async executeCode({
    language,
    sourceCode,
    stdin = '',
    timeoutMs = LIMITS.DEFAULT_TIMEOUT_MS,
    signal = null
  }) {
    if (!this.isConfigured()) {
      throw new ExternalServiceError(
        'Judge0 is not configured (JUDGE0_ENDPOINT missing)',
        'CODE_EXECUTION_UNAVAILABLE'
      );
    }

    const languageId = this.resolveLanguageId(language);
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), timeoutMs + 3000);

    const onParentAbort = () => abortCtrl.abort();
    if (signal) signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const res = await fetch(`${this.endpoint}/submissions?base64_encoded=true&wait=true`, {
        method: 'POST',
        headers: this._headers(),
        signal: abortCtrl.signal,
        body: JSON.stringify({
          source_code: b64(sourceCode),
          language_id: languageId,
          stdin: b64(stdin)
        })
      });

      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new ExternalServiceError(
          `Judge0 HTTP ${res.status}: ${this.sanitizeMessage(txt.slice(0, 200))}`,
          'CODE_EXECUTION_PROVIDER_ERROR'
        );
      }

      const data = await res.json();
      const sid = data.status && data.status.id;
      const stdout = this.truncateOutput(unb64(data.stdout));
      const stderr = this.truncateOutput(unb64(data.stderr || ''));
      const compileOutput = this.truncateOutput(unb64(data.compile_output || ''));

      let status = EXECUTION_STATUS.ACCEPTED;
      let error = null;

      if (sid === 3) {
        status = EXECUTION_STATUS.ACCEPTED;
      } else if (sid === 4) {
        status = EXECUTION_STATUS.WRONG_ANSWER;
      } else if (sid === 5) {
        status = EXECUTION_STATUS.TIME_LIMIT_EXCEEDED;
        error = 'Time limit exceeded';
      } else if (sid === 6) {
        status = EXECUTION_STATUS.COMPILATION_ERROR;
        error = compileOutput || 'Compilation error';
      } else if (sid >= 7 && sid <= 12) {
        status = EXECUTION_STATUS.RUNTIME_ERROR;
        error = stderr || (data.status && data.status.description) || 'Runtime error';
      } else {
        status = EXECUTION_STATUS.RUNTIME_ERROR;
        error = (data.status && data.status.description) || 'Execution error';
      }

      return {
        success: status === EXECUTION_STATUS.ACCEPTED,
        status,
        stdout,
        stderr: this.sanitizeMessage(stderr),
        compileOutput: this.sanitizeMessage(compileOutput),
        exitCode: data.exit_code,
        executionTimeMs: data.time ? Math.round(parseFloat(data.time) * 1000) : null,
        memoryUsedKb: data.memory,
        providerSubmissionId: data.token || null,
        error
      };
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);

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
      throw err;
    }
  }
}

module.exports = Judge0Provider;

