# DAY 28 — BACKUP AND DISASTER RECOVERY ARCHITECTURE
## Aspire by Adyapan — Enterprise Multi-Tenant SaaS Resilience Model

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-14  
**Author:** Platform Engineering, SRE & Database Reliability Group  
**Classification:** Internal Technical Standard  

---

## 1. Executive Overview

Aspire by Adyapan is a multi-tenant scholarship assessment and technical evaluation platform. Its authoritative ledger consists of student records, exam submissions, automated scoring decisions, digital certificate cryptographic credentials, organization branding assets, and audit logs.

The Day 28 Backup and Disaster Recovery (BDR) subsystem provides a zero-data-loss, tamper-evident, cryptographically secure resilience pipeline. It protects against:
1. **Accidental Deletion & Administrative Error:** Individual tenant or platform record erasure.
2. **Database Corruption:** SQLite page-level bit-rot or crash inconsistencies.
3. **Storage & Hardware Failure:** Physical volume detachment or drive degradation.
4. **Catastrophic Infrastructure Loss:** Data center outage requiring cold rebuild on clean compute.
5. **Ransomware & Tampering:** Hostile file modification detected via authenticated AES-256-GCM and SHA-256 integrity trees.

---

## 2. High-Level Resilience Architecture

The Aspire resilience pipeline separates ephemeral brokers (Redis, BullMQ) from persistent state (SQLite, asset directories). Redis can be cold-restarted at any moment; persistent state cannot.

```
+--------------------------------------------------------------------------------------------------+
|                                      ASPIRE LIVE APPLICATION                                     |
|                                                                                                  |
|   +-------------------+      +-------------------------+      +------------------------------+   |
|   |   better-sqlite3  |      |   Tenant File Storage   |      |  Platform Runtime Config     |   |
|   |  data/aspire.db   |      |   data/uploads/         |      |  config table, env vars,     |   |
|   |  (WAL + SHM)      |      |   data/logo/            |      |  subscription plans          |   |
|   +---------+---------+      +------------+------------+      +--------------+---------------+   |
+-------------|-----------------------------|----------------------------------|-------------------+
              |                             |                                  |
              v                             v                                  v
+--------------------------------------------------------------------------------------------------+
|                                BACKUP SUBSYSTEM ORCHESTRATION                                    |
|                                                                                                  |
|  [1. db.backup()]           [2. Files Bundler]            [3. Config Serializer]                 |
|  Online snapshot via         Traverses uploads & logos     Extracts non-sensitive state          |
|  SQLite online backup API    Base64 encoding + hashes      Schema version & plan matrix          |
|             |                             |                                  |                   |
|             +-----------------------------+----------------------------------+                   |
|                                           |                                                      |
|                                           v                                                      |
|                             [4. Integrity Verification]                                          |
|                             PRAGMA integrity_check + PRAGMA foreign_key_check                    |
|                             Computes SHA-256 hashes of all raw artifacts                         |
|                                           |                                                      |
|                                           v                                                      |
|                             [5. Authenticated Encryption]                                        |
|                             AES-256-GCM with 96-bit IV, 128-bit Auth Tag                         |
|                             Format: ASPIRE_ENC_V1 container                                      |
|                                           |                                                      |
|                                           v                                                      |
|                             [6. Cryptographic Manifest]                                          |
|                             manifest.json with artifact hashes, sizes, metadata                  |
|                                           |                                                      |
|                                           v                                                      |
|                             [7. Storage Manager & Providers]                                     |
|                             Local Disk (data/backups) -> Rclone CLI -> AWS S3 / R2               |
|                                           |                                                      |
|                                           v                                                      |
|                             [8. GFS Retention Pruner]                                            |
|                             7 Daily, 4 Weekly, 6 Monthly points (Min. 1 backup preserved)        |
+--------------------------------------------------------------------------------------------------+
```

---

## 3. Database Persistence & WAL Safety

Aspire's primary database operates under **SQLite Write-Ahead Logging (`WAL`) mode**. 

### 3.1 The WAL Challenge
In WAL mode, recent transactional writes live in `data/aspire.db-wal`, coordinated by `data/aspire.db-shm`. Standard OS-level file copies (`cp aspire.db`) risk capturing a torn page or an uncheckpointed state if a write occurs mid-read.

### 3.2 The Online Backup Solution
The database backup engine (`backend/src/services/backup/database-backup.service.js`) utilizes `better-sqlite3`'s native `.backup()` method:
1. **Paging Engine:** The SQLite online backup API copies pages monotonically from the live source to a temporary target database file.
2. **Lock Free:** Readers and writers continue normal execution without blocking the application.
3. **Internal Checkpoint:** Any pages updated in the WAL journal during backup execution are re-copied to ensure total point-in-time consistency.
4. **Target Integrity:** Once snapshotting finishes, the engine mounts the target database in read-only mode and executes:
   - `PRAGMA integrity_check;` -> Must return `ok`.
   - `PRAGMA foreign_key_check;` -> Must return zero constraint violations.
   - Core table counts (`organizations`, `users`, `students`, `attempts`, `certificates`) are recorded into the manifest.

---

## 4. File Storage & Asset Bundling

Aspire stores tenant organization logos and uploaded branding under `data/uploads/` and system badges under `data/logo/`.

1. **Traversal Engine:** `backend/src/services/backup/file-backup.service.js` crawls both directory trees recursively.
2. **Asset Packaging:** Each file is read into memory, hashed with SHA-256, and encoded in Base64 within a unified `files-bundle.json` payload:
   ```json
   {
     "version": "1.0.0",
     "generatedAt": "2026-11-14T13:19:38.637Z",
     "fileCount": 18,
     "totalSizeBytes": 524288,
     "files": [
       {
         "relativePath": "organizations/org_123/branding/logo/acme.png",
         "sizeBytes": 28410,
         "sha256": "4b92...",
         "contentBase64": "iVBORw0KGgoAAAANSUhEUg..."
       }
     ]
   }
   ```
3. **Encrypted Envelope:** The resulting bundle file is encrypted as an individual artifact with its own SHA-256 verification signature.
4. **Restoration Extraction:** The unpacker reconstructs the file hierarchy on disk, verifies each individual file's SHA-256 against its entry, and overwrites/creates targets atomically.

---

## 5. Configuration & Environment State

To prevent "split-brain" restorations where a database is recovered without the corresponding business rule definitions, `backend/src/services/backup/configuration-backup.service.js` packages platform runtime parameters:
- **Non-Secret Environment Inventory:** `PORT`, `NODE_ENV`, `DB_PATH`, `STORAGE_LOCAL_DIR`, `LOG_LEVEL`, `DEFAULT_SUBSCRIPTION_PLAN`.
- **Database Schema Level:** Queries `schema_migrations` to record the highest migration successfully applied.
- **Dynamic Configuration Table:** Dumps key-value settings from the internal `configurations` table.
- **Subscription Plan Matrix:** Serializes the available subscription tiers, quotas, and feature entitlements.
- **Strict Secret Exclusion:** Secrets (`AUTH_SECRET`, `CERTIFICATE_SIGNING_SECRET`, `BACKUP_ENCRYPTION_KEY`, AWS tokens, Brevo keys) are **strictly excluded** to prevent credential leaks.

---

## 6. Cryptographic Security & Encryption Model

All backup artifacts (`database.sqlite`, `files-bundle.json`, `config.json`) are encrypted using authenticated cryptography before being written to disk or transferred off-site.

### 6.1 Cryptographic Parameters
- **Cipher:** `AES-256-GCM` (Galois/Counter Mode).
- **Authentication:** 128-bit authentication tag appended to ciphertext to detect tampering.
- **Key Derivation:** Single SHA-256 hash of `BACKUP_ENCRYPTION_KEY` yielding a 256-bit cryptographic key.
- **Initialization Vector:** 12-byte (96-bit) cryptographically secure pseudorandom IV (`crypto.randomBytes(12)`), unique per artifact.

### 6.2 Binary Container Format: `ASPIRE_ENC_V1`
Artifact files are written with a structured binary header:
```
+-------------------+-------------------+--------------------+------------------------+
| Magic (14 bytes)  | IV (12 bytes)     | Tag (16 bytes)     | Ciphertext (N bytes)   |
| "ASPIRE_ENC_V1\n" | Nonce / IV        | GCM Auth Tag       | Encrypted payload      |
+-------------------+-------------------+--------------------+------------------------+
```

### 6.3 Verification & Decryption Safety
During restore or verification, if an attacker flips a single bit in the ciphertext or header:
1. `crypto.createDecipheriv` fails authentication verification.
2. `decipher.final()` throws `Unsupported state or unable to authenticate data`.
3. The restore operation terminates immediately before touching live data.

---

## 7. Cryptographic Manifest (`manifest.json`)

Every backup bundle contains an unencrypted, schema-validated `manifest.json` describing the backup.

### Manifest Schema (`backup-manifest.service.js`)
```json
{
  "backupId": "bak_20261114_131938_e8c95174",
  "version": "1.0.0",
  "createdAt": "2026-11-14T13:19:38.637Z",
  "applicationVersion": "1.0.0",
  "sourceDatabase": "aspire.db",
  "schemaVersion": "020_monitoring_observability",
  "tableCounts": {
    "organizations": 419,
    "users": 629,
    "students": 460,
    "attempts": 817,
    "certificates": 707
  },
  "encryption": {
    "enabled": true,
    "algorithm": "aes-256-gcm",
    "keyFingerprint": "sha256:d8a4..."
  },
  "artifacts": {
    "database": {
      "filename": "database.sqlite.enc",
      "sizeBytes": 20127744,
      "sha256": "80894569f...",
      "encrypted": true
    },
    "files": {
      "filename": "files-bundle.json.enc",
      "sizeBytes": 34812,
      "sha256": "129845ff...",
      "fileCount": 18,
      "encrypted": true
    },
    "config": {
      "filename": "config.json.enc",
      "sizeBytes": 4210,
      "sha256": "993a4bc...",
      "encrypted": true
    }
  },
  "backupStatus": "COMPLETED",
  "verificationStatus": "VERIFIED"
}
```

---

## 8. Retention Engine (GFS Model)

The retention system (`backend/src/services/backup/backup-retention.service.js`) manages storage consumption using a Grandfather-Father-Son (GFS) scheduling model:

### 8.1 Retention Rules
- **Daily Backups (Son):** Preserved for **7 days**. One backup retained per day.
- **Weekly Backups (Father):** Preserved for **4 weeks**. Retains the Sunday point of each week.
- **Monthly Backups (Grandfather):** Preserved for **6 months**. Retains the first day of each month.

### 8.2 Safety Invariants
1. **Preserve Sole Backup:** If only 1 valid backup exists in the repository, the retention engine will never prune it, regardless of age.
2. **Protect Restore Targets:** If a specific backup ID is marked as active or an active restore operation is referencing it, pruning is rejected.
3. **Dry-Run Auditing:** Operators can simulate retention via `npm run backup:cleanup -- --dry-run` to preview actions before files are deleted.

---

## 9. Multi-Tier Storage Abstraction

The storage manager (`backend/src/services/backup/backup-storage.service.js`) routes backup packages across redundant storage tiers:

1. **Local Filesystem Tier (`LocalBackupStorageProvider`):**
   - Stores archives on the host filesystem under `data/backups/`.
   - Organizes backups in deterministic subdirectories: `data/backups/:backupId/`.
2. **Cloudflare R2 / AWS S3 Tier (`S3BackupStorageProvider`):**
   - Uses `@aws-sdk/client-s3` to push encrypted packages to remote object stores.
   - Enabled when `R2_ACCESS_KEY_ID` or `AWS_ACCESS_KEY_ID` is present.
3. **Rclone Provider Tier (`RcloneBackupStorageProvider`):**
   - Integrates with system-installed `rclone` binary to sync to secondary storage (B2, Wasabi, Google Drive).
   - If `rclone` is not installed or credentials are mock/missing, cleanly marks offsite sync as mocked or disabled without blocking local backup.

---

## 10. Concurrency Control & Mutex

To prevent backup corruption caused by simultaneous backup processes:
- `backend/src/services/backup/backup-scheduler.service.js` enforces a single-instance file lock: `data/backups/.backup.lock`.
- Stale lock detection: If a lock file is older than 30 minutes (indicating an unhandled node process termination or crash), it is automatically cleared with an audit warning.
- Overlapping executions are rejected with code `CONCURRENT_BACKUP_BLOCKED`.

---

## 11. Staged Disaster Recovery Engine

The restore service (`backend/src/services/backup/restore.service.js`) adheres to strict safety staging:

```
+--------------------------------------------------------------------------------------------------+
|                                    STAGED RESTORE PIPELINE                                       |
|                                                                                                  |
|   1. Read & Validate manifest.json via Zod Schema                                                |
|   2. Compute and verify SHA-256 checksums of encrypted artifacts                                 |
|   3. Decrypt database, files, and config into temporary staging directory                       |
|   4. Perform PRAGMA integrity_check and foreign_key_check on staged database                     |
|   5. Inspect table counts and schema version against manifest expectations                       |
|                                                                                                  |
|   [IF DRY-RUN]: Output detailed inspection preview and exit 0. Live state untouched.             |
|                                                                                                  |
|   [IF LIVE RESTORE]:                                                                             |
|   6. Require explicit --confirm flag (prevents catastrophic accidental invocation)               |
|   7. Capture PRE-RESTORE SAFETY SNAPSHOT: aspire.db.pre-restore.<timestamp>                      |
|   8. Close live SQLite connection (Proxy will block new transactions)                            |
|   9. Atomically replace data/aspire.db from staging database                                     |
|   10. Remove orphaned WAL and SHM journal files (data/aspire.db-wal, data/aspire.db-shm)         |
|   11. Unpack files-bundle.json into data/uploads/ and data/logo/                                 |
|   12. Re-open SQLite connection via reopenDatabase() Proxy re-binding                            |
|   13. Verify live connection queries successfully                                                |
|   14. Record DR audit log in database audit_logs table                                           |
+--------------------------------------------------------------------------------------------------+
```

---

## 12. CLI Operations Reference

| Operation | Command | Flags / Options | Purpose |
| :--- | :--- | :--- | :--- |
| **Create Backup** | `npm run backup:create` | None | Snapshot DB, package assets, encrypt, write manifest |
| **List Backups** | `npm run backup:list` | None | Display table of available recovery points |
| **Verify Backup** | `npm run backup:verify` | `--id <backupId>` | Check manifest schema, hashes, and encryption |
| **Restore (Dry-Run)** | `npm run backup:restore` | `--id <backupId> --dry-run` | Stage, decrypt, and verify without touching live data |
| **Restore (Live)** | `npm run backup:restore` | `--id <backupId> --confirm` | Full atomic disaster recovery replacement |
| **Retention Cleanup**| `npm run backup:cleanup` | `--dry-run` (simulate) / `--confirm` | Prune aged archives per GFS rules |

---

## 13. Super Admin REST API

Endpoints are mounted in `backend/src/routes/admin.js` and protected with `requireRole(ROLES.SUPER_ADMIN)`:

1. **`GET /api/admin/backups`**
   - Returns array of available backup summaries (ID, created date, size, schema version, encryption status).
2. **`GET /api/admin/backups/:id`**
   - Returns complete `manifest.json` for specified backup archive.
3. **`POST /api/admin/backups/create`**
   - Triggers asynchronous backup pipeline. Returns 201 with created backup manifest.
4. **`POST /api/admin/backups/verify/:id`**
   - Verifies integrity of specified backup archive. Returns pass/fail result with SHA-256 match confirmation.

