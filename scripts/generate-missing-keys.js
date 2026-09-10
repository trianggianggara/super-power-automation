const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/env.js');
loadEnv();

const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl } = require('../utils/browser.js');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();

const browserExecutable = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
const browserType = browserTypeFor(browserExecutable);
browserType.use(StealthPlugin);

const { sleep } = require('../utils/helpers.js');
const { solveAliyunCaptcha } = require('../utils/captcha_solver.js');

const openmodelCsvPath = path.join(__dirname, '../openmodel.csv');
const keysCsvPath = path.join(__dirname, '../keys.csv');

if (!fs.existsSync(openmodelCsvPath)) {
  console.error(`Error: openmodel.csv not found at ${openmodelCsvPath}`);
  process.exit(1);
}

// Simple CSV parser
function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = [];
    let current = '';
    let inQuotes = false;
    const line = lines[i];
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.replace(/^"|"$/g, '').trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.replace(/^"|"$/g, '').trim());
    
    // Map to object
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return { headers, rows };
}

// Convert rows back to CSV string
function writeCsv(headers, rows, filePath) {
  const headerLine = headers.map(h => `"${h}"`).join(',');
  const rowLines = rows.map(row => {
    return headers.map(h => `"${String(row[h] || '').replace(/"/g, '""')}"`).join(',');
  });
  
  fs.writeFileSync(filePath, [headerLine, ...rowLines, ''].join('\n'), 'utf8');
}

async function checkRateLimit(page) {
  const rateLimitTexts = [
    "too many requests",
    "try again later",
    "rate limit",
    "banyak permintaan",
    "permintaan terlalu banyak"
  ];
  for (const text of rateLimitTexts) {
    // Search the text in case-insensitive way anywhere on the page
    const locator = page.locator(`text=/${text}/i`).first();
    if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log(`\n[CRITICAL] Rate limit detected: "${text}" is visible on the page!`);
      return true;
    }
  }
  return false;
}

async function getApiKeyForAccount(email, password) {
  console.log(`\nStarting browser for: ${email}...`);
  const executablePathToUse = browserExecutable || '/usr/bin/google-chrome-stable';
  const isCam = isCamoufox(executablePathToUse);
  
  let browser;
  let context;
  
  if (isCam) {
    const launchOpts = {
      headless: false, // Must be non-headless for manual captcha
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    };
    if (process.env.PROXY) {
      launchOpts.proxy = proxyFromUrl(process.env.PROXY);
    }
    launchOpts.executablePath = executablePathToUse;
    browser = await browserType.launch(launchOpts);
    context = await browser.newContext({
      viewport: null,
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
    });
  } else {
    const { chromium } = require('playwright-extra');
    const tempProfileDir = path.join(__dirname, `../.chrome_profile_tmp_login_${Date.now()}`);
    const contextOpts = {
      headless: false,
      executablePath: executablePathToUse,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--incognito',
      ],
    };
    if (process.env.PROXY) {
      contextOpts.proxy = proxyFromUrl(process.env.PROXY);
    }
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
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  let apiKey = '';

  try {
    console.log('Navigating to auth page...');
    await page.goto('https://console.openmodel.ai/auth', { waitUntil: 'networkidle', timeout: 45000 });

    if (await checkRateLimit(page)) {
      console.log('Stopping execution due to rate limit/too many requests.');
      process.exit(1);
    }

    // Handle policy agreement modal if present
    const agreeBtn = page.getByRole('button', { name: /agree/i });
    if (await agreeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await agreeBtn.click();
      await sleep(1000);
    }

    // Click "Sign in with verification code"
    console.log('Switching to Sign in with verification code...');
    const switchBtn = page.locator('button:has-text("Sign in with verification code")').first();
    if (await switchBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await switchBtn.click();
      await sleep(1000);
    }

    // Fill email
    console.log(`Filling email: ${email}`);
    await page.locator('input#email, input[type="email"]').first().fill(email);
    await sleep(500);

    // Dismiss any error/alert dialog before clicking Send code
    const dialogCloseBtn = page.locator('button:has-text("OK"), button:has-text("Confirm"), button:has-text("Close"), [role="dialog"] button').first();
    if (await dialogCloseBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Dismissing active alert dialog/modal...');
      await dialogCloseBtn.click();
      await sleep(1000);
    }

    // Click "Send code"
    console.log('Clicking Send code button...');
    const sendCodeBtn = page.locator('button:has-text("Send code"), button:has-text("Send verification code"), button:has-text("Continue"), button[type="submit"]').first();
    await sendCodeBtn.click();
    await sleep(2000);

    if (await checkRateLimit(page)) {
      console.log('Stopping execution due to rate limit/too many requests after clicking Send Code.');
      process.exit(1);
    }
    
    // Auto-solve CAPTCHA using LLM
    console.log('Checking for CAPTCHA...');
    const captchaContainer = page.locator('#tcaptcha_transform_dy, .tencent-captcha__transform, #tCaptchaMaskLayer, .tencent-captcha__mask-layer, #tCaptchaVerifyArea, .tencent-captcha__verify-area, iframe[src*="tcaptcha"]').first();
    let hasCaptcha = false;
    try {
      await captchaContainer.waitFor({ state: 'visible', timeout: 8000 });
      hasCaptcha = true;
    } catch (e) {
      // Timeout means no captcha is displayed
    }

    if (hasCaptcha) {
      console.log('CAPTCHA detected! Attempting to solve via LLM...');
      const solved = await solveAliyunCaptcha(page, {
        apiKey: process.env.LLM_API_KEY,
        apiUrl: process.env.LLM_API_URL,
        model: process.env.LLM_MODEL,
        retries: 3
      });
      if (solved) {
        console.log('CAPTCHA solved successfully via LLM!');
      } else {
        console.log('LLM CAPTCHA solving failed. Falling back to manual resolution if needed...');
      }
    } else {
      console.log('No CAPTCHA detected or already bypassed.');
      const noCaptchaScreenshotPath = path.join(__dirname, '../debug_nocaptcha.png');
      await page.screenshot({ path: noCaptchaScreenshotPath }).catch(() => {});
      console.log(`Saved debug screenshot when no captcha detected: ${noCaptchaScreenshotPath}`);
    }

    console.log('Waiting for OTP input field to appear...');
    
    // Wait for the OTP input field to become visible
    const otpInput = page.locator('input#otp-code, input#code, input[placeholder*="code" i], input[placeholder*="digit" i]').first();
    await otpInput.waitFor({ state: 'visible', timeout: 120000 });
    console.log('  OTP input field is visible.');

    // Fetch OTP code from webhook
    let otpCode = '';
    const otpStartTime = Date.now();
    console.log('Waiting for verification code email in webhook...');
    const tempMailStorePath = path.join(__dirname, '../.tempmail-webhook-8787.json');
    
    while (Date.now() - otpStartTime < 60000) {
      if (fs.existsSync(tempMailStorePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(tempMailStorePath, 'utf8'));
          const match = content.find(msg => msg.to_address.toLowerCase() === email.toLowerCase());
          if (match) {
            const receivedTime = new Date(match.received_at).getTime();
            if (receivedTime > (otpStartTime - 15000)) { // 15 seconds buffer to allow for slight clock desync
              const codeMatch = match.text_body.match(/verification code is (\d{6})/i) || 
                                match.text_body.match(/\b(\d{6})\b/);
              if (codeMatch) {
                otpCode = codeMatch[1];
                console.log(`Extracted OTP Code: ${otpCode}`);
                break;
              }
            }
          }
        } catch (e) {
          // ignore parsing error
        }
      }
      await sleep(2000);
    }

    if (otpCode) {
      console.log(`Filling OTP Code digit-by-digit: ${otpCode}`);
      // Clear input and focus it
      await otpInput.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await sleep(300);
      
      // Type digit-by-digit
      await otpInput.pressSequentially(otpCode, { delay: 150 });
      await sleep(1000);

      // Verify the value was entered
      const actualVal = await otpInput.inputValue().catch(() => '');
      console.log(`  Current OTP input value: "${actualVal}"`);

      // Screenshot for verification code submission
      const codeScreenshotPath = path.join(__dirname, '../inspect_otp_entered.png');
      await page.screenshot({ path: codeScreenshotPath }).catch(() => {});
      console.log(`  Saved screenshot after typing OTP: ${codeScreenshotPath}`);

      const verifyBtn = page.locator('button[type="submit"]:has-text("Verify"), button:has-text("Verify"), button:has-text("Continue"), button[type="submit"]').first();
      console.log('Clicking verify button...');
      await verifyBtn.click();
      await sleep(2000);
      
      // Screenshot post-click for debugging
      const postClickScreenshotPath = path.join(__dirname, '../inspect_otp_submitted.png');
      await page.screenshot({ path: postClickScreenshotPath }).catch(() => {});
      console.log(`  Saved screenshot after clicking Verify: ${postClickScreenshotPath}`);

      console.log('Submitted verification code. Waiting for login to complete...');
      
      // Wait for redirect to happen (from /auth to dashboard /)
      await page.waitForURL(url => !url.href.includes('/auth'), { timeout: 60000 });
      console.log('Login successful!');
      await sleep(2000);
    } else {
      throw new Error('Failed to receive verification code email in time.');
    }

    // Go to API keys page directly, with fallback to sidebar link click
    console.log('Navigating to API keys page...');
    try {
      await page.goto('https://console.openmodel.ai/api-keys', { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      console.log('  Direct page.goto failed or was aborted. Attempting sidebar link or retry...');
      const apiKeysLink = page.locator('a:has-text("API keys"), a[href*="api-keys"]').first();
      if (await apiKeysLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await apiKeysLink.click();
        await sleep(3000);
      } else {
        // Retry goto once with looser waitUntil condition
        await page.goto('https://console.openmodel.ai/api-keys', { waitUntil: 'load', timeout: 20000 }).catch((retryErr) => {
          console.error('  Retry navigation failed:', retryErr.message);
        });
      }
    }
    await sleep(2000);

    // Click Create API key
    const createBtn = page.locator('button:has-text("Create API key"), button:has-text("Create API Key"), button:has-text("Create key")').first();
    await createBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    if (await createBtn.isVisible().catch(() => false)) {
      console.log('Found Create API Key button. Clicking it...');
      await createBtn.click();
      await sleep(2000);

      // Check if there is an input field for key name in modal (scoping to dialog)
      const nameInput = page.locator('[role="dialog"] input[placeholder*="key" i], [role="dialog"] input[placeholder*="Name" i], [role="dialog"] input[type="text"]').first();
      const apiKeyName = `auto-${Math.floor(10000 + Math.random() * 90000)}`;
      if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`Filling key name: ${apiKeyName}`);
        await nameInput.fill(apiKeyName);
        await sleep(500);
      }

      // Click the submit/confirm button inside the dialog specifically
      const confirmBtn = page.locator('[role="dialog"] button:has-text("Create"), [role="dialog"] button').filter({ hasText: /^Create$/ }).first();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('Clicking confirm button in modal...');
        await confirmBtn.click();
        
        console.log('Waiting for API key to be generated and displayed...');
        const startTime = Date.now();
        let found = false;
        
        while (Date.now() - startTime < 15000) {
          // 1. Scan input fields inside the active dialog
          const inputs = page.locator('[role="dialog"] input');
          const inputCount = await inputs.count().catch(() => 0);
          for (let i = 0; i < inputCount; i++) {
            const val = await inputs.nth(i).inputValue().catch(() => '');
            if (/^(sk|om)-[a-zA-Z0-9_-]{30,80}$/.test(val)) {
              apiKey = val;
              console.log(`Extracted API Key from input: ${apiKey}`);
              found = true;
              break;
            }
          }
          if (found) break;

          // 2. Scan visible text of active dialog
          const dialogText = await page.locator('[role="dialog"]').innerText().catch(() => '');
          const keyMatch = dialogText.match(/\b(sk|om)-[a-zA-Z0-9_-]{30,80}\b/);
          if (keyMatch) {
            apiKey = keyMatch[0];
            console.log(`Extracted API Key from dialog text: ${apiKey}`);
            found = true;
            break;
          }

          // 3. Fallback: Scan any input fields on the page in case the dialog is not scoped
          const allInputs = page.locator('input');
          const allInputCount = await allInputs.count().catch(() => 0);
          for (let i = 0; i < allInputCount; i++) {
            const val = await allInputs.nth(i).inputValue().catch(() => '');
            if (/^(sk|om)-[a-zA-Z0-9_-]{30,80}$/.test(val)) {
              apiKey = val;
              console.log(`Extracted API Key from general input: ${apiKey}`);
              found = true;
              break;
            }
          }
          if (found) break;

          await sleep(1000);
        }

        if (!apiKey) {
          console.log('Failed to find API Key after waiting. Taking screenshot for debug...');
          const errorScreenshotPath = path.join(__dirname, `../error_key_generation_${email.replace(/[@.]/g, '_')}.png`);
          await page.screenshot({ path: errorScreenshotPath }).catch(() => {});
          console.log(`Saved debug screenshot to: ${errorScreenshotPath}`);
          
          const dialogExists = await page.locator('[role="dialog"]').isVisible().catch(() => false);
          console.log(`Debug - Dialog visible: ${dialogExists}`);
          if (dialogExists) {
            const text = await page.locator('[role="dialog"]').innerText().catch(() => '');
            console.log(`Debug - Dialog text content: "${text}"`);
          } else {
            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
            console.log(`Debug - Page body text (first 500 chars): "${bodyText.substring(0, 500)}"`);
          }
        }
      }

      // Dismiss dialog
      if (apiKey) {
        const doneBtn = page.locator('[role="dialog"] button:has-text("Done"), [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("OK")').first();
        if (await doneBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await doneBtn.click();
          await sleep(1000);
        }
      }
    } else {
      console.error('Could not find Create API Key button.');
    }

  } catch (err) {
    console.error('Error during automation:', err.message);
  } finally {
    console.log('Closing browser...');
    if (browser) await browser.close();
  }

  return apiKey;
}

async function run() {
  const content = fs.readFileSync(openmodelCsvPath, 'utf8');
  const { headers, rows } = parseCsv(content);
  
  const pendingRows = rows.filter(r => r.api_key === 'MANUAL_REQUIRED' || (!r.api_key.startsWith('sk-') && !r.api_key.startsWith('om-')));
  
  if (pendingRows.length === 0) {
    console.log('No pending OpenModel accounts found in openmodel.csv.');
    process.exit(0);
  }
  
  console.log(`Found ${pendingRows.length} accounts missing API keys.`);
  
  for (const row of pendingRows) {
    const email = row.email;
    const password = row.password;
    
    console.log(`\n======================================================`);
    console.log(`Processing: ${email}`);
    console.log(`======================================================`);
    
    const apiKey = await getApiKeyForAccount(email, password);
    
    if (apiKey) {
      // 1. Update in rows array
      row.api_key = apiKey;
      
      // Write updated openmodel.csv immediately so we don't lose progress if subsequent runs fail
      writeCsv(headers, rows, openmodelCsvPath);
      console.log(`Updated openmodel.csv for ${email}`);
      

    } else {
      console.log(`Failed to retrieve key for ${email}. Moving to next...`);
    }
    
    // Quick pause between accounts
    await sleep(3000);
  }
  
  console.log('\nAll pending accounts processed!');
}

run().catch(console.error);
