// ASPIRE — MASTER LANDING PAGE TEST SUITE
// Automated Playwright E2E and Unit Verification for the Immersive Luxury Landing Page.

const path = require('path');
const os = require('os');
const http = require('http');
const { chromium } = require('@playwright/test');

const DB_PATH = path.join(os.tmpdir(), `aspire-landing-test-${Date.now()}-${Math.floor(Math.random() * 10000)}.db`);
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';
process.env.AUTH_SECRET = 'playwright_landing_test_secret_32bytes!';

const { db } = require('../backend/src/db');
const createApp = require('../backend/src/app');
const { seedIfEmpty } = require('../backend/src/data/seed');

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

async function runLandingPageTests() {
  console.log('====================================================');
  console.log('ASPIRE LANDING PAGE: LUXURY IMMERSIVE PLAYWRIGHT SUITE');
  console.log('====================================================\n');

  seedIfEmpty(db);
  const app = createApp();

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Landing Test] Test server running at ${baseUrl}`);

  let browser;
  try {
    console.log('\n--- 1. Launching Headless Chromium ---');
    browser = await chromium.launch({ headless: true });
    ok('Playwright headless Chromium launched successfully', !!browser);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });
    const page = await context.newPage();

    // Track console errors and failed network requests
    const consoleErrors = [];
    const failedRequests = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
    });

    console.log('\n--- 2. Loading Landing Page & Asset Integrity ---');
    const response = await page.goto(`${baseUrl}/landing.html`, { waitUntil: 'networkidle' });
    ok('Landing page HTTP status is 200', response.status() === 200);

    const title = await page.title();
    ok('Title matches brand headline', title.includes('Aspire by Adyapan'));

    // Check console errors
    const filteredErrors = consoleErrors.filter(e => !e.includes('favicon'));
    ok('Zero browser console errors on load', filteredErrors.length === 0, JSON.stringify(filteredErrors));
    ok('Zero failed network requests', failedRequests.length === 0, JSON.stringify(failedRequests));

    // Verify choreographed page-loaded class
    const isLoaded = await page.evaluate(() => document.body.classList.contains('page-loaded'));
    ok('Body has page-loaded class after choreography init', isLoaded);

    console.log('\n--- 3. Hero Section & Focal Composition ---');
    const eyebrow = await page.textContent('.hero-eyebrow');
    ok('Hero eyebrow displays A NEW STANDARD OF OPPORTUNITY', eyebrow.includes('A NEW STANDARD OF OPPORTUNITY'));

    const headline = await page.textContent('#hero-main-title');
    ok('Headline includes "Your ambition."', headline.includes('Your ambition.'));
    ok('Headline includes gold italic "Our opportunity."', headline.includes('Our opportunity.'));
    ok('Headline includes "Your future."', headline.includes('Your future.'));

    const statueVisible = await page.isVisible('.sculpture-img');
    ok('Classical marble statue image is rendered and visible', statueVisible);

    const haloPresent = await page.isVisible('#goldenHalo');
    ok('Golden circular halo element is rendered in hero stage', haloPresent);

    console.log('\n--- 4. Primary CTA Integration to Registration ---');
    const heroCtaHref = await page.getAttribute('.hero-cta-btn', 'href');
    ok('Hero CTA button links directly to registration route', heroCtaHref === '/index.html' || heroCtaHref === './index.html');

    // Click hero CTA and verify navigation to real candidate registration page
    await Promise.all([
      page.waitForNavigation(),
      page.click('.hero-cta-btn')
    ]);
    const currentUrl = page.url();
    ok('Clicking Hero CTA navigates to registration page (/index.html)', currentUrl.includes('index.html'));

    const regFormVisible = await page.isVisible('#regForm');
    ok('Registration form (#regForm) is rendered and active', regFormVisible);

    // Return to landing page
    await page.goto(`${baseUrl}/landing.html`, { waitUntil: 'networkidle' });

    console.log('\n--- 5. Scholarship Highlight Carousel Functionality ---');
    const initialSlideNum = await page.textContent('#carouselCurrentSlide');
    ok('Carousel starts on Slide 01', initialSlideNum.trim() === '01');

    const initialTier = await page.textContent('.carousel-slide.is-active .badge-percentage');
    ok('Slide 1 displays 100% scholarship tier', initialTier.includes('100'));

    // Click Next button
    await page.click('#carouselNextBtn');
    await page.waitForTimeout(200);
    const slide2Num = await page.textContent('#carouselCurrentSlide');
    const slide2Tier = await page.textContent('.carousel-slide.is-active .badge-percentage');
    ok('Clicking Next advances carousel to Slide 02', slide2Num.trim() === '02');
    ok('Slide 2 displays 50% distinguished tier', slide2Tier.includes('50'));

    // Click Next again to Slide 3
    await page.click('#carouselNextBtn');
    await page.waitForTimeout(200);
    const slide3Num = await page.textContent('#carouselCurrentSlide');
    const slide3Tier = await page.textContent('.carousel-slide.is-active .badge-percentage');
    ok('Clicking Next advances carousel to Slide 03', slide3Num.trim() === '03');
    ok('Slide 3 displays 25% merit tier', slide3Tier.includes('25'));

    // Click Next again to Slide 4
    await page.click('#carouselNextBtn');
    await page.waitForTimeout(200);
    const slide4Num = await page.textContent('#carouselCurrentSlide');
    const slide4Tier = await page.textContent('.carousel-slide.is-active .badge-percentage');
    ok('Clicking Next advances carousel to Slide 04', slide4Num.trim() === '04');
    ok('Slide 4 displays 10% foundation tier', slide4Tier.includes('10'));

    // Click Next to wrap around to Slide 1
    await page.click('#carouselNextBtn');
    await page.waitForTimeout(200);
    const wrappedNum = await page.textContent('#carouselCurrentSlide');
    ok('Clicking Next wraps carousel back to Slide 01', wrappedNum.trim() === '01');

    // Click Prev to wrap to Slide 4
    await page.click('#carouselPrevBtn');
    await page.waitForTimeout(200);
    const prevWrappedNum = await page.textContent('#carouselCurrentSlide');
    ok('Clicking Prev wraps carousel to Slide 04', prevWrappedNum.trim() === '04');

    // Keyboard Arrow navigation
    await page.focus('.scholarship-highlight-card');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    const keySlideNum = await page.textContent('#carouselCurrentSlide');
    ok('Pressing ArrowRight on carousel card advances slide', keySlideNum.trim() === '01');

    console.log('\n--- 6. Section 2: The Experience & 4-Step Process ---');
    const expHeadline = await page.textContent('#experience-title');
    ok('Experience headline contains "prove yourself."', expHeadline.includes('prove yourself.'));

    const stepItems = await page.$$('.process-step-item');
    ok('Experience section renders exactly 4 structured steps', stepItems.length === 4);

    const step4Highlighted = await page.isVisible('.step-celebrate .icon-circle-gold');
    ok('Step 04 (Celebrate) has the golden highlighted icon badge', step4Highlighted);

    console.log('\n--- 7. Section 3: The Scholarship Opportunity Tiers ---');
    const tierRows = await page.$$('.tier-table-row');
    ok('Scholarship opportunity displays 4 performance tiers', tierRows.length === 4);

    const tierScores = await page.$$eval('.criteria-score', els => els.map(e => e.textContent.trim()));
    ok('Includes 90%+ tier', tierScores.includes('90%+'));
    ok('Includes 75% – 89% tier', tierScores.includes('75% – 89%'));
    ok('Includes 60% – 74% tier', tierScores.includes('60% – 74%'));
    ok('Includes 40% – 59% tier', tierScores.includes('40% – 59%'));

    console.log('\n--- 8. Interactive FAQs Accordion ---');
    const faqQuestions = await page.$$('.faq-question');
    ok('FAQs accordion contains 4 questions', faqQuestions.length === 4);

    // Initial state of first answer is hidden
    const initialFaqHidden = await page.getAttribute('#faq-ans-1', 'hidden');
    ok('FAQ answer 1 initially has hidden attribute', initialFaqHidden !== null);

    // Click to expand FAQ 1
    await page.click('.faq-question:first-child');
    await page.waitForTimeout(100);
    const expandedFaqHidden = await page.getAttribute('#faq-ans-1', 'hidden');
    const isExpanded = await page.getAttribute('.faq-question:first-child', 'aria-expanded');
    ok('Clicking FAQ 1 expands answer (hidden attribute removed)', expandedFaqHidden === null);
    ok('Clicking FAQ 1 sets aria-expanded="true"', isExpanded === 'true');

    // Click again to collapse
    await page.click('.faq-question:first-child');
    await page.waitForTimeout(100);
    const collapsedFaqHidden = await page.getAttribute('#faq-ans-1', 'hidden');
    ok('Clicking FAQ 1 again collapses answer', collapsedFaqHidden !== null);

    console.log('\n--- 9. Section 4: Architectural Closing Experience ---');
    const closingHeadline = await page.textContent('#closing-title');
    ok('Closing headline contains "Step forward. Shape your future."', closingHeadline.includes('Step forward.') && closingHeadline.includes('Shape your future.'));

    const closingCtaHref = await page.getAttribute('.closing-register-btn', 'href');
    ok('Closing CTA button links to registration page', closingCtaHref === '/index.html' || closingCtaHref === './index.html');

    const brandStatement = await page.textContent('.closing-brand-statement');
    ok('Displays vertical brand signature "Aspire. Achieve. Adyapan."', brandStatement.includes('Aspire') && brandStatement.includes('Achieve') && brandStatement.includes('Adyapan'));

    console.log('\n--- 10. Horizontal Overflow & Responsive Geometry (1440px) ---');
    const overflowDesktop = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    ok('No horizontal overflow on Desktop (1440px)', overflowDesktop);

    console.log('\n--- 11. Tablet Responsiveness (768px) ---');
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(200);
    const overflowTablet = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    ok('No horizontal overflow on Tablet (768px)', overflowTablet);

    console.log('\n--- 12. Mobile Responsiveness & Drawer Navigation (375px) ---');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(200);

    const overflowMobile = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    ok('No horizontal overflow on Mobile (375px)', overflowMobile);

    const hamburgerVisible = await page.isVisible('.menu-toggle-btn');
    ok('Mobile hamburger menu toggle button is visible', hamburgerVisible);

    const desktopNavHidden = await page.isVisible('.desktop-navigation');
    ok('Desktop navigation is hidden on mobile screens', !desktopNavHidden);

    // Open mobile drawer
    await page.click('.menu-toggle-btn');
    await page.waitForTimeout(250);
    const drawerOpen = await page.evaluate(() => {
      const d = document.querySelector('#mobile-nav-drawer');
      return d && d.classList.contains('is-open');
    });
    ok('Clicking hamburger opens mobile navigation drawer (.is-open)', drawerOpen);

    // Close mobile drawer with Escape key
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const drawerClosed = await page.evaluate(() => {
      const d = document.querySelector('#mobile-nav-drawer');
      return d && !d.classList.contains('is-open');
    });
    ok('Pressing Escape key closes mobile navigation drawer', drawerClosed);

    await context.close();
  } catch (err) {
    console.error('Test execution error:', err);
    failedTests++;
  } finally {
    if (browser) await browser.close();
    server.close();
  }

  console.log('\n====================================================');
  console.log(`LANDING PAGE TEST SUMMARY: ${passedTests}/${totalTests} PASSED (Failed: ${failedTests})`);
  console.log('====================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runLandingPageTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

