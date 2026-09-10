const { loadEnv } = require('../utils/env.js');
loadEnv();

const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();

const browserExecutable = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
const browserType = browserTypeFor(browserExecutable);
browserType.use(StealthPlugin);

const TempMail = require('../services/tempmail/tempmail.js');
const fs = require('fs');
const path = require('path');

const { sleep, rand, fillHuman, gotoWithRetry, handleCookies } = require('../utils/helpers.js');

const CONFIG = {
  signupUrl: 'https://ecomagent.in/signup',
  loginUrl: 'https://ecomagent.in/login',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'ecomagent.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  emailTimeout: 120000,
  otpTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};

function decodeQuotedPrintable(str) {
  if (!str) return '';
  let decoded = str.replace(/=\r?\n/g, '');
  decoded = decoded.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return decoded;
}

async function clickTurnstileCheckbox(page) {
  try {
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    if (await turnstileIframe.isVisible().catch(() => false)) {
      const frame = await turnstileIframe.contentFrame();
      if (frame) {
        const selectors = [
          'input[type="checkbox"]',
          '#challenge-stage',
          '.ct-checkbox',
          '#cf-stage',
          '.mark',
          'body'
        ];
        for (const sel of selectors) {
          const checkbox = frame.locator(sel).first();
          if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
            await checkbox.click({ force: true }).catch(() => {});
            console.log(`  Auto-clicked Turnstile checkbox element: ${sel}`);
            return true;
          }
        }
      }
    }
  } catch (err) {
    console.log(`  [WARN] Error clicking Turnstile checkbox: ${err.message}`);
  }
  return false;
}

async function register() {
  let browser;
  let stepTimer;
  
  function armStep(label, timeoutMs = CONFIG.stepTimeout) {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      console.error(`  TIMEOUT: ${label} stuck > ${Math.round(timeoutMs / 1000)}s. Closing browser, exiting...`);
      const forceExit = setTimeout(() => process.exit(1), 5000);
      if (forceExit.unref) forceExit.unref();
      Promise.resolve(browser?.close()).catch(() => {}).finally(() => process.exit(1));
    }, timeoutMs);
  }

  armStep('[1/10] Launching browser', CONFIG.launchTimeout);
  console.log('[1/10] Launching browser...');
  
  const executablePathToUse = CONFIG.browserExecutablePath || '/usr/bin/google-chrome-stable';
  const isCam = isCamoufox(executablePathToUse);
  const selectedProxy = selectProxy(CONFIG.proxy);
  
  let context;
  let connectedCDP = false;
  
  if (!isCam) {
    const { chromium } = require('playwright-extra');
    try {
      const checkRes = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
      if (checkRes && checkRes.ok) {
        console.log('  Found active Google Chrome Remote Debugging port at http://127.0.0.1:9222! Connecting...');
        const browserInstance = await chromium.connectOverCDP('http://127.0.0.1:9222');
        const contexts = browserInstance.contexts();
        context = contexts.length > 0 ? contexts[0] : await browserInstance.newContext();
        connectedCDP = true;
        browser = browserInstance;
      }
    } catch (_) {}
  }
  
  if (!connectedCDP) {
    if (isCam) {
      const launchOpts = {
        headless: envFlag('HEADLESS'),
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
        ],
      };
      if (selectedProxy) {
        launchOpts.proxy = proxyFromUrl(selectedProxy);
        console.log(`  Proxy: ${selectedProxy.split('@').pop() || selectedProxy}`);
      }
      if (executablePathToUse) {
        launchOpts.executablePath = executablePathToUse;
        console.log(`  Browser (Camoufox): ${executablePathToUse}`);
      }
      browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
      
      const contextOpts = {
        viewport: null,
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
      };
      context = await browser.newContext(contextOpts);
    } else {
      const { chromium } = require('playwright-extra');
      const tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}`);
      console.log(`  Browser (Google Chrome Clean Profile): ${executablePathToUse}`);
      console.log(`  Profile path: ${tempProfileDir}`);
      
      const contextOpts = {
        headless: envFlag('HEADLESS'),
        executablePath: executablePathToUse,
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--incognito',
        ],
      };
      if (selectedProxy) {
        contextOpts.proxy = proxyFromUrl(selectedProxy);
        console.log(`  Proxy: ${selectedProxy.split('@').pop() || selectedProxy}`);
      }
      
      context = await chromium.launchPersistentContext(tempProfileDir, contextOpts);
      
      browser = {
        close: async () => {
          await context.close().catch(() => {});
          try {
            if (fs.existsSync(tempProfileDir)) {
              fs.rmSync(tempProfileDir, { recursive: true, force: true });
            }
          } catch (_) {}
        }
      };
    }
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    // Step 1: Create temp email
    armStep('[2/10] Creating temporary email', 60000);
    console.log('[2/10] Creating temporary email...');
    const tempmail = new TempMail();
    const cleanLocalPart = `user${rand(100000, 999999)}`;
    const inbox = await tempmail.createInbox(cleanLocalPart);
    const email = inbox.address;
    console.log(`  Email: ${email}`);

    // Step 2: Navigate to registration page
    armStep('[3/10] Opening registration page', 90000);
    console.log('[3/10] Opening signup page...');
    await gotoWithRetry(page, CONFIG.signupUrl, { timeout: CONFIG.navigateTimeout });
    await handleCookies(page);
    await sleep(rand(2000, 4000));

    // Step 3: Handle Turnstile Captcha
    armStep('[4/10] Checking Turnstile captcha', 180000);
    console.log('[4/10] Checking for Cloudflare Turnstile captcha...');
    console.log('  Waiting for solver/manual interaction...');
    console.log('  >>> Please complete Turnstile human verification if prompted.');
    
    const deadline = Date.now() + 180000;
    let turnstileSolved = false;
    let clickedCheckbox = false;
    while (Date.now() < deadline) {
      if (!clickedCheckbox) {
        const clicked = await clickTurnstileCheckbox(page);
        if (clicked) {
          clickedCheckbox = true;
          await sleep(3000);
        }
      }

      const token = await page.evaluate(() => {
        const els = [
          document.querySelector('[name="cf-turnstile-response"]'),
          document.querySelector('[id*="cf-turnstile-response"]'),
        ];
        for (const el of els) {
          if (el && el.value && el.value.length > 0) return el.value;
        }
        return '';
      }).catch(() => '');

      if (token && token.length > 0) {
        console.log('  Turnstile solved!');
        turnstileSolved = true;
        break;
      }
      await sleep(2000);
    }
    if (!turnstileSolved) {
      console.log('  [WARN] Turnstile not solved, proceeding anyway...');
    }
    await sleep(rand(1000, 2000));

    // Step 4: Fill registration form
    armStep('[5/10] Filling registration form', 60000);
    console.log('[5/10] Filling registration form...');

    const emailInput = page.locator('input[placeholder="you@example.com"]').first();
    await fillHuman(page, emailInput, email);
    await sleep(rand(300, 800));

    const passwordInput = page.locator('input[placeholder="Min. 6 characters"]').first();
    await fillHuman(page, passwordInput, CONFIG.password);
    await sleep(rand(500, 1200));

    // Submit registration
    console.log('  Submitting signup form...');
    const submitBtn = page.locator('button:has-text("Create Account"), button[type="submit"]').first();
    await submitBtn.click();
    await sleep(rand(3000, 6000));

    // Step 5: Wait for email verification link
    armStep('[6/10] Waiting for confirmation email', CONFIG.emailTimeout + 15000);
    console.log('[6/10] Waiting for confirmation email...');
    const msg = await tempmail.waitForEmail(email, CONFIG.emailTimeout);
    if (!msg) {
      throw new Error('Verification email not received.');
    }

    const body = decodeQuotedPrintable(msg.text_body || msg.html_body || '');
    const links = body.match(/https?:\/\/[^\s"'<>]+/g) || [];
    const verifyLink = links.find(link => link.includes('verify') || link.includes('confirm') || link.includes('email-verification') || link.includes('ecomagent.in'));
    if (!verifyLink) {
      throw new Error('Verification link not found in confirmation email.');
    }
    const cleanLink = verifyLink.replace(/&amp;/g, '&');
    console.log(`  Found verification link: ${cleanLink}`);

    // Navigate to verification link
    armStep('[7/10] Verifying email address', 90000);
    console.log('  Opening verification link...');
    await gotoWithRetry(page, cleanLink, { timeout: CONFIG.navigateTimeout });
    await sleep(rand(5000, 8000));
    console.log('  Email verified successfully.');

    // Step 6: Log In
    armStep('[8/10] Logging in', 90000);
    console.log('[8/10] Logging in...');
    await gotoWithRetry(page, CONFIG.loginUrl, { timeout: CONFIG.navigateTimeout });
    await sleep(rand(2000, 4000));

    const loginEmailInput = page.locator('input[placeholder="you@example.com"]').first();
    await fillHuman(page, loginEmailInput, email);
    await sleep(rand(300, 600));

    const loginPasswordInput = page.locator('input[placeholder="Your password"]').first();
    await fillHuman(page, loginPasswordInput, CONFIG.password);
    await sleep(rand(500, 1000));

    const loginBtn = page.locator('button:has-text("Log In"), button[type="submit"]').first();
    await loginBtn.click();
    await sleep(rand(5000, 8000));

    // Step 7: Create API Key
    armStep('[9/10] Navigating to API Key settings', 120000);
    console.log('[9/10] Creating API Key...');

    // Try finding navigation tabs/links to API settings
    const apiNavSelectors = [
      'a:has-text("API Keys")',
      'a:has-text("API")',
      'a:has-text("Keys")',
      'a:has-text("Developer")',
      'a:has-text("Settings")',
      '[href*="api" i]',
      '[href*="key" i]',
      '[href*="settings" i]',
    ];
    let foundApiPage = false;
    for (const sel of apiNavSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click();
        await sleep(rand(2000, 4000));
        foundApiPage = true;
        console.log(`  Navigated via: ${sel}`);
        break;
      }
    }

    if (!foundApiPage) {
      // Direct console paths as fallback
      const baseDashboardUrl = page.url().split('#')[0].split('?')[0];
      const paths = ['/api-keys', '/settings/api', '/dashboard/keys', '/settings', '/keys', '/developer'];
      for (const p of paths) {
        try {
          await page.goto(baseDashboardUrl + p, { timeout: 10000 });
          await sleep(rand(2000, 4000));
          foundApiPage = true;
          console.log(`  Attempted direct navigation to: ${baseDashboardUrl + p}`);
          break;
        } catch (_) {}
      }
    }

    // Try finding a Create or Add API Key button
    const createBtnSelectors = [
      'button:has-text("Create API Key")',
      'button:has-text("Create Key")',
      'button:has-text("New API Key")',
      'button:has-text("Create")',
      'button:has-text("New")',
      'button:has-text("Add")',
      'a:has-text("Create")',
      'a:has-text("New")',
      '[class*="create" i]',
      '[class*="add" i]',
    ];
    let createBtn = null;
    for (const sel of createBtnSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        createBtn = el;
        break;
      }
    }

    if (createBtn) {
      await createBtn.click();
      await sleep(1500);
      console.log('  Create Token modal/form opened');

      // Check for Name input in modal
      const nameInputSelectors = [
        'input[placeholder*="name" i]',
        'input[placeholder*="Name" i]',
        'input[name*="name" i]',
        'input[type="text"]',
      ];
      let nameInput = null;
      for (const sel of nameInputSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          nameInput = el;
          break;
        }
      }
      if (nameInput) {
        const keyName = 'auto-' + Date.now().toString(36);
        await nameInput.fill(keyName);
        console.log(`  Token Name set to: ${keyName}`);
      }

      // Submit API key form
      const confirmSelectors = [
        'button:has-text("Submit")',
        'button:has-text("Confirm")',
        'button:has-text("Create")',
        'button:has-text("Save")',
        'button:has-text("OK")',
        'button[type="submit"]',
      ];
      let confirmBtn = null;
      for (const sel of confirmSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          confirmBtn = el;
          break;
        }
      }
      if (confirmBtn) {
        await confirmBtn.click();
        await sleep(3000);
        console.log('  Token creation confirmed');
      } else if (nameInput) {
        await nameInput.press('Enter');
        await sleep(3000);
      }
    }

    // Step 8: Extract and save API Key
    armStep('[10/10] Extracting and saving API Key', 60000);
    console.log('[10/10] Extracting API Key...');
    let apiKey = '';

    // Search page text for standard token/key patterns
    const textOnPage = await page.locator('body').textContent({ timeout: 5000 }).catch(() => '');
    const keyMatch = textOnPage.match(/\b(sk_[A-Za-z0-9_-]{20,80})\b/);
    if (keyMatch) {
      apiKey = keyMatch[0];
      console.log(`  Extracted API Key from body: ${apiKey}`);
    }

    if (!apiKey) {
      // Try finding readonly inputs containing token
      const inputs = page.locator('input[readonly], input');
      const inputCount = await inputs.count().catch(() => 0);
      for (let i = 0; i < inputCount; i++) {
        const val = await inputs.nth(i).inputValue().catch(() => '');
        if (val.length > 20 && (val.startsWith('sk_') || /^[A-Za-z0-9_-]{20,80}$/.test(val))) {
          apiKey = val;
          console.log(`  Extracted API Key from input: ${apiKey}`);
          break;
        }
      }
    }

    if (!apiKey) {
      // Look for copy button and attempt clipboard extraction
      const copyBtnSelectors = [
        'button:has-text("Copy")',
        '[class*="copy" i]',
      ];
      for (const sel of copyBtnSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          await el.click();
          await sleep(1000);
          console.log('  Clicked Copy button');
          break;
        }
      }

      try {
        apiKey = await Promise.race([
          page.evaluate(() => navigator.clipboard.readText()),
          new Promise(resolve => setTimeout(() => resolve(''), 2000)),
        ]);
        console.log(`  Extracted API Key from clipboard: ${apiKey}`);
      } catch (_) {}
    }

    // Save to ecomagent.csv
    const csvHeaders = 'timestamp,email,password,api_key';
    const csvRow = [
      new Date().toISOString(),
      email,
      CONFIG.password,
      apiKey || 'NOT_FOUND',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const exists = fs.existsSync(CONFIG.outputFile);
    if (!exists) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow + '\n', 'utf8');
    console.log(`  Saved credentials to ${CONFIG.outputFile}`);



    console.log('\n========================================');
    console.log('  ECOMAGENT REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${CONFIG.password}`);
    console.log(`  API Key:    ${apiKey || 'NOT_FOUND'}`);
    console.log('========================================\n');

  } catch (err) {
    clearTimeout(stepTimer);
    console.error('ERROR:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
  } finally {
    clearTimeout(stepTimer);
    await browser?.close();
  }
}

if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register };
