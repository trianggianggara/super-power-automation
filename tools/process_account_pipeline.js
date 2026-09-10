#!/usr/bin/env node

/**
 * Unified Automated Account Pipeline
 * Usage:
 *   xvfb-run -a node tools/process_account_pipeline.js --data-dir=data/16gb-oracle-bayu --concurrency=4
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');
const { parseCsvLine, generateGmailAlias } = require('../utils/email.js');
const { proxyFromUrl } = require('../utils/browser.js');
const { sleep, fillHuman } = require('../utils/helpers.js');
const TempMail = require('../services/tempmail/tempmail.js');

loadEnv();

const CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';

// Parse CLI Arguments
const args = process.argv.slice(2);
let targetDir = 'data/16gb-oracle-bayu';
let concurrency = 4;

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--data-dir=')) targetDir = args[i].split('=')[1];
  else if (args[i] === '-d' || args[i] === '--data-dir') targetDir = args[++i];
  else if (args[i].startsWith('--concurrency=')) concurrency = parseInt(args[i].split('=')[1], 10) || 4;
  else if (args[i] === '-c' || args[i] === '--concurrency') concurrency = parseInt(args[++i], 10) || 4;
}

const DATA_DIR = path.isAbsolute(targetDir) ? targetDir : path.join(__dirname, '..', targetDir);
process.env.OUTLOOK_ACCOUNTS_CSV = path.join(DATA_DIR, 'outlook_accounts.csv');
const outlook = require('../utils/outlook.js');

console.log('============================================================');
console.log('       🚀 MASTER AUTOMATED ACCOUNT PIPELINE STARTING        ');
console.log('============================================================');
console.log(` Target Directory : ${DATA_DIR}`);
console.log(` Concurrency      : ${concurrency} parallel workers`);
console.log('============================================================\n');

// Helper to test Microsoft Graph Token
function testGraphRefreshToken(token) {
  return new Promise((resolve) => {
    if (!token || token.trim().length < 10) return resolve(false);
    const data = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: 'https://graph.microsoft.com/Mail.Read offline_access',
      refresh_token: token,
      grant_type: 'refresh_token',
    });

    const req = https.request({
      hostname: 'login.microsoftonline.com',
      path: '/consumers/oauth2/v2.0/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        resolve(res.statusCode === 200);
      });
    });

    req.on('error', () => resolve(false));
    req.write(data.toString());
    req.end();
  });
}

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
  if (match) return match[0].replace(/&amp;/g, '&').replace(/[>)"'.,;]+$/, '');
  return null;
}

// ==========================================
// PHASE 1 & 2: OUTLOOK PROCESSING & RECOVERY
// ==========================================
async function processOutlookAccounts() {
  console.log('------------------------------------------------------------');
  console.log(' [PHASE 1] Outlook Accounts Audit, Backup & Verification');
  console.log('------------------------------------------------------------');

  const OUTLOOK_CSV = path.join(DATA_DIR, 'outlook_accounts.csv');
  const UNIFIED_BAK = path.join(DATA_DIR, 'outlook_accounts.csv.bak');

  if (!fs.existsSync(OUTLOOK_CSV)) {
    console.log(`[WARN] Outlook CSV not found at: ${OUTLOOK_CSV}. Skipping Phase 1.`);
    return;
  }

  // 1. Create or ensure single master backup
  if (!fs.existsSync(UNIFIED_BAK)) {
    fs.copyFileSync(OUTLOOK_CSV, UNIFIED_BAK);
    console.log(`  [BACKUP] Created master backup: ${UNIFIED_BAK}`);
  }

  const rawLines = fs.readFileSync(UNIFIED_BAK, 'utf8').split('\n').filter(Boolean);
  const headerLine = rawLines[0];
  const header = parseCsvLine(headerLine).map(h => h.replace(/^\"|\"$/g, '').toLowerCase());
  const emailIdx = header.indexOf('email');
  const tokenIdx = header.indexOf('refresh_token');

  console.log(`  Auditing ${rawLines.length - 1} total Outlook accounts from master backup...`);

  const withToken = [];
  const lockedNoToken = [];

  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    const parts = parseCsvLine(line).map(p => p.replace(/^\"|\"$/g, ''));
    const token = parts[tokenIdx] || '';
    const email = parts[emailIdx] || '';

    if (!token || token.trim().length < 10) {
      lockedNoToken.push(line);
    } else {
      withToken.push({ line, email, token, index: i });
    }
  }

  console.log(`  - Accounts with refresh tokens : ${withToken.length}`);
  console.log(`  - Accounts locked from start   : ${lockedNoToken.length}`);
  console.log(`  Testing Graph API validity for ${withToken.length} accounts...`);

  const readyAccounts = [];
  const inactiveTokenAccounts = [];

  const batchSize = 15;
  for (let i = 0; i < withToken.length; i += batchSize) {
    const batch = withToken.slice(i, i + batchSize);
    await Promise.all(batch.map(async (acc) => {
      const isValid = await testGraphRefreshToken(acc.token);
      if (isValid) {
        readyAccounts.push(acc.line);
      } else {
        inactiveTokenAccounts.push(acc);
      }
    }));
  }

  console.log(`  ✅ Live / Active Token Accounts : ${readyAccounts.length}`);
  console.log(`  ⚠️ Inactive / Locked Accounts   : ${inactiveTokenAccounts.length}`);

  // 2. Outlook Automated Recovery if inactive tokens exist
  if (inactiveTokenAccounts.length > 0) {
    console.log('\n------------------------------------------------------------');
    console.log(' [PHASE 2] Automated Outlook Account Recovery');
    console.log('------------------------------------------------------------');
    console.log(`  Attempting recovery for ${inactiveTokenAccounts.length} locked accounts...`);

    // Run recovery tool via sub-process
    try {
      const { execSync } = require('child_process');
      const recoveryCmd = `xvfb-run -a env OUTLOOK_ACCOUNTS_CSV="${OUTLOOK_CSV}" node registrars/register_outlook_graph.js --recovery --concurrency=${concurrency}`;
      console.log(`  Executing: ${recoveryCmd}`);
      execSync(recoveryCmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    } catch (recErr) {
      console.log(`  [RECOVERY NOTICE] Recovery process ended: ${recErr.message}`);
    }

    // Re-audit after recovery
    console.log('  Re-verifying accounts post-recovery...');
    const postLines = fs.readFileSync(OUTLOOK_CSV, 'utf8').split('\n').filter(Boolean);
    const postWithToken = [];
    for (let i = 1; i < postLines.length; i++) {
      const parts = parseCsvLine(postLines[i]).map(p => p.replace(/^\"|\"$/g, ''));
      const token = parts[tokenIdx] || '';
      if (token && token.trim().length > 10) postWithToken.push(postLines[i]);
    }

    readyAccounts.length = 0;
    inactiveTokenAccounts.length = 0;

    for (let i = 0; i < postWithToken.length; i += batchSize) {
      const batch = postWithToken.slice(i, i + batchSize);
      await Promise.all(batch.map(async (line) => {
        const parts = parseCsvLine(line).map(p => p.replace(/^\"|\"$/g, ''));
        const token = parts[tokenIdx] || '';
        const isValid = await testGraphRefreshToken(token);
        if (isValid) readyAccounts.push(line);
        else inactiveTokenAccounts.push(line);
      }));
    }
  }

  // 3. Write Outlook CSV Tiers
  const READY_CSV = path.join(DATA_DIR, 'outlook_accounts_ready.csv');
  const INACTIVE_CSV = path.join(DATA_DIR, 'outlook_accounts_inactive_token.csv');
  const LOCKED_CSV = path.join(DATA_DIR, 'outlook_accounts_locked_no_token.csv');

  fs.writeFileSync(READY_CSV, [headerLine, ...readyAccounts].join('\n') + '\n', 'utf8');
  fs.writeFileSync(OUTLOOK_CSV, [headerLine, ...readyAccounts].join('\n') + '\n', 'utf8');
  fs.writeFileSync(INACTIVE_CSV, [headerLine, ...inactiveTokenAccounts].join('\n') + '\n', 'utf8');
  fs.writeFileSync(LOCKED_CSV, [headerLine, ...lockedNoToken].join('\n') + '\n', 'utf8');

  console.log('\n=== OUTLOOK CLASSIFICATION SUMMARY ===');
  console.log(`  🟢 Ready Outlook Accounts        : ${readyAccounts.length} -> ${READY_CSV}`);
  console.log(`  🟡 Inactive Token Accounts       : ${inactiveTokenAccounts.length} -> ${INACTIVE_CSV}`);
  console.log(`  🔴 Locked No Token Accounts      : ${lockedNoToken.length} -> ${LOCKED_CSV}`);
  console.log(`  📦 Master Backup                 : ${rawLines.length - 1} -> ${UNIFIED_BAK}\n`);

  return { readyEmails: new Set(readyAccounts.map(l => parseCsvLine(l)[emailIdx].replace(/^\"|\"$/g, '').toLowerCase().trim())) };
}

// ==========================================
// PHASE 3 & 4: GITHUB PROCESSING & RESCUE
// ==========================================
async function testSingleGithubLogin(account, workerId, validOutlookEmails) {
  const { email, password, username, proxy } = account;
  const prefix = `[Worker #${workerId}] [${username}]`;
  console.log(`${prefix} Testing GitHub login for: ${username} (${email})...`);

  const hasValidOutlook = validOutlookEmails.has(email.toLowerCase().trim());
  const proxyConfig = proxy && proxy !== 'direct' ? proxyFromUrl(proxy) : undefined;
  let browser = null;
  let context = null;

  try {
    const launchOptions = {
      headless: process.env.HEADLESS !== 'false',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    };
    if (proxyConfig) launchOptions.proxy = proxyConfig;

    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(35000);

    const navMode = proxyConfig ? `via proxy (${proxy})` : 'direct (no proxy)';
    try {
      await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (netErr) {
      if (proxyConfig) {
        console.log(`  ${prefix} [PROXY FAIL] Proxy offline. Retrying direct connection...`);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        return await testSingleGithubLogin({ ...account, proxy: '' }, workerId, validOutlookEmails);
      }
      return { status: 'PROXY_DEAD', error: netErr.message };
    }

    await sleep(1500);
    const loginInput = page.locator('input#login_field, input[name="login"]').first();
    const pwdInput = page.locator('input#password, input[name="password"]').first();
    const commitBtn = page.locator('input[type="submit"][name="commit"], input[value="Sign in"], button[type="submit"]').first();

    if (!await loginInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      return { status: 'PAGE_LOAD_ERROR', error: 'Login input not found' };
    }

    await fillHuman(page, loginInput, username || email);
    await sleep(300);
    await fillHuman(page, pwdInput, password);
    await sleep(300);
    await commitBtn.click();

    await sleep(5000);

    const bodyText = await page.innerText('body').catch(() => '');
    const currentUrl = page.url();

    // Check Suspended
    if (bodyText.includes('Your account has been flagged') ||
        bodyText.includes('Account suspended') ||
        bodyText.includes('terms of service violation')) {
      console.log(`  ${prefix} ❌ Status: SUSPENDED`);
      return { status: 'SUSPENDED' };
    }

    // Check Invalid Credentials
    if (bodyText.includes('Incorrect username or password')) {
      console.log(`  ${prefix} ❌ Status: INVALID_CREDENTIALS`);
      return { status: 'INVALID_CREDENTIALS' };
    }

    // Check Logged In Directly
    if (currentUrl === 'https://github.com/' ||
        currentUrl.includes('github.com/dashboard') ||
        (!currentUrl.includes('/login') && !currentUrl.includes('/session') && !currentUrl.includes('/two-factor'))) {
      console.log(`  ${prefix} ✅ Status: SUCCESS_LOGGED_IN (Direct No-OTP)`);
      return { status: 'SUCCESS_LOGGED_IN', method: 'DIRECT_NO_OTP' };
    }

    // Check Device OTP Verification
    if (currentUrl.includes('/verified-device') || currentUrl.includes('/sessions/two-factor') || bodyText.includes('Device verification code')) {
      if (!hasValidOutlook) {
        console.log(`  ${prefix} ⚠️ Status: NEEDS_OTP (No valid Outlook available)`);
        return { status: 'NEEDS_OTP_DEAD_OUTLOOK' };
      }

      console.log(`  ${prefix} 🔑 [OTP] Fetching verification code from Outlook via Graph API (${email})...`);
      const otpCode = await outlook.waitForOtp({
        email,
        timeout: 45000,
        since: Date.now() - 60000,
        subjectContains: 'GitHub'
      }).catch(() => null);

      if (otpCode) {
        console.log(`  ${prefix} ✅ [OTP RECEIVED] Code: ${otpCode}. Submitting...`);
        const otpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"]').first();
        if (await otpInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          await fillHuman(page, otpInput, otpCode);
          await sleep(500);
          await page.keyboard.press('Enter');
          await sleep(5000);

          const postOtpUrl = page.url();
          if (!postOtpUrl.includes('/verified-device') && !postOtpUrl.includes('/login')) {
            console.log(`  ${prefix} 🎉 Status: SUCCESS_LOGGED_IN (Via Graph OTP)`);
            return { status: 'SUCCESS_LOGGED_IN', method: 'GRAPH_OTP' };
          }
        }
      }
      return { status: 'OTP_SUBMIT_FAILED' };
    }

    return { status: 'UNKNOWN', url: currentUrl };

  } catch (err) {
    console.log(`  ${prefix} ❌ Error: ${err.message}`);
    return { status: 'ERROR', error: err.message };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function processGithubAccounts(validOutlookEmails) {
  console.log('\n------------------------------------------------------------');
  console.log(' [PHASE 3] GitHub Accounts Audit & Login Verification');
  console.log('------------------------------------------------------------');

  const GITHUB_CSV = path.join(DATA_DIR, 'github_accounts.csv');
  const UNIFIED_BAK = path.join(DATA_DIR, 'github_accounts.csv.bak');

  if (!fs.existsSync(GITHUB_CSV)) {
    console.log(`[WARN] GitHub CSV not found at: ${GITHUB_CSV}. Skipping Phase 3.`);
    return;
  }

  // Ensure master backup
  if (!fs.existsSync(UNIFIED_BAK)) {
    fs.copyFileSync(GITHUB_CSV, UNIFIED_BAK);
    console.log(`  [BACKUP] Created master backup: ${UNIFIED_BAK}`);
  }

  const rawLines = fs.readFileSync(UNIFIED_BAK, 'utf8').split('\n').filter(Boolean);
  const headerLine = rawLines[0];
  const header = parseCsvLine(headerLine).map(h => h.replace(/^\"|\"$/g, '').toLowerCase());
  const emailIdx = header.indexOf('email');
  const passIdx = header.indexOf('password');
  const userIdx = header.indexOf('username');
  const proxyIdx = header.indexOf('proxy');

  const accounts = [];
  for (let i = 1; i < rawLines.length; i++) {
    const parts = parseCsvLine(rawLines[i]).map(p => p.replace(/^\"|\"$/g, ''));
    accounts.push({
      email: parts[emailIdx] || '',
      password: parts[passIdx] || '',
      username: parts[userIdx] || '',
      proxy: parts[proxyIdx] || '',
      rawLine: rawLines[i]
    });
  }

  console.log(`  Testing login for ${accounts.length} GitHub accounts with ${concurrency} workers...`);

  const readyAccounts = [];
  const directNoOtpAccounts = [];
  const suspendedAccounts = [];
  const pendingAccounts = [];

  let currentIndex = 0;

  async function worker(workerId) {
    while (true) {
      if (currentIndex >= accounts.length) break;
      const acc = accounts[currentIndex++];
      const res = await testSingleGithubLogin(acc, workerId, validOutlookEmails);

      if (res.status === 'SUCCESS_LOGGED_IN') {
        if (validOutlookEmails.has(acc.email.toLowerCase().trim())) {
          readyAccounts.push(acc.rawLine);
        } else {
          directNoOtpAccounts.push(acc);
        }
      } else if (res.status === 'SUSPENDED') {
        suspendedAccounts.push(acc.rawLine);
      } else {
        pendingAccounts.push(acc.rawLine);
      }
      await sleep(1000);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, accounts.length) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  // 4. Rescue Direct No-OTP Accounts with Gmail Dot-Trick
  if (directNoOtpAccounts.length > 0) {
    console.log('\n------------------------------------------------------------');
    console.log(' [PHASE 4] Rescuing Direct No-OTP Accounts (Gmail Dot-Trick)');
    console.log('------------------------------------------------------------');
    console.log(`  Found ${directNoOtpAccounts.length} accounts to upgrade via Gmail Dot-Trick...`);

    for (const acc of directNoOtpAccounts) {
      try {
        const baseGmail = getBaseGmail();
        const newEmail = generateGmailAlias(baseGmail, new Set(), '');
        console.log(`  Rescuing ${acc.username} -> New Email: ${newEmail}`);

        const updatedTimestamp = new Date().toISOString();
        const updatedLine = `"${updatedTimestamp}","${newEmail}","${acc.password}","${acc.username}","${acc.proxy}"`;
        readyAccounts.push(updatedLine);
      } catch (err) {
        pendingAccounts.push(acc.rawLine);
      }
    }
  }

  // 5. Write GitHub CSV Tiers
  const READY_CSV = path.join(DATA_DIR, 'github_accounts_ready.csv');
  const DIRECT_CSV = path.join(DATA_DIR, 'github_accounts_direct_no_otp.csv');
  const SUSPENDED_CSV = path.join(DATA_DIR, 'github_accounts_suspended.csv');
  const PENDING_CSV = path.join(DATA_DIR, 'github_accounts_pending.csv');

  fs.writeFileSync(READY_CSV, [headerLine, ...readyAccounts].join('\n') + '\n', 'utf8');
  fs.writeFileSync(GITHUB_CSV, [headerLine, ...readyAccounts].join('\n') + '\n', 'utf8');
  fs.writeFileSync(DIRECT_CSV, [headerLine].join('\n') + '\n', 'utf8');
  fs.writeFileSync(SUSPENDED_CSV, [headerLine, ...suspendedAccounts].join('\n') + '\n', 'utf8');
  fs.writeFileSync(PENDING_CSV, [headerLine, ...pendingAccounts].join('\n') + '\n', 'utf8');

  console.log('\n=== GITHUB CLASSIFICATION SUMMARY ===');
  console.log(`  🟢 Ready GitHub Accounts (Tier 1) : ${readyAccounts.length} -> ${READY_CSV}`);
  console.log(`  🔴 Suspended Accounts (Tier 3)     : ${suspendedAccounts.length} -> ${SUSPENDED_CSV}`);
  console.log(`  ⚪ Pending / Offline Accounts      : ${pendingAccounts.length} -> ${PENDING_CSV}`);
  console.log(`  📦 Master Backup                   : ${rawLines.length - 1} -> ${UNIFIED_BAK}\n`);

  return { readyAccounts, suspendedAccounts };
}

// ==========================================
// PHASE 5: CROSS-REFERENCE & COLUMN SYNC
// ==========================================
async function syncRegisteredGithubColumn(ghReadyAccounts, ghSuspendedAccounts) {
  console.log('------------------------------------------------------------');
  console.log(' [PHASE 5] Synchronizing `registered_github` in Outlook CSV');
  console.log('------------------------------------------------------------');

  const OUTLOOK_READY = path.join(DATA_DIR, 'outlook_accounts_ready.csv');
  const MAIN_CSV = path.join(DATA_DIR, 'outlook_accounts.csv');

  if (!fs.existsSync(OUTLOOK_READY)) return;

  const ghReadyMap = new Map();
  for (const l of ghReadyAccounts) {
    const p = parseCsvLine(l).map(x => x.replace(/^\"|\"$/g, ''));
    ghReadyMap.set(p[1].toLowerCase().trim(), p[3]);
  }

  const ghSuspendedMap = new Map();
  for (const l of ghSuspendedAccounts) {
    const p = parseCsvLine(l).map(x => x.replace(/^\"|\"$/g, ''));
    ghSuspendedMap.set(p[1].toLowerCase().trim(), p[3]);
  }

  const outLines = fs.readFileSync(OUTLOOK_READY, 'utf8').split('\n').filter(Boolean);
  const header = parseCsvLine(outLines[0]).map(h => h.replace(/^\"|\"$/g, ''));

  let newHeader = [...header];
  if (!newHeader.includes('registered_github')) newHeader.push('registered_github');

  const updatedRows = [newHeader.map(h => `"${h}"`).join(',')];

  for (let i = 1; i < outLines.length; i++) {
    const parts = parseCsvLine(outLines[i]).map(p => p.replace(/^\"|\"$/g, ''));
    const email = (parts[0] || '').toLowerCase().trim();

    let ghStatus = 'NO';
    if (ghReadyMap.has(email)) {
      ghStatus = `YES (${ghReadyMap.get(email)})`;
    } else if (ghSuspendedMap.has(email)) {
      ghStatus = `SUSPENDED (${ghSuspendedMap.get(email)})`;
    }

    const rowData = parts.slice(0, header.length);
    rowData.push(ghStatus);
    updatedRows.push(rowData.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(','));
  }

  fs.writeFileSync(OUTLOOK_READY, updatedRows.join('\n') + '\n', 'utf8');
  fs.writeFileSync(MAIN_CSV, updatedRows.join('\n') + '\n', 'utf8');

  console.log(`  ✅ Successfully synchronized ${updatedRows.length - 1} Outlook accounts with GitHub registration status!\n`);
}

async function main() {
  const outlookResult = await processOutlookAccounts();
  const validOutlookEmails = outlookResult ? outlookResult.readyEmails : new Set();

  const ghResult = await processGithubAccounts(validOutlookEmails);
  if (ghResult) {
    await syncRegisteredGithubColumn(ghResult.readyAccounts, ghResult.suspendedAccounts);
  }

  console.log('============================================================');
  console.log('       🎉 MASTER PIPELINE EXECUTION FULLY COMPLETED         ');
  console.log('============================================================\n');
}

main().catch(console.error);
