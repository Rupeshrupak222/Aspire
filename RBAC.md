# ASPIRE — ROLE-BASED ACCESS CONTROL (RBAC) & MULTI-TENANCY MATRIX

## 1. Overview

Aspire implements a strict **Deny-by-Default** authorization model. Every administrative request passes through authentication, account status verification, explicit permission checks, and tenant boundary enforcement:

```text
Request
   ↓
Rate Limit (40 req / 15m)
   ↓
requireAuth (JWT + Session + Account Status)
   ↓
requirePermission(permission)
   ↓
Tenant Scope Check (Resource Ownership / IDOR Defense)
   ↓
Input Validation (Zod)
   ↓
Controller / Database
```

---

## 2. Roles

The system defines 5 strict internal roles:

1. **`SUPER_ADMIN` (Super Admin)**:
   - Platform-level administrator.
   - Manages all organizations, platform users, question bank, test configs, results, and system analytics.
   - Operates across all tenant boundaries.
2. **`ORG_ADMIN` (Organization Admin)**:
   - Organization-level administrator.
   - Manages questions, exam configurations, results, exports, and users belonging **strictly to their organization**.
   - Cannot modify platform-level settings, create new organizations, or access other organizations' data.
3. **`EXAM_MANAGER` (Exam Manager)**:
   - Examination author and manager.
   - Full CRUD over questions and exams.
   - Read-only access to assessment results and college performance reports.
   - Cannot manage users, alter organization configurations, or export CSV data.
4. **`EVALUATOR` (Evaluator)**:
   - Assessment evaluator.
   - Read-only access to results and college skill reports.
   - Cannot mutate questions, users, or configurations. Cannot export results.
5. **`VIEWER` (Viewer)**:
   - Strictly read-only auditor.
   - Read-only access to candidate test results.
   - No mutation rights, no exports, no configuration access.

---

## 3. Permissions Definition

```text
questions.read           Examine question bank
questions.create         Add new questions
questions.update         Modify existing questions
questions.delete         Remove questions

exams.read               Examine exams
exams.create             Create new exams
exams.update             Modify exams
exams.delete             Remove exams
exams.publish            Publish exams live

results.read             View student results and scores
results.export           Export results to CSV

analytics.read           View aggregate college skill analytics & rankings

users.read               List and view administrative users
users.create             Provision new administrative users
users.update             Modify administrative user profiles
users.disable            Disable or reactivate administrative users

settings.read            Read test and application configuration
settings.update          Update test and application configuration

organizations.read       View organization tenant details
organizations.create     Create new organization tenants
organizations.update     Update organization tenant details
```

---

## 4. Role-to-Permission Matrix

| Category | Permission | SUPER_ADMIN | ORG_ADMIN | EXAM_MANAGER | EVALUATOR | VIEWER |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **Questions** | `questions.read` | ✅ | ✅ (Tenant) | ✅ | ❌ | ❌ |
| | `questions.create` | ✅ | ✅ (Tenant) | ✅ | ❌ | ❌ |
| | `questions.update` | ✅ | ✅ (Tenant) | ✅ | ❌ | ❌ |
| | `questions.delete` | ✅ | ✅ (Tenant) | ✅ | ❌ | ❌ |
| **Exams** | `exams.read` | ✅ | ✅ | ✅ | ❌ | ❌ |
| | `exams.create` | ✅ | ✅ | ✅ | ❌ | ❌ |
| | `exams.update` | ✅ | ✅ | ✅ | ❌ | ❌ |
| | `exams.delete` | ✅ | ✅ | ✅ | ❌ | ❌ |
| | `exams.publish` | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Results** | `results.read` | ✅ | ✅ (Tenant) | ✅ (Tenant) | ✅ (Tenant) | ✅ (Tenant) |
| | `results.export` | ✅ | ✅ (Tenant) | ❌ | ❌ | ❌ |
| **Analytics** | `analytics.read` | ✅ | ✅ (Tenant) | ✅ (Tenant) | ✅ (Tenant) | ❌ |
| **Users** | `users.read` | ✅ | ✅ (Tenant) | ❌ | ❌ | ❌ |
| | `users.create` | ✅ | ✅ (Tenant) | ❌ | ❌ | ❌ |
| | `users.update` | ✅ | ✅ (Tenant) | ❌ | ❌ | ❌ |
| | `users.disable` | ✅ | ✅ (Tenant) | ❌ | ❌ | ❌ |
| **Settings** | `settings.read` | ✅ | ✅ | ❌ | ❌ | ❌ |
| | `settings.update` | ✅ | ✅ (Limited) | ❌ | ❌ | ❌ |
| **Organizations** | `organizations.read` | ✅ | ✅ (Own Org) | ❌ | ❌ | ❌ |
| | `organizations.create`| ✅ | ❌ | ❌ | ❌ | ❌ |
| | `organizations.update`| ✅ | ✅ (Own Org) | ❌ | ❌ | ❌ |

---

## 5. Admin API Endpoint Mapping

| Endpoint | Method | Required Permission | Tenant Scoped | Description |
|---|---|---|:---:|---|
| `/api/admin/judge0-status` | `GET` | `questions.read` | No | Judge0 connectivity status |
| `/api/admin/questions` | `GET` | `questions.read` | Yes | List questions (scoped to tenant + platform samples) |
| `/api/admin/questions` | `POST` | `questions.create` | Yes | Create question (tagged with user's org) |
| `/api/admin/questions/:id` | `PUT` | `questions.update` | Yes | Update question (IDOR protected) |
| `/api/admin/questions/:id` | `DELETE` | `questions.delete` | Yes | Delete question (IDOR protected) |
| `/api/admin/config` | `GET` | `settings.read` | No | Retrieve test configuration |
| `/api/admin/config` | `PUT` | `settings.update` | Yes | Update config (Org Admin restricted from global slabs) |
| `/api/admin/results` | `GET` | `results.read` | Yes | Filtered by user's organization |
| `/api/admin/results.csv` | `GET` | `results.export` | Yes | CSV download (filtered by organization) |
| `/api/admin/report/college` | `GET` | `analytics.read` | Yes | Per-college report (filtered by organization) |
| `/api/admin/users` | `GET` | `users.read` | Yes | List users in current organization |
| `/api/admin/users` | `POST` | `users.create` | Yes | Create user (Org Admin cannot create Super Admin) |
| `/api/admin/users/:id` | `GET` | `users.read` | Yes | View user profile (IDOR protected) |
| `/api/admin/users/:id` | `PUT` | `users.update` | Yes | Update user profile (IDOR protected) |
| `/api/admin/users/:id/disable` | `POST` | `users.disable` | Yes | Disable user and flush sessions (IDOR protected) |
| `/api/admin/users/:id/enable` | `POST` | `users.disable` | Yes | Enable user account (IDOR protected) |
| `/api/admin/organizations` | `GET` | `organizations.read` | Yes | List organizations (Super Admin: all; Org Admin: own) |
| `/api/admin/organizations` | `POST` | `organizations.create` | No | Super Admin only platform organization provisioning |
| `/api/admin/organizations/:id` | `GET` | `organizations.read` | Yes | View organization (IDOR protected) |
| `/api/admin/organizations/:id` | `PUT` | `organizations.update` | Yes | Update organization name/status (IDOR protected) |

---

## 6. Multi-Tenant Isolation & IDOR Defenses

1. **Explicit Organization Boundaries**:
   - Administrative users belong to an `organization_id` (foreign key to `organizations.id`).
   - Super Admins have `organization_id = NULL` and operate with global cross-tenant privileges.
2. **Resource Ownership Rules**:
   - Questions have an `organization_id`. Sample/seeded questions have `organization_id = NULL` (platform-owned).
   - Only Super Admins can edit or delete platform questions.
   - Non-super-admins attempting to read, update, or delete another organization's questions or users receive HTTP 403 Forbidden with security audit logging (`cross_tenant_access_denied`).
3. **Privilege Escalation Defenses**:
   - Organization Admins cannot provision a `SUPER_ADMIN` user or assign users to another organization.
   - Organization Admins cannot modify or delete the last active Super Admin account.
