#!/usr/bin/env node
// registrars/register_outlook_graph.js
// Batch auto-generate Microsoft Graph API refresh tokens via Camoufox/Chromium + OAuth Device Code Flow
// Usage:
//   node registrars/register_outlook_graph.js          -> Process all unconfigured accounts from CSV
//   node registrars/register_outlook_graph.js <email>  -> Process a single specific account

const path = require('path');
const fs = require('fs');
const https = require('https');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');
loadEnv();

const {
  isCamoufox, browserTypeFor, resolveBrowserExecutablePath, envFlag,
  proxyFromUrl, selectProxy, markProxyDead, isProxyError, handleProxyFailure, setupNetworkOptimization,
} = require('../utils/browser.js');

const { sleep, rand, fillHuman, handleCookies } = require('../utils/helpers.js');
const { loadOutlookAccounts, saveOutlookRefreshToken, saveOutlookAccountData, removeOutlookAccountFromCsv } = require('../utils/email.js');
const TempMail = require('../services/tempmail/tempmail.js');

/**
 * Capture debug screenshot on error / block / captcha issue
 */
async function takeDebugScreenshot(page, email, reason = 'error', prefix = '') {
  if (envFlag('DISABLE_SCREENSHOTS', false) || !page) return;
  try {
    const screenshotsDir = path.join(__dirname, '..', 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const cleanEmail = String(email || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const ssPath = path.join(screenshotsDir, `graph_${reason}_${cleanEmail}_${Date.now()}.png`);
    await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});
    console.log(`  ${prefix} [SCREENSHOT] Saved debug screenshot to: ${ssPath}`);
  } catch (_) {}
}

/**
 * Handle Press & Hold challenge with natural human movement simulation
 */
async function handleHumanPressAndHold(page, prefix = '') {
  const maxHoldAttempts = 3;
  for (let holdAttempt = 1; holdAttempt <= maxHoldAttempts; holdAttempt++) {
    if (holdAttempt > 1) {
      console.log(`  ${prefix} [CHALLENGE] Hold attempt ${holdAttempt}/${maxHoldAttempts} (retrying with longer hold)...`);
      await sleep(rand(2000, 3500));
    }
    const held = await attemptPressAndHold(page, holdAttempt, prefix);
    if (held) return true;
  }
  return false;
}

async function attemptPressAndHold(page, holdAttempt = 1, prefix = '') {
  const allTargets = [page, ...page.frames()];
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
        'div[role="button"]:has-text("Tekan dan tahan")',
        'button:has-text("Tekan dan tahan")',
        '[aria-label*="tekan" i][aria-label*="tahan" i]',
        'div[role="button"]:has-text("Tekan dan tahan tombol ini")',
        ':text-is("Press and hold")',
        ':text-is("Tekan dan tahan")',
        ':text-is("Press and hold the button")'
      ];

      for (const sel of holdSelectors) {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 20 && box.height > 20) {
            console.log(`  ${prefix} [CHALLENGE] Detected Press & Hold button (${sel}). Simulating realistic human hold...`);
            
            const bodyText = await frame.innerText('body').catch(() => '');
            if (bodyText.includes('Please try again')) {
              console.log(`  ${prefix} [CHALLENGE] Cooldown detected ("Please try again"). Waiting 3s for reset...`);
              await sleep(3000);
            }

            await sleep(500);
            await el.hover({ timeout: 2000 }).catch(() => {});
            await sleep(rand(200, 400));
            await el.focus({ timeout: 2000 }).catch(() => {});
            await sleep(rand(150, 300));

            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;

            const startX = centerX + rand(-200, 200);
            const startY = centerY + rand(-150, 150);
            const ctrl1X = startX + (centerX - startX) * 0.3 + rand(-30, 30);
            const ctrl1Y = startY + (centerY - startY) * 0.3 + rand(-20, 20);
            const ctrl2X = centerX + rand(-15, 15);
            const ctrl2Y = centerY + rand(-10, 10);

            const moveSteps = rand(15, 25);
            for (let s = 0; s <= moveSteps; s++) {
              const t = s / moveSteps;
              const x = Math.pow(1-t, 3) * startX + 3 * Math.pow(1-t, 2) * t * ctrl1X + 3 * (1-t) * Math.pow(t, 2) * ctrl2X + Math.pow(t, 3) * centerX;
              const y = Math.pow(1-t, 3) * startY + 3 * Math.pow(1-t, 2) * t * ctrl1Y + 3 * (1-t) * Math.pow(t, 2) * ctrl2Y + Math.pow(t, 3) * centerY;
              await page.mouse.move(x, y);
              await sleep(rand(15, 40));
            }

            await sleep(rand(200, 500));
            await page.mouse.move(centerX + rand(-2, 2), centerY + rand(-2, 2), { steps: 3 });
            await sleep(rand(50, 120));

            await page.mouse.down();
            await page.mouse.move(centerX, centerY + rand(1, 3), { steps: 2 });
            console.log(`  ${prefix} [CHALLENGE] Button pressed. Holding with human-like micro-tremor...`);

            const holdStart = Date.now();
            const minDuration = holdAttempt <= 1 ? 7000 : (holdAttempt === 2 ? 9000 : 11000);
            const maxDuration = holdAttempt <= 1 ? 9000 : (holdAttempt === 2 ? 11000 : 13000);
            const targetDuration = rand(minDuration, maxDuration);
            let currentX = centerX;
            let currentY = centerY;

            let driftX = 0, driftY = 0;
            let tremorPhase = 0;

            while (Date.now() - holdStart < targetDuration) {
              await sleep(rand(50, 100));
              tremorPhase += rand(0.1, 0.3);

              const tremorX = Math.sin(tremorPhase) * rand(0.1, 0.5);
              const tremorY = Math.cos(tremorPhase * rand(1.1, 1.4)) * rand(0.1, 0.4);

              driftX += (Math.random() - 0.5) * 0.05;
              driftY += (Math.random() - 0.5) * 0.05;
              driftX = Math.max(-3, Math.min(3, driftX));
              driftY = Math.max(-3, Math.min(3, driftY));

              currentX = centerX + tremorX + driftX;
              currentY = centerY + tremorY + driftY;

              currentX = Math.max(box.x + 5, Math.min(box.x + box.width - 5, currentX));
              currentY = Math.max(box.y + 5, Math.min(box.y + box.height - 5, currentY));

              await page.mouse.move(currentX, currentY, { steps: 1 }).catch(() => {});

              const stillVisible = await el.isVisible({ timeout: 300 }).catch(() => false);
              const checkText = await frame.innerText('body').catch(() => '');
              if (!stillVisible || checkText.includes('Success') || checkText.includes('Verified') || checkText.includes('verified')) {
                console.log(`  ${prefix} [CHALLENGE] Challenge resolved early after ${((Date.now() - holdStart) / 1000).toFixed(1)}s!`);
                break;
              }
            }

            await page.mouse.move(currentX, currentY - rand(1, 2), { steps: 2 });
            await sleep(rand(30, 80));
            await page.mouse.up();
            console.log(`  ${prefix} [CHALLENGE] Button released after ${((Date.now() - holdStart) / 1000).toFixed(1)}s.`);
            await sleep(rand(1500, 2500));

            const postText = await frame.innerText('body').catch(() => '');
            const stillThere = await el.isVisible({ timeout: 500 }).catch(() => false);
            if (!stillThere || postText.includes('Success') || postText.includes('Verified') || postText.includes('verified')) {
              console.log(`  ${prefix} [CHALLENGE] Challenge PASSED!`);
              return true;
            }
            if (postText.includes('Please try again') || postText.includes('try again') || stillThere) {
              console.log(`  ${prefix} [CHALLENGE] Hold #${holdAttempt} failed. Will retry with longer hold...`);
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

function generateGmailDotTrick() {
  const allUsers = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);
  if (allUsers.length === 0) {
    throw new Error('Missing GMAIL_USER in .env for OTP verification.');
  }

  const baseEmail = allUsers[Math.floor(Math.random() * allUsers.length)];
  const atIdx = baseEmail.indexOf('@');
  if (atIdx === -1) return baseEmail;

  const rawUser = baseEmail.slice(0, atIdx);
  const domain = baseEmail.slice(atIdx + 1);
  const cleanUser = rawUser.replace(/\./g, '').split('+')[0];

  if (cleanUser.length <= 1) {
    return `${cleanUser}@${domain}`;
  }

  const positions = [];
  for (let i = 1; i < cleanUser.length; i++) {
    positions.push(i);
  }

  const numDots = Math.min(cleanUser.length > 5 ? 2 : 1, positions.length);
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

const CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || 'a48e86c0-e508-4b09-9d69-f735792ed3e3';
const SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';

function postForm(hostname, path_, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: path_,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function requestDeviceCode() {
  const res = await postForm(
    'login.microsoftonline.com',
    '/consumers/oauth2/v2.0/devicecode',
    `client_id=${encodeURIComponent(CLIENT_ID)}&scope=${encodeURIComponent(SCOPE)}`
  );

  if (res.status !== 200) {
    throw new Error(`Device code request failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function pollDeviceToken(deviceCode, intervalSec = 5, timeoutSec = 300) {
  const startTime = Date.now();
  const timeoutMs = timeoutSec * 1000;
  const pollIntervalMs = Math.max(intervalSec, 3) * 1000;

  while (Date.now() - startTime < timeoutMs) {
    await sleep(pollIntervalMs);

    const tokenRes = await postForm(
      'login.microsoftonline.com',
      '/consumers/oauth2/v2.0/token',
      `client_id=${encodeURIComponent(CLIENT_ID)}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(deviceCode)}`
    );

    if (tokenRes.status === 200 && tokenRes.body.refresh_token) {
      return tokenRes.body;
    }

    if (tokenRes.body && tokenRes.body.error === 'authorization_pending') {
      continue;
    }

    if (tokenRes.body && tokenRes.body.error === 'authorization_declined') {
      throw new Error('Authorization was declined in browser.');
    }

    if (tokenRes.body && tokenRes.body.error === 'expired_token') {
      throw new Error('Device code expired.');
    }

    if (tokenRes.status !== 200) {
      throw new Error(`Token polling error: ${JSON.stringify(tokenRes.body)}`);
    }
  }

  throw new Error(`Timed out waiting for device authorization (${timeoutSec}s).`);
}

async function processSingleAccount(account, index, total, workerId = 1) {
  const prefix = `[Worker #${workerId}]`;
  console.log(`\n============================================================`);
  console.log(`  ${prefix} [${index}/${total}] Processing: ${account.email}`);
  console.log(`  Recovery Email : ${account.recoveryEmail}`);
  console.log(`============================================================`);

  // 1. Request Device Code
  console.log(`  ${prefix} [1] Requesting device code...`);
  const deviceData = await requestDeviceCode();
  const userCode = deviceData.user_code;
  const verifyUrl = deviceData.verification_uri || 'https://microsoft.com/devicelogin';
  console.log(`  ${prefix} Code: ${userCode} | URL: ${verifyUrl}`);

  // 2. Launch Browser context with proxy support
  const execPath = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || 'camoufox');
  const isCam = isCamoufox(execPath);
  const disableProxy = envFlag('DISABLE_PROXY', false);
  const selectedProxy = disableProxy ? null : selectProxy('', { autoFetch: true });
  let proxyConfig = null;
  if (selectedProxy) {
    console.log(`  ${prefix} [PROXY] Using proxy: ${selectedProxy}`);
    proxyConfig = proxyFromUrl(selectedProxy);
  }

  let browser;
  let context;
  const chromeProfileDir = path.join(__dirname, '..', 'scratch', `.chrome_g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

  if (isCam) {
    browser = await browserTypeFor(execPath).launch({
      headless: envFlag('HEADLESS', true),
      args: ['--no-sandbox'],
      ignoreHTTPSErrors: true,
      ...(proxyConfig ? { proxy: { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password } } : {}),
      ...(execPath ? { executablePath: execPath } : {}),
    });
    context = await browser.newContext({
      viewport: null,
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      ignoreHTTPSErrors: true,
    });
  } else {
    context = await chromium.launchPersistentContext(
      chromeProfileDir,
      {
        headless: envFlag('HEADLESS', true),
        executablePath: execPath || undefined,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
        ignoreHTTPSErrors: true,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
        ...(proxyConfig ? { proxy: { server: proxyConfig.server, username: proxyConfig.username, password: proxyConfig.password } } : {}),
      }
    );
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await setupNetworkOptimization(page);

  try {
    console.log(`  ${prefix} [2] Navigating to verification link...`);
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(2500);

    let codeEntered = false;
    let emailEntered = false;
    let passwordEntered = false;
    let passwordAttempts = 0;
    let isLockedEncountered = false;
    let lookupIssueRetries = 0;
    let tempmail = null;
    const maxLoops = 40;

    for (let loop = 1; loop <= maxLoops; loop++) {
      const bodyText = await page.locator('body').innerText().catch(() => '');

      // Dismiss Microsoft cookie consent banner if present
      await handleCookies(page, 0);

      // Check confirmation text
      if (bodyText.includes('You have signed in to the') || bodyText.includes('You are all set') || bodyText.includes('All done!')) {
        console.log(`  ${prefix} [AUTH] Confirmation screen reached.`);
        break;
      }

      // Check for non-existent account (Fail fast)
      if (bodyText.includes("That Microsoft account doesn't exist") || bodyText.includes("couldn't find an account with that username")) {
        throw new Error(`ACCOUNT_DEAD: Microsoft account does not exist.`);
      }

      // Handle "Your account has been locked" Screen (Auto Recovery / Fast Fail)
      const isLockedScreen = bodyText.includes('Your account has been locked') || 
                             bodyText.includes('account has been locked') || 
                             bodyText.includes('violates our Microsoft Services Agreement');
      if (isLockedScreen) {
        isLockedEncountered = true;
        const lockNextBtn = page.locator('button[type="submit"], input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Next"), input[value="Next"], #iNext, button:has-text("Lanjut")').first();
        if (await lockNextBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`  ${prefix} [RECOVERY] "Your account has been locked" with Next button detected. Clicking Next...`);
          await lockNextBtn.click().catch(() => {});
          await sleep(1500);
          continue;
        } else {
          console.log(`  ${prefix} [PERM_LOCK] "Your account has been locked" with NO Next/Recovery button (Permanent Lock). Marking FAILED and skipping immediately...`);
          saveOutlookAccountData(account.email, { recovery_status: 'FAILED', status: 'LOCKED' });
          throw new Error(`ACCOUNT_LOCKED: Account is permanently locked with no verification option.`);
        }
      }

      // Handle "Let's prove you're human" / Press and Hold Challenge
      const isPressHoldScreen = bodyText.includes("Let's prove you're human") || 
                                bodyText.includes('prove you\'re human') || 
                                bodyText.includes('Press and hold') || 
                                bodyText.includes('Tekan dan tahan');
      const holdBtnVisible = await page.locator('div[role="button"]:has-text("Press and hold"), button:has-text("Press and hold"), #px-captcha, #sec-cpt-btn, div[role="button"]:has-text("Tekan dan tahan")').first().isVisible({ timeout: 400 }).catch(() => false);

      if (isPressHoldScreen || holdBtnVisible) {
        console.log(`  ${prefix} [CHALLENGE] Press & Hold human challenge detected! Simulating hold...`);
        const solved = await handleHumanPressAndHold(page, prefix);
        if (solved) {
          console.log(`  ${prefix} [CHALLENGE] Press & Hold solved! Waiting for page transition...`);
          await sleep(2500);
        } else {
          console.log(`  ${prefix} [WARN] Press & Hold attempt did not resolve yet, continuing loop...`);
          await sleep(1000);
        }
        continue;
      }

      // Step A: Device Code Input
      const codeInput = page.locator('input#otc, input[name="otc"], input#code, input[placeholder*="code" i]').first();
      if (!codeEntered && await codeInput.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] Entering user code: ${userCode}`);
        await fillHuman(page, codeInput, userCode);
        await sleep(200);
        const nextBtn = page.locator('input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Next"), input[value="Next"], button[type="submit"]').first();
        if (await nextBtn.isVisible({ timeout: 400 }).catch(() => false)) {
          await nextBtn.click();
        } else {
          await codeInput.press('Enter');
        }
        codeEntered = true;
        await sleep(1500);
        continue;
      }

      // Step B: Account tile picker
      const accountTile = page.locator(`[data-test-id*="${account.email}"], div[role="button"]:has-text("${account.email}"), div.table-cell:has-text("${account.email}")`).first();
      if (!emailEntered && await accountTile.isVisible({ timeout: 400 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] Clicking account tile for ${account.email}...`);
        await accountTile.click().catch(() => {});
        emailEntered = true;
        await sleep(1200);
        continue;
      }

      // Step C: Email input
      const emailInput = page.locator('input#usernameEntry, input#i0116, input[name="loginfmt"], input[type="email"]').first();
      if (!emailEntered && await emailInput.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] Entering email: ${account.email}`);
        await fillHuman(page, emailInput, account.email);
        await sleep(200);
        const nextBtn = page.locator('button[type="submit"], input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Next")').first();
        if (await nextBtn.isVisible({ timeout: 400 }).catch(() => false)) {
          await nextBtn.click();
        } else {
          await emailInput.press('Enter');
        }
        emailEntered = true;
        await sleep(1500);
        continue;
      }

      // Step C2: Retry Next if lookup timed out ("There was an issue looking up your account. Tap Next to try again.")
      if (bodyText.includes('issue looking up your account') || bodyText.includes('Tap Next to try again')) {
        lookupIssueRetries++;
        console.log(`  ${prefix} [AUTH] "Issue looking up account" detected (attempt ${lookupIssueRetries}/3)...`);
        if (lookupIssueRetries >= 3) {
          if (selectedProxy) markProxyDead(selectedProxy);
          throw new Error(`PROXY_LOOKUP_TIMEOUT: Proxy repeatedly failed Microsoft account lookup.`);
        }
        const retryNextBtn = page.locator('button[type="submit"], input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Next")').first();
        if (await retryNextBtn.isVisible({ timeout: 600 }).catch(() => false)) {
          await retryNextBtn.click().catch(() => {});
          await sleep(1500);
          continue;
        }
      }

function findMatchingRecoveryEmail(maskedText, defaultEmail) {
  if (!maskedText) return defaultEmail;
  const match = maskedText.match(/([a-zA-Z0-9.*]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (!match) return defaultEmail;
  const masked = match[1].toLowerCase();
  const [maskedUser, maskedDomain] = masked.split('@');
  const allCandidates = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);
  
  for (const cand of allCandidates) {
    const [candUser, candDomain] = cand.toLowerCase().split('@');
    if (maskedDomain && candDomain !== maskedDomain) continue;
    const cleanCandUser = candUser.replace(/\./g, '');
    const prefix = maskedUser.split('*')[0];
    if (prefix && (cleanCandUser.startsWith(prefix) || candUser.startsWith(prefix))) {
      return cand;
    }
  }
  return defaultEmail;
}

      // Step C3: "Something went wrong" / "Try again"
      const isSomethingWrong = bodyText.includes('Something went wrong') || 
                               bodyText.includes("problem with the service") ||
                               bodyText.includes('try again later');
      const tryAgainBtn = page.locator('button:has-text("Try again"), input[value="Try again"], button#idSIButton9, a:has-text("Try again")').filter({ hasText: /Try again/i }).first();
      if (isSomethingWrong || await tryAgainBtn.isVisible({ timeout: 300 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] "Something went wrong" screen detected. Clicking "Try again"...`);
        if (await tryAgainBtn.isVisible({ timeout: 600 }).catch(() => false)) {
          await tryAgainBtn.click().catch(() => {});
        } else {
          await page.keyboard.press('Enter').catch(() => {});
        }
        await sleep(2500);
        continue;
      }

      // Step D: "Send a code to ..." (Too many incorrect password attempts / OTP bypass)
      const sendCodeLink = page.locator('a, button, [role="link"], span').filter({ hasText: /Send a code to/i }).first();
      const isTooManyAttempts = bodyText.includes("tried to sign in too many times") || bodyText.includes('too many times with an incorrect');
      
      if (isTooManyAttempts) {
        if (await sendCodeLink.isVisible({ timeout: 300 }).catch(() => false)) {
          isLockedEncountered = true;
          const linkText = await sendCodeLink.innerText().catch(() => '');
          console.log(`  ${prefix} [AUTH] "Send a code to recovery email" link detected (${linkText}). Clicking...`);
          
          if (!account.recoveryEmail) {
            const matched = findMatchingRecoveryEmail(linkText, '');
            if (matched) {
              account.recoveryEmail = matched;
              console.log(`  ${prefix} [AUTH] Matched masked recovery email to: ${account.recoveryEmail}`);
            }
          }

          await sendCodeLink.click().catch(() => {});
          await sleep(2500);
        } else {
          console.log(`  ${prefix} [PERM_LOCK] Account is password-locked with NO recovery email linked. Marking FAILED and skipping immediately...`);
          saveOutlookAccountData(account.email, { recovery_status: 'FAILED', status: 'LOCKED' });
          return { success: false, reason: 'PERM_LOCKED_NO_RECOVERY' };
        }
      }

      // Step D1: Password input
      const pwdInput = page.locator('input[type="password"], input[name="passwd"], input#i0118, input#password').first();
      if (!isTooManyAttempts && await pwdInput.isVisible({ timeout: 600 }).catch(() => false)) {
        passwordAttempts++;
        if (passwordAttempts > 3) {
          const isWrongPwd = bodyText.includes('incorrect account or password') || 
                             bodyText.includes('password is incorrect') || 
                             bodyText.includes('Sign-in is blocked');
          if (isWrongPwd) {
            console.log(`  ${prefix} [AUTH ERROR] Microsoft indicated password is incorrect or blocked.`);
            throw new Error(`PASSWORD_INCORRECT: Microsoft rejected password for ${account.email}`);
          }
          console.log(`  ${prefix} [WARN] Password entered ${passwordAttempts - 1} times, waiting for page transition...`);
          await sleep(2500);
          continue;
        }
        console.log(`  ${prefix} [AUTH] Entering password (attempt ${passwordAttempts}/3)...`);
        await fillHuman(page, pwdInput, account.password);
        await sleep(300);
        const submitBtn = page.locator('button[type="submit"], input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Sign in"), button:has-text("Next")').first();
        if (await submitBtn.isVisible({ timeout: 400 }).catch(() => false)) {
          await submitBtn.click().catch(() => {});
        } else {
          await pwdInput.press('Enter').catch(() => {});
        }
        passwordEntered = true;
        await sleep(2000);
        continue;
      }

      // Step D2: "Verify your identity" (Existing Recovery Email verification or OTP screen)
      const isVerifyIdentityScreen = bodyText.includes('Verify your identity') || 
                                     bodyText.includes('We need to verify your identity') || 
                                     bodyText.includes('How would you like to get your security code') ||
                                     bodyText.includes('Enter code') ||
                                     bodyText.includes('We emailed a code');
      
      const proofConfirmInput = page.locator('input#proofConfirmationText, input[name="proofConfirmationText"], input#iProofEmail, input#proofInput').first();
      const otpCodeInput = page.locator('input#iOttText, input[name="iOttText"], input#iProofCode, input[name="iProofCode"], input#otcInput, input[name="otc"], input#txtCode, input[aria-label*="Enter the code" i], input[aria-label*="code" i]:not(#DisplayPhoneNumber)').first();

      if (isVerifyIdentityScreen || await proofConfirmInput.isVisible({ timeout: 400 }).catch(() => false) || await otpCodeInput.isVisible({ timeout: 400 }).catch(() => false)) {
        isLockedEncountered = true;
        console.log(`  ${prefix} [RECOVERY] "Verify your identity" security proof screen detected!`);
        
        // If there are options to choose (e.g. Email vs SMS vs App)
        const emailOption = page.locator('div[data-value*="Email" i], div.table-row:has-text("Email"), div[role="button"]:has-text("Email"), span:has-text("Email")').first();
        if (await emailOption.isVisible({ timeout: 600 }).catch(() => false)) {
          console.log(`  ${prefix} [RECOVERY] Selecting Email verification method...`);
          await emailOption.click().catch(() => {});
          await sleep(1500);
        }

        const recov = account.recoveryEmail || generateGmailDotTrick();
        if (await proofConfirmInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`  ${prefix} [RECOVERY] Inputting recovery email confirmation: ${recov}`);
          await proofConfirmInput.fill('');
          await fillHuman(page, proofConfirmInput, recov);
          await sleep(500);

          const sendCodeBtn = page.locator('button:has-text("Send code"), input[value="Send code"], #iNext, button[type="submit"], input[type="submit"], button#idSIButton9').first();
          if (await sendCodeBtn.isVisible({ timeout: 800 }).catch(() => false)) {
            await sendCodeBtn.click().catch(() => {});
            await sleep(3000);
          }
        }

        // Wait for OTP code input screen
        const codeVisible = await otpCodeInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => false);

        if (codeVisible || await otpCodeInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          if (!tempmail) tempmail = new TempMail();
          console.log(`  ${prefix} [OTP] Waiting for Microsoft verification code sent to ${recov}...`);
          const otp = await (tempmail.waitForOtp ? tempmail.waitForOtp(recov, 90000) : tempmail.waitForOTP(recov, 90000));

          if (otp) {
            console.log(`  ${prefix} [OTP] Received Microsoft verification code: ${otp}`);
            await otpCodeInput.fill('');
            await fillHuman(page, otpCodeInput, otp);
            await sleep(500);

            const verifyBtn = page.locator('#iNext, input#iNext, input[value="Next"], #iSignupAction, input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Verify"), button#idSIButton9').first();
            if (await verifyBtn.isVisible({ timeout: 800 }).catch(() => false)) {
              await verifyBtn.click();
              await sleep(4000);
            }

            saveOutlookAccountData(account.email, { recoveryEmail: recov });
            account.recoveryEmail = recov;
            console.log(`  ${prefix} [SUCCESS] Identity verified via ${recov}!`);
          } else {
            console.log(`  ${prefix} [WARN] OTP not received for ${recov}`);
          }
        }
        continue;
      }

      // Step D3: Detect Phone-Only verification barrier (SMS Required)
      if (bodyText.includes('Enter a phone number') || bodyText.includes('Enter your phone number') || bodyText.includes('Help us beat the robots')) {
        const phoneInput = page.locator('input[type="tel"], input#Phone, input[name="Phone"], input#iPhoneNumber').first();
        const hasAlternateMethod = page.locator('a:has-text("Use another option"), a:has-text("I have a code"), a:has-text("email")').first();
        if (await phoneInput.isVisible({ timeout: 500 }).catch(() => false) && !await hasAlternateMethod.isVisible({ timeout: 500 }).catch(() => false)) {
          throw new Error(`ACCOUNT_LOCKED: Microsoft strictly requires SMS phone verification.`);
        }
      }

      // Step D4: "Let's protect your account" / Alternate Email Setup
      const protectEmailInput = page.locator('input#EmailAddress, input[name="EmailAddress"], input#iProofEmail, input[placeholder*="someone@example.com" i], input[placeholder*="example.com" i], input#proofInput, input[name="DisplayEmail"]').first();
      const isProtectScreen = bodyText.includes("Let's protect your account") || bodyText.includes('protect your account') || bodyText.includes('Use a personal email');

      if (isProtectScreen || await protectEmailInput.isVisible({ timeout: 400 }).catch(() => false)) {
        isLockedEncountered = true;
        console.log(`  ${prefix} [SECURITY] "Let's protect your account" screen detected!`);
        if (!tempmail) tempmail = new TempMail();

        const recov = account.recoveryEmail || generateGmailDotTrick();
        console.log(`  ${prefix} [SECURITY] Inputting Gmail Dot-Trick recovery email: ${recov}`);

        const proofTypeSelect = page.locator('select#ProofType, select[name="ProofType"], select#proofType, select#iProofOptions, select#proof').first();
        if (await proofTypeSelect.isVisible({ timeout: 500 }).catch(() => false)) {
          await proofTypeSelect.selectOption({ label: 'An alternate email address' }).catch(async () => {
            await proofTypeSelect.selectOption('Email').catch(() => {});
          });
          await sleep(300);
        }

        if (await protectEmailInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          await protectEmailInput.fill('');
          await fillHuman(page, protectEmailInput, recov);
          await sleep(500);
        }

        const nextBtn = page.locator('#iNext, input#iNext, input[value="Next"], #iSignupAction, input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Send code")').first();
        if (await nextBtn.isVisible({ timeout: 800 }).catch(() => false)) {
          await nextBtn.click();
          await sleep(3000);
        }

        // Wait for OTP code input screen
        const codeInput = page.locator('input#iOttText, input[name="iOttText"], input#iProofCode, input[name="iProofCode"], input#otcInput, input[name="otc"], input#txtCode, input[aria-label*="Enter the code" i], input[aria-label*="code" i]:not(#DisplayPhoneNumber)').first();
        const codeVisible = await codeInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => false);

        if (codeVisible || await codeInput.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`  ${prefix} [OTP] Waiting for Microsoft verification code sent to ${recov}...`);
          const otp = await (tempmail.waitForOtp ? tempmail.waitForOtp(recov, 90000) : tempmail.waitForOTP(recov, 90000));

          if (otp) {
            console.log(`  ${prefix} [OTP] Received Microsoft verification code: ${otp}`);
            await codeInput.fill('');
            await fillHuman(page, codeInput, otp);
            await sleep(500);

            const verifyBtn = page.locator('#iNext, input#iNext, input[value="Next"], #iSignupAction, input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Verify")').first();
            if (await verifyBtn.isVisible({ timeout: 800 }).catch(() => false)) {
              await verifyBtn.click();
              await sleep(4000);
            }

            // Save recovery email immediately to CSV
            saveOutlookAccountData(account.email, { recoveryEmail: recov });
            account.recoveryEmail = recov;
            console.log(`  ${prefix} [SUCCESS] Recovery email ${recov} saved to CSV!`);
          } else {
            console.log(`  ${prefix} [WARN] OTP not received for ${recov}`);
          }
        }
        continue;
      }

      // Step E: "Use your password instead" link (Skip recovery OTP challenge)
      const passLinks = [
        page.locator('span[role="button"]:has-text("Use your password")').first(),
        page.locator('[role="button"]:has-text("Use your password")').first(),
        page.locator('button:has-text("Use your password")').first(),
        page.locator('a:has-text("Use your password")').first(),
        page.locator('a#idA_PWD_SwitchToPassword').first(),
        page.locator('a, [role="link"]').filter({ hasText: /use your password/i }).first(),
        page.locator('a, [role="link"]').filter({ hasText: /other ways to sign in/i }).first(),
      ];
      let clickedSwitch = false;
      for (const pLink of passLinks) {
        if (await pLink.isVisible({ timeout: 400 }).catch(() => false)) {
          console.log(`  ${prefix} [AUTH] Clicking "Use your password"...`);
          await pLink.click({ force: true }).catch(() => {});
          await sleep(2500);
          clickedSwitch = true;
          break;
        }
      }
      if (clickedSwitch) continue;

      // Step F: Consent Accept Permissions prompt
      const consentBtn = page.locator('button:has-text("Accept"), input[value="Accept"], button#idBtn_Accept, input#idBtn_Accept, button:has-text("Continue"), input[value="Continue"], button:has-text("Yes"), input[value="Yes"]').first();
      if (await consentBtn.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] Consent "Accept" button detected. Clicking Accept...`);
        await consentBtn.click().catch(() => {});
        await sleep(3500);
        continue;
      }

      // Step G: Stay signed in? prompt
      const kmsiBtn = page.locator('#acceptButton, input#idSIButton9, button#idSIButton9, input[value="Yes"], button:has-text("Yes"), button:has-text("Stay signed in")').first();
      if (await kmsiBtn.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] "Stay signed in?" prompt detected. Clicking Yes...`);
        await kmsiBtn.click().catch(() => {});
        await sleep(3000);
        continue;
      }

      // Step H: Promo / Skip passkey
      const skipBtn = page.locator('#declineButton, button#declineButton, button:has-text("No thanks"), button:has-text("Skip"), button:has-text("Skip for now"), a:text-is("Skip for now"), a:text-is("Cancel"), a#iCancel').first();
      if (await skipBtn.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log(`  ${prefix} [AUTH] Promo/Skip prompt detected. Clicking Skip...`);
        await skipBtn.click().catch(() => {});
        await sleep(2000);
        continue;
      }

      await sleep(1500);
    }

    console.log(`  ${prefix} [3] Waiting for token exchange response...`);
    const tokenResult = await pollDeviceToken(deviceData.device_code, 3, 180);
    const recovStatusVal = isLockedEncountered ? 'RECOVERED' : (account.recoveryStatus || '');
    saveOutlookAccountData(account.email, {
      refreshToken: tokenResult.refresh_token,
      status: 'ACTIVE',
      recoveryStatus: recovStatusVal,
    });
    console.log(`  ${prefix} [SUCCESS] Refresh token captured for ${account.email} (recoveryStatus: ${recovStatusVal || 'NORMAL'}) and saved to CSV!`);
    return true;

  } catch (err) {
    await takeDebugScreenshot(page, account.email, 'error', prefix);
    throw err;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    try {
      if (fs.existsSync(chromeProfileDir)) {
        fs.rmSync(chromeProfileDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

async function main() {
  console.log('=== Microsoft Graph API Batch Token Generator ===\n');

  const allAccounts = loadOutlookAccounts();

  if (allAccounts.length === 0) {
    console.error('[ERROR] No accounts found in data/outlook_accounts.csv');
    process.exit(1);
  }

  // Parse CLI args for email, concurrency, and locked recovery
  const args = process.argv.slice(2);
  let cliEmail = null;
  let concurrency = 1;
  const includeLocked = args.includes('--include-locked') || args.includes('--recovery') || args.includes('--all') || process.env.INCLUDE_LOCKED === 'true';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--concurrency=')) {
      concurrency = parseInt(arg.split('=')[1], 10) || 1;
    } else if (arg === '--concurrency' || arg === '-c') {
      concurrency = parseInt(args[++i], 10) || 1;
    } else if (arg.startsWith('-c=')) {
      concurrency = parseInt(arg.split('=')[1], 10) || 1;
    } else if (!arg.startsWith('-') && !cliEmail) {
      cliEmail = arg;
    }
  }

  if (process.env.CONCURRENCY && concurrency === 1) {
    concurrency = parseInt(process.env.CONCURRENCY, 10) || 1;
  }

  let targetAccounts = [];

  if (cliEmail) {
    const acc = allAccounts.find(a => a.email.toLowerCase() === cliEmail.toLowerCase());
    if (!acc) {
      console.error(`[ERROR] Account ${cliEmail} not found in CSV.`);
      process.exit(1);
    }
    targetAccounts = [acc];
  } else {
    // Filter target accounts (include locked if requested)
    const filterFn = includeLocked
      ? a => (!a.refreshToken || a.refreshToken.trim().length === 0) && a.status !== 'DEAD'
      : a => (!a.refreshToken || a.refreshToken.trim().length === 0) && a.status !== 'LOCKED' && a.status !== 'DEAD';

    targetAccounts = allAccounts.filter(filterFn);

    if (targetAccounts.length === 0) {
      console.log(`[INFO] All ${allAccounts.length} accounts already have refresh tokens configured in data/outlook_accounts.csv!`);
      if (!includeLocked) {
        console.log(`Tip: If you want to retry accounts previously marked LOCKED, run with: node registrars/register_outlook_graph.js --recovery`);
      }
      console.log(`To regenerate for a specific email, run: node registrars/register_outlook_graph.js <email>`);
      process.exit(99);
    }
  }

  concurrency = Math.max(1, Math.min(concurrency, targetAccounts.length));

  console.log(`Total Accounts to Process : ${targetAccounts.length}`);
  console.log(`Include Locked Accounts   : ${includeLocked ? 'YES' : 'NO'}`);
  console.log(`Concurrency               : ${concurrency} worker(s)`);
  console.log(`Client ID                 : ${CLIENT_ID}\n`);

  let currentIndex = 0;
  let successCount = 0;
  let failedCount = 0;

  async function worker(workerId) {
    while (true) {
      if (currentIndex >= targetAccounts.length) break;
      const idx = currentIndex++;
      const acc = targetAccounts[idx];

      try {
        let ok = false;
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            ok = await processSingleAccount(acc, idx + 1, targetAccounts.length, workerId);
            if (ok) break;
          } catch (err) {
            lastErr = err;
            if (err.message && (err.message.includes('NS_ERROR') || err.message.includes('Timeout') || err.message.includes('ECONNRESET') || err.message.includes('PROXY_LOOKUP_TIMEOUT'))) {
              console.log(`  [Worker #${workerId}] [PROXY RETRY] Network/Proxy failure detected for ${acc.email} (attempt ${attempt}/2). Retrying with new proxy...`);
              await sleep(2000);
              continue;
            }
            throw err;
          }
        }
        if (ok) {
          successCount++;
        } else {
          failedCount++;
          if (includeLocked) {
            removeOutlookAccountFromCsv(acc.email);
            console.log(`  [Worker #${workerId}] 🗑️  [CSV REMOVED] Removed failed/unrecoverable account from CSV: ${acc.email}`);
          }
        }
      } catch (err) {
        console.error(`  [Worker #${workerId}] [ERROR] Failed to process ${acc.email}:`, err.message);
        if (includeLocked) {
          removeOutlookAccountFromCsv(acc.email);
          console.log(`  [Worker #${workerId}] 🗑️  [CSV REMOVED] Removed failed/unrecoverable account from CSV: ${acc.email}`);
        } else if (err.message && err.message.includes('ACCOUNT_LOCKED')) {
          saveOutlookAccountData(acc.email, { status: 'LOCKED', recoveryStatus: 'FAILED' });
          console.log(`  [Worker #${workerId}] [CSV] Marked ${acc.email} as LOCKED (recoveryStatus: FAILED) in CSV.`);
        } else if (err.message && err.message.includes('ACCOUNT_DEAD')) {
          saveOutlookAccountData(acc.email, { status: 'DEAD', recoveryStatus: 'FAILED' });
          console.log(`  [Worker #${workerId}] [CSV] Marked ${acc.email} as DEAD in CSV.`);
        }
        failedCount++;
      }

      if (currentIndex < targetAccounts.length) {
        await sleep(2000);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log(`\n============================================================`);
  console.log(`  BATCH PROCESS COMPLETED`);
  console.log(`  Success : ${successCount}`);
  console.log(`  Failed  : ${failedCount}`);
  console.log(`============================================================\n`);

  const remainingFilterFn = includeLocked
    ? a => (!a.refreshToken || a.refreshToken.trim().length === 0) && a.status !== 'DEAD'
    : a => (!a.refreshToken || a.refreshToken.trim().length === 0) && a.status !== 'LOCKED' && a.status !== 'DEAD';

  const remaining = loadOutlookAccounts().filter(remainingFilterFn);
  if (remaining.length === 0) {
    console.log('[INFO] All target Outlook accounts now have refresh tokens! Stopping loop runner.');
    process.exit(99);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
