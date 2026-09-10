const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealthPlugin);

const { loadEnv } = require('../utils/env.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy } = require('../utils/browser.js');
const { waitForOtp: waitEmailOtp, loadOutlookAccounts } = require('../utils/email.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');
const TempMail = require('../services/tempmail/tempmail.js');

loadEnv();

function attachNavigationLogger(targetPage, label = 'Browser') {
  if (!targetPage) return;
  targetPage.on('framenavigated', frame => {
    if (frame === targetPage.mainFrame()) {
      console.log(`  [${label} Nav] -> ${frame.url()}`);
    }
  });
  targetPage.on('response', resp => {
    const status = resp.status();
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = resp.headers()['location'] || '';
      if (loc) {
        console.log(`  [${label} Redirect ${status}] ${resp.url()} -> ${loc}`);
      }
    }
  });
  targetPage.on('close', () => {
    console.log(`  [${label} Tab Closed]`);
  });
}

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

function resolveCsvFile(inputPath) {
  if (!inputPath) return path.join(__dirname, '..', 'data', 'kiro_accounts.csv');
  if (fs.existsSync(inputPath)) return inputPath;
  const inData = path.join(__dirname, '..', 'data', inputPath);
  if (fs.existsSync(inData)) return inData;
  const inRoot = path.join(__dirname, '..', inputPath);
  if (fs.existsSync(inRoot)) return inRoot;
  return path.join(__dirname, '..', 'data', inputPath);
}

const isDirect = args.has('direct') || args.has('no-proxy') || args.get('proxy') === 'false';
const explicitProxy = args.get('proxy') && args.get('proxy') !== 'true' && args.get('proxy') !== 'false' ? args.get('proxy') : (process.env.PROXY || '');

const config = {
  csv: resolveCsvFile(args.get('csv') || process.env.OMNIROUTE_KIRO_CSV),
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://100.103.220.104:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  headless: args.get('headed') === 'true' ? false : (args.get('headless') === 'true' ? true : (process.env.HEADLESS === 'false' ? false : true)),
  direct: isDirect,
  proxy: isDirect ? '' : explicitProxy,
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
};

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
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    return [];
  }
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value])))
    .map(row => ({
      timestamp: row.timestamp,
      email: row.email,
      password: row.password,
      api_key: row.api_key || '',
      imported_to_omniroute: row.imported_to_omniroute || ''
    }))
    .filter(row => row.email && row.password);
}

function updateCsvImportStatus(csvPath, email, statusValue) {
  if (!fs.existsSync(csvPath)) return;
  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length <= 1) return;

    const header = parseCsvLine(lines[0]);
    const emailIdx = header.indexOf('email');
    let importedIdx = header.indexOf('imported_to_omniroute');

    if (importedIdx === -1) {
      header.push('imported_to_omniroute');
      lines[0] = header.map(h => `"${h.replace(/"/g, '""')}"`).join(',');
      importedIdx = header.length - 1;
    }

    let modified = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const row = parseCsvLine(line);
      
      const rowEmail = row[emailIdx];
      if (rowEmail === email) {
        row[importedIdx] = statusValue;
        while (row.length < header.length) {
          row.push('');
        }
        lines[i] = row.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
        modified = true;
        break;
      }
    }

    if (modified) {
      fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
      console.log(`  [CSV] Status updated for ${email} in CSV.`);
    }
  } catch (err) {
    console.error(`  [WARN] Failed to write status back to CSV: ${err.message}`);
  }
}

async function loginOmniRoute(page) {
  console.log(`Navigating to OmniRoute login page: ${config.url}/login`);
  try {
    await page.goto(`${config.url}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    console.log(`  Navigation info: ${err.message}`);
  }
  
  const currentUrl = page.url();
  if (!currentUrl.includes('/login')) {
    console.log('  Already logged in.');
    return;
  }

  console.log('  Filling OmniRoute password...');
  const passwordInput = page.getByRole('textbox', { name: /password|enter your password/i })
    .or(page.locator('input[type="password"]'))
    .first();
  await passwordInput.fill(config.password);

  const loginButton = page.getByRole('button', { name: /continue|login|sign in|submit/i }).first();
  if (await loginButton.isVisible().catch(() => false)) {
    await loginButton.click();
  } else {
    await passwordInput.press('Enter');
  }

  console.log('  Waiting for redirect...');
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  console.log('  Logged in successfully.');
}

async function performAWSBuilderIdLogin(authPage, email, password, tempmail) {
  try {
    console.log('    [AWS Portal] Starting login flow...');
    await authPage.waitForLoadState('domcontentloaded');
    await sleep(3000);

    // 1. If "Confirm and continue" is visible first (Device Code flow)
    const confirmBtn = authPage.locator('button:has-text("Confirm and continue")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      console.log('    [AWS Portal] Click Confirm and continue (Device Code flow start)...');
      await confirmBtn.click();
      await sleep(4000);
    }

    console.log('    [AWS Portal] Filling email...');
    const emailInput = authPage.locator('input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await fillHuman(authPage, emailInput, email);
    await sleep(1000);

    const continueBtn = authPage.locator('button:has-text("Continue")').first();
    await continueBtn.click();
    await sleep(4500);

    // Password step
    if (await authPage.locator('input[type="password"]').isVisible().catch(() => false)) {
      console.log('    [AWS Portal] Password field detected, filling password...');
      const pwdInput = authPage.locator('input[type="password"]').first();
      await fillHuman(authPage, pwdInput, password);
      await sleep(1000);

      const signinBtn = authPage.locator('button:has-text("Continue")').filter({ visible: true }).first();
      await signinBtn.click();
      await sleep(6000);
    }

    // OTP step
    const isOtpVisible = await authPage.locator('input[placeholder="6-digit"], input[type="text"]').first().isVisible().catch(() => false);
    if (isOtpVisible) {
      console.log('    [AWS Portal] OTP verification requested, waiting for OTP email...');
      let otpCode = null;
      const isOutlook = /@(outlook|hotmail|live|msn)\./i.test(email);
      if (isOutlook) {
        const accounts = loadOutlookAccounts();
        const outlookAcc = accounts.find(a => (a.email || '').toLowerCase() === email.toLowerCase()) || { email, password };
        otpCode = await waitEmailOtp({
          mode: 'outlook',
          email,
          account: outlookAcc,
          timeout: 120000,
          interval: 3000,
          since: Date.now() - 60000,
        });
      } else {
        otpCode = await tempmail.waitForOtp(email, 120000);
      }
      if (!otpCode) {
        throw new Error('OTP not received or failed to extract.');
      }
      console.log(`    [AWS Portal] Retrieved OTP: ${otpCode}`);

      const otpInput = authPage.locator('input[placeholder="6-digit"], input[type="text"]').first();
      await fillHuman(authPage, otpInput, otpCode);
      await sleep(1000);

      const otpSubmitBtn = authPage.locator('button:has-text("Continue")').filter({ visible: true }).first();
      await otpSubmitBtn.click();
      await sleep(8000);
    }

    // 5. If "Confirm and continue" is visible now (Direct sign-in popup flow or post-OTP/device code confirm)
    const confirmBtnPost = authPage.locator('button:has-text("Confirm and continue")').first();
    if (await confirmBtnPost.isVisible().catch(() => false)) {
      console.log('    [AWS Portal] Click Confirm and continue (Direct Sign-in flow end)...');
      await confirmBtnPost.click();
      await sleep(5000);
    }

    // Allow/Approve step
    console.log('    [AWS Portal] Looking for Allow/Approve/Allow access button...');
    const allowBtn = authPage.locator('button:has-text("Allow"), button:has-text("Allow access"), button:has-text("Approve")').first();
    await allowBtn.waitFor({ state: 'visible', timeout: 25000 });
    console.log('    [AWS Portal] Clicking Allow button...');
    await allowBtn.click();
    await sleep(5000);
  } catch (err) {
    const errPath = path.join(__dirname, `scratch/error_authPage_${email.replace(/[@+.]/g, '_')}.png`);
    await authPage.screenshot({ path: errPath }).catch(() => {});
    console.log(`    [AWS Portal] Saved auth page error screenshot to: ${errPath}`);
    throw err;
  }
}

async function main() {
  console.log('=== Kiro OmniRoute Connection Automation ===');
  console.log(`Reading accounts from: ${config.csv}`);
  const rows = readAccounts(config.csv);
  
  const pendingRows = rows.filter(r => r.imported_to_omniroute !== 'true');
  console.log(`Found ${rows.length} total rows. Pending imports: ${pendingRows.length}`);

  if (pendingRows.length === 0) {
    console.log('No pending accounts to import.');
    return;
  }

  const tempmail = new TempMail();
  const pc = config.proxy ? proxyFromUrl(config.proxy) : null;
  if (pc) pc.bypass = 'localhost,127.0.0.1,100.*,10.*,192.168.*';
  const executablePathToUse = config.browserExecutablePath || undefined;
  const isCam = isCamoufox(executablePathToUse);
  const browserType = browserTypeFor(executablePathToUse);

  console.log(`Launching OmniRoute manager browser...`);
  let browser;
  let context;

  if (isCam) {
    const launchOpts = { headless: config.headless, args: ['--no-sandbox'] };
    if (executablePathToUse) launchOpts.executablePath = executablePathToUse;
    if (pc) launchOpts.proxy = pc;
    browser = await browserType.launch(launchOpts);
    context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta' });
  } else {
    const launchOpts = { headless: config.headless, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] };
    if (executablePathToUse) launchOpts.executablePath = executablePathToUse;
    if (pc) launchOpts.proxy = pc;
    browser = await browserType.launch(launchOpts);
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta'
    });
  }

  context.on('page', p => {
    console.log(`  [OmniRoute New Tab/Popup] Opened`);
    attachNavigationLogger(p, 'OmniRoute-Popup');
  });

  const page = await context.newPage();
  attachNavigationLogger(page, 'OmniRoute');

  try {
    await loginOmniRoute(page);

    console.log('Navigating to Kiro provider page...');
    await page.goto(`${config.url}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(8000);

    for (let idx = 0; idx < pendingRows.length; idx++) {
      const row = pendingRows[idx];
      const email = row.email;
      const password = row.password;

      console.log(`\n======================================================`);
      console.log(`[Import ${idx + 1}/${pendingRows.length}] Processing: ${email}`);
      console.log(`======================================================`);

      let popupCloseHandler = null;
      try {
        // Ensure we are back on Kiro provider page if somehow navigated away
        if (!page.url().includes('/dashboard/providers/kiro')) {
          console.log('  Ensuring provider page...');
          await page.goto(`${config.url}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }

        const addBtn = page.locator('button:has-text("Add Connection"), button:has-text("Add")').first();
        console.log('Clicking Add Connection button...');
        await addBtn.click();
        await page.waitForTimeout(2000);

        const continueWarningBtn = page.locator('button:has-text("I understand, continue")').first();
        if (await continueWarningBtn.isVisible().catch(() => false)) {
          console.log('  Bypassing warning modal...');
          await continueWarningBtn.click();
          await page.waitForTimeout(2000);
        }

        console.log('  Selecting AWS Builder ID option...');
        const builderIdOption = page.locator('text="AWS Builder ID"').first();

        // Setup popup interceptor to force device code flow (since popup flow can leak session state)
        popupCloseHandler = async (p) => {
          console.log('  [Popup Interceptor] Popup detected. Closing popup to force device code modal...');
          await p.close().catch(() => {});
        };
        context.on('page', popupCloseHandler);

        await builderIdOption.click();

        console.log('  Waiting for in-page device code verification modal...');
        
        // Wait up to 15s for the verification URL to appear in the modal
        const modalText = await page.waitForFunction(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return false;
          return dialog.innerText.includes('https://view.awsapps.com');
        }, { timeout: 15000 })
        .then(async () => await page.locator('[role="dialog"]').innerText())
        .catch(() => '');

        const urlMatch = modalText.match(/(https:\/\/view\.awsapps\.com\/[^\s\n]+)/);
        
        if (!urlMatch) {
          throw new Error(`Device code verification modal was not found. Modal content: "${modalText}"`);
        }

        const verificationUrl = urlMatch[1];
        console.log(`  Found device code flow. Verification URL: ${verificationUrl}`);

        // Remove the popup interceptor before starting manual login context
        context.off('page', popupCloseHandler);
        popupCloseHandler = null;

        // Open a completely fresh browser instance to isolate AWS login session with proxy
        let accountProxy = null;
        if (!config.direct) {
          accountProxy = selectProxy(config.proxy || null);
        }
        const ssoPc = accountProxy ? proxyFromUrl(accountProxy) : null;
        const proxyDisplay = accountProxy ? accountProxy.replace(/:[^:@]+@/, ':***@') : 'Direct (No Proxy)';
        console.log(`  Launching isolated AWS Builder ID login browser... [Proxy: ${proxyDisplay}]`);
        let ssoBrowser;
        if (isCam) {
          const launchOpts = { headless: config.headless, args: ['--no-sandbox'] };
          if (executablePathToUse) launchOpts.executablePath = executablePathToUse;
          if (ssoPc) launchOpts.proxy = ssoPc;
          ssoBrowser = await browserType.launch(launchOpts);
        } else {
          const launchOpts = { headless: config.headless, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] };
          if (executablePathToUse) launchOpts.executablePath = executablePathToUse;
          if (ssoPc) launchOpts.proxy = ssoPc;
          ssoBrowser = await browserType.launch(launchOpts);
        }

        const ssoContext = await ssoBrowser.newContext({
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'Asia/Jakarta',
          ignoreHTTPSErrors: true
        });

        ssoContext.on('page', p => {
          console.log(`  [AWS-SSO New Tab/Popup] Opened`);
          attachNavigationLogger(p, 'AWS-SSO-Popup');
        });

        const authPage = await ssoContext.newPage();
        attachNavigationLogger(authPage, 'AWS-SSO');
        try {
          await authPage.goto(verificationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await performAWSBuilderIdLogin(authPage, email, password, tempmail);
          console.log('  Device authorization login completed.');
        } finally {
          await authPage.close().catch(() => {});
          await ssoContext.close().catch(() => {});
          await ssoBrowser.close().catch(() => {});
        }

        // Wait for the modal on the main dashboard to automatically close (max 30s)
        console.log('  Waiting for verification modal on dashboard to close...');
        const modalClosed = await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 30000 }).then(() => true).catch(() => false);
        console.log(`  Verification modal closed status: ${modalClosed}`);

        console.log(`  Connection successful for ${email}!`);
        updateCsvImportStatus(config.csv, email, 'true');

      } catch (err) {
        console.error(`  [ERROR] Failed to import connection for ${email}:`, err.message);
        
        // Take diagnostic screenshot of main page
        const errScreenshotPath = path.join(__dirname, `scratch/error_import_${email.replace(/[@+.]/g, '_')}.png`);
        await page.screenshot({ path: errScreenshotPath }).catch(() => {});
        console.log(`  Saved error screenshot: ${errScreenshotPath}`);

        // Dismiss modal using Escape or Close button to prepare for next run
        const modalCloseBtn = page.locator('[role="dialog"] button:has-text("Close"), [role="dialog"] button').filter({ has: page.locator('svg') }).first();
        if (await modalCloseBtn.isVisible().catch(() => false)) {
          await modalCloseBtn.click().catch(() => {});
        } else {
          await page.keyboard.press('Escape');
        }
        await sleep(2000);

        // Ensure page is clean and on Kiro provider page for next run
        await page.goto(`${config.url}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } finally {
        if (popupCloseHandler) {
          context.off('page', popupCloseHandler);
        }
      }

      // Quick cooldown between accounts
      await sleep(5000);
    }

  } finally {
    console.log('Closing browser...');
    await browser.close().catch(() => {});
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
