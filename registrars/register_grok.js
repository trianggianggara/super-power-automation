const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const browserExecutable = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
const browserType = browserTypeFor(browserExecutable);
if (!isCamoufox(browserExecutable)) {
  browserType.use(StealthPlugin);
}

const TempMail = require('../services/tempmail/tempmail.js');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { sleep, rand, fillHuman, gotoWithRetry, handleCookies } = require('../utils/helpers.js');
const { randomFirstName, randomLastName } = require('../utils/names.js');

const CONFIG = {
  registerUrl: 'https://grok.com',
  password: process.env.GROK_PASSWORD || process.env.PASSWORD || 'PortoAuto2026!',
  outputFile: path.join(__dirname, '..', 'data', 'grok.csv'),
  emailTimeout: 180000,
  otpTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function decodeQuotedPrintable(str) {
  if (!str) return '';
  let decoded = str.replace(/=\r?\n/g, '');
  decoded = decoded.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return decoded;
}

async function resolveBaseEmail(tempmail) {
  const envGmailUser = process.env.GMAIL_USER || '';
  const emails = envGmailUser.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (emails.length > 0) {
    const selected = emails[Math.floor(Math.random() * emails.length)];
    console.log(`  Selected random email from GMAIL_USER list: ${selected}`);
    return selected;
  }

  let activeGmail = null;
  try {
    const accessToken = await tempmail._refreshGmailToken();
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      activeGmail = profile.emailAddress;
    }
  } catch (err) {
    console.log(`  [WARN] Failed to fetch active Gmail profile: ${err.message}`);
  }

  if (activeGmail) {
    console.log(`  Using active Gmail account fetched dynamically: ${activeGmail}`);
    return activeGmail;
  }
  
  throw new Error("Failed to determine Gmail address. Please set GMAIL_USER in .env.");
}

async function monitorTurnstile(page, resolve, timeoutMs = 60000) {
  console.log('[INFO] monitorTurnstile started for Grok.');
  try {
    let frame = null;
    for (let i = 0; i < 10; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    
    if (!frame) {
      console.log('Turnstile frame not found in frame list.');
      resolve(false);
      return;
    }

    await page.waitForTimeout(2000);

    const startTime = Date.now();
    let clickCount = 0;
    let lastClickTime = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return;

      const tokenValue = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('textarea, input'));
        for (const el of elements) {
          const name = el.getAttribute('name') || '';
          const id = el.getAttribute('id') || '';
          if (
            name.includes('cf-turnstile-response') || 
            id.includes('cf-turnstile-response') || 
            name.includes('g-recaptcha-response') || 
            id.includes('g-recaptcha-response') ||
            name === 'cf_challenge_response' ||
            id.endsWith('_response')
          ) {
            if (el.value && el.value.length > 50) return el.value;
          }
        }
        return null;
      }).catch(() => null);

      if (tokenValue) {
        console.log(`✅ CAPTCHA SOLVED (Token found: ${tokenValue.substring(0, 15)}...)!`);
        resolve(true);
        return;
      }

      const activeFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (!activeFrame) {
        await page.waitForTimeout(1000);
        continue;
      }

      const frameElement = await activeFrame.frameElement().catch(() => null);
      if (frameElement) {
        const isFrameVisible = await frameElement.isVisible().catch(() => false);
        if (isFrameVisible) {
          const box = await frameElement.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const now = Date.now();
            if (now - lastClickTime > 8000) {
              const clickX = box.x + 30;
              const clickY = box.y + box.height / 2;
              clickCount++;
              console.log(`[Click #${clickCount}] Auto-clicking Turnstile checkbox: x=${clickX}, y=${clickY}`);
              await page.mouse.click(clickX, clickY).catch(() => {});
              lastClickTime = now;
            }
          }
        }
      }

      await page.waitForTimeout(2000);
    }
  } catch (err) {
    console.log(`[ERROR] monitorTurnstile failed: ${err.message}`);
  }
  resolve(false);
}

async function handleTurnstile(page, timeoutMs = 25000) {
  return new Promise((resolve) => {
    monitorTurnstile(page, resolve, timeoutMs);
  });
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

  try {
    armStep('[1/8] Launching browser', CONFIG.launchTimeout);
    console.log('=== Grok Auto-Registration Script ===');
    console.log('[1/8] Launching browser...');

    const tempmail = new TempMail();
    const provider = process.env.TEMPMAIL_PROVIDER || TempMail.PROVIDER || 'webhook';

    let email = '';
    let selectedProxy = '';
    if (provider === 'gmail' || process.env.GMAIL_USER) {
      const baseEmail = await resolveBaseEmail(tempmail);
      const atIdx = baseEmail.indexOf('@');
      const username = baseEmail.slice(0, atIdx);
      const domainName = baseEmail.slice(atIdx + 1);
      const cleanUsername = username.replace(/\./g, '').split('+')[0];

      // Load existing emails from grok.csv to avoid duplicates
      const existingEmails = new Set();
      if (fs.existsSync(CONFIG.outputFile)) {
        try {
          const content = fs.readFileSync(CONFIG.outputFile, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts[1]) {
              const cleanEmail = parts[1].replace(/"/g, '').trim().toLowerCase();
              existingEmails.add(cleanEmail);
            }
          }
        } catch (_) {}
      }

      let attempts = 0;
      while (attempts < 1000) {
        let dottedUsername = cleanUsername;
        if (cleanUsername.length > 1 && Math.random() < 0.8) {
          const dotIndex = Math.floor(1 + Math.random() * (cleanUsername.length - 1));
          dottedUsername = cleanUsername.slice(0, dotIndex) + '.' + cleanUsername.slice(dotIndex);
        }
        const candidateEmail = `${dottedUsername}@${domainName}`;
        if (!existingEmails.has(candidateEmail)) {
          email = candidateEmail;
          break;
        }
        attempts++;
      }
      if (!email) {
        email = `${cleanUsername}@${domainName}`;
      }
    } else {
      const inbox = await tempmail.createInbox();
      email = inbox.address;
    }

    console.log(`Generated registration email: ${email}`);

    const executablePathToUse = CONFIG.browserExecutablePath || undefined;
    selectedProxy = selectProxy(CONFIG.proxy);
    const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
    const isCam = isCamoufox(executablePathToUse);
    let tempProfileDir = '';

    const vpWidth = 1366 + rand(-20, 20);
    const vpHeight = 768 + rand(-10, 10);

    if (isCam) {
      console.log('  Launching Camoufox browser...');
      const launchOpts = {
        headless: envFlag('HEADLESS'),
        args: ['--no-sandbox'],
        ignoreHTTPSErrors: true,
      };
      if (selectedProxyConfig) launchOpts.proxy = selectedProxyConfig;
      if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

      browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
      context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
    } else {
      console.log('  Launching Chromium/Brave persistent context...');
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_grok_${Date.now()}_${Math.floor(Math.random() * 100000)}`);
      
      const contextOpts = {
        headless: envFlag('HEADLESS'),
        executablePath: executablePathToUse,
        viewport: { width: vpWidth, height: vpHeight },
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
        ignoreHTTPSErrors: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--incognito',
        ],
      };
      if (selectedProxyConfig) contextOpts.proxy = selectedProxyConfig;

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

    const firstName = randomFirstName();
    const lastName = randomLastName();
    const password = CONFIG.password;
    let ssoCookieVal = '';

    console.log(`[*] Account Profile Details:`);
    console.log(`  - Name:     ${firstName} ${lastName}`);
    console.log(`  - Email:    ${email}`);
    console.log(`  - Password: ${password}`);

    // Step 2: Navigate to Grok login page directly
    armStep('[2/8] Navigating to Grok login page', 90000);
    console.log('[2/8] Opening https://grok.com/login...');
    await page.goto('https://grok.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    await handleCookies(page);
    
    console.log('Checking and solving Cloudflare Turnstile on login page...');
    await handleTurnstile(page, 30000);
    await sleep(3000);
    await page.screenshot({ path: path.join(__dirname, 'grok_step2_login_modal.png') }).catch(() => {});

    // Step 3: Enter email address
    armStep('[3/8] Filling email address', 60000);
    console.log('[3/8] Submitting email address...');

    // Explicitly click "Don't have an account? Sign up" if we are on the Sign in modal
    const signUpLink = page.locator('a:has-text("Sign up"), button:has-text("Sign up")').first();
    if (await signUpLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Clicking "Don\'t have an account? Sign up" link to open register form...');
      await signUpLink.click();
      await sleep(2000);
      await page.screenshot({ path: path.join(__dirname, 'grok_step3_signup_modal.png') }).catch(() => {});
    }

    // Click "Sign up with email" / "Login with email" option button if visible
    const emailOptionBtn = page.locator('button:has-text("Sign up with email"), button:has-text("Login with email"), a:has-text("Login with email"), a:has-text("Sign up with email")').first();
    if (await emailOptionBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Found email signup/login button, clicking...');
      await emailOptionBtn.click();
      await sleep(2000);
    }

    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    await fillHuman(page, emailInput, email);
    await sleep(1000);
    await page.screenshot({ path: path.join(__dirname, 'grok_step4_email_filled.png') }).catch(() => {});

    const submitBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Sign Up")').first();
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await emailInput.press('Enter');
    }
    await sleep(3000);

    // Check if password input field appears immediately
    const pwdInputStep3 = page.locator('input[type="password"]').first();
    if (await pwdInputStep3.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Filling password...');
      await fillHuman(page, pwdInputStep3, password);
      await sleep(1000);

      const submitPwdBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Sign Up"), button:has-text("Log in")').first();
      if (await submitPwdBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitPwdBtn.click();
      } else {
        await pwdInputStep3.press('Enter');
      }
      await sleep(5000);
    }

    // Step 4: Wait for verification email & OTP
    armStep('[4/8] Waiting for verification email OTP', CONFIG.emailTimeout);
    console.log('[4/8] Waiting for verification OTP code...');

    let otpCode = '';
    const startOtpTime = Date.now();
    while (Date.now() - startOtpTime < CONFIG.emailTimeout) {
      try {
        const messages = await tempmail.getMessages(email);
        const otpMsg = messages.find(m => 
          (m.subject && (m.subject.toLowerCase().includes("x.ai") || m.subject.toLowerCase().includes("spacexai") || m.subject.toLowerCase().includes("confirmation"))) ||
          (m.from_address && (m.from_address.toLowerCase().includes("x.ai") || m.from_address.toLowerCase().includes("spacexai")))
        );
        if (otpMsg) {
          const code = TempMail.extractOtp(otpMsg.subject, otpMsg.text_body, otpMsg.html_body);
          if (code && code.length >= 6) {
            otpCode = code;
            break;
          }
        }
      } catch (e) {
        console.error("  Polling error:", e.message);
      }
      await sleep(5000);
    }

    if (!otpCode) {
      throw new Error('Verification OTP code not received for Grok sign-up.');
    }
    console.log(`  Received OTP code: ${otpCode}`);

    // Step 5: Input OTP code
    armStep('[5/8] Submitting OTP code', 60000);
    console.log('[5/8] Filling OTP code into verification inputs...');
    
    // Support single input or multi-digit input boxes (e.g. 6 separate input boxes)
    const digitInputs = page.locator('input[type="text"], input[inputmode="numeric"], input[name*="code" i]');
    const count = await digitInputs.count().catch(() => 0);

    if (count >= 6) {
      console.log(`  Filling ${otpCode.length} digits into separate input boxes...`);
      for (let i = 0; i < Math.min(count, otpCode.length); i++) {
        await digitInputs.nth(i).fill(otpCode[i]);
        await sleep(150);
      }
    } else {
      const singleOtpInput = digitInputs.first();
      await singleOtpInput.waitFor({ state: 'visible', timeout: 15000 });
      await fillHuman(page, singleOtpInput, otpCode);
    }
    await sleep(2000);
    await page.screenshot({ path: path.join(__dirname, 'grok_step5_otp_filled.png') }).catch(() => {});

    const confirmOtpBtn = page.locator('button:has-text("Confirm email"), button:has-text("Confirm"), button:has-text("Verify"), button[type="submit"]').first();
    if (await confirmOtpBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  Clicking Confirm Email button...');
      await confirmOtpBtn.click();
      await sleep(5000);
    }

    // Step 6: Complete Registration Form (First Name, Last Name, Password)
    armStep('[6/8] Completing user profile registration details', 60000);
    console.log('[6/8] Filling profile details (First Name, Last Name, Password)...');
    await sleep(3000);

    await handleCookies(page);
    await handleTurnstile(page, 15000);

    const fnInput = page.locator('input[placeholder*="First" i], input[name="firstName"], input[name="first_name"], input[placeholder="First name"]').first();
    const lnInput = page.locator('input[placeholder*="Last" i], input[name="lastName"], input[name="last_name"], input[placeholder="Last name"]').first();
    const nameInput = page.locator('input[name="name"], input[placeholder*="Name" i]').first();

    if (await fnInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      console.log(`  Filling First Name: ${firstName}`);
      await fillHuman(page, fnInput, firstName);
      await sleep(1000);

      if (await lnInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`  Filling Last Name: ${lastName}`);
        await fillHuman(page, lnInput, lastName);
        await sleep(1000);
      }
    } else if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      const fullName = `${firstName} ${lastName}`;
      console.log(`  Filling Full Name: ${fullName}`);
      await fillHuman(page, nameInput, fullName);
      await sleep(500);
    }

    const pwdInput = page.locator('input[type="password"]').first();
    if (await pwdInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`  Filling Password: ${password}`);
      await fillHuman(page, pwdInput, password);
      await sleep(500);
    }

    await page.screenshot({ path: path.join(__dirname, 'grok_step6_profile_filled.png') }).catch(() => {});

    const completeBtn = page.locator('button:has-text("Complete sign up"), button[type="submit"], button:has-text("Create account"), button:has-text("Continue"), button:has-text("Submit")').first();
    if (await completeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  Submitting completed profile form...');
      await completeBtn.click();
      await sleep(10000);

      try {
        const cookies = await context.cookies().catch(() => []);
        const ssoCookie = cookies.find(c => c.name === 'sso');
        if (ssoCookie) {
          ssoCookieVal = ssoCookie.value;
          console.log(`  Successfully extracted Grok SSO Cookie: ${ssoCookieVal.substring(0, 20)}...`);
        } else {
          console.log('  [WARN] Grok SSO cookie not found in browser context right after registration.');
        }
      } catch (err) {
        console.log(`  [WARN] Failed to read cookies: ${err.message}`);
      }
    }

    // Step 7: Navigate to xAI console & Create API Key
    armStep('[7/8] Generating and extracting API Key from xAI Console', 90000);
    console.log('[7/8] Navigating to xAI Console (https://console.x.ai/)...');
    await page.goto('https://console.x.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(5000);

    await handleCookies(page);
    await handleTurnstile(page, 15000);

    // Take screenshot of the main dashboard
    await page.screenshot({ path: path.join(__dirname, 'grok_step7_console_dashboard.png') }).catch(() => {});

    // First click the "API Keys" sidebar link to navigate to the API Keys tab
    const apiKeysTabLink = page.locator('a:has-text("API Keys"), a[href*="api-keys"], a:has-text("API keys")').first();
    if (await apiKeysTabLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Found API Keys tab navigation link, clicking...');
      await apiKeysTabLink.click();
      await sleep(3000);
      await handleTurnstile(page, 10000);
    }

    // Take screenshot of the API keys page
    await page.screenshot({ path: path.join(__dirname, 'grok_step7_api_keys_page.png') }).catch(() => {});

    let apiKey = '';

    // Check if actual Create API Key button exists on the page
    const createKeyBtnSelectors = [
      'button:has-text("Create API Key")',
      'button:has-text("Create API key")',
      'button:has-text("Create key")',
      'button:has-text("New API Key")',
      'button:has-text("Create new key")',
      'button:has-text("Create")',
      'a:has-text("Create API Key")',
      'a:has-text("Create API key")',
    ];

    let createKeyBtn = null;
    for (const sel of createKeyBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        createKeyBtn = btn;
        console.log(`Found Create API Key button: ${sel}`);
        break;
      }
    }

    if (createKeyBtn) {
      await createKeyBtn.click();
      await sleep(2000);
      await page.screenshot({ path: path.join(__dirname, 'grok_step7_create_key_clicked.png') }).catch(() => {});

      // Name key if modal appears
      const keyNameInput = page.locator('[role="dialog"] input, input[placeholder*="name" i], input[placeholder*="Key" i]').first();
      if (await keyNameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await keyNameInput.fill(`auto-${Date.now().toString(36)}`);
        await sleep(500);

        const confirmBtn = page.locator('[role="dialog"] button:has-text("Create"), [role="dialog"] button:has-text("Save"), [role="dialog"] button[type="submit"]').first();
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.click();
          await sleep(3000);
        } else {
          await keyNameInput.press('Enter');
          await sleep(3000);
        }
      }
      await page.screenshot({ path: path.join(__dirname, 'grok_step7_after_key_generation.png') }).catch(() => {});
    }

    // Extract API key from page text or input fields
    const pageText = await page.innerText('body').catch(() => '');
    const keyMatch = pageText.match(/(xai-[A-Za-z0-9_-]{30,80}|gsk_[A-Za-z0-9_-]{30,80})/);
    if (keyMatch) {
      apiKey = keyMatch[0];
      console.log(`  Extracted API Key from text: ${apiKey}`);
    }

    if (!apiKey) {
      const inputs = page.locator('input');
      const inputCount = await inputs.count().catch(() => 0);
      for (let i = 0; i < inputCount; i++) {
        const val = await inputs.nth(i).inputValue().catch(() => '');
        if (val.startsWith('xai-') || val.startsWith('gsk_')) {
          apiKey = val;
          console.log(`  Extracted API Key from input: ${apiKey}`);
          break;
        }
      }
    }

    if (!apiKey) {
      const codeElements = page.locator('code, pre');
      const cCount = await codeElements.count().catch(() => 0);
      for (let i = 0; i < cCount; i++) {
        const val = (await codeElements.nth(i).textContent().catch(() => '')).trim();
        if (val.startsWith('xai-') || val.startsWith('gsk_')) {
          apiKey = val;
          console.log(`  Extracted API Key from code block: ${apiKey}`);
          break;
        }
      }
    }

    // Fallback to session cookie if API key generation requires active billing/team setup
    if (!apiKey) {
      if (ssoCookieVal) {
        apiKey = ssoCookieVal;
        console.log(`  Using extracted Grok SSO Cookie as credentials: ${apiKey.substring(0, 40)}...`);
      } else {
        const cookies = await context.cookies().catch(() => []);
        const authCookie = cookies.find(c => c.name.includes('session') || c.name.includes('token') || c.name.includes('auth') || c.name.includes('sso'));
        if (authCookie) {
          apiKey = `SESSION_${authCookie.name}:${authCookie.value}`;
          console.log(`  Extracted Session Token: ${apiKey.substring(0, 40)}...`);
        }
      }
    }

    if (!apiKey) {
      apiKey = 'REGISTERED_SUCCESS';
    }
    console.log(`  Extracted credentials/token status: ${apiKey}`);

    // Step 8: Save ONLY to grok.csv
    armStep('[8/8] Saving credentials to grok.csv', 30000);
    console.log('[8/8] Saving output ONLY to grok.csv...');

    const headers = 'timestamp,email,password,api_key';
    const row = [
      new Date().toISOString(),
      email,
      password,
      apiKey,
    ].map(v => csvCell(v)).join(',');

    const fileExists = fs.existsSync(CONFIG.outputFile);
    if (!fileExists) {
      fs.writeFileSync(CONFIG.outputFile, headers + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, row + '\n', 'utf8');
    console.log(`✅ Successfully saved account record to ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  GROK REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${password}`);
    console.log(`  API Key:    ${apiKey}`);
    console.log(`  Output:     ${CONFIG.outputFile}`);
    console.log('========================================\n');

  } catch (err) {
    clearTimeout(stepTimer);
    console.error('ERROR in Grok registration flow:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errPath = path.join(__dirname, 'grok_error.png');
    if (page) {
      await page.screenshot({ path: errPath }).catch(() => {});
      console.log(`  Saved error screenshot to: ${errPath}`);
    }
    throw err;
  } finally {
    clearTimeout(stepTimer);
    if (browser) {
      console.log('Closing browser...');
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  register().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { register, CONFIG };
