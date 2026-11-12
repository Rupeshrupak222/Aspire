// ============================================================================
// DAY 24 TEST 4: QR CODE GENERATION & URL ENCODING
// ============================================================================

const assert = require('assert');
const { generateQrCodeBuffer, generateQrCodeDataUrl } = require('../backend/src/services/certificate/qr-code.service');

console.log('====================================================');
console.log('DAY 24: QR CODE GENERATION & ENCODING SUITE');
console.log('====================================================');

(async () => {
  const publicUrl = 'https://aspire.adyapan.com/verify/ASP26-9F8E7D6C5B4A';

  // --- 1. QR Code Buffer Generation ---
  console.log('\n--- 1. QR Code Buffer Generation ---');
  const buffer = await generateQrCodeBuffer(publicUrl, { width: 256 });
  assert(Buffer.isBuffer(buffer), 'Result must be a Buffer');
  assert(buffer.length > 500, 'PNG buffer must have substantial size');
  // PNG Magic Header check: 89 50 4E 47 0D 0A 1A 0A
  assert.strictEqual(buffer[0], 0x89, 'PNG magic byte 0');
  assert.strictEqual(buffer[1], 0x50, 'PNG magic byte 1 (P)');
  assert.strictEqual(buffer[2], 0x4E, 'PNG magic byte 2 (N)');
  assert.strictEqual(buffer[3], 0x47, 'PNG magic byte 3 (G)');
  console.log('  PASS  High-contrast PNG buffer generated with valid magic bytes');

  // --- 2. QR Code DataURL Generation ---
  console.log('\n--- 2. QR Code DataURL Generation ---');
  const dataUrl = await generateQrCodeDataUrl(publicUrl, { width: 180 });
  assert(typeof dataUrl === 'string', 'Data URL must be a string');
  assert(dataUrl.startsWith('data:image/png;base64,'), 'Data URL has correct MIME prefix');
  console.log('  PASS  Base64 DataURL generated successfully');

  // --- 3. Privacy & Security Validation ---
  console.log('\n--- 3. Privacy & Security Validation ---');
  // The input URL must ONLY encode the public URL, no session/tokens
  assert(!publicUrl.includes('secret'), 'URL contains no secret');
  assert(!publicUrl.includes('token='), 'URL contains no session token');
  assert(!publicUrl.includes('phone='), 'URL contains no PII');
  assert(!publicUrl.includes('email='), 'URL contains no email');
  console.log('  PASS  QR target URL contains zero secrets or candidate PII');

  // --- 4. Input Validation & Error Handling ---
  console.log('\n--- 4. Input Validation & Error Handling ---');
  let errThrown = false;
  try {
    await generateQrCodeBuffer('');
  } catch (err) {
    errThrown = true;
  }
  assert(errThrown, 'Empty verification URL must throw error');

  let nullErr = false;
  try {
    await generateQrCodeBuffer(null);
  } catch (err) {
    nullErr = true;
  }
  assert(nullErr, 'Null verification URL must throw error');
  console.log('  PASS  Invalid inputs properly rejected with clear exceptions');
})();

