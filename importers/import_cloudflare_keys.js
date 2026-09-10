const fs = require('fs');
const path = require('path');
const { chromium, firefox } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealthPlugin);
const { spawn } = require('child_process');

const { loadEnv } = require('../utils/env.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl } = require('../utils/browser.js');
const { sleep, rand, fillHuman, humanMouseMove, humanScroll } = require('../utils/helpers.js');

loadEnv();

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_CLOUDFLARE_CSV || 'cloudflare.csv',
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://localhost:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  accountId: args.get('account-id') || process.env.CLOUDFLARE_ACCOUNT_ID || '',
  validate: args.get('validate') !== 'false' && !args.has('no-validate'),
  importFreeOnly: args.get('import-free-only') !== 'false' && !args.has('no-import-free-only'),
  headless: args.get('headed') === 'true' ? false : (args.get('headless') === 'true' ? true : (process.env.HEADLESS === 'false' ? false : true)),
  proxy: process.env.PROXY || '',
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

function readKeys(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    return [];
  }
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value])))
    .map(row => ({
      name: row.email,
      apiKey: row.api_key,
      email: row.email,
      password: row.password,
      accountId: row.account_id || row.accountId || null
    }))
    .filter(row => row.name && row.apiKey);
}

function updateCsvWithAccountId(csvPath, email, apiKey, accountId) {
  if (!fs.existsSync(csvPath)) return;
  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length <= 1) return;

    const header = parseCsvLine(lines[0]);
    const emailIdx = header.indexOf('email');
    const apiKeyIdx = header.indexOf('api_key');
    let accountIdIdx = header.indexOf('account_id');

    if (accountIdIdx === -1) {
      header.push('account_id');
      lines[0] = header.map(h => `"${h.replace(/"/g, '""')}"`).join(',');
      accountIdIdx = header.length - 1;
    }

    let modified = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const row = parseCsvLine(line);
      
      const rowEmail = row[emailIdx];
      const rowApiKey = row[apiKeyIdx];
      
      if (rowEmail === email && rowApiKey === apiKey) {
        row[accountIdIdx] = accountId;
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
      console.log(`  Saved resolved Account ID (${accountId}) back to CSV for ${email}.`);
    }
  } catch (err) {
    console.error(`  [WARN] Failed to write Account ID back to CSV: ${err.message}`);
  }
}


async function validateKey(apiKey) {
  const url = 'https://api.cloudflare.com/client/v4/user/tokens/verify';
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      return { ok: true };
    }
    const errText = data.errors && data.errors[0] ? data.errors[0].message : 'Unknown validation error';
    return { ok: false, status: res.status, error: errText };
  } catch (err) {
    console.warn(`  Validation request failed: ${err.message}. Assuming valid.`);
    return { ok: true };
  }
}

function isAntiDetectBrowser(executablePath = '') {
  const lower = executablePath.toLowerCase();
  return lower.includes('camoufox') || lower.includes('comufox') || lower.includes('cloak');
}

function killExistingChromeCDP() {
  try {
    const { execSync } = require('child_process');
    execSync('fuser -k 9222/tcp', { stdio: 'ignore' });
    console.log('Terminated existing Chrome process on port 9222.');
  } catch (err) {
    // ignore non-zero exit code when port is already free
  }
}

async function ensureChromeRunning(executablePath = 'google-chrome') {
  try {
    const checkRes = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log('Google Chrome with Remote Debugging is already running.');
      return true;
    }

    console.log('Google Chrome Remote Debugging port NOT detected. Spawning Chrome...');

    let chromePath = executablePath;
    const lower = chromePath.toLowerCase();
    if (lower === 'cloakbrowser' || lower === 'cloak') {
      chromePath = '/home/nbs59/.cloakbrowser/chromium-146.0.7680.177.5/chrome';
    } else if (lower === 'camoufox' || lower === 'comufox') {
      chromePath = '/home/nbs59/.cache/camoufox/camoufox';
    }

    const args = [
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/chrome-debug-profile',
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check'
    ];

    console.log(`Spawning chrome: ${chromePath} ${args.join(' ')}`);

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
      if (res && res.ok) {
        console.log('Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error('Timeout waiting for Google Chrome remote debugging port to respond.');
  } catch (err) {
    console.error(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function monitorTurnstile(page, resolve) {
  console.log('[INFO] monitorTurnstile started.');
  try {
    console.log('Waiting for Turnstile frame to appear...');
    let frame = null;
    for (let i = 0; i < 30; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    
    if (!frame) {
      throw new Error('Turnstile frame not found in frame list.');
    }

    console.log('Turnstile frame detected. Waiting 5s for layout to settle...');
    await page.waitForTimeout(5000);

    console.log('Waiting for Turnstile response token to populate...');
    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes
    let clickCount = 0;
    let lastClickTime = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return;

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
        console.log(`✅ CAPTCHA SOLVED (Token found: ${tokenValue.substring(0, 15)}...)!`);
        resolve();
        return;
      }

      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));

      if (!activeFrame) {
        console.log('Turnstile frame is no longer present. Checking if token appears...');
        await page.waitForTimeout(1000);
        continue;
      }

      const frameElement = await activeFrame.frameElement().catch(() => null);
      if (frameElement) {
        const isFrameVisible = await frameElement.isVisible().catch(() => false);
        if (isFrameVisible) {
          const box = await frameElement.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const now = Date.now();
            if (now - lastClickTime > 8000) {
              const clickX = box.x + 30;
              const clickY = box.y + box.height / 2;
              clickCount++;
              console.log(`[Click #${clickCount}] Auto-clicking Turnstile checkbox: x=${clickX}, y=${clickY}`);
              await page.mouse.click(clickX, clickY).catch(() => {});
              lastClickTime = now;
            }
          }
        } else {
          console.log('Turnstile frame element is not visible.');
        }
      }

      await page.waitForTimeout(2000);
    }

    console.log('Wait did not solve captcha. Waiting for manual solve...');
    for (let i = 0; i < 780; i++) {
      if (page.isClosed()) return;
      const manualToken = await page.evaluate(() => {
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
        return '';
      }).catch(() => '');

      if (manualToken) {
        console.log(`✅ CAPTCHA SOLVED MANUALLY (Token found: ${manualToken.substring(0, 15)}...)!`);
        resolve();
        return;
      }
      await page.waitForTimeout(1000);
    }
  } catch (err) {
    console.log(`[ERROR] monitorTurnstile failed: ${err.message}`);
  }
  resolve();
}

async function getAccountIdFromBrowser(email, password) {
  const pc = config.proxy ? proxyFromUrl(config.proxy) : null;
  const browserExecutable = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
  const executablePathToUse = browserExecutable || '/usr/bin/google-chrome-stable';
  const browserType = browserTypeFor(executablePathToUse);
  let context;
  let connectedCDP = false;
  let browser;

  try {
    if (!isCamoufox(executablePathToUse)) {
      killExistingChromeCDP();
      await ensureChromeRunning(executablePathToUse);
      const checkRes = await fetch('http://127.0.0.1:9222/json/version').catch(() => null);
      if (checkRes && checkRes.ok) {
        console.log('Found active Google Chrome Remote Debugging port at http://127.0.0.1:9222! Connecting...');
        browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        const contexts = browser.contexts();
        context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        connectedCDP = true;
      }
    }
  } catch (err) {
    console.log(`CDP connection error: ${err.message}`);
  }

  if (!connectedCDP) {
    console.log(`Browser: ${executablePathToUse}`);
    const launchOpts = {
      headless: config.headless,
      executablePath: executablePathToUse,
      args: isAntiDetectBrowser(executablePathToUse) ? [] : [
        '--disable-blink-features=AutomationControlled',
        '--incognito',
        '--no-sandbox'
      ],
    };
    if (pc) {
      launchOpts.proxy = { server: pc.server, username: pc.username, password: pc.password };
    }

    console.log('Launching browser...');
    browser = await browserType.launch(launchOpts);
    console.log('Browser launched.');
    const contextOpts = {
      viewport: isAntiDetectBrowser(executablePathToUse) ? null : { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
    };
    if (!isAntiDetectBrowser(executablePathToUse)) {
      contextOpts.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    }
    if (pc) {
      contextOpts.proxy = { server: pc.server, username: pc.username, password: pc.password };
    }
    context = await browser.newContext(contextOpts);
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    console.log(`  [Browser] Logging in for ${email}...`);
    await page.goto('https://dash.cloudflare.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(rand(1500, 3000));

    // Wait for Turnstile/CAPTCHA to be solved first
    console.log('  [Browser] Waiting for Turnstile captcha...');
    let resolvePromise;
    const solvedPromise = new Promise((res) => {
      resolvePromise = res;
    });
    monitorTurnstile(page, resolvePromise);
    await solvedPromise;
    console.log('  [Browser] Captcha solved or skipped.');

    // Fill credentials
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, emailInput, email);
    await sleep(rand(800, 1500));

    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, passwordInput, password);
    await sleep(rand(1000, 2000));

    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
    await submitBtn.click();
    console.log('  [Browser] Credentials submitted. Waiting for dashboard redirect...');

    // Wait for redirect to get Account ID
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const currentUrl = page.url();
      const match = currentUrl.match(/dash\.cloudflare\.com\/([a-f0-9]{32})/);
      if (match) {
        const accountId = match[1];
        console.log(`  [Browser] Successfully extracted Account ID: ${accountId}`);
        return accountId;
      }
      await sleep(1000);
    }
    throw new Error('Timeout waiting for redirect containing Account ID');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
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

async function main() {
  console.log(`Reading Cloudflare keys from: ${config.csv}`);
  const rows = readKeys(config.csv);
  console.log(`Found ${rows.length} total entries.`);
  
  const seenKeys = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (seenKeys.has(row.apiKey)) continue;
    seenKeys.add(row.apiKey);
    uniqueRows.push(row);
  }
  console.log(`Found ${uniqueRows.length} unique API keys.`);

  if (uniqueRows.length === 0) {
    console.log('No keys to import.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await loginOmniRoute(page);

    const allConnections = await page.evaluate(async () => {
      const data = await fetch('/api/providers').then(res => res.json());
      return data.connections || [];
    });

    const existingNames = new Set(allConnections
      .filter(connection => connection.provider === 'cloudflare-ai')
      .map(connection => connection.name));
    
    const results = [];

    for (const row of uniqueRows) {
      let accountId = row.accountId || config.accountId || undefined;
      if (!accountId && row.password) {
        try {
          accountId = await getAccountIdFromBrowser(row.email, row.password);
          if (accountId) {
            updateCsvWithAccountId(config.csv, row.email, row.apiKey, accountId);
          }
        } catch (e) {
          console.error(`Failed to get account ID via browser for ${row.email}: ${e.message}`);
        }
      }

      if (existingNames.has(row.name)) {
        results.push({ name: row.name, status: 'skipped_duplicate_name' });
        continue;
      }

      if (config.validate) {
        console.log(`Validating key for ${row.name}...`);
        const validation = await validateKey(row.apiKey);
        if (!validation.ok) {
          console.log(`  Validation failed: ${validation.error}`);
          results.push({ name: row.name, status: 'skipped_validation_failed', detail: validation.error });
          continue;
        }
      }

      const payload = {
        provider: 'cloudflare-ai',
        authType: 'apikey',
        name: row.name,
        apiKey: row.apiKey,
        priority: 1,
        isActive: true,
        providerSpecificData: {
          importFreeModelsOnly: config.importFreeOnly,
          ...(accountId ? { accountId } : {})
        },
      };

      console.log(`Saving connection for ${row.name} to OmniRoute${accountId ? ` (Account ID: ${accountId})` : ''}...`);
      const saved = await page.evaluate(async payload => {
        const res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        let body = {};
        try { body = JSON.parse(text); } catch (_) {}
        return { ok: res.ok, status: res.status, body };
      }, payload);

      if (saved.ok) {
        existingNames.add(row.name);
        results.push({ name: row.name, status: 'added' });
        console.log(`  Added successfully.`);

        const connectionId = saved.body?.connection?.id;
        if (connectionId) {
          console.log(`  Syncing models for connection ${connectionId}...`);
          const syncRes = await page.evaluate(async id => {
            const res = await fetch(`/api/providers/${id}/sync-models`, { method: 'POST' });
            const text = await res.text();
            return { ok: res.ok, status: res.status, text };
          }, connectionId);
          console.log(`  Sync completed: status=${syncRes.status}`);
        }
      } else {
        const errDetail = saved.body?.error || saved.body?.message || 'Save failed';
        results.push({ name: row.name, status: 'failed_save', detail: saved.status, error: errDetail });
        console.error(`  Failed to save: status=${saved.status}, error=${errDetail}`);
      }
    }

    const summary = results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {});

    console.log('\n=== IMPORT SUMMARY ===');
    console.log(JSON.stringify({
      csvRows: rows.length,
      uniqueKeys: uniqueRows.length,
      validateEachKeyBeforeSaving: config.validate,
      summary,
      results,
    }, null, 2));

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
