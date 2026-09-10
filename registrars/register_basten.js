const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const { loadOutlookAccounts, pickFreshOutlook, resolveEmail, waitForOtp, parseCsvLine } = require('../utils/email.js');

const browserExecutable = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
const browserType = browserTypeFor(browserExecutable);

const TempMail = require('../services/tempmail/tempmail.js');
const fs = require('fs');
const path = require('path');

const { sleep, rand, fillHuman, gotoWithRetry, handleCookies } = require('../utils/helpers.js');
const { randomFirstName, randomLastName } = require('../utils/names.js');

const CONFIG = {
  registerUrl: 'https://login.baseten.co/sign-up',
  password: process.env.BASETEN_PASSWORD || process.env.PASSWORD || 'PortoAuto2026!',
  outputFile: path.join(__dirname, '..', 'data', 'basten.csv'),
  emailTimeout: 180000,
  otpTimeout: 180000,
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  proxy: process.env.PROXY || '',
  browserExecutablePath: browserExecutable,
};


function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function resolveBaseEmail(tempmail) {
  const envGmailUser = process.env.GMAIL_USER || '';
  const emails = envGmailUser.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  if (emails.length > 0) {
    const selected = emails[Math.floor(Math.random() * emails.length)];
    console.log(`  Selected random email from GMAIL_USER list: ${selected}`);
    return selected;
  }

  let activeGmail = null;
  try {
    const accessToken = await tempmail._refreshGmailToken();
    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      activeGmail = profile.emailAddress;
    }
  } catch (err) {
    console.log(`  [WARN] Failed to fetch active Gmail profile: ${err.message}`);
  }

  if (activeGmail) {
    console.log(`  Using active Gmail account fetched dynamically: ${activeGmail}`);
    return activeGmail;
  }
  
  throw new Error("Failed to determine Gmail address. Please set GMAIL_USER in .env.");
}

async function handleTurnstile(page, timeoutMs = 15000) {
  try {
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first();
    const isVisible = await turnstileIframe.isVisible({ timeout: 1500 }).catch(() => false);
    if (!isVisible) {
      return true;
    }

    console.log('  [Turnstile] Challenge detected. Solving...');
    const startTime = Date.now();
    let lastClickTime = 0;

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
            name === 'cf_challenge_response' ||
            id.endsWith('_response')
          ) {
            if (el.value && el.value.length > 50) return el.value;
          }
        }
        return null;
      }).catch(() => null);

      if (tokenValue) {
        console.log(`  ✅ Turnstile solved!`);
        return true;
      }

      const box = await turnstileIframe.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        const now = Date.now();
        if (now - lastClickTime > 4000) {
          const clickX = box.x + 30;
          const clickY = box.y + box.height / 2;
          console.log(`  [Turnstile] Clicking checkbox at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
          await page.mouse.click(clickX, clickY).catch(() => {});
          lastClickTime = now;
        }
      }

      await sleep(1000);
    }
  } catch (err) {
    // Ignore turnstile error
  }
  return false;
}

function extractBastenOtp(subject, textBody, htmlBody) {
  // 1. Try TempMail smart extractor first
  const smartOtp = TempMail.extractOtp(subject, textBody, htmlBody);
  if (smartOtp && smartOtp.length === 6 && /^\d{6}$/.test(smartOtp)) {
    const year = parseInt(smartOtp, 10);
    if (year < 2000 || year > 2099) {
      return smartOtp;
    }
  }

  // 2. Clean text and HTML bodies (strip colors, emails, expiration notices, links)
  const cleanHtml = TempMail.cleanHtml(htmlBody || '');
  const cleanText = TempMail.stripEmailHeaders(textBody || '')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ')
    .replace(/(?:expires?|valid|berlaku|kedaluwarsa)\s+(?:in|for|selama|within)?\s*\d+\s*(?:minutes?|mins?|menit|seconds?|secs?|detik|hours?|jam)/gi, ' ');

  const combined = `${cleanText}\n${cleanHtml}`;
  const p = '(?:otp|kode|code|verif(?:y|ication|ikasi)?|pin|password|passcode|security|launch\\s+code|one[-\\s]?time(?:\\s+code|\\s+password)?|2fa)';

  const kwMatch = combined.match(new RegExp(`${p}[^\\d]{0,100}\\b(\\d{6})\\b`, 'i'));
  if (kwMatch) {
    const year = parseInt(kwMatch[1], 10);
    if (year < 2000 || year > 2099) {
      return kwMatch[1];
    }
  }

  // 3. Fallback: any standalone 6-digit number in cleaned text
  const textMatches = cleanText.match(/\b(\d{6})\b/g);
  if (textMatches && textMatches.length > 0) {
    const valid = textMatches.filter(code => {
      const year = parseInt(code, 10);
      return !(year >= 2000 && year <= 2099);
    });
    if (valid.length > 0) return valid[0];
  }

  return null;
}

function isBasetenEmail(m) {
  const from = (m.from_address || '').toLowerCase();
  const sub = (m.subject || '').toLowerCase();
  const txt = (m.text_body || '').toLowerCase();
  const html = (m.html_body || '').toLowerCase();
  return from.includes('baseten') || sub.includes('baseten') || sub.includes('verify your email') || sub.includes('create your baseten') || txt.includes('baseten') || html.includes('baseten');
}

function markGithubAccountSuspended(emailToMark) {
  if (!emailToMark) return;
  const ghCsvPath = path.join(__dirname, '..', 'data', 'github_accounts.csv');
  if (!fs.existsSync(ghCsvPath)) return;
  try {
    const content = fs.readFileSync(ghCsvPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const header = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
    let statusCol = header.indexOf('github_status');
    if (statusCol === -1) {
      statusCol = header.indexOf('imported_to_omniroute');
    }
    const emailCol = header.indexOf('email');
    if (emailCol === -1) return;

    const newLines = [lines[0]];
    let modified = false;
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
      if (parts[emailCol] && parts[emailCol].toLowerCase() === emailToMark.toLowerCase()) {
        if (statusCol !== -1) {
          parts[statusCol] = 'suspended';
        }
        modified = true;
      }
      newLines.push(parts.map(p => `"${String(p).replace(/"/g, '""')}"`).join(','));
    }
    if (modified) {
      fs.writeFileSync(ghCsvPath, newLines.join('\n') + '\n', 'utf8');
      console.log(`  🚫 [DATABASE] Marked ${emailToMark} as suspended in github_accounts.csv`);
    }
  } catch (err) {
    console.warn(`  [WARN] Failed updating github_accounts.csv: ${err.message}`);
  }
}

async function waitForBastenOtp({ email, timeout = 180000, since = Date.now() - 30000, tempmail, outlookAccount } = {}) {
  const isOutlook = email.toLowerCase().includes('@outlook.') || email.toLowerCase().includes('@hotmail.') || email.toLowerCase().includes('@live.');
  if (isOutlook) {
    console.log(`  [Baseten OTP] Polling via Outlook/Hotmail service for ${email}...`);
    return await waitForOtp({
      mode: 'outlook',
      email,
      account: outlookAccount,
      timeout,
      since,
      subjectContains: 'Baseten',
    });
  }

  const startOtpTime = Date.now();
  while (Date.now() - startOtpTime < timeout) {
    try {
      const messages = await tempmail.getMessages(email);
      const sorted = [...messages].sort((a, b) => {
        const tA = Date.parse(a.received_at) || 0;
        const tB = Date.parse(b.received_at) || 0;
        return tB - tA;
      });
      const newMessages = sorted.filter(m => {
        const rec = Date.parse(m.received_at);
        return !isNaN(rec) && rec >= since;
      });
      const otpMsg = newMessages.find(isBasetenEmail);
      if (otpMsg) {
        const code = extractBastenOtp(otpMsg.subject, otpMsg.text_body, otpMsg.html_body);
        if (code && code.length === 6 && /^\d{6}$/.test(code)) {
          return code;
        }
      }
    } catch (e) {
      console.error("  Polling error:", e.message);
    }
    await sleep(3000);
  }
  return null;
}

async function checkWaitingRoom(page) {
  const url = page.url();
  const lowerUrl = url.toLowerCase();
  
  if (lowerUrl.includes('waiting_room') || lowerUrl.includes('waiting-room') || lowerUrl.includes('waitlist') || lowerUrl.includes('waitingroom') || lowerUrl.includes('approval')) {
    console.log(`[WAITING ROOM] Entered waiting room/approval gate via URL: ${url}`);
    return true;
  }
  
  const bodyText = await page.innerText('body').catch(() => '');
  const lowerText = bodyText.toLowerCase();
  
  const waitingKeywords = [
    'waiting room',
    'waitlist',
    'waiting list',
    'you are in the waiting room',
    'queue',
    'you\'ve been added to the waitlist',
    'we need more information to approve your account',
    'to speed up your approval',
    'when your account is approved',
    'account is approved',
    'pending approval',
    'under review'
  ];
  
  for (const keyword of waitingKeywords) {
    if (lowerText.includes(keyword)) {
      console.log(`[WAITING ROOM] Entered waiting room/approval gate via keyword: "${keyword}"`);
      return true;
    }
  }

  return false;
}

async function handleBasetenOnboarding(page, firstName, lastName, wsName, timeoutMs = 60000) {
  console.log('[6/8] Handling Baseten onboarding & workspace wizard...');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (page.isClosed()) return false;

    await handleCookies(page);
    await handleTurnstile(page, 3000);

    const currentUrl = page.url();
    let u;
    try { u = new URL(currentUrl); } catch (_) { u = { hostname: '', pathname: '' }; }

    // 0. Check for Waiting Room
    if (await checkWaitingRoom(page)) {
      throw new Error('Baseten registration failed: Entered waiting room.');
    }

    // 1. Check for "We need more information to approve your account" questionnaire
    const bodyText = await page.innerText('body').catch(() => '');
    const isApprovalScreen = bodyText.includes('We need more information to approve your account') ||
      (await page.locator('h1:has-text("approve your account"), h2:has-text("approve your account"), text="We need more information to approve your account"').first().isVisible({ timeout: 1000 }).catch(() => false));

    if (isApprovalScreen) {
      console.log('  [Onboarding] Approval questionnaire detected ("We need more information to approve your account"). Auto-filling details...');

      // A. Company name
      const compInput = page.locator('input[placeholder*="AI Startup" i], input[placeholder*="company" i], input[name*="company" i]').first();
      if (await compInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log(`  [Onboarding] Filling Company: ${lastName} AI Labs`);
        await fillHuman(page, compInput, `${lastName} AI Labs`);
        await sleep(200);
      }

      // B. LinkedIn / Professional profile
      const lnProfileInput = page.locator('input[placeholder*="linkedin" i], input[name*="linkedin" i], input[name*="profile" i], input[placeholder*="http" i]').first();
      if (await lnProfileInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        const dummyLinkedin = `https://www.linkedin.com/in/${firstName.toLowerCase()}-${lastName.toLowerCase()}-${rand(100, 999)}`;
        console.log(`  [Onboarding] Filling LinkedIn profile: ${dummyLinkedin}`);
        await fillHuman(page, lnProfileInput, dummyLinkedin);
        await sleep(200);
      }

      // C. How do you want to use Baseten?
      const useCaseArea = page.locator('textarea').first();
      if (await useCaseArea.isVisible({ timeout: 1500 }).catch(() => false)) {
        const useCaseText = 'We are developing AI applications and deploying open source LLM models on Baseten for scalable inference API endpoints.';
        console.log('  [Onboarding] Filling use case explanation...');
        await fillHuman(page, useCaseArea, useCaseText);
        await sleep(200);
      }

      // D. Click Submit button
      const submitApprovalBtn = page.locator('button:has-text("Submit"), button[type="submit"]').first();
      if (await submitApprovalBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  [Onboarding] Submitting approval form...');
        await submitApprovalBtn.click().catch(() => {});
        await sleep(4000);
      }

      // E. Check if submitted page shows waiting for email approval
      const afterText = await page.innerText('body').catch(() => '');
      if (afterText.includes('You\'ll receive an email when your account is approved') || afterText.includes('approved') || afterText.includes('under review')) {
        console.log('  [Notice] Approval form submitted. Account is pending email review.');
      }
      continue;
    }

    // 2. Check if REAL dashboard or API keys settings reached
    const isRealDashboard = (u.hostname === 'app.baseten.co' && !u.pathname.includes('onboarding') && !u.pathname.includes('sign-up') && !u.pathname.includes('login') && !u.pathname.includes('callback') && !u.pathname.includes('email-verification')) &&
      !bodyText.includes('approve your account') &&
      !bodyText.includes('First name') &&
      !bodyText.includes('Your company\'s name');

    if (isRealDashboard) {
      console.log('  [Onboarding] Successfully reached Baseten dashboard!');
      return true;
    }

    // 3. First Name & Last Name
    const fnInput = page.locator('input[name="firstName"], input[name="first_name"], input[placeholder*="First" i]').first();
    if (await fnInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('  [Onboarding] Filling First Name & Last Name...');
      await fillHuman(page, fnInput, firstName);
      await sleep(200);

      const lnInput = page.locator('input[name="lastName"], input[name="last_name"], input[placeholder*="Last" i]').first();
      if (await lnInput.isVisible({ timeout: 1000 }).catch(() => false)) {
        await fillHuman(page, lnInput, lastName);
        await sleep(200);
      }

      const continueProfileBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first();
      if (await continueProfileBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await continueProfileBtn.click().catch(() => {});
        await sleep(2000);
        continue;
      }
    }

    // 4. Full Name / Single Name input
    const nameInput = page.locator('input[name="name"], input[name="fullName"], input[placeholder*="Your name" i], input[placeholder*="Full name" i]').first();
    if (await nameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('  [Onboarding] Filling Name...');
      await fillHuman(page, nameInput, `${firstName} ${lastName}`);
      await sleep(200);
      const nextBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first();
      if (await nextBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await sleep(2000);
        continue;
      }
    }

    // 5. Workspace / Organization Name
    const wsInput = page.locator('input[placeholder*="Company" i], input[name="workspaceName"], input[name="workspace_name"], input[name="orgName"], input[placeholder*="Workspace" i]').first();
    if (await wsInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`  [Onboarding] Filling workspace name: ${wsName}`);
      await fillHuman(page, wsInput, wsName);
      await sleep(200);

      const continueWsBtn = page.locator('button:has-text("Continue"), button:has-text("Create"), button:has-text("Next"), button[type="submit"]').first();
      if (await continueWsBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await continueWsBtn.click().catch(() => {});
        await sleep(2000);
        continue;
      }
    }

    // 6. Skip or Role Selection
    const skipBtn = page.locator('button:has-text("Skip"), a:has-text("Skip"), button:has-text("Maybe later"), button:has-text("Dismiss")').first();
    if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('  [Onboarding] Skipping optional step...');
      await skipBtn.click().catch(() => {});
      await sleep(2000);
      continue;
    }

    const roleOption = page.locator('button:has-text("Engineer"), button:has-text("Developer"), label:has-text("Engineer"), div[role="button"]:has-text("Engineer")').first();
    if (await roleOption.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('  [Onboarding] Selecting role option...');
      await roleOption.click().catch(() => {});
      await sleep(1000);
      const nextBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first();
      if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await nextBtn.click().catch(() => {});
        await sleep(2000);
      }
      continue;
    }

    // 7. Generic Continue Button
    const genericContinueBtn = page.locator('button:has-text("Continue"), button:has-text("Get Started"), button:has-text("Next")').first();
    if (await genericContinueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('  [Onboarding] Clicking generic continue button...');
      await genericContinueBtn.click().catch(() => {});
      await sleep(2000);
      continue;
    }

    await sleep(1500);
  }

  return true;
}

async function register() {
  let browser;
  let context;
  let page;
  let stepTimer;
  let selectedProxy = '';

  const isGithubMode = process.argv.includes('--github') || 
    process.env.BASETEN_SIGNUP_MODE === 'github' || 
    process.env.SIGNUP_MODE === 'github';

  const isOutlookMode = process.argv.includes('--outlook') ||
    process.env.BASETEN_SIGNUP_MODE === 'outlook' ||
    process.env.SIGNUP_MODE === 'outlook';

  function armStep(label, timeoutMs = CONFIG.stepTimeout) {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      console.error(`  TIMEOUT: ${label} stuck > ${Math.round(timeoutMs / 1000)}s. Closing browser, exiting...`);
      const forceExit = setTimeout(() => process.exit(1), 5000);
      if (forceExit.unref) forceExit.unref();
      Promise.resolve(browser?.close()).catch(() => {}).finally(() => process.exit(1));
    }, timeoutMs);
  }

  try {
    console.log('=== Baseten Auto-Registration Script ===');
    console.log(`Mode: ${isGithubMode ? 'GitHub OAuth (like TokenHarbor)' : isOutlookMode ? 'Outlook/Hotmail Account' : 'Direct Email OTP'}`);

    const tempmail = new TempMail();
    const provider = process.env.TEMPMAIL_PROVIDER || TempMail.PROVIDER || 'webhook';

    let email = '';
    let githubUsername = '';
    let githubPassword = CONFIG.password;
    let outlookAccount = null;
    const firstName = randomFirstName();
    const lastName = randomLastName();

    if (isOutlookMode) {
      const outlookAccounts = loadOutlookAccounts();
      if (outlookAccounts.length === 0) {
        throw new Error('No Outlook/Hotmail accounts found in outlook_accounts.csv');
      }
      outlookAccount = pickFreshOutlook(outlookAccounts, CONFIG.outputFile);
      if (!outlookAccount) {
        throw new Error('No fresh Outlook accounts available. All used in basten.csv');
      }
      email = outlookAccount.email;
      console.log(`[*] Using Outlook account: ${email} | Recovery: ${outlookAccount.recoveryEmail || 'none'}`);
      
      // Use recovery Gmail as Tempmail source for OTP if available
      if (outlookAccount.recoveryEmail) {
        process.env.GMAIL_USER = outlookAccount.recoveryEmail;
        console.log(`[*] Set GMAIL_USER to recovery email: ${outlookAccount.recoveryEmail}`);
      }
    }

    if (isGithubMode) {
      const useExistingGithub = process.argv.includes('--use-existing-github') || process.argv.includes('--existing') || process.env.USE_EXISTING_GITHUB === 'true';
      const ghCsvPath = path.join(__dirname, '..', 'data', 'github_accounts.csv');

      if (process.env.GITHUB_EMAIL && process.env.GITHUB_PASSWORD) {
        email = process.env.GITHUB_EMAIL;
        githubUsername = process.env.GITHUB_USER || email.split('@')[0];
        githubPassword = process.env.GITHUB_PASSWORD;
        console.log(`[*] Using provided GitHub credentials: ${email}`);
      } else if (useExistingGithub && fs.existsSync(ghCsvPath)) {
        try {
          const ghContent = fs.readFileSync(ghCsvPath, 'utf8');
          const lines = ghContent.split('\n').map(l => l.trim()).filter(Boolean);
          // Parse lines (skip header)
          const availableAccounts = [];
          for (let i = 1; i < lines.length; i++) {
            const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, '').trim());
            const [ts, em, pw, un, prx, status, ghStatus] = parts;
            const isSuspended = String(status || '').toLowerCase() === 'suspended' || String(ghStatus || '').toLowerCase() === 'suspended' || String(ghStatus || '').toLowerCase() === 'banned';
            if (em && pw && !isSuspended) {
              availableAccounts.push({ email: em, password: pw, username: un || em.split('@')[0] });
            }
          }

          // Check against basten.csv
          const bastenEmails = new Set();
          if (fs.existsSync(CONFIG.outputFile)) {
            const bastenLines = fs.readFileSync(CONFIG.outputFile, 'utf8').split('\n').filter(Boolean);
            for (let i = 1; i < bastenLines.length; i++) {
              const bEmail = bastenLines[i].split(',')[1]?.replace(/^"|"$/g, '').trim().toLowerCase();
              if (bEmail) bastenEmails.add(bEmail);
            }
          }

          const freshAccounts = availableAccounts.filter(a => !bastenEmails.has(a.email.toLowerCase()));
          if (freshAccounts.length > 0) {
            const preferredAccounts = freshAccounts.filter(a => a.email.endsWith('@dellakuyang.com'));
            const pool = preferredAccounts.length > 0 ? preferredAccounts : freshAccounts;
            const chosen = pool[Math.floor(Math.random() * pool.length)];
            email = chosen.email;
            githubUsername = chosen.username;
            githubPassword = chosen.password;
            console.log(`[*] Selected existing GitHub account from database (${pool.length} available on active domain): ${email}`);
          }
        } catch (err) {
          console.warn(`  [WARN] Failed reading github_accounts.csv: ${err.message}`);
        }
      }

      if (!email) {
        console.log('=== Step 1: Registering fresh GitHub account (with proxy/VPN) ===');
        const { register: registerGithub, CONFIG: githubConfig } = require('./register_github.js');
        const githubResult = await registerGithub({ keepOpen: false });
        email = githubResult.email;
        githubUsername = githubResult.username;
        githubPassword = githubConfig.password || 'PortoAuto2025!';
      }
    } else {
      // Direct Email mode
      if (isOutlookMode) {
        // Email already set from Outlook account, skip generation
        console.log(`[*] Outlook mode: using ${email} directly`);
      } else if (provider === 'gmail' || process.env.GMAIL_USER) {
        const baseEmail = await resolveBaseEmail(tempmail);
        const atIdx = baseEmail.indexOf('@');
        const username = baseEmail.slice(0, atIdx);
        const domainName = baseEmail.slice(atIdx + 1);
        const cleanUsername = username.replace(/\./g, '').split('+')[0];

        const existingEmails = new Set();
        if (fs.existsSync(CONFIG.outputFile)) {
          try {
            const content = fs.readFileSync(CONFIG.outputFile, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            for (let i = 1; i < lines.length; i++) {
              const parts = lines[i].split(',');
              if (parts[1]) {
                const cleanEmail = parts[1].replace(/"/g, '').trim().toLowerCase();
                existingEmails.add(cleanEmail);
              }
            }
          } catch (_) {}
        }

        let attempts = 0;
        while (attempts < 2000) {
          let dottedUsername = '';
          for (let i = 0; i < cleanUsername.length; i++) {
            dottedUsername += cleanUsername[i];
            if (i < cleanUsername.length - 1 && Math.random() < 0.5) {
              dottedUsername += '.';
            }
          }
          const plusSuffix = `+bas_${Date.now()}_${rand(1000, 9999)}`;
          const candidateEmail = `${dottedUsername}${plusSuffix}@${domainName}`.toLowerCase();
          if (!existingEmails.has(candidateEmail)) {
            email = candidateEmail;
            break;
          }
          attempts++;
        }
        if (!email) {
          const plusSuffix = `+bas_${Date.now()}_${rand(1000, 9999)}`;
          email = `${cleanUsername}${plusSuffix}@${domainName}`.toLowerCase();
        }
      } else {
        const inbox = await tempmail.createInbox();
        email = inbox.address;
      }
    }

    console.log(`Target registration email: ${email}`);

    // Launch Browser Context for Baseten
    armStep('[1/8] Launching browser', CONFIG.launchTimeout);
    console.log('[1/8] Launching browser for Baseten...');

    const executablePathToUse = CONFIG.browserExecutablePath || undefined;
    const isDirect = process.argv.includes('--no-proxy') || process.argv.includes('--direct') || envFlag('DISABLE_PROXY');
    const proxyArg = process.argv.find(a => a.startsWith('--proxy='))?.split('=')[1];
    const proxyToSelect = proxyArg || CONFIG.proxy;
    selectedProxy = isDirect ? '' : selectProxy(proxyToSelect);
    const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
    const isCam = isCamoufox(executablePathToUse);
    let tempProfileDir = '';

    if (selectedProxyConfig) {
      console.log(`  Using proxy for Baseten: ${selectedProxy}`);
    } else {
      console.log('  Using Direct / WARP connection (NO proxy) for Baseten...');
    }

    const vpWidth = 1366 + rand(-20, 20);
    const vpHeight = 768 + rand(-10, 10);

    if (isCam) {
      console.log('  Launching Camoufox browser...');
      const launchOpts = {
        headless: envFlag('HEADLESS'),
        args: ['--no-sandbox'],
        ignoreHTTPSErrors: true,
      };
      if (selectedProxyConfig) launchOpts.proxy = selectedProxyConfig;
      if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

      browser = await browserTypeFor(executablePathToUse).launch(launchOpts);
      context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
    } else {
      console.log('  Launching Chromium/Brave persistent context...');
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_basten_${Date.now()}_${Math.floor(Math.random() * 100000)}`);
      
      const contextOpts = {
        headless: envFlag('HEADLESS'),
        executablePath: executablePathToUse,
        viewport: { width: vpWidth, height: vpHeight },
        locale: 'en-US',
        timezoneId: 'Asia/Jakarta',
        ignoreHTTPSErrors: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
        ],
      };
      if (selectedProxyConfig) contextOpts.proxy = selectedProxyConfig;

      context = await chromium.launchPersistentContext(tempProfileDir, contextOpts);
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

    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();

    console.log(`[*] Profile Details:`);
    console.log(`  - Name:     ${firstName} ${lastName}`);
    console.log(`  - Email:    ${email}`);
    if (isGithubMode) console.log(`  - GitHub:   ${githubUsername}`);

    // Step 2: Open Baseten sign-up page
    armStep('[2/8] Navigating to Baseten sign-up page', 90000);
    console.log('[2/8] Opening Baseten sign-up page...');
    await page.goto(CONFIG.registerUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(3000);

    await handleCookies(page);
    await handleTurnstile(page, 15000);

    if (isGithubMode) {
      // Step 3: Click Continue with GitHub
      armStep('[3/8] Continuing with GitHub OAuth', 240000);
      console.log('[3/8] Clicking Continue with GitHub...');
      const ghBtn = page.locator('a[href*="GitHubOAuth"], a:has-text("Continue with GitHub"), button:has-text("Continue with GitHub")').first();
      await ghBtn.waitFor({ state: 'visible', timeout: 20000 });
      await ghBtn.click();

      // State machine loop while on GitHub
      const oauthStart = Date.now();
      await sleep(3000); // Give browser time to start redirecting to GitHub

      while (Date.now() - oauthStart < 240000) {
        const currentUrl = page.url();
        let u;
        try { u = new URL(currentUrl); } catch (_) { u = { hostname: '', pathname: '' }; }
        console.log(`  [GitHub OAuth Loop] Host: ${u.hostname}, Path: ${u.pathname}`);

        // Only exit loop when ACTUALLY on email-verification or app dashboard
        if (u.pathname.includes('email-verification') || (u.hostname === 'app.baseten.co' && !u.pathname.includes('callback') && !u.pathname.includes('login') && !u.pathname.includes('sign-up'))) {
          console.log('  [OAuth Success] Redirected back to Baseten (Verification or Dashboard)!');
          break;
        }

        // Check for Suspended / Blocked Account on GitHub
        if (u.pathname.includes('/suspended') || u.pathname.includes('/blocked') || currentUrl.includes('/suspended') || currentUrl.includes('/blocked')) {
          const bodyText = await page.innerText('body').catch(() => '');
          if (u.pathname.includes('/suspended') || bodyText.toLowerCase().includes('suspended') || bodyText.toLowerCase().includes('flagged')) {
            console.error(`  ❌ [SUSPENDED] GitHub account ${email} is suspended!`);
            markGithubAccountSuspended(email);
            throw new Error(`GITHUB_SUSPENDED: Account ${email} is suspended by GitHub`);
          }
        }

        // Check for Invalid Credentials
        const loginErrorMsg = page.locator('.flash-error, div[role="alert"]:has-text("Incorrect username or password")').first();
        if (await loginErrorMsg.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.error(`  ❌ [INVALID CREDENTIALS] GitHub rejected login credentials for ${email}!`);
          throw new Error(`GITHUB_INVALID_CREDENTIALS: Incorrect username or password for ${email}`);
        }

        // 1. Check for GitHub Login Form
        const loginInput = page.locator('input#login_field, input[name="login"]').first();
        if (await loginInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  [GitHub Login] Login form visible. Submitting credentials...');
          await fillHuman(page, loginInput, email);
          await sleep(500);
          const pwdInput = page.locator('input#password, input[name="password"]').first();
          await fillHuman(page, pwdInput, githubPassword);
          await sleep(500);
          const signInBtn = page.locator('input[type="submit"], input[value="Sign in"], button[type="submit"]').first();
          await signInBtn.click();
          await sleep(4000);
          continue;
        }

        // 2. Check for Device OTP Verification
        const otpInput = page.locator('input#otp, input[name="otp"], input[placeholder*="code" i], input[id*="code"], input[name="app_otp"]').first();
        if (await otpInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          armStep('[3/8] Waiting for GitHub device verification OTP', 180000);
          console.log('  [GitHub Login] Device verification OTP requested. Waiting for email...');
          let otpCode = null;
          const isOutlook = email.toLowerCase().includes('@outlook.') || email.toLowerCase().includes('@hotmail.') || email.toLowerCase().includes('@live.');
          if (isOutlook) {
            otpCode = await waitForOtp({ mode: 'outlook', email, account: outlookAccount, timeout: 120000, since: Date.now() - 60000, subjectContains: 'GitHub' });
          } else {
            otpCode = await tempmail.waitForOtp(email, 120000, 5000, Date.now() - 60000);
          }
          if (!otpCode) {
            throw new Error('Failed to retrieve GitHub login verification OTP from email.');
          }
          console.log(`  [GitHub Login] Submitting OTP: ${otpCode}`);
          await otpInput.fill(otpCode);
          await sleep(500);
          const verifyBtn = page.locator('button:has-text("Verify"), button.btn-primary').first();
          if (await verifyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await verifyBtn.click().catch(() => {});
          } else {
            await otpInput.press('Enter').catch(() => {});
          }
          await sleep(5000);
          continue;
        }

        // 3. Check for OAuth Authorize Button (e.g. "Authorize basetenlabs", "Authorize", etc.)
        const authBtn = page.locator([
          'button.btn-primary:has-text("Authorize")',
          'button[value="1"]',
          'button:has-text("Authorize basetenlabs")',
          'button:has-text("Authorize baseten")',
          'button:has-text("Authorize")',
          'input[value*="Authorize" i]',
          'button#js-oauth-authorize-btn',
          'input#js-oauth-authorize-btn',
          '.js-oauth-authorize-btn'
        ].join(', ')).first();

        if (await authBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          const btnInfo = await authBtn.evaluate(el => ({
            text: (el.innerText || el.textContent || el.value || '').trim(),
            val: el.getAttribute('value') || '',
            name: el.getAttribute('name') || ''
          }));
          const isCancel = btnInfo.text.toLowerCase().includes('cancel') || btnInfo.val === '0';
          if (!isCancel && (btnInfo.text.toLowerCase().includes('authorize') || btnInfo.val === '1')) {
            console.log(`  [GitHub OAuth] Clicking Authorize button: "${btnInfo.text}" (val=${btnInfo.val})...`);
            await authBtn.click().catch(() => {});
            await sleep(5000);
            continue;
          }
        }

        // 4. If redirected to login.baseten.co and Continue with GitHub is visible
        if (currentUrl.includes('login.baseten.co') && !currentUrl.includes('sign-up')) {
          const reloginGh = page.locator('a[href*="GitHubOAuth"], a:has-text("Continue with GitHub"), button:has-text("Continue with GitHub")').first();
          if (await reloginGh.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('  [Baseten] Clicking Continue with GitHub on login page...');
            await reloginGh.click().catch(() => {});
            await sleep(4000);
            continue;
          }
        }

        await sleep(2000);
      }

      if (page.url().includes('github.com')) {
        const finalAuthBtn = page.locator('button:has-text("Authorize"), input[value*="Authorize" i]').first();
        if (await finalAuthBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('  [GitHub OAuth] Clicking final Authorize button...');
          await finalAuthBtn.click().catch(() => {});
          await sleep(5000);
        }
      }

      // Step 4: Handle Baseten Email Verification OTP (if redirected to email-verification)
      console.log('[4/8] Checking for Baseten email verification screen...');
      const isVerificationPage = await page.waitForURL(url => url.pathname.includes('email-verification'), { timeout: 10000 }).catch(() => null) ||
        page.url().includes('email-verification') ||
        (await page.locator('input[type="text"], input[inputmode="numeric"], input[maxlength="1"]').count().catch(() => 0)) >= 6;

      if (isVerificationPage || page.url().includes('email-verification')) {
        armStep('[4/8] Submitting Baseten Email Verification OTP', CONFIG.emailTimeout);
        console.log(`[4/8] Waiting for Baseten verification OTP on ${email}...`);

        const bOtpCode = await waitForBastenOtp({
          email,
          timeout: CONFIG.emailTimeout,
          since: Date.now() - 30000,
          tempmail,
          outlookAccount
        });

        if (!bOtpCode) {
          throw new Error('Verification OTP code not received/extracted for Baseten sign-up.');
        }
        console.log(`  Received Baseten OTP code: ${bOtpCode}`);

        console.log('  Filling Baseten 6-digit OTP code...');
        await sleep(2000);

        const digitInputs = page.locator('input[type="text"], input[inputmode="numeric"], input[name*="code" i], input[maxlength="1"]');
        const count = await digitInputs.count().catch(() => 0);

        if (count >= 6) {
          const firstBox = digitInputs.first();
          await firstBox.focus().catch(() => {});
          for (const char of bOtpCode) {
            await page.keyboard.press(char);
            await sleep(50);
          }

          let filledAll = true;
          for (let i = 0; i < Math.min(count, bOtpCode.length); i++) {
            const val = await digitInputs.nth(i).inputValue().catch(() => '');
            if (!val) {
              filledAll = false;
              break;
            }
          }

          if (!filledAll) {
            for (let i = 0; i < Math.min(count, bOtpCode.length); i++) {
              await digitInputs.nth(i).fill(bOtpCode[i]);
              await sleep(50);
            }
          }
        } else {
          const singleOtpInput = digitInputs.first();
          await singleOtpInput.waitFor({ state: 'visible', timeout: 15000 });
          await fillHuman(page, singleOtpInput, bOtpCode);
        }

        // Wait for page transition after OTP submission
        await Promise.race([
          page.waitForURL(url => !url.pathname.includes('email-verification'), { timeout: 10000 }).catch(() => null),
          page.waitForSelector('input[name="firstName"], input[placeholder*="Company" i], [data-cy="create-api-key-dialog"]', { timeout: 10000 }).catch(() => null),
        ]);
      }
    } else {
      // Step 3: Direct Email mode
      armStep('[3/8] Submitting email for verification', 60000);
      console.log('[3/8] Filling email...');
      const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="Your email address" i], input[placeholder*="email" i]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 20000 });
      await fillHuman(page, emailInput, email);
      await sleep(500);

      const submitBtn = page.locator('button[type="submit"], button:has-text("Continue")').first();
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await emailInput.press('Enter');
      }

      await Promise.race([
        page.waitForURL(url => url.pathname.includes('email-verification'), { timeout: 8000 }).catch(() => null),
        page.waitForSelector('input[inputmode="numeric"], input[maxlength="1"]', { timeout: 8000 }).catch(() => null),
      ]);

      if (await checkWaitingRoom(page)) {
        await page.screenshot({ path: path.join(__dirname, 'basten_waiting_room_error.png') }).catch(() => {});
        throw new Error('Baseten registration failed: Entered waiting room.');
      }

      // Step 4: Wait for verification OTP
      armStep('[4/8] Waiting for verification email OTP', CONFIG.emailTimeout);
      console.log('[4/8] Waiting for verification OTP code...');

      const otpCode = await waitForBastenOtp({
        email,
        timeout: CONFIG.emailTimeout,
        since: Date.now() - 30000,
        tempmail,
        outlookAccount
      });

      if (!otpCode) {
        throw new Error('Verification OTP code not received/extracted for Baseten sign-up.');
      }
      console.log(`  Received OTP code: ${otpCode}`);

      // Step 5: Input OTP code
      armStep('[5/8] Submitting OTP code', 60000);
      console.log('[5/8] Filling OTP code...');
      
      const digitInputs = page.locator('input[type="text"], input[inputmode="numeric"], input[name*="code" i], input[maxlength="1"]');
      const count = await digitInputs.count().catch(() => 0);

      if (count >= 6) {
        console.log(`  Filling ${otpCode.length} digits into separate input boxes...`);
        const firstBox = digitInputs.first();
        await firstBox.focus().catch(() => {});
        for (const char of otpCode) {
          await page.keyboard.press(char);
          await sleep(50);
        }
        
        let filledAll = true;
        for (let i = 0; i < Math.min(count, otpCode.length); i++) {
          const val = await digitInputs.nth(i).inputValue().catch(() => '');
          if (!val) {
            filledAll = false;
            break;
          }
        }
        
        if (!filledAll) {
          console.log('  Some input boxes empty. Refilling individually...');
          for (let i = 0; i < Math.min(count, otpCode.length); i++) {
            await digitInputs.nth(i).fill(otpCode[i]);
            await sleep(50);
          }
        }
      } else {
        const singleOtpInput = digitInputs.first();
        await singleOtpInput.waitFor({ state: 'visible', timeout: 15000 });
        await fillHuman(page, singleOtpInput, otpCode);
      }

      await Promise.race([
        page.waitForURL(url => !url.pathname.includes('email-verification'), { timeout: 10000 }).catch(() => null),
        page.waitForSelector('input[name="firstName"], input[placeholder*="Company" i], [data-cy="create-api-key-dialog"]', { timeout: 10000 }).catch(() => null),
      ]);
    }

    // Check for waiting room
    if (await checkWaitingRoom(page)) {
      await page.screenshot({ path: path.join(__dirname, 'basten_waiting_room_error.png') }).catch(() => {});
      throw new Error('Baseten registration failed: Entered waiting room.');
    }

    // Step 6 & 7: Complete Profile & Workspace Onboarding Wizard
    armStep('[6/8] Completing user profile & workspace onboarding', 90000);
    const wsName = `${lastName} Tech`;
    await handleBasetenOnboarding(page, firstName, lastName, wsName, 45000);

    // Check again for waiting room
    if (await checkWaitingRoom(page)) {
      await page.screenshot({ path: path.join(__dirname, 'basten_waiting_room_error.png') }).catch(() => {});
      throw new Error('Baseten registration failed: Entered waiting room.');
    }

    // Step 8: Create API Key
    armStep('[8/8] Generating API Key', 90000);
    console.log('[8/8] Navigating to settings/api_keys page...');
    
    await page.goto('https://app.baseten.co/settings/api_keys', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(async () => {
      await page.goto('https://app.baseten.co/settings/api_keys', { waitUntil: 'load', timeout: 45000 });
    });
    await sleep(2000);

    await handleCookies(page);
    await handleTurnstile(page, 5000);

    // Immediate check for Waiting Room / Approval gate on settings page
    if (await checkWaitingRoom(page)) {
      const dbgPath = path.join(__dirname, 'basten_waiting_room_error.png');
      await page.screenshot({ path: dbgPath }).catch(() => {});
      throw new Error('Baseten registration failed: Entered waiting room.');
    }

    // If still in onboarding / approval flow, handle it
    const bodyNow = await page.innerText('body').catch(() => '');
    if (page.url().includes('onboarding') || bodyNow.includes('approve your account') || bodyNow.includes('Company name')) {
      console.log('  [Baseten] Onboarding / approval screen active. Completing steps...');
      await handleBasetenOnboarding(page, firstName, lastName, wsName, 30000);
      if (!page.url().includes('settings/api_keys')) {
        await page.goto('https://app.baseten.co/settings/api_keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }
    }

    // Check again for waiting room
    if (await checkWaitingRoom(page)) {
      const dbgPath = path.join(__dirname, 'basten_waiting_room_error.png');
      await page.screenshot({ path: dbgPath }).catch(() => {});
      throw new Error('Baseten registration failed: Entered waiting room.');
    }

    console.log('  Locating Create API Key button...');
    const createKeyBtn = page.locator([
      'button[data-cy="create-api-key-dialog"]',
      'button:has-text("Create API key")',
      'button:has-text("Create API Key")',
      'button:has-text("New API Key")',
      'button:has-text("New API key")',
      'button:has-text("Create key")',
      'button:has-text("Create Key")',
      'button:has-text("Generate API key")',
      'button:has-text("Create new key")'
    ].join(', ')).first();

    await createKeyBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(async (err) => {
      const errShot = path.join(__dirname, 'basten_error.png');
      await page.screenshot({ path: errShot }).catch(() => {});
      console.log(`  [DEBUG] Saved step 8 screenshot to: ${errShot} (URL: ${page.url()})`);
      throw err;
    });

    console.log('  Clicking Create API Key button...');
    await createKeyBtn.click({ force: true }).catch(() => {});
    await sleep(500);

    const keyNameInput = page.locator('.MuiDialog-root input, input[placeholder*="production-api-key" i], input[placeholder*="api-key" i], [role="dialog"] input, div[role="dialog"] input').first();
    const isModalOpen = await keyNameInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (!isModalOpen) {
      await createKeyBtn.evaluate(el => el.click()).catch(() => {});
      await sleep(1000);
    }

    console.log('  Filling key name in modal dialog...');
    await keyNameInput.waitFor({ state: 'visible', timeout: 15000 });
    const keyName = `auto-${Date.now().toString(36)}`;
    await fillHuman(page, keyNameInput, keyName);
    await sleep(300);

    console.log('  Submitting Create API Key modal form...');
    const modalSubmitBtn = page.locator([
      '.MuiDialog-root button:has-text("Create API key")',
      '.MuiDialog-root button:has-text("Create key")',
      '.MuiDialog-root button:has-text("Create")',
      '.MuiDialog-root button[type="submit"]',
      '[role="dialog"] button:has-text("Create API key")',
      '[role="dialog"] button:has-text("Create key")',
      '[role="dialog"] button:has-text("Create")',
      '[role="dialog"] button[type="submit"]'
    ].join(', ')).first();

    if (await modalSubmitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await modalSubmitBtn.click().catch(() => {});
    } else {
      await keyNameInput.press('Enter').catch(() => {});
    }
    await sleep(1500);

    // Extract API Key
    console.log('  Extracting API Key...');
    let apiKey = '';
    const keyPattern = /\b([A-Za-z0-9_-]{4,20}\.[A-Za-z0-9_-]{20,80})\b/;

    const startKeyWait = Date.now();
    while (Date.now() - startKeyWait < 25000) {
      apiKey = await page.evaluate((patternStr) => {
        const regex = new RegExp(patternStr);
        
        // A. Inputs & readonly textboxes
        const inputs = Array.from(document.querySelectorAll('input, textarea'));
        for (const inp of inputs) {
          const val = inp.value || '';
          const m = val.match(regex);
          if (m) return m[1];
        }

        // B. Code & pre blocks inside modal or page
        const codes = Array.from(document.querySelectorAll('code, pre, [data-cy*="key"], [role="dialog"] p, [role="dialog"] div, .MuiDialog-root p, .MuiDialog-root div'));
        for (const el of codes) {
          const txt = (el.innerText || el.textContent || '').trim();
          const m = txt.match(regex);
          if (m) return m[1];
        }

        // C. Whole page text fallback
        const bodyTxt = document.body ? document.body.innerText : '';
        const bodyMatch = bodyTxt.match(regex);
        if (bodyMatch) return bodyMatch[1];

        return null;
      }, keyPattern.source).catch(() => null);

      if (apiKey) {
        console.log(`  Extracted API Key: ${apiKey}`);
        break;
      }

      await sleep(1000);
    }

    if (!apiKey) {
      const debugScreenshotPath = path.join(__dirname, 'basten_key_extraction_failed.png');
      await page.screenshot({ path: debugScreenshotPath });
      console.log(`  [WARN] Failed to automatically extract API Key. Saved debug screenshot to: ${debugScreenshotPath}`);
      throw new Error('Baseten API Key extraction failed.');
    }

    // Step 9: Save output
    console.log('Saving output to basten.csv...');

    const headers = 'timestamp,email,password,workspace_name,api_key';
    const row = [
      new Date().toISOString(),
      email,
      CONFIG.password,
      wsName,
      apiKey,
    ].map(v => csvCell(v)).join(',');

    const fileExists = fs.existsSync(CONFIG.outputFile);
    if (!fileExists) {
      fs.writeFileSync(CONFIG.outputFile, headers + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, row + '\n', 'utf8');
    console.log(`✅ Successfully saved account record to ${CONFIG.outputFile}`);

    console.log('\n========================================');
    console.log('  BASETEN REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Mode:           ${isGithubMode ? 'GitHub OAuth' : isOutlookMode ? 'Outlook/Hotmail' : 'Direct Email'}`);
    console.log(`  Email:          ${email}`);
    console.log(`  Password:       ${CONFIG.password}`);
    console.log(`  Workspace Name: ${wsName}`);
    console.log(`  API Key:        ${apiKey}`);
    console.log(`  Output:         ${CONFIG.outputFile}`);
    console.log('========================================\n');

    return { email, apiKey, wsName };

  } catch (err) {
    clearTimeout(stepTimer);
    console.error('ERROR in Baseten registration flow:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    const errPath = path.join(__dirname, 'basten_error.png');
    if (page) {
      await page.screenshot({ path: errPath }).catch(() => {});
      console.log(`  Saved error screenshot to: ${errPath}`);
    }
    throw err;
  } finally {
    clearTimeout(stepTimer);
    if (browser) {
      console.log('Closing browser...');
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  register().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { register, CONFIG };
