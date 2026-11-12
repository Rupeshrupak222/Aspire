# ASPIRE BY ADYAPAN
# EMAIL PROVIDER SETUP GUIDE
## Production Configuration for Resend, DNS Verification, and Webhook Ingestion

**Date:** 2026-11-12  
**Applies To:** Aspire by Adyapan v1.0+ (Day 23 Milestone)  

---

## 1. Overview

Aspire by Adyapan utilizes a modular email abstraction layer that supports two operating modes:

1. **Mock Email Provider (`mock`):** Active by default in local development and automated CI testing. Requires zero credentials, zero network access, and records all outgoing emails in an in-memory audit log for inspection.
2. **Resend Email Provider (`resend`):** Enterprise-grade transactional email service powered by the official `resend` Node.js SDK. Delivers real emails with DKIM signing, high deliverability, and real-time delivery status callbacks via Svix webhooks.

This guide provides step-by-step instructions for transitioning from the default Mock provider to the production Resend service.

---

## 2. Environment Variables Reference

Configure the following variables in your `.env` file or cloud secrets manager:

| Variable | Required in Prod? | Default (Dev/Test) | Description |
| :--- | :---: | :--- | :--- |
| `EMAIL_PROVIDER` | No | `mock` | Specifies active provider: `resend` or `mock`. Defaults to `mock` if unset. |
| `RESEND_API_KEY` | **Yes** (if `resend`) | `""` | Resend API secret key (format: `re_...`). |
| `RESEND_FROM_EMAIL` | **Yes** (if `resend`) | `notifications@aspire.adyapan.internal` | Authenticated sender identity (e.g. `Aspire <notifications@aspire.adyapan.internal>`). |
| `RESEND_WEBHOOK_SECRET`| Recommended | `""` | Svix HMAC webhook secret for verifying incoming delivery status callbacks (`whsec_...`). |
| `APP_BASE_URL` | Recommended | `http://localhost:3000` | Canonical platform URL used to construct links in email templates. |

---

## 3. Step-by-Step Production Setup with Resend

### Step 1: Create a Resend Account & API Key
1. Sign up or log into [Resend Console](https://resend.com).
2. Navigate to **API Keys** in the sidebar.
3. Click **Create API Key**.
4. Set permission to **Sending Access** (or **Full Access**), assign a label (e.g. `aspire-production`), and copy the generated secret key (starts with `re_`).

### Step 2: Domain Verification (SPF, DKIM, and DMARC)
To guarantee high inbox deliverability and prevent emails from landing in spam, verify your custom domain in Resend:

1. In the Resend Console, navigate to **Domains** -> **Add Domain**.
2. Enter your corporate sending domain (e.g. `aspire.adyapan.internal` or `adyapan.com`).
3. Add the DNS records provided by Resend to your domain registrar (e.g. Cloudflare, AWS Route 53, GoDaddy):

#### Required DNS Records:
- **DKIM (DomainKeys Identified Mail):**
  - Type: `CNAME` or `TXT`
  - Host: `resend._domainkey`
  - Value: Provided by Resend console
- **SPF (Sender Policy Framework):**
  - Type: `TXT`
  - Host: `@` (or subdomain)
  - Value: `v=spf1 include:amazonses.com ~all` (or custom Resend record)
- **DMARC (Domain-based Message Authentication):**
  - Type: `TXT`
  - Host: `_dmarc`
  - Value: `v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-reports@yourdomain.com`

4. Once DNS propagates, click **Verify Domain** in Resend until status indicates **Verified**.

### Step 3: Configure Inbound Delivery Webhooks
Resend dispatches asynchronous events when emails are delivered, bounced, or flagged as spam.

1. Navigate to **Webhooks** in the Resend Console.
2. Click **Add Webhook**.
3. **Endpoint URL:** `https://<your-aspire-domain>/api/webhooks/email/resend`
4. **Events to Subscribe:**
   - `email.sent`
   - `email.delivered`
   - `email.bounced`
   - `email.complained`
5. Click **Create Webhook**.
6. Copy the **Signing Secret** (starts with `whsec_`).

### Step 4: Apply Configuration to Aspire
Update your production `.env` configuration:

```bash
# Activation flag
EMAIL_PROVIDER=resend

# Credentials
RESEND_API_KEY=re_123456789_abcdefghijklmnopqrstuvwxyz
RESEND_FROM_EMAIL="Aspire by Adyapan <notifications@yourdomain.com>"
RESEND_WEBHOOK_SECRET=whsec_abcdef1234567890abcdef1234567890

# Platform base URL for emails
APP_BASE_URL=https://aspire.yourdomain.com
```

Restart the Aspire application server to apply changes.

---

## 4. Operational Verification

### 4.1 Check Provider Health via Super Admin API
Authenticate as a `SUPER_ADMIN` and query the overview endpoint:

```bash
curl -X GET https://your-aspire-domain/api/admin/notifications/overview \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>"
```

**Expected JSON Response:**
```json
{
  "status": "success",
  "data": {
    "provider": {
      "provider": "resend",
      "isConfigured": true,
      "senderName": "Aspire by Adyapan",
      "senderAddress": "notifications@yourdomain.com",
      "hasWebhookSecret": true,
      "mode": "live"
    },
    "metrics": {
      "total": 124,
      "sent": 118,
      "delivered": 112,
      "pending": 2,
      "processing": 0,
      "failed": 2,
      "bounced": 2,
      "complained": 0,
      "cancelled": 0,
      "deliveryRate": 96.8
    }
  }
}
```

### 4.2 Test an Interactive Workflow
1. Register a test student candidate at `https://your-aspire-domain/index.html`.
2. Inspect the candidate's inbox for the luxury welcome email.
3. Open the Super Admin **Notifications** panel at `/admin.html#pane-notifications` to verify that the dispatch row transitioned from `PENDING` -> `SENT` -> `DELIVERED`.

---

## 5. Troubleshooting Common Issues

| Symptom | Root Cause | Resolution |
| :--- | :--- | :--- |
| `PROVIDER_NOT_CONFIGURED` | Missing `RESEND_API_KEY` | Ensure `RESEND_API_KEY` is defined in `.env` and `EMAIL_PROVIDER=resend`. |
| `UNVERIFIED_DOMAIN (403)` | Sending domain not verified in Resend | Verify DKIM and SPF records in your DNS management console. |
| `Webhook 401 Unauthorized` | Invalid `RESEND_WEBHOOK_SECRET` | Verify that the webhook signing secret in `.env` matches the secret displayed in Resend Webhook settings. |
| Rate Limit `429 Too Many Requests` | Burst exceeded Resend API quotas | The built-in BullMQ rate limiter caps requests at 50/sec. If your plan has a lower limit, adjust the worker token bucket in `notification.worker.js`. |
| Emails landing in Spam | Missing DMARC record or neutral SPF | Add a valid DMARC `TXT` record (`_dmarc.yourdomain.com`) with `p=quarantine` or `p=reject`. |

---

## 6. Switching Back to Mock Mode
If external credentials expire or you need an isolated local debugging session, set:

```bash
EMAIL_PROVIDER=mock
```

The system will instantly redirect all transactional dispatches to the in-memory log with zero downtime.

