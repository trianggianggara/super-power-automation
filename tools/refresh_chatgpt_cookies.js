const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const {
  isCamoufox,
  browserTypeFor,
  resolveBrowserExecutablePath,
  proxyFromUrl,
  selectProxy,
  setupNetworkOptimization,
} = require('../utils/browser.js');

const { sleep, rand, fillHuman, gotoWithRetry } = require('../utils/helpers.js');
const { parseCsvLine } = require('../utils/email.js');
const outlookApi = require('../utils/outlook.js');

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const defaultCsv = path.join(__dirname, '..', 'data', 'chatgpt.csv');

const isHeadless = process.argv.some(arg => arg === '--headless' || arg === '--headless=true') ||
                   args.get('headless') === 'true' ||
                   process.env.HEADLESS === 'true';

const CONFIG = {
  csv: args.get('csv') || defaultCsv,
  targetEmail: (args.get('email') || '').trim().toLowerCase(),
  onlyExpired: args.get('only-expired') === 'true' || args.get('check') === 'true',
  limit: Number(args.get('limit') || 0),
  headless: isHeadless, // Default is HEADFULL (visible window on screen)
  direct: args.get('direct') === 'true' || args.get('no-proxy') === 'true',
  proxy: args.get('proxy') || process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
  timeoutMs: Number(process.env.STEP_TIMEOUT_MS || 25000),
};

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseCsvFull(content) {
  const rows = [];
  let currentRow = [];
  let currentVal = '';
  let insideQuote = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        currentVal += '"';
        i++;
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === ',' && !insideQuote) {
      currentRow.push(currentVal);
      currentVal = '';
    } else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') i++;
      currentRow.push(currentVal);
      currentVal = '';
      if (currentRow.some(c => c.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentVal += char;
    }
  }

  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal);
    if (currentRow.some(c => c.trim().length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function isSessionTokenCookie(name = '') {
  return /^__Secure-next-auth\.session-token(\.\d+)?$/.test(name);
}

function formatOmnirouteCookies(cookies = []) {
  const byName = new Map();

  for (const c of cookies) {
    if (!c || !c.name || c.value === undefined || c.value === null) continue;
    const domain = String(c.domain || '').toLowerCase();
    if (domain !== 'chatgpt.com' && !domain.endsWith('.chatgpt.com')) continue;
    if (!byName.has(c.name)) byName.set(c.name, c.value);
  }

  const priority = [
    '__Secure-next-auth.session-token.0',
    '__Secure-next-auth.session-token.1',
    '__Secure-next-auth.session-token.2',
    '__Secure-next-auth.session-token',
    'cf_clearance',
    '__cf_bm',
    '_cfuvid',
    '__Secure-oai-is',
    '__Host-next-auth.csrf-token',
    '__Secure-next-auth.callback-url',
    '__oailb',
    'oai-sc',
    'oai-client-auth-info',
    'oai-did',
    'oai-client-session-epoch',
  ];

  const parts = [];
  const handled = new Set();

  for (const name of priority) {
    if (byName.has(name)) {
      parts.push(`${name}=${byName.get(name)}`);
      handled.add(name);
      continue;
    }
    if (name === '__Secure-next-auth.callback-url') {
      parts.push('__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com%2F');
      handled.add(name);
    }
  }

  const rest = [...byName.entries()]
    .filter(([name]) => !handled.has(name))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, value] of rest) {
    parts.push(`${name}=${value}`);
  }

  return parts.join('; ');
}

async function extractSessionCookies(context) {
  let sessionToken = '';
  let cookies = [];
  let formattedCookies = '';

  const start = Date.now();
  while (Date.now() - start < 15000) {
    cookies = await context.cookies(['https://chatgpt.com', 'https://openai.com', 'https://auth0.openai.com', 'https://auth.openai.com']);
    formattedCookies = formatOmnirouteCookies(cookies);

    const tokenCookies = cookies.filter(c => isSessionTokenCookie(c.name));
    const unchunked = tokenCookies.find(c => c.name === '__Secure-next-auth.session-token');
    sessionToken = (unchunked || tokenCookies[0] || {}).value || '';

    if (sessionToken) break;
    await sleep(1500);
  }

  return { cookies, formattedCookies, sessionToken };
}

async function isAccountDeactivated(page) {
  if (!page || page.isClosed()) return false;
  try {
    const url = page.url();
    if (
      url.includes('account_deactivated') ||
      url.includes('error=account_deactivated') ||
      url.includes('error_code=account_deactivated')
    ) {
      return true;
    }

    const detected = await page.evaluate(() => {
      const text = (document.body && document.body.innerText) || '';
      return (
        text.includes('account_deactivated') ||
        text.includes('deleted or deactivated') ||
        text.includes('has been deleted or deactivated') ||
        (text.includes('Authentication Error') && (text.includes('deactivated') || text.includes('deleted')))
      );
    }).catch(() => false);

    if (detected) return true;

    const el = page.locator([
      'text="account_deactivated"',
      'text="deleted or deactivated"',
      'text="has been deleted or deactivated"',
      'text="You do not have an account because it has been deleted or deactivated"'
    ].join(', ')).first();

    return await el.isVisible({ timeout: 500 }).catch(() => false);
  } catch (_) {
    return false;
  }
}

async function monitorTurnstile(page, timeoutMs = 45000) {
  try {
    if (await isAccountDeactivated(page)) return false;
    let frame = null;
    for (let i = 0; i < 6; i++) {
      if (page.isClosed()) return false;
      if (await isAccountDeactivated(page)) return false;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }

    if (!frame) return false;

    console.log('  [*] Turnstile challenge detected. Waiting for response token...');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return false;
      if (await isAccountDeactivated(page)) return false;

      const tokenValue = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('textarea, input'));
        for (const el of elements) {
          const name = el.getAttribute('name') || '';
          const id = el.getAttribute('id') || '';
          if (
            name.includes('cf-turnstile-response') ||
            id.includes('cf-turnstile-response') ||
            name.includes('g-recaptcha-response') ||
            id.includes('g-recaptcha-response') ||
            name === 'cf_challenge_response'
          ) {
            if (el.value && el.value.length > 30) return el.value;
          }
        }
        return null;
      }).catch(() => null);

      if (tokenValue) {
        console.log(`  [✓] Turnstile solved (token: ${tokenValue.substring(0, 15)}...)`);
        return true;
      }

      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (activeFrame) {
        const checkbox = activeFrame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage').first();
        if (await checkbox.isVisible().catch(() => false)) {
          await checkbox.click().catch(() => {});
        }
      }
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    console.log(`  [WARN] Turnstile notice: ${err.message}`);
  }
  return false;
}

function extractOpenAiVerification(subject = '', body = '', preview = '') {
  const combined = `${subject}\n${preview}\n${body}`;
  const otpMatch = combined.match(/(?:code|verification|kode|is)\s*(?:is:?|:)?\s*(\d{6})\b/i) || combined.match(/\b(\d{6})\b/);
  const otp = otpMatch ? otpMatch[1] : null;
  const linkMatch = combined.match(/https:\/\/(?:auth0\.openai\.com|auth\.openai\.com|account\.openai\.com)[^\s"'<>]+/i);
  const link = linkMatch ? linkMatch[0] : null;
  return { otp, link };
}

async function waitForOpenAiEmail(email, timeoutMs = 120000, since = Date.now() - 60000, options = {}) {
  const {
    page = null,
    resendAfterMs = 35000,
    maxResends = 2,
  } = options;
  console.log(`  [*] Polling Outlook inbox for OpenAI verification (${email})...`);
  const start = Date.now();
  let lastResendAttempt = Date.now();
  let resendCount = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const messages = await outlookApi.getMessages({ email, since, top: 5 });
      for (const msg of messages) {
        const subject = msg.subject || '';
        const preview = msg.bodyPreview || '';
        const from = msg.from?.emailAddress?.address || '';

        const isFromOpenAi = from.toLowerCase().includes('openai') ||
                             subject.toLowerCase().includes('openai') ||
                             subject.toLowerCase().includes('verify') ||
                             preview.toLowerCase().includes('openai');

        if (isFromOpenAi) {
          console.log(`  [+] Detected email: "${subject}" from ${from}`);
          const full = await outlookApi.getMessageBody(msg.id, email);
          const result = extractOpenAiVerification(subject, full.body || preview, preview);
          if (result.otp || result.link) {
            return result;
          }
        }
      }

      // If no email received yet, check if we should trigger "Resend email"
      if (page && !page.isClosed() && resendCount < maxResends && (Date.now() - lastResendAttempt) >= resendAfterMs) {
        try {
          const resendBtn = page.locator([
            'button:has-text("Resend email")',
            'a:has-text("Resend email")',
            'button:has-text("Resend code")',
            'a:has-text("Resend code")',
            'button:text-is("Resend")',
            'a:text-is("Resend")'
          ].join(', ')).first();

          const isVisible = await resendBtn.isVisible({ timeout: 1000 }).catch(() => false);
          if (isVisible) {
            const isDisabled = await resendBtn.isDisabled().catch(() => false);
            const text = (await resendBtn.innerText().catch(() => '')).trim();

            const hasCountdown = text.match(/in \d+|\(\d+s?\)|wait/i);
            if (!isDisabled && !hasCountdown) {
              console.log(`  [🔄 RESEND] No OTP received after ${Math.round((Date.now() - lastResendAttempt) / 1000)}s. Clicking "${text || 'Resend email'}" (${resendCount + 1}/${maxResends})...`);
              await resendBtn.click().catch(() => {});
              resendCount++;
              lastResendAttempt = Date.now();
              await sleep(2500);
            } else {
              console.log(`  [*] Resend button detected but cooling down: "${text}"`);
            }
          }
        } catch (resendErr) {
          console.log(`  [WARN] Resend button check: ${resendErr.message}`);
        }
      }
    } catch (err) {
      if (
        err.message.includes('Token refresh failed') ||
        err.message.includes('invalid_grant') ||
        err.message.includes('abuse') ||
        err.message.includes('AADSTS70000') ||
        err.message.includes('AADSTS50053')
      ) {
        console.error(`  ❌ [OUTLOOK BLOCKED] ${email} is locked/disabled: ${err.message}`);
        throw new Error(`OUTLOOK_ACCOUNT_LOCKED: ${err.message}`);
      }
      console.log(`  [WARN] Outlook poll: ${err.message}`);
    }
    await sleep(4000);
  }
  return null;
}

async function checkSessionStatus(cookieStr) {
  if (!cookieStr || cookieStr.trim().length === 0) return { active: false, reason: 'empty_cookie' };
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Cookie': cookieStr,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) {
      const data = await res.json();
      if (data.user?.email || data.accessToken) {
        return { active: true, user: data.user?.email, expires: data.expires };
      }
      return { active: false, reason: 'session_empty_json' };
    }
    return { active: false, reason: `http_${res.status}` };
  } catch (err) {
    return { active: false, reason: `check_error: ${err.message}` };
  }
}

let backupCreated = false;
function updateCsvRowInPlace(csvPath, targetEmail, optionsOrCookies) {
  if (!fs.existsSync(csvPath)) return false;

  let newCookies = null;
  let newStatus = null;
  if (typeof optionsOrCookies === 'string') {
    newCookies = optionsOrCookies;
    newStatus = 'active';
  } else if (typeof optionsOrCookies === 'object' && optionsOrCookies !== null) {
    newCookies = optionsOrCookies.cookies !== undefined ? optionsOrCookies.cookies : null;
    newStatus = optionsOrCookies.status !== undefined ? optionsOrCookies.status : null;
  }

  if (!backupCreated) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = `${csvPath}.bak-${timestamp}`;
    fs.copyFileSync(csvPath, bakPath);
    console.log(`  [BACKUP] Created CSV backup: ${path.basename(bakPath)}`);
    backupCreated = true;
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsvFull(content);
  if (allRows.length <= 1) return false;

  let header = allRows[0].map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  const cookiesIdx = header.indexOf('cookies');
  const createdAtIdx = header.indexOf('created_at');
  let statusIdx = header.indexOf('status');

  if (emailIdx === -1) {
    console.error('CSV missing email column!');
    return false;
  }

  // Ensure 'status' column exists in header
  if (statusIdx === -1) {
    allRows[0].push('status');
    statusIdx = allRows[0].length - 1;
    for (let i = 1; i < allRows.length; i++) {
      while (allRows[i].length < allRows[0].length) {
        allRows[i].push('');
      }
    }
  }

  let matched = false;
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    while (row.length < allRows[0].length) {
      row.push('');
    }

    if ((row[emailIdx] || '').trim().toLowerCase() === targetEmail.toLowerCase()) {
      if (newCookies !== null && cookiesIdx !== -1) {
        row[cookiesIdx] = newCookies;
        if (createdAtIdx !== -1) {
          row[createdAtIdx] = new Date().toISOString();
        }
      }
      if (newStatus !== null) {
        row[statusIdx] = newStatus;
      } else if (newCookies) {
        row[statusIdx] = 'active';
      }
      matched = true;
      break;
    }
  }

  if (!matched) return false;

  const serialized = allRows.map(row => row.map(val => csvCell(val)).join(',')).join('\n') + '\n';
  fs.writeFileSync(csvPath, serialized, 'utf8');
  console.log(`  [CSV] Row updated in-place for ${targetEmail} (status: "${newStatus || (newCookies ? 'active' : 'unchanged')}")`);
  return true;
}

async function loginAndRefresh(account, proxyConfig) {
  const { email, password } = account;
  console.log(`\n=============================================`);
  console.log(`[*] Starting browser login for: ${email}`);

  const isCam = isCamoufox(CONFIG.browserExecutablePath);
  let browser = null;
  let context = null;
  let page = null;
  let tempProfileDir = '';

  const vpWidth = 1366 + rand(-20, 20);
  const vpHeight = 768 + rand(-10, 10);

  if (isCam) {
    console.log(`  [*] Launching Camoufox browser (Headless: ${CONFIG.headless})...`);
    const launchOpts = {
      headless: CONFIG.headless,
      args: ['--no-sandbox'],
      ignoreHTTPSErrors: true,
    };
    if (proxyConfig) launchOpts.proxy = proxyConfig;
    if (CONFIG.browserExecutablePath) launchOpts.executablePath = CONFIG.browserExecutablePath;

    browser = await browserTypeFor(CONFIG.browserExecutablePath).launch(launchOpts);
    context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
    page = await context.newPage();
  } else {
    console.log(`  [*] Launching Chromium persistent context (Headless: ${CONFIG.headless})...`);
    tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_chatgpt_refresh_${Date.now()}_${Math.floor(Math.random() * 100000)}`);

    const contextOpts = {
      headless: CONFIG.headless,
      viewport: { width: vpWidth, height: vpHeight },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      ignoreHTTPSErrors: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    };
    if (proxyConfig) contextOpts.proxy = proxyConfig;
    if (CONFIG.browserExecutablePath) contextOpts.executablePath = CONFIG.browserExecutablePath;

    context = await chromium.launchPersistentContext(tempProfileDir, contextOpts);
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
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

  page.setDefaultNavigationTimeout(25000);
  page.setDefaultTimeout(25000);
  await setupNetworkOptimization(page);

  try {
    console.log('  [*] Navigating to ChatGPT login page...');
    await gotoWithRetry(page, 'https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 }, 2);
    await sleep(2500);

    const emailInput = page.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="username"]:visible, input[id="email-input"]:visible').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    console.log('  [*] Filling email...');
    await fillHuman(page, emailInput, email);
    await sleep(800);

    // Strictly match primary Continue button (exclude "Continue with Google" / "Continue with Microsoft")
    const continueBtn = page.locator([
      'button:text-is("Continue"):visible',
      'button:text-is("Lanjutkan"):visible',
      'button[type="submit"]:not(:has-text("Google")):not(:has-text("Microsoft")):not(:has-text("Apple")):visible',
      'button.continue-btn:visible'
    ].join(', ')).first();

    if (await continueBtn.isVisible().catch(() => false)) {
      console.log('  [*] Clicking primary Continue button...');
      await continueBtn.click();
    } else {
      console.log('  [*] Submitting email via Enter key...');
      await emailInput.press('Enter');
    }

    await sleep(3000);
    await monitorTurnstile(page, 15000);

    // Check immediately if account has been deleted/deactivated by OpenAI
    if (await isAccountDeactivated(page)) {
      console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
      return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
    }

    // If redirected to Google by mistake, bounce back to auth/login
    if (page.url().includes('accounts.google.com')) {
      console.log('  [WARN] Accidental redirect to Google detected. Navigating back...');
      await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);
    }

    // Check if "Log in with a one-time code" is available (OpenAI passwordless flow)
    const oneTimeCodeBtn = page.locator([
      'button:has-text("Log in with a one-time code"):visible',
      'button:has-text("one-time code"):visible',
      'button[name="intent"]:has-text("one-time code"):visible'
    ].join(', ')).first();

    if (await oneTimeCodeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('  [*] Found "Log in with a one-time code" button! Clicking for email OTP...');
      await oneTimeCodeBtn.click();
      await sleep(2500);
      await monitorTurnstile(page, 15000);
      if (await isAccountDeactivated(page)) {
        console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
        return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
      }
    } else {
      // If no one-time code button, try password
      const passwordInput = page.locator([
        'input[type="password"]:not([name*="hidden"]):not([aria-hidden="true"]):visible',
        'input[name="password"]:visible',
        '#password:visible',
        'input[autocomplete*="password"]:visible'
      ].join(', ')).first();

      if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('  [*] Filling password...');
        await fillHuman(page, passwordInput, password);
        await sleep(800);

        const submitPasswordBtn = page.locator([
          'button:text-is("Continue"):visible',
          'button:text-is("Log in"):visible',
          'button[type="submit"]:not(:has-text("Google")):not(:has-text("Microsoft")):not(:has-text("Apple")):visible'
        ].join(', ')).first();

        if (await submitPasswordBtn.isVisible().catch(() => false)) {
          console.log('  [*] Clicking submit password...');
          await submitPasswordBtn.click();
        } else {
          console.log('  [*] Submitting password via Enter key...');
          await passwordInput.press('Enter');
        }

        await sleep(2500);
        await monitorTurnstile(page, 15000);

        if (await isAccountDeactivated(page)) {
          console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
          return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
        }

        // Check if incorrect password error appeared
        const hasPwErr = await page.locator('text="Incorrect email address or password", text="Incorrect password"').first().isVisible({ timeout: 2000 }).catch(() => false);
        if (hasPwErr) {
          console.log('  [!] Incorrect password detected. Looking for "Log in with a one-time code" fallback...');
          const retryOtpBtn = page.locator('button:has-text("Log in with a one-time code"):visible, button:has-text("one-time code"):visible').first();
          if (await retryOtpBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('  [*] Clicking "Log in with a one-time code"...');
            await retryOtpBtn.click();
            await sleep(2500);
            await monitorTurnstile(page, 15000);
            if (await isAccountDeactivated(page)) {
              console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
              return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
            }
          }
        }
      }
    }

    if (await isAccountDeactivated(page)) {
      console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
      return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
    }

    // Check if OTP requested (email-verification page or OTP input)
    const isVerificationPage = page.url().includes('email-verification') ||
      await page.locator('input[placeholder*="digit"], input[name="code"], input[placeholder="Code"], input[autocomplete="one-time-code"]').first().isVisible({ timeout: 8000 }).catch(() => false);

    if (isVerificationPage) {
      console.log('  [*] Email verification OTP requested by OpenAI!');
      const emailResult = await waitForOpenAiEmail(email, 90000, Date.now() - 60000, {
        page,
        resendAfterMs: 35000,
        maxResends: 2,
      });
      if (!emailResult || !emailResult.otp) {
        throw new Error(`Failed to retrieve OpenAI OTP from email inbox for ${email}`);
      }
      console.log(`  [✓] Retrieved OTP: ${emailResult.otp}`);
      const codeInput = page.locator('input[name="code"]:visible, input[placeholder="Code"]:visible, input[placeholder*="digit"]:visible, input[autocomplete="one-time-code"]:visible').first();
      await fillHuman(page, codeInput, emailResult.otp);
      await sleep(1000);

      const otpSubmitBtn = page.locator('button[type="submit"]:has-text("Continue"):visible, button[type="submit"]:visible, button:has-text("Continue"):visible').first();
      if (await otpSubmitBtn.isVisible().catch(() => false)) {
        await otpSubmitBtn.click();
      } else {
        await codeInput.press('Enter');
      }
      await sleep(3000);

      if (await isAccountDeactivated(page)) {
        console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
        return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
      }
    }

    // Wait for landing on chatgpt.com
    console.log('  [*] Waiting for redirect to chatgpt.com...');
    await page.waitForURL(url => url.hostname.includes('chatgpt.com') && !url.pathname.includes('/auth/'), { timeout: 40000 });
    await sleep(3000);
    await monitorTurnstile(page, 10000);

    // Dismiss welcome modals if present
    const modalBtn = page.locator('button:has-text("Okay, let\'s go"), button:has-text("Next"), button:has-text("Done"), button:has-text("Stay logged out")').first();
    if (await modalBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await modalBtn.click().catch(() => {});
      await sleep(1500);
    }

    console.log('  [*] Extracting fresh session cookies...');
    const { formattedCookies, sessionToken } = await extractSessionCookies(context);

    if (!sessionToken || !formattedCookies) {
      throw new Error('Session token not found in cookies after login redirect!');
    }

    console.log(`  [✓] Extracted fresh cookies successfully (length: ${formattedCookies.length})`);
    return { ok: true, cookies: formattedCookies, status: 'active' };
  } catch (err) {
    if (page && (await isAccountDeactivated(page))) {
      console.log(`  ❌ [ACCOUNT DEACTIVATED] ${email} has been deactivated/deleted by OpenAI.`);
      return { ok: false, status: 'deactivated', reason: 'account_deactivated' };
    }
    throw err;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function main() {
  console.log('=== ChatGPT Cookie Refresher (Existing Accounts) ===');
  console.log(`Reading accounts from: ${CONFIG.csv}`);

  if (!fs.existsSync(CONFIG.csv)) {
    console.error(`CSV file not found: ${CONFIG.csv}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CONFIG.csv, 'utf8').trim();
  const allRows = parseCsvFull(content);
  if (allRows.length <= 1) {
    console.log('CSV is empty or only contains header.');
    return;
  }

  const header = allRows[0].map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  const passwordIdx = header.indexOf('password');
  const cookiesIdx = header.indexOf('cookies');
  const statusIdx = header.indexOf('status');

  let accounts = [];
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    const email = (row[emailIdx] || '').trim();
    const password = (row[passwordIdx] || '').trim();
    const cookies = (row[cookiesIdx] || '').trim();
    const status = statusIdx !== -1 ? (row[statusIdx] || '').trim().toLowerCase() : '';
    if (email && password) {
      accounts.push({ email, password, cookies, status, rowIndex: i });
    }
  }

  console.log(`Found ${accounts.length} total account(s) with email & password in CSV.`);

  if (CONFIG.targetEmail) {
    accounts = accounts.filter(a => a.email.toLowerCase() === CONFIG.targetEmail);
    console.log(`Filtered by email '${CONFIG.targetEmail}': ${accounts.length} account found.`);
  }

  if (CONFIG.limit > 0) {
    accounts = accounts.slice(0, CONFIG.limit);
    console.log(`Limited to ${CONFIG.limit} account(s).`);
  }

  if (accounts.length === 0) {
    console.log('No matching accounts to process.');
    return;
  }

  let refreshedCount = 0;
  let skippedValidCount = 0;
  let skippedDeactivatedCount = 0;
  let newlyDeactivatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    console.log(`\n[${i + 1}/${accounts.length}] Account: ${acc.email}`);

    // If already marked deactivated in CSV, skip unless this is a single targeted run
    if (acc.status === 'deactivated' && !CONFIG.targetEmail) {
      console.log(`  [-] Marked as DEACTIVATED in CSV -> Skipping immediately.`);
      skippedDeactivatedCount++;
      continue;
    }

    // Check session status only if --only-expired is passed
    if (CONFIG.onlyExpired) {
      process.stdout.write('  Checking session validity... ');
      const status = await checkSessionStatus(acc.cookies);
      if (status.active) {
        console.log(`STILL ACTIVE [Expires: ${status.expires || 'N/A'}] -> Skipping.`);
        skippedValidCount++;
        continue;
      } else {
        console.log(`EXPIRED/DEAD (${status.reason}) -> Proceeding to re-login.`);
      }
    } else {
      console.log(`  [FORCE REFRESH] Performing re-login to generate fresh cookies...`);
    }

    // Select proxy for this attempt
    let proxyConfig = null;
    if (!CONFIG.direct) {
      const selected = selectProxy(CONFIG.proxy, { service: 'chatgpt' });
      if (selected) {
        proxyConfig = proxyFromUrl(selected);
        console.log(`  Using Proxy: ${selected.replace(/:[^:@]+@/, ':***@')}`);
      }
    } else {
      console.log('  Using Direct Connection (--direct)');
    }

    try {
      const result = await loginAndRefresh(acc, proxyConfig);
      if (result.ok && result.cookies) {
        updateCsvRowInPlace(CONFIG.csv, acc.email, { cookies: result.cookies, status: 'active' });
        refreshedCount++;
      } else if (result.status === 'deactivated') {
        console.log(`  [-] Account deactivated by OpenAI. Updating CSV status to "deactivated"...`);
        updateCsvRowInPlace(CONFIG.csv, acc.email, { status: 'deactivated' });
        newlyDeactivatedCount++;
        continue;
      }
    } catch (err) {
      console.error(`  ❌ Failed to refresh ${acc.email}: ${err.message}`);
      failedCount++;
    }

    if (i < accounts.length - 1) {
      await sleep(3000);
    }
  }

  console.log('\n=== REFRESH SUMMARY ===');
  console.log(`Total Accounts Processed: ${accounts.length}`);
  console.log(`Refreshed & Active:       ${refreshedCount}`);
  console.log(`Newly Deactivated:        ${newlyDeactivatedCount}`);
  console.log(`Skipped (Already Deact):  ${skippedDeactivatedCount}`);
  console.log(`Skipped (Still Active):   ${skippedValidCount}`);
  console.log(`Failed:                   ${failedCount}`);
}

main().catch(err => {
  console.error('Fatal error in refresher:', err);
  process.exit(1);
});
