// ============================================================================
// ASPIRE DAY 27: DISCORD WEBHOOK ALERT PROVIDER
// ============================================================================

const https = require('https');
const http = require('http');
const logger = require('../../../utils/logger');

const SEVERITY_COLORS = {
  P0: 0xDC2626, // Red
  P1: 0xEA580C, // Orange
  P2: 0xEAB308, // Yellow
  P3: 0x2563EB, // Blue
  RESOLVED: 0x16A34A // Green
};

class DiscordAlertProvider {
  constructor(webhookUrl = process.env.DISCORD_WEBHOOK_URL) {
    this.webhookUrl = webhookUrl;
  }

  async sendAlert(alert) {
    if (!this.webhookUrl) return { sent: false, reason: 'NO_WEBHOOK_URL' };

    const color = alert.isRecovery ? SEVERITY_COLORS.RESOLVED : (SEVERITY_COLORS[alert.severity] || 0x6B7280);
    const prefix = alert.isRecovery ? '✅ [RESOLVED]' : `🚨 [${alert.severity}]`;

    const embed = {
      title: `${prefix} ${alert.title}`,
      description: alert.message,
      color,
      timestamp: alert.timestamp || new Date().toISOString(),
      fields: [
        { name: 'Service', value: alert.service || 'aspire-platform', inline: true },
        { name: 'Environment', value: alert.environment || 'development', inline: true },
        { name: 'Severity', value: alert.severity, inline: true }
      ],
      footer: { text: 'Aspire by Adyapan — SRE & Observability Engine' }
    };

    if (alert.correlationId) {
      embed.fields.push({ name: 'Correlation ID', value: alert.correlationId, inline: true });
    }

    if (alert.recommendedAction) {
      embed.fields.push({ name: 'Recommended Action', value: alert.recommendedAction, inline: false });
    }

    if (alert.dashboardUrl) {
      embed.fields.push({ name: 'Operations Dashboard', value: alert.dashboardUrl, inline: false });
    }

    const payload = JSON.stringify({
      username: 'Aspire SRE Monitor',
      embeds: [embed]
    });

    return new Promise((resolve) => {
      try {
        const url = new URL(this.webhookUrl);
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
          this.webhookUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 5000
          },
          (res) => {
            res.resume();
            resolve({ sent: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
          }
        );

        req.on('error', (err) => {
          logger.warn({ err: err.message }, 'Failed sending Discord webhook alert');
          resolve({ sent: false, error: err.message });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ sent: false, error: 'TIMEOUT' });
        });

        req.write(payload);
        req.end();
      } catch (err) {
        resolve({ sent: false, error: err.message });
      }
    });
  }
}

module.exports = DiscordAlertProvider;

