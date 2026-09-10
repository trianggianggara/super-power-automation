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

const CONFIG = {
  referralCode: process.env.BITDEER_REFERRAL_CODE || 'aOrgULHCMW',
  registerUrl: process.env.BITDEER_REGISTER_URL || `https://www.bitdeer.ai/ref_entry?code=${process.env.BITDEER_REFERRAL_CODE || 'aOrgULHCMW'}&lang=en`,
  password: process.env.BITDEER_PASSWORD || 'BitdeerAuto2026!',
  outputFile: path.join(__dirname, '..', 'data', 'bitdeer.csv'),
  otpTimeout: 120000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
  llmApiKey: process.env.LLM_API_KEY || '',
  llmApiUrl: process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions',
  llmModel: process.env.LLM_MODEL || 'cx/gpt-5.4-mini',
};

async function solveGeetestClickCaptcha(page, options) {
  const {
    apiKey = CONFIG.llmApiKey,
    apiUrl = CONFIG.llmApiUrl,
    model = CONFIG.llmModel,
    retries = 3,
  } = options || {};

  if (!apiKey) {
    console.log('  [WARN] No LLM_API_KEY provided. Skipping automated captcha solve...');
    return false;
  }

  const wrapLocator = page.locator('.geetest_wrap').first();
  const bgLocator = page.locator('.geetest_bg').first();
  const submitLocator = page.locator('.geetest_submit').first();

  for (let attempt = 0; attempt < retries; attempt++) {
    console.log(`  Geetest Click Captcha attempt ${attempt + 1}/${retries}...`);
    try {
      await wrapLocator.waitFor({ state: 'visible', timeout: 15000 });
      await bgLocator.waitFor({ state: 'visible', timeout: 5000 });
      await sleep(2000);

      const bgBox = await bgLocator.boundingBox();
      const wrapBox = await wrapLocator.boundingBox();
      if (!bgBox || !wrapBox) {
        console.log('  [WARN] Failed to get Geetest bounding boxes. Retrying...');
        continue;
      }

      console.log(`  Drawing relative coordinate grid inside .geetest_bg: ${bgBox.width}x${bgBox.height}`);

      // Inject relative grid overlay matching the bounding box inside .geetest_bg
      await page.evaluate((box) => {
        const bg = document.querySelector('.geetest_bg');
        if (!bg) return;

        bg.style.position = 'relative';

        const old = document.getElementById('captcha-grid-overlay');
        if (old) old.remove();

        const overlay = document.createElement('canvas');
        overlay.id = 'captcha-grid-overlay';
        overlay.width = box.width;
        overlay.height = box.height;
        overlay.style.position = 'absolute';
        overlay.style.left = '0px';
        overlay.style.top = '0px';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '2147483647';

        const ctx = overlay.getContext('2d');
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.35)';
        ctx.lineWidth = 0.75;
        ctx.fillStyle = 'rgba(255, 0, 0, 0.9)';
        ctx.font = 'bold 9px sans-serif';

        // Draw origin small 0
        ctx.fillText('0', 2, 10);

        const step = 40;
        // Vertical gridlines
        for (let x = step; x < box.width; x += step) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, box.height);
          ctx.stroke();
          ctx.fillText(x.toString(), x + 2, 10);
        }
        // Horizontal gridlines
        for (let y = step; y < box.height; y += step) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(box.width, y);
          ctx.stroke();
          ctx.fillText(y.toString(), 2, y - 2);
        }
        bg.appendChild(overlay);
      }, bgBox).catch(() => {});

      await sleep(500);

      // Capture screenshot of the entire geetest_box_layer modal directly in memory
      const boxLocator = page.locator('.geetest_box_layer').first();
      const imgBuffer = await boxLocator.screenshot();

      // Clean up overlay immediately
      await page.evaluate(() => {
        const overlay = document.getElementById('captcha-grid-overlay');
        if (overlay) overlay.remove();
      }).catch(() => {});

      const b64 = imgBuffer.toString('base64');

      const promptText = `This challenge image has a red coordinate grid overlayed on top of the main scenic area, with vertical and horizontal lines spaced every 40 CSS pixels. The top-left corner of the scenic background is (0, 0), marked with a "0" label.

At the top of the image, there is an instruction panel showing a sequence of target shapes/icons to select in order (from left to right).

Your task:
1. Identify the target shapes/icons shown in the top instruction panel in sequence from left to right.
2. Locate where each shape/icon is in the gridded scenic background image.
3. For each shape, reason out loud about its location relative to the grid lines (e.g., "lies between x=120 and x=160, close to y=80, so center is around x=140, y=100").
4. Based on your reasoning, determine the center coordinates (x, y) of each shape in grid pixel coordinates (do NOT scale them, do NOT multiply them by any factor).
5. Finally, output a JSON block matching the clicks array at the end of your response, like so:
{
  "clicks": [
    { "x": <x_1>, "y": <y_1> },
    { "x": <x_2>, "y": <y_2> },
    ...
  ]
}
Do not write anything after the JSON block.`;

      const payload = {
        model: model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
            ]
          }
        ]
      };

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`LLM API returned status ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const rawResult = (data.choices[0].message.content || '').trim();
      console.log(`  LLM response content:\n${rawResult}`);

      const match = rawResult.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error('No JSON found in LLM response');
      }
      const parsed = JSON.parse(match[0]);
      if (!parsed.clicks || !Array.isArray(parsed.clicks)) {
        throw new Error('Invalid JSON format: missing clicks array');
      }

      console.log(`  Clicking ${parsed.clicks.length} coordinates...`);
      for (let i = 0; i < parsed.clicks.length; i++) {
        const click = parsed.clicks[i];
        console.log(`    Click ${i + 1}: relative (${click.x}, ${click.y})`);
        await bgLocator.click({
          position: { x: Math.round(click.x), y: Math.round(click.y) },
          force: true,
          delay: rand(80, 150)
        });
        await sleep(rand(400, 700));
      }

      console.log('  Clicking Submit (OK) button...');
      await submitLocator.click();
      await sleep(3000);

      const stillVisible = await wrapLocator.isVisible().catch(() => false);
      if (!stillVisible) {
        console.log('  GeeTest captcha solved successfully!');
        return true;
      }

      console.log('  Captcha wrapper is still visible. Retrying...');
      const refreshBtn = page.locator('.geetest_refresh').first();
      if (await refreshBtn.isVisible().catch(() => false)) {
        await refreshBtn.click();
        await sleep(2000);
      }
    } catch (err) {
      console.error('  Error during captcha solve attempt:', err.message);
    }
  }
  return false;
}

async function register() {
  let browser;
  let context;
  let stepTimer;

  function armStep(label, timeoutMs = CONFIG.stepTimeout) {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      console.error(`  TIMEOUT: ${label} stuck > ${Math.round(timeoutMs / 1000)}s. Exiting...`);
      Promise.resolve(browser?.close()).catch(() => {}).finally(() => process.exit(1));
    }, timeoutMs);
  }

  const selectedProxy = selectProxy(CONFIG.proxy);
  const isCam = isCamoufox(CONFIG.browserExecutablePath);

  try {
    armStep('[1/8] Launching browser', CONFIG.launchTimeout);
    console.log('[1/8] Launching browser...');

    if (isCam) {
      const launchOpts = {
        headless: envFlag('HEADLESS', true),
        args: ['--no-sandbox'],
        executablePath: CONFIG.browserExecutablePath,
      };
      if (selectedProxy) {
        launchOpts.proxy = proxyFromUrl(selectedProxy);
      }
      browser = await browserType.launch(launchOpts);
      context = await browser.newContext({
        viewport: null,
        locale: 'en-US',
      });
    } else {
      const tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}`);
      const contextOpts = {
        headless: envFlag('HEADLESS', true),
        executablePath: CONFIG.browserExecutablePath,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        permissions: ['clipboard-read', 'clipboard-write'],
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--incognito',
        ],
      };
      if (selectedProxy) {
        contextOpts.proxy = proxyFromUrl(selectedProxy);
      }
      context = await browserType.launchPersistentContext(tempProfileDir, contextOpts);
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
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Step 2: Navigate to referral page
    armStep('[2/8] Navigating to referral link', 60000);
    console.log(`[2/8] Navigating to ${CONFIG.registerUrl}...`);
    await page.goto(CONFIG.registerUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(4000);

    // Step 3: Create temporary email
    armStep('[3/8] Creating temporary email', 30000);
    console.log('[3/8] Creating temporary email inbox...');
    const tempmail = new TempMail();
    const localPart = `user_${Math.floor(1000000 + Math.random() * 9000000)}`;
    const inbox = await tempmail.createInbox(localPart);
    const email = inbox.address;
    console.log(`  Email Address: ${email}`);

    // Fill email
    const emailInput = page.locator('input[placeholder*="Email Address" i], input[placeholder*="email" i], input[tabindex="1"]').first();
    await emailInput.fill(email);
    await sleep(1000);

    // Step 4: Click send code and solve Geetest Click Captcha
    armStep('[4/8] Triggering and solving captcha', 180000);
    console.log('[4/8] Clicking Send verification code...');
    const sendBtn = page.locator('button:has-text("Send verification code"), button:has-text("Send"), button[tabindex="-1"]').first();
    await sendBtn.click();
    await sleep(4000);

    // Solve Geetest
    console.log('  Detecting Geetest Click Captcha...');
    const solved = await solveGeetestClickCaptcha(page);
    if (!solved) {
      // Capture error screenshot
      const errPath = path.join(__dirname, 'bitdeer_captcha_error.png');
      await page.screenshot({ path: errPath });
      throw new Error(`Captcha solving failed. Saved error screenshot to ${errPath}`);
    }

    // Step 5: Wait for OTP and submit registration details
    armStep('[5/8] Fetching verification OTP email', CONFIG.otpTimeout);
    console.log(`[5/8] Waiting for registration OTP email (max ${CONFIG.otpTimeout / 1000}s)...`);
    let otpCode = '';
    const otpStartTime = Date.now();

    while (Date.now() - otpStartTime < CONFIG.otpTimeout) {
      try {
        const messages = await tempmail.getMessages(email);
        for (const msg of messages || []) {
          console.log(`  Found email: "${msg.subject}"`);
          const cleanText = TempMail.cleanHtml(`${msg.subject || ''}\n${msg.text_body || msg.html_body || ''}`);
          const codeMatch = cleanText.match(/\b(\d{6})\b/);
          if (codeMatch) {
            otpCode = codeMatch[1];
            console.log(`  Extracted Registration OTP: ${otpCode}`);
            break;
          }
        }
        if (otpCode) break;
      } catch (err) {
        console.log(`  Error checking email: ${err.message}`);
      }
      await sleep(4000);
    }

    if (!otpCode) {
      throw new Error('Timeout waiting for verification email');
    }

    // Step 6: Enter OTP, Password, checkbox, and submit
    armStep('[6/8] Entering registration details and submitting', 60000);
    console.log('[6/8] Entering verification code, password, and submitting form...');
    
    // Enter OTP
    const otpInput = page.locator('input[placeholder*="verification code" i], input[tabindex="2"]').first();
    await otpInput.fill(otpCode);
    await sleep(500);

    // Enter Password
    const passwordInput = page.locator('input[type="password"], input[tabindex="3"]').first();
    await passwordInput.fill(CONFIG.password);
    await sleep(500);

    // Ensure Referral ID is filled
    try {
      const referralToggle = page.locator('text="Referral ID"').first();
      let refInput = page.locator('input[placeholder*="referral" i], input[tabindex="4"]').first();
      
      if (await referralToggle.isVisible().catch(() => false)) {
        if (!(await refInput.isVisible().catch(() => false))) {
          await referralToggle.click().catch(() => {});
          await sleep(500);
        }
      }
      
      refInput = page.locator('input[placeholder*="referral" i], input[tabindex="4"]').first();
      if (await refInput.isVisible().catch(() => false)) {
        const currentVal = await refInput.inputValue().catch(() => '');
        if (!currentVal && CONFIG.referralCode) {
          console.log(`  Filling Referral ID: ${CONFIG.referralCode}`);
          await refInput.fill(CONFIG.referralCode);
          await sleep(500);
        } else {
          console.log(`  Referral ID present: "${currentVal}"`);
        }
      }
    } catch (err) {
      console.log(`  Note on Referral ID input: ${err.message}`);
    }

    // Agree terms checkbox
    const agreeCheckbox = page.locator('input[type="checkbox"], input[tabindex="5"]').first();
    if (await agreeCheckbox.isVisible() && !(await agreeCheckbox.isChecked())) {
      await agreeCheckbox.click();
    }
    await sleep(1000);

    // Submit
    const createBtn = page.locator('button[type="submit"]:has-text("Create my account"), button[type="submit"], button[tabindex="6"]').first();
    await createBtn.click();
    console.log('  Account submission sent. Waiting for dashboard navigation...');
    await sleep(8000);

    // Check if we are redirected or need to navigate manually
    let currentUrl = page.url();
    console.log(`  Current URL: ${currentUrl}`);
    if (!currentUrl.includes('model/apikeys')) {
      console.log('  Navigating manually to API keys dashboard...');
      let manualNavSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto('https://www.bitdeer.ai/en/model/apikeys', { waitUntil: 'load', timeout: 30000 });
          manualNavSuccess = true;
          break;
        } catch (e) {
          console.log(`  [WARN] Manual navigation attempt ${attempt} failed: ${e.message}. Retrying in 3s...`);
          await sleep(3000);
        }
      }
      if (!manualNavSuccess) {
        throw new Error('Failed to navigate to API keys dashboard after 3 attempts.');
      }
    }
    
    // Wait for the key elements to stabilize on page
    const genKeyBtn = page.locator('button:has-text("Generate API Key"), button:has-text("Generate")').first();
    await genKeyBtn.waitFor({ state: 'visible', timeout: 20000 });
    await sleep(2000);

    // Step 7: Verify balance
    armStep('[7/8] Verifying balance', 30000);
    console.log('[7/8] Verifying sign-up balance...');
    const bodyText = await page.innerText('body');
    if (bodyText.includes('$5.00') || bodyText.includes('5.00')) {
      console.log('  [SUCCESS] Balance verified: $5.00 found in dashboard!');
    } else {
      console.log('  [WARN] Could not verify $5.00 balance in dashboard text. Checking screenshot...');
      const balScreenshot = path.join(__dirname, 'bitdeer_balance_check.png');
      await page.screenshot({ path: balScreenshot });
      console.log(`  Saved dashboard screenshot to ${balScreenshot}`);
    }

    // Step 8: Generate API key and save
    armStep('[8/8] Generating API Key', 60000);
    console.log('[8/8] Generating API Key...');
    await genKeyBtn.click();
    await sleep(2000);

    // Fill API name
    const apiName = `auto-${Date.now().toString(36)}`;
    console.log(`  Entering API Name: ${apiName}`);
    const nameInput = page.locator('input[placeholder*="API Name" i], input').first();
    await nameInput.fill(apiName);
    await sleep(1000);

    // Click generate in modal
    const modalGenBtn = page.locator('div[class*="modal" i] button:has-text("Generate"), button:has-text("Generate")').last();
    await modalGenBtn.click();
    
    // Wait for the success modal to load by waiting for the title or text
    console.log('  Waiting for success modal to appear...');
    const successTitle = page.locator('div:has-text("API Key Generated Successfully"), :has-text("This is the only time")').first();
    await successTitle.waitFor({ state: 'visible', timeout: 20000 });
    await sleep(2500);

    // Extract API Key from modal inputs
    let apiKey = await page.evaluate((nameValue) => {
      // Find the modal container
      const modal = document.querySelector('div[class*="modal"], div[class*="dialog"]') || document.body;
      const inputs = Array.from(modal.querySelectorAll('input'));
      
      // Filter out inputs that are empty, or contain the API name value
      const keyInput = inputs.find(i => i.value && i.value.trim() !== nameValue);
      if (keyInput) return keyInput.value.trim();

      // Fallback 1: Try to find the label "API Key" and get the input field associated with it
      const elements = Array.from(modal.querySelectorAll('div, label, span'));
      const keyLabel = elements.find(el => el.innerText && el.innerText.trim() === 'API Key');
      if (keyLabel && keyLabel.parentElement) {
        const input = keyLabel.parentElement.querySelector('input');
        if (input && input.value) return input.value;
      }

      // Fallback 2: get the second input field inside the modal container
      if (inputs.length >= 2) {
        return inputs[1].value;
      }
      if (inputs.length === 1) {
        return inputs[0].value;
      }
      return '';
    }, apiName);

    console.log(`  API Key extracted: ${apiKey}`);

    // Click OK to close the modal
    try {
      const modalOkBtn = page.locator('div[class*="modal"] button:has-text("OK"), button:has-text("OK")').last();
      if (await modalOkBtn.isVisible()) {
        await modalOkBtn.click();
        await sleep(1000);
      }
    } catch (e) {
      console.log(`  [INFO] Failed to click OK button to close modal: ${e.message}`);
    }

    if (!apiKey) {
      // Save screenshot for manual retrieval
      const keyErrScreenshot = path.join(__dirname, 'bitdeer_key_extraction_error.png');
      await page.screenshot({ path: keyErrScreenshot });
      throw new Error(`Failed to extract generated API Key. Saved screenshot to ${keyErrScreenshot}`);
    }

    // Save to CSV
    console.log(`  Saving credentials and API Key to ${CONFIG.outputFile}...`);
    const csvRecord = `"${email}","${CONFIG.password}","${apiKey}","${new Date().toISOString()}"\n`;
    fs.mkdirSync(path.dirname(CONFIG.outputFile), { recursive: true });
    fs.appendFileSync(CONFIG.outputFile, csvRecord, 'utf8');

    console.log('[SUCCESS] Auto-Registration and API Key Generation completed successfully!');
  } catch (err) {
    console.error('[ERROR] Registration flow failed:', err.message);
    if (page) {
      const errScreenshotPath = path.join(__dirname, 'bitdeer_error_desktop.png');
      await page.screenshot({ path: errScreenshotPath }).catch(() => {});
      console.log(`  Saved error screenshot to ${errScreenshotPath}`);
      console.log(`  Current Page URL on error: ${page.url()}`);
    }
    throw err;
  } finally {
    clearTimeout(stepTimer);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  register().catch(() => process.exit(1));
}

module.exports = { register };
