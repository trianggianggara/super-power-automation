// Kimchi.dev Auto-Registration Script using Playwright
const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const TempMail = require('../services/tempmail/tempmail.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');

const CONFIG = {
  signupUrl: 'https://app.kimchi.dev/',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'kimchi.csv'),
  emailTimeout: 180000,
  browserExecutablePath: '/usr/bin/google-chrome-stable',
};

function envFlag(flagName, defaultValue = false) {
  const val = process.env[flagName];
  if (val === undefined) return defaultValue;
  const lower = val.toLowerCase().trim();
  return lower === 'true' || lower === '1' || lower === 'yes';
}

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function ensureChromeRunning(executablePath = '/usr/bin/google-chrome-stable', port = 9222) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log(`Google Chrome with Remote Debugging is already running on port ${port}.`);
      return true;
    }

    console.log(`Google Chrome Remote Debugging port ${port} NOT detected. Spawning Chrome...`);

    let chromePath = executablePath;
    const tempProfileDir = `/tmp/chrome-debug-profile-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled'
    ];

    console.log(`Spawning chrome: ${chromePath} ${args.join(' ')}`);

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
        console.log('Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Google Chrome remote debugging port ${port} to respond.`);
  } catch (err) {
    console.log(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

function parseProxy(p) {
  if (!p) return null;
  try {
    const u = new URL(p);
    return {
      server: `${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password)
    };
  } catch (err) {
    return null;
  }
}

// Monitor Turnstile state changes via polling iframe DOM
async function monitorTurnstile(page, resolve) {
  console.log('[INFO] monitorTurnstile started.');
  try {
    // 1. Wait for the Turnstile iframe to load and exist in DOM (max 30s)
    console.log('Waiting for Turnstile frame to appear...');
    let frame = null;
    for (let i = 0; i < 30; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    
    if (!frame) {
      throw new Error('Turnstile frame not found in frame list.');
    }

    // Wait longer to let layout settle
    console.log('Turnstile frame detected. Waiting 5s for layout to settle...');
    await page.waitForTimeout(5000);

    // 2. Loop to check for token and click the checkbox if needed (max 2 minutes)
    console.log('Waiting for Turnstile response token to populate...');
    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes
    let clickCount = 0;
    let lastClickTime = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return;

      // If the destination form elements are already visible, we are past Turnstile!
      const emailVisible = await page.locator('input[type="email"], input[name="email"], #email').filter({ visible: true }).first().isVisible().catch(() => false);
      if (emailVisible) {
        console.log('✅ CAPTCHA SOLVED (Form elements detected)!');
        resolve();
        return;
      }

      // Check if token is populated in the page
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
        console.log(`\u2705 CAPTCHA SOLVED (Token found: ${tokenValue.substring(0, 15)}...)!`);
        resolve();
        return;
      }

      // Check if the Turnstile frame is still present
      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));

      if (!activeFrame) {
        console.log('Turnstile frame is no longer present. Checking if form is loaded...');
        const emailVisible = await page.locator('input[type="email"], input[name="email"], #email').filter({ visible: true }).first().isVisible().catch(() => false);
        if (emailVisible) {
          console.log('✅ CAPTCHA SOLVED (Form elements loaded and Turnstile iframe dissolved)!');
          resolve();
          return;
        }
        await page.waitForTimeout(1000);
        continue;
      }

      // Check if Turnstile iframe element is visible and has a positive bounding box
      const frameElement = await activeFrame.frameElement().catch(() => null);
      if (frameElement) {
        const isFrameVisible = await frameElement.isVisible().catch(() => false);
        if (isFrameVisible) {
          const box = await frameElement.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const now = Date.now();
            // If it's been at least 8 seconds since the last click (or we haven't clicked yet), click it.
            if (now - lastClickTime > 8000) {
              const clickX = box.x + 30;
              const clickY = box.y + box.height / 2;
              clickCount++;
              console.log(`[Click #${clickCount}] Auto-clicking Turnstile checkbox: x=${clickX}, y=${clickY}`);
              await page.mouse.click(clickX, clickY).catch(() => {});
              lastClickTime = now;
            }
          }
        } else {
          console.log('Turnstile frame element is not visible.');
        }
      }

      await page.waitForTimeout(2000);
    }

    console.log('\u26a0 Auto-click did not solve captcha in 2 minutes. Waiting for manual solve (max 13 min)...');

    // 3. Fallback: poll for another 13 minutes for manual solve
    for (let i = 0; i < 780; i++) {
      if (page.isClosed()) return;

      const emailVisible = await page.locator('input[type="email"], input[name="email"], #email').filter({ visible: true }).first().isVisible().catch(() => false);
      if (emailVisible) {
        console.log('✅ CAPTCHA SOLVED (Form elements detected in fallback loop)!');
        resolve();
        return;
      }

      const manualToken = await page.evaluate(() => {
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
        return '';
      }).catch(() => '');

      if (manualToken) {
        console.log(`\u2705 CAPTCHA SOLVED MANUALLY (Token found: ${manualToken.substring(0, 15)}...)!`);
        resolve();
        return;
      }
      await page.waitForTimeout(1000);
    }
  } catch (err) {
    console.log(`[ERROR] monitorTurnstile failed: ${err.message}`);
  }
  resolve();
}

async function resolveBaseEmail(tempmail) {
  const envGmailUser = process.env.GMAIL_USER || '';
  const emails = envGmailUser.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (emails.length > 0) {
    const selected = emails[Math.floor(Math.random() * emails.length)];
    console.log(`  Selected random email from GMAIL_USER list: ${selected}`);
    return selected;
  }

  throw new Error("Failed to determine Gmail address. Please set GMAIL_USER in .env.");
}

async function register() {
  console.log('=== Kimchi.dev Auto-Registration ===');
  
  const tempmail = new TempMail();
  const baseEmail = await resolveBaseEmail(tempmail);
  
  const atIdx = baseEmail.indexOf('@');
  const username = baseEmail.slice(0, atIdx);
  const domainName = baseEmail.slice(atIdx + 1);
  
  const cleanUsername = username.replace(/\./g, '').split('+')[0];
  
  // Load existing emails from kimchi.csv to avoid duplicates
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
  let attempts = 0;
  while (attempts < 1000) {
    let dottedUsername = cleanUsername;
    // Insert at most 1 dot at a random position to avoid triggering "Email addresses format is not allowed"
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
  console.log(`Generated registration email (pure dot-trick): ${email}`);

  const password = CONFIG.password;
  console.log(`Using password: ${password}`);

  // Kimchi.dev does not work with proxy. Always run without proxy.
  const selectedProxy = null;
  const pc = null;

  const tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_kimchi_${Date.now()}`);
  
  const useCDP = envFlag('USE_CDP', false);
  
  let context;
  let browser;
  let connectedCDP = false;
  let dynamicPortUsed = null;

  if (useCDP) {
    try {
      const dynamicPort = Math.floor(19000 + Math.random() * 6000);
      dynamicPortUsed = dynamicPort;
      await ensureChromeRunning(CONFIG.browserExecutablePath, dynamicPort);
      const checkRes = await fetch(`http://127.0.0.1:${dynamicPort}/json/version`).catch(() => null);
      if (checkRes && checkRes.ok) {
        console.log(`Found active Google Chrome Remote Debugging port at http://127.0.0.1:${dynamicPort}! Connecting...`);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
        const contextOpts = {
          ignoreHTTPSErrors: true
        };
        if (pc) {
          contextOpts.proxy = { server: `http://${pc.server}`, username: pc.username, password: pc.password };
        }
        context = await browser.newContext(contextOpts);
        connectedCDP = true;
      }
    } catch (err) {
      console.log(`CDP connection error: ${err.message}`);
    }
  }

  if (!connectedCDP) {
    const directPort = Math.floor(19000 + Math.random() * 6000);
    const launchOptions = {
      headless: envFlag('HEADLESS', false),
      executablePath: CONFIG.browserExecutablePath,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      ignoreHTTPSErrors: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--incognito',
        `--remote-debugging-port=${directPort}`
      ]
    };
    if (pc) {
      launchOptions.proxy = { server: `http://${pc.server}`, username: pc.username, password: pc.password };
    }
    context = await chromium.launchPersistentContext(tempProfileDir, launchOptions);
    console.log(`Google Chrome direct launch remote debugging port is active at http://127.0.0.1:${directPort}`);
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // Close default blank pages in the default browser context to prevent leakage/confusions
  if (connectedCDP && browser) {
    const allContexts = browser.contexts();
    for (const ctx of allContexts) {
      if (ctx !== context) {
        const pages = ctx.pages();
        for (const p of pages) {
          await p.close().catch(() => {});
        }
      }
    }
  }

  // Intercept and abort resource types that are not needed to reduce request volume and stay under proxy trial concurrency/rate limits
  if (pc) {
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      const url = route.request().url();
      // Always allow main document, scripts, and turnstile iframe resources
      if (type === 'document' || type === 'script' || url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        route.continue();
      } else if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  try {
    console.log('[1/8] Opening Kimchi sign up page...');
    await page.goto(CONFIG.signupUrl, { waitUntil: 'load', timeout: 60000 });

    console.log('  Mencoba auto-click Turnstile captcha (jika gagal, silakan klik manual)...');
    let resolvePromise;
    const solvedPromise = new Promise((res) => {
      resolvePromise = res;
    });
    monitorTurnstile(page, resolvePromise);
    await solvedPromise;

    console.log('  Waiting for login/signup page components...');
    const emailInput = page.locator('input[type="email"], input[name="email"], #email').filter({ visible: true }).first();
    await emailInput.waitFor({ state: 'visible', timeout: 120000 });
    console.log('  Page loaded successfully.');

    // Check if we are on the Sign In page and click Sign Up link if present
    const isSignInPage = await page.locator('h1:has-text("Welcome back"), h2:has-text("Welcome back"), button:has-text("Sign in"), button:has-text("Sign In")').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (isSignInPage) {
      console.log('  Detected Sign In page ("Welcome back"). Looking for "Sign up" link to register...');
      const signupLink = page.locator('a:has-text("Sign up"), a[href*="signup" i], a[href*="register" i]').first();
      await signupLink.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await signupLink.isVisible().catch(() => false)) {
        console.log('  Clicking Sign up link...');
        
        let navigatedToSignup = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          await signupLink.click({ force: true }).catch(() => {});
          console.log(`  [Attempt ${attempt}/5] Clicked Sign up link, waiting to verify navigation...`);
          await sleep(2000);
          
          const isSignUpPage = await page.locator('h1:has-text("Create"), h1:has-text("Sign up"), button:has-text("Sign up"), button:has-text("Create"), h2:has-text("Create"), h2:has-text("Sign up")').first().isVisible().catch(() => false);
          if (isSignUpPage) {
            navigatedToSignup = true;
            break;
          }
        }
        
        if (navigatedToSignup) {
          console.log('  Successfully loaded Sign Up page.');
        } else {
          console.log('  [WARN] Failed to confirm Sign Up page navigation.');
        }
      }
    }

    console.log('[2/8] Filling signup details...');
    await page.locator('input[type="email"], input[name="email"], #email').filter({ visible: true }).first().fill(email);
    await sleep(500);

    const passwordInput = page.locator('input[type="password"], input[name="password"], #password').filter({ visible: true }).first();
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill(password);
      await sleep(500);
    }

    const checkRegistrationError = async () => {
      const errorLocators = [
        page.locator(':has-text("Invalid sign up")'),
        page.locator(':has-text("already exists")'),
        page.locator(':has-text("format is not allowed")'),
        page.locator('[class*="error" i]:has-text("sign up")'),
        page.locator('[class*="feedback" i]:has-text("error")')
      ];
      for (const loc of errorLocators) {
        if (await loc.first().isVisible().catch(() => false)) {
          const errText = await loc.first().innerText().catch(() => 'Registration error');
          return errText.trim();
        }
      }
      return null;
    };

    const submitBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign up"), button:has-text("Sign In"), button:has-text("Create")').filter({ visible: true }).first();
    console.log('  Submitting form...');
    await submitBtn.click({ force: true });
    await sleep(4000);

    const errFirst = await checkRegistrationError();
    if (errFirst) {
      console.log(`  [WARN] Registration rejected: "${errFirst}". Aborting this run.`);
      throw new Error(`Registration rejected: ${errFirst}`);
    }

    // If password input was not on the first page, it might be on the second page (Ory Flow)
    const secondPasswordInput = page.locator('input[type="password"], input[name="password"], #password').filter({ visible: true }).first();
    if (await secondPasswordInput.isVisible().catch(() => false)) {
      console.log('  Entering password on step 2...');
      await secondPasswordInput.fill(password);
      await sleep(500);
      const secondSubmit = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Sign up"), button:has-text("Sign In")').filter({ visible: true }).first();
      await secondSubmit.click({ force: true });
      await sleep(4000);

      const errSecond = await checkRegistrationError();
      if (errSecond) {
        console.log(`  [WARN] Registration rejected on step 2: "${errSecond}". Aborting this run.`);
        throw new Error(`Registration rejected: ${errSecond}`);
      }
    }
    // Check if email confirmation page is loaded
    const confirmEmailHeader = page.locator('h1:has-text("Confirm"), h2:has-text("Confirm"), h1:has-text("verification"), h2:has-text("verification"), :has-text("verification email"), :has-text("Confirm your email")').first();
    if (await confirmEmailHeader.isVisible().catch(() => false)) {
      console.log('  Email verification page detected. Fetching verification link from Gmail...');
      
      // Wait for the verification email (up to 3 minutes)
      let msg = null;
      const emailStartTime = Date.now();
      const emailTimeoutMs = 180000;
      while (Date.now() - emailStartTime < emailTimeoutMs) {
        const messages = await tempmail.getMessages(email).catch(() => []);
        if (messages && messages.length > 0) {
          const found = messages.find(m => {
            const subject = (m.subject || '').toLowerCase();
            const body = (m.html_body || m.text_body || '').toLowerCase();
            const from = (m.from_address || '').toLowerCase();
            return (subject.includes('verify') || subject.includes('confirm') || subject.includes('kimchi') || body.includes('kimchi') || from.includes('kimchi'));
          });
          if (found) {
            msg = found;
            break;
          }
        }
        await sleep(5000);
      }

      if (!msg) {
        throw new Error(`Timeout waiting for verification email on ${email}`);
      }
      console.log(`  Received email: "${msg.subject}". Extracting verification link...`);
      
      // Parse verification URL
      const links = [];
      const hrefRegex = /href="([^"]+)"/gi;
      let match;
      while ((match = hrefRegex.exec(msg.html_body)) !== null) {
        links.push(match[1]);
      }
      const urlRegex = /(https?:\/\/[^\s"'\<\>]+)/gi;
      while ((match = urlRegex.exec(msg.text_body)) !== null) {
        links.push(match[0]);
      }
      
      let verificationLink = links.find(link => link.includes('kimchi.dev') && !link.includes('unsubscribe') && !link.includes('static'));
      if (!verificationLink) {
        // If links are rewritten by SendGrid/tracking wrappers, take the first link that is not unsubscribe
        verificationLink = links.find(link => !link.includes('unsubscribe') && !link.includes('optout') && link.startsWith('http'));
      }
      if (!verificationLink) {
        console.log('  All parsed links:', links);
        throw new Error('Verification link not found in email body');
      }
      
      console.log(`  Opening verification link: ${verificationLink}`);
      await page.goto(verificationLink, { waitUntil: 'load', timeout: 60000 });
      
      // Pass Turnstile if it appears after email verification
      let verifyResolve;
      const verifySolvedPromise = new Promise((res) => {
        verifyResolve = res;
      });
      monitorTurnstile(page, verifyResolve);
      await verifySolvedPromise;
      
      await sleep(3000);

      // Check if we are redirected to a login page or if we need to log in
      console.log('  Checking if login is required...');
      const loginEmailInput = page.locator('input[type="email"], input[name="email"], #email').filter({ visible: true }).first();
      try {
        await loginEmailInput.waitFor({ state: 'visible', timeout: 3000 });
        console.log('  Login page detected. Performing login using registered credentials...');
        
        // Fill email
        await loginEmailInput.fill(email);
        await sleep(500);
        
        // Fill password
        const loginPasswordInput = page.locator('input[type="password"], input[name="password"], #password').filter({ visible: true }).first();
        await loginPasswordInput.fill(password);
        await sleep(500);
        
        // Click Submit/Login button
        const loginBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Sign In")').first();
        await loginBtn.click();
        console.log('  Clicked Login button.');
        
        // After clicking login, Turnstile might appear again!
        let loginResolve;
        const loginSolvedPromise = new Promise((res) => {
          loginResolve = res;
        });
        monitorTurnstile(page, loginResolve);
        await loginSolvedPromise;
        
      } catch (err) {
        console.log('  No login page detected or already logged in (continuing to 2FA):', err.message);
      }
      
      await sleep(5000);
    }
    let secretKey = '';
    console.log('[3/8] Determining next screen (2FA setup vs Dashboard)...');
    
    let nextScreen = 'unknown';
    const qrElement = page.locator('img[src*="base64" i], img[src*="data:image" i], canvas, [class*="qr" i] img, [class*="qr" i] svg, [class*="totp" i] img, [class*="totp" i] svg').filter({ visible: true }).first();
    const recoveryBtn = page.locator('#kc-recovery-btn, button:has-text("I\'ve saved my recovery code")').first();
    const otpInput = page.locator('#kc-code').first();
    const dashboardElement = page.locator('button:has-text("Create Key"), button:has-text("Create API Key"), button:has-text("Add Key"), button:has-text("Generate Key"), a:has-text("Create Key"), a:has-text("API Keys")').first();

    for (let i = 0; i < 30; i++) {
      if (page.isClosed()) return;

      const hasQr = await qrElement.isVisible().catch(() => false);
      const hasRecovery = await recoveryBtn.isVisible().catch(() => false);
      const hasOtp = await otpInput.isVisible().catch(() => false);
      const hasDashboard = await dashboardElement.isVisible().catch(() => false) || page.url().includes('/app.kimchi.dev');

      if (hasQr || hasRecovery || hasOtp) {
        nextScreen = '2fa';
        break;
      }
      if (hasDashboard) {
        nextScreen = 'dashboard';
        break;
      }
      await sleep(1000);
    }

    console.log(`  Detected screen: ${nextScreen}`);

    if (nextScreen === '2fa') {
      // Helper to extract 2FA secret key from page DOM
      const extractSecretFromPage = async () => {
        return await page.evaluate(() => {
          const isValidSecret = (str) => {
            const cleaned = str.replace(/[\s\-\u00A0]+/g, '');
            return /^[A-Z0-9]{24,32}$/.test(cleaned);
          };

          // Try inputs
          const inputs = Array.from(document.querySelectorAll('input'));
          for (const input of inputs) {
            const val = (input.value || '').trim();
            if (isValidSecret(val)) return val.replace(/[\s\-\u00A0]+/g, '');
          }

          // Try text content of elements
          const selectors = ['code', 'pre', 'span', 'div', 'p'];
          for (const sel of selectors) {
            const elements = Array.from(document.querySelectorAll(sel));
            for (const el of elements) {
              if (el.children.length === 0) {
                const text = (el.textContent || '').trim();
                if (isValidSecret(text)) return text.replace(/[\s\-\u00A0]+/g, '');
              }
            }
          }
          return null;
        }).catch(() => null);
      };

      // Try DOM extraction first
      secretKey = await extractSecretFromPage();
      if (secretKey) {
        console.log(`  Successfully extracted 2FA Secret Key from page DOM: ${secretKey}`);
      } else {
        // Fall back to QR code screenshot and decoding
        await qrElement.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await sleep(3000); // Allow browser JS to render/update the QR code source fully
        const hasQr = await qrElement.isVisible().catch(() => false);
        if (hasQr) {
          console.log('  2FA setup screen detected (QR Code visible). Decoding QR code...');
          
          // Screenshot the QR code element to a unique local file to prevent cross-run caching
          const qrPath = path.join(__dirname, `qr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.png`);
          const box = await qrElement.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            console.log(`  Taking clipped page screenshot for QR code at: ${JSON.stringify(box)}`);
            await page.screenshot({
              path: qrPath,
              clip: { x: box.x, y: box.y, width: box.width, height: box.height }
            });
          } else {
            console.log('  Clipped screenshot unavailable. Falling back to locator.screenshot...');
            await qrElement.screenshot({ path: qrPath, timeout: 10000 }).catch(async (e) => {
              console.log(`  Locator screenshot failed: ${e.message}. Taking full page screenshot as final fallback...`);
              await page.screenshot({ path: qrPath });
            });
          }
          console.log(`  QR Code screenshot saved to: ${qrPath}`);

        console.log('[4/8] Decoding QR code using zxing.org...');
        const zxingPage = await context.newPage();
        await zxingPage.goto('https://zxing.org/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const fileInput = zxingPage.locator('input[type="file"], input[name="f"]').first();
        try {
          await fileInput.waitFor({ state: 'visible', timeout: 15000 });
        } catch (err) {
          console.log('  [WARN] zxing.org file input not visible, capturing screenshot to zxing_error.png...');
          await zxingPage.screenshot({ path: path.join(__dirname, 'zxing_error.png') }).catch(() => {});
          throw err;
        }
        await fileInput.setInputFiles(qrPath);
        
        const zxingSubmit = zxingPage.locator('tr:has(input[type="file"]) input[type="submit"]').first();
        await zxingSubmit.click();
        await zxingPage.waitForURL('**/w/decode**', { timeout: 30000 }).catch(async () => {
          console.log('  [WARN] zxing.org result navigation timed out. Attempting fallback wait...');
          await sleep(5000);
        });

        const zxingBody = await zxingPage.innerText('body').catch(() => '');
        const secretMatch = zxingBody.match(/secret=([A-Z2-7=]+)/i);
        if (!secretMatch) {
          console.log('  Decoded text from zxing:\n', zxingBody);
          await zxingPage.screenshot({ path: path.join(__dirname, 'zxing_error.png') }).catch(() => {});
          throw new Error('Failed to find 2FA secret key in zxing.org response');
        }
        secretKey = secretMatch[1];
        console.log(`  Decoded 2FA Secret Key: ${secretKey}`);
        await zxingPage.close();

        // Clean up qr.png file
        try {
          if (fs.existsSync(qrPath)) {
            fs.unlinkSync(qrPath);
          }
        } catch (_) {}
      }
    }

      console.log('[6/8] Entering OTP code on Kimchi...');
      
      // Wait for recoveryBtn to be attached or visible
      const recoveryBtnLoc = page.locator('#kc-recovery-btn, button:has-text("I\'ve saved my recovery code")').first();
      await recoveryBtnLoc.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});

      console.log('  Clicking recovery code button and waiting for OTP field...');
      let buttonClicked = false;
      for (let clickAttempt = 1; clickAttempt <= 5; clickAttempt++) {
        // Try Playwright click
        await recoveryBtnLoc.click({ force: true }).catch(() => {});
        await recoveryBtnLoc.evaluate(el => el.click()).catch(() => {});
        
        // Try native fallback click
        await page.evaluate(() => {
          const btn = document.querySelector('#kc-recovery-btn') || 
                      Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes("I've saved"));
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        }).catch(() => {});
        
        // Wait to see if the OTP input becomes visible
        const otpInput = page.locator('#kc-code').first();
        const visible = await otpInput.isVisible().catch(() => false);
        if (visible) {
          buttonClicked = true;
          console.log('  OTP input field (#kc-code) is now visible!');
          break;
        }
        await sleep(2000);
      }

      const otpInput = page.locator('#kc-code').first();
      console.log('  Waiting for OTP input field (#kc-code)...');
      try {
        await otpInput.waitFor({ state: 'visible', timeout: 15000 });
      } catch (err) {
        throw new Error('Timeout waiting for OTP input field (#kc-code) to become visible after clicking recovery button.');
      }

      if (secretKey) {
        // Loop to fetch fresh OTP and submit (handles expired or failed codes)
        let otpSuccess = false;
        const maxOtpAttempts = 5;
        for (let otpAttempt = 1; otpAttempt <= maxOtpAttempts; otpAttempt++) {
          if (!(await otpInput.isVisible().catch(() => false))) {
            console.log('  OTP input field is no longer visible. OTP phase completed.');
            otpSuccess = true;
            break;
          }

          console.log(`  Fetching fresh 2FA token from 2fa.live (Attempt ${otpAttempt}/${maxOtpAttempts})...`);
          
          let otpCode = '';
          try {
            // Retrying should wait for a new TOTP window to get a different code
            if (otpAttempt > 1) {
              const epoch = Math.round(Date.now() / 1000);
              const remaining = 30 - (epoch % 30);
              const waitTime = remaining + 1;
              console.log(`  Retrying OTP. Waiting ${waitTime}s for next TOTP window to get a different code...`);
              await sleep(waitTime * 1000);
            } else {
              // Avoid submitting at the very end of the current window (within last 6 seconds)
              const epoch = Math.round(Date.now() / 1000);
              const remaining = 30 - (epoch % 30);
              if (remaining < 6) {
                const waitTime = remaining + 1;
                console.log(`  TOTP window expiring in ${remaining}s. Waiting ${waitTime}s for a fresh window...`);
                await sleep(waitTime * 1000);
              }
            }

            const totpRes = await fetch(`https://2fa.live/tok/${secretKey}`);
            if (totpRes.ok) {
              const totpData = await totpRes.json();
              otpCode = totpData.token;
            }
          } catch (e) {
            console.log(`  [WARN] Failed to fetch OTP: ${e.message}`);
          }

          if (!otpCode) {
            console.log('  [WARN] Could not retrieve OTP code. Retrying in 3s...');
            await sleep(3000);
            continue;
          }

          console.log(`  Generated OTP Code: ${otpCode}`);
          await otpInput.fill(otpCode);
          await sleep(500);

          const otpSubmit = page.locator('#kc-btn, button[type="submit"]').first();
          console.log('  Submitting OTP code...');
          await otpSubmit.click({ force: true }).catch(() => {});
          
          // Wait to see if submission succeeds
          await sleep(6000);
          
          const stillVisible = await otpInput.isVisible().catch(() => false);
          if (!stillVisible) {
            console.log('  OTP input is no longer visible. OTP submission successful!');
            otpSuccess = true;
            break;
          }
          
          console.log('  OTP input is still visible. Code might have been invalid/expired. Retrying...');
        }

        if (!otpSuccess) {
          console.log('  [WARN] OTP submission did not clear the OTP field after multiple attempts.');
        }
      } else {
        console.log('  [WARN] No 2FA secret key decoded. Please solve/verify 2FA input manually if required.');
        // If no secretKey decoded, let's wait longer for manual interaction or for the input to disappear
        for (let waitSec = 0; waitSec < 60; waitSec++) {
          if (!(await otpInput.isVisible().catch(() => false))) {
            break;
          }
          await sleep(1000);
        }
      }
    } else {
      console.log('  Skipping 2FA flow (either not present or already on dashboard).');
    }

    console.log('[7/8] Creating API Key...');
    // Wait for the app page/dashboard to load
    await page.waitForURL('**/app.kimchi.dev/**', { timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // Look for create API key button/link
    let createKeyBtn = page.locator('button:has-text("Create Key"), button:has-text("Create API Key"), button:has-text("Add Key"), button:has-text("Generate Key"), a:has-text("Create Key"), a:has-text("API Keys")').first();
    if (await createKeyBtn.isVisible().catch(() => false)) {
      await createKeyBtn.click();
      await sleep(2000);
    }

    // Name the key if prompted
    const keyNameInput = page.locator('input[type="text"], input[placeholder*="name" i]').first();
    if (await keyNameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      const randomKeyName = 'key_' + Math.random().toString(36).substring(2, 10);
      console.log(`  Entering key name: ${randomKeyName}`);
      await keyNameInput.fill(randomKeyName);
      await sleep(500);
      
      const confirmBtn = page.locator('button[type="submit"], button:has-text("Create"), button:has-text("Confirm")').first();
      await confirmBtn.click();
      await sleep(3000);
    }

    // Extract the API Key
    let apiKey = '';
    const textSelectors = ['code', 'pre', 'input[readonly]', 'input[type="text"]', 'span', 'div'];
    for (const selector of textSelectors) {
      const loc = page.locator(selector);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const text = await loc.nth(i).innerText().catch(() => '');
        const val = await loc.nth(i).inputValue().catch(() => '');
        const combined = (text + '\n' + val).trim();
        const match = combined.match(/\b(sk-[a-zA-Z0-9_]{32,64})\b/);
        if (match) {
          apiKey = match[1];
          break;
        }
      }
      if (apiKey) break;
    }

    if (!apiKey) {
      console.log('  [WARN] API key could not be extracted automatically.');
      const errScreenshot = path.join(__dirname, `kimchi_key_extract_failed_${Date.now()}.png`);
      await page.screenshot({ path: errScreenshot }).catch(() => {});
      console.log(`  Screenshot saved to ${errScreenshot}`);
    } else {
      console.log(`  Extracted API Key: ${apiKey}`);
    }

    console.log('[8/8] Saving credentials to kimchi.csv...');
    const csvHeaders = 'timestamp,email,password,api_key,secret_2fa\n';
    const csvRow = [new Date().toISOString(), email, password, apiKey || 'NOT_FOUND', secretKey].map(csvCell).join(',') + '\n';
    
    if (!fs.existsSync(CONFIG.outputFile)) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders, 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow, 'utf8');
    console.log(`  Account details successfully saved to ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  KIMCHI SIGNUP & KEY GENERATION SUCCESS');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${password}`);
    console.log(`  2FA Secret: ${secretKey}`);
    console.log(`  API Key:    ${apiKey || 'NOT_FOUND'}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('Registration failed:', err);
  } finally {
    if (connectedCDP) {
      if (browser) await browser.close().catch(() => {});
    } else {
      if (context) await context.close().catch(() => {});
      try {
        if (fs.existsSync(tempProfileDir)) {
          fs.rmSync(tempProfileDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
    if (dynamicPortUsed) {
      try {
        const { execSync } = require('child_process');
        execSync(`fuser -k ${dynamicPortUsed}/tcp`, { stdio: 'ignore' });
        console.log(`Terminated Chrome process on dynamic port ${dynamicPortUsed}.`);
      } catch (_) {}
    }
  }
}

register();
