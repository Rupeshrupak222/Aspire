// ASPIRE — DAY 14: Comprehensive Unit Test Suite (Layer A)
// Tests individual functions and services independently with deterministic fixtures.

process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'unit_test_auth_secret_for_aspire_testing_32bytes_long!';

const assert = require('assert');
const crypto = require('crypto');
const { hashPassword, verifyPassword, normalizeEmail, signAccessToken, verifyAccessToken } = require('../backend/src/security/jwt');
const { ROLES, PERMISSIONS, hasPermission, isValidRole } = require('../backend/src/security/rbac');
const { createPrng, fisherYatesShuffle, generateSeed } = require('../backend/src/services/shuffle.service');
const { computeSnapshotHash, verifySnapshotIntegrity, createExamSnapshot, createQuestionSnapshots } = require('../backend/src/services/snapshot.service');
const timerSubmissionService = require('../backend/src/services/timer-submission.service');
const { classifyRisk, sanitizeMetadata, RISK_LEVELS, RISK_POINTS, PROCTORING_EVENTS } = require('../backend/src/services/proctoring-risk.service');
const { generateCertificate } = require('../backend/src/services/certificate');
const { registerSchema } = require('../backend/src/validation/student.schemas');
const { submitSchema } = require('../backend/src/validation/attempt.schemas');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function ok(name, condition, extra = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  PASS  ${name}`);
  } else {
    failedTests++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

// Helper: Tier calculation logic identical to production router
function tierFor(percentage, slabsJson) {
  let slabs;
  try {
    slabs = typeof slabsJson === 'string' ? JSON.parse(slabsJson) : slabsJson;
    if (!Array.isArray(slabs) || slabs.length === 0) throw new Error('bad slabs');
  } catch {
    slabs = [
      { min: 90, scholarship: 100 },
      { min: 75, scholarship: 50 },
      { min: 60, scholarship: 25 },
      { min: 40, scholarship: 10 },
      { min: 0, scholarship: 0 }
    ];
  }
  const sorted = slabs.slice().sort((a, b) => b.min - a.min);
  for (const s of sorted) {
    if (percentage >= s.min) return s.scholarship;
  }
  return 0;
}

async function runUnitTests() {
  console.log('====================================================');
  console.log('ASPIRE DAY 14: UNIT TESTING SUITE (LAYER A)');
  console.log('====================================================\n');

  // 1. Password Hashing & Verification
  console.log('--- 1. Password Hashing & Verification ---');
  const plain = 'SecurePassword123!';
  const hash = await hashPassword(plain);
  ok('hashPassword produces a valid bcrypt hash starting with $2b$', hash.startsWith('$2b$'));
  ok('verifyPassword returns true for matching password', await verifyPassword(plain, hash));
  ok('verifyPassword returns false for wrong password', !(await verifyPassword('WrongPassword', hash)));
  ok('normalizeEmail trims and lowercases email', normalizeEmail('  Candidate.Name@Domain.COM ') === 'candidate.name@domain.com');

  let emptyHashError = false;
  try { await hashPassword(''); } catch { emptyHashError = true; }
  ok('hashPassword throws error on empty password', emptyHashError);

  // 2. JWT Signing & Verification
  console.log('\n--- 2. JWT Signing & Verification ---');
  const userPayload = { id: 42, email: 'student@example.com', role: ROLES.ORG_ADMIN, organization_id: 10 };
  const jwtToken = await signAccessToken(userPayload);
  ok('signAccessToken returns a non-empty string', typeof jwtToken === 'string' && jwtToken.split('.').length === 3);

  const decoded = await verifyAccessToken(jwtToken);
  ok('verifyAccessToken returns correct payload fields', decoded.id === 42 && decoded.role === ROLES.ORG_ADMIN);

  let invalidJwtError = false;
  try { await verifyAccessToken('invalid.token.payload'); } catch { invalidJwtError = true; }
  ok('verifyAccessToken rejects tampered JWT string', invalidJwtError);

  // 3. RBAC Permissions Matrix
  console.log('\n--- 3. RBAC Permissions Matrix ---');
  ok('SUPER_ADMIN has all permissions', hasPermission(ROLES.SUPER_ADMIN, PERMISSIONS.QUESTIONS_CREATE) && hasPermission(ROLES.SUPER_ADMIN, PERMISSIONS.RESULTS_EXPORT));
  ok('ORG_ADMIN has questions.create permission', hasPermission(ROLES.ORG_ADMIN, PERMISSIONS.QUESTIONS_CREATE));
  ok('VIEWER cannot create questions', !hasPermission(ROLES.VIEWER, PERMISSIONS.QUESTIONS_CREATE));
  ok('VIEWER can read results', hasPermission(ROLES.VIEWER, PERMISSIONS.RESULTS_READ));
  ok('EXAM_MANAGER cannot export results', !hasPermission(ROLES.EXAM_MANAGER, PERMISSIONS.RESULTS_EXPORT));
  ok('isValidRole identifies valid system roles', isValidRole(ROLES.SUPER_ADMIN) && isValidRole(ROLES.ORG_ADMIN));
  ok('isValidRole rejects unknown role', !isValidRole('SUPER_HACKER'));

  // 4. Deterministic PRNG & Fisher-Yates Shuffling
  console.log('\n--- 4. Deterministic PRNG & Fisher-Yates Shuffling ---');
  const seed1 = 'a'.repeat(64);
  const seed2 = 'b'.repeat(64);
  const prng1a = createPrng(seed1);
  const prng1b = createPrng(seed1);
  const prng2 = createPrng(seed2);

  const seq1a = [prng1a(), prng1a(), prng1a()];
  const seq1b = [prng1b(), prng1b(), prng1b()];
  const seq2 = [prng2(), prng2(), prng2()];

  ok('Same seed emits identical deterministic PRNG sequence', JSON.stringify(seq1a) === JSON.stringify(seq1b));
  ok('Different seed emits different PRNG sequence', JSON.stringify(seq1a) !== JSON.stringify(seq2));

  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const shuffled1 = fisherYatesShuffle(items, createPrng(seed1));
  const shuffled2 = fisherYatesShuffle(items, createPrng(seed1));
  const shuffledDiff = fisherYatesShuffle(items, createPrng(seed2));

  ok('Shuffling preserves all original elements', shuffled1.slice().sort((a,b)=>a-b).join() === items.join());
  ok('Same seed generates reproducible permutation', JSON.stringify(shuffled1) === JSON.stringify(shuffled2));
  ok('Different seed generates distinct permutation', JSON.stringify(shuffled1) !== JSON.stringify(shuffledDiff));
  ok('Shuffling does not mutate input array', items[0] === 1 && items[9] === 10);
  ok('Empty and single-item arrays handled cleanly', fisherYatesShuffle([], createPrng(seed1)).length === 0 && fisherYatesShuffle([42], createPrng(seed1))[0] === 42);

  // 5. Exam & Question Snapshots and Cryptographic Integrity
  console.log('\n--- 5. Exam & Question Snapshots and HMAC Integrity ---');
  const exam = { id: 101, version: 1, name: 'Tech Exam', code: 'TECH-101', duration_minutes: 60 };
  const sections = [{ id: 1, name: 'Technical', display_order: 1, total_questions: 20 }];
  const slabs = [{ min_score_pct: 90, max_score_pct: 100, discount_pct: 100 }];
  const examSnap = createExamSnapshot(exam, sections, slabs);

  ok('createExamSnapshot freezes exam fields', examSnap.id === 101 && examSnap.duration_minutes === 60 && examSnap.sections.length === 1);

  const rawQuestions = [
    { id: 201, type: 'mcq', question_text: 'What is 1+1?', marks: 2, correct_index: 1, options_json: '["1","2","3","4"]' },
    { id: 202, type: 'code', question_text: 'def sum(a,b):', marks: 5, code_starter: 'def sum(a,b): pass' }
  ];
  const qSnapshots = createQuestionSnapshots(rawQuestions);
  ok('createQuestionSnapshots creates snapshot objects with marks and type', qSnapshots.length === 2 && qSnapshots[0].marks === 2 && qSnapshots[1].type === 'code');

  const shuffleMap = { 201: [1, 0, 3, 2] };
  const hashOriginal = computeSnapshotHash(examSnap, qSnapshots, shuffleMap);
  ok('computeSnapshotHash returns 64-char hex string', typeof hashOriginal === 'string' && hashOriginal.length === 64);

  const validAttempt = {
    exam_snapshot_json: JSON.stringify(examSnap),
    questions_snapshot_json: JSON.stringify(qSnapshots),
    shuffle_map_json: JSON.stringify(shuffleMap),
    snapshot_hash: hashOriginal
  };
  ok('verifySnapshotIntegrity passes for valid untampered attempt', verifySnapshotIntegrity(validAttempt) === true);

  const tamperedAttempt = {
    ...validAttempt,
    questions_snapshot_json: JSON.stringify([{ ...qSnapshots[0], marks: 100 }]) // Tampered!
  };
  let tamperedCaught = false;
  try { verifySnapshotIntegrity(tamperedAttempt); } catch (err) {
    if (err.code === 'SNAPSHOT_INTEGRITY_FAILURE') tamperedCaught = true;
  }
  ok('verifySnapshotIntegrity throws SNAPSHOT_INTEGRITY_FAILURE on tampered snapshot', tamperedCaught);

  // 6. Assessment Deadline & Remaining Time Calculations
  console.log('\n--- 6. Assessment Deadline & Timing Calculations ---');
  const startedAt = '2026-10-31T10:00:00.000Z';
  const durationMinutes = 60;
  const gracePeriodSeconds = 60;
  const calculatedDeadline = timerSubmissionService.calculateAuthoritativeDeadline(startedAt, durationMinutes, gracePeriodSeconds);

  // 60 min = 3600s + 60s grace = 3660s = 10:00:00 + 3660s = 11:01:00.000Z
  ok('calculateAuthoritativeDeadline includes duration and grace period', calculatedDeadline === '2026-10-31T11:01:00.000Z');

  const futureDeadline = new Date(Date.now() + 1800 * 1000).toISOString();
  const futureAttempt = { deadline_at: futureDeadline, grace_period_seconds: 60 };
  const timingFuture = timerSubmissionService.getAuthoritativeTiming(futureAttempt);
  ok('getAuthoritativeTiming returns isExpired=false for active attempt', timingFuture.isExpired === false && timingFuture.remainingSeconds > 1750);

  const pastDeadline = new Date(Date.now() - 5000).toISOString();
  const expiredAttempt = { deadline_at: pastDeadline, grace_period_seconds: 60 };
  const timingPast = timerSubmissionService.getAuthoritativeTiming(expiredAttempt);
  ok('getAuthoritativeTiming returns isExpired=true and remainingSeconds=0 for expired attempt', timingPast.isExpired === true && timingPast.remainingSeconds === 0);

  // 7. Scholarship Tier Calculation Boundaries
  console.log('\n--- 7. Scholarship Tier Calculation Boundaries ---');
  ok('tierFor 100% awards 100% scholarship', tierFor(100) === 100);
  ok('tierFor 90.00% awards 100% scholarship', tierFor(90.0) === 100);
  ok('tierFor 89.99% falls into 50% scholarship', tierFor(89.99) === 50);
  ok('tierFor 75.00% awards 50% scholarship', tierFor(75.0) === 50);
  ok('tierFor 60.00% awards 25% scholarship', tierFor(60.0) === 25);
  ok('tierFor 40.00% awards 10% scholarship', tierFor(40.0) === 10);
  ok('tierFor 39.99% awards 0% scholarship', tierFor(39.99) === 0);
  ok('tierFor 0% awards 0% scholarship', tierFor(0) === 0);

  const customSlabs = [
    { min: 80, scholarship: 80 },
    { min: 50, scholarship: 40 },
    { min: 0, scholarship: 0 }
  ];
  ok('tierFor supports custom slab configuration', tierFor(85, customSlabs) === 80 && tierFor(60, customSlabs) === 40);

  // 8. Proctoring Risk Score & Metadata Sanitization
  console.log('\n--- 8. Proctoring Risk Score & Sanitization ---');
  ok('classifyRisk 0-20 is NORMAL', classifyRisk(0) === RISK_LEVELS.NORMAL && classifyRisk(20) === RISK_LEVELS.NORMAL);
  ok('classifyRisk 21-50 is WARNING', classifyRisk(21) === RISK_LEVELS.WARNING && classifyRisk(50) === RISK_LEVELS.WARNING);
  ok('classifyRisk 51-75 is SUSPICIOUS', classifyRisk(51) === RISK_LEVELS.SUSPICIOUS && classifyRisk(75) === RISK_LEVELS.SUSPICIOUS);
  ok('classifyRisk 76+ is HIGH_RISK', classifyRisk(76) === RISK_LEVELS.HIGH_RISK && classifyRisk(120) === RISK_LEVELS.HIGH_RISK);

  const dirtyMetadata = {
    validKey: 'allowed_info',
    clipboardText: 'const secret = 42;',
    keystrokes: 'Ctrl+V',
    password: 'secret_candidate_password',
    inner: { text: 'forbidden string' }
  };
  const cleanMetadataStr = sanitizeMetadata(dirtyMetadata);
  const cleanMetadata = JSON.parse(cleanMetadataStr);
  ok('sanitizeMetadata strips clipboardText', cleanMetadata.clipboardText === undefined);
  ok('sanitizeMetadata strips keystrokes', cleanMetadata.keystrokes === undefined);
  ok('sanitizeMetadata strips password', cleanMetadata.password === undefined);
  ok('sanitizeMetadata retains legitimate metadata keys', cleanMetadata.validKey === 'allowed_info');

  // 9. Input Validation Schemas & Forbidden Field Injection
  console.log('\n--- 9. Registration & Submission Schemas ---');
  const validReg = {
    name: 'Aarav Sharma',
    phone: '9876543210',
    email: 'aarav.sharma@example.com',
    college: 'IIT Delhi',
    city: 'New Delhi',
    grad_year: '2026',
    track: 'Full Stack'
  };
  const regParsed = registerSchema.safeParse(validReg);
  ok('registerSchema accepts valid candidate payload', regParsed.success === true);

  const invalidPhone = { ...validReg, phone: '12345' };
  ok('registerSchema rejects invalid short phone number', registerSchema.safeParse(invalidPhone).success === false);

  const invalidEmail = { ...validReg, email: 'not-an-email' };
  ok('registerSchema rejects invalid email address', registerSchema.safeParse(invalidEmail).success === false);

  // Forbidden fields injection into submitSchema
  const injectedSubmit = {
    answers: { 1: 2 },
    remainingSeconds: 9999, // FORBIDDEN!
    score: 100              // FORBIDDEN!
  };
  const submitParsed = submitSchema.safeParse(injectedSubmit);
  ok('submitSchema rejects client-controlled score or timer injection', submitParsed.success === false);

  // 10. Certificate Generation (PDF Buffer Output)
  console.log('\n--- 10. PDF Certificate Generation ---');
  const certBuffer = await generateCertificate({
    name: 'Aarav Sharma',
    percentage: 95,
    scholarshipPct: 100,
    certificateId: 'CERT-TEST-12345',
    dateStr: 'October 31, 2026',
    brandName: 'Adyapan'
  });
  ok('generateCertificate returns a valid non-empty PDF Buffer', Buffer.isBuffer(certBuffer) && certBuffer.length > 1000);
  ok('generateCertificate output begins with %PDF signature', certBuffer.slice(0, 4).toString() === '%PDF');

  // Summary
  console.log('\n====================================================');
  console.log(`UNIT TESTING SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runUnitTests().catch((err) => {
    console.error('Fatal unit test error:', err);
    process.exit(1);
  });
}

module.exports = { runUnitTests };
