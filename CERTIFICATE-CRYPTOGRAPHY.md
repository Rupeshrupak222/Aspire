# ASPIRE BY ADYAPAN — DIGITAL CREDENTIALS
# CRYPTOGRAPHIC ARCHITECTURE & SIGNING SPECIFICATION

---

## 1. Cryptographic Principles

The digital certificate verification architecture in Aspire is designed around four core tenets:

1. **Self-Sovereign Determinism**: Given a certificate payload and secret key, the signature computation is 100% deterministic and reproducible.
2. **Zero-Knowledge Privacy**: Public verifiers receive only authoritative academic merit outcomes. Internal candidate secrets (phone numbers, email addresses, student IDs, proctoring events) are excluded from the signed payload.
3. **Timing Invariance**: Signature validation utilizes constant-time comparison (`crypto.timingSafeEqual`) to prevent side-channel timing attacks.
4. **Key Rotation Resilience**: The platform supports versioned signing keys (`signing_key_id`), allowing secret rotations without invalidating historically signed credentials.

---

## 2. Canonical Payload Serialization

JSON serialization is notoriously indeterminate across environments due to key ordering and whitespace differences. Aspire enforces strict canonicalization:

```javascript
function canonicalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a non-null object');
  }

  const sortedKeys = Object.keys(payload).sort();
  const sortedObj = {};
  for (const key of sortedKeys) {
    const val = payload[key];
    sortedObj[key] = val;
  }

  return JSON.stringify(sortedObj);
}
```

### 2.1 Standard Signed Fields

Every issued certificate payload includes the following normalized fields:

| Field | Type | Description |
| :--- | :--- | :--- |
| `certificateId` | String | Format `ASP26-[0-9A-F]{12}` |
| `attemptId` | Number | Integer database ID of the completed assessment attempt |
| `organizationId` | Number | Multi-tenant organization ID |
| `organizationName` | String | Organization brand name |
| `studentId` | Number | Student database ID |
| `studentName` | String | Full name of the candidate |
| `examId` | Number | Examination ID |
| `examTitle` | String | Formal assessment title |
| `score` | Number | Points achieved |
| `totalMarks` | Number | Total available points |
| `percentage` | Number | Normalized percentage score (float) |
| `scholarshipPercentage` | Number | Awarded scholarship tier percentage (0 to 100) |
| `issuedAt` | String | ISO 8601 UTC timestamp of issuance |

---

## 3. Cryptographic Operations

### 3.1 Payload Hash Generation

The SHA-256 digest acts as a fingerprint for integrity checks:

$$\text{payloadHash} = \text{SHA-256}(\text{canonicalPayload})$$

```javascript
function createPayloadHash(canonicalJson) {
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}
```

### 3.2 HMAC-SHA256 Signature Generation

The signature seals the canonical payload using the designated signing key:

$$\text{signature} = \text{HMAC-SHA256}(\text{canonicalPayload}, K_{\text{signing}})$$

```javascript
function signCertificatePayload(canonicalJson, keyId = 'default') {
  const secret = getSigningKey(keyId);
  return crypto.createHmac('sha256', secret).update(canonicalJson, 'utf8').digest('hex');
}
```

### 3.3 Constant-Time Verification

To eliminate microarchitectural timing leaks, signatures are validated using constant-time byte buffers:

```javascript
function constantTimeSignatureCompare(sigA, sigB) {
  if (typeof sigA !== 'string' || typeof sigB !== 'string') return false;
  const bufA = Buffer.from(sigA, 'hex');
  const bufB = Buffer.from(sigB, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
```

---

## 4. Key Rotation Lifecycle

### 4.1 Key Storage & Selection

- The active signing key is controlled via `CERTIFICATE_SIGNING_KEY` and identified by `CERTIFICATE_SIGNING_KEY_ID`.
- Fallback signing secrets are derived from `AUTH_SECRET` or ephemeral cryptographically secure buffers.

### 4.2 Multi-Key Verification Matrix

```
┌──────────────────────────────────────────────┐
│ Verification Request: (payload, key_id, sig) │
└──────────────────────┬───────────────────────┘
                       │
             [Is key_id registered?]
             /                     \
           YES                      NO
           /                         \
┌─────────────────────┐    ┌──────────────────────────────────┐
│ Retrieve key_id key │    │ Fallback to active platform key │
└──────────┬──────────┘    └────────────────┬─────────────────┘
           │                                │
           ▼                                ▼
┌─────────────────────────────────────────────────────┐
│  Compute expected HMAC-SHA256 with designated key   │
└──────────────────────────┬──────────────────────────┘
                           │
             [timingSafeEqual(sig, expected)?]
             /                               \
           TRUE                             FALSE
           /                                   \
     ┌─────────────┐                      ┌─────────────┐
     │  VALID SIG  │                      │ INVALID SIG │
     └─────────────┘                      └─────────────┘
```

When an operational rotation occurs:
1. Retain the old key in the key registry with its historical `key_id`.
2. Configure the new active key in `.env` (`CERTIFICATE_SIGNING_KEY` and `CERTIFICATE_SIGNING_KEY_ID`).
3. New certificates are issued using the new key.
4. Historical certificates verify against their stored `signing_key_id` without disruption.

