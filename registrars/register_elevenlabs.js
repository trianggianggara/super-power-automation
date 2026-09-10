// ElevenLabs Auto-Registration Script using Playwright
const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const TempMail = require('../services/tempmail/tempmail.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const { sleep, rand, fillHuman, gotoWithRetry, handleCookies } = require('../utils/helpers.js');
const { solveArkoseDragCaptcha } = require('../utils/captcha_solver.js');

const CONFIG = {
  signupUrl: 'https://elevenlabs.io/app/sign-up',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'elevenlabs.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  emailTimeout: 180000,
  proxy: process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
  llmApiKey: process.env.LLM_API_KEY || '',
  llmApiUrl: process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions',
  llmModel: process.env.LLM_MODEL || 'cx/gpt-5.4-mini',
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

async function typeHumanDirect(locator, text) {
  try {
    await locator.click({ force: true, timeout: 3000 });
  } catch (err) {
    await locator.focus();
  }
  await locator.fill('');
  await sleep(rand(150, 300));
  for (const char of text) {
    await locator.pressSequentially(char, { delay: rand(70, 160) });
  }
  await sleep(rand(200, 400));
}

async function handleCaptchaIfPresent(page, label = '', timeoutMs = 2500) {
  const iframeSelector = 'iframe[src*="arkoselabs.com"], iframe[src*="hcaptcha.com"][src*="frame=challenge"], iframe[title*="challenge"], iframe[src*="funcaptcha"]';
  try {
    const visibleIframe = page.locator(iframeSelector).filter({ visible: true }).first();
    const isCaptchaPresent = await visibleIframe.waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);

    if (isCaptchaPresent) {
      console.log(`  [CAPTCHA] Captcha detected during "${label}"! Starting solver...`);
      const solved = await solveArkoseDragCaptcha(page, {
        apiKey: CONFIG.llmApiKey,
        apiUrl: CONFIG.llmApiUrl,
        model: CONFIG.llmModel,
      });
      if (solved === true) {
        console.log(`  [CAPTCHA] Captcha solved successfully for "${label}"!`);
        return 'solved';
      } else if (solved === 'no_challenge') {
        console.log(`  [CAPTCHA] No active captcha challenge was displayed for "${label}".`);
        return 'no_captcha';
      } else {
        console.log(`  [CAPTCHA] Captcha solver returned failure for "${label}".`);
        const screenshotPath = path.join(__dirname, `elevenlabs_captcha_failed_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
        console.log(`  [CAPTCHA] Screenshot saved to ${screenshotPath}`);
        return 'failed';
      }
    }
  } catch (err) {
    console.log(`  [CAPTCHA] Error during captcha detection/solving: ${err.message}`);
    const screenshotPath = path.join(__dirname, `elevenlabs_captcha_failed_err_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`  [CAPTCHA] Screenshot saved to ${screenshotPath}`);
    return 'failed';
  }
  return 'no_captcha';
}

async function extractApiKeyFromPage(page) {
  // Grant clipboard permissions to read the copied key
  try {
    const context = page.context();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  } catch (_) {}

  // 1. Try finding and clicking copy buttons
  const copySelectors = [
    'button[aria-label*="copy" i]',
    'button[title*="copy" i]',
    'button:has(svg[class*="copy" i])',
    'svg[class*="copy" i]',
    '[data-testid*="copy" i]',
    'button:has-text("Copy")'
  ];

  for (const sel of copySelectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          console.log(`  Found potential copy button matching selector "${sel}", clicking...`);
          await item.click({ force: true }).catch(() => {});
          await sleep(1000);
          const clipText = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
          const cleanClip = clipText.trim();
          if (cleanClip && /^[a-zA-Z0-9_]{32,64}$/.test(cleanClip)) {
            console.log('  Successfully retrieved API key from clipboard!');
            return cleanClip;
          }
        }
      }
    } catch (_) {}
  }

  // 2. Try searching inside modal or dialog
  const dialog = page.locator('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="popup" i]').first();
  const searchRoot = (await dialog.isVisible().catch(() => false)) ? dialog : page;

  const selectors = [
    'input[readonly]',
    'input[type="text"]',
    'code',
    'pre',
    'span',
    'div'
  ];
  
  for (const selector of selectors) {
    try {
      const loc = searchRoot.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const text = await loc.nth(i).innerText().catch(() => '');
        const val = await loc.nth(i).inputValue().catch(() => '');
        const combined = (text + '\n' + val).trim();
        const match = combined.match(/\b([a-zA-Z0-9_]{32,64})\b/);
        if (match) {
          return match[1];
        }
      }
    } catch (_) {}
  }
  
  const bodyText = await page.innerText('body').catch(() => '');
  const match = bodyText.match(/\b([a-zA-Z0-9_]{32,64})\b/);
  if (match) {
    return match[0];
  }
  
  return '';
}

async function validateElevenLabsKey(key) {
  try {
    console.log(`  [Validator] Validating key: ${key.slice(0, 8)}... via GET /v1/user`);
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': key }
    });
    if (res.ok) {
      console.log('  [Validator] ElevenLabs key is valid!');
      return true;
    } else {
      console.log(`  [Validator] ElevenLabs key is invalid. Status: ${res.status}`);
      return false;
    }
  } catch (err) {
    console.log(`  [Validator] Validation request failed: ${err.message}`);
    return false;
  }
}

async function register() {
  console.log('=== ElevenLabs Auto-Registration ===');
  
  const tempmail = new TempMail();
  const provider = (TempMail.PROVIDER || process.env.TEMPMAIL_PROVIDER || 'webhook').toLowerCase().trim();
  
  let email = '';
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
    
    const plusSuffix = `+eleven_${Date.now()}_${rand(1000, 9999)}`;
    email = `${dottedUsername}${plusSuffix}@${domainName}`;
  } else {
    const inbox = await tempmail.createInbox();
    email = inbox.address;
  }

  console.log(`Generated registration email: ${email}`);

  // Generate safe password that meets validation criteria
  const password = CONFIG.password || `Xq9!${Math.random().toString(36).substring(2, 14)}#Z`;
  console.log(`Using password: ${password}`);

  const executablePathToUse = CONFIG.browserExecutablePath || '/usr/bin/google-chrome-stable';
  const selectedProxy = selectProxy(CONFIG.proxy);
  const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
  const isCam = isCamoufox(executablePathToUse);
  let browser;
  let context;
  let tempProfileDir = '';
  let dynamicPortUsed = null;
  let connectedCDP = false;

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
    try {
      const dynamicPort = Math.floor(19000 + Math.random() * 6000);
      dynamicPortUsed = dynamicPort;
      await ensureChromeRunning(executablePathToUse, dynamicPort);
      const checkRes = await fetch(`http://127.0.0.1:${dynamicPort}/json/version`).catch(() => null);
      if (checkRes && checkRes.ok) {
        console.log(`  Found active Google Chrome Remote Debugging port at http://127.0.0.1:${dynamicPort}! Connecting...`);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
        const contexts = browser.contexts();
        context = contexts.length > 0 ? contexts[0] : await browser.newContext({ ignoreHTTPSErrors: true });
        connectedCDP = true;
      }
    } catch (err) {
      console.log(`  CDP connection error: ${err.message}. Falling back to persistent context.`);
    }

    if (!connectedCDP) {
      console.log('  Launching Chromium with persistent context (Fallback)...');
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}_${dynamicPortUsed || Math.floor(Math.random() * 10000)}`);
      
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
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    // Step 1: Open ElevenLabs signup page
    console.log('[1/8] Opening ElevenLabs signup page...');
    await gotoWithRetry(page, CONFIG.signupUrl);
    await sleep(3000);
    await handleCookies(page);

    // Step 2: Fill signup form
    console.log('[2/8] Filling signup details...');
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await typeHumanDirect(emailInput, email);
    await sleep(800);

    const pwdInput = page.locator('input[type="password"]').first();
    await pwdInput.waitFor({ state: 'visible', timeout: 5000 });
    await typeHumanDirect(pwdInput, password);
    await sleep(1000);

    // Check Terms checkbox (Radix or standard input/button)
    console.log('  Checking Terms and Conditions checkbox...');
    const termsCheckbox = page.locator('button[role="checkbox"], input[type="checkbox"]').first();
    if (await termsCheckbox.isVisible().catch(() => false)) {
      await termsCheckbox.click();
      await sleep(1000);
    } else {
      // Try finding by text
      const termsLabel = page.locator('text="I agree to the Terms of Service"').first();
      if (await termsLabel.isVisible().catch(() => false)) {
        await termsLabel.click({ force: true });
        await sleep(1000);
      }
    }

    // Click Sign up button
    console.log('  Clicking Sign up button...');
    const submitBtn = page.locator('button').filter({ hasText: /^Sign up$/ }).first();
    await submitBtn.click().catch(() => {});
    await sleep(2000);

    // Fallback: Try pressing Enter on password input if still on signup page
    if (page.url().includes('/sign-up')) {
      console.log('  Still on signup page, trying Enter key on password input...');
      await pwdInput.press('Enter').catch(() => {});
      await sleep(2000);
    }

    // Step 3: CAPTCHA Solving (Auto-solved via LLM)
    let captchaFailures = 0;
    const initialCaptchaStatus = await handleCaptchaIfPresent(page, 'Signup Submit');

    if (initialCaptchaStatus === 'solved') {
      console.log('  CAPTCHA solving complete. Clicking Sign up button again to submit form...');
      const finalSubmitBtn = page.locator('button').filter({ hasText: /^Sign up$/ }).filter({ visible: true }).first();
      if (await finalSubmitBtn.isVisible().catch(() => false)) {
        await finalSubmitBtn.click({ force: true }).catch(() => {});
      } else {
        await pwdInput.press('Enter').catch(() => {});
      }
      await sleep(3000);
    } else if (initialCaptchaStatus === 'failed') {
      captchaFailures++;
      console.log(`  [CAPTCHA] Initial captcha solve attempt failed. Count: ${captchaFailures}/3`);
    }

    let formSubmitted = false;
    for (let i = 0; i < 90; i++) { // 3 minutes timeout (90 * 2000 ms)
      await sleep(2000);

      // Check for captcha inside the loop with a fast 500ms check
      const captchaStatus = await handleCaptchaIfPresent(page, 'Signup Poll', 500);
      if (captchaStatus === 'solved') {
        console.log('  CAPTCHA solved inside poll loop! Clicking Sign up button again...');
        const finalSubmitBtn = page.locator('button').filter({ hasText: /^Sign up$/ }).filter({ visible: true }).first();
        if (await finalSubmitBtn.isVisible().catch(() => false)) {
          await finalSubmitBtn.click({ force: true }).catch(() => {});
        } else {
          await pwdInput.press('Enter').catch(() => {});
        }
        await sleep(3000);
      } else if (captchaStatus === 'failed') {
        captchaFailures++;
        console.log(`  [CAPTCHA] Captcha solve attempt failed in poll loop. Count: ${captchaFailures}/3`);
        if (captchaFailures >= 3) {
          throw new Error('Aborting registration: Captcha solving failed 3 times.');
        }
        await sleep(5000); // Backoff for 5 seconds to let page/widget stabilize
      }

      const currentUrl = page.url();
      const bodyText = await page.innerText('body').catch(() => '');
      
      if (currentUrl.includes('/verify') || 
          bodyText.toLowerCase().includes('check your email') || 
          bodyText.toLowerCase().includes('verification link') ||
          bodyText.toLowerCase().includes('sent an email') || 
          bodyText.toLowerCase().includes('sent a verification')) {
        console.log('  Form submitted successfully. Found verification message on screen.');
        formSubmitted = true;
        break;
      }
    }

    if (!formSubmitted) {
      throw new Error('CAPTCHA solving / form submission timed out.');
    }

    // Step 4: Wait for verification email & extract verification link
    console.log('[3/8] Waiting for ElevenLabs verification email...');
    let verifyLink = '';
    const pollDeadline = Date.now() + CONFIG.emailTimeout;
    while (Date.now() < pollDeadline && !verifyLink) {
      const msg = await tempmail.waitForEmail(email, 15000).catch(() => null);
      if (msg && (msg.subject.toLowerCase().includes('verify') || msg.subject.toLowerCase().includes('elevenlabs'))) {
        const fullText = decodeQuotedPrintable((msg.text_body || '') + '\n' + (msg.html_body || ''));
        const links = fullText.match(/https?:\/\/[^\s"'<>]+/g) || [];
        console.log(`  Found ${links.length} links in the verification email.`);
        
        // Find links containing elevenlabs.io or stytch / verify patterns
        verifyLink = links.find(link => link.includes('elevenlabs.io') && (link.includes('verify') || link.includes('confirm') || link.includes('email-verification')));
        if (!verifyLink) {
          verifyLink = links.find(link => link.includes('elevenlabs.io'));
        }
        
        if (verifyLink) {
          verifyLink = verifyLink.replace(/&amp;/g, '&');
          console.log(`  Extracted verification link: ${verifyLink}`);
          break;
        }
      }
      await sleep(3000);
    }

    if (!verifyLink) {
      throw new Error('Verification email or link not received.');
    }

    // Step 5: Navigate to verification link
    console.log('[4/8] Navigating to verification link...');
    await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(10000); // let redirects settle

    // Check if we ended up on the Sign In page
    const loginHeader = page.locator('h1:has-text("Welcome back"), h2:has-text("Welcome back")').first();
    const isLoginPage = await loginHeader.isVisible({ timeout: 3000 }).catch(() => false);
    
    if (isLoginPage || page.url().includes('/sign-in') || page.url().includes('/login')) {
      console.log('  Verification redirected to login page. Performing first-time sign in...');
      
      const emailInput = page.locator('input[type="email"]').first();
      const currentEmailVal = await emailInput.inputValue().catch(() => '');
      if (!currentEmailVal) {
        await typeHumanDirect(emailInput, email);
      }
      
      const passwordInput = page.locator('input[type="password"]').first();
      await typeHumanDirect(passwordInput, password);
      
      const signInBtn = page.locator('button').filter({ hasText: /^Sign in$/ }).filter({ visible: true }).first();
      await signInBtn.click();
      await sleep(4000);
      
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (bodyText.includes('No user is found with these credentials')) {
        console.log('  [ERROR] Login failed: "No user is found with these credentials."');
        console.log('  Closing browser and advancing to next loop...');
        await browser.close().catch(() => {});
        process.exit(1);
      }
      await sleep(6000); // Let dashboard load
    }

    // Step 6: Handle Onboarding Skips
    console.log('[5/8] Checking for onboarding wizard flow...');
    for (let attempt = 0; attempt < 10; attempt++) {
      const currentUrl = page.url();
      if (currentUrl.includes('/settings/api-keys') || currentUrl.includes('/settings') || currentUrl.includes('/speech-synthesis')) {
        console.log('  Onboarding bypassed or completed.');
        break;
      }

      // Check for age confirmation checkbox on onboarding page
      const adultCheckboxInput = page.locator('input[name="adult"]').first();
      const adultCheckboxBtn = page.locator('button[role="checkbox"]').first();
      
      if (await adultCheckboxInput.isVisible().catch(() => false) || await adultCheckboxBtn.isVisible().catch(() => false)) {
        console.log('  Age verification checkbox detected. Checking it...');
        
        let isChecked = false;
        if (await adultCheckboxBtn.isVisible().catch(() => false)) {
          const state = await adultCheckboxBtn.getAttribute('aria-checked').catch(() => 'false');
          isChecked = (state === 'true');
        } else {
          isChecked = await adultCheckboxInput.isChecked().catch(() => false);
        }
        
        if (!isChecked) {
          console.log('  Checkbox is unchecked. Clicking it...');
          if (await adultCheckboxBtn.isVisible().catch(() => false)) {
            await adultCheckboxBtn.click({ force: true }).catch(() => {});
          } else {
            await adultCheckboxInput.check({ force: true }).catch(() => {});
          }
          await sleep(1000);
        } else {
          console.log('  Checkbox is already checked.');
        }
      }
      
      const skipBtn = page.locator('button:has-text("Skip"), button:has-text("Continue"), button:has-text("Next"), a:has-text("Skip")')
        .filter({ visible: true })
        .filter({ hasNotText: 'Skip to content' })
        .first();
      if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('  Clicking onboarding skip/continue button...');
        await skipBtn.click();
        await sleep(3000);
      } else {
        const closeBtn = page.locator('button[aria-label*="close" i], button[class*="close" i]').filter({ visible: true }).first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log('  Clicking onboarding close button...');
          await closeBtn.click();
          await sleep(2000);
        }
      }
      await sleep(1000);
    }

    // Step 7: Navigate to API Keys Settings page
    console.log('[6/8] Accessing API Keys page...');
    
    const candidateUrls = [
      'https://elevenlabs.io/app/developers',
      'https://elevenlabs.io/app/settings/api-keys',
      'https://elevenlabs.io/app/settings'
    ];
    
    let createKeyBtn = page.locator('button:has-text("Create Key"), button:has-text("Create API Key"), button:has-text("Add Key"), button:has-text("+ Create Key"), button:has-text("Create new key")').filter({ visible: true }).first();
    
    for (const url of candidateUrls) {
      if (await createKeyBtn.isVisible().catch(() => false)) {
        break;
      }
      
      console.log(`  Attempting navigation to: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(4000);
      
      if (url.includes('/settings') && !(url.includes('/api-keys'))) {
        const apiKeysTab = page.locator('a:has-text("API Keys"), a:has-text("Developers"), button:has-text("API Keys"), a[href*="api-keys"], a[href*="developers"]').filter({ visible: true }).first();
        if (await apiKeysTab.isVisible().catch(() => false)) {
          console.log('  Clicking API Keys tab...');
          await apiKeysTab.click({ force: true });
          await sleep(3000);
        }
      }
      
      createKeyBtn = page.locator('button:has-text("Create Key"), button:has-text("Create API Key"), button:has-text("Add Key"), button:has-text("+ Create Key"), button:has-text("Create new key")').filter({ visible: true }).first();
    }
    
    if (!(await createKeyBtn.isVisible().catch(() => false))) {
      console.log('  Create Key button still not found. Searching for sidebar or menu links...');
      const devLinks = page.locator('a:has-text("Developers"), a:has-text("API Keys"), button:has-text("Developers"), button:has-text("API Keys"), a[href*="developers"], a[href*="api-keys"]');
      const count = await devLinks.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const link = devLinks.nth(i);
        if (await link.isVisible().catch(() => false)) {
          console.log(`  Found and clicking link/button: ${await link.innerText().catch(() => '') || 'dev link'}`);
          await link.click({ force: true }).catch(() => {});
          await sleep(4000);
          createKeyBtn = page.locator('button:has-text("Create Key"), button:has-text("Create API Key"), button:has-text("Add Key"), button:has-text("+ Create Key"), button:has-text("Create new key")').filter({ visible: true }).first();
          if (await createKeyBtn.isVisible().catch(() => false)) {
            break;
          }
        }
      }
    }

    if (!(await createKeyBtn.isVisible().catch(() => false))) {
      // Let's capture a screenshot to diagnose
      const missingKeyBtnScreenshot = path.join(__dirname, 'elevenlabs_no_create_key_btn.png');
      await page.screenshot({ path: missingKeyBtnScreenshot }).catch(() => {});
      console.log(`  [WARN] Create Key button not found. Saved screenshot to ${missingKeyBtnScreenshot}`);
    } else {
      console.log('  Clicking Create Key button...');
      // Re-query locator to avoid element detachment
      createKeyBtn = page.locator('button:has-text("Create Key"), button:has-text("Create API Key"), button:has-text("Add Key"), button:has-text("+ Create Key"), button:has-text("Create new key")').filter({ visible: true }).first();
      await createKeyBtn.click({ force: true, timeout: 5000 }).catch(async () => {
        console.log('  [WARN] First click attempt on Create Key failed, retrying in 2 seconds...');
        await sleep(2000);
        await createKeyBtn.click({ force: true }).catch(() => {});
      });
      await sleep(2000);

      // Name the key
      const keyNameInput = page.locator('input[type="text"], input[placeholder*="name" i]').first();
      if (await keyNameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        const randomKeyName = 'key_' + Math.random().toString(36).substring(2, 10);
        console.log(`  Entering random key name: ${randomKeyName}`);
        await keyNameInput.fill(randomKeyName);
        await sleep(500);
      }

      // Disable Restrict Key toggle if ON
      const restrictToggle = page.locator('button[role="switch"]').first();
      if (await restrictToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
        const isChecked = await restrictToggle.getAttribute('aria-checked').catch(() => 'false') === 'true';
        if (isChecked) {
          console.log('  Restrict Key toggle is ON. Clicking to turn it OFF...');
          await restrictToggle.click({ force: true }).catch(() => {});
          await sleep(1500); // Wait for the warning banner and layout animation to settle
        } else {
          console.log('  Restrict Key toggle is already OFF.');
        }
      }

      // Confirm creation (Create Key button inside dialog)
      let confirmBtn = page.locator('[role="dialog"] button').filter({ hasText: /^Create Key$/ }).first();
      if (!(await confirmBtn.isVisible().catch(() => false))) {
        confirmBtn = page.locator('button').filter({ hasText: /^Create Key$/ }).last();
      }

      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  Clicking Create Key confirmation button...');
        await confirmBtn.click({ force: true, timeout: 5000 }).catch(async (err) => {
          console.log('  [WARN] First confirm click failed, retrying with re-query:', err.message);
          await sleep(1500);
          confirmBtn = page.locator('[role="dialog"] button').filter({ hasText: /^Create Key$/ }).first();
          if (!(await confirmBtn.isVisible().catch(() => false))) {
            confirmBtn = page.locator('button').filter({ hasText: /^Create Key$/ }).last();
          }
          await confirmBtn.click({ force: true }).catch(() => {});
        });
        await sleep(4000);
      }
    }

    // Step 8: Extract API Key
    console.log('[7/8] Extracting API Key...');
    let apiKey = await extractApiKeyFromPage(page);

    if (!apiKey) {
      console.log('  [WARN] API key could not be extracted automatically.');
      const errScreenshot = path.join(__dirname, `elevenlabs_key_extract_failed_${Date.now()}.png`);
      await page.screenshot({ path: errScreenshot }).catch(() => {});
      console.log(`  Screenshot saved to ${errScreenshot}`);
    } else {
      console.log(`  Extracted API Key: ${apiKey}`);
    }

    // Validate the API key
    if (apiKey) {
      const isValid = await validateElevenLabsKey(apiKey);
      if (!isValid) {
        console.log('========================================');
        console.log('  KEY VALIDATION FAILED! SKIPPING SAVING.');
        console.log('========================================');
        return;
      }
    }

    // Save to outputs
    console.log('[8/8] Saving credentials to elevenlabs.csv...');
    const proxyForCsv = connectedCDP ? 'direct/cdp' : (selectedProxy || 'direct');
    const csvHeaders = 'timestamp,email,password,api_key,proxy\n';
    const csvRow = [new Date().toISOString(), email, password, apiKey || 'NOT_FOUND', proxyForCsv].map(csvCell).join(',') + '\n';
    
    if (!fs.existsSync(CONFIG.outputFile)) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders, 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow, 'utf8');
    console.log(`  Account details successfully saved to ${CONFIG.outputFile}`);



    console.log('\n========================================');
    console.log('  ELEVENLABS SIGNUP & KEY GENERATION SUCCESS');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${password}`);
    console.log(`  API Key:    ${apiKey || 'NOT_FOUND'}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('  [ERROR] Registration failed:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errScreenshot = path.join(__dirname, `elevenlabs_error_${Date.now()}.png`);
    await page.screenshot({ path: errScreenshot }).catch(() => {});
    console.log(`  Screenshot saved to ${errScreenshot}`);
    throw err;
  } finally {
    if (dynamicPortUsed) {
      try {
        const { execSync } = require('child_process');
        execSync(`fuser -k ${dynamicPortUsed}/tcp`, { stdio: 'ignore' });
        console.log(`  Terminated Chrome process on dynamic port ${dynamicPortUsed}.`);
      } catch (err) {
        // ignore errors
      }
    }

    if (browser && typeof browser.close === 'function') {
      await Promise.race([
        browser.close(),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]).catch(() => {});
    } else if (context) {
      await Promise.race([
        context.close(),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]).catch(() => {});
    }
  }
}

if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register, CONFIG };
