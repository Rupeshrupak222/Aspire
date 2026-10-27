# ASPIRE — DATABASE HARDENING CHECKLIST

Comprehensive audit and operational checklist for Aspire by Adyapan database layer (SQLite + better-sqlite3).

---

## 1. Schema Integrity & Constraints

- [x] **Primary keys reviewed**: All tables enforce explicit primary keys (`INTEGER PRIMARY KEY AUTOINCREMENT` for entity tables, `TEXT PRIMARY KEY` for sessions/config/migrations).
- [x] **Foreign keys reviewed**: Explicit parent-child relationships defined with appropriate `ON DELETE` semantics (`attempts -> students` CASCADE, `sessions -> users` CASCADE, `audit_logs -> users` SET NULL, `users -> organizations` SET NULL).
- [x] **Foreign key enforcement enabled**: `PRAGMA foreign_keys = ON;` executed on every database connection before any queries run.
- [x] **Unique constraints reviewed**: Real-world uniqueness enforced (`students.phone`, `organizations.slug`, `users.email`, `attempts.token`, `attempts.certificate_id`, `attempts.claim_code`).
- [x] **CHECK constraints reviewed**: Database-level domain integrity constraints active (`questions.type IN ('mcq', 'code')`, `organizations.status IN ('ACTIVE', 'SUSPENDED')`, `users.role IN (...)`, `users.status IN ('ACTIVE', 'DISABLED')`).
- [x] **NULLability reviewed**: Critical identity, auth, and state columns explicitly declared `NOT NULL`.
- [x] **Timestamps reviewed**: `created_at` and `updated_at` standardized using UTC ISO datetime strings.

---

## 2. Performance & Concurrency

- [x] **Query patterns reviewed**: Frequent queries in candidate registration, question selection, submission grading, audit logging, and admin filtering profiled.
- [x] **Missing indexes added**:
  - `idx_questions_category_type` ON `questions(category, type)` (direct question pool selection)
  - `idx_attempts_student_id` ON `attempts(student_id)` (fast student attempt lookup and resume)
  - `idx_attempts_claim_code` ON `attempts(claim_code)` (fast certificate/claim verification)
  - `idx_attempts_status_submitted` ON `attempts(status, submitted_at DESC)` (admin dashboard queries)
  - `idx_students_college` ON `students(college)` (college performance reporting)
  - `idx_students_track` ON `students(track)` (track distribution reporting)
  - `idx_users_org_role` ON `users(organization_id, role)` (tenant user listing and RBAC)
  - `idx_audit_logs_event_created` ON `audit_logs(event, created_at DESC)` (audit trail search)
  - `idx_audit_logs_org_created` ON `audit_logs(organization_id, created_at DESC)` (tenant audit isolation)
- [x] **Composite indexes evaluated**: Tailored to query predicates combining organization scoping and ordering.
- [x] **WAL verified**: `PRAGMA journal_mode = WAL;` enabled for concurrent reading without blocking writers.
- [x] **Busy handling verified**: `PRAGMA busy_timeout = 5000;` configured to queue concurrent write transactions smoothly.
- [x] **Memory cache verified**: `PRAGMA cache_size = -64000;` (64MB) and `PRAGMA temp_store = MEMORY;` configured for fast query execution.

---

## 3. Transaction Boundaries & Atomicity

- [x] **Registration atomic**: Candidate registration wrapped in `db.transaction(...)` ensuring candidate and attempt creation are all-or-nothing.
- [x] **Submission atomic**: State lock (`status = 'started' -> 'grading'`) prevents race conditions, and final submission update persists answers, grades, and certificate atomically.
- [x] **Result generation safe**: Graded details, percentage calculation, and scholarship slabs calculated consistently.
- [x] **Certificate generation safe**: Unique certificate code (`ASP26-XXXX`) and claim code generated within submission transaction.
- [x] **Admin mutations safe**: User provisioning, role changes, and organization updates execute atomically with audit logging.

---

## 4. Backup & Disaster Recovery

- [x] **Backup script**: `npm run db:backup` (`backend/src/scripts/backup.js`) utilizes `db.backup(...)` for non-blocking WAL-consistent online snapshots.
- [x] **Backup verification**: Every generated backup is immediately verified using `PRAGMA integrity_check;`.
- [x] **Restore procedure**: `npm run db:restore` (`backend/src/scripts/restore.js`) captures a pre-restore safety snapshot, validates source backup, and safely restores data.
- [x] **Restore test**: Automated test suite performs backup and restore into a disposable database, verifying 100% record integrity.
- [x] **Retention policy**: Backups automatically pruned according to `BACKUP_RETENTION_COUNT` (default: 10).

---

## 5. Operations & Operational Security

- [x] **Health check**: `/api/health` and `/api/health/db` report database availability, foreign keys, and journal mode without leaking internal system paths or SQL structures.
- [x] **Graceful shutdown**: `SIGTERM` and `SIGINT` signals intercepted in `server.js` to stop incoming HTTP traffic, await active queries, and cleanly close database handles.
- [x] **Persistent Docker volume**: `./data:/app/data` mounted in `docker-compose.yml` to prevent data loss on container rebuilds.
- [x] **Database inaccessible publicly**: Static file server explicitly configured for `frontend/` only; requests to `/aspire.db` and `/data/aspire.db` return HTTP 404.
- [x] **Backup directory inaccessible publicly**: Backups stored in server-side `data/backups/`, completely inaccessible via HTTP (returns 404).

---

## 6. Migration Management

- [x] **Migration system**: Ordered, idempotent migration runner (`backend/src/db/migrations.js`).
- [x] **Version tracking**: Dedicated `schema_migrations` table records version and execution timestamp.
- [x] **Existing database migration tested**: Migrations 001, 002, and 003 apply smoothly onto existing databases without data destruction.
- [x] **Migration failure behavior tested**: Failed migrations trigger immediate rollback, leaving schema state clean and preventing deployment of corrupt schemas.
- [x] **Standalone CLI**: `npm run db:migrate` and `npm run db:migrate -- --status` provided for deployment pipelines.

---

## 7. Multi-Tenancy & SaaS Data Governance

- [x] **Organization ownership**: Questions, users, attempts, and audit logs maintain explicit `organization_id` references.
- [x] **Tenant-scoped indexes**: Multi-column indexes support queries filtered by `organization_id`.
- [x] **Cross-tenant isolation**: Query predicates and RBAC middleware enforce tenant boundaries at the database level.
- [x] **Audit retention**: Audit logs persist with non-cascading references (`SET NULL`) to prevent history erasure.
- [x] **Database growth strategy**: Heartbeats update single attempt rows rather than creating append-only rows; proctoring events stored as structured summaries.
