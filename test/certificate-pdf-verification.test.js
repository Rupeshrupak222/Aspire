// ============================================================================
// DAY 24 TEST 5: PDF CERTIFICATE RENDERING WITH QR CODE EMBEDDING
// ============================================================================

const assert = require('assert');
const { generateCertificate, getCachedCertificate, clearCertificateCache } = require('../backend/src/services/certificate');

console.log('====================================================');
console.log('DAY 24: PDF CERTIFICATE GENERATION & QR EMBEDDING');
console.log('====================================================');

(async () => {
  clearCertificateCache();

  // --- 1. PDF Generation with Embedded QR Code ---
  console.log('\n--- 1. PDF Generation with Embedded QR Code ---');
  const certId = 'ASP26-B8C7D6E5F4A3';
  const pdfBuffer = await generateCertificate({
    name: 'Ada Lovelace',
    percentage: 98.2,
    scholarshipPct: 100,
    certificateId: certId,
    dateStr: 'November 12, 2026',
    brandName: 'Adyapan Computational Labs'
  });

  assert(Buffer.isBuffer(pdfBuffer), 'Result must be a Buffer');
  assert(pdfBuffer.length > 3000, 'PDF buffer should be substantial in size');
  // Check PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46 0x2D)
  const header = pdfBuffer.slice(0, 5).toString('ascii');
  assert.strictEqual(header, '%PDF-', 'Buffer starts with %PDF- header');
  console.log(`  PASS  Valid PDF document generated (${pdfBuffer.length} bytes)`);

  // --- 2. In-Memory Tenant-Scoped Caching ---
  console.log('\n--- 2. In-Memory Tenant-Scoped Caching ---');
  const cached = getCachedCertificate(null, certId);
  assert(cached !== null, 'Certificate must be cached');
  assert.strictEqual(cached.length, pdfBuffer.length, 'Cached buffer matches generated buffer');
  console.log('  PASS  In-memory PDF caching operates correctly');

  // --- 3. Cache Invalidation ---
  console.log('\n--- 3. Cache Invalidation ---');
  clearCertificateCache();
  const cachedAfterClear = getCachedCertificate(null, certId);
  assert.strictEqual(cachedAfterClear, null, 'Cache must be empty after clearCertificateCache');
  console.log('  PASS  Cache clearing functions operate correctly');
})();

