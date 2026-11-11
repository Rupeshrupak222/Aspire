# ASPIRE BY ADYAPAN — USAGE RECONCILIATION GUIDE
## Operational Runbook for Quota Auditing, Counter Drift Detection & Ledger Correction

**Document Version:** 1.0.0  
**Effective Date:** 2026-11-11  
**Target Audience:** Super Administrators, Site Reliability Engineers, Platform Operations  
**Architecture Module:** `backend/src/services/subscription/reconciliation.service.js`

---

## 1. Overview & Architectural Motivation

In any multi-tenant SaaS platform, high-speed cached counters (such as `organization_usage_counters`) and pre-aggregated rollups provide low-latency reads. However, edge conditions—such as server crashes during non-atomic manual data migrations, background worker queue drops, or out-of-band disk file changes—can cause discrepancies between:

1. **Source of Truth:** Real relational database entities (`students`, `attempts`, `exams`, `questions`, `coding_submissions`).
2. **Usage Counters:** Period-scoped counter cache in `organization_usage_counters`.
3. **Event Ledger:** Append-only journal in `organization_usage_events`.
4. **Physical Disk / Object Storage:** Uploaded files on `./data/uploads` or S3.

The **Aspire Reconciliation Engine** solves this problem by performing automated bidirectional comparison and safe self-healing.

---

## 2. Source-of-Truth Hierarchy

```
+---------------------------------------------------------------------------------+
|                         RECONCILIATION TRUTH HIERARCHY                          |
+---------------------+-------------------------------+---------------------------+
| Domain              | Authoritative Source-of-Truth | Secondary Reconciled Target|
+---------------------+-------------------------------+---------------------------+
| Candidates          | COUNT(DISTINCT students.id)   | organization_usage_counters|
| Assessment Attempts | COUNT(attempts.id)            | organization_usage_events |
| Monthly Exams       | COUNT(published exams in per) | organization_usage_counters|
| Question Bank       | COUNT(questions.id)           | Snapshot Telemetry        |
| Certificates        | COUNT(attempts with cert_id)  | organization_usage_events |
| Code Executions     | COUNT(coding_submissions.id)  | organization_usage_events |
| Storage Assets      | Physical Disk + DB Object Meta| organization_usage_daily  |
+---------------------+-------------------------------+---------------------------+
```

---

## 3. Reconciliation Modes

### 3.1 Dry-Run Mode (`DRY_RUN`)
- **Default mode** for routine audits and health checks.
- Compares authoritative tables against counters, event sums, and daily rollups.
- Calculates exact discrepancies, deltas, and severity levels.
- **Makes zero mutations to the database.**
- Generates an immutable audit record and returns detailed analysis.

### 3.2 Apply Corrections Mode (`APPLY_CORRECTIONS`)
- **Authorized repair mode**, restricted to Super Administrators.
- Executes safe transactional adjustments:
  1. Creates an immutable `ADJUSTED` event in `organization_usage_events` with detailed metadata explaining the previous value, corrected value, and initiating administrator.
  2. Updates `organization_usage_counters` to match authoritative counts.
  3. Rebuilds affected daily aggregates via `rebuildDailyAggregate()`.
  4. Records the correction in the persistent job report.

---

## 4. How to Execute Reconciliation

### Method 1: REST API (Admin Dashboard / curl)

#### Run Dry-Run for All Active Organizations:
```bash
curl -X POST https://aspire.adyapan.internal/api/admin/usage/reconcile \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"mode": "DRY_RUN"}'
```

#### Run Authorized Repair for a Specific Organization:
```bash
curl -X POST https://aspire.adyapan.internal/api/admin/usage/reconcile \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": 10,
    "mode": "APPLY_CORRECTIONS"
  }'
```

#### Fetch Reconciliation Job Status & Report:
```bash
curl -X GET https://aspire.adyapan.internal/api/admin/usage/reconciliation/reconcile_9a7b1c8f \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>"
```

---

### Method 2: Node.js / Server CLI Execution

For direct server-side execution without HTTP overhead:

```javascript
const { reconcileOrganization, startReconciliationJob } = require('./backend/src/services/subscription/reconciliation.service');

// Single organization dry-run:
const report = reconcileOrganization(10, { mode: 'DRY_RUN', actorId: 1 });
console.log('Discrepancies found:', report.discrepancies);

// Full platform repair:
const job = startReconciliationJob({ mode: 'APPLY_CORRECTIONS', actorId: 1 });
console.log('Repairs completed. Job ID:', job.jobId);
```

---

## 5. Sample Discrepancy Scenarios & Resolutions

### Scenario A: Counter Drift on Candidates
- **Symptom:** `students` table has 12 distinct entries, but `organization_usage_counters.used` displays 10.
- **Detection:**
  ```json
  {
    "resourceKey": "candidates",
    "issue": "COUNTER_MISMATCH",
    "sourceValue": 12,
    "counterValue": 10,
    "delta": 2,
    "severity": "WARNING"
  }
  ```
- **Resolution:** `APPLY_CORRECTIONS` triggers `recordUsageEvent` with `eventType: 'ADJUSTED'`, delta `+2`, adjusting the counter to 12 without re-registering students.

### Scenario B: Physical Storage Drift
- **Symptom:** Files on disk in `./data/uploads/organizations/10` occupy 15,728,640 bytes (15 MB), but database object table records 10,485,760 bytes (10 MB).
- **Detection:**
  ```json
  {
    "resourceKey": "storage_bytes",
    "issue": "PHYSICAL_STORAGE_DRIFT",
    "dbTrackedBytes": 10485760,
    "diskPhysicalBytes": 15728640,
    "deltaBytes": 5242880,
    "severity": "WARNING"
  }
  ```
- **Resolution:** Reconciler logs a warning, alerts the operator to orphan files on disk, and optionally aligns tracked bytes.

---

## 6. Audit Trail & Compliance

Every reconciliation execution creates an immutable record in `audit_logs`:
- **Event:** `usage_reconciliation_executed`
- **Captured Metadata:**
  - `userId`: ID of the initiating Super Admin.
  - `organizationId`: Target tenant ID or platform global.
  - `mode`: `DRY_RUN` vs `APPLY_CORRECTIONS`.
  - `discrepanciesCount`: Count of detected deviations.
  - `correctionsCount`: Count of modifications applied.
  - `status`: `CLEAN`, `DISCREPANCIES_FOUND`, or `REPAIRED`.
- **Job Retention:** Records in `reconciliation_jobs` are retained indefinitely for SaaS audit compliance.

