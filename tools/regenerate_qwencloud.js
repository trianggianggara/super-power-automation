const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const TempMail = require('../services/tempmail/tempmail.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl } = require('../utils/browser.js');
const { sleep, rand, fillHuman, humanMouseMove, humanScroll } = require('../utils/helpers.js');

const CONFIG = {
  baseUrl: 'https://home.qwencloud.com/',
  apiKeysUrl: 'https://home.qwencloud.com/api-keys',
  csvFile: path.join(__dirname, '..', 'data', 'qwencloud.csv'),
  otpTimeout: Number(process.env.QWENCLOUD_OTP_TIMEOUT || 120000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
};

// Simple command line argument parsing
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const TARGET_EMAIL = args.get('email') || null;
const FORCE = args.has('force');
const MAX_AGE_DAYS = Number(args.get('max-age-days') || 7);
const HEADED = args.get('headed') === 'true' || !envFlag('HEADLESS', true);

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  out.push(value);
  return out;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`CSV file not found: ${filePath}`);
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf8').trim();
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    return row;
  });
}

function updateCsvKey(filePath, email, newKey) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return false;

  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine);
  const emailIdx = headers.indexOf('email');
  const keyIdx = headers.indexOf('api_key');
  const tsIdx = headers.indexOf('timestamp');

  if (emailIdx === -1 || keyIdx === -1 || tsIdx === -1) {
    console.error('Invalid CSV header structure. Must contain: email, api_key, timestamp');
    return false;
  }

  const updatedLines = [headerLine];
  let updated = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = parseCsvLine(line);
    if (row[emailIdx] && row[emailIdx].toLowerCase() === email.toLowerCase()) {
      row[keyIdx] = newKey;
      row[tsIdx] = new Date().toISOString();
      updated = true;
    }
    const escapedRow = row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
    updatedLines.push(escapedRow);
  }

  fs.writeFileSync(filePath, updatedLines.join('\n') + '\n', 'utf8');
  return updated;
}

async function waitForQwenOtp(tempmail, email, timeoutMs, existingMsgIds = new Set()) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await tempmail.getMessages(email);
    for (const msg of messages || []) {
      if (existingMsgIds.has(msg.id)) continue; // Ignore messages that existed before clicking Send Code
      const text = TempMail.cleanHtml(`${msg.subject || ''}\n${msg.text_body || msg.html_body || ''}`);
      const match = text.match(/verification code for Qwen Cloud is:[\s\S]*?(\d{6})/i) || text.match(/verification code[\s\S]*?(\d{6})/i);
      if (match) return match[1];
    }
    await sleep(3000);
  }
  throw new Error('OTP not received on email address.');
}

async function deleteExistingKeys(page) {
  console.log('  Checking for existing API keys to delete...');
  
  // Locators for delete/revoke button in actions table or page
  const deleteBtnSelector = 'button:has-text("Delete"), button:has-text("Revoke"), button[class*="delete"], button[class*="trash"], button[aria-label*="delete" i], button[aria-label*="revoke" i], a:has-text("Delete"), a:has-text("Revoke")';
  
  let deleteButtons = page.locator(deleteBtnSelector);
  let count = await deleteButtons.count();
  console.log(`  Found ${count} potential delete/revoke buttons.`);
  
  let attempts = 0;
  while (count > 0 && attempts < 5) {
    attempts++;
    console.log(`  Deleting an existing API key (attempt ${attempts})...`);
    
    const btn = deleteButtons.first();
    await btn.click({ force: true });
    await sleep(1500);
    
    // Check for a confirmation dialog/modal and click confirm
    const confirmBtn = page.locator('div[role="dialog"] button:has-text("Confirm"), div[role="dialog"] button:has-text("Delete"), div[role="dialog"] button:has-text("OK"), button:has-text("Confirm"), button:has-text("OK"), button:has-text("Yes")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      console.log('  Clicking confirm in deletion dialog...');
      await confirmBtn.click();
      await sleep(2500);
    } else {
      console.log('  No confirmation dialog detected. Checking if deleted...');
    }
    
    // Refresh count
    deleteButtons = page.locator(deleteBtnSelector);
    count = await deleteButtons.count();
  }
  
  console.log('  Finished checking and deleting existing keys.');
}

async function completeCountryStep(page) {
  console.log('  Checking if country selection is required...');
  const trigger = page.locator('[role="combobox"], [class*="select-trigger"], button:has-text("Select your")').first();
  if (await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log('  Country selection page detected. Filling...');
    await sleep(rand(1000, 2000));
    await humanMouseMove(page);
    await trigger.click();
    await sleep(rand(800, 1500));

    console.log('  Selecting Indonesia...');
    const idOption = page.locator('[role="option"]:has-text("Indonesia")').first();
    await idOption.waitFor({ state: 'visible', timeout: 5000 });
    await idOption.click();
    await sleep(rand(800, 1500));

    const checkbox = page.locator('input.maas-terms-text__checkbox, input[type="checkbox"]').first();
    await checkbox.check({ force: true }).catch(async () => {
      await checkbox.click({ force: true }).catch(() => {});
    });
    await sleep(rand(800, 1500));

    const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
    await humanMouseMove(page);
    await continueBtn.click();
    await sleep(5000);
  } else {
    console.log('  No country selection required.');
  }
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

async function regenerateAccount(account) {
  const { email } = account;
  console.log(`\n========================================`);
  console.log(`Processing Account: ${email}`);
  console.log(`========================================`);

  const tempmail = new TempMail();
  const executablePathToUse = CONFIG.browserExecutablePath || undefined;
  const isCam = isCamoufox(executablePathToUse);
  let browser;
  let context;
  let tempProfileDir = '';

  if (isCam) {
    console.log('  Launching Camoufox (Firefox-based)...');
    const launchOpts = {
      headless: !HEADED,
      args: ['--no-sandbox'],
    };
    if (CONFIG.proxy) launchOpts.proxy = proxyFromUrl(CONFIG.proxy);
    if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

    browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
    context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta' });
  } else {
    console.log('  Launching Chromium with persistent context and stealth...');
    tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_${Date.now()}`);
    console.log(`  Profile path: ${tempProfileDir}`);

    const contextOpts = {
      headless: !HEADED,
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
    if (CONFIG.proxy) contextOpts.proxy = proxyFromUrl(CONFIG.proxy);

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

  try {
    console.log('[1/5] Opening Qwen Cloud...');
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1500, 3000));
    await humanMouseMove(page);

    // Look for Sign In or Log In link (filtered strictly to avoid Google/Github buttons)
    const loginLink = page.locator('a').filter({ hasText: /^(Log In|Sign In)$/i }).first();
    if (await loginLink.isVisible().catch(() => false)) {
      console.log('  Clicking Sign In / Log In button...');
      await loginLink.click();
      await sleep(rand(2000, 4000));
      await humanMouseMove(page);
    } else {
      console.log('  Log In button not visible, attempting to proceed directly...');
    }

    // Fill email
    console.log('  Entering email address...');
    const emailInput = page.locator('input[placeholder="Email"], input[placeholder*="Email" i], input[type="email"], input[type="text"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, emailInput, email);
    await sleep(rand(1000, 2000));
    await humanMouseMove(page);

    // Get existing messages before clicking Send Code to avoid matching old OTPs
    const existingMsgIds = new Set((await tempmail.getMessages(email) || []).map(m => m.id));

    // Click Send Code button (critical to trigger OTP)
    console.log('  Clicking Send Code...');
    const sendCodeBtn = page.locator('button:has-text("Send Code"), [role="button"]:has-text("Send Code"), span:has-text("Send Code")').first();
    await sendCodeBtn.click();
    await sleep(rand(1000, 2000));

    // Wait for OTP code
    const otp = await waitForQwenOtp(tempmail, email, CONFIG.otpTimeout, existingMsgIds);
    console.log(`  OTP Code received: ${otp}`);

    // Fill OTP / Verification Code
    console.log('  Entering Verification Code...');
    const verificationInput = page.locator('input[placeholder="Verification Code"], input[placeholder*="Verification" i], input[inputmode="numeric"]').first();
    await verificationInput.waitFor({ state: 'visible', timeout: 15000 });
    await verificationInput.click();
    await sleep(rand(2000, 4000));

    // Clear verification input just in case
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(rand(300, 600));

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

    // Click Next to submit the login
    console.log('  Clicking Next...');
    const nextBtn = page.locator('button:has-text("Next"), button[type="submit"]').first();
    await nextBtn.click();
    await sleep(rand(4000, 6000));

    // Country selection
    await completeCountryStep(page).catch(err => console.log(`  Country step skipped: ${err.message}`));

    // Redirect verify / Settle down
    console.log('  Waiting for login to redirect or settle...');
    await sleep(5000);
    console.log(`  Current URL: ${page.url()}`);

    // Navigate to API Keys page (do this with page.goto directly since redirect might get stuck or point to home)
    console.log('[2/5] Navigating to API Keys page...');
    let apiKeysLoaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(CONFIG.apiKeysUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);
        // Check if we are on the api keys page
        if (page.url().includes('/api-keys')) {
          apiKeysLoaded = true;
          break;
        }
      } catch (err) {
        console.log(`  Navigation to API Keys page failed (attempt ${attempt}/3): ${err.message}`);
        await sleep(3000);
      }
    }
    if (!apiKeysLoaded) {
      throw new Error(`Failed to load API Keys page. Current URL is: ${page.url()}`);
    }
    console.log(`  API Keys page loaded successfully. URL: ${page.url()}`);

    // Delete existing keys to avoid key limit
    console.log('[3/5] Revoking old keys...');
    await deleteExistingKeys(page).catch(err => console.error('  Failed to clear existing keys:', err.message));

    // Create a new key
    console.log('[4/5] Creating new API key...');
    const createBtn = page.locator('button:has-text("Create API key"), button:has-text("+ Create API key")').first();
    await createBtn.waitFor({ state: 'visible', timeout: 15000 });
    await createBtn.click();
    await sleep(rand(1000, 2000));
    await humanMouseMove(page);

    const descInput = page.locator('input[placeholder*="Production API key"], input[placeholder*="e.g."]').first();
    if (await descInput.isVisible().catch(() => false)) {
      const keyName = 'auto-' + Date.now().toString(36);
      await fillHuman(page, descInput, keyName);
      await sleep(rand(800, 1500));
    }

    const genBtn = page.locator('button:has-text("Generate Key"), button:has-text("Confirm")').first();
    await genBtn.waitFor({ state: 'visible', timeout: 15000 });
    await humanMouseMove(page);
    await genBtn.click();

    console.log('  Waiting for generated API key...');
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
    if (!apiKey) throw new Error('API key could not be extracted from screen');

    console.log(`  Successfully generated API key: ${apiKey}`);

    // Done modal click
    const doneBtn = page.locator('button:has-text("Done"), button:has-text("Close"), button:has-text("OK")').first();
    if (await doneBtn.isVisible().catch(() => false)) {
      await doneBtn.click().catch(() => {});
    }

    // Save to CSV in place
    console.log('[5/5] Saving to CSV...');
    const updated = updateCsvKey(CONFIG.csvFile, email, apiKey);
    if (updated) {
      console.log(`  CSV file updated successfully!`);
    } else {
      console.error(`  Warning: Could not find or update ${email} in CSV.`);
    }

    const regTime = new Date().toLocaleString();
    console.log(`[SUCCESS] Account ${email} regenerated at: ${regTime}`);
    return { success: true, email, key: apiKey, time: regTime };

  } catch (err) {
    const errTime = new Date().toLocaleString();
    console.error(`[ERROR] Failed to process ${email} at: ${errTime}`);
    console.error('Error message:', err.message);

    // Save error screenshot
    const errorScreenshotName = `error_regenerate_${email.replace(/[@.]/g, '_')}.png`;
    const screenshotPath = path.join(__dirname, 'scratch', errorScreenshotName);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`  Saved error screenshot to: ${screenshotPath}`);

    return { success: false, email, error: err.message, time: errTime };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('Reading accounts from qwencloud.csv...');
  const allAccounts = readCsv(CONFIG.csvFile);
  console.log(`Total accounts in CSV: ${allAccounts.length}`);

  let accountsToProcess = allAccounts;

  if (TARGET_EMAIL) {
    accountsToProcess = allAccounts.filter(acc => acc.email.toLowerCase() === TARGET_EMAIL.toLowerCase());
    if (accountsToProcess.length === 0) {
      console.error(`Error: target email "${TARGET_EMAIL}" not found in qwencloud.csv`);
      process.exit(1);
    }
    console.log(`Running in targeted mode for email: ${TARGET_EMAIL}`);
  } else {
    // Filter by timestamp age
    const now = Date.now();
    const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    accountsToProcess = allAccounts.filter(acc => {
      if (FORCE) return true;
      if (!acc.timestamp) return true;
      const keyDate = new Date(acc.timestamp).getTime();
      if (isNaN(keyDate)) return true; // Invalid timestamp, process it
      return (now - keyDate) > maxAgeMs;
    });

    console.log(`Filtered accounts based on age (> ${MAX_AGE_DAYS} days): ${accountsToProcess.length} need regeneration.`);
  }

  if (accountsToProcess.length === 0) {
    console.log('All accounts are up-to-date. No regeneration needed. (Use --force to regenerate anyway)');
    return;
  }

  const results = [];
  for (let i = 0; i < accountsToProcess.length; i++) {
    const account = accountsToProcess[i];
    console.log(`\n--- Progress: Account ${i + 1} of ${accountsToProcess.length} ---`);
    const result = await regenerateAccount(account);
    results.push(result);

    // Rate limiting cooldown between accounts
    if (i < accountsToProcess.length - 1) {
      const cooldown = 5000 + Math.floor(Math.random() * 5000);
      console.log(`Waiting ${Math.round(cooldown / 1000)} seconds before next account to prevent rate limits...`);
      await sleep(cooldown);
    }
  }

  // Generate run summary
  console.log('\n========================================');
  console.log('REGENERATION RUN SUMMARY');
  console.log('========================================');
  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Total Processed: ${results.length}`);
  console.log(`Succeeded:       ${succeeded.length}`);
  console.log(`Failed:          ${failed.length}`);

  if (succeeded.length > 0) {
    console.log('\nSucceeded Regenerations:');
    succeeded.forEach(r => {
      console.log(`- ${r.email} | Regenerated at: ${r.time}`);
    });
  }

  if (failed.length > 0) {
    console.log('\nFailed Regenerations:');
    failed.forEach(r => {
      console.log(`- ${r.email} | Error: ${r.error} | Failed at: ${r.time}`);
    });
  }
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal execution error:', err.message);
  process.exit(1);
});
