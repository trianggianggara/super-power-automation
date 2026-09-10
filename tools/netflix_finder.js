const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium, firefox } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { sleep, handleCookies, fillHuman, humanMouseMove, humanScroll, rand } = require('../utils/helpers.js');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

function decodeQuotedPrintable(str) {
  if (!str) return '';
  let decoded = str.replace(/=\r?\n/g, '');
  decoded = decoded.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return decoded;
}

// Register stealth plugin for chromium-based browsers
chromium.use(StealthPlugin);

const defaultChromiumPath = process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium';

const BROWSERS = [
  {
    name: 'Chromium-1',
    path: process.env.NETFLIX_BROWSER_1_PATH || defaultChromiumPath,
    type: 'chromium'
  },
  {
    name: 'Chromium-2',
    path: process.env.NETFLIX_BROWSER_2_PATH || defaultChromiumPath,
    type: 'chromium'
  }
];

let globalFound = false;
const activeBrowsers = new Map();

function getRandomProxy() {
  const proxyEnv = process.env.PROXY || '';
  const list = proxyEnv.split(',').map(p => p.trim()).filter(Boolean);
  if (list.length === 0) return null;
  const proxyStr = list[Math.floor(Math.random() * list.length)];
  try {
    const url = new URL(proxyStr);
    return {
      server: `${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    };
  } catch (e) {
    console.error('[System] Error parsing proxy:', e.message);
    return null;
  }
}

async function ensureChromeRunning(executablePath, port, tempProfileDir) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      return true;
    }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ];

    const chromeProcess = spawn(executablePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (res && res.ok) {
        return true;
      }
    }
    throw new Error(`Timeout waiting for browser remote debugging port ${port} to respond.`);
  } catch (err) {
    throw err;
  }
}

async function closeBrowser(name, browser, dynamicPort, tempProfileDir) {
  if (browser) {
    await browser.close().catch(() => { });
  }
  if (dynamicPort) {
    try {
      execSync(`fuser -k ${dynamicPort}/tcp`, { stdio: 'ignore' });
    } catch (_) { }
  }
  if (tempProfileDir) {
    try {
      if (fs.existsSync(tempProfileDir)) {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      }
    } catch (_) { }
  }
}

async function runBrowserLoop(browserConf) {
  const { name, path: execPath, type } = browserConf;
  let iteration = 0;

  while (!globalFound) {
    iteration++;
    console.log(`[${name}] 🔄 Iteration #${iteration}: Launching fresh browser...`);

    let browser;
    let context;
    let page;
    let tempProfileDir = '';
    let dynamicPortUsed = null;

    try {
      const isFirefox = type === 'firefox';
      const proxyConfig = getRandomProxy();

      if (isFirefox) {
        const launchOpts = {
          executablePath: execPath,
          headless: false,
          args: ['--no-sandbox']
        };
        if (proxyConfig) {
          launchOpts.proxy = {
            server: `http://${proxyConfig.server}`,
            username: proxyConfig.username,
            password: proxyConfig.password
          };
          console.log(`[${name}] 🌐 Using Proxy: ${proxyConfig.server}`);
        }
        browser = await firefox.launch(launchOpts);
        context = await browser.newContext({
          viewport: null,
          locale: 'en-US',
          timezoneId: 'Asia/Jakarta',
          ignoreHTTPSErrors: true
        });
      } else {
        // Chromium-based browsers (Cloak, Brave)
        const launchOpts = {
          executablePath: execPath,
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--incognito',
            '--no-sandbox'
          ]
        };
        if (proxyConfig) {
          launchOpts.proxy = {
            server: `http://${proxyConfig.server}`,
            username: proxyConfig.username,
            password: proxyConfig.password
          };
          console.log(`[${name}] 🌐 Using Proxy: ${proxyConfig.server}`);
        }
        browser = await chromium.launch(launchOpts);
        context = await browser.newContext({
          viewport: { width: 1366, height: 768 },
          locale: 'en-US',
          timezoneId: 'Asia/Jakarta',
          ignoreHTTPSErrors: true
        });
      }

      // Track active browser so we can terminate it if another one succeeds
      activeBrowsers.set(name, { browser, dynamicPort: dynamicPortUsed, tempProfileDir, isSuccessful: false });

      // Inject robust anti-fingerprinting stealth script
      await context.addInitScript(() => {
        // 1. Remove webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;

        // 2. Fake plugins (realistic count)
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const plugins = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
            ];
            plugins.length = 3;
            return plugins;
          },
        });

        // 3. Fake languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en', 'id'],
        });

        // 4. Patch chrome runtime
        window.chrome = {
          runtime: {
            PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
            PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
            PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
            RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
            OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          },
        };

        // 5. Patch permissions
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (params) =>
          params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);

        // 6. WebGL fingerprint spoofing
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return 'Google Inc. (Intel)';
          if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
          return getParameter.call(this, param);
        };
      });

      const pages = context.pages();
      page = pages.length > 0 ? pages[0] : await context.newPage();

      // Network logger to diagnose blocks/failures
      const networkLogs = [];
      page.on('request', req => {
        networkLogs.push({
          type: 'request',
          timestamp: new Date().toISOString(),
          url: req.url(),
          method: req.method(),
          headers: req.headers(),
          postData: req.postData()
        });
      });
      page.on('response', async res => {
        const url = res.url();
        const status = res.status();
        const contentType = res.headers()['content-type'] || '';
        let body = '';
        if (contentType.includes('json') || url.includes('graphql') || url.includes('signup') || url.includes('api') || status >= 400) {
          try {
            body = await res.text();
          } catch (e) {
            body = '[Error reading response body: ' + e.message + ']';
          }
        }
        networkLogs.push({
          type: 'response',
          timestamp: new Date().toISOString(),
          url,
          status,
          headers: res.headers(),
          body: body ? body.substring(0, 2000) : ''
        });
      });

      console.log(`[${name}] 🌐 Navigating to Netflix...`);
      await page.goto('https://www.netflix.com/tr-en/', { waitUntil: 'domcontentloaded', timeout: 45000 });

      // Let page elements load
      await sleep(3500);

      // Handle cookie consent overlay if it shows up
      await handleCookies(page).catch(() => { });

      // Extract body text
      const bodyText = await page.innerText('body').catch(() => '');

      // Locate potential CTA elements and extract text
      let ctaText = '';
      const ctaSelectors = [
        '[data-uia="our-story-cta-hero"]',
        'button.btn-red',
        'button[type="submit"]',
        'a.btn-red',
        '.our-story-cta',
        'button:has-text("Try")',
        'button:has-text("Coba")',
        'a:has-text("Try")',
        'a:has-text("Coba")'
      ];

      for (const sel of ctaSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
            const txt = (await el.innerText().catch(() => '')).trim();
            if (txt) {
              ctaText = txt;
              break;
            }
          }
        } catch (e) {
          // Ignore locator errors
        }
      }

      console.log(`[${name}] 📝 Found CTA: "${ctaText || 'None'}"`);

      const combinedText = `${bodyText} ${ctaText}`;
      const has30Days = /30\s*(days?|hari)/i.test(combinedText);
      const has14Days = /14\s*(days?|hari)/i.test(combinedText);
      const has7Days = /7\s*(days?|hari)/i.test(combinedText);

      if (has30Days) {
        console.log(`\n🎉 🎉 [${name}] SUCCESS! FOUND "Try 30 Days" OFFER! 🎉 🎉`);
        console.log(`[${name}] Detected Text: "30 days"`);
        console.log(`[${name}] CTA Button text: "${ctaText}"`);

        // Simulate human reading behavior before typing to bypass behavioral analysis
        console.log(`[${name}] 🕵️ Simulating human reading behavior...`);
        await sleep(2000 + Math.random() * 2000);
        await humanMouseMove(page).catch(() => { });
        await sleep(1000);
        await humanScroll(page).catch(() => { });
        await sleep(1500);

        // Generate random email using TEMPMAIL_WEBHOOK_DOMAIN (no plus-trick)
        const domainsEnv = process.env.TEMPMAIL_WEBHOOK_DOMAIN;
        if (!domainsEnv) {
          throw new Error('Missing TEMPMAIL_WEBHOOK_DOMAIN env for Netflix email generation.');
        }
        const domainsList = domainsEnv.split(',').map(d => d.trim()).filter(Boolean);
        if (domainsList.length === 0) {
          throw new Error('TEMPMAIL_WEBHOOK_DOMAIN is empty.');
        }
        const chosenDomain = domainsList[Math.floor(Math.random() * domainsList.length)];
        const localPart = `user_${crypto.randomBytes(4).toString('hex')}`;
        const email = `${localPart}@${chosenDomain}`;
        console.log(`[${name}] 📧 Generated Webhook Email (No plus-trick): ${email}`);

        // Locate email input field
        let emailInput = null;
        const emailSelectors = [
          'input[type="email"]',
          'input[name="email"]',
          'input[placeholder*="Email" i]',
          '#id_email_hero_num2'
        ];

        for (const sel of emailSelectors) {
          try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
              emailInput = el;
              break;
            }
          } catch (e) { }
        }

        if (emailInput) {
          console.log(`[${name}] ✍️ Typing email address (mimicking human keys)...`);
          await emailInput.click({ force: true });
          await sleep(rand(400, 800));

          // Clear input first with Ctrl+A and Backspace
          await page.keyboard.press('Control+A');
          await sleep(rand(100, 200));
          await page.keyboard.press('Backspace');
          await sleep(rand(300, 600));

          // Type character by character (faster)
          for (const char of email) {
            await page.keyboard.type(char, { delay: rand(15, 35) });
          }
          await sleep(1000);

          // Locate the CTA button
          let ctaBtn = null;
          const buttonSelectors = [
            '[data-uia="our-story-cta-hero"]',
            'button.btn-red',
            'button[type="submit"]',
            'a.btn-red',
            '.our-story-cta',
            'button:has-text("Try")',
            'button:has-text("Coba")',
            'a:has-text("Try")',
            'a:has-text("Coba")'
          ];

          for (const sel of buttonSelectors) {
            try {
              const el = page.locator(sel).first();
              if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
                ctaBtn = el;
                break;
              }
            } catch (e) { }
          }

          if (ctaBtn) {
            try {
              const maxAttempts = 1;
              let attempts = 0;
              let errorText = null;

              while (attempts < maxAttempts) {
                attempts++;

                // Check if email input got cleared and refill it
                let emailInput = page.locator('input[type="email"], input[name="email"], input[name="userLoginId"]').first();
                if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
                  const currentVal = await emailInput.inputValue().catch(() => '');
                  if (!currentVal) {
                    console.log(`[${name}] ✍️ Email input was cleared. Refilling...`);
                    await emailInput.fill(email);
                    await sleep(1000);
                  }
                }

                console.log(`[${name}] 🖱️ Clicking CTA button (Attempt ${attempts}/${maxAttempts})...`);
                await ctaBtn.click();
                await sleep(8000); // Wait for transition and API responses to complete

                // Check if error message is on page (excluding create a password links which indicate signup page)
                errorText = await page.evaluate(() => {
                  const text = document.body.innerText || '';
                  // If it contains "create a password" / "buat sandi", this is actually a valid signup funnel step!
                  if (text.includes('create a password') || text.includes('Create a password') || text.includes('buat sandi') || text.includes('Buat sandi')) {
                    return null;
                  }
                  if (text.includes('Something went wrong') ||
                    text.includes('try again in a few minutes') ||
                    text.includes('terjadi kesalahan') ||
                    text.includes('coba lagi')) {
                    return text;
                  }
                  return null;
                });

                if (!errorText) {
                  console.log(`[${name}] 🎉 Successfully navigated past email setup after ${attempts} attempts.`);
                  break;
                }

                console.log(`[${name}] ⚠️ Error detected: "${errorText.substring(0, 100).replace(/\n/g, ' ')}". Retrying...`);
                await sleep(3000);
              }

              if (errorText) {
                throw new Error(`Error page on email submit after ${maxAttempts} attempts: ${errorText.substring(0, 200).replace(/\n/g, ' ')}`);
              }

              // --- WAIT FOR PAGE STABILIZATION & DETECT SIGNUP SETUP SCREEN ---
              console.log(`[${name}] Determining next step (checking for signup / create password instead screen)...`);
              await sleep(5000);

              const isSignupPage = await page.evaluate(() => {
                const text = document.body.innerText || '';
                return text.includes('Create password instead') ||
                  text.includes('Buat sandi sebagai gantinya') ||
                  text.includes('Finish setting up your account') ||
                  text.includes('Selesaikan pengaturan akun') ||
                  text.includes('Send Link') ||
                  text.includes('Kirim Link') ||
                  text.includes('Step 1 of') ||
                  text.includes('Langkah 1 dari') ||
                  text.includes('Create a password') ||
                  text.includes('Buat sandi');
              });

              if (isSignupPage) {
                console.log(`\n🎉 🎉 [${name}] SUCCESS! REACHED SIGNUP SETUP PAGE! 🎉 🎉`);

                // Mark this browser as successful/valid so other threads don't close it
                const currentInfo = activeBrowsers.get(name);
                if (currentInfo) {
                  currentInfo.isSuccessful = true;
                  activeBrowsers.set(name, currentInfo);
                }

                let clickedCreatePassword = false;

                // 1. Check if the "create a password" link (like in the orange error banner) is already visible
                let regformLink = page.locator('a[href*="/signup/regform"], a:has-text("create a password"), a:has-text("Create password"), a:has-text("buat sandi"), a:has-text("Buat sandi")').first();
                if (await regformLink.isVisible({ timeout: 3000 }).catch(() => false)) {
                  console.log(`[${name}] 🖱️ Orange error banner / regform link is visible. Clicking "create a password" directly...`);
                  await regformLink.click({ force: true });
                  clickedCreatePassword = true;
                  await sleep(4000);
                } else {
                  // Locate terms / offers consent checkbox (checklist checkboxnya)
                  let consentCheckbox = page.locator('#chkbox-id, input[id="chkbox-id"], input[type="checkbox"]').first();
                  if (await consentCheckbox.isVisible({ timeout: 5000 }).catch(() => false) ||
                    (await consentCheckbox.count() > 0)) {
                    console.log(`[${name}] ✍️ Checking consent checkbox (forcing if styled-hidden)...`);
                    await consentCheckbox.check({ force: true }).catch(() => { });
                    await sleep(1000);
                  }

                  // Locate and click "Send Link" / "Send Email"
                  let sendLinkBtn = page.locator('button:has-text("Send Link"), button:has-text("Kirim Link"), button:has-text("Send Email"), button:has-text("Kirim Email"), button:has-text("Send email"), button:has-text("Kirim email"), button[type="submit"]').first();
                  if (await sendLinkBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
                    console.log(`[${name}] 🖱️ Clicking Send Link / Send Email button...`);
                    await sendLinkBtn.click();
                  }

                  // Wait and poll for the error banner to appear
                  console.log(`[${name}] ⏳ Waiting up to 10 seconds for orange error banner...`);
                  for (let i = 0; i < 10; i++) {
                    await sleep(1000);
                    if (await regformLink.isVisible().catch(() => false)) {
                      console.log(`[${name}] 🖱️ Orange error banner appeared. Clicking "create a password" now...`);
                      await regformLink.click({ force: true });
                      clickedCreatePassword = true;
                      await sleep(4000);
                      break;
                    }
                  }
                }

                // 2. If we haven't clicked yet, check if we need to click "Create Password Instead" or the regform link
                if (!clickedCreatePassword) {
                  let createPassBtn = page.locator('a[href*="/signup/regform"], a:has-text("create a password"), a:has-text("Create password"), button:has-text("Create Password Instead"), button:has-text("Create password instead"), button:has-text("Buat sandi sebagai gantinya"), a:has-text("Create Password Instead"), a:has-text("Create password instead"), a:has-text("Buat sandi sebagai gantinya")').first();

                  if (await createPassBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                    console.log(`[${name}] 🖱️ Clicking "Create Password Instead" / regform link...`);
                    await createPassBtn.click({ force: true });
                    await sleep(4000);
                  }
                }

                // Wait for password input field to appear. Use waitFor to throw error if it fails to appear.
                let passInput = page.locator('input[type="password"], input[name="password"]').first();
                console.log(`[${name}] ⏳ Waiting for password input field...`);
                await passInput.waitFor({ state: 'visible', timeout: 15000 });

                // Always generate a random password to comply with "password harus selalu random"
                const password = `NetflixPass${crypto.randomBytes(4).toString('hex')}!`;
                console.log(`[${name}] ✍️ Typing random password: ${password}`);
                await passInput.click({ force: true });
                await sleep(rand(300, 600));
                for (const char of password) {
                  await page.keyboard.type(char, { delay: rand(15, 35) });
                }
                await sleep(1000);

                let nextBtn = page.locator('button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Berikutnya")').first();
                if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                  console.log(`[${name}] 🖱️ Clicking Next/Continue button...`);
                  await nextBtn.click({ force: true });

                  // --- SAVE TO netflix.csv IMMEDIATELY AFTER PASSWORD SUBMISSION ---
                  console.log(`[${name}] 💾 Saving account credentials to netflix.csv...`);
                  const csvLine = `"${email}","${password}"\n`;
                  fs.appendFileSync(path.join(__dirname, '..', 'data', 'netflix.csv'), csvLine, 'utf8');
                  console.log(`[${name}] 💾 Appended ${email} to netflix.csv.`);

                  await sleep(8000);

                  // --- CHOOSE YOUR PLAN (SCREEN 1) ---
                  console.log(`[${name}] 📋 Waiting for "Choose your plan" page...`);
                  let planNextBtn = page.locator('[data-uia="continue-button"], button:has-text("Next"), button:has-text("Berikutnya"), button[type="submit"]').first();
                  try {
                    await planNextBtn.waitFor({ state: 'visible', timeout: 15000 });
                    console.log(`[${name}] 🖱️ Clicking Next on Choose your plan screen...`);
                    await planNextBtn.click({ force: true });
                  } catch (e) {
                    console.log(`[${name}] ⚠️ Choose your plan button wait timed out or failed: ${e.message}`);
                  }
                  await sleep(5000);

                  // --- PLAN SELECTION TABLE (SCREEN 2) ---
                  console.log(`[${name}] 📋 Waiting for plan selection table page...`);
                  let planTableNextBtn = page.locator('[data-uia="continue-button"], button:has-text("Next"), button:has-text("Berikutnya"), button[type="submit"]').first();
                  try {
                    await planTableNextBtn.waitFor({ state: 'visible', timeout: 15000 });
                    console.log(`[${name}] 🖱️ Clicking Next on plan table selection screen...`);
                    await planTableNextBtn.click({ force: true });
                  } catch (e) {
                    console.log(`[${name}] ⚠️ Plan table button wait timed out or failed: ${e.message}`);
                  }
                  await sleep(5000);

                  // --- CHOOSE HOW TO PAY (SCREEN 3) ---
                  console.log(`[${name}] 📋 Waiting for "Choose how to pay" page...`);
                  let walletBtn = page.locator('[data-uia="MOBILE_WALLET+PressableListItem"], [data-uia="payment-choice-WALLETS"], text=Digital Wallet, text=Dompet Digital').first();
                  try {
                    await walletBtn.waitFor({ state: 'visible', timeout: 15000 });
                    console.log(`[${name}] 🖱️ Clicking Digital Wallet...`);
                    await walletBtn.click({ force: true });
                  } catch (e) {
                    console.log(`[${name}] ⚠️ Digital Wallet button wait timed out or failed: ${e.message}`);
                  }
                  await sleep(5000);

                  // --- SELECT DANA WALLET ---
                  console.log(`[${name}] 📋 Waiting for "Set up your wallet" page...`);
                  let selectDropdown = page.locator('[data-uia="wallet-picker"], button:has-text("Select a wallet"), button:has-text("Pilih dompet"), [aria-haspopup="listbox"], select').first();
                  try {
                    await selectDropdown.waitFor({ state: 'visible', timeout: 15000 });
                    console.log(`[${name}] 🖱️ Clicking Select Wallet dropdown...`);
                    await selectDropdown.click({ force: true });
                  } catch (e) {
                    console.log(`[${name}] ⚠️ Select Wallet dropdown wait timed out or failed: ${e.message}`);
                  }
                  await sleep(2000);

                  // Now click the DANA option
                  let danaOption = page.locator('[data-uia="wallet-choice-DANA"], text=DANA').first();
                  try {
                    await danaOption.waitFor({ state: 'visible', timeout: 10000 });
                    console.log(`[${name}] 🖱️ Selecting DANA option...`);
                    await danaOption.click({ force: true });
                  } catch (e) {
                    console.log(`[${name}] ⚠️ DANA option wait timed out or failed: ${e.message}`);
                  }
                  await sleep(3000);

                  console.log(`[${name}] ✅ SUCCESS username=${email} password=${password}`);

                  globalFound = true; // Signal to other searching loops to stop launching new browsers

                  // Close remaining loops/browsers that are NOT successful (searching/inactive)
                  console.log(`[${name}] ⚠️ Closing other inactive/searching browsers...\n`);
                  for (const [otherName, bInfo] of activeBrowsers.entries()) {
                    if (otherName !== name && !bInfo.isSuccessful) {
                      console.log(`[${name}] Closing other browser: ${otherName}`);
                      await closeBrowser(otherName, bInfo.browser, bInfo.dynamicPort, bInfo.tempProfileDir).catch(() => { });
                    }
                  }

                  console.log(`[${name}] Keeping this window open for you to verify or interact. Waiting for window to be closed manually...`);
                  await page.waitForEvent('close', { timeout: 0 }).catch(() => { });
                  console.log(`[${name}] Browser window closed. Exiting thread...`);
                  return;
                } else {
                  throw new Error('Next/Continue button not visible after typing password');
                }
              } else {
                throw new Error(`Failed to reach signup page. Current URL: ${page.url()}`);
              }

            } catch (signupErr) {
              console.error(`[${name}] ❌ Error in signup funnel: ${signupErr.message}`);

              const screenshotPath = path.join(__dirname, `netflix_error_${name.toLowerCase()}_${Date.now()}.png`);
              await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
              console.log(`[${name}] 📸 Saved error UI screenshot to: ${screenshotPath}`);

              const logPath = path.join(__dirname, `netflix_network_${name.toLowerCase()}_${Date.now()}.json`);
              fs.writeFileSync(logPath, JSON.stringify(networkLogs, null, 2), 'utf8');
              console.log(`[${name}] 💾 Saved network logs to: ${logPath}`);

              // Clean up this browser instance
              console.log(`[${name}] 🧹 Cleaning up this browser instance...`);
              await closeBrowser(name, browser, dynamicPortUsed, tempProfileDir).catch(() => { });
              activeBrowsers.delete(name);

              if (globalFound) {
                console.log(`[${name}] Another browser succeeded. Terminating this thread.`);
                return;
              }

              await sleep(5000); // Wait before retrying
              continue;
            }
          } else {
            console.error(`[${name}] ❌ Could not find CTA button to click.`);
            await closeBrowser(name, browser, dynamicPortUsed, tempProfileDir).catch(() => { });
            activeBrowsers.delete(name);
            if (globalFound) return;
            continue;
          }
        } else {
          console.error(`[${name}] ❌ Could not find email input field.`);
          await closeBrowser(name, browser, dynamicPortUsed, tempProfileDir).catch(() => { });
          activeBrowsers.delete(name);
          if (globalFound) return;
          continue;
        }

        console.log(`[${name}] Keeping this browser window open. Terminating other browsers...\n`);

        // Close other running browsers
        for (const [otherName, bInfo] of activeBrowsers.entries()) {
          if (otherName !== name) {
            console.log(`[${name}] Closing other browser: ${otherName}`);
            await closeBrowser(otherName, bInfo.browser, bInfo.dynamicPort, bInfo.tempProfileDir);
          }
        }

        // Keep this browser process open
        console.log(`[${name}] Waiting for browser window to be closed manually by user...`);
        await page.waitForEvent('close', { timeout: 0 }).catch(() => { });
        console.log(`[${name}] Browser window closed. Exiting script...`);
        process.exit(0);
      } else {
        if (has14Days) {
          console.log(`[${name}] ❌ Detected 14-day offer. Closing and retrying...`);
        } else if (has7Days) {
          console.log(`[${name}] ❌ Detected 7-day offer. Closing and retrying...`);
        } else {
          console.log(`[${name}] ❌ No 30-day trial offer detected. Closing and retrying...`);
        }

        await closeBrowser(name, browser, dynamicPortUsed, tempProfileDir);
        activeBrowsers.delete(name);
        // Wait a short delay before restarting this thread to avoid CPU thrashing
        await sleep(2000);
      }

    } catch (err) {
      console.error(`[${name}] ⚠️ Error: ${err.message}`);
      if (browser) {
        await closeBrowser(name, browser, dynamicPortUsed, tempProfileDir);
        activeBrowsers.delete(name);
      }
      await sleep(5000); // Backoff on error
    }
  }
}

// Handle termination signal cleanly
process.on('SIGINT', async () => {
  console.log('\n[System] SIGINT received. Cleaning up and exiting...');
  for (const [name, bInfo] of activeBrowsers.entries()) {
    console.log(`[System] Closing browser: ${name}`);
    await closeBrowser(name, bInfo.browser, bInfo.dynamicPort, bInfo.tempProfileDir);
  }
  process.exit(0);
});

// Run all browsers in parallel
(async () => {
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
  console.log('========================================================');
  console.log('🚀 Starting Netflix "Try 30 Days" Finder');
  console.log(`   Running ${CONCURRENCY} browser instances in parallel...`);
  console.log('========================================================\n');

  const runners = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const baseConf = BROWSERS[i % BROWSERS.length];
    runners.push({
      ...baseConf,
      name: `${baseConf.name}-${i + 1}`
    });
  }

  // Spawn loops in parallel
  const promises = runners.map(browserConf => runBrowserLoop(browserConf));
  await Promise.all(promises);
})();
