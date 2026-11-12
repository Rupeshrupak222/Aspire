// ============================================================================
// DAY 24 TEST 9: MULTI-TENANT ISOLATION & RBAC BOUNDARIES
// ============================================================================

const assert = require('assert');
const { db } = require('../backend/src/db');
const certService = require('../backend/src/services/certificate/certificate.service');

console.log('====================================================');
console.log('DAY 24: MULTI-TENANT ISOLATION SUITE');
console.log('====================================================');

// Setup two certificates across two different organizations
const { certificate: certOrg1 } = certService.issueCertificate({
  attemptId: 55551,
  organizationId: 1,
  studentId: 3331,
  studentName: 'Candidate Alpha',
  examId: 101,
  examTitle: 'Org 1 Technical Assessment',
  score: 90,
  totalMarks: 100,
  percentage: 90.0,
  scholarshipPct: 100
});

const { certificate: certOrg2 } = certService.issueCertificate({
  attemptId: 55552,
  organizationId: 2,
  studentId: 3332,
  studentName: 'Candidate Beta',
  examId: 102,
  examTitle: 'Org 2 Scholarship Test',
  score: 85,
  totalMarks: 100,
  percentage: 85.0,
  scholarshipPct: 50
});

// --- 1. Cross-Tenant Revocation Prevention ---
console.log('\n--- 1. Cross-Tenant Revocation Prevention ---');
let crossTenantBlocked = false;
try {
  // Org 1 admin attempting to revoke Org 2 certificate
  certService.revokeCertificate({
    certificateId: certOrg2.certificate_id,
    organizationId: 1, // Wrong organization!
    reason: 'Malicious cross-tenant attempt',
    revokedByUserId: 10
  });
} catch (err) {
  crossTenantBlocked = true;
  assert(err.message.includes('Cannot revoke certificate belonging to another organization') || err.status === 403);
}
assert.strictEqual(crossTenantBlocked, true, 'Cross-tenant revocation must be rejected with AuthorizationError');
console.log('  PASS  Cross-tenant certificate revocation strictly blocked');

// --- 2. Tenant Scoped Listing ---
console.log('\n--- 2. Tenant Scoped Listing ---');
const org1List = certService.listCertificates({ organizationId: 1 });
const org1Ids = org1List.certificates.map(c => c.certificate_id);
assert(org1Ids.includes(certOrg1.certificate_id), 'Org 1 list contains certOrg1');
assert(!org1Ids.includes(certOrg2.certificate_id), 'Org 1 list does NOT contain certOrg2');

const org2List = certService.listCertificates({ organizationId: 2 });
const org2Ids = org2List.certificates.map(c => c.certificate_id);
assert(!org2Ids.includes(certOrg1.certificate_id), 'Org 2 list does NOT contain certOrg1');
assert(org2Ids.includes(certOrg2.certificate_id), 'Org 2 list contains certOrg2');
console.log('  PASS  Certificate listings strictly isolated by tenant');

// --- 3. Super Admin Platform-Wide Scope ---
console.log('\n--- 3. Super Admin Platform-Wide Scope ---');
const globalList = certService.listCertificates({ organizationId: null });
const globalIds = globalList.certificates.map(c => c.certificate_id);
assert(globalIds.includes(certOrg1.certificate_id), 'Global list includes Org 1 cert');
assert(globalIds.includes(certOrg2.certificate_id), 'Global list includes Org 2 cert');

// Super Admin can revoke any certificate regardless of org
const superRevoked = certService.revokeCertificate({
  certificateId: certOrg2.certificate_id,
  organizationId: null, // Super Admin scope
  reason: 'Super Admin administrative action',
  revokedByUserId: 1
});
assert.strictEqual(superRevoked.verification_status, 'REVOKED', 'Super Admin successfully revoked certificate');
console.log('  PASS  Super Admin possesses global cross-tenant management capability');

// --- 4. Public Verification is Tenant-Agnostic ---
console.log('\n--- 4. Public Verification is Tenant-Agnostic ---');
// Public verifier does not supply organizationId, yet verifies correctly
const publicCheck1 = certService.verifyCertificate(certOrg1.certificate_id);
assert.strictEqual(publicCheck1.status, 'VALID', 'Public check verifies Org 1 certificate');

const publicCheck2 = certService.verifyCertificate(certOrg2.certificate_id);
assert.strictEqual(publicCheck2.status, 'REVOKED', 'Public check verifies Org 2 certificate');
console.log('  PASS  Public verification operates without requiring visitor tenant context');

// Clean up
db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id IN (?, ?)').run(
  certOrg1.certificate_id, certOrg2.certificate_id
);
db.prepare('DELETE FROM certificates WHERE certificate_id IN (?, ?)').run(
  certOrg1.certificate_id, certOrg2.certificate_id
);
console.log('  PASS  Test fixtures cleaned up');

