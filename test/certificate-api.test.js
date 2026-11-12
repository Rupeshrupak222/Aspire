// ============================================================================
// DAY 24 TEST 13: CERTIFICATE EXPRESS REST API ENDPOINTS
// ============================================================================

const assert = require('assert');
const request = require('supertest');
const createApp = require('../backend/src/app');
const app = createApp();
const { db } = require('../backend/src/db');
const { signAccessToken } = require('../backend/src/security/jwt');
const certService = require('../backend/src/services/certificate/certificate.service');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE EXPRESS REST API SUITE');
console.log('====================================================');

(async () => {
  // Setup test tokens
  const user = db.prepare("SELECT id, email, role, organization_id, token_version FROM users WHERE role = 'ORG_ADMIN' LIMIT 1").get();
  const superUser = db.prepare("SELECT id, email, role, organization_id, token_version FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1").get();
  const superAdminToken = await signAccessToken({ sub: String(superUser.id), email: superUser.email, role: 'SUPER_ADMIN', token_version: superUser.token_version });
  const orgAdminToken = await signAccessToken({ sub: String(user.id), email: user.email, role: 'ORG_ADMIN', organization_id: user.organization_id, token_version: user.token_version });

  // Issue test certificate
  const { certificate: cert } = certService.issueCertificate({
    attemptId: 44441,
    organizationId: user.organization_id,
    studentId: 2221,
    studentName: 'Leonardo da Vinci',
    examId: 101,
    examTitle: 'Engineering & Renaissance Polymath Evaluation',
    score: 98,
    totalMarks: 100,
    percentage: 98.0,
    scholarshipPct: 100
  });

  // --- 1. GET /api/public/certificates/verify/:id ---
  console.log('\n--- 1. Public Verification Endpoints ---');
  const pubRes = await request(app)
    .get(`/api/public/certificates/verify/${cert.certificate_id}`)
    .expect(200);

  assert.strictEqual(pubRes.body.status, 'VALID');
  assert.strictEqual(pubRes.body.data.certificateId, cert.certificate_id);
  assert.strictEqual(pubRes.body.data.studentName, 'Leonardo da Vinci');
  console.log('  PASS  GET /api/public/certificates/verify/:id returns 200 VALID');

  // Unknown certificate
  await request(app)
    .get('/api/public/certificates/verify/ASP26-UNKNOWN9999')
    .expect(404);
  console.log('  PASS  GET /api/public/certificates/verify/:id returns 404 for unknown ID');

  // Alternative route alias
  const aliasRes = await request(app)
    .get(`/api/public/verify/${cert.certificate_id}`)
    .expect(200);
  assert.strictEqual(aliasRes.body.status, 'VALID');
  console.log('  PASS  GET /api/public/verify/:id alias functions correctly');

  // --- 2. Organization Admin Endpoints ---
  console.log('\n--- 2. Organization Admin Endpoints ---');
  const listRes = await request(app)
    .get('/api/organization/certificates?limit=10')
    .set('Authorization', `Bearer ${orgAdminToken}`)
    .expect(200);

  assert(listRes.body.success === true);
  assert(Array.isArray(listRes.body.data.certificates));
  console.log('  PASS  GET /api/organization/certificates returns tenant list');

  const detailRes = await request(app)
    .get(`/api/organization/certificates/${cert.certificate_id}`)
    .set('Authorization', `Bearer ${orgAdminToken}`)
    .expect(200);

  assert.strictEqual(detailRes.body.data.certificate.certificate_id, cert.certificate_id);
  assert(Array.isArray(detailRes.body.data.history));
  console.log('  PASS  GET /api/organization/certificates/:id returns details and history');

  // Revoke via Organization Admin API
  const revokeRes = await request(app)
    .post(`/api/organization/certificates/${cert.certificate_id}/revoke`)
    .set('Authorization', `Bearer ${orgAdminToken}`)
    .send({ reason: 'Disqualified due to unverified identification' })
    .expect(200);

  assert(revokeRes.body.success === true);
  assert.strictEqual(revokeRes.body.data.verification_status, 'REVOKED');
  console.log('  PASS  POST /api/organization/certificates/:id/revoke updates status');

  // Verify public endpoint immediately reflects revoked status
  const postRevokeRes = await request(app)
    .get(`/api/public/certificates/verify/${cert.certificate_id}`)
    .expect(200);
  assert.strictEqual(postRevokeRes.body.status, 'REVOKED');
  console.log('  PASS  Public verification endpoint immediately reflects revoked status');

  // --- 3. Super Admin Endpoints ---
  console.log('\n--- 3. Super Admin Endpoints ---');
  const adminListRes = await request(app)
    .get('/api/admin/certificates?limit=10')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .expect(200);

  assert(adminListRes.body.success === true);
  assert(Array.isArray(adminListRes.body.data.certificates));
  console.log('  PASS  GET /api/admin/certificates returns cross-tenant platform list');

  // Clean up
  db.prepare('DELETE FROM certificate_verification_events WHERE certificate_id = ?').run(cert.certificate_id);
  db.prepare('DELETE FROM certificates WHERE certificate_id = ?').run(cert.certificate_id);
  console.log('  PASS  Test fixtures cleaned up');
})();
