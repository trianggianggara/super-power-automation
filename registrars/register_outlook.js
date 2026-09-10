#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium, firefox } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const { loadEnv } = require('../utils/env.js');
loadEnv();

const { 
  isCamoufox, 
  browserTypeFor, 
  resolveBrowserExecutablePath, 
  envFlag, 
  proxyFromUrl, 
  selectProxy, 
  handleProxyFailure,
  setupNetworkOptimization
} = require('../utils/browser.js');
const { sleep, rand, fillHuman, clickHuman, gotoWithRetry } = require('../utils/helpers.js');
const { randomFirstName, randomLastName } = require('../utils/names.js');
const TempMail = require('../services/tempmail/tempmail.js');

const CONFIG = {
  signupUrl: 'https://signup.live.com/signup?lic=1',
  loginUrl: 'https://login.live.com/',
  outlookWebUrl: 'https://outlook.live.com/mail/',
  securityProofsUrl: 'https://account.live.com/proofs/manage/additional',
  password: process.env.OUTLOOK_PASSWORD || process.env.PASSWORD || 'PortoAuto2025!#',
  domain: process.env.OUTLOOK_DOMAIN || '@outlook.com',
  country: process.env.OUTLOOK_COUNTRY || 'auto', // Default to auto-detect matching the IP
  outputFile: path.join(__dirname, '..', 'data', 'outlook_accounts.csv'),
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  // Outlook registrar respects BROWSER_EXECUTABLE_PATH from .env, defaults to standard Chromium
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
  proxy: process.env.PROXY || '',
  headless: envFlag('HEADLESS', false),
  enableRecoveryEmail: envFlag('OUTLOOK_ENABLE_RECOVERY_EMAIL', true) || 
                       process.argv.includes('--recovery') || 
                       process.argv.includes('--email-recovery'),
};

/**
 * Generate 6-digit TOTP code locally using RFC 6238
 */
function generateTotpToken(secretKey) {
  try {
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    const cleanSecret = String(secretKey || '').replace(/[\s=-]/g, '').toUpperCase();
    for (let i = 0; i < cleanSecret.length; i++) {
      const val = base32chars.indexOf(cleanSecret.charAt(i));
      if (val >= 0) bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    const secretBuffer = Buffer.from(bytes);
    const epoch = Math.floor(Date.now() / 1000);
    const time = Math.floor(epoch / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigUInt64BE(BigInt(time));

    const hmac = crypto.createHmac('sha1', secretBuffer);
    hmac.update(timeBuffer);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1] & 0xf;
    const code = (
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)
    ) % 1000000;

    return String(code).padStart(6, '0');
  } catch (_) {
    return null;
  }
}

/**
 * Generate unique Gmail address using ONLY Dot-Trick (No Plus-Trick)
 */
function generateGmailDotTrick() {
  const allUsers = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);
  if (allUsers.length === 0) {
    throw new Error('Missing GMAIL_USER in .env for OTP verification.');
  }

  // Pick a random active Gmail address from GMAIL_USER
  const baseEmail = allUsers[Math.floor(Math.random() * allUsers.length)];
  const atIdx = baseEmail.indexOf('@');
  if (atIdx === -1) return baseEmail;

  const rawUser = baseEmail.slice(0, atIdx);
  const domain = baseEmail.slice(atIdx + 1);

  // Clean username of any existing dots or plus tags
  const cleanUser = rawUser.replace(/\./g, '').split('+')[0];

  if (cleanUser.length <= 1) {
    return `${cleanUser}@${domain}`;
  }

  // Insert 1 or 2 dots randomly between characters (clean dot-trick only, no plus)
  const positions = [];
  for (let i = 1; i < cleanUser.length; i++) {
    positions.push(i);
  }

  const numDots = Math.min(cleanUser.length > 5 ? rand(1, 2) : 1, positions.length);
  const shuffled = positions.sort(() => 0.5 - Math.random()).slice(0, numDots).sort((a, b) => a - b);

  let dottedUser = '';
  let lastIdx = 0;
  for (const pos of shuffled) {
    dottedUser += cleanUser.slice(lastIdx, pos) + '.';
    lastIdx = pos;
  }
  dottedUser += cleanUser.slice(lastIdx);

  return `${dottedUser}@${domain}`;
}

function generateRandomPassword() {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const all = upper + lower + digits + special;
  
  // Guarantee at least one character from each set to pass Microsoft complexity rules
  let pwd = '';
  pwd += upper[rand(0, upper.length)];
  pwd += lower[rand(0, lower.length)];
  pwd += digits[rand(0, digits.length)];
  pwd += special[rand(0, special.length)];
  
  // Randomize length between 12 and 15
  const len = rand(12, 16);
  for (let i = 4; i < len; i++) {
    pwd += all[rand(0, all.length)];
  }
  
  // Shuffle the password characters
  return pwd.split('').sort(() => 0.5 - Math.random()).join('');
}

function generateAccount() {
  const fn = randomFirstName();
  const ln = randomLastName();
  
  const cleanFirst = fn.toLowerCase().replace(/[^a-z]/g, '');
  const cleanLast = ln.toLowerCase().replace(/[^a-z]/g, '');
  
  // Create natural matching email prefixes: e.g. "karen.collins", "karencollins", or "k_collins"
  const suffix = rand(10, 999);
  const styles = [
    `${cleanFirst}${cleanLast}${suffix}`,
    `${cleanFirst}.${cleanLast}${suffix}`,
    `${cleanFirst}_${cleanLast}${suffix}`,
    `${cleanFirst.slice(0, 1)}${cleanLast}${suffix}`
  ];
  const emailUsername = styles[Math.floor(Math.random() * styles.length)];
  
  // Randomly choose between outlook.com and hotmail.com (unless configured otherwise in env)
  let chosenDomain = '@outlook.com';
  if (process.env.OUTLOOK_DOMAIN && process.env.OUTLOOK_DOMAIN !== 'random' && process.env.OUTLOOK_DOMAIN !== '@random') {
    chosenDomain = process.env.OUTLOOK_DOMAIN.startsWith('@') ? process.env.OUTLOOK_DOMAIN : `@${process.env.OUTLOOK_DOMAIN}`;
  } else {
    const domains = ['@outlook.com', '@hotmail.com'];
    chosenDomain = domains[Math.floor(Math.random() * domains.length)];
  }

  // Use dynamic randomized password instead of static CONFIG.password
  const dynamicPassword = generateRandomPassword();

  return {
    firstName: fn,
    lastName: ln,
    email: `${emailUsername}${chosenDomain}`,
    password: dynamicPassword,
    recoveryEmail: '',
    totpSecret: ''
  };
}

function saveAccount(account) {
  const dir = path.dirname(CONFIG.outputFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(CONFIG.outputFile)) {
    fs.writeFileSync(CONFIG.outputFile, '"email","password","first_name","last_name","recovery_email","totp_secret","refresh_token","status","refresh_token_status","created_at"\n');
  }
  const recovery = account.recoveryEmail || '';
  const totp = account.totpSecret || '';
  const refreshToken = account.refreshToken || '';
  const status = refreshToken ? 'active' : '';
  const refreshTokenStatus = refreshToken ? 'valid' : '';
  const line = `"${account.email}","${account.password}","${account.firstName}","${account.lastName}","${recovery}","${totp}","${refreshToken}","${status}","${refreshTokenStatus}","${new Date().toISOString()}"\n`;
  fs.appendFileSync(CONFIG.outputFile, line);
  console.log(`[SUCCESS] Account saved to ${CONFIG.outputFile}`);
}

/**
 * Solve distorted text/image captcha using LLM Vision solver
 */
async function handleOutlookImageCaptcha(page) {
  const imgSelectors = [
    'img[id*="hip" i]',
    'img[src*="/HIP/"]',
    'img[src*="HIP" i]',
    'img[id*="Captcha" i]',
    'img[src*="captcha" i]',
    'img[alt*="captcha" i]'
  ];

  const inputSelectors = [
    'input[id*="hip" i]',
    'input[name*="hip" i]',
    'input[id*="Captcha" i]',
    'input[name*="Captcha" i]',
    'input[type="text"][placeholder*="characters" i]',
    'input[type="text"][aria-label*="characters" i]',
    'input[type="text"]'
  ];

  let imgLocator = null;
  for (const sel of imgSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
      imgLocator = loc;
      break;
    }
  }

  let inputLocator = null;
  let inputSelectorUsed = '';
  for (const sel of inputSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
      inputLocator = loc;
      inputSelectorUsed = sel;
      break;
    }
  }

  if (imgLocator && inputLocator) {
    console.log('[CAPTCHA] Distorted text CAPTCHA detected. Attempting to solve via LLM...');
    const { solveImageCaptcha } = require('../utils/captcha_solver.js');
    
    const success = await solveImageCaptcha(imgLocator, page, {
      apiKey: process.env.LLM_API_KEY,
      apiUrl: process.env.LLM_API_URL,
      model: process.env.LLM_MODEL,
      retries: 5,
      timeoutMs: 60000,
      inputSelector: inputSelectorUsed,
      submitSelector: 'button#nextButton, #iSignupAction, button:has-text("Next"), input[type="submit"]',
      promptOverride: 'Solve this Microsoft signup captcha. Identify the alphanumeric characters in the image. Return only the code, in uppercase, no spaces, no explanation.'
    }).catch(err => {
      console.error(`  [CAPTCHA ERROR] Error solving image captcha: ${err.message}`);
      return false;
    });

    if (success) {
      console.log('  [CAPTCHA] Image CAPTCHA solved successfully!');
      return true;
    } else {
      console.log('  [CAPTCHA] Image CAPTCHA solving failed or timed out.');
    }
  }
  return false;
}

/**
 * Handle Press & Hold challenge with natural human movement simulation
 */
async function handleHumanPressAndHold(page) {
  const maxHoldAttempts = 3;
  for (let holdAttempt = 1; holdAttempt <= maxHoldAttempts; holdAttempt++) {
    if (holdAttempt > 1) {
      console.log(`[CHALLENGE] Hold attempt ${holdAttempt}/${maxHoldAttempts} (retrying with longer hold)...`);
      await sleep(2500);
    }
    const held = await attemptPressAndHold(page, holdAttempt);
    if (held) return true;
  }
  return false;
}

async function attemptPressAndHold(page, holdAttempt = 1) {
  const allTargets = [page, ...page.frames()];
  console.log(`[CHALLENGE DEBUG] Scanning ${allTargets.length} targets (main page + ${page.frames().length} frames)...`);
  for (const f of page.frames()) {
    console.log(`  [FRAME] URL: ${f.url()}`);
  }

  for (const frame of allTargets) {
    try {
      const holdSelectors = [
        '#px-captcha',
        'div[id*="px-captcha"]',
        'div[aria-label*="Press and Hold" i]',
        'div[aria-label*="Press & Hold" i]',
        'button[aria-label*="Press and Hold" i]',
        'div[role="button"]:has-text("Press and hold")',
        'button:has-text("Press and hold")',
        '#sec-cpt-btn',
        '#px-captcha-wrapper',
        'div[role="button"]:has-text("Press and hold the button")',
        '[aria-label*="press" i][aria-label*="hold" i]',
        // Localized Indonesian version support
        'div[role="button"]:has-text("Tekan dan tahan")',
        'button:has-text("Tekan dan tahan")',
        '[aria-label*="tekan" i][aria-label*="tahan" i]',
        'div[role="button"]:has-text("Tekan dan tahan tombol ini")',
        // Exact text wildcards
        ':text-is("Press and hold")',
        ':text-is("Tekan dan tahan")',
        ':text-is("Press and hold the button")'
      ];

      for (const sel of holdSelectors) {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 20 && box.height > 20) {
            console.log(`[CHALLENGE] Detected Press & Hold button (${sel}). Simulating realistic human hold...`);
            
            // Check if it's currently showing "Please try again", wait for cooldown animation to finish
            const bodyText = await frame.innerText('body').catch(() => '');
            if (bodyText.includes('Please try again')) {
              console.log('[CHALLENGE] Cooldown detected ("Please try again"). Waiting 3s for reset...');
              await sleep(3000);
            }

            // Check if element is still in skeleton/loading/disabled state ("bayangan")
            const isReady = await el.evaluate(node => {
              const style = window.getComputedStyle(node);
              const opacity = parseFloat(style.opacity || '1');
              const isPointerDisabled = style.pointerEvents === 'none';
              const isDisabled = node.hasAttribute('disabled') || 
                                 node.getAttribute('aria-disabled') === 'true' || 
                                 node.classList.contains('disabled') ||
                                 node.classList.contains('loading');
              return opacity >= 0.85 && !isPointerDisabled && !isDisabled;
            }).catch(() => false);

            if (!isReady) {
              console.log('[CHALLENGE] Warning: Button style check suggests skeleton state, but proceeding anyway to prevent lockup...');
            }

            // Brief stabilization delay to ensure canvas/widget is ready for interaction
            await sleep(500);
            
            // Native hover and focus to route pointer events correctly in iframes
            await el.hover({ timeout: 2000 }).catch(() => {});
            await sleep(rand(200, 400));
            await el.focus({ timeout: 2000 }).catch(() => {});
            await sleep(rand(150, 300));

            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;

            // 1. Human-like approach: Bezier curve from random offset to button center
            const startX = centerX + rand(-200, 200);
            const startY = centerY + rand(-150, 150);
            const ctrl1X = startX + (centerX - startX) * 0.3 + rand(-30, 30);
            const ctrl1Y = startY + (centerY - startY) * 0.3 + rand(-20, 20);
            const ctrl2X = centerX + rand(-15, 15);
            const ctrl2Y = centerY + rand(-10, 10);

            console.log(`[CHALLENGE] Moving to button via Bezier curve from (${Math.round(startX)},${Math.round(startY)})...`);
            const moveSteps = rand(15, 25);
            for (let s = 0; s <= moveSteps; s++) {
              const t = s / moveSteps;
              // Cubic Bezier
              const x = Math.pow(1-t, 3) * startX + 3 * Math.pow(1-t, 2) * t * ctrl1X + 3 * (1-t) * Math.pow(t, 2) * ctrl2X + Math.pow(t, 3) * centerX;
              const y = Math.pow(1-t, 3) * startY + 3 * Math.pow(1-t, 2) * t * ctrl1Y + 3 * (1-t) * Math.pow(t, 2) * ctrl2Y + Math.pow(t, 3) * centerY;
              await page.mouse.move(x, y);
              await sleep(rand(15, 40));
            }

            // Brief hesitation like a human reading "Press and Hold"
            await sleep(rand(200, 500));

            // Small adjustment jitter right before clicking (like finger settling)
            await page.mouse.move(centerX + rand(-2, 2), centerY + rand(-2, 2), { steps: 3 });
            await sleep(rand(50, 120));

            // 2. Press down with slight downward pressure movement
            await page.mouse.down();
            await page.mouse.move(centerX, centerY + rand(1, 3), { steps: 2 }); // slight press-down like finger pressure
            console.log(`[CHALLENGE] Button pressed. Holding with human-like micro-tremor...`);

            // 3. Hold with natural tremor — release when success detected, not fixed duration
            const holdStart = Date.now();
            // Adjusted hold duration curve: 1st=10-13s, 2nd=13-16s, 3rd=16-20s (gives enough time for canvas ring completion)
            const minDuration = holdAttempt <= 1 ? 10000 : (holdAttempt === 2 ? 13000 : 16000);
            const maxDuration = holdAttempt <= 1 ? 13000 : (holdAttempt === 2 ? 16000 : 20000);
            const targetDuration = rand(minDuration, maxDuration);
            let currentX = centerX;
            let currentY = centerY;

            // Natural tremor: very small oscillations with slow drift
            let driftX = 0, driftY = 0;
            let tremorPhase = 0;

            while (Date.now() - holdStart < targetDuration) {
              await sleep(rand(50, 100));
              tremorPhase += rand(0.1, 0.3);

              // Natural tremor: ~0.1-0.5px oscillation (like a finger shake)
              const tremorX = Math.sin(tremorPhase) * rand(0.1, 0.5);
              const tremorY = Math.cos(tremorPhase * rand(1.1, 1.4)) * rand(0.1, 0.4);

              // Slow drift: tiny gradual movement in random direction (like hand fatigue)
              driftX += (Math.random() - 0.5) * 0.05;
              driftY += (Math.random() - 0.5) * 0.05;
              driftX = Math.max(-3, Math.min(3, driftX));
              driftY = Math.max(-3, Math.min(3, driftY));

              currentX = centerX + tremorX + driftX;
              currentY = centerY + tremorY + driftY;

              // Keep within box bounds
              currentX = Math.max(box.x + 5, Math.min(box.x + box.width - 5, currentX));
              currentY = Math.max(box.y + 5, Math.min(box.y + box.height - 5, currentY));

              await page.mouse.move(currentX, currentY, { steps: 1 }).catch(() => {});

              // Check if challenge resolved early (element gone or success state)
              const stillVisible = await el.isVisible({ timeout: 300 }).catch(() => false);
              const checkText = await frame.innerText('body').catch(() => '');
              if (!stillVisible || checkText.includes('Success') || checkText.includes('Verified') || checkText.includes('verified')) {
                console.log(`[CHALLENGE] Challenge resolved early after ${((Date.now() - holdStart) / 1000).toFixed(1)}s!`);
                break;
              }
            }

            // 4. Release gradually — slight upward drift then release (like lifting finger)
            await page.mouse.move(currentX, currentY - rand(1, 2), { steps: 2 });
            await sleep(rand(30, 80));
            await page.mouse.up();
            console.log(`[CHALLENGE] Button released after ${((Date.now() - holdStart) / 1000).toFixed(1)}s.`);
            
            // Allow 3-5 seconds for PerimeterX telemetry evaluation & token handoff
            const evalStart = Date.now();
            while (Date.now() - evalStart < 4500) {
              await sleep(600);
              const postText = await frame.innerText('body').catch(() => '');
              const stillThere = await el.isVisible({ timeout: 300 }).catch(() => false);
              const currentUrl = page.url();

              if (!stillThere || postText.includes('Success') || postText.includes('Verified') || postText.includes('verified') ||
                  !currentUrl.includes('/signup?') || currentUrl.includes('account.') || currentUrl.includes('login.') || currentUrl.includes('ppsecure')) {
                console.log('[CHALLENGE] Challenge PASSED!');
                return true;
              }
            }

            // Check if challenge failed or requested retry
            const postText = await frame.innerText('body').catch(() => '');
            const stillThere = await el.isVisible({ timeout: 500 }).catch(() => false);
            if (!stillThere || postText.includes('Success') || postText.includes('Verified') || postText.includes('verified')) {
              console.log('[CHALLENGE] Challenge PASSED!');
              return true;
            }
            if (postText.includes('Please try again') || postText.includes('try again') || stillThere) {
              console.log(`[CHALLENGE] Hold #${holdAttempt} failed (too short or rejected). Will retry with longer hold...`);
              return false;
            }
            return true;
          }
        }
      }
    } catch (_) {}
  }
  return false;
}

async function waitForManualCaptcha(page, timeoutMs = 180000) {
  const challengeSelectors = [
    '#px-captcha', '#px-captcha-wrapper', '#sec-cpt-btn',
    'iframe[src*="hsprotect.net"]', 'iframe[src*="arkose"]',
    'iframe[src*="captcha"]', 'iframe[title*="challenge" i]',
    '[aria-label*="Press and Hold" i]', '[aria-label*="Press & Hold" i]',
    'div[role="button"]:has-text("Press and hold")',
    'button:has-text("Press and hold")'
  ];

  const challengeVisible = async () => {
    for (const selector of challengeSelectors) {
      if (await page.locator(selector).first().isVisible({ timeout: 200 }).catch(() => false)) return true;
    }
    for (const frame of page.frames()) {
      if (frame.url().includes('hsprotect.net') || frame.url().includes('challenge') || frame.url().includes('px') || frame.url().includes('arkose')) return true;
    }
    const text = await page.locator('body').innerText({ timeout: 300 }).catch(() => '');
    return /help us beat the robots|press\s*(and|&)\s*hold|verify you are human|security challenge|captcha/i.test(text);
  };

  if (!(await challengeVisible())) return true;
  console.log('[CHALLENGE] CAPTCHA detected. Actively monitoring for element & URL resolution (up to 180s max)...');

  const successSelectors = [
    'button#idSIButton9', 'input#idSIButton9', 'button#acceptButton',
    'input[value="Yes"]', 'input[value="No"]', 'button:has-text("Yes")',
    'button:has-text("No")', 'button:has-text("Stay signed in")',
    '#kmsiTitle', '#iCancel', 'a:has-text("No thanks")', 'button:has-text("Skip")',
    'button:has-text("Next")', 'input[value="Next"]'
  ];

  let lastHoldAttemptTime = 0;
  const deadline = Date.now() + Math.min(timeoutMs, 180000);
  while (Date.now() < deadline) {
    const curUrl = page.url();

    // 1. Detect immediate URL transition out of signup/challenge
    if (!curUrl.includes('/signup?') && (
      curUrl.includes('account.') || curUrl.includes('login.') || 
      curUrl.includes('outlook.') || curUrl.includes('ppsecure') || 
      curUrl.includes('privacynotice') || curUrl.includes('/proofs/')
    )) {
      console.log(`[CHALLENGE RESOLVED] Detected success URL transition: ${curUrl}`);
      return true;
    }

    // 2. Detect Block / Error screens immediately (fast fail)
    const isBlockedOrError = await page.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      return body.includes('Account creation has been blocked') || 
             body.includes('blocked the creation of this account') ||
             body.includes('This site is temporarily unavailable') ||
             body.includes('We ran into a problem');
    }).catch(() => false);

    if (isBlockedOrError || curUrl.includes('error.aspx') || curUrl.includes('/error')) {
      console.log(`[CHALLENGE FAILED] Detected Microsoft blocked/error screen. Fast-failing immediately...`);
      return false;
    }

    // 3. Detect "Try again" button on "Something went wrong"
    const tryAgainBtn = page.locator('button:has-text("Try again"), input[value="Try again"], button#idSIButton9').filter({ hasText: /Try again/i }).first();
    if (await tryAgainBtn.isVisible({ timeout: 200 }).catch(() => false)) {
      console.log(`[CHALLENGE RECOVERY] Detected "Try again" button. Clicking...`);
      await tryAgainBtn.click().catch(() => {});
      await sleep(1500);
      continue;
    }

    // 4. If Press & Hold button is detected, execute realistic human hold immediately
    if (Date.now() - lastHoldAttemptTime > 12000) {
      const isHoldPresent = await challengeVisible();
      if (isHoldPresent) {
        lastHoldAttemptTime = Date.now();
        console.log(`[CHALLENGE] Press & Hold detected during monitoring. Triggering instant hold simulation...`);
        const held = await attemptPressAndHold(page, 1);
        if (held) {
          await sleep(2000);
          const postHoldUrl = page.url();
          if (!postHoldUrl.includes('/signup?') || postHoldUrl.includes('account.') || postHoldUrl.includes('login.') || postHoldUrl.includes('outlook.') || postHoldUrl.includes('ppsecure')) {
            console.log(`[CHALLENGE RESOLVED] Instant hold succeeded and page transitioned.`);
            return true;
          }
        }
      }
    }

    // 5. Detect post-challenge success UI elements (KMSI / Stay Signed In / Privacy Notice / Passwordless Promo)
    for (const sel of successSelectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 150 }).catch(() => false)) {
        if (!(await challengeVisible())) {
          console.log(`[CHALLENGE RESOLVED] Detected post-challenge element: ${sel}`);
          return true;
        }
      }
    }

    // 6. Check if challenge container disappeared completely
    if (!(await challengeVisible())) {
      console.log(`[CHALLENGE RESOLVED] Challenge elements disappeared. Page transitioned.`);
      return true;
    }

    await sleep(500);
  }

  console.log('[CHALLENGE TIMEOUT] Active element detection reached 180s hard ceiling.');
  return false;
}

async function clickNext(page) {
  const nextSelectors = [
    'button#nextButton',
    'button#idSIButton9',
    'button[type="submit"]',
    'button:has-text("Next")',
    '#iSignupAction',
    'input[type="submit"]',
    'input[value="Next"]'
  ];
  for (const sel of nextSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
      await clickHuman(page, btn).catch(() => {});
      return true;
    }
  }
  await page.keyboard.press('Enter').catch(() => {});
  return false;
}

async function handleSecurityEmailOtpChallenge(page, tempmail, existingRecoveryEmail = null) {
  // Check for Stay Signed In prompt
  const staySignedInBtn = page.locator('#acceptButton, input[value="Yes"], button:has-text("Yes"), button:has-text("Stay signed in")').first();
  if (await staySignedInBtn.isVisible({ timeout: 800 }).catch(() => false)) {
    console.log(`[INFO] "Stay signed in?" prompt detected. Clicking Yes...`);
    await staySignedInBtn.click();
    await sleep(2500);
  }

  // Check if Microsoft allows skipping security info / recovery setup
  const skipBtn = page.locator('a#iCancel, button#iCancel, a#iLandingViewAction, a:has-text("Skip for now"), a:has-text("Cancel"), a:has-text("Looks good"), a:has-text("Remind me later"), a:has-text("Ask me later"), a:has-text("No thanks"), button:has-text("Skip"), button:has-text("Cancel"), a:has-text("Use your password"), a#idA_PWD_SwitchToPassword').first();
  if (!CONFIG.enableRecoveryEmail && await skipBtn.isVisible({ timeout: 800 }).catch(() => false)) {
    console.log('[SECURITY] Skipping recovery email setup prompt (OUTLOOK_ENABLE_RECOVERY_EMAIL=false)...');
    await clickHuman(page, skipBtn).catch(() => {});
    await sleep(2500);
    return { handled: true, skipped: true };
  }

  // Check if Microsoft offers "Add an email instead" toggle if phone number is shown
  const useEmailLink = page.locator('a:has-text("Add an email"), a:has-text("email instead"), a:has-text("Use a different method"), a#proofTypeToggle').first();
  if (await useEmailLink.isVisible({ timeout: 800 }).catch(() => false)) {
    console.log('[SECURITY] Switching to email verification method...');
    await useEmailLink.click().catch(() => {});
    await sleep(1000);
  }

  // Check for proof type dropdown / radio button first (ensures email field becomes visible)
  const proofTypeSelect = page.locator('select#ProofType, select[name="ProofType"], select#proofType, select#iProofOptions, select#proof').first();
  if (await proofTypeSelect.isVisible({ timeout: 1200 }).catch(() => false)) {
    console.log('[SECURITY] Proof dropdown detected. Selecting alternate email option...');
    await proofTypeSelect.selectOption({ label: 'An alternate email address' }).catch(async () => {
      await proofTypeSelect.selectOption('Email').catch(async () => {
        await proofTypeSelect.selectOption({ index: 1 }).catch(() => {});
      });
    });
    await sleep(800);
  }

  const emailRadio = page.locator('input[type="radio"][value*="email" i], input[type="radio"]#Email, label:has-text("Email"), div[role="radio"]:has-text("Email")').first();
  if (await emailRadio.isVisible({ timeout: 500 }).catch(() => false)) {
    console.log('[SECURITY] Radio button detected. Selecting email option...');
    await emailRadio.click().catch(() => {});
    await sleep(800);
  }

  let recoveryEmail = existingRecoveryEmail;

  // Step 1: Handle Alternate Email Entry Screen (account.live.com/proofs/Add or Let's protect your account)
  const emailInput = page.locator('input#EmailAddress, input[name="EmailAddress"], input#iProofEmail, input#txtEmail, input[type="email"], input[placeholder*="someone@example.com" i], input[placeholder*="example.com" i], input#proofInput, input[name="DisplayEmail"], input#Email').first();
  const isEmailPrompt = await emailInput.isVisible({ timeout: 4000 }).catch(() => false);

  if (isEmailPrompt) {
    if (!CONFIG.enableRecoveryEmail) {
      // Check again if there is a cancel/skip link on the email entry page
      if (await skipBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log('[SECURITY] Skipping recovery email setup prompt...');
        await clickHuman(page, skipBtn).catch(() => {});
        await sleep(2500);
        return { handled: true, skipped: true };
      }
    }

    if (!recoveryEmail) {
      recoveryEmail = generateGmailDotTrick();
    }
    console.log(`[SECURITY] Microsoft requested recovery/verification email. Using Gmail Dot-Trick: ${recoveryEmail}`);

    await emailInput.fill('');
    await fillHuman(page, emailInput, recoveryEmail);
    await sleep(500);

    const submitBtn = page.locator('#iNext, input#iNext, input[value="Next"], #iSignupAction, input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Send code"), button:has-text("Submit")').first();
    if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('[SECURITY] Submitting recovery email to receive OTP code...');
      await submitBtn.click();
      await sleep(3000);
    } else {
      await emailInput.press('Enter');
      await sleep(3000);
    }
  }

  // Step 2: Handle OTP Verification Screen (account.live.com/proofs/Verify or Enter code)
  const codeInput = page.locator('input#iOttText, input[name="iOttText"], input#iProofCode, input[name="iProofCode"], input#otcInput, input[name="otc"], input#txtCode, input[aria-label*="Enter the code" i], input[aria-label*="code" i]:not(#DisplayPhoneNumber)').first();
  const isVerifyUrl = page.url().includes('/proofs/Verify') || page.url().includes('proofs/verify');
  let isCodeVisible = (await codeInput.isVisible({ timeout: 1500 }).catch(() => false)) || isVerifyUrl;

  if (!isCodeVisible && isEmailPrompt) {
    // Wait up to 12s for transition to Enter Code screen
    isCodeVisible = await codeInput.waitFor({ state: 'visible', timeout: 12000 }).catch(() => false);
  }

  if (isCodeVisible || await codeInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!recoveryEmail) {
      const pageText = await page.innerText('body').catch(() => '');
      const emailMatch = pageText.match(/sent to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (emailMatch) {
        recoveryEmail = emailMatch[1];
        console.log(`[OTP] Detected target OTP email from page: ${recoveryEmail}`);
      } else {
        recoveryEmail = generateGmailDotTrick();
      }
    }

    console.log(`[OTP] Waiting for Microsoft verification code sent to ${recoveryEmail}...`);
    const otp = await (tempmail.waitForOtp ? tempmail.waitForOtp(recoveryEmail, 90000) : tempmail.waitForOTP(recoveryEmail, 90000));
    console.log(`[OTP] Received Microsoft verification code: ${otp}`);

    if (otp) {
      await codeInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await codeInput.fill('');
      await fillHuman(page, codeInput, otp);
      await sleep(600);

      const verifyBtn = page.locator('#iNext, input#iNext, input[value="Next"], #iSignupAction, input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Verify")').first();
      if (await verifyBtn.isVisible({ timeout: 800 }).catch(() => false)) {
        console.log('[OTP] Submitting verification code...');
        await clickHuman(page, verifyBtn);
        await sleep(4000);
      }
    }

    // Check for Stay Signed In prompt immediately after OTP verification
    const postOtpStayBtn = page.locator('#acceptButton, input[value="Yes"], button:has-text("Yes"), button:has-text("Stay signed in")').first();
    if (await postOtpStayBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[INFO] "Stay signed in?" prompt detected after OTP. Clicking Yes...`);
      await clickHuman(page, postOtpStayBtn);
      await sleep(2500);
    }

    return { handled: true, recoveryEmail, otp };
  }

  return { handled: isEmailPrompt, recoveryEmail };
}

async function handlePostOtpSteps(page) {
  let handledAny = false;

  // 1. Privacy Notice screen (privacynotice.account.microsoft.com)
  if (page.url().includes('privacynotice')) {
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button#acceptButton, input[value="Continue"], input[value="Next"], button:has-text("OK"), a:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`[INFO] Privacy Notice prompt detected. Clicking Continue...`);
      await clickHuman(page, continueBtn).catch(() => {});
      await sleep(3000);
      return true;
    }
  }

  // 2. Stay Signed In prompt
  const staySignedInBtn = page.locator('#acceptButton, input[value="Yes"], button:has-text("Yes"), button:has-text("Stay signed in")').first();
  if (await staySignedInBtn.isVisible({ timeout: 800 }).catch(() => false)) {
    console.log(`[INFO] "Stay signed in?" prompt detected. Clicking Yes...`);
    await clickHuman(page, staySignedInBtn).catch(() => {});
    await sleep(3000);
    return true;
  }

  // 3. Break free from your passwords / Passkey promo prompt
  const declinePasskeyBtn = page.locator('#declineButton, button#declineButton, button:has-text("No thanks"), button:has-text("Skip"), button:has-text("Skip for now"), a:text-is("Skip for now"), a:text-is("Cancel")').first();
  if (await declinePasskeyBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
    console.log(`[INFO] Promo/passkey prompt detected. Skipping...`);
    await clickHuman(page, declinePasskeyBtn).catch(() => {});
    await sleep(2000);
    return true;
  }

  // 4. Welcome / Get started prompt
  const getStartedBtn = page.locator('button:has-text("Get started"), button:has-text("Done"), button:has-text("Finish"), a:has-text("Get started")').first();
  if (await getStartedBtn.isVisible({ timeout: 800 }).catch(() => false)) {
    console.log(`[INFO] Welcome/Get started prompt detected. Clicking...`);
    await getStartedBtn.click().catch(() => {});
    await sleep(2000);
    return true;
  }

  return false;
}

async function setupMicrosoft2FA(page, account, tempmail) {
  console.log('\n[2FA] Navigating to Microsoft Security Proofs to configure 2FA...');
  await page.goto(CONFIG.securityProofsUrl, { timeout: 45000 }).catch(() => {});
  await sleep(3000);

  // Handle password re-entry if prompted
  const pwdInput = page.locator('input[type="password"], input[name="passwd"], input#i0118').first();
  if (await pwdInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('[2FA] Re-entering password for security access...');
    await fillHuman(page, pwdInput, account.password);
    await clickNext(page);
    await sleep(3500);
  }

  // Handle alternate email OTP if prompted to view security info
  await handleSecurityEmailOtpChallenge(page, tempmail, account.recoveryEmail);

  // Click "Add a new way to sign in or verify" or "Set up two-step verification"
  const addWaySelectors = [
    'a:has-text("Add a new way to sign in or verify")',
    'button:has-text("Add a new way to sign in or verify")',
    '#addProofLink',
    '[data-bi-name="AddProof"]',
    'a:has-text("Set up two-step verification")',
    'a:has-text("Turn on")'
  ];

  for (const sel of addWaySelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`[2FA] Clicking: "${sel}"...`);
      await btn.click();
      await sleep(2500);
      break;
    }
  }

  // Select "Use an app" / "Authenticator app"
  const appOptions = [
    'div:has-text("Use an app")',
    'span:has-text("Authenticator app")',
    '#appOption',
    '[data-value="App"]',
    'button:has-text("Use an app")'
  ];
  for (const sel of appOptions) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[2FA] Selecting Authenticator App option...');
      await el.click();
      await sleep(2500);
      break;
    }
  }

  // Click "I want to use a different authenticator app"
  const differentAppLinks = [
    'a:has-text("different authenticator app")',
    'a:has-text("Set up a different Authenticator app")',
    '#otherAppOption',
    'button:has-text("different authenticator app")'
  ];
  for (const sel of differentAppLinks) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[2FA] Choosing third-party/standard TOTP Authenticator app...');
      await el.click();
      await sleep(2500);
      break;
    }
  }

  // Click "Can't scan it?" / "Set up without a QR code" to reveal secret key text
  const cantScanLinks = [
    '#cantScanQR',
    '#cantScanLink',
    'a:has-text("Can\'t scan it")',
    'a:has-text("Set up without a QR code")',
    'a:has-text("manually")',
    'button:has-text("Can\'t scan it")'
  ];
  for (const sel of cantScanLinks) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('[2FA] Revealing manual Secret Key...');
      await el.click();
      await sleep(2000);
      break;
    }
  }

  // Extract Secret Key text (Base32, e.g. 16-32 uppercase chars)
  let secretKey = '';
  const keySelectors = [
    '#secretKey',
    'span#secretKeySpan',
    'input[readonly]',
    '[id*="secretKey" i]',
    '#manualSetupKey',
    'code'
  ];

  for (const sel of keySelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      const val = (await el.inputValue().catch(() => '')) || (await el.innerText().catch(() => ''));
      const clean = val.replace(/[\s-]/g, '').trim().toUpperCase();
      if (/^[A-Z2-7]{16,36}$/.test(clean)) {
        secretKey = clean;
        break;
      }
    }
  }

  if (!secretKey) {
    const bodyText = await page.innerText('body').catch(() => '');
    const match = bodyText.match(/\b([A-Z2-7]{16,32})\b/);
    if (match) {
      secretKey = match[1];
    }
  }

  if (secretKey) {
    console.log(`[2FA SUCCESS] Extracted 2FA TOTP Secret: ${secretKey}`);
    account.totpSecret = secretKey;

    await clickNext(page);
    await sleep(2000);

    const totpCode = generateTotpToken(secretKey);
    console.log(`[2FA] Generated dynamic 6-digit TOTP verification code: ${totpCode}`);

    const totpCodeInput = page.locator('input#Code, input[name="Code"], input[name="otc"], input#otcInput, input[placeholder*="code" i], input[type="tel"]').first();
    if (await totpCodeInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fillHuman(page, totpCodeInput, totpCode);
      await sleep(500);
      await clickNext(page);
      await sleep(3500);
      console.log('[2FA SUCCESS] 2FA Authenticator activated successfully!');
    }
    return true;
  } else {
    console.log('[2FA INFO] Secret Key field not found or 2FA setup skipped by Microsoft.');
    return false;
  }
}

/**
 * Spawn a local Google Chrome instance in incognito mode on a specified debugging port.
 */
async function ensureChromeRunning(executablePath = '/usr/bin/google-chrome-stable', port = 9222, proxy = null) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log(`Google Chrome with Remote Debugging is already running on port ${port}.`);
      return true;
    }

    console.log(`Spawning Google Chrome Stable Incognito on port ${port}...`);

    const tempProfileDir = `/tmp/chrome-debug-profile-outlook-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
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
        console.log('Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Google Chrome remote debugging port ${port} to respond.`);
  } catch (err) {
    console.error(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function loginAndSetup2FA(account, selectedProxy = '') {
  console.log(`\n========================================`);
  console.log(`[LOGIN FLOW] Opening fresh browser session for ${account.email}...`);
  console.log(`========================================`);

  const browserExecutable = CONFIG.browserExecutablePath;
  const isCam = isCamoufox(browserExecutable);
  const browserType = isCam ? firefox : chromium;
  const disableProxy = envFlag('DISABLE_PROXY', false);
  const proxy = disableProxy ? null : (selectedProxy || selectProxy(CONFIG.proxy));

  const launchOptions = {
    headless: CONFIG.headless,
  };

  let proxyConfig = null;
  if (proxy) {
    console.log(`[LOGIN] Using proxy: ${proxy}`);
    proxyConfig = proxyFromUrl(proxy);
    if (proxyConfig) {
      launchOptions.proxy = proxyConfig;
    } else {
      console.error(`[FATAL] Failed to parse proxy config for login: ${proxy}`);
      return false;
    }
  } else {
    console.log(`[LOGIN] Running without proxy (Direct connection)`);
  }

  const tempmail = new TempMail();
  let freshBrowser;
  let context;
  let page;
  let tempProfileDir = null;

  try {
    if (isCam) {
      console.log(`[LOGIN] Using Camoufox anti-detect browser (${browserExecutable})`);
      launchOptions.executablePath = browserExecutable;
      freshBrowser = await browserType.launch(launchOptions);
      context = await freshBrowser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'America/New_York' });
      page = await context.newPage();
    } else {
      console.log(`[LOGIN] Launching Chrome in Incognito mode with Stealth...`);
      const launchOpts = {
        headless: CONFIG.headless,
        ignoreHTTPSErrors: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--renderer-process-limit=2',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--incognito',
        ],
      };

      const chromePath = browserExecutable && browserExecutable !== 'random' ? browserExecutable : '/usr/bin/google-chrome-stable';
      if (chromePath) {
        launchOpts.executablePath = chromePath;
      }
      if (proxyConfig) {
        launchOpts.proxy = proxyConfig;
      }

      freshBrowser = await chromium.launch(launchOpts);
      context = await freshBrowser.newContext({
        viewport: CONFIG.headless ? { width: 1280, height: 800 } : null,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
    }

    await setupNetworkOptimization(page);

    const targetLoginUrl = 'https://login.live.com/';
    console.log(`[LOGIN] Navigating directly to ${targetLoginUrl}...`);
    await gotoWithRetry(page, targetLoginUrl, { timeout: CONFIG.stepTimeout });
    await sleep(2000);

    // 1. Enter Email (from CSV account)
    console.log(`[LOGIN] Waiting for Sign in email input field...`);
    const loginEmailInput = page.locator('input[type="email"], input[name="loginfmt"], input#i0116, input[placeholder*="email" i]').first();
    await loginEmailInput.waitFor({ state: 'visible', timeout: 30000 });
    console.log(`[LOGIN] Entering account email: ${account.email}`);
    await fillHuman(page, loginEmailInput, account.email);
    await clickNext(page);
    await sleep(3500);

    // 2. Enter Password (from CSV account)
    console.log(`[LOGIN] Waiting for Password input field...`);
    const loginPwdInput = page.locator('input[type="password"], input[name="passwd"], input#i0118, input[placeholder*="password" i]').first();
    await loginPwdInput.waitFor({ state: 'visible', timeout: 25000 });
    console.log(`[LOGIN] Entering account password...`);
    await fillHuman(page, loginPwdInput, account.password);
    await clickNext(page);
    await sleep(4000);

    // 3. Handle post-login state loop (Security email, OTP, Stay signed in, promo)
    const loginLoopStart = Date.now();
    while (Date.now() - loginLoopStart < 90000) {
      // Check for Stay Signed In prompt
      const staySignedInBtn = page.locator('#acceptButton, input[value="Yes"], button:has-text("Yes"), button:has-text("Stay signed in")').first();
      if (await staySignedInBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log(`[LOGIN] "Stay signed in?" prompt detected. Clicking Yes...`);
        await staySignedInBtn.click();
        await sleep(3000);
        continue;
      }

      // Check for Promo / Passkey decline (avoid matching footer links)
      const declineBtn = page.locator('#declineButton, button#declineButton, button:has-text("No thanks"), button:has-text("Skip"), button:has-text("Skip for now"), a:text-is("Skip for now"), a:text-is("Cancel")').first();
      if (await declineBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`[LOGIN] Promo/passkey prompt detected. Skipping...`);
        await declineBtn.click();
        await sleep(2500);
        continue;
      }

      // Check for Security Alternate Email or OTP ("Let's protect your account")
      const secResult = await handleSecurityEmailOtpChallenge(page, tempmail, account.recoveryEmail);
      if (secResult.handled) {
        if (secResult.recoveryEmail) account.recoveryEmail = secResult.recoveryEmail;
        await sleep(2500);
        continue;
      }

      // Check if logged into Outlook Mailbox
      const cur = page.url();
      if (cur.includes('outlook.live.com/mail') || cur.includes('/mail/0/')) {
        console.log(`[LOGIN SUCCESS] Outlook Mailbox loaded successfully! Current URL: ${cur}`);
        break;
      }

      await sleep(2000);
    }

    console.log(`[LOGIN FINISHED] Current URL: ${page.url()}`);

    // 4. Setup 2FA Authenticator & extract Secret Key
    try {
      await setupMicrosoft2FA(page, account, tempmail);
    } catch (e) {
      console.log(`[2FA WARN] 2FA setup failed or skipped: ${e.message}`);
    }

    return true;
  } catch (err) {
    console.error(`[LOGIN ERROR] Fresh browser login failed: ${err.message}`);
    return false;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (freshBrowser) {
      await freshBrowser.close().catch(() => {});
    }
    if (tempProfileDir) {
      try {
        if (fs.existsSync(tempProfileDir)) {
          fs.rmSync(tempProfileDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  }
}

async function finalizeRegistration(page, tempmail, account, currentRecoveryEmail) {
  if (CONFIG.enableRecoveryEmail && !account.recoveryEmail) {
    console.log(`[SECURITY] Proactively linking recovery email at https://account.live.com/proofs/Add...`);
    try {
      if (!page.url().includes('account.live.com/proofs/Add')) {
        await page.goto('https://account.live.com/proofs/Add', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      }
      await sleep(3000);
      const secRes = await handleSecurityEmailOtpChallenge(page, tempmail, currentRecoveryEmail);
      if (secRes.otp && secRes.recoveryEmail) {
        account.recoveryEmail = secRes.recoveryEmail;
        console.log(`[SECURITY] Successfully linked recovery email: ${account.recoveryEmail}`);
      } else {
        const curUrl = page.url();
        console.log(`[SECURITY WARN] Recovery email not linked yet (Current URL: ${curUrl})`);
        try {
          const parsed = new URL(curUrl);
          if (parsed.pathname.includes('/signup') || (parsed.hostname === 'login.live.com' && !parsed.pathname.includes('/ppsecure/post.srf'))) {
            console.log(`[SECURITY ERROR] Session not authenticated (registration was not actually completed). Aborting save.`);
            return false;
          }
        } catch (_) {}
      }
    } catch (err) {
      console.log(`[SECURITY WARN] Proactive recovery email linking failed: ${err.message}`);
    }
  }

  // Final confirmation check: verify page is not stuck on signup or error
  const finalCheckUrl = page.url();
  if (finalCheckUrl.includes('/signup?') || finalCheckUrl.includes('/error')) {
    console.log(`[WARN] Final validation check failed: URL is still ${finalCheckUrl}. Registration incomplete.`);
    return false;
  }

  console.log(`\n🎉 [SUCCESS] Account ${account.email} registered successfully! Saving to CSV and closing browser session...`);
  saveAccount(account);
  return true;
}

async function registerOutlook() {
  const account = generateAccount();
  const tempmail = new TempMail();
  let currentRecoveryEmail = '';
  let tempProfileDir = null;

  const screenshotsDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  console.log(`\n========================================`);
  console.log(`[START] Registering Outlook Account: ${account.email}`);
  console.log(`========================================`);

  const browserExecutable = CONFIG.browserExecutablePath;
  const isCam = isCamoufox(browserExecutable);
  const browserType = isCam ? firefox : chromium;
  const disableProxy = envFlag('DISABLE_PROXY', false);
  const selectedProxy = disableProxy ? null : selectProxy(CONFIG.proxy);
  let proxyConfig = null;
  if (selectedProxy) {
    console.log(`[PROXY] Using proxy: ${selectedProxy}`);
    proxyConfig = proxyFromUrl(selectedProxy);
  } else {
    if (!disableProxy && envFlag('BLOCK_DIRECT_CONNECTION', true)) {
      console.log(`[PROXY ERROR] No active proxies available in http_proxies.txt and BLOCK_DIRECT_CONNECTION is active. Direct connection blocked!`);
      return false;
    }
    console.log(`[PROXY] Running without proxy (Direct connection - recommended for Outlook)`);
  }

  let browser;
  let context;
  let page;

  try {
    if (isCam) {
      console.log(`[INFO] Launching Camoufox anti-detect browser (${browserExecutable})...`);
      const launchOptions = {
        headless: CONFIG.headless,
        executablePath: browserExecutable,
      };
      if (proxyConfig) {
        launchOptions.proxy = proxyConfig;
      }
      browser = await browserType.launch(launchOptions);
      context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'America/New_York' });
      page = await context.newPage();
    } else {
      console.log(`[INFO] Launching Google Chrome in Incognito mode with Stealth...`);
      const launchOpts = {
        headless: CONFIG.headless,
        ignoreHTTPSErrors: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--renderer-process-limit=2',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--incognito',
        ],
      };
      const chromePath = browserExecutable && browserExecutable !== 'random' ? browserExecutable : '/usr/bin/google-chrome-stable';
      if (chromePath) {
        launchOpts.executablePath = chromePath;
      }
      if (proxyConfig) {
        launchOpts.proxy = proxyConfig;
      }

      browser = await chromium.launch(launchOpts);
      context = await browser.newContext({
        viewport: CONFIG.headless ? { width: 1280, height: 800 } : null,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        ignoreHTTPSErrors: true,
      });
      page = await context.newPage();
    }

    await setupNetworkOptimization(page);

    console.log(`[1/5] Navigating to ${CONFIG.signupUrl}...`);
    await gotoWithRetry(page, CONFIG.signupUrl, { timeout: CONFIG.stepTimeout });
    await sleep(2500);

    // Step 1: Email
    console.log(`[2/5] Entering email: ${account.email}`);
    const [rawUsername, rawDomain] = account.email.split('@');
    const domainWithAt = `@${rawDomain}`;

    const emailInput = page.locator('input#MemberName, input#usernameInput, input[type="email"], input[name="MemberName"], input[name="email"], input[name="New email"], #floatingLabelInput4, input[id*="Input"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 25000 });

    // Check if domain dropdown selector or "Use your email instead" is present
    const hasDomainSelector = await page.locator([
      'select#LiveDomainBoxList',
      'select[name="LiveDomainBoxList"]',
      'button#liveDomainBoxListDropdown',
      '[data-testid*="LiveDomainBoxList"]',
      'div[role="combobox"]:has-text("@")',
      'button:has-text("@outlook")',
      'button:has-text("@hotmail")',
      'a:has-text("Use your email instead")',
      'button:has-text("Use your email instead")'
    ].join(', ')).first().isVisible({ timeout: 1500 }).catch(() => false);

    const domainSelect = page.locator('select#LiveDomainBoxList, select[name="LiveDomainBoxList"]').first();
    const domainDropdownBtn = page.locator('button#liveDomainBoxListDropdown, [data-testid*="LiveDomainBoxList"], div[role="combobox"]:has-text("@"), button:has-text("@outlook"), button:has-text("@hotmail")').first();

    if (await domainSelect.isVisible({ timeout: 500 }).catch(() => false)) {
      await domainSelect.hover({ timeout: 1500 }).catch(() => {});
      await sleep(rand(100, 250));
      await domainSelect.selectOption({ label: domainWithAt }).catch(async () => {
        await domainSelect.selectOption(rawDomain).catch(() => {});
      });
      console.log(`  [INFO] Selected domain dropdown: ${domainWithAt}`);
      await fillHuman(page, emailInput, rawUsername);
    } else if (await domainDropdownBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await clickHuman(page, domainDropdownBtn).catch(() => {});
      await sleep(300);
      const opt = page.locator(`[role="option"]:has-text("${rawDomain}"), [role="option"]:has-text("${domainWithAt}")`).first();
      if (await opt.isVisible().catch(() => false)) {
        await clickHuman(page, opt).catch(() => {});
      }
      console.log(`  [INFO] Selected domain button: ${domainWithAt}`);
      await fillHuman(page, emailInput, rawUsername);
    } else if (hasDomainSelector) {
      console.log(`  [INFO] Domain selector present on page. Entering username prefix: ${rawUsername}`);
      await fillHuman(page, emailInput, rawUsername);
    } else {
      await fillHuman(page, emailInput, account.email);
    }
    await sleep(500);

    await clickNext(page);

    // Check for "Enter the email address in the format someone@example.com" or "Email already taken"
    for (let retry = 0; retry < 3; retry++) {
      await sleep(1500);
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');

      // Case 1: Format error because full email was typed instead of username
      if (bodyText.includes('Enter the email address in the format') || bodyText.includes('someone@example.com')) {
        console.log(`  [WARN] Email format error detected. Resetting to username prefix only: ${rawUsername}`);
        await emailInput.fill('');
        await fillHuman(page, emailInput, rawUsername);
        await sleep(400);
        await clickNext(page);
        continue;
      }

      // Case 2: Email username already taken
      const isTaken = bodyText.includes('Someone already has this email address') || 
                      bodyText.includes('is not available') || 
                      bodyText.includes('already taken') ||
                      bodyText.includes("isn't available");

      if (isTaken) {
        const extraSuffix = `${rand(10, 99)}${Date.now().toString(36).slice(-3)}`;
        const newUsername = `${rawUsername}${extraSuffix}`;
        account.email = `${newUsername}@${rawDomain}`;
        console.log(`  [WARN] Email already taken. Retrying with new username: ${account.email}`);
        await emailInput.fill('');
        await fillHuman(page, emailInput, newUsername);
        await sleep(400);
        await clickNext(page);
      } else {
        break;
      }
    }
    
    // Step 2: Password (reactive wait)
    console.log(`[3/5] Entering password...`);
    const passwordInput = page.locator('input#Password, input#PasswordInput, input[type="password"], input[name="password"], input[name="Password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 35000 });
    await fillHuman(page, passwordInput, account.password);
    await sleep(500);

    await clickNext(page);

    // Step 3-5: Unified Reactive State Machine to handle Name, DOB, Verification in any order
    console.log(`[4/5] Processing registration forms (Name, DOB, Verification)...`);
    const startTime = Date.now();
    const maxWaitMs = 360000; // 6 minutes max
    let nameFilled = false;
    let dobFilled = false;
    let blankCount = 0;
    let challengeStartTime = null;
    const maxChallengeTimeoutMs = 240000; // 240s (4 min) max timeout for challenge screen to give full time for hold & redirect

    let loopCount = 0;
    while (Date.now() - startTime < maxWaitMs) {
      loopCount++;
      const currentUrl = page.url();

      // Watchdog: detect stuck challenge screen ("Help us beat the robots", "Press and hold", "Verify you are human")
      let pageText = '';
      for (const targetFrame of [page, ...page.frames()]) {
        try {
          const txt = await targetFrame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
          if (txt) pageText += ' ' + txt;
        } catch (_) {}
      }

      const nameFormVisible = await page.locator('input#firstNameInput, input[name="firstNameInput"], input[name="FirstName"], input#FirstName').first().isVisible().catch(() => false);
      const dobFormVisible = await page.locator('select#BirthMonth, select[name="BirthMonth"], button#BirthMonthDropdown, button[name="BirthMonth"], input#BirthYear, input[name="BirthYear"]').first().isVisible().catch(() => false);
      
      const challengeIframe = page.locator('iframe[src*="hsprotect.net"], iframe[src*="challenge"], iframe[src*="px"], iframe[src*="arkose"]').first();
      const hasVisibleChallengeIframe = await challengeIframe.isVisible().catch(() => false);

      let isChallengeScreen = !nameFormVisible && !dobFormVisible && (
        /help us beat the robots|press and hold|verify you are human|prove you're human|prove you are human|security challenge|captcha|tekan dan tahan/i.test(pageText) ||
        hasVisibleChallengeIframe
      );

      if (loopCount % 3 === 0) {
        console.log(`[LOOP DEBUG] #${loopCount} Url: ${currentUrl} | nameVisible: ${nameFormVisible} | dobVisible: ${dobFormVisible} | isChallenge: ${isChallengeScreen}`);
        if (!envFlag('DISABLE_SCREENSHOTS', false)) {
          const debugSsPath = path.join(__dirname, '..', 'screenshots', 'debug_loop.png');
          await page.screenshot({ path: debugSsPath }).catch(() => {});
        }
      }

      // Stabilization delay if challenge detected, to prevent race conditions during form transitions
      if (isChallengeScreen) {
        await sleep(1500);
        const nameVisibleNow = await page.locator('input#firstNameInput, input[name="firstNameInput"], input[name="FirstName"], input#FirstName').first().isVisible().catch(() => false);
        const dobVisibleNow = await page.locator('select#BirthMonth, select[name="BirthMonth"], button#BirthMonthDropdown, button[name="BirthMonth"], input#BirthYear, input[name="BirthYear"]').first().isVisible().catch(() => false);
        if (nameVisibleNow || dobVisibleNow) {
          isChallengeScreen = false;
        }
      }

      if (isChallengeScreen) {
        if (challengeStartTime === null) {
          challengeStartTime = Date.now();
          console.log(`[CHALLENGE] Challenge screen detected. Watchdog timer started (max 150s)...`);
        } else {
          const challengeElapsed = Date.now() - challengeStartTime;
          if (challengeElapsed > maxChallengeTimeoutMs) {
            console.log(`[CHALLENGE TIMEOUT] Challenge screen exceeded ${Math.round(maxChallengeTimeoutMs / 1000)}s without resolving. Aborting run to rotate proxy.`);
            return false;
          }
        }
      } else {
        challengeStartTime = null;
      }

      // Check for blank white page (empty body or zero interactive elements)
      const isBlank = await page.evaluate(() => {
        const body = document.body;
        if (!body) return true;
        const text = (body.innerText || '').trim();
        const interactive = document.querySelectorAll('input, button, select, a, iframe');
        return text.length === 0 && interactive.length === 0;
      }).catch(() => false);

      if (isBlank) {
        blankCount++;
        if (blankCount >= 2) {
          console.log(`[INFO] Blank white page detected (${blankCount}x). Refreshing page to reload form...`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await sleep(3000);
          blankCount = 0;
          continue;
        }
      } else {
        blankCount = 0;
      }

      // Check for "Something went wrong" / "Try again" button
      const tryAgainBtn = page.locator('button:has-text("Try again"), input[value="Try again"], button#idSIButton9, a:has-text("Try again")').filter({ hasText: /Try again/i }).first();
      if (await tryAgainBtn.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log(`[RETRY] "Something went wrong" screen detected. Clicking "Try again"...`);
        await tryAgainBtn.click().catch(() => {});
        await sleep(2500);
        continue;
      }

      // Check for Error / Blocked / Unavailable screen
      const isErrorUrl = currentUrl.includes('error.aspx') || currentUrl.includes('/error');
      const isBlocked = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        return body.includes('Account creation has been blocked') || 
               body.includes('blocked the creation of this account') ||
               body.includes('This site is temporarily unavailable') ||
               body.includes('We ran into a problem');
      });
      if (isErrorUrl || isBlocked) {
        console.log(`[BLOCKED/ERROR] Microsoft returned error or blocked account creation (automation flagged).`);
        if (!envFlag('DISABLE_SCREENSHOTS', false)) {
          const screenshotPath = path.join(__dirname, '..', 'screenshots', `outlook_block_${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath }).catch(() => {});
          console.log(`[BLOCKED/ERROR] Saved debug screenshot to: ${screenshotPath}`);
        }
        if (selectedProxy) {
          handleProxyFailure(selectedProxy, new Error('MICROSOFT_IP_BLOCKED'), { force: true });
        }
        return false;
      }

      // 1. If recovery email is enabled, process OTP challenge
      if (CONFIG.enableRecoveryEmail) {
        const secResult = await handleSecurityEmailOtpChallenge(page, tempmail, currentRecoveryEmail);
        if (secResult.handled) {
          if (secResult.recoveryEmail) currentRecoveryEmail = secResult.recoveryEmail;
          if (secResult.otp) account.recoveryEmail = secResult.recoveryEmail;
          await sleep(2500);
          continue;
        }
      }

      // 2. Always handle Post-Registration prompts (Stay Signed In, Privacy Notice, Passkeys, Welcome screens)
      let postPromptHandled = false;
      if (!isChallengeScreen && nameFilled && dobFilled) {
        postPromptHandled = await handlePostOtpSteps(page);
        if (postPromptHandled) {
          await sleep(2500);
        }
      }

      // 3. Check if registration is completed (redirected past /signup? or reached mailbox/account screen)
      const isProofsUrl = currentUrl.includes('/proofs/');
      const isPostSignupUrl = !isProofsUrl && !currentUrl.includes('/signup?') && (
        currentUrl.includes('ppsecure/post.srf') || 
        currentUrl.includes('privacynotice') ||
        currentUrl.includes('account.microsoft.com') || 
        currentUrl.includes('account.live.com') ||
        currentUrl.includes('outlook.live.com') || 
        currentUrl.includes('outlook.office.com') ||
        currentUrl.includes('login.live.com') ||
        currentUrl.includes('live.com/mail')
      );

      const hasPostSignupPrompt = !isChallengeScreen && !currentUrl.includes('/signup?') && (
        await page.locator('#kmsiTitle, #acceptButton, input[value="Yes"], input[value="No"], #iLandingViewAction, #iCancel, [aria-labelledby="kmsiTitle"]').first().isVisible({ timeout: 200 }).catch(() => false)
      );

      if ((dobFilled && (isPostSignupUrl || hasPostSignupPrompt || postPromptHandled)) || isPostSignupUrl) {
        return await finalizeRegistration(page, tempmail, account, currentRecoveryEmail);
      }

      // 1. Check for Name Form
      const firstNameInput = page.locator('input#firstNameInput, input[name="firstNameInput"], input[name="FirstName"], input#FirstName, input[placeholder*="first name" i], input[aria-label*="first name" i]').first();
      if (await firstNameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        if (!nameFilled) {
          console.log(`[NAME] Entering name: ${account.firstName} ${account.lastName}`);
          await sleep(rand(400, 900));
          await fillHuman(page, firstNameInput, account.firstName);
          await sleep(rand(600, 1200));

          const lastNameInput = page.locator('input#lastNameInput, input[name="lastNameInput"], input[name="LastName"], input#LastName, input[placeholder*="last name" i], input[aria-label*="last name" i]').first();
          if (await lastNameInput.isVisible().catch(() => false)) {
            await fillHuman(page, lastNameInput, account.lastName);
            await sleep(rand(800, 1500));
          }
          nameFilled = true;
        }

        await clickNext(page);
        await sleep(rand(2000, 3500));
        continue;
      }

      // 2. Check for DOB / Country Form
      const monthSelect = page.locator('select#BirthMonth, select[name="BirthMonth"], select[data-testid="BirthMonth"]').first();
      const monthDropdown = page.locator('button#BirthMonthDropdown, button[name="BirthMonth"]').first();
      const birthYearInput = page.locator('input#BirthYear, input[name="BirthYear"], input[data-testid="BirthYear"]').first();

      const isDobVisible = (await monthSelect.isVisible({ timeout: 600 }).catch(() => false)) || 
                           (await monthDropdown.isVisible({ timeout: 600 }).catch(() => false)) ||
                           (await birthYearInput.isVisible({ timeout: 600 }).catch(() => false));

      if (isDobVisible) {
        if (!dobFilled) {
          console.log(`[DOB] Filling Birth Date & Details...`);
        const randomMonth = String(rand(1, 12));
        const randomDay = String(rand(1, 28));
        const birthYear = String(rand(1985, 2002));

        // Country selection
        const targetCountry = CONFIG.country;
        if (targetCountry && targetCountry.toLowerCase() !== 'auto') {
          const countryCode = targetCountry.toUpperCase();
          let countryLabel = countryCode === 'US' ? 'United States' : (countryCode === 'ID' ? 'Indonesia' : countryCode);
          
          try {
            await page.evaluate(({ code, label }) => {
              const select = document.querySelector('select#Country, select#countryDropdownId, select[name="Country"], select[name="countryDropdownId"]');
              if (select) {
                for (let i = 0; i < select.options.length; i++) {
                  if (select.options[i].value === code || select.options[i].text.includes(label)) {
                    select.selectedIndex = i;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    break;
                  }
                }
              }
            }, { code: countryCode, label: countryLabel });
          } catch (_) {}

          const countrySelect = page.locator('select#Country, select#countryDropdownId, select[name="Country"], select[name="countryDropdownId"], select[data-testid*="Country"], select[aria-label*="Country"]').first();
          const countryBtn = page.locator('button#countryDropdownId, button#Country, button[name="Country"], button[aria-label*="Country"], [data-testid*="countryDropdown"]').first();

          const currentCountryText = await countryBtn.innerText().catch(() => '');
          if (currentCountryText && (currentCountryText.toLowerCase().includes(countryLabel.toLowerCase()) || countryLabel.toLowerCase().includes(currentCountryText.toLowerCase()))) {
            console.log(`[DOB] Country is already set to ${currentCountryText}. Skipping selection.`);
          } else {
            if (await countrySelect.isVisible({ timeout: 1000 }).catch(() => false)) {
              await countrySelect.selectOption({ label: countryLabel }).catch(async () => {
                await countrySelect.selectOption(countryCode).catch(() => {});
              });
              await sleep(200);
            } else if (await countryBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
              try {
                await clickHuman(page, countryBtn);
                await sleep(500);
                const opt = page.locator(`[role="option"]:has-text("${countryLabel}"), [role="option"][data-value="${countryCode}"]`).first();
                if (await opt.isVisible({ timeout: 1500 }).catch(() => false)) {
                  await clickHuman(page, opt);
                } else {
                  await page.keyboard.press(`Key${countryCode.charAt(0)}`);
                  await sleep(150);
                  await page.keyboard.press('Enter');
                }
                await sleep(400);
              } catch (_) {}
            }
          }
          console.log(`[DOB] Country selected: ${countryLabel} (${countryCode})`);
        } else {
          console.log(`[DOB] Country set to auto-detect (leaving default Microsoft selection)`);
        }

        // Month
        if (await monthSelect.isVisible({ timeout: 1000 }).catch(() => false)) {
          await monthSelect.hover({ timeout: 1500 }).catch(() => {});
          await sleep(rand(100, 250));
          await monthSelect.selectOption(randomMonth);
          await sleep(150);
        } else if (await monthDropdown.isVisible({ timeout: 1000 }).catch(() => false)) {
          await clickHuman(page, monthDropdown).catch(() => {});
          await sleep(rand(300, 500));
          
          const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
          ];
          const monthText = months[parseInt(randomMonth, 10) - 1];
          const opt = page.locator(`[role="option"]:has-text("${monthText}"), .fui-Option:has-text("${monthText}")`).first();
          if (await opt.isVisible().catch(() => false)) {
            await clickHuman(page, opt).catch(() => {});
          }
          await sleep(150);
        }

        // Day
        const daySelect = page.locator('select#BirthDay, select[name="BirthDay"], select[data-testid="BirthDay"]').first();
        const dayDropdown = page.locator('button#BirthDayDropdown, button[name="BirthDay"]').first();
        if (await daySelect.isVisible({ timeout: 1000 }).catch(() => false)) {
          await daySelect.hover({ timeout: 1500 }).catch(() => {});
          await sleep(rand(100, 250));
          await daySelect.selectOption(randomDay);
          await sleep(150);
        } else if (await dayDropdown.isVisible({ timeout: 1000 }).catch(() => false)) {
          await clickHuman(page, dayDropdown).catch(() => {});
          await sleep(rand(300, 500));
          
          const opt = page.locator(`[role="option"]:text-is("${randomDay}"), .fui-Option:text-is("${randomDay}")`).first();
          if (await opt.isVisible().catch(() => false)) {
            await clickHuman(page, opt).catch(() => {});
          }
          await sleep(150);
        }

        // Year
        if (await birthYearInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          await fillHuman(page, birthYearInput, birthYear);
          await sleep(rand(600, 1500));
        }
        dobFilled = true;
      }

      await clickNext(page);
      await sleep(rand(2000, 3500));
      continue;
    }

      // 6. Check for Press & Hold challenge (only when challenge screen is actively detected)
      if (isChallengeScreen) {
        // Try Press & Hold first
        const held = await handleHumanPressAndHold(page);
        if (held) {
          await sleep(2000);
          const postHoldUrl = page.url();
          if (!postHoldUrl.includes('/signup?') || postHoldUrl.includes('account.') || postHoldUrl.includes('login.') || postHoldUrl.includes('outlook.') || postHoldUrl.includes('ppsecure')) {
            return await finalizeRegistration(page, tempmail, account, currentRecoveryEmail);
          }
          continue;
        }

        // Fallback: try solving distorted text/image captcha via LLM
        const imageCaptchaSolved = await handleOutlookImageCaptcha(page);
        if (imageCaptchaSolved) {
          await sleep(2000);
          const postImageCaptchaUrl = page.url();
          if (!postImageCaptchaUrl.includes('/signup?') || postImageCaptchaUrl.includes('account.') || postImageCaptchaUrl.includes('login.') || postImageCaptchaUrl.includes('outlook.') || postImageCaptchaUrl.includes('ppsecure')) {
            return await finalizeRegistration(page, tempmail, account, currentRecoveryEmail);
          }
          continue;
        }

        // Final fallback to manual captcha entry
        console.log('[CHALLENGE] Automated challenge handling failed. Falling back to manual verification (30s)...');
        const solved = await waitForManualCaptcha(page, 30000);
        if (solved) {
          await sleep(2000);
          const postManualUrl = page.url();
          if (!postManualUrl.includes('/signup?') || postManualUrl.includes('account.') || postManualUrl.includes('login.') || postManualUrl.includes('outlook.') || postManualUrl.includes('ppsecure')) {
            return await finalizeRegistration(page, tempmail, account, currentRecoveryEmail);
          }
          continue;
        }

        // 7. Check for start button in challenge iframes
        for (const frame of page.frames()) {
          if (frame.url().includes('hsprotect.net') || frame.url().includes('challenge') || frame.url().includes('arkose')) {
            try {
              const startBtn = frame.locator('button:has-text("Next"), button:has-text("Start"), button:has-text("Verify"), button:has-text("Play")').first();
              if (await startBtn.isVisible({ timeout: 300 }).catch(() => false)) {
                await clickHuman(page, startBtn).catch(() => {});
              }
            } catch (_) {}
          }
        }
      }

      await sleep(1500);
    }

    const finalUrl = page.url();
    const isSuccess = !finalUrl.includes('/signup?') && !finalUrl.includes('error.aspx') && !finalUrl.includes('/proofs/') &&
      (finalUrl.includes('account.microsoft.com') || 
       finalUrl.includes('outlook.live.com') || 
       finalUrl.includes('ppsecure/post.srf') ||
       finalUrl.includes('privacynotice.account.microsoft.com'));

    if (isSuccess) {
      console.log(`[SUCCESS] Registered and logged in successfully in the same session! Final URL: ${finalUrl}`);
      await sleep(2000);
      saveAccount(account);
      return true;
    } else {
      console.log(`[WARN] Registration did not complete. Final URL: ${finalUrl}`);
      return false;
    }
  } catch (err) {
    if (selectedProxy) handleProxyFailure(selectedProxy, err, { force: true }); // Force blacklist and remove proxy on any registration failure
    console.error(`[ERROR] Registration failed:`, err.message);
    return false;
  } finally {
    if (context) {
      try {
        await Promise.race([
          context.close().catch(() => {}),
          new Promise(r => setTimeout(r, 3000))
        ]);
      } catch (_) {}
    }
    if (browser) {
      try {
        await Promise.race([
          browser.close().catch(() => {}),
          new Promise(r => setTimeout(r, 3000))
        ]);
      } catch (_) {}
    }
    if (tempProfileDir) {
      try {
        if (fs.existsSync(tempProfileDir)) {
          fs.rmSync(tempProfileDir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  }
}

if (require.main === module) {
  registerOutlook()
    .then(ok => {
      setTimeout(() => process.exit(ok ? 0 : 1), 300);
    })
    .catch(err => {
      console.error('Fatal execution error:', err.message);
      setTimeout(() => process.exit(1), 500);
    });
}

module.exports = { registerOutlook, register: registerOutlook };
