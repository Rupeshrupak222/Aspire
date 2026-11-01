// ============================================================================
// ASPIRE DAY 16: MULTI-TENANT ISOLATION & CONCURRENCY TEST SUITE
// ============================================================================
// Validates:
// 1. Database-level organization boundaries
// 2. AsyncLocalStorage tenant context isolation
// 3. Prevention of 20 cross-tenant attack vectors & IDOR vulnerabilities
// 4. Background worker & outbox tenant verification
// 5. Cross-tenant certificate cache isolation
// 6. Suspended organization & disabled user rejection
// 7. High-concurrency interleaved async context separation
// ============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
  runWithTenant,
  getTenantContext,
  getOrganizationId,
  createTenantContext
} = require('../backend/src/utils/tenant-context');
const { getCachedCertificate, clearCertificateCache, generateCertificate } = require('../backend/src/services/certificate');
const { processCodeJob } = require('../backend/src/workers/code-execution.processor');

const PORT = 3218;
const DB_FILE = path.join(os.tmpdir(), `aspire-multitenant-test-${Date.now()}.db`);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function api(endpoint, opts = {}) {
  const res = await fetch(BASE + endpoint, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data, raw: text, headers: res.headers };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {}
    await wait(250);
  }
  return false;
}

async function loginUser(email, password) {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  return {
    status: res.status,
    data: res.data,
    token: res.data?.data?.token,
    user: res.data?.data?.user,
    headers: res.data?.data?.token ? { Authorization: `Bearer ${res.data.data.token}` } : {}
  };
}

async function runSuite() {
  console.log('====================================================');
  console.log('ASPIRE DAY 16: MULTI-TENANT ISOLATION TEST SUITE');
  console.log('====================================================\n');

  // Clean old db files if any
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + ext); } catch {}
  }

  // 1. Direct AsyncLocalStorage Concurrency Unit Tests
  console.log('--- 1. AsyncLocalStorage Concurrency & Context Isolation ---');
  {
    let contextMissingCaught = false;
    try {
      getOrganizationId({ required: true });
    } catch (err) {
      contextMissingCaught = err.code === 'TENANT_CONTEXT_MISSING' || err.message.includes('Tenant context');
    }
    ok('getOrganizationId fails closed outside tenant context (TENANT_CONTEXT_MISSING)', contextMissingCaught);

    // Simulate 50 concurrent interleaved async operations across 3 organizations
    const concurrencyIterations = 50;
    const errors = [];

    const tasks = Array.from({ length: concurrencyIterations }, async (_, i) => {
      const assignedOrgId = (i % 3) + 101; // Orgs 101, 102, 103
      const ctx = createTenantContext({
        organizationId: assignedOrgId,
        userId: i + 1,
        role: 'ORG_ADMIN',
        requestId: `req_${i}`
      });

      return runWithTenant(ctx, async () => {
        // Step 1: verify initial context
        if (getOrganizationId() !== assignedOrgId) {
          errors.push(`Mismatch before delay for iteration ${i}`);
        }

        // Asynchronous delay simulating I/O
        await wait(Math.floor(Math.random() * 20) + 5);

        // Step 2: verify context after first async hop
        if (getOrganizationId() !== assignedOrgId) {
          errors.push(`Mismatch after first delay for iteration ${i}`);
        }

        // Second asynchronous delay simulating DB transaction
        await wait(Math.floor(Math.random() * 20) + 5);

        // Step 3: verify context after second async hop
        if (getOrganizationId() !== assignedOrgId) {
          errors.push(`Mismatch after second delay for iteration ${i}`);
        }
      });
    });

    await Promise.all(tasks);
    ok('50 concurrent interleaved async tasks maintain 100% strict tenant context isolation', errors.length === 0, errors.join(', '));
  }

  // 2. Start Isolated Express Server
  console.log('\n--- 2. Starting Isolated Server on Port ' + PORT + ' ---');
  const serverProc = spawn('node', ['backend/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB_FILE,
      NODE_ENV: 'test',
      INITIAL_ADMIN_EMAIL: 'superadmin@adyapan.internal',
      INITIAL_ADMIN_PASSWORD: 'SuperPassword123!',
      AUTH_SECRET: 'aspire-day16-multi-tenant-test-auth-secret-key-32',
      CODE_EXECUTION_PROVIDER: 'MOCK',
      CODE_EXECUTION_FALLBACK: 'true'
    },
    stdio: 'ignore'
  });

  const ready = await waitForServer();
  if (!ready) {
    console.error('Failed to start test server on port ' + PORT);
    serverProc.kill();
    process.exit(1);
  }
  ok('Test server initialized and ready at ' + BASE, true);

  try {
    // 3. Super Admin Authentication & Multi-Organization Setup
    console.log('\n--- 3. Organization Onboarding & Seeding ---');
    const superAdmin = await loginUser('superadmin@adyapan.internal', 'SuperPassword123!');
    ok('Super Admin login succeeded (HTTP 200)', superAdmin.status === 200);

    // Onboard Organization A
    const onboardARes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Alpha University',
        slug: 'alpha-univ',
        admin_name: 'Alpha Org Admin',
        admin_email: 'admin@alpha.test',
        admin_password: 'Password123!'
      })
    });
    ok('Onboard Organization A succeeded (HTTP 201)', onboardARes.status === 201);
    const orgA = onboardARes.data.organization;
    const orgAAdminId = onboardARes.data.admin.id;

    // Onboard Organization B
    const onboardBRes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Beta Polytechnic',
        slug: 'beta-poly',
        admin_name: 'Beta Org Admin',
        admin_email: 'admin@beta.test',
        admin_password: 'Password123!'
      })
    });
    ok('Onboard Organization B succeeded (HTTP 201)', onboardBRes.status === 201);
    const orgB = onboardBRes.data.organization;
    const orgBAdminId = onboardBRes.data.admin.id;

    // Onboard Organization C (will be suspended later)
    const onboardCRes = await api('/api/admin/organizations/onboard', {
      method: 'POST',
      headers: superAdmin.headers,
      body: JSON.stringify({
        name: 'Gamma Institute',
        slug: 'gamma-inst',
        admin_name: 'Gamma Org Admin',
        admin_email: 'admin@gamma.test',
        admin_password: 'Password123!'
      })
    });
    ok('Onboard Organization C succeeded (HTTP 201)', onboardCRes.status === 201);
    const orgC = onboardCRes.data.organization;

    // Log in administrators
    const adminA = await loginUser('admin@alpha.test', 'Password123!');
    ok('Org Admin A login succeeded (HTTP 200)', adminA.status === 200);

    const adminB = await loginUser('admin@beta.test', 'Password123!');
    ok('Org Admin B login succeeded (HTTP 200)', adminB.status === 200);

    const adminC = await loginUser('admin@gamma.test', 'Password123!');
    ok('Org Admin C login succeeded (HTTP 200)', adminC.status === 200);

    // Create an Exam Manager and Viewer for Org A
    const mgrA = await api('/api/admin/users', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        name: 'Alpha Exam Manager',
        email: 'manager@alpha.test',
        password: 'Password123!',
        role: 'EXAM_MANAGER'
      })
    });
    ok('Org Admin A creates EXAM_MANAGER in Org A (HTTP 201)', mgrA.status === 201);

    const viewerA = await api('/api/admin/users', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        name: 'Alpha Viewer',
        email: 'viewer@alpha.test',
        password: 'Password123!',
        role: 'VIEWER'
      })
    });
    ok('Org Admin A creates VIEWER in Org A (HTTP 201)', viewerA.status === 201);

    // 4. Create Seed Resources in Org A and Org B
    console.log('\n--- 4. Seeding Tenant-Isolated Questions and Exams ---');
    // Questions in Org A
    const qARes = await api('/api/admin/questions', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        type: 'mcq',
        category: 'aptitude',
        title: 'Alpha Proprietary Aptitude Q1',
        question_text: 'What is 10 + 15 in Alpha assessment?',
        options: ['25', '30', '35', '40'],
        correct_index: 0,
        marks: 1
      })
    });
    ok('Org Admin A creates question (HTTP 201)', qARes.status === 201);
    const qAId = qARes.data?.data?.id || qARes.data?.id;

    // Publish Question A
    await api(`/api/admin/questions/${qAId}/publish`, { method: 'POST', headers: adminA.headers });

    // Questions in Org B
    const qBRes = await api('/api/admin/questions', {
      method: 'POST',
      headers: adminB.headers,
      body: JSON.stringify({
        type: 'mcq',
        category: 'technical',
        title: 'Beta Proprietary Technical Q1',
        question_text: 'What does HTTP 403 represent in Beta systems?',
        options: ['Forbidden', 'Not Found', 'Internal Server Error', 'OK'],
        correct_index: 0,
        marks: 2
      })
    });
    ok('Org Admin B creates question (HTTP 201)', qBRes.status === 201);
    const qBId = qBRes.data?.data?.id || qBRes.data?.id;

    // Publish Question B
    await api(`/api/admin/questions/${qBId}/publish`, { method: 'POST', headers: adminB.headers });

    // Exam in Org A
    const examARes = await api('/api/admin/exams', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        name: 'Alpha Annual Scholarship Exam 2026',
        code: 'ALPHA-2026',
        duration_minutes: 60,
        passing_score: 1
      })
    });
    ok('Org Admin A creates exam ALPHA-2026 (HTTP 201)', examARes.status === 201);
    const examAId = examARes.data?.data?.id || examARes.data?.id;

    // Add Section and Question to Exam A
    const secARes = await api(`/api/admin/exams/${examAId}/sections`, {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        name: 'Aptitude Section',
        display_order: 1,
        question_selection_mode: 'MANUAL',
        total_questions: 1,
        total_marks: 1
      })
    });
    const secAId = secARes.data?.data?.sections?.[0]?.id || secARes.data?.sections?.[0]?.id || secARes.data?.data?.id || secARes.data?.id;

    await api(`/api/admin/exams/${examAId}/sections/${secAId}/questions`, {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({ question_id: qAId })
    });

    // Add Scholarship Slabs to Exam A
    await api(`/api/admin/exams/${examAId}/scholarship-slabs`, {
      method: 'PUT',
      headers: adminA.headers,
      body: JSON.stringify({
        slabs: [
          { min_score_pct: 0, max_score_pct: 100, discount_pct: 100, tier_name: 'Full' }
        ]
      })
    });

    // Publish Exam A and make LIVE
    const pubARes = await api(`/api/admin/exams/${examAId}/publish`, { method: 'POST', headers: adminA.headers });
    if (pubARes.status !== 200) console.log('pubARes error:', pubARes.status, pubARes.data);
    ok('Org Admin A publishes exam ALPHA-2026 (HTTP 200)', pubARes.status === 200);
    const liveARes = await api(`/api/admin/exams/${examAId}/live`, { method: 'POST', headers: adminA.headers });
    ok('Org Admin A makes exam ALPHA-2026 LIVE (HTTP 200)', liveARes.status === 200);

    // Exam in Org B
    const examBRes = await api('/api/admin/exams', {
      method: 'POST',
      headers: adminB.headers,
      body: JSON.stringify({
        name: 'Beta Technology Fellowship Exam 2026',
        code: 'BETA-2026',
        duration_minutes: 45,
        passing_score: 1
      })
    });
    ok('Org Admin B creates exam BETA-2026 (HTTP 201)', examBRes.status === 201);
    const examBId = examBRes.data?.data?.id || examBRes.data?.id;

    // Add Section and Question to Exam B
    const secBRes = await api(`/api/admin/exams/${examBId}/sections`, {
      method: 'POST',
      headers: adminB.headers,
      body: JSON.stringify({
        name: 'Technical Section',
        display_order: 1,
        question_selection_mode: 'MANUAL',
        total_questions: 1,
        total_marks: 2
      })
    });
    const secBId = secBRes.data?.data?.sections?.[0]?.id || secBRes.data?.sections?.[0]?.id || secBRes.data?.data?.id || secBRes.data?.id;

    await api(`/api/admin/exams/${examBId}/sections/${secBId}/questions`, {
      method: 'POST',
      headers: adminB.headers,
      body: JSON.stringify({ question_id: qBId })
    });

    // Add Scholarship Slabs to Exam B
    await api(`/api/admin/exams/${examBId}/scholarship-slabs`, {
      method: 'PUT',
      headers: adminB.headers,
      body: JSON.stringify({
        slabs: [
          { min_score_pct: 0, max_score_pct: 100, discount_pct: 100, tier_name: 'Full' }
        ]
      })
    });

    // Publish Exam B and make LIVE
    const pubBRes = await api(`/api/admin/exams/${examBId}/publish`, { method: 'POST', headers: adminB.headers });
    ok('Org Admin B publishes exam BETA-2026 (HTTP 200)', pubBRes.status === 200);
    const liveBRes = await api(`/api/admin/exams/${examBId}/live`, { method: 'POST', headers: adminB.headers });
    ok('Org Admin B makes exam BETA-2026 LIVE (HTTP 200)', liveBRes.status === 200);

    // Register Candidates in Org A and Org B
    const candARes = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Alice Alpha',
        phone: '9811001100',
        email: 'alice@alpha.student',
        exam_code: 'ALPHA-2026'
      })
    });
    if (candARes.status !== 200) {
      console.log('candARes error:', candARes.status, candARes.data);
    }
    ok('Candidate registers for Org A exam ALPHA-2026 (HTTP 200)', candARes.status === 200);
    const tokenA = candARes.data.token;

    const candBRes = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bob Beta',
        phone: '9822002200',
        email: 'bob@beta.student',
        exam_code: 'BETA-2026'
      })
    });
    ok('Candidate registers for Org B exam BETA-2026 (HTTP 200)', candBRes.status === 200);
    const tokenB = candBRes.data.token;

    // Submit assessments to produce results and certificates
    const subARes = await api(`/api/attempt/${tokenA}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers: { [String(qAId)]: 0 } })
    });
    const certAId = subARes.data.certificate_id;

    const subBRes = await api(`/api/attempt/${tokenB}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers: { [String(qBId)]: 0 } })
    });
    const certBId = subBRes.data.certificate_id;

    // Post proctoring events
    await api(`/api/attempt/${tokenA}/proctoring/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{
          eventId: 'evt_alpha_001_tab',
          eventType: 'TAB_SWITCH',
          timestamp: new Date().toISOString()
        }]
      })
    });

    await api(`/api/attempt/${tokenB}/proctoring/events`, {
      method: 'POST',
      body: JSON.stringify({
        events: [{
          eventId: 'evt_beta_001_tab',
          eventType: 'TAB_SWITCH',
          timestamp: new Date().toISOString()
        }]
      })
    });

    // 5. Twenty Mandatory Cross-Tenant Attack Scenarios
    console.log('\n--- 5. Executing 20 Cross-Tenant Attack Scenarios ---');

    // Scenario 1: Org A cannot read Org B's exam
    const atk1 = await api(`/api/admin/exams/${examBId}`, { headers: adminA.headers });
    if (atk1.status !== 403) console.log('atk1 status & data:', atk1.status, atk1.data);
    ok('Attack 1: Org A cannot read Org B exam (HTTP 403)', atk1.status === 403);

    // Scenario 2: Org A cannot modify Org B's exam
    const atk2 = await api(`/api/admin/exams/${examBId}`, {
      method: 'PUT',
      headers: adminA.headers,
      body: JSON.stringify({ name: 'Tampered by Org A' })
    });
    ok('Attack 2: Org A cannot modify Org B exam (HTTP 403)', atk2.status === 403);

    // Scenario 3: Org A cannot delete or archive Org B's exam
    const atk3 = await api(`/api/admin/exams/${examBId}/archive`, {
      method: 'POST',
      headers: adminA.headers
    });
    ok('Attack 3: Org A cannot archive Org B exam (HTTP 403)', atk3.status === 403);

    // Scenario 4: Org A cannot read Org B's questions
    const atk4 = await api(`/api/admin/questions/${qBId}`, { headers: adminA.headers });
    ok('Attack 4: Org A cannot read Org B question (HTTP 403)', atk4.status === 403);

    // Scenario 5: Org A cannot insert questions into Org B
    const atk5 = await api('/api/admin/questions', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        type: 'mcq',
        category: 'aptitude',
        question_text: 'Injected question into Org B',
        options: ['A', 'B'],
        correct_index: 0,
        organization_id: orgB.id
      })
    });
    // Cross-tenant parameter manipulation should be rejected with 403 or auto-bound to Org A
    ok('Attack 5: Question creation rejects cross-tenant spoofing (HTTP 403) or binds to Org A',
      atk5.status === 403 || (atk5.status === 201 && (atk5.data?.organization_id === orgA.id || atk5.data?.data?.organization_id === orgA.id))
    );

    // Scenario 6: Org A cannot read Org B's students
    const atk6 = await api('/api/admin/results', { headers: adminA.headers });
    const containsBob = atk6.data.some((r) => r.name === 'Bob Beta' || r.email === 'bob@beta.student');
    ok('Attack 6: Org A results query does not leak Org B candidates', containsBob === false);

    // Scenario 7: Org A cannot access Org B's attempt
    const allAtts = await api('/api/admin/results', { headers: superAdmin.headers });
    const attemptB = allAtts.data.find((r) => r.name === 'Bob Beta');
    const atk7 = await api(`/api/admin/attempts/${attemptB.attempt_id}/proctoring`, { headers: adminA.headers });
    ok('Attack 7: Org A cannot access Org B attempt proctoring (HTTP 403)', atk7.status === 403);

    // Scenario 8: Org A candidate cannot submit answers to Org B attempt token
    const atk8 = await api(`/api/attempt/${tokenB}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers: { [String(qAId)]: 0 } })
    });
    // Idempotent return of existing submitted result without re-grading or corruption
    ok('Attack 8: Attempting to submit cross-tenant token returns idempotent sealed result', atk8.status === 200 && atk8.data.certificate_id === certBId);

    // Scenario 9: Org A admin cannot retrieve Org B's certificate details via admin attempts
    const atk9 = await api(`/api/admin/attempts/${attemptB.attempt_id}/coding-submissions`, { headers: adminA.headers });
    ok('Attack 9: Org A admin cannot inspect Org B coding submissions (HTTP 403)', atk9.status === 403);

    // Scenario 10: Org A cannot read Org B's coding submissions
    const atk10 = await api(`/api/admin/attempts/${attemptB.attempt_id}/coding-submissions`, { headers: adminA.headers });
    ok('Attack 10: Org A blocked from viewing Org B submissions (HTTP 403)', atk10.status === 403);

    // Scenario 11: Org A cannot read Org B's proctoring events
    const atk11 = await api(`/api/admin/attempts/${attemptB.attempt_id}/proctoring`, { headers: adminA.headers });
    ok('Attack 11: Org A blocked from viewing Org B proctoring events (HTTP 403)', atk11.status === 403);

    // Scenario 12: Org A cannot access Org B's analytics or platform metrics
    const atk12 = await api('/api/admin/metrics', { headers: adminA.headers });
    ok('Attack 12: Org A metrics strictly scoped to Org A; platform telemetry protected', atk12.status === 200 && atk12.data.scoped === 'organization' && atk12.data.organizationId === orgA.id);

    // Scenario 13: Org A cannot export Org B's candidate records
    const atk13 = await api('/api/admin/results.csv', { headers: adminA.headers });
    const csvLeaksBob = atk13.raw.includes('Bob Beta') || atk13.raw.includes('bob@beta.student');
    ok('Attack 13: Org A CSV export contains zero records from Org B', csvLeaksBob === false);

    // Scenario 14: Org A cannot modify Org B's users or roles
    const atk14 = await api(`/api/admin/users/${orgBAdminId}`, {
      method: 'PUT',
      headers: adminA.headers,
      body: JSON.stringify({ name: 'Tampered Admin' })
    });
    ok('Attack 14: Org A cannot modify Org B user (HTTP 403)', atk14.status === 403);

    const atk14b = await api(`/api/admin/users/${orgBAdminId}/disable`, {
      method: 'POST',
      headers: adminA.headers
    });
    ok('Attack 14b: Org A cannot disable Org B user (HTTP 403)', atk14b.status === 403);

    // Scenario 15: Cross-tenant certificate cache isolation
    clearCertificateCache();
    // Warm cache for Org B
    await generateCertificate({
      name: 'Bob Beta',
      percentage: 100,
      scholarshipPct: 100,
      certificateId: certBId,
      organizationId: orgB.id,
      dateStr: '1 November 2026',
      brandName: 'Beta Polytechnic'
    });
    // Query cache using Org A context
    const cachedUnderOrgA = getCachedCertificate(orgA.id, certBId);
    ok('Attack 15: Org A cannot access Org B cached certificate buffer', cachedUnderOrgA === null);

    const cachedUnderOrgB = getCachedCertificate(orgB.id, certBId);
    ok('Attack 15b: Org B accesses its own cached certificate buffer successfully', cachedUnderOrgB !== null);

    // Scenario 16: Manipulating organization ID in request headers
    const atk16 = await api('/api/admin/questions', {
      headers: {
        ...adminA.headers,
        'X-Organization-Id': String(orgB.id)
      }
    });
    ok('Attack 16: Spoofing X-Organization-Id header rejected with HTTP 403', atk16.status === 403);

    // Scenario 17: Manipulating organization ID in request body
    const atk17 = await api('/api/admin/users', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        email: 'attacker.intruder@alpha.test',
        password: 'Password123!',
        name: 'Intruder',
        role: 'VIEWER',
        organization_id: orgB.id
      })
    });
    ok('Attack 17: Client body organization_id spoofing rejected with HTTP 403', atk17.status === 403);

    // Scenario 18: Manipulating organization ID in query parameters
    const atk18 = await api(`/api/admin/questions?organization_id=${orgB.id}`, {
      headers: adminA.headers
    });
    ok('Attack 18: Query string organization_id spoofing rejected with HTTP 403', atk18.status === 403);

    // Scenario 19: Use Org B question in Org A exam section
    const draftExamA = await api('/api/admin/exams', {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        name: 'Alpha Draft Exam for Tamper Test',
        code: 'ALPHA-TAMPER',
        duration_minutes: 30,
        passing_score: 1
      })
    });
    const draftExamAId = draftExamA.data?.data?.id || draftExamA.data?.id;
    const draftSecA = await api(`/api/admin/exams/${draftExamAId}/sections`, {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({
        name: 'Draft Section',
        display_order: 1,
        question_selection_mode: 'MANUAL',
        total_questions: 1,
        total_marks: 1
      })
    });
    const draftSecAId = draftSecA.data?.data?.sections?.[0]?.id || draftSecA.data?.sections?.[0]?.id || draftSecA.data?.data?.id || draftSecA.data?.id;

    const atk19 = await api(`/api/admin/exams/${draftExamAId}/sections/${draftSecAId}/questions`, {
      method: 'POST',
      headers: adminA.headers,
      body: JSON.stringify({ question_id: qBId })
    });
    ok('Attack 19: Attaching Org B question to Org A exam section rejected with HTTP 403', atk19.status === 403);

    // Scenario 20: Cross-tenant question listing isolation
    const listA = await api('/api/admin/questions', { headers: adminA.headers });
    const containsQB = listA.data.some((q) => q.id === qBId);
    ok('Attack 20: Org A questions listing does not leak Org B questions', containsQB === false);

    // 6. Organization Status & Lifecycle Isolation
    console.log('\n--- 6. Suspended Organization & Disabled Account Enforcement ---');

    // Suspend Organization C
    const suspendC = await api(`/api/admin/organizations/${orgC.id}`, {
      method: 'PUT',
      headers: superAdmin.headers,
      body: JSON.stringify({ status: 'SUSPENDED' })
    });
    ok('Super Admin suspends Organization C (HTTP 200)', suspendC.status === 200);

    // Attempt request as Org Admin C
    const reqC = await api('/api/admin/questions', { headers: adminC.headers });
    ok('Suspended organization access rejected with HTTP 403', reqC.status === 403 && reqC.data.message.includes('suspended'));

    // Disable a user and verify immediate rejection
    await api(`/api/admin/users/${viewerA.data.id}/disable`, {
      method: 'POST',
      headers: adminA.headers
    });

    const viewerLogin = await loginUser('viewer@alpha.test', 'Password123!');
    ok('Disabled user login rejected with HTTP 401', viewerLogin.status === 401 && viewerLogin.data.message.includes('disabled'));

    // 7. Background Worker Cross-Tenant Verification
    console.log('\n--- 7. Background Worker Tenant Verification ---');
    const workerMismatchResult = await processCodeJob({
      submissionId: 'csub_nonexistent',
      attemptId: 999999
    });
    ok('Worker rejects missing submission record cleanly', workerMismatchResult.status === 'FAILED');

  } finally {
    // Teardown
    console.log('\n--- Teardown: Stopping Test Server ---');
    serverProc.kill();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + ext); } catch {}
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('ALL MULTI-TENANT ISOLATION TESTS PASSED!');
  } else {
    console.error(`MULTI-TENANT ISOLATION TESTS FAILED: ${failures} assertions failed.`);
  }
  console.log('====================================================\n');

  process.exit(failures > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error('Unhandled test suite failure:', err);
  process.exit(1);
});
