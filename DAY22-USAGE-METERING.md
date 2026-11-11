# ASPIRE BY ADYAPAN — DAY 22
# USAGE METERING & RESOURCE CONSUMPTION ANALYTICS
## Comprehensive System Specification & Architecture Reference

**Date:** 2026-11-11  
**Version:** 1.0.0  
**Status:** Production Ready & Verified  
**Milestone:** Day 22 — Daily Aggregation, Usage Tracking, Reconciliation and Subscription Visibility

---

## 1. System Overview

Day 22 introduces a carrier-grade resource metering, daily aggregation, and self-healing reconciliation subsystem for **Aspire by Adyapan**. Extending the foundation established in Day 21 (Subscription Plans, Feature Entitlements, Atomic Quota Enforcement), Day 22 provides authoritative, real-time measurement and historical analytics across **all seven core resource categories**:

1. **Candidates:** Distinct human student identities registered per tenant.
2. **Assessment Attempts:** Valid assessment attempts across states (started, submitted, abandoned, expired).
3. **Exams:** Draft creation, published exam count, and monthly published quota consumption.
4. **Questions:** Active and archived question bank inventory, and exam allocation tracking.
5. **Certificates:** Awarded and verified completion and scholarship credentials.
6. **Code Executions:** Processed student code submissions categorized by execution outcome.
7. **Storage:** Real stored asset footprint (bytes and objects) categorized across branding, certificates, exports, and exams.

The system ensures that organizations and Super Administrators have complete, transparent visibility into their resource consumption, warning thresholds (soft limits at 80%), hard quota boundaries (100%), and time-series trends without degrading query performance.

---

## 2. Database Architecture & Schema (Migration 016)

Day 22 introduces migration `016_usage_metering_and_aggregation.js`, adding pre-aggregated rollups, storage tracking, and reconciliation job records.

```
+---------------------------------------------------------------------------------------------------+
|                                      MIGRATION 016 TABLES                                         |
+--------------------------------+------------------------------------------------------------------+
| Table                          | Purpose                                                          |
+--------------------------------+------------------------------------------------------------------+
| organization_usage_daily       | Pre-aggregated daily rollups (consumed, released, net, count)   |
| organization_storage_objects   | Tracked file inventory with exact byte sizes and categories     |
| reconciliation_jobs            | Audit log and execution reports of platform reconciliation runs  |
| organization_usage_events      | Recreated with support for INCREMENT, DECREMENT, SNAPSHOT types |
+--------------------------------+------------------------------------------------------------------+
```

### 2.1 Schema Definitions

```sql
-- 1. Daily Aggregates (Pre-aggregated rollups for O(1) trend rendering)
CREATE TABLE organization_usage_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  net_usage INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(organization_id, resource_key, usage_date)
);

CREATE INDEX idx_usage_daily_org_date ON organization_usage_daily(organization_id, usage_date);
CREATE INDEX idx_usage_daily_lookup ON organization_usage_daily(organization_id, resource_key, usage_date);

-- 2. Storage Objects (Exact byte measurements)
CREATE TABLE organization_storage_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('branding', 'certificates', 'exports', 'exams', 'questions', 'general')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  provider TEXT NOT NULL DEFAULT 'LOCAL',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_storage_org_cat ON organization_storage_objects(organization_id, category);

-- 3. Reconciliation Jobs
CREATE TABLE reconciliation_jobs (
  id TEXT PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'APPLY_CORRECTIONS')),
  discrepancies_count INTEGER NOT NULL DEFAULT 0,
  corrections_count INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,
  initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 3. Core Metering Services

### 3.1 Metering Service (`metering.service.js`)
- **`recordUsageEvent({...})`:** Idempotent atomic ingestion of usage events. Updates the event ledger (`organization_usage_events`), updates the daily rollup (`organization_usage_daily`), and updates period counters (`organization_usage_counters`) within an atomic SQLite transaction.
- **`getCurrentUsageSnapshot(organizationId)`:** Real-time computation of snapshot across all 7 resources, including limit evaluation, percentages, and warning threshold states.
- **`getUsageTrends({ organizationId, resourceKey, startDate, endDate, interval })`:** Generates contiguous, gap-free date time-series arrays for Chart.js.
- **`getUsageHistory({...})`:** Paginated event audit trail with sanitized metadata to prevent sensitive credential or PII leaks.
- **`getStorageFootprint(organizationId)`:** Exact breakdown of storage bytes, megabytes, gigabytes, and category allocations.
- **`rebuildDailyAggregate(organizationId, targetDate, resourceKey)`:** Reconstructs daily aggregate rollups directly from the immutable event ledger.

### 3.2 Reconciliation Engine (`reconciliation.service.js`)
- Compares source-of-truth business entities against cache counters, event ledgers, and disk directories.
- Supports **`DRY_RUN`** (zero-mutation audit) and **`APPLY_CORRECTIONS`** (authorized auto-repair with `ADJUSTED` ledger entries).
- Scans `./data/uploads/organizations/<orgId>` to identify drifted or orphaned physical files.
- Persists detailed job logs in `reconciliation_jobs` and triggers security audit events.

---

## 4. REST API Endpoints

### 4.1 Tenant Organization Endpoints (`/api/organization/usage/*`)
- `GET /api/organization/usage/overview`: Comprehensive snapshot across plan status, soft/hard alerts, and 7 resource metrics.
- `GET /api/organization/usage/resources`: Detailed resource inventory breakdown.
- `GET /api/organization/usage/trends`: Contiguous time-series trends by resource and date range.
- `GET /api/organization/usage/history`: Paginated audit log of usage events.
- `GET /api/organization/usage/storage`: Category breakdown and total storage footprint.

### 4.2 Super Admin Endpoints (`/api/admin/usage/*`)
- `GET /api/admin/usage/overview`: Platform-wide consumption totals and organization summaries.
- `GET /api/admin/usage/organizations/:organizationId`: Cross-tenant inspection of a specific organization's usage snapshot.
- `GET /api/admin/usage/trends`: Multi-tenant trend telemetry.
- `POST /api/admin/usage/reconcile`: Trigger platform-wide or tenant-specific reconciliation (`DRY_RUN` or `APPLY_CORRECTIONS`).
- `GET /api/admin/usage/reconciliation/:jobId`: Fetch historical reconciliation job reports.

---

## 5. Frontend Dashboard Integration

The Organization and Super Admin views in `frontend/admin.html` and `frontend/js/admin.js` have been enhanced:
1. **Resource Grid:** 7 responsive metric cards (Candidates, Attempts, Exams, Questions, Certificates, Code Executions, Storage).
2. **Quota Progress & Warnings:** Color-coded progress bars (Normal green, Soft limit warning amber at >= 80%, Hard limit red at 100%).
3. **Interactive Trends Chart:** Chart.js time-series graph with resource toggle dropdown and 7-day/30-day/90-day time range filters.
4. **Detailed Inventory Table:** Tabular breakdown of resource limits, consumed units, remaining capacity, and status badges.
5. **Event Ledger Table:** Paginated audit log detailing recent usage transactions with timestamps and event types.

---

## 6. Verification & Test Suite Summary

12 dedicated, isolated test suites verify every behavioral guarantee:

```
+----------------------------------------------+---------------+---------+
| Test Suite                                   | File          | Status  |
+----------------------------------------------+---------------+---------+
| Candidates Metering & Distinct Identity      | candidates    | PASSED  |
| Attempts Metering & Lifecycle Statuses       | attempts      | PASSED  |
| Exams Metering & Monthly Quota Consumption   | exams         | PASSED  |
| Questions Bank & Allocation Non-Duplication  | questions     | PASSED  |
| Certificates Issuance & Preview Non-Metering | certificates  | PASSED  |
| Code Executions & Status Categorization      | code-exec     | PASSED  |
| Storage Footprint & Multi-Tenant Isolation   | storage       | PASSED  |
| Daily Aggregation & Trend Contiguity         | aggregation   | PASSED  |
| Reconciliation Engine & Drift Self-Healing   | reconciliation| PASSED  |
| Security, RBAC & Tenant Scoping              | security      | PASSED  |
| High-Concurrency & Race-Condition Safety     | concurrency   | PASSED  |
| REST API Endpoints & Super Admin Controls    | api           | PASSED  |
+----------------------------------------------+---------------+---------+
```

All 12 suites pass cleanly with **0 failures**, and full regression verification (`npm test`, `test:tenant`, `test:day17`, `test:day18`, `test:day19`, `test:day20`, `test:day21`, `test:day22`, `test:landing`) confirms zero regressions across the platform.

