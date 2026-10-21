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
- **Admin panel** (token auth): question bank CRUD, test config, results table with filters,
  CSV export, per-college batch skill reports, Judge0 status notice
- **Seed data**: 53 sample questions — 15 aptitude, 30 technical (output prediction,
  bug-fix MCQ, code completion, CS fundamentals), 8 Judge0 coding questions — all marked `SAMPLE`

## Quick start

```bash
cp .env.example .env        # then edit: set ADMIN_TOKEN (or one is generated for you)
npm install
npm start                   # http://localhost:3000
```

- Student: http://localhost:3000/
- Admin: http://localhost:3000/admin.html (paste the `ADMIN_TOKEN`)

## Stack

Node.js + Express · better-sqlite3 (file DB) · vanilla JS frontend (no build step) ·
PDFKit (certificates) · Judge0 for code execution · Docker-ready.

## Docs

- `DEPLOY.md` — local run, Docker deploy, env vars, Judge0 setup (RapidAPI + self-hosted), subdomain/DNS
- `HANDOVER.md` — architecture, DB schema, what the tech team must provide, where to change branding/pricing
- `test/selftest.js` — automated end-to-end test (`npm test`, 50+ assertions, all green)

## Project layout

```
server.js            Express entry (static frontend + API)
src/
  db.js              SQLite schema + config store
  seed.js            53 sample questions (15 aptitude / 30 technical / 8 coding)
  judge0.js          Judge0 adapter (RapidAPI + self-hosted CE)
  certificate.js     PDFKit certificate generator
  routes-public.js   register / attempt / submit / certificate
  routes-admin.js    token-auth admin API (questions, config, results, reports)
public/              vanilla JS frontend (index, instructions, test, result, admin)
test/selftest.js     full self-test harness
Dockerfile
docker-compose.yml
```
# Aspire