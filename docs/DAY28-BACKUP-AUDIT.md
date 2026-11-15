# DAY 28 — BACKUP & DISASTER RECOVERY AUDIT
## Aspire by Adyapan — Comprehensive Persistence, Storage, and Recovery Assessment

**Date:** 2026-11-14  
**Status:** COMPLETE  
**Auditor:** Senior SRE, Database Reliability Engineer, and Backend Architect  
**Scope:** Data persistence, SQLite WAL mechanics, asset storage, configuration inventory, secrets boundaries, existing backup scripts, and disaster recovery gaps across Days 1–27.

---

## 1. Executive Summary

Aspire by Adyapan is a production-oriented, multi-tenant scholarship assessment and technical evaluation platform. Its authoritative source of truth is a single file-based SQLite database accessed concurrently in Write-Ahead Logging (`WAL`) mode via `better-sqlite3`. In addition to relational data, the platform stores tenant-uploaded assets (organization branding, logos), ephemeral execution logs, signed cryptographic digital certificates, and background event queues.

Currently, the repository contains a rudimentary Day 3 backup script (`backend/src/scripts/backup.js`) that creates a raw SQLite copy using `db.backup()`. However, significant operational gaps exist:
- **No cryptographic manifest or checksumming:** Backups lack SHA-256 integrity trees.
- **No encryption at rest:** Backups are written as unencrypted raw databases.
- **No asset synchronization:** Organization logos and uploaded branding in `data/uploads` are omitted from backups.
- **No configuration state backup:** Non-secret settings and schema versions are not packaged alongside the database.
- **No Grandfather-Father-Son (GFS) retention:** Only a simplistic count-based file prune exists.
- **No verified disaster recovery pipeline:** No automated restore drills, pre-restore safety snapshots, dry-run validations, or integrity gates exist before live data replacement.
- **No cloud offsite integration:** No abstraction for Rclone or S3-compatible secondary destinations exists.

Day 28 introduces an enterprise-grade, encrypted, verifiable, restorable backup and disaster recovery subsystem designed to guarantee Zero Data Loss for critical academic, candidate, assessment, and financial ledgers.

---

## 2. Inventory of Existing Persistence & State

### 2.1 Primary SQLite Database
- **Engine:** SQLite 3 via `better-sqlite3` v13.0.3.
- **Default Database Path:** `data/aspire.db` (configurable via `process.env.DB_PATH`).
- **Pragmas Configured on Startup (`backend/src/db/index.js`):**
  - `journal_mode = WAL` (Write-Ahead Logging mode enabled).
  - `foreign_keys = ON` (Cascading integrity enforced).
  - `busy_timeout = 5000` (5-second lock queue).
  - `synchronous = NORMAL` (Optimal for WAL durability without disk thrashing).
  - `cache_size = -64000` (64MB memory page cache).
  - `temp_store = MEMORY` (Temporary indices and tables held in RAM).
- **Associated WAL Files:**
  - `data/aspire.db-wal`: Active WAL journal holding uncheckpointed writes.
  - `data/aspire.db-shm`: Shared-memory index for WAL coordination.

### 2.2 Schema Migrations
- **Location:** `backend/src/db/migrations.js`
- **Execution Mechanism:** Synchronous runner (`runMigrations(db)`) executing in a single transaction on startup.
- **Tracking Table:** `schema_migrations` (`version TEXT PRIMARY KEY, applied_at DATETIME`).
- **Migration Count:** 20 applied migrations spanning:
  1. `001_core_schema` (students, exams, questions, attempts, answers, results)
  2. `002_rbac_multitenancy` (organizations, users, sessions, audit_logs)
  3. `003_db_hardening` (indexes, constraints)
  4. `004_question_bank_2_0` (tags, complexity, categories)
  5. `005_exam_builder` (blueprints, sections, rules)
  6. `006_exam_versioning_security` (versions, immutability)
  7. `007_coding_execution` (code questions, testcases)
  8. `008_async_code_execution` (async tokens, job tracking)
  9. `009_proctoring_analytics` (events, risk scores)
  10. `010_network_session_recovery` (heartbeats, reconnect tokens)
  11. `011_timer_submission_reliability` (monotonic timers, auto-submit)
  12. `012_multi_tenant_enforcement` (tenant context, IDOR defenses)
  13. `013_organization_management` (invitations, domains, branding)
  14. `014_dashboard_analytics_indexes` (reporting aggregations)
  15. `015_subscription_and_usage_model` (plans, usage counters, subscriptions)
  16. `016_usage_metering_and_aggregation` (daily aggregates, meters)
  17. `017_notification_system` (templates, outbox, deliveries)
  18. `018_certificate_verification` (certificates, revocation, public verifications)
  19. `019_public_candidate_experience` (slugs, custom landing, candidate access)
  20. `020_monitoring_observability` (worker heartbeats, alert incidents)

### 2.3 File Uploads and Stored Assets
- **Local Storage Root:** `data/uploads/` (configurable via `STORAGE_LOCAL_DIR`).
- **Directory Structure:**
  - `data/uploads/organizations/:orgId/branding/logo/:hash.png`
- **Branding Assets Root:** `data/logo/` (core platform marks, favicon, logos).
- **Storage Abstraction:** `backend/src/services/storage.service.js`
  - Supports Cloudflare R2 / AWS S3 via `@aws-sdk/client-s3` when credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) are set.
  - Automatically falls back to local disk storage (`data/uploads`) in dev/test.

### 2.4 Ephemeral & Auxiliary Systems
- **Redis & BullMQ:**
  - Primary role: Queue broker for asynchronous code execution (`code-execution` queue) and notifications (`notification` queue).
  - Volatile cache: Certificate verification memory cache.
  - **Durability Role:** Redis is NOT an authoritative store. All jobs originate from SQLite transactional outboxes (`outbox_events`). In the event of total Redis loss, Redis state can be regenerated entirely from SQLite outbox tables.
- **Pino Structured Logger:**
  - Configured in `backend/src/utils/logger.js`.
  - Streams to stdout; production targets log shippers (systemd journal / Promtail / Vector).
  - Sensitive parameters (passwords, OTPs, JWT tokens, DSNs, private keys) are redacted.

---

## 3. Data Classification: What Must Be Backed Up vs. Regenerated

| Data Category | Target | Criticality | Loss Impact | Can Be Regenerated? | Backup Strategy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Candidate Assessments** | `attempts`, `attempt_answers`, `code_submissions` | **Tier 0 (Maximum)** | Critical | **NO** | SQLite Consistent Snapshot |
| **Results & Scholarships** | `results`, `scholarship_allocations` | **Tier 0 (Maximum)** | Critical | **NO** | SQLite Consistent Snapshot |
| **Digital Credentials** | `certificates`, `certificate_verifications` | **Tier 0 (Maximum)** | Severe Legal Risk | **NO** | SQLite Consistent Snapshot |
| **Organization & Tenant Config** | `organizations`, `organization_branding`, `users` | **Tier 0 (Maximum)** | Tenant Outage | **NO** | SQLite Consistent Snapshot |
| **Usage & Financial Ledgers** | `organization_subscriptions`, `organization_usage_events`, `usage_daily_aggregates` | **Tier 0 (Maximum)** | Billing / Quota Loss | **NO** | SQLite Consistent Snapshot |
| **Audit & Security Evidence** | `audit_logs`, `proctoring_events` | **Tier 1 (High)** | Compliance Breach | **NO** | SQLite Consistent Snapshot |
| **Notification History** | `notification_events`, `notification_deliveries` | **Tier 1 (High)** | Communication Gap | **NO** | SQLite Consistent Snapshot |
| **Tenant Uploaded Assets** | `data/uploads/organizations/*` | **Tier 1 (High)** | Broken Images/Logos | **NO** | File Backup / Archive |
| **Platform Config Metadata** | `config` table, plan definitions, migration state | **Tier 1 (High)** | Setup Delay | Partially | JSON Inventory Export |
| **Redis Queues & Cache** | Redis memory | **Tier 2 (Low)** | Temporary delay | **YES** (from SQLite outbox) | Exclude (Drain/Replay from DB) |
| **Operational Logs** | Stdout / Log files | **Tier 2 (Low)** | Telemetry Gap | **NO** (Historical) | Periodic Tarball Export |

---

## 4. SQLite WAL Mode Risks & Online Backup Requirements

A primary risk in SQLite architectures running Write-Ahead Logging (`WAL`) is **blind filesystem copying**.

### 4.1 The Blind Copy Vulnerability
When SQLite operates in WAL mode:
1. Active transactions write to `aspire.db-wal`, not `aspire.db`.
2. A direct OS copy (`fs.copyFileSync('data/aspire.db')`) captures an obsolete or torn state because recent writes exist only in the WAL file.
3. If an agent copies `aspire.db` and `aspire.db-wal` sequentially while the application is actively writing, the database file and WAL file are copied at different points in time, resulting in a **corrupt, unrecoverable database**.

### 4.2 Required Solution: SQLite Online Backup API
- `better-sqlite3` exposes `db.backup(destinationPath, options)`.
- This invokes SQLite's native `sqlite3_backup_*` C API.
- The online backup API acquires read locks page-by-page, checkpoints committed WAL pages into the destination snapshot, and yields to concurrent writers (`NORMAL` transactions continue without blocking candidate exams).
- The resulting destination file is a self-contained, standalone, WAL-free SQLite database.

### 4.3 Post-Backup Integrity Verification
Every database backup artifact must be immediately verified before being packaged into a backup set:
1. Open the backup file in read-only mode with a dedicated Database handle.
2. Execute `PRAGMA integrity_check;` (must return `'ok'`).
3. Execute `PRAGMA foreign_key_check;` (must return zero violations).
4. Verify table counts for core tables (`organizations`, `students`, `attempts`, `certificates`).

---

## 5. Existing Gaps & Architectural Deficiencies

1. **No Unified Backup Orchestration:** Database backup, file backup, and config backup are completely decoupled.
2. **Missing Cryptographic Manifests:** Backups have no machine-readable manifest (`manifest.json`) declaring SHA-256 hashes, file counts, schemas, and timestamps.
3. **No Authenticated Encryption:** Backups contain plaintext PII (student names, emails, exam answers, scores) and are vulnerable to interception if synced to remote storage without encryption.
4. **No Uploads Backup:** If `data/uploads/` is deleted, tenant logos and branding are permanently lost.
5. **Lack of Safe Restore Pipeline:** Restoring currently requires manual script invocation or overwriting `aspire.db` with no pre-flight verification or automatic rollback.
6. **No Concurrency Protection:** Simultaneous backup commands can race, resulting in resource exhaustion or lock contention.
7. **No Cloud Storage Adapter:** No standardized bridge to sync encrypted backups to AWS S3, Cloudflare R2, or Rclone remotes.

---

## 6. Proposed Day 28 Backup & DR Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │          Backup Orchestration Engine         │
                  │           (backup.service.js)                │
                  └──────┬──────────────┬──────────────┬─────────┘
                         │              │              │
         ┌───────────────▼──┐   ┌───────▼──────┐   ┌───▼─────────────┐
         │ Database Backup  │   │ File Backup  │   │ Configuration   │
         │ (db.backup() API)│   │ (Uploads/Logo│   │ (Sanitized JSON)│
         └──────┬───────────┘   └───────┬──────┘   └───┬─────────────┘
                │                       │              │
                └───────────────┬───────┴──────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Manifest & SHA-256 Engine │
                  │ (manifest.service.js)     │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Authenticated Encryption  │
                  │ (AES-256-GCM via crypto)  │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Storage Provider Gateway  │
                  │ (Local / Rclone / S3)     │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Retention Engine (GFS)    │
                  │ (Daily 7d, Wk 4w, Mo 6mo) │
                  └───────────────────────────┘
```

### 6.1 Subsystem Layout
- `backend/src/services/backup/`
  - `backup.service.js`: Main facade coordinating lifecycle.
  - `database-backup.service.js`: Safe online SQLite backup + integrity check.
  - `file-backup.service.js`: Preserves `data/uploads` and `data/logo`.
  - `configuration-backup.service.js`: Non-secret inventory of app config and migration versions.
  - `backup-manifest.service.js`: Generates and validates `manifest.json`.
  - `backup-integrity.service.js`: Computes and verifies SHA-256 trees.
  - `backup-encryption.service.js`: Authenticated AES-256-GCM encryption with IV and AuthTag.
  - `backup-storage.service.js`: Storage providers (`local`, `rclone`, `s3`).
  - `backup-retention.service.js`: GFS grandfather-father-son retention pruning.
  - `restore.service.js`: Atomic, verified staging restore with automatic rollback snapshot.
  - `backup-scheduler.service.js`: Safe cron/timer trigger with concurrency file lock.

### 6.2 CLI Tooling (`backend/src/commands/`)
- `create-backup.js`: Creates on-demand full/partial backup.
- `list-backups.js`: Displays table of available restore points with health and size.
- `verify-backup.js`: Recomputes SHA-256 checksums and tests archive readability.
- `restore-backup.js`: Supports `--dry-run` and interactive `--confirm` restore.
- `cleanup-backups.js`: Applies GFS retention pruning rules.

---

## 7. Security Boundaries & Secrets Hygiene

### 7.1 Secret Segregation
- **Encryption Key Isolation:** Backup encryption utilizes `BACKUP_ENCRYPTION_KEY` (32-byte hex or base64 key).
- **Separation of Concerns:** The backup encryption key MUST NOT be derived from or shared with `CERTIFICATE_SIGNING_SECRET`, `AUTH_SECRET`, or database credentials.
- **Redaction Policy:** Configuration backups will strictly store non-secret operational variables (`PORT`, `NODE_ENV`, `STORAGE_MAX_UPLOAD_SIZE_BYTES`, `DB_PATH`, `MIGRATION_VERSION`, `PLAN_DEFINITIONS`).
- **Zero Credential Exposure:** `.env` files, API keys (`RESEND_API_KEY`, `ONLINECOMPILER_API_KEY`), tokens, and private secrets will NEVER be written into backup archives.

---

## 8. Dependencies & Recovery Limitations

1. **Host Prerequisites:** Node.js v18+, better-sqlite3 native bindings.
2. **Rclone Tooling:** Optional external utility. If absent, local and S3 storage providers operate seamlessly without breaking.
3. **Environment Independence:** Fully executable on local Windows developer machines without Docker, systemd, or Linux cron.
4. **Day 26 Context:** Production scheduling (systemd timers) and live cloud synchronization remain marked as **Pending Day 26 Deployment**.

---
*Audit approved for Day 28 implementation.*

