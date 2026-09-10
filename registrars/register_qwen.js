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

const { sleep, rand, gotoWithRetry } = require('../utils/helpers.js');

const CONFIG = {
  registerUrl: 'https://home.qwencloud.com/',
  password: process.env.ALIBABA_PASSWORD || 'AlibabaAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'alibaba.csv'),
  emailTimeout: 120000,
  otpTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};

function acquireLock(lockName, timeoutMs = 10000) {
  const lockFilePath = path.join(__dirname, `${lockName}.lock`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      fs.writeFileSync(lockFilePath, 'locked', { flag: 'wx' });
      return true;
    } catch (err) {
      const sleepDuration = 50 + Math.floor(Math.random() * 100);
      const startInner = Date.now();
      while (Date.now() - startInner < sleepDuration) {}
    }
  }
  console.log(`[WARN] Failed to acquire lock for ${lockName} after ${timeoutMs}ms.`);
  return false;
}

function releaseLock(lockName) {
  const lockFilePath = path.join(__dirname, `${lockName}.lock`);
  try {
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
  } catch (err) {}
}

function loadVCCs() {
  const filePath = path.join(__dirname, 'education.txt');
  if (!fs.existsSync(filePath)) {
    throw new Error('education.txt not found');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  return lines.map(line => {
    const parts = line.split('|');
    const card = parts[0];
    const month = parts[1];
    const year = parts[2];
    const cvc = parts[3];
    const count = parts[4] ? parseInt(parts[4], 10) : 0;
    const status = parts[5] || 'active';
    return { card, month, year, cvc, count, status };
  });
}

function saveVCCs(vccs) {
  const filePath = path.join(__dirname, 'education.txt');
  const lines = vccs.map(vcc => {
    return `${vcc.card}|${vcc.month}|${vcc.year}|${vcc.cvc}|${vcc.count}|${vcc.status}`;
  });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function updateVccStatus(cardNum, status) {
  acquireLock('education');
  try {
    const vccs = loadVCCs();
    let updated = false;
    for (const v of vccs) {
      if (v.card === cardNum) {
        v.status = status;
        updated = true;
      }
    }
    if (updated) {
      saveVCCs(vccs);
    }
  } finally {
    releaseLock('education');
  }
}

function incrementVccCount(cardNum) {
  acquireLock('education');
  try {
    const vccs = loadVCCs();
    let updated = false;
    for (const v of vccs) {
      if (v.card === cardNum) {
        v.count += 1;
        if (v.count >= 7) {
          v.status = 'too_many';
        }
        updated = true;
      }
    }
    if (updated) {
      saveVCCs(vccs);
    }
  } finally {
    releaseLock('education');
  }
}

async function register() {
  let browser;
  let context;
  let page;
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
    armStep('[1/10] Launching browser', CONFIG.launchTimeout);
    console.log('[1/10] Launching browser...');

    const executablePathToUse = CONFIG.browserExecutablePath || '/usr/bin/google-chrome-stable';
    const isCam = isCamoufox(executablePathToUse);
    selectedProxy = selectProxy(CONFIG.proxy);

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
    page = pages.length > 0 ? pages[0] : await context.newPage();

    // Step 2: Create temporary email
    armStep('[2/10] Creating temporary email', 60000);
    console.log('[2/10] Creating temporary email...');
    const tempmail = new TempMail();

    // Determine domain (default to delladolly.biz.id if configured)
    let selectedDomain = 'delladolly.biz.id';
    const domainsEnv = process.env.TEMPMAIL_WEBHOOK_DOMAIN || '';
    const domainsList = domainsEnv.split(',').map(d => d.trim()).filter(Boolean);
    if (domainsList.length > 0) {
      if (domainsList.includes('delladolly.biz.id')) {
        selectedDomain = 'delladolly.biz.id';
      } else {
        selectedDomain = domainsList[0];
      }
    }

    const localPart = `user_${Math.floor(100000 + Math.random() * 900000)}`;
    const inbox = await tempmail.createInbox(localPart, selectedDomain);
    const email = inbox.address;
    console.log(`  Email created: ${email}`);

    // Step 3: Navigate to landing page
    armStep('[3/10] Opening landing page', 60000);
    console.log('[3/10] Opening Qwen Cloud home console...');
    await gotoWithRetry(page, CONFIG.registerUrl, { timeout: 45000 });
    await sleep(3000);

    // Click Sign Up
    console.log('  Clicking Sign Up / Get Started...');
    const signUpLink = page.locator('a:has-text("Sign Up"), button:has-text("Sign Up"), a:has-text("Register"), a[href*="register"], a:has-text("Get Started"), button:has-text("Get Started")').first();
    await signUpLink.click();
    await sleep(5000);

    // If we landed on a login page, click the Sign Up link at the bottom to switch to register mode
    const loginSignUpLink = page.locator('a:has-text("Sign Up")').first();
    if (await loginSignUpLink.count() > 0 && (page.url().includes('login') || await page.locator('button:has-text("Log in with Google")').count() > 0)) {
      console.log('  Landed on login page. Clicking Sign Up link at the bottom to go to register page...');
      await loginSignUpLink.click();
      await sleep(5000);
    }

    // Step 4: Fill email & click Next
    armStep('[4/10] Filling email & clicking Next', 45000);
    console.log('[4/10] Filling email...');
    const emailInput = page.locator('input[type="email"], input[placeholder*="Email" i], input[type="text"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await emailInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(300);
    await emailInput.pressSequentially(email, { delay: 100 });
    await sleep(1000);

    const nextBtn = page.locator('button:has-text("Next"), button[type="submit"]').first();
    await nextBtn.click();
    console.log('  Clicked Next. Waiting for verification code to arrive...');

    // Step 5: Wait for OTP
    armStep('[5/10] Waiting for OTP email', CONFIG.otpTimeout);
    let otp = '';
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIG.otpTimeout) {
      const messages = await tempmail.getMessages(email);
      if (messages && messages.length > 0) {
        const msg = messages[0];
        console.log(`  Received email: "${msg.subject}"`);
        const cleanText = TempMail.cleanHtml(msg.text_body || msg.html_body || '');
        const match = cleanText.match(/verification code for Qwen Cloud is:[^]*?(\d{6})/i) || 
                      cleanText.match(/Your verification code[^]*?(\d{6})/i) ||
                      cleanText.match(/\b\d{6}\b/);
        if (match) {
          otp = match[1];
          break;
        }
      }
      await sleep(3000);
    }

    if (!otp) {
      throw new Error('OTP not received in time.');
    }
    console.log(`  Received OTP: ${otp}`);

    // Step 6: Fill OTP
    armStep('[6/10] Entering OTP', 45000);
    console.log('[6/10] Typing OTP...');
    const firstInput = page.locator('input[inputmode="numeric"]').first();
    await firstInput.waitFor({ state: 'visible', timeout: 15000 });
    await firstInput.click();
    await sleep(500);

    for (const char of otp) {
      await page.keyboard.press(char);
      await sleep(150);
    }
    await sleep(1000);

    // Click Continue on OTP screen if still on OTP page
    const otpContinueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
    if (await page.locator('input[inputmode="numeric"]').count() > 0) {
      console.log('  Clicking OTP Continue/Validate...');
      await otpContinueBtn.click({ timeout: 5000 }).catch(() => {});
    }
    await sleep(5000);

    // Step 7: Handle Country Selection page
    armStep('[7/10] Country Selection and Terms', 60000);
    console.log('[7/10] Checking for Country/Region selection page...');
    try {
      const countryTrigger = page.locator('button:has-text("Select your"), [class*="select-trigger"], [role="combobox"]').first();
      if (await countryTrigger.isVisible({ timeout: 10000 }).catch(() => false)) {
        console.log('  Country selection trigger is visible. Clicking...');
        await countryTrigger.click();
        await sleep(1500);

        console.log('  Selecting United States...');
        const usOption = page.locator('[role="option"]').filter({ hasText: /^United States$/ }).first();
        await usOption.waitFor({ state: 'visible', timeout: 5000 });
        await usOption.click();
        await sleep(1500);

        const triggerText = await countryTrigger.innerText().catch(() => '');
        console.log(`  Trigger text after selection: "${triggerText.trim()}"`);

        console.log('  Checking agreement checkbox...');
        const checkbox = page.locator('input.maas-terms-text__checkbox, input[type="checkbox"]').first();
        await checkbox.check({ force: true }).catch(async () => {
          await checkbox.click({ force: true }).catch(() => {});
        });
        await sleep(1000);

        // Take a screenshot before continuing
        const beforeContinuePath = path.join(__dirname, 'scratch/qwen_before_country_continue.png');
        await page.screenshot({ path: beforeContinuePath }).catch(() => {});
        console.log(`  Saved screenshot before Country page Continue to ${beforeContinuePath}`);

        console.log('  Clicking Continue...');
        const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
        await continueBtn.click();
        await sleep(5000);
      } else {
        console.log('  Country selection page was skipped or auto-navigated.');
      }
    } catch (err) {
      console.log('  Error / skipped country selection:', err.message);
      const errPath = path.join(__dirname, 'scratch/qwen_country_error.png');
      await page.screenshot({ path: errPath }).catch(() => {});
      console.log(`  Saved country error screenshot to ${errPath}`);
    }

    // Wait for console redirect
    console.log('  Waiting for console home to load...');
    await page.waitForURL('**/home.qwencloud.com/**', { timeout: 30000 }).catch(() => {});
    console.log('  Current URL:', page.url());

    // Step 8: Establish SSO and Add Payment Method
    armStep('[8/10] Establishing SSO and Adding Payment Method', 180000);
    console.log('[8/10] Establishing SSO and Adding Payment Method...');
    
    // Load active VCCs
    let vccs = [];
    try {
      vccs = loadVCCs();
    } catch (err) {
      console.log('  Warning: Could not load VCCs from education.txt:', err.message);
    }
    
    const activeVcc = vccs.find(v => v.status === 'active');
    if (!activeVcc) {
      console.log('  Warning: No active VCC found in education.txt. Skipping payment addition.');
    } else {
      console.log(`  Selected VCC for billing: ${activeVcc.card}`);
      
      // Navigate to Pay-As-You-Go Billing page
      console.log('  Navigating to Qwen Billing Pay-As-You-Go page...');
      await gotoWithRetry(page, 'https://home.qwencloud.com/billing/pay-as-you-go', { timeout: 60000 });
      await sleep(10000);
      console.log('  Current URL:', page.url());
      await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_payg_page.png') }).catch(() => {});

      // General login handler helper
      async function handleLoginIfRequired() {
        if (page.url().includes('account.alibabacloud.com') || page.url().includes('account.qwencloud.com')) {
          console.log('  Redirected to login. Performing secondary login...');
          
          // Input email sequentially to trigger validation
          const emailInput = page.locator('input[type="email"], input[placeholder*="Email" i], input[type="text"]').first();
          if (await emailInput.count() > 0) {
            await emailInput.click();
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
            await sleep(300);
            await emailInput.pressSequentially(email, { delay: 100 });
            await sleep(3000);
          }

          // Get existing messages
          const existingMessages = await tempmail.getMessages(email).catch(() => []);
          const existingIds = new Set(existingMessages.map(m => m.id));
          console.log(`  Existing email count in inbox: ${existingIds.size}`);

          const codeField = page.locator('input[placeholder="Verification Code"], input[inputmode="numeric"], input[placeholder*="Code" i]').first();
          const isSinglePage = await codeField.count() > 0;
          
          if (isSinglePage) {
            console.log('  Detected single-page login form. Sending code first...');
            const sendCodeBtn = page.locator('button:has-text("Send Code"), span:has-text("Send Code"), button[type="button"]:has-text("Send Code"), a:has-text("Send Code")').first();
            
            let codeSent = false;
            for (let clickAttempt = 1; clickAttempt <= 3; clickAttempt++) {
              console.log(`  Clicking Send Code (attempt ${clickAttempt})...`);
              await sendCodeBtn.click({ force: true }).catch(err => console.log('  Click error:', err.message));
              await sleep(3000);
              await page.screenshot({ path: path.join(__dirname, `scratch/qwen_otp_send_clicked_attempt_${clickAttempt}.png`) }).catch(() => {});
              
              const btnText = await sendCodeBtn.innerText().catch(() => '');
              console.log(`  Send Code button text after click: "${btnText}"`);
              if (/\d+/.test(btnText) || btnText.toLowerCase().includes('resend') || btnText.toLowerCase().includes('sent')) {
                console.log('  Code successfully sent!');
                codeSent = true;
                break;
              }
            }
            if (!codeSent) {
              console.log('  Warning: Button text did not change, but continuing to check email anyway...');
            }
            
            console.log('  Waiting for OTP email...');
            let otp = '';
            const startTime = Date.now();
            while (Date.now() - startTime < 60000) {
              const messages = await tempmail.getMessages(email).catch(() => []);
              if (messages && messages.length > 0) {
                const newMail = messages.find(m => !existingIds.has(m.id));
                if (newMail) {
                  console.log(`  Received email: "${newMail.subject}"`);
                  const cleanText = TempMail.cleanHtml(newMail.text_body || newMail.html_body || '');
                  const match = cleanText.match(/verification code for Qwen Cloud is:[^]*?(\d{6})/i) || 
                                cleanText.match(/Your verification code[^]*?(\d{6})/i) ||
                                cleanText.match(/\b\d{6}\b/);
                  if (match) {
                    otp = match[1] || match[0];
                    break;
                  }
                }
              }
              await sleep(2000);
            }
            if (!otp) throw new Error('Secondary OTP not received.');
            console.log(`  Secondary OTP: ${otp}`);
            
            await codeField.click();
            await sleep(500);
            for (const char of otp) {
              await page.keyboard.press(char);
              await sleep(150);
            }
            await sleep(1000);
            
            const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]').first();
            await nextBtn.click();
            await sleep(15000);
          } else {
            console.log('  Detected two-step login form. Clicking Next first...');
            const nextBtn = page.locator('button:has-text("Next"), button[type="submit"]').first();
            await nextBtn.click();
            await sleep(5000);
            
            // Click Send Code on OTP page
            const sendOtpBtn = page.locator('button:has-text("Send Code"), span:has-text("Send Code"), button[type="button"]:has-text("Send Code"), a:has-text("Send Code")').first();
            if (await sendOtpBtn.count() > 0) {
              console.log('  Clicking Send Code on OTP page...');
              await sendOtpBtn.click({ force: true });
              await sleep(5000);
            }
            
            console.log('  Waiting for OTP email...');
            let otp = '';
            const startTime = Date.now();
            while (Date.now() - startTime < 60000) {
              const messages = await tempmail.getMessages(email).catch(() => []);
              if (messages && messages.length > 0) {
                const newMail = messages.find(m => !existingIds.has(m.id));
                if (newMail) {
                  console.log(`  Received email: "${newMail.subject}"`);
                  const cleanText = TempMail.cleanHtml(newMail.text_body || newMail.html_body || '');
                  const match = cleanText.match(/verification code for Qwen Cloud is:[^]*?(\d{6})/i) || 
                                cleanText.match(/Your verification code[^]*?(\d{6})/i) ||
                                cleanText.match(/\b\d{6}\b/);
                  if (match) {
                    otp = match[1] || match[0];
                    break;
                  }
                }
              }
              await sleep(2000);
            }
            if (!otp) throw new Error('Secondary OTP not received.');
            console.log(`  Secondary OTP: ${otp}`);
            
            const numericInput = page.locator('input[inputmode="numeric"]').first();
            await numericInput.waitFor({ state: 'visible', timeout: 15000 });
            await numericInput.click();
            await sleep(500);
            for (const char of otp) {
              await page.keyboard.press(char);
              await sleep(150);
            }
            await sleep(1000);
            
            const otpContinueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
            if (await otpContinueBtn.count() > 0) {
              await otpContinueBtn.click({ timeout: 5000 }).catch(() => {});
            }
            await sleep(15000);
          }
          await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_payg_after_secondary_login.png') }).catch(() => {});
        }
      }

      // Look for the "Sign in now" button
      const signInBtn = page.locator('button:has-text("Sign in now")').first();
      if (await signInBtn.count() > 0) {
        console.log('  Found "Sign in now" button. Clicking to synchronize session...');
        await signInBtn.click();
        await sleep(10000);
        console.log('  URL after clicking "Sign in now":', page.url());
        await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_payg_after_sync.png') }).catch(() => {});

        // Run login handler
        await handleLoginIfRequired();
      } else {
        console.log('  No "Sign in now" button found (already logged in).');
      }

      // Navigate to Qwen Billing Overview with target=payment to establish SSO session
      console.log('  Navigating to Qwen Billing Overview (target=payment) to establish SSO...');
      await page.goto('https://home.qwencloud.com/billing/overview?target=payment', { waitUntil: 'load', timeout: 60000 });
      await sleep(15000);
      console.log('  Current URL after Billing Overview navigation:', page.url());
      await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_billing_overview_sso.png') }).catch(() => {});

      // Run login handler if redirected to login page during SSO handshake
      await handleLoginIfRequired();

      // Make sure we are back on billing overview with modal open
      if (!page.url().includes('billing/overview')) {
        console.log('  Navigating back to Qwen Billing Overview (target=payment)...');
        await page.goto('https://home.qwencloud.com/billing/overview?target=payment', { waitUntil: 'load', timeout: 60000 });
        await sleep(10000);
      }

      // Select Credit & Debit Cards option (extremely specific, using text boundary filter)
      console.log('  Selecting Credit & Debit Cards option in Qwen billing modal...');
      const ccOption = page.locator('span, div, label, p').filter({ hasText: /^Credit & Debit Cards$/ }).first();
      await ccOption.click({ force: true });
      await sleep(5000);
      await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_billing_modal_expanded.png') }).catch(() => {});

      // Fallback: If CC option click didn't trigger form loading (still on list page)
      const isCardFormLoaded = await page.locator('input[autocomplete="cc-number"]').count().catch(() => 0) > 0;
      if (!isCardFormLoaded) {
        console.log('  Card form inputs not detected. Trying alternate click targets for Card Option...');
        const ccAlt = page.locator('div[class*="payment-method"], div[class*="card"], li:has-text("Card")').first();
        if (await ccAlt.count() > 0) {
          await ccAlt.click({ force: true });
          await sleep(5000);
        }
      }

      // Check if a "Next" button has appeared in the modal to transition to the card form
      const nextBtn = page.locator('[role="dialog"] button:has-text("Next"), button:has-text("Next"), button:has-text("Continue")').first();
      if (await nextBtn.count() > 0 && await nextBtn.isVisible()) {
        console.log('  Clicking Next to proceed to card details...');
        await nextBtn.click();
        await sleep(5000);
        await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_billing_modal_card_step.png') }).catch(() => {});
      }

      const expandedHtml = await page.content().catch(() => '');
      fs.writeFileSync(path.join(__dirname, 'scratch/qwen_billing_modal_expanded.html'), expandedHtml);

      const frames = page.frames();
      console.log(`  Filling card details (searching page and ${frames.length} frames)...`);

      async function attemptFill(target) {
        let filledAny = false;
        const cardSelectors = [
          'input[name*="card" i][name*="num" i]',
          'input[name="cardNo"]',
          'input[id="cardNo"]',
          'input[autocomplete="cc-number"]',
          'input[placeholder*="Card number" i]',
          'input[placeholder*="Card Number" i]',
          'input[id*="card" i][id*="num" i]'
        ];
        for (const sel of cardSelectors) {
          try {
            const el = target.locator(sel).first();
            if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
              await el.click();
              await el.fill(activeVcc.card);
              console.log(`  Filled card number using selector: ${sel}`);
              filledAny = true;
              break;
            }
          } catch (_) {}
        }

        const nameSelectors = [
          'input[name*="holder" i]',
          'input[name*="name" i]',
          'input[placeholder*="Holder" i]',
          'input[id*="holder" i]',
          'input[id*="name" i]'
        ];
        for (const sel of nameSelectors) {
          try {
            const el = target.locator(sel).first();
            if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
              await el.click();
              await el.fill('Alibaba User');
              console.log(`  Filled cardholder name using selector: ${sel}`);
              filledAny = true;
              break;
            }
          } catch (_) {}
        }

        // Support combined expiry date inputs like MM/YY, including autocomplete cc-exp
        const combinedDateSelectors = [
          'input[autocomplete="cc-exp"]',
          'input[autocomplete*="exp" i]',
          'input[placeholder*="MM" i][placeholder*="YY" i]',
          'input[placeholder*="MM / YY" i]',
          'input[placeholder*="MM/YY" i]',
          'input[placeholder*="Expiry" i]',
          'input[placeholder*="Expiration" i]',
          'input[name*="expiry" i]',
          'input[name*="date" i]',
          'input[id*="exp" i]',
          'input[id*="date" i]'
        ];
        let filledCombinedDate = false;
        for (const sel of combinedDateSelectors) {
          try {
            const el = target.locator(sel).first();
            if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
              await el.click();
              const yy = activeVcc.year.slice(-2);
              await el.fill(`${activeVcc.month}/${yy}`);
              console.log(`  Filled expiry date (MM/YY) using selector: ${sel}`);
              filledAny = true;
              filledCombinedDate = true;
              break;
            }
          } catch (_) {}
        }

        if (!filledCombinedDate) {
          const monthSelectors = [
            'input[name*="month" i]',
            'select[name*="month" i]',
            'input[placeholder*="MM"]',
            'input[placeholder*="Month" i]',
            'select[placeholder*="Month" i]'
          ];
          for (const sel of monthSelectors) {
            try {
              const el = target.locator(sel).first();
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                const tagName = await el.tagName().catch(() => '');
                if (tagName === 'SELECT') {
                  await el.selectOption(activeVcc.month);
                } else {
                  await el.click();
                  await el.fill(activeVcc.month);
                }
                console.log(`  Filled expiry month using selector: ${sel}`);
                filledAny = true;
                break;
              }
            } catch (_) {}
          }

          const yearSelectors = [
            'input[name*="year" i]',
            'select[name*="year" i]',
            'input[placeholder*="YY"]',
            'input[placeholder*="YYYY"]',
            'select[placeholder*="Year" i]'
          ];
          for (const sel of yearSelectors) {
            try {
              const el = target.locator(sel).first();
              if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
                const tagName = await el.tagName().catch(() => '');
                const fullYear = activeVcc.year.length === 2 ? '20' + activeVcc.year : activeVcc.year;
                if (tagName === 'SELECT') {
                  await el.selectOption(activeVcc.year).catch(async () => {
                    await el.selectOption(fullYear);
                  });
                } else {
                  await el.click();
                  await el.fill(activeVcc.year).catch(async () => {
                    await el.fill(fullYear);
                  });
                }
                console.log(`  Filled expiry year using selector: ${sel}`);
                filledAny = true;
                break;
              }
            } catch (_) {}
          }
        }

        const cvvSelectors = [
          'input[name="cvv"]',
          'input[name="cvc"]',
          'input[autocomplete="cc-csc"]',
          'input[placeholder*="CVV" i]',
          'input[placeholder*="CVC" i]',
          'input[id*="cvv" i]'
        ];
        for (const sel of cvvSelectors) {
          try {
            const el = target.locator(sel).first();
            if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
              await el.click();
              await el.fill(activeVcc.cvc);
              console.log(`  Filled CVV using selector: ${sel}`);
              filledAny = true;
              break;
            }
          } catch (_) {}
        }
        return filledAny;
      }

      await attemptFill(page);
      for (const f of frames) {
        if (f !== page) {
          await attemptFill(f).catch(() => {});
        }
      }

      console.log('  Clicking Save/Submit payment method (linking card)...');
      // Locate the Save/Submit/Confirm button that is visible on the page (inside or outside of the dialog)
      const saveBtn = page.locator('[role="dialog"] button:has-text("Confirm"), [role="dialog"] button:has-text("Save"), [role="dialog"] button[type="submit"], button:has-text("Confirm"), button:has-text("Save")').filter({ visible: true }).first();
      let submitted = false;
      if (await saveBtn.count() > 0) {
        if (await saveBtn.isDisabled()) {
          console.log('  Confirm button is disabled. Waiting for form validation to clear...');
          await sleep(5000);
        }
        await saveBtn.click({ force: true });
        submitted = true;
        console.log('  Clicked Confirm button.');
      } else {
        // Fallback search frames for submit button
        for (const f of frames) {
          if (f !== page) {
            const frameSaveBtn = f.locator('button:has-text("Confirm"), button:has-text("Save"), button:has-text("Submit"), button[type="submit"], button:has-text("Next")').filter({ visible: true }).first();
            if (await frameSaveBtn.count() > 0) {
              await frameSaveBtn.click({ force: true });
              submitted = true;
              console.log('  Clicked Confirm button in frame.');
              break;
            }
          }
        }
      }

      if (submitted) {
        console.log('  Card link requested. Waiting for billing address form to load...');
        await sleep(15000);
        await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_payment_submitted.png') }).catch(() => {});
        incrementVccCount(activeVcc.card);

        // Fill Billing Address Form
        const addressLine1Input = page.locator('input[placeholder*="address line 1" i], input[placeholder*="Address Line 1" i], input[placeholder*="Address line 1" i]').first();
        if (await addressLine1Input.count() > 0 && await addressLine1Input.isVisible()) {
          console.log('  Billing address inputs detected. Filling billing address form...');
          
          // First Name
          const firstName = page.locator('input[placeholder*="first name" i], input[placeholder*="First Name" i]').first();
          if (await firstName.count() > 0) {
            await firstName.click();
            await firstName.fill('John');
          }
          
          // Last Name
          const lastName = page.locator('input[placeholder*="last name" i], input[placeholder*="Last Name" i]').first();
          if (await lastName.count() > 0) {
            await lastName.click();
            await lastName.fill('Doe');
          }
          
          // Address Line 1
          await addressLine1Input.click();
          await addressLine1Input.fill('120 Main Street');
          
          // City
          const city = page.locator('input[placeholder*="city" i], input[placeholder*="City" i]').first();
          if (await city.count() > 0) {
            await city.click();
            await city.fill('New York');
          }
          
          // Post Code
          const zip = page.locator('input[placeholder*="post code" i], input[placeholder*="postal" i], input[placeholder*="Post Code" i], input[placeholder*="Zip" i]').first();
          if (await zip.count() > 0) {
            await zip.click();
            await zip.fill('10001');
          }
          
          // Phone Number
          const phone = page.locator('input[placeholder*="phone number" i], input[placeholder*="Phone" i]').first();
          if (await phone.count() > 0) {
            console.log('  Skipping Phone Number fill to avoid triggering SMS verification block...');
          }

          // State/Province Dropdown handling
          console.log('  Handling State/Province dropdown...');
          const stateTrigger = page.locator('span, div, button, p').filter({ hasText: /^Select state\/province$/ }).first();
          if (await stateTrigger.count() > 0) {
            await stateTrigger.click();
            await sleep(2000);
            
            // Search inside popover/list if applicable
            const searchInput = page.locator('input[placeholder*="search" i], input[placeholder*="Search" i], [role="dialog"] input[type="text"]').first();
            if (await searchInput.count() > 0 && await searchInput.isVisible()) {
              await searchInput.fill('New York');
              await sleep(1000);
            }
            
            // Explicitly click NY option
            const option = page.locator('[role="option"]').filter({ hasText: /^New York$/ }).first();
            if (await option.count() > 0) {
              await option.click();
              console.log('  Selected New York state option.');
            } else {
              // Press ArrowDown and Enter to select first state option
              console.log('  Fallback ArrowDown and Enter to select state option...');
              await page.keyboard.press('ArrowDown');
              await sleep(500);
              await page.keyboard.press('Enter');
            }
          }
          
          await sleep(2000);
          await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_billing_address_filled.png') }).catch(() => {});
          
          // Click final Save button
          console.log('  Clicking final Save button...');
          const saveAddressBtn = page.locator('[role="dialog"] button:has-text("Save"), button:has-text("Save")').filter({ visible: true }).first();
          if (await saveAddressBtn.count() > 0) {
            await saveAddressBtn.click({ force: true });
            console.log('  Clicked final Save button.');
            await sleep(15000);
            await page.screenshot({ path: path.join(__dirname, 'scratch/qwen_billing_address_submitted.png') }).catch(() => {});
          }
        }
      }
    }

    // Step 9: Navigate to API Keys page and Create Key
    armStep('[9/10] Navigating to API Keys page and Creating Key', 90000);
    console.log('[9/10] Navigating to API Keys page...');
    await page.goto('https://home.qwencloud.com/api-keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);
    console.log('  API Keys Page URL:', page.url());

    const keysPagePath = path.join(__dirname, 'scratch/qwen_api_keys_page.png');
    await page.screenshot({ path: keysPagePath }).catch(() => {});
    console.log(`  Saved API Keys page screenshot to ${keysPagePath}`);

    console.log('  Clicking Create API key button...');
    const createBtn = page.locator('button:has-text("Create API key"), button:has-text("+ Create API key")').first();
    await createBtn.click();
    await sleep(2000);

    const modalPath = path.join(__dirname, 'scratch/qwen_key_modal.png');
    await page.screenshot({ path: modalPath }).catch(() => {});
    console.log(`  Saved key creation modal screenshot to ${modalPath}`);

    console.log('  Typing description...');
    const descInput = page.locator('input[placeholder*="Production API key"], input[placeholder*="e.g."]').first();
    const keyName = 'auto-' + Date.now().toString(36);
    await descInput.fill(keyName);
    await sleep(1000);

    console.log('  Clicking Generate Key / Confirm...');
    const generateBtn = page.locator('button:has-text("Generate Key"), button:has-text("Confirm")').first();
    await generateBtn.click();
    await sleep(5000);

    const resultModalPath = path.join(__dirname, 'scratch/qwen_key_result_modal.png');
    await page.screenshot({ path: resultModalPath }).catch(() => {});
    console.log(`  Saved key result modal screenshot to ${resultModalPath}`);

    console.log('  Extracting API Key...');
    let apiKey = '';
    const pageText = await page.innerText('body').catch(() => '');
    const keyMatch = pageText.match(/sk-[a-zA-Z0-9_.-]{30,}/);
    if (keyMatch) {
      apiKey = keyMatch[0];
      console.log(`  Successfully extracted API Key: ${apiKey}`);
    } else {
      apiKey = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const input of inputs) {
          if (input.value && input.value.startsWith('sk-')) {
            return input.value;
          }
        }
        const elements = Array.from(document.querySelectorAll('pre, span, div, code'));
        for (const el of elements) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text.startsWith('sk-') && text.length > 20) {
            return text;
          }
        }
        return '';
      });
      if (apiKey) {
        console.log(`  Successfully extracted API Key from elements: ${apiKey}`);
      } else {
        throw new Error('Failed to find generated API key on the screen.');
      }
    }

    // Step 9.6: Verify and Test the Generated API Key
    armStep('[9.6/10] Verifying and Testing API Key', 60000);
    console.log('[9.6/10] Hit testing the generated API Key with qwen-plus model...');
    let keyWorking = false;
    let hitDetail = '';
    try {
      const fetch = (await import('node-fetch')).default;
      const testUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
      const testPayload = {
        model: 'qwen-plus',
        messages: [{ role: 'user', content: 'ping' }]
      };
      
      const testResponse = await fetch(testUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testPayload)
      });
      
      const testData = await testResponse.json();
      if (testResponse.ok) {
        keyWorking = true;
        hitDetail = testData.choices?.[0]?.message?.content || JSON.stringify(testData);
        console.log(`  Hit Test Successful: "${hitDetail}"`);
      } else {
        hitDetail = testData.error?.message || testData.message || JSON.stringify(testData);
        console.log(`  Hit Test Failed (Status ${testResponse.status}): ${hitDetail}`);
      }
    } catch (testErr) {
      hitDetail = testErr.message;
      console.log(`  Hit Test Error: ${hitDetail}`);
    }

    // Step 10: Save to CSV
    armStep('[10/10] Saving outputs', 30000);
    console.log('[10/10] Saving to CSV...');
    const csvHeaders = 'timestamp,email,password,api_key';
    const csvRow = [
      new Date().toISOString(),
      email,
      CONFIG.password,
      apiKey
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const exists = fs.existsSync(CONFIG.outputFile);
    if (!exists) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow + '\n', 'utf8');
    console.log(`  Saved successfully to: ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  QWEN CLOUD REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${CONFIG.password}`);
    console.log(`  API Key:  ${apiKey}`);
    console.log(`  Saved to: ${CONFIG.outputFile}`);
    console.log('========================================\n');

  } catch (err) {
    clearTimeout(stepTimer);
    console.error('ERROR in main flow:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errPath = path.join(__dirname, 'scratch/qwen_error.png');
    await page.screenshot({ path: errPath }).catch(() => {});
    console.log(`  Saved error screenshot to ${errPath}`);
  } finally {
    clearTimeout(stepTimer);
    if (browser) {
      console.log('Closing browser...');
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register, CONFIG };
