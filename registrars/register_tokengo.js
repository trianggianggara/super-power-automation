const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBrowserExecutablePath, envFlag } = require('../utils/browser.js');
const { sleep, rand, handleCookies } = require('../utils/helpers.js');

const CONFIG = {
  extensionPath: '/home/nbs59/.config/google-chrome/Profile 27/Extensions/gkojfkhlekighikafcpjkiklfbnlmeio/1.255.748_0',
  browserExecutablePath: '/home/nbs59/.local/share/brave-bin/opt/brave.com/brave/brave',
  password: process.env.TOKENGO_PASSWORD || 'PortoAuto2025!',
  affCode: process.env.TOKENGO_AFF || 'ovod',
  outputFile: path.join(__dirname, '..', 'data', 'tokengo.csv'),
  keysFile: path.join(__dirname, '..', 'data', 'keys.csv'),
  launchTimeout: Number(process.env.LAUNCH_TIMEOUT_MS || 60000),
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 120000),
};

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[97m',
  gray: '\x1b[90m',
};

function log(msg) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`${C.gray}[${timestamp}]${C.reset} ${msg}`);
}

function randUser() {
  const f = ['alex','sam','jordan','taylor','morgan','casey','riley','jamie','drew','quinn','sage','river','sky','wren','finn','nova','echo','wolf','jade','kai'];
  const l = ['dev','code','tech','ai','ml','app','bot','net','cloud','data','flux','byte','pixel','logic','sync','mesh','node','edge','core','base'];
  const hex = crypto.randomBytes(4).toString('hex').slice(0, 4);
  return f[Math.floor(Math.random() * f.length)] + '_' + l[Math.floor(Math.random() * l.length)] + hex;
}

function ensureHolaAuth(threadIndex) {
  const tempProfileDir = path.join(__dirname, `.chrome_profile_tokengo_persistent_${threadIndex}`);
  
  const localDest = path.join(tempProfileDir, 'Default', 'Local Extension Settings', 'gkojfkhlekighikafcpjkiklfbnlmeio');
  const indexDest = path.join(tempProfileDir, 'Default', 'IndexedDB', 'chrome-extension_gkojfkhlekighikafcpjkiklfbnlmeio_0.indexeddb.leveldb');
  
  const localSrc = '/home/nbs59/.config/google-chrome/Profile 27/Local Extension Settings/gkojfkhlekighikafcpjkiklfbnlmeio';
  const indexSrc = '/home/nbs59/.config/google-chrome/Profile 27/IndexedDB/chrome-extension_gkojfkhlekighikafcpjkiklfbnlmeio_0.indexeddb.leveldb';

  function copyFolderSync(from, to) {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from).forEach(element => {
      const stat = fs.lstatSync(path.join(from, element));
      if (stat.isFile()) {
        fs.copyFileSync(path.join(from, element), path.join(to, element));
      } else if (stat.isDirectory()) {
        copyFolderSync(path.join(from, element), path.join(to, element));
      }
    });
  }

  copyFolderSync(localSrc, localDest);
  copyFolderSync(indexSrc, indexDest);
}

async function configureVPN(context, country) {
  log(`Connecting to Hola VPN with country: ${country}...`);
  const sw = context.serviceWorkers()[0];
  if (!sw) {
    throw new Error('Hola VPN background service worker not found!');
  }

  const countryMap = {
    'switzerland': 'ch',
    'germany': 'de',
    'brazil': 'br',
    'argentina': 'ar',
    'france': 'fr',
    'united kingdom': 'gb',
    'singapore': 'sg',
    'united states': 'us',
    'canada': 'ca',
    'australia': 'au',
    'japan': 'jp',
    'italy': 'it',
    'spain': 'es',
    'netherlands': 'nl',
    'indonesia': 'id',
    'india': 'in',
    'malaysia': 'my',
    'vietnam': 'vn',
    'thailand': 'th',
    'philippines': 'ph',
    'south korea': 'kr',
    'mexico': 'mx'
  };
  const code = countryMap[country.toLowerCase()] || country.toLowerCase();

  // Find the target tab ID from extension service worker context
  const targetTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(t => t.url && t.url.includes('tokengo.com')) || tabs.find(t => t.active);
    return target ? target.id : null;
  });

  if (!targetTabId) {
    log('  [WARN] TokenGO target tab not found in browser yet.');
    return;
  }

  // Set the VPN country programmatically in the background Service Worker for the specific tab ID
  log(`  Setting country ${country} (${code}) in Service Worker for tab ID ${targetTabId}...`);
  const vpnResult = await sw.evaluate(async ({ code, tabId }) => {
    try {
      be_bg_main.be_ext.set('enabled', true);
      if (be_bg_main.be_vpn.set_enabled) {
        await be_bg_main.be_vpn.set_enabled(true);
      }
      // Configure root url unblocker rule for tokengo.com to ensure extension turns ON
      if (be_bg_main.be_vpn.enable_root_url) {
        await be_bg_main.be_vpn.enable_root_url({
          country: code.toLowerCase(),
          root_url: 'tokengo.com'
        });
      }
      // Also apply browser country for the specific tab ID
      const res = await be_bg_main.be_vpn.set_browser_country({
        country: code.toLowerCase(),
        tab_id: tabId,
        src: 'popup'
      });
      return { success: true, res };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }, { code, tabId: targetTabId });

  if (!vpnResult.success) {
    throw new Error(`Failed to configure VPN via SW API: ${vpnResult.error}`);
  }
  
  log(`  Successfully connected VPN to ${country} (${code}) for target tab.`);
}


async function clickTurnstileCheckbox(page) {
  try {
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    if (await turnstileIframe.isVisible().catch(() => false)) {
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
      const selectors = [
        'input[type="checkbox"]',
        '#challenge-stage',
        '.ct-checkbox',
        '#cf-stage',
        '.mark',
        'body'
      ];
      for (const sel of selectors) {
        const checkbox = frame.locator(sel).first();
        if (await checkbox.isVisible({ timeout: 500 }).catch(() => false)) {
          await checkbox.click({ force: true }).catch(() => {});
          log(`  Auto-clicked Turnstile checkbox element: ${sel}`);
          return true;
        }
      }
    }
  } catch (err) {
    log(`  [WARN] Error clicking Turnstile checkbox: ${err.message}`);
  }
  return false;
}

async function handleTurnstile(page, timeoutMs = 60000) {
  try {
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    const hasTurnstile = await turnstileIframe.isVisible({ timeout: 2000 }).catch(() => false);
    if (!hasTurnstile) {
      return true;
    }
  } catch (e) {
    return true;
  }

  log('Cloudflare Turnstile challenge detected. Solving...');
  const deadline = Date.now() + timeoutMs;
  let clickedCheckbox = false;
  while (Date.now() < deadline) {
    const token = await page.evaluate(() => {
      const els = [
        document.querySelector('[name="cf-turnstile-response"]'),
        document.querySelector('[id*="cf-turnstile-response"]'),
      ];
      for (const el of els) {
        if (el && el.value && el.value.length > 0) return el.value;
      }
      return '';
    }).catch(() => '');

    if (token && token.length > 0) {
      log('  Turnstile solved!');
      return true;
    }

    if (!clickedCheckbox) {
      const clicked = await clickTurnstileCheckbox(page);
      if (clicked) {
        clickedCheckbox = true;
        await sleep(3000);
      }
    }

    await sleep(2000);
  }
  return false;
}

async function register() {
  log(`${C.bold}${C.white}=== TokenGO Hybrid Browser-API Registration ===${C.reset}`);
  
  const threadIndex = process.env.THREAD_INDEX || '0';
  
  // Isolate XDG config to prevent conflicts with desktop Brave browser instance
  process.env.XDG_CONFIG_HOME = path.join(__dirname, `.xdg_config_tokengo_${threadIndex}`);
  log(`XDG_CONFIG_HOME redirected to: ${process.env.XDG_CONFIG_HOME}`);

  let browser;
  let context;
  let page;
  let stepTimer;
  
  function armStep(label, timeoutMs = CONFIG.stepTimeout) {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      console.error(`  TIMEOUT: ${label} stuck > ${Math.round(timeoutMs / 1000)}s. Closing browser, exiting...`);
      const forceExit = setTimeout(() => process.exit(1), 5000);
      if (forceExit.unref) forceExit.unref();
      Promise.resolve(browser?.close()).catch(() => {}).finally(() => process.exit(1));
    }, timeoutMs);
  }

  armStep('[1/10] Launching browser', CONFIG.launchTimeout);
  const executablePathToUse = CONFIG.browserExecutablePath;
  
  log('Ensuring authenticated session for Hola VPN...');
  ensureHolaAuth(threadIndex);
  
  const tempProfileDir = path.join(__dirname, `.chrome_profile_tokengo_persistent_${threadIndex}`);
  
  // Clean up stale singleton symlinks/files directly
  ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].forEach(file => {
    try {
      fs.rmSync(path.join(tempProfileDir, file), { force: true });
    } catch (_) {}
  });

  log(`Browser: ${executablePathToUse}`);
  log(`Profile path: ${tempProfileDir}`);

  const contextOpts = {
    headless: envFlag('HEADLESS', false),
    executablePath: executablePathToUse,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${CONFIG.extensionPath}`,
      `--load-extension=${CONFIG.extensionPath}`,
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-process-singleton',
    ],
  };

  context = await chromium.launchPersistentContext(tempProfileDir, contextOpts);
  
  // Wait for Service Worker registration
  log('Waiting for Hola VPN background Service Worker...');
  let sw = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    sw = context.serviceWorkers()[0];
    if (sw) break;
    await sleep(500);
  }
  if (!sw) {
    throw new Error('Hola VPN background Service Worker failed to register.');
  }
  log('Service Worker is ready.');

  browser = {
    close: async () => {
      await context.close().catch(() => {});
    }
  };

  // Get the primary page and ensure it is the ONLY tab/page open
  const pages = context.pages();
  page = pages.length > 0 ? pages[0] : await context.newPage();
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }

  // Bypass window.close to prevent extension popup from closing the main tab
  await page.addInitScript(() => {
    window.close = () => { console.log('Bypassed window.close()'); };
  });

  // Boot the Hola extension models once by loading the popup in the primary tab
  log('Booting Hola VPN extension...');
  try {
    await page.goto('chrome-extension://gkojfkhlekighikafcpjkiklfbnlmeio/js/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (_) {}
  await sleep(2000);
  
  const username = randUser();
  const password = CONFIG.password;
  const affCode = CONFIG.affCode;
  
  log(`Account Info:`);
  log(`  - Username: ${C.green}${username}${C.reset}`);
  log(`  - Password: ${C.green}${password}${C.reset}`);
  log(`  - Aff/Ref:  ${C.green}${affCode || '(none)'}${C.reset}`);

  try {
    // Define VPN countries for rotation
    const VPN_COUNTRIES = [
      'Switzerland', 'Germany', 'Brazil', 'Argentina', 'France', 'United Kingdom', 'Singapore',
      'United States', 'Canada', 'Australia', 'Japan', 'Italy', 'Spain', 'Netherlands',
      'Indonesia', 'India', 'Malaysia', 'Vietnam', 'Thailand', 'Philippines', 'South Korea', 'Mexico'
    ];
    let countryIndex = 0;
    let currentCountry = VPN_COUNTRIES[countryIndex];

    // Step 1: Open TokenGO Sign-up Page first to establish the web origin context in the tab
    armStep('[2/10] Establishing target page context', 60000);
    log('Opening dashboard.tokengo.com sign-up page...');
    try {
      await page.goto('https://dashboard.tokengo.com/sign-up', { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      log(`  [INFO] Initial page.goto threw: ${err.message}. Continuing...`);
    }
    await sleep(2000);

    // Step 2: Configure Hola VPN connection for this web tab ID
    armStep('[3/10] Configuring VPN connection', 90000);
    await configureVPN(context, currentCountry);
    await sleep(5000);

    // Step 3: Reload the page to route the tab traffic through the VPN
    log('Reloading page to route through VPN...');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      log(`  [INFO] page.reload threw: ${err.message}. Checking page URL...`);
      await sleep(2000);
      const curUrl = page.url();
      log(`  Current page URL: ${curUrl}`);
      if (!curUrl.includes('tokengo.com')) {
        throw err;
      }
    }
    await sleep(1500);
    await handleCookies(page);
    await handleTurnstile(page, 60000);
    await sleep(500);

    // Step 4: Execute Registration via Page Console Fetch with Country/IP Rotation on Rate Limit/429
    let regSuccess = false;
    let regResult;
    
    while (!regSuccess && countryIndex < VPN_COUNTRIES.length) {
      armStep(`[5/10] Executing register payload inside console (${currentCountry})`, 60000);
      log(`Executing API registration call in browser console using VPN: ${currentCountry}...`);
      
      regResult = await page.evaluate(async ({ username, password, affCode }) => {
        try {
          const res = await fetch('/api/user/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, aff_code: affCode })
          });
          const text = await res.text();
          let body = null;
          try { body = JSON.parse(text); } catch (_) {}
          return { status: res.status, text, body };
        } catch (err) {
          return { error: err.message };
        }
      }, { username, password, affCode });

      if (regResult.error) {
        log(`[WARN] Browser console registration request failed: ${regResult.error}`);
      } else {
        log(`  Registration Status: ${regResult.status}`);
        log(`  Registration Response Text: ${regResult.text}`);
      }

      if (!regResult.error && regResult.status === 200 && regResult.body && regResult.body.success) {
        regSuccess = true;
        log(`  ${C.green}Registration successful on ${currentCountry}!${C.reset}`);
      } else {
        // Registration failed or hit 429 rate limit / blocker
        countryIndex++;
        if (countryIndex < VPN_COUNTRIES.length) {
          currentCountry = VPN_COUNTRIES[countryIndex];
          log(`[WARN] Registration failed or rate limited (Status ${regResult.status}). Rotating VPN to: ${currentCountry}...`);
          
          // Connect to next country
          try {
            await configureVPN(context, currentCountry);
          } catch (vpnErr) {
            log(`[ERROR] Failed to switch VPN to ${currentCountry}: ${vpnErr.message}`);
          }
          await sleep(5000);
          
          // Re-navigate to target page context to ensure clean session/IP routing
          log('Re-establishing target page context...');
          try {
            await page.goto('https://dashboard.tokengo.com/sign-up', { waitUntil: 'domcontentloaded', timeout: 45000 });
          } catch (err) {
            log(`  [INFO] page.goto threw during rotation: ${err.message}. Checking page URL...`);
            await sleep(2000);
            const curUrl = page.url();
            log(`  Current page URL: ${curUrl}`);
            if (!curUrl.includes('tokengo.com')) {
              throw err;
            }
          }
          await sleep(1500);
          await handleCookies(page);
          await handleTurnstile(page, 60000);
          await sleep(500);
        } else {
          throw new Error(`All VPN countries exhausted. Registration failed: ${regResult.body ? regResult.body.message : 'Invalid response body'}`);
        }
      }
    }
    await sleep(500);

    // Post-registration API calls block (Login -> Key Creation -> List -> Unmask) with Country/IP Rotation on failure
    let postSuccess = false;
    let apiKey;
    
    while (!postSuccess && countryIndex < VPN_COUNTRIES.length) {
      try {
        // Step 5: Execute Login via Page Console Fetch to establish cookie session
        armStep(`[6/10] Executing login payload inside console (${currentCountry})`, 60000);
        log(`Executing API login call in browser console using VPN: ${currentCountry}...`);
        const loginResult = await page.evaluate(async ({ username, password }) => {
          try {
            const res = await fetch('/api/user/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });
            const text = await res.text();
            let body = null;
            try { body = JSON.parse(text); } catch (_) {}
            return { status: res.status, text, body };
          } catch (err) {
            return { error: err.message };
          }
        }, { username, password });

        if (loginResult.error) {
          throw new Error(`Browser console login request failed: ${loginResult.error}`);
        }
        log(`  Login Status: ${loginResult.status}`);
        log(`  Login Response Text: ${loginResult.text}`);

        if (loginResult.status !== 200 || !loginResult.body || !loginResult.body.success) {
          throw new Error(`Login API failed (Status ${loginResult.status}): ${loginResult.body ? loginResult.body.message : 'Invalid response body'}`);
        }

        const uid = loginResult.body.data.id;
        log(`  ${C.green}Logged in successfully! UID: ${uid}${C.reset}`);
        await sleep(500);

        // Step 6: Create API key via Page Console Fetch
        armStep(`[7/10] Creating API key inside console (${currentCountry})`, 60000);
        log('Executing API key creation in browser console...');
        const createResult = await page.evaluate(async ({ uid }) => {
          try {
            const res = await fetch('/api/token/', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'LLMAPI-User': String(uid)
              },
              body: JSON.stringify({
                name: 'auto',
                expired_time: -1,
                remain_quota: 0,
                unlimited_quota: true,
                group: 'default'
              })
            });
            const text = await res.text();
            let body = null;
            try { body = JSON.parse(text); } catch (_) {}
            return { status: res.status, text, body };
          } catch (err) {
            return { error: err.message };
          }
        }, { uid });

        if (createResult.error) {
          throw new Error(`Browser console key creation request failed: ${createResult.error}`);
        }
        log(`  Key Creation Status: ${createResult.status}`);
        log(`  Key Creation Response Text: ${createResult.text}`);

        if (createResult.status !== 200 || !createResult.body || !createResult.body.success) {
          throw new Error(`Key creation API failed (Status ${createResult.status}): ${createResult.body ? createResult.body.message : 'Invalid response body'}`);
        }
        log(`  ${C.green}Key placeholder created successfully!${C.reset}`);
        await sleep(500);

        // Step 7: Retrieve Token List to get key item ID
        armStep(`[8/10] Retrieving token ID inside console (${currentCountry})`, 60000);
        log('Executing token list fetch in browser console...');
        const listResult = await page.evaluate(async ({ uid }) => {
          try {
            const res = await fetch('/api/token/?page=1&page_size=20', {
              method: 'GET',
              headers: {
                'LLMAPI-User': String(uid)
              }
            });
            const text = await res.text();
            let body = null;
            try { body = JSON.parse(text); } catch (_) {}
            return { status: res.status, text, body };
          } catch (err) {
            return { error: err.message };
          }
        }, { uid });

        if (listResult.error) {
          throw new Error(`Browser console token list request failed: ${listResult.error}`);
        }
        log(`  Token List Status: ${listResult.status}`);
        log(`  Token List Response Text: ${listResult.text}`);
        
        if (listResult.status !== 200 || !listResult.body || !listResult.body.success) {
          throw new Error(`Token list API failed (Status ${listResult.status}): ${listResult.body ? listResult.body.message : 'Invalid response body'}`);
        }

        const items = listResult.body.data.items || [];
        const targetItem = items.find(item => item.name === 'auto');
        if (!targetItem) {
          throw new Error('Could not find token item named "auto" in list response');
        }
        const tokenId = targetItem.id;
        log(`  Found Token ID: ${tokenId}`);
        await sleep(500);

        // Step 8: Extract unmasked API key
        armStep(`[9/10] Extracting unmasked API key inside console (${currentCountry})`, 60000);
        log('Executing API key unmask call in browser console...');
        const keyResult = await page.evaluate(async ({ uid, tokenId }) => {
          try {
            const res = await fetch(`/api/token/${tokenId}/key`, {
              method: 'POST',
              headers: {
                'LLMAPI-User': String(uid)
              }
            });
            const text = await res.text();
            let body = null;
            try { body = JSON.parse(text); } catch (_) {}
            return { status: res.status, text, body };
          } catch (err) {
            return { error: err.message };
          }
        }, { uid, tokenId });

        if (keyResult.error) {
          throw new Error(`Browser console key unmask request failed: ${keyResult.error}`);
        }
        
        log(`  Key Unmask Status: ${keyResult.status}`);
        log(`  Key Unmask Response Text: ${keyResult.text}`);

        if (keyResult.status !== 200 || !keyResult.body || !keyResult.body.success) {
          throw new Error(`Key unmask API failed (Status ${keyResult.status}): ${keyResult.body ? keyResult.body.message : 'Invalid response body'}`);
        }

        apiKey = keyResult.body.data.key;
        if (!apiKey || apiKey.length < 10) {
          throw new Error(`Invalid extracted API Key: ${apiKey}`);
        }
        log(`  ${C.green}Successfully extracted API Key: ${C.bold}${apiKey}${C.reset}`);
        
        postSuccess = true;
      } catch (err) {
        log(`[WARN] Post-registration step failed: ${err.message}`);
        countryIndex++;
        if (countryIndex < VPN_COUNTRIES.length) {
          currentCountry = VPN_COUNTRIES[countryIndex];
          // Re-arm step timer with high timeout for rotation process
          armStep(`Rotating VPN to ${currentCountry}`, 120000);
          log(`Rotating VPN to: ${currentCountry} and retrying post-registration steps...`);
          
          // Connect to next country
          try {
            await configureVPN(context, currentCountry);
          } catch (vpnErr) {
            log(`[ERROR] Failed to switch VPN to ${currentCountry}: ${vpnErr.message}`);
          }
          await sleep(5000);
          
          // Re-navigate to target page context to ensure clean session/IP routing
          log('Re-establishing target page context...');
          try {
            await page.goto('https://dashboard.tokengo.com/sign-up', { waitUntil: 'domcontentloaded', timeout: 45000 });
          } catch (err) {
            log(`  [INFO] page.goto threw during post-registration rotation: ${err.message}. Checking page URL...`);
            await sleep(2000);
            const curUrl = page.url();
            log(`  Current page URL: ${curUrl}`);
            if (!curUrl.includes('tokengo.com')) {
              throw err;
            }
          }
          await sleep(5000);
          await handleCookies(page);
          await handleTurnstile(page, 60000);
          await sleep(2000);
        } else {
          throw new Error(`All VPN countries exhausted. Post-registration steps failed.`);
        }
      }
    }

    // Step 9: Save output files
    armStep('[10/10] Saving outputs and cleaning up', 60000);
    log('Saving credentials to CSV files...');
    const timestamp = new Date().toISOString();

    // A. Save to tokengo.csv
    const tokengoHeaders = 'timestamp,username,password,api_key_name,api_key,status';
    const tokengoRow = [
      timestamp,
      username,
      password,
      'auto',
      apiKey,
      'registered',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const tokengoExists = fs.existsSync(CONFIG.outputFile);
    if (!tokengoExists) {
      fs.writeFileSync(CONFIG.outputFile, tokengoHeaders + '\n', 'utf8');
    }
    fs.appendFileSync(CONFIG.outputFile, tokengoRow + '\n', 'utf8');
    log(`  Saved to: ${CONFIG.outputFile}`);


    console.log('\n========================================');
    console.log('  TOKENGO REGISTRATION SUMMARY');
    console.log('========================================');
    console.log(`  Username:   ${username}`);
    console.log(`  Password:   ${password}`);
    console.log(`  API Key:    ${apiKey}`);
    console.log('========================================\n');

  } catch (err) {
    log(`${C.red}[ERROR] main flow failed: ${err.message}${C.reset}`);
    const errorScreenshot = path.join(__dirname, 'tokengo_error.png');
    if (page) {
      await page.screenshot({ path: errorScreenshot }).catch(() => {});
      log(`Saved error screenshot to: ${errorScreenshot}`);
    }
    
    // Set exit code for loop/parallel runners
    let exitCode = 1;
    if (err.message.includes('429') || err.message.toLowerCase().includes('rate limit') || err.message.toLowerCase().includes('exhausted')) {
      exitCode = 88; // Rate limit exit code (sleep 10 mins)
    } else if (err.message.toLowerCase().includes('turnstile') || err.message.toLowerCase().includes('captcha')) {
      exitCode = 77; // Captcha block exit code (sleep 20 mins)
    }
    
    log(`Exiting process with code: ${exitCode}`);
    process.exit(exitCode);
  } finally {
    clearTimeout(stepTimer);
    if (browser) {
      log('Closing browser...');
      await browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  register().catch(console.error);
}

module.exports = { register, CONFIG };
