// Kiro.dev Auto-Registration Script using Playwright
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
  signinUrl: 'https://app.kiro.dev/signin',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'kiro_accounts.csv'),
  otpTimeout: 180000,
  proxy: process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
  omnirouteUrl: process.env.OMNIROUTE_URL || 'http://100.103.220.104:20128',
  omniroutePassword: process.env.OMNIROUTE_PASSWORD || '123456',
  importToOmniRoute: envFlag('OMNIROUTE_IMPORT_ON_SUCCESS', true),
};

let lastFailedUrl = '';

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function resolveBaseEmail(tempmail) {
  const envGmailUser = process.env.GMAIL_USER || '';
  const emails = envGmailUser.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (emails.length > 0) {
    const selected = emails[Math.floor(Math.random() * emails.length)];
    console.log(`  Selected random email from GMAIL_USER list: ${selected}`);
    return selected;
  }

  // Fallback if GMAIL_USER is empty/not set: Get email dynamically from Google Profile API
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
        apiKey: process.env.LLM_API_KEY,
        apiUrl: process.env.LLM_API_URL,
        model: process.env.LLM_MODEL,
      });
      if (solved === true) {
        console.log(`  [CAPTCHA] Captcha solved successfully for "${label}"!`);
        return true;
      } else if (solved === 'no_challenge') {
        console.log(`  [CAPTCHA] No active captcha challenge was displayed for "${label}".`);
        return false;
      } else {
        console.log(`  [CAPTCHA] Captcha solver returned failure for "${label}".`);
      }
    }
  } catch (err) {
    console.log(`  [CAPTCHA] Error during captcha detection/solving: ${err.message}`);
  }
  return false;
}

async function register() {
  console.log('=== Kiro.dev Auto-Registration ===');
  
  const tempmail = new TempMail();
  const provider = (TempMail.PROVIDER || process.env.TEMPMAIL_PROVIDER || 'webhook').toLowerCase().trim();
  
  let email = '';
  if (provider === 'gmail') {
    const baseEmail = await resolveBaseEmail(tempmail);
    
    const atIdx = baseEmail.indexOf('@');
    const username = baseEmail.slice(0, atIdx);
    const domainName = baseEmail.slice(atIdx + 1);
    
    // Clean username of any existing dots or pluses
    const cleanUsername = username.replace(/\./g, '').split('+')[0];
    
    // Generate a dotted username (dot trick)
    let dottedUsername = cleanUsername[0];
    for (let i = 1; i < cleanUsername.length; i++) {
      if (Math.random() < 0.5) {
        dottedUsername += '.';
      }
      dottedUsername += cleanUsername[i];
    }
    
    // Add plus-sign combination with kiro, timestamp, and a random number
    const plusSuffix = `+kiro_${Date.now()}_${rand(1000, 9999)}`;
    email = `${dottedUsername}${plusSuffix}@${domainName}`;
  } else {
    const inbox = await tempmail.createInbox();
    email = inbox.address;
  }

  console.log(`Generated registration email: ${email}`);

  const executablePathToUse = CONFIG.browserExecutablePath || undefined;
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
      await ensureChromeRunning(executablePathToUse || 'google-chrome-stable', dynamicPort);
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

  // Watch for request failures globally to trigger reloads
  lastFailedUrl = '';
  page.on('requestfailed', request => {
    const errorText = request.failure()?.errorText || '';
    if (errorText.includes('ERR_CONNECTION_RESET') || errorText.includes('NS_ERROR_NET_RESET') || errorText.includes('NS_ERROR_CONNECTION_REFUSED')) {
      console.log(`  [NET ERROR] Failed to load ${request.url()} due to ${errorText}`);
      lastFailedUrl = request.url();
    }
  });

  // Console message listener
  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('Download the React DevTools') && !text.includes('Failed to load resource')) {
      console.log(`  [CONSOLE] [${msg.type()}] ${text}`);
    }
  });

  // Network request listener
  page.on('request', request => {
    const url = request.url();
    if (url.includes('signup') || url.includes('aws') || url.includes('cognito') || url.includes('login') || url.includes('device') || url.includes('telemetry')) {
      console.log(`  [REQ] ${request.method()} ${url}`);
    }
  });

  // Network response listener (logs bodies of errors >= 400)
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('signup') || url.includes('aws') || url.includes('cognito') || url.includes('login') || url.includes('device') || url.includes('telemetry')) {
      const status = response.status();
      console.log(`  [RES] ${status} ${url}`);
      if (status >= 400) {
        try {
          const body = await response.text();
          console.log(`  [RES ERROR BODY] ${url} -> ${body.substring(0, 1200)}`);
        } catch (_) {}
      }
    }
  });

  try {
    // Step 1: Open landing page
    console.log('[1/7] Opening Kiro signin page...');
    await gotoWithRetry(page, CONFIG.signinUrl);
    await sleep(2000);

    // Step 2: Click Builder ID
    console.log('[2/7] Clicking Builder ID login...');
    let redirectSuccess = false;
    for (let clickAttempt = 1; clickAttempt <= 3; clickAttempt++) {
      try {
        const builderIdBtn = page.locator('button:has-text("Builder ID"), a:has-text("Builder ID")').first();
        await builderIdBtn.click();
        
        // Wait for page to navigate away or check if it starts loading AWS URL
        await page.waitForURL(url => url.hostname.includes('aws') || url.hostname.includes('signin'), { timeout: 15000 });
        redirectSuccess = true;
        break;
      } catch (err) {
        console.log(`  [WARN] Click Builder ID or redirect failed (attempt ${clickAttempt}/3): ${err.message}`);
        if (clickAttempt === 3) throw err;
        console.log('  Navigating back to Kiro signin page to retry...');
        await gotoWithRetry(page, CONFIG.signinUrl);
        await sleep(3000);
      }
    }

     // Helper functions for retry, reload, errors, and cookie handling
    const handleCookiesLocal = async (p) => {
      try {
        const awsCookieSelectors = [
          '#awsccc-cb-btn-accept',
          '#awsccc-cb-buttons button',
          '#aws-cookie-banner-button-accept',
          '#aws-cookie-banner',
          'button:has-text("Accept")',
          'button:has-text("Accept all")',
          'button:has-text("Agree")',
          '#aws-privacy-notice-agree',
          '#cookie-consent-accept',
        ];
        for (const sel of awsCookieSelectors) {
          try {
            const btn = p.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
              await btn.click({ timeout: 2000 });
              console.log(`  [Cookies] Accepted cookies via ${sel}`);
              await sleep(500);
              break;
            }
          } catch (e) {}
        }

        try {
          await handleCookies(p, 200);
        } catch (e) {}

        // Remove elements from DOM if still present to prevent pointer interception
        await p.evaluate(() => {
          const ids = ['awsccc-sb-ux-c', 'awsccc-cb-buttons', 'aws-cookie-banner'];
          for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.remove();
          }
          const classes = ['awsccc-u-modal-backdrop', 'awsccc-cs-s-text', 'awsccc-cb-text'];
          for (const cls of classes) {
            const els = document.querySelectorAll('.' + cls);
            els.forEach(el => el.remove());
          }
        }).catch(() => {});
      } catch (err) {
        console.log(`  [Cookies] Error checking/accepting cookies: ${err.message}`);
      }
    };

    const checkAwsErrorsAndReload = async (p, label) => {
      const errorSelectors = [
        'text="It\'s not you, it\'s us"',
        'text="We couldn\'t complete your request"',
        'text="ERR-837"',
        'text="Please try again"',
        'text="error processing your request"',
        'text="Something went wrong"',
      ];
      for (const sel of errorSelectors) {
        if (await p.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) {
          console.log(`  [AWS ERROR] Detected error banner "${sel}" during "${label}". Reloading page...`);
          await p.reload();
          await sleep(3000);
          await handleCookiesLocal(p);
          return true;
        }
      }
      return false;
    };

    const waitWithRetryAndReload = async (p, locator, label, timeoutMs = 20000, maxRetries = 3) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await handleCookiesLocal(p);
          await checkAwsErrorsAndReload(p, label);
          
          // Explicitly check for browser-level network error page (Firefox neterror or Chrome error page)
          const currentUrl = p.url();
          const pageTitle = await p.title().catch(() => '');
          const pageBodyText = await p.innerText('body').catch(() => '');
          if (currentUrl.startsWith('about:neterror') || 
              pageTitle.toLowerCase().includes('problem loading page') || 
              pageTitle.toLowerCase().includes('secure connection failed') ||
              pageBodyText.includes('Secure Connection Failed') ||
              pageBodyText.includes('connection was reset') ||
              lastFailedUrl !== '') {
            console.log(`  [NET ERROR] Detected browser neterror page or connection reset on "${currentUrl}". Forcing reload...`);
            lastFailedUrl = ''; // reset flag
            await p.reload().catch(() => {});
            await sleep(4000);
            await handleCookiesLocal(p);
          }

          await handleCaptchaIfPresent(p, label);

          await locator.waitFor({ state: 'visible', timeout: timeoutMs });
          return;
        } catch (err) {
          console.log(`  [WARN] "${label}" wait failed (attempt ${attempt}/${maxRetries}): ${err.message}`);
          if (attempt === maxRetries) throw err;
          console.log(`  Reloading page to retry "${label}"...`);
          await p.reload().catch(() => {});
          await sleep(3000);
        }
      }
    };

    // Step 3: Wait for AWS Sign-in & Fill Email
    console.log('[3/7] Filling email on AWS portal...');
    const emailInput = page.locator('input[type="email"]').first();
    await waitWithRetryAndReload(page, emailInput, 'Email field loading');
    await sleep(1500);

    await typeHumanDirect(emailInput, email);
    await sleep(1000);

    const continueBtn = page.locator('button:has-text("Continue")').first();
    await continueBtn.click();

    // Step 4: Fill Name
    console.log('[4/7] Filling name...');
    const nameInput = page.locator('input[type="text"]').first();
    await waitWithRetryAndReload(page, nameInput, 'Name field loading');
    await sleep(1500);

    const firstNames = ['Della', 'Dolly', 'Diana', 'Dewi', 'Desy', 'Donna', 'Dora', 'Dina', 'Dani', 'Devi', 'Dania', 'Darla', 'Daisy', 'Clara', 'Cindy', 'Celia', 'Chelsea', 'Chloe', 'Alya', 'Anisa', 'Aurel', 'Bella', 'Bianca', 'Citra', 'Dinda', 'Elsa', 'Farah', 'Fiona', 'Gita', 'Hana', 'Indah', 'Intan', 'Irene', 'Jessica', 'Julia', 'Kartika', 'Karin', 'Kayla', 'Laras', 'Laura', 'Lina', 'Maya', 'Mila', 'Nadia', 'Naila', 'Nina', 'Olivia', 'Priska', 'Putri', 'Raina', 'Rani', 'Rara', 'Rika', 'Salsa', 'Santi', 'Sekar', 'Shinta', 'Tania', 'Tasya', 'Tiara', 'Vania', 'Vina', 'Yasmin', 'Zahra'];
    const lastNames = ['Adelia', 'Agata', 'Amanda', 'Amelia', 'Angelina', 'Anindya', 'Aprilia', 'Arianti', 'Arisanti', 'Astuti', 'Aulia', 'Ayuningtyas', 'Putri', 'Sari', 'Lestari', 'Wulandari', 'Anggraini', 'Anggraeni', 'Azzahra', 'Cahyaningrum', 'Damayanti', 'Fitriani', 'Handayani', 'Hapsari', 'Hasanah', 'Hidayati', 'Kirana', 'Kusuma', 'Kusumawati', 'Maharani', 'Maulida', 'Melati', 'Nabila', 'Nadira', 'Ningrum', 'Nuraini', 'Permata', 'Prameswari', 'Puspita', 'Ramadhani', 'Ratnasari', 'Safitri', 'Setianingrum', 'Susanti', 'Syahputri', 'Utami', 'Wijaya', 'Yuliana', 'Zulaikha'];
    const randomName = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
    console.log(`  Selected random name: ${randomName}`);
    await typeHumanDirect(nameInput, randomName);
    await sleep(1000);

    const nameContinueBtn = page.locator('button:has-text("Continue")').first();
    await nameContinueBtn.click();

    // Step 5: OTP Code
    console.log('[5/7] Waiting for OTP page...');
    const otpInput = page.locator('input[placeholder="6-digit"]').first();
    await waitWithRetryAndReload(page, otpInput, 'OTP field loading');
    await sleep(1500);

    console.log('  Retrieving OTP code from tempmail inbox...');
    const otp = await tempmail.waitForOtp(email, CONFIG.otpTimeout);
    if (!otp) {
      throw new Error('Failed to retrieve verification code.');
    }
    console.log(`  Retrieved OTP Code: ${otp}`);

    await typeHumanDirect(otpInput, otp);
    await sleep(1000);

    const otpContinueBtn = page.locator('button:has-text("Continue")').first();
    await otpContinueBtn.click();

    // Step 6: Create Password
    console.log('[6/7] Creating password...');
    const pwdInput = page.locator('input[placeholder="Enter password"]').first();
    await waitWithRetryAndReload(page, pwdInput, 'Password field loading');
    await sleep(1500);

    const confirmPwdInput = page.locator('input[placeholder="Re-enter password"]').first();
    await typeHumanDirect(pwdInput, CONFIG.password);
    await sleep(800);
    await typeHumanDirect(confirmPwdInput, CONFIG.password);
    await sleep(1000);

    const pwdContinueBtn = page.locator('button:has-text("Continue")').first();
    await pwdContinueBtn.click();

    // Step 7: Redirection back to Kiro
    console.log('[7/7] Waiting for redirect back to Kiro...');
    let loggedIn = false;
    const redirectDeadline = Date.now() + 20000;
    while (Date.now() < redirectDeadline) {
      await sleep(1000);
      const url = page.url();
      const bodyText = await page.innerText('body').catch(() => '');
      if (bodyText.includes('Authorize') || bodyText.includes('Allow') || bodyText.includes('consent') || bodyText.includes('dashboard') || url.includes('kiro.dev')) {
        loggedIn = true;
        console.log(`  Redirection target reached: ${url}`);
        break;
      }
    }

    if (loggedIn) {
      console.log('  Successfully signed in to Kiro!');
    } else {
      console.log('  [WARN] Redirection took too long, proceeding to save account.');
    }

    // === Auto import to OmniRoute on Success ===
    let importedToOmniRoute = 'false';
    if (CONFIG.importToOmniRoute) {
      try {
        await importToOmniRoute(context, email, CONFIG.password, tempmail);
        importedToOmniRoute = 'true';
      } catch (err) {
        console.error(`  [WARN] Auto-import during registration failed: ${err.message}`);
      }
    }

    const proxyForCsv = connectedCDP ? 'direct/cdp' : (selectedProxy || 'direct');

    // Save account credentials to CSV
    const csvHeaders = 'timestamp,email,password,api_key,imported_to_omniroute,proxy\n';
    const csvRow = [new Date().toISOString(), email, CONFIG.password, '', importedToOmniRoute, proxyForCsv].map(csvCell).join(',') + '\n';
    
    if (!fs.existsSync(CONFIG.outputFile)) {
      fs.writeFileSync(CONFIG.outputFile, csvHeaders, 'utf8');
    } else {
      const oldHeaders = 'timestamp,email,password,api_key,imported_to_omniroute\n';
      const currentCsv = fs.readFileSync(CONFIG.outputFile, 'utf8');
      if (currentCsv.startsWith(oldHeaders)) {
        const oldRows = currentCsv.slice(oldHeaders.length).split('\n');
        const migratedRows = oldRows.map(row => row ? `${row},""` : row).join('\n');
        fs.writeFileSync(CONFIG.outputFile, csvHeaders + migratedRows, 'utf8');
      }
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow, 'utf8');
    console.log(`  Account details successfully saved to ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  KIRO.DEV REGISTRATION & IMPORT SUCCESS');
    console.log('========================================');
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${CONFIG.password}`);
    console.log(`  Imported:   ${importedToOmniRoute}`);
    console.log('========================================\n');

  } catch (err) {
    console.error('  [ERROR] Registration failed:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errScreenshot = path.join(__dirname, `kiro_error_${Date.now()}.png`);
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

async function performAWSBuilderIdLogin(authPage, email, password, tempmail) {
  try {
    console.log('    [AWS Portal] Starting login flow...');
    await authPage.waitForLoadState('domcontentloaded');
    await sleep(3000);

    const handleCookiesLocal = async (p) => {
      try {
        const awsCookieSelectors = [
          '#awsccc-cb-btn-accept',
          '#awsccc-cb-buttons button',
          '#aws-cookie-banner-button-accept',
          '#aws-cookie-banner',
          'button:has-text("Accept")',
          'button:has-text("Accept all")',
          'button:has-text("Agree")',
          '#aws-privacy-notice-agree',
          '#cookie-consent-accept',
        ];
        for (const sel of awsCookieSelectors) {
          try {
            const btn = p.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
              await btn.click({ timeout: 2000 });
              console.log(`    [Cookies] Accepted cookies via ${sel}`);
              await sleep(500);
              break;
            }
          } catch (e) {}
        }

        try {
          await handleCookies(p, 200);
        } catch (e) {}

        // Remove elements from DOM if still present to prevent pointer interception
        await p.evaluate(() => {
          const ids = ['awsccc-sb-ux-c', 'awsccc-cb-buttons', 'aws-cookie-banner'];
          for (const id of ids) {
            const el = document.getElementById(id);
            if (el) el.remove();
          }
          const classes = ['awsccc-u-modal-backdrop', 'awsccc-cs-s-text', 'awsccc-cb-text'];
          for (const cls of classes) {
            const els = document.querySelectorAll('.' + cls);
            els.forEach(el => el.remove());
          }
        }).catch(() => {});
      } catch (err) {}
    };

    const checkAwsErrorsAndReload = async (p, label) => {
      const errorSelectors = [
        'text="It\'s not you, it\'s us"',
        'text="We couldn\'t complete your request"',
        'text="ERR-837"',
        'text="Please try again"',
        'text="error processing your request"',
        'text="Something went wrong"',
      ];
      for (const sel of errorSelectors) {
        if (await p.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) {
          console.log(`    [AWS ERROR] Detected error banner "${sel}" during "${label}". Reloading page...`);
          await p.reload();
          await sleep(3000);
          await handleCookiesLocal(p);
          return true;
        }
      }
      return false;
    };

    const waitWithRetryAndReload = async (p, locator, label, timeoutMs = 20000, maxRetries = 3) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await handleCookiesLocal(p);
          await checkAwsErrorsAndReload(p, label);

          // Explicitly check for browser-level network error page (Firefox neterror or Chrome error page)
          const currentUrl = p.url();
          const pageTitle = await p.title().catch(() => '');
          const pageBodyText = await p.innerText('body').catch(() => '');
          if (currentUrl.startsWith('about:neterror') || 
              pageTitle.toLowerCase().includes('problem loading page') || 
              pageTitle.toLowerCase().includes('secure connection failed') ||
              pageBodyText.includes('Secure Connection Failed') ||
              pageBodyText.includes('connection was reset') ||
              lastFailedUrl !== '') {
            console.log(`    [NET ERROR] Detected browser neterror page or connection reset on "${currentUrl}". Forcing reload...`);
            lastFailedUrl = ''; // reset flag
            await p.reload().catch(() => {});
            await sleep(4000);
            await handleCookiesLocal(p);
          }

          await handleCaptchaIfPresent(p, label);

          await locator.waitFor({ state: 'visible', timeout: timeoutMs });
          return;
        } catch (err) {
          console.log(`    [WARN] "${label}" wait failed (attempt ${attempt}/${maxRetries}): ${err.message}`);
          if (attempt === maxRetries) throw err;
          console.log(`    Reloading page to retry "${label}"...`);
          await p.reload().catch(() => {});
          await sleep(3000);
        }
      }
    };

    await handleCookiesLocal(authPage);

    const confirmBtn = authPage.locator('button:has-text("Confirm and continue")').first();
    const emailInput = authPage.locator('input[type="email"]').first();
    const allowBtn = authPage.locator('button:has-text("Allow"), button:has-text("Allow access"), button:has-text("Approve")').first();

    console.log('    [AWS Portal] Waiting for page to load login/confirm elements...');
    let activeElement = '';
    for (let i = 0; i < 30; i++) {
      await handleCookiesLocal(authPage);
      if (await confirmBtn.isVisible().catch(() => false)) {
        activeElement = 'confirm';
        break;
      }
      if (await emailInput.isVisible().catch(() => false)) {
        const isEditable = await emailInput.isEditable().catch(() => false);
        if (isEditable) {
          activeElement = 'login';
          break;
        }
      }
      if (await allowBtn.isVisible().catch(() => false)) {
        activeElement = 'allow';
        break;
      }
      await sleep(500);
    }

    console.log(`    [AWS Portal] Detected active state: ${activeElement || 'none'}`);

    if (activeElement === 'confirm') {
      console.log('    [AWS Portal] Click Confirm and continue...');
      await confirmBtn.click();
      await sleep(5000);
      await handleCookiesLocal(authPage);
      
      activeElement = '';
      for (let i = 0; i < 20; i++) {
        if (await allowBtn.isVisible().catch(() => false)) {
          activeElement = 'allow';
          break;
        }
        if (await emailInput.isVisible().catch(() => false)) {
          const isEditable = await emailInput.isEditable().catch(() => false);
          if (isEditable) {
            activeElement = 'login';
            break;
          }
        }
        await sleep(500);
      }
      console.log(`    [AWS Portal] State after confirm: ${activeElement || 'none'}`);
    }

    if (activeElement === 'login' || (!activeElement && await emailInput.isVisible().catch(() => false))) {
      console.log('    [AWS Portal] Filling email...');
      await waitWithRetryAndReload(authPage, emailInput, 'Email field loading');
      await fillHuman(authPage, emailInput, email);
      await sleep(1000);

      const continueBtn = authPage.locator('button:has-text("Continue")').first();
      await continueBtn.click();
      await sleep(4500);

      // Password step
      if (await authPage.locator('input[type="password"]').isVisible().catch(() => false)) {
        console.log('    [AWS Portal] Password field detected, filling password...');
        const pwdInput = authPage.locator('input[type="password"]').first();
        await fillHuman(authPage, pwdInput, password);
        await sleep(1000);

        const signinBtn = authPage.locator('button:has-text("Continue")').filter({ visible: true }).first();
        await signinBtn.click();
        await sleep(6000);
      }

      // OTP step
      const isOtpVisible = await authPage.locator('input[placeholder="6-digit"], input[type="text"]').first().isVisible().catch(() => false);
      if (isOtpVisible) {
        console.log('    [AWS Portal] OTP verification requested, waiting for OTP email...');
        const otpCode = await tempmail.waitForOtp(email, 120000);
        if (!otpCode) {
          throw new Error('OTP not received or failed to extract.');
        }
        console.log(`    [AWS Portal] Retrieved OTP: ${otpCode}`);

        const otpInput = authPage.locator('input[placeholder="6-digit"], input[type="text"]').first();
        await fillHuman(authPage, otpInput, otpCode);
        await sleep(1000);

        const otpSubmitBtn = authPage.locator('button:has-text("Continue")').filter({ visible: true }).first();
        await otpSubmitBtn.click();
        await sleep(8000);
      }

      // If "Confirm and continue" is visible now (post-OTP confirm)
      const confirmBtnPost = authPage.locator('button:has-text("Confirm and continue")').first();
      if (await confirmBtnPost.isVisible().catch(() => false)) {
        console.log('    [AWS Portal] Click Confirm and continue (Post-Login)...');
        await confirmBtnPost.click();
        await sleep(5000);
      }
    }

    // Allow/Approve step
    console.log('    [AWS Portal] Looking for Allow/Approve/Allow access button...');
    await waitWithRetryAndReload(authPage, allowBtn, 'Allow button loading', 25000);
    console.log('    [AWS Portal] Clicking Allow button...');
    await allowBtn.click();
    await sleep(5000);
  } catch (err) {
    const errPath = path.join(__dirname, `scratch/error_authPage_${email.replace(/[@+.]/g, '_')}.png`);
    await authPage.screenshot({ path: errPath }).catch(() => {});
    console.log(`    [AWS Portal] Saved auth page error screenshot to: ${errPath}`);
    throw err;
  }
}

async function importToOmniRoute(context, email, password, tempmail) {
  console.log(`  [Import] Connecting ${email} to OmniRoute...`);
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  
  try {
    console.log(`    [Import] Navigating to OmniRoute login page...`);
    await page.goto(`${CONFIG.omnirouteUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    
    if (page.url().includes('/login')) {
      console.log('    [Import] Filling OmniRoute password...');
      const passwordInput = page.getByRole('textbox', { name: /password|enter your password/i })
        .or(page.locator('input[type="password"]'))
        .first();
      await passwordInput.fill(CONFIG.omniroutePassword);

      const loginButton = page.getByRole('button', { name: /continue|login|sign in|submit/i }).first();
      if (await loginButton.isVisible().catch(() => false)) {
        await loginButton.click();
      } else {
        await passwordInput.press('Enter');
      }

      await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    console.log('    [Import] Navigating to Kiro provider page...');
    await page.goto(`${CONFIG.omnirouteUrl}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(8000);

    const addBtn = page.locator('button:has-text("Add Connection"), button:has-text("Add")').first();
    console.log('    [Import] Clicking Add Connection button...');
    await addBtn.click();
    await page.waitForTimeout(2000);

    const continueWarningBtn = page.locator('button:has-text("I understand, continue")').first();
    if (await continueWarningBtn.isVisible().catch(() => false)) {
      console.log('    [Import] Bypassing warning modal...');
      await continueWarningBtn.click();
      await page.waitForTimeout(2000);
    }

    console.log('    [Import] Selecting AWS Builder ID option...');
    const builderIdOption = page.locator('text="AWS Builder ID"').first();

    // Click and check for popup window (in same browser context)
    let popup = null;
    const popupPromise = context.waitForEvent('page', { timeout: 15000 }).then(p => { popup = p; }).catch(() => null);
    await builderIdOption.click();
    await popupPromise;

    if (popup) {
      console.log('    [Import] Detected popup authentication flow.');
      await performAWSBuilderIdLogin(popup, email, password, tempmail);
      
      console.log('    [Import] Waiting for popup closure...');
      const popupClosed = await popup.waitForEvent('close', { timeout: 30000 }).then(() => true).catch(() => false);
      console.log(`    [Import] Popup closed status: ${popupClosed}`);
    } else {
      console.log('    [Import] No popup detected. Checking for device code verification modal...');
      await page.waitForTimeout(3000);
      
      const modalText = await page.locator('[role="dialog"]').innerText().catch(() => '');
      const urlMatch = modalText.match(/(https:\/\/view\.awsapps\.com\/[^\s\n]+)/);
      
      if (!urlMatch) {
        throw new Error('Neither OAuth popup opened nor device code verification modal was found.');
      }

      const verificationUrl = urlMatch[1];
      console.log(`    [Import] Found device code flow. Verification URL: ${verificationUrl}`);

      // Open verification page in the registration context (context - Browser A)
      console.log('    [Import] Opening verification URL inside the registration browser context...');
      const authPage = await context.newPage();
      try {
        await authPage.goto(verificationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await performAWSBuilderIdLogin(authPage, email, password, tempmail);
        console.log('    [Import] Device authorization login completed.');
      } finally {
        await authPage.close().catch(() => {});
      }

      // Wait for modal on main page to close
      console.log('    [Import] Waiting for verification modal on dashboard to close...');
      const modalClosed = await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 30000 }).then(() => true).catch(() => false);
      console.log(`    [Import] Verification modal closed status: ${modalClosed}`);
    }

    console.log(`    [Import] Successfully linked connection for ${email} in OmniRoute!`);
  } catch (err) {
    console.error(`    [Import] [ERROR] Failed to import connection for ${email}:`, err.message);
    
    // Take diagnostic screenshot of main page
    const errScreenshotPath = path.join(__dirname, `scratch/error_import_${email.replace(/[@+.]/g, '_')}.png`);
    await page.screenshot({ path: errScreenshotPath }).catch(() => {});
    console.log(`    [Import] Saved error screenshot: ${errScreenshotPath}`);

    // Dismiss modal using Escape or Close button to prepare for next run
    const modalCloseBtn = page.locator('[role="dialog"] button:has-text("Close"), [role="dialog"] button').filter({ has: page.locator('svg') }).first();
    if (await modalCloseBtn.isVisible().catch(() => false)) {
      await modalCloseBtn.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape');
    }
    await sleep(2000);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register };
