# OnlineCompiler.io Production Coding Engine Integration

## 1. Overview & Architecture

Aspire by Adyapan utilizes a modular, multi-tenant code execution engine to run and evaluate candidate code submissions in real-time. For Day 9, the coding evaluation layer was migrated to a high-reliability **OnlineCompiler.io** execution pipeline behind a resilient provider abstraction.

The complete coding assessment workflow operates as follows:

```text
Candidate Browser (Interactive Editor)
   │
   ├─► POST /api/attempt/:token/code-run (Interactive feedback: Sample test cases only)
   │
   └─► POST /api/attempt/:token/code-submit (Question submission: Full test suite evaluation)
            │
            ▼
      Rate Limiter (25 requests/min per IP)
            │
            ▼
   Token & Candidate Authorization
      - Attempt active, valid, unexpired, unsubmitted
      - Question belongs to frozen attempt snapshot (questions_snapshot_json)
      - HMAC integrity verification
            │
            ▼
   Payload & Language Whitelist Validation
      - Source code non-empty, string, ≤ 100 KB
      - Language resolved to canonical identifier
            │
            ▼
   CodingExecutionService (Provider Abstraction)
            │
            ├─► MockProvider (in automated test suites)
            ├─► OnlineCompilerProvider (Primary cloud execution)
            └─► Judge0Provider (Secondary / legacy fallback)
            │
            ▼
   OnlineCompiler.io Synchronous API (`POST /api/run-code-sync/`)
            │
            ▼
   Response Normalization & Sanitization
      - Status normalized: ACCEPTED, WRONG_ANSWER, COMPILATION_ERROR, RUNTIME_ERROR, TIME_LIMIT_EXCEEDED, MEMORY_LIMIT_EXCEEDED
      - Error output scrubbed (file paths, secrets, API keys stripped)
      - Large output truncated at 100 KB boundary
            │
            ▼
   Server-Side Evaluation & Comparison
      - Normalized newline policy (CRLF vs LF, line-end trims)
      - Strict privacy: Hidden test inputs/outputs NEVER leaked to client
            │
            ▼
   Transactional Persistence
      - Insert into `coding_submissions` table (UUID, hash, time, memory, score)
      - Update attempt `code_answers_json`
      - Record structured Pino audit log
            │
            ▼
   Final Exam Submission (`POST /api/attempt/:token/submit`)
      - Combined grading: MCQ + Coding marks evaluated against frozen snapshot
      - Deterministic scholarship tier assignment & certificate issuance
```

---

## 2. Execution Provider Abstraction

All code execution is encapsulated behind a unified `ExecutionProvider` interface. Express routes and grading logic never invoke provider-specific APIs directly.

```text
               ┌───────────────────────────────┐
               │    ExecutionService           │
               └───────────────┬───────────────┘
                               │
               ┌───────────────┴───────────────┐
               │       ExecutionProvider       │
               │   (base interface & contract) │
               └───────────────┬───────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  OnlineCompiler  │  │      Judge0      │  │   MockProvider   │
│     Provider     │  │     Provider     │  │   (Unit Tests)   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Provider Contract: `executeCode(options)`

Every provider must implement:

```javascript
async executeCode({
  language,       // canonical language string ('python', 'javascript', 'cpp', 'java')
  sourceCode,     // candidate source code (string, <= 100KB)
  stdin,          // standard input (string, <= 100KB)
  timeoutMs,      // execution timeout in milliseconds (default: 10000ms)
  signal          // optional AbortSignal for early cancellation
})
```

And return a normalized execution result:

```json
{
  "success": true,
  "status": "ACCEPTED",
  "stdout": "...",
  "stderr": "",
  "compileOutput": "",
  "exitCode": 0,
  "executionTimeMs": 42,
  "memoryUsedKb": 15360,
  "providerSubmissionId": "...",
  "error": null
}
```

---

## 3. Supported Languages & Normalization

Aspire enforces a strict server-side language whitelist. Arbitrary language strings from clients are rejected with `400 UNSUPPORTED_LANGUAGE`.

| Canonical Language | Aliases / Accepted Strings | OnlineCompiler Identifier | Judge0 ID |
| :--- | :--- | :--- | :--- |
| `python` | `py`, `python3`, `py3`, `python-3.14`, `71` | `python-3.14` | `71` |
| `javascript` | `js`, `node`, `nodejs`, `nodejs-24`, `63` | `nodejs-24` | `63` |
| `cpp` | `c++`, `c-plus-plus`, `g++`, `gcc`, `g++-15`, `54` | `g++-15` | `54` |
| `java` | `openjdk`, `openjdk-25`, `62` | `openjdk-25` | `62` |

---

## 4. Output Comparison Policy

Output comparison between actual program output and expected test case output is authoritative on the server:

1. **Newline Normalization:** All `\r\n` (CRLF) sequences are converted to `\n` (LF).
2. **Trailing Whitespace on Lines:** Trailing spaces and tabs on each individual line are stripped (`.trimEnd()`).
3. **Leading / Trailing Blank Lines:** Extraneous leading or trailing newlines and whitespace on the whole string are stripped (`.trim()`).
4. **Preserved Semantics:** Case sensitivity (`"Pass"` != `"pass"`) and internal multi-space formatting are strictly preserved.

---

## 5. Public vs Private Test Case Security

To prevent candidate cheating and solution reverse-engineering:

- **Public / Sample Test Cases:**
  - Sent to candidate client in `q.sample_test_cases` on attempt start.
  - Executed via `POST /api/attempt/:token/code-run`.
  - Client receives passed status, input, expected output, and candidate actual output for interactive debugging.
- **Private / Hidden Test Cases:**
  - Stored strictly in the server-side frozen snapshot (`questions_snapshot_json`).
  - NEVER sent over HTTP to candidate client.
  - Executed during `POST /api/attempt/:token/code-submit` and final `POST /api/attempt/:token/submit`.
  - Client receives test pass count (`passed: 2, total: 3`) and overall status, but NEVER inputs or expected outputs.

---

## 6. Execution Status State Machine

All execution outcomes normalize into standardized Aspire status codes:

- `QUEUED`: Submission accepted and waiting in queue.
- `RUNNING`: Code actively running on execution worker.
- `ACCEPTED`: Code executed successfully and matched expected output on all tests.
- `WRONG_ANSWER`: Code exited cleanly but produced output differing from expected.
- `COMPILATION_ERROR`: Code failed to compile (syntax error, missing header, build failure).
- `RUNTIME_ERROR`: Process crashed or uncaught exception thrown during execution.
- `TIME_LIMIT_EXCEEDED`: Process exceeded runtime timeout (infinite loop safeguard).
- `MEMORY_LIMIT_EXCEEDED`: Process exceeded memory ceiling.
- `EMPTY_SUBMISSION`: Empty or whitespace-only code submission.
- `SYSTEM_ERROR`: Internal infrastructure failure.
- `PROVIDER_ERROR`: External cloud provider network or service error.

---

## 7. Database Persistence (`coding_submissions`)

Migration `007_coding_execution` created the dedicated `coding_submissions` table:

```sql
CREATE TABLE IF NOT EXISTS coding_submissions (
  id TEXT PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  language TEXT NOT NULL,
  submission_status TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_submission_id TEXT,
  source_hash TEXT NOT NULL,
  source_code TEXT NOT NULL,
  test_cases_passed INTEGER DEFAULT 0,
  test_cases_total INTEGER DEFAULT 0,
  score REAL DEFAULT 0,
  execution_time_ms INTEGER,
  memory_used_kb INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

Indexes are maintained on `attempt_id`, `question_id`, `organization_id`, and `submission_status` for sub-millisecond admin lookups.

---

## 8. Environment Configuration & Secret Rules

### Critical Security Rule

The OnlineCompiler API key must **NEVER** be committed to Git, hardcoded in JavaScript, or exposed to the client.

```env
# Primary OnlineCompiler Engine Configuration
ONLINECOMPILER_API_KEY=your_actual_key_here
ONLINECOMPILER_ENDPOINT=https://api.onlinecompiler.io
ONLINECOMPILER_REQUIRED=false
ONLINECOMPILER_LIVE_TEST=false
```

- When `ONLINECOMPILER_REQUIRED=true`, the server verifies the key on startup and safely halts if missing.
- Pino logger redaction automatically masks `ONLINECOMPILER_API_KEY`, `sourceCode`, and `test_cases` from application logs.
- Status endpoints (`GET /api/admin/code-execution/status` and `GET /health`) expose only `{ provider: 'onlinecompiler', configured: true }`, never leaking credentials.

---

## 9. Observability & Admin Operations

### Admin Endpoints

1. **Engine Health & Status:**
   - `GET /api/admin/code-execution/status`
   - Requires `SUPER_ADMIN` or `ORG_ADMIN` role (`PERMISSIONS.SETTINGS_READ`).
   - Reports provider status, active mode, and supported languages.

2. **Candidate Submissions Inspection:**
   - `GET /api/admin/attempts/:id/coding-submissions`
   - Requires `PERMISSIONS.RESULTS_READ`.
   - Returns full chronological submission log for that attempt, including source code, execution times, scores, and verdicts.
   - Enforces multi-tenant isolation: non-super-admins cannot view submissions from another organization.

---

## 10. Troubleshooting & Common Scenarios

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| `CODE_EXECUTION_UNAVAILABLE` (503) | OnlineCompiler API outage or network connectivity failure | The provider automatically retries 5xx responses with exponential backoff. If persistent, check API status and ensure `ONLINECOMPILER_ENDPOINT` is reachable. Candidate code is preserved locally. |
| `UNSUPPORTED_LANGUAGE` (400) | Candidate submitted an unapproved language alias | Ensure frontend passes canonical names (`python`, `javascript`, `cpp`, `java`). Check `constants.js` aliases. |
| `SOURCE_CODE_TOO_LARGE` (413) | Code submission exceeds 100 KB | Reject code before calling external API to prevent memory exhaustion and DoS. Advise candidate to remove redundant data or imports. |
| `RATE_LIMITED` (429) | Candidate clicked "Run Code" or "Submit Solution" > 25 times/min | Wait 60 seconds. Rate limiter prevents spamming external compiler resources. |

