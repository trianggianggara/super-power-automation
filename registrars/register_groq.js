const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium, firefox } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const path = require('path');
const fs = require('fs');
const TempMail = require('../services/tempmail/tempmail.js');
const { 
  isCamoufox, 
  browserTypeFor, 
  resolveBrowserExecutablePath, 
  envFlag, 
  proxyFromUrl, 
  selectProxy, 
  handleProxyFailure 
} = require('../utils/browser.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');

const CONFIG = {
  loginUrl: 'https://console.groq.com/login',
  keysUrl: 'https://console.groq.com/keys',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'groq.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  emailTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
  proxy: process.env.PROXY || '',
};

function decodeQuotedPrintable(str) {
  if (!str) return '';
  let decoded = str.replace(/=\r?\n/g, '');
  decoded = decoded.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return decoded;
}

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Monitor Turnstile state changes via polling iframe DOM
async function monitorTurnstile(page, resolve, timeoutMs = 60000) {
  console.log('[INFO] monitorTurnstile started.');
  try {
    // 1. Wait for the Turnstile iframe to load and exist in DOM (max 10s)
    console.log('Waiting for Turnstile frame to appear...');
    let frame = null;
    for (let i = 0; i < 10; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    
    if (!frame) {
      console.log('Turnstile frame not found in frame list.');
      resolve(false);
      return;
    }

    // Wait longer to let layout settle
    console.log('Turnstile frame detected. Waiting 3s for layout to settle...');
    await page.waitForTimeout(3000);

    // 2. Loop to check for token and click the checkbox if needed
    console.log('Waiting for Turnstile response token to populate...');
    const startTime = Date.now();
    let clickCount = 0;
    let lastClickTime = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return;

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
        console.log(`✅ CAPTCHA SOLVED (Token found: ${tokenValue.substring(0, 15)}...)!`);
        resolve(true);
        return;
      }

      // Check if the Turnstile frame is still present
      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));

      if (!activeFrame) {
        console.log('Turnstile frame is no longer present. Checking if token appears...');
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
  } catch (err) {
    console.log(`[ERROR] monitorTurnstile failed: ${err.message}`);
  }
  resolve(false);
}

async function handleTurnstile(page, timeoutMs = 25000) {
  return new Promise((resolve) => {
    monitorTurnstile(page, resolve, timeoutMs);
  });
}

async function handleCookiesAndBanners(page) {
  try {
    const bannerBtn = page.locator('button:has-text("Accept"), button:has-text("Accept all"), button:has-text("Allow all"), button:has-text("I Agree"), button:has-text("Dismiss")').first();
    if (await bannerBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await bannerBtn.click();
      await sleep(1000);
    }
  } catch (_) {}
}

async function handleGroqOnboarding(page) {
  console.log('Checking for Groq onboarding/terms modal...');
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    // 1. Check for checkbox (Terms agreement)
    const termsCheckbox = page.locator('input[type="checkbox"]').first();
    if (await termsCheckbox.isVisible({ timeout: 1500 }).catch(() => false)) {
      const isChecked = await termsCheckbox.isChecked().catch(() => false);
      if (!isChecked) {
        console.log('  [Onboarding] Checking terms agreement checkbox...');
        await termsCheckbox.check().catch(() => {});
      }
    }

    // 2. Check for Organization or Name input if empty
    const orgInput = page.locator('input[placeholder*="Organization" i], input[name*="org" i], input[placeholder*="Name" i]').first();
    if (await orgInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      const val = await orgInput.inputValue().catch(() => '');
      if (!val) {
        console.log('  [Onboarding] Filling organization name...');
        await orgInput.fill('Personal');
        await sleep(500);
      }
    }

    // 3. Click any Agree / Accept / Continue / Next / Get Started / Submit button
    const actionBtn = page.locator([
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'button:has-text("Agree & Continue")',
      'button:has-text("Agree")',
      'button:has-text("Get Started")',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Done")',
      'button[type="submit"]:has-text("Submit")'
    ].join(', ')).first();

    if (await actionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const text = (await actionBtn.innerText().catch(() => '')).trim();
      console.log(`  [Onboarding] Clicking button: "${text}"...`);
      await actionBtn.click().catch(() => {});
      await sleep(3000);
    } else {
      break;
    }
  }
}

async function resolveBaseEmail() {
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
  let browser;
  let context;
  let page;
  let stepTimer;
  let selectedProxy = '';
  let tempProfileDir = '';

  const isGithubMode = process.argv.includes('--github') || 
    process.env.GROQ_SIGNUP_MODE === 'github' || 
    process.env.SIGNUP_MODE === 'github';

  function armStep(label, timeoutMs = CONFIG.stepTimeout) {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      console.error(`  TIMEOUT: ${label} stuck > ${Math.round(timeoutMs / 1000)}s. Closing browser, exiting...`);
      const forceExit = setTimeout(() => process.exit(1), 5000);
      if (forceExit.unref) forceExit.unref();
      Promise.resolve(context?.close?.() || browser?.close?.()).catch(() => {}).finally(() => process.exit(1));
    }, timeoutMs);
  }

  try {
    console.log('=== Groq Auto-Registration Script ===');
    console.log(`Mode: ${isGithubMode ? 'GitHub OAuth' : 'Direct Email OTP / Magic Link'}`);

    const tempmail = new TempMail();
    let email = '';
    let githubUsername = '';
    let githubPassword = CONFIG.password;

    if (isGithubMode) {
      const useExistingGithub = process.argv.includes('--use-existing-github') || 
        process.argv.includes('--existing') || 
        process.env.USE_EXISTING_GITHUB === 'true';
      const ghCsvPath = path.join(__dirname, '..', 'data', 'github_accounts.csv');

      if (process.env.GITHUB_EMAIL && process.env.GITHUB_PASSWORD) {
        email = process.env.GITHUB_EMAIL;
        githubUsername = process.env.GITHUB_USER || email.split('@')[0];
        githubPassword = process.env.GITHUB_PASSWORD;
        console.log(`[*] Using provided GitHub credentials: ${email}`);
      } else if (useExistingGithub && fs.existsSync(ghCsvPath)) {
        try {
          const ghContent = fs.readFileSync(ghCsvPath, 'utf8');
          const lines = ghContent.split('\n').map(l => l.trim()).filter(Boolean);
          const availableAccounts = [];
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',').map(p => p.replace(/^"|"$/g, '').trim());
            const [ts, em, pw, un, prx, status] = parts;
            if (em && pw && status !== 'suspended') {
              availableAccounts.push({ email: em, password: pw, username: un || em.split('@')[0] });
            }
          }

          // Check against groq.csv to avoid reusing same account
          const groqEmails = new Set();
          if (fs.existsSync(CONFIG.outputFile)) {
            const groqLines = fs.readFileSync(CONFIG.outputFile, 'utf8').split('\n').filter(Boolean);
            for (let i = 1; i < groqLines.length; i++) {
              const gEmail = groqLines[i].split(',')[1]?.replace(/^"|"$/g, '').trim().toLowerCase();
              if (gEmail) groqEmails.add(gEmail);
            }
          }

          const freshAccounts = availableAccounts.filter(a => !groqEmails.has(a.email.toLowerCase()));
          if (freshAccounts.length > 0) {
            const preferredAccounts = freshAccounts.filter(a => a.email.endsWith('@dellakuyang.com'));
            const pool = preferredAccounts.length > 0 ? preferredAccounts : freshAccounts;
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            email = chosen.email;
            githubUsername = chosen.username;
            githubPassword = chosen.password;
            console.log(`[*] Selected existing GitHub account from database (${pool.length} available): ${email}`);
          }
        } catch (err) {
          console.warn(`  [WARN] Failed reading github_accounts.csv: ${err.message}`);
        }
      }

      if (!email) {
        console.log('=== Registering fresh GitHub account for Groq ===');
        const { register: registerGithub, CONFIG: githubConfig } = require('./register_github.js');
        const githubResult = await registerGithub({ keepOpen: false });
        email = githubResult.email;
        githubUsername = githubResult.username;
        githubPassword = githubConfig.password || 'PortoAuto2025!';
      }
    } else {
      // Direct Email mode (Gmail Dot-Trick)
      const baseEmail = await resolveBaseEmail();
      const atIdx = baseEmail.indexOf('@');
      const username = baseEmail.slice(0, atIdx);
      const domainName = baseEmail.slice(atIdx + 1);
      const cleanUsername = username.replace(/\./g, '').split('+')[0];
      
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

      let attempts = 0;
      while (attempts < 1000) {
        let dottedUsername = cleanUsername;
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
      console.log(`Generated registration email (dot-trick): ${email}`);
    }

    console.log(`Target registration email: ${email}`);

    // Launch Browser Context
    armStep('Launching browser', CONFIG.launchTimeout);
    console.log('Launching browser...');

    const executablePathToUse = CONFIG.browserExecutablePath || undefined;
    const proxyArg = process.argv.find(a => a.startsWith('--proxy='))?.split('=')[1];
    const proxyToSelect = proxyArg || CONFIG.proxy;
    selectedProxy = envFlag('DISABLE_PROXY') ? '' : selectProxy(proxyToSelect);
    const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
    const isCam = isCamoufox(executablePathToUse);

    if (selectedProxyConfig) {
      console.log(`  Using proxy for Groq: ${selectedProxy}`);
    } else {
      console.log('  Using Direct connection (NO proxy) for Groq...');
    }

    const vpWidth = 1366 + rand(-20, 20);
    const vpHeight = 768 + rand(-10, 10);

    if (isCam) {
      console.log('  Launching Camoufox browser...');
      const launchOpts = {
        headless: envFlag('HEADLESS', false),
        args: ['--no-sandbox'],
        ignoreHTTPSErrors: true,
      };
      if (selectedProxyConfig) launchOpts.proxy = selectedProxyConfig;
      if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

      browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
      context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
    } else {
      console.log('  Launching Chromium/Brave persistent context...');
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_groq_${Date.now()}_${Math.floor(Math.random() * 100000)}`);
      
      const contextOpts = {
        headless: envFlag('HEADLESS', false),
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

    let loginSuccess = false;

    if (isGithubMode) {
      // ==========================================
      // GITHUB OAUTH REGISTRATION FLOW
      // ==========================================
      armStep('Navigating to Groq login page', 60000);
      console.log('Navigating to Groq login page...');
      await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3000);
      await handleCookiesAndBanners(page);

      armStep('Clicking Continue with GitHub', 180000);
      console.log('Looking for Continue with GitHub button...');
      const ghBtn = page.locator([
        'button:has-text("Continue with GitHub")',
        'a:has-text("Continue with GitHub")',
        'button:has-text("GitHub")',
        'a:has-text("GitHub")',
        'a[href*="github"]',
        'button[data-provider="github"]',
      ].join(', ')).first();

      await ghBtn.waitFor({ state: 'visible', timeout: 20000 });
      await ghBtn.click();

      const oauthStart = Date.now();
      await sleep(3000);

      while (Date.now() - oauthStart < 240000) {
        const currentUrl = page.url();
        let u;
        try { u = new URL(currentUrl); } catch (_) { u = { hostname: '', pathname: '' }; }
        console.log(`  [GitHub OAuth Loop] Host: ${u.hostname}, Path: ${u.pathname}`);

        // Success condition: back on Groq console (and not on login/callback page)
        const isConsoleGroq = (u.hostname === 'console.groq.com' || (u.hostname.includes('groq.com') && !u.hostname.includes('api.stytch') && !u.hostname.includes('stytch'))) && 
          !u.pathname.includes('login') && 
          !u.pathname.includes('callback') && 
          !u.pathname.includes('signup');

        if (isConsoleGroq) {
          console.log(`  [OAuth Success] Redirected back to Groq Console (${currentUrl})!`);
          loginSuccess = true;
          break;
        }

        // 1. GitHub Login Form
        const loginInput = page.locator('input#login_field, input[name="login"]').first();
        if (await loginInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  [GitHub Login] Submitting login credentials...');
          await fillHuman(page, loginInput, email);
          await sleep(500);
          const pwdInput = page.locator('input#password, input[name="password"]').first();
          await fillHuman(page, pwdInput, githubPassword);
          await sleep(500);
          const signInBtn = page.locator('input[type="submit"], input[value="Sign in"], button[type="submit"]').first();
          await signInBtn.click();
          await sleep(4000);
          continue;
        }

        // 2. GitHub Device OTP Verification
        const otpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"], input[name="app_otp"]').first();
        if (await otpInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          armStep('Waiting for GitHub device verification OTP', 180000);
          console.log('  [GitHub Login] Device verification OTP requested. Checking email...');
          const otpCode = await tempmail.waitForOtp(email, 120000, 5000, Date.now() - 60000);
          if (!otpCode) {
            throw new Error('Failed to retrieve GitHub login verification OTP from email.');
          }
          console.log(`  [GitHub Login] Submitting OTP: ${otpCode}`);
          await otpInput.fill(otpCode);
          await sleep(500);
          const verifyBtn = page.locator('button:has-text("Verify"), button.btn-primary').first();
          if (await verifyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await verifyBtn.click().catch(() => {});
          } else {
            await otpInput.press('Enter').catch(() => {});
          }
          await sleep(5000);
          continue;
        }

        // 3. GitHub OAuth Authorize Button
        const authButtons = page.locator([
          'button:has-text("Authorize groq")',
          'button:has-text("Authorize Groq")',
          'button:has-text("Authorize")',
          'button[name="authorize"]',
          'button#js-oauth-authorize-btn',
          'input[name="authorize"]',
          'input[value*="Authorize" i]',
          '[data-octo-click*="authorize"]'
        ].join(', '));

        const authCount = await authButtons.count().catch(() => 0);
        let clickedAuth = false;
        for (let i = 0; i < authCount; i++) {
          const btn = authButtons.nth(i);
          if (await btn.isVisible().catch(() => false)) {
            const btnText = (await btn.innerText().catch(() => '')).trim();
            const btnVal = (await btn.getAttribute('value').catch(() => '')) || '';
            const isCancel = btnText.toLowerCase().includes('cancel') || btnVal === '0';
            if (!isCancel) {
              console.log(`  [GitHub OAuth] Clicking Authorize button: "${btnText || 'Authorize'}" (index=${i})...`);
              await btn.scrollIntoViewIfNeeded().catch(() => {});
              await btn.click({ force: true }).catch(() => {});
              await btn.evaluate(el => {
                el.click();
                if (el.form) el.form.submit();
              }).catch(() => {});
              clickedAuth = true;
              await sleep(4000);
              break;
            }
          }
        }
        if (clickedAuth) continue;

        // 4. If back on login.groq.com / console.groq.com login page, try clicking github again
        if (currentUrl.includes('groq.com/login')) {
          const reloginGh = page.locator('button:has-text("Continue with GitHub"), a:has-text("Continue with GitHub"), button:has-text("GitHub")').first();
          if (await reloginGh.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('  [Groq] Clicking Continue with GitHub again on login page...');
            await reloginGh.click().catch(() => {});
            await sleep(4000);
            continue;
          }
        }

        await sleep(2000);
      }

      // Final check on GitHub page authorize if still on github.com
      if (page.url().includes('github.com')) {
        const finalAuthBtn = page.locator('button:has-text("Authorize"), button[name="authorize"], input[value*="Authorize" i]').first();
        if (await finalAuthBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('  [GitHub OAuth] Clicking final Authorize button...');
          await finalAuthBtn.scrollIntoViewIfNeeded().catch(() => {});
          await finalAuthBtn.click({ force: true }).catch(() => {});
          await finalAuthBtn.evaluate(el => { el.click(); if (el.form) el.form.submit(); }).catch(() => {});
          await sleep(5000);
        }
      }

      // Handle any onboarding screens on Groq
      await handleGroqOnboarding(page);

      loginSuccess = true;
    } else {
      // ==========================================
      // DIRECT EMAIL / MAGIC LINK FLOW
      // ==========================================
      for (let loginAttempt = 1; loginAttempt <= 5; loginAttempt++) {
        console.log(`\n[Login Attempt ${loginAttempt}/5] Starting login/signup flow...`);

        armStep('Navigating to Groq login page', 45000);
        console.log('Navigating to Groq login...');
        await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(3000);

        console.log('Fetching initial inbox messages to ignore old verifications...');
        const initialMessages = await tempmail.getMessages(email).catch(() => []);
        const ignoredIds = new Set(initialMessages.map(m => m.id));

        console.log('Filling email...');
        const emailInput = page.locator('input[type="email"], #email-input').first();
        await emailInput.fill(email);
        await sleep(1000);

        console.log('Clicking continue...');
        await page.locator('button[type="submit"]').first().click();
        await sleep(5000);

        armStep('Waiting for verification email', CONFIG.emailTimeout);
        console.log('Waiting for verification email...');
        let msg = null;
        const startTime = Date.now();
        while (Date.now() - startTime < CONFIG.emailTimeout) {
          try {
            const messages = await tempmail.getMessages(email);
            const newMsg = messages.find(m => !ignoredIds.has(m.id));
            if (newMsg) {
              msg = newMsg;
              break;
            }
          } catch (e) {
            console.error("  Polling error:", e.message);
          }
          await sleep(5000);
        }

        if (!msg) {
          throw new Error('Verification email not received for signup.');
        }

        const body = decodeQuotedPrintable(msg.text_body || msg.html_body || '');
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

        let magicLink = links.find(link => link.includes('stytch.com/v1/magic_links/redirect'));
        if (!magicLink) {
          magicLink = links.find(link => link.includes('magic_links'));
        }
        if (!magicLink) {
          console.log('  All parsed links:', links);
          throw new Error('Magic link not found in signup email.');
        }
        const cleanLink = magicLink.replace(/&amp;/g, '&');

        armStep('Opening Magic Link', 60000);
        console.log(`Opening Magic Link: ${cleanLink}`);
        await page.goto(cleanLink, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('Waiting for onboarding/redirect to complete...');
        await sleep(30000);

        // Check if we are still on the login/signup page
        const googleBtn = page.locator('button:has-text("Google"), button:has-text("google")').first();
        const stillOnLoginPage = await googleBtn.isVisible({ timeout: 3000 }).catch(() => false) || 
                                  await page.locator('input[type="email"], #email-input').first().isVisible({ timeout: 1000 }).catch(() => false);

        if (stillOnLoginPage) {
          console.log('  [WARNING] Still on login/signup page after opening magic link. Retrying login flow...');
          continue;
        }

        // Handle onboarding (terms/agreements or role/name questions) if visible
        const onboardingBtn = page.locator('button:has-text("Agree"), button:has-text("Accept"), button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first();
        if (await onboardingBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log('Found onboarding/agree button, clicking...');
          await onboardingBtn.click();
          await sleep(3000);
        }

        loginSuccess = true;
        break;
      }
    }

    if (!loginSuccess) {
      throw new Error('Failed to login/signup after attempts (stuck on login page).');
    }

    // ==========================================
    // API KEY CREATION & EXTRACTION
    // ==========================================
    armStep('Navigating to API Keys page', 60000);
    console.log('Navigating to API Keys page...');
    await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);

    console.log(`Current URL on keys page: ${page.url()}`);

    let keyCreated = false;
    let apiKey = '';
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      armStep(`Creating API key (attempt ${attempt}/3)`, 90000);
      console.log(`[Attempt ${attempt}/3] Trying to create API Key...`);
      
      const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first();

      // Check button visibility
      const createBtnSelectors = [
        'button:has-text("Create API Key")',
        'button:has-text("Create API key")',
        'button:has-text("Create key")',
        'button:has-text("New API Key")',
        'button:has-text("Create")',
      ];
      let buttonVisible = false;
      for (const selector of createBtnSelectors) {
        if (await page.locator(selector).first().isVisible({ timeout: 500 }).catch(() => false)) {
          buttonVisible = true;
          break;
        }
      }

      if (attempt > 1) {
        const turnstilePresent = await turnstileIframe.isVisible().catch(() => false);
        if (!turnstilePresent && !buttonVisible) {
          console.log('Refreshing page to reset state (no Turnstile and no Create Key button)...');
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(5000);
        } else {
          console.log(`Skipping refresh. Status - Turnstile present: ${turnstilePresent}, Button visible: ${buttonVisible}`);
        }
      }

      // Check if Turnstile challenge is present on the page
      let turnstileDetected = false;
      try {
        await turnstileIframe.waitFor({ state: 'visible', timeout: 5000 });
        turnstileDetected = true;
      } catch (_) {}

      if (turnstileDetected) {
        console.log('  Turnstile challenge detected on page. Solving Turnstile first...');
        const solved = await handleTurnstile(page, 30000).catch(() => false);
        console.log(`  Turnstile solver finished. Status: ${solved}`);
        await sleep(3000);
      }

      // Try finding "Create API Key" button
      let createBtn = null;
      for (const selector of createBtnSelectors) {
        const el = page.locator(selector).first();
        const text = await el.innerText().catch(() => '');
        if (await el.isVisible({ timeout: 1000 }).catch(() => false) && 
            (text.toLowerCase().includes('create') || text.toLowerCase().includes('key') || text.toLowerCase().includes('new'))) {
          createBtn = el;
          console.log(`Found Create Key button via selector: ${selector} ("${text}")`);
          break;
        }
      }

      if (!createBtn) {
        const buttons = page.locator('button');
        const bCount = await buttons.count().catch(() => 0);
        for (let i = 0; i < bCount; i++) {
          const b = buttons.nth(i);
          const text = (await b.innerText().catch(() => '')).toLowerCase();
          if (text.includes('create') && (text.includes('key') || text.includes('api'))) {
            createBtn = b;
            console.log(`Found Create Key button via loop: "${text}"`);
            break;
          }
        }
      }

      if (!createBtn) {
        console.log('  Create API Key button not found, retrying next attempt...');
        continue;
      }

      await createBtn.click();
      console.log('  Clicked Create Key button. Waiting for Turnstile challenge or modal name input...');

      const nameInput = page.locator([
        '[role="dialog"] input',
        '[aria-modal="true"] input',
        'input[placeholder*="Production" i]',
        'input[placeholder*="e.g." i]',
        'input[placeholder*="Key" i]',
        'input[placeholder*="name" i]',
        'input[placeholder*="Name" i]',
        'input'
      ].join(', ')).first();

      await nameInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

      if (!(await nameInput.isVisible().catch(() => false))) {
        console.log('  [WARN] Modal name input not found. Refreshing and retrying next attempt...');
        continue;
      }

      // Check if Turnstile challenge is present in the modal
      let turnstileInModalDetected = false;
      try {
        await turnstileIframe.waitFor({ state: 'visible', timeout: 5000 });
        turnstileInModalDetected = true;
      } catch (_) {}

      if (turnstileInModalDetected) {
        console.log('  Turnstile challenge detected in modal! Attempting to auto-solve...');
        await handleTurnstile(page, 30000).catch(() => false);
        await sleep(2000);
      }

      const keyName = `Porto-${Date.now()}`;
      console.log(`  Filling key name: ${keyName}...`);
      await nameInput.fill(keyName);
      await sleep(1000);

      // Click modal submit/create button
      const confirmBtn = page.locator([
        '[role="dialog"] button:has-text("Create")',
        '[role="dialog"] button:has-text("Submit")',
        '[role="dialog"] button:has-text("Save")',
        '[role="dialog"] button[type="submit"]',
        'button:has-text("Create API Key")',
        'button:has-text("Create")',
        'button[type="submit"]'
      ].join(', ')).first();

      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('  Clicking modal submit button...');
        await confirmBtn.evaluate(el => el.click()).catch(() => {});
        await sleep(5000);
      } else {
        console.log('  Confirm button not found, pressing Enter...');
        await nameInput.press('Enter');
        await sleep(5000);
      }

      // Extract API key from inputs
      const inputs = page.locator('input');
      const inputCount = await inputs.count().catch(() => 0);
      for (let i = 0; i < inputCount; i++) {
        const val = await inputs.nth(i).inputValue().catch(() => '');
        if (val.startsWith('gsk_')) {
          apiKey = val;
          break;
        }
      }

      // If not in input, extract from code elements
      if (!apiKey) {
        const codeElements = page.locator('code, pre');
        const cCount = await codeElements.count().catch(() => 0);
        for (let i = 0; i < cCount; i++) {
          const val = (await codeElements.nth(i).textContent().catch(() => '')).trim();
          if (val.startsWith('gsk_')) {
            apiKey = val;
            break;
          }
        }
      }

      // If not in elements, search textOnPage
      if (!apiKey) {
        const textOnPage = await page.innerText('body').catch(() => '');
        const keyMatch = textOnPage.match(/\b(gsk_[A-Za-z0-9_-]{30,80})\b/);
        if (keyMatch) {
          apiKey = keyMatch[0];
        }
      }

      if (apiKey) {
        console.log(`  Successfully created and extracted API Key: ${apiKey}`);
        keyCreated = true;
        break;
      } else {
        console.log('  Failed to find generated API key on page, retrying...');
      }
    }

    if (!keyCreated || !apiKey) {
      throw new Error('Failed to generate Groq API key after 3 attempts.');
    }

    // Dismiss modal if any
    const closeBtn = page.locator('button:has-text("Done"), button:has-text("Close"), button:has-text("Dismiss")').first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
      await sleep(1000);
    }

    // Save to groq.csv
    const timestamp = new Date().toISOString();
    const effectivePassword = isGithubMode ? githubPassword : CONFIG.password;
    const groqRow = [
      timestamp,
      email,
      effectivePassword,
      apiKey,
    ].map(csvCell).join(',');

    const groqExists = fs.existsSync(CONFIG.outputFile);
    if (!groqExists) {
      fs.writeFileSync(CONFIG.outputFile, 'timestamp,email,password,api_key\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, groqRow + '\n', 'utf8');
    console.log(`Saved credentials to ${CONFIG.outputFile}`);

    // Also append to global keys.csv
    const keysRow = [
      timestamp,
      email,
      effectivePassword,
      'auto',
      apiKey,
    ].map(csvCell).join(',');

    if (!fs.existsSync(CONFIG.keysFile)) {
      fs.writeFileSync(CONFIG.keysFile, 'timestamp,email,password,api_key_name,api_key\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.keysFile, keysRow + '\n', 'utf8');
    console.log(`Saved API key to global ${CONFIG.keysFile}`);

    console.log('\n========================================');
    console.log('  GROQ REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Mode:       ${isGithubMode ? 'GitHub OAuth' : 'Direct Email'}`);
    console.log(`  Email:      ${email}`);
    if (isGithubMode && githubUsername) console.log(`  GitHub:     ${githubUsername}`);
    console.log(`  Password:   ${effectivePassword}`);
    console.log(`  API Key:    ${apiKey}`);
    console.log('========================================\n');

    clearTimeout(stepTimer);
    return { email, password: effectivePassword, apiKey, username: githubUsername };

  } catch (err) {
    clearTimeout(stepTimer);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    throw err;
  } finally {
    clearTimeout(stepTimer);
    if (browser) {
      await browser.close().catch(() => {});
    } else if (context) {
      await context.close().catch(() => {});
    }
    try {
      if (tempProfileDir && fs.existsSync(tempProfileDir)) {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

if (require.main === module) {
  register().catch(err => {
    console.error('Fatal registration error:', err.message);
    process.exit(1);
  });
}

module.exports = { register, CONFIG };
