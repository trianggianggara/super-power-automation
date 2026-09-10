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

const { sleep, rand, fillHuman, humanMouseMove, humanScroll, clickFirst, gotoWithRetry } = require('../utils/helpers.js');
const { solveAliyunCaptcha } = require('../utils/captcha_solver.js');

const CONFIG = {
  registerUrl: 'https://console.openmodel.ai/auth',
  password: process.env.OPENMODEL_PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'openmodel.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  emailTimeout: 120000,
  otpTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};

async function checkRateLimit(page) {
  const rateLimitTexts = [
    "too many requests",
    "try again later",
    "rate limit",
    "banyak permintaan",
    "permintaan terlalu banyak"
  ];
  for (const text of rateLimitTexts) {
    // Search the text in case-insensitive way anywhere on the page
    const locator = page.locator(`text=/${text}/i`).first();
    if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log(`\n[CRITICAL] Rate limit detected: "${text}" is visible on the page!`);
      return true;
    }
  }
  return false;
}

async function register() {
  let browser;
  let context;
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

  let selectedProxy = '';
  try {
    armStep('[1/10] Launching browser in incognito mode', CONFIG.launchTimeout);
    console.log('[1/10] Launching browser...');
    
    const executablePathToUse = CONFIG.browserExecutablePath || '/usr/bin/google-chrome-stable';
    const isCam = isCamoufox(executablePathToUse);
    selectedProxy = selectProxy(CONFIG.proxy);
    
    let connectedCDP = false;
    // We explicitly skip CDP connection to use clean incognito profile
    console.log('  Using Clean Incognito Profile...');

    if (isCam) {
      const launchOpts = {
        headless: envFlag('HEADLESS'),
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      };
      if (selectedProxy) {
        launchOpts.proxy = proxyFromUrl(selectedProxy);
      }
      if (executablePathToUse) {
        launchOpts.executablePath = executablePathToUse;
      }
      browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
      context = await browser.newContext({
        viewport: null,
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
      });
    } else {
      const { chromium } = require('playwright-extra');
      const tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}`);
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

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Step 2: Navigate to console auth page
    armStep('[2/10] Navigating to console auth page', 60000);
    console.log('[2/10] Navigating to OpenModel Console Auth...');
    await page.goto(CONFIG.registerUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await sleep(2000);

    if (await checkRateLimit(page)) {
      console.log('Stopping registration due to rate limit/too many requests.');
      process.exit(1);
    }

    // Step 3: Handle Policy Modal if present
    armStep('[3/10] Handling policy modal', 30000);
    const agreeBtn = page.getByRole('button', { name: /agree/i });
    if (await agreeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('  Clicking Policy Agreement button...');
      await agreeBtn.click();
      await sleep(1000);
    }

    // Switch to Register tab
    console.log('  Switching to Register tab...');
    await page.getByRole('tab', { name: 'Register' }).or(page.locator('button:has-text("Register")')).first().click();
    await sleep(1500);

    // Step 4: Create temporary email with clean alphanumeric prefix (no underscores)
    armStep('[4/10] Creating temporary email', 60000);
    console.log('[4/10] Creating temporary email (alphanumeric)...');
    const tempmail = new TempMail();
    const localPart = `user${Math.floor(1000000 + Math.random() * 9000000)}`;
    const inbox = await tempmail.createInbox(localPart);
    const email = inbox.address;
    console.log(`  Email: ${email}`);

    // Fill email
    await page.locator('input#email-otp').fill(email);
    await sleep(500);

    // Step 5: Send code and trigger captcha
    armStep('[5/10] Clicking Send code and triggering captcha', 30000);
    console.log('[5/10] Clicking Send code...');
    await page.getByRole('button', { name: 'Send code' }).click();
    await sleep(2000);

    if (await checkRateLimit(page)) {
      console.log('Stopping registration due to rate limit/too many requests after clicking Send Code.');
      process.exit(1);
    }

    // Step 6: Wait for captcha resolution (Auto-solve using LLM, fallback to manual)
    armStep('[6/10] Waiting for captcha resolution', 150000);
    console.log('Waiting for captcha to appear...');
    const captchaContainer = page.locator('#tcaptcha_transform_dy, .tencent-captcha__transform, #tCaptchaMaskLayer, .tencent-captcha__mask-layer, #tCaptchaVerifyArea, .tencent-captcha__verify-area, iframe[src*="tcaptcha"]').first();
    let hasCaptcha = false;
    try {
      await captchaContainer.waitFor({ state: 'visible', timeout: 8000 });
      hasCaptcha = true;
    } catch (e) {
      // Timeout means no captcha is displayed
    }

    let solved = false;
    if (hasCaptcha) {
      console.log('CAPTCHA detected! Attempting to solve via LLM...');
      solved = await solveAliyunCaptcha(page, {
        apiKey: process.env.LLM_API_KEY,
        apiUrl: process.env.LLM_API_URL,
        model: process.env.LLM_MODEL,
        retries: 3
      });
      if (solved) {
        console.log('  Captcha solved successfully via LLM.');
      } else {
        console.log('  LLM CAPTCHA solving failed. Please solve manually in the browser window...');
        // Fallback: wait for user to solve manually
        try {
          await page.locator('#tCaptchaVerifyArea, .tencent-captcha__verify-area').first()
            .waitFor({ state: 'hidden', timeout: 120000 });
          solved = true;
        } catch (e) {
          console.log('  Timeout or error waiting for manual captcha to be solved.');
        }
      }
    } else {
      console.log('No CAPTCHA detected or already bypassed.');
      solved = true;
    }

    if (!solved) {
      throw new Error('Captcha was not solved in time.');
    }
    await sleep(2000);

    // Step 7: Wait and fetch OTP code
    armStep('[7/10] Fetching OTP', CONFIG.otpTimeout);
    console.log('[7/10] Waiting for OTP email...');
    let otpCode = '';
    const otpStartTime = Date.now();
    
    while (Date.now() - otpStartTime < CONFIG.otpTimeout) {
      try {
        const messages = await tempmail.getMessages(email);
        for (const msg of messages || []) {
          console.log(`  Found email: "${msg.subject}"`);
          const cleanText = TempMail.cleanHtml(`${msg.subject || ''}\n${msg.text_body || msg.html_body || ''}`);
          const codeMatch = cleanText.match(/verification code is (\d{6})/i) || 
                            cleanText.match(/verification code[^]*?(\d{6})/i) ||
                            cleanText.match(/\b(\d{6})\b/);
          if (codeMatch) {
            otpCode = codeMatch[1];
            console.log(`  Extracted OTP Code: ${otpCode}`);
            break;
          }
        }
        if (otpCode) break;
      } catch (e) {
        console.error('  Error checking messages:', e.message);
      }
      await sleep(3000);
    }

    if (!otpCode) {
      throw new Error('Timeout waiting for OTP email');
    }

    // Step 8: Enter OTP and click Verify
    armStep('[8/10] Entering OTP and verifying', 45000);
    console.log('[8/10] Submitting OTP...');
    await page.locator('input#otp-code').fill(otpCode);
    await sleep(500);
    await page.locator('button[type="submit"]:has-text("Verify")').click();
    await sleep(5000);

    // Capture screenshot after verification
    const verifyScreenshotPath = path.join(__dirname, 'openmodel_after_verify.png');
    await page.screenshot({ path: verifyScreenshotPath });
    console.log(`  Saved screenshot after verify to ${verifyScreenshotPath}`);

    // Verify OTP submission success
    const otpInput = page.locator('input#otp-code');
    const otpInputHidden = await otpInput.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true).catch(() => false);
    if (!otpInputHidden) {
      // Find the error text on the page
      const errorText = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const match = bodyText.match(/(Invalid or expired verification code|incorrect|already exists|error|failed)/i);
        return match ? match[0] : '';
      });
      throw new Error(`OTP Verification failed. OTP input is still visible.${errorText ? ` Error: ${errorText}` : ''}`);
    }

    // Inspect the post-verify page
    const elements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, button')).map(el => ({
        tagName: el.tagName.toLowerCase(),
        id: el.id,
        className: el.className,
        type: el.type,
        placeholder: el.placeholder || '',
        text: el.innerText || el.textContent || '',
        visible: el.offsetWidth > 0 && el.offsetHeight > 0
      }));
    });
    console.log('  Visible elements after Verify:', elements.filter(e => e.visible));

    // Check if password inputs are visible on the page
    const passwordInput = page.locator('input[type="password"], input#password, input[placeholder*="password" i]').first();
    if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('  Password creation fields are visible. Setting password...');
      // Fill password in all password inputs
      const pwCount = await page.locator('input[type="password"]').count();
      for (let i = 0; i < pwCount; i++) {
        await page.locator('input[type="password"]').nth(i).fill(CONFIG.password);
        await sleep(300);
      }
      
      // Click register/submit
      const submitBtn = page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Register")').first();
      await submitBtn.click();
      await sleep(5000);
    }

    // Step 9: API Key generation in dashboard
    armStep('[9/10] Navigating dashboard and creating API Key', 90000);
    console.log('[9/10] Handling dashboard and API Key creation...');
    
    // Screenshot of final/dashboard page
    const finalScreenshotPath = path.join(__dirname, 'openmodel_dashboard.png');
    await page.screenshot({ path: finalScreenshotPath });
    console.log(`  Saved dashboard screenshot to ${finalScreenshotPath}`);

    // Let's print current URL
    const finalUrl = page.url();
    console.log(`  Current URL: ${finalUrl}`);

    // Go to API keys page directly to ensure we are on the right page
    console.log('  Navigating to API keys page...');
    await page.goto('https://console.openmodel.ai/api-keys', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await sleep(2000);

    let apiKey = '';
    let apiKeyName = `auto-${Math.floor(10000 + Math.random() * 90000)}`;

    try {
      // Wait for the "Create API key" button to be visible
      const createBtn = page.locator('button:has-text("Create API key"), button:has-text("Create API Key"), button:has-text("Create key")').first();
      await createBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      if (await createBtn.isVisible().catch(() => false)) {
        console.log('  Found Create API Key button. Clicking it...');
        await createBtn.click();
        await sleep(2000);

        // Check if there is an input field for key name in modal (scoping to dialog)
        const nameInput = page.locator('[role="dialog"] input[placeholder*="key" i], [role="dialog"] input[placeholder*="Name" i], [role="dialog"] input[type="text"]').first();
        if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log(`  Filling key name inside modal: ${apiKeyName}`);
          await nameInput.fill(apiKeyName);
          await sleep(500);
        }

        // Click the submit/confirm button inside the dialog specifically
        const confirmBtn = page.locator('[role="dialog"] button:has-text("Create"), [role="dialog"] button').filter({ hasText: /^Create$/ }).first();
        if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('  Clicking confirm button in modal...');
          await confirmBtn.click();
          await sleep(5000); // Wait for the key to be generated and shown
        }

        // Try to locate the API key (starts with sk- and usually 51 chars long)
        // 1. Scan input fields inside the active dialog
        const inputs = page.locator('[role="dialog"] input');
        const inputCount = await inputs.count();
        for (let i = 0; i < inputCount; i++) {
          const val = await inputs.nth(i).inputValue().catch(() => '');
          if (/^(sk|om)-[a-zA-Z0-9_-]{30,80}$/.test(val)) {
            apiKey = val;
            console.log(`  Extracted API Key from modal input field: ${apiKey}`);
            break;
          }
        }

        // 2. Scan visible text of the active dialog
        if (!apiKey) {
          const dialogText = await page.locator('[role="dialog"]').innerText().catch(() => '');
          const keyMatch = dialogText.match(/\b(sk|om)-[a-zA-Z0-9_-]{30,80}\b/);
          if (keyMatch) {
            apiKey = keyMatch[0];
            console.log(`  Extracted API Key from modal text match: ${apiKey}`);
          }
        }

        // Dismiss the modal once the key is extracted
        if (apiKey) {
          const doneBtn = page.locator('[role="dialog"] button:has-text("Done"), [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("OK")').first();
          if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await doneBtn.click();
            await sleep(1000);
          }
        }
      } else {
        console.error('  Failed to find Create API Key button.');
      }
    } catch (keyErr) {
      console.error('  Error automating API key creation:', keyErr.message);
    }



    // Save outputs
    const csvHeaders = 'timestamp,username,email,password,api_key,status';
    const csvRow = [
      new Date().toISOString(),
      email.split('@')[0],
      email,
      CONFIG.password,
      apiKey || 'MANUAL_REQUIRED',
      'registered',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const exists = fs.existsSync(CONFIG.outputFile);
    if (!exists) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow + '\n', 'utf8');
    console.log(`  Saved credentials to: ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  OPENMODEL.AI REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${CONFIG.password}`);
    console.log(`  API Key:    ${apiKey || 'MANUAL_REQUIRED'}`);
    console.log('========================================\n');

  } catch (err) {
    clearTimeout(stepTimer);
    console.error('ERROR:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
  } finally {
    clearTimeout(stepTimer);
    console.log('Closing browser in 5 seconds...');
    await sleep(5000);
    if (browser) await browser.close();
  }
}

if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register, CONFIG };
