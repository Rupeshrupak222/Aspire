// ============================================================================
// ASPIRE DAY 27: TELEGRAM BOT ALERT PROVIDER
// ============================================================================

const https = require('https');
const logger = require('../../../utils/logger');

class TelegramAlertProvider {
  constructor(botToken = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  async sendAlert(alert) {
    if (!this.botToken || !this.chatId) return { sent: false, reason: 'NO_TELEGRAM_CREDENTIALS' };

    const prefix = alert.isRecovery ? '✅ *RESOLVED*' : `🚨 *${alert.severity} INCIDENT*`;
    let text = `${prefix}\n\n`;
    text += `*${alert.title}*\n`;
    text += `${alert.message}\n\n`;
    text += `• *Service:* \`${alert.service || 'aspire'}\`\n`;
    text += `• *Environment:* \`${alert.environment || 'development'}\`\n`;
    text += `• *Time:* ${alert.timestamp || new Date().toISOString()}\n`;

    if (alert.correlationId) {
      text += `• *Correlation ID:* \`${alert.correlationId}\`\n`;
    }

    if (alert.recommendedAction) {
      text += `\n*Action Required:* ${alert.recommendedAction}\n`;
    }

    const payload = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown'
    });

    const endpoint = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    return new Promise((resolve) => {
      try {
        const req = https.request(
          endpoint,
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
            resolve({ sent: res.statusCode === 200, statusCode: res.statusCode });
          }
        );

        req.on('error', (err) => {
          logger.warn({ err: err.message }, 'Failed sending Telegram alert');
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

module.exports = TelegramAlertProvider;

