// ============================================================================
// ASPIRE DAY 27: ERROR TRACKING ADAPTER (GLITCHTIP / SENTRY / MOCK)
// ============================================================================

const https = require('https');
const http = require('http');
const logger = require('../../utils/logger');
const metrics = require('../../utils/metrics');

class ErrorTrackingService {
  constructor() {
    this.provider = process.env.ERROR_TRACKING_PROVIDER || (process.env.SENTRY_DSN || process.env.GLITCHTIP_DSN ? 'sentry' : 'mock');
    this.dsn = process.env.SENTRY_DSN || process.env.GLITCHTIP_DSN || null;
    this.environment = process.env.NODE_ENV || 'development';
    this.release = process.env.APP_VERSION || process.env.RELEASE || 'aspire@1.0.0';
    this.sampleRate = parseFloat(process.env.ERROR_TRACKING_SAMPLE_RATE || '1.0');
    this.capturedEvents = [];
    this.parsedDsn = this._parseDsn(this.dsn);
  }

  _parseDsn(dsn) {
    if (!dsn || typeof dsn !== 'string') return null;
    try {
      const url = new URL(dsn);
      const publicKey = url.username;
      const projectId = url.pathname.replace(/^\//, '');
      const host = url.host;
      const protocol = url.protocol;
      return { publicKey, projectId, host, protocol, endpoint: `${protocol}//${host}/api/${projectId}/store/` };
    } catch {
      return null;
    }
  }

  /**
   * Capture and record an exception with safe context.
   *
   * @param {Error|any} err
   * @param {Object} context
   * @returns {string} eventId
   */
  captureException(err, context = {}) {
    if (Math.random() > this.sampleRate) return null;

    const eventId = `err_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const errorMessage = err?.message || String(err || 'Unknown error');
    const errorStack = err?.stack || '';
    const errorName = err?.name || 'Error';
    const errorCode = err?.code || context.code || 'UNHANDLED_EXCEPTION';

    // Scrub any sensitive context fields
    const safeContext = logger.sanitizePayload({
      service: context.service || 'aspire-backend',
      environment: this.environment,
      release: this.release,
      requestId: context.requestId,
      correlationId: context.correlationId,
      route: context.route,
      method: context.method,
      category: context.category || 'application',
      worker: context.worker,
      queue: context.queue,
      jobId: context.jobId,
      statusCode: context.statusCode,
      extra: context.extra ? logger.sanitizePayload(context.extra) : undefined
    });

    const eventPayload = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: 'error',
      logger: 'aspire.error_tracking',
      environment: this.environment,
      release: this.release,
      exception: {
        values: [
          {
            type: errorName,
            value: errorMessage,
            stacktrace: {
              frames: errorStack.split('\n').slice(1).map(line => ({ filename: line.trim() }))
            }
          }
        ]
      },
      tags: {
        service: safeContext.service,
        category: safeContext.category,
        code: String(errorCode),
        worker: safeContext.worker,
        queue: safeContext.queue
      },
      extra: safeContext
    };

    // Store in-memory for testing / inspection
    this.capturedEvents.push(eventPayload);
    if (this.capturedEvents.length > 500) {
      this.capturedEvents.shift();
    }

    // Record operational metric
    metrics.recordError(safeContext.category, errorCode);

    // Forward to remote DSN if configured
    if (this.parsedDsn && this.provider !== 'mock' && this.provider !== 'none') {
      this._dispatchRemote(eventPayload);
    }

    return eventId;
  }

  /**
   * Capture an informational or warning message.
   */
  captureMessage(message, level = 'info', context = {}) {
    const eventId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const safeContext = logger.sanitizePayload(context);

    const eventPayload = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level,
      message,
      environment: this.environment,
      release: this.release,
      extra: safeContext
    };

    this.capturedEvents.push(eventPayload);
    if (this.capturedEvents.length > 500) {
      this.capturedEvents.shift();
    }

    if (this.parsedDsn && this.provider !== 'mock' && this.provider !== 'none') {
      this._dispatchRemote(eventPayload);
    }

    return eventId;
  }

  /**
   * Non-blocking HTTP POST to GlitchTip / Sentry store endpoint
   */
  _dispatchRemote(payload) {
    try {
      const data = JSON.stringify(payload);
      const client = this.parsedDsn.protocol === 'https:' ? https : http;
      const req = client.request(
        this.parsedDsn.endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=aspire-agent/1.0.0, sentry_key=${this.parsedDsn.publicKey}`
          },
          timeout: 4000
        },
        (res) => {
          res.resume(); // consume response body
        }
      );

      req.on('error', (err) => {
        logger.warn({ err: err.message, service: 'error-tracking' }, 'Failed sending error to remote tracking provider');
      });

      req.on('timeout', () => {
        req.destroy();
      });

      req.write(data);
      req.end();
    } catch (err) {
      logger.warn({ err: err.message }, 'Error dispatching remote error report');
    }
  }

  getCapturedEvents() {
    return [...this.capturedEvents];
  }

  clearEvents() {
    this.capturedEvents = [];
  }

  getStatus() {
    return {
      provider: this.provider,
      configured: !!this.parsedDsn,
      environment: this.environment,
      release: this.release,
      sampleRate: this.sampleRate,
      capturedCount: this.capturedEvents.length
    };
  }
}

// Singleton instance
const errorTrackingService = new ErrorTrackingService();

module.exports = {
  ErrorTrackingService,
  errorTrackingService
};

