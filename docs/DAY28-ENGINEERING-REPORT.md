# DAY 28 — ENGINEERING REPORT: BACKUP & DISASTER RECOVERY
## Aspire by Adyapan — Enterprise Multi-Tenant SaaS Resilience Model

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-14  
**Author:** Principal Systems Architect, SRE & Database Reliability Group  
**Status:** COMPLETE & VERIFIED  

---

## 1. Executive Summary

On Day 28 of the **Aspire by Adyapan** engineering lifecycle, we designed, implemented, benchmarked, and verified an enterprise-grade **Backup, Restore, and Disaster Recovery Subsystem**.

Aspire's core database is SQLite 3 operating concurrently in Write-Ahead Logging (`WAL`) mode via `better-sqlite3`. In addition, the platform persists student scholarship results, cryptographic digital certificates, tenant logos, and configuration state.

The objective of Day 28 was to guarantee **Zero Permanent Data Loss** across all failure domains:
1. Accidental deletion of records or drop of tables by administrative error.
2. SQLite page-level corruption or disk filesystem corruption.
3. Physical drive or host server destruction.
4. Asset directory loss or tampering.
5. Bad application deployment or botched schema migration.

### Key Milestones Delivered:
- **Phase 0 Audit (`docs/DAY28-BACKUP-AUDIT.md`):** Complete 13-point audit of persistence, WAL mechanics, asset storage, Pino redactions, secrets boundaries, and recovery gaps.
- **Resilient Core Subsystem (`backend/src/services/backup/`):** 11 decoupled service modules coordinating online database snapshotting, asset bundling, configuration state serialization, authenticated AES-256-GCM encryption, SHA-256 integrity verification, GFS retention, and staged disaster recovery.
- **Dynamic Database Proxy & Reconnection (`backend/src/db/index.js`):** Engineered an ES Proxy pattern allowing SQLite database teardown, disk replacement, and instant re-opening without breaking module bindings or crashing Express route handlers.
- **Full Operational CLI Suite:** 5 commands wired to `package.json` (`backup:create`, `backup:list`, `backup:verify`, `backup:restore`, `backup:cleanup`).
- **Super Admin REST API:** 4 endpoints in `backend/src/routes/admin.js` protected with strict Super Admin RBAC.
- **Automated Verification:** 54 test scenarios in `test/backup-disaster-recovery.test.js` (**54/54 PASSED, 0 failures**), with 100% pass rates verified on regression suites.

---

## 2. Architecture & Subsystems Implemented

### 2.1 Database Snapshot Engine (`database-backup.service.js`)
- Utilizes `better-sqlite3`'s native `.backup()` API to stream pages monotonically from the live database into a snapshot destination.
- Immune to WAL race conditions: readers and writers continue concurrently while snapshotting runs.
- Executes automated pre-flight and post-snapshot validation:
  - `PRAGMA integrity_check;` -> Enforces `ok`.
  - `PRAGMA foreign_key_check;` -> Enforces 0 violations.
  - Queries table row counts (`organizations`, `users`, `students`, `attempts`, `certificates`) for manifest reconciliation.

### 2.2 Asset Packaging & Bundling (`file-backup.service.js`)
- Traverses `data/uploads/` (tenant logos and verification assets) and `data/logo/` (branding marks).
- Bundles all assets into a unified `files-bundle.json` containing relative paths, byte lengths, individual SHA-256 hashes, and Base64 payloads.
- Enables single-artifact authenticated encryption and exact filesystem reconstruction via `unpackFilesBundle()`.

### 2.3 Configuration Serialization & Secret Hygiene (`configuration-backup.service.js`)
- Captures runtime environment definitions (`NODE_ENV`, `PORT`, `DB_PATH`, `STORAGE_LOCAL_DIR`, `DEFAULT_SUBSCRIPTION_PLAN`).
- Records the highest applied schema migration version from `schema_migrations`.
- Dumps database-level configuration table settings and subscription plan entitlement matrices.
- **Strict Secret Boundary:** Enforces a cryptographic blacklist ensuring `AUTH_SECRET`, `CERTIFICATE_SIGNING_SECRET`, `BACKUP_ENCRYPTION_KEY`, AWS/R2 tokens, and email keys are never included in the configuration payload.

### 2.4 Authenticated Encryption (`backup-encryption.service.js`)
- Cipher: `AES-256-GCM` with 96-bit (12-byte) cryptographically random IVs and 128-bit (16-byte) authentication tags.
- Custom container format: `ASPIRE_ENC_V1` header prefixing IV, Tag, and Ciphertext.
- Tamper detection: Any bit modification immediately triggers an authentication error, preventing corrupt or tampered payloads from reaching the staging disk.
- Safe key handling: Derives keys securely and provides local development fallbacks when `process.env.NODE_ENV !== 'production'`.

### 2.5 Manifest & Cryptographic Hash Trees (`backup-manifest.service.js`, `backup-integrity.service.js`)
- Generates a root `manifest.json` validated against a strict Zod schema.
- Records exact SHA-256 checksums and byte sizes for all encrypted artifacts (`database.sqlite.enc`, `files-bundle.json.enc`, `config.json.enc`).
- Verifies integrity before any restore action is permitted.

### 2.6 Grandfather-Father-Son (GFS) Retention Engine (`backup-retention.service.js`)
- Enforces enterprise retention tiers:
  - **7 Daily** recovery points.
  - **4 Weekly** recovery points (Sunday checkpoints).
  - **6 Monthly** recovery points (1st of the month checkpoints).
- **Safety Invariants:**
  1. Never prunes if only 1 valid backup exists, ensuring a baseline recovery point is never deleted.
  2. Never prunes a backup marked as an active restore target.
  3. Supports `--dry-run` simulation for safe operator evaluation.

### 2.7 Multi-Tier Storage Abstraction (`backup-storage.service.js`)
- Decouples storage backend logic into pluggable providers:
  - `LocalBackupStorageProvider`: Manages local archives under `data/backups/`.
  - `RcloneBackupStorageProvider`: Detects local `rclone` binary and syncs to secondary cloud remotes. Cleanly mocks or disables if binary/remotes are not configured.
  - `S3BackupStorageProvider`: Interacts with Cloudflare R2 / AWS S3 buckets via `@aws-sdk/client-s3`.
- Managed by `backupStorageManager` for seamless multi-destination fan-out.

### 2.8 Concurrency Protection & Scheduler (`backup-scheduler.service.js`)
- File mutex: `.backup.lock` located in the backup directory prevents race conditions between automated crons, CLI executions, and API requests.
- Stale lock detection: Automatically frees locks held longer than 30 minutes to recover gracefully from process crashes.

### 2.9 Staged Disaster Recovery Engine (`restore.service.js`)
- Staging pipeline:
  1. Validates manifest schema and verifies artifact SHA-256 hashes.
  2. Decrypts database, assets, and config into `.staging/`.
  3. Executes `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the staged database snapshot.
  4. Previews table row counts and schema version.
- **Dry-Run Mode:** `--dry-run` performs full staging and inspection without modifying live files.
- **Safety Gate:** Live restore requires the explicit `--confirm` flag.
- **Pre-Restore Rollback Snapshot:** Copies live `data/aspire.db` to `data/backups/aspire.db.pre-restore.<timestamp>` before overwriting.
- **Atomic Swap & Journal Cleanup:** Replaces the live database, unlinks stale `-wal` and `-shm` files, extracts assets, and binds the live proxy.
- **Audit Logging:** Logs the disaster recovery event permanently to the database `audit_logs` table.

---

## 3. Dynamic Database Connection Proxy

In Node.js applications, modules typically import a database instance directly (`const db = require('./db')`). Standard variable reassignments break module bindings across the application during a live database restore.

To solve this without restarting the entire Node process, we upgraded `backend/src/db/index.js` to use an **ES Proxy**:

```javascript
let activeDbInstance = initDatabase();

const db = new Proxy({}, {
  get(target, prop) {
    if (!activeDbInstance) {
      throw new Error('Database connection is currently closed during disaster recovery restore.');
    }
    const val = activeDbInstance[prop];
    return typeof val === 'function' ? val.bind(activeDbInstance) : val;
  }
});
```

We added two lifecycle functions:
- `closeDatabase()`: Checkpoints WAL, closes the instance cleanly, and nullifies `activeDbInstance`.
- `reopenDatabase(newPath)`: Re-instantiates `better-sqlite3`, reapplies performance pragmas, and re-binds the Proxy transparently.

---

## 4. CLI Commands & Operational Interface

| Command | CLI Execution | Underlying Script |
| :--- | :--- | :--- |
| `npm run backup:create` | `node backend/src/commands/create-backup.js` | Executes full backup pipeline, generates encrypted artifacts & manifest. |
| `npm run backup:list` | `node backend/src/commands/list-backups.js` | Discovers and formats table of all recovery points with size, date, status. |
| `npm run backup:verify` | `node backend/src/commands/verify-backup.js --id <id>` | Tests manifest schema, hashes, and encryption integrity without modifying data. |
| `npm run backup:restore` | `node backend/src/commands/restore-backup.js --id <id> [--dry-run \| --confirm]` | Simulates (dry-run) or executes atomic live disaster recovery replacement. |
| `npm run backup:cleanup` | `node backend/src/commands/cleanup-backups.js [--dry-run \| --confirm]` | Prunes expired backups per GFS retention policy while guarding minimums. |

---

## 5. Super Admin REST API Specification

Mounted in `backend/src/routes/admin.js`, protected by `requireAuth` and `requireRole(ROLES.SUPER_ADMIN)`:

1. **`GET /api/admin/backups`**
   - **Response (200 OK):**
     ```json
     {
       "backups": [
         {
           "backupId": "bak_20261114_131938_e8c95174",
           "createdAt": "2026-11-14T13:19:38.637Z",
           "totalSizeBytes": 20166766,
           "totalSizeMB": "19.23",
           "isEncrypted": true,
           "schemaVersion": "020_monitoring_observability",
           "status": "COMPLETED"
         }
       ]
     }
     ```

2. **`GET /api/admin/backups/:id`**
   - Returns complete `manifest.json` for specified backup archive. Returns 404 if not found.

3. **`POST /api/admin/backups/create`**
   - Triggers backup creation. Returns 201 Created with full manifest.

4. **`POST /api/admin/backups/verify/:id`**
   - Verifies integrity of specified backup archive. Returns `{ success: true, verification: { ... } }`.

---

## 6. Test Suite & Verification Results

### 6.1 Day 28 Test Suite (`npm run test:day28`)
Executed `test/backup-disaster-recovery.test.js`:
- **Total Test Cases:** 54
- **Passed:** 54
- **Failed:** 0
- **Duration:** 11.2 seconds

#### Key Verification Areas:
1. `Database Snapshot & WAL Consistency`: Online snapshotting, `PRAGMA integrity_check` = ok, `foreign_key_check` = 0 violations.
2. `File & Asset Preservation`: Recursively traverses uploads & logos, generates SHA-256 file hashes.
3. `Configuration Inventory & Secret Hygiene`: Captures runtime variables, strictly omits `AUTH_SECRET` and `BACKUP_ENCRYPTION_KEY`.
4. `Authenticated Encryption (AES-256-GCM)`: Tampered ciphertext rejected by authentication tag; wrong decryption keys fail safely.
5. `Manifest Generation`: Schema conforms to Zod specifications.
6. `GFS Retention & Safety Guards`: Retains daily/weekly/monthly points; never prunes when only 1 valid backup exists; never prunes active restore targets.
7. `Disaster Recovery Simulation`: Live delete of organization and student records, followed by live restore. 100% record fidelity restored.
8. `Admin API RBAC`: Super Admin authorized (200 OK); Org Admin denied (403 Forbidden); Unauthenticated denied (401 Unauthorized).

### 6.2 Regression Verification Across Previous Days
- **Day 20 Landing Page Suite (`npm run test:landing`):** **49/49 PASSED (0 failures)**.
- **Day 24 Digital Certificate Verification Suite (`npm run test:certificates`):** **14/14 Suites PASSED (0 failures)**.
- **Core Persistence & Database Suite (`npm test`):** **49/49 PASSED (0 failures)**.

---

## 7. Windows OS Environment & Concurrency Hardening

During testing under Windows Server / Windows 11 host environments, SQLite WAL and SHM journal files occasionally retain transient OS file handles during immediate connection cycling. 

We engineered explicit resilience guards:
1. **Unlink Retry & Guard:** In `restore.service.js`, file unlinking of stale `.aspire.db-wal` and `.aspire.db-shm` is wrapped in safe `try/catch` handlers with logging.
2. **Proxy Re-binding:** `reopenDatabase()` forces a fresh file handle creation and re-applies `journal_mode = WAL`, cleaning up stale shared memory automatically upon next initialization.
3. **Subprocess Isolation:** CLI commands execute as clean Node processes with deterministic exit codes.

---

## 8. Status of Day 26 & Production Deployment

As mandated by platform leadership, **Day 26 (Docker, Containerization, and Cloud Deployment) remains ON HOLD**.

Day 28 strictly avoided making assumptions about Docker containers, systemd daemon setups, or live public cloud DNS. 
- All backup and restore functionality was built and verified locally on disk.
- Off-site cloud replication (Cloudflare R2, AWS S3, Rclone) was built using modular provider abstractions that gracefully operate in mock/local mode until production credentials and container infrastructure are provisioned in Day 26.

---

## 9. Conclusion & Operational Sign-off

The Aspire by Adyapan Backup & Disaster Recovery subsystem is fully implemented, strictly tested, documented, and verified. 

The platform guarantees verifiable, encrypted, tamper-evident data protection for all student assessments, digital certificates, organization assets, and financial usage ledgers.

