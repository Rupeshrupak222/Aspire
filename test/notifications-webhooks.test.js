// ============================================================================
// ASPIRE DAY 23: NOTIFICATIONS WEBHOOKS TEST SUITE
// ============================================================================

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(os.tmpdir(), `aspire-notif-wh-test-${Date.now()}.db`);
process.env.DB_PATH = DB_FILE;
process.env.NODE_ENV = 'test';

const { db } = require('../backend/src/db');
const { updateDeliveryFromWebhook } = require('../backend/src/services/notifications/notification-delivery.service');
const { ResendEmailProvider } = require('../backend/src/services/notifications/providers/resend.provider');

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function run() {
  console.log('====================================================');
  console.log('DAY 23: NOTIFICATIONS WEBHOOKS TEST SUITE');
  console.log('====================================================\n');

  db.prepare("INSERT OR IGNORE INTO organizations (id, name, slug) VALUES (1, 'Adyapan Tech', 'adyapan')").run();

  try {
    console.log('--- 1. Resend / Svix Signature Verification ---');
    const secret = 'whsec_' + Buffer.from('test_webhook_secret_key_32bytes!').toString('base64');
    const resendProvider = new ResendEmailProvider({ webhookSecret: secret });

    const msgId = 'msg_svix_test_001';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payloadObj = { type: 'email.delivered', data: { email_id: 're_123456' } };
    const rawBody = JSON.stringify(payloadObj);

    // Compute valid signature
    const keyBuf = Buffer.from(secret.slice(6), 'base64');
    const expectedSig = crypto.createHmac('sha256', keyBuf).update(`${msgId}.${timestamp}.${rawBody}`).digest('base64');

    const validHeaders = {
      'svix-id': msgId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${expectedSig}`
    };

    ok('Valid signature returns true', resendProvider.verifyWebhook(rawBody, validHeaders) === true);

    const invalidHeaders = {
      'svix-id': msgId,
      'svix-timestamp': timestamp,
      'svix-signature': 'v1,invalid_signature_base64=='
    };
    ok('Invalid signature returns false', resendProvider.verifyWebhook(rawBody, invalidHeaders) === false);

    const expiredHeaders = {
      'svix-id': msgId,
      'svix-timestamp': (parseInt(timestamp, 10) - 600).toString(), // 10 minutes ago
      'svix-signature': `v1,${expectedSig}`
    };
    ok('Expired timestamp (> 300s) returns false', resendProvider.verifyWebhook(rawBody, expiredHeaders) === false);

    ok('Missing headers return false', resendProvider.verifyWebhook(rawBody, {}) === false);

    console.log('\n--- 2. Delivery Status State Transitions via Webhook ---');
    // Seed delivery records
    db.prepare(`
      INSERT INTO notification_deliveries (
        id, organization_id, recipient_email, channel, provider, provider_message_id,
        template_key, status
      ) VALUES ('del_wh_1', 1, 'candidate1@test.com', 'EMAIL', 'resend', 'msg_resend_deliv_1', 'EXAM_INVITATION', 'SENT')
    `).run();

    db.prepare(`
      INSERT INTO notification_deliveries (
        id, organization_id, recipient_email, channel, provider, provider_message_id,
        template_key, status
      ) VALUES ('del_wh_2', 1, 'candidate2@test.com', 'EMAIL', 'resend', 'msg_resend_bounce_2', 'EXAM_REMINDER', 'SENT')
    `).run();

    db.prepare(`
      INSERT INTO notification_deliveries (
        id, organization_id, recipient_email, channel, provider, provider_message_id,
        template_key, status
      ) VALUES ('del_wh_3', 1, 'candidate3@test.com', 'EMAIL', 'resend', 'msg_resend_fail_3', 'RESULT_AVAILABLE', 'SENT')
    `).run();

    // Event 1: Delivered
    const delRes1 = updateDeliveryFromWebhook({
      providerMessageId: 'msg_resend_deliv_1',
      eventType: 'email.delivered',
      timestamp: new Date().toISOString()
    });
    ok('Delivered webhook returns updated: true', delRes1.updated === true);
    ok('Delivered webhook returns status DELIVERED', delRes1.status === 'DELIVERED');

    const row1 = db.prepare('SELECT status, delivered_at FROM notification_deliveries WHERE id = ?').get('del_wh_1');
    ok('Database status updated to DELIVERED', row1.status === 'DELIVERED');
    ok('delivered_at timestamp recorded', Boolean(row1.delivered_at));

    // Event 2: Bounced
    const delRes2 = updateDeliveryFromWebhook({
      providerMessageId: 'msg_resend_bounce_2',
      eventType: 'email.bounced',
      metadata: { bounceReason: 'Mailbox does not exist' }
    });
    ok('Bounced webhook returns updated: true', delRes2.updated === true);
    ok('Bounced webhook returns status BOUNCED', delRes2.status === 'BOUNCED');

    const row2 = db.prepare('SELECT status, last_error_code, last_error_message FROM notification_deliveries WHERE id = ?').get('del_wh_2');
    ok('Database status updated to BOUNCED', row2.status === 'BOUNCED');
    ok('last_error_code is PROVIDER_BOUNCED', row2.last_error_code === 'PROVIDER_BOUNCED');
    ok('last_error_message recorded', row2.last_error_message === 'Mailbox does not exist');

    // Event 3: Failed / Rejected
    const delRes3 = updateDeliveryFromWebhook({
      providerMessageId: 'msg_resend_fail_3',
      eventType: 'email.failed',
      metadata: { reason: 'Blacklisted IP or domain' }
    });
    ok('Failed webhook returns status FAILED', delRes3.status === 'FAILED');

    const row3 = db.prepare('SELECT status, failed_at, last_error_code FROM notification_deliveries WHERE id = ?').get('del_wh_3');
    ok('Database status updated to FAILED', row3.status === 'FAILED');
    ok('failed_at timestamp recorded', Boolean(row3.failed_at));

    // Untracked message ID
    const untracked = updateDeliveryFromWebhook({
      providerMessageId: 'msg_untracked_999999',
      eventType: 'email.delivered'
    });
    ok('Untracked message ID returns updated: false without error', untracked.updated === false);

  } catch (err) {
    failures++;
    console.error('Unexpected test error:', err);
  } finally {
    try {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    } catch {}
    process.exit(failures > 0 ? 1 : 0);
  }
}

run();

