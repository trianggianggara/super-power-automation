const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const path = require('path');
const fs = require('fs');

const { 
  isCamoufox, 
  browserTypeFor, 
  resolveBrowserExecutablePath, 
  envFlag, 
  proxyFromUrl, 
  selectProxy, 
  handleProxyFailure,
  isProxyError,
} = require('../utils/browser.js');

const { incrementChatGPTProxyUsage } = require('../utils/proxy.js');

const { sleep, rand, fillHuman, gotoWithRetry, handleCookies } = require('../utils/helpers.js');
const { randomFirstName, randomLastName } = require('../utils/names.js');
const { loadOutlookAccounts, pickFreshOutlook, parseCsvLine } = require('../utils/email.js');
const outlookApi = require('../utils/outlook.js');
const TempMail = require('../services/tempmail/tempmail.js');

const CONFIG = {
  chatgptUrl: 'https://chatgpt.com/',
  signupUrl: 'https://chatgpt.com/auth/login?screen_hint=signup',
  password: process.env.CHATGPT_PASSWORD || process.env.PASSWORD || 'PortoAuto2026!#',
  outputCsv: path.join(__dirname, '..', 'data', 'chatgpt.csv'),
  outputJson: path.join(__dirname, '..', 'data', 'chatgpt_cookies.json'),
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 30000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 25000),
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
  proxy: process.env.PROXY || '',
};

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function getRandomBirthday() {
  const year = Math.floor(1990 + Math.random() * 14); // 1990 - 2004
  const month = String(Math.floor(1 + Math.random() * 12)).padStart(2, '0');
  const day = String(Math.floor(1 + Math.random() * 28)).padStart(2, '0');
  return { year: String(year), month, day, formatted: `${month}/${day}/${year}` };
}

// Monitor Turnstile state changes
async function monitorTurnstile(page, timeoutMs = 45000) {
  try {
    let frame = null;
    for (let i = 0; i < 6; i++) {
      if (page.isClosed()) return false;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    
    if (!frame) return false;

    console.log('[*] Turnstile challenge detected. Waiting for response token...');
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return false;

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

      // Try clicking turnstile checkbox if visible inside frame
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
    console.log(`  [WARN] Turnstile monitor notice: ${err.message}`);
  }
  return false;
}

// Extract verification link or code from email body/subject
function extractOpenAiVerification(subject = '', body = '', preview = '') {
  // 1. Try TempMail smart extractor first
  let otp = null;
  try {
    const smartOtp = TempMail.extractOtp(subject, body, preview);
    if (smartOtp && /^\d{6}$/.test(smartOtp)) {
      otp = smartOtp;
    }
  } catch (_) {}

  // 2. Fallback to OpenAI specific regex
  if (!otp) {
    const combined = `${subject}\n${preview}\n${body}`;
    const otpMatch = combined.match(/(?:code|verification|kode|is)\s*(?:is:?|:)?\s*(\d{6})\b/i) || combined.match(/\b(\d{6})\b/);
    otp = otpMatch ? otpMatch[1] : null;
  }

  // 3. Try verification link
  const combined = `${subject}\n${preview}\n${body}`;
  const linkMatch = combined.match(/https:\/\/(?:auth0\.openai\.com|auth\.openai\.com|account\.openai\.com)[^\s"'<>]+/i);
  const link = linkMatch ? linkMatch[0] : null;

  return { otp, link };
}

async function waitForOpenAiEmail(email, timeoutMs = 120000, since = Date.now() - 60000, options = {}) {
  const {
    page = null,
    resendAfterMs = 35000,
    maxResends = 2,
    mode = 'tempmail',
    tempmail = null,
  } = options;
  console.log(`[*] Polling ${mode} inbox for OpenAI verification (${email})...`);
  const start = Date.now();
  let lastResendAttempt = Date.now();
  let resendCount = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      if (mode === 'outlook') {
        const messages = await outlookApi.getMessages({ email, since, top: 5 });
        for (const msg of messages) {
          const subject = msg.subject || '';
          const preview = msg.bodyPreview || '';
          const from = msg.from?.emailAddress?.address || '';

          const isFromOpenAi = from.toLowerCase().includes('openai') || 
                               from.toLowerCase().includes('chatgpt') ||
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
      } else {
        // TempMail mode (webhook / mailpit / gmail)
        const tm = tempmail || new TempMail();
        const messages = await tm.getMessages(email);
        if (messages && messages.length > 0) {
          const newMessages = messages.filter(msg => {
            const recTime = Date.parse(msg.received_at);
            return isNaN(recTime) || recTime >= since;
          }).sort((a, b) => (Date.parse(b.received_at) || 0) - (Date.parse(a.received_at) || 0));

          for (const msg of newMessages) {
            const subject = msg.subject || '';
            const body = msg.text_body || msg.html_body || '';
            const preview = msg.html_body || msg.text_body || '';
            const from = msg.from_address || msg.from || '';

            const isFromOpenAi = from.toLowerCase().includes('openai') || 
                                 from.toLowerCase().includes('chatgpt') ||
                                 subject.toLowerCase().includes('openai') || 
                                 subject.toLowerCase().includes('chatgpt') || 
                                 subject.toLowerCase().includes('verify') || 
                                 subject.toLowerCase().includes('code') ||
                                 body.toLowerCase().includes('openai');

            if (isFromOpenAi || newMessages.length === 1) {
              console.log(`  [+] Detected email: "${subject}" from ${from}`);
              const result = extractOpenAiVerification(subject, body, preview);
              if (result.otp || result.link) {
                return result;
              }
            }
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
              console.log(`  [🔄 RESEND] No OTP email received after ${Math.round((Date.now() - lastResendAttempt) / 1000)}s. Clicking "${text || 'Resend email'}" (${resendCount + 1}/${maxResends})...`);
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
        mode === 'outlook' && (
          err.message.includes('Token refresh failed') ||
          err.message.includes('invalid_grant') ||
          err.message.includes('abuse') ||
          err.message.includes('AADSTS70000') ||
          err.message.includes('AADSTS50053')
        )
      ) {
        console.error(`  ❌ [OUTLOOK BLOCKED] ${email} is locked/disabled by Microsoft: ${err.message}`);
        throw new Error(`OUTLOOK_ACCOUNT_LOCKED_OR_SUSPENDED: ${err.message}`);
      }
      console.log(`  [WARN] ${mode} poll warning: ${err.message}`);
    }
    await sleep(3000);
  }
  return null;
}

function isSessionTokenCookie(name = '') {
  return /^__Secure-next-auth\.session-token(\.\d+)?$/.test(name);
}

function formatOmnirouteCookies(cookies = []) {
  const byName = new Map();

  // Keep only cookies relevant to chatgpt.com — the domain OmniRoute replays
  // against. The session token + Cloudflare clearance live on chatgpt.com
  // (and `.chatgpt.com` subdomain). auth.openai.com / auth0.openai.com cookies
  // are auth-flow artifacts, not session replay material.
  for (const c of cookies) {
    if (!c || !c.name || c.value === undefined || c.value === null) continue;
    const domain = String(c.domain || '').toLowerCase();
    if (domain !== 'chatgpt.com' && !domain.endsWith('.chatgpt.com')) continue;
    // Preserve chunked names (.0/.1/.2) as distinct entries. Playwright reports
    // chunked session cookies with numeric suffixes, e.g.
    // `__Secure-next-auth.session-token.0`. Collapsing them on base name would
    // drop the payload halves and produce an invalid token.
    if (!byName.has(c.name)) byName.set(c.name, c.value);
  }

  // Deterministic priority order — session token first, then Cloudflare bypass,
  // then the rest of the auth jar. Anything not listed is appended after.
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
      // Always emit this one — OmniRoute expects it and it is a static literal.
      parts.push('__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com%2F');
      handled.add(name);
    }
  }

  // Append anything left (alphabetical for determinism) so no auth cookie is lost.
  const rest = [...byName.entries()]
    .filter(([name]) => !handled.has(name))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, value] of rest) {
    parts.push(`${name}=${value}`);
  }

  return parts.join('; ');
}

async function extractSessionCookies(context, page) {
  let sessionToken = '';
  let cookies = [];
  let formattedCookies = '';

  const start = Date.now();
  while (Date.now() - start < 15000) {
    cookies = await context.cookies(['https://chatgpt.com', 'https://openai.com', 'https://auth0.openai.com', 'https://auth.openai.com']);
    formattedCookies = formatOmnirouteCookies(cookies);

    // Accept either the unchunked token OR its chunked pieces. ChatGPT splits the
    // token into `.0`/`.1`/`.2` cookies when it exceeds a browser cookie size
    // limit, so requiring the bare name would report "not found" on a perfectly
    // valid chunked session.
    const tokenCookies = cookies.filter(c => isSessionTokenCookie(c.name));
    const unchunked = tokenCookies.find(c => c.name === '__Secure-next-auth.session-token');
    sessionToken = (unchunked || tokenCookies[0] || {}).value || '';

    if (sessionToken) break;
    await sleep(1500);
  }

  return {
    cookies,
    formattedCookies,
    sessionToken,
  };
}

function saveAccountRecord(record) {
  // Output CSV: created_at,email,password,cookies,status
  const csvExists = fs.existsSync(CONFIG.outputCsv);
  if (!csvExists) {
    const header = 'created_at,email,password,cookies,status\n';
    fs.writeFileSync(CONFIG.outputCsv, header, 'utf8');
  }

  const row = [
    csvCell(record.createdAt),
    csvCell(record.email),
    csvCell(record.password),
    csvCell(record.cookies),
    csvCell('active'),
  ].join(',') + '\n';

  fs.appendFileSync(CONFIG.outputCsv, row, 'utf8');
  console.log(`[✓] Saved account to ${CONFIG.outputCsv}`);

  // JSON format for reference/debugging
  try {
    let list = [];
    if (fs.existsSync(CONFIG.outputJson)) {
      list = JSON.parse(fs.readFileSync(CONFIG.outputJson, 'utf8') || '[]');
    }
    list.push(record);
    fs.writeFileSync(CONFIG.outputJson, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.log(`  [WARN] Failed to write JSON output: ${err.message}`);
  }
}

async function runRegistration() {
  const isOutlookMode = process.argv.includes('--outlook') ||
    process.env.CHATGPT_MODE === 'outlook' ||
    process.env.REGISTRATION_MODE === 'outlook';
  const registrationMode = isOutlookMode ? 'outlook' : 'tempmail';

  console.log('\n=============================================');
  console.log(`       ChatGPT Auto-Registrar (${isOutlookMode ? 'Outlook' : 'TempMail'})      `);
  console.log('=============================================\n');

  let email = '';
  let password = CONFIG.password;
  let firstName = randomFirstName();
  let lastName = randomLastName();
  const birthday = getRandomBirthday();
  let tempmail = null;

  if (isOutlookMode) {
    // 1. Pick Outlook Account
    const outlookAccounts = loadOutlookAccounts();
    if (outlookAccounts.length === 0) {
      throw new Error('No Outlook accounts found in data/outlook_accounts.csv');
    }

    const chosenAccount = pickFreshOutlook(outlookAccounts, CONFIG.outputCsv, { requireToken: true });
    if (!chosenAccount) {
      throw new Error('No fresh Outlook accounts with valid refresh tokens available in data/outlook_accounts.csv');
    }

    email = chosenAccount.email;
    password = chosenAccount.password || CONFIG.password;
    firstName = chosenAccount.firstName || firstName;
    lastName = chosenAccount.lastName || lastName;
  } else {
    // 1. TempMail Account
    tempmail = new TempMail();
    const userLocal = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${rand(10, 9999)}`;
    const cliDomain = process.argv.find(a => a.startsWith('--domain='))?.split('=')[1] || process.env.CHATGPT_EMAIL_DOMAIN || null;
    const inbox = await tempmail.createInbox(userLocal, cliDomain);
    email = inbox.address;
  }

  console.log(`[*] Registration Mode: ${registrationMode}`);
  console.log(`[*] Selected Account: ${email}`);
  console.log(`[*] Target Name: ${firstName} ${lastName}`);
  console.log(`[*] Birthday: ${birthday.formatted}`);

  // 2. Select Proxy
  const cliProxy = process.argv.find(a => a.startsWith('--proxy='))?.split('=')[1] || CONFIG.proxy;
  const proxy = envFlag('DISABLE_PROXY') ? '' : selectProxy(cliProxy, { service: 'chatgpt' });

  const proxyConfig = proxy ? proxyFromUrl(proxy) : null;
  if (proxyConfig) {
    console.log(`[*] Proxy: ${proxyConfig.server}`);
  }

  // 3. Launch Browser
  const isCam = isCamoufox(CONFIG.browserExecutablePath);
  let browser = null;
  let context = null;
  let page = null;
  let tempProfileDir = '';

  const vpWidth = 1366 + rand(-20, 20);
  const vpHeight = 768 + rand(-10, 10);

  if (isCam) {
    console.log(`[*] Launching Camoufox browser (Headless: ${envFlag('HEADLESS', false)})...`);
    const launchOpts = {
      headless: envFlag('HEADLESS', false),
      args: ['--no-sandbox'],
      ignoreHTTPSErrors: true,
    };
    if (proxyConfig) launchOpts.proxy = proxyConfig;
    if (CONFIG.browserExecutablePath) launchOpts.executablePath = CONFIG.browserExecutablePath;

    browser = await browserTypeFor(CONFIG.browserExecutablePath).launch(launchOpts);
    context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
    page = await context.newPage();
  } else {
    console.log(`[*] Launching Chromium/Brave persistent context (Headless: ${envFlag('HEADLESS', false)})...`);
    tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_chatgpt_${Date.now()}_${Math.floor(Math.random() * 100000)}`);
    
    const contextOpts = {
      headless: envFlag('HEADLESS', false),
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

// Proactively check for Fake/Echo Proxies, Connection Timeouts, Proxy Refusals, IP Block, Cloudflare 1020/1015, or Access Denied
async function checkIpBlockOrError(page) {
  try {
    if (!page || page.isClosed()) return;
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    const lower = (title + ' ' + bodyText).toLowerCase();

    // Check for browser network error / timeout page / proxy refusing (e.g. Camoufox / Firefox error screens)
    if (
      title.includes('Problem loading page') ||
      lower.includes('the proxy server is refusing connections') ||
      lower.includes('the connection has timed out') ||
      lower.includes('is taking too long to respond') ||
      lower.includes('problem loading page') ||
      lower.includes('unable to connect') ||
      lower.includes('secure connection failed') ||
      lower.includes('pr_connect_reset_error') ||
      lower.includes('server not found') ||
      lower.includes('ns_error_') ||
      lower.includes('cant connect to the server') ||
      lower.includes("can't connect to the server")
    ) {
      throw new Error('PROXY_CONNECTION_REFUSED_OR_TIMED_OUT: Proxy server refused connection or timed out');
    }

    // Check for fake / transparent echo proxies (dumping PHP $_SERVER variables)
    if (
      bodyText.includes('REMOTE_ADDR =') ||
      bodyText.includes('REQUEST_METHOD =') ||
      bodyText.includes('HTTP_USER_AGENT =') ||
      bodyText.includes('HTTP_HOST =') ||
      lower.includes('tinyproxy') ||
      lower.includes('squid') ||
      lower.includes('mikrotik')
    ) {
      throw new Error('PROXY_ECHO_HIJACKED_FAKE_PROXY');
    }

    if (
      lower.includes('sorry, you have been blocked') ||
      lower.includes('error code 1020') ||
      lower.includes('error code 1015') ||
      lower.includes('error 1020') ||
      lower.includes('error 1015') ||
      lower.includes('you have been blocked') ||
      lower.includes('access to chatgpt.com was blocked') ||
      lower.includes('access is temporarily restricted') ||
      (lower.includes('access denied') && !lower.includes('challenges.cloudflare.com')) ||
      lower.includes('we detected unusual activity')
    ) {
      throw new Error('CHATGPT_IP_BLOCKED_OR_RESTRICTED');
    }
  } catch (err) {
    if (
      err.message.includes('CHATGPT_IP_BLOCKED') || 
      err.message.includes('PROXY_ECHO_HIJACKED') || 
      err.message.includes('PROXY_CONNECTION_')
    ) {
      throw err;
    }
  }
}

  page.setDefaultTimeout(CONFIG.stepTimeout);

  const registrationStartTime = Date.now();

  try {
    // 4. Navigate to ChatGPT Sign up
    console.log(`[*] Navigating to ChatGPT sign-up page: ${CONFIG.signupUrl}...`);
    await gotoWithRetry(page, CONFIG.signupUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2500);

    // Check for IP block on initial load
    await checkIpBlockOrError(page);

    // Check Turnstile on initial load
    await monitorTurnstile(page, 15000);

    // Handle Cookie banner if present
    await handleCookies(page);

    // Check if we need to click Sign up button
    const signUpBtn = page.locator('button:has-text("Sign up"), a:has-text("Sign up"), [data-testid="signup-button"]').first();
    if (await signUpBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[*] Clicking "Sign up" button...');
      await signUpBtn.click();
      await sleep(2000);
      await checkIpBlockOrError(page);
    }

    // 5. Fill Email
    console.log('[*] Entering email address...');
    await handleCookies(page, 0);

    const emailInput = page.locator('input[type="email"]:visible, input[name="email"]:visible, #email-input:visible, input[name="username"]:visible').first();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await emailInput.click({ force: true }).catch(() => {});
    await fillHuman(page, emailInput, email);

    // Verify value was actually set in DOM and dispatch React change event if needed
    let currentVal = await emailInput.inputValue().catch(() => '');
    if (!currentVal || currentVal.trim() !== email.trim()) {
      console.log(`  [*] Ensuring email value is set via native fill (was: "${currentVal}")...`);
      await emailInput.fill(email);
    }
    await sleep(500);

    // Dismiss any cookie consent banner overlay before clicking continue
    await handleCookies(page, 0);

    // Click Continue after email or press Enter
    const continueEmailBtn = page.locator([
      'button[type="submit"]:not(:has-text("Google")):not(:has-text("Microsoft")):not(:has-text("Apple")):not(:has-text("Sign in")):visible',
      'button:text-is("Continue"):visible',
      'button:text-is("Lanjutkan"):visible',
      'button.continue-btn:visible'
    ].join(', ')).first();

    if (await continueEmailBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await continueEmailBtn.click();
    } else {
      await emailInput.press('Enter');
    }
    await sleep(3500);

    // Check if "Email is required" or "Email is not valid" appeared
    const emailErr = page.locator('text="Email is required", text="Email is not valid", text="email is required", text="email is not valid"').first();
    if (await emailErr.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('  ⚠️ [WARN] Email error detected. Re-clearing input and filling exact email...');
      await emailInput.click({ force: true }).catch(() => {});
      await emailInput.fill(email);
      await sleep(500);
      if (await continueEmailBtn.isVisible().catch(() => false)) {
        await continueEmailBtn.click();
      } else {
        await emailInput.press('Enter');
      }
      await sleep(3000);
    }

    // Check if domain is rejected by OpenAI ("The email you provided is not supported")
    const unsupportedErr = page.locator([
      'text="The email you provided is not supported"',
      'text="email you provided is not supported"',
      'text="The email is invalid"',
      'text="Email is not valid"'
    ].join(', ')).first();
    if (await unsupportedErr.isVisible({ timeout: 1500 }).catch(() => false)) {
      const errText = await unsupportedErr.innerText().catch(() => 'Email not supported');
      console.error(`  ❌ [EMAIL REJECTED] OpenAI rejected email domain (${email}): ${errText}`);
      throw new Error(`OPENAI_EMAIL_NOT_SUPPORTED: ${errText} (${email})`);
    }

    await checkIpBlockOrError(page);
    await monitorTurnstile(page, 15000);

    // 6. Adaptive Registration Steps (OTP Verification, Password, Profile)
    let isFinished = false;
    const maxSteps = 10;
    let stepCount = 0;

    while (!isFinished && stepCount < maxSteps) {
      stepCount++;
      await sleep(1500);
      await checkIpBlockOrError(page);
      await monitorTurnstile(page, 15000);
      await handleCookies(page, 0);

      const currentUrl = page.url();
      console.log(`[*] Step ${stepCount} | Current URL: ${currentUrl}`);
      await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', `chatgpt_step_${stepCount}.png`) }).catch(() => {});

      // Case A: Redirected to ChatGPT main page
      if (currentUrl.includes('chatgpt.com') && !currentUrl.includes('/auth/')) {
        console.log('[*] Successfully landed on ChatGPT main interface!');
        isFinished = true;
        break;
      }

      // If still stuck on login page or "Email is required" / "Email is not valid" error is shown
      if (currentUrl.includes('/auth/login') && !currentUrl.includes('email-verification')) {
        await handleCookies(page, 0);
        const emailInputStep = page.locator('input[type="email"]:visible, input[name="email"]:visible, #email-input:visible, input[name="username"]:visible').first();
        if (await emailInputStep.isVisible({ timeout: 1000 }).catch(() => false)) {
          const stepVal = await emailInputStep.inputValue().catch(() => '');
          if (!stepVal || stepVal.trim() !== email.trim()) {
            console.log(`  [*] Email input value incorrect ("${stepVal}"). Resetting to: ${email}`);
            await emailInputStep.click({ force: true }).catch(() => {});
            await emailInputStep.fill(email);
            await sleep(500);
          }
          const retryContinueBtn = page.locator([
            'button[type="submit"]:not(:has-text("Google")):not(:has-text("Microsoft")):not(:has-text("Apple")):not(:has-text("Sign in")):visible',
            'button:text-is("Continue"):visible',
            'button:text-is("Lanjutkan"):visible',
            'button.continue-btn:visible'
          ].join(', ')).first();
          if (await retryContinueBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            console.log('  [*] Re-clicking Continue button on email page...');
            await retryContinueBtn.click().catch(() => {});
            await sleep(2500);
            continue;
          }
        }
      }

      // Case B: Email Verification (Code / Check your inbox)
      const isEmailVerificationPage = currentUrl.includes('email-verification') || 
                                      await page.locator('text="Check your inbox"').isVisible().catch(() => false);

      if (isEmailVerificationPage) {
        const codeInput = page.locator('input[name="code"]:visible, input[aria-label*="Code" i]:visible, input[placeholder*="Code" i]:visible, input[inputmode="numeric"]:visible').first();
        const codeVal = await codeInput.inputValue().catch(() => '');

        // Check if code was already entered or if the Continue button is spinning/loading
        const isButtonLoading = await page.locator('button[type="submit"][disabled], button[aria-busy="true"], button:has-text("Continue")[disabled], .loading, svg.animate-spin').first().isVisible({ timeout: 500 }).catch(() => false);

        if (codeVal.length === 6 || isButtonLoading) {
          console.log(`[*] OTP verification in progress (Code: ${codeVal || 'entered'}, Loading: ${isButtonLoading}). Waiting for verification response...`);
          await monitorTurnstile(page, 15000);
          try {
            await page.waitForURL(url => !url.href.includes('email-verification'), { timeout: 20000 });
            console.log(`[*] Advanced past verification page! URL: ${page.url()}`);
            await sleep(2500);
            continue;
          } catch (_) {
            console.log('  [*] Still on verification page, verifying if invalid code error is displayed...');
          }
        }

        // Check if "Invalid code" or "Incorrect code" error is visible
        const invalidCodeErr = page.locator('text="Invalid code", text="Incorrect code", text="The code is invalid", text="expired"').first();
        if (await invalidCodeErr.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log('  ⚠️ [WARN] Invalid OTP code detected. Clicking "Resend email"...');
          const resendBtn = page.locator('button:has-text("Resend email"), a:has-text("Resend email")').first();
          if (await resendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await resendBtn.click().catch(() => {});
            await sleep(3000);
          }
        }

        console.log(`[*] Polling ${registrationMode} inbox for OpenAI verification...`);
        const verificationData = await waitForOpenAiEmail(email, 120000, registrationStartTime - 30000, {
          page,
          resendAfterMs: 35000,
          maxResends: 2,
          mode: registrationMode,
          tempmail,
        });

        if (verificationData?.otp) {
          console.log(`[*] Filling OTP code: ${verificationData.otp}`);
          await codeInput.click({ force: true }).catch(() => {});
          await codeInput.fill(verificationData.otp);
          await sleep(600);

          const submitCodeBtn = page.locator('button[type="submit"]:visible, button:text-is("Continue"):visible').first();
          if (await submitCodeBtn.isVisible().catch(() => false)) {
            await submitCodeBtn.click().catch(() => {});
          } else {
            await codeInput.press('Enter').catch(() => {});
          }
          await sleep(2000);

          // Check if "The verification code is required" error appeared
          const codeReqErr = page.locator('text="The verification code is required", text="verification code is required"').first();
          if (await codeReqErr.isVisible({ timeout: 1500 }).catch(() => false)) {
            console.log('  ⚠️ [WARN] "The verification code is required" detected. Refilling OTP and submitting...');
            await codeInput.click({ force: true }).catch(() => {});
            await codeInput.fill(verificationData.otp);
            await sleep(500);
            if (await submitCodeBtn.isVisible().catch(() => false)) {
              await submitCodeBtn.click().catch(() => {});
            } else {
              await codeInput.press('Enter').catch(() => {});
            }
            await sleep(2500);
          }

          // Proactively wait for navigation after submitting OTP
          console.log('[*] Waiting for verification response...');
          await monitorTurnstile(page, 15000);
          try {
            await page.waitForURL(url => !url.href.includes('email-verification'), { timeout: 25000 });
            console.log(`[*] Advanced past verification page! URL: ${page.url()}`);
          } catch (_) {}

          await sleep(3000);
          continue;
        } else if (verificationData?.link) {
          console.log(`[*] Navigating to verification link: ${verificationData.link}`);
          await gotoWithRetry(page, verificationData.link, { waitUntil: 'domcontentloaded' });
          await sleep(4000);
          continue;
        } else {
          console.log('  [WARN] No OTP received yet, checking resend button on page...');
          const resendBtn = page.locator('button:has-text("Resend email"), a:has-text("Resend email"), button:has-text("Resend code")').first();
          if (await resendBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            const isDisabled = await resendBtn.isDisabled().catch(() => false);
            if (!isDisabled) {
              console.log('  [🔄 RESEND] Clicking "Resend email" before retrying loop...');
              await resendBtn.click().catch(() => {});
              await sleep(3000);
            }
          }
        }
      }

      // Case C: Profile Setup ("How old are you?" / Name & Age / Birthday)
      const isProfilePage = await page.locator('text="How old are you?"').isVisible().catch(() => false) ||
                            await page.locator('text="Tell us about you"').isVisible().catch(() => false) ||
                            await page.locator('input[name="name"]:visible, input[aria-label*="Full name" i]:visible, input[placeholder*="Full name" i]:visible').isVisible().catch(() => false);

      if (isProfilePage) {
        console.log('[*] Profile setup form detected!');
        const nameInput = page.locator('input[name="name"]:visible, input[name="fullName"]:visible, input[aria-label*="Full name" i]:visible, input[placeholder*="Full name" i]:visible, input[name="firstName"]:visible').first();
        if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`[*] Filling Full Name: ${firstName} ${lastName}`);
          await fillHuman(page, nameInput, `${firstName} ${lastName}`);
          await sleep(500);
        }

        // Age input (e.g. 21 - 35)
        const ageInput = page.locator('input[name="age"]:visible, input[aria-label*="Age" i]:visible, input[placeholder*="Age" i]:visible').first();
        if (await ageInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          const randomAge = String(Math.floor(21 + Math.random() * 14)); // e.g. 26
          console.log(`[*] Filling Age: ${randomAge}`);
          await fillHuman(page, ageInput, randomAge);
          await sleep(500);
        }

        // Birthday input
        const bdayInput = page.locator('input[name="birthday"]:visible, input[placeholder*="DD"]:visible, input[placeholder*="MM"]:visible, input[type="date"]:visible').first();
        if (await bdayInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`[*] Filling Birthday: ${birthday.formatted}`);
          await fillHuman(page, bdayInput, birthday.formatted);
          await sleep(500);
        }

        const continueProfileBtn = page.locator('button[type="submit"]:visible, button:text-is("Continue"):visible, button:has-text("Agree"):visible').first();
        if (await continueProfileBtn.isVisible().catch(() => false)) {
          await continueProfileBtn.click();
        } else {
          await nameInput.press('Enter');
        }
        await sleep(5000);
        continue;
      }

      // Case D: Password setup or login if requested
      const passwordInput = page.locator([
        'input[type="password"]:not([name*="hidden"]):not([aria-hidden="true"]):visible',
        'input[name="password"]:visible',
        '#password:visible',
        'input[autocomplete*="password"]:visible'
      ].join(', ')).first();

      if (await passwordInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('[*] Password input detected. Filling password...');
        await passwordInput.click({ force: true }).catch(() => {});
        await fillHuman(page, passwordInput, password);
        await sleep(1000);
        const continuePasswordBtn = page.locator('button[type="submit"]:visible, button:text-is("Continue"):visible, button:has-text("Log in"):visible').first();
        if (await continuePasswordBtn.isVisible().catch(() => false)) {
          await continuePasswordBtn.click().catch(() => {});
        } else {
          await passwordInput.press('Enter').catch(() => {});
        }
        await sleep(4000);
        continue;
      }

      // Case E: Account already exists ("An account already exists for this email address" / user_already_exists)
      const isAccountAlreadyExists = await page.locator('text="An account already exists", text="user_already_exists", text="Please log in instead"').first().isVisible({ timeout: 1000 }).catch(() => false);
      if (isAccountAlreadyExists) {
        console.log(`[*] Account already exists for ${email}. Transitioning to Login flow...`);
        const loginLink = page.locator('a:has-text("log in"), a:has-text("Log in"), button:has-text("Log in"), button:has-text("log in")').first();
        if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
          await loginLink.click().catch(() => {});
        } else {
          await gotoWithRetry(page, 'https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' });
        }
        await sleep(3000);
        continue;
      }

      // If already logged in or no recognizable step, check if we're on chatgpt.com
      if (currentUrl.includes('chatgpt.com') && !currentUrl.includes('/auth/')) {
        console.log('[*] Successfully landed on ChatGPT main interface!');
        isFinished = true;
        break;
      }
    }

    // 9. Wait for ChatGPT Main Interface
    console.log('[*] Waiting for session completion & redirect to ChatGPT...');
    try {
      await page.waitForURL(url => url.hostname.includes('chatgpt.com') && !url.pathname.includes('/auth/'), { timeout: 45000 });
    } catch (_) {
      console.log(`[*] Current URL after registration: ${page.url()}`);
    }

    await sleep(4000);
    await monitorTurnstile(page, 10000);

    // Close any introductory modal if present ("Okay, let's go", "Next", "Done")
    const modalBtn = page.locator('button:has-text("Okay, let\'s go"), button:has-text("Next"), button:has-text("Done"), button:has-text("Stay logged out")').first();
    if (await modalBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await modalBtn.click().catch(() => {});
      await sleep(1000);
    }

    // 10. Extract Cookies and Session Token
    console.log('[*] Extracting cookies and session tokens...');
    const sessionData = await extractSessionCookies(context, page);

    if (!sessionData.sessionToken) {
      console.error(`\n[ERROR] Session token (__Secure-next-auth.session-token) not found in cookies.`);
      console.log(`Cookies extracted: ${sessionData.formattedCookies || 'Empty'}`);
      throw new Error('CHATGPT_SESSION_TOKEN_MISSING: Registration did not reach fully authenticated session');
    }

    console.log(`\n=============================================`);
    console.log(`✅ ChatGPT REGISTRATION SUCCESSFUL!`);
    console.log(`Email:         ${email}`);
    console.log(`Session Token: ${sessionData.sessionToken.substring(0, 40)}...`);
    console.log(`Cookies:       ${sessionData.formattedCookies.substring(0, 80)}...`);
    console.log(`=============================================\n`);

    saveAccountRecord({
      createdAt: new Date().toISOString(),
      email,
      password,
      cookies: sessionData.formattedCookies,
    });

    if (proxy) {
      incrementChatGPTProxyUsage(proxy);
    }

  } catch (err) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'chatgpt_error.png') }).catch(() => {});
    }
    console.error(`\n[ERROR] Registration failed: ${err.message}`);
    if (proxy) {
      try {
        const isSlowOrDeadOrBlocked = isProxyError(err) || /timeout|block|restrict|slow|refused|reset|closed|econn|1020|1015|proxy_echo|fake_proxy/i.test(err.message);
        handleProxyFailure(proxy, err, { service: 'chatgpt', force: isSlowOrDeadOrBlocked });
      } catch (proxyCleanupErr) {
        console.warn(`  [WARN] Failed to record proxy failure: ${proxyCleanupErr.message}`);
      }
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  runRegistration().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runRegistration };
