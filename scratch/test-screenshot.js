const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto('http://localhost:3000/landing.html', { waitUntil: 'networkidle' });

  // Scroll to experience section
  await page.evaluate(() => {
    document.querySelector('#experience').scrollIntoView();
  });
  await page.waitForTimeout(1000);

  const data = await page.evaluate(() => {
    const wrapper = document.querySelector('.process-track-wrapper');
    const wrapRect = wrapper.getBoundingClientRect();
    const line = document.querySelector('.process-connecting-line');
    const lineRect = line.getBoundingClientRect();
    const regTitle = document.querySelector('.process-step-item:first-child .step-name');
    const regRect = regTitle.getBoundingClientRect();
    const celTitle = document.querySelector('.process-step-item.step-celebrate .step-name');
    const celRect = celTitle.getBoundingClientRect();
    const descEls = Array.from(document.querySelectorAll('.step-desc')).map(el => ({
      text: el.innerText,
      rect: el.getBoundingClientRect(),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight
    }));
    const circleEls = Array.from(document.querySelectorAll('.step-icon-circle')).map(el => ({
      rect: el.getBoundingClientRect()
    }));

    return {
      wrapRect,
      lineRect,
      regRect,
      celRect,
      descEls,
      circleEls,
      lineStyle: {
        left: line.style.left,
        width: line.style.width,
        top: line.style.top
      }
    };
  });

  console.log('DOM Data:', JSON.stringify(data, null, 2));

  const target = await page.$('.process-track-wrapper');
  if (target) {
    const screenshotPath = path.join(__dirname, 'experience-actual.png');
    await target.screenshot({ path: screenshotPath });
    console.log('Saved screenshot to:', screenshotPath);
  }

  await browser.close();
})();

