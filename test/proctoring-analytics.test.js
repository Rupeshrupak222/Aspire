// Automated Test Suite for Day 11: Advanced Proctoring, Behavioral Monitoring & Risk Analytics
// Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const proctoringRiskService = require('../backend/src/services/proctoring-risk.service');
const {
  PROCTORING_EVENTS,
  RISK_POINTS,
  RISK_LEVELS,
  classifyRisk,
  sanitizeMetadata
} = proctoringRiskService;
const userService = require('../backend/src/services/user.service');
const orgService = require('../backend/src/services/organization.service');
const examService = require('../backend/src/services/exam.service');
const snapshotService = require('../backend/src/services/snapshot.service');
const { ROLES } = require('../backend/src/security/rbac');

let server;
let baseUrl;

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = {
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
      ...(options.headers || {})
    };
    let body = options.body;

    if (body && typeof body === 'object' && !(body instanceof Buffer)) {
      body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(data); } catch {}
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsed,
          text: data
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function login(email, password) {
  return request('POST', '/api/auth/login', {
    body: { email, password }
  });
}

async function runTests() {
  console.log('[test-proctoring] Starting Day 11 Proctoring Analytics Test Suite...\n');

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[test-proctoring] Test server listening on port ${addr.port}`);
      resolve();
    });
  });

  let totalPassed = 0;
  function ok(name, condition, extra = '') {
    if (condition) {
      totalPassed++;
      console.log(`  PASS  ${name}`);
    } else {
      console.error(`  FAIL  ${name} ${extra}`);
      throw new Error(`Assertion failed: ${name}`);
    }
  }

  try {
    // -------------------------------------------------------------
    // SECTION 1: Pure Unit Tests for Risk Engine & Sanitization
    // -------------------------------------------------------------
    console.log('--- 1. Risk Scoring & Boundary Classification ---');

    // Boundary classification checks
    ok('score 0 -> NORMAL', classifyRisk(0) === RISK_LEVELS.NORMAL);
    ok('score 10 -> NORMAL', classifyRisk(10) === RISK_LEVELS.NORMAL);
    ok('boundary score 20 -> NORMAL', classifyRisk(20) === RISK_LEVELS.NORMAL);
    ok('boundary score 21 -> WARNING', classifyRisk(21) === RISK_LEVELS.WARNING);
    ok('score 35 -> WARNING', classifyRisk(35) === RISK_LEVELS.WARNING);
    ok('boundary score 50 -> WARNING', classifyRisk(50) === RISK_LEVELS.WARNING);
    ok('boundary score 51 -> SUSPICIOUS', classifyRisk(51) === RISK_LEVELS.SUSPICIOUS);
    ok('score 65 -> SUSPICIOUS', classifyRisk(65) === RISK_LEVELS.SUSPICIOUS);
    ok('boundary score 75 -> SUSPICIOUS', classifyRisk(75) === RISK_LEVELS.SUSPICIOUS);
    ok('boundary score 76 -> HIGH_RISK', classifyRisk(76) === RISK_LEVELS.HIGH_RISK);
    ok('score 150 -> HIGH_RISK', classifyRisk(150) === RISK_LEVELS.HIGH_RISK);

    console.log('\n--- 2. Privacy & Metadata Sanitization ---');

    // Check clipboard & keylog stripping
    const unsafeMeta = {
      targetTag: 'INPUT',
      clipboardText: 'CONFIDENTIAL_CODE_COPIED',
      clipboardData: '12345',
      keystrokes: 'secret_password_123',
      keyLog: 'F12',
      password: 'mypassword',
      riskScore: 999, // client attempt to tamper score
      riskPoints: 100,
      riskLevel: 'NORMAL',
      shortcut: 'Ctrl+Shift+I'
    };

    const sanitizedJson = sanitizeMetadata(unsafeMeta);
    ok('metadata is sanitized to JSON', typeof sanitizedJson === 'string');
    const parsedMeta = JSON.parse(sanitizedJson);
    ok('targetTag preserved', parsedMeta.targetTag === 'INPUT');
    ok('shortcut preserved', parsedMeta.shortcut === 'Ctrl+Shift+I');
    ok('clipboardText scrubbed', parsedMeta.clipboardText === undefined);
    ok('clipboardData scrubbed', parsedMeta.clipboardData === undefined);
    ok('keystrokes scrubbed', parsedMeta.keystrokes === undefined);
    ok('password scrubbed', parsedMeta.password === undefined);
    ok('client riskScore scrubbed', parsedMeta.riskScore === undefined);
    ok('client riskLevel scrubbed', parsedMeta.riskLevel === undefined);

    // -------------------------------------------------------------
    // SECTION 2: Multi-Tenant Setup & Assessment Attempt Setup
    // -------------------------------------------------------------
    console.log('\n--- 3. Test Fixture Setup (Organizations, Users, Attempts) ---');

    const suffix = crypto.randomBytes(4).toString('hex');
    const orgA = orgService.createOrganization({ name: `Proctor Org A ${suffix}`, slug: `proc-org-a-${suffix}` });
    const orgB = orgService.createOrganization({ name: `Proctor Org B ${suffix}`, slug: `proc-org-b-${suffix}` });

    const superAdminUser = await userService.createUser({
      email: `superadmin-${suffix}@adyapan.internal`,
      password: 'SuperAdminPassword123!',
      name: 'Super Admin',
      role: ROLES.SUPER_ADMIN,
      organizationId: null
    });

    const orgAAdminUser = await userService.createUser({
      email: `orga-admin-${suffix}@adyapan.internal`,
      password: 'AdminPassword123!',
      name: 'Org A Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: orgA.id
    });

    const orgBAdminUser = await userService.createUser({
      email: `orgb-admin-${suffix}@adyapan.internal`,
      password: 'AdminPassword123!',
      name: 'Org B Admin',
      role: ROLES.ORG_ADMIN,
      organizationId: orgB.id
    });

    const superAdminLoginRes = await login(superAdminUser.email, 'SuperAdminPassword123!');
    const superAdminToken = superAdminLoginRes.data.data.token;

    const orgAAdminLoginRes = await login(orgAAdminUser.email, 'AdminPassword123!');
    const orgAAdminToken = orgAAdminLoginRes.data.data.token;

    const orgBAdminLoginRes = await login(orgBAdminUser.email, 'AdminPassword123!');
    const orgBAdminToken = orgBAdminLoginRes.data.data.token;

    // Create candidate & attempt
    const studentPhone = '99' + Math.floor(10000000 + Math.random() * 90000000);
    const regRes = await request('POST', '/api/register', {
      body: {
        name: 'Proctor Candidate',
        phone: studentPhone,
        email: `cand-${suffix}@example.com`
      }
    });
    ok('candidate registration 200', regRes.status === 200);
    const attemptToken = regRes.data.token;
    ok('attempt token returned', Boolean(attemptToken));

    // Assign attempt to Org A
    db.prepare('UPDATE attempts SET organization_id = ? WHERE token = ?').run(orgA.id, attemptToken);

    const attemptRow = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
    ok('attempt recorded in DB', Boolean(attemptRow));
    ok('initial risk score is 0', attemptRow.proctoring_risk_score === 0);
    ok('initial risk level is NORMAL', attemptRow.proctoring_risk_level === 'NORMAL');

    // -------------------------------------------------------------
    // SECTION 3: Candidate Proctoring Event Ingestion Endpoint
    // -------------------------------------------------------------
    console.log('\n--- 4. Proctoring Event Ingestion & Server Scoring ---');

    // A. Ingest TAB_SWITCH (+10)
    const eventId1 = `evt_tab_${crypto.randomBytes(8).toString('hex')}`;
    const resTab = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.1',
      body: {
        events: [{
          eventId: eventId1,
          eventType: 'TAB_SWITCH',
          timestamp: new Date().toISOString()
        }]
      }
    });

    ok('TAB_SWITCH ingestion 200', resTab.status === 200);
    ok('accepted true', resTab.data.accepted === true);
    ok('risk score is 10', resTab.data.risk.score === 10);
    ok('risk level is NORMAL (10 <= 20)', resTab.data.risk.level === 'NORMAL');

    // Verify DB update
    const dbAtt1 = db.prepare('SELECT * FROM attempts WHERE token = ?').get(attemptToken);
    ok('db score updated to 10', dbAtt1.proctoring_risk_score === 10);
    ok('db level updated to NORMAL', dbAtt1.proctoring_risk_level === 'NORMAL');
    ok('db tab_switches synchronized to 1', dbAtt1.tab_switches === 1);

    // B. Deduplication / Idempotency Check
    const resTabDup = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.2',
      body: {
        events: [{
          eventId: eventId1, // identical eventId
          eventType: 'TAB_SWITCH',
          timestamp: new Date().toISOString()
        }]
      }
    });

    ok('duplicate event accepted idempotently (200)', resTabDup.status === 200);
    ok('duplicateCount reported as 1', resTabDup.data.duplicateCount === 1);
    ok('risk score remained 10 (not doubled)', resTabDup.data.risk.score === 10);

    // C. Ingest COPY_ATTEMPT (+15) -> Score becomes 25 (Crosses into WARNING)
    const eventId2 = `evt_copy_${crypto.randomBytes(8).toString('hex')}`;
    const resCopy = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.3',
      body: {
        events: [{
          eventId: eventId2,
          eventType: 'COPY_ATTEMPT',
          timestamp: new Date().toISOString(),
          metadata: { targetTag: 'PRE' }
        }]
      }
    });

    ok('COPY_ATTEMPT ingestion 200', resCopy.status === 200);
    ok('risk score is now 25 (10 + 15)', resCopy.data.risk.score === 25);
    ok('risk level transitions to WARNING (25 > 20)', resCopy.data.risk.level === 'WARNING');

    // D. Ingest Informational Event: NETWORK_OFFLINE (+0) & NETWORK_ONLINE (+0)
    const eventIdOffline = `evt_off_${crypto.randomBytes(8).toString('hex')}`;
    const eventIdOnline = `evt_on_${crypto.randomBytes(8).toString('hex')}`;
    const resNet = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.4',
      body: {
        events: [
          { eventId: eventIdOffline, eventType: 'NETWORK_OFFLINE', timestamp: new Date().toISOString() },
          { eventId: eventIdOnline, eventType: 'NETWORK_ONLINE', timestamp: new Date().toISOString() }
        ]
      }
    });

    ok('network offline/online ingestion 200', resNet.status === 200);
    ok('network events add 0 points (score remains 25)', resNet.data.risk.score === 25);

    // E. Ingest Batch of Multiple Events (WINDOW_BLUR +5, FULLSCREEN_EXIT +10, DEVTOOLS_SHORTCUT_ATTEMPT +15)
    // 25 + 5 + 10 + 15 = 55 (Crosses into SUSPICIOUS)
    const resBatch = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.5',
      body: {
        events: [
          { eventId: `evt_blur_${crypto.randomBytes(8).toString('hex')}`, eventType: 'WINDOW_BLUR', timestamp: new Date().toISOString() },
          { eventId: `evt_fsexit_${crypto.randomBytes(8).toString('hex')}`, eventType: 'FULLSCREEN_EXIT', timestamp: new Date().toISOString() },
          { eventId: `evt_dev_${crypto.randomBytes(8).toString('hex')}`, eventType: 'DEVTOOLS_SHORTCUT_ATTEMPT', timestamp: new Date().toISOString(), metadata: { shortcut: 'F12' } }
        ]
      }
    });

    ok('batch ingestion 200', resBatch.status === 200);
    ok('risk score is now 55', resBatch.data.risk.score === 55);
    ok('risk level transitions to SUSPICIOUS (55 > 50)', resBatch.data.risk.level === 'SUSPICIOUS');

    // -------------------------------------------------------------
    // SECTION 4: Validation & Attack Defenses
    // -------------------------------------------------------------
    console.log('\n--- 5. Security & Input Validation Defenses ---');

    // A. Forged Client-Side Score Tampering
    const resTamper = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.6',
      body: {
        events: [{
          eventId: `evt_hack_${crypto.randomBytes(8).toString('hex')}`,
          eventType: 'WINDOW_BLUR',
          riskScore: 0, // Client tries to reset risk score to 0
          riskLevel: 'NORMAL'
        }]
      }
    });
    ok('client risk score tampering rejected (400)', resTamper.status === 400);
    ok('rejection code VALIDATION_ERROR', resTamper.data.code === 'VALIDATION_ERROR');

    // B. Batch Size Exceeded (> 50 events)
    const hugeBatch = Array.from({ length: 55 }, (_, i) => ({
      eventId: `evt_huge_${i}_${crypto.randomBytes(6).toString('hex')}`,
      eventType: 'WINDOW_BLUR'
    }));
    const resHuge = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.7',
      body: { events: hugeBatch }
    });
    ok('batch > 50 rejected (400)', resHuge.status === 400);

    // C. Empty Batch Rejection
    const resEmpty = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.8',
      body: { events: [] }
    });
    ok('empty batch rejected (400)', resEmpty.status === 400);

    // D. Invalid Event Type Rejection
    const resInvalidType = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.9',
      body: {
        events: [{
          eventId: `evt_bad_${crypto.randomBytes(8).toString('hex')}`,
          eventType: 'MALICIOUS_CUSTOM_INJECTION'
        }]
      }
    });
    ok('invalid eventType rejected (400)', resInvalidType.status === 400);

    // E. Short eventId (< 8 chars)
    const resShortId = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.10',
      body: {
        events: [{
          eventId: 'abc',
          eventType: 'WINDOW_BLUR'
        }]
      }
    });
    ok('short eventId rejected (400)', resShortId.status === 400);

    // F. Unknown Attempt Token
    const resUnknown = await request('POST', '/api/attempt/unknown_token_1234567890abcdef/proctoring/events', {
      ip: '10.0.1.11',
      body: {
        events: [{
          eventId: `evt_unk_${crypto.randomBytes(8).toString('hex')}`,
          eventType: 'WINDOW_BLUR'
        }]
      }
    });
    ok('unknown attempt token returns 404', resUnknown.status === 404);

    // G. Tampered Snapshot Integrity Protection
    // Create a temporary attempt and tamper with its snapshot
    const candPhone2 = '99' + Math.floor(10000000 + Math.random() * 90000000);
    const regRes2 = await request('POST', '/api/register', {
      body: { name: 'Tamper Tester', phone: candPhone2 }
    });
    const tamperToken = regRes2.data.token;
    // Corrupt snapshot
    db.prepare("UPDATE attempts SET questions_snapshot_json = '[{\"tampered\":true}]' WHERE token = ?").run(tamperToken);

    const resTamperSnap = await request('POST', `/api/attempt/${tamperToken}/proctoring/events`, {
      ip: '10.0.1.12',
      body: {
        events: [{
          eventId: `evt_snapt_${crypto.randomBytes(8).toString('hex')}`,
          eventType: 'WINDOW_BLUR'
        }]
      }
    });
    ok('tampered snapshot rejected on proctoring ingestion (409)', resTamperSnap.status === 409);
    ok('error code is SNAPSHOT_INTEGRITY_FAILURE', resTamperSnap.data.code === 'SNAPSHOT_INTEGRITY_FAILURE');

    // -------------------------------------------------------------
    // SECTION 5: Suspicious Pattern Generator & High-Risk Elevation
    // -------------------------------------------------------------
    console.log('\n--- 6. Suspicious Pattern Generator & Escalation ---');

    // Send 3 rapid tab switches within seconds -> triggers SUSPICIOUS_PATTERN (+25)
    // Current score on attempt 1 was 55. Adding 3 tab switches (+30) + pattern (+25) = 110 (Crosses into HIGH_RISK)
    const patternRes = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.13',
      body: {
        events: [
          { eventId: `evt_pat_tab1_${crypto.randomBytes(8).toString('hex')}`, eventType: 'TAB_SWITCH', timestamp: new Date().toISOString() },
          { eventId: `evt_pat_tab2_${crypto.randomBytes(8).toString('hex')}`, eventType: 'TAB_SWITCH', timestamp: new Date().toISOString() },
          { eventId: `evt_pat_tab3_${crypto.randomBytes(8).toString('hex')}`, eventType: 'TAB_SWITCH', timestamp: new Date().toISOString() }
        ]
      }
    });

    ok('pattern batch accepted 200', patternRes.status === 200);
    ok('synthesizedPatterns count >= 1', patternRes.data.synthesizedPatterns >= 1);
    ok('score escalated past 76 (HIGH_RISK)', patternRes.data.risk.score >= 76);
    ok('risk level is HIGH_RISK', patternRes.data.risk.level === 'HIGH_RISK');

    // Verify pattern event in database
    const patternRow = db.prepare(`
      SELECT * FROM proctoring_events
      WHERE attempt_id = ? AND event_type = 'SUSPICIOUS_PATTERN'
    `).get(attemptRow.id);
    ok('SUSPICIOUS_PATTERN event saved in DB', Boolean(patternRow));
    ok('SUSPICIOUS_PATTERN has 25 points', patternRow.risk_points === 25);

    // Verify Pattern Cooldown: Immediate next tab switch does not spam another SUSPICIOUS_PATTERN
    const resCooldown = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.14',
      body: {
        events: [{
          eventId: `evt_cool_${crypto.randomBytes(8).toString('hex')}`,
          eventType: 'TAB_SWITCH',
          timestamp: new Date().toISOString()
        }]
      }
    });
    ok('tab switch in cooldown accepted 200', resCooldown.status === 200);
    ok('synthesizedPatterns during cooldown is 0', resCooldown.data.synthesizedPatterns === 0);

    // -------------------------------------------------------------
    // SECTION 6: Admin Proctoring Analytics Endpoint & RBAC/IDOR
    // -------------------------------------------------------------
    console.log('\n--- 7. Admin Proctoring Analytics & Multi-Tenant Isolation ---');

    // A. Unauthenticated Request
    const resNoAuth = await request('GET', `/api/admin/attempts/${attemptRow.id}/proctoring`);
    ok('unauthenticated admin proctoring query returns 401', resNoAuth.status === 401);

    // B. Org B Admin tries to access Org A Attempt (Cross-Tenant IDOR Attack)
    const resCrossTenant = await request('GET', `/api/admin/attempts/${attemptRow.id}/proctoring`, {
      headers: { Authorization: `Bearer ${orgBAdminToken}` }
    });
    ok('cross-tenant IDOR access blocked (403)', resCrossTenant.status === 403);
    ok('error code is FORBIDDEN', resCrossTenant.data.code === 'FORBIDDEN');

    // C. Org A Admin accesses their own Attempt (Authorized)
    const resOrgAAuth = await request('GET', `/api/admin/attempts/${attemptRow.id}/proctoring`, {
      headers: { Authorization: `Bearer ${orgAAdminToken}` }
    });
    ok('tenant admin accesses their own attempt proctoring (200)', resOrgAAuth.status === 200);
    const dataA = resOrgAAuth.data.data;
    ok('candidate details returned', dataA.candidate.name === 'Proctor Candidate');
    ok('risk score >= 76', dataA.risk.score >= 76);
    ok('risk level is HIGH_RISK', dataA.risk.level === 'HIGH_RISK');
    ok('summary breakdown exists', Boolean(dataA.summary && dataA.summary.breakdown));
    ok('timeline is non-empty array', Array.isArray(dataA.timeline) && dataA.timeline.length > 5);

    // D. Super Admin accesses Attempt (Cross-Tenant Super Admin Access)
    const resSuperAuth = await request('GET', `/api/admin/attempts/${attemptRow.id}/proctoring`, {
      headers: { Authorization: `Bearer ${superAdminToken}` }
    });
    ok('super admin can inspect any attempt proctoring (200)', resSuperAuth.status === 200);

    // -------------------------------------------------------------
    // SECTION 7: Non-Disqualification & Final Assessment Submission
    // -------------------------------------------------------------
    console.log('\n--- 8. Non-Disqualification Rule & Final Grading ---');

    // A HIGH_RISK candidate submits their test
    // MUST NOT fail or disqualify the candidate automatically!
    const resSubmit = await request('POST', `/api/attempt/${attemptToken}/submit`, {
      ip: '10.0.1.15',
      body: { answers: {} }
    });

    ok('HIGH_RISK candidate can submit test (200)', resSubmit.status === 200);
    ok('submission status is submitted', resSubmit.data.status === 'submitted');
    ok('certificate_id generated', Boolean(resSubmit.data.certificate_id));
    ok('claim_code generated', Boolean(resSubmit.data.claim_code));
    ok('proctoring_risk_score in result summary', typeof resSubmit.data.proctoring_risk_score === 'number');
    ok('proctoring_risk_level in result summary', resSubmit.data.proctoring_risk_level === 'HIGH_RISK');

    // Submitting events to already submitted attempt should now be rejected (409)
    const resPostSubmitEvent = await request('POST', `/api/attempt/${attemptToken}/proctoring/events`, {
      ip: '10.0.1.16',
      body: {
        events: [{
          eventId: `evt_post_${crypto.randomBytes(8).toString('hex')}`,
          eventType: 'WINDOW_BLUR'
        }]
      }
    });
    ok('proctoring events rejected after test submission (409)', resPostSubmitEvent.status === 409);

    // -------------------------------------------------------------
    // SECTION 8: Admin Results List & CSV Export Integration
    // -------------------------------------------------------------
    console.log('\n--- 9. Admin Results List & CSV Export Verification ---');

    // Verify GET /api/admin/results
    const resResults = await request('GET', '/api/admin/results', {
      headers: { Authorization: `Bearer ${superAdminToken}` }
    });
    ok('admin results list returns 200', resResults.status === 200);
    const matchedResult = resResults.data.find((r) => r.attempt_id === attemptRow.id);
    ok('attempt present in results list', Boolean(matchedResult));
    ok('proctoring_risk_score in results item', typeof matchedResult.proctoring_risk_score === 'number');
    ok('proctoring_risk_level in results item', matchedResult.proctoring_risk_level === 'HIGH_RISK');

    // Verify GET /api/admin/results.csv
    const resCsv = await request('GET', '/api/admin/results.csv', {
      headers: { Authorization: `Bearer ${superAdminToken}` }
    });
    ok('results CSV returns 200', resCsv.status === 200);
    ok('CSV content-type text/csv', resCsv.headers['content-type'].includes('text/csv'));
    const csvLines = resCsv.text.split('\n');
    const headerLine = csvLines[0];
    ok('CSV header contains proctoring_risk_score', headerLine.includes('proctoring_risk_score'));
    ok('CSV header contains proctoring_risk_level', headerLine.includes('proctoring_risk_level'));
    ok('CSV data contains HIGH_RISK entry', resCsv.text.includes('HIGH_RISK'));

    console.log(`\n[test-proctoring] ALL ${totalPassed} ASSERTIONS PASSED!`);

  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('[test-proctoring] Test server closed cleanly.');
    }
  }
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('[test-proctoring] Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
