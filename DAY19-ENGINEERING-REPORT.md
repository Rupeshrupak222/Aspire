# ASPIRE BY ADYAPAN — DAY 19 ENGINEERING REPORT
## Exam Analytics: Psychometrics, Asynchronous Execution Telemetry & Performance Distribution

**Date:** November 6, 2026  
**Milestone:** Day 19 — Exam Analytics  
**Status:** Complete & Verified (100% Green Across All Suites)  
**Author:** Antigravity AI Engineering Team  

---

## 1. Executive Summary

Day 19 delivers **Exam Analytics** for **Aspire by Adyapan**, expanding upon the Day 18 SaaS dashboard by providing comprehensive examination-level behavioral monitoring, psychometric evaluation, and asynchronous code execution analytics.

Key capabilities delivered:
1. **Candidate Funnel**: Stage-by-stage progression tracking (`Registered → Started → Completed → Passed / Failed`), drop-off rates, abandonment tracking (explicit vs expired attempts), and retake metrics.
2. **Item Psychometrics**: Correct and wrong rates of answered questions, unanswered proportions, difficulty categorization (5 standard tiers), and **Kelley's Item Discrimination Index ($D$)**.
3. **Execution Architecture Telemetry**: Deep categorization of coding outcomes into compilation errors, runtime failures, execution timeouts, and cloud provider failures.
4. **Performance & Statistical Distributions**: Exact percentile calculations (mean, median, standard deviation, Q1, Q3, P90, IQR) powered by the `simple-statistics` package, accompanied by 20% score histograms and duration distributions.
5. **Interactive UI**: An administrative view in `frontend/admin.html` with responsive Chart.js visual charts, a searchable psychometric table, single-question modal inspection, and a paginated candidate roster.
6. **Multi-Tenant Security**: Fail-closed 404 responses for cross-tenant access, preventing ID enumeration and cross-organization telemetry leakage.

---

## 2. Files Created & Modified

| File | Status | Description |
| :--- | :--- | :--- |
| `backend/src/services/exam-analytics.service.js` | **Created** | Core analytical service providing candidate funnel, psychometric calculations, discrimination index $D$, asynchronous coding analytics, and performance distributions. |
| `backend/src/validation/exam-analytics.schemas.js` | **Created** | Zod validation schemas for query parameters, date ranges, pagination, sorting, and route parameters. |
| `backend/src/routes/organization.js` | **Modified** | Mounted 7 organization-scoped analytical endpoints with tenant isolation and RBAC. |
| `backend/src/routes/admin.js` | **Modified** | Mounted `/exams/:id/analytics` for super-admin / platform-wide analytical inspection. |
| `frontend/admin.html` | **Modified** | Added `#pane-exam-analytics` with sub-sections for Overview & Funnel, Questions, Coding, Performance, and Candidates, plus `#questionAnalyticsModal`. |
| `frontend/js/admin.js` | **Modified** | Added `openExamAnalytics()`, data loaders, Chart.js renderers, chart cleanup lifecycle, question inspector modal, and event listeners. |
| `package.json` | **Modified** | Added `simple-statistics` dependency, `"test:exam-analytics"`, `"test:day19"`, and updated `"test:regression"`. |
| `test/exam-analytics.test.js` | **Created** | Test suite for candidate funnel, overview KPIs, abandonment, retakes, and empty exams. |
| `test/exam-question-analytics.test.js` | **Created** | Test suite for item accuracy, difficulty boundaries, timing behavior, and MCQ inspection. |
| `test/exam-coding-analytics.test.js` | **Created** | Test suite for coding execution telemetry, compiler/runtime/timeout counts, and pass rates. |
| `test/exam-analytics-security.test.js` | **Created** | Test suite for multi-tenant isolation, cross-tenant IDOR protection, and RBAC enforcement. |
| `test/exam-analytics-statistics.test.js` | **Created** | Test suite for `simple-statistics` computations, Kelley's discrimination index $D$, and sample size boundaries. |
| `DAY19-EXAM-ANALYTICS.md` | **Created** | Comprehensive technical and architectural specification. |
| `DAY19-ENGINEERING-REPORT.md` | **Created** | This engineering report. |

---

## 3. Mathematical & Statistical Methodology

### 3.1 Item Discrimination Index ($D$)
Implemented via the standard Upper/Lower Group Method (Kelley, 1939):
1. **Sample Size Eligibility**: $N \ge 10$ finalized attempts required. If $N < 10$, calculation returns `discriminationIndex: null` and `sampleSizeInsufficient: true` to prevent false conclusions.
2. **Kelley's 27% Rule**: Candidates are ranked by score percentage.
   - Upper Group ($U$): Top $k = \max(1, \text{round}(N \times 0.27))$ candidates.
   - Lower Group ($L$): Bottom $k = \max(1, \text{round}(N \times 0.27))$ candidates.
3. **Calculation**:
   $$D = P(U) - P(L) = \left(\frac{C_U}{k}\right) - \left(\frac{C_L}{k}\right)$$
4. **Ratings**:
   - $D \ge 0.40$: `EXCELLENT`
   - $0.30 \le D < 0.40$: `GOOD`
   - $0.20 \le D < 0.30$: `ACCEPTABLE`
   - $0.00 \le D < 0.20$: `POOR`
   - $D < 0.00$: `NEGATIVE` (flags misleading questions or corrupted answer keys).

### 3.2 Non-Parametric & Parametric Measures
Utilizes `simple-statistics` for all non-trivial calculations:
- **Median**: Exact middle score (resistant to extreme outliers).
- **Quantiles**: `ss.quantileSorted(sortedScores, 0.25)` (Q1), `ss.quantileSorted(sortedScores, 0.75)` (Q3), `ss.quantileSorted(sortedScores, 0.90)` (P90).
- **Interquartile Range (IQR)**: $\text{Q3} - \text{Q1}$.
- **Sample Standard Deviation**: $\sqrt{\frac{\sum (x - \bar{x})^2}{N - 1}}$ for $N > 1$.

---

## 4. Known Instrumentation Gaps & Dwell Timing Policy

- **Current Status**: While total assessment duration is tracked accurately via `started_at` and `submitted_at`, individual question dwell time is not logged per item unless explicitly recorded in synchronization payloads.
- **Handling**: In adherence to strict engineering rules, **dwell time is never fabricated**. When question timing is unrecorded, the API returns:
  ```json
  {
    "hasTimingData": false,
    "averageTimeSeconds": null,
    "medianTimeSeconds": null
  }
  ```
- **Forward-Compatible Roadmap**: When candidate UI logs question-focus events via `/api/attempt/:token/progress/sync`, `exam-analytics.service.js` automatically aggregates `time_spent_seconds` without requiring backend schema migrations.

---

## 5. Security & Multi-Tenant Verification

- **Fail-Closed 404 Responses**: When Organization A requests analytics for an exam owned by Organization B, the server responds with `404 Not Found`. This prevents tenant ID enumeration and protects business intelligence.
- **Permission Matrix**: Enforces `PERMISSIONS.ANALYTICS_READ`. The `VIEWER` role is rejected with `403 Forbidden`; `EVALUATOR`, `EXAM_MANAGER`, and `ORG_ADMIN` are permitted.
- **SQL Parameterization**: 100% of analytical queries use parameterized placeholders (`?`).

---

## 6. Verification & Test Results

All 5 dedicated test suites for Day 19 run with 0 failures:
- `test/exam-analytics.test.js`: Candidate funnel, retakes, and empty states.
- `test/exam-question-analytics.test.js`: Item accuracy, difficulty classifications, and timing.
- `test/exam-coding-analytics.test.js`: Coding telemetry, compiler/runtime/timeout metrics.
- `test/exam-analytics-security.test.js`: Multi-tenant isolation and RBAC.
- `test/exam-analytics-statistics.test.js`: `simple-statistics` calculations, discrimination $D$.

All 33 test suites across Days 1–19 maintain 100% green regression.

