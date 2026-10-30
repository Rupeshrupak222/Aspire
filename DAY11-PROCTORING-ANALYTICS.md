# Aspire by Adyapan — Day 11
## Advanced Proctoring, Behavioral Monitoring & Risk Analytics

---

## 1. Executive Summary

Day 11 transforms Aspire's basic proctoring tracking (`visibilitychange`, `blur`, `tab_switches`, and heartbeat) into an enterprise-grade behavioral monitoring and risk analytics engine.

The system continuously captures, deduplicates, and evaluates candidate behavioral telemetry during assessments, calculates server-authoritative risk scores, detects complex multi-event suspicious patterns, enforces strict candidate privacy safeguards, and surfaces chronological behavioral timelines in the administrative dashboard for human review.

```text
Candidate Browser (frontend/js/proctoring.js)
    │
    ├── Tab Switching (visibilitychange / hidden)
    ├── Window Blur & Focus
    ├── Fullscreen Entry & Exit
    ├── Clipboard Activity (Copy, Paste, Cut — zero content captured)
    ├── Context Menu / Right-Click Interception
    ├── Developer Tools Shortcuts (F12, Ctrl+Shift+I/J/C, Ctrl+U)
    ├── Network Disconnect & Reconnect (Offline Queue & Local Replay)
    └── Screen Wake Lock (prevents display sleep)
    │
    ▼ (Batch Transmission every 3s or Immediate on Critical Events)
POST /api/attempt/:token/proctoring/events
    │
    ├── Rate Limiting (60 req/min)
    ├── Attempt State & Snapshot HMAC Verification
    ├── Zod Schema Validation & Client Score Tamper Rejection
    ├── Idempotent Event Deduplication (Unique event_id)
    ├── Server-Authoritative Scoring Engine (backend/src/services/proctoring-risk.service.js)
    ├── Suspicious Pattern Generator (+25 pts with 60s Cooldown)
    └── SQLite WAL Mode Atomic Transaction
            ├── INSERT INTO proctoring_events
            └── UPDATE attempts (proctoring_risk_score, proctoring_risk_level, proctoring_summary_json)
    │
    ▼
Admin Investigation Console (frontend/admin.html & js/admin.js)
    │
    ├── GET /api/admin/attempts/:id/proctoring
    ├── Multi-Tenant Scoped Behavioral Analytics & Timeline Drawer
    └── CSV Results Export with Risk Classification
```

---

## 2. Event Taxonomy & Risk Scoring Allocation

Each event recorded by the system is assigned server-authoritative risk points according to its potential impact on assessment integrity:

| Event Type | Points | Purpose & Technical Signal | Privacy / Security Rule |
|---|---|---|---|
| `TAB_SWITCH` | **+10** | Document visibility transitioned to hidden (`document.hidden = true`). | Synchronized with legacy `tab_switches` column. |
| `WINDOW_BLUR` | **+5** | Window lost focus (`window.blur`). | Captures app switching without tab change. |
| `WINDOW_FOCUS` | **+0** | Window regained focus (`window.focus`). | Informational lifecycle marker. |
| `FULLSCREEN_EXIT` | **+10** | Candidate exited browser fullscreen mode. | Triggers non-blocking warning and re-enter button. |
| `FULLSCREEN_ENTER` | **+0** | Candidate returned to fullscreen mode. | Informational compliance marker. |
| `COPY_ATTEMPT` | **+15** | Candidate attempted to copy text (`copy` event). | **Zero clipboard text collected or stored.** |
| `PASTE_ATTEMPT` | **+10** | Candidate attempted to paste text (`paste` event). | **Zero clipboard text collected or stored.** |
| `CUT_ATTEMPT` | **+5** | Candidate cut selected content (`cut` event). | Zero text content collected. |
| `CONTEXT_MENU_ATTEMPT` | **+2** | Right-click attempt intercepted and blocked. | Context menu suppressed via `preventDefault()`. |
| `DEVTOOLS_SHORTCUT_ATTEMPT` | **+15** | Developer tools shortcuts intercepted (`F12`, `Ctrl+Shift+I/J/C`, `Ctrl+U`). | **No arbitrary keystroke logging; shortcut category only.** |
| `NETWORK_OFFLINE` | **+0** | Network lost (`window.offline`). | Informational marker; queues events locally. |
| `NETWORK_ONLINE` | **+0** | Network restored (`window.online`). | Informational marker; triggers automatic queue flush. |
| `SUSPICIOUS_PATTERN` | **+25** | Server-synthesized cascade pattern detection. | Cooldown period of 60s enforced to avoid spam. |

---

## 3. Risk Level Classifications

The server calculates the aggregate risk score across all events for an attempt and classifies the candidate into one of four distinct tiers:

$$\text{Risk Level} = \begin{cases}
\text{NORMAL} & \text{if } 0 \le \text{Score} \le 20 \\
\text{WARNING} & \text{if } 21 \le \text{Score} \le 50 \\
\text{SUSPICIOUS} & \text{if } 51 \le \text{Score} \le 75 \\
\text{HIGH\_RISK} & \text{if } \text{Score} \ge 76
\end{cases}$$

### Strict Non-Disqualification Philosophy
> **IMPORTANT:** Candidates are **NEVER automatically disqualified or failed** solely because their risk score crosses into `WARNING`, `SUSPICIOUS`, or `HIGH_RISK`. High-risk attempts are flagged in the administrative portal for **human review**. Candidates retain full ability to complete their exam, receive authoritative scoring, earn scholarship tiers, and obtain certificates without automated disqualification based on fragile client-side browser events.

---

## 4. Privacy & Zero Data Leakage Architecture

The proctoring system enforces strict privacy safeguards:

1. **Zero Clipboard Content Capture:** Neither `copy` nor `paste` event handlers ever read `clipboardData` or `navigator.clipboard`. Only the event occurrence, target DOM tag name (e.g. `TEXTAREA`), and timestamp are captured.
2. **Zero Keystroke Logging:** Arbitrary keypresses, candidate text inputs, and password fields are never recorded. Only explicit developer tools shortcut combinations (`F12`, `Ctrl+Shift+I/J/C`, `Ctrl+U`, `Cmd+Opt+I`) are intercepted.
3. **Payload Sanitization & Stripping:** `sanitizeMetadata()` automatically strips any attempted injection of forbidden keys (`clipboardText`, `clipboardData`, `keystrokes`, `password`, `inputVal`).
4. **Client Score Tampering Rejection:** Any client request attempting to supply `riskScore`, `riskPoints`, or `riskLevel` is rejected with HTTP `400 VALIDATION_ERROR`. Scoring is 100% server-authoritative.

---

## 5. Database Schema & Migration `009_proctoring_analytics`

Implemented in `backend/src/db/migrations.js`:

```sql
-- 1. Dedicated Behavioral Events Table
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

-- 2. Add Proctoring Columns to attempts Table
ALTER TABLE attempts ADD COLUMN proctoring_risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN proctoring_risk_level TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE attempts ADD COLUMN proctoring_summary_json TEXT;

CREATE INDEX IF NOT EXISTS idx_attempts_risk_level ON attempts(proctoring_risk_level);
```

---

## 6. API Endpoints

### A. Candidate Ingestion: `POST /api/attempt/:token/proctoring/events`
- **Rate Limit:** 60 requests/minute (`proctoringLimiter`).
- **Integrity Checks:** Validates attempt status `'started'`, unexpired duration, and Day 8 HMAC snapshot integrity.
- **Deduplication:** Idempotently accepts batches with unique `event_id`s. Duplicate IDs are counted but do not re-increment risk scores.
- **Request Format:**
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
- **Response Format (200 OK):**
  ```json
  {
    "success": true,
    "accepted": true,
    "risk": {
      "score": 25,
      "level": "WARNING"
    },
    "processedCount": 1,
    "duplicateCount": 0,
    "synthesizedPatterns": 0
  }
  ```

### B. Admin Investigation: `GET /api/admin/attempts/:id/proctoring`
- **Permission Required:** `results.read` (`PERMISSIONS.RESULTS_READ`).
- **Multi-Tenant Isolation:** Enforces organization scoping. Non-super admins cannot view attempts from another organization (HTTP `403 FORBIDDEN`).
- **Response Format:**
  ```json
  {
    "success": true,
    "data": {
      "attemptId": 189,
      "token": "522cc8c399f3d71c...",
      "candidate": { "name": "Jane Doe", "phone": "9912345678", "email": "jane@example.com" },
      "examName": "Aspire Scholarship Assessment",
      "status": "submitted",
      "risk": { "score": 85, "level": "HIGH_RISK" },
      "tabSwitches": 3,
      "summary": {
        "totalScore": 85,
        "riskLevel": "HIGH_RISK",
        "totalEvents": 7,
        "breakdown": {
          "TAB_SWITCH": { "count": 3, "points": 30 },
          "COPY_ATTEMPT": { "count": 2, "points": 30 },
          "SUSPICIOUS_PATTERN": { "count": 1, "points": 25 }
        }
      },
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

---

## 7. Frontend Proctoring Client (`frontend/js/proctoring.js`)

The standalone proctoring module integrates into `frontend/test.html` and `frontend/js/test.js`:

1. **Clean Lifecycle Hooks:**
   - `AspireProctoring.init({ token })`: Attaches all browser event listeners, initializes `localStorage` queue, and starts background flush interval.
   - `AspireProctoring.destroy()`: Flushes remaining queue via `keepalive: true`, releases wake locks, cleans up banners, and removes all event listeners.
2. **Offline Resilience & Queue Replay:**
   - Events are buffered in memory and mirrored to `localStorage` under `aspire_proctoring_${token}`.
   - Background interval flushes up to 50 events every 3 seconds.
   - Upon network reconnect (`window.online`), the queue is automatically flushed.
3. **Screen Wake Lock API:**
   - Requests `navigator.wakeLock.request('screen')` to prevent OS display sleep during timed assessments.
4. **Non-Blocking Candidate Guidance:**
   - When fullscreen mode is exited, a non-blocking top banner informs the candidate and offers an immediate "Enter Fullscreen" button.
   - Non-intrusive floating toasts inform the candidate when protected actions (e.g. right-click, devtools shortcuts) are blocked.

---

## 8. Verification & Test Suite

The test suite `test/proctoring-analytics.test.js` exercises **86 automated assertions** across 9 comprehensive sections:

1. **Risk Scoring & Strict Boundary Classification:** 0, 10, 20 (`NORMAL`), 21, 35, 50 (`WARNING`), 51, 65, 75 (`SUSPICIOUS`), 76, 150 (`HIGH_RISK`).
2. **Privacy & Metadata Sanitization:** Stripping of `clipboardText`, `clipboardData`, `keystrokes`, `password`, and client `riskScore`.
3. **Multi-Tenant Fixture Setup:** Provisioning organizations, RBAC users, and snapshot-protected candidate attempts.
4. **Event Ingestion & Server Scoring:** Verified point allocations for all 12 event types.
5. **Security & Input Validation Defenses:** Rejection of forged client scores, batch limits (>50), empty batches, unsupported event types, and tampered snapshot HMACs.
6. **Suspicious Pattern Generator:** Synthesis of `SUSPICIOUS_PATTERN` (+25 points) and 60-second cooldown protection.
7. **Admin Proctoring Analytics & Multi-Tenant Isolation:** Unauthenticated rejection (401), cross-tenant IDOR blocking (403 `FORBIDDEN`), and authorized timeline retrieval.
8. **Non-Disqualification & Final Grading:** Verification that `HIGH_RISK` candidates successfully complete assessment, receive proper grading, scholarships, and certificates.
9. **Admin Results List & CSV Export:** Verified presence of `proctoring_risk_score` and `proctoring_risk_level` in admin table and CSV download.

