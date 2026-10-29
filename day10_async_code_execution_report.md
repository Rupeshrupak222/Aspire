# ASPIRE — DAY 10 IMPLEMENTATION REPORT
## Asynchronous Code Execution with Redis, BullMQ, and Dedicated Workers

**Project:** Aspire by Adyapan — Multi-Tenant Scholarship Assessment SaaS  
**Stage:** Day 10 Milestone  
**Engineering Focus:** Distributed Asynchronous Job Execution, Redis + BullMQ Queue, Dedicated Worker Process, SQLite Transactional Outbox, Dual-Write Resilience, Candidate Polling Protocol, Zero Hidden Test Case Leakage, and End-to-End Test Suite Green Baseline.

---

## 1. Executive Summary

On Day 10, the synchronous request-response coding evaluation layer implemented on Day 9 was elevated into an **enterprise-grade, durable, asynchronous job-processing pipeline**. 

In high-concurrency scholarship assessments, executing multi-test coding solutions synchronously across external compilers (such as OnlineCompiler.io) exposes API gateways to HTTP socket timeouts, resource starvation, and dual-write inconsistencies. Day 10 solves these challenges by:

1. **Decoupling Candidate Ingestion from Execution:** The candidate submission route (`POST /api/attempt/:token/code-submit`) validates attempt status, verifies snapshot HMAC integrity, performs 15-second idempotency checks, persists the submission to SQLite within an atomic transactional outbox, and returns **HTTP 202 Accepted** immediately with polling coordinates (`statusUrl`, `retryAfterMs`).
2. **Authoritative SQLite Persistence (Transactional Outbox Pattern):** SQLite with WAL mode remains the authoritative source of truth. Redis and BullMQ serve as an ephemeral transport mechanism. Submissions are claimed and outbox events recorded in an atomic SQLite transaction, ensuring zero loss of candidate work during network blips or Redis outages.
3. **Dedicated BullMQ Worker Process:** A separate worker process consumes evaluation jobs from the Redis queue with configurable concurrency, executes test suites against the provider abstraction, updates `coding_submissions` authoritatively, and updates the attempt's code answers.
4. **Candidate Polling Protocol (`GET /api/attempt/:token/code-submissions/:submissionId`):** Candidates poll status changes (`QUEUED` $\rightarrow$ `RUNNING` $\rightarrow$ `COMPLETED` / `FAILED`) with strict separation between lifecycle status and assessment verdicts (`ACCEPTED`, `WRONG_ANSWER`, `COMPILATION_ERROR`).
5. **Zero-Leakage Privacy:** Private test inputs, expected outputs, and actual stdout are completely scrubbed at the service boundary.
6. **Final Exam Submit Coordination:** When candidate submits the assessment, in-flight coding jobs are drained so that final marks and scholarship slab allocations accurately reflect authoritative completed scores.
7. **Regression Suite 100% Green:** All 10 automated test suites (selftest, validation-and-errors, security-hardening, auth-rbac, database-hardening, question-bank, exam-builder, exam-versioning, coding-execution, async-code-execution) passed with **0 failures**.

---

## 2. Pre-Implementation Code & Architecture Audit

Before modifying the codebase, an audit of Day 9's implementation was conducted:
- **Routes Audited:** `backend/src/routes/public.js` (`/code-run`, `/code-submit`, `/submit`), `backend/src/routes/admin.js` (`/code-execution/status`, `/attempts/:id/coding-submissions`).
- **Services Audited:** `backend/src/services/code-execution/execution.service.js`, `providers/onlinecompiler.provider.js`, `providers/judge0.provider.js`.
- **Database Audited:** `coding_submissions` table schema, index definitions, attempt snapshot integrity mechanisms.
- **Findings:**
  - `POST /code-run` provides interactive IDE feedback on public/sample test cases. Because it is fast and interactive, it was preserved as synchronous.
  - `POST /code-submit` previously ran all test cases in the HTTP request handler before responding, blocking the candidate for up to several seconds.
  - The database lacked queue tracking fields (`lifecycle_status`, `job_id`, `queued_at`, `started_at`, `attempt_count`, `last_error_code`).
  - No transactional outbox table existed to buffer jobs during Redis disconnects.
  - `POST /submit` (final exam submit) previously relied on a legacy Judge0 adapter; it needed coordination to retrieve authoritative scores from `coding_submissions`.

---

## 3. Distributed Job Queue Architecture (Redis + BullMQ)

The queue layer is encapsulated in `backend/src/queues/code-execution.queue.js` backed by `bullmq` and `ioredis`.

```text
┌───────────────────────┐       ┌────────────────────────┐       ┌───────────────────────┐
│ Express API / Outbox  │ ────► │  Redis / BullMQ Queue  │ ────► │   Dedicated Worker    │
│  enqueueSubmissionJob │       │ (aspire-code-execution)│       │   processCodeJob()    │
└───────────────────────┘       └────────────────────────┘       └───────────────────────┘
```

### Queue Configuration & Features
- **Queue Identifier:** Configured via `CODE_EXECUTION_QUEUE_NAME` (default: `'aspire-code-execution'`).
- **Stable Deduplication ID:** Every job uses `jobId: submissionId` (`csub_...`), guaranteeing that duplicate enqueue attempts in BullMQ do not result in duplicate executions.
- **Backoff & Retry Policy:** Exponential backoff with initial 1000ms delay, bounded by `CODE_EXECUTION_JOB_ATTEMPTS` (default: 3).
- **Retention Hygiene:** 
  - `removeOnComplete`: Retains last 1,000 completed jobs up to 1 hour for telemetry.
  - `removeOnFail`: Retains up to 5,000 failed jobs for 24 hours for post-mortem debugging.
- **Mock Mode Support:** Supports headless test runs via `.setMockMode(true)` for CI environments without live Redis daemons.

---

## 4. SQLite Authority & Dual-Write Resolution (Transactional Outbox Pattern)

A critical architectural requirement for Aspire is that Redis must **never** become the source of truth for candidate assessment state.

### The Dual-Write Problem
If an application writes to SQLite and then writes to Redis over the network, a network drop or crash between the two writes causes state divergence: the database has a queued submission, but Redis never received the job.

### Aspire's Transactional Outbox Solution
```text
BEGIN TRANSACTION;
  INSERT INTO coding_submissions (id, attempt_id, question_id, ..., lifecycle_status='QUEUED');
  INSERT INTO outbox_events (id, event_type='CODE_EXECUTION_REQUESTED', aggregate_id=submissionId, payload_json=..., status='PENDING');
COMMIT;
```
1. **Atomic Ingestion:** Both the submission record and the outbox event are inserted in a single SQLite transaction.
2. **Immediate Dispatch:** Right after commit, `outboxDispatcher.dispatchImmediate(submissionId)` attempts to publish the job to BullMQ.
3. **Redis Outage Resilience:** If Redis is down, BullMQ's connection failure is caught safely:
   - The outbox event remains in SQLite with `status = 'PENDING'`.
   - `attempt_count` is incremented, and `available_at` is scheduled with exponential backoff (`available_at = datetime('now', '+5 seconds')`).
   - The candidate's submission is never rejected or lost; it safely awaits Redis recovery or fallback processing.
4. **Fallback / Drain Processor:** `outboxDispatcher.drainAttemptSubmissions(attemptId)` ensures that if a candidate submits their final exam while Redis is down or slow, pending submissions are processed authoritatively so marks are never omitted.

---

## 5. Database Migration (Migration 008)

Migration `008_async_code_execution` was implemented in `backend/src/db/migrations.js` with WAL mode compatibility:

```sql
-- 1. Create outbox_events table for durable asynchronous job dispatching
CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_avail ON outbox_events(status, available_at);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox_events(created_at);

-- 2. Add lifecycle status and job tracking columns to coding_submissions
ALTER TABLE coding_submissions ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'QUEUED';
ALTER TABLE coding_submissions ADD COLUMN job_id TEXT;
ALTER TABLE coding_submissions ADD COLUMN queued_at TEXT;
ALTER TABLE coding_submissions ADD COLUMN started_at TEXT;
ALTER TABLE coding_submissions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coding_submissions ADD COLUMN last_error_code TEXT;
ALTER TABLE coding_submissions ADD COLUMN last_error_at TEXT;

CREATE INDEX IF NOT EXISTS idx_coding_subs_lifecycle ON coding_submissions(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_coding_subs_job_id ON coding_submissions(job_id);
```

---

## 6. Dedicated Worker Implementation & Concurrency

### Worker Architecture (`backend/src/workers/code-execution.worker.js`)
- **Process Isolation:** Runs as an independent Node.js process (`npm run worker:code`), completely separate from the Express API cluster.
- **Concurrency Control:** Configured via `CODE_EXECUTION_WORKER_CONCURRENCY` (default: 5 concurrent jobs).
- **Graceful Shutdown:** Intercepts `SIGTERM` and `SIGINT`, halts new job acquisitions, waits for active jobs to complete (lock duration: 120,000ms), and calls `worker.close()` and `closeRedisConnections()`.

### Worker Processor (`backend/src/workers/code-execution.processor.js`)
The `processCodeJob(jobData)` processor:
1. Loads the submission from `coding_submissions WHERE id = submissionId`.
2. Checks idempotency: if already `COMPLETED`, exits cleanly.
3. Loads attempt and verifies **HMAC snapshot integrity** via `snapshotService.verifySnapshotIntegrity(attempt)`.
4. Transitions `lifecycle_status = 'RUNNING'` and records `started_at`.
5. Resolves target question and test cases from the frozen snapshot.
6. Calls `executionService.evaluateQuestion({ language, sourceCode, testCases, sampleOnly: false })`.
7. Calculates score: $\text{score} = \text{round}\left(\text{marks} \times \frac{\text{testsPassed}}{\text{testsTotal}}, 2\right)$.
8. Transactionally persists terminal evaluation to `coding_submissions` (`lifecycle_status = 'COMPLETED'`, `submission_status = verdict`), updates `attempts.code_answers_json`, and records an audit log event.

---

## 7. Submission State Machine & Verdict Isolation

Aspire strictly separates queue execution lifecycle from evaluation verdicts:

```text
                  ┌───────────────┐
                  │    QUEUED     │
                  └───────┬───────┘
                          │ (Worker acquires job)
                          ▼
                  ┌───────────────┐
       ┌───────── │    RUNNING    │ ─────────┐
       │          └───────┬───────┘          │
       │ (Transient 5xx)  │ (Evaluated)      │ (Fatal error)
       ▼                  ▼                  ▼
┌───────────────┐ ┌───────────────┐  ┌───────────────┐
│   RETRYING    │ │   COMPLETED   │  │    FAILED     │
└──────┬────────┘ └───────────────┘  └───────────────┘
       │ (Backoff)        ▲
       └──────────────────┘
```

### Deterministic Verdicts Do NOT Trigger Queue Retries
If candidate code outputs a wrong answer, encounters a syntax error (`COMPILATION_ERROR`), crashes (`RUNTIME_ERROR`), or times out (`TIME_LIMIT_EXCEEDED`), this is a **deterministic assessment verdict**. The worker immediately transitions the submission to `COMPLETED` with the appropriate `submission_status` verdict. Only transient external provider outages (HTTP 502/503/504 or network socket drops) trigger `RETRYING` and BullMQ backoff.

---

## 8. Candidate API Protocol (HTTP 202 Async Submit & Polling)

### A. Code Submit: `POST /api/attempt/:token/code-submit`
- **Rate Limit:** 25 req/min per IP.
- **Payload Validation:** Enforces positive `questionId`, non-empty whitelisted `language`, and `sourceCode` ($\le 100\text{ KB}$).
- **15-Second Idempotency:** Duplicate submissions with identical code in the last 15 seconds return the existing record without duplicate executions.
- **Response (HTTP 202):**
  ```json
  {
    "success": true,
    "submissionId": "csub_785d2928bb640027d5c56145",
    "status": "QUEUED",
    "statusUrl": "/api/attempt/93ffd19c.../code-submissions/csub_785d2928bb640027d5c56145",
    "retryAfterMs": 1500
  }
  ```

### B. Status Polling: `GET /api/attempt/:token/code-submissions/:submissionId`
- **Attempt Isolation (IDOR Protection):** Ensures candidate token matches the submission's attempt ID.
- **Snapshot Integrity:** Re-verifies HMAC integrity; returns 409 if snapshot tampered.
- **Terminal Response (HTTP 200):**
  ```json
  {
    "success": true,
    "submissionId": "csub_785d2928bb640027d5c56145",
    "status": "COMPLETED",
    "verdict": "ACCEPTED",
    "language": "python",
    "testsPassed": 3,
    "testsTotal": 3,
    "score": 5,
    "marks": 5,
    "executionTimeMs": 126,
    "error": null,
    "createdAt": "2026-10-29 18:15:51",
    "queuedAt": "2026-10-29 18:15:51",
    "startedAt": "2026-10-29 18:15:51",
    "completedAt": "2026-10-29 18:15:51"
  }
  ```

---

## 9. Hidden Test Case Security & Client Protection

Hidden test cases safeguard assessment integrity:
1. **Interactive Run (`/code-run`):** Only processes `sample_test_cases` (public tests).
2. **Final Submission (`/code-submit`):** Evaluates all tests (public + private).
3. **Client Isolation:** The polling endpoint and `coding_submissions` store only pass/fail tallies (`testsPassed`, `testsTotal`) and final score. Neither private inputs (`10 20`), private expected outputs (`30`), nor candidate execution stdout on private tests are ever transmitted to candidate browsers or logs.

---

## 10. Error Handling, Bounded Backoff, & Redis Outage Resilience

| Scenario | Behavior |
| :--- | :--- |
| **Redis Server Down on Submission** | SQLite commits submission (`QUEUED`) and outbox event (`PENDING`). API responds HTTP 202. Job is retained in SQLite outbox with exponential backoff on `available_at`. |
| **Worker Process Crash** | BullMQ lock expiration (120s) releases job back to queue for reassignment to another worker. |
| **Provider 503 / Timeout** | Worker catches error, updates SQLite `lifecycle_status = 'RETRYING'`, and throws to BullMQ for exponential backoff (1s, 2s, 4s). If max attempts exceeded, marks `FAILED` with `submission_status = 'PROVIDER_ERROR'`. |
| **Snapshot HMAC Tampered** | Worker catches integrity violation, transitions submission to `FAILED` with `SYSTEM_ERROR`, and halts evaluation. |

---

## 11. Final Exam Grading Coordination & Authoritative Scoring

When a candidate finishes their exam and invokes `POST /api/attempt/:token/submit`:
1. **In-Flight Coordination:** The endpoint invokes `outboxDispatcher.drainAttemptSubmissions(attemptId, 8000)`, waiting up to 8 seconds for pending coding jobs to complete.
2. **Authoritative Lookup:** For every coding question in the exam, marks are pulled directly from completed records in `coding_submissions`:
   ```sql
   SELECT * FROM coding_submissions
   WHERE attempt_id = ? AND question_id = ? AND lifecycle_status = 'COMPLETED'
   ORDER BY score DESC, completed_at DESC LIMIT 1
   ```
3. **Combined Grading:** MCQ marks and coding question marks are summed authoritatively to compute percentage, allocate scholarship slabs, and generate certificates.

---

## 12. Admin Observability, Queue Metrics, & Submissions Inspection

### A. Queue Metrics Endpoint (`GET /api/admin/code-execution/queue-metrics`)
Requires `ANALYTICS_READ` permission. Returns:
- **Queue Counts:** `waiting`, `active`, `completed`, `failed`, `delayed`.
- **Outbox Counts:** `PENDING`, `DISPATCHED`, `FAILED`.
- **Lifecycle Counts:** `QUEUED`, `RUNNING`, `RETRYING`, `COMPLETED`, `FAILED`.

### B. Attempt Submissions Inspection (`GET /api/admin/attempts/:id/coding-submissions`)
Requires `RESULTS_READ` permission with strict multi-tenant organization boundary validation. Returns complete audit rows with `lifecycle_status`, `job_id`, `queued_at`, `started_at`, `attempt_count`, `last_error_code`, `score`, and duration.

---

## 13. Frontend Coding Editor & Resilient Polling

In `frontend/js/test.js`:
- Candidate clicks **Submit Solution**: UI displays `⏳ Evaluating complete test suite...`.
- Receives HTTP 202: Displays `⏳ Submission queued. Waiting for worker assignment...`.
- Polls `statusUrl` with backoff (every 1,500ms):
  - When status updates to `RUNNING`: Displays `⚡ Worker evaluating private test suite in isolated runtime...`.
  - When status updates to `COMPLETED`: Renders verdict badge (`ACCEPTED`, `WRONG_ANSWER`), score earned, and test case pass ratio.
- **Local Persistence:** Source code is cached in browser `localStorage` (`aspire_code_${token}_${questionId}`) to survive page refreshes or connection drops.

---

## 14. Automated Test Suite & Regression Verification

A dedicated automated test suite (`test/async-code-execution.test.js`) was engineered covering 14 distinct integration sections:

1. **Test Fixtures Setup:** Tenant, Org Admin, published exam with MCQ and coding questions (with 1 public and 2 hidden test cases).
2. **HTTP 202 Async Acknowledgment:** Verifies non-blocking 202 status and `statusUrl`.
3. **Transactional Outbox Durability:** Verifies dual-write atomicity in `coding_submissions` and `outbox_events`.
4. **Polling Endpoint in QUEUED State:** Verifies initial polling behavior and `retryAfterMs`.
5. **Worker Processing & State Machine:** Verifies transition `QUEUED` $\rightarrow$ `RUNNING` $\rightarrow$ `COMPLETED` and authoritative SQLite updates.
6. **Polling Endpoint in COMPLETED State & Hidden Test Privacy:** Verifies verdict exposure with zero private test data leakage.
7. **Polling Authorization & IDOR Protection:** Verifies cross-candidate and cross-attempt polling rejections (404).
8. **Snapshot HMAC Integrity Check:** Verifies that tampered attempt snapshots are rejected (409).
9. **Error-Aware Retries vs Deterministic Failures:** Verifies that deterministic failures (`WRONG_ANSWER`) complete without retry, while 503 provider errors flag `RETRYING` and trigger backoff.
10. **Redis Outage Resilience & Outbox Retention:** Verifies outbox buffering during Redis downtime and successful recovery processing.
11. **15-Second Idempotency Protection:** Verifies duplicate submission deduplication.
12. **Final Exam Submit Coordination:** Verifies in-flight draining and authoritative combined grading (MCQ 2/2 + Code 5/5 = 7/7 marks, 100% scholarship).
13. **Admin Observability:** Verifies `/queue-metrics` and candidate submission inspection.
14. **Worker Graceful Shutdown:** Verifies clean resource release on `SIGTERM`.

### Full Test Suite Run (`npm test`)

```text
> aspire-test-platform@1.0.0 test
> node test/selftest.js && node test/validation-and-errors.test.js && node test/security-hardening.test.js && node test/auth-rbac.test.js && node test/database-hardening.test.js && node test/question-bank.test.js && node test/exam-builder.test.js && node test/exam-versioning.test.js && node test/coding-execution.test.js && node test/async-code-execution.test.js
```

| Test Suite | File | Status |
| :--- | :--- | :--- |
| **Suite 1: Platform Self-Test** | `test/selftest.js` | **PASS (100% Green)** |
| **Suite 2: Centralized Validation & Errors** | `test/validation-and-errors.test.js` | **PASS (100% Green)** |
| **Suite 3: Security Hardening** | `test/security-hardening.test.js` | **PASS (100% Green)** |
| **Suite 4: Auth, RBAC & Multi-Tenancy** | `test/auth-rbac.test.js` | **PASS (100% Green)** |
| **Suite 5: Database Hardening & Migrations** | `test/database-hardening.test.js` | **PASS (100% Green)** |
| **Suite 6: Question Bank 2.0** | `test/question-bank.test.js` | **PASS (100% Green)** |
| **Suite 7: Exam Builder** | `test/exam-builder.test.js` | **PASS (100% Green)** |
| **Suite 8: Exam Versioning & Snapshots** | `test/exam-versioning.test.js` | **PASS (100% Green)** |
| **Suite 9: OnlineCompiler Coding Engine** | `test/coding-execution.test.js` | **PASS (100% Green)** |
| **Suite 10: Asynchronous Code Execution** | `test/async-code-execution.test.js` | **PASS (100% Green)** |

**Overall Result:** **All 10 test suites passed cleanly with exit code 0.**

---

## 15. Production Deployment, Runbook, & Environment Configuration

### Required Environment Variables

```env
# Database
DATABASE_PATH=data/aspire.db

# Redis Connection (BullMQ Queue)
REDIS_URL=redis://127.0.0.1:6379

# Queue Configuration
CODE_EXECUTION_QUEUE_NAME=aspire-code-execution
CODE_EXECUTION_WORKER_CONCURRENCY=5
CODE_EXECUTION_JOB_ATTEMPTS=3
CODE_EXECUTION_JOB_TIMEOUT_MS=120000

# OnlineCompiler.io Execution Layer
ONLINECOMPILER_API_KEY=your_production_api_key_here
ONLINECOMPILER_BASE_URL=https://api.onlinecompiler.io
ONLINECOMPILER_DEFAULT_TIMEOUT_MS=10000
```

### Production Process Management (systemd / PM2 / Docker)
In production, run the API server and worker processes under process supervisors:

```bash
# 1. Start Express Web API
node backend/server.js

# 2. Start Dedicated Code Execution Worker Process
npm run worker:code

# 3. Optional: Start Background Outbox Poller Daemon
npm run worker:outbox
```

---

## Conclusion & Verification Sign-off

The Day 10 milestone has successfully transformed Aspire's coding execution into a **scalable, asynchronous, queue-backed distributed system**. 

- Candidate experience is immediate and responsive (HTTP 202 + status badges).
- Assessment records and marks remain 100% authoritative in SQLite.
- Redis outages and network partitions are gracefully absorbed by the Transactional Outbox.
- Private test cases remain strictly isolated and protected.
- The entire regression baseline across all 10 test suites is completely green.

