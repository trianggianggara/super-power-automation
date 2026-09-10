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

const CONFIG = {
  registerUrl: 'https://console.mistral.ai/',
  password: process.env.MISTRAL_PASSWORD || '',
  outputFile: path.join(__dirname, '..', 'data', 'mistral.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  resultFile: path.join(__dirname, 'result.txt'),
  emailTimeout: 120000,
  otpTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Indonesian names list matching kiro/deepgram behavior
const FIRST_NAMES = ['Della', 'Dolly', 'Diana', 'Dewi', 'Desy', 'Donna', 'Dora', 'Dina', 'Dani', 'Devi', 'Dania', 'Darla', 'Daisy', 'Clara', 'Cindy', 'Celia', 'Chelsea', 'Chloe', 'Alya', 'Anisa', 'Aurel', 'Bella', 'Bianca', 'Citra', 'Dinda', 'Elsa', 'Farah', 'Fiona', 'Gita', 'Hana', 'Indah', 'Intan', 'Irene', 'Jessica', 'Julia', 'Kartika', 'Karin', 'Kayla', 'Laras', 'Laura', 'Lina', 'Maya', 'Mila', 'Nadia', 'Naila', 'Nina', 'Olivia', 'Priska', 'Putri', 'Raina', 'Rani', 'Rara', 'Rika', 'Salsa', 'Santi', 'Sekar', 'Shinta', 'Tania', 'Tasya', 'Tiara', 'Vania', 'Vina', 'Yasmin', 'Zahra'];
const LAST_NAMES = ['Adelia', 'Agata', 'Amanda', 'Amelia', 'Angelina', 'Anindya', 'Aprilia', 'Arianti', 'Arisanti', 'Astuti', 'Aulia', 'Ayuningtyas', 'Putri', 'Sari', 'Lestari', 'Wulandari', 'Anggraini', 'Anggraeni', 'Azzahra', 'Cahyaningrum', 'Damayanti', 'Fitriani', 'Handayani', 'Hapsari', 'Hasanah', 'Hidayati', 'Kirana', 'Kusuma', 'Kusumawati', 'Maharani', 'Maulida', 'Melati', 'Nabila', 'Nadira', 'Ningrum', 'Nuraini', 'Permata', 'Prameswari', 'Puspita', 'Ramadhani', 'Ratnasari', 'Safitri', 'Setianingrum', 'Susanti', 'Syahputri', 'Utami', 'Wijaya', 'Yuliana', 'Zulaikha'];

function getRandomName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return { first, last };
}

async function resolveBaseEmail(tempmail) {
  const envGmailUser = process.env.GMAIL_USER || '';
  const emails = envGmailUser.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (emails.length > 0) {
    const selected = emails[Math.floor(Math.random() * emails.length)];
    console.log(`  Selected random email from GMAIL_USER list: ${selected}`);
    return selected;
  }

  // Fallback Google token method
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
  
  throw new Error("Failed to determine Gmail address. Please check GMAIL_USER or GMAIL_REFRESH_TOKEN.");
}

async function ensureChromeRunning(executablePath = 'google-chrome-stable', port = 9222) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log(`  [CDP] Google Chrome with Remote Debugging is already running on port ${port}.`);
      return true;
    }

    console.log(`  [CDP] Google Chrome Remote Debugging port ${port} NOT detected. Spawning Chrome...`);

    let chromePath = executablePath;
    const lower = chromePath.toLowerCase();
    if (lower === 'cloakbrowser' || lower === 'cloak') {
      chromePath = '/home/nbs59/.cloakbrowser/chromium-146.0.7680.177.5/chrome';
    } else if (lower === 'camoufox' || lower === 'comufox') {
      chromePath = '/home/nbs59/.cache/camoufox/camoufox';
    }

    const tempProfileDir = `/tmp/chrome-debug-profile-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--excludeSwitches=enable-automation',
      '--disable-infobars'
    ];

    console.log(`  [CDP] Spawning chrome: ${chromePath} ${args.join(' ')}`);

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (res && res.ok) {
        console.log('  [CDP] Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Google Chrome remote debugging port ${port} to respond.`);
  } catch (err) {
    console.log(`  [CDP] [ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function clickTurnstileCheckbox(page) {
  try {
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    if (await turnstileIframe.isVisible().catch(() => false)) {
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
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
  } catch (err) {
    console.log(`  [WARN] Error clicking Turnstile checkbox: ${err.message}`);
  }
  return false;
}

async function handleTurnstile(page, timeoutMs = 60000) {
  console.log('Checking for Cloudflare Turnstile...');
  try {
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    const hasTurnstile = await turnstileIframe.isVisible({ timeout: 2000 }).catch(() => false);
    if (!hasTurnstile) {
      console.log('  No Turnstile challenge detected.');
      return true;
    }
  } catch (e) {
    // ignore
  }

  const deadline = Date.now() + timeoutMs;
  let clickedCheckbox = false;
  while (Date.now() < deadline) {
    // Check if Turnstile response is populated
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
      console.log('  Turnstile solved / not blocking.');
      return true;
    }

    if (!clickedCheckbox) {
      const clicked = await clickTurnstileCheckbox(page);
      if (clicked) {
        clickedCheckbox = true;
        await sleep(3000);
      }
    }

    await sleep(2000);
  }
  console.log('  Turnstile check completed (either bypassed or timed out).');
  return false;
}

async function register() {
  let browser;
  let context;
  let page;
  let stepTimer;
  let dynamicPortUsed = null;

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
    armStep('[1/10] Launching browser', CONFIG.launchTimeout);
    console.log('[1/10] Launching browser...');

    const tempmail = new TempMail();
    const provider = TempMail.PROVIDER || process.env.TEMPMAIL_PROVIDER || 'webhook';

    let email = '';
    let selectedProxy = '';
    if (provider === 'gmail') {
      const baseEmail = await resolveBaseEmail(tempmail);
      
      const atIdx = baseEmail.indexOf('@');
      const username = baseEmail.slice(0, atIdx);
      const domainName = baseEmail.slice(atIdx + 1);
      
      const cleanUsername = username.replace(/\./g, '').split('+')[0];
      
      let dottedUsername = cleanUsername[0];
      for (let i = 1; i < cleanUsername.length; i++) {
        if (Math.random() < 0.5) {
          dottedUsername += '.';
        }
        dottedUsername += cleanUsername[i];
      }
      
      const plusSuffix = `+mistral_${Date.now()}_${rand(1000, 9999)}`;
      email = `${dottedUsername}${plusSuffix}@${domainName}`;
    } else {
      const inbox = await tempmail.createInbox();
      email = inbox.address;
    }

    console.log(`Generated registration email: ${email}`);

    const executablePathToUse = CONFIG.browserExecutablePath || undefined;
    selectedProxy = selectProxy(CONFIG.proxy);
    const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
    const isCam = isCamoufox(executablePathToUse);
    let connectedCDP = false;
    let tempProfileDir = '';

    const vpWidth = 1366 + rand(-20, 20);
    const vpHeight = 768 + rand(-10, 10);

    if (isCam) {
      console.log('  Launching Camoufox (Firefox-based)...');
      if (selectedProxy) console.log(`  Using proxy: ${selectedProxy}`);
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
      console.log('  Launching Chromium/Brave with clean persistent context...');
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}_${Math.floor(Math.random() * 100000)}`);
      
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

    // Generate random Indonesian names
    const randName = getRandomName();
    const firstName = randName.first;
    const lastName = randName.last;
    const password = CONFIG.password || `Xq9!${Math.random().toString(36).substring(2, 14)}#Z`;

    console.log(`[*] Account info:`);
    console.log(`  - Name:     ${firstName} ${lastName}`);
    console.log(`  - Email:    ${email}`);
    console.log(`  - Password: ${password}`);

    // Step 3: Navigate to landing/signup page
    armStep('[3/10] Opening signup page', 90000);
    console.log('[3/10] Opening console.mistral.ai...');
    await page.goto(CONFIG.registerUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    // Accept cookies if present
    await handleCookies(page);

    // Check for Turnstile before filling fields
    await handleTurnstile(page, 15000);

    // Step 4: Fill initial email field and click Continue
    armStep('[4/10] Entering email address', 60000);
    console.log('[4/10] Filling initial email address...');
    const initialEmailInput = page.locator('input[placeholder="you@example.com"], input[type="email"]').first();
    await initialEmailInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, initialEmailInput, email);
    await sleep(500);

    // Verify email value to prevent typing errors/autofill corruption
    let filledEmail = await initialEmailInput.inputValue().catch(() => '');
    if (filledEmail !== email) {
      console.log(`  [WARN] Email mismatch! Expected: ${email}, got: ${filledEmail}. Re-filling...`);
      await initialEmailInput.fill('');
      await initialEmailInput.fill(email);
    }
    await sleep(800);

    // Submit email form
    console.log('  Submitting initial email form...');
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('  Clicking Continue button...');
      await continueBtn.click();
    } else {
      console.log('  Continue button not visible, pressing Enter on email field...');
      await initialEmailInput.press('Enter').catch(() => {});
    }
    await sleep(3000);

    // Wait for the form fields to appear
    console.log('  Waiting for signup form password and name fields to load...');
    const firstNameInput = page.locator('input[placeholder="John"], input[placeholder*="First name" i]').first();
    await firstNameInput.waitFor({ state: 'visible', timeout: 15000 });

    const lastNameInput = page.locator('input[placeholder="Doe"], input[placeholder*="Last name" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    console.log('  Filling signup details...');
    await fillHuman(page, firstNameInput, firstName);
    await sleep(300);
    let filledFirstName = await firstNameInput.inputValue().catch(() => '');
    if (filledFirstName !== firstName) {
      await firstNameInput.fill('');
      await firstNameInput.fill(firstName);
    }
    await sleep(rand(300, 600));

    await fillHuman(page, lastNameInput, lastName);
    await sleep(300);
    let filledLastName = await lastNameInput.inputValue().catch(() => '');
    if (filledLastName !== lastName) {
      await lastNameInput.fill('');
      await lastNameInput.fill(lastName);
    }
    await sleep(rand(300, 600));

    await fillHuman(page, passwordInput, password);
    await sleep(300);
    let filledPassword = await passwordInput.inputValue().catch(() => '');
    if (filledPassword !== password) {
      await passwordInput.fill('');
      await passwordInput.fill(password);
    }
    await sleep(rand(500, 1000));

    // Submit signup details
    console.log('  Submitting signup form...');
    const signupBtn = page.locator('button:has-text("Signup"), button[type="submit"]').filter({ visible: true }).first();
    await signupBtn.click();
    await sleep(5000);

    // Step 5: Wait for verification code/OTP
    armStep('[5/10] Waiting for OTP email', CONFIG.otpTimeout);
    console.log('[5/10] Waiting for verification email...');
    const otpCode = await tempmail.waitForOtp(email, CONFIG.otpTimeout);
    if (!otpCode) {
      throw new Error('OTP not received in time.');
    }
    console.log(`  Received OTP: ${otpCode}`);

    // Step 6: Enter OTP code
    armStep('[6/10] Entering OTP code', 45000);
    console.log('[6/10] Submitting OTP...');
    const codeInput = page.locator('input[name="code"], input[placeholder*="code" i], input[inputmode="numeric"]').first();
    await codeInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, codeInput, otpCode);
    await sleep(2000);

    const successText = page.locator('text="Email successfully verified"');
    const continueArrowBtn = page.locator('button, a').filter({ hasText: 'Continue' }).filter({ visible: true }).first();

    if (await successText.isVisible({ timeout: 5000 }).catch(() => false) ||
        await continueArrowBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('  Email verified automatically. Clicking Continue...');
      await continueArrowBtn.click();
    } else {
      console.log('  Did not auto-submit. Finding and clicking verification button...');
      const verifyBtn = page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Confirm")').filter({ visible: true }).first();
      await verifyBtn.click();
    }
    await sleep(8000);

    // Step 7: Handle Organization Setup
    armStep('[7/10] Handling organization setup', 60000);
    console.log('[7/10] Checking for Organization creation screen...');
    
    // Check if on /join or if org input is visible
    const orgInput = page.locator('input[placeholder*="organization" i], input[placeholder*="name" i], input[name="name"]').first();
    if (await orgInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      // Randomized organic Indonesian organization name
      const orgName = `${lastName} ${['Group', 'Digital', 'Systems', 'Tech', 'Solutions', 'Global'][Math.floor(Math.random() * 6)]}`;
      console.log(`  Creating organization: ${orgName}`);
      await orgInput.fill(orgName);
      await sleep(500);

      // Check Terms checkbox if present (supporting Radix UI checkbox button)
      const termsCheckbox = page.locator('button[role="checkbox"], [role="checkbox"], input[type="checkbox"]').first();
      console.log('  Checking Terms of Service checkbox...');
      try {
        await termsCheckbox.waitFor({ state: 'attached', timeout: 5000 });
        
        // Focus it and press Space (very reliable for Radix/custom checkboxes)
        await termsCheckbox.focus().catch(() => {});
        await page.keyboard.press('Space').catch(() => {});
        await sleep(1000);
        
        // Also click text containing "agree" or "Terms of Service" to be sure
        const termsText = page.locator('text=/I agree/i, text=/accept/i, text=/terms of service/i').first();
        if (await termsText.isVisible({ timeout: 1000 }).catch(() => false)) {
          await termsText.click({ force: true }).catch(() => {});
          await sleep(1000);
        }

        // Check if the button is still disabled. If it is, click checkbox element directly via force click
        const createOrgBtn = page.locator('button:has-text("Create"), button:has-text("Join"), button:has-text("Continue"), button[type="submit"]').filter({ visible: true }).first();
        const isDisabled = await createOrgBtn.getAttribute('disabled').catch(() => null) !== null || 
                           await createOrgBtn.getAttribute('aria-disabled').catch(() => null) === 'true';
                           
        if (isDisabled) {
          console.log('  Button still disabled, trying force click on terms checkbox...');
          await termsCheckbox.click({ force: true }).catch(() => {});
          await sleep(1000);
        }
        
        console.log('  Clicked Terms checkbox.');
      } catch (err) {
        console.log(`  Failed to click Terms checkbox: ${err.message}`);
      }
      await sleep(1000);
      
      const createOrgBtn = page.locator('button:has-text("Create"), button:has-text("Join"), button:has-text("Continue"), button[type="submit"]').filter({ visible: true }).first();
      await createOrgBtn.click();
      await sleep(8000);
      console.log('  Organization setup complete.');
    } else {
      console.log('  No organization setup screen detected. Proceeding...');
    }

    // Step 8: Navigate to API keys page
    armStep('[8/10] Navigating to API Keys page', 60000);
    console.log('[8/10] Navigating to API keys page...');
    await page.goto('https://console.mistral.ai/api-keys', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    console.log('  API keys page loaded.');

    // Step 9: Create API Key
    armStep('[9/10] Generating API Key', 90000);
    console.log('[9/10] Clicking Create API key button...');
    const createKeyBtn = page.locator('button:has-text("Create new key"), button:has-text("Create API key"), button:has-text("Create key"), button:has-text("New API Key")').filter({ visible: true }).first();
    await createKeyBtn.waitFor({ state: 'visible', timeout: 15000 });
    await createKeyBtn.click();

    // Wait for the dialog to open
    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await sleep(2000);

    // Check if we are on the landing screen ("No API Key created? Generate one...")
    // In this case, we need to click the modal's "Create new key" button to open the form.
    const landingBtn = dialog.locator('button:has-text("Create new key"), button:has-text("Create API key")').filter({ visible: true }).first();
    const hasNameInput = await dialog.locator('input[name="name"]').first().isVisible().catch(() => false);
    if (!hasNameInput && await landingBtn.isVisible().catch(() => false)) {
      console.log('  Clicking modal landing button...');
      await landingBtn.click();
      await sleep(2000);
    }

    // If modal name input is visible, fill key name
    const keyNameInput = dialog.locator('input[name="name"], input[placeholder*="name" i], input[placeholder*="Key" i]').first();
    const keyName = 'auto-' + Date.now().toString(36);
    try {
      await keyNameInput.waitFor({ state: 'visible', timeout: 8000 });
      console.log(`  Naming key: ${keyName}`);
      await keyNameInput.fill(keyName);
      await sleep(500);
    } catch (err) {
      console.log('  Key name input not visible/found inside dialog, skipping naming...');
    }

    // Look specifically inside [role="dialog"] for the submit/create button
    const confirmCreateBtn = dialog.locator('button:has-text("Create new key"), button:has-text("Create API key"), button:has-text("Create"), button:has-text("Confirm")').filter({ visible: true }).first();
    await confirmCreateBtn.waitFor({ state: 'visible', timeout: 8000 });
    console.log('  Submitting key creation form...');
    await confirmCreateBtn.click();
    await sleep(5000);

    // Extract API Key
    console.log('  Extracting API Key...');
    let apiKey = '';

    // A. Check body text
    const pageText = await page.innerText('body').catch(() => '');
    const keyMatch = pageText.match(/sk-[a-zA-Z0-9_-]{20,80}/);
    if (keyMatch) {
      apiKey = keyMatch[0];
      console.log(`  Extracted API Key from page text: ${apiKey}`);
    }

    // B. Check inputs
    if (!apiKey) {
      const inputs = page.locator('input');
      const inputCount = await inputs.count().catch(() => 0);
      for (let i = 0; i < inputCount; i++) {
        const val = await inputs.nth(i).inputValue().catch(() => '');
        if (val.startsWith('sk-') || /^[a-zA-Z0-9_-]{30,80}$/.test(val)) {
          apiKey = val;
          console.log(`  Extracted API Key from input field: ${apiKey}`);
          break;
        }
      }
    }

    // C. Check code/pre/span
    if (!apiKey) {
      const codeElements = page.locator('code, pre, span');
      const cCount = await codeElements.count().catch(() => 0);
      for (let i = 0; i < cCount; i++) {
        const val = (await codeElements.nth(i).textContent().catch(() => '')).trim();
        if (val.startsWith('sk-') || /^[a-zA-Z0-9_-]{30,80}$/.test(val)) {
          apiKey = val;
          console.log(`  Extracted API Key from code/pre/span: ${apiKey}`);
          break;
        }
      }
    }

    if (!apiKey) {
      // Capture screenshot to debug why key wasn't found
      const debugScreenshotPath = path.join(__dirname, 'mistral_debug_key_extraction.png');
      await page.screenshot({ path: debugScreenshotPath });
      console.log(`  [WARN] Failed to automatically extract API Key. Saved debug screenshot to: ${debugScreenshotPath}`);
      throw new Error('API Key extraction failed.');
    }

    // Dismiss the modal
    const doneBtn = page.locator('button:has-text("Done"), button:has-text("Close"), button:has-text("Dismiss")').filter({ visible: true }).first();
    if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await doneBtn.click();
      await sleep(1000);
    }

    // Step 10: Saving outputs
    armStep('[10/10] Saving outputs', 30000);
    console.log('[10/10] Saving outputs...');

    // Save to mistral.csv
    const csvHeaders = 'timestamp,email,password,api_key';
    const csvRow = [
      new Date().toISOString(),
      email,
      password,
      apiKey
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const exists = fs.existsSync(CONFIG.outputFile);
    if (!exists) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow + '\n', 'utf8');
    console.log(`  Saved to: ${CONFIG.outputFile}`);



    // Save to result.txt (in the format email | password | api_key)
    fs.appendFileSync(CONFIG.resultFile, `${email} | ${password} | ${apiKey}\n`, 'utf8');
    console.log(`  Saved to: ${CONFIG.resultFile}`);

    console.log('\n========================================');
    console.log('  MISTRAL.AI REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${password}`);
    console.log(`  API Key:    ${apiKey}`);
    console.log('========================================\n');

  } catch (err) {
    clearTimeout(stepTimer);
    console.error('ERROR in main flow:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errPath = path.join(__dirname, 'mistral_error.png');
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
    if (dynamicPortUsed) {
      try {
        const { execSync } = require('child_process');
        execSync(`fuser -k ${dynamicPortUsed}/tcp`, { stdio: 'ignore' });
        console.log(`  Terminated Chrome process on dynamic port ${dynamicPortUsed}.`);
      } catch (err) {
        // ignore errors
      }
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
