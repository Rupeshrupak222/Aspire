# ASPIRE — PRODUCTION SECURITY BASELINE CHECKLIST

This checklist documents the security controls, baseline configurations, verification status, and operational policies for the **Aspire Assessment Platform**.

---

## 1. Secrets & Environment Security

- [x] **No `.env` committed**: Verified via `git log --all --full-history -- .env backend/.env`.
- [x] **Database files ignored**: SQLite files (`*.db`, `*.db-wal`, `*.db-shm`, `/data/`) are strictly ignored in `.gitignore`.
- [x] **API keys & tokens excluded**: No hardcoded API keys, JWT secrets, or cloud keys in version control.
- [x] **Production auth secret enforced**: In `backend/server.js`, if `NODE_ENV === 'production'` and `AUTH_SECRET` is unset, the process halts immediately with exit code 1.
- [x] **Old default token eradicated**: Development fallback `ADMIN_TOKEN` has been completely eliminated from production authentication and documentation.
- [x] **Log redaction**: Sensitive fields (`authorization`, `password`, `password_hash`, `new_password`, `current_password`, `token_hash`, `token`, `secret`, `*.AUTH_SECRET`, `*.JWT_SECRET`, `*.JUDGE0_API_KEY`) are masked with `[REDACTED]` in Pino structured logs.

---

## 2. HTTP Security Headers (Helmet)

- [x] **Helmet enabled**: Mounted at top level in `backend/src/app.js` using `backend/src/security/headers.js`.
- [x] **Clickjacking protection**: `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` prevent embedding exam or admin interfaces in malicious iframes.
- [x] **MIME sniffing protection**: `X-Content-Type-Options: nosniff` prevents browsers from executing uploaded non-executable files as scripts.
- [x] **Referrer policy**: `Referrer-Policy: same-origin` prevents leaking sensitive attempt tokens or query parameters to third-party domains.
- [x] **Content Security Policy (CSP)**:
  - `default-src: ["'self'"]`
  - `script-src: ["'self'", "'unsafe-inline'"]` (supports client instructions script without external CDNs)
  - `style-src: ["'self'", "'unsafe-inline'"]` (supports dynamic inline branding colors & UI alert states)
  - `img-src: ["'self'", "data:"]`
  - `connect-src: ["'self'"]`
  - `object-src: ["'none'"]`
  - `base-uri: ["'self'"]`
  - `form-action: ["'self'"]`
- [x] **HSTS (Strict-Transport-Security)**: Automatically enabled with `max-age: 31536000` (1 year) when `NODE_ENV === 'production'`.
- [x] **Permissions Policy**: `camera=(), microphone=(), geolocation=(), payment=()` disables unnecessary browser hardware APIs.

---

## 3. Cross-Origin Resource Sharing (CORS)

- [x] **Explicit origin allowlist**: Configured in `backend/src/security/cors.js`.
- [x] **No wildcard credentials**: Wildcard `*` is prohibited when credentials are true.
- [x] **Preflight OPTIONS**: Configured with 24-hour cache (`maxAge: 86400`) and allowed methods `GET, POST, PUT, DELETE, OPTIONS`.
- [x] **Environment-driven**: Reads `CORS_ORIGIN` comma-separated list in production; permits localhost during development and testing.

---

## 4. Request Size & Rate Limiting

- [x] **Global request body limits**: `express.json({ limit: '512kb' })` and `express.urlencoded({ extended: false, limit: '128kb' })` defend against memory exhaustion and large payload DoS.
- [x] **Public API rate limiter**: 300 requests per 15 minutes per IP on all `/api/*` endpoints.
- [x] **Registration rate limiter**: 15 registration attempts per 15 minutes per IP on `POST /api/register` to block bot account creation and database spam.
- [x] **Assessment submission rate limiter**: 10 submissions per 1 minute per IP on `POST /api/attempt/:token/submit` to protect remote Judge0 compute quotas.
- [x] **Admin login brute-force limiter**: 10 login attempts per 15 minutes per IP on `POST /api/auth/login`.
- [x] **Admin API rate limiter**: 40 requests per 15 minutes on `/api/admin/*`.
- [x] **Certificate retrieval rate limiter**: 30 downloads per 5 minutes per IP on `GET /api/certificate/:certificateId` to block scraping and enumeration.
- [x] **Standardized 429 response**: Returns HTTP `429 Too Many Requests` with `{ success: false, error: "RATE_LIMITED", code: "RATE_LIMITED", ... }`.

---

## 5. Input Security & XSS Mitigation

- [x] **Zod input validation**: Strict runtime boundaries enforced across all request bodies, route params, and query filters.
- [x] **Output encoding**: All dynamic variables rendered in the browser DOM are passed through HTML entity escaping (`esc(...)`) in `frontend/js/*.js`.
- [x] **Preservation of math and code symbols**: Input sanitization does not mangle legitimate programming symbols like `<iostream>`, `a < b`, or `x > y`.
- [x] **SQL LIKE wildcard escaping**: SQLite `LIKE` queries in admin results and college skill reports escape `%`, `_`, and `\` using `escapeLike(...)` with `ESCAPE '\'`.

---

## 6. Authentication & Session Security (Day 4)

- [x] **Cryptographic JWT via `jose`**: HS256 tokens signed with `AUTH_SECRET`, with clean claims (`sub`, `role`, `organization_id`, `token_version`, `jti`).
- [x] **Password Hashing via `bcrypt`**: 10 salt rounds in production (~60ms hash time), preventing offline dictionary and rainbow table cracking.
- [x] **Email Normalization**: Emails trimmed and lowercased before lookup and insertion.
- [x] **Account Enumeration Defense**: Constant-time dummy hashing on invalid logins; returns uniform `"Invalid email or password."`.
- [x] **Server-Side Session State**: Cryptographically random 24-byte hex sessions tracked in `sessions` table.
- [x] **Immediate Revocation**: Logout, password reset, role changes, and account disablement instantly invalidate previously issued access tokens.
- [x] **Token Versioning**: `users.token_version` invalidates all cached tokens if an administrator modifies roles or passwords.
- [x] **Candidate Separation**: Candidate attempt tokens remain separate 48-character assessment-scoped secrets and are never conflated with admin identities.

---

## 7. Role-Based Access Control (RBAC) & Multi-Tenancy

- [x] **Deny-by-Default Policy**: Endpoints require explicit authentication and permission checks.
- [x] **5 Distinct Roles**: `SUPER_ADMIN`, `ORG_ADMIN`, `EXAM_MANAGER`, `EVALUATOR`, `VIEWER`.
- [x] **Centralized RBAC Matrix**: Defined in `backend/src/security/rbac.js`.
- [x] **Tenant Boundary Scoping**: Organization Admins and tenant users are strictly scoped to their `organization_id`.
- [x] **IDOR Protection**: Insecure Direct Object References prevented on questions, results, users, settings, and organization records.
- [x] **Platform Protection**: Platform sample questions and global configurations cannot be mutated or deleted by tenant admins.
- [x] **Privilege Escalation Protection**: Organization Admins cannot provision Super Admins or disable the last Super Admin.

---

## 8. Security Audit Logging

- [x] **Structured Security Logs**: High-signal security events recorded via Pino with child request IDs and user contexts.
- [x] **Database Audit Trail**: Persisted to `audit_logs` table (`event, user_id, organization_id, request_id, ip_address, details_json, created_at`).
- [x] **Tracked Security Events**: `login_success`, `login_failure`, `logout`, `permission_denied`, `cross_tenant_access_denied`, `user_created`, `user_updated`, `user_disabled`, `user_enabled`, `config_updated`.

---

## 9. Automated Testing & Verification

- [x] **Selftest Suite** (`test/selftest.js`): 50+ assertions covering candidate assessment flow, grading, PDF generation, and admin CRUD (**ALL GREEN**).
- [x] **Validation & Error Suite** (`test/validation-and-errors.test.js`): 28 assertions verifying input boundaries, error mapping, and stack trace redaction (**ALL PASSED**).
- [x] **Security Hardening Suite** (`test/security-hardening.test.js`): 18 assertions verifying Helmet, CSP, CORS preflight, payload boundaries, rate limiting, stored XSS safety, and SQL parameterization (**ALL PASSED**).
- [x] **Authentication & RBAC Suite** (`test/auth-rbac.test.js`): 60+ assertions covering login security, JWT verification, session revocation, 5-role RBAC matrix, IDOR defense, and audit logging (**ALL PASSED**).
