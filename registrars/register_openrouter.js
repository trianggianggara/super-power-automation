const { loadEnv } = require('../utils/env.js');
loadEnv();

const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy } = require('../utils/browser.js');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();

const browserExecutable = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
const browserType = browserTypeFor(browserExecutable);
if (!isCamoufox(browserExecutable)) {
  browserType.use(StealthPlugin);
}

const TempMail = require('../services/tempmail/tempmail.js');
const fs = require('fs');
const path = require('path');
const { sleep, rand } = require('../utils/helpers.js');
const { spawn } = require('child_process');

const CONFIG = {
  signupUrl: 'https://openrouter.ai/sign-up',
  password: process.env.OPENROUTER_PASSWORD || 'RouterAuto2026!',
  outputFile: path.join(__dirname, '..', 'data', 'openrouter.csv'),
  emailTimeout: 120000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: '/usr/bin/google-chrome-stable',
};

function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

function randNames() {
  const firstNames = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Skyler', 'Reese'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson'];
  return {
    first: firstNames[Math.floor(Math.random() * firstNames.length)],
    last: lastNames[Math.floor(Math.random() * lastNames.length)]
  };
}

const US_ADDRESSES = [
  { street: '1234 Crockett St', city: 'Toledo', state: 'Indiana', stateCode: 'IN', zip: '32980' },
  { street: '742 Evergreen Terrace', city: 'Springfield', state: 'Oregon', stateCode: 'OR', zip: '97477' },
  { street: '450 North Park Ave', city: 'Indianapolis', state: 'Indiana', stateCode: 'IN', zip: '46202' },
  { street: '1000 Broadway St', city: 'San Diego', state: 'California', stateCode: 'CA', zip: '92101' },
  { street: '200 Elm Street', city: 'Dallas', state: 'Texas', stateCode: 'TX', zip: '75201' },
  { street: '550 5th Avenue', city: 'New York', state: 'New York', stateCode: 'NY', zip: '10036' },
  { street: '800 Michigan Ave', city: 'Chicago', state: 'Illinois', stateCode: 'IL', zip: '60611' },
  { street: '300 Biscayne Blvd', city: 'Miami', state: 'Florida', stateCode: 'FL', zip: '33132' },
  { street: '1200 Washington St', city: 'Phoenix', state: 'Arizona', stateCode: 'AZ', zip: '85007' },
  { street: '400 Pine Street', city: 'Seattle', state: 'Washington', stateCode: 'WA', zip: '98101' }
];

function randUsAddress() {
  const item = US_ADDRESSES[Math.floor(Math.random() * US_ADDRESSES.length)];
  return {
    line1: item.street,
    city: item.city,
    state: item.state,
    stateCode: item.stateCode,
    zip: item.zip,
    country: 'United States',
  };
}

async function ensureChromeRunning(executablePath = '/usr/bin/google-chrome-stable', port = 9222, proxy = null) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      log(`Google Chrome already running on port ${port}.`);
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
    throw new Error(`Timeout waiting for Chrome debugging port ${port} to respond.`);
  } catch (err) {
    log(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function monitorTurnstile(page, timeoutMs = 60000, required = false) {
  log(`[INFO] Turnstile challenge monitor started (required=${required})...`);
  try {
    const startTime = Date.now();
    let clickCount = 0;
    let lastClickTime = 0;

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

      // Check if token is populated
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
            if (el.value && el.value.length > 20) return el.value;
          }
        }
        return null;
      }).catch(() => null);

      if (tokenValue) {
        log(`✅ Turnstile Token resolved: ${tokenValue.substring(0, 18)}...`);
        return true;
      }

      // Check full-page challenge state
      const pageState = await page.evaluate(() => {
        const title = document.title || '';
        const bodyText = document.body ? document.body.innerText || '' : '';
        const isChallengeTitle = title.includes('Just a moment') || title.includes('Attention Required') || title.includes('Cloudflare');
        const hasChallengeStage = !!document.getElementById('challenge-stage') ||
                                  !!document.getElementById('challenge-form') ||
                                  !!document.querySelector('.cf-turnstile-wrapper') ||
                                  !!document.querySelector('[id^="cf-chl-widget"]') ||
                                  !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        const isChallengePage = isChallengeTitle || hasChallengeStage ||
                                bodyText.includes('Performing security verification') ||
                                bodyText.includes('Verify you are human') ||
                                bodyText.includes('checking your browser');
        return { isChallengePage, hasChallengeStage, isChallengeTitle };
      }).catch(() => ({ isChallengePage: false, hasChallengeStage: false, isChallengeTitle: false }));

      // Find active turnstile frame
      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => {
        const u = f.url() || '';
        return u.includes('challenges.cloudflare.com') || u.includes('turnstile');
      });

      if (!required && !pageState.isChallengePage && !pageState.hasChallengeStage && !activeFrame && (Date.now() - startTime > 1500)) {
        return true;
      }

      const now = Date.now();
      if (now - lastClickTime > 6000) {
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
          } catch (_) {}

          try {
            const cb = activeFrame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, .mark').first();
            if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
              await cb.click().catch(() => {});
              lastClickTime = now;
            }
          } catch (_) {}
        }

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

async function handleOnboardingWizard(page, name) {
  log('[Onboarding] Handling OpenRouter onboarding flow...');
  const addr = randUsAddress();
  log(`  Using fake US Address: ${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`);

  let extractedKey = '';

  for (let round = 0; round < 15; round++) {
    await sleep(2000);
    const url = page.url();
    const bodyText = await page.textContent('body').catch(() => '');

    // Check if we reached the keys or dashboard page
    if (url.includes('/keys') || (url.includes('/activity') && !bodyText.includes('Welcome to OpenRouter'))) {
      log('  Reached dashboard / keys page.');
      break;
    }

    // 1. Welcome to OpenRouter: Select Individual -> Next
    if (bodyText.includes('Welcome to OpenRouter') || bodyText.includes('How will you be using OpenRouter')) {
      log('  [Step 1] Selecting Individual...');
      const indCard = page.locator('text="Individual", div:has-text("Individual"), input[value="individual"]').first();
      if (await indCard.isVisible({ timeout: 2000 }).catch(() => false)) {
        await indCard.click().catch(() => {});
        await sleep(300);
      }
      const nextBtn = page.locator('button:visible:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click().catch(() => {});
        log('  Clicked Next');
      }
      await sleep(2000);
      continue;
    }

    // 2. Add a payment method / Billing address
    if (bodyText.includes('Add a payment method') && (bodyText.includes('Address line 1') || bodyText.includes('Update Address') || bodyText.includes('Country or region'))) {
      log('  [Step 2] Filling fake US address...');
      
      // Full Name
      const nameInp = page.locator('input[placeholder*="name" i], input[name*="name" i]').first();
      if (await nameInp.isVisible({ timeout: 1500 }).catch(() => false)) {
        await nameInp.fill(`${name.first} ${name.last}`);
        await sleep(150);
      }

      // Address line 1
      const line1Inp = page.locator('input[placeholder*="street" i], input[name*="line1" i], input[placeholder*="address" i], input[name*="address" i]').first();
      if (await line1Inp.isVisible({ timeout: 1500 }).catch(() => false)) {
        await line1Inp.fill(addr.line1);
        await sleep(150);
      }

      // City
      const cityInp = page.locator('input[placeholder*="city" i], input[name*="city" i]').first();
      if (await cityInp.isVisible({ timeout: 1500 }).catch(() => false)) {
        await cityInp.fill(addr.city);
        await sleep(150);
      }

      // State (select / combobox / input)
      try {
        const stateSelect = page.locator('select').first();
        if (await stateSelect.isVisible({ timeout: 1000 }).catch(() => false)) {
          await stateSelect.selectOption({ label: addr.state }).catch(async () => {
            await stateSelect.selectOption({ value: addr.stateCode });
          });
        } else {
          const stateCombobox = page.locator('button[role="combobox"], div[role="combobox"]').nth(1);
          if (await stateCombobox.isVisible({ timeout: 1000 }).catch(() => false)) {
            await stateCombobox.click();
            await sleep(300);
            await page.locator(`text="${addr.state}"`).first().click().catch(() => {});
          }
        }
      } catch (_) {}

      // ZIP code
      const zipInp = page.locator('input[placeholder*="zip" i], input[name*="postal" i], input[name*="zip" i]').first();
      if (await zipInp.isVisible({ timeout: 1500 }).catch(() => false)) {
        await zipInp.fill(addr.zip);
        await sleep(150);
      }

      // Click Update Address
      const updateAddrBtn = page.locator('button:visible:has-text("Update Address")').first();
      if (await updateAddrBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await updateAddrBtn.click();
        log('  Clicked Update Address');
        await sleep(2000);
      }
      continue;
    }

    // 3. Add a payment method (Card / "I'll do this later")
    const laterBtn = page.locator('button:visible:has-text("I\'ll do this later"), a:visible:has-text("I\'ll do this later"), text="I\'ll do this later"').first();
    if (await laterBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('  [Step 3] Clicking "I\'ll do this later"...');
      await laterBtn.click().catch(() => {});
      await sleep(2000);
      continue;
    }

    // 4. Survey: "Where did you first hear about OpenRouter?" -> Google
    if (bodyText.includes('Where did you first hear') || bodyText.includes('how people find us')) {
      log('  [Step 4] Selecting Google in survey...');
      const googleOpt = page.locator('label:has-text("Google"), div:has-text("Google"), text="Google"').first();
      if (await googleOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await googleOpt.click().catch(() => {});
        await sleep(300);
      }
      const continueBtn = page.locator('button:visible:has-text("Continue")').first();
      if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await continueBtn.click();
        log('  Clicked Continue');
      }
      await sleep(2000);
      continue;
    }

    // 5. "Your workspace is ready" screen
    if (bodyText.includes('Your workspace is ready') || bodyText.includes('Your API Key')) {
      log('  [Step 5] Workspace Ready screen detected!');
      const keyMatch = bodyText.match(/sk-or-v1-[a-fA-F0-9]{64}/) || bodyText.match(/sk-or-v1-[a-fA-F0-9]+/) || bodyText.match(/sk-or-[a-zA-Z0-9_-]+/);
      if (keyMatch) {
        extractedKey = keyMatch[0];
        log(`  🔑 Found API Key from workspace: ${extractedKey}`);
      }

      const continueBtn = page.locator('button:visible:has-text("Continue")').first();
      if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await continueBtn.click();
        log('  Clicked Continue on Workspace Ready');
      }
      await sleep(3000);
      continue;
    }

    // Generic fallback for Continue / Next
    const genericNext = page.locator('button:visible:has-text("Continue"), button:visible:has-text("Next")').first();
    if (await genericNext.isVisible({ timeout: 1000 }).catch(() => false)) {
      await genericNext.click().catch(() => {});
      await sleep(2000);
    }
  }

  return extractedKey;
}

async function main() {
  log('=== OpenRouter Auto-Registration (Chrome Stable + CDP) ===');

  // [1] Generate temp mail
  log('[1/7] Generating temporary email (only .my and .com)...');
  const tempmail = new TempMail();
  
  const allDomains = (process.env.TEMPMAIL_WEBHOOK_DOMAIN || '')
    .split(',')
    .map(d => d.trim())
    .filter(Boolean);
  const allowedDomains = allDomains.filter(d => d.endsWith('.my') || d.endsWith('.com'));
  const chosenDomain = allowedDomains.length > 0
    ? allowedDomains[Math.floor(Math.random() * allowedDomains.length)]
    : null;

  const inboxResult = await tempmail.createInbox(null, chosenDomain);
  const email = typeof inboxResult === 'string' ? inboxResult : inboxResult.address || inboxResult.email;
  log(`  Email: ${email}`);

  // [2] Setup proxy
  log('[2/7] Setting up browser engine...');
  let rawProxy = CONFIG.proxy;
  if (!rawProxy && !envFlag('DISABLE_PROXY')) {
    rawProxy = selectProxy(null);
  }
  const pc = rawProxy ? proxyFromUrl(rawProxy) : null;

  log(`  Using Browser Engine: Google Chrome Stable (Incognito Mode CDP)`);
  if (pc) log(`  Proxy: ${pc.server}`);

  let browser;
  let context;
  let dynamicPortUsed = null;

  try {
    const dynamicPort = Math.floor(19000 + Math.random() * 6000);
    dynamicPortUsed = dynamicPort;
    await ensureChromeRunning(CONFIG.browserExecutablePath, dynamicPort, pc);

    const { chromium } = require('playwright-extra');
    chromium.use(require('puppeteer-extra-plugin-stealth')());
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  } catch (err) {
    log(`CDP connection failed: ${err.message}. Falling back to standard launch...`);
    const { chromium } = require('playwright-extra');
    chromium.use(require('puppeteer-extra-plugin-stealth')());
    const launchOpts = {
      headless: envFlag('HEADLESS', false),
      executablePath: CONFIG.browserExecutablePath,
      args: [
        '--incognito',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1920,1080',
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

  try {
    // [3] Navigate to sign-up
    log('[3/7] Navigating to sign-up page...');
    await page.goto(CONFIG.signupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const name = randNames();
    log(`  Name: ${name.first} ${name.last}`);

    // [4] Fill form
    log('[4/7] Filling registration form...');
    const firstNameInput = page.locator('#firstName-field, input[name="firstName"], input[autocomplete="given-name"]').first();
    await firstNameInput.waitFor({ state: 'visible', timeout: 15000 });
    await firstNameInput.fill(name.first);
    await sleep(rand(200, 400));

    const lastNameInput = page.locator('#lastName-field, input[name="lastName"], input[autocomplete="family-name"]').first();
    await lastNameInput.fill(name.last);
    await sleep(rand(200, 400));

    const emailInput = page.locator('#emailAddress-field, input[name="emailAddress"], input[type="email"]').first();
    await emailInput.fill(email);
    await sleep(rand(300, 500));

    const passwordInput = page.locator('#password-field, input[name="password"], input[type="password"]').first();
    await passwordInput.fill(CONFIG.password);
    await sleep(rand(200, 400));

    const checkbox = page.locator('#legalAccepted-field, input[type="checkbox"]');
    if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await checkbox.check({ force: true }).catch(() => {});
      log('  Terms accepted');
    }

    // [5] Submit with Turnstile solving
    log('[5/7] Submitting form (with Turnstile monitor)...');
    const submitBtn = page.locator('button:visible:has-text("Continue"), button.cl-formButtonPrimary:visible, button:visible[type="submit"]').first();
    await submitBtn.click();
    log('  Clicked Continue, waiting for Clerk Turnstile...');
    
    // Clerk loads Turnstile after Continue click (render=explicit)
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const frames = page.frames();
      const tf = frames.find(f => (f.url() || '').includes('challenges.cloudflare.com') || (f.url() || '').includes('turnstile'));
      if (tf) {
        log('  Turnstile frame detected!');
        break;
      }
      if (i % 3 === 0) log(`  Waiting for Turnstile... (${(i+1)}s)`);
    }
    
    const tsSolved = await monitorTurnstile(page, 45000, true);
    log(`  Turnstile result: ${tsSolved ? 'SOLVED' : 'TIMEOUT'}`);
    await sleep(2000);
    
    log(`  URL after Turnstile: ${page.url()}`);
    
    if (page.url().includes('sign-up') && !page.url().includes('verify')) {
      try {
        await page.locator('button:visible:has-text("Continue"), button.cl-formButtonPrimary:visible, button:visible[type="submit"]').first().click({ timeout: 3000 });
      } catch (_) {}
      await sleep(3000);
    }
    log(`  Final URL: ${page.url()}`);

    // [6] Email verification
    log('[6/7] Waiting for verification email...');
    let msg = null;
    try {
      msg = await tempmail.waitForEmail(email, CONFIG.emailTimeout);
    } catch (e) {
      log(`  Email wait error: ${e.message}`);
    }

    if (!msg) {
      // Fallback: try direct polling
      try {
        const messages = await tempmail.getMessages(email);
        if (messages && messages.length > 0) {
          msg = messages[0];
        }
      } catch (_) {}
    }

    let otpCode = null;
    let verifyLink = null;

    if (msg) {
      log(`  Email received: "${msg.subject || 'No Subject'}"`);
      const body = (msg.text_body || '') + '\n' + (msg.html_body || '');

      otpCode = TempMail.extractOtp(msg.subject, msg.text_body, msg.html_body);
      if (otpCode) {
        log(`  Extracted OTP code: ${otpCode}`);
      }

      const linkMatch = body.match(/https?:\/\/openrouter\.ai\/[^\s"'<>]*verif[^\s"'<>]*/i)
        || body.match(/https?:\/\/openrouter\.ai\/[^\s"'<>]*confirm[^\s"'<>]*/i)
        || body.match(/https?:\/\/openrouter\.ai\/[^\s"'<>]*activate[^\s"'<>]*/i)
        || body.match(/https?:\/\/clerk\.[^\s"'<>]*\/[^\s"'<>]*/i);

      if (linkMatch) {
        verifyLink = linkMatch[0].replace(/[.,;:'")\]]*$/, '');
        log(`  Found verification link: ${verifyLink}`);
      }

      if (!verifyLink) {
        const anyLink = body.match(/https?:\/\/openrouter\.ai\/[^\s"'<>]+/gi);
        if (anyLink) {
          for (const link of anyLink) {
            const clean = link.replace(/[.,;:'")\]]*$/, '');
            if (!clean.includes('/sign-in') && !clean.includes('/sign-up') && !clean.includes('/docs')) {
              verifyLink = clean;
              log(`  Found link: ${verifyLink}`);
              break;
            }
          }
        }
      }
    }

    // Input OTP code or navigate link
    if (otpCode) {
      log('  Entering OTP code into verification inputs...');
      const digitInputs = page.locator('input[inputmode="numeric"], input[data-otp-input], input[name*="code" i], input[id*="code" i]');
      const count = await digitInputs.count().catch(() => 0);
      if (count >= 6) {
        log(`  Filling ${otpCode.length} digits into separate boxes...`);
        for (let i = 0; i < Math.min(count, otpCode.length); i++) {
          await digitInputs.nth(i).fill(otpCode[i]);
          await sleep(150);
        }
      } else if (count > 0) {
        log(`  Filling OTP into input box...`);
        await digitInputs.first().fill(otpCode);
      } else {
        // Try any text input on verify page
        const generalInput = page.locator('input[type="text"]').first();
        if (await generalInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await generalInput.fill(otpCode);
        }
      }
      await sleep(1500);

      const continueBtn = page.locator('button:visible:has-text("Continue"), button:visible:has-text("Verify"), button.cl-formButtonPrimary:visible').first();
      if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await continueBtn.click().catch(() => {});
      }
      await sleep(3000);
    } else if (verifyLink) {
      await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      log(`  Verified via link. URL: ${page.url()}`);
    } else {
      log('  WARNING: No OTP code or verification link found.');
    }

    // [7] Handle Onboarding Wizard (Individual -> Fake US Address -> I'll do this later -> Google -> Workspace Ready)
    log('[7/8] Handling onboarding wizard...');
    let apiKey = await handleOnboardingWizard(page, name);

    // [8] Go to Keys / Dashboard & Ensure API Key
    log('[8/8] Checking API Key and Dashboard...');

    if (!apiKey) {
      if (!page.url().includes('/keys')) {
        await page.goto('https://openrouter.ai/keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
      }

      log(`  Keys page: ${page.url()}`);

      // Handle redirect to sign-in if needed
      if (page.url().includes('sign-in')) {
        log('  Redirected to sign-in. Trying login...');
        const signInEmail = page.locator('#emailAddress-field, input[name=emailAddress]');
        if (await signInEmail.isVisible({ timeout: 2000 }).catch(() => false)) {
          await signInEmail.fill(email);
          await page.locator('button:visible:has-text("Continue")').first().click();
          await sleep(2000);
          const signInPass = page.locator('#password-field, input[name=password]');
          if (await signInPass.isVisible({ timeout: 2000 }).catch(() => false)) {
            await signInPass.fill(CONFIG.password);
            await page.locator('button:visible:has-text("Continue")').first().click();
            await sleep(3000);
          }
        }
        await page.goto('https://openrouter.ai/keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
      }

      // Click "Create Key"
      const createBtn = page.locator('button:visible:has-text("Create Key"), button:visible:has-text("Add Key"), button:visible:has-text("New"), a:visible:has-text("Create Key")').first();
      try {
        await createBtn.click({ timeout: 5000 });
        await sleep(2000);
        log('  Clicked Create Key');

        // Fill key name
        const keyName = `auto-${Math.random().toString(36).substring(2, 10)}`;
        const nameInput = page.locator('input[name="name"], input[id*="name"], input[placeholder*="Name"]').first();
        if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await nameInput.fill(keyName);
          await sleep(500);

          const confirmBtn = page.locator('button:visible:has-text("Create"), button:visible:has-text("Confirm"), button:visible:has-text("Generate")').first();
          await confirmBtn.click();
          await sleep(2000);
          log(`  Key named: ${keyName}`);
        }
      } catch (e) {
        log(`  Create Key button not found or already created: ${e.message}`);
      }

      // Extract API key from page
      const bodyText = await page.textContent('body');
      const match = bodyText.match(/sk-or-v1-[a-fA-F0-9]{64}/) || bodyText.match(/sk-or-v1-[a-fA-F0-9]+/) || bodyText.match(/sk-or-[a-zA-Z0-9]+/);
      if (match) apiKey = match[0];

      if (!apiKey) {
        try {
          const codeBlock = await page.locator('code, pre').first().textContent({ timeout: 3000 });
          const cm = codeBlock.match(/sk-or-[a-zA-Z0-9_-]+/);
          if (cm) apiKey = cm[0];
        } catch (_) {}
      }
    }

    // Save
    const csvDir = path.dirname(CONFIG.outputFile);
    if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });

    const csvHeader = 'email,password,api_key,name,created_at';
    const csvRow = `${email},${CONFIG.password},${apiKey || 'MISSING'},"${name.first} ${name.last}",${new Date().toISOString()}`;

    if (!fs.existsSync(CONFIG.outputFile)) {
      fs.writeFileSync(CONFIG.outputFile, csvHeader + '\n');
    }
    fs.appendFileSync(CONFIG.outputFile, csvRow + '\n');
    log(`  Saved to ${CONFIG.outputFile}`);

    console.log('\n=== REGISTRATION COMPLETE ===');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${CONFIG.password}`);
    console.log(`  Name:     ${name.first} ${name.last}`);
    console.log(`  API Key:  ${apiKey || 'NOT FOUND'}`);
    console.log(`  Credits:  $1.00 (automatic)`);

    return { email, password: CONFIG.password, apiKey, name };

  } catch (err) {
    log(`ERROR: ${err.message}`);
    try {
      const screenshotDir = path.join(__dirname, '..', 'data', 'screenshots');
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ssFile = path.join(screenshotDir, `openrouter_error_${timestamp}.png`);
      const ssLatest = path.join(screenshotDir, `openrouter_error_latest.png`);
      
      await page.screenshot({ path: ssFile, fullPage: true });
      await page.screenshot({ path: ssLatest, fullPage: true });
      log(`📸 Screenshot error berhasil disimpan di:\n   -> ${ssFile}\n   -> ${ssLatest}`);
    } catch (ssErr) {
      log(`⚠️ Gagal mengambil screenshot error: ${ssErr.message}`);
    }
    throw err;
  } finally {
    try { await browser.close(); } catch (_) {}
    log('Browser closed.');
    if (dynamicPortUsed) {
      try { spawn('pkill', ['-f', `chrome.*${dynamicPortUsed}`]); } catch (_) {}
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
