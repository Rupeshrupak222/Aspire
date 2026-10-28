# Aspire Exam / Test Builder 2.0 Specification & Architecture

## 1. Overview
The **Exam Builder 2.0** transforms Aspire from a single hardcoded scholarship evaluation into a multi-tenant, enterprise assessment engine capable of authoring, configuring, validating, publishing, and versioning multiple independent exams simultaneously.

Each exam defines its own:
- Metadata (`name`, `code`, `description`)
- Timing & Attempts (`duration_minutes`, `max_attempts`)
- Structure (`exam_sections` with ordering)
- Question Selection (`MANUAL`, `POOL_RANDOM`, or `RULE_BASED` linked to the Day 6 Question Bank)
- Scoring & Certification (`total_marks`, `passing_score`)
- Scholarship Slabs (custom percentage and fee discount tiers)
- Immutable Snapshot Versioning (guaranteeing historical assessment reproducibility)

---

## 2. Data Model

### `exams` Table
| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | NO | AUTOINCREMENT | Unique identifier |
| `organization_id` | INTEGER | YES | NULL | Tenant scope (NULL = Platform / Global) |
| `name` | TEXT | NO | - | Human-readable title (e.g., `Aspire Scholarship Test 2026`) |
| `code` | TEXT | NO | - | Unique alphanumeric identifier (e.g., `ASPIRE-2026`) |
| `description` | TEXT | YES | NULL | Administrative or candidate-facing description |
| `status` | TEXT | NO | `'DRAFT'` | State: `'DRAFT'`, `'REVIEW'`, `'PUBLISHED'`, `'ARCHIVED'` |
| `version` | INTEGER | NO | 1 | Revision number |
| `duration_minutes` | INTEGER | NO | 90 | Allowed attempt duration in minutes |
| `total_marks` | REAL | NO | 0 | Server-calculated total marks across all sections |
| `passing_score` | REAL | NO | 40 | Passing percentage or marks threshold |
| `max_attempts` | INTEGER | NO | 1 | Maximum attempts permitted per student |
| `shuffle_questions`| INTEGER | NO | 1 | 1 = randomize question presentation order |
| `shuffle_options`  | INTEGER | NO | 1 | 1 = randomize MCQ option order |
| `is_default` | INTEGER | NO | 0 | 1 = default exam for registrations without explicit exam_code |
| `created_by` | INTEGER | YES | NULL | Server-assigned creator user ID |
| `updated_by` | INTEGER | YES | NULL | Server-assigned last updater user ID |
| `published_at` | TEXT | YES | NULL | Timestamp of publication |
| `created_at` | TEXT | NO | datetime('now') | Record creation timestamp |
| `updated_at` | TEXT | NO | datetime('now') | Record last update timestamp |

### `exam_sections` Table
| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | NO | AUTOINCREMENT | Section ID |
| `exam_id` | INTEGER | NO | - | Foreign key to `exams(id)` ON DELETE CASCADE |
| `name` | TEXT | NO | - | Section title (e.g. `Aptitude`, `Technical`, `Coding`) |
| `description` | TEXT | YES | NULL | Section guidance or instructions |
| `display_order` | INTEGER | NO | 0 | Sequence order within exam |
| `question_selection_mode` | TEXT | NO | `'RULE_BASED'` | `'MANUAL'`, `'POOL_RANDOM'`, or `'RULE_BASED'` |
| `total_questions` | INTEGER | NO | 0 | Number of questions in this section |
| `total_marks` | REAL | NO | 0 | Total marks allocated to this section |

### `exam_section_questions` Table (Manual Selection)
| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | NO | Link record ID |
| `section_id` | INTEGER | NO | Foreign key to `exam_sections(id)` |
| `question_id` | INTEGER | NO | Foreign key to `questions(id)` |
| `display_order` | INTEGER | NO | Question order within section |
| **Constraint** | UNIQUE(`section_id`, `question_id`) | Prevents duplicate questions in same section |

### `exam_question_rules` Table (Rule-Based / Pool Random Selection)
| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | NO | Rule ID |
| `section_id` | INTEGER | NO | Foreign key to `exam_sections(id)` |
| `topic` | TEXT | YES | Filter by topic (e.g. `React`, `Data Structures`) |
| `skill` | TEXT | YES | Filter by skill (e.g. `Hooks`, `Arrays`) |
| `difficulty` | TEXT | YES | Filter by difficulty (`EASY`, `MEDIUM`, `HARD`) |
| `type` | TEXT | YES | Filter by type (`MCQ`, `CODING`) |
| `category` | TEXT | YES | Filter by legacy track (`aptitude`, `technical`, `coding`) |
| `count` | INTEGER | NO | Number of questions to randomly sample from pool |
| `marks_per_question` | REAL | YES | Marks assigned to each sampled question |

### `exam_scholarship_slabs` Table
| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | NO | Slab ID |
| `exam_id` | INTEGER | NO | Foreign key to `exams(id)` |
| `min_score_pct` | REAL | NO | Minimum percentage threshold (inclusive) |
| `max_score_pct` | REAL | NO | Maximum percentage threshold (inclusive) |
| `discount_pct` | REAL | NO | Fee waiver / scholarship reward percentage (0 - 100) |
| `tier_name` | TEXT | YES | Display label (e.g., `Tier 1 (100% Scholarship)`) |

---

## 3. Exam Lifecycle State Machine

```text
       ┌───────────┐
       │   DRAFT   │ ◄────────────────┐
       └─────┬─────┘                  │
             │                        │
             ▼                        │
       ┌───────────┐                  │
       │  REVIEW   │                  │
       └─────┬─────┘                  │
             │                        │
             ▼                        │
       ┌───────────┐                  │
       │ PUBLISHED │                  │
       └─────┬─────┘                  │
             │                        │
             ▼                        │
       ┌───────────┐                  │
       │ ARCHIVED  ├──────────────────┘
       └───────────┘
```

### State Machine Transition Rules
1. `DRAFT -> REVIEW`: Authorized author prepares exam for review.
2. `REVIEW -> DRAFT`: Reviewer requests revisions.
3. `REVIEW -> PUBLISHED` or `DRAFT -> PUBLISHED`: Enforces pre-publish validation.
4. `PUBLISHED -> ARCHIVED`: Retires exam from candidate registration while preserving completed attempts.
5. `ARCHIVED -> DRAFT`: Allows restoring an archived exam for editing.

### Publish Validation Checklist (`validateExamForPublish`)
An exam cannot transition to `PUBLISHED` unless:
- `name` is at least 3 characters.
- `code` is unique and at least 3 characters.
- `duration_minutes` > 0.
- `max_attempts` >= 1.
- At least one section exists.
- In `MANUAL` sections: all attached questions exist, belong to accessible tenant, and have status `PUBLISHED`.
- In `RULE_BASED` sections: every rule's required count can be satisfied by current published question bank pools.
- Total question count > 0.
- Total marks > 0.
- `passing_score` is valid and does not exceed total marks.
- At least one non-overlapping scholarship slab is defined.

---

## 4. Question Selection & Sampling Modes

1. **MANUAL Selection**:
   Administrators pick specific questions from the Question Bank. The system prevents duplicates via `UNIQUE(section_id, question_id)`.
2. **POOL_RANDOM / RULE_BASED Selection**:
   Administrators define structured sampling rules. When a candidate begins an attempt, the engine queries the Question Bank matching the criteria and randomly samples the configured count using Fisher-Yates shuffle.

---

## 5. Frozen Snapshot Architecture (Historical Assessment Integrity)

To guarantee that past candidate attempts, scores, and certificates are 100% reproducible:

```text
Candidate Registers for Exam
            │
            ▼
generateExamAttemptQuestions(examId)
            │
    ┌───────┴───────┐
    ▼               ▼
Exam Snapshot   Question Snapshot
(name, slabs,   (text, options, marks,
 duration)       language, test cases)
    │               │
    └───────┬───────┘
            ▼
Stored in attempts record:
  - exam_snapshot_json
  - questions_snapshot_json
            │
            ▼
Assessment Delivery & Grading
  (Always evaluated against frozen snapshots)
```

- When an attempt begins, the attempt freezes the exact text, options, marks, starter code, and test cases into `questions_snapshot_json`.
- The exam title, duration, passing score, and scholarship slabs are frozen into `exam_snapshot_json`.
- **Candidate Privacy**: Client responses (`GET /api/attempt/:token`) sanitize questions by stripping `correct_index` and hidden test cases.
- **Grading Integrity**: Even if an administrator edits or archives a question in the Question Bank tomorrow, existing attempts grade against their frozen snapshot.

---

## 6. Multi-Tenant Isolation & RBAC

### Tenant Scoping
- All exam queries automatically scope: `WHERE (e.organization_id = ? OR e.organization_id IS NULL)`.
- Users from Organization A cannot view, update, publish, or archive Organization B's exams (`403 FORBIDDEN`).
- Super Admin has full cross-tenant visibility.

### RBAC Permission Matrix
| Role | View Exams | Create Exam | Update / Edit | Publish | Archive | Delete Section |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **SUPER_ADMIN** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ORG_ADMIN** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **EXAM_MANAGER** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **EVALUATOR** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **VIEWER** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 7. API Reference

| Method | Endpoint | Description | Permission |
|---|---|---|---|
| `GET` | `/api/admin/exams` | List exams (paginated, filtered, search) | `exams.read` |
| `POST` | `/api/admin/exams` | Create exam in DRAFT status | `exams.create` |
| `GET` | `/api/admin/exams/:id` | Get single exam details | `exams.read` |
| `PUT` | `/api/admin/exams/:id` | Update exam (optimistic concurrency enabled) | `exams.update` |
| `GET` | `/api/admin/exams/:id/preview` | Admin preview & publish validation checklist | `exams.read` |
| `POST` | `/api/admin/exams/:id/publish` | Publish exam atomically | `exams.publish` |
| `POST` | `/api/admin/exams/:id/archive` | Archive exam | `exams.update` |
| `POST` | `/api/admin/exams/:id/version` | Clone into new DRAFT v(n+1) version | `exams.create` |
| `POST` | `/api/admin/exams/:id/sections` | Add section to exam | `exams.update` |
| `PUT` | `/api/admin/exams/:id/sections/:sectionId` | Update section details | `exams.update` |
| `DELETE` | `/api/admin/exams/:id/sections/:sectionId` | Delete section | `exams.update` |
| `PUT` | `/api/admin/exams/:id/sections-reorder` | Reorder sections (Sortable persistence) | `exams.update` |
| `POST` | `/api/admin/exams/:id/sections/:sectionId/questions` | Attach question (Manual mode) | `exams.update` |
| `DELETE` | `/api/admin/exams/:id/sections/:sectionId/questions/:questionId` | Detach question | `exams.update` |
| `POST` | `/api/admin/exams/:id/sections/:sectionId/rules` | Add selection rule | `exams.update` |
| `DELETE` | `/api/admin/exams/:id/sections/:sectionId/rules/:ruleId` | Delete selection rule | `exams.update` |
| `PUT` | `/api/admin/exams/:id/scholarship-slabs` | Configure scholarship slabs | `exams.update` |

---

## 8. Candidate Integration (`routes/public.js`)

- `POST /api/register`:
  - Accepts optional `exam_code` or `exam_id`.
  - Resolves target exam (defaults to active flagship exam `ASPIRE-SCHOLARSHIP-2026` if omitted).
  - Enforces `max_attempts` limit per student and exam.
  - Samples questions and freezes snapshots into `attempts`.
  - Calculates expiration from `targetExam.duration_minutes`.
- `GET /api/attempt/:token`:
  - Returns sanitized questions from `questions_snapshot_json`.
  - Sets title from `exam_snapshot_json`.
- `POST /api/attempt/:token/submit`:
  - Grades MCQs and coding challenges against the frozen question snapshots.
  - Computes percentage and matches against the exam's custom scholarship slabs.

---

## 9. Audit Logging
Every mutation records a structured audit event in `audit_logs`:
- `exam_created`
- `exam_updated`
- `exam_section_created`
- `exam_section_updated`
- `exam_section_deleted`
- `exam_sections_reordered`
- `exam_question_added`
- `exam_question_removed`
- `exam_rule_added`
- `exam_rule_removed`
- `exam_scholarship_updated`
- `exam_published`
- `exam_archived`
- `exam_version_created`
