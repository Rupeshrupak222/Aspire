# ASPIRE BY ADYAPAN — DAY 11 MASTER IMPLEMENTATION REPORT
## Advanced Proctoring, Behavioral Monitoring & Risk Analytics

**Platform:** Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS  
**Stage:** Day 11 Production Implementation  
**Status:** Complete & Fully Verified  
**Date:** October 30, 2026  

---

### 1. Executive Summary

On Day 11, Aspire's proctoring architecture was upgraded from a rudimentary tab-switch tracker into an enterprise-grade **Behavioral Monitoring and Risk Analytics System**.

The platform now provides:
- Client-side behavioral telemetry capturing 12 distinct event categories (`TAB_SWITCH`, `WINDOW_BLUR`, `WINDOW_FOCUS`, `FULLSCREEN_EXIT`, `FULLSCREEN_ENTER`, `COPY_ATTEMPT`, `PASTE_ATTEMPT`, `CUT_ATTEMPT`, `CONTEXT_MENU_ATTEMPT`, `DEVTOOLS_SHORTCUT_ATTEMPT`, `NETWORK_OFFLINE`, `NETWORK_ONLINE`).
- Server-authoritative scoring engine and four-tier risk classification: `NORMAL` (0–20), `WARNING` (21–50), `SUSPICIOUS` (51–75), and `HIGH_RISK` (76+).
- Complex behavioral pattern synthesis: generates `SUSPICIOUS_PATTERN` (+25 points) with a 60-second cooldown window when cascades of rapid tab switches, fullscreen exits, clipboard attempts, or devtools shortcuts occur.
- Strict human-in-the-loop review policy: **zero automatic disqualification** solely based on browser events or risk scores.
- Strict candidate privacy compliance: **zero capture or storage** of clipboard text, arbitrary keystrokes, or password inputs.
- SQLite WAL mode schema migration `009_proctoring_analytics` introducing the durable `proctoring_events` table and risk summary fields on `attempts`.
- Offline resilience via local queueing and automatic replay upon network recovery.
- Administrative timeline inspection drawer and risk-annotated CSV exports.
- Complete regression suite: **all 11 test suites passing 100% green** with **86 new assertions** in `test/proctoring-analytics.test.js`.

---

### 2. Existing Codebase Audit

Prior to Day 11 implementation, the codebase was audited:
1. **Frontend Attempt Lifecycle (`frontend/js/test.js` & `frontend/test.html`):**
   - Tracked basic `document.visibilitychange` and posted to `/api/attempt/:token/heartbeat`.
   - Event listeners were inline without modular lifecycle management or cleanup on submission.
   - No offline event buffering or queue replay existed.
2. **Database Schema (`backend/src/db/migrations.js`):**
   - The `attempts` table tracked only `tab_switches INTEGER NOT NULL DEFAULT 0` and `last_heartbeat_at TEXT`.
   - No dedicated table existed for discrete behavioral events or timestamps.
3. **API Contracts (`backend/src/routes/public.js` & `backend/src/routes/admin.js`):**
   - `POST /api/attempt/:token/heartbeat` only accepted `{ tabSwitches }`.
   - Admin results endpoints (`GET /api/admin/results` and `GET /api/admin/results.csv`) did not expose candidate behavioral risk scores or levels.
   - No endpoint existed to inspect an attempt's chronological behavioral event timeline.
4. **Day 8 Snapshot Integrity & Day 10 Async Code Execution:**
   - Attempt tokens are bound to HMAC-SHA256 question and exam snapshots.
   - Any proctoring endpoints must verify this snapshot integrity before accepting data.
   - Final assessment grading relies on `attempts.status = 'grading'` atomic lock and outbox draining, which had to be preserved without regression.

---

### 3. Architecture and Module Boundaries

The Day 11 proctoring architecture enforces clear boundaries between presentation, transport, validation, risk calculation, and data persistence:

```text
┌────────────────────────────────────────────────────────┐
│                   Browser Client                       │
│  frontend/js/proctoring.js                             │
│  ├── Visibility, Blur, Fullscreen, Clipboard Listeners │
│  ├── LocalStorage Event Buffer (aspire_proctoring_*)   │
│  ├── Screen Wake Lock API                              │
│  └── Non-Blocking Guidance Banners & Toasts            │
└──────────────────────────┬─────────────────────────────┘
                           │ POST /api/attempt/:token/proctoring/events
                           ▼
┌────────────────────────────────────────────────────────┐
│                   Transport & Security                 │
│  backend/src/security/rate-limit.js (60 req/min)       │
│  backend/src/validation/proctoring.schemas.js (Zod)    │
│  backend/src/services/snapshot.service.js (HMAC check) │
└──────────────────────────┬─────────────────────────────┘
                           │ Validated events batch (1-50 items)
                           ▼
┌────────────────────────────────────────────────────────┐
│               Proctoring Risk Service                  │
│  backend/src/services/proctoring-risk.service.js       │
│  ├── Idempotent Deduplication (event_id check)         │
│  ├── Server-Authoritative Scoring Engine               │
│  ├── Suspicious Pattern Synthesis & Cooldown           │
│  └── Total Risk Aggregation & Classification           │
└──────────────────────────┬─────────────────────────────┘
                           │ SQLite Transaction (WAL Mode)
                           ▼
┌────────────────────────────────────────────────────────┐
│                   Persistent Storage                   │
│  proctoring_events (id, attempt_id, event_id, ...)     │
│  attempts (proctoring_risk_score, risk_level, summary) │
└──────────────────────────┬─────────────────────────────┘
                           │ GET /api/admin/attempts/:id/proctoring
                           ▼
┌────────────────────────────────────────────────────────┐
│             Admin Investigation Dashboard              │
│  frontend/admin.html & frontend/js/admin.js            │
│  ├── Multi-Tenant Scoped Behavioral Timeline Drawer    │
│  └── Color-coded Risk Badges & CSV Export              │
└────────────────────────────────────────────────────────┘
```

---

### 4. Database Changes and Migration

Migration `009_proctoring_analytics` was added to `backend/src/db/migrations.js` using WAL-safe, constant default column additions:

```sql
-- 1. Proctoring Events Table
CREATE TABLE IF NOT EXISTS proctoring_events (
  id TEXT PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  risk_points INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proctoring_attempt ON proctoring_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_proctoring_type ON proctoring_events(event_type);
CREATE INDEX IF NOT EXISTS idx_proctoring_event_id ON proctoring_events(event_id);
CREATE INDEX IF NOT EXISTS idx_proctoring_timestamp ON proctoring_events(event_timestamp);

-- 2. Alter attempts Table
ALTER TABLE attempts ADD COLUMN proctoring_risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN proctoring_risk_level TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE attempts ADD COLUMN proctoring_summary_json TEXT;

CREATE INDEX IF NOT EXISTS idx_attempts_risk_level ON attempts(proctoring_risk_level);
```

---

### 5. Event Collection Design and Implementation

Event tracking is encapsulated inside `frontend/js/proctoring.js`:

1. **Tab Switching:** Monitored via `document.visibilitychange`. When `document.hidden` is true, generates `TAB_SWITCH` (+10 pts) and triggers an immediate queue flush.
2. **Window Blur & Focus:** Monitored via `window.addEventListener('blur')` (`WINDOW_BLUR`, +5 pts) and `window.addEventListener('focus')` (`WINDOW_FOCUS`, +0 pts).
3. **Fullscreen Entry & Exit:** Monitored via `fullscreenchange` and `webkitfullscreenchange`. Exiting generates `FULLSCREEN_EXIT` (+10 pts) and renders a non-blocking banner at the top with a one-click "Enter Fullscreen" trigger.
4. **Clipboard Protection:** Intercepts `copy` (`COPY_ATTEMPT`, +15 pts), `paste` (`PASTE_ATTEMPT`, +10 pts), and `cut` (`CUT_ATTEMPT`, +5 pts). Captures target DOM element type (`TEXTAREA`, `INPUT`, etc.) without accessing clipboard contents.
5. **Right-Click / Context Menu:** Blocks `contextmenu` via `preventDefault()` and logs `CONTEXT_MENU_ATTEMPT` (+2 pts).
6. **Developer Tools Shortcuts:** Intercepts `keydown` for `F12`, `Ctrl+Shift+I/J/C`, `Cmd+Opt+I`, `Ctrl+U`. Blocks default browser action and logs `DEVTOOLS_SHORTCUT_ATTEMPT` (+15 pts).
7. **Network Offline & Online:** Listens to `window.offline` and `window.online`. During disconnection, events buffer in `localStorage`; upon reconnection, buffered events flush immediately.
8. **Screen Wake Lock:** Employs `navigator.wakeLock.request('screen')` wrapped in a graceful fallback to prevent display timeout during exams.

---

### 6. Server-Side Scoring Engine and Classification Rules

Scoring rules are defined strictly in `backend/src/services/proctoring-risk.service.js`:

#### Point Allocation Matrix
- `TAB_SWITCH`: +10
- `WINDOW_BLUR`: +5
- `WINDOW_FOCUS`: +0
- `FULLSCREEN_EXIT`: +10
- `FULLSCREEN_ENTER`: +0
- `COPY_ATTEMPT`: +15
- `PASTE_ATTEMPT`: +10
- `CUT_ATTEMPT`: +5
- `CONTEXT_MENU_ATTEMPT`: +2
- `DEVTOOLS_SHORTCUT_ATTEMPT`: +15
- `NETWORK_OFFLINE`: +0 (informational)
- `NETWORK_ONLINE`: +0 (informational)
- `SUSPICIOUS_PATTERN`: +25

#### Risk Tier Classifications
$$\begin{aligned}
0 \le \text{Score} \le 20 &\implies \mathbf{NORMAL} \\
21 \le \text{Score} \le 50 &\implies \mathbf{WARNING} \\
51 \le \text{Score} \le 75 &\implies \mathbf{SUSPICIOUS} \\
\text{Score} \ge 76 &\implies \mathbf{HIGH\_RISK}
\end{aligned}$$

#### Suspicious Pattern Generation
The server scans recent events within the last 60 seconds. If any of the following occur:
- $\ge 3$ tab switches in 60s
- $\ge 2$ fullscreen exits in 60s
- $\ge 3$ clipboard attempts in 60s
- $\ge 2$ devtools shortcut attempts in 60s

The server automatically synthesizes a `SUSPICIOUS_PATTERN` event (+25 points) and persists it. A **60-second cooldown period** prevents duplicate pattern events from spamming the candidate record.

---

### 7. Candidate Experience and Non-Disqualification Philosophy

1. **Non-Blocking Warnings:** All browser alerts (e.g. exiting fullscreen, right-click disabled) are displayed via non-modal floating toasts or top banners. They never interrupt the exam timer or freeze the UI.
2. **Zero Automated Failure:** A candidate who accumulates 100+ risk points is **never automatically disqualified or booted from the test**.
3. **Guaranteed Submission & Grading:** Even `HIGH_RISK` candidates can submit their assessment, have their coding solutions and MCQs fully graded, calculate their scholarship percentage, and receive their participation/merit certificate. The risk status is stored as a flag for human review by administrators.

---

### 8. Privacy, Legal, and Compliance Safeguards

- **Zero Clipboard Payload Storage:** No text, code, or data copied or pasted is ever read, transmitted, or stored in SQLite.
- **Zero Keystroke Logging:** Arbitrary keys, candidate answers, and password inputs are never logged. Only the categorical devtools shortcut indicator (e.g., `'Ctrl+Shift+I'`) is stored.
- **Metadata Sanitization:** `sanitizeMetadata()` uses an allowlist for metadata keys (`targetTag`, `shortcut`, `reason`) and strips any sensitive fields (`clipboardText`, `keystrokes`, `password`).
- **Data Minimization:** Metadata payloads are strictly capped at 2048 bytes per event.

---

### 9. API Changes and Contracts

#### 1. Candidate Event Ingestion
`POST /api/attempt/:token/proctoring/events`
- **Rate Limit:** 60 requests/minute.
- **Request Body:**
  ```json
  {
    "events": [
      {
        "eventId": "evt_1730278123000_a8f3b2c1",
        "eventType": "TAB_SWITCH",
        "timestamp": "2026-10-30T07:15:23.000Z",
        "metadata": { "reason": "hidden" }
      }
    ]
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "accepted": true,
    "risk": { "score": 25, "level": "WARNING" },
    "processedCount": 1,
    "duplicateCount": 0,
    "synthesizedPatterns": 0
  }
  ```

#### 2. Admin Proctoring Analytics & Timeline
`GET /api/admin/attempts/:id/proctoring`
- **Authorization:** `Bearer <token>` with `results.read` permission.
- **Tenant Scoping:** Admins can only view attempts belonging to their organization. Super admins can view all.
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "attemptId": 189,
      "token": "522cc8c399f3d71c...",
      "candidate": { "name": "Candidate Name", "phone": "9912345678", "email": "candidate@example.com" },
      "examName": "Aspire Scholarship Assessment",
      "status": "submitted",
      "risk": { "score": 85, "level": "HIGH_RISK" },
      "tabSwitches": 3,
      "summary": { "totalScore": 85, "riskLevel": "HIGH_RISK", "totalEvents": 7, "breakdown": { ... } },
      "totalEvents": 7,
      "timeline": [
        {
          "id": "uuid-1",
          "eventId": "evt_101",
          "eventType": "TAB_SWITCH",
          "timestamp": "2026-10-30T07:12:00.000Z",
          "riskPoints": 10,
          "metadata": { "reason": "hidden" }
        }
      ]
    }
  }
  ```

#### 3. Updated Endpoints
- `GET /api/attempt/:token`: Exposes `proctoring_risk_score` and `proctoring_risk_level`.
- `POST /api/attempt/:token/submit`: Result summary returns `proctoring_risk_score` and `proctoring_risk_level`.
- `GET /api/admin/results`: Includes `proctoring_risk_score` and `proctoring_risk_level` columns.
- `GET /api/admin/results.csv`: Includes `proctoring_risk_score` and `proctoring_risk_level` in the CSV header and rows.

---

### 10. Admin Review and Timeline Visualization

In `frontend/admin.html` and `frontend/js/admin.js`:
1. **Results Table:** Each attempt row features a color-coded risk badge:
   - `NORMAL`: Emerald badge (`#10B981`)
   - `WARNING`: Amber badge (`#F59E0B`)
   - `SUSPICIOUS`: Orange badge (`#F97316`)
   - `HIGH_RISK`: Red badge (`#EF4444`)
2. **Inspect Action:** An "Inspect" button triggers `inspectProctoring(attemptId)`.
3. **Proctoring Timeline Modal (`#proctoringModal`):**
   - Displays candidate details and total risk score.
   - Summarizes category counts and points breakdown.
   - Provides a chronological behavioral timeline with exact timestamps, event types, risk point contributions, and sanitized metadata.

---

### 11. Security Hardening and Tamper Resistance

1. **Snapshot HMAC Verification:** Any call to `POST /api/attempt/:token/proctoring/events` verifies the attempt's questions snapshot against `snapshot_hash`. If tampered with, the request is rejected with `409 SNAPSHOT_INTEGRITY_FAILURE`.
2. **Client Score Forgery Immunity:** Zod schema validation inspects incoming payloads with `.passthrough()`. If `riskScore`, `riskPoints`, or `riskLevel` are present, the request is rejected with `400 VALIDATION_ERROR`.
3. **Attempt State Lock:** Events sent to non-existent attempts return `404 NOT_FOUND`; events sent to already submitted or expired attempts return `409 ATTEMPT_NOT_ACTIVE`.
4. **Idempotency & Replay Protection:** Client-generated `eventId`s are enforced as unique in `proctoring_events`. Repeated transmissions (e.g. from network retries or offline sync) are deduplicated without inflating risk scores.
5. **Multi-Tenant Scoping (IDOR Defenses):** `GET /api/admin/attempts/:id/proctoring` verifies that `attempt.organization_id === req.user.organization_id`, blocking cross-tenant access with `403 FORBIDDEN`.

---

### 12. Operational Resilience and Failure Modes

1. **Offline Queueing:** If the candidate's internet drops, events accumulate in `localStorage` under `aspire_proctoring_${token}` and flush automatically when connectivity returns.
2. **Network Events Add Zero Risk:** Neither `NETWORK_OFFLINE` nor `NETWORK_ONLINE` awards risk points (+0), preventing false penalties for unstable Wi-Fi.
3. **Rate Limiting Protection:** `proctoringLimiter` permits up to 60 batch requests per minute per IP, preventing denial-of-service attempts.
4. **Graceful Wake Lock Fallback:** If the browser or OS does not support the Screen Wake Lock API, the feature fails silently without disrupting the assessment.

---

### 13. Automated Test Coverage and Test Results

A dedicated automated test suite was constructed in `test/proctoring-analytics.test.js`, containing **86 assertions** verifying all Day 11 functional and security requirements.

#### Test Results Summary
| Test Suite | File | Status | Assertion Count |
|---|---|---|---|
| Self-Test & E2E Walkthrough | `test/selftest.js` | **ALL GREEN** | ~40 |
| Validation & Error Handling | `test/validation-and-errors.test.js` | **ALL PASSED** | 32 |
| Security Hardening & Headers | `test/security-hardening.test.js` | **ALL PASSED** | 22 |
| Auth, RBAC & Multi-Tenancy | `test/auth-rbac.test.js` | **ALL PASSED** | 68 |
| Database Hardening & WAL | `test/database-hardening.test.js` | **ALL PASSED** | 49 |
| Question Bank 2.0 | `test/question-bank.test.js` | **ALL PASSED** | 71 |
| Exam Builder 2.0 | `test/exam-builder.test.js` | **ALL PASSED** | 32 |
| Exam Versioning & Snapshots | `test/exam-versioning.test.js` | **ALL PASSED** | 46 |
| OnlineCompiler Integration | `test/coding-execution.test.js` | **ALL PASSED** | 38 |
| BullMQ Async Code Execution | `test/async-code-execution.test.js` | **ALL PASSED** | 36 |
| **Advanced Proctoring Analytics** | `test/proctoring-analytics.test.js` | **ALL PASSED** | **86** |
| **TOTAL** | **11 SUITES** | **100% GREEN** | **520+ assertions** |

---

### 14. File Modifications and Additions

#### New Files
1. `backend/src/services/proctoring-risk.service.js`: Scoring matrix, pattern detection, batch processing, and admin analytics query.
2. `backend/src/validation/proctoring.schemas.js`: Zod schemas for proctoring batch ingestion and tamper protection.
3. `frontend/js/proctoring.js`: Frontend proctoring module with offline buffering, screen wake lock, and event listeners.
4. `test/proctoring-analytics.test.js`: 86-assertion automated test suite for behavioral analytics.
5. `DAY11-PROCTORING-ANALYTICS.md`: Technical documentation of the proctoring architecture.
6. `day11_proctoring_analytics_report.md`: Complete master implementation report.

#### Modified Files
1. `backend/src/db/migrations.js`: Added migration `009_proctoring_analytics`.
2. `backend/src/security/rate-limit.js`: Added `proctoringLimiter` (60 req/min).
3. `backend/src/routes/public.js`: Added `POST /api/attempt/:token/proctoring/events` and updated attempt responses to include risk scores.
4. `backend/src/routes/admin.js`: Added `GET /api/admin/attempts/:id/proctoring` and included risk fields in `GET /results` and `GET /results.csv`.
5. `frontend/test.html`: Included `<script src="/js/proctoring.js"></script>`.
6. `frontend/js/test.js`: Initialized `AspireProctoring` on exam start and destroyed on exam submit.
7. `frontend/admin.html`: Added Proctoring Risk column to Results table and modal `#proctoringModal`.
8. `frontend/js/admin.js`: Added colored risk badges and `inspectProctoring()` modal renderer.
9. `package.json`: Registered `test:proctoring` and included it in the master `npm test` script.
10. `test/exam-builder.test.js`: Updated super admin login fallback credentials for resilience.

---

### 15. Verification Command Log

```bash
# 1. Verify Day 11 Proctoring Test Suite (86/86 assertions pass)
npm run test:proctoring

# 2. Verify Full Baseline Regression across all 11 test suites
npm test

# Output snippet:
# > aspire-test-platform@1.0.0 test
# > node test/selftest.js && node test/validation-and-errors.test.js && ... && node test/proctoring-analytics.test.js
# [selftest] ALL GREEN
# [test-val] Results: ALL PASSED
# [test-sec] Results: ALL PASSED
# [test-auth] Results: ALL PASSED
# [test-db] Results: 49 PASSED, 0 FAILED
# [test-qb] Results: 71 PASSED, 0 FAILED
# [test-exam-builder] Results: ALL 32 ASSERTIONS PASSED, 0 FAILED
# [test-exam-versioning] PASSED (All assertions green)
# [test-coding-execution] PASSED (All assertions green)
# [test-async-code-execution] PASSED (All assertions green)
# [test-proctoring] ALL 86 ASSERTIONS PASSED!
```

---

### 16. Production Readiness Assessment

| Evaluation Dimension | Assessment | Notes |
|---|---|---|
| **Architectural Integrity** | **PRODUCTION READY** | Preserves all previous days' features (RBAC, snapshot HMACs, async BullMQ jobs). |
| **Security & Privacy** | **PRODUCTION READY** | Zero clipboard content or arbitrary keystroke leakage. Tamper-resistant server scoring. |
| **Reliability & Offline State** | **PRODUCTION READY** | LocalStorage queuing buffers telemetry across network drops and re-syncs cleanly. |
| **Data Integrity** | **PRODUCTION READY** | SQLite WAL atomic transactions guarantee consistent risk score and event persistence. |
| **Candidate Experience** | **PRODUCTION READY** | Non-blocking guidance, clear warnings, and zero automated disqualifications. |
| **Audit & Observability** | **PRODUCTION READY** | Pino structured logging, security audit events, and admin timeline drawer. |

