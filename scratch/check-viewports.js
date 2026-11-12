const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 }
  ];

  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: vp });
    const page = await context.newPage();
    await page.goto('http://localhost:3000/landing.html', { waitUntil: 'networkidle' });

    // Scroll to experience
    await page.evaluate(() => {
      document.querySelector('#experience').scrollIntoView();
    });
    await page.waitForTimeout(500);

    const res = await page.evaluate(() => {
      const line = document.querySelector('.process-connecting-line');
      const reg = document.querySelector('.process-step-item:first-child .step-name');
      const cel = document.querySelector('.process-step-item.step-celebrate .step-name');
      const celDesc = document.querySelector('.process-step-item.step-celebrate .step-desc');
      const wrap = document.querySelector('.process-track-wrapper');
      const circle = document.querySelector('.step-icon-circle');

      const isLineVisible = line && window.getComputedStyle(line).display !== 'none';
      const lineRect = line ? line.getBoundingClientRect() : null;
      const regRect = reg ? reg.getBoundingClientRect() : null;
      const celRect = cel ? cel.getBoundingClientRect() : null;
      const descRect = celDesc ? celDesc.getBoundingClientRect() : null;
      const circleRect = circle ? circle.getBoundingClientRect() : null;

      return {
        isLineVisible,
        lineLeft: lineRect ? lineRect.left : null,
        regLeft: regRect ? regRect.left : null,
        lineRight: lineRect ? lineRect.right : null,
        celRight: celRect ? celRect.right : null,
        celDescText: celDesc ? celDesc.innerText : null,
        celDescHeight: celDesc ? celDesc.clientHeight : null,
        lineTop: lineRect ? lineRect.top : null,
        descBottom: descRect ? descRect.bottom : null,
        circleTop: circleRect ? circleRect.top : null
      };
    });

    console.log(`Viewport ${vp.width}x${vp.height}:`, JSON.stringify(res, null, 2));
    await context.close();
  }

  await browser.close();
})();

