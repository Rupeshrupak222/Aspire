# DAY 28 — SECRET ROTATION & CREDENTIAL MANAGEMENT
## Aspire by Adyapan — Cryptographic Lifecycle and Operational Protocols

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-14  
**Author:** Security Architecture & Site Reliability Engineering  
**Classification:** Confidential — Security Standard  

---

## 1. Executive Summary & Inventory of Cryptographic Secrets

Aspire by Adyapan protects sensitive tenant data, administrative controls, student credentials, and backup artifacts using cryptographic keys and third-party service tokens. A compromised or expired secret threatens platform integrity.

This document establishes the official operational protocols for rotating all system secrets with zero unmanaged downtime, zero data loss, and uninterrupted decryptability of backup archives.

### System Secrets Inventory:

| Environment Variable | Criticality | Usage Scope | Key Algorithm / Type | Storage Location |
| :--- | :--- | :--- | :--- | :--- |
| `BACKUP_ENCRYPTION_KEY` | **Tier 0** | AES-256-GCM backup artifact encryption & decryption | 256-bit symmetric key | Environment / Secret Vault |
| `AUTH_SECRET` | **Tier 0** | JWT session issuance and verification for admins & students | 256+ bit HMAC secret | Environment / Secret Vault |
| `CERTIFICATE_SIGNING_SECRET`| **Tier 0** | HMAC-SHA256 cryptographic signatures on student certificates | 256-bit HMAC secret (Versioned) | Environment / Secret Vault |
| `R2_SECRET_ACCESS_KEY` / `AWS_SECRET_ACCESS_KEY` | **Tier 1** | Remote object store write/read credentials for backups & assets | S3 IAM Secret Key | Environment / Secret Vault |
| `RESEND_API_KEY` / `BREVO_API_KEY` | **Tier 2** | Transactional email delivery pipeline | API Bearer Token | Environment / Secret Vault |

---

## 2. Protocol 1: `BACKUP_ENCRYPTION_KEY` Rotation

The backup encryption key is used by `backend/src/services/backup/backup-encryption.service.js` to encrypt SQLite database snapshots, file asset bundles, and configuration dumps.

### 2.1 The Legacy Decryptability Challenge
If the `BACKUP_ENCRYPTION_KEY` is rotated without a transition plan, historical backups encrypted under the previous key become permanently unrecoverable in a disaster.

### 2.2 Rotation Architecture: Dual-Key Registry
The backup subsystem supports a fallback/previous key array via `BACKUP_ENCRYPTION_KEY_FALLBACKS` (comma-separated list of previous valid keys) or by re-encrypting existing archives during a planned rotation window.

### 2.3 Step-by-Step Rotation Runbook
1. **Generate New Cryptographically Secure Key:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Stage Rotation in Environment File:**
   ```env
   # Set current key as fallback, and activate new primary key:
   BACKUP_ENCRYPTION_KEY_FALLBACKS="<OLD_KEY>"
   BACKUP_ENCRYPTION_KEY="<NEW_GENERATED_KEY>"
   ```
3. **Execute Immediate On-Demand Backup with New Key:**
   ```bash
   npm run backup:create
   ```
4. **Verify New Backup Integrity:**
   ```bash
   npm run backup:verify -- --id <new_backup_id>
   ```
5. **Re-Encrypt Critical Historical Backups (Optional but Recommended):**
   For each historical recovery point that must be retained under the new key:
   ```bash
   node backend/src/commands/reencrypt-backup.js --id <old_backup_id> --old-key "<OLD_KEY>" --new-key "<NEW_GENERATED_KEY>"
   ```
6. **Archive Previous Key in Corporate Hardware Vault:**
   Securely store the previous key in 1Password / HashiCorp Vault marked with its validity timeframe (e.g. `Aspire_Backup_Key_Valid_Until_20261114`).

---

## 3. Protocol 2: `AUTH_SECRET` (JWT Signing Secret) Rotation

The `AUTH_SECRET` signs user and administrator authentication tokens using the `jose` library.

### 3.1 Impact Analysis
Rotating `AUTH_SECRET` invalidates all currently issued JWTs. Active users will encounter HTTP 401 on their next API request and will be redirected to the login screen. It does not affect database persistence or background workers.

### 3.2 Planned Rotation Procedure
1. **Schedule Maintenance Window:** Choose an off-peak hour to minimize disruptions to test-taking candidates.
2. **Generate High-Entropy Secret:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```
3. **Update Environment Variable:**
   Update `AUTH_SECRET` in `.env` or production secret manager.
4. **Graceful Application Reload:**
   ```bash
   npm restart || pm2 reload aspire-api
   ```
5. **Validation:**
   - Attempt login with existing credentials:
     ```bash
     curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@adyapan.internal","password":"<password>"}'
     ```
   - Confirm new JWT is issued with status 200.
   - Confirm old JWT tokens are rejected with 401 Unauthorized.

---

## 4. Protocol 3: `CERTIFICATE_SIGNING_SECRET` Rotation

Student digital certificates contain an HMAC-SHA256 signature calculated from the student's name, score, issue date, and organization ID.

### 4.1 Key Versioning Architecture (Day 24 Integration)
Day 24 implemented structured key versioning:
- Every certificate record in the `certificates` table stores a `key_version` column (e.g. `v1`, `v2`).
- The verification service maintains a versioned key map:
  ```javascript
  const SIGNING_KEYS = {
    'v1': process.env.CERTIFICATE_SIGNING_KEY_V1,
    'v2': process.env.CERTIFICATE_SIGNING_KEY_V2 || process.env.CERTIFICATE_SIGNING_SECRET
  };
  ```
- Public verification continues to verify older `v1` certificates against `KEY_V1` while newly issued certificates are signed with `KEY_V2`.

### 4.2 Step-by-Step Rotation Runbook
1. **Generate New Key:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Promote Keys in Environment:**
   ```env
   # Demote current secret to specific version key:
   CERTIFICATE_SIGNING_KEY_V1="<PREVIOUS_KEY>"
   # Activate new secret:
   CERTIFICATE_SIGNING_SECRET="<NEW_KEY>"
   CERTIFICATE_KEY_VERSION="v2"
   ```
3. **Deploy & Restart Services:**
   Restart API server to re-initialize the certificate verification key provider.
4. **Automated Verification Drill:**
   Run the Day 24 key rotation test suite:
   ```bash
   node test/certificate-key-rotation.test.js
   ```
   Confirm that:
   - Historical certificates continue to pass verification (Status: `VALID`).
   - New certificates are generated using `v2`.
   - Tampered certificates continue to be flagged as `INVALID`.

---

## 5. Protocol 4: Cloud Storage Credentials (AWS S3 / Cloudflare R2)

Credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` / `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) govern remote storage off-site sync.

### 5.1 Dual-Credential Rotation Procedure
Cloudflare R2 and AWS IAM support having two active API keys simultaneously:
1. **Create Secondary API Key:**
   In Cloudflare / AWS console, generate a new Access Key Pair (`Key_B`).
2. **Update Application Environment:**
   Update `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` with `Key_B`.
3. **Verify Upload Pipeline:**
   Trigger an on-demand backup upload:
   ```bash
   npm run backup:create
   ```
   Confirm upload to bucket `aspire-backups` succeeds with HTTP 200.
4. **Revoke Old Access Key:**
   In Cloudflare / AWS console, delete or deactivate `Key_A`.

---

## 6. Protocol 5: Transactional Email API Key (`RESEND_API_KEY`)

1. Log into Resend / Brevo console and create an API token with `Sending Only` permissions.
2. Update `RESEND_API_KEY` in environment.
3. Send a test email delivery or trigger test notification:
   ```bash
   node -e "require('./backend/src/services/notification.service').sendAdminAlert('Test alert', 'Secret rotation test');"
   ```
4. Confirm delivery in Resend dashboard.
5. Invalidate the old token in the Resend console.

---

## 7. Emergency Secret Compromise Checklist

If an active secret is leaked publicly (e.g. committed to GitHub, captured in client logs):

1. **IMMEDIATELY INITIATE INCIDENT RESPONSE (SEV-1).**
2. **Revoke Leaked Credential:**
   - For Cloud / Resend keys: Delete token from provider console immediately.
   - For internal keys (`AUTH_SECRET`, `BACKUP_ENCRYPTION_KEY`): Generate new random keys and redeploy within 15 minutes.
3. **Audit Access Logs:**
   - Query `audit_logs` table for abnormal activity during the window of exposure:
     ```sql
     SELECT * FROM audit_logs WHERE created_at >= '<compromise_timestamp>' ORDER BY created_at DESC;
     ```
   - Check S3 access logs for unauthorized backup bucket downloads.
4. **Re-Encrypt Backups:**
   If `BACKUP_ENCRYPTION_KEY` was leaked, assume historical backups may be compromised if attacker had filesystem access. Re-encrypt all retained archives with a fresh key and rotate bucket write permissions.
5. **Issue Post-Mortem Incident Report.**

