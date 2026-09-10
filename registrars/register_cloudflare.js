const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium, firefox } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealthPlugin);

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const TempMail = require('../services/tempmail/tempmail.js');
const {
  browserTypeFor,
  isCamoufox,
  isAntiDetectBrowser,
  resolveBrowserExecutablePath,
  proxyFromUrl,
  selectProxy,
  handleProxyFailure,
  setupNetworkOptimization,
} = require('../utils/browser.js');
const { maskProxy } = require('../utils/proxy.js');

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

async function fillHuman(page, locator, text) {
  await locator.click({ force: true }).catch(() => {});
  await sleep(rand(80, 150));
  await locator.fill(text);
  await locator.dispatchEvent('input').catch(() => {});
  await locator.dispatchEvent('change').catch(() => {});
  await sleep(rand(80, 150));
}

const CONFIG = {
  emailDomains: (process.env.TEMPMAIL_WEBHOOK_DOMAIN || 'dellakuyang.com,dellakuyang.my').split(',').map(d => d.trim()).filter(Boolean),
  password: process.env.PASSWORD || 'Kucinghitam99#',
  baseUrl: process.env.BASE_URL || 'https://dash.cloudflare.com/',
  keysFile: path.join(__dirname, '..', 'data', 'cloudflare.csv'),
  proxy: process.env.PROXY || null,
  browserExecutable: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function randomString(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function decodeQuotedPrintable(str) {
  if (!str) return '';
  let decoded = str.replace(/=\r?\n/g, '');
  decoded = decoded.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return decoded;
}

function generateGmailWithTricks() {
  const gmailUsers = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);
  if (gmailUsers.length === 0) {
    const d = CONFIG.emailDomains;
    return `user_${randomString(8)}@${d[Math.floor(Math.random() * d.length)]}`;
  }

  // Pick a random Gmail address from GMAIL_USER
  const baseEmail = gmailUsers[Math.floor(Math.random() * gmailUsers.length)];
  const atIdx = baseEmail.indexOf('@');
  if (atIdx === -1) return baseEmail;

  const rawUser = baseEmail.slice(0, atIdx);
  const domain = baseEmail.slice(atIdx + 1);

  // Clean username of any existing dots or plus tags
  const cleanUser = rawUser.replace(/\./g, '').split('+')[0];

  // Natural Dot trick: place 1 single dot inside the alphabetical prefix only
  const match = cleanUser.match(/^([a-zA-Z]+)(.*)$/);
  let dotted = cleanUser;
  if (match) {
    const letters = match[1];
    const rest = match[2];
    if (letters.length >= 4) {
      const splitIdx = Math.floor(letters.length / 2);
      dotted = letters.slice(0, splitIdx) + '.' + letters.slice(splitIdx) + rest;
    }
  }

  // Plus trick: clean tag
  const plusSuffix = `+cf_${randomString(4)}_${Date.now().toString().slice(-4)}`;
  return `${dotted}${plusSuffix}@${domain}`;
}

function generateEmail() {
  const provider = (process.env.TEMPMAIL_PROVIDER || 'webhook').toLowerCase();
  if (provider === 'gmail' && process.env.GMAIL_USER) {
    return generateGmailWithTricks();
  }
  const d = CONFIG.emailDomains;
  return `user_${randomString(8)}@${d[Math.floor(Math.random() * d.length)]}`;
}

function parseProxy(p) {
  if (!p) return null;
  const u = new URL(p);
  return { server: `${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

// Monitor and solve Turnstile challenge (both inline widget and full-page challenge)
async function monitorTurnstile(page, timeoutMs = 60000, required = false) {
  log(`[INFO] Turnstile challenge monitor started (required=${required})...`);
  try {
    const startTime = Date.now();
    let clickCount = 0;
    let lastClickTime = 0;

    // If required, wait up to 15s for the frame or challenge stage to appear
    if (required) {
      log('Waiting for Turnstile frame to appear...');
      for (let i = 0; i < 15; i++) {
        if (page.isClosed()) return false;
        const frames = page.frames();
        const f = frames.find(frame => (frame.url() || '').includes('challenges.cloudflare.com') || (frame.url() || '').includes('turnstile'));
        if (f) break;
        await sleep(1000);
      }
    }

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return false;

      // 1. Check if token is populated in form
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
            if (el.value && el.value.length > 20) {
              return el.value;
            }
          }
        }
        return null;
      }).catch(() => null);

      if (tokenValue) {
        log(`✅ Turnstile Token resolved: ${tokenValue.substring(0, 18)}...`);
        return true;
      }

      // 2. Check full-page challenge state
      const pageState = await page.evaluate(() => {
        const title = document.title || '';
        const bodyText = document.body ? document.body.innerText || '' : '';
        const isChallengeTitle = title.includes('Just a moment') || title.includes('Attention Required') || title.includes('Cloudflare');
        const hasChallengeStage = !!document.getElementById('challenge-stage') ||
                                  !!document.getElementById('challenge-form') ||
                                  !!document.getElementById('challenge-running') ||
                                  !!document.querySelector('.cf-turnstile-wrapper') ||
                                  !!document.querySelector('[id^="cf-chl-widget"]') ||
                                  !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        const isChallengePage = isChallengeTitle || hasChallengeStage ||
                                bodyText.includes('Performing security verification') ||
                                bodyText.includes('Verify you are human') ||
                                bodyText.includes('Verifying you are human') ||
                                bodyText.includes('checking your browser');
        return { isChallengePage, hasChallengeStage, isChallengeTitle };
      }).catch(() => ({ isChallengePage: false, hasChallengeStage: false, isChallengeTitle: false }));

      // Find active turnstile frame
      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => {
        const u = f.url() || '';
        return u.includes('challenges.cloudflare.com') || u.includes('turnstile');
      });

      // If NOT required, and no challenge page / stage / frame exists after settling delay, return true
      if (!required && !pageState.isChallengePage && !pageState.hasChallengeStage && !activeFrame && (Date.now() - startTime > 1500)) {
        return true;
      }

      const now = Date.now();
      if (now - lastClickTime > 6000) {
        // Strategy A: Click inside active turnstile frame
        if (activeFrame) {
          try {
            const frameElement = await activeFrame.frameElement().catch(() => null);
            if (frameElement) {
              await frameElement.scrollIntoViewIfNeeded().catch(() => {});
              await sleep(300);
              const box = await frameElement.boundingBox().catch(() => null);
              if (box && box.width > 0 && box.height > 0) {
                const clickX = box.x + Math.min(30, box.width / 2);
                const clickY = box.y + Math.min(35, box.height / 2);
                clickCount++;
                log(`[Click #${clickCount}] Clicking Turnstile frame checkbox at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                await page.mouse.click(clickX, clickY).catch(() => {});
                lastClickTime = now;
              }
            }
          } catch (frameErr) {
            // ignore
          }

          // Direct locator attempt
          try {
            const cb = activeFrame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, .mark').first();
            if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
              await cb.click().catch(() => {});
              lastClickTime = now;
            }
          } catch (_) {}
        }

        // Strategy B: Click #challenge-stage on main page if full-page challenge
        if (pageState.hasChallengeStage || pageState.isChallengePage) {
          try {
            const stage = page.locator('#challenge-stage, .cf-turnstile-wrapper, #turnstile-wrapper').first();
            if (await stage.isVisible({ timeout: 1000 }).catch(() => false)) {
              const box = await stage.boundingBox().catch(() => null);
              if (box && box.width > 0 && box.height > 0) {
                const clickX = box.x + Math.min(35, box.width / 2);
                const clickY = box.y + Math.min(35, box.height / 2);
                clickCount++;
                log(`[Click #${clickCount}] Clicking challenge stage at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                await page.mouse.click(clickX, clickY).catch(() => {});
                lastClickTime = now;
              }
            }
          } catch (_) {}
        }
      }

      await sleep(1500);
    }
  } catch (err) {
    log(`[ERROR] monitorTurnstile error: ${err.message}`);
  }
  return false;
}

async function ensureChromeRunning(executablePath = '/usr/bin/google-chrome-stable', port = 9222, proxy = null) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      log(`Google Chrome with Remote Debugging is already running on port ${port}.`);
      return true;
    }

    log(`Spawning Google Chrome Stable Incognito on port ${port}...`);

    const tempProfileDir = `/tmp/chrome-debug-profile-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--start-maximized',
    ];

    if (proxy && proxy.server) {
      args.push(`--proxy-server=${proxy.server}`);
    }

    const chromeProcess = spawn(executablePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (res && res.ok) {
        log('Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Google Chrome remote debugging port ${port} to respond.`);
  } catch (err) {
    log(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function resolveAccountId(page) {
  let match = page.url().match(/dash\.cloudflare\.com\/([a-f0-9]{32})/);
  if (match) return match[1];

  let accountId = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const m = href.match(/^\/([a-f0-9]{32})/);
      if (m) return m[1];
    }
    return '';
  }).catch(() => '');
  if (accountId) return accountId;

  log('Navigating to dash.cloudflare.com to resolve Account ID...');
  await page.goto('https://dash.cloudflare.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    match = page.url().match(/dash\.cloudflare\.com\/([a-f0-9]{32})/);
    if (match) return match[1];

    accountId = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/^\/([a-f0-9]{32})/);
        if (m) return m[1];
      }
      return '';
    }).catch(() => '');
    if (accountId) return accountId;

    await sleep(1000);
  }
  return '';
}

function loadProxyList() {
  if (process.env.DISABLE_PROXY === 'true') return [];
  if (process.env.PROXY) {
    return process.env.PROXY.split(',').map(p => p.trim()).filter(Boolean);
  }
  const proxyFilePath = path.join(__dirname, '..', 'http_proxies.txt');
  if (fs.existsSync(proxyFilePath)) {
    const lines = fs.readFileSync(proxyFilePath, 'utf8').split('\n');
    return lines
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.includes(':'));
  }
  return [];
}

async function main() {
  const email = generateEmail();
  const tempmail = new TempMail();
  log(`Generated Email: ${email}`);

  const rawProxy = selectProxy(CONFIG.proxy);
  const pc = rawProxy ? (proxyFromUrl(rawProxy) || parseProxy(rawProxy)) : null;
  const executablePathToUse = '/usr/bin/google-chrome-stable';

  log(`Using Browser Engine: Google Chrome Stable (Incognito Mode CDP)`);
  if (pc) {
    log(`Using Proxy: ${pc.server}`);
  }

  let browser;
  let context;
  let dynamicPortUsed = null;

  try {
    const dynamicPort = Math.floor(19000 + Math.random() * 6000);
    dynamicPortUsed = dynamicPort;
    await ensureChromeRunning(executablePathToUse, dynamicPort, pc);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  } catch (err) {
    log(`CDP connection failed: ${err.message}. Falling back to standard launch...`);
    const launchOpts = {
      headless: process.env.HEADLESS === 'true',
      executablePath: executablePathToUse,
      args: [
        '--incognito',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    };
    if (pc) {
      launchOpts.proxy = { server: pc.server, username: pc.username, password: pc.password };
    }
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
    });
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await setupNetworkOptimization(page);

  if (pc && pc.username && pc.password) {
    await context.setHTTPCredentials({ username: pc.username, password: pc.password }).catch(() => {});
  }

  // Permanently disable OneTrust overlay, filter, and auto-click Accept All Cookies
  await page.addInitScript(() => {
    const injectStyle = () => {
      if (document.getElementById('anti-onetrust-style')) return;
      const s = document.createElement('style');
      s.id = 'anti-onetrust-style';
      s.innerHTML = `
        #onetrust-consent-sdk,
        .onetrust-pc-dark-filter,
        #onetrust-banner-sdk,
        .ot-fade-in,
        #onetrust-group-container {
          display: none !important;
          pointer-events: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
        }
      `;
      (document.head || document.documentElement).appendChild(s);
    };
    injectStyle();
    window.addEventListener('DOMContentLoaded', injectStyle);

    // Auto-click accept button as soon as OneTrust DOM renders
    try {
      const observer = new MutationObserver(() => {
        const acceptBtn = document.getElementById('onetrust-accept-btn-handler');
        if (acceptBtn) {
          try { acceptBtn.click(); } catch (_) {}
        }
        const filter = document.querySelector('.onetrust-pc-dark-filter');
        if (filter) filter.remove();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }).catch(() => {});

  const dismissCookieBanner = async () => {
    try {
      const selectors = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept All Cookies")',
        'button:has-text("Accept all cookies")',
        'button:has-text("Accept All")',
        'button:has-text("Accept")',
        '#onetrust-reject-all-handler',
        '.onetrust-close-btn-handler'
      ];
      for (const sel of selectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
          await btn.click({ force: true }).catch(() => {});
          log('Dismissed / Accepted cookie consent banner.');
          await sleep(500);
          break;
        }
      }
    } catch (_) {}
    await page.evaluate(() => {
      document.querySelectorAll('#onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter, .ot-fade-in, [id*="onetrust"]').forEach(el => el.remove());
    }).catch(() => {});
  };

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.startsWith('[USER_CLICK]')) log(`🖱️ ${txt}`);
  });

  page.on('framenavigated', frame => {
    if (frame.url().includes('challenges.cloudflare.com') || frame.url().includes('turnstile')) {
      log(`🔍 Turnstile frame navigated: ${frame.url().substring(0, 80)}...`);
    }
  });

  try {
    let registeredSuccessfully = false;
    const maxSignUpAttempts = 4;

    for (let attempt = 1; attempt <= maxSignUpAttempts; attempt++) {
      log(`[Attempt ${attempt}/${maxSignUpAttempts}] Navigating/Preparing Cloudflare sign-up page...`);
      if (attempt === 1) {
        // Retry with different proxy on failure
        let gotoOk = false;
        for (let proxyRetry = 1; proxyRetry <= 5; proxyRetry++) {
          try {
            await page.goto('https://dash.cloudflare.com/sign-up', { waitUntil: 'domcontentloaded', timeout: 35000 });
            gotoOk = true;
            break;
          } catch (gotoErr) {
            log(`[GOTO ERROR] Attempt ${proxyRetry}/5: ${gotoErr.message}`);
            if (rawProxy) handleProxyFailure(rawProxy, gotoErr);
            // Pick new proxy and restart browser
            rawProxy = selectProxy(null);
            if (rawProxy) {
              const pc = proxyFromUrl(rawProxy);
              log(`Retrying with new proxy: ${maskProxy(rawProxy)}`);
              try { await context.close(); } catch (_) {}
              const newPort = Math.floor(19000 + Math.random() * 6000);
              await ensureChromeRunning(executablePathToUse, newPort, pc);
              browser = await chromium.connectOverCDP(`http://127.0.0.1:${newPort}`);
              const contexts = browser.contexts();
              context = contexts.length > 0 ? contexts[0] : await browser.newContext();
              const pages = context.pages();
              page = pages.length > 0 ? pages[0] : await context.newPage();
              if (pc && pc.username && pc.password) {
                await context.setHTTPCredentials({ username: pc.username, password: pc.password }).catch(() => {});
              }
              dynamicPortUsed = newPort;
            } else {
              log('No more proxies available, retrying without proxy...');
              await page.goto('https://dash.cloudflare.com/sign-up', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
              break;
            }
          }
        }
        if (!gotoOk) {
          log('All proxy retries exhausted. Skipping this attempt...');
          break;
        }
      } else {
        log('Reloading sign-up page to get a fresh Turnstile captcha...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 });
      }
      await monitorTurnstile(page, 15000, false);
      await sleep(rand(2000, 3000));
      log(`Loaded URL: ${page.url()}`);

      // Dismiss OneTrust cookie banner if present
      await dismissCookieBanner();

      // STEP 1: Fill Email First
      log('Filling Email field...');
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      await emailInput.waitFor({ timeout: 20000 });
      await fillHuman(page, emailInput, email);
      log(`Email entered: ${email}`);
      await sleep(rand(800, 1200));

      // STEP 2: Fill Password
      log('Filling Password field...');
      const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
      await passwordInput.waitFor({ timeout: 10000 });
      await fillHuman(page, passwordInput, CONFIG.password);
      log('Password entered.');
      await sleep(rand(1000, 1500));

      // STEP 3: Click outside to settle form state and trigger validation
      await page.mouse.click(100, 100).catch(() => {});
      await sleep(rand(1000, 1500));

      // Check if Turnstile frame or element appears within 8s
      log('Checking if Turnstile widget is present on form...');
      let hasTurnstile = false;
      for (let i = 0; i < 8; i++) {
        const frames = page.frames();
        const tf = frames.find(f => (f.url() || '').includes('challenges.cloudflare.com') || (f.url() || '').includes('turnstile'));
        const tokenInput = await page.$('input[name*="turnstile"], textarea[name*="turnstile"], [id*="turnstile"]');
        if (tf || tokenInput) {
          hasTurnstile = true;
          break;
        }
        await sleep(1000);
      }

      if (!hasTurnstile) {
        log('⚠️ Turnstile widget did NOT appear on sign-up page. Will reload page...');
        continue;
      }

      // STEP 4: Monitor and solve Turnstile Captcha
      await dismissCookieBanner();
      log('⏳ Checking & solving Turnstile challenge...');
      const turnstileSolved = await monitorTurnstile(page, 45000, true);
      if (turnstileSolved) {
        log('✅ Turnstile verification confirmed.');
      } else {
        log('⚠️ Turnstile token not detected within timeout. Reloading page...');
        continue;
      }

      await sleep(rand(1500, 2500));

      // STEP 5: Click Submit
      await dismissCookieBanner();
      log('Clicking Sign Up button...');
      const submitBtn = page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("Sign Up")').first();
      await submitBtn.waitFor({ timeout: 10000 });
      await submitBtn.click();
      log('Submit button clicked.');

      // Wait for submission response via dynamic check instead of blind 10s sleep
      log('Waiting for sign up confirmation...');
      const submitStart = Date.now();
      let url = page.url();
      while (Date.now() - submitStart < 12000) {
        url = page.url();
        if (!url.includes('signup') && !url.includes('sign-up') && !url.includes('sign_up')) {
          break;
        }
        const pageErrorText = await page.evaluate(() => {
          const errorEls = Array.from(document.querySelectorAll('[role="alert"], .text-danger, .error, [class*="error"], [class*="alert"]'));
          return errorEls.map(e => (e.textContent || '').trim()).filter(Boolean).join(' | ');
        }).catch(() => '');
        if (pageErrorText) break;
        await sleep(500);
      }
      log(`Result URL after submit: ${url}`);
      await page.screenshot({ path: path.join(__dirname, 'result.png'), fullPage: true }).catch(() => {});

      // Check for inline error messages on the page
      const pageErrorText = await page.evaluate(() => {
        const errorEls = Array.from(document.querySelectorAll('[role="alert"], .text-danger, .error, [class*="error"], [class*="alert"]'));
        return errorEls.map(e => (e.textContent || '').trim()).filter(Boolean).join(' | ');
      }).catch(() => '');

      if (pageErrorText) {
        log(`⚠️ Page notice / error: ${pageErrorText}`);
      }

      if (pageErrorText.toLowerCase().includes('captcha') || pageErrorText.toLowerCase().includes('risk check')) {
        log('⚠️ Submission rejected due to captcha / risk check error. Reloading sign-up page...');
        continue;
      }

      if ((url.includes('signup') || url.includes('sign-up') || url.includes('sign_up')) && !url.includes('verify')) {
        log('Still on signup page after submit. Retrying attempt...');
        continue;
      }

      registeredSuccessfully = true;
      break;
    }

    if (!registeredSuccessfully) {
      throw new Error('Registration failed after maximum sign-up attempts. Turnstile was blocked or not accepted.');
    }

    log('🎉 Registration successful, proceeding to email verification!');

      // 1. Wait for email verification link
      log(`Waiting for Cloudflare verification email on ${email}...`);
      const msg = await tempmail.waitForEmail(email, 180000);
      if (!msg) {
        throw new Error('Verification email not received in time.');
      }

      const rawBody = msg.text_body || msg.html_body || '';
      let verificationLink = '';
      const htmlMatch = rawBody.match(/href=["'](https:\/\/dash\.cloudflare\.com\/email-verification[^"']+)["']/i);
      if (htmlMatch) {
        verificationLink = htmlMatch[1].trim();
      } else {
        const textMatch = rawBody.match(/https:\/\/dash\.cloudflare\.com\/email-verification[^\s<>"'\)\}\]]+/);
        if (textMatch) {
          verificationLink = textMatch[0].trim();
        }
      }
      if (!verificationLink) {
        throw new Error('Failed to find verification link in email body.');
      }
      verificationLink = verificationLink.replace(/&amp;/g, '&');
      log(`Found verification link: ${verificationLink}`);

      // 2. Navigate to verification link
      log('Verifying email address...');
      await page.goto(verificationLink, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(1000);

      // Handle Full-Page Turnstile / Challenge on verification page
      log('Checking Turnstile challenge on email verification page...');
      await monitorTurnstile(page, 25000, false);

      // Click verification button if page asks for confirmation
      try {
        const confirmBtn = page.locator('button:has-text("Verify"), button:has-text("Continue"), a:has-text("Continue"), button:has-text("Confirm"), a:has-text("Log in"), button:has-text("Log in")').first();
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          log('Clicking confirmation button on email verification page...');
          await confirmBtn.click().catch(() => {});
          await sleep(1500);
        }
      } catch (_) {}

      log('Email verification page processed.');

      let accountId = '';
      try {
        accountId = await resolveAccountId(page);
        log(`Resolved Account ID early: ${accountId || 'none'}`);
      } catch (err) {
        log(`[WARN] Error in early Account ID resolution: ${err.message}`);
      }

      // 3. Go to API Tokens page
      log('Navigating to API Tokens page...');
      await page.goto('https://dash.cloudflare.com/profile/api-tokens', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await monitorTurnstile(page, 20000, false);

      // 4. Click Create Token
      log('Clicking Create Token...');
      const createTokenBtn = page.locator('a:has-text("Create Token"), button:has-text("Create Token")').first();
      await createTokenBtn.waitFor({ state: 'visible', timeout: 15000 });
      await createTokenBtn.click();

      // 5. Use template Workers AI
      log('Selecting Workers AI template...');
      const templateRow = page.locator('tr, [role="row"]').filter({ hasText: 'Workers AI' }).first();
      const useTemplateBtn = templateRow.locator('button, a').filter({ hasText: 'Use template' }).first();
      await useTemplateBtn.waitFor({ state: 'visible', timeout: 15000 });
      await useTemplateBtn.click();

      // 6. Select "All accounts" under Account Resources
      log('Selecting "All accounts" under Account Resources...');
      const section = page.locator('div, section, tr, fieldset').filter({ hasText: 'Account Resources' }).first();
      const dropdownContainer = section.locator('.react-select-container').filter({ hasText: 'Select...' }).first();
      const dropdownControl = dropdownContainer.locator('.react-select__control, .react-select__placeholder').first();
      await dropdownControl.waitFor({ state: 'visible', timeout: 15000 });
      await dropdownControl.click();

      const allAccountsOption = page.locator('[id*="-option-0"], div').filter({ hasText: /^All accounts$/ }).first();
      await allAccountsOption.waitFor({ state: 'visible', timeout: 15000 });
      await allAccountsOption.click();
      await sleep(300);

      // 7. Click Continue to summary
      log('Clicking Continue to summary...');
      const continueBtn = page.locator('button:has-text("Continue to summary"), button:has-text("Continue")').first();
      await continueBtn.waitFor({ state: 'visible', timeout: 15000 });
      await continueBtn.click();

      // 8. Click Create Token (confirm) with fast unverified retry logic
      log('Clicking final Create Token button...');
      let apiKey = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const finalCreateBtn = page.locator('button:has-text("Create Token")').first();
        await finalCreateBtn.waitFor({ state: 'visible', timeout: 15000 });
        await finalCreateBtn.click();

        // Fast poll for token or error toast
        const tokenPollStart = Date.now();
        let hasUnverifiedError = false;
        while (Date.now() - tokenPollStart < 8000) {
          apiKey = await page.evaluate(() => {
            for (const el of document.querySelectorAll('input, textarea, code, pre, div, span')) {
              const val = ('value' in el ? el.value : el.textContent || '').trim();
              if (/^cfut_[a-zA-Z0-9_-]{30,70}$/.test(val)) return val;
            }
            return '';
          });
          if (apiKey) break;

          hasUnverifiedError = await page.evaluate(() => {
            const bodyText = document.body ? document.body.innerText || '' : '';
            return bodyText.toLowerCase().includes('please verify your email') || bodyText.toLowerCase().includes('verify your email');
          }).catch(() => false);

          if (hasUnverifiedError) break;
          await sleep(400);
        }

        if (apiKey) {
          log(`✅ API Token successfully generated: ${apiKey}`);
          break;
        }

        if (hasUnverifiedError && attempt < 3) {
          log(`⚠️ Attempt ${attempt}: Cloudflare says "Please verify your email". Waiting 2s and re-verifying link...`);
          try {
            await page.goto(verificationLink, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await monitorTurnstile(page, 15000, false);
            await sleep(1000);
            await page.goto('https://dash.cloudflare.com/profile/api-tokens', { waitUntil: 'domcontentloaded', timeout: 25000 });
            await monitorTurnstile(page, 15000, false);

            // Re-select template
            const createTokenBtn2 = page.locator('a:has-text("Create Token"), button:has-text("Create Token")').first();
            if (await createTokenBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
              await createTokenBtn2.click();
              const templateRow2 = page.locator('tr, [role="row"]').filter({ hasText: 'Workers AI' }).first();
              const useTemplateBtn2 = templateRow2.locator('button, a').filter({ hasText: 'Use template' }).first();
              await useTemplateBtn2.waitFor({ state: 'visible', timeout: 10000 });
              await useTemplateBtn2.click();
              const section2 = page.locator('div, section, tr, fieldset').filter({ hasText: 'Account Resources' }).first();
              const dropdownContainer2 = section2.locator('.react-select-container').filter({ hasText: 'Select...' }).first();
              const dropdownControl2 = dropdownContainer2.locator('.react-select__control, .react-select__placeholder').first();
              await dropdownControl2.waitFor({ state: 'visible', timeout: 10000 });
              await dropdownControl2.click();
              const allAccountsOption2 = page.locator('[id*="-option-0"], div').filter({ hasText: /^All accounts$/ }).first();
              await allAccountsOption2.waitFor({ state: 'visible', timeout: 10000 });
              await allAccountsOption2.click();
              await sleep(300);
              const continueBtn2 = page.locator('button:has-text("Continue to summary"), button:has-text("Continue")').first();
              await continueBtn2.waitFor({ state: 'visible', timeout: 10000 });
              await continueBtn2.click();
            }
          } catch (retryErr) {
            log(`[WARN] Re-verification attempt failed: ${retryErr.message}`);
          }
        } else {
          break;
        }
      }

      if (!apiKey) {
        throw new Error('Failed to find generated API Token on success screen.');
      }

      // Extract Account ID
      if (!accountId) {
        try {
          log('Attempting to extract Account ID (fallback)...');
          accountId = await resolveAccountId(page);
          log(`Successfully resolved Account ID (fallback): ${accountId || 'none'}`);
        } catch (extractErr) {
          log(`[WARN] Failed to resolve Account ID (fallback): ${extractErr.message}`);
        }
      } else {
        log(`Using previously resolved Account ID: ${accountId}`);
      }

      // 10. Save credentials to keys.csv
      const csvHeaders = 'timestamp,email,password,api_key_name,api_key,account_id';
      const csvRow = [
        new Date().toISOString(),
        email,
        CONFIG.password,
        'Workers AI',
        apiKey,
        accountId || ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

      const csvExists = fs.existsSync(CONFIG.keysFile);
      if (!csvExists) {
        fs.writeFileSync(CONFIG.keysFile, csvHeaders + '\n', 'utf8');
      } else {
        const content = fs.readFileSync(CONFIG.keysFile, 'utf8');
        const lines = content.split('\n');
        if (lines[0] && !lines[0].includes('account_id')) {
          lines[0] = csvHeaders;
          fs.writeFileSync(CONFIG.keysFile, lines.join('\n'), 'utf8');
        }
      }
      fs.appendFileSync(CONFIG.keysFile, csvRow + '\n', 'utf8');
      log(`Saved credentials to ${CONFIG.keysFile}`);

      // 11. Log out
      log('Logging out to prepare for the next run...');
      try {
        log('Navigating directly to logout URL...');
        await page.goto('https://dash.cloudflare.com/logout', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
        await sleep(1000);
        log('Logged out successfully.');
      } catch (logoutErr) {
        log(`Direct logout navigation failed: ${logoutErr.message}. Attempting manual click...`);
        try {
          const avatar = page.locator('[aria-label*="Profile"], [aria-label*="profile"], button:has(svg)').last();
          await avatar.click();
          await sleep(500);
          const logoutBtn = page.locator('text=Log out, button:has-text("Log out"), a:has-text("Log out")').first();
          await logoutBtn.click();
          await sleep(1000);
          log('Logged out manually.');
        } catch (clickErr) {
          log(`Failed to log out manually: ${clickErr.message}`);
        }
      }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (rawProxy) {
      handleProxyFailure(rawProxy, err);
    }
    try { await page.screenshot({ path: path.join(__dirname, 'error.png'), fullPage: true }); } catch { }
  } finally {
    log('Closing browser...');
    await sleep(1000);
    if (typeof browser !== 'undefined' && browser) {
      await browser.close().catch(() => {});
    } else if (typeof context !== 'undefined' && context) {
      await context.close().catch(() => {});
    }

    if (dynamicPortUsed) {
      try {
        const { execSync } = require('child_process');
        execSync(`fuser -k ${dynamicPortUsed}/tcp`, { stdio: 'ignore' });
        log(`Terminated Chrome process on dynamic port ${dynamicPortUsed}.`);
      } catch (err) {
        // ignore errors
      }
    }
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
