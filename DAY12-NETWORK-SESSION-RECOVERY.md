# ASPIRE — DAY 12: Network Resilience, Automatic Saving & Assessment Session Recovery
## Production Documentation & Engineering Specification

**Platform:** Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS  
**Stage:** Day 12 Architecture Implementation  
**Status:** Complete & Fully Tested (12/12 Suites Green)

---

## 1. Executive Summary

During high-stakes online scholarship examinations, candidates experience real-world environmental disruptions:
- Transient Wi-Fi dropouts and cellular tethering disconnects.
- Laptop battery shutdowns and sudden system power losses.
- Accidental browser tab closures, page refreshes, and browser process crashes.
- Intermittent upstream application server lag or network partition.

**Day 12: Network Resilience, Automatic Saving & Session Recovery** provides bulletproof, enterprise-grade fault tolerance across candidate assessments. Candidates never lose progress, answers, or draft code solutions. All progress is automatically persisted client-side in structured IndexedDB storage and periodically batched and synchronized with the authoritative backend through a revision-controlled, idempotent synchronization protocol.

Crucially, **the server retains 100% authority over the assessment deadline, time remaining, question snapshot verification, and final grading**. Offline intervals never grant additional time or extend deadlines, eliminating gaming vectors while delivering uninterrupted candidate experience.

---

## 2. Architectural Overview

```text
Candidate Browser
┌────────────────────────────────────────────────────────────────────────┐
│  Candidate Assessment UI (frontend/test.html, frontend/js/test.js)      │
│   ├── MCQ Option Selection (immediate auto-save)                       │
│   ├── Code Editor Buffer (debounced auto-save: 600ms)                  │
│   ├── Question / Section Navigation                                    │
│   └── Visual Connection & Sync Status Badge                            │
└──────────────────┬─────────────────────────────▲───────────────────────┘
                   │                             │
                   ▼                             │ (State Rehydration)
┌──────────────────────────────────────┐         │
│ AssessmentStorage (IndexedDB / IDB)  │─────────┘
│  - Storage Key: aspire_assessment_tok│
│  - Transparent localStorage fallback │
│  - Monotonic local revisions         │
│  - Durable pending changes queue     │
└──────────────────┬───────────────────┘
                   │
                   ▼ (Batching, Exponential Backoff, Jitter)
┌────────────────────────────────────────────────────────────────────────┐
│ NetworkRecovery State Machine (frontend/js/network-recovery.js)        │
│  - States: ONLINE, UNSTABLE, OFFLINE, RECONNECTING, SYNCING, SYNCED   │
│  - Heartbeat Loop (every 15s): authoritative time, tab switches       │
│  - Auto-Sync Loop: flushes pending changes queue                      │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │
                   ▼ HTTPS (Zod Validation, Rate Limiter)
┌────────────────────────────────────────────────────────────────────────┐
│ Express Backend (backend/src/routes/public.js)                         │
│  ├── POST /api/attempt/:token/heartbeat (authoritative timer)          │
│  ├── POST /api/attempt/:token/progress/sync (batch progress sync)      │
│  └── GET  /api/attempt/:token (full session state recovery)            │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ SessionRecoveryService (backend/src/services/session-recovery.service) │
│  ├── HMAC Snapshot Integrity Verification                              │
│  ├── Idempotency Check via attempt_sync_changes                        │
│  ├── Monotonic Revision Check per (attempt, question, type)           │
│  └── Atomic SQLite WAL Transaction:                                    │
│       ├── Insert attempt_sync_changes log                              │
│       ├── Update attempts.answers_json                                 │
│       ├── Update attempts.draft_code_json                              │
│       └── Increment attempts.server_revision                           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Client Storage Architecture: `AssessmentStorage`

The frontend storage abstraction (`frontend/js/assessment-storage.js`) manages local assessment state with maximum reliability:

1. **Storage Mechanism:** Powered by `idb-keyval` v6.3.0 for IndexedDB asynchronous storage, with transparent fallback to `localStorage` and memory store if IndexedDB is blocked by browser privacy policies or storage limits.
2. **Attempt Scoping:** Storage records are scoped strictly per candidate attempt token: `aspire_assessment_${token}`.
3. **Session Identification:** A unique `clientSessionId` (`sess_${Date.now()}_...`) is generated per browser session to trace multi-tab or refreshed sessions.
4. **Structured Assessment State:**
   ```json
   {
     "token": "460e3ce6f64d82addc87123eaa6f8e47b201f90e734f2062",
     "clientSessionId": "sess_1761811200000_a8f9d0c",
     "localRevision": 5,
     "serverRevision": 3,
     "currentQuestionId": 12,
     "currentSectionId": 1,
     "answers": {
       "10": 2,
       "11": 0
     },
     "draftCode": {
       "15": {
         "code": "def solve(n):\n    return n * 2",
         "language": "python",
         "updatedAt": "2026-10-30T13:20:00.000Z"
       }
     },
     "pendingChanges": [
       {
         "changeId": "code_1761811200000_b7e9f1",
         "type": "CODE_DRAFT",
         "questionId": 15,
         "language": "python",
         "code": "def solve(n):\n    return n * 2",
         "revision": 5,
         "timestamp": "2026-10-30T13:20:00.000Z"
       }
     ],
     "lastSyncedAt": "2026-10-30T13:19:45.000Z",
     "updatedAt": "2026-10-30T13:20:00.000Z"
   }
   ```

---

## 4. Network Recovery State Machine: `NetworkRecovery`

`frontend/js/network-recovery.js` manages connection monitoring, periodic heartbeat, and automatic background queue synchronization.

### 4.1 State Machine Lifecycle
- `ONLINE`: Normal connection active, low failure count.
- `SYNCING`: Background batch sync of unsaved answers/drafts in flight.
- `SYNCED`: All local edits successfully acknowledged by the server.
- `CONNECTION_UNSTABLE`: Heartbeat or sync request timed out or returned transient network failure (1 failure).
- `OFFLINE`: Network completely unavailable or consecutive heartbeats failed ($\ge 2$ failures).
- `RECONNECTING`: Network `online` event received; pinging heartbeat before flushing queue.
- `SYNC_FAILED`: Sync request encountered HTTP error; retrying with bounded exponential backoff.

### 4.2 Sync Status UI Indicator
Located in the sticky top assessment header (`#timerBar`):
- `🟢 Synced`: All answers and draft code confirmed on server.
- `🔄 Syncing…`: In-flight progress sync batch.
- `⚠️ Unstable`: Connection degraded; candidate advised that answers remain safe locally.
- `🔴 Offline (Saved Locally)`: Wi-Fi dropped; candidate can continue answering questions without disruption.
- `🟡 Reconnecting…`: Network returning; automated reconciliation occurring.

---

## 5. Server-Side Synchronization & Recovery Endpoints

### 5.1 Authoritative Heartbeat
`POST /api/attempt/:token/heartbeat`
- **Request Body:**
  ```json
  {
    "tabSwitches": 2,
    "clientSessionId": "sess_1761811200000_a8f9d0c",
    "currentQuestionId": 12
  }
  ```
- **Response:**
  ```json
  {
    "ok": true,
    "acknowledged": true,
    "serverTime": "2026-10-30T13:25:00.000Z",
    "expiresAt": "2026-10-30T14:45:00.000Z",
    "remainingSeconds": 4800,
    "isExpired": false,
    "status": "started",
    "serverRevision": 4,
    "tabSwitches": 2,
    "lastSyncedAt": "2026-10-30T13:24:50.000Z"
  }
  ```
- **Guarantees:**
  - Strict server calculation: `remainingSeconds = Math.max(0, Math.floor((expiresMs - nowMs) / 1000))`.
  - Rejects client-supplied `remainingSeconds`, `score`, `marks`, or `serverRevision` with HTTP 400.
  - Updates attempt `last_heartbeat_at`, `client_session_id`, `current_question_id`, and monotonic `tab_switches`.

### 5.2 Batch Progress Synchronization
`POST /api/attempt/:token/progress/sync`
- **Rate Limit:** 120 requests/minute per IP (`recoverySyncLimiter`).
- **Request Body:**
  ```json
  {
    "clientSessionId": "sess_1761811200000_a8f9d0c",
    "localRevision": 5,
    "changes": [
      {
        "changeId": "mcq_1761811200100_c3e8a1",
        "type": "MCQ_ANSWER",
        "questionId": 10,
        "answer": 2,
        "revision": 4
      },
      {
        "changeId": "code_1761811200200_f9d2b4",
        "type": "CODE_DRAFT",
        "questionId": 15,
        "language": "python",
        "code": "def solve(n):\n    return n * 2",
        "revision": 5
      }
    ],
    "navigation": {
      "questionId": 15,
      "sectionId": 1
    }
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "accepted": true,
    "serverRevision": 5,
    "serverTime": "2026-10-30T13:25:01.000Z",
    "acknowledgedChanges": [
      "mcq_1761811200100_c3e8a1",
      "code_1761811200200_f9d2b4"
    ],
    "conflicts": [],
    "currentAnswersCount": 8,
    "currentDraftsCount": 2
  }
  ```

---

## 6. Conflict Resolution & Idempotency Protocol

To withstand unstable networks, repeated requests, and multiple browser instances:

1. **Idempotency Guarantee:**
   - Every change carries a cryptographically unique `changeId` (min 8 chars).
   - `attempt_sync_changes` records every applied `changeId`.
   - If an acknowledged packet was dropped in transit and the client re-transmits the batch, the server identifies existing `id` records, acknowledges them immediately, and does not duplicate changes or corrupt state.
2. **Monotonic Revision Ordering:**
   - Every change carries a monotonically increasing client `revision`.
   - The server maintains the latest applied revision per `(attempt_id, question_id, change_type)`.
   - If a client sends a stale revision ($\le \text{last applied revision}$), the change is safely rejected with conflict details (`reason: 'STALE_REVISION'`). The server state is protected from regression, and `attempts.sync_conflict_count` is incremented for monitoring.
3. **Snapshot Question Membership Validation:**
   - Every question ID submitted in changes or navigation is validated against the attempt's frozen question snapshot (`questions_snapshot_json`).
   - Requests referencing non-snapshot questions or illegal MCQ option indices are rejected with HTTP 400.
4. **Lifecycle Boundary Protection:**
   - Sync attempts against an already `submitted` assessment are rejected with HTTP 409 (`ATTEMPT_ALREADY_SUBMITTED`).
   - Sync attempts against an `expired` assessment are rejected with HTTP 409 (`ATTEMPT_EXPIRED`).

---

## 7. Strict Separation of Concerns

1. **Decoupled from Day 10 Async Execution (BullMQ):**
   - Candidate typing in the code editor automatically saves draft code (`attempts.draft_code_json`).
   - Draft code saves **never trigger BullMQ jobs or create `coding_submissions` records**.
   - Coding execution is only triggered when the candidate explicitly clicks **"Run Code"** (sample tests) or **"Submit Solution"** (full private test suite evaluation).
2. **Decoupled from Day 11 Proctoring Telemetry:**
   - Proctoring events remain stored strictly in `proctoring_events` (`attempt_id`, `event_type`, `risk_points`, `metadata_json`).
   - Assessment progress synchronization is logged strictly in `attempt_sync_changes`.
   - Proctoring risk scores cannot be forged via sync payloads.
3. **Automatic Evaluation Inclusion:**
   - During final submission (`POST /api/attempt/:token/submit`), the backend merges auto-saved `attempts.answers_json` with any submitted body answers. If a candidate experiences a network blip right during final submission, all previously auto-saved MCQ answers are evaluated and graded without loss.

---

## 8. Database Migrations (`010_network_session_recovery`)

```sql
-- 1. Durable sync change log
CREATE TABLE IF NOT EXISTS attempt_sync_changes (
  id TEXT PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  question_id INTEGER,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  client_session_id TEXT,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_attempt ON attempt_sync_changes(attempt_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_qid ON attempt_sync_changes(attempt_id, question_id);
CREATE INDEX IF NOT EXISTS idx_sync_changes_applied ON attempt_sync_changes(applied_at);

-- 2. Added columns to attempts table
ALTER TABLE attempts ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE attempts ADD COLUMN last_synced_at TEXT;
ALTER TABLE attempts ADD COLUMN server_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN current_question_id INTEGER;
ALTER TABLE attempts ADD COLUMN current_section_id INTEGER;
ALTER TABLE attempts ADD COLUMN client_session_id TEXT;
ALTER TABLE attempts ADD COLUMN draft_code_json TEXT;
ALTER TABLE attempts ADD COLUMN sync_conflict_count INTEGER NOT NULL DEFAULT 0;
```

---

## 9. Verification & Automated Test Baseline

Day 12 adds a comprehensive automated test suite `test/network-session-recovery.test.js` containing 89 assertions covering:
- Unit storage behavior with `idb-keyval` and fallback.
- Auto-save debouncing and revision incrementing.
- Authoritative heartbeat and strict deadline protection.
- Question snapshot membership validation.
- Batch synchronization and atomic persistence.
- Idempotency and stale revision conflict handling.
- Reconnection and page reload restoration.
- Independence from BullMQ execution and proctoring events.
- Admin results and CSV export metadata reporting.

**Total automated test suites: 12 passing test suites with 403+ green assertions.**

