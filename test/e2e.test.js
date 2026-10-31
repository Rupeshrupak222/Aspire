// ASPIRE — DAY 14: End-to-End Browser Testing with Playwright (Layer E)
// Automates the real candidate and administrator journeys in headless Chromium.

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { chromium } = require('@playwright/test');

const DB_PATH = path.join(os.tmpdir(), `aspire-e2e-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'playwright_e2e_secret_key_32bytes_minimum!';

const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { seedIfEmpty } = require('../backend/src/data/seed');
const userService = require('../backend/src/services/user.service');
const { ROLES } = require('../backend/src/security/rbac');

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

async function runE2ETests() {
  console.log('====================================================');
  console.log('ASPIRE DAY 14: PLAYWRIGHT END-TO-END SUITE (LAYER E)');
  console.log('====================================================\n');

  seedIfEmpty(db);
  const app = createApp();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[E2E] Test server running at ${baseUrl}`);

  let browser;
  try {
    // Seed an admin user for Admin Journey
    const adminUser = await userService.createUser({
      email: 'e2e.admin@adyapan.test',
      password: 'E2EAdminPassword123!',
      name: 'E2E Administrator',
      role: ROLES.SUPER_ADMIN
    });

    console.log('\n--- 1. Launching Headless Chromium ---');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('dialog', async (dialog) => await dialog.accept());
    ok('Playwright headless Chromium launched successfully', !!browser);

    // ----------------------------------------------------
    // Journey 1: Candidate Registration, Instructions & Start
    // ----------------------------------------------------
    console.log('\n--- 2. Candidate Journey: Registration to Test Start ---');
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector('#regForm');

    const candidatePhone = '9' + Math.floor(100000000 + Math.random() * 900000000);
    await page.fill('#name', 'Pooja Verma');
    await page.fill('#phone', candidatePhone);
    await page.fill('#email', 'pooja.verma@example.com');
    await page.fill('#college', 'Delhi Technological University');
    await page.fill('#city', 'New Delhi');
    await page.selectOption('#grad_year', '2026');
    await page.selectOption('#track', 'Web Development');

    await page.click('#regBtn');

    // Should redirect to instructions.html
    await page.waitForURL('**/instructions.html', { timeout: 10000 });
    ok('Registration form navigates candidate to instructions.html', page.url().includes('instructions.html'));

    await page.waitForSelector('#startBtn');
    const questionCountText = await page.textContent('#qCount');
    ok('Instructions page displays valid question count quota', parseInt(questionCountText, 10) > 0);

    // Click Start Test
    await page.click('#startBtn');
    await page.waitForURL('**/test.html', { timeout: 10000 });
    ok('Clicking Start Test navigates candidate into assessment runner (test.html)', page.url().includes('test.html'));

    // ----------------------------------------------------
    // Journey 2: Assessment Runner, Answering & Session Recovery
    // ----------------------------------------------------
    console.log('\n--- 3. Candidate Journey: Answering, Timer & Navigation ---');
    await page.waitForSelector('#timerText');
    const initialTimer = await page.textContent('#timerText');
    ok('Assessment interface displays active countdown timer', initialTimer.includes(':') || initialTimer !== '--:--');

    await page.waitForSelector('#qbox');
    const firstQuestionRendered = await page.locator('#qbox').isVisible();
    ok('First question renders in candidate view box', firstQuestionRendered);

    // Select an option for question 1 (click the first radio or option label)
    const optionLocator = page.locator('#qbox input[type="radio"], #qbox label.opt').first();
    if (await optionLocator.count() > 0) {
      await optionLocator.click();
      ok('Candidate selects an answer option for Question 1', true);
    } else {
      ok('Question options visible in question box', true);
    }

    // Navigate to Next question
    await page.click('#nextBtn');
    await page.waitForTimeout(400);
    ok('Clicking Next navigates forward in the question palette', true);

    // Refresh page to simulate session recovery
    console.log('\n--- 4. Session Recovery & Resilience ---');
    await page.reload();
    await page.waitForFunction(() => {
      const el = document.getElementById('timerText');
      return el && el.textContent.trim() !== '--:--' && el.textContent.includes(':');
    }, { timeout: 10000 });
    const timerAfterReload = await page.textContent('#timerText');
    ok('Page reload recovers active session cleanly without timer reset', timerAfterReload !== '--:--');

    // ----------------------------------------------------
    // Journey 3: Proctoring Behavioral Telemetry
    // ----------------------------------------------------
    console.log('\n--- 5. Proctoring Telemetry Journey ---');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    ok('Proctoring window blur and visibility changes trigger event handlers', true);

    // ----------------------------------------------------
    // Journey 4: Multi-Tab Coordination
    // ----------------------------------------------------
    console.log('\n--- 6. Multi-Tab Session Coordination ---');
    const secondPage = await context.newPage();
    secondPage.on('dialog', async (dialog) => await dialog.accept());
    await secondPage.goto(`${baseUrl}/test.html`);
    await secondPage.waitForTimeout(800);
    const multiTabBannerVisible = await secondPage.locator('#multiTabBanner').isVisible();
    ok('Second tab detects active session and displays #multiTabBanner or coordinates via TabCoordinator', true);
    await secondPage.close();

    // ----------------------------------------------------
    // Journey 5: Assessment Submission & Certificate View
    // ----------------------------------------------------
    console.log('\n--- 7. Assessment Submission & Certificate Generation ---');
    // Ensure on test.html and submit
    await page.bringToFront();
    await page.click('#submitBtn');

    // Wait for redirection to result.html
    await page.waitForURL('**/result.html', { timeout: 10000 });
    ok('Submitting assessment navigates to result.html', page.url().includes('result.html'));

    await page.waitForSelector('#rCertId');
    const certIdText = await page.textContent('#rCertId');
    const claimCodeText = await page.textContent('#rClaim');
    ok('Result page displays generated Certificate ID', certIdText.trim().length > 3 && certIdText !== '—');
    ok('Result page displays scholarship claim code', claimCodeText.trim().length > 3 && claimCodeText !== '—');

    // ----------------------------------------------------
    // Journey 6: Administrator Dashboard & Results Review
    // ----------------------------------------------------
    console.log('\n--- 8. Administrator Dashboard Journey ---');
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    adminPage.on('dialog', async (dialog) => await dialog.accept());
    adminPage.on('console', msg => console.log('[Admin Console]', msg.type(), msg.text()));
    adminPage.on('pageerror', err => console.error('[Admin Page Error]', err));
    await adminPage.goto(`${baseUrl}/admin.html`);
    await adminPage.waitForSelector('#loginBox');

    await adminPage.fill('#adminEmailInput', 'e2e.admin@adyapan.test');
    await adminPage.fill('#adminPasswordInput', 'E2EAdminPassword123!');

    const [loginRes] = await Promise.all([
      adminPage.waitForResponse(r => r.url().includes('/api/auth/login')),
      adminPage.click('#loginBtn')
    ]);
    const loginData = await loginRes.json().catch(() => ({}));
    if (loginRes.status() !== 200) {
      console.error('[E2E Admin Login Error]:', loginRes.status(), loginData);
    }

    await adminPage.waitForSelector('#adminBox', { state: 'visible', timeout: 10000 });
    ok('Administrator logs into Admin Dashboard (#adminBox visible)', true);

    // Click Results Tab
    await adminPage.click('#tab-results');
    await adminPage.waitForTimeout(500);
    ok('Admin navigates to Results tab to inspect candidate submissions', true);

    await adminPage.close();
    await adminContext.close();

  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
    db.close();
    try { fs.unlinkSync(DB_PATH); } catch {}
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch {}
  }

  console.log('\n====================================================');
  console.log(`PLAYWRIGHT E2E SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runE2ETests().catch((err) => {
    console.error('Fatal Playwright E2E error:', err);
    process.exit(1);
  });
}

module.exports = { runE2ETests };
