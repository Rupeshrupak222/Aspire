// ============================================================================
// DAY 24 TEST 1: CERTIFICATE IDENTIFIER GENERATION & ENTROPY
// ============================================================================

const assert = require('assert');
const certCrypto = require('../backend/src/utils/certificate-crypto');

console.log('====================================================');
console.log('DAY 24: CERTIFICATE IDENTIFIER GENERATION SUITE');
console.log('====================================================');

// --- 1. Valid Identifier Generation ---
console.log('\n--- 1. Identifier Format & Generation ---');
const id1 = certCrypto.generateCertificateId();
assert(typeof id1 === 'string', 'Generated ID should be a string');
assert(id1.startsWith('ASP26-'), 'Generated ID should have default ASP26 prefix');
assert(certCrypto.isValidCertificateId(id1), 'Generated ID should validate against isValidCertificateId');
console.log('  PASS  Default identifier format matches ASP26-<HEX>');

const customId = certCrypto.generateCertificateId('SCHOLAR27');
assert(customId.startsWith('SCHOLAR27-'), 'Generated ID should respect custom prefix');
console.log('  PASS  Custom prefix format supported');

// --- 2. Uniqueness & Collision Resistance ---
console.log('\n--- 2. Uniqueness & Collision Resistance ---');
const idSet = new Set();
const sampleSize = 1000;
for (let i = 0; i < sampleSize; i++) {
  const newId = certCrypto.generateCertificateId();
  assert(!idSet.has(newId), `Collision detected at iteration ${i} for ID ${newId}`);
  idSet.add(newId);
}
assert.strictEqual(idSet.size, sampleSize, 'All generated identifiers must be strictly unique');
console.log(`  PASS  ${sampleSize} consecutive identifiers generated with 0 collisions`);

// --- 3. Invalid Identifier Rejection ---
console.log('\n--- 3. Invalid Identifier Rejection ---');
assert.strictEqual(certCrypto.isValidCertificateId(''), false, 'Empty string rejected');
assert.strictEqual(certCrypto.isValidCertificateId(null), false, 'Null rejected');
assert.strictEqual(certCrypto.isValidCertificateId(undefined), false, 'Undefined rejected');
assert.strictEqual(certCrypto.isValidCertificateId(12345), false, 'Numeric input rejected');
assert.strictEqual(certCrypto.isValidCertificateId('ASP26-123'), false, 'Too short suffix rejected');
assert.strictEqual(certCrypto.isValidCertificateId('INVALID_PREFIX-A1B2C3D4'), false, 'Non-conforming prefix rejected');
assert.strictEqual(certCrypto.isValidCertificateId('ASP26-A1B2C3D4-EXTRA'), false, 'Malformed suffix rejected');
assert.strictEqual(certCrypto.isValidCertificateId('ASP26-ZZZZZZZZ'), false, 'Non-hex characters rejected');
console.log('  PASS  Strict validation rejects malformed identifiers');

// --- 4. Unpredictability & Non-Sequential Randomness ---
console.log('\n--- 4. Unpredictability & Non-Sequential Randomness ---');
const ids = [];
for (let i = 0; i < 5; i++) {
  ids.push(certCrypto.generateCertificateId());
}
// Verify suffixes are not sequential or predictable increments
const suffixes = ids.map(id => id.split('-')[1]);
for (let i = 1; i < suffixes.length; i++) {
  assert.notStrictEqual(suffixes[i], suffixes[i - 1], 'Adjacent suffixes must not be equal');
  const diff = Math.abs(parseInt(suffixes[i].slice(0, 4), 16) - parseInt(suffixes[i - 1].slice(0, 4), 16));
  assert(diff > 1, 'Hex suffixes must not be sequential increments');
}
console.log('  PASS  Identifiers exhibit non-sequential cryptographic entropy');

