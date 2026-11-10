# Aspire by Adyapan — Frontend Screen Inventory
## Complete Multi-Screen Architecture & API Mapping

This document provides a comprehensive inventory of all screens in the **Aspire by Adyapan** internal platform, mapped to their routes, user roles, APIs, and design status.

---

### Screen Inventory Table

| Screen ID | Screen Name | Route / Path | Primary Role | Existing API Endpoints | Key Components & State |
|---|---|---|---|---|---|
| **00** | Public Landing Page *(Existing / Out of Scope)* | `/landing.html` | Public | None | Hero, Carousel, 3D Parallax, Experience, Tiers, FAQs |
| **01** | User / Admin Login | `/login.html` & in `/admin.html` | All Users | `POST /api/auth/login` | Midnight black card, email/password, toggle visibility, error alert |
| **02** | Candidate Registration | `/index.html` | Candidate | `POST /api/register` | Luxury registration card, 8 fields, validation, instant token |
| **03** | Password Recovery / Assistance | `/forgot-password.html` | All Users | Support / Admin Reset | Recovery guidance, email field, administrative instruction |
| **04** | Candidate Dashboard | `/candidate-dashboard.html#dashboard` | Candidate | `GET /api/attempt/:token`, `GET /api/config/public` | Midnight sidebar, next assessment, progress metrics, status |
| **05** | Candidate Profile | `/candidate-dashboard.html#profile` | Candidate | `GET /api/attempt/:token` | Personal info, academic details, college, track, edit mode |
| **06** | Assessments Listing & History | `/candidate-dashboard.html#assessments` | Candidate | `GET /api/config/public`, `GET /api/attempt/:token` | Upcoming, active, and completed assessments cards with CTAs |
| **07** | Pre-Assessment Instructions | `/instructions.html` | Candidate | `GET /api/config/public` | Readiness checklist, proctoring notice, quota breakdown, start CTA |
| **08** | Proctored Assessment Room | `/test.html` | Candidate | `GET/POST /api/attempt/:token/*` | Top nav with timer & sync, left palette, MCQs, code editor, submit dialog |
| **09** | Assessment Results | `/result.html` | Candidate | `GET /api/attempt/:token/submit` | Large Playfair score, scholarship slab, claim code, breakdown table |
| **10** | Scholarship Details & Claim | `/candidate-dashboard.html#scholarship` | Candidate | `GET /api/attempt/:token` | Awarded percentage, claim instructions, counselor guidance |
| **11** | Achievement Certificate | `/candidate-dashboard.html#certificate` | Candidate | `GET /api/certificate/:certId` | Luxury on-screen certificate, gold seal, PDF download button |
| **12** | Candidate Support & FAQs | `/candidate-dashboard.html#support` | Candidate | Static / Knowledgebase | Assessment rules, troubleshooting, network recovery instructions |
| **13** | SaaS Analytics Dashboard | `/admin.html#pane-dashboard` | Admin / Org Admin | `GET /api/organization/dashboard/*` | 8 KPI metric cards, Chart.js trends, score/college distribution |
| **14** | Candidate Management | `/admin.html#pane-candidates` | Admin / Org Admin | `GET /api/admin/results` | Candidate roster, search, college filter, detail inspection drawer |
| **15** | Exam Management & Builder | `/admin.html#pane-exams` | Exam Manager / Admin | `GET/POST/PUT /api/admin/exams/*` | Exam list, version lifecycle, section manager, scholarship slabs |
| **16** | Question Bank 2.0 | `/admin.html#pane-questions` | Exam Manager / Admin | `GET/POST/PUT /api/admin/questions/*` | Filter by category/difficulty/type, search, preview modal, editor |
| **17** | Exam Analytics (5 Tabs) | `/admin.html#pane-exam-analytics` | Admin / Analyst | `GET /api/organization/exams/:id/analytics/*` | Overview/Funnel, Questions psychometrics, Coding, Performance, Candidates |
| **18** | Results & Submissions | `/admin.html#pane-results` | Admin / Evaluator | `GET /api/admin/results`, `GET /api/admin/results.csv` | Search, score filter, CSV export, proctoring telemetry review |
| **19** | Scholarship Management | `/admin.html#pane-scholarships` | Admin / Org Admin | `GET /api/admin/results` | Slabs breakdown, recipients, verified claims, certificate issuance |
| **20** | Reporting & Export System | `/admin.html#pane-report` | Admin / Viewer | `GET /api/admin/report/college`, `/api/admin/results.csv` | College performance batch report, multi-format export, filters |
| **21** | Organization Management | `/admin.html#pane-organizations` | Super Admin | `GET/POST/PUT /api/admin/organizations/*` | Tenant roster, onboarding modal, suspend/enable, platform usage |
| **22** | Team Management & Invites | `/admin.html#pane-users` | Org Admin / Super Admin | `GET/POST /api/admin/users`, `/api/organization/invitations` | Member list, roles, send invitation email modal, revocation |
| **23** | Settings & Branding | `/admin.html#pane-branding` & `#pane-config` | Org Admin / Admin | `POST /api/organization/branding/*`, `GET/PUT /api/admin/config` | Brand colors, logo upload, certificate signature, test defaults |

---

### Global System States

1. **404 Page Not Found**: Universal fallback screen with brand typography and navigation.
2. **403 Access Denied**: Security rejection screen for unpermitted tenant or role operations.
3. **Session Expired**: Auto-clears invalid JWT and navigates cleanly to `/login.html` with flash notification.
4. **Network Offline / Disconnection**: Live badge in test interface with offline caching notice and local recovery.
5. **Multi-Tab Warning Banner**: Prevents race conditions and duplicate attempt sessions across tabs.
6. **Toast & Notification Framework**: Universal toasts with auto-dismiss and accessible ARIA attributes.

