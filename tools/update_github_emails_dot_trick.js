#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');
const { parseCsvLine, generateGmailAlias } = require('../utils/email.js');
const { proxyFromUrl } = require('../utils/browser.js');
const { sleep, fillHuman } = require('../utils/helpers.js');
const TempMail = require('../services/tempmail/tempmail.js');

loadEnv();

const NO_OTP_CSV = path.join(__dirname, '..', 'data', '6gb-oracle-bayu', 'github_accounts_direct_no_otp.csv');
const READY_CSV = path.join(__dirname, '..', 'data', '6gb-oracle-bayu', 'github_accounts_ready.csv');
const MAIN_CSV = path.join(__dirname, '..', 'data', '6gb-oracle-bayu', 'github_accounts.csv');

function getBaseGmail() {
  const envUsers = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);
  if (envUsers.length > 0) return envUsers[0];
  throw new Error('GMAIL_USER is not configured in .env');
}

function extractVerificationLink(htmlOrText) {
  if (!htmlOrText) return null;
  const match = htmlOrText.match(/https:\/\/github\.com\/users\/[^\s"'<>]+/i)
             || htmlOrText.match(/https:\/\/github\.com\/emails\/[^\s"'<>]+/i)
             || htmlOrText.match(/https:\/\/github\.com\/confirm_verification\/[^\s"'<>]+/i)
             || htmlOrText.match(/https:\/\/github\.com\/settings\/emails\/[^\s"'<>]+/i);
  if (match) {
    return match[0].replace(/&amp;/g, '&').replace(/[>)"'.,;]+$/, '');
  }
  return null;
}

async function updateAccountEmail(account, workerId = 1, useProxy = true) {
  const { email: oldEmail, password, username, proxy } = account;
  const prefix = `[Worker #${workerId}] [${username}]`;
  console.log(`\n============================================================`);
  console.log(`${prefix} Starting GitHub Email Update (Gmail Dot-Trick)...`);
  console.log(`  Username  : ${username}`);
  console.log(`  Old Email : ${oldEmail}`);
  console.log(`  Proxy     : ${useProxy && proxy ? proxy : 'Direct (no proxy)'}`);
  console.log(`============================================================`);

  const baseGmail = getBaseGmail();
  const existingEmails = new Set();
  const newEmail = generateGmailAlias(baseGmail, existingEmails, '');
  console.log(`  ${prefix} ✨ New Gmail Dot-Trick Email: ${newEmail}`);

  const proxyConfig = useProxy && proxy && proxy !== 'direct' ? proxyFromUrl(proxy) : undefined;
  let browser = null;
  let context = null;

  try {
    const launchOptions = {
      headless: process.env.HEADLESS !== 'false',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ]
    };
    if (proxyConfig) launchOptions.proxy = proxyConfig;

    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    const page = await context.newPage();
    page.setDefaultTimeout(35000);

    const navMode = proxyConfig ? `via proxy (${proxy})` : 'direct (no proxy)';
    console.log(`  ${prefix} [1/6] Navigating to GitHub login ${navMode}...`);
    try {
      await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (netErr) {
      if (useProxy && proxyConfig) {
        console.log(`  ${prefix} [PROXY FAIL] Proxy timed out: ${netErr.message}`);
        console.log(`  ${prefix} [FALLBACK] Retrying direct connection without proxy...`);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        return await updateAccountEmail(account, workerId, false);
      }
      throw netErr;
    }
    await sleep(1500);

    const loginInput = page.locator('input#login_field, input[name="login"]').first();
    const pwdInput = page.locator('input#password, input[name="password"]').first();
    const commitBtn = page.locator('input[type="submit"][name="commit"], input[value="Sign in"], button[type="submit"]').first();

    if (!await loginInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      throw new Error('Login form not visible on GitHub login page');
    }

    console.log(`  ${prefix} [2/6] Submitting credentials for ${username}...`);
    await fillHuman(page, loginInput, username || oldEmail);
    await sleep(400);
    await fillHuman(page, pwdInput, password);
    await sleep(400);
    await commitBtn.click();

    await sleep(5000);

    const afterLoginUrl = page.url();
    if (afterLoginUrl.includes('/login') || afterLoginUrl.includes('/session') || afterLoginUrl.includes('/two-factor')) {
      throw new Error(`Login failed or OTP required (URL: ${afterLoginUrl})`);
    }
    console.log(`  ${prefix} ✅ [LOGIN OK] Successfully logged in to GitHub!`);

    // 2. Navigate to Email Settings
    console.log(`  ${prefix} [3/6] Navigating to https://github.com/settings/emails...`);
    await page.goto('https://github.com/settings/emails', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const addEmailInput = page.locator('input#email, input[name="email"]').first();
    const addBtn = page.locator('button:has-text("Add"), input[value="Add"], button[type="submit"]:has-text("Add")').first();

    if (!await addEmailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      throw new Error('Add email input not found on https://github.com/settings/emails');
    }

    console.log(`  ${prefix} [4/6] Adding new email ${newEmail}...`);
    await fillHuman(page, addEmailInput, newEmail);
    await sleep(500);
    await addBtn.click();
    await sleep(4000);

    // 3. Sudo password confirmation if prompted
    const sudoPwdInput = page.locator('input#sudo_password, input[name="sudo_password"]').first();
    const sudoBtn = page.locator('button:has-text("Confirm password"), input[value*="Confirm" i]').first();
    if (await sudoPwdInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  ${prefix} [SUDO] Password confirmation prompted. Submitting password...`);
      await fillHuman(page, sudoPwdInput, password);
      await sleep(300);
      await sudoBtn.click();
      await sleep(4000);
    }

    // 4. Wait for verification email via Gmail
    console.log(`  ${prefix} [5/6] Waiting for GitHub verification email sent to ${newEmail}...`);
    const tempmail = new TempMail();
    const startTime = Date.now() - 30000;
    let confirmUrl = null;

    for (let poll = 0; poll < 10; poll++) {
      await sleep(4000);
      try {
        const msg = await tempmail.waitForEmail(newEmail, 8000, 2000, startTime);
        if (msg) {
          const content = (msg.body_html || msg.html || msg.text || msg.body_text || msg.body || '');
          confirmUrl = extractVerificationLink(content);
          if (confirmUrl) break;
        }
      } catch (err) {
        // continue polling
      }
    }

    if (confirmUrl) {
      console.log(`  ${prefix} ✅ [EMAIL RECEIVED] Verification Link: ${confirmUrl}`);
      console.log(`  ${prefix} [6/6] Verifying new email on GitHub...`);
      await page.goto(confirmUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);

      // Set Primary Email
      await page.goto('https://github.com/settings/emails', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);

      const primarySelect = page.locator('select#primary_email_select, select[name="email"]').first();
      const savePrimaryBtn = page.locator('button:has-text("Save"), input[value="Save"]').first();

      if (await primarySelect.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`  ${prefix} [PRIMARY] Setting ${newEmail} as primary email...`);
        await primarySelect.selectOption({ label: newEmail }).catch(() => {});
        await sleep(500);
        if (await savePrimaryBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await savePrimaryBtn.click();
          await sleep(2000);
        }
      }

      console.log(`  ${prefix} 🎉 [SUCCESS] GitHub email updated successfully to: ${newEmail}!`);
      return { success: true, newEmail };
    } else {
      console.log(`  ${prefix} ⚠️ [WARN] Email added to GitHub (pending confirmation in inbox).`);
      return { success: true, newEmail, unverified: true };
    }

  } catch (err) {
    console.log(`  ${prefix} ❌ [FAILED] Error updating email: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  let concurrency = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--concurrency=')) concurrency = parseInt(args[i].split('=')[1], 10) || 3;
    else if (args[i] === '-c' || args[i] === '--concurrency') concurrency = parseInt(args[++i], 10) || 3;
  }

  console.log('=== Parallel GitHub Account Email Updater (Gmail Dot-Trick) ===\n');
  console.log(`Concurrency : ${concurrency} worker(s)`);
  console.log(`Source CSV  : ${NO_OTP_CSV}\n`);

  if (!fs.existsSync(NO_OTP_CSV)) {
    console.error(`Source file not found: ${NO_OTP_CSV}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(NO_OTP_CSV, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 2) {
    console.log('No accounts found in github_accounts_direct_no_otp.csv.');
    process.exit(0);
  }

  const header = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
  const emailIdx = header.indexOf('email');
  const passIdx = header.indexOf('password');
  const userIdx = header.indexOf('username');
  const proxyIdx = header.indexOf('proxy');

  const accounts = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
    accounts.push({
      email: parts[emailIdx] || '',
      password: parts[passIdx] || '',
      username: parts[userIdx] || '',
      proxy: parts[proxyIdx] || '',
    });
  }

  console.log(`Found ${accounts.length} accounts to update.\n`);

  let currentIndex = 0;
  let successCount = 0;
  let failCount = 0;

  async function worker(workerId) {
    while (true) {
      if (currentIndex >= accounts.length) break;
      const idx = currentIndex++;
      const acc = accounts[idx];

      const res = await updateAccountEmail(acc, workerId, true);

      if (res.success) {
        successCount++;
        const updatedTimestamp = new Date().toISOString();
        const updatedLine = `"${updatedTimestamp}","${res.newEmail}","${acc.password}","${acc.username}","${acc.proxy}"`;

        fs.appendFileSync(READY_CSV, updatedLine + '\n', 'utf8');
        fs.appendFileSync(MAIN_CSV, updatedLine + '\n', 'utf8');

        // Remove from No-OTP CSV safely
        try {
          const curNoOtp = fs.readFileSync(NO_OTP_CSV, 'utf8').split('\n').filter(Boolean);
          const remaining = curNoOtp.filter((l, lIdx) => lIdx === 0 || !l.includes(`"${acc.username}"`));
          fs.writeFileSync(NO_OTP_CSV, remaining.join('\n') + '\n', 'utf8');
        } catch (_) {}

        console.log(`[Worker #${workerId}] 🚀 [PROMOTED] Moved ${acc.username} to github_accounts_ready.csv!`);
      } else {
        failCount++;
      }

      await sleep(1500);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, accounts.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  console.log('\n============================================================');
  console.log('  PARALLEL EMAIL UPDATE COMPLETED');
  console.log(`  Success (Upgraded to Ready): ${successCount}`);
  console.log(`  Failed / Skipped           : ${failCount}`);
  console.log('============================================================\n');
}

main().catch(console.error);
