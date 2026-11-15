# DAY 27 — MONITORING, LOGGING & ALERTS AUDIT
## Aspire by Adyapan — Multi-Tenant SaaS Assessment Platform Observability Audit

**Audit Date**: November 2026  
**Auditor**: Senior Systems, SRE & Backend Infrastructure Architecture Team  
**Scope**: Production Observability, Structured Logging, Error Tracking, Health Probes, BullMQ & Worker Telemetry, Operational Metrics, Alerting Pipeline, and Admin Dashboards  
**Status**: Completed Pre-Implementation Assessment

---

## 1. Executive Summary

Aspire by Adyapan is a high-stakes, multi-tenant scholarship assessment and code evaluation platform. As candidate assessment volume, institutional tenancy, and background execution workloads expand across Days 1–25, systemic observability becomes mission-critical.

This audit evaluates the platform's current monitoring readiness across 10 foundational dimensions, uncovers architectural observability gaps, and outlines a production-ready engineering plan to achieve robust observability without coupling to ephemeral production environments (Day 26 Docker deployment is on hold; all implementations must be fully verifiable locally with pluggable production adapters).

---

## 2. Core Audit Findings (10 Evaluation Criteria)

| # | Audit Criterion | Current Implementation Status | Evaluation & Gap Analysis |
|---|----------------|--------------------------------|---------------------------|
| **1** | **Which errors are currently logged?** | Partial | Express centralized error handler maps known errors (`SqliteError`, Zod, `Judge0`, `ExternalServiceError`) and logs via Pino. However, background worker job failures and startup/shutdown errors use unformatted `console.error` in `server.js` and worker scripts. |
| **2** | **Are logs structured JSON?** | Yes in Production, Pretty in Dev | Uses Pino v10 in `backend/src/utils/logger.js`. In production, logs output standard single-line structured JSON with ISO timestamps (`pino.stdTimeFunctions.isoTime`). In development, `pino-pretty` is optionally loaded. |
| **3** | **Do request IDs exist?** | Yes, Partial Propagation | `backend/src/middleware/request-id.js` binds `req.id` (`req_<hex>`) or accepts incoming `X-Request-Id`, binds child logger `req.log`, sets `X-Request-Id` response header, and logs status code and duration. **Gap**: `X-Request-Id` lacks strict regex validation (accepts arbitrary user input) and is not uniformly forwarded through the transactional outbox to BullMQ job payloads. |
| **4** | **Are stack traces exposed to clients?** | Protected / Not Exposed | `backend/src/middleware/error-handler.js` scrubs internal stack traces from API JSON responses (only sending `code`, `message`, and validation fields). Stacks are logged server-side only when `!isOperational`. |
| **5** | **Can sensitive data enter logs?** | Low Risk, Needs Extension | Pino config defines redaction paths for passwords, `ADMIN_TOKEN`, `AUTH_SECRET`, JWT secrets, and API keys. **Gap**: Verification OTPs (`req.body.otp`), email verification tokens (`req.query.token`), and campaign IP headers are not explicitly in the redaction paths. |
| **6** | **Are worker failures visible?** | Partially Visible | BullMQ `worker.on('failed')` logs errors via Pino, but there is no centralized failure counter, dead-letter queue alert, or heartbeat registry to detect silent worker crashes or stalled tasks. |
| **7** | **Can queue backlog be measured?** | Yes, Queue-Level Metrics Available | Both `codeExecutionQueue.getQueueMetrics()` and `notificationQueue.getQueueMetrics()` query BullMQ counts (`waiting`, `active`, `completed`, `failed`, `delayed`). **Gap**: Stalled job counts, oldest waiting job latency, and aggregated outbox backlog metrics are not exposed in unified health probes. |
| **8** | **Do health checks test actual dependencies?** | Incomplete | Current `/health` and `/api/health` check `checkDbHealth()` (`SELECT 1`) and static `executionService.getStatus()`. They do NOT test Redis connectivity, BullMQ queue readiness, worker heartbeats, outbox processing, or email delivery provider configuration. |
| **9** | **Can errors be correlated across requests and workers?** | Disconnected | While API requests have `requestId`, outbox events in SQLite and jobs in BullMQ generate independent identifiers without preserving the triggering `requestId` or `correlationId`. |
| **10** | **Which monitoring integrations are present?** | Pino + In-Memory Metrics | Pino logging and `backend/src/utils/metrics.js` (event-loop lag, CPU, memory, route latency percentiles) are present. There are zero external error-tracking SDKs (Sentry/GlitchTip), zero alert dispatchers (Discord/Telegram), and no worker heartbeat table. |

---

## 3. Detailed Architectural Gap Analysis

### 3.1 Logging & Request Correlation Gaps
1. **Unsanitized Inbound `X-Request-Id`**:
   The current middleware accepts any arbitrary `x-request-id` header without format validation or length capping, creating log injection or spoofing risks.
2. **Missing Correlation Context Across Asynchronous Boundaries**:
   When an assessment action creates an outbox event (e.g. `coding_submissions` or `notifications`), the originating `requestId` is lost. Tracing a failure from a candidate submission in `POST /api/attempt/:token/submit-code` to the BullMQ worker requires grepping across disconnected logs.
3. **Log Redaction Holes**:
   Day 25 candidate verification endpoints (`POST /api/auth/candidate/verify-otp`, `GET /api/auth/candidate/verify-email`) handle high-sensitivity OTP codes and single-use hashes. Redaction rules in `logger.js` must explicitly sanitize `otp`, `code`, `verification_token`, `token_hash`, and candidate credential payloads.

### 3.2 Error Tracking Architecture (GlitchTip vs Sentry Evaluation)
- **Sentry Developer Tier**: Commercial SaaS, robust SDK (`@sentry/node`), strict rate limits, vendor lock-in.
- **GlitchTip**: Open-source, Sentry-compatible API, self-hostable, zero vendor lock-in, uses standard Sentry envelope ingestion protocol.
- **Decision & Strategy**:
  Implement a vendor-agnostic **Error Tracking Adapter** (`backend/src/services/monitoring/error-tracking.service.js`).
  - Native fallback/mock adapter for test environments and when DSN is unconfigured.
  - Zero crashes when offline or when network requests to Sentry/GlitchTip fail.
  - Client-side error tracking helper for candidate-facing pages with strict PII filtering (no source code, answers, or credentials attached).

### 3.3 Health Probes & Deep Diagnostics
- Modern container orchestration (Kubernetes, Nomad, Docker Compose) mandates separating **Liveness** from **Readiness**:
  - `GET /health/live`: Fast process survival probe (returns 200 OK immediately if Node event loop is responsive; zero DB queries).
  - `GET /health/ready`: Traffic acceptance probe (verifies SQLite WAL is readable/writable and Redis connection is healthy).
  - `GET /api/admin/monitoring/health/detailed` (Protected): Exhaustive dependency diagnostic reporting SQLite stats, Redis latency, BullMQ queue depths, worker heartbeats, outbox backlog, and email/code provider operational readiness.

### 3.4 Worker Heartbeats & Queue Backlog
- Currently, if the `code-execution.worker` or `notification.worker` crashes due to an unhandled native segfault or out-of-memory error:
  - Jobs pile up in `waiting` state indefinitely.
  - The API continues to return 200 OK without notifying administrators.
- **Remedy**:
  - Introduce an authoritative `worker_heartbeats` table in SQLite with `last_heartbeat_at`, `status`, `pid`, and `metadata_json`.
  - Workers emit a periodic heartbeat every 10 seconds.
  - The monitoring service flags workers as `STALE` (> 30s) or `DEAD` (> 60s) and generates automated alerts.

### 3.5 Alerting Pipeline (Discord & Telegram)
- Absence of real-time operational notifications forces administrators to manually inspect logs.
- Need a robust alerting service supporting:
  - **Discord Webhook Provider**: Formatted rich embeds with severity colors (Red for P0, Orange for P1, Yellow for P2, Blue for P3).
  - **Telegram Bot Provider**: Formatted HTML alerts with direct operational actions.
  - **Deduplication & Cooldown**: Sliding-window deduplication to avoid alert storms (e.g., single incident notification during prolonged Redis outages).
  - **Auto-Recovery Notifications**: Automatic resolution message when a degraded service resumes normal health.

---

## 4. Implementation Roadmap & Milestones

1. **Database Migration `020_monitoring_observability`**:
   - `worker_heartbeats` table: Tracks worker health, PID, host, and heartbeat timestamp.
   - `alert_incidents` table: Durable record of triggered, resolved, and cooldown alert states.
2. **Structured Logging Enhancements**:
   - Enhanced `backend/src/utils/logger.js` with comprehensive redaction paths.
   - Hardened `backend/src/middleware/request-id.js` with correlation ID propagation.
3. **Error Tracking Engine**:
   - Pluggable error tracking adapter (`error-tracking.service.js`) supporting GlitchTip/Sentry protocols and graceful degradation.
4. **Health Check Probes**:
   - Explicit `/health/live`, `/health/ready`, and protected `/api/admin/monitoring/overview`.
5. **Worker Heartbeat & Queue Telemetry**:
   - Instrument BullMQ workers and outbox dispatcher with automatic background heartbeats.
6. **Operational Metrics & Threshold Monitor**:
   - Extend `metrics.js` with operational failure counters, error rates, and queue backlog ages.
7. **Multi-Channel Alert Dispatcher**:
   - Alert service with Discord, Telegram, and mock test providers, with deduplication and recovery notifications.
8. **Admin Operations Dashboard UI**:
   - Integrated "Monitoring" tab in `admin.html` with real-time health badges, worker status, queue depths, error rates, and manual alert test triggers.
9. **Automated Test Suite**:
   - Dedicated `npm run test:day27` test suite validating logging, redaction, health probes, worker heartbeats, alerts, and security isolation.
10. **Engineering Documentation & Runbooks**:
    - Complete incident response runbook and configuration manuals.

---

## 5. Security and Privacy Boundaries

- **Zero Secret Leakage**: Passwords, OTP codes, bearer tokens, certificate private keys, and candidate source code are systematically excluded from log streams, Sentry error payloads, and webhook alert bodies.
- **Tenant Isolation**: Operational infrastructure metrics are restricted strictly to `SUPER_ADMIN`. Organization administrators cannot access global Redis, worker, or platform infrastructure telemetry.
- **Non-Blocking Observability**: Failure of an external monitoring service (e.g. Sentry DNS timeout or Discord 504 Gateway Timeout) will NEVER disrupt candidate test attempts, question serving, or database transactions.

