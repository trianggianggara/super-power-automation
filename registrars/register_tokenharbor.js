// TokenHarbor Auto-Registration Script using Playwright
const { loadEnv } = require('../utils/env.js');
loadEnv();

const fs = require('fs');
const path = require('path');
const { chromium, firefox } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const { register: registerGithub, CONFIG: githubConfig } = require('./register_github.js');
const TempMail = require('../services/tempmail/tempmail.js');
const { isCamoufox, envFlag } = require('../utils/browser.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');

const CONFIG = {
  inviteUrl: 'https://tokenharbor.ai/login?invite=TH-5A6A-JYPX',
  outputFile: path.join(__dirname, '..', 'data', 'tokenharbor.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  otpTimeout: 180000,
};

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function handleTokenHarborCookies(page) {
  try {
    const cookieBtn = page.locator('button:has-text("Accept analytics"), button:has-text("Essential only"), button:has-text("Accept all"), button:has-text("Allow all")').first();
    if (await cookieBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('  [Cookies] Clicking cookie consent button...');
      await cookieBtn.click();
      await sleep(1000);
    }
  } catch (err) {
    console.log('  [Cookies] No cookie banner found or error:', err.message);
  }
}

async function handleEnableFreeModels(page) {
  console.log('  [Free Models] Checking for "Enable free models" prompt...');
  try {
    const modalBtn = page.locator('button:has-text("Enable free models")').first();
    if (await modalBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('  [Free Models] Clicking Enable free models button...');
      await modalBtn.click();
      await sleep(2000);
    } else {
      const dashboardBtn = page.locator('button:has-text("Enable free models")').first();
      if (await dashboardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await dashboardBtn.click();
        await sleep(2000);
      }
    }
  } catch (err) {
    console.log('  [Free Models] [WARN] Error handling free models:', err.message);
  }
}

async function triggerAndVerifyEmail(page, email, tempmail) {
  console.log('  [Email Verification] Checking for Verify email button...');
  try {
    const verifyBtn = page.locator('button:has-text("Verify email"), button:has-text("verify email")').first();
    if (await verifyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('  [Email Verification] Clicking "Verify email" button...');
      await verifyBtn.click();
      await sleep(3000);
      
      console.log('  [Email Verification] Polling tempmail for verification link...');
      const startTime = Date.now();
      let verifyUrl = '';
      
      while (Date.now() - startTime < 90000) {
        const messages = await tempmail.getMessages(email);
        const newMessages = messages.filter(msg => {
          const recTime = Date.parse(msg.received_at);
          return isNaN(recTime) || recTime >= (startTime - 60000);
        });
        
        for (const msg of newMessages) {
          const body = (msg.text_body || '') + '\n' + (msg.html_body || '');
          const urlMatch = body.match(/https?:\/\/[^\s"'<>]+verify[^\s"'<>]+/i);
          if (urlMatch) {
            verifyUrl = urlMatch[0];
            verifyUrl = verifyUrl.replace(/&amp;/g, '&');
            console.log(`  [Email Verification] Found verification URL: ${verifyUrl}`);
            break;
          }
        }
        
        if (verifyUrl) break;
        await sleep(5000);
      }
      
      if (!verifyUrl) {
        throw new Error('Verification email not received or link not found.');
      }
      
       console.log('  [Email Verification] Navigating to verification link...');
      await page.goto(verifyUrl, { waitUntil: 'load', timeout: 30000 });
      await sleep(4000);
      await handleTurnstile(page, 15000);
      
      if (!page.url().includes('/dashboard')) {
        await page.goto('https://tokenharbor.ai/dashboard', { waitUntil: 'load', timeout: 30000 });
        await sleep(3000);
        await handleTurnstile(page, 15000);
      }
      console.log('  [Email Verification] Email verified successfully!');
      return true;
    } else {
      console.log('  [Email Verification] No "Verify email" button found (already verified?).');
    }
  } catch (err) {
    console.error('  [Email Verification] [ERROR] Verification failed:', err.message);
  }
  return false;
}

async function monitorTurnstile(page, resolve, timeoutMs = 20000) {
  console.log('  [Turnstile] Monitoring for Cloudflare Turnstile...');
  try {
    let frame = null;
    for (let i = 0; i < 5; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await sleep(1000);
    }
    
    if (!frame) {
      resolve(false);
      return;
    }

    await sleep(2000);

    const startTime = Date.now();
    let clickCount = 0;
    let lastClickTime = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return;

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
        console.log(`  [Turnstile] ✅ CAPTCHA SOLVED (Token found)!`);
        resolve(true);
        return;
      }

      const activeFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (!activeFrame) {
        await sleep(1000);
        continue;
      }

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
              console.log(`  [Turnstile] [Click #${clickCount}] Auto-clicking Turnstile checkbox: x=${clickX}, y=${clickY}`);
              await page.mouse.click(clickX, clickY).catch(() => {});
              lastClickTime = now;
            }
          }
        }
      }

      await sleep(2000);
    }
  } catch (err) {
    console.log(`  [Turnstile] [WARN] monitorTurnstile failed: ${err.message}`);
  }
  resolve(false);
}

async function handleTurnstile(page, timeoutMs = 20000) {
  return new Promise((resolve) => {
    monitorTurnstile(page, resolve, timeoutMs);
  });
}

async function claimWelcomeGift(page) {
  console.log('  [Gift] Waiting for "1 new gift to claim" badge/button to appear...');
  try {
    const giftBadge = page.locator(':text("1 new gift to claim"), button:has-text("gift to claim"), a:has-text("gift to claim"), [class*="gift" i]').first();
    await giftBadge.waitFor({ state: 'visible', timeout: 15000 });
    console.log('  [Gift] Clicking "1 new gift to claim" button...');
    await giftBadge.click();
    await sleep(3000);
    
    console.log('  [Gift] Waiting for "Claim" button inside modal...');
    const claimBtn = page.locator('div[role="dialog"]').locator('button:has-text("Claim")').first();
    await claimBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('  [Gift] Clicking "Claim" button...');
    await claimBtn.click();
    await sleep(3000);
    
    // Dismiss welcome success modal
    const dismissBtn = page.locator('button:has-text("OK"), button:has-text("Confirm"), button:has-text("Close"), button:has-text("Awesome")').first();
    if (await dismissBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await dismissBtn.click();
      await sleep(1000);
    }
    console.log('  [Gift] Welcome gift claimed successfully!');
    return true;
  } catch (err) {
    console.log('  [Gift] [WARN] Could not claim welcome gift:', err.message);
  }
  return false;
}

async function createAndVerifyApiKey(page, email, tempmail) {
  console.log('  [API Key] Navigating to API Keys section...');
  
  // Try navigating to API keys page first via direct URL, or by clicking dashboard links
  const targetUrl = 'https://tokenharbor.ai/dashboard/api-keys';
  try {
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 25000 });
    await sleep(3000);
    await handleTurnstile(page, 15000);
  } catch (err) {
    console.log('  [API Key] Direct navigation to /api-keys failed, trying menu click...');
    const menuSelectors = [
      'a[href*="api-keys" i]',
      'a[href*="keys" i]',
      'a:has-text("API Keys")',
      'a:has-text("Keys")',
      'span:has-text("API Keys")',
    ];
    for (const sel of menuSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        await sleep(3000);
        await handleTurnstile(page, 15000);
        break;
      }
    }
  }

  console.log('  [API Key] Creating a new API key...');
  const createBtnSelectors = [
    'button:has-text("Create key" i)',
    'button:has-text("Create API Key" i)',
    'button:has-text("Create Token" i)',
    'button:has-text("Create" i)',
    'button:has-text("New Key" i)',
    'button:has-text("Add Key" i)',
    'a:has-text("Create key" i)',
  ];

  let createBtn = null;
  for (const sel of createBtnSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      createBtn = el;
      break;
    }
  }

  if (!createBtn) {
    // Fallback locator
    createBtn = page.locator('button').filter({ hasText: /key|token|create|add/i }).first();
    if (!(await createBtn.isVisible().catch(() => false))) {
      throw new Error('Could not locate "Create Key" button on the page.');
    }
  }

  console.log('  [API Key] Clicking Create Key button...');
  await createBtn.click();
  await sleep(1500);

  // Fill key label if prompt/input is visible
  const keyLabelInput = page.locator('input[placeholder*="name" i], input[placeholder*="label" i], input[type="text"]').first();
  if (await keyLabelInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    const label = 'auto-key-' + Date.now().toString(36);
    await keyLabelInput.fill(label);
    await sleep(500);
  }

  // Click Submit/Confirm
  const confirmBtn = page.locator('button:has-text("Create key"), button:has-text("Create"), button:has-text("Confirm"), button:has-text("Submit"), button[type="submit"]').first();
  try {
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  [API Key] Clicking Confirm button...');
    await confirmBtn.click();
    await sleep(2000);
  } catch (err) {
    console.log('  [API Key] [WARN] Confirm button not visible or could not be clicked:', err.message);
  }

  // Wait for OTP/Verification code step if triggered
  console.log('  [API Key] Checking for OTP/Verification prompt to reveal API key...');
  const otpInput = page.locator('input[placeholder*="code" i], input[placeholder*="otp" i], input[placeholder*="verification" i], input[id*="otp" i]').first();
  const isOtpVisible = await otpInput.isVisible({ timeout: 8000 }).catch(() => false);
  
  if (isOtpVisible) {
    console.log(`  [API Key] OTP code requested. Waiting for email verification code on ${email}...`);
    const otpCode = await tempmail.waitForOtp(email, CONFIG.otpTimeout, 5000, Date.now() - 60000);
    if (!otpCode) {
      throw new Error('Failed to retrieve TokenHarbor API Key creation OTP from email.');
    }
    console.log(`  [API Key] Retrieved OTP Code: ${otpCode}`);

    await otpInput.focus();
    await otpInput.fill(otpCode);
    await sleep(1000);

    const verifyBtn = page.locator('button:has-text("Verify" i), button:has-text("Confirm" i), button:has-text("Submit" i), button[type="submit"]').first();
    if (await verifyBtn.isVisible().catch(() => false)) {
      await verifyBtn.click();
    } else {
      await otpInput.press('Enter');
    }
    await sleep(4000);
  } else {
    console.log('  [API Key] No direct OTP modal visible immediately. Checking if "View" / "Reveal" button is visible...');
    // Sometimes key is created masked, clicking "View" / "Reveal" triggers OTP
    const viewBtn = page.locator('button:has-text("View" i), button:has-text("Reveal" i), [class*="eye" i]').first();
    if (await viewBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('  [API Key] Clicking Reveal/View button...');
      await viewBtn.click();
      await sleep(2000);
      
      const otpInputReveal = page.locator('input[placeholder*="code" i], input[placeholder*="otp" i], input[id*="otp" i]').first();
      if (await otpInputReveal.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`  [API Key] OTP requested. Polling email ${email}...`);
        const otpCode = await tempmail.waitForOtp(email, CONFIG.otpTimeout, 5000, Date.now() - 60000);
        if (!otpCode) {
          throw new Error('Failed to retrieve reveal OTP from email.');
        }
        console.log(`  [API Key] OTP Code: ${otpCode}`);
        await otpInputReveal.fill(otpCode);
        await sleep(1000);
        
        const submitReveal = page.locator('button:has-text("Verify" i), button:has-text("Submit" i), button:has-text("Confirm" i)').first();
        if (await submitReveal.isVisible().catch(() => false)) {
          await submitReveal.click();
        } else {
          await otpInputReveal.press('Enter');
        }
        await sleep(4000);
      }
    }
  }

  // Retrieve revealed API key
  console.log('  [API Key] Extracting API key value...');
  let apiKey = '';

  // Look for text matching thk_... pattern
  const textOnPage = await page.locator('body').innerText().catch(() => '');
  const keyMatch = textOnPage.match(/thk_[A-Za-z0-9_-]{20,}/);
  if (keyMatch) {
    apiKey = keyMatch[0];
  }

  if (!apiKey) {
    // Try copying to clipboard or reading from visible input fields
    const copyBtn = page.locator('button:has-text("Copy" i), [class*="copy" i]').first();
    if (await copyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('  [API Key] Clicking Copy button...');
      await copyBtn.click();
      await sleep(1000);
      try {
        apiKey = await Promise.race([
          page.evaluate(() => navigator.clipboard.readText()),
          new Promise(resolve => setTimeout(() => resolve(''), 1500))
        ]);
      } catch (_) {}
    }
  }

  if (!apiKey) {
    const inputKeyField = page.locator('input[readonly], input[value*="thk_" i]').first();
    if (await inputKeyField.isVisible({ timeout: 2000 }).catch(() => false)) {
      apiKey = await inputKeyField.inputValue();
    }
  }

  if (!apiKey) {
    throw new Error('Failed to extract/reveal the API Key.');
  }

  console.log(`  [API Key] Successfully retrieved: ${apiKey}`);
  return apiKey;
}

async function launchTokenHarborBrowser() {
  let executablePathToUse = githubConfig.browserExecutablePath || undefined;
  if (executablePathToUse && executablePathToUse.toLowerCase() === 'random') {
    const allBrowsers = [
      '/home/nbs59/.cache/camoufox/camoufox',
      '/home/nbs59/.local/share/brave-bin/opt/brave.com/brave/brave-browser',
      '/usr/bin/google-chrome-stable',
      '/home/nbs59/.cloakbrowser/chromium-146.0.7680.177.5/chrome'
    ];
    executablePathToUse = allBrowsers[Math.floor(Math.random() * allBrowsers.length)];
  }
  
  const isCam = isCamoufox(executablePathToUse);
  
  console.log(`Launching fresh browser context for TokenHarbor (Headless: ${envFlag('HEADLESS')})...`);
  
  const launchOpts = {
    headless: envFlag('HEADLESS'),
    args: ['--no-sandbox'],
    ignoreHTTPSErrors: true,
  };
  
  if (!isCam) {
    launchOpts.args.push('--disable-blink-features=AutomationControlled');
  }
  
  if (executablePathToUse) {
    launchOpts.executablePath = executablePathToUse;
  }
  
  let browser;
  let context;
  
  if (isCam) {
    const { firefox: firefoxExtra } = require('playwright-extra');
    browser = await firefoxExtra.launch(launchOpts);
    context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
  } else {
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      ignoreHTTPSErrors: true
    });
  }
  
  const page = await context.newPage();
  return { browser, context, page };
}

async function run() {
  console.log('=== Starting TokenHarbor Auto-Registration ===');
  let email = '';
  let username = '';

  try {
    // Step 1: Register GitHub account and close it immediately
    console.log('=== Step 1: Registering GitHub account (with proxy) ===');
    const githubResult = await registerGithub({ keepOpen: false });
    email = githubResult.email;
    username = githubResult.username;
  } catch (err) {
    console.error('[FATAL] GitHub registration failed, aborting TokenHarbor signup:', err.message);
    process.exit(1);
  }

  // Get GitHub password from registration config
  const githubPassword = githubConfig.password || 'PortoAuto2025!';

  // Step 2: Launch a fresh browser context without proxy for TokenHarbor
  console.log('=== Step 2: Launching fresh browser (NO proxy) for TokenHarbor ===');
  let thSession;
  try {
    thSession = await launchTokenHarborBrowser();
  } catch (err) {
    console.error('[FATAL] Failed to launch non-proxy browser context for TokenHarbor:', err.message);
    process.exit(1);
  }

  const { browser, context, page } = thSession;

  try {
    // Navigate to TokenHarbor Invite URL
    console.log(`[1/5] Navigating to TokenHarbor: ${CONFIG.inviteUrl}`);
    await page.goto(CONFIG.inviteUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(async (err) => {
      console.log(`  [WARN] Initial navigation to TokenHarbor failed (${err.message}). Retrying...`);
      await page.goto(CONFIG.inviteUrl, { waitUntil: 'load', timeout: 45000 });
    });
    await sleep(3000);

    // Accept cookies
    await handleTokenHarborCookies(page);

    // Step 2: Click Continue with GitHub
    console.log('[2/5] Clicking Continue with GitHub...');
    const ghBtn = page.locator('button[aria-label="Continue with GitHub"]').first();
    await ghBtn.waitFor({ state: 'visible', timeout: 10000 });
    await ghBtn.click();
    await sleep(4000);

    // Handle optional GitHub sign in
    const githubLoginInput = page.locator('input#login_field, input[name="login"]').first();
    if (await githubLoginInput.isVisible({ timeout: 6000 }).catch(() => false)) {
      console.log('  [GitHub Login] GitHub login page visible. Entering credentials...');
      await githubLoginInput.fill(email);
      await sleep(500);
      const githubPasswordInput = page.locator('input#password, input[name="password"]').first();
      await githubPasswordInput.fill(githubPassword);
      await sleep(500);
      
      const githubSignInBtn = page.locator('input[type="submit"], input[value="Sign in"]').first();
      await githubSignInBtn.click();
      await sleep(5000);
    }

    // Handle GitHub OTP code if triggered
    const githubOtpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"]').first();
    if (await githubOtpInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('  [GitHub Login] GitHub device verification code requested. Waiting for email...');
      const tempmail = new TempMail();
      const otpCode = await tempmail.waitForOtp(email, 120000, 5000, Date.now() - 60000);
      if (!otpCode) {
        throw new Error('Failed to retrieve GitHub login verification OTP from email.');
      }
      console.log(`  [GitHub Login] Entering verification code: ${otpCode}`);
      await githubOtpInput.fill(otpCode);
      await sleep(500);
      
      const verifyBtn = page.locator('button:has-text("Verify"), button.btn-primary').first();
      if (await verifyBtn.isVisible().catch(() => false)) {
        await verifyBtn.click();
      } else {
        await githubOtpInput.press('Enter');
      }
      await sleep(5000);
    }

    // Wait for redirect to GitHub OAuth page or TokenHarbor landing page
    console.log('  [OAuth] Waiting for OAuth authorize screen or dashboard redirect...');
    const authorizeLocators = [
      'button#js-oauth-authorize-btn',
      'button[name="authorize"]',
      'button.btn-primary:has-text("Authorize")',
      'button:has-text("Authorize")',
      'button:has-text("authorize" i)'
    ];
    
    let isOAuthPage = false;
    const startTime = Date.now();
    while (Date.now() - startTime < 35000) {
      const currentUrl = page.url();
      console.log(`  [OAuth Loop] Current URL: ${currentUrl}`);
      if (currentUrl.includes('github.com')) {
        isOAuthPage = true;
        break;
      }
      if (currentUrl.includes('/dashboard')) {
        isOAuthPage = false;
        break;
      }
      if (currentUrl.includes('/oauth/finish')) {
        await sleep(3000);
        const urlAfterDelay = page.url();
        console.log(`  [OAuth Loop] URL after delay: ${urlAfterDelay}`);
        if (urlAfterDelay.includes('github.com')) {
          isOAuthPage = true;
          break;
        }
        console.log(`  [OAuth] Reached onboarding finish page directly: ${urlAfterDelay}`);
        isOAuthPage = false;
        break;
      }
      await sleep(1000);
    }

    if (isOAuthPage) {
      console.log('  [GitHub OAuth] Locating Authorize button...');
      let targetBtn = null;
      for (const sel of authorizeLocators) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          const btnText = (await el.innerText().catch(() => '')).trim();
          console.log(`  [GitHub OAuth] Candidate button: "${sel}" (Text: "${btnText}")`);
          if (btnText && !btnText.toLowerCase().includes('cancel')) {
            targetBtn = el;
            break;
          }
        }
      }

      if (targetBtn) {
        const btnText = (await targetBtn.innerText().catch(() => '')).trim();
        console.log(`  [GitHub OAuth] Clicking Authorize button: "${btnText}"...`);
        await targetBtn.click();
      } else {
        console.log('  [GitHub OAuth] [WARN] Authorize button not visible or only matched Cancel.');
      }
      await sleep(5000);
    } else {
      console.log('  [GitHub OAuth] Direct redirect or already authorized.');
    }

    // Step 3: Wait for redirect to TokenHarbor dashboard/finish URL
    console.log('[3/5] Waiting for dashboard redirect...');
    try {
      await page.waitForURL(url => url.hostname.includes("tokenharbor.ai") && !url.pathname.includes("login"), { timeout: 35000 });
      await page.waitForLoadState('domcontentloaded');
      await sleep(4000);
      await handleTurnstile(page, 15000);
    } catch (err) {
      console.log(`  [WARN] Dashboard redirect wait failed (${err.message}). Attempting recovery navigation...`);
      await page.goto('https://tokenharbor.ai/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(3000);
      await handleTurnstile(page, 15000);
      
      // If we are still on login page, click Continue with GitHub again
      if (page.url().includes('login')) {
        const ghBtn = page.locator('button[aria-label="Continue with GitHub"]').first();
        if (await ghBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log('  [Recovery] Clicking Continue with GitHub again...');
          await ghBtn.click();
          await sleep(5000);
          
          if (await authBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log('  [Recovery] Clicking Authorize button on recovery page...');
            await authBtn.click();
            await sleep(5000);
            await handleTurnstile(page, 15000);
          } else if (await fallbackAuthBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('  [Recovery] Clicking Fallback Authorize button on recovery page...');
            await fallbackAuthBtn.click();
            await sleep(5000);
            await handleTurnstile(page, 15000);
          }
          
          await page.waitForURL(url => url.hostname.includes("tokenharbor.ai") && !url.pathname.includes("login"), { timeout: 30000 }).catch(() => {});
          await sleep(4000);
          await handleTurnstile(page, 15000);
        }
      }
    }
    console.log(`  TokenHarbor Landing URL reached: ${page.url()}`);

    // Handle onboarding finish page if present
    if (page.url().includes('finish')) {
      console.log('  [Onboarding] On finish page, waiting for Claim/Invite elements...');
      
      // Parse invite code from URL
      const inviteUrlObj = new URL(CONFIG.inviteUrl);
      const inviteCode = inviteUrlObj.searchParams.get('invite') || 'TH-5A6A-JYPX';
      
      // Look for invite code input field and fill it only if empty
      const inviteInput = page.locator('input[placeholder*="invite" i], input[id*="invite" i], input[type="text"]').first();
      if (await inviteInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        const currentVal = await inviteInput.inputValue().catch(() => '');
        if (!currentVal.trim()) {
          console.log(`  [Onboarding] Invite input is empty. Entering invite code: ${inviteCode}`);
          await inviteInput.fill(inviteCode);
          await sleep(1000);
        } else {
          console.log(`  [Onboarding] Invite input already has value: "${currentVal}". Skipping fill.`);
        }
      }

      const finishBtn = page.locator('button').filter({ hasText: /Claim \$5 and start chatting/i }).first();
      await finishBtn.waitFor({ state: 'visible', timeout: 15000 });
      console.log('  [Onboarding] Clicking "Claim $5 and start chatting" button...');
      await finishBtn.click();
      await sleep(3000);
      
      // If still on finish page, try fallback click
      if (page.url().includes('finish')) {
        console.log('  [Onboarding] Still on finish page. Retrying click with fallback locator...');
        const fallbackBtn = page.locator('button:has-text("Claim $5"), button:has-text("start chatting"), :text("Claim $5 and start chatting")').first();
        await fallbackBtn.click().catch(() => {});
        await sleep(3000);
      }
      
      console.log('  [Onboarding] Waiting for dashboard URL redirect...');
      try {
        await page.waitForURL(url => url.pathname.includes('/dashboard'), { timeout: 25000 });
      } catch (err) {
        console.log(`  [Onboarding] [WARN] Redirect wait failed (${err.message}). Navigating directly to /dashboard...`);
        await page.goto('https://tokenharbor.ai/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      }
      await sleep(4000);
    }

    const tempmail = new TempMail();

    // 1. Click Enable free models
    await handleEnableFreeModels(page);
    await sleep(2000);

    // 2. Click Verify email & open confirmation link
    await triggerAndVerifyEmail(page, email, tempmail);
    await sleep(2000);

    // 3. Click button new gift & claim
    await claimWelcomeGift(page);
    await sleep(2000);

    // Step 4: Create and Verify API Key with OTP
    console.log('[4/5] Proceeding to create and verify API key...');
    const apiKey = await createAndVerifyApiKey(page, email, tempmail);

    // Step 5: Save output details
    console.log('[5/5] Saving outputs...');
    const timestamp = new Date().toISOString();

    // A. Save to tokenharbor.csv
    const thHeaders = 'timestamp,email,github_username,tokenharbor_key,status\n';
    const thRow = [
      timestamp,
      email,
      username,
      apiKey,
      'registered'
    ].map(csvCell).join(',') + '\n';

    if (!fs.existsSync(CONFIG.outputFile)) {
      fs.writeFileSync(CONFIG.outputFile, thHeaders, 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, thRow, 'utf8');
    console.log(`  Credentials saved to ${CONFIG.outputFile}`);

    // B. Save key to global keys.csv
    const keysHeaders = 'timestamp,email,password,api_key_name,api_key\n';
    // Password is from register_github CONFIG password
    const githubPasswordVal = githubConfig.password || 'PortoAuto2025!';

    const keysRow = [
      timestamp,
      email,
      githubPasswordVal,
      'auto',
      apiKey
    ].map(csvCell).join(',') + '\n';

    if (!fs.existsSync(CONFIG.keysFile)) {
      fs.writeFileSync(CONFIG.keysFile, keysHeaders, 'utf8');
    }
    fs.appendFileSync(CONFIG.keysFile, keysRow, 'utf8');
    console.log(`  API Key saved to global keys file: ${CONFIG.keysFile}`);

    console.log('\n==================================================');
    console.log('    TOKENHARBOR REGISTRATION & API KEY SUCCESS');
    console.log('==================================================');
    console.log(`  GitHub User:  ${username}`);
    console.log(`  Email:        ${email}`);
    console.log(`  API Key:      ${apiKey}`);
    console.log('==================================================\n');

  } catch (err) {
    console.error('[ERROR] TokenHarbor Signup Flow failed:', err.message);
    const errScreenshot = path.join(__dirname, `tokenharbor_error_${Date.now()}.png`);
    await page.screenshot({ path: errScreenshot }).catch(() => {});
    console.log(`  Screenshot saved to ${errScreenshot}`);
  } finally {
    console.log('Closing browser...');
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  run().catch(console.error);
}
