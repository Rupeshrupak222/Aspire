# ASPIRE BY ADYAPAN — DIGITAL CREDENTIALS
# CERTIFICATE VERIFICATION REST API SPECIFICATION

---

## 1. Overview & Authentication Matrix

Aspire exposes endpoints for public verification (zero authentication required) and administrative management (role-based access control with tenant isolation).

| Endpoint | Method | Role | Rate Limit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `/api/public/certificates/verify/:id` | `GET` | Public | 60 req/min | Primary public verification endpoint |
| `/api/public/verify/:id` | `GET` | Public | 60 req/min | Route alias for short QR code scanning |
| `/api/public/certificate/:id` | `GET` | Public | 30 req/min | Download certificate PDF (returns 410 if revoked) |
| `/verify/:id?` | `GET` | Public | Standard | Serves the HTML verification web page |
| `/api/organization/certificates` | `GET` | `ORG_ADMIN` | Standard | List tenant certificates with search & pagination |
| `/api/organization/certificates/:id` | `GET` | `ORG_ADMIN` | Standard | Get certificate detail and verification history |
| `/api/organization/certificates/:id/revoke` | `POST` | `ORG_ADMIN` | Standard | Revoke tenant certificate with mandatory reason |
| `/api/organization/certificates/:id/reissue` | `POST` | `ORG_ADMIN` | Standard | Reissue certificate with new cryptographic seal |
| `/api/admin/certificates` | `GET` | `SUPER_ADMIN` | Standard | Platform-wide certificate listing across tenants |
| `/api/admin/certificates/:id/revoke` | `POST` | `SUPER_ADMIN` | Standard | Emergency cross-tenant certificate revocation |

---

## 2. Public Verification Endpoint

### `GET /api/public/certificates/verify/:certificateId`

#### Path Parameters
- `certificateId` (String, Required): Format `ASP26-[0-9A-F]{12}`.

#### Success Response: Valid Certificate (`200 OK`)

```json
{
  "status": "VALID",
  "data": {
    "certificateId": "ASP26-8E3885EEB4FE",
    "verificationStatus": "VALID",
    "studentName": "Leonardo da Vinci",
    "examTitle": "Renaissance Polymath Evaluation",
    "finalScore": 98,
    "totalMarks": 100,
    "percentage": 98.0,
    "scholarshipPercentage": 100,
    "organizationName": "Alpha Institute of Technology",
    "issuedAt": "2026-11-12T10:41:37.000Z",
    "verifiedAt": "2026-11-12T11:05:22.148Z"
  }
}
```

#### Success Response: Revoked Certificate (`200 OK`)

```json
{
  "status": "REVOKED",
  "data": {
    "certificateId": "ASP26-8E3885EEB4FE",
    "verificationStatus": "REVOKED",
    "studentName": "Leonardo da Vinci",
    "examTitle": "Renaissance Polymath Evaluation",
    "organizationName": "Alpha Institute of Technology",
    "issuedAt": "2026-11-12T10:41:37.000Z",
    "revocation": {
      "reason": "Academic integrity review violation (proctoring flag)",
      "revokedAt": "2026-11-12T11:15:00.000Z"
    },
    "verifiedAt": "2026-11-12T11:20:00.000Z"
  }
}
```

#### Integrity Failure: Tampered Certificate (`200 OK`)

```json
{
  "status": "INVALID",
  "data": {
    "certificateId": "ASP26-8E3885EEB4FE",
    "verificationStatus": "INVALID",
    "error": "Cryptographic signature mismatch. Credential has been altered.",
    "verifiedAt": "2026-11-12T11:25:00.000Z"
  }
}
```

#### Error Response: Not Found (`404 Not Found`)

```json
{
  "status": "NOT_FOUND",
  "error": "Certificate with ID ASP26-NONEXISTENT does not exist."
}
```

---

## 3. Administrative Management Endpoints

### `GET /api/organization/certificates`

#### Headers
- `Authorization: Bearer <JWT>`

#### Query Parameters
- `page` (Integer, default 1)
- `limit` (Integer, default 20, max 100)
- `status` (Enum: `ALL`, `VALID`, `REVOKED`)
- `search` (String, searches `certificate_id` and `student_name`)

#### Response (`200 OK`)

```json
{
  "success": true,
  "data": {
    "certificates": [
      {
        "certificate_id": "ASP26-8E3885EEB4FE",
        "student_name": "Leonardo da Vinci",
        "exam_title": "Renaissance Polymath Evaluation",
        "final_score": 98,
        "percentage": 98.0,
        "scholarship_percentage": 100,
        "verification_status": "VALID",
        "issued_at": "2026-11-12T10:41:37.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

### `POST /api/organization/certificates/:certificateId/revoke`

#### Headers
- `Authorization: Bearer <JWT>`

#### Request Body
```json
{
  "reason": "Failed academic identity re-verification audit."
}
```

#### Response (`200 OK`)

```json
{
  "success": true,
  "message": "Certificate ASP26-8E3885EEB4FE successfully revoked",
  "data": {
    "certificate_id": "ASP26-8E3885EEB4FE",
    "verification_status": "REVOKED",
    "revocation_reason": "Failed academic identity re-verification audit.",
    "revoked_at": "2026-11-12T11:30:00.000Z"
  }
}
```

