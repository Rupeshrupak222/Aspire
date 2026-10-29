// Base class for code execution providers
const { LIMITS, EXECUTION_STATUS } = require('../constants');

class ExecutionProvider {
  constructor(name = 'base') {
    this.name = name;
  }

  isConfigured() {
    return false;
  }

  getStatus() {
    return {
      provider: this.name,
      configured: this.isConfigured()
    };
  }

  /**
   * Execute code on external provider.
   * Must return NormalizedExecutionResult:
   * {
   *   success: boolean,
   *   status: string (EXECUTION_STATUS),
   *   stdout: string,
   *   stderr: string,
   *   compileOutput: string,
   *   exitCode: number|null,
   *   executionTimeMs: number|null,
   *   memoryUsedKb: number|null,
   *   providerSubmissionId: string|null,
   *   error: string|null
   * }
   */
  async executeCode(options) {
    throw new Error('executeCode must be implemented by subclass');
  }

  /**
   * Strip sensitive details, absolute file paths, API keys, and environment leaks
   * from compiler/runtime messages before delivering to client.
   */
  sanitizeMessage(msg) {
    if (!msg || typeof msg !== 'string') return '';
    return msg
      // Strip potential API key / bearer token values
      .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
      // Strip absolute server paths (Windows and Unix)
      .replace(/[A-Za-z]:\\[\w.-]+(?:\\[\w.-]+)*/g, '[path]')
      .replace(/\/(?:home|usr|app|tmp|var|etc)\/[\w.-]+(?:\/[\w.-]+)*/g, '[path]')
      // Limit length
      .slice(0, 4096);
  }

  /**
   * Truncate large output strings to prevent memory exhaustion
   */
  truncateOutput(str, maxBytes = LIMITS.MAX_OUTPUT_BYTES) {
    if (!str || typeof str !== 'string') return '';
    if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
    const truncated = Buffer.from(str, 'utf8').subarray(0, maxBytes).toString('utf8');
    return truncated + '\n[OUTPUT TRUNCATED: Exceeded 100KB limit]';
  }
}

module.exports = ExecutionProvider;

