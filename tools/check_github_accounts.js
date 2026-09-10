#!/usr/bin/env node

/**
 * check_github_accounts.js
 * Tool to verify GitHub accounts status from data/github_accounts.csv
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealthPlugin);

const { loadEnv } = require('../utils/env.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl } = require('../utils/browser.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');
const TempMail = require('../services/tempmail/tempmail.js');

loadEnv();

const CSV_PATH = path.resolve(__dirname, '..', 'data', 'github_accounts.csv');

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

function readAccounts(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const row = parseCsvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, row[i] || '']));
  }).filter(r => r.email && r.password);
}

async function checkAccount(account, index, total) {
  const { email, password, username } = account;
  console.log(`\n------------------------------------------------------------`);
  console.log(`[${index + 1}/${total}] Checking: ${username || email} (${email})`);
  console.log(`------------------------------------------------------------`);

  const tempmail = new TempMail();
  const executablePathToUse = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || 'camoufox');
  const isCam = isCamoufox(executablePathToUse);
  const browserType = browserTypeFor(executablePathToUse);

  const launchOpts = {
    headless: false,
    args: isCam ? ['--no-sandbox'] : ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  };
  if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

  let browser;
  let context;
  let page;
  let result = { email, username, status: 'UNKNOWN', details: '' };

  try {
    browser = await browserType.launch(launchOpts);
    context = await browser.newContext({
      viewport: isCam ? null : { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta'
    });
    page = await context.newPage();

    console.log('  Navigating to https://github.com/login ...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const loginInput = page.locator('input#login_field, input[name="login"]').first();
    const isLoginInputVisible = await loginInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (!isLoginInputVisible) {
      const pageText = await page.innerText('body').catch(() => '');
      if (pageText.includes('DataDome') || pageText.includes('blocked')) {
        result.status = 'BLOCKED_BY_WAF';
        result.details = 'DataDome WAF blocked login page';
        return result;
      }
      result.status = 'PAGE_LOAD_ERROR';
      result.details = 'Login field not found';
      return result;
    }

    console.log(`  Filling login credentials (${username || email})...`);
    await fillHuman(page, loginInput, username || email);
    await sleep(rand(300, 600));

    const passwordInput = page.locator('input#password, input[name="password"]').first();
    await fillHuman(page, passwordInput, password);
    await sleep(rand(400, 800));

    console.log('  Submitting login form...');
    const signInBtn = page.locator('input[type="submit"], input[value="Sign in"]').first();
    await signInBtn.click();

    await sleep(4000);

    // 1. Check for suspension
    const url = page.url();
    const bodyText = await page.innerText('body').catch(() => '');
    if (url.includes('/suspended') || url.includes('support.github.com') || bodyText.includes('Account suspended') || bodyText.includes('violation of GitHub Terms')) {
      result.status = 'SUSPENDED';
      result.details = `Account is suspended. URL: ${url}`;
      console.log(`  ❌ Status: SUSPENDED`);
      return result;
    }

    // 2. Check for Incorrect username or password
    if (bodyText.includes('Incorrect username or password') || bodyText.includes('There have been several failed attempts')) {
      result.status = 'INVALID_CREDENTIALS';
      result.details = 'Incorrect username or password';
      console.log(`  ❌ Status: INVALID CREDENTIALS`);
      return result;
    }

    // 3. Check for Device Verification OTP code
    const otpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"], input[autocomplete="one-time-code"]').first();
    const needOtp = await otpInput.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (needOtp) {
      console.log('  ⚠️ Device verification OTP required. Waiting for OTP from TempMail...');
      const otpCode = await tempmail.waitForOtp(email, 60000);
      if (otpCode) {
        console.log(`  Entering OTP code: ${otpCode}`);
        await otpInput.fill(otpCode);
        await sleep(1000);
        
        const verifyBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Verify")').first();
        if (await verifyBtn.isVisible().catch(() => false)) {
          await verifyBtn.click();
        } else {
          await otpInput.press('Enter').catch(() => {});
        }
        await sleep(5000);
      } else {
        result.status = 'OTP_TIMEOUT';
        result.details = 'Device verification OTP requested but no email received';
        console.log(`  ⚠️ Status: OTP_TIMEOUT`);
        return result;
      }
    }

    // 4. Check post-login state
    const currentUrl = page.url();
    const postBody = await page.innerText('body').catch(() => '');
    if (currentUrl.includes('/suspended') || postBody.includes('Account suspended')) {
      result.status = 'SUSPENDED';
      result.details = 'Suspension detected after login';
      console.log(`  ❌ Status: SUSPENDED`);
    } else if (currentUrl === 'https://github.com/' || currentUrl.includes('github.com/dashboard') || currentUrl.includes('github.com/settings') || postBody.includes('Sign out') || postBody.includes('Dashboard')) {
      result.status = 'ACTIVE';
      result.details = `Login successful! Redirected to ${currentUrl}`;
      console.log(`  ✅ Status: ACTIVE (Login Successful)`);
    } else {
      result.status = 'UNKNOWN';
      result.details = `URL: ${currentUrl}`;
      console.log(`  ❓ Status: UNKNOWN (URL: ${currentUrl})`);
    }

  } catch (err) {
    result.status = 'ERROR';
    result.details = err.message;
    console.log(`  ⚠️ Error checking account: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  console.log('=== Checking GitHub Accounts from CSV ===');
  console.log(`Reading CSV: ${CSV_PATH}`);
  const accounts = readAccounts(CSV_PATH);
  console.log(`Total accounts to check: ${accounts.length}`);

  if (accounts.length === 0) {
    console.log('No accounts found in CSV.');
    return;
  }

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    const res = await checkAccount(accounts[i], i, accounts.length);
    results.push(res);
    await sleep(2000);
  }

  console.log('\n============================================================');
  console.log('📊 SUMMARY OF GITHUB ACCOUNTS');
  console.log('============================================================');
  console.table(results);
}

main().catch(console.error);
