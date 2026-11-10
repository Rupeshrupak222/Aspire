# ASPIRE BY ADYAPAN — DAY 21 ENGINEERING REPORT
# SaaS Monetization Architecture — Subscription Plans, Limits, Usage Tracking, and Quota Enforcement

---

## 1. Project Overview & Scope

The objective of **Day 21** was to design and implement a production-oriented SaaS monetization architecture for **Aspire by Adyapan**, establishing subscription plan tiers, metered resource quotas, feature entitlements, soft/hard usage limits, and atomic quota enforcement without introducing third-party payment gateways.

### Key Deliverables Completed:
1. **Configurable Subscription Catalog:** Seeded `STARTER`, `GROWTH`, and `ENTERPRISE` plans in SQLite, with support for Super Admin-managed custom plans.
2. **Explicit Unlimited Quota Invariant:** `null` explicitly designates unlimited quotas (`exams_monthly: null` for Growth/Enterprise, `candidates: null` for Enterprise). Quotas are strictly distinct from `0` and false.
3. **Distinct Candidate Identity Metering:** Unique human candidates (`students` table rows) consume candidate quota upon registration. Retakes, re-evaluations, and multiple attempts by existing candidates consume 0 quota.
4. **Monthly Published Exam Accounting:** Only first-time publication transitions (`DRAFT` / `IN_REVIEW` -> `PUBLISHED` / `LIVE`) consume 1 unit from `exams_monthly`, guarded by idempotency key `pub_exam_<examId>`. Draft editing and unpublishing/republishing do not re-consume quota.
5. **Atomic SQLite Concurrency Enforcement:** Immediate transactions and row-level locks prevent over-allocation under concurrent bursts.
6. **Feature Gating Middleware:** `requireFeature` and `requireActiveSubscription` with Super Admin global overrides.
7. **Native Admin UI:** Integrated Subscription & Usage tab, quota meters, plan comparison grid, upgrade request modal, and dashboard overview widget.
8. **Automated Test Suite:** 7 new dedicated test suites with 121 assertions passing with 100% success rate, alongside zero regressions across Days 1–20.

---

## 2. Database Migration Implementation (Migration 015)

Applied in `backend/src/db/migrations.js` as migration `015_subscription_and_usage_model`:

### Relational Schema Summary:
1. **`subscription_plans`**:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `code TEXT NOT NULL UNIQUE` (e.g. `STARTER`, `GROWTH`, `ENTERPRISE`)
   - `name TEXT NOT NULL`
   - `description TEXT`
   - `features_json TEXT NOT NULL DEFAULT '[]'`
   - `quotas_json TEXT NOT NULL DEFAULT '{}'`
   - `soft_limit_pct INTEGER NOT NULL DEFAULT 80`
   - `is_active INTEGER NOT NULL DEFAULT 1`
   - `sort_order INTEGER NOT NULL DEFAULT 0`
   - `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
2. **`organization_subscriptions`**:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
   - `plan_id INTEGER NOT NULL REFERENCES subscription_plans(id)`
   - `status TEXT NOT NULL DEFAULT 'ACTIVE'` (`TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED`, `CANCELLED`, `EXPIRED`)
   - `starts_at TEXT NOT NULL`
   - `current_period_start TEXT NOT NULL`
   - `current_period_end TEXT NOT NULL`
   - `trial_ends_at TEXT`, `grace_period_ends_at TEXT`
   - `override_quotas_json TEXT`
   - `override_features_json TEXT`
   - `notes TEXT`
   - `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
   - Partial Unique Index: `idx_org_subs_active_unique` on `(organization_id)` WHERE `status IN ('ACTIVE', 'TRIAL', 'PAST_DUE')`.
3. **`organization_usage_counters`**:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
   - `resource_key TEXT NOT NULL` (`candidates`, `exams_monthly`, `storage_bytes`)
   - `period_start TEXT NOT NULL`, `period_end TEXT NOT NULL`
   - `used INTEGER NOT NULL DEFAULT 0`
   - `reserved INTEGER NOT NULL DEFAULT 0`
   - `updated_at TEXT NOT NULL`
   - Unique Index: `idx_org_usage_period_unique` on `(organization_id, resource_key, period_start, period_end)`.
4. **`organization_usage_events`**:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`
   - `resource_key TEXT NOT NULL`
   - `event_type TEXT NOT NULL` (`CONSUMED`, `RESERVED`, `RELEASED`, `ADJUSTED`, `REVERSED`)
   - `delta INTEGER NOT NULL`
   - `period_start TEXT NOT NULL`, `period_end TEXT NOT NULL`
   - `idempotency_key TEXT UNIQUE`
   - `metadata_json TEXT NOT NULL DEFAULT '{}'`
   - `user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`
   - `created_at TEXT NOT NULL`

### Data Backfill & Backward Compatibility:
- All 371 existing organizations present in `data/aspire.db` were safely backfilled with active `ENTERPRISE` subscriptions.
- Any newly created organization automatically receives an active subscription upon creation, preserving 100% compatibility across legacy test suites.

---

## 3. Quota Engine & Architectural Invariants

### 3.1 Distinct Candidate Identity Metering
- Candidate consumption occurs in `backend/src/routes/public.js` during candidate registration (`POST /api/register`).
- The system checks if `students` table already has a registered record with the candidate's phone/email for that organization.
- If the candidate identity already exists, **0 candidate quota units are consumed** (retakes and resumes are free).
- If the candidate identity is new, the candidate quota is verified and atomically consumed. If exhausted, registration returns HTTP `403 Forbidden` (`QUOTA_EXCEEDED`).

### 3.2 Monthly Published Exam Accounting
- Exam drafting, section configuration, and question banking consume zero quota.
- When `transitionExamStatus` is called in `backend/src/services/exam.service.js` with target status `PUBLISHED` or `LIVE`:
  - If `exam.published_at` is null, `exams_monthly` quota is atomically checked and consumed with idempotency key `pub_exam_${examId}`.
  - If `exam.published_at` is already populated (re-publishing), no quota is deducted.

### 3.3 Concurrency & Race Condition Defense
- Quota check and consumption run within SQLite `db.transaction()` executing immediate row-level locking.
- When an organization has 1 candidate remaining and 10 concurrent requests arrive simultaneously:
  - Exactly **1 request succeeds** and consumes the final unit.
  - Exactly **9 requests are rejected** with `QUOTA_EXCEEDED` (HTTP 403).
  - The counter ends at exactly the quota ceiling without over-allocation.

---

## 4. Automated Test Results

The Day 21 test suite consists of 7 standalone, isolated test files:

```
> node test/subscription-plans.test.js
> node test/subscription-lifecycle.test.js
> node test/subscription-usage.test.js
> node test/subscription-quota.test.js
> node test/subscription-concurrency.test.js
> node test/subscription-security.test.js
> node test/subscription-features.test.js
```

### Detailed Results Matrix:

| Suite | Category | Assertions | Status | Highlights |
|---|---|---|---|---|
| `subscription-plans.test.js` | Plan Catalog & Invariants | 25 | **PASSED** | Validated Starter, Growth, Enterprise seed configs; unlimited vs zero; custom plan CRUD; duplicate protection. |
| `subscription-lifecycle.test.js` | Lifecycle & Overrides | 23 | **PASSED** | Validated plan assignment, trial state, suspend/resume, per-tenant overrides, downgrade data preservation, audit history. |
| `subscription-usage.test.js` | Usage Metering & Audit | 18 | **PASSED** | Validated period resolution, counter increments, idempotent events, adjustment audits, distinct candidate retake safety. |
| `subscription-quota.test.js` | Quota Enforcement | 18 | **PASSED** | Validated candidate consumption, monthly exam publishing, 80% soft limit warning, 100% hard limit 403 rejection. |
| `subscription-concurrency.test.js` | Concurrency & Race Defense | 7 | **PASSED** | Validated 10 concurrent requests vying for 1 remaining candidate slot: exactly 1 allowed, 9 blocked, zero race conditions. |
| `subscription-security.test.js` | Security & Tenant Isolation | 12 | **PASSED** | Validated tenant data isolation, suspended organization blocking, cross-tenant subscription tampering defense. |
| `subscription-features.test.js` | Feature Entitlements | 18 | **PASSED** | Validated plan feature matrix, `requireFeature` middleware, Super Admin bypass, per-tenant custom feature overrides. |
| **Total Day 21** | | **121** | **100% PASS** | Zero failures. |

---

## 5. Frontend Admin User Interface

The Admin dashboard interface has been extended with native subscription management:

1. **Dashboard Subscription Bar:**
   - Integrated into the primary dashboard (`#dashSubscriptionBar`).
   - Surfaces current plan pill, monthly exam consumption badge, candidate progress meter, and quick upgrade action.
2. **Subscription & Usage Tab (`#pane-subscription`):**
   - **Current Plan Card:** Shows tier, billing period, active status, and custom tenant notes.
   - **Metered Resource Quota Cards:** Dynamic visual progress bars with threshold color shifting:
     - Normal (< 80%): Emerald green
     - Soft Limit Warning (80% – 99%): Amber warning badge
     - Hard Limit (100%): Crimson danger badge with "Limit Exceeded" alert.
   - **Plan Feature Grid:** Active entitlements vs. locked features with clear visual status indicators.
   - **Plan Comparison Matrix:** Side-by-side comparison of Starter, Growth, and Enterprise plans with immediate upgrade triggers.
3. **Upgrade Request Modal (`#upgradeModal`):**
   - Allows organization admins to submit upgrade inquiries directly to Super Admins.

---

## 6. Regression Testing Summary

| Test Suite | Commands / Sub-Suites | Status |
|---|---|---|
| Core Self-Test & Base Tests | `npm test` (13 suites: validation, security, auth, database, qb, exam, code, proctoring, timer) | **PASSED** |
| Multi-Tenant Isolation | `npm run test:tenant` | **PASSED** |
| Day 17: Organization Management | `npm run test:day17` (4 suites) | **PASSED** |
| Day 18: SaaS Dashboard | `npm run test:dashboard` (4 suites) | **PASSED** |
| Day 19: Exam Analytics | `npm run test:day19` (5 suites) | **PASSED** |
| Day 20: Reporting System | `npm run test:day20` (12 suites) | **PASSED** |
| Day 21: Subscription & Usage Model | `npm run test:day21` (7 suites) | **PASSED** |
| Public Landing Page | `npm run test:landing` | **PASSED** |

---

## 7. Conclusion

Day 21 is complete, fully tested, and verified. The Aspire SaaS platform now features a hardened, transactional subscription, quota, and feature-gating infrastructure ready for commercial multi-tenant operations.

