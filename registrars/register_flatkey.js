const { loadEnv } = require('../utils/env.js');
loadEnv();

// Force WEBHOOK provider as requested
process.env.TEMPMAIL_PROVIDER = 'webhook';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const path = require('path');
const fs = require('fs');
const TempMail = require('../services/tempmail/tempmail.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');
const { proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');

const CONFIG = {
  signupUrl: 'https://console.flatkey.ai/sign-up',
  keysUrl: 'https://console.flatkey.ai/keys',
  password: process.env.PASSWORD || 'Kucinghitam99#',
  keysFile: path.join(__dirname, '..', 'data', 'flatkey.csv'),
  proxy: process.env.PROXY || null,
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function generateCleanString(prefix = '', len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = prefix;
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

// Monitor Turnstile state changes via polling iframe DOM
async function monitorTurnstile(page, resolve, timeoutMs = 60000) {
  log('[INFO] monitorTurnstile started for Flatkey.');
  try {
    log('Waiting for Turnstile frame to appear...');
    let frame = null;
    for (let i = 0; i < 30; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    
    if (!frame) {
      log('Turnstile frame not found in frame list.');
      resolve(false);
      return;
    }

    log('Turnstile frame detected. Waiting 3s for layout to settle...');
    await page.waitForTimeout(3000);

    log('Waiting for Turnstile response token to populate...');
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
        log(`✅ CAPTCHA SOLVED (Token found: ${tokenValue.substring(0, 15)}...)!`);
        resolve(true);
        return;
      }

      // Check if the Turnstile frame is still present
      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));

      if (!activeFrame) {
        log('Turnstile frame is no longer present. Checking if token appears...');
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
            // If it's been at least 8 seconds since last click (or we haven't clicked yet), click it
            if (now - lastClickTime > 8000) {
              const clickX = box.x + 30;
              const clickY = box.y + box.height / 2;
              clickCount++;
              log(`[Click #${clickCount}] Auto-clicking Turnstile checkbox: x=${clickX}, y=${clickY}`);
              await page.mouse.click(clickX, clickY).catch(() => {});
              lastClickTime = now;
            }
          }
        } else {
          log('Turnstile frame element is not visible.');
        }
      }

      await page.waitForTimeout(2000);
    }
  } catch (err) {
    log(`[ERROR] monitorTurnstile failed: ${err.message}`);
  }
  resolve(false);
}

async function handleTurnstile(page, timeoutMs = 25000) {
  return new Promise((resolve) => {
    monitorTurnstile(page, resolve, timeoutMs);
  });
}

async function register() {
  log('=== Flatkey Auto-Registration & API Key Extraction ===');

  const tempmail = new TempMail();
  
  // Generate random dot-free and plus-free username and email local part
  const username = generateCleanString('user', 8);
  const emailLocal = generateCleanString('fk', 8);
  
  log(`Generated username: ${username}`);
  log(`Generating email using desired local part: ${emailLocal}`);
  
  const inbox = await tempmail.createInbox(emailLocal);
  const email = inbox.address;
  log(`Email address: ${email}`);

  // Setup Browser
  const browserExecutable = process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';
  log(`Using Browser Executable: ${browserExecutable}`);

  const selectedProxy = selectProxy(CONFIG.proxy);
  const pc = selectedProxy ? proxyFromUrl(selectedProxy) : null;

  const directPort = Math.floor(19000 + Math.random() * 6000);
  const tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_flatkey_${Date.now()}`);

  const launchOptions = {
    headless: process.env.HEADLESS === 'true',
    executablePath: browserExecutable,
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
    launchOptions.proxy = { server: pc.server, username: pc.username, password: pc.password };
    log(`Using proxy: ${pc.server}`);
  }

  log(`Launching Chrome on remote debugging port ${directPort}...`);
  const context = await chromium.launchPersistentContext(tempProfileDir, launchOptions);
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    log(`Navigating to ${CONFIG.signupUrl}...`);
    await page.goto(CONFIG.signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    // Fill Username
    log('Filling username...');
    const userField = page.locator('input[placeholder="Enter your username"]').first();
    await userField.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, userField, username);

    // Fill Password
    log('Filling password...');
    const passwordField = page.locator('input[placeholder="Enter password (8-20 characters)"]').first();
    await fillHuman(page, passwordField, CONFIG.password);

    // Confirm Password
    log('Confirming password...');
    const confirmField = page.locator('input[placeholder="Confirm password"]').first();
    await fillHuman(page, confirmField, CONFIG.password);

    // Fill Email
    log('Filling email...');
    const emailField = page.locator('input[placeholder="name@example.com"]').first();
    await fillHuman(page, emailField, email);

    // Click "Send code"
    log('Clicking "Send code" button...');
    const sendCodeBtn = page.locator('button:has-text("Send code")').first();
    
    // Wait for button to be visible
    await sendCodeBtn.waitFor({ state: 'visible', timeout: 15000 });
    
    // Check if the button is disabled
    let isDisabled = await sendCodeBtn.getAttribute('disabled') !== null;
    if (isDisabled) {
      log('Send code button is disabled. Waiting up to 10s for it to be enabled...');
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        const disabledAttr = await sendCodeBtn.getAttribute('disabled');
        if (disabledAttr === null) {
          isDisabled = false;
          break;
        }
        await sleep(1000);
      }
    }
    
    if (isDisabled) {
      log('[ERROR] Send code button remained disabled.');
      // Check if Turnstile is present
      const frames = page.frames();
      const turnstileFrame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (!turnstileFrame) {
        throw new Error('Turnstile captcha not detected (button disabled and no turnstile frame). Starting new session.');
      } else {
        throw new Error('Button disabled but Turnstile frame present. Starting new session.');
      }
    }

    try {
      await sendCodeBtn.click({ timeout: 10000 });
    } catch (err) {
      throw new Error(`Failed to click Send code button: ${err.message}`);
    }
    await sleep(2000);

    // Handle Turnstile Captcha
    log('Waiting for Turnstile Captcha to be solved...');
    const solved = await handleTurnstile(page, 45000);
    if (!solved) {
      throw new Error('Turnstile captcha not detected or solved within timeout. Starting new session.');
    }
    await sleep(2000);

    // Wait for Verification Code (OTP)
    log('Waiting for OTP email verification code...');
    const msg = await tempmail.waitForEmail(email, 180000);
    if (!msg) {
      throw new Error('Failed to receive verification email.');
    }
    const rawHtml = msg.html_body || msg.text_body || '';
    
    // Clean HTML tags and entities
    const cleanHtml = (raw) => {
      if (!raw) return "";
      return raw
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/\s(?:href|src|action|data-[\w-]+)\s*=\s*"[^"]*"/gi, " ")
        .replace(/\s(?:href|src|action|data-[\w-]+)\s*=\s*'[^']*'/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (e, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&zwnj;|&zwj;/gi, "");
    };

    // Robust custom parser for Flatkey verification codes
    const extractFlatkeyOtp = (html) => {
      // 1. Try class-based match
      let match = html.match(/class="verification-code"[^>]*>([a-zA-Z0-9]{6})<\/div>/i);
      if (match) return match[1];

      // 2. Try cleaned text match near "verification code"
      const clean = cleanHtml(html);
      match = clean.match(/verification\s*code\s*([a-zA-Z0-9]{6})/i);
      if (match) return match[1];

      // 3. Fallback: match any 6-character alphanumeric string that is not a word
      const matches = clean.match(/\b([a-zA-Z0-9]{6})\b/g) || [];
      for (const m of matches) {
        if (m.toLowerCase() !== 'expire' && m.toLowerCase() !== 'cancel' && !/^[a-zA-Z]{6}$/.test(m)) {
          return m;
        }
      }
      return null;
    };

    const otp = extractFlatkeyOtp(rawHtml);
    if (!otp) {
      log(`[ERROR] Failed to extract OTP. Raw message subject: ${msg.subject}`);
      throw new Error('Failed to parse OTP verification code from email.');
    }
    log(`OTP verification code received: ${otp}`);

    // Fill Verification Code
    log('Filling verification code...');
    const verificationCodeField = page.locator('input[placeholder="Verification code"]').first();
    await fillHuman(page, verificationCodeField, otp);
    await sleep(1000);

    // Click submit button: "Get free test credits"
    log('Submitting registration form...');
    const submitBtn = page.locator('button:has-text("Get free test credits")').first();
    await submitBtn.click();

    log('Registration form submitted. Waiting for page redirection (10s)...');
    await sleep(10000);
    log(`Current page URL: ${page.url()}`);
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'flatkey_after_signup.png') }).catch(() => {});

    // Navigate to Keys Page
    log(`Navigating to Keys page: ${CONFIG.keysUrl}...`);
    await page.goto(CONFIG.keysUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    log(`Loaded Keys page URL: ${page.url()}`);
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'flatkey_keys_page.png') }).catch(() => {});

    // Click Create API Key
    log('Clicking "+ Create API Key" button...');
    const createBtn = page.locator('button:has-text("Create API Key"), a:has-text("Create API Key"), :has-text("+ Create API Key")').first();
    await createBtn.click();
    await sleep(2000);

    // Fill Name in Modal
    const keyName = `key-${generateCleanString('', 6)}`;
    log(`Filling API Key name: ${keyName}...`);
    const nameInput = page.locator('input[placeholder="Enter a name"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await fillHuman(page, nameInput, keyName);
    await sleep(1000);

    // Click final Create API Key button
    log('Confirming API Key creation...');
    const confirmBtn = page.locator('button:has-text("Create API Key")').last();
    await confirmBtn.click();
    await sleep(5000);
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'flatkey_key_created.png') }).catch(() => {});

    // Extract API Key
    log('Extracting generated API Key...');
    let apiKey = '';
    
    // Poll for key to appear
    const startTimeKey = Date.now();
    while (Date.now() - startTimeKey < 20000) {
      // 1. Try to extract from the "Your new key" modal specifically
      const modalLocator = page.locator('div:has-text("Your new key"), [role="dialog"]').last();
      if (await modalLocator.isVisible().catch(() => false)) {
        apiKey = await modalLocator.evaluate(modalEl => {
          // A. Try input with readonly attribute first (this is the key input field)
          const readonlyInput = modalEl.querySelector('input[readonly]');
          if (readonlyInput && readonlyInput.value.trim()) {
            return readonlyInput.value.trim();
          }

          // B. Look inside inputs/textareas/codes/pres matching the key regex
          for (const el of modalEl.querySelectorAll('input, textarea, code, pre')) {
            const val = (el.value || el.textContent || '').trim();
            if (/^(sk-)?[a-zA-Z0-9_-]{32,80}$/.test(val)) {
              return val;
            }
          }
          // C. Fallback to div/span leaf nodes
          for (const el of modalEl.querySelectorAll('div, span')) {
            if (el.children.length === 0) {
              const val = (el.textContent || '').trim();
              if (/^(sk-)?[a-zA-Z0-9_-]{32,80}$/.test(val)) {
                return val;
              }
            }
          }
          return '';
        }).catch(() => '');
      }

      if (apiKey) break;

      // 2. Try global search restricted to inputs, textareas, codes, pres
      apiKey = await page.evaluate(() => {
        // Try any readonly input inside a dialog
        const readonlyInput = document.querySelector('[role="dialog"] input[readonly], input[readonly]');
        if (readonlyInput && readonlyInput.value.trim()) {
          return readonlyInput.value.trim();
        }

        for (const el of document.querySelectorAll('input, textarea, code, pre')) {
          const val = ('value' in el ? el.value : el.textContent || '').trim();
          if (/^(sk-)?[a-zA-Z0-9_-]{32,80}$/.test(val)) {
            return val;
          }
        }
        return '';
      }).catch(() => '');

      if (apiKey) break;
      await sleep(1000);
    }

    if (!apiKey) {
      // Fallback 3: Check text on the page using regex for any sk- key or 32-80 char key
      const pageText = await page.innerText('body').catch(() => '');
      const keyMatch = pageText.match(/\b(sk-[a-zA-Z0-9_-]{32,80})\b/) || pageText.match(/\b([a-zA-Z0-9_-]{32,80})\b/);
      if (keyMatch && keyMatch[0].toLowerCase() !== 'total1enabled1disabled0expired0exhausted0') {
        apiKey = keyMatch[0];
      }
    }

    if (!apiKey) {
      log('[ERROR] Failed to extract API Key. Saving page source for debugging...');
      const pageSource = await page.content();
      fs.writeFileSync(path.join(__dirname, 'flatkey_page_source.html'), pageSource, 'utf8');
      throw new Error('API Key extraction failed.');
    }

    log(`✅ API Key extracted successfully: ${apiKey}`);

    // Save to flatkey.csv
    const csvHeaders = 'timestamp,email,password,api_key_name,api_key';
    const csvRow = [
      new Date().toISOString(),
      email,
      CONFIG.password,
      keyName,
      apiKey
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const csvExists = fs.existsSync(CONFIG.keysFile);
    if (!csvExists) {
      fs.writeFileSync(CONFIG.keysFile, csvHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.keysFile, csvRow + '\n', 'utf8');
    log(`Saved credentials to ${CONFIG.keysFile}`);

    console.log('\n========================================');
    console.log('  FLATKEY REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Username:   ${username}`);
    console.log(`  Email:      ${email}`);
    console.log(`  Password:   ${CONFIG.password}`);
    console.log(`  API Key:    ${apiKey}`);
    console.log('========================================\n');

  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'flatkey_error.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    log('Closing browser...');
    await context.close().catch(() => {});
    try {
      if (fs.existsSync(tempProfileDir)) {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

if (require.main === module) {
  register().catch(e => {
    console.error('Fatal execution error:', e.message);
    process.exit(1);
  });
}

module.exports = { register };
