# Aspire Test Platform

Scholarship test platform for **Aspire by Adyapan** — *Aspire. Achieve. Adyapan.*

Students register → take a timed, auto-graded test → get their score, scholarship tier,
and a branded PDF certificate **instantly**. Zero human intervention in the testing pipeline.
An admin panel manages the question bank, test configuration, results, and per-college reports.

## Features

- **Student flow**: registration (one attempt per mobile number) → instructions → timed test
  → auto-submit on timeout → instant result (score, %, scholarship) → PDF certificate download → scholarship claim code
- **Test engine**: per-category quotas — **10 aptitude + 25 technical MCQ + 5 coding** (Judge0)
  per attempt; random subset per category, categories interleaved, shuffled MCQ
  options, countdown timer (default 90 min), tab-switch detection (counted, warned, persisted).
  Without Judge0, coding questions are auto-excluded and the test runs with 35.
- **Question types**: MCQ (single-correct, auto-graded) + code-writing questions graded
  against hidden test cases via **Judge0** (server-side; keys never reach the browser)
- **Scholarship tiers**: configurable slabs, defaults 90%+→100%, 75–89%→50%, 60–74%→25%, 40–59%→10%
- **Admin panel & RBAC**: JWT + session authentication via `jose`, bcrypt password hashing, 5 distinct roles (`SUPER_ADMIN`, `ORG_ADMIN`, `EXAM_MANAGER`, `EVALUATOR`, `VIEWER`), multi-tenant organization scoping, audit logging, question bank CRUD, test config, results table with filters, CSV export, per-college batch skill reports, Judge0 status notice
- **Seed data**: 53 sample questions — 15 aptitude, 30 technical (output prediction,
  bug-fix MCQ, code completion, CS fundamentals), 8 Judge0 coding questions — all marked `SAMPLE`

## Quick start

```bash
cp .env.example .env        # then edit: set AUTH_SECRET (or one is generated for local dev)
npm install
npm run bootstrap:admin     # provisions your initial Super Admin credentials
npm start                   # http://localhost:3000
```

- Student: http://localhost:3000/
- Admin: http://localhost:3000/admin.html (log in with your administrative credentials)

## Stack

Node.js + Express · better-sqlite3 (file DB) · vanilla JS frontend (no build step) ·
PDFKit (certificates) · Judge0 for code execution · Docker-ready.

## Docs

- `DEPLOY.md` — local run, Docker deploy, env vars, Judge0 setup (RapidAPI + self-hosted), subdomain/DNS
- `HANDOVER.md` — architecture, DB schema, what the tech team must provide, where to change branding/pricing
- `test/selftest.js` — automated end-to-end test (`npm test`, 50+ assertions, all green)

## Project layout

```
backend/
  server.js          Express entry point
  src/
    app.js           Express app wiring & static serving
    config/          env and configuration loaders
    data/seed.js     53 sample questions (15 aptitude / 30 technical / 8 coding)
    db/              SQLite schema + config store (better-sqlite3)
    middleware/      Admin token authentication
    routes/          Public & Admin REST endpoints
    services/        Certificate generator & Judge0 code runner
frontend/            Vanilla JS frontend (index, instructions, test, result, admin)
data/                SQLite database file location (aspire.db)
test/selftest.js     Full self-test harness (50+ assertions)
Dockerfile
docker-compose.yml
```
# Aspire