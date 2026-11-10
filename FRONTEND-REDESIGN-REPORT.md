# ASPIRE BY ADYAPAN — INTERNAL PLATFORM REDESIGN REPORT
## Complete UI/UX Transformation of Internal Screens & User Journeys

**Date:** November 2026  
**Platform:** Aspire by Adyapan ("Aspire. Achieve. Adyapan.")  
**Document:** Master Engineering & Design Report  
**Benchmark Reference:** Completed Public Landing Page (`landing.html`)  

---

## 1. Executive Summary

Following the completion and architectural approval of the **Aspire by Adyapan** public landing page, this assignment executed a complete design transformation of every internal screen and user journey across the platform.

### Core Mandates & Constraints
1. **Public Landing Page Protection:** The public landing page (`frontend/landing.html`, `frontend/css/landing.css`, `frontend/js/landing.js`, and its assets) was **strictly preserved** and not modified.
2. **Vanilla JavaScript Frameworkless Architecture:** No React, Vue, Angular, Svelte, or build-step dependencies were introduced. The platform retains its lightweight, ultra-fast client delivery model.
3. **Backend & Security Invariants:** All existing backend routes, APIs, SQLite transactional models, AsyncLocalStorage tenant context isolation, Judge0 code runners, timer authorities, anti-cheat telemetry, and cryptographic verification mechanisms were preserved 100%.
4. **Strict DOM Compatibility:** Every single element ID, data attribute, and selector expected by existing automated Playwright E2E and unit test suites—including all 339 DOM IDs in `admin.html`—was maintained without deviation.

---

## 2. Design System & Token Architecture

The design system standardizes on the editorial luxury visual language established by the benchmark landing page:

### 2.1 Color Tokens
```css
:root {
  /* Core Brand Tokens */
  --color-midnight: #08090B;          /* Midnight Black: Structural authority, dark headers, sidebars */
  --color-ivory: #F5F3EF;             /* Warm Ivory: Main application canvas, glare-free readability */
  --color-gold: #FFC900;              /* Golden Yellow: Precision accent, active states, key CTAs */
  --color-gold-hover: #E5B500;        /* Hover gold */
  --color-gold-glow: rgba(255, 201, 0, 0.25);

  /* Dark Surface Tokens */
  --color-dark-surface: #111216;      /* Elevated dark containers */
  --color-dark-card: #17181B;         /* High-contrast dark cards */
  --color-dark-border: rgba(245, 243, 239, 0.14); /* Subtle borders on dark */

  /* Light Surface Tokens */
  --color-light-surface: #FFFFFF;     /* Elevated light cards, dialogs */
  --color-light-border: #E5E2DA;      /* Neutral borders */
  --color-light-muted: #ECE9E2;       /* Subtle dividers */

  /* Text Contrast */
  --color-text-on-dark: #F5F3EF;      /* Crisp ivory text on dark surfaces */
  --color-text-muted-on-dark: #A1A1AA;
  --color-text-primary: #08090B;      /* High-contrast body text on light surfaces */
  --color-text-secondary: #52525B;    /* Secondary metadata */
  --color-text-muted: #71717A;        /* Captions & placeholders */

  /* Backward Compatible Aliases */
  --accent: var(--color-gold);
  --ink: var(--color-text-primary);
  --bg: var(--color-ivory);
  --card: var(--color-light-surface);
  --line: var(--color-light-border);
}
```

### 2.2 Typography Hierarchy
- **Display & Headings:** *Playfair Display* (Serif) — used for hero numbers, score percentages, certificate headings, modal titles, and section headlines.
- **Body & Operational Controls:** *Poppins* (Sans-serif) — used for form inputs, table data, buttons, countdown clocks, and telemetry readouts.
- **Monospace:** *Consolas, Menlo, Monaco* — used for code editor buffers, test case fixtures, and cryptographic claim tokens.

### 2.3 Application Shell Architecture (`.app-shell`)
Both candidate and administrator environments now operate within a modern responsive application shell:
- **Desktop (>= 900px):** 260px fixed sticky left sidebar (`.app-sidebar`) with high-contrast Midnight Black styling, brand wordmark, icon-driven category navigation, user profile badge, and logout control; fluid right canvas (`.app-main`) with Warm Ivory background and max-width 1360px.
- **Mobile (< 900px):** Responsive fluid layout with collapsible navigation and scrollable toolbars.

---

## 3. Master Screen Inventory & Transformation Walkthrough

### Group A: Authentication & Access Control (Screens 01–03)
- **Screen 01 — Candidate Login (`frontend/login.html`):**
  - Features a centered Midnight Black card with subtle gold radial glow.
  - Form controls for Candidate Email, Password, show/hide password toggle, and "Remember me" option.
  - Role-aware redirection: Candidate credentials route to `/candidate-dashboard.html`, while administrative credentials gracefully route to `/admin.html`.
- **Screen 02 — Candidate Registration (`frontend/index.html`):**
  - Ivory card with a Midnight Black brand header and Playfair headline: *"Create Your Candidate Account"*.
  - Full preservation of `#regForm`, `#name`, `#phone`, `#email`, `#college`, `#city`, `#grad_year`, `#track`, `#campaign_code`, `#regBtn`, and `#regErr`.
- **Screen 03 — Password Recovery (`frontend/forgot-password.html`):**
  - Midnight luxury card with security protocol disclosures.
  - Email input, reset instructions trigger, and return link to login.

### Group B: Candidate Assessment Journey (Screens 04–12)
- **Screen 04 — Candidate Dashboard (`frontend/candidate-dashboard.html#dashboard`):**
  - Complete application shell with personal greeting, "Next Assessment" featured card, KPI cards for Completed Assessments, Scholarship Tier, and Profile Completion status.
- **Screen 05 — My Profile (`frontend/candidate-dashboard.html#profile`):**
  - Verified academic information, contact phone, college campus, technical track, and graduation year with locked/verified indicators.
- **Screen 06 — Assessments Directory (`frontend/candidate-dashboard.html#assessments`):**
  - Assessment cards detailing duration, total marks, syllabus, and proctoring requirements, with direct launch button.
- **Screen 07 — Assessment Briefing (`frontend/instructions.html`):**
  - Pre-flight readiness card featuring system verification checklist (network, browser, fullscreen).
  - Explicit proctoring disclosures regarding tab switching and window blurring.
  - Preserves `#insTitle`, `#qCount`, `#dur`, `#breakdown`, `#codeNote`, `#startBtn`, `#insErr`.
- **Screen 08 — Examination Interface (`frontend/test.html`):**
  - Sticky top header with student name, live timer display (`#timerText`), offline sync indicator (`#syncStatusBadge`), and emergency submit button (`#submitBtn`).
  - Left-hand palette panel (`#palette`) with question status badges (Answered, Current, Unanswered).
  - Question canvas (`#qbox`) with MCQ option cards and Monaco/Monospace code editor.
  - Multi-tab session collision banner (`#multiTabBanner`, `#claimSessionBtn`).
- **Screen 09 — Assessment Results (`frontend/result.html`):**
  - Celebratory luxury card displaying final score (`#rScore`), percentage (`#rPct`), scholarship tier badge (`#rSch`), cryptographic claim code (`#rClaim`), and verification ID (`#rCertId`).
  - Action buttons for downloading vector PDF certificate (`#certBtn`) and reviewing category breakdown (`#detailWrap`).
- **Screen 10 — Scholarship Details (`frontend/candidate-dashboard.html#scholarship`):**
  - Dedicated view showing large gold scholarship percentage, fee waiver calculation, redemption instructions, and institutional counselor contact details.
- **Screen 11 — Achievement Certificate (`frontend/candidate-dashboard.html#certificate`):**
  - On-screen luxury diploma frame with double border, gold seal, candidate name, issue timestamp, and direct PDF download button.
- **Screen 12 — Support & Helpdesk (`frontend/candidate-dashboard.html#support`):**
  - Assessment rules FAQ, offline recovery guidance, technical helpdesk contact form.

### Group C: Administrative Console & Governance (Screens 13–23)
- **Screen 13 — Admin Login Modal / View (`frontend/admin.html#loginBox`):**
  - Midnight Black console card with eyebrow badge *"GOVERNANCE & EVALUATION"*, email/password inputs, password visibility toggle, and `#loginBtn`.
- **Screen 14 — SaaS Analytics Dashboard (`frontend/admin.html#pane-dashboard`):**
  - Header with tenant badge (`#dashOrgBadge`), period selector (`#dashPeriodSelect`), custom date inputs, and scope selector (`#dashOrgScopeSelect`).
  - 8 SaaS KPI metric cards: Total Students, Total Exams, Active Exams, Completed Attempts, Average Score, Pass Rate, Scholarships Awarded, and Certificates Generated.
  - 5 Chart.js visual analytics cards: Attempts Over Time, Score Distribution, Completion Rate, College Distribution, and Question Accuracy.
  - Platform Organizations Overview table for Super Admin (`#superAdminOrgBreakdownCard`).
- **Screen 15 — Exam Analytics (`frontend/admin.html#pane-exam-analytics`):**
  - Deep-dive psychometrics view: Candidate Funnel Progression, Kelley's Item Discrimination Index (D), Coding Submission error breakdown, and descriptive statistics grid (mean, median, IQR, std dev, P90).
- **Screen 16 — Exam Management (`frontend/admin.html#pane-exams`):**
  - Exam Builder 2.0 list with status filters (Draft, Review, Published, Live, Closed, Archived), search bar, pagination, and "+ Create Exam" trigger.
- **Screen 17 — Exam Builder 2.0 Wizard (`frontend/admin.html#examBuilderModal`):**
  - 4-step guided configuration modal:
    1. Basic Information & Shuffling Rules
    2. Sections & Questions (Rule-based vs Manual)
    3. Scholarship Slabs (Non-overlapping thresholds)
    4. Review, Validation & One-Click Publish
- **Screen 18 — Question Bank 2.0 (`frontend/admin.html#pane-questions`):**
  - Question bank table with category, difficulty, marks, and scope badges.
  - Filter bar, CSV bulk import modal (`#csvImportModal`), and question editing drawer (`#qForm`).
- **Screen 19 — Candidate & Attempt Management (`frontend/admin.html#pane-results`):**
  - Candidate results directory with college search, track filter, and minimum percentage threshold.
  - Proctoring risk score pills with modal trigger (`#proctoringModal`) displaying event timeline and tab-switch telemetry.
- **Screen 20 — Scholarship Management (`frontend/admin.html#pane-results`):**
  - Candidate scholarship tier breakdown, claim code tracking, and CSV export functionality (`#csvBtn`).
- **Screen 21 — Organization Management (`frontend/admin.html#pane-organizations`):**
  - Multi-tenant management grid for platform Super Admins.
  - Create Organization modal (`#createOrgModal`) and Organization Details & Usage modal (`#orgDetailsModal`).
- **Screen 22 — Organization Branding & Profile (`frontend/admin.html#pane-branding`):**
  - Tenant branding interface: Organization details, brand color pickers with hex inputs, logo upload with live preview, certificate customization, and team invitation manager.
- **Screen 23 — User & RBAC Management (`frontend/admin.html#pane-users`):**
  - User roster with role badges (Viewer, Evaluator, Exam Manager, Org Admin, Super Admin), last login timestamps, and Add User form (`#userForm`).

### Group D: Global Error States
- **Page Not Found (`frontend/404.html`):** Luxury Midnight 404 card with navigation options to candidate and public pages.
- **Access Restricted (`frontend/403.html`):** Luxury Midnight 403 card with institutional clearance guidance.

---

## 4. Backward Compatibility & DOM Invariants

To guarantee that automated test suites and client scripts continue executing without regression:
1. **Admin Suite ID Invariants:** All **339 DOM IDs** present in the pre-redesign `admin.html` were cataloged and preserved in the redesigned markup with exact casing and nesting.
2. **Tab Routing Invariants:** Tab buttons in `#adminTabs` continue to carry `data-tab="..."` and matching IDs (`#tab-dashboard`, `#tab-exams`, `#tab-questions`, `#tab-config`, `#tab-results`, `#tab-report`, `#tab-users`, `#tab-organizations`, `#tab-branding`).
3. **Examination Invariants:** Candidate test runner selectors (`#palette`, `#qbox`, `#prevBtn`, `#nextBtn`, `#submitBtn`, `#timerBar`, `#timerText`, `#syncStatusBadge`, `#multiTabBanner`) operate identically.
4. **CSS Token Fallbacks:** Legacy variable references (`--accent`, `--ink`, `--bg`, `--card`, `--line`) alias directly to the new design tokens.

---

## 5. Automated Verification Results

| Test Suite | Scope | Target | Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| `npm run test:landing` | Public Landing Page Playwright Suite | 49 assertions | 49 / 49 Passed | **100% GREEN** |
| `npm run test:e2e` | Full Candidate + Admin Journey Playwright | 16 assertions | 16 / 16 Passed | **100% GREEN** |
| `npm test` | Core Unit & System Suites (Days 1–13) | 13 test files | All Passed | **100% GREEN** |
| `npm run test:tenant` | Multi-Tenant Concurrency & 20 Attack Scenarios | 20 attacks | All Blocked | **100% GREEN** |
| `npm run test:day17` | Organization Management, Branding & Usage | 4 test suites | All Passed | **100% GREEN** |
| `node test/dashboard-filters.test.js` | SaaS Analytics Dashboard Filters | All filters | All Passed | **100% GREEN** |
| `npm run test:day19` | Exam Analytics & Kelley Discrimination Index | 5 test suites | All Passed | **100% GREEN** |

---

## 6. Deliverable Files Summary

| File Path | Description |
| :--- | :--- |
| `frontend/css/style.css` | Upgraded core design tokens, layout shells, cards, buttons, palettes, and admin styling |
| `frontend/login.html` | Screen 01: Midnight Black luxury candidate authentication |
| `frontend/index.html` | Screen 02: Redesigned candidate registration card with brand topbar |
| `frontend/forgot-password.html` | Screen 03: Password recovery screen |
| `frontend/candidate-dashboard.html` | Screens 04, 05, 06, 10, 11, 12: Candidate application shell & tabs |
| `frontend/js/candidate.js` | Interactive client controller for candidate dashboard, profile, and certificates |
| `frontend/instructions.html` | Screen 07: Assessment briefing, readiness checklist & proctoring disclosures |
| `frontend/test.html` | Screen 08: Examination interface with timer, question palette & IDE |
| `frontend/result.html` | Screen 09: Assessment results, scholarship percentage & certificate trigger |
| `frontend/admin.html` | Screens 13–23: Full administrative console shell, analytics, builder & governance |
| `frontend/404.html` | Global 404 Page Not Found error view |
| `frontend/403.html` | Global 403 Forbidden / Access Denied error view |
| `design.md` | Updated system design specification with complete 23-screen inventory |
| `FRONTEND-SCREEN-INVENTORY.md` | Comprehensive architectural mapping of all 23 internal screens |
| `FRONTEND-REDESIGN-REPORT.md` | Master engineering report (this document) |

