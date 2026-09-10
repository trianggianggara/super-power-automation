// Deepgram Auto-Registration Script using Playwright
const { loadEnv } = require('../utils/env.js');
const { solve: solveRecaptchaAudio } = require('recaptcha-solver');
const { findFfmpeg } = require('../utils/ffmpeg.js');
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

const ffmpegPath = findFfmpeg();

const CONFIG = {
  signupUrl: 'https://console.deepgram.com/signup',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'deepgram.csv'),
  emailTimeout: 180000,
  proxy: process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
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

function generateRandomPassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let pass = '';
  pass += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
  pass += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  pass += '0123456789'[Math.floor(Math.random() * 10)];
  pass += '!@#$%^&*'[Math.floor(Math.random() * 8)];
  for (let i = 0; i < 12; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  return pass.split('').sort(() => 0.5 - Math.random()).join('');
}

async function fillOnboardingDropdown(page, labelText, isMulti = false) {
  console.log(`  Filling dropdown: "${labelText}"`);
  const label = page.locator(`text="${labelText}"`).first();
  await label.waitFor({ state: 'visible', timeout: 10000 });
  
  const parent = label.locator('xpath=..');
  let trigger = parent.locator('button, [role="combobox"], div[tabindex="0"], div[class*="select"]').first();
  
  if (await trigger.count() === 0) {
    const grandParent = label.locator('xpath=../..');
    trigger = grandParent.locator('button, [role="combobox"], div[tabindex="0"], div[class*="select"]').first();
  }
  
  await trigger.waitFor({ state: 'visible', timeout: 5000 });
  await trigger.scrollIntoViewIfNeeded();
  await sleep(rand(300, 600));
  await trigger.click({ force: true });
  await sleep(rand(1000, 1500));
  
  // Robust options parser inside visible popovers/lists linked to this trigger
  const ariaControls = await trigger.getAttribute('aria-controls').catch(() => '') || '';
  const ariaOwns = await trigger.getAttribute('aria-owns').catch(() => '') || '';
  const targetId = ariaControls || ariaOwns;
  
  let container = null;
  if (targetId) {
    container = page.locator(`[id="${targetId}"]`).first();
    if (await container.count() === 0) {
      container = null;
    }
  }

  let options = null;
  const startTime = Date.now();
  while (Date.now() - startTime < 4000) {
    if (container && await container.isVisible().catch(() => false)) {
      const items = container.locator('div.cursor-pointer, [role="option"], [role="menuitem"], [class*="SelectItem"]');
      const iCount = await items.count();
      if (iCount > 0) {
        const list = [];
        for (let i = 0; i < iCount; i++) {
          if (await items.nth(i).isVisible().catch(() => false)) {
            list.push(items.nth(i));
          }
        }
        if (list.length > 0) {
          options = list;
          break;
        }
      }
    }

    // Fallback: search absolute/fixed popovers
    const containerLocators = [
      '[role="listbox"]',
      '[role="presentation"]',
      'div.absolute',
      'div.fixed',
      'div[class*="absolute"]',
      'div[class*="fixed"]',
      'div[class*="menu"]',
      'div[class*="popover"]'
    ];
    for (const containerSel of containerLocators) {
      const containers = page.locator(containerSel);
      const cCount = await containers.count();
      for (let c = 0; c < cCount; c++) {
        const fallbackContainer = containers.nth(c);
        if (await fallbackContainer.isVisible().catch(() => false)) {
          const items = fallbackContainer.locator('div.cursor-pointer, [role="option"], [role="menuitem"], [class*="SelectItem"]');
          const iCount = await items.count();
          if (iCount > 0) {
            const list = [];
            for (let i = 0; i < iCount; i++) {
              if (await items.nth(i).isVisible().catch(() => false)) {
                list.push(items.nth(i));
              }
            }
            if (list.length > 0) {
              options = list;
              break;
            }
          }
        }
      }
      if (options) break;
    }
    if (options) break;
    await sleep(200);
  }
  
  if (!options || options.length === 0) {
    console.log(`    [WARN] Options not found for "${labelText}". Pressing ArrowDown + Enter.`);
    await trigger.press('ArrowDown');
    await sleep(500);
    await trigger.press('Enter');
    await sleep(1000);
    return;
  }
  
  const count = options.length;
  console.log(`    Found ${count} visible options`);
  
  if (isMulti) {
    const selectCount = Math.floor(Math.random() * Math.min(2, count)) + 1;
    const selectedIndices = new Set();
    while (selectedIndices.size < selectCount) {
      selectedIndices.add(Math.floor(Math.random() * count));
    }
    
    console.log(`    Selecting multi-select options at indices: ${Array.from(selectedIndices).join(', ')}`);
    for (const idx of selectedIndices) {
      const opt = options[idx];
      await opt.scrollIntoViewIfNeeded();
      await opt.click({ force: true });
      await sleep(rand(500, 800));
    }
    
    // Close multi-select dropdown explicitly
    await page.keyboard.press('Escape');
    await sleep(500);
    // Also click the label text to blur focus
    await label.click({ force: true }).catch(() => {});
    await sleep(800);
  } else {
    const idx = Math.floor(Math.random() * count);
    console.log(`    Selecting option at index: ${idx}`);
    const opt = options[idx];
    await opt.scrollIntoViewIfNeeded();
    await opt.click({ force: true });
    await sleep(1000);
    
    // Close single-select dropdown if it doesn't auto-close
    await page.keyboard.press('Escape');
    await sleep(500);
    await label.click({ force: true }).catch(() => {});
    await sleep(800);
  }
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

async function extractApiKeyFromPage(page) {
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
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const text = await loc.nth(i).innerText().catch(() => '');
        const val = await loc.nth(i).inputValue().catch(() => '');
        const combined = (text + '\n' + val).trim();
        const match = combined.match(/\b([a-fA-F0-9]{40})\b/);
        if (match) {
          return match[1];
        }
      }
    } catch (_) {}
  }
  
  const bodyText = await page.innerText('body').catch(() => '');
  const match = bodyText.match(/\b([a-fA-F0-9]{40})\b/);
  if (match) {
    return match[0];
  }
  
  return '';
}

function validateDeepgramKey(key) {
  return new Promise((resolve) => {
    try {
      const WebSocket = require("ws");
      const url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=24000&channels=1";
      console.log(`  [Validator] Validating key: ${key.slice(0, 8)}... via WebSocket`);
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${key}` },
      });
      
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.error("  [Validator] TIMEOUT");
          try { ws.terminate(); } catch (_) {}
          resolve(false);
        }
      }, 8000);

      ws.on("upgrade", (res) => {
        console.log("  [Validator] UPGRADE", res.statusCode);
      });

      ws.on("open", () => {
        console.log("  [Validator] OK: key valid for realtime listen");
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          resolve(true);
        }
      });

      ws.on("error", (err) => {
        console.error("  [Validator] ERROR:", err.message);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    } catch (err) {
      console.error("  [Validator] Failed to initialize WebSocket client:", err.message);
      resolve(false);
    }
  });
}

async function register() {
  console.log('=== Deepgram Auto-Registration ===');
  
  const password = generateRandomPassword();
  const tempmail = new TempMail();
  
  // Force Gmail dot-trick only
  const baseEmail = await resolveBaseEmail(tempmail);
  
  const atIdx = baseEmail.indexOf('@');
  const username = baseEmail.slice(0, atIdx);
  const domainName = baseEmail.slice(atIdx + 1);
  const cleanUsername = username.replace(/\./g, '').split('+')[0];

  // Load existing emails from deepgram.csv to avoid duplicates
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

  let email = '';
  let emailAttempt = 0;
  while (emailAttempt < 2000) {
    let dottedUsername = cleanUsername[0];
    for (let i = 1; i < cleanUsername.length; i++) {
      if (Math.random() < 0.5) {
        dottedUsername += '.';
      }
      dottedUsername += cleanUsername[i];
    }
    
    const candidateEmail = `${dottedUsername}@${domainName}`;
    if (!existingEmails.has(candidateEmail.toLowerCase())) {
      email = candidateEmail;
      break;
    }
    emailAttempt++;
  }

  if (!email) {
    // fallback to random suffix if we run out of pure combinations
    const plusSuffix = `+dg_${Date.now()}_${rand(1000, 9999)}`;
    email = `${cleanUsername}${plusSuffix}@${domainName}`;
  }

  console.log(`Generated registration email: ${email}`);

  const executablePathToUse = CONFIG.browserExecutablePath || '/usr/bin/google-chrome-stable';
  const selectedProxy = selectProxy(CONFIG.proxy);
  const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
  const isCam = false; // Always use Chromium/Chrome Stable instead of Camoufox
  let browser;
  let context;
  let tempProfileDir = '';
  let dynamicPortUsed = null;
  let connectedCDP = false;

  const vpWidth = 1366 + rand(-20, 20);
  const vpHeight = 768 + rand(-10, 10);

  if (isCam) {
    console.log('  Launching Camoufox (Firefox-based)...');
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
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}`);
      
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

  // Watch for connection errors
  let lastFailedUrl = '';
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText || '';
    if (errorText.includes('ERR_CONNECTION_RESET') || errorText.includes('NS_ERROR_NET_RESET')) {
      lastFailedUrl = request.url();
    }
  });

  try {
    // Step 1: Open Deepgram signup page
    console.log('[1/7] Opening Deepgram signup page...');
    await gotoWithRetry(page, CONFIG.signupUrl);
    await sleep(2000);

    // Step 2: Fill signup form
    console.log('[2/7] Filling email and password...');
    const emailInput = page.locator('#email').first();
    const pwdInput = page.locator('#new-password').first();

    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await typeHumanDirect(emailInput, email);
    await sleep(800);

    await pwdInput.waitFor({ state: 'visible', timeout: 5000 });
    await typeHumanDirect(pwdInput, password);
    await sleep(1000);

    // Step 3: CAPTCHA Solver (similar to register.js)
    console.log('  Handling reCAPTCHA...');
    let checkboxClicked = false;
    for (let attempt = 0; attempt < 5 && !checkboxClicked; attempt++) {
      try {
        await page.waitForSelector('iframe[title="reCAPTCHA"]', { state: 'attached', timeout: 20000 });
        await sleep(rand(1000, 2000)); // let iframe fully render

        const recaptchaFrame = await page.$('iframe[title="reCAPTCHA"]');
        if (recaptchaFrame) {
          const frame = await recaptchaFrame.contentFrame();
          if (frame) {
            await frame.waitForSelector('.recaptcha-checkbox-border', { state: 'visible', timeout: 5000 });
            const checkbox = await frame.$('.recaptcha-checkbox-border');
            if (checkbox) {
              await checkbox.click();
              console.log('  reCAPTCHA Checkbox clicked, waiting for challenge...');
              await sleep(rand(2000, 3000));
              checkboxClicked = true;
            }
          }
        }
      } catch (_) {
        if (attempt < 4) {
          console.log(`  reCAPTCHA Checkbox not ready (attempt ${attempt + 1}/5), retrying...`);
          await sleep(1000);
        }
      }
    }

    let audioSuccess = false;
    try {
      process.env.VERBOSE = '1';
      await solveRecaptchaAudio(page, { wait: 15000, retry: 5, ffmpeg: ffmpegPath });
      console.log('  reCAPTCHA solved via audio!');
      audioSuccess = true;
    } catch (e) {
      console.log(`  Audio solver failed: ${e.message}. Pausing for manual fallback...`);
      console.log('\n==================================================================');
      console.log('  >>> ACTION REQUIRED: Solve CAPTCHA manually in the browser window');
      console.log('  >>> and submit the registration form.');
      console.log('==================================================================\n');
    }

    // Submit form if not automatically done
    const submitBtn = page.locator('button[type="submit"], button:has-text("Create Account")').first();
    
    if (audioSuccess) {
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Wait for disabled state to clear
        for (let i = 0; i < 10; i++) {
          const isDisabled = await submitBtn.getAttribute('disabled').catch(() => null);
          if (isDisabled === null) break;
          await sleep(500);
        }
        console.log('  Clicking Create Account submit button...');
        await submitBtn.click().catch(() => {});
        await sleep(3000);
      }
    }

    let captchaPassed = false;
    for (let i = 0; i < 180; i++) { // 6 minutes max
      await sleep(2000);
      const currentUrl = page.url();
      const bodyText = await page.innerText('body').catch(() => '');

      // Detect "Something went wrong" signup error immediately
      if (bodyText.includes('Something went wrong!') || bodyText.toLowerCase().includes('something went wrong')) {
        throw new Error('Signup failed: "Something went wrong! Please try again." (Possibly IP or proxy blocked by auth provider)');
      }

      // Handle reCAPTCHA expiration auto-recovery
      if (bodyText.includes('Verification expired.') || bodyText.toLowerCase().includes('verification expired')) {
        console.log('  [WARN] reCAPTCHA verification expired! Attempting auto-recovery...');
        
        // Re-locate recaptcha checkbox inside iframe
        const recaptchaFrame = await page.$('iframe[title="reCAPTCHA"]');
        if (recaptchaFrame) {
          const frame = await recaptchaFrame.contentFrame();
          if (frame) {
            const checkbox = await frame.$('.recaptcha-checkbox-border');
            if (checkbox) {
              console.log('  Clicking reCAPTCHA checkbox again...');
              await checkbox.click({ force: true });
              await sleep(3000);
            }
          }
        }
        
        console.log('  Re-running audio solver...');
        process.env.VERBOSE = '1';
        await solveRecaptchaAudio(page, { wait: 15000, retry: 5, ffmpeg: ffmpegPath });
        console.log('  reCAPTCHA successfully re-solved via audio!');
        
        if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  Re-clicking Create Account submit button...');
          await submitBtn.click().catch(() => {});
          await sleep(3000);
        }
        continue;
      }

      if (!currentUrl.includes('/signup') || 
          bodyText.toLowerCase().includes('verification code') || 
          bodyText.toLowerCase().includes('account created') || 
          bodyText.toLowerCase().includes('check your email') || 
          bodyText.toLowerCase().includes('verify your email') ||
          bodyText.toLowerCase().includes('verification link') ||
          bodyText.toLowerCase().includes('sent an email') ||
          bodyText.toLowerCase().includes('personalize') ||
          bodyText.toLowerCase().includes('explore first') ||
          (await page.locator('input[placeholder*="code" i], input[id*="code"]').isVisible().catch(() => false))) {
        console.log(`  Form successfully submitted. Current URL: ${currentUrl}`);
        captchaPassed = true;
        break;
      }
    }

    if (!captchaPassed) {
      throw new Error('CAPTCHA solving / Form submission timed out.');
    }

    // Step 4: Wait for verification email & extract verification code
    const currentUrl = page.url();
    const bodyText = await page.innerText('body').catch(() => '');
    const needsOtp = currentUrl.includes('/verify') || 
                      bodyText.toLowerCase().includes('verification code') || 
                      bodyText.toLowerCase().includes('enter code') ||
                      bodyText.toLowerCase().includes('verify your email') ||
                      (await page.locator('input[placeholder*="code" i], input[id*="code"]').isVisible().catch(() => false));

    if (needsOtp) {
      console.log('[3/7] Waiting for Deepgram verification email/code...');
      
      // Explicitly poll for the "Signup verification code" email to get the correct OTP
      let otp = '';
      const pollDeadline = Date.now() + CONFIG.emailTimeout;
      while (Date.now() < pollDeadline && !otp) {
        const msg = await tempmail.waitForEmail(email, 15000).catch(() => null);
        if (msg && msg.subject.includes('verification')) {
          const fullText = (msg.text_body || '') + '\n' + (msg.html_body || '');
          const match = fullText.match(/\b(\d{6})\b/);
          if (match) {
            otp = match[1];
            console.log(`  Extracted OTP code from Deepgram signup email: ${otp}`);
            break;
          }
        }
        await sleep(3000);
      }

      if (!otp) {
        // Fallback to regular helper
        otp = await tempmail.waitForOtp(email, 30000).catch(() => '');
      }

      if (!otp) {
        throw new Error('Verification OTP code not received.');
      }
      console.log(`  Using OTP: ${otp}`);

      // Log visible inputs for diagnostics
      try {
        const inputs = page.locator('input');
        const count = await inputs.count();
        console.log(`  Diagnostic: Found ${count} input elements on verification page:`);
        for (let i = 0; i < count; i++) {
          const type = await inputs.nth(i).getAttribute('type').catch(() => '');
          const placeholder = await inputs.nth(i).getAttribute('placeholder').catch(() => '');
          const id = await inputs.nth(i).getAttribute('id').catch(() => '');
          const name = await inputs.nth(i).getAttribute('name').catch(() => '');
          const classes = await inputs.nth(i).getAttribute('class').catch(() => '');
          console.log(`    Input ${i}: id="${id}" name="${name}" type="${type}" placeholder="${placeholder}" class="${classes}"`);
        }
      } catch (e) {
        console.log(`  [WARN] Failed to log inputs diagnostics: ${e.message}`);
      }

      // Fill OTP
      const otpInput = page.locator('input[type="text"], input[type="tel"], input[type="number"], input[placeholder*="code" i], input[id*="code"], input').first();
      await otpInput.waitFor({ state: 'visible', timeout: 15000 });
      await typeHumanDirect(otpInput, otp);
      await sleep(1000);

      // Press Enter to submit
      console.log('  Pressing Enter on verification code input...');
      try {
        await otpInput.press('Enter', { timeout: 5000 });
        await sleep(3000);
      } catch (err) {
        console.log(`  [INFO] Pressing Enter on OTP input timed out or page redirected: ${err.message}`);
      }

      // Click submit if a button is visible
      try {
        const verifySubmitBtn = page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').first();
        if (await verifySubmitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  Clicking submit button...');
          await verifySubmitBtn.click({ timeout: 5000 });
          await sleep(3000);
        }
      } catch (err) {
        console.log(`  [INFO] Clicking OTP submit button timed out or page redirected: ${err.message}`);
      }

      // Verify that we successfully moved past the verification code page
      const bodyTextAfterVerify = await page.innerText('body').catch(() => '');
      if (bodyTextAfterVerify.includes("verification code") || bodyTextAfterVerify.includes("Account created! Please enter")) {
        throw new Error('Verification failed. Still stuck on verification code screen.');
      }
      console.log('  Verification successfully completed! Advanced to next page.');
    } else {
      console.log('[3/7] Already verified or bypassed verification screen. Skipping OTP input.');
    }

    // Step 5: Handle onboarding wizard
    console.log('[4/7] Navigating onboarding flow...');

    // Stage A: "Let's personalize your experience." -> fill all inputs
    console.log('  Onboarding Stage 1: Personalization...');
    let personalizationHandled = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const bodyText = await page.innerText('body').catch(() => '');
      if (bodyText.includes("personalize your experience") || bodyText.includes("Let's personalize") || bodyText.toLowerCase().includes("role") || bodyText.toLowerCase().includes("team") || bodyText.toLowerCase().includes("industry")) {
        console.log("  Detected 'Let's personalize your experience' page.");
        
        // Fill all 4 onboarding questions randomly
        try {
          await fillOnboardingDropdown(page, "What industry are you in?", false);
          await fillOnboardingDropdown(page, "What are you aiming to use Deepgram to build?", true);
          await fillOnboardingDropdown(page, "Are you currently using another voice provider(s)?", true);
          await fillOnboardingDropdown(page, "What is your technical experience", false);
          
          // Check for any visible text inputs/textareas that appeared conditionally and fill them
          const textInputs = page.locator('input[type="text"], input:not([type]), textarea');
          const inputCount = await textInputs.count().catch(() => 0);
          for (let i = 0; i < inputCount; i++) {
            const input = textInputs.nth(i);
            if (await input.isVisible().catch(() => false)) {
              const role = await input.getAttribute('role').catch(() => '') || '';
              if (role === 'combobox') continue;
              
              const val = await input.inputValue().catch(() => '');
              if (!val.trim()) {
                const placeholder = await input.getAttribute('placeholder').catch(() => '') || '';
                console.log(`  Filling empty input/textarea (placeholder: "${placeholder}") with default text to avoid blank fields...`);
                await input.fill("Other/None");
                await sleep(500);
              }
            }
          }

          console.log("  All onboarding inputs filled. Clicking Continue...");
          const continueBtn = page.locator('button:has-text("Continue")').first();
          await continueBtn.click();
          await sleep(3500);
          personalizationHandled = true;
          break;
        } catch (err) {
          console.log(`  [WARN] Failed to fill onboarding dropdowns: ${err.message}. Attempting fallback click on Continue button...`);
          const continueBtn = page.locator('button:has-text("Continue")').first();
          if (await continueBtn.isVisible().catch(() => false)) {
            await continueBtn.click();
            await sleep(3500);
            personalizationHandled = true;
            break;
          }
        }
      } else {
        await sleep(1000);
      }
    }

    // Stage B: "What would you like to explore first?" -> choose a random card and continue
    console.log('  Onboarding Stage 2: Explore Option...');
    let exploreHandled = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const bodyText = await page.innerText('body').catch(() => '');
      if (bodyText.includes("What would you like to explore first?") || bodyText.toLowerCase().includes("explore first") || bodyText.toLowerCase().includes("voice agent")) {
        console.log("  Detected 'What would you like to explore first?' page.");
        
        const exploreOptions = ['Speech to Text', 'Text to Speech', 'Voice agent'];
        const chosenOption = exploreOptions[Math.floor(Math.random() * exploreOptions.length)];
        console.log(`  Selecting explore option card: "${chosenOption}"`);
        
        const cardSelectors = [
          `text="${chosenOption}"`,
          `div:has-text("${chosenOption}")`,
          `button:has-text("${chosenOption}")`
        ];
        
        let cardClicked = false;
        for (const selector of cardSelectors) {
          const card = page.locator(selector).last();
          if (await card.isVisible({ timeout: 1000 }).catch(() => false)) {
            await card.click();
            await sleep(1500);
            cardClicked = true;
            break;
          }
        }
        
        if (!cardClicked) {
          console.log("  [WARN] Option card not found, trying fallback click on first option...");
          const firstCard = page.locator('div[class*="card"], [role="button"]').first();
          if (await firstCard.isVisible({ timeout: 1000 }).catch(() => false)) {
            await firstCard.click();
            await sleep(1500);
          }
        }

        const continueBtn = page.locator('button:has-text("Continue")').first();
        if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  Clicking Continue on Stage 2...');
          await continueBtn.click();
          await sleep(5000);
          exploreHandled = true;
          break;
        } else {
          console.log("  Continue button not found on Stage 2, waiting...");
          await sleep(2000);
        }
      } else {
        await sleep(1000);
      }
    }

    // Step 6: Create API key via the modal
    console.log('[5/7] Creating API key from the modal...');
    await sleep(4000);

    let apiKey = '';
    const nameInputSelectors = [
      'input[placeholder*="Friendly name" i]',
      'input[placeholder*="My first useful key" i]',
      'input[id*="name" i]',
      'input[type="text"]'
    ];

    let nameInput = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const sel of nameInputSelectors) {
        const input = page.locator(sel).first();
        if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
          nameInput = input;
          break;
        }
      }
      if (nameInput) break;

      const dashboardBtns = [
        page.locator('button:has-text("Create API Key")'),
        page.locator('a:has-text("Create API Key")'),
        page.locator('button:has-text("Free API Key")'),
        page.locator('a:has-text("Free API Key")'),
        page.locator('a[href*="/api-keys"]')
      ];

      let clicked = false;
      for (const btn of dashboardBtns) {
        if (await btn.first().isVisible().catch(() => false)) {
          console.log("  Found dashboard Create API Key button/link, clicking to open modal...");
          await btn.first().click({ force: true }).catch(() => {});
          await sleep(2000);
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await sleep(1000);
      }
    }

    if (nameInput) {
      const keyName = 'omni';
      console.log(`  Filling key name: ${keyName}`);
      await nameInput.fill(keyName);
      await sleep(1000);

      const createKeyBtnSelectors = [
        'button:has-text("Create Key")',
        'button:has-text("Create key")',
        'button:has-text("Create")',
        'button[type="submit"]'
      ];

      let createKeyClicked = false;
      for (const sel of createKeyBtnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`  Clicking Create Key button: ${sel}`);
          await btn.click();
          await sleep(4000);
          createKeyClicked = true;
          break;
        }
      }

      if (createKeyClicked) {
        console.log('  Waiting for the API key secret display...');
        apiKey = await extractApiKeyFromPage(page);

        // Click the checkbox
        const checkboxSelectors = [
          'input[type="checkbox"]',
          'text="I know I can\'t access this key\'s secret again"',
          'span:has-text("I know I can\'t access")',
          'label:has-text("I know I can\'t access")',
        ];

        let checkboxClicked = false;
        for (let cbAttempt = 0; cbAttempt < 5; cbAttempt++) {
          for (const sel of checkboxSelectors) {
            const cb = page.locator(sel).first();
            if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
              await cb.click();
              console.log(`  Clicked checkbox using: ${sel}`);
              checkboxClicked = true;
              break;
            }
          }
          if (checkboxClicked) break;
          await sleep(1000);
        }

        // Click Got It button
        const gotItSelectors = [
          'button:has-text("Got it")',
          'button:has-text("got it")',
          'button:has-text("View code sample")',
        ];

        let gotItClicked = false;
        for (const sel of gotItSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await btn.click();
            console.log(`  Clicked Got It button using: ${sel}`);
            gotItClicked = true;
            break;
          }
        }
        await sleep(3000);
      }
    } else {
      console.log('  [WARN] "Create an API Key" modal not found or input not visible.');
    }

    if (!apiKey) {
      console.log('  [WARN] API key could not be extracted automatically.');
      console.log('  Please check screen screenshot to retrieve the key.');
      await page.screenshot({ path: path.join(__dirname, `deepgram_api_key_check_${Date.now()}.png`) });
    } else {
      console.log(`  Extracted API Key: ${apiKey}`);
    }

    // Step 7: Check Dashboard and Credit Status
    console.log('[6/7] Checking Dashboard Credit status...');
    if (!page.url().includes('/dashboard')) {
      console.log('  Navigating to dashboard...');
      await page.goto('https://console.deepgram.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(5000);
    }

    const dashboardScreenshot = path.join(__dirname, 'deepgram_dashboard.png');
    await page.screenshot({ path: dashboardScreenshot }).catch(() => {});
    console.log(`  Dashboard screenshot saved to ${dashboardScreenshot}`);

    const dashboardBodyText = await page.innerText('body').catch(() => '');
    const hasCreditNone = /credit\s*[\r\n\s]*none/i.test(dashboardBodyText);

    if (hasCreditNone) {
      console.log('========================================');
      console.log('  CREDIT IS NONE! SKIPPING SAVING TO CSV.');
      console.log('========================================');
      return;
    }

    console.log('  Credit is not None. Proceeding with key validation...');

    // Validate the API key using WebSocket
    if (!apiKey) {
      console.log('  [ERROR] No API key extracted. Skipping validation.');
      return;
    }

    const isValid = await validateDeepgramKey(apiKey);
    if (!isValid) {
      console.log('========================================');
      console.log('  KEY VALIDATION FAILED! SKIPPING SAVING.');
      console.log('========================================');
      return;
    }

    // Step 8: Save to CSV
    console.log('[7/7] Saving credentials to deepgram.csv...');
    const proxyForCsv = connectedCDP ? 'direct/cdp' : (selectedProxy || 'direct');
    const csvHeaders = 'timestamp,email,password,api_key,proxy\n';
    const csvRow = [new Date().toISOString(), email, password, apiKey, proxyForCsv].map(csvCell).join(',') + '\n';
    
    if (!fs.existsSync(CONFIG.outputFile)) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders, 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow, 'utf8');
    console.log(`  Account details successfully saved to ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  DEEPGRAM SIGNUP & KEY GENERATION SUCCESS');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${password}`);
    console.log(`  API Key:    ${apiKey}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('  [ERROR] Registration failed:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errScreenshot = path.join(__dirname, `deepgram_error_${Date.now()}.png`);
    await page.screenshot({ path: errScreenshot }).catch(() => {});
    console.log(`  Screenshot saved to ${errScreenshot}`);
    throw err;
  } finally {
    if (browser && typeof browser.close === 'function') {
      await browser.close().catch(() => {});
    } else if (context) {
      await context.close().catch(() => {});
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
  register().catch(console.error);
}

module.exports = { register, CONFIG };
