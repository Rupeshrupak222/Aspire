// ============================================================================
// DAY 24 TEST 11: CERTIFICATE PDF CACHE & TENANT INVALIDATION
// ============================================================================

const assert = require('assert');
const {
  generateCertificate,
  getCertificateCacheKey,
  getCachedCertificate,
  clearCertificateCache,
  clearCertificateCacheForOrg,
  clearCertificateCacheForCert
} = require('../backend/src/services/certificate');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE PDF CACHE & INVALIDATION SUITE');
console.log('====================================================');

(async () => {
  clearCertificateCache();

  // --- 1. Cache Key Formatting ---
  console.log('\n--- 1. Cache Key Formatting ---');
  assert.strictEqual(getCertificateCacheKey(1, 'ASP26-AAA'), '1:ASP26-AAA');
  assert.strictEqual(getCertificateCacheKey(null, 'ASP26-BBB'), 'global:ASP26-BBB');
  console.log('  PASS  Cache keys properly scoped by tenant ID');

  // --- 2. Cache Hit & Identity ---
  console.log('\n--- 2. Cache Hit & Identity ---');
  const certId = 'ASP26-CACHE001';
  const pdf1 = await generateCertificate({
    name: 'Grace Hopper',
    percentage: 97.0,
    scholarshipPct: 100,
    certificateId: certId,
    dateStr: 'November 12, 2026',
    organizationId: 1
  });

  const cached = getCachedCertificate(1, certId);
  assert(cached !== null, 'Buffer must exist in cache');
  assert.strictEqual(cached, pdf1, 'Second fetch returns exact buffer instance from cache');
  console.log('  PASS  In-memory cache stores and serves exact PDF buffer');

  // --- 3. Invalidation by Specific Certificate ---
  console.log('\n--- 3. Invalidation by Specific Certificate ---');
  clearCertificateCacheForCert(1, certId);
  assert.strictEqual(getCachedCertificate(1, certId), null, 'Cache entry removed for specific certificate');
  console.log('  PASS  clearCertificateCacheForCert invalidates targeted entry');

  // --- 4. Invalidation by Organization ---
  console.log('\n--- 4. Invalidation by Organization ---');
  await generateCertificate({
    name: 'Grace Hopper',
    percentage: 97.0,
    scholarshipPct: 100,
    certificateId: 'ASP26-ORG1-A',
    dateStr: 'November 12, 2026',
    organizationId: 5
  });

  await generateCertificate({
    name: 'Grace Hopper',
    percentage: 97.0,
    scholarshipPct: 100,
    certificateId: 'ASP26-ORG1-B',
    dateStr: 'November 12, 2026',
    organizationId: 5
  });

  assert(getCachedCertificate(5, 'ASP26-ORG1-A') !== null);
  assert(getCachedCertificate(5, 'ASP26-ORG1-B') !== null);

  clearCertificateCacheForOrg(5);
  assert.strictEqual(getCachedCertificate(5, 'ASP26-ORG1-A'), null, 'Org 5 cert A cleared');
  assert.strictEqual(getCachedCertificate(5, 'ASP26-ORG1-B'), null, 'Org 5 cert B cleared');
  console.log('  PASS  clearCertificateCacheForOrg flushes all organization certificates');

  clearCertificateCache();
})();

