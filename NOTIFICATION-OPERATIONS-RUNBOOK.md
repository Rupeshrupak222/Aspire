# ASPIRE BY ADYAPAN
# NOTIFICATION OPERATIONS RUNBOOK
## SRE & Operations Guide — BullMQ Workers, Outbox Dispatcher, Delivery Telemetry & Incident Playbooks

**Date:** 2026-11-12  
**Version:** 1.0.0  
**Target Audience:** SREs, DevOps Engineers, and Platform Administrators  

---

## 1. System Topology & Component Overview

The Aspire notification system is engineered for resilient, decoupled operation:

```
+-------------------------------------------------------------------------------------------------------+
|                                        NOTIFICATION SUBSYSTEM                                         |
+--------------------------+------------------------------+---------------------------------------------+
| Component                | Implementation File          | Role                                        |
+--------------------------+------------------------------+---------------------------------------------+
| Outbox Dispatcher        | src/workers/outbox-dispatcher| Polls outbox_events in SQLite; enqueues jobs |
| Notification Queue       | src/queues/notification.queue| BullMQ queue (Redis) with direct fallback   |
| Notification Worker      | src/workers/notification.work| Consumes jobs, renders HTML, sends to Resend |
| Delivery Service         | src/services/notifications/  | State transitions, retries, metrics, logging|
| Webhook Ingestion        | src/routes/webhooks.js       | Processes Resend delivery/bounce callbacks  |
+--------------------------+------------------------------+---------------------------------------------+
```

---

## 2. Operational Health Monitoring & KPIs

### 2.1 Core Health Indicators (SLIs / SLOs)
- **Delivery Success Rate:** Target $\ge 98.0\%$. Alert if $< 92.0\%$ over a 15-minute window.
- **Dispatch Latency:** $P_{95} \le 5\text{ seconds}$ from database commit to provider dispatch.
- **Outbox Queue Depth:** Normal depth $< 10$ pending records. Alert if $> 100$ records persist for $> 3\text{ minutes}$.
- **Worker Concurrency Limit:** 50 requests/second token bucket.

### 2.2 Health Check Endpoint
Query the Super Admin overview endpoint every 60 seconds:

```bash
curl -s -X GET https://<host>/api/admin/notifications/overview \
  -H "Authorization: Bearer <SUPER_ADMIN_TOKEN>"
```

### 2.3 Authoritative Database Inspection Queries

#### Inspect Backlogged or Pending Deliveries:
```sql
SELECT status, COUNT(*) 
FROM notification_deliveries 
GROUP BY status;
```

#### Inspect Recent Failed Deliveries:
```sql
SELECT id, recipient_email, template_key, last_error_code, last_error_message, attempt_count, updated_at
FROM notification_deliveries
WHERE status = 'FAILED'
ORDER BY updated_at DESC
LIMIT 15;
```

#### Check Outbox Backlog:
```sql
SELECT COUNT(*) AS pending_outbox_count
FROM outbox_events
WHERE event_type = 'NOTIFICATION_EMAIL' AND status = 'PENDING';
```

---

## 3. Worker & Queue Management

### 3.1 Managing the BullMQ Worker Process
In production environments, the worker runs as a dedicated daemon managed by systemd or PM2:

```bash
# Start background outbox dispatcher & worker
npm run worker

# Check status in PM2
pm2 status aspire-worker

# Restart the worker
pm2 restart aspire-worker
```

### 3.2 Operating Without Redis (Direct Fallback Mode)
If Redis is temporarily unavailable or in local test environments, the system automatically activates **Direct Fallback Mode**. The outbox dispatcher executes delivery synchronously via `setImmediate()` without throwing runtime exceptions.

---

## 4. Incident Response Playbooks

### Playbook 1: Spike in `FAILED` Notifications
**Symptoms:** Delivery success rate drops below 95%; `status = 'FAILED'` count climbs.

1. **Query error codes:**
   ```sql
   SELECT last_error_code, COUNT(*) 
   FROM notification_deliveries 
   WHERE status = 'FAILED' 
   GROUP BY last_error_code;
   ```
2. **If `UNVERIFIED_DOMAIN` or `PROVIDER_403`:**
   - The sending domain in `RESEND_FROM_EMAIL` has not completed DNS verification.
   - Inspect Resend Console -> Domains. Verify that DKIM and SPF records are active.
3. **If `RATE_LIMITED` (`429`):**
   - The platform exceeded Resend API bursts.
   - Verify that `notification.worker.js` rate limiting is active. Throttle `max: 50` down to `max: 20` if using a lower tier.
4. **Resolution Action:** Once the underlying cause is resolved, trigger batch retries (see Section 5).

---

### Playbook 2: Outbox Backlog (Messages Stuck in `PENDING`)
**Symptoms:** Outbox query shows high count of `PENDING` outbox records; candidates report delays.

1. **Verify outbox dispatcher status:**
   - Check application server logs for `outbox-dispatcher` heartbeat.
2. **Verify database locking:**
   - Ensure SQLite WAL mode is active:
     ```sql
     PRAGMA journal_mode; -- Must return 'wal'
     ```
3. **Restart the dispatcher service:**
   ```bash
   pm2 restart aspire-api
   ```

---

### Playbook 3: Inbound Webhook Fails Verification (`401 Unauthorized`)
**Symptoms:** Delivery logs remain in `SENT` status rather than updating to `DELIVERED` or `BOUNCED`. Webhook logs report `Received Resend webhook with invalid or missing signature`.

1. **Verify `RESEND_WEBHOOK_SECRET`:**
   - Confirm that the `RESEND_WEBHOOK_SECRET` environment variable matches the signing secret displayed in the Resend Console under Webhook Settings (`whsec_...`).
2. **Verify Reverse Proxy Configuration:**
   - Confirm that your load balancer or reverse proxy (Nginx, Cloudflare, Traefik) passes raw headers `svix-id`, `svix-timestamp`, and `svix-signature` intact.
   - Ensure body parser preserves raw body strings for HMAC validation (`routes/webhooks.js` uses `express.raw({ type: 'application/json' })` or standard JSON with intact bytes).

---

### Playbook 4: Candidate Reports Missing Email
**Investigation Steps:**

1. **Search Delivery Log by Recipient:**
   ```sql
   SELECT * FROM notification_deliveries 
   WHERE recipient_email = 'student@example.com' 
   ORDER BY created_at DESC;
   ```
2. **Interpret Status:**
   - **`CANCELLED` (`MUTED_BY_PREFERENCES`):** The candidate or organization disabled notifications for this category in preferences.
   - **`BOUNCED`:** The candidate's mailbox rejected the message (e.g. invalid mailbox or full inbox).
   - **`DELIVERED`:** The email provider acknowledged delivery to the destination MX server. Instruct the student to check Spam / Promotions folder or corporate quarantine.
   - **`FAILED`:** Check `last_error_message` and click **Retry** in the Admin UI.

---

## 5. Manual Retries & Recovery Actions

### 5.1 Single Delivery Retry via UI
1. Log into `https://<host>/admin.html`.
2. Navigate to the **Notifications** tab.
3. Locate the failed delivery row and click the **Retry** action button.

### 5.2 Single Delivery Retry via REST API
```bash
curl -X POST https://<host>/api/organization/notifications/<DELIVERY_ID>/retry \
  -H "Authorization: Bearer <ORG_ADMIN_JWT>"
```

### 5.3 Batch Retry Script for Incident Recovery
If hundreds of deliveries failed during an external provider outage, run the recovery batch script:

```bash
node -e "
const { db } = require('./backend/src/db');
const { retryDelivery } = require('./backend/src/services/notifications/notification-delivery.service');

async function recover() {
  const failed = db.prepare('SELECT id FROM notification_deliveries WHERE status = \"FAILED\"').all();
  console.log('Retrying ' + failed.length + ' deliveries...');
  for (const row of failed) {
    try {
      await retryDelivery(row.id);
      console.log('Retried ' + row.id);
    } catch (e) {
      console.error('Failed ' + row.id, e.message);
    }
  }
}
recover();
"
```

---

## 6. Secret Rotation & Security Maintenance

### 6.1 Rotating Resend API Key
1. Generate a new API Key in the Resend Console.
2. Update `RESEND_API_KEY` in environment secrets.
3. Perform a zero-downtime rolling restart of the application and worker processes.
4. Verify healthy dispatch via `GET /api/admin/notifications/overview`.
5. Revoke the old API key in the Resend Console.

### 6.2 Rotating Webhook Signing Secret
1. Create a second webhook endpoint in Resend pointing to `/api/webhooks/email/resend`.
2. Update `RESEND_WEBHOOK_SECRET` in environment secrets.
3. Restart application servers.
4. Delete the obsolete webhook endpoint in the Resend Console.

