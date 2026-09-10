// registrars/register_genspark.js — Auto-register Genspark via Microsoft OAuth + GSK CLI Token
const { loadEnv } = require('../utils/env.js');
loadEnv();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium, firefox } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();

const {
  isCamoufox,
  browserTypeFor,
  resolveBrowserExecutablePath,
  envFlag,
  selectProxy,
  proxyFromUrl,
  handleProxyFailure,
} = require('../utils/browser.js');
const { incrementGensparkProxyUsage } = require('../utils/proxy.js');
const { sleep, rand, fillHuman, handleCookies } = require('../utils/helpers.js');
const { loadOutlookAccounts, saveOutlookAccountData, pickFreshOutlook } = require('../utils/email.js');

const rawBrowserPath = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || 'cloakbrowser');
const browserType = browserTypeFor(rawBrowserPath);
if (!isCamoufox(rawBrowserPath)) {
  browserType.use(StealthPlugin);
}

const CONFIG = {
  loginEntryUrl: process.env.GENSPARK_LOGIN_URL || 'https://www.genspark.ai/api/login?redirect_url=%2F',
  homeUrl: process.env.GENSPARK_HOME_URL || 'https://www.genspark.ai/',
  outputFile: path.join(__dirname, '..', 'data', 'genspark_accounts.csv'),
  browserExecutablePath: rawBrowserPath,
  headless: envFlag('HEADLESS', false) || process.argv.includes('--headless'),
  timeout: Number(process.env.STEP_TIMEOUT_MS || 60000),
  proxy: process.env.PROXY || null,
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

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

function ensureCsvHeader() {
  const dir = path.dirname(CONFIG.outputFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CONFIG.outputFile)) {
    fs.writeFileSync(CONFIG.outputFile, '"email","password","api_key","status","created_at"\n', 'utf8');
  }
}

function appendToCsv(email, password, apiKey, status = 'ACTIVE') {
  ensureCsvHeader();
  const createdAt = new Date().toISOString();
  const line = `"${email}","${password}","${apiKey}","${status}","${createdAt}"\n`;
  fs.appendFileSync(CONFIG.outputFile, line, 'utf8');
  log(`[CSV] Saved ${email} to ${CONFIG.outputFile}`);
}

function updateGskConfigFile(apiKey, baseUrl = 'https://www.genspark.ai') {
  try {
    const configDir = path.join(os.homedir(), '.genspark-tool-cli');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');
    const content = JSON.stringify({ api_key: apiKey, base_url: baseUrl }, null, 2);
    fs.writeFileSync(configPath, content, 'utf8');
    log(`[GSK] Successfully updated ${configPath}`);
  } catch (err) {
    log(`[WARN] Failed to write GSK config: ${err.message}`);
  }
}

const TempMail = require('../services/tempmail/tempmail.js');

function findMatchingRecoveryEmail(maskedText, defaultEmail) {
  if (!maskedText) return defaultEmail;
  const match = maskedText.match(/([a-zA-Z0-9.*]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (!match) return defaultEmail;
  const masked = match[1].toLowerCase();
  const [maskedUser, maskedDomain] = masked.split('@');
  const allCandidates = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);

  for (const cand of allCandidates) {
    const [candUser, candDomain] = cand.toLowerCase().split('@');
    if (maskedDomain && candDomain !== maskedDomain) continue;
    const cleanCandUser = candUser.replace(/\./g, '');
    const prefix = maskedUser.split('*')[0];
    if (prefix && (cleanCandUser.startsWith(prefix) || candUser.startsWith(prefix))) {
      return cand;
    }
  }
  return defaultEmail;
}

async function handleMicrosoftLogin(page, account) {
  log(`[MS LOGIN] Starting Microsoft login for ${account.email}...`);
  let emailEntered = false;
  let passwordEntered = false;
  let tempmailClient = null;
  const maxLoops = 40;

  for (let loop = 1; loop <= maxLoops; loop++) {
    const currentUrl = page.url();

    // 1. If redirected back to Genspark
    if (currentUrl.includes('genspark.ai') && !currentUrl.includes('login.genspark.ai')) {
      log(`[MS LOGIN] Successfully redirected to Genspark: ${currentUrl}`);
      return true;
    }

    const bodyText = await page.innerText('body').catch(() => '');

    // 2. Handle transient Bad Request on Genspark oauth2/authresp
    let isAuthRespPath = false;
    try {
      const parsedUrl = new URL(currentUrl);
      isAuthRespPath = parsedUrl.pathname.includes('/oauth2/authresp');
    } catch (_) {}

    const isBadRequestBody = bodyText.trim() === 'Bad Request' || (bodyText.includes('Bad Request') && !bodyText.includes('Microsoft'));

    if (isBadRequestBody || (isAuthRespPath && !currentUrl.includes('login.live.com'))) {
      log(`[MS LOGIN] "Bad Request" on authresp detected. Reloading page...`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(3000);
      continue;
    }

    // 3. Priority: "Use your password instead" (e.g. "You've reached your limit with this sign-in method")
    const usePasswordBtn = page.locator('#idA_PWD_SwitchToPassword, a:has-text("Use your password instead"), button:has-text("Use your password instead"), [role="button"]:has-text("Use your password instead"), a:has-text("Use your password"), button:has-text("Use your password"), a:has-text("Gunakan kata sandi")').first();
    if (await usePasswordBtn.isVisible({ timeout: 400 }).catch(() => false)) {
      log('[MS LOGIN] "Use your password instead" button/link detected. Clicking...');
      await usePasswordBtn.click({ force: true }).catch(() => {});
      await page.locator('input[type="password"], input[name="passwd"], input#i0118, input#password').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await sleep(1500);
      continue;
    }

    // 4. Step: "Verify your identity" / Proof confirmation input (e.g. enter full email to send code)
    const proofConfirmInput = page.locator('input#proofConfirmationText, input[name="proofConfirmationText"], input#iProofEmail, input#proofInput').first();
    if (await proofConfirmInput.isVisible({ timeout: 500 }).catch(() => false)) {
      const recov = account.recoveryEmail || (process.env.GMAIL_USER || '').split(',')[0].trim();
      log(`[MS LOGIN] Inputting recovery email confirmation: ${recov}...`);
      await fillHuman(page, proofConfirmInput, recov);
      await sleep(400);
      const sendCodeBtn = page.locator('button:has-text("Send code"), input[value="Send code"], button:has-text("Kirim kode"), #iNext, button[type="submit"], input[type="submit"], button#idSIButton9').first();
      if (await sendCodeBtn.isVisible({ timeout: 800 }).catch(() => false)) {
        await sendCodeBtn.click({ force: true });
        await sleep(3000);
      }
      continue;
    }

    // 5. Detect Account Lockout / Too Many Attempts / Send Code via Recovery Email link
    const sendCodeLink = page.locator('a, button, [role="link"], [role="button"]').filter({ hasText: /(Email code to|Send a code to|Kirim kode ke|Send code to)/i }).first();
    const isSendCodeLinkVisible = await sendCodeLink.isVisible({ timeout: 400 }).catch(() => false);

    if (isSendCodeLinkVisible) {
      const linkText = await sendCodeLink.innerText().catch(() => '');
      log(`[MS LOGIN] Recovery email link detected: "${linkText}". Clicking...`);
      if (!account.recoveryEmail) {
        const matched = findMatchingRecoveryEmail(linkText, '');
        if (matched) {
          account.recoveryEmail = matched;
          log(`[MS LOGIN] Matched masked recovery email to: ${account.recoveryEmail}`);
        }
      }
      await sendCodeLink.click({ force: true }).catch(() => {});
      await sleep(2500);
      continue;
    }

    // 6. Step: Identity method selector (Email vs other)
    const emailMethodOption = page.locator('div[data-value*="Email" i], div.table-row:has-text("Email"), div[role="button"]:has-text("Email")').first();
    if (bodyText.includes('Verify your identity') && await emailMethodOption.isVisible({ timeout: 500 }).catch(() => false)) {
      log(`[MS LOGIN] Selecting Email verification method...`);
      await emailMethodOption.click({ force: true }).catch(() => {});
      await sleep(1500);
      continue;
    }

    // 5. Step: OTP verification code input
    const otpCodeInput = page.locator('input#iOttText, input[name="iOttText"], input#iProofCode, input[name="iProofCode"], input#otcInput, input[name="otc"], input#txtCode, input[aria-label*="Enter the code" i], input[aria-label*="code" i]:not(#DisplayPhoneNumber)').first();
    if (await otpCodeInput.isVisible({ timeout: 500 }).catch(() => false)) {
      const recov = account.recoveryEmail || (process.env.GMAIL_USER || '').split(',')[0].trim();
      log(`[MS LOGIN] 🔐 OTP input screen detected! Waiting for verification code sent to ${recov}...`);
      if (!tempmailClient) tempmailClient = new TempMail();
      const otp = await tempmailClient.waitForOtp(recov, 90000);
      if (otp) {
        log(`[MS LOGIN] ✅ Received Microsoft verification code: ${otp}`);
        await fillHuman(page, otpCodeInput, otp);
        await sleep(400);
        const verifyBtn = page.locator('#iNext, input#iNext, input[value="Next"], input[value="Verify"], #iSignupAction, input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Verify"), button#idSIButton9').first();
        if (await verifyBtn.isVisible({ timeout: 800 }).catch(() => false)) {
          await verifyBtn.click({ force: true });
          await sleep(3500);
        }
      } else {
        log(`[WARN] OTP not received for recovery email ${recov}.`);
      }
      continue;
    }

    // 6. Priority 1: Email Input
    const emailInput = page.locator('input#i0116, input[name="loginfmt"], input[type="email"]:not([placeholder*="someone@example.com" i])').first();
    if (!emailEntered && await emailInput.isVisible({ timeout: 500 }).catch(() => false)) {
      log(`[MS LOGIN] Entering email: ${account.email}`);
      await fillHuman(page, emailInput, account.email);
      await sleep(400);
      const nextBtn = page.locator('input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Next"), button:has-text("Selanjutnya")').first();
      if (await nextBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await nextBtn.click({ force: true });
      } else {
        await emailInput.press('Enter');
      }
      emailEntered = true;
      await sleep(2500);
      continue;
    }

    // 7. Priority 2: Password Input (only if not locked/too many attempts)
    const pwdInput = page.locator('input[type="password"], input[name="passwd"], input#i0118, input#password').first();
    const isPwdVisible = await pwdInput.isVisible({ timeout: 500 }).catch(() => false);

    if (isPwdVisible && !isTooManyAttempts) {
      log(`[MS LOGIN] Entering password for ${account.email}...`);
      await fillHuman(page, pwdInput, account.password);
      await sleep(400);
      const submitBtn = page.locator('input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Sign in"), button:has-text("Masuk")').first();
      if (await submitBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await submitBtn.click({ force: true });
      } else {
        await pwdInput.press('Enter');
      }
      passwordEntered = true;
      await sleep(3000);
      continue;
    }

    // 8. Switch to password if passwordless / passkey prompt appears
    if (emailEntered && !isPwdVisible && !isTooManyAttempts) {
      const passSwitchSelectors = [
        '#idA_PWD_SwitchToPassword',
        'a#idA_PWD_SwitchToPassword',
        'button#idA_PWD_SwitchToPassword',
        'div[data-value="Password"]',
        'div[role="button"][data-bind*="Password"]',
        '[role="button"]:has-text("Use your password")',
        'a:has-text("Use your password")',
        'button:has-text("Use your password")',
        'a:has-text("Gunakan kata sandi Anda")',
        '#idA_PWD_SwitchToCredPicker',
        'a:has-text("Other ways to sign in")',
      ];

      for (const sel of passSwitchSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
          log(`[MS LOGIN] Switching to password entry (${sel})...`);
          await el.click({ force: true }).catch(() => {});
          await page.locator('input[type="password"], input[name="passwd"], input#i0118, input#password').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
          await sleep(1200);
          break;
        }
      }
    }

    // 9. OAuth Permission Consent screen: "Let this app access your info? (1 of 1 apps)" -> Click "Accept"
    const isConsentScreen = bodyText.includes('Let this app access your info') || bodyText.includes('Genspark needs your permission') || bodyText.includes('Genspark memerlukan izin');
    if (isConsentScreen) {
      log('[MS LOGIN] OAuth consent screen detected. Clicking "Accept"...');
      const acceptBtn = page.locator('#idBtn_Accept, input#idBtn_Accept, button#idSIButton9, input#idSIButton9, button:has-text("Accept"), button:has-text("Terima"), input[type="submit"][value="Accept"]').first();
      await acceptBtn.click({ force: true }).catch(() => {});
      await sleep(3000);
      continue;
    }

    // 10. "Stay signed in?" (KMSI) screen -> Click "Yes"
    const isKmsiScreen = bodyText.includes('Stay signed in?') || bodyText.includes('Tetap masuk?') || bodyText.includes('Do this to reduce');
    if (isKmsiScreen) {
      log('[MS LOGIN] "Stay signed in?" prompt detected. Clicking "Yes"...');
      const staySignedInBtn = page.locator('#acceptButton, input#idSIButton9, button#idSIButton9, input[value="Yes"], button:has-text("Yes"), button:has-text("Ya")').first();
      await staySignedInBtn.click({ force: true }).catch(() => {});
      await sleep(2500);
      continue;
    }

    // 11. Check for Microsoft Rate Limit / Server Repeated Attempts Error
    if (bodyText.includes('too many repeated authentication attempts') || bodyText.includes('detected too many repeated') || (bodyText.includes('Something went wrong') && bodyText.includes('sign you in right now'))) {
      log(`[MS LOGIN RATE-LIMIT] Microsoft server rate-limited: "Too many repeated authentication attempts".`);
      throw new Error('MS_SERVER_RATE_LIMIT_REPEATED_ATTEMPTS');
    }

    // 12. Check for Account lockout / Phone verification requirement
    if (bodyText.includes('Help us protect your account') || bodyText.includes('Verify your phone number') || bodyText.includes('Your account has been locked')) {
      log(`[WARN] Account ${account.email} requires phone verification / is locked.`);
      saveOutlookAccountData(account.email, { status: 'LOCKED', recovery_status: 'FAILED' });
      return false;
    }

    await sleep(1000);
  }

  log(`[WARN] MS Login loop reached max attempts.`);
  return false;
}

function generateStrongPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const numbers = '23456789';
  const symbols = '@#$%&*!';

  let pwd = '';
  pwd += upper[Math.floor(Math.random() * upper.length)];
  pwd += lower[Math.floor(Math.random() * lower.length)];
  pwd += numbers[Math.floor(Math.random() * numbers.length)];
  pwd += symbols[Math.floor(Math.random() * symbols.length)];

  const all = upper + lower + numbers + symbols;
  for (let i = 0; i < 8; i++) {
    pwd += all[Math.floor(Math.random() * all.length)];
  }
  return pwd;
}

async function solveGensparkTextCaptcha(page, maxAttempts = 6) {
  const apiKey = process.env.LLM_API_KEY;
  const apiUrl = process.env.LLM_API_URL || 'http://100.103.220.104:20128/v1/chat/completions';
  const model = process.env.LLM_MODEL || 'antigravity/gemini-3.5-flash-high';

  const captchaImgLoc = page.locator('#captchaControlChallengeCode-img, .captcha-imageContent, img[alt*="captcha" i]').first();
  const captchaInputLoc = page.locator('input#captchaControlChallengeCode, input#captcha').first();
  const sendCodeBtnLoc = page.locator('button#emailVerificationControl_but_send_code, button:has-text("Send verification code")').first();
  const reloadBtnLoc = page.locator('button#captchaControlChallengeCode-generateCaptchaBtn, #emailVerificationControl_but_reload_captcha').first();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[CAPTCHA] Solving text captcha with LLM Vision (attempt ${attempt}/${maxAttempts})...`);

    // Wait for captcha image
    await captchaImgLoc.waitFor({ state: 'visible', timeout: 10000 });
    await sleep(600);

    // Get image base64 directly from src attribute if it is data:image, else take screenshot
    let base64Img = '';
    const srcAttr = await captchaImgLoc.getAttribute('src').catch(() => '');
    if (srcAttr && srcAttr.startsWith('data:image')) {
      base64Img = srcAttr.split(',')[1] || '';
    }
    if (!base64Img) {
      const imgBuffer = await captchaImgLoc.screenshot();
      base64Img = imgBuffer.toString('base64');
    }

    const prompt = `You are an expert OCR solver for distorted alphanumeric CAPTCHA images.
The characters in this image may be arranged across multiple lines, rows, or stacked vertically.
Read ALL characters strictly from left-to-right, row-by-row (top row first, then bottom row).
Output ONLY the plain uppercase alphanumeric characters with NO spaces, NO newlines, NO explanation, and NO punctuation.
Example: If the top line shows "MLK" and the bottom line shows "MSY", output: MLKMSY`;

    const body = {
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Img}`,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
    };

    let solution = '';
    try {
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const text = await resp.text();
      let rawContent = '';
      if (text.startsWith('data:')) {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:') && !line.includes('[DONE]')) {
            try {
              const chunk = JSON.parse(line.slice(5).trim());
              rawContent += chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.message?.content || '';
            } catch (_) {}
          }
        }
      } else {
        const data = JSON.parse(text);
        rawContent = data?.choices?.[0]?.message?.content || '';
      }
      solution = rawContent.replace(/[^A-Za-z0-9]/g, '').toUpperCase().trim();
      log(`[CAPTCHA] LLM Vision solution: "${solution}"`);
    } catch (err) {
      log(`[CAPTCHA] LLM API error: ${err.message}`);
    }

    if (!solution || solution.length < 3) {
      log('[CAPTCHA] Solution is too short or empty. Reloading captcha...');
      await reloadBtnLoc.click({ force: true }).catch(() => {});
      await sleep(1500);
      continue;
    }

    // Fill captcha
    await captchaInputLoc.click();
    await captchaInputLoc.fill('');
    await fillHuman(page, captchaInputLoc, solution);
    await sleep(400);

    // Click Send verification code
    log('[CAPTCHA] Clicking "Send verification code"...');
    await sendCodeBtnLoc.click({ force: true });
    await sleep(2500);

    // Check if verification code input became enabled / visible / send code succeeded
    const codeInput = page.locator('input#emailVerificationCode').first();
    const isCodeVisible = await codeInput.isVisible({ timeout: 4000 }).catch(() => false);
    const isCodeEditable = isCodeVisible && await codeInput.isEditable().catch(() => false);

    // Also check if Send code button changed or Verify code button appeared
    const verifyBtn = page.locator('button#emailVerificationControl_but_verify_code').first();
    const isVerifyBtnVisible = await verifyBtn.isVisible({ timeout: 2000 }).catch(() => false);

    if (isCodeEditable || isVerifyBtnVisible) {
      log('🎉 [CAPTCHA] Captcha solved and verification code sent successfully!');
      return true;
    }

    // Otherwise check for error message and click reload
    log(`[CAPTCHA] Captcha rejected or invalid (attempt ${attempt}). Reloading captcha image...`);
    await reloadBtnLoc.click({ force: true }).catch(() => {});
    await sleep(2000);
  }

  throw new Error('Failed to solve CAPTCHA within maximum attempts.');
}

async function handleEmailSignUp(page, account, tempmailClient) {
  log(`[EMAIL SIGNUP] Starting TempMail sign-up for ${account.email}...`);

  // 1. Click "Login with email" on Genspark login screen
  const loginWithEmailBtn = page.locator('button:has-text("Login with email"), div[role="button"]:has-text("Login with email"), a:has-text("Login with email")').first();
  await loginWithEmailBtn.waitFor({ state: 'visible', timeout: 15000 });
  log('[EMAIL SIGNUP] Clicking "Login with email"...');
  await loginWithEmailBtn.click({ force: true });
  await sleep(1500);

  // 2. Click "Don't have an account? Sign up now"
  const signUpNowBtn = page.locator('a:has-text("Sign up now"), button:has-text("Sign up now"), #createAccount').first();
  await signUpNowBtn.waitFor({ state: 'visible', timeout: 10000 });
  log('[EMAIL SIGNUP] Clicking "Sign up now"...');
  await signUpNowBtn.click({ force: true });
  await sleep(2000);

  // 3. Fill Email Address in User Details form
  const emailInput = page.locator('input#email').first();
  await emailInput.waitFor({ state: 'visible', timeout: 10000 });
  log(`[EMAIL SIGNUP] Entering email: ${account.email}`);
  await fillHuman(page, emailInput, account.email);
  await sleep(500);

  // 4. Solve Captcha & Send verification code
  await solveGensparkTextCaptcha(page);

  // 5. Wait for Verification Code via TempMail
  log(`[EMAIL SIGNUP] Waiting for OTP on ${account.email}...`);
  const otp = await tempmailClient.waitForOtp(account.email, 90000);
  if (!otp) {
    throw new Error(`Failed to receive OTP for ${account.email} within 90 seconds.`);
  }
  log(`[EMAIL SIGNUP] ✅ Received verification code: ${otp}`);

  // 6. Enter Verification Code & click "Verify code"
  const otpInput = page.locator('input#emailVerificationCode').first();
  await otpInput.waitFor({ state: 'visible', timeout: 8000 });
  await fillHuman(page, otpInput, otp);
  await sleep(400);

  const verifyCodeBtn = page.locator('button#emailVerificationControl_but_verify_code').first();
  log('[EMAIL SIGNUP] Clicking "Verify code"...');
  await verifyCodeBtn.click({ force: true });
  await sleep(2500);

  // 7. Enter New Password & Re-enter Password
  const newPwdInput = page.locator('input#newPassword').first();
  const reenterPwdInput = page.locator('input#reenterPassword').first();

  await newPwdInput.waitFor({ state: 'visible', timeout: 10000 });
  log(`[EMAIL SIGNUP] Entering password...`);
  await fillHuman(page, newPwdInput, account.password);
  await sleep(300);

  if (await reenterPwdInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    log(`[EMAIL SIGNUP] Entering confirm password...`);
    await fillHuman(page, reenterPwdInput, account.password);
    await sleep(300);
  }

  // 8. Click "Create" / "Continue"
  const createBtn = page.locator('button#continue').first();
  log('[EMAIL SIGNUP] Clicking "Create"...');
  await createBtn.click({ force: true });

  // 9. Wait for redirect back to Genspark session
  log('[EMAIL SIGNUP] Waiting for redirect to Genspark home...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const url = page.url();
    if (url.includes('genspark.ai') && !url.includes('login.genspark.ai')) {
      log(`[EMAIL SIGNUP] Successfully authenticated and redirected to ${url}`);
      return true;
    }
  }

  return true;
}

async function registerGenspark() {
  const isEmailMode = process.argv.includes('--email') || envFlag('GENSPARK_EMAIL_MODE', false);

  log('==============================================');
  log(`🚀 Starting Genspark Auto-Registration (${isEmailMode ? 'TempMail Mode' : 'Microsoft Outlook Mode'})...`);
  log('==============================================');

  let account = null;
  let tempmailClient = null;

  if (isEmailMode) {
    tempmailClient = new TempMail();
    const inbox = await tempmailClient.createInbox();
    account = {
      email: inbox.address,
      password: generateStrongPassword(),
    };
    log(`[ACCOUNT] Generated TempMail account: ${account.email}`);
  } else {
    // 1. Load Outlook account
    const accounts = loadOutlookAccounts();
    if (accounts.length === 0) {
      log('[ERROR] No accounts found in data/outlook_accounts.csv');
      process.exit(1);
    }

    account = pickFreshOutlook(accounts, CONFIG.outputFile, { requireToken: false });
    if (!account) {
      log('[ERROR] All accounts in data/outlook_accounts.csv have already been used for Genspark!');
      process.exit(0);
    }

    log(`[ACCOUNT] Selected target account: ${account.email}`);
  }

  // 2. Select proxy (Mandatory for Genspark unless --direct explicitly passed)
  let proxy = null;
  let selectedRawProxy = null;
  const isDirectMode = process.argv.includes('--direct') || process.argv.includes('--no-proxy');

  if (!isDirectMode) {
    selectedRawProxy = selectProxy(CONFIG.proxy || '', { service: 'genspark' });
    if (!selectedRawProxy) {
      log('[PROXY] No active proxy available for Genspark. Fetching fresh proxies against Genspark...');
      const { ensureProxiesAvailable } = require('../utils/proxy.js');
      ensureProxiesAvailable({ service: 'genspark', background: false });
      selectedRawProxy = selectProxy(CONFIG.proxy || '', { service: 'genspark' });
    }

    if (!selectedRawProxy) {
      log('[ERROR] Proxy is REQUIRED for Genspark. No working proxy could be fetched. Aborting to protect direct IP.');
      process.exit(1);
    }

    proxy = proxyFromUrl(selectedRawProxy);
    log(`[PROXY] Using proxy: ${proxy.server}`);
  } else {
    log('[WARN] Running in --direct mode (Proxy disabled).');
  }

  const isCam = isCamoufox(rawBrowserPath);

  // 3. Launch browser
  log(`[BROWSER] Launching ${isCam ? 'Camoufox' : 'Chromium'} (headless: ${CONFIG.headless})...`);
  const launchOptions = {
    headless: CONFIG.headless,
    args: isCam
      ? ['--no-sandbox']
      : [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
        ],
  };

  if (rawBrowserPath && fs.existsSync(rawBrowserPath)) {
    launchOptions.executablePath = rawBrowserPath;
  }
  if (proxy) {
    launchOptions.proxy = proxy;
  }

  let browser;
  try {
    browser = await browserType.launch(launchOptions);
  } catch (err) {
    log(`[ERROR] Failed to launch browser: ${err.message}`);
    process.exit(1);
  }

  const contextOpts = isCam
    ? { viewport: null, locale: 'en-US' }
    : {
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      };

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);

  try {
    // 4. Open Genspark Login Entry
    log(`[NAVIGATE] Opening ${CONFIG.loginEntryUrl}...`);
    await page.goto(CONFIG.loginEntryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    if (isEmailMode) {
      // 5-6. Execute Email Sign Up flow
      await handleEmailSignUp(page, account, tempmailClient);
    } else {
      // 5. On login.genspark.ai page, click "Microsoft" button
      log('[FLOW] Waiting for "Microsoft" button on login.genspark.ai...');
      const msBtn = page.locator('button:has-text("Microsoft"), div[role="button"]:has-text("Microsoft"), a:has-text("Microsoft"), [data-provider="microsoft"]').first();
      await msBtn.waitFor({ state: 'visible', timeout: 25000 });
      log('[FLOW] Clicking "Microsoft"...');
      await msBtn.click({ force: true });
      await sleep(3000);

      // 6. Handle Microsoft Login
      const msSuccess = await handleMicrosoftLogin(page, account);
      if (!msSuccess) {
        throw new Error('Microsoft authentication failed or timed out.');
      }
    }

    // 7. Verify we are logged in on Genspark (with auto-reload if stuck on authresp / Bad Request)
    log('[FLOW] Waiting for authenticated Genspark session...');
    let loggedIn = false;
    for (let waitAttempt = 1; waitAttempt <= 6; waitAttempt++) {
      try {
        await page.waitForURL(url => url.hostname.includes('genspark.ai') && !url.hostname.includes('login.genspark.ai'), { timeout: 8000 });
        loggedIn = true;
        break;
      } catch (_) {
        const u = page.url();
        const b = await page.innerText('body').catch(() => '');
        if (b.includes('Bad Request') || u.includes('authresp') || u.includes('login.genspark.ai')) {
          log(`[FLOW] Page at ${u} with "${b.slice(0, 30)}...". Reloading (${waitAttempt}/6)...`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await sleep(2500);
        }
      }
    }
    if (!loggedIn) {
      await page.waitForURL(url => url.hostname.includes('genspark.ai') && !url.hostname.includes('login.genspark.ai'), { timeout: 15000 });
    }
    await sleep(3000);
    log('✅ Successfully logged into Genspark Web Session!');

    // 8. Execute GSK Device Code Flow
    log('[GSK AUTH] Requesting device code from /api/cli_auth/device_code...');
    const deviceResp = await page.evaluate(async () => {
      const r = await fetch('https://www.genspark.ai/api/cli_auth/device_code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return await r.json();
    }).catch(async () => {
      const res = await fetch('https://www.genspark.ai/api/cli_auth/device_code', { method: 'POST' });
      return await res.json();
    });

    const { device_code, auth_url, poll_interval = 3, expires_in = 600 } = deviceResp || {};
    if (!device_code || !auth_url) {
      throw new Error(`Failed to obtain device_code: ${JSON.stringify(deviceResp)}`);
    }

    log(`[GSK AUTH] Received device code: ${device_code}`);
    log(`[GSK AUTH] Navigating to auth URL: ${auth_url}`);

    // Navigate to auth verification page in a fresh page in the same authenticated context
    await sleep(2000);
    const authPage = await context.newPage();
    authPage.setDefaultTimeout(CONFIG.timeout);
    await authPage.goto(auth_url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(2500);

    // 9. Click "Allow" button on verification page (with auto-reload if blank)
    log('[GSK AUTH] Looking for "Allow" button on CLI authorization page...');
    const allowBtn = authPage.locator('button:has-text("Allow"), button:has-text("Izinkan"), button.primary:has-text("Allow"), div[role="button"]:has-text("Allow")').first();

    let allowFound = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await allowBtn.waitFor({ state: 'visible', timeout: 7000 });
        allowFound = true;
        break;
      } catch (_) {
        log(`[GSK AUTH] "Allow" button not visible yet (attempt ${attempt}/4). Reloading page...`);
        await authPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(2500);
      }
    }

    if (!allowFound) {
      await allowBtn.waitFor({ state: 'visible', timeout: 10000 });
    }

    log('[GSK AUTH] Clicking "Allow"...');
    await allowBtn.click({ force: true });
    await sleep(2000);

    // 10. Poll for API Token
    log('[GSK AUTH] Polling /api/cli_auth/token for API Key...');
    const startTime = Date.now();
    const timeoutMs = expires_in * 1000;
    let apiKey = null;

    while (Date.now() - startTime < timeoutMs) {
      await sleep(poll_interval * 1000);
      const tokenResp = await fetch(`https://www.genspark.ai/api/cli_auth/token?code=${encodeURIComponent(device_code)}`)
        .then(r => r.json())
        .catch(() => null);

      if (tokenResp && tokenResp.status === 'approved' && tokenResp.api_key) {
        apiKey = tokenResp.api_key;
        log(`🎉 [GSK AUTH] API Key successfully obtained: ${apiKey.substring(0, 25)}...`);
        break;
      }

      if (tokenResp && tokenResp.status === 'expired') {
        throw new Error('Device code authorization expired.');
      }
    }

    if (!apiKey) {
      throw new Error('Timed out waiting for device token approval.');
    }

    // 11. Save output
    updateGskConfigFile(apiKey);
    appendToCsv(account.email, account.password, apiKey, 'ACTIVE');
    if (selectedRawProxy) {
      incrementGensparkProxyUsage(selectedRawProxy);
    }

    log('==============================================');
    log(`✨ REGISTRATION & GSK AUTH COMPLETE for ${account.email}!`);
    log(`🔑 API Key: ${apiKey}`);
    log('==============================================');

    await sleep(2000);
  } catch (err) {
    log(`[ERROR] Registration flow encountered an error: ${err.message}`);
    if (selectedRawProxy || proxy) {
      handleProxyFailure(selectedRawProxy || proxy.server, err, { service: 'genspark' });
    }
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  registerGenspark();
}

module.exports = { registerGenspark };
