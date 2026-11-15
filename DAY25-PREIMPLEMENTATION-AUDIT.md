# ASPIRE BY ADYAPAN — DAY 25
# PRE-IMPLEMENTATION AUDIT REPORT
## Public Exam & Candidate Experience Architecture

---

## 1. Executive Summary

This audit assesses the state of Aspire by Adyapan's candidate-facing experience prior to Day 25 development.

Through Days 1–24, Aspire established backend assessment infrastructure:
- Multi-tenancy with AsyncLocalStorage (`Day 16`)
- SaaS organizations & branding (`Day 17`)
- Analytics & reporting engines (`Days 18–20`)
- Subscription quotas & metering (`Days 21–22`)
- Transactional notification outbox (`Day 23`)
- Cryptographic certificate issuance & verification (`Day 24`)

However, the **candidate user interface and onboarding journey** remained minimal:
- Registration used an unvalidated form with basic fields and no verification.
- No email verification or mobile OTP verification existed.
- Autocomplete for colleges was absent.
- First-party campaign attribution (`utm_*`, referral codes) was uncaptured.
- The assessment test room used a raw HTML `<textarea>` for code input without syntax highlighting or indentation.
- Question palette only indicated answered/unanswered rather than visited, flagged, or current state.
- WCAG accessibility standards (accessible labels, ARIA live regions, keyboard navigation) were incomplete.

Day 25 transforms this experience into a production assessment product.

---

## 2. Existing Candidate Journey Audit

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│  Landing Page   │ ────► │  Registration Page   │ ────► │  Instructions Page  │
│  (landing.html) │       │     (index.html)     │       │ (instructions.html) │
└─────────────────┘       └──────────────────────┘       └──────────┬──────────┘
                                                                    │
                                                                    ▼
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│   Result Page   │ ◄──── │   Submission Modal   │ ◄──── │   Assessment Room   │
│  (result.html)  │       │       & Grading      │       │     (test.html)     │
└─────────────────┘       └──────────────────────┘       └─────────────────────┘
```

### 2.1 Component-by-Component Analysis

| View / File | Current State | Deficiencies & Gaps | Target Day 25 State |
| :--- | :--- | :--- | :--- |
| **Registration** (`index.html`, `register.js`) | Basic static inputs for Name, Phone, Email, College, City, Grad Year, Track. | No client validation beyond browser `pattern`. No email verification. No OTP verification. No college autocomplete. No UTM persistence. | Accessible form, Zod-backed validation, real-time feedback, email verification, SMS/OTP provider abstraction, searchable college dropdown, first/last-touch campaign attribution. |
| **Instructions** (`instructions.html`) | Informational card with rules and readiness checklist. | Missing section-by-section breakdown preview, no test environment checks (camera/audio check modal), static layout. | Dynamic exam structure summary, accessibility controls, terms agreement checkpoint. |
| **Assessment Room** (`test.html`, `test.js`) | Left sidebar palette with numbers; right card with question text & options/textarea. | Simple 2-state palette (answered/not answered). No "Mark for Review" action. No Clear Response. Raw `<textarea>` for code. Minimal section indicators. | 5-state palette (Not Visited, Unanswered, Answered, Marked for Review, Answered & Marked), Clear Answer, Review Toggle, section tabs, production-grade CodeMirror editor, responsive drawer. |
| **Timer** (`timer.worker.js`, `test.js`) | Server-authoritative countdown using Web Worker + heartbeat synchronization (Day 13). | Good core engine, but UI lacks distinct urgency thresholds (10m, 5m, 1m warning banners) and accessible screen-reader announcements. | Visual warning pulses, accessible aria-live timer milestone announcements, graceful final minute transition. |
| **Save & Autosave** (`network-recovery.js`, `assessment-storage.js`) | IndexedDB local persistence + revision synchronization + outbox sync (Day 12). | Excellent background engine. Badge only indicates green/red without granular states (Saving, Saved, Offline, Reconnecting, Sync Failed). | Explicit 6-state save badge, local dirty state tracking, unsaved change warning on navigation/unload. |
| **Code Editor** (`test.js`) | Plain HTML `<textarea id="codeArea">`. | No syntax coloring, no line numbers, no tab indent, no code reset confirmation, poor mobile keyboard handling. | CodeMirror 6 with Python, JS, C++, and Java syntax packages, line numbers, tab-handling, Aspire dark theme, lazy loading. |
| **Results** (`result.html`, `result.js`) | Score display, percentage, scholarship tier text, claim code. | Minimal UI, missing Day 24 certificate verification badge and QR verification link integration. | Comprehensive score card, performance tier badge, direct Day 24 verification link, copyable credential URL. |

---

## 3. Existing Backend APIs & Services

### 3.1 Reusable Endpoints
- `POST /api/register`: Creates/resumes student attempt and assigns exam snapshot. Reused as the core attempt initialization point.
- `GET /api/attempt/:token`: Delivers sanitized exam questions (no answer keys or hidden tests leaked).
- `POST /api/attempt/:token/progress/sync`: Receives batched answers with monotonic server revisions.
- `POST /api/attempt/:token/heartbeat`: Server-authoritative timer sync and deadline enforcement.
- `POST /api/attempt/:token/code-run`: Async run request via worker (HTTP 202).
- `POST /api/attempt/:token/code-submit`: Async authoritative code submission via worker (HTTP 202).
- `POST /api/attempt/:token/submit`: Atomic final grading, snapshot HMAC verification, and scholarship allocation.
- `GET /api/public/certificates/verify/:id`: Day 24 public verification.

### 3.2 Missing Endpoints to Implement
1. `POST /api/auth/candidate/send-otp`: Sends mobile verification code via provider.
2. `POST /api/auth/candidate/verify-otp`: Validates entered OTP code with brute-force protections.
3. `POST /api/auth/candidate/send-verification-email`: Triggers transactional email verification token via Day 23 outbox.
4. `GET /api/auth/candidate/verify-email`: Validates email token and marks candidate email verified.
5. `GET /api/public/colleges`: Debounced, searchable list of verified Indian & global educational institutions with caching.
6. `POST /api/public/campaign/attribution`: Records first-touch and last-touch marketing attribution.

---

## 4. Security & Integrity Risk Analysis

1. **OTP Brute-Force & Enumeration Risk**:
   - *Risk*: Attackers could brute-force 4- or 6-digit OTPs or enumerate existing phone numbers.
   - *Mitigation*: Store only SHA-256 hashes of OTPs. Enforce maximum 5 verification attempts per code. Implement a 60-second resend cooldown and IP/phone rate limiting. Return uniform generic responses.
2. **Client-Side Grading / Score Spoofing**:
   - *Preservation*: The server remains 100% authoritative for MCQ evaluation, coding sandboxes, snapshot integrity HMACs, and scholarship tier assignment.
3. **Hidden Test & Answer Key Leakage**:
   - *Preservation*: The sanitization routines in `buildAttemptQuestions()` and `snapshotService` ensure `correct_index` and `test_cases` are never sent to the browser.
4. **Editor Code Injection & Server Sandbox**:
   - *Preservation*: Candidate code is NEVER executed locally on the Node.js application server. All execution passes through Redis/BullMQ to the isolated execution engine.

---

## 5. Required Database Migration (Migration 019)

Migration `019_public_candidate_experience` will add:

1. **Student Account Security Columns**:
   - `email_verified` (INTEGER 0/1)
   - `phone_verified` (INTEGER 0/1)
   - `password_hash` (TEXT, optional for candidate portal login)
2. **Table `candidate_verifications`**:
   - Stores hashed OTPs and email verification tokens with expiration, attempts count, and single-use status.
3. **Table `colleges`**:
   - Catalogue of universities, engineering colleges, and institutes for fast, normalized autocomplete search.
4. **Table `campaign_attributions`**:
   - First-touch and last-touch UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `referral_code`, `landing_source`, `ip`, `user_agent`).

---

## 6. Code Editor Selection

**Decision: CodeMirror 6**
- *Reasoning*:
  - Fully modular and lightweight (~320KB minified vs Monaco's ~25MB+ multi-file footprint).
  - Works in Vanilla JS environments without requiring bundlers, webpack, or AMD loaders.
  - Native mobile browser and touch support (crucial for students taking assessments on tablets or laptops).
  - Full syntax highlighting for Python, JavaScript, C++, and Java.
  - Accessible ARIA keyboard navigation.
  - Documented in detail in `DAY25-EDITOR-DECISION.md`.

---

## 7. Dependencies to Install

- `node-fetch` or native fetch (Node 24 native fetch available).
- Zero external runtime bloat required:
  - Cryptography: Node native `crypto`.
  - Database: Existing `better-sqlite3`.
  - Validation: Existing `zod`.
  - Notification Outbox: Existing Day 23 infrastructure.
  - CodeMirror: Packaged self-hosted vendor bundle in `frontend/js/vendor/codemirror/` to ensure zero CDN dependencies and complete offline/intranet reliability.

