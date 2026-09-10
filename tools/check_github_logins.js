#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const GITHUB_CSV_PATH = process.env.GITHUB_ACCOUNTS_CSV || path.join(__dirname, '..', 'data', '6gb-oracle-bayu', 'github_accounts.csv');
const OUTLOOK_CSV_PATH = process.env.OUTLOOK_ACCOUNTS_CSV || path.join(__dirname, '..', 'data', '6gb-oracle-bayu', 'outlook_accounts.csv');
const RESULTS_CSV = path.join(__dirname, '..', 'data', '6gb-oracle-bayu', 'github_valid_outlook_check_results.csv');

process.env.OUTLOOK_ACCOUNTS_CSV = OUTLOOK_CSV_PATH;

const { chromium } = require('playwright');
const { parseCsvLine } = require('../utils/email.js');
const outlook = require('../utils/outlook.js');
const { proxyFromUrl } = require('../utils/browser.js');
const { sleep, fillHuman } = require('../utils/helpers.js');

function loadValidOutlookMap() {
  if (!fs.existsSync(OUTLOOK_CSV_PATH)) return new Map();
  const lines = fs.readFileSync(OUTLOOK_CSV_PATH, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 2) return new Map();

  const header = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
  const emailIdx = header.indexOf('email');
  const tokenIdx = header.indexOf('refresh_token');
  const statusIdx = header.indexOf('status');

  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
    const email = parts[emailIdx]?.toLowerCase();
    const token = parts[tokenIdx];
    const status = parts[statusIdx];
    if (email && token && token.length > 20 && status === 'ACTIVE') {
      map.set(email, token);
    }
  }
  return map;
}

async function attemptLogin(account, useProxy = true, workerId = 1) {
  const { email, password, username, proxy } = account;
  const proxyConfig = useProxy && proxy && proxy !== 'direct' ? proxyFromUrl(proxy) : undefined;
  const prefix = `[Worker #${workerId}] [${username || email}]`;
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
    if (proxyConfig) {
      launchOptions.proxy = proxyConfig;
    }

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
    console.log(`  ${prefix} Navigating to https://github.com/login ${navMode}...`);
    try {
      await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (netErr) {
      if (useProxy && proxyConfig) {
        console.log(`  ${prefix} [PROXY FAIL] Proxy timed out/failed: ${netErr.message}`);
        console.log(`  ${prefix} [FALLBACK] Retrying direct connection without proxy...`);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        return await attemptLogin(account, false, workerId);
      }
      return { status: 'NETWORK_ERROR', details: netErr.message };
    }

    await sleep(1500);

    const loginInput = page.locator('input#login_field, input[name="login"]').first();
    const pwdInput = page.locator('input#password, input[name="password"]').first();
    const commitBtn = page.locator('input[type="submit"][name="commit"], input[value="Sign in"], button[type="submit"]').first();

    if (!await loginInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      const pageText = await page.innerText('body').catch(() => '');
      if (pageText.includes('Access is temporarily restricted') || pageText.includes('blocked')) {
        return { status: 'IP_BLOCKED', details: 'WAF / Rate limited' };
      }
      return { status: 'PAGE_ERROR', details: 'Login input not visible' };
    }

    console.log(`  ${prefix} Submitting credentials (Username/Email & Password)...`);
    await fillHuman(page, loginInput, username || email);
    await sleep(400);
    await fillHuman(page, pwdInput, password);
    await sleep(400);
    await commitBtn.click();

    console.log(`  ${prefix} Waiting for response...`);
    await sleep(5000);

    const currentUrl = page.url();
    const bodyText = await page.innerText('body').catch(() => '');

    // 1. Check for Suspension
    if (currentUrl.includes('/suspended') || currentUrl.includes('/blocked') || bodyText.toLowerCase().includes('account suspended') || bodyText.toLowerCase().includes('account has been flagged')) {
      console.log(`  ${prefix} ❌ Status: SUSPENDED (Account flagged by GitHub)`);
      return { status: 'SUSPENDED', details: 'GitHub suspended/flagged' };
    }

    // 2. Check for Incorrect Password
    if (bodyText.includes('Incorrect username or password') || bodyText.includes('There have been several failed attempts')) {
      console.log(`  ${prefix} ❌ Status: INVALID_CREDENTIALS`);
      return { status: 'INVALID_CREDENTIALS', details: 'Wrong username or password' };
    }

    // 3. Check for Device OTP Verification Prompt
    const otpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"], input[name="app_otp"]').first();
    if (currentUrl.includes('/sessions/verified-device') || currentUrl.includes('/two-factor') || await otpInput.isVisible({ timeout: 2000 }).catch(() => false) || bodyText.includes('Device verification code') || bodyText.includes('verify your device')) {
      console.log(`  ${prefix} ⚠️ Status: NEEDS_DEVICE_OTP (Prompted for 6-digit email code)`);
      console.log(`  ${prefix} [OTP] Fetching verification code from Outlook via Graph API (${email})...`);

      const otpStartTime = Date.now() - 60000;
      let otpCode = null;
      try {
        otpCode = await outlook.waitForOtp({ email, timeout: 45000, since: otpStartTime, subjectContains: 'GitHub' });
      } catch (e) {
        console.log(`  ${prefix} [WARN] Graph API error: ${e.message}`);
      }

      if (otpCode) {
        console.log(`  ${prefix} ✅ [OTP RECEIVED] Code: ${otpCode}. Submitting to GitHub...`);
        await fillHuman(page, otpInput, otpCode);
        await sleep(500);

        const verifyBtn = page.locator('input[type="submit"][value*="Verify" i], button[type="submit"]:has-text("Verify"), button:has-text("Verify"), input[value="Submit"]').first();
        if (await verifyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await verifyBtn.click();
        } else {
          await otpInput.press('Enter');
        }

        await sleep(5000);

        const postOtpUrl = page.url();
        const postOtpBody = await page.innerText('body').catch(() => '');

        if (postOtpUrl.includes('/suspended') || postOtpBody.toLowerCase().includes('account suspended')) {
          console.log(`  ${prefix} ❌ Status: SUSPENDED (Post-OTP flagged)`);
          return { status: 'SUSPENDED', details: 'Suspended after OTP' };
        }

        console.log(`  ${prefix} ✅ Status: SUCCESS_LOGGED_IN (Authenticated via Outlook OTP!)`);
        return { status: 'SUCCESS_LOGGED_IN', details: 'Logged in via Outlook OTP' };
      } else {
        console.log(`  ${prefix} ❌ [OTP TIMEOUT] Could not retrieve OTP code from Outlook.`);
        return { status: 'OTP_NOT_RECEIVED', details: 'OTP code timeout from Outlook' };
      }
    }

    // 4. Check for Direct Login Success (No OTP)
    if (!currentUrl.includes('/login') && !currentUrl.includes('/session') && (bodyText.includes('Dashboard') || bodyText.includes('Sign out') || currentUrl === 'https://github.com/' || currentUrl === 'https://github.com')) {
      console.log(`  ${prefix} ✅ Status: SUCCESS_LOGGED_IN (No OTP required!)`);
      return { status: 'SUCCESS_LOGGED_IN', details: 'Logged in without OTP' };
    }

    const userAvatar = page.locator('button[aria-label*="user navigation" i], img.avatar-user, button:has(img.avatar)').first();
    if (await userAvatar.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log(`  ${prefix} ✅ Status: SUCCESS_LOGGED_IN (Avatar visible, logged in!)`);
      return { status: 'SUCCESS_LOGGED_IN', details: 'Logged in without OTP' };
    }

    console.log(`  ${prefix} ⚠️ Status: UNKNOWN (${currentUrl})`);
    return { status: 'UNKNOWN', details: currentUrl };

  } catch (err) {
    console.log(`  ${prefix} ❌ Error: ${err.message}`);
    return { status: 'ERROR', details: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  let concurrency = 4;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--concurrency=')) concurrency = parseInt(args[i].split('=')[1], 10) || 4;
    else if (args[i] === '-c' || args[i] === '--concurrency') concurrency = parseInt(args[++i], 10) || 4;
  }

  console.log('=== Parallel GitHub Account Login Checker (Valid Outlooks) ===\n');
  console.log(`Concurrency : ${concurrency} worker(s)`);
  console.log(`GitHub CSV  : ${GITHUB_CSV_PATH}`);
  console.log(`Outlook CSV : ${OUTLOOK_CSV_PATH}\n`);

  if (!fs.existsSync(GITHUB_CSV_PATH) || !fs.existsSync(OUTLOOK_CSV_PATH)) {
    console.error('CSV file(s) not found.');
    process.exit(1);
  }

  const validOutlookMap = loadValidOutlookMap();
  console.log(`[INFO] Found ${validOutlookMap.size} Outlook accounts with ACTIVE & VALID refresh tokens.`);

  const gLines = fs.readFileSync(GITHUB_CSV_PATH, 'utf8').split('\n').filter(Boolean);
  if (gLines.length < 2) {
    console.log('GitHub CSV is empty.');
    process.exit(0);
  }

  const header = parseCsvLine(gLines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
  const emailIdx = header.indexOf('email');
  const passIdx = header.indexOf('password');
  const userIdx = header.indexOf('username');
  const proxyIdx = header.indexOf('proxy');

  const targetAccounts = [];
  for (let i = 1; i < gLines.length; i++) {
    const parts = parseCsvLine(gLines[i]).map(p => p.replace(/^"|"$/g, ''));
    const email = parts[emailIdx]?.toLowerCase();
    if (email && validOutlookMap.has(email)) {
      targetAccounts.push({
        email: parts[emailIdx] || '',
        password: parts[passIdx] || '',
        username: parts[userIdx] || '',
        proxy: parts[proxyIdx] || '',
      });
    }
  }

  console.log(`[INFO] Found ${targetAccounts.length} GitHub accounts matching VALID Outlook accounts.\n`);

  const results = [];
  let currentIndex = 0;
  let successCount = 0;
  let suspendedCount = 0;
  let otpFailCount = 0;
  let otherCount = 0;

  async function worker(workerId) {
    while (true) {
      if (currentIndex >= targetAccounts.length) break;
      const idx = currentIndex++;
      const acc = targetAccounts[idx];

      console.log(`[Worker #${workerId}] [${idx + 1}/${targetAccounts.length}] Testing GitHub login for: ${acc.username} (${acc.email})`);
      const res = await attemptLogin(acc, true, workerId);
      results.push({ ...acc, ...res });

      if (res.status === 'SUCCESS_LOGGED_IN') successCount++;
      else if (res.status === 'SUSPENDED') suspendedCount++;
      else if (res.status === 'OTP_NOT_RECEIVED') otpFailCount++;
      else otherCount++;

      await sleep(1000);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targetAccounts.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // Save Results
  const outHeader = ['email', 'username', 'password', 'proxy', 'login_status', 'details'];
  const outLines = [outHeader.map(h => `"${h}"`).join(',')];
  for (const r of results) {
    outLines.push([r.email, r.username, r.password, r.proxy, r.status, r.details].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
  }
  fs.writeFileSync(RESULTS_CSV, outLines.join('\n') + '\n', 'utf8');

  console.log('\n============================================================');
  console.log('  PARALLEL VERIFICATION SUMMARY');
  console.log('============================================================');
  console.log(`Total Target Accounts : ${targetAccounts.length}`);
  console.log(`  🟢 Logged In (Active) : ${successCount}`);
  console.log(`  🔴 Suspended / Flagged: ${suspendedCount}`);
  console.log(`  🟡 OTP Not Received   : ${otpFailCount}`);
  console.log(`  ⚠️ Other / Error      : ${otherCount}`);
  console.log(`Results saved to      : ${RESULTS_CSV}`);
  console.log('============================================================\n');
}

main().catch(console.error);
