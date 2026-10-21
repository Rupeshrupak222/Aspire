# HANDOVER.md — for Adyapan's tech team

## What this is

A complete, self-tested scholarship-test platform. Students: register → timed test →
instant score + scholarship + PDF certificate. Admins: question bank, config, results,
CSV export, per-college reports. Built to be deployed as-is (suggested: `aspire.adyapan.com`)
or ported into the main adyapan.com stack — the API contracts below make either path easy.

## Architecture

```
Browser (vanilla JS, no build step)
   │  sessionStorage holds the attempt token
   ▼
Express (server.js)
   ├─ GET  /  /index.html /instructions.html /test.html /result.html /admin.html
   ├─ /api/*            public routes (src/routes-public.js)
   ├─ /api/admin/*      token-auth routes (src/routes-admin.js)
   ├─ src/db.js         better-sqlite3, schema + config table
   ├─ src/seed.js       53 sample questions (is_sample=1): 15 aptitude, 30 technical, 8 coding
   ├─ src/judge0.js     server-side Judge0 adapter
   └─ src/certificate.js PDFKit certificate generator
```

**Key design decisions**
- Attempt integrity is server-side: question order + option-shuffle maps are stored
  per attempt (`attempts.question_ids_json`, `shuffle_map_json`); the browser never
  receives `correct_index` or `test_cases` (verified by self-test).
- One attempt per phone: `students.phone` is UNIQUE (normalized to 10 digits).
  Re-registration resumes an in-progress attempt or returns 409 ALREADY_ATTEMPTED.
- Grading is synchronous in `POST /api/attempt/:token/submit` (idempotent).
  Code questions call Judge0 with `wait=true` per test case (sequential, ~1–3s each).
- Certificates are generated on demand (`GET /api/certificate/:id`), not stored.

## Database schema (SQLite, better-sqlite3)

- `config(key, value)` — test_title, duration_minutes (default 90),
  quota_aptitude (10), quota_technical (25), quota_coding (5),
  shuffle_questions, shuffle_options, scholarship_slabs (JSON), brand_name, accent_color
- `questions(id, type['mcq'|'code'], category['aptitude'|'technical'|'coding'], question_text, options_json,
  correct_index, code_starter, language_id, test_cases_json[{input,expected}],
  marks, is_sample, created_at)` — category↔type is strict: coding ⇔ code, others ⇔ mcq
- `students(id, name, phone UNIQUE, email, college, city, grad_year, track,
  campaign_code, created_at)`
- `attempts(id, token UNIQUE, student_id, status, started_at, expires_at,
  submitted_at, tab_switches, question_ids_json, shuffle_map_json, answers_json,
  code_answers_json, score, total_marks, percentage, scholarship_pct,
  certificate_id UNIQUE, claim_code UNIQUE, was_late, graded_detail_json)`

Swap to Postgres later by replacing `src/db.js` — all SQL is in `db.js` and the
two route files, no ORM magic.

## API contracts (for porting into adyapan.com later)

Public: `POST /api/register` → `{token, expires_at, …}` · `GET /api/config/public` →
`{duration_minutes, question_count, quotas{aptitude,technical,coding}, breakdown, code_questions_enabled}` ·
`GET /api/attempt/:token` →
`{questions:[{id,type,category,question_text,options|code_starter,marks}]}` ·
`POST /api/attempt/:token/submit {answers, codeAnswers, tabSwitches}` →
`{score,total_marks,percentage,scholarship_pct,certificate_id,claim_code,was_late,detail}` ·
`GET /api/certificate/:id` → PDF.

Admin (`x-admin-token` header): CRUD `/api/admin/questions`,
`GET|PUT /api/admin/config`, `GET /api/admin/results[?college&track&min_percentage]`,
`GET /api/admin/results.csv`, `GET /api/admin/report/college?college=`,
`GET /api/admin/judge0-status`.

## What the team must provide (env)

- `ADMIN_TOKEN` — strong random secret for the admin panel.
- For code questions: **one** of —
  - RapidAPI: `JUDGE0_ENDPOINT=https://judge0-ce.p.rapidapi.com`,
    `JUDGE0_API_KEY=<key>`, `JUDGE0_RAPIDAPI_HOST=judge0-ce.p.rapidapi.com`; or
  - Self-hosted CE: `JUDGE0_ENDPOINT=http://<host>:2358` (key/host empty).
- ⚠️ **Not verified locally**: live Judge0 execution. The adapter follows Judge0's
  documented API (`POST /submissions?base64_encoded=true&wait=true`, status id 3 =
  Accepted) and degrades cleanly when unconfigured, but the team must point it at a
  real endpoint/key and run one code submission before launch. Everything else
  (50+ assertions in `npm test`) is verified green.

## Where to change things

- **Branding/colors**: `public/css/style.css` (`--accent`), `brand_name`/`accent_color`
  in Admin → Test Config; certificate layout in `src/certificate.js`.
- **Pricing/scholarship slabs**: Admin → Test Config → scholarship slabs JSON
  (also the tier list hardcoded on `public/instructions.html` — keep in sync).
- **Test length/duration**: Admin → Test Config (`duration_minutes`, per-category
  quotas `quota_aptitude` / `quota_technical` / `quota_coding`). Locked default:
  40 questions (10 aptitude + 25 technical + 5 coding), 90 minutes. Scholarship
  tiers are percentage-based, so the 35-question fallback (Judge0 off) works unchanged.
- **Questions**: Admin → Questions (delete `is_sample=1` rows before launch, or
  `DELETE FROM questions WHERE is_sample=1`).
- **Phone validation**: `normalizePhone()` in `src/routes-public.js` (currently
  Indian 10-digit mobiles).

## Known limitations / future work

- No email/WhatsApp delivery yet — results + certificate are on-screen/download.
  Add via WATI/Interakt (WhatsApp) when ready; claim codes are already unique per student.
- Rate limiting / CAPTCHA on registration not included — add at the reverse proxy
  if abuse appears.
- Code grading is sequential per test case; for large cohorts consider a job queue.
- `node_modules` is not committed — `npm install` on deploy (Dockerfile handles it).
