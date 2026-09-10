// registrars/register_codebuddy.js — Auto-register CodeBuddy via GitHub OAuth
const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const TempMail = require('../services/tempmail/tempmail.js');
const { resolveEmail, waitForOtp } = require('../utils/email.js');
const { isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const { sleep, rand, fillHuman } = require('../utils/helpers.js');

const rawBrowserPath = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
// Playwright-extra chromium requires a Chromium-based browser executable (not Camoufox/Firefox)
const chromiumExecutablePath = (rawBrowserPath && !isCamoufox(rawBrowserPath) && fs.existsSync(rawBrowserPath))
  ? rawBrowserPath
  : undefined;

const CONFIG = {
  signupUrl: process.env.CODEBUDDY_SIGNUP_URL || 'https://www.codebuddy.ai/login',
  githubPassword: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'codebuddy_accounts.csv'),
  browserExecutablePath: chromiumExecutablePath,
};

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function loadUsedEmails(outputFile) {
  const used = new Set();
  if (fs.existsSync(outputFile)) {
    try {
      const content = fs.readFileSync(outputFile, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, '').trim());
        const email = parts[0]?.toLowerCase();
        if (email && email !== 'email' && email.includes('@')) {
          used.add(email);
        }
      }
    } catch (_) {}
  }
  return used;
}

function loadCsvAccounts(csvName) {
  const csv = path.join(__dirname, '..', 'data', csvName);
  if (!fs.existsSync(csv)) return [];
  try {
    const content = fs.readFileSync(csv, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase().trim());
    const emailIdx = headers.indexOf('email');
    const passIdx = headers.indexOf('password');
    return lines.slice(1).map(l => {
      const parts = parseCsvLine(l).map(p => p.replace(/^"|"$/g, '').trim());
      return {
        email: parts[emailIdx >= 0 ? emailIdx : 0] || '',
        password: parts[passIdx >= 0 ? passIdx : 1] || ''
      };
    }).filter(a => a.email && a.password && a.email.includes('@'));
  } catch (err) {
    console.warn(`  [WARN] Failed to load ${csvName}: ${err.message}`);
    return [];
  }
}

// Pick account — supports both Outlook and GitHub CSV sources
function pickAccount() {
  const useGithubAccounts = process.argv.includes('--github') && !process.argv.includes('--outlook');
  const useOutlookAccounts = process.env.CODEBUDDY_MODE === 'outlook' || process.argv.includes('--outlook');
  const used = loadUsedEmails(CONFIG.outputFile);

  const ghAccounts = loadCsvAccounts('github_accounts.csv');
  const ghMap = new Map(ghAccounts.map(a => [a.email.toLowerCase(), a.password]));

  if (useOutlookAccounts) {
    // 1. Prefer accounts in github_accounts.csv that are Outlook emails (with correct GitHub password)
    let accounts = ghAccounts.filter(a => /@(outlook|hotmail|live|msn)\./i.test(a.email) && !used.has(a.email.toLowerCase()));
    
    // 2. If none in github_accounts.csv, check outlook_accounts.csv and map GitHub password if exists
    if (accounts.length === 0) {
      const oAccounts = loadCsvAccounts('outlook_accounts.csv');
      accounts = oAccounts
        .filter(a => !used.has(a.email.toLowerCase()))
        .map(o => ({
          email: o.email,
          password: ghMap.get(o.email.toLowerCase()) || o.password
        }));
    }
    if (accounts.length === 0) throw new Error('No available Outlook accounts found for CodeBuddy');
    const chosen = accounts[Math.floor(Math.random() * accounts.length)];
    const finalPassword = ghMap.get(chosen.email.toLowerCase()) || chosen.password;
    console.log(`[*] Using Outlook account for GitHub login: ${chosen.email} (Password source: ${ghMap.has(chosen.email.toLowerCase()) ? 'github_accounts.csv' : 'outlook_accounts.csv'})`);
    return { email: chosen.email, password: finalPassword, mode: 'outlook' };
  }

  // Default: GitHub accounts from github_accounts.csv
  if (ghAccounts.length === 0) throw new Error('No GitHub accounts in data/github_accounts.csv');
  const fresh = ghAccounts.filter(a => !used.has(a.email.toLowerCase()));
  if (fresh.length === 0) throw new Error('All GitHub accounts in github_accounts.csv have already been used for CodeBuddy');
  const chosen = fresh[Math.floor(Math.random() * fresh.length)];
  console.log(`[*] Using GitHub account: ${chosen.email}`);
  return { email: chosen.email, password: chosen.password, mode: 'github' };
}

async function handleGithubExtraStep(page, account) {
  // OTP
  const otpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i]').first();
  if (await otpInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log('  GitHub OTP requested. Waiting for verification code...');
    let otp = null;
    const isOutlookEmail = account.email.toLowerCase().includes('@outlook.') || account.email.toLowerCase().includes('@hotmail.');
    if (account.mode === 'outlook' || isOutlookEmail) {
      otp = await waitForOtp({ mode: 'outlook', email: account.email, account, timeout: 120000, since: Date.now() - 60000 });
    } else {
      const tm = new TempMail();
      otp = await tm.waitForOtp(account.email, 120000, 3000, Date.now() - 60000);
    }
    if (otp) {
      await otpInput.fill(otp);
      await sleep(300);
      await page.keyboard.press('Enter');
      return true;
    }
  }
  // Device verification
  const verifyBtn = page.locator('button:has-text("Verify"), input[value="Verify"]').first();
  if (await verifyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('  GitHub device verification page. Clicking Verify...');
    await verifyBtn.click();
    await sleep(5000);
    return true;
  }
  // CAPTCHA (if any)
  const captchaFrame = page.locator('iframe[title*="challenge" i], iframe[src*="captcha" i]');
  if (await captchaFrame.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  ⚠️ GitHub CAPTCHA detected. Trying to bypass...');
    return false;
  }
  return false;
}

async function handleServiceAgreement(page, frame = null) {
  const targets = frame ? [frame, page] : [page];
  for (const t of targets) {
    try {
      // 1. Check for unchecked checkboxes (Service agreement / Privacy policy)
      const checkboxes = t.locator('input[type="checkbox"], [role="checkbox"]');
      const count = await checkboxes.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const cb = checkboxes.nth(i);
        const isVisible = await cb.isVisible({ timeout: 400 }).catch(() => false);
        if (isVisible) {
          const isChecked = await cb.isChecked().catch(() => false);
          if (!isChecked) {
            console.log('  [Service Agreement] Checking terms/agreement checkbox...');
            await cb.check({ force: true }).catch(() => cb.click({ force: true }));
            await sleep(400);
          }
        }
      }

      // 2. Check for agreement dialog / popup buttons
      const agreeBtns = [
        t.locator('button:has-text("Agree"), button:has-text("Accept"), button:has-text("Confirm"), button:has-text("I Agree"), button:has-text("Setuju")').first(),
        t.locator('.modal button, .dialog button, [role="dialog"] button').filter({ hasText: /agree|accept|confirm|continue/i }).first()
      ];
      for (const btn of agreeBtns) {
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log('  [Service Agreement] Clicking Agree/Confirm in dialog...');
          await btn.click({ force: true }).catch(() => {});
          await sleep(1000);
        }
      }
    } catch (_) {}
  }
}

async function handleCountryAndComplete(page) {
  console.log('[4/4] Selecting current country & completing registration...');
  const start = Date.now();

  while (Date.now() - start < 60000) {
    const url = page.url();

    // Check for IP restriction
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes('Account Access Restricted') || bodyText.includes('security policy restrictions')) {
      throw new Error('CodeBuddy IP/Security Policy Restriction: Account Access Restricted (Tencent Cloud requires a valid clean proxy)');
    }

    // If already in dashboard / console / chat / home (success)
    if (!url.includes('register') && !url.includes('login') && !url.includes('github.com') && !url.includes('openid-connect')) {
      return true;
    }

    // Step A: Handle any agreement checkbox on complete page
    await handleServiceAgreement(page);

    // Step B: Handle Country / Region Dropdown
    const countrySelectors = [
      page.locator('select[name*="country" i], select[name*="region" i]').first(),
      page.locator('[role="combobox"]').first(),
      page.locator('.ant-select, .el-select, div[class*="select" i]').first(),
      page.locator('input[placeholder*="country" i], input[placeholder*="region" i]').first(),
    ];

    for (const sel of countrySelectors) {
      if (await sel.isVisible({ timeout: 800 }).catch(() => false)) {
        console.log('  Country selector detected. Confirming current selection...');
        const tagName = await sel.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
        if (tagName === 'select') {
          await sel.selectOption({ index: 1 }).catch(() => {});
        } else {
          await sel.click().catch(() => {});
          await sleep(500);
          const option = page.locator('[role="option"], .ant-select-item, .el-select-dropdown__item, li').first();
          if (await option.isVisible({ timeout: 1500 }).catch(() => false)) {
            await option.click().catch(() => {});
          }
        }
        await sleep(800);
        break;
      }
    }

    // Step C: Click Confirm / Complete / Continue / Submit button
    const submitBtns = [
      page.locator('button:has-text("Complete"), button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Next"), button:has-text("Get Started")').first(),
      page.locator('input[type="submit"], button[type="submit"]').first(),
    ];

    for (const btn of submitBtns) {
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        console.log('  Clicking Complete / Confirm button...');
        await btn.click().catch(() => {});
        await sleep(3000);
        break;
      }
    }

    await sleep(2000);
  }

  const finalUrl = page.url();
  return !finalUrl.includes('register') && !finalUrl.includes('login') && !finalUrl.includes('github.com');
}

async function register() {
  console.log('=== CodeBuddy Auto-Registration (GitHub OAuth) ===');
  
  const selectedProxy = process.argv.includes('--direct') ? null : selectProxy();
  const proxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
  if (proxyConfig) console.log(`[*] Proxy: ${proxyConfig.server}`);
  else console.log(`[*] Direct (no proxy)`);

  const account = pickAccount();

  const launchOpts = {
    headless: envFlag('HEADLESS', false),
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreHTTPSErrors: true,
  };
  if (proxyConfig) launchOpts.proxy = proxyConfig;
  if (CONFIG.browserExecutablePath) launchOpts.executablePath = CONFIG.browserExecutablePath;

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(45000);

  try {
    // Step 1: Open CodeBuddy login page
    console.log('[1/4] Opening CodeBuddy and finding Sign up with GitHub...');
    let navSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(CONFIG.signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        navSuccess = true;
        break;
      } catch (e) {
        console.warn(`  [WARN] Failed to open ${CONFIG.signupUrl} (attempt ${attempt}/3): ${e.message}`);
        if (attempt === 3) throw e;
        await sleep(3000);
      }
    }
    
    // Wait for Keycloak iframe (openid-connect)
    let kcFrame = null;
    const startFrameWait = Date.now();
    while (Date.now() - startFrameWait < 45000) {
      const frames = page.frames();
      kcFrame = frames.find(f => f.url().includes('openid-connect'));
      if (kcFrame) break;
      await sleep(1000);
    }
    if (!kcFrame) throw new Error('Keycloak iframe (openid-connect) not found within timeout');

    // Step 2: Confirm Service Agreement before/during GitHub click
    console.log('[2/4] Confirming Service Agreement...');
    await handleServiceAgreement(page, kcFrame);

    // Click Sign up with GitHub inside iframe
    const ghBtn = kcFrame.locator('#social-github, [data-provider="github"], button:has-text("GitHub"), a:has-text("GitHub")').first();
    await ghBtn.waitFor({ state: 'visible', timeout: 35000 });
    console.log('  Clicking Sign up with GitHub button...');
    
    const ghUrl = await ghBtn.getAttribute('href');
    if (!ghUrl) {
      await ghBtn.click();
    } else {
      const targetUrl = ghUrl.startsWith('http') ? ghUrl : new URL(ghUrl, kcFrame.url()).href;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await sleep(2000);
    // Re-check for any service agreement dialog popup
    await handleServiceAgreement(page);
    await sleep(2000);

    // Step 3: Login GitHub and Authorize
    console.log('[3/4] Logging in to GitHub and Authorizing...');
    const onGithub = page.url().includes('github.com');

    if (onGithub && page.url().includes('/login')) {
      await sleep(2000);
      
      const ghLogin = page.locator('input#login_field, input[name="login"]').first();
      if (await ghLogin.isVisible({ timeout: 25000 }).catch(() => false)) {
        console.log('  Entering GitHub credentials...');
        await ghLogin.fill(account.email);
        await sleep(rand(300, 600));
        const ghPass = page.locator('input#password, input[name="password"]').first();
        await ghPass.fill(account.password);
        await sleep(rand(300, 600));
        const signIn = page.locator('input[type="submit"], button:has-text("Sign in")').first();
        await signIn.click();
        await sleep(5000);

        // Check for Invalid Credentials or Suspension on GitHub
        const bodyText = await page.innerText('body').catch(() => '');
        if (bodyText.includes('Incorrect username or password') || bodyText.includes('There have been several failed attempts')) {
          console.error(`  ❌ [INVALID CREDENTIALS] GitHub rejected login for ${account.email}!`);
          throw new Error(`GITHUB_INVALID_CREDENTIALS: Incorrect username or password for ${account.email}`);
        }
        if (page.url().includes('/suspended') || bodyText.includes('Account suspended') || bodyText.includes('flagged')) {
          console.error(`  ❌ [SUSPENDED] GitHub account ${account.email} is suspended!`);
          throw new Error(`GITHUB_SUSPENDED: Account ${account.email} is suspended`);
        }

        const handledExtra = await handleGithubExtraStep(page, account);
        if (handledExtra) {
          console.log('  Extra verification step handled');
          await sleep(5000);
        }
      }
    }

    // Wait for OAuth Authorize button (if prompted)
    const startAuth = Date.now();
    while (Date.now() - startAuth < 45000) {
      const url = page.url();
      if (url.includes('codebuddy.ai') && !url.includes('openid-connect') && !url.includes('broker')) {
        break;
      }
      const authBtn = page.locator('#js-oauth-authorize-btn, button[name="authorize"], button:has-text("Authorize")').first();
      if (await authBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await authBtn.click();
        console.log('  Clicked GitHub Authorize button!');
        await sleep(5000);
        break;
      }
      await sleep(1500);
    }

    // Step 4: Select Country Current and Complete Registration
    const success = await handleCountryAndComplete(page);

    if (success) {
      console.log(`  ✅ Registered successfully! Final URL: ${page.url()}`);
      
      // Save to CSV
      const csvDir = path.dirname(CONFIG.outputFile);
      if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });
      const isNew = !fs.existsSync(CONFIG.outputFile);
      if (isNew) {
        fs.writeFileSync(CONFIG.outputFile, '"email","password","platform","registered_at"\n');
      }
      fs.appendFileSync(CONFIG.outputFile,
        `"${account.email}","${account.password}","codebuddy","${new Date().toISOString()}"\n`
      );
      console.log(`  Saved account to ${CONFIG.outputFile}`);
    } else {
      console.log('  ⚠️ Timeout or incomplete onboarding.');
      try {
        const ssDir = path.join(__dirname, '..', 'screenshots');
        if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
        const ssPath = path.join(ssDir, `codebuddy_timeout_${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: true });
        console.log(`  📸 Screenshot: ${ssPath}`);
      } catch (_) {}
    }

  } catch (err) {
    console.error('Error during registration:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err, { service: 'github' });
    }
    // Screenshot on error
    try {
      const ssDir = path.join(__dirname, '..', 'screenshots');
      if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
      const ssPath = path.join(ssDir, `codebuddy_err_${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: true });
      console.log(`  📸 Screenshot saved: ${ssPath}`);
    } catch (_) {}
    throw err;
  } finally {
    if (envFlag('KEEP_OPEN')) {
      console.log('KEEP_OPEN=true — browser stays open');
    } else {
      await browser.close();
    }
  }
}

if (require.main === module) {
  register().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { register, CONFIG };


