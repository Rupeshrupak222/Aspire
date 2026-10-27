# Aspire Question Bank 2.0 Specification & Architecture

## 1. Overview
Question Bank 2.0 transforms Aspire's question CRUD system into an enterprise-ready, multi-tenant content management foundation for the assessment engine. It provides rich metadata, strict lifecycle management, tenant-isolated search and pagination, live duplicate detection, fuzzy matching, bounded CSV bulk import/export, and candidate-facing question previews.

Crucially, Question Bank 2.0 guarantees **historical assessment integrity**: questions used in active or past student attempts cannot be silently mutated or hard-deleted.

---

## 2. Data Model & Metadata

Questions reside in the `questions` table with the following schema:

| Column | Type | Nullable | Default | Description |
|---|---|---|---|---|
| `id` | INTEGER PRIMARY KEY | NO | AUTOINCREMENT | Unique question ID |
| `organization_id` | INTEGER | YES | NULL | Tenant scope (NULL = Platform / Global) |
| `type` | TEXT | NO | - | Question type: `'MCQ'` or `'CODING'` |
| `category` | TEXT | NO | - | Legacy assessment category (`'FULLSTACK'`, `'FRONTEND'`, `'BACKEND'`, etc.) |
| `title` | TEXT | YES | NULL | Short question title (up to 200 chars) |
| `question_text` | TEXT | NO | - | Full question stem / problem statement |
| `difficulty` | TEXT | NO | `'MEDIUM'` | Controlled difficulty: `'EASY'`, `'MEDIUM'`, `'HARD'` |
| `topic` | TEXT | YES | NULL | Broader subject (e.g. `'Data Structures'`, `'JavaScript'`) |
| `skill` | TEXT | YES | NULL | Specific evaluated skill (e.g. `'Binary Trees'`, `'Closures'`) |
| `marks` | INTEGER | NO | 5 | Positive score points |
| `time_estimate` | INTEGER | NO | 120 | Expected solve time in **seconds** |
| `tags` | TEXT (JSON) | NO | `'[]'` | JSON array of normalized lowercase strings |
| `language` | TEXT | YES | NULL | Programming language for coding questions (`'javascript'`, `'python'`, etc.) |
| `version` | INTEGER | NO | 1 | Monotonically increasing revision counter |
| `status` | TEXT | NO | `'DRAFT'` | Lifecycle state: `'DRAFT'`, `'REVIEW'`, `'PUBLISHED'`, `'ARCHIVED'` |
| `options_json` | TEXT (JSON) | YES | NULL | JSON array of strings for MCQ choices |
| `correct_index` | INTEGER | YES | NULL | 0-based index of correct MCQ option |
| `starter_code` | TEXT | YES | NULL | Starter code template for candidate editor |
| `test_cases_json` | TEXT (JSON) | YES | NULL | JSON array of `{ input, expected_output, is_hidden }` |
| `created_by` | INTEGER | YES | NULL | User ID of creator (server-assigned) |
| `updated_by` | INTEGER | YES | NULL | User ID of last modifier (server-assigned) |
| `created_at` | DATETIME | NO | CURRENT_TIMESTAMP | Creation timestamp |
| `updated_at` | DATETIME | NO | CURRENT_TIMESTAMP | Modification timestamp |

### Indexes
- `idx_questions_status` on `(status)`
- `idx_questions_difficulty` on `(difficulty)`
- `idx_questions_topic` on `(topic)`
- `idx_questions_skill` on `(skill)`
- `idx_questions_org_status` on `(organization_id, status)`
- `idx_questions_version` on `(version)`

---

## 3. Question Lifecycle State Machine

Questions move through four controlled states:

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

### Transition Rules
1. `DRAFT -> REVIEW`: Allowed for authoring review.
2. `REVIEW -> DRAFT`: Allowed if edits are requested.
3. `REVIEW -> PUBLISHED`: Requires passing `validateForPublish()`.
4. `DRAFT -> PUBLISHED`: Allowed directly if passing `validateForPublish()`.
5. `PUBLISHED -> ARCHIVED`: Retires question from new assessment draws.
6. `ARCHIVED -> DRAFT`: Restores question for revisions.
7. Any other transition is rejected with `INVALID_STATUS_TRANSITION`.

### Draft vs Publish Validation
- **DRAFT**: Allows minimal fields (`type`, `question_text`). Partial options or missing test cases are permitted during drafting.
- **PUBLISH**:
  - `question_text` must be non-empty.
  - `marks` must be > 0.
  - `time_estimate` must be > 0 seconds.
  - **MCQ**: Must have at least 2 distinct, non-empty options. `correct_index` must be valid integer within options bounds.
  - **CODING**: `language` is mandatory. Must have at least 1 test case with non-empty `input` and `expected_output`.
  - Incomplete questions attempting to publish receive `HTTP 400 VALIDATION_ERROR` with specific field issues.

---

## 4. Assessment Engine Integration & Historical Integrity

- **Public Assessment Engine (`routes/public.js`)**:
  When candidates take assessments, questions are dynamically selected strictly where:
  ```sql
  WHERE category = ? AND type = ? AND (status = 'PUBLISHED' OR status IS NULL)
  ```
  Draft, Review, and Archived questions are never served to students.
- **Historical Immutability & Safe Archive**:
  When an admin attempts to `DELETE` a question:
  ```sql
  SELECT count(*) FROM attempts WHERE question_ids_json LIKE '%"id":55%'
  ```
  If historical attempts exist, the question cannot be hard-deleted. The system automatically switches to `ARCHIVED`, ensuring historical student results, certificate links, and evaluator grading records remain 100% reproducible.
- **Version Tracking**:
  Editing a published question increments its `version` counter (`version = version + 1`).

---

## 5. Multi-Tenant Isolation & RBAC

All operations enforce multi-tenancy and RBAC server-side:

### Tenant Scoping
- Non-super admins have their query automatically restricted: `WHERE organization_id = req.user.organizationId`.
- Accessing or mutating questions from another organization returns `HTTP 403 FORBIDDEN`.
- `SUPER_ADMIN` can view across organizations or filter specifically by `organization_id`.

### Role Permission Matrix
| Operation | SUPER_ADMIN | ORG_ADMIN | EXAM_MANAGER | EVALUATOR | VIEWER |
|---|:---:|:---:|:---:|:---:|:---:|
| Read Questions | ✅ | ✅ | ✅ | ❌ | ❌ |
| Create Question | ✅ | ✅ | ✅ | ❌ | ❌ |
| Edit Question | ✅ | ✅ | ✅ | ❌ | ❌ |
| Publish Question | ✅ | ✅ | ✅ | ❌ | ❌ |
| Archive Question | ✅ | ✅ | ✅ | ❌ | ❌ |
| Import CSV | ✅ | ✅ | ✅ | ❌ | ❌ |
| Export CSV | ✅ | ✅ | ✅ | ❌ | ❌ |
| Preview Question | ✅ | ✅ | ✅ | ❌ | ❌ |

---

## 6. Search, Filtering & Pagination

The question list endpoint (`GET /api/admin/questions`) provides structured server-side filtering and pagination:

### Query Parameters
- `page`: Page number (default: 1, minimum: 1).
- `limit`: Items per page (default: 20, max: 100).
- `search`: Search query (searches across `title`, `question_text`, `topic`, `skill`, `tags`).
- `status`: Filter by lifecycle status (`DRAFT`, `REVIEW`, `PUBLISHED`, `ARCHIVED`).
- `difficulty`: Filter by difficulty (`EASY`, `MEDIUM`, `HARD`).
- `type`: Filter by type (`MCQ`, `CODING`).
- `category`: Filter by category (`FULLSTACK`, `FRONTEND`, `BACKEND`, etc.).
- `topic`: Filter by topic.
- `skill`: Filter by skill.
- `sortBy`: Whitelisted sort column (`created_at`, `updated_at`, `marks`, `difficulty`, `status`, `title`).
- `sortOrder`: `'ASC'` or `'DESC'`.

### Response Format
When paginated:
```json
{
  "success": true,
  "data": {
    "items": [...],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 55,
      "totalPages": 3
    }
  }
}
```
*Note: If `page`, `limit`, and `paginate` query parameters are omitted, returns an array of questions directly to preserve backwards compatibility with legacy admin consumers.*

---

## 7. Duplicate Detection

Duplicate detection prevents accidental question duplication and helps question authors reuse existing content:

1. **Exact Matching**:
   Normalizes question text (trimmed, lowercased, whitespace collapsed) and queries within tenant scope.
2. **Fuzzy Matching (`Fuse.js`)**:
   Uses lightweight in-memory fuzzy index across tenant questions using threshold `0.3` to identify questions with similar wording or titles.
3. **Endpoint (`POST /api/admin/questions/duplicates`)**:
   Accepts `{ question_text, title, type, category }` and returns:
   ```json
   {
     "success": true,
     "data": {
       "hasDuplicates": true,
       "exactMatch": { "id": 4, "title": "...", "question_text": "..." },
       "fuzzyMatches": [ ... ]
     }
   }
   ```
   Admin UI provides real-time warning on blur of question text in question authoring forms without blocking valid similar questions.

---

## 8. Bulk CSV Import & Export

### CSV Column Specification
| Header | Required? | Example | Notes |
|---|---|---|---|
| `type` | Yes | `MCQ` | `MCQ` or `CODING` |
| `category` | Yes | `FULLSTACK` | Assessment track |
| `title` | No | `React Hooks Intro` | Short identifier |
| `question_text` | Yes | `What hook handles state?` | Problem stem |
| `difficulty` | No | `MEDIUM` | `EASY`, `MEDIUM`, or `HARD` |
| `topic` | No | `React` | Broader category |
| `skill` | No | `useState` | Specific skill |
| `marks` | No | `5` | Positive integer (default: 5) |
| `time_estimate` | No | `120` | Seconds (default: 120) |
| `tags` | No | `react,frontend,hooks` | Comma-separated |
| `language` | For Coding | `javascript` | Programming language |
| `status` | No | `DRAFT` | `DRAFT`, `REVIEW`, `PUBLISHED` |
| `options` | For MCQ | `useState\|useEffect\|useMemo` | Pipe-delimited (`\|`) |
| `correct_answer` | For MCQ | `0` or `useState` | Index or literal matching option |
| `starter_code` | For Coding | `function solution() {}` | Candidate code template |
| `test_cases` | For Coding | `[{"input":"1","expected_output":"2"}]` | JSON string |

### CSV Template Example
```csv
type,category,title,question_text,difficulty,topic,skill,marks,time_estimate,tags,language,status,options,correct_answer,starter_code,test_cases
MCQ,FULLSTACK,React State,Which hook handles local component state?,EASY,React,Hooks,5,60,"react,hooks",english,PUBLISHED,useState|useEffect|useRef|useMemo,0,,
CODING,FULLSTACK,Sum Two,Write a function sum(a, b) that returns their sum.,EASY,Algorithms,Math,10,300,"math,basics",javascript,PUBLISHED,,,,function sum(a, b) {\n  return 0;\n},"[{\"input\":\"2 3\",\"expected_output\":\"5\",\"is_hidden\":false}]"
```

### Import Workflow
1. **Preview (`POST /api/admin/questions/import/preview`)**:
   Parses CSV with `PapaParse`, runs row-by-row Zod validation and duplicate checks. Returns `{ totalRows, validRows, invalidRows, duplicates, rows }` without writing to the database.
2. **Execute (`POST /api/admin/questions/import`)**:
   Executes within a database transaction. If rows are invalid or duplicates, reports detailed errors per row (`rowNumber`, `field`, `error`, `message`).
3. **Export (`GET /api/admin/questions/export`)**:
   Streams filtered, tenant-isolated questions as formatted CSV with `Content-Type: text/csv`. Sensitive candidate attempt data and internal hashes are never exported.

---

## 9. Candidate Preview

- **Endpoint**: `GET /api/admin/questions/:id/preview`
- Sanitizes sensitive scoring and answers:
  - For MCQs: returns `options` array without `correct_index`.
  - For Coding: filters out `test_cases` where `is_hidden = true`.
- Allows admins to verify the rendered layout exactly as a candidate sees it in the assessment engine.

---

## 10. Audit Events

All question mutations emit structured security/business audit logs via `logSecurityEvent`:

- `question_created`
- `question_updated`
- `question_published`
- `question_archived`
- `question_deleted`
- `question_bulk_imported`
- `question_bulk_exported`
