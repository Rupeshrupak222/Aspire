# ASPIRE BY ADYAPAN — SRE & OPERATIONS RUNBOOK
# DIGITAL CERTIFICATE REVOCATION, REISSUANCE & COMPROMISE PROTOCOL

---

## 1. Standard Operating Procedures (SOP)

### 1.1 Grounds for Revocation

A certificate may only be revoked under one of the following documented criteria:

1. **Academic Dishonesty / Proctoring Breach**: Post-assessment forensic review confirmed multiple faces, unapproved browser tabs, or code plagiarism.
2. **Identity Impersonation**: Candidate identity verification failed upon enrollment or scholarship disbursement.
3. **Clerical or Scoring Error**: Erroneous answer key correction or question invalidation altered candidate scores.
4. **Administrative Supersession**: Candidate re-took the assessment under permitted circumstances, producing a superseded credential.

### 1.2 Step-by-Step Revocation Procedure

#### Via Organization Admin Portal
1. Navigate to **Certificates** (`#tab-certificates`) in the Aspire Admin Dashboard.
2. Search for the Certificate ID (e.g. `ASP26-XXXXXXXXXXXX`) or Candidate Name.
3. Review candidate details, score, attempt timestamps, and verification status.
4. Click **Revoke Certificate**.
5. Input the formal **Revocation Reason** (mandatory; minimum 5 characters).
6. Click **Confirm Revocation**.
7. Confirm that the status badge changes from `VALID` to `REVOKED`.

#### Via REST API (Automated Systems)
```bash
curl -X POST https://aspire.adyapan.com/api/organization/certificates/ASP26-8E3885EEB4FE/revoke \
  -H "Authorization: Bearer <ORG_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Identity verification failed on enrollment"}'
```

---

## 2. Reissuance Runbook

When a credential requires reissuance (e.g., candidate legally updated their name or a legitimate regrading occurred):

1. **Never mutate the historical record directly**.
2. Call the reissuance endpoint with the updated parameters:
   ```bash
   curl -X POST https://aspire.adyapan.com/api/organization/certificates/ASP26-8E3885EEB4FE/reissue \
     -H "Authorization: Bearer <ORG_ADMIN_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "reason": "Official legal name amendment",
       "studentName": "Leonardo Ser Piero da Vinci"
     }'
   ```
3. The platform automatically:
   - Revokes the old certificate (`ASP26-8E3885EEB4FE`) with reason "Reissued as ASP26-NEWID: Official legal name amendment".
   - Generates a new certificate (`ASP26-NEWID`) linked back to the historical attempt.
   - Sets `reissued_as_certificate_id` on the old record and `supersedes_certificate_id` on the new record.
   - Clears the PDF document cache.

---

## 3. Cache Invalidation Verification

When a certificate is revoked, the system invalidates both memory and HTTP edge caches:

1. **PDF Endpoint**:
   ```bash
   curl -I https://aspire.adyapan.com/api/public/certificate/ASP26-REVOKEDID
   ```
   **Expected Response**: `HTTP/1.1 410 Gone`.

2. **Public Verification Endpoint**:
   ```bash
   curl https://aspire.adyapan.com/api/public/certificates/verify/ASP26-REVOKEDID
   ```
   **Expected Response**: `200 OK` with `"status": "REVOKED"` and populated `revocation` object.

---

## 4. Emergency Incident Playbook: Key Compromise

In the unlikely event of a suspected leak of `CERTIFICATE_SIGNING_KEY`:

### Immediate Actions
1. **Rotate the Active Secret**:
   Generate a new cryptographically random 256-bit secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update the environment variables:
   ```env
   CERTIFICATE_SIGNING_KEY_ID=key_2026_v2
   CERTIFICATE_SIGNING_KEY=<new_hex_secret>
   ```
3. Register the compromised key in historical read-only mode if legitimate certificates were issued with it prior to the compromise incident.
4. Restart all API instances.
5. Review the `certificate_verification_events` table for abnormal spikes in verification attempts or invalid signatures:
   ```sql
   SELECT verifier_ip, count(*) as count 
   FROM certificate_verification_events 
   WHERE verification_status = 'INVALID' 
   GROUP BY verifier_ip 
   ORDER BY count DESC;
   ```

