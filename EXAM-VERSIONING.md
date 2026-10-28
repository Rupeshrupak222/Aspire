# ASPIRE — EXAM VERSIONING ARCHITECTURE & LIFECYCLE SPECIFICATION

## 1. Overview & Core Invariant

Aspire guarantees absolute historical reproducibility for all candidate assessments. Once a candidate registers and creates an attempt, the assessment execution is bound to an immutable execution record:

$$\text{Attempt} = \langle \text{Exam Version}, \text{Exam Snapshot}, \text{Question Snapshot}, \text{Shuffle Map}, \text{Candidate Identity} \rangle$$

Subsequent edits to the live Question Bank, modifications to future exam versions, alterations to duration, changes to passing scores, or updates to scholarship slabs **never mutate or contaminate an active or historical attempt**.

---

## 2. Exam Lifecycle State Machine

An exam moves through six explicit lifecycle states with server-authoritative transition guards:

```text
 ┌─────────┐         ┌──────────┐         ┌───────────┐
 │  DRAFT  │ ◄─────► │  REVIEW  │ ──────► │ PUBLISHED │
 └─────────┘         └──────────┘         └───────────┘
                                                │
                                                ▼
 ┌──────────┐        ┌──────────┐          ┌─────────┐
 │ ARCHIVED │ ◄───── │  CLOSED  │ ◄──────► │  LIVE   │
 └──────────┘        └──────────┘          └─────────┘
```

### State Definitions

| State | Modifiable? | Accepts Candidates? | Operational Meaning |
| :--- | :---: | :---: | :--- |
| **`DRAFT`** | Yes | No | Work in progress. Sections, rules, questions, and slabs can be modified freely. |
| **`REVIEW`** | Yes | No | Internal review stage. Exam is finalized and ready for QA / sign-off. |
| **`PUBLISHED`**| No | No (Directly) | Approved and locked. Blueprint is cryptographically finalized. |
| **`LIVE`** | No | Yes | Actively accepting new candidate registrations and attempts. |
| **`CLOSED`** | No | No (New attempts) | Registration is blocked (409 `EXAM_CLOSED`). Ongoing attempts can finish. Historical attempts remain fully accessible. Can be reopened to `LIVE`. |
| **`ARCHIVED`** | No | No | Retired historical exam. Preserved for audits and reporting. Terminal state. |

### Allowed Transitions

```javascript
const ALLOWED_TRANSITIONS = {
  DRAFT: ['REVIEW'],
  REVIEW: ['DRAFT', 'PUBLISHED'],
  PUBLISHED: ['LIVE'],
  LIVE: ['CLOSED'],
  CLOSED: ['LIVE', 'ARCHIVED'],
  ARCHIVED: []
};
```

Any attempt to execute an invalid transition (e.g., `PUBLISHED` $\to$ `DRAFT`) is rejected with HTTP 409 Conflict:
```json
{
  "success": false,
  "error": "INVALID_EXAM_STATUS_TRANSITION",
  "code": "INVALID_EXAM_STATUS_TRANSITION",
  "message": "Cannot transition exam status from \"PUBLISHED\" to \"DRAFT\"."
}
```

---

## 3. Strict Version Immutability (`EXAM_VERSION_IMMUTABLE`)

Once an exam reaches `PUBLISHED`, `LIVE`, or `CLOSED`, its assessment-critical blueprint is frozen:

- Exam metadata (name, duration, passing score, shuffle flags)
- Sections (add, update, delete, reorder)
- Question assignments (manual selection)
- Dynamic rule quotas (rule count, category, type, marks)
- Scholarship slabs (score ranges and discount percentages)

Any administrative mutation attempt triggers `assertExamMutable(exam)` which throws `EXAM_VERSION_IMMUTABLE` (HTTP 409):
```json
{
  "success": false,
  "error": "EXAM_VERSION_IMMUTABLE",
  "code": "EXAM_VERSION_IMMUTABLE",
  "message": "Published exam versions cannot be modified (current status: LIVE). Create a new draft version to make changes."
}
```

---

## 4. Version Lineage & Forking

When an exam requires modification after being published:

1. Admin calls `POST /api/admin/exams/:id/version`.
2. The system deep-copies the existing exam configuration:
   - Increments version number (`version = base.version + 1`).
   - Sets status to `DRAFT`.
   - Records `parent_exam_id` pointing to the root/parent exam.
   - Deep-clones all sections, manual question links, rule quotas, and scholarship slabs.
3. The previous published version remains intact, immutable, and live for current test-takers.
4. Admins modify and review the new version in `DRAFT`.
5. When ready, the new version is transitioned `REVIEW` $\to$ `PUBLISHED` $\to$ `LIVE`.

### Lineage Querying
Administrators can inspect full version lineage via `GET /api/admin/exams/:id/versions`, scoped strictly by tenant/organization boundaries.

---

## 5. Candidate Version Resolution Policy

When a candidate registers (`POST /api/register`):
1. The exam is resolved by `exam_code` or `exam_id`.
2. If multiple versions exist for an exam code, the resolver prioritizes:
   $$\text{LIVE} > \text{PUBLISHED} > \text{CLOSED} > \text{REVIEW} > \text{DRAFT}$$
   ordered by `version DESC`.
3. If the resolved exam is `CLOSED`, the candidate is rejected with HTTP 409 (`EXAM_CLOSED`).
4. If the resolved exam is not `LIVE` or `PUBLISHED`, registration is rejected with HTTP 409 (`EXAM_NOT_LIVE`).
5. Upon successful registration, the attempt is permanently bound to `exam_id` and `exam_version`. Even if a v2 or v3 is subsequently released and made LIVE, this candidate's attempt continues executing against their frozen v1 snapshot.
