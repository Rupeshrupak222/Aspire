# DAY 28 — DISASTER RECOVERY & RESTORE RUNBOOK
## Aspire by Adyapan — SRE Emergency Operational Procedures

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-14  
**Author:** Site Reliability Engineering & Incident Management  
**Classification:** Critical Operational Standard  

---

## 1. Purpose & Incident Scope

This runbook defines the authoritative, step-by-step operational instructions for recovering **Aspire by Adyapan** during catastrophic data loss, database corruption, accidental administrative deletion, physical hardware failure, or bad deployments.

All engineers on-call or conducting disaster recovery operations **must** adhere strictly to the protocols herein.

---

## 2. Emergency Assessment & Decision Matrix

| Incident Type | Symptoms / Indicators | Target Action | Expected RTO | Expected RPO |
| :--- | :--- | :--- | :--- | :--- |
| **Scenario A: SQLite Database Corruption** | `SqliteError: file is corrupted` or `PRAGMA integrity_check` failure. | Full Staged Database Restore | < 5 Minutes | < 24 Hours (or last backup) |
| **Scenario B: Accidental Data Deletion** | Tenant records, exams, or student attempts accidentally deleted by operator. | Point-in-Time Database Restore | < 10 Minutes | Point-in-time of prior backup |
| **Scenario C: Host Server / Compute Loss** | Physical hardware destruction, host VM terminated, drive destroyed. | Bare-Metal Cold Rebuild & Restore | < 20 Minutes | Point-in-time of prior backup |
| **Scenario D: Asset Directory Loss** | Tenant branding and certificate assets in `data/uploads/` missing (HTTP 404s). | Asset-Only / Bundle Extraction | < 3 Minutes | Point-in-time of prior backup |
| **Scenario E: Failed Deployment Rollout** | Unrecoverable schema migration or application crash post-deployment. | Pre-Restore / Pre-Deploy Rollback | < 2 Minutes | 0 (Revert to pre-deploy DB) |

---

## 3. Incident Phase 1: Immediate Triage & Traffic Mitigation

### 3.1 Step 1: Prevent Further Ingress & Stop Writing
Before touching persistence files, stop incoming writes to avoid further corrupting the WAL journal:
```bash
# In production environment:
systemctl stop aspire-api || pm2 stop aspire-api || npm stop
```

If running locally or in development:
Terminate the node process running the API server or background workers.

### 3.2 Step 2: Inspect Database Health
Run quick diagnostics against the live SQLite file:
```bash
node -e "const db = require('better-sqlite3')('data/aspire.db'); console.log(db.pragma('integrity_check')); console.log(db.pragma('foreign_key_check'));"
```
- If the output is `[ { integrity_check: 'ok' } ]` and empty `foreign_key_check`, corruption is not present. Do not execute destructive restore without confirming data loss.
- If output returns errors (e.g. `page ... is corrupted`), proceed to **Section 4**.

---

## 4. Incident Phase 2: Locating & Verifying Backup Recovery Points

### 4.1 Step 1: List Available Backups
List all local and cataloged backup points:
```bash
npm run backup:list
```

Example Output:
```
====================================================
ASPIRE BY ADYAPAN — AVAILABLE BACKUP REPOSITORY
====================================================

Found 3 backup archive(s):

STATUS    BACKUP ID                           CREATED AT                SIZE (MB)   ENCRYPTED   SCHEMA
---------------------------------------------------------------------------------------------------------
VALID     bak_20261114_131938_e8c95174        14/11/2026, 6:49:38 pm    19.17       YES         020_monitoring_observability
VALID     bak_20261113_020000_a1f23b89        13/11/2026, 2:00:00 am    18.94       YES         020_monitoring_observability
VALID     bak_20261112_020000_cc849102        12/11/2026, 2:00:00 am    18.52       YES         020_monitoring_observability
```

Select the most recent `VALID` backup created prior to the incident timestamp.

### 4.2 Step 2: Verify Cryptographic Integrity of Selected Backup
Before restoring, confirm that the backup's `manifest.json` and SHA-256 artifact checksums match:
```bash
npm run backup:verify -- --id bak_20261114_131938_e8c95174
```

Required Output:
```
  PASS  Manifest schema validated.
  PASS  All SHA-256 artifact checksums matched.
  PASS  Packaging integrity confirmed.
```

> [!CAUTION]
> If `backup:verify` fails with checksum mismatches or invalid schema, **DO NOT** attempt to restore this recovery point. Select the preceding backup.

---

## 5. Incident Phase 3: Dry-Run Restore Simulation

Always simulate the restore before touching live production storage:
```bash
npm run backup:restore -- --id bak_20261114_131938_e8c95174 --dry-run
```

### Dry-Run Verification Checklist:
1. `Database Integrity: ok`
2. `Foreign Key Check: PASSED`
3. `Encrypted Artifacts: YES` (Decryption key verified)
4. Record counts match expectations:
   - Check `organizations`, `users`, `students`, `attempts`, `certificates`.
5. Staged schema version matches target environment.

---

## 6. Incident Phase 4: Executing Live Disaster Recovery

Once dry-run validation passes, execute the live staged restore.

```bash
npm run backup:restore -- --id bak_20261114_131938_e8c95174 --confirm
```

### What the Engine Executes Automatically:
1. **Pre-Restore Rollback Snapshot:** Copies `data/aspire.db` to `data/backups/aspire.db.pre-restore.<timestamp>`. Even in total failure, the state before restore can be recovered.
2. **Safe Connection Severing:** Invokes `closeDatabase()` to drain SQLite connections.
3. **Atomic File Replacement:** Atomically swaps `data/aspire.db` with the decrypted, verified staged snapshot.
4. **Journal Cleanup:** Unlinks orphaned `data/aspire.db-wal` and `data/aspire.db-shm` files to ensure SQLite mounts the restored DB clean.
5. **Asset Restoration:** Reconstructs `data/uploads/` and `data/logo/` files from `files-bundle.json`.
6. **Live Connection Re-binding:** Invokes `reopenDatabase()` to refresh the internal Proxy.
7. **Audit Logging:** Inserts a permanent disaster recovery record into the `audit_logs` table.

Expected Success Banner:
```
====================================================
DISASTER RECOVERY RESTORE COMPLETED SUCCESSFULLY
====================================================
Backup bak_20261114_131938_e8c95174 has been restored to:
  Database: ./data/aspire.db
  Uploads:  C:\Aspire\data\uploads
Pre-restore safety snapshot retained at:
  C:\Aspire\data\backups\aspire.db.pre-restore.1794235800000
```

---

## 7. Incident Phase 5: Post-Restore Verification & Sanity Checks

Verify data health before resuming public traffic:

### 7.1 Verify SQLite Integrity and Table Integrity
```bash
node -e "const db = require('better-sqlite3')('data/aspire.db'); console.log('Integrity:', db.pragma('integrity_check')); console.log('Users count:', db.prepare('SELECT count(*) as c FROM users').get().c); console.log('Orgs count:', db.prepare('SELECT count(*) as c FROM organizations').get().c); console.log('Certificates count:', db.prepare('SELECT count(*) as c FROM certificates').get().c);"
```

### 7.2 Run Core Regression Suites
Ensure core services function cleanly against the restored database:
```bash
npm run test:day28
npm run test:certificates
```

### 7.3 Start Workers & Services
Restart the application and background workers:
```bash
npm start
# Or systemctl start aspire-api
```

### 7.4 Monitor Health Endpoint
Verify application health via the Day 27 observability endpoint:
```bash
curl http://localhost:3000/health
```
Ensure database status returns `"up"` and latency is normal.

---

## 8. Rollback Protocol: Reverting a Failed Restore

If, for any reason, post-restore checks reveal that the restored state is incorrect or older than desired:

1. Stop the application:
   ```bash
   npm stop || pm2 stop aspire-api
   ```
2. Locate the pre-restore safety snapshot in `data/backups/`:
   ```bash
   ls data/backups/aspire.db.pre-restore.*
   ```
3. Copy the pre-restore snapshot over `data/aspire.db`:
   ```bash
   cp data/backups/aspire.db.pre-restore.<timestamp> data/aspire.db
   rm -f data/aspire.db-wal data/aspire.db-shm
   ```
4. Restart the application. Live database is restored to the exact state it was in prior to the restore invocation.

---

## 9. Scenario-Specific Execution Guides

### 9.1 Scenario C: Bare-Metal / Clean Server Cold Rebuild
In the event of total server loss:
1. Clone the repository to the new host:
   ```bash
   git clone https://github.com/adyapan/aspire.git /opt/aspire
   cd /opt/aspire
   npm install --production
   ```
2. Populate `.env` with required runtime variables (`PORT`, `AUTH_SECRET`, `BACKUP_ENCRYPTION_KEY`, etc.).
3. Retrieve latest backup archive from off-site storage (Cloudflare R2 or AWS S3):
   ```bash
   # Using AWS CLI:
   aws s3 cp s3://aspire-backups/bak_20261114_131938_e8c95174 ./data/backups/bak_20261114_131938_e8c95174 --recursive
   ```
4. Run live restore:
   ```bash
   npm run backup:restore -- --id bak_20261114_131938_e8c95174 --confirm
   ```
5. Start service:
   ```bash
   npm start
   ```

### 9.2 Scenario D: Uploads / Asset Restoration Only
If only `data/uploads/` was corrupted or deleted:
1. Execute dry-run to stage the bundle:
   ```bash
   npm run backup:restore -- --id <backupId> --dry-run
   ```
2. The staging directory will contain the unencrypted `files-bundle.json`.
3. Unpack directly using node:
   ```bash
   node -e "const { unpackFilesBundle } = require('./backend/src/services/backup/file-backup.service'); const bundle = JSON.parse(require('fs').readFileSync('data/backups/.staging/files-bundle.json', 'utf8')); unpackFilesBundle(bundle, './data/uploads', './data/logo');"
   ```
4. Re-verify assets exist in `data/uploads/organizations/`.

