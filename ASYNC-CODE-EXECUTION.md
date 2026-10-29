# Asynchronous Code Execution Architecture

## Aspire by Adyapan — Distributed Coding Engine Integration

---

## 1. Architectural Overview

Aspire uses an **asynchronous, queue-backed, distributed worker architecture** for coding question evaluations during scholarship assessments.

Instead of blocking the candidate's HTTP connection while executing code across external providers (such as OnlineCompiler.io) against multi-test suites, the system acknowledges valid submissions immediately (**HTTP 202 Accepted**) and dispatches evaluation jobs to a durable pipeline backed by **SQLite** and **Redis + BullMQ**.

```text
Candidate Frontend
        │
        ▼
POST /api/attempt/:token/code-submit
        │
        ├── 1. Authentication & Attempt Active Check
        ├── 2. Snapshot HMAC Integrity Check
        ├── 3. 15-Second Idempotency Deduplication Check
        │
        ▼
   SQLite Transaction (Authoritative Store)
   ├── Claim Submission (`coding_submissions` -> status: PENDING, lifecycle: QUEUED)
   └── Create Outbox Event (`outbox_events` -> status: PENDING)
        │
        ├── Immediate HTTP 202 Acknowledgment: { submissionId, status: "QUEUED", statusUrl, retryAfterMs: 1500 }
        │
        ▼
Outbox Dispatcher ────────► Redis + BullMQ Queue (`aspire-code-execution`)
(Dual-Write Gap Resolver)             │
                                       ▼
                             Dedicated Worker Process
                             (`code-execution.worker.js`)
                                       │
                                       ▼
                             Worker Processor
                             (`code-execution.processor.js`)
                                       │
                                       ├── Load submission & frozen attempt snapshot
                                       ├── Verify snapshot HMAC integrity
                                       ├── Transition lifecycle: RUNNING
                                       ├── Call ExecutionService (OnlineCompiler.io)
                                       ├── Evaluate public & private test cases
                                       ├── Calculate marks & score
                                       │
                                       ▼
                             SQLite Authoritative Write
                             ├── Update `coding_submissions` (status: COMPLETED, verdict, score, times)
                             ├── Update `attempts.code_answers_json`
                             └── Record Audit Log
                                       ▲
                                       │
Candidate Frontend ────────────────────┘
GET /api/attempt/:token/code-submissions/:submissionId (Polling with Backoff)
```

---

## 2. Key Architecture Principles

### A. Authoritative Source of Truth
- **SQLite with WAL Mode** is the **sole authoritative persistent record of truth** for all assessment data, attempts, scores, and coding submissions.
- **Redis and BullMQ** act exclusively as a **fast, ephemeral job transport and distribution mechanism**. Assessment marks and attempts are never stored solely in Redis.

### B. Dual-Write Gap Resolution (Transactional Outbox)
Network partitions or Redis downtime must never cause candidate submissions to be lost or orphaned:
1. Submissions are committed to `coding_submissions` and `outbox_events` within the **same SQLite atomic transaction**.
2. If Redis is available, `outboxDispatcher.dispatchImmediate(submissionId)` enqueues the job immediately to BullMQ and marks the outbox event as `DISPATCHED`.
3. If Redis is unavailable or fails to respond, the submission is still safely recorded in SQLite. The outbox event remains `PENDING` with exponential backoff on `available_at`.
4. When Redis recovers or when `outboxDispatcher.drainAttemptSubmissions()` is triggered during final exam submit, pending outbox items are processed safely. No submission is ever dropped.

### C. Zero-Leakage Hidden Test Case Security
- **Interactive "Run Code"** (`POST /api/attempt/:token/code-run`): Evaluates against **sample/public test cases only** and returns actual vs expected outputs for IDE feedback.
- **Final "Submit Solution"** (`POST /api/attempt/:token/code-submit`): Evaluates against the **entire test suite**, including private hidden test cases.
- **Privacy Enforcement**: Private test inputs, expected outputs, and actual outputs are scrubbed at the service level and are **never persisted to `coding_submissions` or returned in polling responses**. The candidate only receives aggregated counts (`testsPassed`, `testsTotal`) and final scores.

---

## 3. Lifecycle Status vs Assessment Verdict

Aspire cleanly separates the **queue lifecycle state** of a submission from the **assessment verdict**:

| Field | Enum Values | Description |
| :--- | :--- | :--- |
| `lifecycle_status` | `QUEUED` | Submission accepted and waiting in queue or outbox |
| | `RUNNING` | Worker process is currently executing test cases |
| | `RETRYING` | Transient failure encountered; backoff retry scheduled |
| | `COMPLETED` | Execution finished and terminal evaluation recorded |
| | `FAILED` | Fatal non-retryable failure encountered |
| `submission_status` | `PENDING` | Default status prior to execution completion |
| | `ACCEPTED` | All public and private test cases passed |
| | `WRONG_ANSWER` | Code executed but output did not match expected |
| | `COMPILATION_ERROR`| Code failed compilation or syntax validation |
| | `RUNTIME_ERROR` | Unhandled exception or non-zero exit code |
| | `TIME_LIMIT_EXCEEDED`| Execution exceeded timeout boundary |
| | `MEMORY_LIMIT_EXCEEDED`| Execution exceeded memory limit |
| | `EMPTY_SUBMISSION` | Blank or whitespace-only code submitted |
| | `PROVIDER_ERROR` | External compiler service unavailable |

---

## 4. API Endpoints

### 1. Submit Code (`POST /api/attempt/:token/code-submit`)

**Headers:**
`Content-Type: application/json`

**Request Body:**
```json
{
  "questionId": 42,
  "language": "python",
  "sourceCode": "import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)"
}
```

**Response (HTTP 202 Accepted):**
```json
{
  "success": true,
  "submissionId": "csub_785d2928bb640027d5c56145",
  "status": "QUEUED",
  "statusUrl": "/api/attempt/93ffd19c56398fd10fe65224b8a97abb47fe8f0b127ad1ba/code-submissions/csub_785d2928bb640027d5c56145",
  "retryAfterMs": 1500
}
```

### 2. Poll Status (`GET /api/attempt/:token/code-submissions/:submissionId`)

**In-Progress Response (HTTP 200 OK):**
```json
{
  "success": true,
  "submissionId": "csub_785d2928bb640027d5c56145",
  "status": "RUNNING",
  "verdict": "PENDING",
  "retryAfterMs": 1500
}
```

**Terminal Completed Response (HTTP 200 OK):**
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

### 3. Admin Queue Metrics (`GET /api/admin/code-execution/queue-metrics`)

**Response (HTTP 200 OK):**
```json
{
  "success": true,
  "data": {
    "queue": {
      "waiting": 0,
      "active": 1,
      "completed": 48,
      "failed": 0,
      "delayed": 0
    },
    "outbox": {
      "PENDING": 0,
      "DISPATCHED": 49,
      "FAILED": 0
    },
    "lifecycle": {
      "QUEUED": 0,
      "RUNNING": 1,
      "RETRYING": 0,
      "COMPLETED": 48,
      "FAILED": 0
    },
    "timestamp": "2026-10-29T18:25:36.567Z"
  }
}
```

---

## 5. Error-Aware Retries & Recovery Policy

Aspire strictly differentiates **transient infrastructure errors** from **deterministic candidate code failures**:

| Failure Category | Examples | Retry Action | Final Status |
| :--- | :--- | :--- | :--- |
| **Deterministic Code Verdict** | Wrong Answer, Syntax Error, Runtime Exception, Memory Limit, Time Limit | **NO RETRY** (Immediate completion) | `lifecycle_status = 'COMPLETED'`<br>`submission_status = VERDICT` |
| **Transient Provider Outage** | OnlineCompiler.io 503 / 502 / 504, Provider Timeout, Network Socket Refusal | **RETRY** with exponential backoff (BullMQ backoff delay: 1s, 2s, 4s, up to 3 attempts) | `lifecycle_status = 'RETRYING'`<br>Then `COMPLETED` on recovery or `FAILED` |
| **Tampered Snapshot** | HMAC mismatch detected on attempt snapshot | **NO RETRY** (Security boundary rejection) | `lifecycle_status = 'FAILED'`<br>`submission_status = 'SYSTEM_ERROR'` |

---

## 6. Exam Submit Coordination

When a candidate finishes their assessment and triggers **POST /api/attempt/:token/submit**:
1. Aspire checks for in-flight coding jobs for the attempt:
   ```sql
   SELECT COUNT(*) as count FROM coding_submissions
   WHERE attempt_id = ? AND lifecycle_status IN ('QUEUED', 'RUNNING', 'RETRYING')
   ```
2. If any submissions are still queued or running, the API initiates `outboxDispatcher.drainAttemptSubmissions(attemptId, 8000)`, executing pending jobs and waiting up to 8 seconds for all test cases to finish evaluation.
3. The assessment calculation retrieves the highest completed score per question from `coding_submissions`:
   ```sql
   SELECT * FROM coding_submissions
   WHERE attempt_id = ? AND question_id = ? AND lifecycle_status = 'COMPLETED'
   ORDER BY score DESC, completed_at DESC LIMIT 1
   ```
4. The final score, percentage, and scholarship slab discount are generated authoritatively.

---

## 7. Operational Runbook

### Environment Configuration

```env
# Redis Configuration
REDIS_URL=redis://127.0.0.1:6379

# Queue & Worker Settings
CODE_EXECUTION_QUEUE_NAME=aspire-code-execution
CODE_EXECUTION_WORKER_CONCURRENCY=5
CODE_EXECUTION_JOB_ATTEMPTS=3
CODE_EXECUTION_JOB_TIMEOUT_MS=120000

# Provider API Credential (OnlineCompiler.io)
ONLINECOMPILER_API_KEY=your_actual_key_here
```

### Running Dedicated Workers

```bash
# Start standalone BullMQ Code Execution Worker process
npm run worker:code

# Start standalone background Outbox Dispatcher loop (optional daemon)
npm run worker:outbox
```

### Running Test Suites

```bash
# Run Day 10 Asynchronous Execution Test Suite
npm run test:async

# Run complete 10-suite regression test suite
npm test
```

