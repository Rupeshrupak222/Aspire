# ASPIRE — AUTHENTICATION ARCHITECTURE & IDENTITY SPECIFICATION

## 1. Overview & Security Model

Day 4 evolved Aspire from a single shared development secret token (`x-admin-token`) into a production-ready, SaaS-compatible administrative identity and authentication architecture.

```text
Admin User
   ↓ (email + password)
POST /api/auth/login
   ↓ Rate Limiting (10 attempts / 15m)
Normalize Email + Verify bcrypt Password Hash
   ↓
Generate Server-Side Session Record (`sessions` table)
   ↓
Sign Ephemeral JWT with `jose` (HS256)
   ↓ Return { token, user: { id, email, name, role, organization_id, permissions } }
Admin Client
   ↓ (Authorization: Bearer <token>)
requireAuth Middleware
   ↓ Verify Token Cryptography (`jose`)
   ↓ Verify Session Not Revoked (`sessions` table)
   ↓ Verify Account Status (`users.status === 'ACTIVE'`)
   ↓ Verify Token Version (`token_version` match)
Attached `req.user`
```

---

## 2. Cryptographic Technologies

1. **JWT Operations**: Implemented using [`jose`](https://github.com/panva/jose) standard library.
   - Algorithm: `HS256` (HMAC with SHA-256).
   - Secret source: `process.env.AUTH_SECRET` (or `process.env.JWT_SECRET`).
   - In production (`NODE_ENV === 'production'`), startup halts immediately if `AUTH_SECRET` is unset.
2. **Password Hashing**: Implemented using `bcrypt`.
   - Work factor: `10` rounds in production/dev (~60ms); `6` rounds in test mode.
   - Passwords are never stored in plaintext, never logged, and never returned in API payloads.
3. **Session IDs & Hashes**:
   - Cryptographically random 24-byte hex session IDs (`crypto.randomBytes(24)`).
   - Session tokens hashed with SHA-256 for persistent database storage and lookup.

---

## 3. Endpoints

### 3.1 Login — `POST /api/auth/login`
- **Rate Limit**: 10 attempts per 15 minutes per IP (`authLoginLimiter`).
- **Request Body**:
  ```json
  {
    "email": "admin@example.com",
    "password": "SecurePassword123!"
  }
  ```
- **Response** (HTTP 200):
  ```json
  {
    "success": true,
    "data": {
      "user": {
        "id": 1,
        "email": "admin@example.com",
        "name": "Platform Administrator",
        "role": "SUPER_ADMIN",
        "organization_id": null,
        "organization_name": null,
        "permissions": [ ... ]
      },
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
  ```
- **Error Behavior**:
  - Inexistent email or incorrect password returns HTTP 401 with generic message: `"Invalid email or password."` to eliminate account enumeration vectors.
  - Constant-time verification dummy hashing is executed even when user does not exist to mitigate timing attacks.

### 3.2 Logout — `POST /api/auth/logout`
- **Authentication**: Requires valid `Authorization: Bearer <token>`.
- **Action**: Immediately purges the session ID from the `sessions` table.
- **Revocation**: Any future request using this token will be rejected immediately with HTTP 401 (`"Session has expired or was revoked. Please log in again."`).

### 3.3 Identity Verification — `GET /api/auth/me`
- **Authentication**: Requires valid `Authorization: Bearer <token>`.
- **Response**: Returns the sanitized user profile, assigned role, organization membership, and active permissions array.

---

## 4. Token & Session Lifetime Architecture

| Component | Setting | Invalidation Mechanism |
|---|---|---|
| **Access Token (JWT)** | Lifetime: 2 hours | Cryptographic expiration (`exp` claim) + server-side session check |
| **Server-Side Session** | Stored in `sessions` table | Explicit `POST /api/auth/logout`, account disable, or password reset |
| **Token Versioning** | `users.token_version` column | Incremented on role change, password update, or account suspension |

### Immediate Invalidation Triggers:
1. **User Logout**: Deletes active session record from SQLite.
2. **Account Disablement (`status = 'DISABLED'`)**: Increments `token_version` and deletes all sessions for the user. Future calls fail instantly with HTTP 401.
3. **Password Change**: Increments `token_version` and flushes all sessions across devices.
4. **Role Modification**: Increments `token_version` to prevent privilege retention from previously issued tokens.

---

## 5. Administrative Bootstrap

Initial platform administrator creation:
- **CLI Command**:
  ```bash
  npm run bootstrap:admin -- --email=admin@adyapan.internal --password=SecurePassword123! --name="Platform Administrator"
  ```
- **Environment Variables**:
  ```bash
  INITIAL_ADMIN_EMAIL=admin@adyapan.internal
  INITIAL_ADMIN_PASSWORD=SecurePassword123!
  ```
  Automatically provisioned on server startup if no active `SUPER_ADMIN` exists.
- In local development (`NODE_ENV !== 'production'`), if no credentials are provided, a one-time random password is generated and printed to console.
