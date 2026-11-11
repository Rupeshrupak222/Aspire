# ASPIRE BY ADYAPAN — RESOURCE METERING POLICY
## Authoritative Accounting Model for Multi-Tenant SaaS Consumption

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-11  
**Architecture Layer:** Subscription, Usage Metering & Resource Accounting  
**Status:** Approved & Enforced

---

## 1. Executive Summary

This document specifies the exact, non-negotiable accounting rules, measurement semantics, and aggregation policies governing resource consumption on the Aspire by Adyapan platform.

Usage metering in Aspire is **event-driven, ledger-backed, and strictly idempotent**. Resource consumption is never estimated from web traffic, page views, or client requests. Every unit consumed or released corresponds to an immutable database transaction or verified file payload.

---

## 2. Resource Specifications & Metering Semantics

Aspire accurately tracks seven core resource categories:

```
+---------------------------------------------------------------------------------+
|                                 METERED RESOURCES                                |
+---------------------+-------------------+---------------------+-----------------+
| Resource Key        | Units             | Quota Scope         | Policy Type     |
+---------------------+-------------------+---------------------+-----------------+
| candidates          | Distinct Students | Plan / Override     | Cumulative High |
| attempts            | Assessment Starts | Telemetry / Audit   | Monotonic Inc   |
| exams_created       | Exam Entities     | Telemetry / Audit   | Monotonic Inc   |
| exams_published     | Published Exams   | Monthly Period      | Period Reset    |
| questions           | Bank Questions    | Bank Inventory      | Net Active      |
| certificates        | Issued Certs      | Plan Quota / Cap    | Monotonic Inc   |
| code_executions     | Code Submissions  | Platform Capacity   | Monotonic Inc   |
| storage_bytes       | Bytes (B/MB/GB)   | Plan Quota (1G/10G) | Net Stored      |
| storage_objects     | Stored Files      | Object Inventory    | Net Count       |
+---------------------+-------------------+---------------------+-----------------+
```

---

### 2.1 Candidates (`candidates`)
- **Definition:** The count of distinct human student identities registered under an organization tenant.
- **Authoritative Event:** A new record inserted into the `students` table (`INSERT INTO students`).
- **Metering Rules:**
  - A newly registered student increments candidate consumption by exactly **1**.
  - Re-registration or submission attempts with an existing email, phone number, or student ID within the same organization increments **0** (idempotent).
  - Assessment retakes or taking multiple exams across different sections increments **0** candidate units.
  - Profile updates (name corrections, college edits) increment **0** candidate units.
  - Multi-tenant isolation: Candidates belonging to Organization A do not consume quota in Organization B.
- **Enforcement:** Enforced prior to student record creation. If an organization exceeds its plan candidate limit (`effectiveQuotas.candidates`), registration fails closed with `HTTP 403 / QUOTA_EXCEEDED`.

---

### 2.2 Assessment Attempts (`attempts`)
- **Definition:** A valid assessment session created for a candidate to undertake an exam.
- **Authoritative Event:** A new attempt row generated in `attempts` (`INSERT INTO attempts`).
- **Lifecycle Tracking:**
  - **Started:** Attempt initialized with active countdown (`status = 'started'`).
  - **Submitted:** Attempt finalized by candidate or auto-submitted (`status = 'submitted'`).
  - **Abandoned:** Candidate closed session or disconnected and did not return before expiration (`status = 'started'` with `expires_at < now`).
  - **Expired:** Server or timer finalized expired attempt (`status = 'expired'`).
- **Metering Rules:**
  - Every valid new attempt increments total attempt consumption by **1**.
  - Exam retakes constitute new attempts and increment attempt consumption by **1** (while candidate count remains unchanged).
  - Session heartbeats, progress sync pulses, browser refreshes, and network recovery reconnections increment **0** attempts.
  - Duplicate attempt initialization requests guarded by `idempotencyKey: attempt_created_<id>`.

---

### 2.3 Exams (`exams_created` & `exams_published`)
- **Definition:** Exam configurations created, edited, and published to candidates.
- **Metering Rules:**
  - **Creation:** Creating an exam draft increments `exams_created` by **1**.
  - **First Publication:** Publishing an exam (`status` transitions to `PUBLISHED` or `LIVE`) for the first time consumes **1** monthly published quota unit (`exams_published` / `exams_monthly`).
  - **Subsequent Publications:** Temporarily reverting an exam to `DRAFT` and republishing it consumes **0** additional quota units. The first publication event is immutably sealed via idempotency key `exam_published_<examId>`.
  - **Archival:** Archiving an exam updates status breakdown but preserves all historical consumption records.

---

### 2.4 Questions (`questions`)
- **Definition:** Reusable question bank items created within an organization.
- **Metering Rules:**
  - Creating a question bank entry increments `questions` by **1**.
  - Modifying an existing question (editing text, test cases, difficulty, options) increments **0** question units.
  - Allocating a single question bank question to one or multiple exams/sections updates `allocatedToExams` tracking but creates **0** duplicate question bank items.
  - Archiving a question transitions it to archived inventory without altering lifetime ledger totals.

---

### 2.5 Certificates (`certificates`)
- **Definition:** Official completion and scholarship certificates awarded to candidates who fulfill passing criteria.
- **Metering Rules:**
  - Generating and assigning a certificate ID to a submitted attempt increments `certificates` by **1**.
  - Multiple certificate PDF downloads, email re-sends, or preview renders increment **0** certificate units.
  - Third-party certificate verification checks (`GET /api/public/verify/:certificateId`) record verification telemetry but consume **0** issuance units.

---

### 2.6 Code Executions (`code_executions`)
- **Definition:** Individual candidate code submissions evaluated by code execution workers (Judge0, Piston, or Mock provider).
- **Metering Rules:**
  - Each accepted coding submission job creates an execution event and increments `code_executions` by **1**.
  - Submissions are categorized into outcome buckets: `passed` (`ALL_TESTS_PASSED`), `compilationError`, `runtimeError`, `timeout` (`TIME_LIMIT_EXCEEDED`), `providerError`, and `pending`.
  - Background worker retries, queue polling, or frontend status inspection calls (`GET /api/attempt/:token/code-status/:id`) increment **0** execution units.

---

### 2.7 Storage (`storage_bytes` & `storage_objects`)
- **Definition:** The exact byte footprint and file object count stored across organization assets (logos, custom fonts, exam documents, certificates, report exports).
- **Metering Rules:**
  - Asset upload increments `storage_bytes` by the exact byte length of the file and `storage_objects` by **1**.
  - Storage is tracked in `organization_storage_objects` with metadata including `category`, `mime_type`, `file_name`, and `size_bytes`.
  - Asset deletion removes the object record, records a `DECREMENT` usage event, and reduces `storage_bytes` by the exact byte length.
  - Default plan thresholds:
    - **Starter:** 1 GB (1,073,741,824 bytes)
    - **Growth:** 10 GB (10,737,418,240 bytes)
    - **Enterprise:** 100 GB (107,374,182,400 bytes) or customizable.

---

## 3. Daily Aggregation & Trend Engine

To eliminate slow full-table scans across multi-million event tables, Aspire maintains a high-speed daily pre-aggregated rollup table:

```sql
CREATE TABLE organization_usage_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  usage_date TEXT NOT NULL, -- YYYY-MM-DD in organization timezone
  consumed INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  net_usage INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, resource_key, usage_date)
);
```

### 3.1 Aggregation Guarantees
1. **Atomic Upsert:** Each event atomically upserts the daily aggregate row using SQLite's `ON CONFLICT(organization_id, resource_key, usage_date) DO UPDATE`.
2. **Timezone Normalization:** Events are grouped according to the organization's configured timezone (`organizations.timezone`, default `Asia/Kolkata`), preventing date-line distortion.
3. **Contiguous Trends:** The trend generator (`getUsageTrends`) fills zero-activity days across the requested date window, ensuring Chart.js visualizations render smooth, continuous time-series curves without missing points.
4. **Reconstructibility:** If daily rollup records are dropped or corrupted, `rebuildDailyAggregate(orgId, date)` re-computes the exact daily values directly from the immutable event ledger.

---

## 4. Quota Enforcement & Warning Thresholds

The quota service evaluates usage against plan limits before allowing potentially chargeable actions:

1. **Normal Operation (< 80%):** Quota usage is within normal operating limits.
2. **Soft Limit Warning (>= 80% and < 100%):** An alert banner surfaces on the admin dashboard notifying administrators that quota capacity is approaching exhaustion. Operations continue unimpeded.
3. **Hard Limit Exceeded (>= 100%):** Operations requiring quota consumption are blocked atomically with `HTTP 403 QuotaExceededError`. Non-consuming operations (viewing results, exporting reports) remain fully available.

---

## 5. Security & Multi-Tenant Boundaries

- **Zero Cross-Tenant Leakage:** Every query on `organization_usage_events`, `organization_usage_daily`, `organization_storage_objects`, and `organization_usage_counters` filters strictly by `organization_id`.
- **Sensitive Data Masking:** Event metadata sanitizes candidate passwords, security hashes, answers, and access tokens prior to returning history to administrators.
- **RBAC Gating:** Platform reconciliation and global usage overviews are strictly restricted to users with the `SUPER_ADMIN` role.

