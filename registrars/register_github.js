// GitHub Auto-Registration Script using Playwright
const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const TempMail = require('../services/tempmail/tempmail.js');
const { resolveEmail, waitForOtp } = require('../utils/email.js');
const { isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure, setupNetworkOptimization } = require('../utils/browser.js');
const { sleep, rand, fillHuman, handleCookies } = require('../utils/helpers.js');
const { solveArkoseDragCaptcha } = require('../utils/captcha_solver.js');

const CONFIG = {
  signupUrl: 'https://github.com/signup/free',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'github_accounts.csv'),
  otpTimeout: 180000,
  // GitHub registrar secara default memakai CloakBrowser; bisa di-override via env
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || 'cloakbrowser'),
  vpnCountry: process.env.VPN_COUNTRY || '',
  vpnProvider: (process.env.VPN_PROVIDER || 'urban').toLowerCase().trim(),
};


const { spawn } = require('child_process');

async function ensureChromeRunning(executablePath = '/usr/bin/google-chrome-stable', port = 9222, proxy = null) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log(`Google Chrome with Remote Debugging is already running on port ${port}.`);
      return true;
    }

    console.log(`Spawning Google Chrome Stable Incognito on port ${port}...`);

    const tempProfileDir = `/tmp/chrome-debug-profile-github-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080',
      '--start-maximized',
    ];

    if (proxy && proxy.server) {
      args.push(`--proxy-server=${proxy.server}`);
    }

    const chromeProcess = spawn(executablePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (res && res.ok) {
        console.log('Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Google Chrome remote debugging port ${port} to respond.`);
  } catch (err) {
    console.error(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function connectVPN(page, country) {
  console.log(`Connecting to Urban VPN with country: ${country}...`);
  await page.goto('chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/popup/index.html');
  await sleep(4000);

  // 1. Wait for consent page accept button and click it
  const acceptBtn = page.locator('button.base-button--primary').first();
  try {
    await acceptBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Consent page visible. Clicking Accept...');
    await acceptBtn.click();
    await sleep(4000);
  } catch (e) {
    console.log('Consent page not visible or already accepted:', e.message);
  }

  // 2. Check for Registration error / Retry button
  const retryBtn = page.locator('button.base-button--primary').first();
  const bodyText = await page.innerText('body').catch(() => '');
  if (bodyText.includes('Registration error') || bodyText.includes('Retry')) {
    console.log('Registration error detected. Clicking Retry...');
    await retryBtn.click();
    await sleep(5000);
  }

  // 3. Wait for main page location view
  console.log('Waiting for main page to load...');
  const locView = page.locator('.location-view').first();
  await locView.waitFor({ state: 'visible', timeout: 25000 });

  // Check if we are already connected to the target country
  const currentCountryText = await locView.innerText().catch(() => '');
  console.log(`Current selected country: ${currentCountryText.trim()}`);

  const isConnected = await page.locator('.timer').isVisible().catch(() => false);
  const isPlayButtonVisible = await page.locator('.play-button').isVisible().catch(() => false);

  if (currentCountryText.toLowerCase().includes(country.toLowerCase()) && isConnected && !isPlayButtonVisible) {
    console.log(`Already connected to ${country}.`);
    return true;
  }

  // If connected to a different country, disconnect first
  if (isConnected && !isPlayButtonVisible) {
    console.log('Connected to another country. Clicking disconnect (play button to stop)...');
    const disconnectBtn = page.locator('button.play-button, .play-button').first();
    await disconnectBtn.click();
    await sleep(3000);
  }

  // 4. Click to open location dropdown
  console.log('Opening location list dropdown...');
  await locView.click();
  await sleep(2000);

  // 5. Search for the country
  console.log(`Searching for '${country}'...`);
  // Target only the visible input inside location list
  const searchInput = page.locator('.location-selector-wrapper input[placeholder*="Search" i], input[placeholder*="Search" i]').first();
  await searchInput.waitFor({ state: 'visible', timeout: 8000 });
  await searchInput.focus();
  await searchInput.fill('');
  await sleep(500);
  await searchInput.fill(country);
  await sleep(2000);

  // 6. Click the country item
  console.log(`Selecting '${country}' from results...`);
  const selected = await page.evaluate((c) => {
    // Find item matching country in the dropdown
    const listItems = Array.from(document.querySelectorAll('.location-selector-wrapper div, .location-selector-wrapper span, .location-selector-wrapper li'));
    const matched = listItems.find(el => (el.textContent || '').trim().toLowerCase() === c.toLowerCase() && el.offsetParent !== null);
    if (matched) {
      matched.click();
      return true;
    }
    return false;
  }, country);

  console.log('Selected country via evaluate:', selected);
  if (!selected) {
    console.log(`Direct JS click failed, attempting Playwright text click...`);
    const countryRow = page.locator(`.location-selector-wrapper div:has-text("${country}"), .location-selector-wrapper span:has-text("${country}")`).filter({ visible: true }).first();
    await countryRow.click({ force: true });
  }
  await sleep(3000);

  // 7. Click Connect / Play button
  console.log('Clicking Connect button...');
  const playBtn = page.locator('button.play-button, .play-button').first();
  await playBtn.waitFor({ state: 'visible', timeout: 5000 });

  // Only click if we are not already connected
  const isTimerCurrentlyVisible = await page.locator('.timer').isVisible().catch(() => false);
  const connStateText = await page.locator('.connection-state').innerText().catch(() => '');
  const isAlreadyConn = isTimerCurrentlyVisible && connStateText.toLowerCase().includes('connected') && !connStateText.toLowerCase().includes('not');

  if (!isAlreadyConn) {
    await playBtn.click();
    console.log('  Play button clicked.');
  } else {
    console.log('  Already connected. Skipping play button click.');
  }

  // 8. Wait and verify connection status
  console.log('Waiting for VPN to connect...');
  const deadline = Date.now() + 15000;
  let connected = false;
  while (Date.now() < deadline) {
    const timerVisible = await page.locator('.timer').isVisible().catch(() => false);
    const connectionState = await page.locator('.connection-state').innerText().catch(() => '');
    if (timerVisible && connectionState.toLowerCase().includes('connected') && !connectionState.toLowerCase().includes('not')) {
      connected = true;
      break;
    }
    await sleep(1000);
  }

  if (connected) {
    console.log(`Successfully connected to ${country}!`);
    return true;
  } else {
    console.log(`Failed to connect to ${country}.`);
    return false;
  }
}

async function connectHideme(page, country) {
  console.log(`Connecting to hide.me VPN with country: ${country}...`);
  await page.goto('chrome-extension://ohjocgmpmlfahafbipehkhbaacoemojp/popup.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  const connectCheckbox = page.locator('#cmn-toggle-1');
  const isConnected = await connectCheckbox.isChecked().catch(() => false);

  if (isConnected) {
    console.log('  VPN already connected. Reconnecting for a fresh connection...');
    await page.evaluate(() => {
      const checkbox = document.querySelector('#cmn-toggle-1');
      if (checkbox && checkbox.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(3000);
  }

  console.log('  Opening server locations...');
  const selectServerBtn = page.locator('#row_select_server').first();
  await selectServerBtn.waitFor({ state: 'visible', timeout: 10000 });
  await selectServerBtn.click();
  await sleep(3000);

  const serverList = page.locator('.servers_list ul');
  await serverList.waitFor({ state: 'visible', timeout: 15000 });
  await sleep(2000);

  const listItems = page.locator('.servers_list ul li');
  const count = await listItems.count().catch(() => 0);
  console.log(`  Found ${count} server location(s) in list.`);

  let clickedServer = await page.evaluate((c) => {
    const items = Array.from(document.querySelectorAll('.servers_list ul li'));
    const matched = items.find(el => {
      const name = (el.getAttribute('name') || '').toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      return name === c.toLowerCase() || name.replace(/_/g, ' ') === c.toLowerCase() || text === c.toLowerCase() || text.includes(c.toLowerCase());
    });
    if (matched) {
      const opts = { bubbles: true, cancelable: true, view: window };
      matched.dispatchEvent(new MouseEvent('mousedown', opts));
      matched.dispatchEvent(new MouseEvent('mouseup', opts));
      matched.click();
      matched.dispatchEvent(new MouseEvent('click', opts));
      return true;
    }
    return false;
  }, country);

  if (!clickedServer) {
    const targetRow = page.locator(`.servers_list li[name="${country.toLowerCase().replace(/ /g, '_')}"], .servers_list li:has-text("${country}")`).first();
    if (await targetRow.isVisible().catch(() => false)) {
      await targetRow.click({ force: true });
      clickedServer = true;
    }
  }

  if (!clickedServer && count > 0) {
    console.log(`  Target country '${country}' not found/clickable. Clicking first available server...`);
    await listItems.first().click({ force: true });
  }

  await sleep(3000);

  console.log('  Clicking Connect...');
  const connectionStatus = page.locator('.connection_status');
  await connectionStatus.waitFor({ state: 'visible', timeout: 10000 });

  const currentChecked = await connectCheckbox.isChecked().catch(() => false);
  if (!currentChecked) {
    await page.evaluate(() => {
      const checkbox = document.querySelector('#cmn-toggle-1');
      if (checkbox && !checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    console.log('  Triggered VPN switch, waiting for Connected status...');
  }

  const deadline = Date.now() + 30000;
  let connected = false;
  while (Date.now() < deadline) {
    const text = await page.locator('.connection_status .indicator').innerText().catch(() => '');
    if (text.toLowerCase().includes('connected') && !text.toLowerCase().includes('not')) {
      connected = true;
      break;
    }
    await sleep(1000);
  }

  if (connected) {
    console.log(`Successfully connected hide.me to ${country}!`);
    return true;
  } else {
    console.log(`Failed to connect hide.me to ${country}.`);
    return false;
  }
}

function csvCell(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function saveAccountCredentials(email, username, proxy) {
  try {
    const csvPath = CONFIG.outputFile;
    const dir = path.dirname(csvPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const cleanEmail = email.toLowerCase().trim();
    if (fs.existsSync(csvPath)) {
      const content = fs.readFileSync(csvPath, 'utf8');
      if (content.toLowerCase().includes(cleanEmail)) {
        console.log(`  [CSV] Account ${email} is already in ${csvPath}`);
        return;
      }
    }
    const csvHeaders = 'timestamp,email,password,username,proxy\n';
    const csvRow = [new Date().toISOString(), email, CONFIG.password, username, proxy || 'direct'].map(csvCell).join(',') + '\n';
    if (!fs.existsSync(csvPath)) {
      fs.writeFileSync(csvPath, csvHeaders, 'utf8');
    }
    fs.appendFileSync(csvPath, csvRow, 'utf8');
    console.log(`\n  ✅ [CSV SUCCESS] Account credentials saved to ${csvPath}`);
    console.log('========================================');
    console.log('    GITHUB REGISTRATION SUCCESS');
    console.log('========================================');
    console.log(`  Username: ${username}`);
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${CONFIG.password}`);
    console.log('========================================\n');
  } catch (err) {
    console.error(`  [WARN] Failed to write account to CSV: ${err.message}`);
  }
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

  throw new Error("Failed to determine Gmail address. Please check GMAIL_USER or GMAIL_REFRESH_TOKEN.");
}

async function typeHumanDirect(locator, text) {
  try {
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.click({ force: true, timeout: 3000 });
  } catch (err) {
    await locator.focus().catch(() => { });
  }
  await sleep(rand(150, 300));
  await locator.fill('');
  await sleep(rand(50, 100));
  for (const char of text) {
    await locator.pressSequentially(char, { delay: rand(60, 180) });
    if (Math.random() < 0.08) {
      await sleep(rand(200, 450)); // natural thinking pauses
    }
  }
  await sleep(rand(100, 200));
}

async function handleCaptchaIfPresent(page, label = '', timeoutMs = 8000) {
  const arkoseSelector = 'iframe[src*="arkoselabs.com"], iframe[src*="hcaptcha.com"][src*="frame=challenge"], iframe[title*="challenge"], iframe[src*="funcaptcha"]';
  const datadomeSelector = 'iframe[src*="captcha-delivery.com"], iframe[title*="CAPTCHA"], iframe[src*="datadome"]';

  try {
    const arkoseIframe = page.locator(arkoseSelector).filter({ visible: true }).first();
    const datadomeIframe = page.locator(datadomeSelector).filter({ visible: true }).first();
    const otpIndicator = page.locator('h1, h2, p, span, label').filter({ hasText: /enter the code|verification|verify your email/i }).first();

    // Check if visible immediately
    let hasArkose = await arkoseIframe.isVisible().catch(() => false);
    let hasDatadome = await datadomeIframe.isVisible().catch(() => false);

    if (!hasArkose && !hasDatadome) {
      // Race waiting for either captcha to show up, OR the page moving to the verification/OTP screen
      const winner = await Promise.race([
        arkoseIframe.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'arkose').catch(() => null),
        datadomeIframe.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'datadome').catch(() => null),
        otpIndicator.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'otp').catch(() => null),
      ]);

      if (winner === 'arkose') hasArkose = true;
      if (winner === 'datadome') hasDatadome = true;
      if (winner === 'otp') {
        console.log('  [CAPTCHA] OTP/Verification page elements detected. Bypassing CAPTCHA wait.');
        return false;
      }
    }

    if (hasDatadome) {
      console.log(`  [DataDome] DataDome CAPTCHA detected during "${label}"! Starting slider solver...`);
      const solvedDD = await solveDataDomeSlider(page, datadomeIframe);
      if (solvedDD) {
        console.log(`  [DataDome] Successfully solved DataDome slider during "${label}"!`);
        return true;
      }
    }

    if (hasArkose) {
      console.log(`  [CAPTCHA] Arkose Captcha detected during "${label}"! Starting solver...`);
      const solved = await solveArkoseDragCaptcha(page, {
        apiKey: process.env.LLM_API_KEY,
        apiUrl: process.env.LLM_API_URL,
        model: process.env.LLM_MODEL,
      });
      if (solved === true) {
        console.log(`  [CAPTCHA] Captcha solved successfully for "${label}"!`);
        return true;
      } else if (solved === 'no_challenge') {
        console.log(`  [CAPTCHA] No active captcha challenge was displayed for "${label}".`);
        return false;
      } else {
        console.log(`  [CAPTCHA] Captcha solver returned failure for "${label}".`);
      }
    }

    if (!hasArkose && !hasDatadome) {
      console.log('  [CAPTCHA] No captcha element appeared.');
    }
  } catch (err) {
    console.log(`  [CAPTCHA] Error during captcha detection/solving: ${err.message}`);
  }
  return false;
}



/**
 * Perform human-like bezier drag with overshoot, micro-jitter, and natural pauses.
 * Based on real human mouse movement patterns to evade DataDome detection.
 */
async function humanDrag(page, startX, startY, distance, direction = 'right') {
  const endX = direction === 'right' ? startX + distance : startX - distance;
  const endY = startY;

  await page.mouse.move(startX, startY, { steps: rand(3, 6) });
  await sleep(rand(40, 80));
  await page.mouse.down();
  await sleep(rand(60, 120));

  const cp1 = {
    x: startX + distance * rand(8, 18) / 100,
    y: startY + rand(-8, 8)
  };
  const cp2 = {
    x: endX - distance * rand(3, 10) / 100,
    y: startY + rand(-4, 4)
  };

  const totalSteps = rand(35, 55);

  for (let s = 0; s <= totalSteps; s++) {
    const t = s / totalSteps;
    const mt = 1 - t;
    const cx = mt * mt * mt * startX + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * endX;
    const cy = mt * mt * mt * startY + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * endY;
    const jitterY = Math.sin(t * Math.PI * rand(2, 5)) * rand(0.3, 1.2);
    await page.mouse.move(cx, cy + jitterY);
    const delay = (t < 0.1 || t > 0.85) ? rand(12, 25) : rand(4, 10);
    await sleep(delay);
  }

  // Overshoot correction (natural human behavior)
  const overshoot = distance * rand(1, 4) / 100;
  await page.mouse.move(endX + overshoot, endY + rand(-2, 2), { steps: 3 });
  await sleep(rand(40, 80));
  await page.mouse.move(endX, endY, { steps: 2 });
  await sleep(rand(30, 60));
  await sleep(rand(80, 200));
  await page.mouse.up();
  console.log('  [DataDome] Human-like slider drag completed (bezier + overshoot + jitter).');
}

async function solveDataDomeSlider(page, iframeLocator) {
  if (process.env.MANUAL_SLIDER === 'true') {
    console.log('\\n======================================================================');
    console.log('[DataDome] MANUAL SLIDER RESOLUTION MODE ACTIVE.');
    console.log('  Please solve the slider CAPTCHA manually in the browser window...');
    console.log('  Waiting up to 5 minutes for manual solve...');
    console.log('======================================================================\\n');

    const solved = await iframeLocator.waitFor({ state: 'hidden', timeout: 300000 })
      .then(() => true)
      .catch(() => false);

    if (solved) {
      console.log('  [DataDome] Slider solved manually!');
      return true;
    } else {
      console.log('  [DataDome] Manual solve timed out (5 minutes).');
      return false;
    }
  }

  console.log('  [DataDome] Attempting to auto-solve slider CAPTCHA using LLM...');
  const os = require('os');
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      console.log(`  [DataDome] Auto-solve attempt ${attempt}/4...`);
      const iframeHandle = await iframeLocator.elementHandle();
      const frame = await iframeHandle.contentFrame();
      if (!frame) {
        console.log('  [DataDome] Failed to access iframe content.');
        await sleep(2000);
        continue;
      }

      // Screenshot iframe for debugging
      try {
        const debugPath = path.join(os.tmpdir(), `datadome_iframe_attempt${attempt}_${Date.now()}.png`);
        await iframeLocator.screenshot({ path: debugPath, timeout: 5000 });
        console.log(`  [DataDome] Iframe screenshot saved: ${debugPath}`);
      } catch (_) { }

      // Check for and click DataDome RETRY button or reload button if displayed
      const retryHandled = await frame.evaluate(() => {
        // 1. Check for audio mode toggle - switch back to visual puzzle if toggled
        const toggles = Array.from(document.querySelectorAll('.captcha-toggle, button.captcha-buttons, [class*="toggle" i]'));
        if (toggles.length > 0) {
          const visualBtn = toggles[0]; // first button is visual mode
          const isAudioActive = document.body && document.body.textContent.toLowerCase().includes('type the numbers');
          if (isAudioActive && visualBtn) {
            visualBtn.click();
            return 'SWITCHED_TO_VISUAL';
          }
        }

        // 2. Check for RETRY button or container
        const retrySelectors = [
          '.retry-container',
          '.retry-container button',
          '.retry-container div',
          'button.retry',
          '[class*="retry" i]',
          'div.toggled.retry-container'
        ];
        for (const s of retrySelectors) {
          const el = document.querySelector(s);
          if (el && el.getBoundingClientRect().width > 15) {
            el.click();
            return 'CLICKED_RETRY_SELECTOR';
          }
        }

        // 3. Fallback: Search all elements with text 'retry' or 'try again'
        const all = Array.from(document.querySelectorAll('button, div, a, span'));
        const retryEl = all.find(el => {
          const txt = (el.textContent || '').trim().toLowerCase();
          const rect = el.getBoundingClientRect();
          return (txt === 'retry' || txt.includes('retry') || txt === 'try again') && rect.width > 20 && rect.height > 15 && rect.height < 150;
        });
        if (retryEl) {
          retryEl.click();
          return 'CLICKED_RETRY_TEXT';
        }

        // 4. Check for refresh/reload button
        const reloadBtn = document.querySelector('.reload, .captcha-reload, [aria-label*="reload" i], [aria-label*="refresh" i]');
        if (reloadBtn) {
          reloadBtn.click();
          return 'CLICKED_RELOAD';
        }

        return null;
      }).catch(() => null);

      if (retryHandled) {
        console.log(`  [DataDome] Handled captcha reset/retry (${retryHandled}). Waiting for fresh challenge elements...`);
        await sleep(3000);
      }

      // Click inside iframe first to activate captcha (DataDome often requires activation click)
      console.log('  [DataDome] Clicking inside iframe to activate captcha...');
      const iframeBox = await iframeLocator.boundingBox().catch(() => null);
      if (iframeBox) {
        await page.mouse.click(iframeBox.x + iframeBox.width / 2, iframeBox.y + iframeBox.height / 2);
        await sleep(1000);
      }

      // Log all visible elements inside iframe for debugging
      const iframeDump = await frame.evaluate(() => {
        const all = document.querySelectorAll('*');
        const visible = [];
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
            const tag = el.tagName.toLowerCase();
            const cls = el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '';
            const txt = (el.textContent || '').trim().slice(0, 30);
            visible.push(`${tag} .${cls} [${rect.width.toFixed(0)}x${rect.height.toFixed(0)}] "${txt}"`);
            if (visible.length >= 20) break;
          }
        }
        return visible;
      }).catch(() => []);
      console.log('  [DataDome] Visible elements inside iframe:');
      iframeDump.forEach(s => console.log('    ' + s));

      // Wait for captcha elements to load inside iframe - broader detection
      console.log('  [DataDome] Waiting for captcha elements to render inside iframe...');
      const elementsLoaded = await frame.evaluate(async () => {
        // Broad selector: any clickable/interactive element
        const findAnyInteractive = () => {
          // Try known slider selectors first
          const sliderSelectors = [
            '.slider', '.slider-btn', '.sec-cpt-slider-btn', '[role="slider"]', '#slider',
            'button.slider', '.geetest_slider_btn', '.captcha_slider', '.slider_handle',
            '[class*="slider"]', 'button[aria-label*="slide" i]',
            // Also any button or div that looks like a handle (small, positioned)
            'button', '[role="button"]', '.btn', '[class*="btn"]',
            '[class*="captcha"] button', '[class*="captcha"] div',
            '[draggable="true"]', '.handle', '.thumb'
          ];
          for (const s of sliderSelectors) {
            const el = document.querySelector(s);
            if (el && el.getBoundingClientRect().width > 10) return el;
          }
          // Fallback: any element with reasonable handle size
          const all = document.querySelectorAll('*');
          for (const el of all) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 10 && rect.width < 120 && rect.height > 10 && rect.height < 80) {
              return el;
            }
          }
          return null;
        };

        for (let i = 0; i < 30; i++) {
          const interactive = findAnyInteractive();
          if (interactive) return true;
          await new Promise(r => setTimeout(r, 300));
        }
        return false;
      }).catch(() => false);

      if (!elementsLoaded) {
        console.log('  [DataDome] Captcha elements did not load or failed to render.');
        await sleep(2000);
        continue;
      }

      // Re-get iframeBox after activation click
      const iframeBox2 = await iframeLocator.boundingBox().catch(() => null);
      if (!iframeBox2) {
        console.log('  [DataDome] Failed to get iframe bounding box.');
        await sleep(2000);
        continue;
      }

      // Locate the slider handle element
      const relativePositions = await frame.evaluate(() => {
        const handleSelectors = ['.slider', '.slider-btn', '.sec-cpt-slider-btn', '[role="slider"]', '#slider', 'button.slider', '.geetest_slider_btn', '.captcha_slider', '.slider_handle', '[class*="slider"][class*="btn"]', '[class*="slider"][class*="handle"]', '[class*="slider"] button', 'button[aria-label*="slide" i]'];

        let h = null;
        for (const s of handleSelectors) {
          const el = document.querySelector(s);
          if (el && el.getBoundingClientRect().width > 0) { h = el; break; }
        }

        if (!h) {
          const allButtons = document.querySelectorAll('button, div[tabindex]');
          for (const b of allButtons) {
            const rect = b.getBoundingClientRect();
            if (rect.width > 20 && rect.width < 100 && rect.height > 20 && rect.height < 100) {
              h = b; break;
            }
          }
        }

        if (!h) return null;
        const hRect = h.getBoundingClientRect();
        return {
          handle: { x: hRect.left, y: hRect.top, w: hRect.width, h: hRect.height }
        };
      }).catch(() => null);

      if (!relativePositions) {
        console.log('  [DataDome] Failed to locate slider handle inside iframe. Captcha page might have reloaded or switched mode.');
        await sleep(3000);
        if (!(await iframeLocator.isVisible().catch(() => false))) {
          return true;
        }
        continue;
      }

      const startX = iframeBox2.x + relativePositions.handle.x + relativePositions.handle.w / 2;
      const startY = iframeBox2.y + relativePositions.handle.y + relativePositions.handle.h / 2;

      // Get background width
      const bgWidth = await frame.evaluate(() => {
        const bg = document.querySelector('.captcha_background, img#bg, .sec-cpt-img, #captcha-bg, img[src*="image"]');
        if (bg) return bg.getBoundingClientRect().width;
        const track = document.querySelector('.slider-track, #slider-track, .slider-container');
        if (track) return track.getBoundingClientRect().width;
        return 300;
      }).catch(() => 300);

      // Check if a puzzle piece element exists in the iframe
      const puzzleExists = await frame.evaluate(() => {
        const puz = document.querySelector('.captcha_fragment, img#puzzle, img#slideBg, img[src*="fragment"], .sec-cpt-puzzle-img, #captcha-puzzle, [class*="puzzle" i]');
        return !!(puz && puz.getBoundingClientRect().width > 0);
      }).catch(() => false);

      if (!puzzleExists) {
        console.log('  [DataDome] Simple slide-to-end challenge detected (no puzzle piece).');
        const dragDistance = bgWidth - relativePositions.handle.w;
        const endX = startX + dragDistance;
        const endY = startY;
        console.log(`  [DataDome] Sliding to end X: ${endX.toFixed(1)} with human-like bezier drag...`);

        await humanDrag(page, startX, startY, dragDistance);
        console.log('  [DataDome] Slider drag completed.');

        await sleep(3500);
        const stillVisible = await iframeLocator.isVisible().catch(() => false);
        if (!stillVisible) {
          console.log('  [DataDome] SUCCESS: DataDome CAPTCHA bypassed successfully!');
          return true;
        } else {
          console.log('  [DataDome] FAILED: Captcha iframe is still visible.');
          continue;
        }
      }

      // If puzzle exists, try local template matching first
      console.log('  [DataDome] Puzzle challenge detected. Attempting local Canvas Template Matching (no LLM)...');
      const localSolution = await frame.evaluate(async () => {
        try {
          const bgImg = document.querySelector('.captcha_background, img#bg, .sec-cpt-img, #captcha-bg, img[src*="image"]');
          const puzzleImg = document.querySelector('.captcha_fragment, img#puzzle, img#slideBg, img[src*="fragment"], .sec-cpt-puzzle-img, #captcha-puzzle');

          if (!bgImg || !puzzleImg) return null;

          const loadImg = (imgEl) => new Promise((resolve, reject) => {
            if (imgEl.complete && imgEl.naturalWidth !== 0) {
              resolve(imgEl);
              return;
            }
            const temp = new Image();
            temp.crossOrigin = "anonymous";
            temp.onload = () => resolve(temp);
            temp.onerror = (e) => reject(e);
            temp.src = imgEl.src;
          });

          const bg = await loadImg(bgImg);
          const puzzle = await loadImg(puzzleImg);

          const bgW = bg.naturalWidth || bg.width;
          const bgH = bg.naturalHeight || bg.height;
          const puzW = puzzle.naturalWidth || puzzle.width;
          const puzH = puzzle.naturalHeight || puzzle.height;

          // Draw background to canvas
          const bgCanvas = document.createElement('canvas');
          bgCanvas.width = bgW;
          bgCanvas.height = bgH;
          const bgCtx = bgCanvas.getContext('2d');
          bgCtx.drawImage(bg, 0, 0);
          const bgData = bgCtx.getImageData(0, 0, bgW, bgH).data;

          // Draw puzzle piece to canvas
          const puzCanvas = document.createElement('canvas');
          puzCanvas.width = puzW;
          puzCanvas.height = puzH;
          const puzCtx = puzCanvas.getContext('2d');
          puzCtx.drawImage(puzzle, 0, 0);
          const puzData = puzCtx.getImageData(0, 0, puzW, puzH).data;

          // Extract mask (non-transparent pixels)
          const mask = [];
          for (let y = 0; y < puzH; y++) {
            for (let x = 0; x < puzW; x++) {
              const idx = (y * puzW + x) * 4;
              const alpha = puzData[idx + 3];
              if (alpha > 50) { // non-transparent
                mask.push({ x, y });
              }
            }
          }

          if (mask.length === 0) return null;

          let bestX = 0;
          let minScore = Infinity;
          const startScanX = Math.round(puzW * 0.3); // avoid left edge
          const endScanX = bgW - puzW;

          for (let scanX = startScanX; scanX < endScanX; scanX++) {
            let score = 0;
            for (const pt of mask) {
              const bgX = scanX + pt.x;
              const bgY = pt.y;
              if (bgX >= bgW || bgY >= bgH) continue;

              const bgIdx = (bgY * bgW + bgX) * 4;
              const r = bgData[bgIdx];
              const g = bgData[bgIdx + 1];
              const b = bgData[bgIdx + 2];

              // brightness
              const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
              score += brightness;
            }

            if (score < minScore) {
              minScore = score;
              bestX = scanX;
            }
          }

          const displayedBgWidth = bgImg.getBoundingClientRect().width;
          const scale = displayedBgWidth / bgW;
          // Calibrate offset exactly to fit target shadow cutout (+33px)
          const dragDistance = (bestX * scale) + 33;

          return { dragDistance, bestX, scale };
        } catch (err) {
          return { error: err.message };
        }
      }).catch((e) => ({ error: e.message }));

      let dragDistance = null;
      if (localSolution && typeof localSolution.dragDistance === 'number' && !localSolution.error) {
        dragDistance = localSolution.dragDistance;
        console.log(`  [DataDome] Solved locally in ~12ms (Distance: ${dragDistance.toFixed(1)}px, BestX: ${localSolution.bestX})`);
      } else {
        console.log(`  [DataDome] Local solver failed (${localSolution?.error || 'No elements'}). Falling back to LLM...`);

        // --- LLM FALLBACK START ---
        // Capture screenshot and start LLM calculation in the background
        const debugPath = path.join(os.tmpdir(), `datadome_captcha_${Date.now()}.png`);
        const getLlmPercentage = (async () => {
          try {
            await iframeLocator.screenshot({ path: debugPath, timeout: 10000 });
            const imgBuffer = fs.readFileSync(debugPath);
            const b64 = imgBuffer.toString('base64');

            const apiKey = process.env.LLM_API_KEY;
            const apiUrl = process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions';
            const model = process.env.LLM_MODEL || 'antigravity/gemini-3.5-flash-high';

            if (!apiKey) return null;

            const payload = {
              model: model,
              stream: false,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'You are given a sliding puzzle captcha card. There is a moving puzzle piece on the far left, and a target dark shadow cutout template to the right. Calculate the horizontal sliding distance required to move the moving puzzle piece from its initial left position to align exactly with the target dark shadow cutout on the right. Express this distance as a percentage of the total scenic background image width (for example, if the cutout is halfway across the background image, return "50%"). Output ONLY the percentage value (for example, "65%"), with no other text or explanation.'
                    },
                    {
                      type: 'image_url',
                      image_url: { url: `data:image/png;base64,${b64}` }
                    }
                  ]
                }
              ]
            };

            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(payload)
            });
            const data = await res.json();
            const rawResult = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
            console.log(`  [DataDome] LLM raw result: "${rawResult}"`);

            const percentageMatches = [...rawResult.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
            if (percentageMatches.length > 0) {
              const lastPctString = percentageMatches[percentageMatches.length - 1][1];
              return Math.round(parseFloat(lastPctString));
            }
          } catch (err) {
            console.log(`  [DataDome WARN] LLM call failed: ${err.message}`);
          } finally {
            try { fs.unlinkSync(debugPath); } catch (_) { }
          }
          return null;
        })();
        // Wait for LLM result, then do one smooth human-like bezier drag
        console.log('  [DataDome] Waiting for LLM calculation to finish...');
        percentage = await getLlmPercentage;

        if (percentage && percentage > 0 && percentage < 100) {
          dragDistance = bgWidth * (percentage / 100) + 30;
          console.log(`  [DataDome] LLM suggested sliding percentage: ${percentage}% (Width: ${bgWidth}px -> Drag: ${dragDistance.toFixed(1)}px)`);
        } else {
          dragDistance = bgWidth - relativePositions.handle.w;
          console.log(`  [DataDome] Using fallback drag distance: ${dragDistance.toFixed(1)}px`);
        }

        await humanDrag(page, startX, startY, dragDistance);
        console.log('  [DataDome] Slider drag completed.');
        dragDistance = null;
        dragDistance = null;
      }

      // If solved locally, drag immediately from start to target
      if (dragDistance !== null) {
        console.log('  [DataDome] Sliding to target with human-like bezier drag...');
        await humanDrag(page, startX, startY, dragDistance);
        console.log('  [DataDome] Slider drag completed.');
      }

      await sleep(3500);
      const stillVisible = await iframeLocator.isVisible().catch(() => false);
      if (!stillVisible) {
        console.log('  [DataDome] SUCCESS: DataDome CAPTCHA bypassed successfully!');
        return true;
      } else {
        console.log('  [DataDome] FAILED: Captcha iframe is still visible.');
      }
    }
  } catch (err) {
    console.log(`  [DataDome] Solver error: ${err.message}`);
  }
  return false;
}

async function handleCountrySelection(page) {
  try {
    // 1. Standard HTML <select>
    const countrySelect = page.locator('select#country_code, select[name*="country_code"], select[name*="country" i], select[id*="country" i]').first();
    if (await countrySelect.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('  [Country] Selecting Singapore via <select> dropdown...');
      await countrySelect.selectOption({ label: 'Singapore' }).catch(() => countrySelect.selectOption({ value: 'SG' })).catch(() => { });
      await countrySelect.dispatchEvent('change').catch(() => { });
      await sleep(500);
      return true;
    }

    // 2. Custom Primer Dropdown Button (e.g. showing "Russian Federation" or other countries)
    const countryBtn = page.locator('button[aria-haspopup="listbox"], button:near(:text("Your Country/Region")), [id*="country"] button, button[aria-label*="Country" i]').first();
    if (await countryBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      const btnText = (await countryBtn.innerText().catch(() => '')).trim();
      console.log(`  [Country] Found country selector button (Current: "${btnText}"). Opening dropdown...`);
      await countryBtn.click();
      await sleep(800);

      // Try typing Singapore in search input if available
      const searchBox = page.locator('input[placeholder*="Search" i], input[placeholder*="Filter" i], input[type="search"], [role="listbox"] input').first();
      if (await searchBox.isVisible({ timeout: 1000 }).catch(() => false)) {
        await searchBox.fill('Singapore');
        await sleep(500);
      }

      const option = page.locator('[role="option"]:has-text("Singapore"), li:has-text("Singapore"), button:has-text("Singapore"), [role="menuitem"]:has-text("Singapore"), text="Singapore"').first();
      if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  [Country] Clicking Singapore option...');
        await option.click();
        await sleep(800);
        return true;
      } else {
        await page.keyboard.press('Escape').catch(() => { });
      }
    }
  } catch (err) {
    console.log(`  [Country WARN] Country selector handling notice: ${err.message}`);
  }
  return false;
}

async function loginIfRequired(page, username, password) {
  try {
    const isLoginPage = page.url().includes('/login');
    const loginInput = page.locator('input#login_field, input[name="login"], input#user_login').first();
    const isLoginFieldVisible = await loginInput.isVisible({ timeout: 2000 }).catch(() => false);

    if (!isLoginPage && !isLoginFieldVisible) {
      return false;
    }

    console.log(`  [Login] GitHub login required. Entering credentials (Username: ${username})...`);
    await loginInput.waitFor({ state: 'visible', timeout: 10000 });
    await loginInput.focus();
    await fillHuman(page, loginInput, username);
    await sleep(500);

    const pwdInput = page.locator('input#password, input[name="password"], input[type="password"]').first();
    await pwdInput.waitFor({ state: 'visible', timeout: 5000 });
    await pwdInput.focus();
    await fillHuman(page, pwdInput, password);
    await sleep(800);

    const signInBtn = page.locator('input[type="submit"][name="commit"], button:has-text("Sign in"), input[value="Sign in"]').first();
    await signInBtn.waitFor({ state: 'visible', timeout: 5000 });
    await signInBtn.click();
    await sleep(3000);

    // Wait for redirect away from /login
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 }).catch(() => { });
    await sleep(1500);
    console.log(`  [Login] Login submitted. Current URL: ${page.url()}`);
    return true;
  } catch (err) {
    console.log(`  [Login WARN] Auto-login error: ${err.message}`);
    return false;
  }
}

async function createDummyRepo(page, username) {
  try {
    console.log('\n[Init Repo] Fast initializing dummy repository with README...');

    // If currently on login page, perform login first
    if (page.url().includes('/login') || await page.locator('input#login_field, input[name="login"]').first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await loginIfRequired(page, username, CONFIG.password);
    }

    // Skip onboarding questionnaire if present
    const skipBtn = page.locator('button:has-text("Skip personalization"), a:has-text("Skip personalization"), button:text-is("Skip"), a:text-is("Skip"), a[href*="skip"]:not([href^="#"])')
      .filter({ hasNot: page.locator('.js-skip-to-content, [href="#start-of-content"], [data-skip-target-assigned]') })
      .first();

    if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('  [Init Repo] Skipping onboarding questionnaire...');
      await skipBtn.click().catch(() => { });
      await sleep(800);
    }

    // Direct navigate to create new repository page
    await page.goto('https://github.com/new', { waitUntil: 'domcontentloaded', timeout: 20000 });

    // If redirected to login from /new, perform login and re-navigate
    if (page.url().includes('/login') || await page.locator('input#login_field, input[name="login"]').first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await loginIfRequired(page, username, CONFIG.password);
      await page.goto('https://github.com/new', { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    // Generate natural repo name
    const adjectives = ['awesome', 'quick', 'starter', 'simple', 'smart', 'core', 'daily', 'modern', 'clean', 'prime'];
    const nouns = ['notes', 'project', 'workspace', 'toolkit', 'guide', 'hub', 'lab', 'box', 'flow', 'base'];
    const repoName = `${adjectives[Math.floor(Math.random() * adjectives.length)]}-${nouns[Math.floor(Math.random() * nouns.length)]}-${Math.floor(Math.random() * 899 + 100)}`;
    console.log(`  [Init Repo] Generated repo name: ${repoName}`);

    // Fast unified locator for repository name input (Instant match, no slow candidate looping)
    const repoNameInput = page.locator('input[aria-label*="Repository name" i], input[data-testid="repository-name-input"], input#repository_name, input[name="repository[name]"], input[placeholder*="name" i], [aria-labelledby*="repo" i] input, main form input[type="text"]').first();
    await repoNameInput.waitFor({ state: 'visible', timeout: 8000 });
    await repoNameInput.fill(repoName);

    // Wait for availability check to finish (green check / is available)
    await page.locator('text=/is available/i, [data-testid="repository-name-input-status"]').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => { });
    await sleep(800);

    // Fast toggle "Add README" (Supports both React Primer switch and legacy checkbox)
    const readmeSwitch = page.locator('div:has-text("Add README") button[role="switch"], button[role="switch"][aria-labelledby*="readme" i], button[role="switch"][aria-label*="README" i], button[role="switch"]:near(:text("Add README")), button[role="switch"]:has-text("README")').first();
    if (await readmeSwitch.isVisible({ timeout: 1000 }).catch(() => false)) {
      const isAriaChecked = (await readmeSwitch.getAttribute('aria-checked')) === 'true';
      if (!isAriaChecked) {
        await readmeSwitch.click({ force: true }).catch(async () => {
          await readmeSwitch.evaluate(el => el.click()).catch(() => { });
        });
        await sleep(500);
      }
    } else {
      const readmeCb = page.locator('input#repository_auto_init, input[name="repository[auto_init]"], label:has-text("Add README"), label:has-text("Add a README file")').first();
      if (await readmeCb.isVisible({ timeout: 800 }).catch(() => false)) {
        await readmeCb.click({ force: true, timeout: 800 }).catch(() => { });
      }
    }

    // Click "Create repository" button
    const createBtn = page.locator('button:has-text("Create repository"):not([disabled]), button[type="submit"]:has-text("Create repository"), button[data-disable-with="Creating repository…"]').first();
    await createBtn.waitFor({ state: 'visible', timeout: 8000 });
    await createBtn.scrollIntoViewIfNeeded().catch(() => { });
    await sleep(500);
    await createBtn.click({ force: true });

    // Fallback: if still on /new after 2.5s, click via direct DOM dispatch
    await sleep(2500);
    if (page.url().includes('/new')) {
      await createBtn.evaluate(el => el.click()).catch(() => { });
    }

    // Wait for redirect to the new repository page
    await page.waitForURL(url => url.pathname.includes(`/${repoName}`) || (url.hostname === 'github.com' && !url.pathname.endsWith('/new')), { timeout: 20000, waitUntil: 'domcontentloaded' });
    console.log(`  ✅ [Init Repo] Repository created successfully: ${page.url()}`);
  } catch (repoErr) {
    const currentUrl = page.url();
    if (currentUrl.includes(`/${repoName}`) || (currentUrl.includes(username) && !currentUrl.endsWith('/new'))) {
      console.log(`  ✅ [Init Repo] Repository created successfully: ${currentUrl}`);
      return;
    }

    console.log(`  ⚠️ [Init Repo] Could not create dummy repo (skipped): ${repoErr.message}`);
    if (process.env.DISABLE_SCREENSHOTS !== 'true') {
      const screenshotDir = fs.existsSync('/app/screenshots') ? '/app/screenshots' : path.join(__dirname, '..', 'screenshots');
      if (!fs.existsSync(screenshotDir)) {
        try { fs.mkdirSync(screenshotDir, { recursive: true }); } catch (_) { }
      }
      const errScreenshot = path.join(screenshotDir, `github_init_repo_error_${username}_${Date.now()}.png`);
      await page.screenshot({ path: errScreenshot }).catch(() => { });
      console.log(`  📸 [Init Repo] Screenshot saved to ${errScreenshot}`);
    }
  }
}

async function register(options = {}) {
  const keepOpen = options.keepOpen || false;
  let errorOccurred = false;
  console.log('=== GitHub Auto-Registration ===');
  let tempProfileDir = '';

  const disableProxy = envFlag('DISABLE_PROXY', false);
  const selectedProxy = disableProxy ? null : selectProxy('', { service: 'github' });
  const selectedProxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;

  if (!selectedProxy) {
    if (!disableProxy && envFlag('BLOCK_DIRECT_CONNECTION', true)) {
      throw new Error('No active proxies available in http_proxies.txt and BLOCK_DIRECT_CONNECTION is active. Direct connection blocked!');
    }
    console.log('[PROXY] Running without proxy (Direct connection)');
  }

  let targetVpnCountry = CONFIG.vpnCountry;
  if (selectedProxyConfig) {
    const proxyUser = selectedProxyConfig.username || 'NO_AUTH';
    console.log(`[PROXY INFO] Server Endpoint : ${selectedProxyConfig.server}`);
    console.log(`[PROXY INFO] Proxy Username  : ${proxyUser}`);
    console.log(`[PROXY INFO] Raw Line        : ${selectedProxy}`);
    targetVpnCountry = '';
  }

  if (targetVpnCountry && targetVpnCountry.toLowerCase() === 'random') {
    let vpnCountries;
    if (CONFIG.vpnProvider === 'hideme') {
      vpnCountries = ['United States', 'Canada', 'Germany', 'Netherlands', 'Singapore'];
    } else {
      vpnCountries = [
        'Switzerland', 'Germany', 'Brazil', 'Argentina', 'France', 'United Kingdom', 'Singapore',
        'United States', 'Canada', 'Australia', 'Japan', 'Italy', 'Spain', 'Netherlands',
        'Indonesia', 'India', 'Malaysia', 'Vietnam', 'Thailand', 'Philippines', 'South Korea', 'Mexico'
      ];
    }
    targetVpnCountry = vpnCountries[Math.floor(Math.random() * vpnCountries.length)];
    console.log(`[VPN] Resolved 'random' country for ${CONFIG.vpnProvider} to: ${targetVpnCountry}`);
  }

  const tempmail = new TempMail();
  const provider = (TempMail.PROVIDER || process.env.TEMPMAIL_PROVIDER || 'webhook').toLowerCase().trim();
  const outlookMode = process.env.GITHUB_SIGNUP_MODE === 'outlook' || process.argv.includes('--outlook');

  let email = '';
  let outlookAccount = null;
  let emailMode = 'gmail';

  if (outlookMode) {
    // Outlook/Hotmail mode — pick from outlook_accounts.csv
    const { email: outlookEmail, outlookAccount: acc } = await resolveEmail(tempmail, {
      mode: 'outlook',
      outputFile: CONFIG.outputFile,
    });
    email = outlookEmail;
    outlookAccount = acc;
    emailMode = 'outlook';
    console.log(`[*] Outlook mode: ${email}`);
  } else if (provider === 'gmail') {
    const baseEmail = await resolveBaseEmail(tempmail);
    const atIdx = baseEmail.indexOf('@');
    const username = baseEmail.slice(0, atIdx);
    const domainName = baseEmail.slice(atIdx + 1);

    const cleanUsername = username.replace(/\./g, '').split('+')[0];

    let dottedUsername = cleanUsername[0];
    for (let i = 1; i < cleanUsername.length; i++) {
      if (Math.random() < 0.5) {
        dottedUsername += '.';
      }
      dottedUsername += cleanUsername[i];
    }

    const plusSuffix = `+github_${Date.now()}_${rand(1000, 9999)}`;
    email = `${dottedUsername}${plusSuffix}@${domainName}`;
  } else {
    const targetDomains = (process.env.TEMPMAIL_WEBHOOK_DOMAIN || '').split(',').map(d => d.trim()).filter(Boolean);
    const workingDomains = targetDomains.filter(d => d.endsWith('.com') || d.endsWith('.my'));
    const selectedDomain = workingDomains.length > 0 ? workingDomains[Math.floor(Math.random() * workingDomains.length)] : null;
    const inbox = await tempmail.createInbox(null, selectedDomain);
    email = inbox.address;
  }

  // Generate valid GitHub username from a pool of common names
  const namePool = [
    'adrian', 'dimas', 'reza', 'dika', 'laras', 'fitri', 'budi', 'dewi',
    'putra', 'putri', 'agus', 'sari', 'ari', 'wulan', 'bagus', 'cahya',
    'setiawan', 'kurniawan', 'nugroho', 'pratama', 'lestari', 'hidayat',
    'saputra', 'wahyuni', 'dharma', 'ananda', 'rizky', 'firmansyah',
    'ramadhan', 'fauzi', 'hadi', 'santoso', 'wijaya', 'yuni', 'endah',
    'kartika', 'linda', 'mega', 'rudi', 'eko', 'dwi', 'tri', 'santi',
    'rinaldi', 'hendra', 'teten', 'irma', 'yulia', 'dani', 'ahmad'
  ];
  const nameBase = namePool[Math.floor(Math.random() * namePool.length)];
  const username = `${nameBase}${rand(1000, 99999)}`;

  console.log(`Generated Email:    ${email}`);
  console.log(`Generated Username: ${username}`);

  let executablePathToUse = CONFIG.browserExecutablePath || undefined;
  if (executablePathToUse && executablePathToUse.toLowerCase() === 'random') {
    const homedir = require('os').homedir();
    const chromiumBrowsers = [
      path.join(homedir, '.local/share/brave-bin/opt/brave.com/brave/brave-browser'),
      '/usr/bin/google-chrome-stable',
      path.join(homedir, '.cloakbrowser/chromium-146.0.7680.177.5/chrome')
    ];
    const allBrowsers = [
      path.join(homedir, '.cache/camoufox/camoufox'),
      ...chromiumBrowsers
    ];
    const listToPick = targetVpnCountry ? chromiumBrowsers : allBrowsers;
    executablePathToUse = listToPick[Math.floor(Math.random() * listToPick.length)];
    console.log(`[BROWSER] Resolved 'random' browser to: ${executablePathToUse}`);
  }

  const isCam = isCamoufox(executablePathToUse);

  console.log(`Launching browser (Headless: ${envFlag('HEADLESS')})...`);
  if (selectedProxyConfig) {
    console.log(`Using Proxy: ${selectedProxyConfig.server}`);
  }

  const launchOpts = {
    headless: envFlag('HEADLESS'),
    args: [],
    ignoreHTTPSErrors: true,
  };
  if (!isCam) {
    launchOpts.args.push('--disable-blink-features=AutomationControlled');
  }
  if (selectedProxyConfig) launchOpts.proxy = selectedProxyConfig;
  if (executablePathToUse) launchOpts.executablePath = executablePathToUse;

  // Check if the selected browser supports extensions (camoufox and google-chrome-stable in this request should not use extensions)
  const isChromeStable = executablePathToUse && executablePathToUse.includes('google-chrome-stable');
  const skipVpnExtension = isCam || isChromeStable;

  let browser;
  let context;

  if (targetVpnCountry && !skipVpnExtension) {
    console.log(`[VPN] VPN requested. Forcing Chromium/Brave persistent context...`);
    tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_github_vpn_${Date.now()}_${Math.floor(Math.random() * 100000)}`);

    let finalExecutable = executablePathToUse;
    const homedir = require('os').homedir();
    if (!finalExecutable) {
      finalExecutable = path.join(homedir, '.local/share/brave-bin/opt/brave.com/brave/brave-browser');
      console.log(`[VPN] Executable path was not specified. Using Brave fallback: ${finalExecutable}`);
    }

    const extensionPath = CONFIG.vpnProvider === 'hideme'
      ? path.join(homedir, '.brave-extension-source/Default/Extensions/ohjocgmpmlfahafbipehkhbaacoemojp/2.0.1_0')
      : path.join(homedir, '.config/BraveSoftware/Brave-Browser/Default/Extensions/eppiocemhmnlbhjplcgkofciiegomcon/5.13.0_0');

    const contextOpts = {
      headless: envFlag('HEADLESS'),
      executablePath: finalExecutable,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      ignoreHTTPSErrors: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    };

    if (CONFIG.vpnProvider === 'hideme') {
      contextOpts.permissions = ['clipboard-read', 'clipboard-write'];
    }

    context = await chromium.launchPersistentContext(tempProfileDir, contextOpts);
    browser = {
      close: async () => {
        await context.close().catch(() => { });
        try {
          if (fs.existsSync(tempProfileDir)) {
            fs.rmSync(tempProfileDir, { recursive: true, force: true });
          }
        } catch (_) { }
      }
    };
  } else {
    if (targetVpnCountry && skipVpnExtension) {
      console.log(`[VPN INFO] VPN was requested but selected browser (${isChromeStable ? 'Google Chrome Stable' : 'Camoufox'}) does not support/use the VPN extension. Running DIRECT without VPN.`);
      targetVpnCountry = ''; // Reset VPN country to direct
    }

    if (isCam) {
      const { firefox } = require('playwright-extra');
      browser = await firefox.launch(launchOpts);
      context = await browser.newContext({ viewport: null, locale: 'en-US', timezoneId: 'Asia/Jakarta', ignoreHTTPSErrors: true });
    } else if (executablePathToUse && false) {
      // Disabled Remote Debugging CDP to prevent detection
      console.log('Launching Google Chrome Stable in Incognito Mode via Remote Debugging (CDP)...');
      const dynamicPort = Math.floor(19000 + Math.random() * 6000);

      const parseProxy = (p) => {
        if (!p) return null;
        try {
          const u = new URL(p);
          return { server: `${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        } catch (_) {
          return null;
        }
      };

      const pc = selectedProxyConfig || parseProxy(selectedProxyConfig?.server || selectedProxyConfig);
      await ensureChromeRunning(executablePathToUse, dynamicPort, pc);

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
      const contexts = browser.contexts();
      context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    } else if (executablePathToUse) {
      console.log(`Launching Google Chrome/Brave persistent context using path: ${executablePathToUse}`);
      tempProfileDir = path.join(__dirname, `.chrome_profile_tmp_github_${Date.now()}_${Math.floor(Math.random() * 100000)}`);

      const contextOpts = {
        headless: envFlag('HEADLESS'),
        executablePath: executablePathToUse,
        viewport: null,
        ignoreHTTPSErrors: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--renderer-process-limit=2',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--ignore-certificate-errors',
          '--start-maximized'
        ],
      };
      if (selectedProxyConfig) contextOpts.proxy = selectedProxyConfig;

      context = await chromium.launchPersistentContext(tempProfileDir, contextOpts);
      browser = {
        close: async () => {
          await context.close().catch(() => { });
          try {
            if (fs.existsSync(tempProfileDir)) {
              fs.rmSync(tempProfileDir, { recursive: true, force: true });
            }
          } catch (_) { }
        }
      };
    } else {
      console.log('Launching CloakBrowser persistent context for anti-detect evasion...');
      tempProfileDir = path.join(__dirname, `.cloak_profile_tmp_github_${Date.now()}_${Math.floor(Math.random() * 100000)}`);
      const { launchPersistentContext } = await import('cloakbrowser');

      const persistentOpts = {
        userDataDir: tempProfileDir,
        headless: envFlag('HEADLESS'),
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--renderer-process-limit=2',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
        ],
        ignoreHTTPSErrors: true,
      };
      if (selectedProxyConfig) persistentOpts.proxy = selectedProxyConfig;

      context = await launchPersistentContext(persistentOpts);
      browser = {
        close: async () => {
          await context.close().catch(() => { });
          try {
            if (fs.existsSync(tempProfileDir)) {
              fs.rmSync(tempProfileDir, { recursive: true, force: true });
            }
          } catch (_) { }
        }
      };
    }
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await setupNetworkOptimization(page);

  if (targetVpnCountry) {
    console.log(`[VPN] Configuring VPN connection to country: ${targetVpnCountry}...`);
    let success;
    if (CONFIG.vpnProvider === 'hideme') {
      success = await connectHideme(page, targetVpnCountry);
    } else {
      success = await connectVPN(page, targetVpnCountry);
    }
    if (!success) {
      console.warn(`[VPN WARN] Failed to connect to VPN country ${targetVpnCountry}. Proceeding anyway...`);
    } else {
      console.log(`[VPN SUCCESS] Successfully routed traffic through ${targetVpnCountry}.`);
    }
  }

  try {
    // Navigate to GitHub Signup page with hard refresh retry if adblock/JS block page is loaded
    let pageLoadedSuccessfully = false;
    const emailInput = page.locator('input#email, input[name="user[email]"]').first();
    const blockedText = page.locator('iframe[title*="CAPTCHA"], iframe[src*="captcha-delivery.com"]').first();

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`[WARN] Navigation retry / hard refresh (Attempt ${attempt}/3)...`);
          await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else {
          console.log('Navigating to GitHub Home Page...');
          await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        // Fill email in landing page if visible
        const homeEmailInput = page.locator('input[placeholder="Enter your email"], input[name="user_email"]').first();
        if (await homeEmailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          console.log('Filling email on Home Page...');
          await typeHumanDirect(homeEmailInput, email);
          await sleep(1000);

          const homeSubmitBtn = page.locator('button:has-text("Sign up for GitHub"), form[action="/signup"] button').first();
          await homeSubmitBtn.waitFor({ state: 'visible', timeout: 5000 });

          // Mimic human reading and scrolling
          console.log('  Simulating human scroll and delay before click...');
          await page.mouse.wheel(0, rand(100, 300));
          await sleep(rand(1200, 2500));
          await page.mouse.wheel(0, rand(-300, -100));
          await sleep(rand(800, 1500));

          const btnBox = await homeSubmitBtn.boundingBox().catch(() => null);
          if (btnBox) {
            console.log(`  Moving mouse to Home Page signup button at (${btnBox.x + btnBox.width / 2}, ${btnBox.y + btnBox.height / 2})...`);
            const targetX = btnBox.x + btnBox.width / 2 + rand(-5, 5);
            const targetY = btnBox.y + btnBox.height / 2 + rand(-2, 2);

            await page.mouse.move(targetX, targetY, { steps: rand(15, 25) });
            await sleep(rand(400, 900));
            await page.mouse.click(targetX, targetY);
          } else {
            await homeSubmitBtn.click();
          }
          await sleep(3500);
        } else {
          console.log('Home Page email input not found. Navigating to signup url directly...');
          await page.goto(CONFIG.signupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      } catch (navErr) {
        console.warn(`  [WARN] Navigation attempt ${attempt} failed: ${navErr.message}`);
        if (attempt === 3) throw navErr;
        await sleep(3000);
        continue;
      }

      console.log('Waiting for page elements to load...');
      await Promise.race([
        emailInput.waitFor({ state: 'visible', timeout: 20000 }),
        blockedText.waitFor({ state: 'visible', timeout: 20000 })
      ]).catch(() => { });

      // If CAPTCHA or Email is already visible, proceed immediately
      if (await emailInput.isVisible() || await blockedText.isVisible()) {
        pageLoadedSuccessfully = true;
        break;
      }

      // Check if body text contains the ad blocker warning
      const bodyText = await page.innerText('body').catch(() => '');
      if (bodyText.includes('Please enable JS') || bodyText.includes('disable any ad blocker')) {
        console.log('  [Warning] Page requested JS/ad-blocker check. Reloading...');
        continue;
      }

      if (bodyText.includes('Access is temporarily restricted') || bodyText.includes('Verification Required')) {
        console.log('  [DataDome] Challenge page detected. Waiting up to 10s for captcha iframe to render...');
        const iframeRendered = await blockedText.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        if (iframeRendered || await blockedText.isVisible()) {
          pageLoadedSuccessfully = true;
          break;
        }

        if (attempt < 3) {
          console.log(`  [DataDome] No captcha iframe rendered yet. Reloading page (Attempt ${attempt}/3)...`);
          await sleep(2000);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          continue;
        }

        console.log('\n======================================================================');
        console.log('[ACCESS RESTRICTED] GitHub has hard-restricted this proxy IP (no captcha iframe after retries).');
        console.log('======================================================================\n');
        if (selectedProxy) {
          handleProxyFailure(selectedProxy, new Error('GITHUB_ACCESS_RESTRICTED'), { force: true, service: 'github' });
        }
        throw new Error('Access is temporarily restricted by GitHub on this proxy IP.');
      }

      if (bodyText.includes('Too many requests') || bodyText.includes('secondary rate limit')) {
        console.log('\n======================================================================');
        console.log('[RATE LIMIT] GitHub secondary rate limit exceeded. Removing proxy...');
        console.log('======================================================================\n');
        if (selectedProxy) {
          handleProxyFailure(selectedProxy, new Error('GITHUB_RATE_LIMIT_EXCEEDED'), { force: true, service: 'github' });
        }
        throw new Error('GitHub rate limit exceeded on this proxy IP.');
      }

      if (await emailInput.isVisible() || await blockedText.isVisible()) {
        pageLoadedSuccessfully = true;
        break;
      }
    }

    if (!pageLoadedSuccessfully) {
      if (selectedProxy) {
        handleProxyFailure(selectedProxy, new Error('GITHUB_PAGE_LOAD_FAILED'), { force: true, service: 'github' });
      }
      throw new Error('Failed to load GitHub signup page correctly (timeout or WAF block).');
    }

    if (await blockedText.isVisible()) {
      console.log('\n======================================================================');
      console.log('[WAF CHALLENGE] DataDome CAPTCHA page detected!');

      const autoSolved = await solveDataDomeSlider(page, blockedText);
      if (autoSolved) {
        console.log('[WAF SOLVED] DataDome slider CAPTCHA auto-solved successfully!');
      } else {
        console.log('[WAF BLOCKED] Auto-solve failed or proxy IP flagged by DataDome. Removing proxy...');
        console.log('======================================================================\n');
        if (selectedProxy) {
          handleProxyFailure(selectedProxy, new Error('GITHUB_DATADOME_BLOCKED'), { force: true, service: 'github' });
        }
        throw new Error('Access is restricted by GitHub DataDome WAF on this proxy IP.');
      }
    } else if (!(await emailInput.isVisible())) {
      if (selectedProxy) {
        handleProxyFailure(selectedProxy, new Error('GITHUB_EMAIL_FIELD_MISSING'), { force: true, service: 'github' });
      }
      throw new Error('Timeout waiting for email input field. Page did not load correctly.');
    }

    // Ensure cookie banner is handled early before touching inputs
    console.log('Checking and dismissing cookie banner...');
    for (let i = 0; i < 3; i++) {
      await handleCookies(page, 800);
    }

    // Ensure the email input field is visible and settled (especially after WAF resolution)
    console.log('Waiting for email input to settle...');
    await Promise.race([
      emailInput.waitFor({ state: 'visible', timeout: 20000 }),
      page.locator('text=/Access is temporarily restricted/i').waitFor({ state: 'visible', timeout: 20000 }),
      page.locator('iframe[title*="CAPTCHA"], iframe[src*="captcha-delivery.com"]').waitFor({ state: 'visible', timeout: 20000 })
    ]).catch(() => {});

    const postWafBody = await page.innerText('body').catch(() => '');
    if (postWafBody.includes('Access is temporarily restricted')) {
      if (selectedProxy) {
        handleProxyFailure(selectedProxy, new Error('GITHUB_ACCESS_RESTRICTED'), { force: true, service: 'github' });
      }
      throw new Error('Access is temporarily restricted by GitHub on this proxy IP.');
    }

    if (!(await emailInput.isVisible().catch(() => false))) {
      await emailInput.waitFor({ state: 'visible', timeout: 5000 });
    }
    await sleep(1000);

    // Check if we are in the single-page layout or multi-step layout
    const pwdInput = page.locator('input#password, input[name="user[password]"], input[name="password"], input[type="password"]').first();
    const usernameInput = page.locator('input#login, input[name="user[login]"], input[name="login"], input[name="username"]').first();
    const createAccountBtn = page.locator('button:has-text("Create account")').first();

    // We are in single page if the create account button is visible, OR if both email and password inputs are visible at the same time
    const isCreateVisible = await createAccountBtn.isVisible().catch(() => false);
    const isPwdVisible = await pwdInput.isVisible().catch(() => false);
    const isSinglePage = isCreateVisible || isPwdVisible;

    function recordAlreadyRegisteredGithub(email, proxy) {
      try {
        const csvPath = CONFIG.outputFile;
        const cleanEmail = email.toLowerCase().trim();
        if (fs.existsSync(csvPath)) {
          const content = fs.readFileSync(csvPath, 'utf8');
          if (content.toLowerCase().includes(cleanEmail)) return;
        }
        const csvRow = [new Date().toISOString(), email, CONFIG.password, email.split('@')[0], proxy || 'direct'].map(csvCell).join(',') + '\n';
        if (!fs.existsSync(csvPath)) {
          fs.writeFileSync(csvPath, 'timestamp,email,password,username,proxy\n' + csvRow, 'utf8');
        } else {
          fs.appendFileSync(csvPath, csvRow, 'utf8');
        }
        console.log(`  [CSV] Saved already-registered account ${email} to ${csvPath}`);
      } catch (err) {
        console.error(`  [WARN] Failed to write already-registered email to CSV: ${err.message}`);
      }
    }

    async function checkEmailAlreadyTaken(page, email, proxy) {
      await sleep(1500);
      const bodyText = await page.innerText('body').catch(() => '');
      const hasTakenText = bodyText.includes('already associated with an account') ||
        bodyText.includes('Email is invalid or already taken') ||
        bodyText.includes('already taken');
      const noticeVisible = await page.locator('text=/already associated with an account|already taken/i').first().isVisible().catch(() => false);

      if (hasTakenText || noticeVisible) {
        console.log(`\n  ⚠️ [ALREADY REGISTERED] Email ${email} is already registered on GitHub!`);
        recordAlreadyRegisteredGithub(email, proxy);
        return true;
      }
      return false;
    }

    if (isSinglePage) {
      console.log('Detected single-page signup layout. Filling all fields...');

      // Step 2: Fill Email
      console.log('  Filling email...');
      await typeHumanDirect(emailInput, email);
      await sleep(1000);

      // Check if email is already registered on GitHub
      if (await checkEmailAlreadyTaken(page, email, selectedProxy)) {
        throw new Error('EMAIL_ALREADY_REGISTERED');
      }

      // Step 3: Fill Password
      console.log('  Filling password...');
      await typeHumanDirect(pwdInput, CONFIG.password);
      await sleep(1000);

      // Step 4: Fill Username
      console.log('  Filling username...');
      await typeHumanDirect(usernameInput, username);
      await usernameInput.dispatchEvent('input').catch(() => { });
      await usernameInput.dispatchEvent('change').catch(() => { });
      await usernameInput.dispatchEvent('blur').catch(() => { });
      await sleep(1000);

      // Handle Country/Region select if present (Crucial: avoids Russia/Belarus sanctions disable)
      await handleCountrySelection(page);
      await sleep(1000);

      // Uncheck GitHub Copilot opt-in if present
      const copilotCb = page.locator('input[name*="copilot" i], input[id*="copilot" i], label:has-text("Copilot") input').first();
      if (await copilotCb.isVisible().catch(() => false)) {
        console.log('  Unchecking GitHub Copilot free signup option...');
        const isChecked = await copilotCb.isChecked().catch(() => false);
        if (isChecked) {
          await copilotCb.uncheck().catch(() => { });
        }
      }
      await sleep(500);

      // Handle updates checkbox (uncheck if checked)
      console.log('  Handling updates checkbox...');
      const optInCb = page.locator('input#opt_in, input[name="opt_in"]').first();
      if (await optInCb.isVisible().catch(() => false)) {
        const isChecked = await optInCb.isChecked().catch(() => false);
        if (isChecked) {
          await optInCb.uncheck().catch(() => { });
        }
      }
      await sleep(500);

      // Safety Check: Ensure all fields have values before submitting
      const currentEmail = await emailInput.inputValue().catch(() => '');
      if (!currentEmail) {
        console.log('  [Safety] Re-filling email...');
        await typeHumanDirect(emailInput, email);
        await sleep(500);
      }
      const currentPwd = await pwdInput.inputValue().catch(() => '');
      if (!currentPwd) {
        console.log('  [Safety] Re-filling password...');
        await typeHumanDirect(pwdInput, CONFIG.password);
        await sleep(500);
      }
      const currentUsername = await usernameInput.inputValue().catch(() => '');
      if (!currentUsername) {
        console.log('  [Safety] Re-filling username...');
        await typeHumanDirect(usernameInput, username);
        await sleep(500);
      }

      // Trigger blur/tab to ensure form validation settles
      await page.keyboard.press('Tab').catch(() => { });
      await sleep(1000);

      // Check if Create account button is enabled
      const createAccountBtn = page.locator('button:has-text("Create account"), button.signup-form-fields__button, button[type="submit"]:has-text("Create account")').first();
      await createAccountBtn.waitFor({ state: 'visible', timeout: 10000 });

      let isEnabled = await createAccountBtn.isEnabled().catch(() => false);
      if (!isEnabled) {
        console.log('  Create account button currently disabled. Re-checking country selection and field validation...');
        await handleCountrySelection(page);
        await usernameInput.focus().catch(() => { });
        await usernameInput.dispatchEvent('blur').catch(() => { });
        await sleep(2000);
        isEnabled = await createAccountBtn.isEnabled().catch(() => false);
      }

      // If button is still disabled, check if proxy country is restricted by US compliance/sanctions
      if (!isEnabled) {
        const pageText = await page.innerText('body').catch(() => '');
        if (/compliance reasons|restricted country|not available in your region|sanctions/i.test(pageText)) {
          if (selectedProxy) {
            handleProxyFailure(selectedProxy, new Error('GITHUB_COUNTRY_RESTRICTED'), { force: true, service: 'github' });
          }
          throw new Error('GitHub account creation restricted for this proxy country / IP.');
        }

        console.log('  [Notice] Enabling button and clicking with force fallback...');
        await page.evaluate(() => {
          const btn = document.querySelector('button.signup-form-fields__button, button[type="submit"]');
          if (btn) {
            btn.removeAttribute('disabled');
            btn.disabled = false;
          }
        }).catch(() => { });
      }

      // Click Create account
      console.log('  Clicking Create account button...');
      await createAccountBtn.click({ force: true, timeout: 10000 }).catch(async () => {
        await page.evaluate(() => {
          const form = document.querySelector('form[action*="signup"], form');
          if (form) form.requestSubmit();
        }).catch(() => { });
      });
      await sleep(2000);

      // Double click check: if button is still visible (pending validation), click it again
      if (await createAccountBtn.isVisible().catch(() => false)) {
        console.log('  Button is still visible (possibly pending validation). Clicking again...');
        await createAccountBtn.click({ force: true, timeout: 5000 }).catch(() => { });
      }
      await sleep(3000);

      // Solve CAPTCHA if it appears after submission
      console.log('  Checking for Arkose CAPTCHA...');
      await handleCaptchaIfPresent(page, 'GitHub Registration', 10000);
      await sleep(2000);

      // Check if restricted page appeared
      const postSubmitBody = await page.innerText('body').catch(() => '');
      if (postSubmitBody.includes('Access is temporarily restricted')) {
        if (selectedProxy) {
          handleProxyFailure(selectedProxy, new Error('GITHUB_ACCESS_RESTRICTED'), { force: true, service: 'github' });
        }
        throw new Error('Access is temporarily restricted by GitHub DataDome WAF on this proxy IP.');
      }

      if (postSubmitBody.includes('Too many requests') || postSubmitBody.includes('secondary rate limit')) {
        console.log('\n======================================================================');
        console.log('[RATE LIMIT] GitHub secondary rate limit exceeded post-submit. Removing proxy...');
        console.log('======================================================================\n');
        if (selectedProxy) {
          handleProxyFailure(selectedProxy, new Error('GITHUB_RATE_LIMIT_EXCEEDED'), { force: true, service: 'github' });
        }
        throw new Error('GitHub rate limit exceeded post-submit on this proxy IP.');
      }

    } else {
      console.log('Detected multi-step signup layout.');

      // Step 2: Enter Email
      console.log('[2/6] Entering email...');
      await sleep(1000);
      await typeHumanDirect(emailInput, email);
      await sleep(1500);

      // Check if email is already registered on GitHub
      if (await checkEmailAlreadyTaken(page, email, selectedProxy)) {
        throw new Error('EMAIL_ALREADY_REGISTERED');
      }

      // Click Continue
      const emailContinueBtn = page.locator('#email-container button').first();
      await emailContinueBtn.click();
      await sleep(1000);

      // Step 3: Enter Password
      console.log('[3/6] Entering password...');
      await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
      await sleep(1000);
      await typeHumanDirect(pwdInput, CONFIG.password);
      await sleep(1500);

      // Click Continue
      const pwdContinueBtn = page.locator('#password-container button').first();
      await pwdContinueBtn.click();
      await sleep(1000);

      // Step 4: Enter Username
      console.log('[4/6] Entering username...');
      const usernameInput = page.locator('input#login, input[name="user[login]"]').first();
      await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
      await sleep(1000);
      await typeHumanDirect(usernameInput, username);
      await sleep(1500);

      // Click Continue
      const usernameContinueBtn = page.locator('#username-container button').first();
      await usernameContinueBtn.click();
      await sleep(1000);

      // Optional Step 5: Product Updates Opt-in
      console.log('[5/6] Handling updates option...');
      const optInInput = page.locator('input#opt_in, input[name="opt_in"]').first();
      if (await optInInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await typeHumanDirect(optInInput, 'n');
        await sleep(1000);
        const optInContinueBtn = page.locator('#opt-in-container button').first();
        optInContinueBtn.click();
        await sleep(1000);
      }

      // Step 6: CAPTCHA and Submit
      console.log('[6/6] Solving CAPTCHA and creating account...');
      await handleCaptchaIfPresent(page, 'GitHub Registration', 10000);
      await sleep(1000);

      const createAccountBtn = page.locator('button:has-text("Create account")').first();
      await createAccountBtn.waitFor({ state: 'visible', timeout: 5000 });

      const btnBox = await createAccountBtn.boundingBox().catch(() => null);
      if (btnBox) {
        console.log(`  Moving mouse to Create account button at (${btnBox.x + btnBox.width / 2}, ${btnBox.y + btnBox.height / 2})...`);
        const targetX = btnBox.x + btnBox.width / 2 + rand(-5, 5);
        const targetY = btnBox.y + btnBox.height / 2 + rand(-2, 2);

        // Human-like mouse move
        await page.mouse.move(targetX, targetY, { steps: rand(10, 20) });
        await sleep(rand(200, 450));
        await page.mouse.click(targetX, targetY);
      } else {
        await createAccountBtn.click();
      }
    }

    // Step 7: Verification OTP code
    console.log('Waiting for verification code page...');
    const otpInputs = page.locator('input[type="text"], input[type="number"], input[inputmode="numeric"], input:not([type="hidden"])').filter({ visible: true });
    await otpInputs.first().waitFor({ state: 'visible', timeout: 35000 });
    await sleep(2000);

    console.log('Retrieving verification OTP...');
    let otp;
    const maxResendRetries = 2;

    for (let resendAttempt = 0; resendAttempt <= maxResendRetries; resendAttempt++) {
      const waitTimeout = (resendAttempt === 0) ? 35000 : 75000;

      if (resendAttempt > 0) {
        console.log(`  [OTP NOT FOUND] Clicking "Resend the code" (Attempt ${resendAttempt}/${maxResendRetries})...`);
        try {
          let resendClicked = false;
          const candidateLocators = [
            page.getByRole('button', { name: /resend the code/i }),
            page.getByRole('link', { name: /resend the code/i }),
            page.getByText(/^Resend the code$/i),
            page.getByText(/resend the code/i),
            page.locator('button:has-text("Resend the code")'),
            page.locator('a:has-text("Resend the code")'),
            page.locator('[role="button"]:has-text("Resend the code")'),
            page.getByRole('button', { name: /resend/i }),
            page.getByRole('link', { name: /resend/i }),
            page.locator('button:has-text("Send a new code"), a:has-text("Send a new code")'),
            page.locator('button:has-text("Send code again"), a:has-text("Send code again")'),
            page.locator('button:has-text("Resend"), a:has-text("Resend")'),
            page.locator('text=/resend (the )?code/i'),
          ];

          for (const loc of candidateLocators) {
            try {
              const count = await loc.count().catch(() => 0);
              for (let i = 0; i < count; i++) {
                const el = loc.nth(i);
                if (await el.isVisible().catch(() => false)) {
                  console.log('  [Resend] Found visible resend element. Clicking...');
                  await el.scrollIntoViewIfNeeded().catch(() => { });

                  const box = await el.boundingBox().catch(() => null);
                  if (box && box.width > 0 && box.height > 0) {
                    const clickX = box.x + box.width / 2;
                    const clickY = box.y + box.height / 2;
                    await page.mouse.move(clickX, clickY, { steps: 5 });
                    await sleep(100);
                    await page.mouse.click(clickX, clickY);
                  } else {
                    await el.click({ force: true, timeout: 3000 });
                  }

                  resendClicked = true;
                  break;
                }
              }
              if (resendClicked) break;
            } catch (_) { }
          }

          if (!resendClicked) {
            console.log('  [Resend] Locators did not match, evaluating DOM elements directly...');
            resendClicked = await page.evaluate(() => {
              const elements = Array.from(document.querySelectorAll('a, button, [role="button"], span, p, div'));
              for (const el of elements) {
                const text = (el.innerText || el.textContent || '').trim();
                if (/resend the code/i.test(text) || (/^resend\b/i.test(text) && text.length < 35)) {
                  const target = el.closest('button, a, [role="button"]') || el;
                  target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                  if (typeof target.click === 'function') target.click();
                  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  return true;
                }
              }
              return false;
            }).catch(() => false);
          }

          if (resendClicked) {
            console.log('  [Resend] Resend link/button clicked successfully.');
            await sleep(4000);
          } else {
            console.log('  [Resend] Resend button/link not visible or found.');
          }
        } catch (resendErr) {
          console.log(`  [Resend ERROR] Failed to resend code: ${resendErr.message}`);
        }
      }

      console.log(`  Retrieving verification OTP (Attempt ${resendAttempt + 1}/${maxResendRetries + 1}, Timeout: ${Math.round(waitTimeout / 1000)}s)...`);
      if (emailMode === 'outlook') {
        otp = await waitForOtp({
          mode: 'outlook',
          email,
          account: outlookAccount,
          timeout: waitTimeout,
          interval: 3000,
          since: Date.now() - 60000,
          disableWebFallback: (resendAttempt === 0), // Enable web fallback if first API check fails
        });
      } else {
        otp = await tempmail.waitForOtp(email, waitTimeout, 5000, Date.now() - 60000);
      }

      if (otp) break;
    }

    if (!otp) {
      throw new Error('Failed to retrieve GitHub verification code from email.');
    }
    console.log(`Retrieved OTP Code: ${otp}`);

    let otpFilled = false;
    const inputCount = await otpInputs.count().catch(() => 0);
    if (inputCount >= 6) {
      console.log(`Split OTP inputs detected (${inputCount}). Filling digit by digit...`);
      for (let i = 0; i < Math.min(inputCount, otp.length); i++) {
        await otpInputs.nth(i).focus();
        await otpInputs.nth(i).fill(otp[i]);
        await sleep(150);
      }
      otpFilled = true;
    } else if (inputCount > 0) {
      console.log('Single OTP input field detected. Filling whole code...');
      const firstInput = otpInputs.first();
      await firstInput.focus();
      await firstInput.fill(otp);
      otpFilled = true;
    }

    if (!otpFilled) {
      throw new Error('Failed to locate any valid OTP input fields.');
    }
    await sleep(1500);

    // Save account credentials immediately upon successful OTP filling
    saveAccountCredentials(email, username, selectedProxy);

    // Step 7b: Post-OTP check (Handle login page, or post-OTP username/password entry if prompted)
    console.log('Checking post-OTP page status...');
    await sleep(2000);

    // If redirected to login page or login fields are immediately visible
    if (page.url().includes('/login') || await page.locator('input#login_field').first().isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Redirected to GitHub login page after OTP verification.');
      await loginIfRequired(page, username, CONFIG.password);
    } else {
      // Check if username/password continuation step is present
      const postPwdInput = page.locator('input#password, input[name="user[password]"]').first();
      const postLoginInput = page.locator('input#login, input[name="user[login]"]').first();
      const isPostPwdVisible = await postPwdInput.isVisible({ timeout: 1500 }).catch(() => false);
      const isPostLoginVisible = await postLoginInput.isVisible({ timeout: 1500 }).catch(() => false);

      if (isPostPwdVisible || isPostLoginVisible) {
        console.log('Detected post-OTP credential form...');
        if (isPostLoginVisible) {
          console.log(`  Filling username: ${username}`);
          await typeHumanDirect(postLoginInput, username);
          await sleep(500);
        }
        if (isPostPwdVisible) {
          console.log('  Filling password...');
          await typeHumanDirect(postPwdInput, CONFIG.password);
          await sleep(500);
        }
        const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Create account"), button[type="submit"]').first();
        if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await continueBtn.click();
          await sleep(2500);
        }
      }
    }

    // Wait for the user registration to finish and redirect to dashboard, home, or login success page
    console.log('Waiting for dashboard/login redirection...');
    await page.waitForURL(url => url.hostname === 'github.com' && !url.pathname.includes('signup'), { timeout: 45000 }).catch(() => { });
    await page.waitForLoadState('domcontentloaded').catch(() => { });

    // If redirected to /login after signup completion, log in now
    if (page.url().includes('/login') || await page.locator('input#login_field').first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await loginIfRequired(page, username, CONFIG.password);
    }

    // Wait until either the success banner, dashboard element, or user avatar is visible
    const successMsg = page.locator('div, p, span, h1, h2').filter({ hasText: /Your account was created successfully/i }).first();
    const dashboardCheck = page.locator('a[href="/dashboard"], a[href="/logout"], button[aria-label*="user" i], img.avatar, [data-login]').first();

    console.log('Waiting for landing page to render success message or dashboard...');
    await Promise.race([
      successMsg.waitFor({ state: 'visible', timeout: 10000 }).catch(() => { }),
      dashboardCheck.waitFor({ state: 'visible', timeout: 10000 }).catch(() => { })
    ]);

    // Check verification success (dashboard URL, onboarding, new repo, or avatar/dashboard elements)
    const currentUrl = page.url();
    const isDashboardUrl = currentUrl.includes('/dashboard') || currentUrl === 'https://github.com/' || currentUrl === 'https://github.com';
    const isSuccessMsgVisible = await successMsg.isVisible().catch(() => false);
    const isDashboard = await dashboardCheck.isVisible().catch(() => false);
    const isOnboarding = currentUrl.includes('/getting-started') || currentUrl.includes('/welcome') || currentUrl.includes('/getting_started') || currentUrl.includes('/onboarding');
    const isNewPage = currentUrl.includes('/new');
    const isVerifiedSuccess = isDashboardUrl || isDashboard || isOnboarding || isNewPage || isSuccessMsgVisible || (currentUrl.includes('github.com') && !currentUrl.includes('/signup') && !currentUrl.includes('/login'));

    console.log(`  [Verification Debug] URL: ${currentUrl}`);
    console.log(`  [Verification Debug] Checks: isDashboardUrl=${isDashboardUrl}, isDashboard=${isDashboard}, isOnboarding=${isOnboarding}, isSuccessMsgVisible=${isSuccessMsgVisible}`);

    if (isVerifiedSuccess) {
      console.log('GitHub Account Registered & Verified Successfully!');

      // Step 8: Initialize a dummy repository with README
      await createDummyRepo(page, username);

      if (keepOpen) {
        return { browser, context, page, email, username, tempProfileDir };
      }
      return { email, username };
    } else {
      throw new Error('Registration completed but redirected to an unverified page: ' + page.url());
    }

  } catch (err) {
    errorOccurred = true;
    if (err.message === 'EMAIL_ALREADY_REGISTERED') {
      console.log('  [SKIP] Moving to the next email account.\n');
      throw err;
    }

    console.error('  [ERROR] GitHub Registration failed:', err.message);

    // Self-healing: comment out dead/blocked proxy in http_proxies.txt
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err, { service: 'github' });
    }

    if (process.env.DISABLE_SCREENSHOTS !== 'true') {
      const screenshotDir = fs.existsSync('/app/screenshots') ? '/app/screenshots' : __dirname;
      const errScreenshot = path.join(screenshotDir, `github_error_${Date.now()}.png`);
      await page.screenshot({ path: errScreenshot }).catch(() => { });
      console.log(`  Screenshot saved to ${errScreenshot}`);
    }
    throw err;
  } finally {
    if (!keepOpen || errorOccurred) {
      if (context) {
        try {
          await Promise.race([
            context.close().catch(() => {}),
            new Promise(r => setTimeout(r, 3000))
          ]);
        } catch (_) {}
      }
      if (browser && typeof browser.close === 'function') {
        try {
          await Promise.race([
            browser.close().catch(() => {}),
            new Promise(r => setTimeout(r, 3000))
          ]);
        } catch (_) {}
      }
      if (tempProfileDir) {
        try {
          if (fs.existsSync(tempProfileDir)) {
            fs.rmSync(tempProfileDir, { recursive: true, force: true });
          }
        } catch (_) { }
      }
    }
  }
}

if (require.main === module) {
  register()
    .then(() => {
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal execution error:', err.message);
      setTimeout(() => process.exit(1), 500);
    });
}

module.exports = { register, CONFIG };
