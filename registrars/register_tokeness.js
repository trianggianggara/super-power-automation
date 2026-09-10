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

const { sleep, rand, fillHuman, humanMouseMove, humanScroll, clickFirst, gotoWithRetry, handleCookies } = require('../utils/helpers.js');

const CONFIG = {
  // Registration URL
  registerUrl: 'https://tokeness.io/sign-up',
  // Password for Tokeness account
  password: process.env.TOKENESS_PASSWORD || 'PortoAuto202122!',
  // Output file for the credentials & API key
  outputFile: path.join(__dirname, '..', 'data', 'tokeness.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  // Timeouts (ms)
  emailTimeout: 120000,
  otpTimeout: 180000,
  navigateTimeout: 45000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  // Proxy (optional): 'http://user:pass@host:port' or empty to disable
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};

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
  
  // Try connecting via CDP first if the user started Chrome with remote-debugging-port
  let connectedCDP = false;
  if (!isCam) {
    const { chromium } = require('playwright-extra');
    try {
      // Check if debugging port is active on port 9222
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
      // Launch using dynamic persistent directory to mimic Incognito while preserving maximum automation compatibility
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
      
      // Cleanup hook when browser closes to delete the temp profile
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
    // Step 1: Create temp email with clean alphanumeric username (no symbols like underscores)
    armStep('[2/10] Creating temporary email', 60000);
    console.log('[2/10] Creating temporary email...');
    const tempmail = new TempMail();
    
    // Generate clean alphanumeric localpart (e.g. user12a34b) without any underscore or dash
    const cleanLocalPart = `user${rand(100000, 999999)}`;
    const inbox = await tempmail.createInbox(cleanLocalPart);
    const email = inbox.address;
    const username = `user${rand(100000, 999999)}`;
    console.log(`  Email: ${email}`);
    console.log(`  Username: ${username}`);

    // Step 2: Navigate to registration page via homepage funnel
    armStep('[3/10] Opening registration page', 90000);
    console.log('[3/10] Opening tokeness.io homepage...');
    
    // Inject a natural pre-navigation delay for TLS to settle
    await sleep(rand(1500, 3000));
    
    // Go to homepage first
    await gotoWithRetry(page, 'https://tokeness.io', { timeout: CONFIG.navigateTimeout });
    await handleCookies(page);
    await sleep(rand(3000, 5000));
    
    // Click "Sign in" button on the homepage
    console.log('  Clicking Sign in button...');
    const signInBtn = page.locator('a[href="/sign-in"], a:has-text("Sign in")').first();
    await signInBtn.click();
    await page.waitForURL('**/sign-in', { timeout: CONFIG.navigateTimeout }).catch(() => {});
    await sleep(rand(2000, 4000));
    
    // Click "Sign up" button on the Sign in page
    console.log('  Clicking Sign up link...');
    const signUpLink = page.locator('a[href="/sign-up"], a:has-text("Sign up")').first();
    await signUpLink.click();
    await page.waitForURL('**/sign-up', { timeout: CONFIG.navigateTimeout }).catch(() => {});
    await sleep(rand(2000, 4000));

    // Step 3: Handle Turnstile Captcha
    armStep('[4/10] Checking Turnstile captcha', 180000);
    console.log('[4/10] Checking for Cloudflare Turnstile captcha...');
    console.log('  Waiting for solver/manual interaction...');
    console.log('  >>> Please complete the "Verify you are human" checkbox if prompt appears.');
    
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
      // Check if Turnstile has verification failed error on page
      const isFailed = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        return bodyText.includes('Verification failed') || bodyText.includes('验证失败') || bodyText.includes('Troubleshoot');
      }).catch(() => false);

      if (isFailed) {
        console.log('  >>> Cloudflare Turnstile verification failed. Please solve/troubleshoot or switch browser.');
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
      
      // Also check if Send code button became enabled (Turnstile might auto-solve silently)
      const isSendEnabled = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Send code') || b.innerText.includes('发送验证码') || b.innerText.includes('Send'));
        return btn && !btn.disabled;
      }).catch(() => false);

      if (isSendEnabled) {
        console.log('  Send code button became enabled! Continuing...');
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

    // Fill Username
    const usernameInput = page.locator('input[placeholder*="username" i], input[placeholder*="用户名" i]').first();
    await fillHuman(page, usernameInput, username);
    await sleep(rand(300, 600));

    // Fill Email
    const emailInput = page.locator('input[placeholder*="example" i], input[placeholder*="邮箱" i], input[type="email"]').first();
    await fillHuman(page, emailInput, email);
    await sleep(rand(300, 600));

    // Fill Password
    const passwordInput = page.locator('input[placeholder*="password" i], input[placeholder*="密码" i]').first();
    await fillHuman(page, passwordInput, CONFIG.password);
    await sleep(rand(300, 600));

    // Fill Confirm Password
    const confirmPasswordInput = page.locator('input[placeholder*="Confirm" i], input[placeholder*="确认密码" i]').first();
    await fillHuman(page, confirmPasswordInput, CONFIG.password);
    await sleep(rand(300, 600));

    // Accept User Agreement checkbox
    const agreementCheckbox = page.locator('span[role="checkbox"], button[role="checkbox"], input[type="checkbox"]').first();
    if (await agreementCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
      await agreementCheckbox.click();
      console.log('  Agreement checkbox checked');
    }
    await sleep(rand(1000, 2000));

    // Step 5: Click "Send code"
    armStep('[6/10] Requesting OTP code', 60000);
    console.log('[6/10] Clicking Send code button...');
    const sendCodeSelectors = [
      'button:has-text("Send code")',
      'button:has-text("Send")',
      'button:has-text("发送验证码")',
      'span:has-text("Send code")',
      'span:has-text("发送验证码")',
      'button:has-text("Code")',
    ];
    let sendCodeClicked = false;
    for (const sel of sendCodeSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click();
        sendCodeClicked = true;
        console.log(`  Clicked Send code via: ${sel}`);
        break;
      }
    }
    if (!sendCodeClicked) {
      console.log('  [WARN] Send code button not clicked automatically. Trying fallback selector...');
      const fallbackBtn = page.locator('button').filter({ hasText: /code|send|发送/i }).first();
      if (await fallbackBtn.isVisible()) {
        await fallbackBtn.click();
        sendCodeClicked = true;
      }
    }
    await sleep(rand(2000, 3000));

    // Step 6: Wait for OTP Email
    armStep('[7/10] Waiting for OTP email', CONFIG.otpTimeout + 15000);
    console.log('[7/10] Waiting for OTP email...');
    const otp = await tempmail.waitForOtp(email, CONFIG.otpTimeout, 3000);
    if (!otp) {
      console.log('  TIMEOUT: No OTP received.');
      throw new Error('OTP timeout');
    }
    console.log(`  OTP received: ${otp}`);

    // Fill OTP
    armStep('[8/10] Filling OTP and submitting', 60000);
    const otpInput = page.locator('input[placeholder*="Verification" i], input[placeholder*="验证码" i]').first();
    await otpInput.click();
    await sleep(rand(300, 600));
    await otpInput.fill(otp);
    await sleep(rand(1000, 2000));

    // Submit registration
    console.log('  Submitting registration form...');
    const submitBtnSelectors = [
      'button:has-text("Create account")',
      'button:has-text("Register")',
      'button:has-text("注册")',
      'button[type="submit"]',
    ];
    let submitClicked = false;
    for (const sel of submitBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click();
        submitClicked = true;
        console.log(`  Clicked submit via: ${sel}`);
        break;
      }
    }
    if (!submitClicked) {
      console.log('  Trying fallback press Enter on OTP field...');
      await otpInput.press('Enter');
    }

    // Step 7: Wait for landing/redirect to console/dashboard
    armStep('[9/10] Waiting for dashboard redirect', 90000);
    console.log('[9/10] Waiting for redirect to dashboard...');
    
    // Wait for the URL to change from sign-up
    const startUrl = page.url();
    const redirectDeadline = Date.now() + 45000;
    while (Date.now() < redirectDeadline) {
      if (!page.url().includes('sign-up') && !page.url().includes('register')) {
        console.log('  Redirected away from registration page');
        break;
      }
      await sleep(1500);
    }
    await sleep(3000);
    await handleCookies(page);

    // If redirected to login, perform login automatically
    if (page.url().includes('login') || page.url().includes('sign-in')) {
      console.log('  Landed on login page. Logging in...');
      const loginEmailInput = page.locator('input[placeholder*="example" i], input[placeholder*="邮箱" i], input[type="email"]').first();
      await loginEmailInput.fill(email);
      await sleep(500);
      const loginPasswordInput = page.locator('input[placeholder*="password" i], input[placeholder*="密码" i]').first();
      await loginPasswordInput.fill(CONFIG.password);
      await sleep(500);
      const loginBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("登录")').first();
      await loginBtn.click();
      await sleep(5000);
    }

    console.log(`  Current URL: ${page.url()}`);

    // Step 8: Go to API keys / Tokens page and extract key
    armStep('[10/10] Navigating to API key/Token creation', 120000);
    console.log('[10/10] Creating/extracting API Key...');

    // Try common navigation link text (Chinese & English)
    const tokenNavSelectors = [
      'a:has-text("Tokens")',
      'a:has-text("令牌")',
      'a:has-text("Keys")',
      'a:has-text("API")',
      '[href*="token" i]',
      '[href*="key" i]',
    ];
    let foundTokensPage = false;
    for (const selector of tokenNavSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click();
        await sleep(2000);
        foundTokensPage = true;
        console.log(`  Navigated via tab/link: ${selector}`);
        break;
      }
    }

    if (!foundTokensPage) {
      // Direct console URL attempts if we can guess them
      const baseDashboardUrl = page.url().split('#')[0].split('?')[0];
      const paths = ['/token', '/tokens', '/keys', '/settings/tokens', '/dashboard/tokens'];
      for (const p of paths) {
        try {
          await page.goto(baseDashboardUrl + p, { timeout: 10000 });
          await sleep(2000);
          foundTokensPage = true;
          console.log(`  Direct navigated to: ${baseDashboardUrl + p}`);
          break;
        } catch (_) {}
      }
    }

    // Try to click Add / Create button to generate a new key
    const addBtnSelectors = [
      'button:has-text("Add Token")',
      'button:has-text("Create Token")',
      'button:has-text("Add")',
      'button:has-text("Create")',
      'button:has-text("添加")',
      'button:has-text("新建")',
      'button:has-text("创建")',
      'button:has-text("添加令牌")',
      'button:has-text("创建令牌")',
    ];
    let addBtn = null;
    for (const selector of addBtnSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        addBtn = el;
        break;
      }
    }

    if (addBtn) {
      await addBtn.click();
      await sleep(1500);
      console.log('  Create Token modal/form opened');

      // Check for form inputs inside modal (e.g. name/label of token, expiration, etc.)
      const nameInputSelectors = [
        'input[placeholder*="name" i]',
        'input[placeholder*="名称" i]',
        'input[name*="name" i]',
        'input[type="text"]',
      ];
      let nameInput = null;
      for (const selector of nameInputSelectors) {
        const el = page.locator(selector).first();
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

      // Submit Token creation
      const confirmSelectors = [
        'button:has-text("Submit")',
        'button:has-text("Confirm")',
        'button:has-text("OK")',
        'button:has-text("确定")',
        'button:has-text("提交")',
        'button[type="submit"]',
      ];
      let confirmBtn = null;
      for (const selector of confirmSelectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
          confirmBtn = el;
          break;
        }
      }
      if (confirmBtn) {
        await confirmBtn.click();
        await sleep(3000);
        console.log('  Token creation confirmed');
      }
    }

    // Attempt to extract the API token
    let apiKey = '';
    
    // Check for standard display of token patterns (like sk-...) on page
    const textOnPage = await page.locator('body').textContent({ timeout: 5000 }).catch(() => '');
    apiKey = textOnPage.match(/sk-[A-Za-z0-9]{20,}/)?.[0] || '';

    if (!apiKey) {
      // Try to click Copy button to see if it is in clipboard
      const copyBtnSelectors = [
        'button:has-text("Copy")',
        'button:has-text("复制")',
        '[class*="copy" i]',
      ];
      for (const selector of copyBtnSelectors) {
        const el = page.locator(selector).first();
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
      } catch (_) {}
    }

    if (!apiKey) {
      // Look for readonly inputs containing token
      const readonlyInput = page.locator('input[readonly]').first();
      if (await readonlyInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        apiKey = await readonlyInput.inputValue().catch(() => '');
      }
    }

    console.log(`  Extracted API Key: ${apiKey || 'NOT_FOUND'}`);

    // Save to tokeness.csv
    const csvHeaders = 'timestamp,username,email,password,api_key,status';
    const csvRow = [
      new Date().toISOString(),
      username,
      email,
      CONFIG.password,
      apiKey || 'NOT_FOUND',
      'registered',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const exists = fs.existsSync(CONFIG.outputFile);
    if (!exists) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow + '\n', 'utf8');
    console.log(`  Saved to: ${CONFIG.outputFile}`);



    console.log('\n========================================');
    console.log('  TOKENESS REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Username:   ${username}`);
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

// CLI
if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register, CONFIG };
