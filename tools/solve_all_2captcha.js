const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { loadEnv } = require('../utils/env.js');
const solvers = require('../utils/demo_solvers.js');
const { sleep } = require('../utils/helpers.js');

loadEnv();

const demoUrls = [
  { name: 'Normal Captcha', url: 'https://2captcha.com/demo/normal', solve: solvers.solveNormal },
  { name: 'Text Captcha', url: 'https://2captcha.com/demo/text', solve: solvers.solveText },
  { name: 'Click Captcha', url: 'https://2captcha.com/demo/clickcaptcha', solve: solvers.solveClick },
  { name: 'Rotate Captcha', url: 'https://2captcha.com/demo/rotatecaptcha', solve: solvers.solveRotate },
  { name: 'reCAPTCHA v2', url: 'https://2captcha.com/demo/recaptcha-v2', solve: solvers.solveRecaptcha },
  { name: 'reCAPTCHA v2 Invisible', url: 'https://2captcha.com/demo/recaptcha-v2-invisible', solve: solvers.solveRecaptcha },
  { name: 'reCAPTCHA v2 Callback', url: 'https://2captcha.com/demo/recaptcha-v2-callback', solve: solvers.solveRecaptcha },
  { name: 'reCAPTCHA v2 Enterprise', url: 'https://2captcha.com/demo/recaptcha-v2-enterprise', solve: solvers.solveRecaptcha },
  { name: 'reCAPTCHA v3', url: 'https://2captcha.com/demo/recaptcha-v3', solve: solvers.solveRecaptcha },
  { name: 'reCAPTCHA v3 Enterprise', url: 'https://2captcha.com/demo/recaptcha-v3-enterprise', solve: solvers.solveRecaptcha },
  { name: 'Cloudflare Turnstile', url: 'https://2captcha.com/demo/cloudflare-turnstile', solve: solvers.solveTurnstile },
  { name: 'GeeTest v3', url: 'https://2captcha.com/demo/geetest', solve: solvers.solveGeetest },
  { name: 'GeeTest v4', url: 'https://2captcha.com/demo/geetest-v4', solve: solvers.solveGeetest },
  { name: 'Solve Media', url: 'https://2captcha.com/demo/solvemedia', solve: async (page) => {
      console.log('  [Solve Media] Solve Media is shut down. Clicking Check directly...');
      await page.click('button:has-text("Check")');
      return true;
  }},
  { name: 'Lemin Captcha', url: 'https://2captcha.com/demo/lemin', solve: solvers.solveLemin },
  { name: 'MTCaptcha', url: 'https://2captcha.com/demo/mtcaptcha', solve: solvers.solveMTCaptcha },
  { name: 'KeyCAPTCHA', url: 'https://2captcha.com/demo/keycaptcha', solve: async (page) => {
      console.log('  [KeyCAPTCHA] KeyCAPTCHA is empty/broken. Clicking Check directly...');
      await page.click('button:has-text("Check")');
      return true;
  }}
];

async function main() {
  console.log('========================================');
  console.log('  STARTING 2CAPTCHA DEMO SOLVER');
  console.log('========================================\n');

  const browser = await chromium.launch({
    headless: false, // Set to false to watch the browser solving live
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });
  
  const report = [];

  for (const demo of demoUrls) {
    console.log(`\n--- [${demo.name}] navigating to ${demo.url} ---`);
    const page = await context.newPage();
    try {
      await page.goto(demo.url, { waitUntil: 'load', timeout: 30000 });
      await sleep(3000);

      // Call the specific solver
      await demo.solve(page, {
        apiKey: process.env.LLM_API_KEY,
        apiUrl: process.env.LLM_API_URL,
        model: process.env.LLM_MODEL
      });

      await sleep(5000);

      // Check success results
      const pageText = await page.innerText('body');
      const screenshotName = `result_${demo.name.replace(/\s+/g, '_').toLowerCase()}.png`;
      const screenshotPath = path.join(__dirname, 'scratch', screenshotName);
      await page.screenshot({ path: screenshotPath });
      
      let status = 'Failed';
      if (pageText.includes('Success') || pageText.includes('passed') || pageText.includes('correct') || pageText.includes('solved') || pageText.includes('verified')) {
        status = 'Success';
      }
      
      console.log(`Result Status: ${status}`);
      console.log(`Saved screenshot to ${screenshotPath}`);
      report.push({ name: demo.name, status, screenshot: screenshotName });
    } catch (e) {
      console.error(`Error solving ${demo.name}:`, e.message);
      const errScreenshotName = `error_${demo.name.replace(/\s+/g, '_').toLowerCase()}.png`;
      const errScreenshotPath = path.join(__dirname, 'scratch', errScreenshotName);
      await page.screenshot({ path: errScreenshotPath }).catch(() => {});
      report.push({ name: demo.name, status: 'Error', error: e.message, screenshot: errScreenshotName });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  console.log('\n========================================');
  console.log('  FINAL RESULTS REPORT');
  console.log('========================================');
  console.table(report);
  console.log('========================================');
}

main().catch(err => {
  console.error('Fatal error running orchestrator:', err);
});
