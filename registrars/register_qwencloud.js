const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const TempMail = require('../services/tempmail/tempmail.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const { sleep, rand, fillHuman, humanMouseMove, humanScroll, handleCookies, gotoWithRetry } = require('../utils/helpers.js');

const CONFIG = {
  baseUrl: 'https://home.qwencloud.com/',
  apiKeysUrl: 'https://home.qwencloud.com/api-keys',
  password: process.env.QWENCLOUD_PASSWORD || process.env.PLATFORM_PASSWORD || 'QwenCloudAuto2026!',
  domain: (process.env.QWENCLOUD_EMAIL_DOMAIN || '').trim() || undefined,
  outputFile: path.join(__dirname, '..', 'data', 'qwencloud.csv'),
  otpTimeout: Number(process.env.QWENCLOUD_OTP_TIMEOUT || 120000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
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

function killExistingChromeCDP() {
  try {
    const { execSync } = require('child_process');
    execSync('fuser -k 9222/tcp', { stdio: 'ignore' });
    console.log('  Terminated existing Chrome process on port 9222.');
  } catch (err) {
    // ignore non-zero exit code when port is already free
  }
}

async function ensureChromeRunning(executablePath = 'google-chrome') {
  try {
    const checkRes = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log('  Google Chrome with Remote Debugging is already running.');
      return true;
    }

    console.log('  Google Chrome Remote Debugging port NOT detected. Spawning Chrome...');

    let chromePath = executablePath;
    const lower = chromePath.toLowerCase();
    if (lower === 'cloakbrowser' || lower === 'cloak') {
      chromePath = '/home/nbs59/.cloakbrowser/chromium-146.0.7680.177.5/chrome';
    } else if (lower === 'camoufox' || lower === 'comufox') {
      chromePath = '/home/nbs59/.cache/camoufox/camoufox';
    }

    const args = [
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/chrome-debug-profile',
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check'
    ];

    console.log(`  Spawning chrome: ${chromePath} ${args.join(' ')}`);

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
      if (res && res.ok) {
        console.log('  Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error('Timeout waiting for Google Chrome remote debugging port to respond.');
  } catch (err) {
    console.log(`  [ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function handleCaptchaIfPresent(page) {
  const captchaSelectors = [
    '#aliyunCaptcha-window-float',
    '.aliyunCaptcha-window-float',
    '[class*="aliyunCaptcha-window"]',
    '.nc_wrapper',
    '#nc_1_wrapper',
    '#baxia-wrapper iframe',
    'iframe[src*="nocaptcha"]',
    'iframe[src*="security"]'
  ];

  let captchaVisible = false;
  for (const sel of captchaSelectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      captchaVisible = true;
      break;
    }
  }

  if (captchaVisible) {
    console.log('  [CAPTCHA] Slider/Baxia challenge detected! Attempting auto-solve...');
    try {
      const { solveAliyunCaptcha } = require('../utils/captcha_solver.js');
      const solved = await solveAliyunCaptcha(page, {
        apiKey: process.env.LLM_API_KEY,
        apiUrl: process.env.LLM_API_URL,
        model: process.env.LLM_MODEL
      });
      if (solved) {
        console.log('  [CAPTCHA] Auto-solve succeeded.');
        await sleep(2000);
        return true;
      }
    } catch (err) {
      console.log(`  [CAPTCHA] Solver error: ${err.message}`);
    }
    console.log('  [CAPTCHA] Auto-solve failed or skipped. Please solve manually in the browser window.');
    
    // Wait up to 30 seconds for manual solve
    const start = Date.now();
    while (Date.now() - start < 30000) {
      let stillVisible = false;
      for (const sel of captchaSelectors) {
        if (await page.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) {
          stillVisible = true;
          break;
        }
      }
      if (!stillVisible) {
        console.log('  [CAPTCHA] Captcha resolved manually.');
        return true;
      }
      await sleep(1000);
    }
    console.log('  [CAPTCHA] Timeout waiting for manual solve.');
    return false;
  }
  return true;
}

async function register() {
  const tempmail = new TempMail();
  const inbox = await tempmail.createInbox(null, CONFIG.domain);
  const email = inbox.address;
  console.log(`Email: ${email}`);

  const executablePathToUse = CONFIG.browserExecutablePath || undefined;
  const isCam = isCamoufox(executablePathToUse);
  const selectedProxy = selectProxy(CONFIG.proxy);
  let browser;
  let context;
  let tempProfileDir = '';
  let connectedCDP = false;

  try {
    if (!isCam) {
      killExistingChromeCDP();
      const chromeExec = executablePathToUse || '/usr/bin/google-chrome-stable';
      await ensureChromeRunning(chromeExec);
      const checkRes = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
      if (checkRes && checkRes.ok) {
        console.log('  Found active Google Chrome Remote Debugging port at http://127.0.0.1:9222! Connecting...');
        browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        const contexts = browser.contexts();
        context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        connectedCDP = true;
      }
    }
  } catch (err) {
    console.log(`  CDP connection error: ${err.message}`);
  }

  // Randomize viewport size slightly to avoid bot fingerprint patterns
  const vpWidth = 1366 + rand(-30, 30);
  const vpHeight = 768 + rand(-20, 20);

  if (!connectedCDP) {
    if (isCam) {
      console.log('  Launching Camoufox (Firefox-based)...');
      const launchOpts = {
        headless: envFlag('HEADLESS'),
        args: ['--no-sandbox'],
      };
      if (selectedProxy) launchOpts.proxy = proxyFromUrl(selectedProxy);
      if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

      browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
      context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta' });
    } else {
      console.log('  Launching Chromium with persistent context and stealth...');
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}`);
      console.log(`  Profile path: ${tempProfileDir}`);

      const contextOpts = {
        headless: envFlag('HEADLESS'),
        executablePath: executablePathToUse,
        viewport: { width: vpWidth, height: vpHeight },
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--incognito',
        ],
      };
      if (selectedProxy) contextOpts.proxy = proxyFromUrl(selectedProxy);

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

  // Inject anti-fingerprint configurations to bypass Qwen/Alibaba security
  await context.addInitScript(() => {
    // 1. Remove webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete navigator.__proto__.webdriver;

    // 2. Fake plugins (realistic count)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
    });

    // 3. Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'id'],
    });

    // 4. Patch chrome runtime
    window.chrome = {
      runtime: {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      },
    };

    // 5. Patch permissions
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);

    // 6. WebGL fingerprint spoofing
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Google Inc. (Intel)';
      if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameter.call(this, param);
    };

    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return 'Google Inc. (Intel)';
      if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return getParameter2.call(this, param);
    };

    // 7. Canvas fingerprint noise
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type) {
      if (type === 'image/png' && this.width > 16 && this.height > 16) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            // Add tiny noise to RGB
            imageData.data[i] += Math.floor(Math.random() * 3) - 1;
            imageData.data[i + 1] += Math.floor(Math.random() * 3) - 1;
            imageData.data[i + 2] += Math.floor(Math.random() * 3) - 1;
          }
          ctx.putImageData(imageData, 0, 0);
        }
      }
      return origToDataURL.apply(this, arguments);
    };

    // 8. Screen properties
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  await page.addInitScript(() => {
    // Track clicks for logging
    document.addEventListener('click', e => {
      const t = e.target;
      const info = { tag: t.tagName, id: t.id, cls: t.className?.toString?.()?.substring(0, 50), x: e.clientX, y: e.clientY };
      console.log('[USER_CLICK]', JSON.stringify(info));
    }, true);
  });

  // Monitor network requests for anti-bot indicators
  page.on('requestfailed', request => {
    console.log(`  [NET-FAIL] ${request.url()} failed: ${request.failure()?.errorText || 'Unknown error'}`);
  });

  page.on('response', response => {
    const status = response.status();
    const url = response.url();
    if (status >= 400) {
      console.log(`  [NET-WARN] ${url} returned HTTP ${status}`);
    }
    if (url.includes('um.js') || url.includes('uab.js') || url.includes('aeis.alicdn.com') || url.includes('nocaptcha') || url.includes('security')) {
      console.log(`  [NET-SEC] Security/Anti-bot script loaded: ${url} (HTTP ${status})`);
    }
  });

  // Monitor browser console for errors/warnings and user clicks
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[USER_CLICK]')) {
      console.log(`  🖱️ ${text}`);
    } else {
      const type = msg.type();
      const textVal = msg.text();
      if (type === 'error' || textVal.toLowerCase().includes('bot') || textVal.toLowerCase().includes('detect') || textVal.toLowerCase().includes('fail') || textVal.toLowerCase().includes('abnormal')) {
        console.log(`  [BROWSER-CONSOLE] [${type}] ${textVal}`);
      }
    }
  });

  try {
    console.log('[1/5] Sign up');
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1500, 3000));
    await handleCookies(page).catch(() => {});
    await sleep(rand(1000, 2000));
    await humanMouseMove(page);

    const signUpBtn = page.locator('a:has-text("Sign Up"), button:has-text("Sign Up"), a:has-text("Register"), a[href*="register"], a:has-text("Get Started"), button:has-text("Get Started")').first();
    await signUpBtn.waitFor({ state: 'visible', timeout: 15000 });
    await signUpBtn.click();
    await sleep(5000);

    // If we landed on a login page, click the Sign Up link at the bottom to switch to register mode
    const loginSignUpLink = page.locator('a:has-text("Sign Up")').first();
    if (await loginSignUpLink.count() > 0 && (page.url().includes('login') || await page.locator('button:has-text("Log in with Google")').count() > 0)) {
      console.log('  Landed on login page. Clicking Sign Up link at the bottom to go to register page...');
      await loginSignUpLink.click();
      await sleep(5000);
    }

    const emailInput = page.locator('input[type="email"], input[placeholder*="Email" i], input[type="text"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, emailInput, email);
    await sleep(rand(1000, 2000));
    await humanMouseMove(page);

    const nextBtn = page.locator('button:has-text("Next"), button[type="submit"]').first();
    await nextBtn.click();
    await sleep(rand(1000, 2000));
    await handleCaptchaIfPresent(page);

    console.log('[2/5] OTP');
    const otp = await waitForQwenOtp(tempmail, email, CONFIG.otpTimeout);
    console.log(`OTP: ${otp}`);
    
    const otpInput = page.locator('input[inputmode="numeric"]').first();
    await otpInput.waitFor({ state: 'visible', timeout: 15000 });
    await otpInput.click();
    await sleep(rand(2000, 4000));

    for (let i = 0; i < otp.length; i++) {
      const digit = otp[i];
      await page.keyboard.press(digit);
      await sleep(rand(350, 750));
      // Simulate a brief pause halfway through typing the code
      if (i === 2 && Math.random() < 0.9) {
        await sleep(rand(1500, 3500));
      }
    }
    await sleep(rand(2500, 4500));
    await humanMouseMove(page);

    const validateBtn = page.locator('button:has-text("Validate"), button:has-text("Continue"), button[type="submit"]').first();
    await validateBtn.click().catch(() => {});
    await sleep(rand(1000, 2000));
    await handleCaptchaIfPresent(page);

    console.log('[3/5] Country');
    await completeCountryStep(page).catch(err => console.log(`Country skipped: ${err.message}`));

    console.log('[3.2/5] Check for error popup on dashboard');
    console.log('  Checking for error popups dynamically...');
    const dashboardDeadline = Date.now() + 15000;
    let dashboardError = false;
    while (Date.now() < dashboardDeadline) {
      if (await checkForErrorPopup(page)) {
        dashboardError = true;
        break;
      }
      await sleep(1000);
    }
    if (dashboardError) {
      console.log('  Error popup or message found on dashboard. Skipping API key generation and CSV logging.');
      return;
    }

    console.log('[3.5/5] Open benefits and check for error popup & setup status');
    await page.goto('https://home.qwencloud.com/benefits', { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('  Checking for error popups and free tier setup status dynamically...');
    
    const benefitsDeadline = Date.now() + 150000; // wait up to 150 seconds
    let benefitsError = false;
    
    while (Date.now() < benefitsDeadline) {
      // 1. Check for error popup
      if (await checkForErrorPopup(page)) {
        benefitsError = true;
        break;
      }
      
      // 2. Check if still setting up the free quota/tier
      const setupIndicator = page.locator('text=/setting up your free quota|almost ready/i').first();
      const loadingIndicator = page.locator('text=/loading/i').first();
      
      const isSetupVisible = await setupIndicator.isVisible().catch(() => false);
      const isLoadingVisible = await loadingIndicator.isVisible().catch(() => false);
      
      if (isSetupVisible || isLoadingVisible) {
        console.log('  Still setting up your free quota / loading benefits... Waiting 10 seconds...');
        await sleep(10000);
        console.log('  Reloading benefits page...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
          console.log(`  Reload failed: ${err.message}`);
        });
      } else {
        console.log('  Benefits / Free quota setup completed successfully.');
        break;
      }
    }
    
    if (benefitsError) {
      console.log('  Error popup or message found on benefits page. Skipping API key generation and CSV logging.');
      return;
    }

    console.log('[3.8/5] Establish SSO and Add Payment Method');
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
      await sleep(3000);
      console.log('  Current URL:', page.url());
      await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_payg_page.png') }).catch(() => {});

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
              await page.screenshot({ path: path.join(__dirname, `scratch/qwencloud_otp_send_clicked_attempt_${clickAttempt}.png`) }).catch(() => {});
              
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
          await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_payg_after_secondary_login.png') }).catch(() => {});
        }
      }

      // Look for the "Sign in now" button
      const signInBtn = page.locator('button:has-text("Sign in now")').first();
      if (await signInBtn.count() > 0) {
        console.log('  Found "Sign in now" button. Clicking to synchronize session...');
        await signInBtn.click();
        await sleep(10000);
        console.log('  URL after clicking "Sign in now":', page.url());
        await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_payg_after_sync.png') }).catch(() => {});

        // Run login handler
        await handleLoginIfRequired();
      } else {
        console.log('  No "Sign in now" button found (already logged in).');
      }

      // Navigate to Qwen Billing Overview with target=payment to establish SSO session
      console.log('  Navigating to Qwen Billing Overview (target=payment) to establish SSO...');
      await page.goto('https://home.qwencloud.com/billing/overview?target=payment', { waitUntil: 'load', timeout: 60000 });
      await sleep(2000);
      const ccOption = page.locator('span, div, label, p').filter({ hasText: /^Credit & Debit Cards$/ }).first();
      await ccOption.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      console.log('  Current URL after Billing Overview navigation:', page.url());
      await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_billing_overview_sso.png') }).catch(() => {});

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
      ccOption = page.locator('span, div, label, p').filter({ hasText: /^Credit & Debit Cards$/ }).first();
      await ccOption.click({ force: true });
      await sleep(2000);
      await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_billing_modal_expanded.png') }).catch(() => {});

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
        await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_billing_modal_card_step.png') }).catch(() => {});
      }

      const expandedHtml = await page.content().catch(() => '');
      fs.writeFileSync(path.join(__dirname, 'scratch/qwencloud_billing_modal_expanded.html'), expandedHtml);

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
        const addressLine1Input = page.locator('input[placeholder*="address line 1" i], input[placeholder*="Address Line 1" i], input[placeholder*="Address line 1" i]').first();
        await addressLine1Input.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_payment_submitted.png') }).catch(() => {});
        incrementVccCount(activeVcc.card);

        // Fill Billing Address Form
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
          await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_billing_address_filled.png') }).catch(() => {});
          
          // Click final Save button
          console.log('  Clicking final Save button...');
          const saveAddressBtn = page.locator('[role="dialog"] button:has-text("Save"), button:has-text("Save")').filter({ visible: true }).first();
          if (await saveAddressBtn.count() > 0) {
            await saveAddressBtn.click({ force: true });
            console.log('  Clicked final Save button.');
            await sleep(5000);
            await page.screenshot({ path: path.join(__dirname, 'scratch/qwencloud_billing_address_submitted.png') }).catch(() => {});
          }
        }
      }
    }

    console.log('[4/5] API key');
    await page.goto(CONFIG.apiKeysUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(2000, 4000));
    await humanMouseMove(page);

    const createBtn = page.locator('button:has-text("Create API key"), button:has-text("+ Create API key")').first();
    await createBtn.waitFor({ state: 'visible', timeout: 15000 });
    await createBtn.click();
    await sleep(rand(1000, 2000));

    const nameInput = page.locator('input[placeholder*="Production API key"], input[placeholder*="e.g."]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await fillHuman(page, nameInput, 'auto-key');
      await sleep(rand(800, 1500));
    }
    
    const genBtn = page.locator('button:has-text("Generate Key"), button:has-text("Confirm")').first();
    await genBtn.waitFor({ state: 'visible', timeout: 15000 });
    await humanMouseMove(page);
    await genBtn.click();

    console.log('  Waiting for generated key to appear...');
    let apiKey = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      apiKey = await extractApiKey(page);
      if (apiKey) break;
      if (await genBtn.isVisible().catch(() => false)) {
        await genBtn.click().catch(() => {});
      }
      await sleep(1000);
    }
    if (!apiKey) throw new Error('API key not found');

    console.log('[5/5] Save');
    appendCsv(CONFIG.outputFile, ['timestamp', 'email', 'password', 'api_key'], [new Date().toISOString(), email, CONFIG.password, apiKey]);
    console.log(`Saved: ${CONFIG.outputFile}`);
    console.log(`API Key: ${apiKey}`);
  } catch (err) {
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    await page.screenshot({ path: path.join(__dirname, 'qwencloud_error.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    if (typeof browser !== 'undefined' && browser) {
      await browser.close().catch(() => {});
    } else if (typeof context !== 'undefined' && context) {
      await context.close().catch(() => {});
    }
    if (!isCam) {
      killExistingChromeCDP();
    }
  }
}

async function waitForQwenOtp(tempmail, email, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await tempmail.getMessages(email);
    for (const msg of messages || []) {
      const text = TempMail.cleanHtml(`${msg.subject || ''}\n${msg.text_body || msg.html_body || ''}`);
      const match = text.match(/verification code for Qwen Cloud is:[\s\S]*?(\d{6})/i) || text.match(/verification code[\s\S]*?(\d{6})/i);
      if (match) return match[1];
    }
    await sleep(3000);
  }
  throw new Error('OTP not received');
}

async function completeCountryStep(page) {
  console.log('  Waiting for Country Selection page...');
  
  // Try to click agreement checkbox first if visible (target the input directly, not the label, to avoid clicking links)
  const checkbox = page.locator('input.maas-terms-text__checkbox, input[type="checkbox"]').first();
  if (await checkbox.isVisible().catch(() => false)) {
    console.log('  Checking agreement checkbox first...');
    await checkbox.check({ force: true }).catch(async () => {
      await checkbox.click({ force: true }).catch(() => {});
    });
    await sleep(rand(800, 1500));
  }

  const trigger = page.locator('[role="combobox"], [class*="select-trigger"], input[placeholder*="country" i], input[placeholder*="region" i]').first();
  await trigger.waitFor({ state: 'visible', timeout: 15000 });
  await sleep(rand(1000, 2000));
  await humanMouseMove(page);
  
  console.log('  Clicking dropdown trigger...');
  await trigger.click();
  await sleep(rand(1200, 2000));

  console.log('  Selecting Indonesia...');
  const idOption = page.locator('[role="option"]').filter({ hasText: 'Indonesia' })
    .or(page.locator('[class*="option"]').filter({ hasText: 'Indonesia' }))
    .or(page.locator('text=Indonesia'))
    .first();
  await idOption.waitFor({ state: 'visible', timeout: 10000 });
  await idOption.click();
  await sleep(rand(800, 1500));

  // Double check checkbox
  if (await checkbox.isVisible().catch(() => false)) {
    const isChecked = await checkbox.isChecked().catch(() => false);
    if (!isChecked) {
      console.log('  Ensuring agreement checkbox is checked...');
      await checkbox.check({ force: true }).catch(async () => {
        await checkbox.click({ force: true }).catch(() => {});
      });
      await sleep(rand(800, 1500));
    }
  }

  await handleCaptchaIfPresent(page);

  console.log('  Clicking Continue...');
  const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"], button:has-text("Next")').first();
  await continueBtn.waitFor({ state: 'visible', timeout: 10000 });

  // Wait dynamically for continue button to be enabled (no disabled attribute)
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const disabled = await continueBtn.getAttribute('disabled');
    if (disabled === null) break;
    await sleep(200);
  }
  await sleep(rand(500, 1000));
  await humanMouseMove(page);
  await continueBtn.click();
  await sleep(rand(1000, 2000));
  await handleCaptchaIfPresent(page);
  
  console.log('  Waiting for dashboard to load after registration...');
  await page.waitForURL(url => {
    return url.href.includes('home.qwencloud.com') && !url.href.includes('register') && !url.href.includes('login') && !url.href.includes('auth');
  }, { timeout: 30000 }).catch(() => {});
  
  await page.locator('a[href="/api-keys"], :has-text("API Keys"), [class*="sidebar"]').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
}

async function extractApiKey(page) {
  const text = await page.innerText('body').catch(() => '');
  const match = text.match(/sk-[a-zA-Z0-9_.-]{30,}/);
  if (match) return match[0];
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('input, textarea, code, pre, span, div')) {
      const value = 'value' in el ? el.value : el.textContent;
      const match = String(value || '').match(/sk-[a-zA-Z0-9_.-]{30,}/);
      if (match) return match[0];
    }
    return '';
  });
}

function appendCsv(file, headers, row) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${headers.join(',')}\n`);
  fs.appendFileSync(file, `${row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')}\n`);
}

async function checkForErrorPopup(page) {
  console.log('  Checking for any error popups on screen...');
  
  const popupLocators = [
    page.locator('[role="alert"]'),
    page.locator('[role="alertdialog"]'),
    page.locator('[role="status"]'),
    page.locator('.ant-notification'),
    page.locator('.ant-message'),
    page.locator('div[class*="toast" i]'),
    page.locator('div[class*="popup" i]'),
    page.locator('div[class*="notification" i]'),
    page.locator('div[class*="alert" i]'),
    page.locator('div[class*="message" i]'),
    page.locator('div[class*="modal" i]'),
    page.locator('div[class*="dialog" i]')
  ];

  const classErrorLocators = [
    page.locator('div[class*="error" i]'),
    page.locator('div[class*="fail" i]'),
    page.locator('div[class*="danger" i]'),
    page.locator('div[class*="warning" i]')
  ];

  const allLocators = [...popupLocators, ...classErrorLocators];

  const errorWords = [
    'error', 'fail', 'abnormal', 'risk', 'limit', 'restrict', 
    'suspend', 'block', 'invalid', 'bridge', 'warning', 'gagal',
    'system error', 'unauthorized', 'deny', 'denied'
  ];

  for (const locator of allLocators) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        if (await el.isVisible()) {
          const text = (await el.innerText().catch(() => '')).toLowerCase();
          if (text) {
            console.log(`  Found visible popup element text: "${text.replace(/\n/g, ' ')}"`);
            for (const word of errorWords) {
              if (text.includes(word)) {
                console.log(`  ==> Detected error popup! Found keyword: "${word}"`);
                await page.screenshot({ path: path.join(__dirname, 'qwencloud_error_popup_detected.png') }).catch(() => {});
                return true;
              }
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }

  // 2. Global locator-based text check (crosses shadow DOM boundaries)
  const riskPhrases = [
    'abnormal registration',
    'abnormal activity',
    'risk control',
    'bridge initialization',
    'system error',
    'restricted access',
    'restricted',
    'account has been suspended',
    'suspended',
    'registration limit',
    'rate limit'
  ];

  for (const phrase of riskPhrases) {
    try {
      const loc = page.locator(`text=/${phrase}/i`).first();
      if (await loc.isVisible().catch(() => false)) {
        const text = (await loc.innerText().catch(() => '')).trim();
        console.log(`  ==> Detected error element via text selector: "${text.replace(/\n/g, ' ')}" (phrase: "${phrase}")`);
        await page.screenshot({ path: path.join(__dirname, 'qwencloud_error_popup_detected.png') }).catch(() => {});
        return true;
      }
    } catch (e) {
      // Ignore errors
    }
  }

  // 3. Fallback standard body check
  const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
  for (const phrase of riskPhrases) {
    if (bodyText.includes(phrase)) {
      console.log(`  ==> Detected error phrase in body: "${phrase}"`);
      await page.screenshot({ path: path.join(__dirname, 'qwencloud_error_phrase_detected.png') }).catch(() => {});
      return true;
    }
  }

  console.log('  No error popups detected.');
  return false;
}

if (require.main === module) register().catch(err => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
});

module.exports = { register, CONFIG, checkForErrorPopup };
