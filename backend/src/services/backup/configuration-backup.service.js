const { getConfig } = require('../../db');

const CONFIG_DICTIONARY = [
  { name: 'PORT', purpose: 'HTTP listening port', required: false, secret: false, restoreFrom: 'Default (3000) or deployment config' },
  { name: 'NODE_ENV', purpose: 'Application runtime environment', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'DB_PATH', purpose: 'Filesystem path to primary SQLite database', required: false, secret: false, restoreFrom: 'Deployment config / mount' },
  { name: 'STORAGE_LOCAL_DIR', purpose: 'Filesystem directory for tenant file uploads', required: false, secret: false, restoreFrom: 'Persistent volume mount' },
  { name: 'STORAGE_MAX_UPLOAD_SIZE_BYTES', purpose: 'Maximum permitted upload file size', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'LOG_LEVEL', purpose: 'Pino structured logging verbosity', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'LOG_FORMAT', purpose: 'Log output format (json vs pretty)', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'REDIS_URL', purpose: 'Redis connection string for BullMQ broker', required: false, secret: false, restoreFrom: 'Infrastructure config' },
  { name: 'AUTH_SECRET', purpose: 'JWT signing secret for user authentication', required: true, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'CERTIFICATE_SIGNING_SECRET', purpose: 'HMAC cryptographic key for digital certificate verification', required: true, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'CERTIFICATE_KEY_ROTATION_SECRETS', purpose: 'Historical keys for legacy certificate verification', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'BACKUP_ENCRYPTION_KEY', purpose: 'AES-256-GCM symmetric key for backup archive encryption', required: true, secret: true, restoreFrom: 'Secure Secrets Manager (External)' },
  { name: 'ONLINECOMPILER_API_KEY', purpose: 'API key for primary code execution engine', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'JUDGE0_API_KEY', purpose: 'API key for secondary code execution fallback', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'RESEND_API_KEY', purpose: 'API key for transactional email delivery', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'R2_ACCESS_KEY_ID', purpose: 'Cloudflare R2 / S3 storage access key ID', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'R2_SECRET_ACCESS_KEY', purpose: 'Cloudflare R2 / S3 storage secret key', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'R2_BUCKET_NAME', purpose: 'Cloudflare R2 storage bucket name', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'DISCORD_WEBHOOK_URL', purpose: 'Webhook URL for critical alert notifications', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'TELEGRAM_BOT_TOKEN', purpose: 'Bot token for incident notification dispatch', required: false, secret: true, restoreFrom: 'Secure Secrets Manager' },
  { name: 'BACKUP_STORAGE_PROVIDER', purpose: 'Target storage provider for backups (local/s3/rclone)', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'BACKUP_DIRECTORY', purpose: 'Local destination directory for backup archives', required: false, secret: false, restoreFrom: 'Persistent volume mount' },
  { name: 'BACKUP_RETENTION_DAILY_DAYS', purpose: 'Days to retain daily backups', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'BACKUP_RETENTION_WEEKLY_WEEKS', purpose: 'Weeks to retain weekly backups', required: false, secret: false, restoreFrom: 'Deployment config' },
  { name: 'BACKUP_RETENTION_MONTHLY_MONTHS', purpose: 'Months to retain monthly backups', required: false, secret: false, restoreFrom: 'Deployment config' }
];

class ConfigurationBackupService {
  /**
   * Extract non-secret runtime configuration and variable inventory.
   * NEVER dumps secrets or raw .env into the exported payload.
   * @param {import('better-sqlite3').Database} [targetDb]
   * @returns {object} Sanitized configuration backup payload
   */
  generateConfigBackup(targetDb) {
    // 1. Build sanitized environment variable map (only non-secret keys)
    const sanitizedEnv = {};
    for (const item of CONFIG_DICTIONARY) {
      if (!item.secret && process.env[item.name] !== undefined) {
        sanitizedEnv[item.name] = process.env[item.name];
      }
    }

    // 2. Fetch non-secret database config table
    let dbConfig = {};
    let subscriptionPlans = [];
    let latestMigration = null;

    if (targetDb) {
      try {
        dbConfig = getConfig(targetDb);
      } catch {}

      try {
        const rows = targetDb.prepare('SELECT id, name, display_name, price_monthly_inr, max_exams_per_month, max_candidates_per_month, max_questions, max_certificates, max_code_executions_per_month, max_storage_mb, features_json FROM subscription_plans ORDER BY id ASC').all();
        subscriptionPlans = rows.map(r => ({
          ...r,
          features: r.features_json ? JSON.parse(r.features_json) : {}
        }));
      } catch {}

      try {
        const row = targetDb.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1').get();
        if (row) latestMigration = row;
      } catch {}
    }

    return {
      backupTimestamp: new Date().toISOString(),
      configurationInventory: CONFIG_DICTIONARY,
      environmentSettings: sanitizedEnv,
      databaseConfig: dbConfig,
      subscriptionPlanTemplates: subscriptionPlans,
      schemaMigrationVersion: latestMigration ? latestMigration.version : 'unknown',
      securityNotice: 'This artifact contains only non-secret architectural configuration. All cryptographic keys, database passwords, and API secrets must be restored from an approved secret management provider.'
    };
  }
}

module.exports = new ConfigurationBackupService();

