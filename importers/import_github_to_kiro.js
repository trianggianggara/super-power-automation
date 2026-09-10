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

async function checkSuspended(page) {
  if (!page || page.isClosed()) return false;
  try {
    const url = page.url();
    const bodyText = await page.innerText('body').catch(() => '');
    
    // Explicit suspension URLs
    const isSuspendedUrl = url.includes('/suspended') || 
                           url.includes('support.github.com/tickets/suspended') || 
                           url.includes('support.github.com/contact/suspended');
    
    // Specific suspension phrases (excluding generic support search pages)
    const isSuspensionText = (
      bodyText.includes('Account suspended') || 
      bodyText.includes('account has been suspended') || 
      bodyText.includes('account has been flagged') ||
      bodyText.includes('suspended due to a violation') ||
      bodyText.includes('Your account is flagged')
    ) && !bodyText.includes('Search GitHub Support');
    
    if (isSuspendedUrl || isSuspensionText) {
      console.log(`  [SUSPENDED CHECK] Genuine suspension detected! URL: ${url}`);
      console.log('  Waiting 5 seconds before recording...');
      await sleep(5000);
      return true;
    }
  } catch (err) {}
  return false;
}

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

async function getElementInfo(locator) {
  try {
    return await locator.evaluate(el => {
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || el.textContent || el.value || '').trim().replace(/\s+/g, ' ');
      const id = el.id ? ` id="${el.id}"` : '';
      const name = el.getAttribute('name') ? ` name="${el.getAttribute('name')}"` : '';
      const val = el.getAttribute('value') ? ` value="${el.getAttribute('value')}"` : '';
      const type = el.getAttribute('type') ? ` type="${el.getAttribute('type')}"` : '';
      const aria = el.getAttribute('aria-label') ? ` aria-label="${el.getAttribute('aria-label')}"` : '';
      return `<${tag}${type}${id}${name}${val}${aria}> "${text.length > 60 ? text.slice(0, 57) + '...' : text}"`;
    }, { timeout: 1500 });
  } catch (e) {
    return 'unknown element';
  }
}

async function clickWithDebug(locator, label, options = {}) {
  try {
    const isVis = await locator.isVisible().catch(() => false);
    if (!isVis) {
      console.log(`  [Click] ${label}: not visible.`);
      return false;
    }
    const info = await getElementInfo(locator);
    console.log(`  [Click] ${label} -> Clicking: ${info}`);
    await locator.click({ noWaitAfter: true, timeout: options.timeout || 3000, ...options });
    return true;
  } catch (err) {
    console.log(`  [Click] ${label} skipped or non-blocking error: ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function listPageButtons(page, prefix = '  [Page Buttons]') {
  try {
    const list = await page.locator('button, input[type="submit"], input[type="button"], a[role="button"]').evaluateAll(els =>
      els.filter(e => e.offsetParent !== null || e.offsetWidth > 0 || e.offsetHeight > 0)
         .map(e => {
            const tag = e.tagName.toLowerCase();
            const text = (e.innerText || e.textContent || e.value || '').trim().replace(/\s+/g, ' ');
            const id = e.id ? ` id="${e.id}"` : '';
            const name = e.getAttribute('name') ? ` name="${e.getAttribute('name')}"` : '';
            const val = e.getAttribute('value') ? ` value="${e.getAttribute('value')}"` : '';
            const type = e.getAttribute('type') ? ` type="${e.getAttribute('type')}"` : '';
            return `<${tag}${type}${id}${name}${val}> "${text.length > 40 ? text.slice(0, 37) + '...' : text}"`;
         })
    );
    if (list.length > 0) {
      console.log(`${prefix} Visible: ${list.join(' | ')}`);
    } else {
      console.log(`${prefix} No visible buttons found.`);
    }
  } catch (e) {}
}

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

function resolveCsvFile(inputPath) {
  if (!inputPath) return path.join(__dirname, '..', 'data', 'github_accounts.csv');
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
  csv: resolveCsvFile(args.get('csv') || process.env.OMNIROUTE_GITHUB_CSV),
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
      username: row.username,
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
  await page.waitForLoadState('load');
  console.log('  Logged in successfully.');
}

async function main() {
  console.log('=== GitHub OmniRoute Kiro Import Automation ===');
  console.log(`Reading accounts from: ${config.csv}`);
  const rows = readAccounts(config.csv);
  
  const pendingRows = rows.filter(r => r.imported_to_omniroute !== 'true' && r.imported_to_omniroute !== 'suspended');
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
    let navigated = false;
    for (let i = 1; i <= 3; i++) {
      try {
        await page.goto(`${config.url}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        navigated = true;
        break;
      } catch (err) {
        if (err.message.includes('NS_BINDING_ABORTED') || err.message.includes('aborted')) {
          console.log(`  [WARN] Navigation aborted by browser (attempt ${i}/3). Retrying in 3 seconds...`);
          await sleep(3000);
        } else {
          throw err;
        }
      }
    }
    if (!navigated) {
      throw new Error('Failed to navigate to Kiro provider page due to repeated browser aborts.');
    }
    await sleep(5000);

    for (let idx = 0; idx < pendingRows.length; idx++) {
      const row = pendingRows[idx];
      const email = row.email;
      const password = row.password;
      const username = row.username;

      console.log(`\n======================================================`);
      console.log(`[Import ${idx + 1}/${pendingRows.length}] Connecting GitHub: ${email}`);
      console.log(`======================================================`);

      try {
        if (!page.url().includes('/dashboard/providers/kiro')) {
          console.log('  Ensuring provider page...');
          await page.goto(`${config.url}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await sleep(3000);
        }

        const addBtn = page.locator('button:has-text("Add Connection"), button:has-text("Add")').first();
        console.log('Clicking Add Connection button...');
        await clickWithDebug(addBtn, 'OmniRoute Add Connection button');
        await sleep(2000);

        const continueWarningBtn = page.locator('button:has-text("I understand, continue")').first();
        if (await continueWarningBtn.isVisible().catch(() => false)) {
          console.log('  Bypassing warning modal...');
          await clickWithDebug(continueWarningBtn, 'Warning modal Continue button');
          await sleep(2000);
        }

        console.log('  Selecting GitHub connection option...');
        const githubOption = page.locator('text="GitHub Account"').first();
        await clickWithDebug(githubOption, 'GitHub Account option');
        await sleep(2000);

        console.log('  Waiting for in-page device code verification modal...');
        
        // Wait up to 15s for the verification URL to appear in the modal
        const modalText = await page.waitForFunction(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return false;
          return dialog.innerText.includes('https://app.kiro.dev/account/device');
        }, { timeout: 15000 })
        .then(async () => await page.locator('[role="dialog"]').innerText())
        .catch(() => '');

        const urlMatch = modalText.match(/(https:\/\/app\.kiro\.dev\/account\/device[^\s\n]+)/);
        
        if (!urlMatch) {
          throw new Error(`Device code verification modal was not found. Modal content: "${modalText}"`);
        }

        const verificationUrl = urlMatch[1];
        console.log(`  Found device code flow. Verification URL: ${verificationUrl}`);

        // Open a completely fresh browser instance to isolate GitHub login session with proxy
        let accountProxy = null;
        if (!config.direct) {
          accountProxy = selectProxy(config.proxy || null);
        }
        const ssoPc = accountProxy ? proxyFromUrl(accountProxy) : null;
        const proxyDisplay = accountProxy ? accountProxy.replace(/:[^:@]+@/, ':***@') : 'Direct (No Proxy)';
        console.log(`  Launching isolated GitHub login browser... [Proxy: ${proxyDisplay}]`);

        let ssoBrowser = null;
        let ssoContext = null;
        let authPage = null;
        let isSuspended = false;
        try {
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

          ssoContext = await ssoBrowser.newContext({
            viewport: isCam ? null : { width: 1366, height: 768 },
            locale: 'en-US',
            timezoneId: 'Asia/Jakarta',
            ignoreHTTPSErrors: true
          });

          ssoContext.on('page', p => {
            console.log(`  [SSO New Tab/Popup] Opened`);
            attachNavigationLogger(p, 'GitHub-SSO-Popup');
          });

          authPage = await ssoContext.newPage();
          attachNavigationLogger(authPage, 'GitHub-SSO');

          await authPage.goto(verificationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          // Wait up to 6s for automatic redirect to GitHub domain (since login_provider=Github is present in URL)
          await authPage.waitForURL(url => url.hostname.includes('github.com'), { timeout: 6000 }).catch(() => {});
          if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');

          // Click GitHub sign-in option on Kiro device authorization page ONLY if not already redirected to GitHub
          if (!authPage.url().includes('github.com')) {
            const githubSignInBtn = authPage.locator('button:has-text("Continue with GitHub"), button:has-text("Sign in with GitHub"), button:has-text("GitHub"), a[href*="github.com/login/oauth"], a:has-text("Continue with GitHub"), a:has-text("Sign in with GitHub")').first();
            const hasSignInBtn = await githubSignInBtn.isVisible({ timeout: 2000 }).catch(() => false);
            if (hasSignInBtn) {
              console.log('  [GitHub SSO] Found GitHub login button on Kiro page.');
              await clickWithDebug(githubSignInBtn, '[GitHub SSO] Sign in with GitHub button', { timeout: 3000 });
              await sleep(2000);
              if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');
            }
          }

          // Handle intermediate "Continue with GitHub" button on GitHub landing page ONLY if not yet on login/oauth page
          if (!authPage.url().includes('github.com/login')) {
            const continueWithGithubBtn = authPage.locator('a:has-text("Continue with GitHub"), button:has-text("Continue with GitHub")').first();
            const hasContinueBtn = await continueWithGithubBtn.isVisible({ timeout: 2000 }).catch(() => false);
            if (hasContinueBtn) {
              console.log('  [GitHub SSO] Intermediate landing page detected.');
              await clickWithDebug(continueWithGithubBtn, '[GitHub SSO] Intermediate Continue with GitHub button', { timeout: 3000 });
              await sleep(2000);
              if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');
            }
          }

          // Check if we need to login to GitHub (wait up to 15 seconds for redirect/loading)
          const githubLoginInput = authPage.locator('input#login_field, input[name="login"]').first();
          const needLogin = await githubLoginInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
          if (needLogin) {
            console.log('  [GitHub SSO] Entering username/email...');
            await fillHuman(authPage, githubLoginInput, username || email);
            
            const passwordInput = authPage.locator('input#password, input[name="password"]').first();
            await fillHuman(authPage, passwordInput, password);
            await sleep(500);

            const signInBtn = authPage.locator('form[action*="session"] input[type="submit"], form[action*="session"] button[type="submit"], input[name="commit"], input[type="submit"][value="Sign in"], button:has-text("Sign in")').first();
            if (await signInBtn.isVisible().catch(() => false)) {
              await clickWithDebug(signInBtn, '[GitHub SSO] GitHub Login Sign in button');
            } else {
              console.log('  [GitHub SSO] Sign in button not visible, pressing Enter on password input...');
              await passwordInput.press('Enter');
            }
            await sleep(5000);
            if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');

            // Handle GitHub OTP code if triggered
            const otpInput = authPage.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"], input[name*="code" i], input[autocomplete="one-time-code"]').first();
            const needOtp = await otpInput.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
            if (needOtp) {
              console.log('  [GitHub SSO] GitHub device verification code requested. Waiting for email...');
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
                throw new Error('Failed to retrieve GitHub verification OTP from email.');
              }
              console.log(`  [GitHub SSO] Entering verification code: ${otpCode}`);
              await fillHuman(authPage, otpInput, otpCode);
              await sleep(1500);
              
              // Only search for and click OTP verify button if we are STILL on the verification/2FA page
              const urlAfterOtp = authPage.url();
              if (urlAfterOtp.includes('verified-device') || urlAfterOtp.includes('two-factor') || urlAfterOtp.includes('sessions/verified')) {
                const verifyBtn = authPage.locator(
                  'form[action*="verified-device"] button[type="submit"], ' +
                  'form[action*="verified-device"] input[type="submit"], ' +
                  'form[action*="two-factor"] button[type="submit"], ' +
                  'form[action*="two-factor"] input[type="submit"], ' +
                  'button:has-text("Verify"), ' +
                  'input[type="submit"][value*="Verify" i]'
                ).filter({ hasNotText: /cancel|batal|resend/i }).first();

                const hasVerifyBtn = await verifyBtn.isVisible().catch(() => false);
                if (hasVerifyBtn) {
                  await clickWithDebug(verifyBtn, '[GitHub SSO] OTP Verify button');
                } else {
                  console.log('  [GitHub SSO] No separate Verify button visible, pressing Enter on OTP input...');
                  await otpInput.press('Enter').catch(() => {});
                }
              } else {
                console.log(`  [GitHub SSO] Page already auto-submitted and navigated to: ${urlAfterOtp}`);
              }
              await sleep(5000);
              if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');
            }
          }

          // Check if OAuth error was received on redirect
          const checkOAuthError = (testUrl) => {
            if (testUrl.includes('error=access_denied') || testUrl.includes('error_description=')) {
              let errorDesc = 'Access denied';
              try {
                const parsed = new URL(testUrl);
                errorDesc = parsed.searchParams.get('error_description') || parsed.searchParams.get('error') || 'Access denied';
              } catch (e) {}
              return decodeURIComponent(errorDesc);
            }
            return null;
          };

          const potentialErr = checkOAuthError(authPage.url());
          if (potentialErr) {
            throw new Error(`GitHub OAuth error: ${potentialErr}`);
          }

          // Authorize OAuth App if on GitHub OAuth authorization page
          // Specifically search for Authorize button (value="1", id="js-oauth-authorize-btn", text="Authorize")
          // and STRICTLY AVOID clicking Cancel button (name="authorize" value="0" or text "Cancel")
          const currentUrlBeforeAuth = authPage.url();
          if (currentUrlBeforeAuth.includes('/oauth') || currentUrlBeforeAuth.includes('/authorize')) {
            console.log(`  [GitHub SSO] On OAuth Authorization page: ${currentUrlBeforeAuth}`);
            await listPageButtons(authPage, '  [GitHub OAuth Debug Buttons]');
          }

          const authorizeBtn = authPage.locator(
            '#js-oauth-authorize-btn, ' +
            'button[name="authorize"][value="1"], ' +
            'input[name="authorize"][value="1"], ' +
            'button[data-octo-click*="accept"], ' +
            'form[action*="/login/oauth/authorize"] button[type="submit"]:not([value="0"]), ' +
            'button:has-text("Authorize"), ' +
            'button:has-text("Otorisasikan"), ' +
            'button:has-text("Setujui")'
          ).filter({
            hasNotText: /cancel|batal|deny|tolak/i
          }).first();

          const hasAuthorizeBtn = await authorizeBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
          if (hasAuthorizeBtn) {
            console.log('  [GitHub SSO] Found GitHub Authorize button.');
            await clickWithDebug(authorizeBtn, '[GitHub SSO] GitHub OAuth Authorize button');
            await sleep(5000);
            if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');
          } else {
            console.log('  [GitHub SSO] Already authorized or authorize button not displayed. (Current URL: ' + authPage.url() + ')');
          }

          const potentialErr2 = checkOAuthError(authPage.url());
          if (potentialErr2) {
            throw new Error(`GitHub OAuth error: ${potentialErr2}`);
          }

          // Wait for either the Approve button or the Done button to become visible on Kiro SSO redirect page
          console.log('  [GitHub SSO] Waiting for Kiro Device Authorization page (Approve or Done)...');
          const kiroApproveBtn = authPage.locator('button:has-text("Approve"), button:has-text("Authorize"), button[type="submit"]:has-text("Approve")').filter({ hasNotText: /cancel|deny/i }).first();
          const kiroDoneBtn = authPage.locator('button:has-text("Done"), button:has-text("Close"), a:has-text("Done")').first();

          await Promise.race([
            kiroApproveBtn.waitFor({ state: 'visible', timeout: 35000 }).catch(() => {}),
            kiroDoneBtn.waitFor({ state: 'visible', timeout: 35000 }).catch(() => {})
          ]);

          if (await checkSuspended(authPage)) throw new Error('GITHUB_SUSPENDED');

          const isApproveVisible = await kiroApproveBtn.isVisible().catch(() => false);
          const isDoneVisible = await kiroDoneBtn.isVisible().catch(() => false);
          const bodyText = await authPage.innerText('body').catch(() => '');

          if (isApproveVisible) {
            console.log('  [GitHub SSO] Found Kiro Approve button.');
            await clickWithDebug(kiroApproveBtn, '[GitHub SSO] Kiro Device Approve button');
            await sleep(5000);
            
            // Now wait for Done button to become visible
            console.log('  [GitHub SSO] Waiting for Kiro Device Authorized confirmation page...');
            await kiroDoneBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
            const hasDoneBtn = await kiroDoneBtn.isVisible().catch(() => false);
            if (hasDoneBtn) {
              await clickWithDebug(kiroDoneBtn, '[GitHub SSO] Kiro Device Done button');
              await sleep(3000);
            } else {
              console.log('  [GitHub SSO] Done button did not appear but approval was sent. Proceeding...');
            }
          } else if (isDoneVisible) {
            console.log('  [GitHub SSO] Device is already authorized.');
            await clickWithDebug(kiroDoneBtn, '[GitHub SSO] Kiro Device Done button');
            await sleep(3000);
          } else if (bodyText.includes('successfully') || bodyText.includes('Authorized') || bodyText.includes('Congratulations')) {
            console.log('  [GitHub SSO] Page indicates successful authorization. Proceeding...');
            await sleep(3000);
          } else {
            await listPageButtons(authPage, '  [Kiro Page Debug Buttons]');
            throw new Error(`Neither Kiro Approve nor Done buttons became visible. Page snippet: "${bodyText.substring(0, 300)}"`);
          }
        } catch (innerErr) {
          isSuspended = innerErr.message === 'GITHUB_SUSPENDED' || await checkSuspended(authPage).catch(() => false);
          if (isSuspended) {
            throw new Error('GITHUB_SUSPENDED');
          }
          if (authPage && !authPage.isClosed()) {
            const ssoErrScreenshotPath = path.join(__dirname, `scratch/sso_error_${email.replace(/[@+.]/g, '_')}.png`);
            await authPage.screenshot({ path: ssoErrScreenshotPath }).catch(() => {});
            console.log(`  Saved SSO error screenshot to: ${ssoErrScreenshotPath}`);
          }
          throw innerErr;
        } finally {
          if (authPage) await authPage.close().catch(() => {});
          if (ssoContext) await ssoContext.close().catch(() => {});
          if (ssoBrowser) await ssoBrowser.close().catch(() => {});
        }

        // Wait for the modal on the main dashboard to automatically close (max 30s)
        console.log('  Waiting for verification modal on dashboard to close...');
        const modalClosed = await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 30000 }).then(() => true).catch(() => false);
        console.log(`  Verification modal closed status: ${modalClosed}`);

        if (!modalClosed) {
          throw new Error('Verification modal on dashboard did not close (authorization failed or timed out).');
        }

        console.log(`  GitHub Account ${email} successfully linked to Kiro!`);
        updateCsvImportStatus(config.csv, email, 'true');

      } catch (err) {
        if (err.message === 'GITHUB_SUSPENDED') {
          console.error(`  [SUSPENDED] GitHub account ${email} is suspended by GitHub! Flagging in CSV...`);
          updateCsvImportStatus(config.csv, email, 'suspended');
        } else {
          console.error(`  [ERROR] Failed to link GitHub account ${email}:`, err.message);
          
          // Save error screenshot
          const errScreenshotPath = path.join(__dirname, `scratch/error_link_${email.replace(/[@+.]/g, '_')}.png`);
          await page.screenshot({ path: errScreenshotPath }).catch(() => {});
          console.log(`  Saved error screenshot to: ${errScreenshotPath}`);
        }

        // Dismiss modal to prepare for next run
        const modalCloseBtn = page.locator('[role="dialog"] button:has-text("Close"), [role="dialog"] button').filter({ has: page.locator('svg') }).first();
        if (await modalCloseBtn.isVisible().catch(() => false)) {
          await modalCloseBtn.click().catch(() => {});
        } else {
          await page.keyboard.press('Escape');
        }
        await sleep(2000);

         await page.goto(`${config.url}/dashboard/providers/kiro`, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
         await sleep(3000);
       }

      await sleep(4000);
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
