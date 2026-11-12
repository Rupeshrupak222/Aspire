# ASPIRE BY ADYAPAN — DAY 24
# DIGITAL CERTIFICATE VERIFICATION SYSTEM
## Production Architectural Specification & System Guide

---

## 1. Executive Overview

Aspire by Adyapan's Digital Certificate Verification System elevates certificate generation from static PDF downloads into a cryptographically anchored, independently verifiable digital credential platform. 

Every newly issued assessment certificate is assigned a globally unique, high-entropy Certificate Identifier (`ASP26-XXXXXXXXXXXX`), sealed with a deterministic HMAC-SHA256 digital signature, embedded with a high-density QR code, and backed by a public, zero-login verification engine.

Recruiters, educational institutions, admissions officers, and employers worldwide can verify credential authenticity instantly by scanning the embedded QR code or querying the public credential portal.

---

## 2. Verification State Machine

The verification subsystem evaluates candidate credentials against a strict five-state integrity machine:

```
                      ┌──────────────────────┐
                      │   Query Identifier   │
                      └──────────┬───────────┘
                                 │
                     [Does Record Exist?]
                     /                  \
                   YES                   NO
                   /                      \
      ┌────────────────────────┐      ┌────────────────────────┐
      │ Check Integrity & Sig  │      │       NOT_FOUND        │
      └──────────┬─────────────┘      └────────────────────────┘
                 │
           [Valid Signature?]
           /                \
         YES                 NO
         /                    \
   ┌─────────────┐        ┌─────────────┐
   │ Check Status│        │   INVALID   │
   └──────┬──────┘        └─────────────┘
          │
    ┌─────┴───────────────┐
    │                     │
[Status == ACTIVE]   [Status == REVOKED]
    │                     │
    ▼                     ▼
┌─────────┐          ┌─────────┐
│  VALID  │          │ REVOKED │
└─────────┘          └─────────┘
```

| State | HTTP Status | Visual Appearance | Meaning |
| :--- | :--- | :--- | :--- |
| **VALID** | `200 OK` | Deep Green (`#22C55E`) Shield | Credential exists, cryptographic signature matches payload exactly, issuing tenant is active, and credential has not been revoked. |
| **REVOKED** | `200 OK` | Crimson Red (`#EF4444`) Alert | Credential was legitimately issued but subsequently invalidated by an authorized administrator (e.g. academic integrity violation). Revocation timestamp and official reason are displayed. |
| **INVALID** | `200 OK` | Amber Orange (`#F59E0B`) Warning | Certificate record exists but the computed HMAC-SHA256 signature does not match the payload. Indicates database tampering or corruption. |
| **NOT_FOUND** | `404 Not Found` | Slate Muted (`#94A3B8`) Neutral | No certificate with this identifier exists in the platform database. |
| **EXPIRED** | `200 OK` | Amber Muted | Credential has exceeded its formal validity period (when expiration policies are applied). |

---

## 3. High-Entropy Credential Identifiers

### 3.1 Identifier Specification

- **Prefix**: `ASP26-` (Representing *Aspire* cohort *2026*).
- **Entropy Body**: 12 uppercase hexadecimal characters (`[0-9A-F]{12}`).
- **Format**: `ASP26-[0-9A-F]{12}` (e.g., `ASP26-8E3885EEB4FE`).
- **Total Entropy**: $16^{12} = 2^{48} \approx 2.81 \times 10^{14}$ distinct combinations.

### 3.2 Security Properties

1. **Non-Sequential Randomness**: Generated via Node.js native `crypto.randomBytes(6)`, preventing ID enumeration and scraping.
2. **Zero PII Exposure**: The identifier contains zero candidate personal data (no student IDs, phone numbers, or dates of birth).
3. **Collision Resistance**: At $10^7$ issued certificates, collision probability remains below $1.7 \times 10^{-4}$ ($< 0.02\%$), safely resolved via database `UNIQUE` constraints and retry loops.

---

## 4. Cryptographic Integrity Architecture

### 4.1 Canonical Payload Serialization

To eliminate signature mismatch due to JSON key ordering, whitespace, or floating point formatting, all payloads are canonicalized prior to hashing:

```javascript
function canonicalizePayload(payload) {
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj = {};
  for (const key of sortedKeys) {
    sortedObj[key] = payload[key];
  }
  return JSON.stringify(sortedObj);
}
```

### 4.2 Canonical Signed Payload Fields

```json
{
  "attemptId": 44441,
  "certificateId": "ASP26-8E3885EEB4FE",
  "examId": 101,
  "examTitle": "Full Stack Software Engineering Assessment",
  "issuedAt": "2026-11-12T10:41:37.000Z",
  "organizationId": 2,
  "organizationName": "Alpha Institute of Technology",
  "percentage": 98.0,
  "scholarshipPercentage": 100,
  "score": 35,
  "studentName": "Leonardo da Vinci",
  "totalMarks": 35
}
```

### 4.3 HMAC-SHA256 Sealing

- **Payload Hash**: `SHA-256(canonicalPayload)` stored as hex digest in `payload_hash`.
- **Digital Signature**: `HMAC-SHA256(canonicalPayload, signingKey)` stored as hex digest in `signature`.
- **Verification**: Recomputes signature and executes constant-time byte comparison using `crypto.timingSafeEqual`.

---

## 5. QR Code Generation & PDF Layout

### 5.1 QR Code Specification

- **Engine**: Self-hosted `qrcode` node module (zero third-party API dependencies).
- **Target URL**: `https://aspire.adyapan.com/verify/ASP26-XXXXXXXXXXXX`.
- **Error Correction**: Level `H` (High — recovers up to 30% damaged or obscured QR code areas).
- **Output Formats**: High-resolution PNG buffer (for PDFKit vector embedding) and Base64 DataURL (for web display).
- **Zero Secret Leakage**: QR code contains only the public HTTPS verification URL.

### 5.2 PDF Credential Geometry

The existing landscape luxury certificate template (`backend/src/services/certificate.js`) embeds the digital verification assets:

- **QR Code Matrix**: Positioned at bottom-left (`x: 75, y: 460, size: 76x76pt`).
- **Authenticity Statement**: "DIGITALLY VERIFIED CREDENTIAL • SCAN OR VISIT TO CONFIRM AUTHENTICITY".
- **Unique Credential ID**: Prominently formatted in monospace gold below the QR block.
- **Direct Link**: Clean verification URL printed for manual transcription.
- **Cache-Control & Revocation**: Revoked certificates immediately return HTTP 410 Gone on `/api/public/certificate/:id`.

---

## 6. Public Zero-Login Verification Interface

The public verification page (`frontend/verify.html`) provides a responsive, brand-aligned inspection interface:

- **Route Handling**: Supports path parameter `/verify/:certificateId` and query parameter `/verify?id=...`.
- **Zero Login Barrier**: Freely accessible by external parties without credentials.
- **Candidate Privacy Protection**: Displays only academic merit data (Student Name, Exam Title, Score, Scholarship Awarded, Issue Date, Organization Name). Withholds phone numbers, emails, candidate IDs, and proctoring metadata.
- **State Badges**: Color-coded badges for `VALID`, `REVOKED`, `INVALID`, and `NOT_FOUND`.
- **Interactive Manual Lookup**: Search bar allowing visitors to verify any credential ID directly.

---

## 7. Administrative Controls & Revocation Lifecycle

### 7.1 Multi-Tenant Role Privileges

- **ORG_ADMIN**: Can list, search, inspect, and revoke certificates belonging strictly to their own tenant.
- **SUPER_ADMIN**: Platform-wide visibility across all tenant certificates, with global revocation authority.

### 7.2 Immediate Invalidation

Revoking a certificate:
1. Updates `verification_status = 'REVOKED'`, records `revocation_reason`, `revoked_at`, and `revoked_by_user_id`.
2. Appends an immutable record to `certificate_verification_events`.
3. Clears in-memory PDF caches immediately via `setClearCacheHook`.
4. Subsequent PDF downloads return `HTTP 410 Gone`.
5. Public verification immediately renders the crimson revoked state banner with the audit reason.

