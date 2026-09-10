const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const fs = require('fs');
const path = require('path');
const TempMail = require('../services/tempmail/tempmail.js');
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, proxyFromUrl, getFirefoxUserAgent, envFlag, selectProxy, handleProxyFailure } = require('../utils/browser.js');
const { sleep, rand, fillHuman, humanMouseMove, handleCookies } = require('../utils/helpers.js');
const { solve: solveRecaptchaAudio } = require('recaptcha-solver');
const { findFfmpeg } = require('../utils/ffmpeg.js');

const ffmpegPath = findFfmpeg();

const CONFIG = {
  extensionPath: '/home/nbs59/.brave-extension-source/Default/Extensions/ohjocgmpmlfahafbipehkhbaacoemojp/2.0.1_0',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '/home/nbs59/.local/share/brave-bin/opt/brave.com/brave/brave-browser'),
  password: process.env.META_PASSWORD || `MetaAuto!${Math.random().toString(36).substring(2, 10)}`,
  outputFile: path.join(__dirname, '..', 'data', 'meta.csv'),
  otpTimeout: 180000,
  captchaMode: 'audio',
  proxy: process.env.PROXY || '',
};

const STATE_MAP = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
  'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia',
  'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
  'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
  'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri',
  'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
  'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
  'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
  'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont',
  'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'
};

// Indonesian names list matching existing behaviors
const FIRST_NAMES = ['Della', 'Dolly', 'Diana', 'Dewi', 'Desy', 'Donna', 'Dora', 'Dina', 'Dani', 'Devi', 'Dania', 'Darla', 'Daisy', 'Clara', 'Cindy'];
const LAST_NAMES = ['Adelia', 'Agata', 'Amanda', 'Amelia', 'Angelina', 'Anindya', 'Aprilia', 'Arianti', 'Arisanti', 'Astuti'];

function getRandomName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return { first, last };
}

// Simple cross-process lock mechanism using lockfile
function acquireLock(lockName, timeoutMs = 15000) {
  const lockFilePath = path.join(__dirname, `${lockName}.lock`);
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      // wx flag throws if file already exists (atomic operation)
      fs.writeFileSync(lockFilePath, process.pid.toString(), { flag: 'wx' });
      return true;
    } catch (err) {
      // Sleep a short random duration and retry
      const sleepDuration = 50 + Math.floor(Math.random() * 100);
      const start = Date.now();
      while (Date.now() - start < sleepDuration) {}
    }
  }
  console.log(`[WARN] Failed to acquire lock for ${lockName} after ${timeoutMs}ms.`);
  return false;
}

function releaseLock(lockName) {
  const lockFilePath = path.join(__dirname, `${lockName}.lock`);
  try {
    if (fs.existsSync(lockFilePath)) {
      fs.unlinkSync(lockFilePath);
    }
  } catch (err) {
    // Ignore error
  }
}

// Load VCCs from education.txt
function loadVCCs() {
  const filePath = path.join(__dirname, 'education.txt');
  if (!fs.existsSync(filePath)) {
    throw new Error('education.txt not found');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  return lines.map(line => {
    const parts = line.split('|');
    const card = parts[0];
    const month = parts[1];
    const year = parts[2];
    const cvc = parts[3];
    const count = parts[4] ? parseInt(parts[4], 10) : 0;
    const status = parts[5] || 'active';
    return { card, month, year, cvc, count, status };
  });
}

// Save VCCs back to education.txt
function saveVCCs(vccs) {
  const filePath = path.join(__dirname, 'education.txt');
  const lines = vccs.map(vcc => {
    return `${vcc.card}|${vcc.month}|${vcc.year}|${vcc.cvc}|${vcc.count}|${vcc.status}`;
  });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

// Atomic helpers for updating VCC status and count safely in parallel
function updateVccStatus(cardNum, status) {
  acquireLock('education');
  try {
    const vccs = loadVCCs();
    let updated = false;
    for (const v of vccs) {
      if (v.card === cardNum) {
        v.status = status;
        updated = true;
      }
    }
    if (updated) {
      saveVCCs(vccs);
    }
  } finally {
    releaseLock('education');
  }
}

function incrementVccCount(cardNum) {
  acquireLock('education');
  try {
    const vccs = loadVCCs();
    let updated = false;
    for (const v of vccs) {
      if (v.card === cardNum) {
        v.count += 1;
        if (v.count >= 7) {
          v.status = 'too_many';
        }
        updated = true;
      }
    }
    if (updated) {
      saveVCCs(vccs);
    }
  } finally {
    releaseLock('education');
  }
}

function incrementCompanyCount(companyNo) {
  acquireLock('company_csv');
  try {
    const { headers: ch, data: cd } = loadCompanies();
    const compToUpdate = cd.find(c => c.no === companyNo);
    if (compToUpdate) {
      compToUpdate.count += 1;
      saveCompanies(ch, cd);
    }
  } finally {
    releaseLock('company_csv');
  }
}

// Save or update account in meta.csv with status
function saveOrUpdateAccount(email, password, otp, status = 'registered', apikey = '') {
  acquireLock('meta_csv');
  try {
    const filePath = CONFIG.outputFile;
    const headers = 'timestamp,email,password,otp,status,apikey';
    let rows = [];
    
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      rows = content.split('\n').map(r => r.trim()).filter(r => r.length > 0);
    }
    
    if (rows.length === 0) {
      rows.push(headers);
    }
    
    // Parse rows (ignoring header)
    let updated = false;
    const newRowData = [new Date().toISOString(), email, password, otp, status, apikey];
    const newRowStr = newRowData.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    
    for (let i = 1; i < rows.length; i++) {
      // Basic CSV splitting (considering quoted values)
      const columns = rows[i].split(',').map(col => col.replace(/^"|"$/g, '').replace(/""/g, '"'));
      if (columns[1] === email) {
        rows[i] = newRowStr;
        updated = true;
        break;
      }
    }
    
    if (!updated) {
      rows.push(newRowStr);
    }
    
    fs.writeFileSync(filePath, rows.join('\n') + '\n', 'utf8');
    console.log(`Saved/updated account details in ${filePath} (status: ${status}, apikey: ${apikey ? 'yes' : 'no'})`);
  } finally {
    releaseLock('meta_csv');
  }
}

// Find a locator in the main page or any frame
async function findLocatorInPageOrFrames(page, selectors) {
  // Check main page first
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      return loc;
    }
  }
  // Check all frames
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        return loc;
      }
    }
  }
  // Return first selector on main page as a fallback locator
  return page.locator(selectors[0]).first();
}

// Find editable text inputs on page or any frame
async function findEditableInputsInPageOrFrames(page) {
  const visibleInputs = [];
  
  const collect = async (context) => {
    try {
      const count = await context.locator('input').count();
      for (let i = 0; i < count; i++) {
        const input = context.locator('input').nth(i);
        const type = await input.getAttribute('type').catch(() => 'text');
        const val = await input.inputValue().catch(() => '');
        const isVisible = await input.isVisible().catch(() => false);
        const isReadonly = await input.getAttribute('readonly').catch(() => null);
        const isDisabled = await input.getAttribute('disabled').catch(() => null);
        
        if (isVisible && isReadonly === null && isDisabled === null && type === 'text' && !val.includes('@')) {
          visibleInputs.push(input);
        }
      }
    } catch (_) {}
  };

  await collect(page);
  for (const frame of page.frames()) {
    await collect(frame);
  }
  return visibleInputs;
}

// Load business profiles from company.csv
function loadCompanies() {
  const filePath = path.join(__dirname, '..', 'data', 'company.csv');
  if (!fs.existsSync(filePath)) {
    throw new Error('company.csv not found');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const headers = lines[0].split(',');
  const data = lines.slice(1).map(line => {
    const parts = line.split(',');
    const no = parts[0];
    const name = parts[1];
    const address = parts[2];
    const city = parts[3];
    const state = parts[4];
    const zip = parts[5];
    const count = parts[6] ? parseInt(parts[6], 10) : 0;
    const status = parts[7] || 'active';
    return { no, name, address, city, state, zip, count, status };
  });
  return { headers, data };
}

// Save business profiles back to company.csv
function saveCompanies(headers, data) {
  const filePath = path.join(__dirname, '..', 'data', 'company.csv');
  const baseHeaders = headers.slice(0, 6);
  if (!baseHeaders.includes('use_count')) baseHeaders.push('use_count');
  if (!baseHeaders.includes('status')) baseHeaders.push('status');
  
  const lines = [baseHeaders.join(',')];
  for (const row of data) {
    lines.push(`${row.no},${row.name},${row.address},${row.city},${row.state},${row.zip},${row.count},${row.status}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

// Helper to fill input fields inside iframe or main frame
async function fillPaymentField(page, fieldSelectors, value) {
  // 1. Search all subframes (non-main frames) first
  for (const frame of page.frames()) {
    if (frame.parentFrame() === null) continue; // Skip main frame
    for (const selector of fieldSelectors) {
      try {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          console.log(`  Filling payment field in iframe (${frame.url()}): ${selector}`);
          await locator.click({ force: true, timeout: 2000 });
          await sleep(rand(80, 150));
          await locator.fill('');
          await sleep(rand(50, 100));
          for (const char of value) {
            await locator.pressSequentially(char, { delay: rand(20, 50) });
          }
          return true;
        }
      } catch (_) {}
    }
  }

  // 2. Fallback to main page ONLY IF it is not a business/address field to prevent selector overlaps
  const isAddressField = fieldSelectors.some(sel => 
    sel.includes('business') || 
    sel.includes('address') || 
    sel.includes('city') || 
    sel.includes('zip') || 
    sel.includes('postal')
  );

  if (!isAddressField) {
    for (const selector of fieldSelectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        console.log(`  Filling payment field in main frame fallback: ${selector}`);
        await fillHuman(page, locator, value);
        return true;
      }
    }
  }
  return false;
}

async function getApiKey(page) {
  // Try reading from clipboard first after clicking Copy on main page and all frames
  try {
    for (const frame of [page, ...page.frames()]) {
      const copyBtn = frame.locator(':text("Copy"), button:has-text("Copy"), button[aria-label*="copy" i], [class*="copy" i]').first();
      if (await copyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await copyBtn.click({ force: true });
        await sleep(1000);
        const clipboardText = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
        if (clipboardText && clipboardText.trim().length > 10) {
          return clipboardText.trim();
        }
      }
    }
  } catch (err) {
    console.log('Clipboard copy failed:', err.message);
  }
  
  // Fallback: search the page/DOM for elements containing the key structure in all frames
  for (const frame of [page, ...page.frames()]) {
    try {
      const key = await frame.evaluate(() => {
        // Search all inputs
        for (const input of Array.from(document.querySelectorAll('input'))) {
          if (input.value && (input.value.startsWith('ms-') || input.value.length > 20)) {
            return input.value;
          }
        }
        // Search all page text for a key pattern
        const text = document.body.innerText;
        const match = text.match(/ms-[a-zA-Z0-9_-]+/);
        if (match) return match[0];
        
        // Search codes/divs
        for (const div of Array.from(document.querySelectorAll('div, span, code'))) {
          const val = (div.textContent || '').trim();
          if (val.startsWith('ms-') || (val.length > 20 && /^[a-zA-Z0-9_-]+$/.test(val))) {
            return val;
          }
        }
        return '';
      });
      if (key && key.trim().length > 10) {
        return key.trim();
      }
    } catch (_) {}
  }
  return '';
}

async function configureVPN(page) {
  console.log('Connecting to hide.me VPN extension page...');
  // Open the extension's popup URL directly
  await page.goto('chrome-extension://ohjocgmpmlfahafbipehkhbaacoemojp/popup.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Check if we need to configure or if it's already connected
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

  // Click row select server
  console.log('  Opening server locations...');
  const selectServerBtn = page.locator('#row_select_server').first();
  await selectServerBtn.waitFor({ state: 'visible', timeout: 10000 });
  await selectServerBtn.click();
  await sleep(3000);

  // Search or click USA/United States
  console.log('  Selecting United States server...');
  const serverList = page.locator('.servers_list ul');
  await serverList.waitFor({ state: 'visible', timeout: 15000 });
  await sleep(2000);

  const listItems = page.locator('.servers_list ul li');
  const count = await listItems.count().catch(() => 0);
  console.log(`  Found ${count} server location(s) in list.`);

  // Print all servers for debugging
  for (let i = 0; i < count; i++) {
    const nameAttr = await listItems.nth(i).getAttribute('name').catch(() => '');
    const textVal = await listItems.nth(i).innerText().catch(() => '');
    console.log(`    - Server ${i}: name="${nameAttr}", text="${textVal.trim()}"`);
  }

  // Click the USA / USA option specifically
  let clickedServer = false;
  
  console.log('  Clicking US option via JS evaluate...');
  clickedServer = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.servers_list ul li'));
    const usItem = items.find(el => {
      const name = el.getAttribute('name') || '';
      const text = (el.textContent || '').trim().toLowerCase();
      return name === 'usa' || name === 'united_states' || text === 'usa' || text.includes('united states');
    });
    if (usItem) {
      console.log('Found US item: ', usItem.outerHTML);
      usItem.focus();
      const opts = { bubbles: true, cancelable: true, view: window };
      usItem.dispatchEvent(new MouseEvent('mousedown', opts));
      usItem.dispatchEvent(new MouseEvent('mouseup', opts));
      usItem.click();
      usItem.dispatchEvent(new MouseEvent('click', opts));
      return true;
    }
    return false;
  });

  if (!clickedServer) {
    // Try via Playwright as fallback
    const targetUS = page.locator('.servers_list li[name="usa"], .servers_list li[name="united_states"]').first();
    if (await targetUS.isVisible().catch(() => false)) {
      console.log('  Clicking US option via Playwright fallback...');
      await targetUS.click({ force: true });
      clickedServer = true;
    }
  }

  if (!clickedServer && count > 0) {
    console.log('  US option not found, clicking the first server option...');
    await listItems.first().click({ force: true });
  }

  await sleep(3000);

  // Now click connect (toggle the checkbox)
  console.log('  Clicking Connect...');
  // Wait for popup list to close or redirect back to main page
  const connectionStatus = page.locator('.connection_status');
  await connectionStatus.waitFor({ state: 'visible', timeout: 10000 });

  const currentChecked = await connectCheckbox.isChecked().catch(() => false);
  if (!currentChecked) {
    console.log('  Triggering VPN switch check via JS evaluate...');
    await page.evaluate(() => {
      const checkbox = document.querySelector('#cmn-toggle-1');
      if (checkbox && !checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    console.log('  Triggered VPN switch check, waiting for connection status to change to Connected...');
  }

  // Wait for status Connected
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const text = await page.locator('.connection_status .indicator').innerText().catch(() => '');
    if (text.toLowerCase().includes('connected') && !text.toLowerCase().includes('not')) {
      console.log('  VPN successfully connected!');
      break;
    }
    await sleep(1000);
  }
}

async function checkRecaptchaBlock(page) {
  try {
    const frames = page.frames();
    for (const f of frames) {
      const text = await f.innerText('body').catch(() => '');
      if (text.includes('Try again later') && (text.includes('automated queries') || text.includes('protect our users'))) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

async function waitForSelectorInPageOrFrames(page, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check main page
    const el = page.locator(selector).first();
    if (await el.count().catch(() => 0) > 0 && await el.isVisible().catch(() => false)) {
      return el;
    }
    // Check all frames
    for (const frame of page.frames()) {
      const elFrame = frame.locator(selector).first();
      if (await elFrame.count().catch(() => 0) > 0 && await elFrame.isVisible().catch(() => false)) {
        return elFrame;
      }
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

async function findFrameContainingRecaptcha(page) {
  const targetSelector = 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]';
  // Check main page
  if (await page.locator(targetSelector).count().catch(() => 0) > 0) {
    return page;
  }
  // Check child frames
  for (const frame of page.frames()) {
    if (await frame.locator(targetSelector).count().catch(() => 0) > 0) {
      return frame;
    }
  }
  return page;
}

async function solveRecaptchaIfPresent(page, browser, timeoutMs = 5000) {
  if (CONFIG.captchaMode !== 'audio') {
    return false;
  }

  let hasRecaptcha = false;
  let recaptchaElement = null;
  const targetSelector = 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]';
  try {
    recaptchaElement = await waitForSelectorInPageOrFrames(page, targetSelector, timeoutMs);
    hasRecaptcha = true;
  } catch (_) {
    // Check if it's there without throwing
    for (const frame of [page, ...page.frames()]) {
      const el = frame.locator(targetSelector).first();
      if (await el.count().catch(() => 0) > 0) {
        recaptchaElement = el;
        hasRecaptcha = true;
        break;
      }
    }
  }

  if (!hasRecaptcha || !recaptchaElement) {
    return false;
  }

  console.log('  reCAPTCHA detected! Auto-solving with audio (offline, free)...');

  const targetFrame = await findFrameContainingRecaptcha(page);
  console.log(`  Using frame context for reCAPTCHA: ${targetFrame.url()}`);

  let checkboxClicked = false;
  for (let attempt = 0; attempt < 5 && !checkboxClicked; attempt++) {
    if (await checkRecaptchaBlock(page)) {
      console.log('  [CAPTCHA BLOCK] reCAPTCHA "Try again later" block detected before checkbox click!');
      console.log('  Closing browser and sleeping this thread for 20 minutes (exit code 77)...');
      await browser.close().catch(() => {});
      process.exit(77);
    }
    try {
      const iframeElement = targetFrame.locator(targetSelector).first();
      const handle = await iframeElement.elementHandle();
      if (handle) {
        const frame = await handle.contentFrame();
        if (frame) {
          await frame.waitForSelector('.recaptcha-checkbox-border', { state: 'visible', timeout: 5000 });
          const checkbox = await frame.$('.recaptcha-checkbox-border');
          if (checkbox) {
            await checkbox.click();
            console.log('  Checkbox clicked, waiting for challenge or checkmark...');
            await sleep(3000);

            // Check if it got checked immediately (green checkmark, no challenge popup)
            const ariaChecked = await frame.$eval('#recaptcha-anchor', el => el.getAttribute('aria-checked')).catch(() => 'false');
            if (ariaChecked === 'true') {
              console.log('  reCAPTCHA checked automatically!');
              checkboxClicked = true;
              return true;
            }
            checkboxClicked = true;
          }
        }
      }
    } catch (e) {
      if (attempt < 4) {
        console.log(`  Checkbox not ready (attempt ${attempt + 1}/5), retrying... Error: ${e.message}`);
        await sleep(1000);
      }
    }
  }

  if (!checkboxClicked) {
    console.log('  [WARN] Could not click checkbox, trying solve anyway...');
  }

  try {
    process.env.VERBOSE = '1';
    await solveRecaptchaAudio(targetFrame, { wait: 15000, retry: 5, ffmpeg: ffmpegPath });
    console.log('  reCAPTCHA solved via audio!');
    return true;
  } catch (e) {
    // If it failed because "No reCAPTCHA detected", let's check if the checkmark is actually checked now
    try {
      const iframeElement = targetFrame.locator(targetSelector).first();
      const handle = await iframeElement.elementHandle();
      if (handle) {
        const frame = await handle.contentFrame();
        if (frame) {
          const ariaChecked = await frame.$eval('#recaptcha-anchor', el => el.getAttribute('aria-checked')).catch(() => 'false');
          if (ariaChecked === 'true') {
            console.log('  reCAPTCHA was already solved/checked (green checkmark)!');
            return true;
          }
        }
      }
    } catch (_) {}

    console.log(`  Audio solver failed: ${e.message}`);
    if (await checkRecaptchaBlock(page)) {
      console.log('  [CAPTCHA BLOCK] reCAPTCHA "Try again later" block detected!');
      console.log('  Closing browser and sleeping this thread for 20 minutes (exit code 77)...');
      await browser.close().catch(() => {});
      process.exit(77);
    }
    console.log('  Closing browser and terminating thread (code 99)...');
    await browser.close().catch(() => {});
    process.exit(99);
  }
}

async function register() {
  console.log('Starting registration script...');

  // Force TEMPMAIL_PROVIDER to be webhook
  process.env.TEMPMAIL_PROVIDER = 'webhook';
  const tempmail = new TempMail();
  const inbox = await tempmail.createInbox();
  const email = inbox.address;
  console.log(`Generated email: ${email}`);

  const randomName = getRandomName();
  let first = randomName.first;
  let last = randomName.last;
  const sessId = Math.random().toString(36).substring(2, 10);

  const executablePathToUse = CONFIG.browserExecutablePath;
  const isCam = isCamoufox(executablePathToUse);
  const selectedProxy = selectProxy(CONFIG.proxy);

  let tempProfileDir;
  let context;
  let browser;

  if (isCam) {
    if (selectedProxy) {
      const launchOpts = {
        headless: envFlag('HEADLESS', false),
        executablePath: executablePathToUse,
        ignoreHTTPSErrors: true,
        proxy: proxyFromUrl(selectedProxy),
      };
      console.log(`  Routing traffic through proxy: ${selectedProxy.split('@').pop() || selectedProxy}`);

      const browserType = browserTypeFor(executablePathToUse);
      const camBrowserInstance = await browserType.launch(launchOpts);
      context = await camBrowserInstance.newContext({
        viewport: null,
        locale: 'en-US',
        ignoreHTTPSErrors: true,
        userAgent: getFirefoxUserAgent(),
      });
      
      browser = {
        close: async () => {
          await context.close().catch(() => {});
          await camBrowserInstance.close().catch(() => {});
        }
      };
    } else {
      // Jika tanpa proxy, gunakan profile persisten dengan VPN ekstensi yang sudah dikonfigurasi
      tempProfileDir = path.join(__dirname, '.camoufox_profile_meta');
      console.log(`Using Camoufox persistent profile dir: ${tempProfileDir}`);

      const contextOpts = {
        headless: envFlag('HEADLESS', false),
        executablePath: executablePathToUse,
        viewport: null, // Let Camoufox handle default viewport
        locale: 'en-US',
        ignoreHTTPSErrors: true,
      };

      const browserType = browserTypeFor(executablePathToUse);
      context = await browserType.launchPersistentContext(tempProfileDir, contextOpts);
      
      browser = {
        close: async () => {
          await context.close().catch(() => {});
        }
      };
    }
  } else {
    // Chromium/Brave persistent context
    tempProfileDir = path.join(__dirname, `.chrome_profile_meta_${Date.now()}`);
    console.log(`Temp profile dir: ${tempProfileDir}`);

    const contextOpts = {
      headless: envFlag('HEADLESS', false), // Must be headful for extensions to work
      executablePath: executablePathToUse,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${CONFIG.extensionPath}`,
        `--load-extension=${CONFIG.extensionPath}`,
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
      permissions: ['clipboard-read', 'clipboard-write'],
    };

    if (selectedProxy) {
      contextOpts.proxy = proxyFromUrl(selectedProxy);
      console.log(`  Routing traffic through proxy: ${selectedProxy.split('@').pop() || selectedProxy}`);
    }

    const browserType = browserTypeFor(executablePathToUse);
    context = await browserType.launchPersistentContext(tempProfileDir, contextOpts);
    
    // Wrapper for Chromium persistent context to clean up temp profile folder on exit
    const originalContext = context;
    browser = {
      close: async () => {
        await originalContext.close().catch(() => {});
        try {
          if (fs.existsSync(tempProfileDir)) {
            fs.rmSync(tempProfileDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    };
  }



  if (CONFIG.proxy && CONFIG.proxy.includes('oxylabs.io')) {
    await context.setExtraHTTPHeaders({
      'X-Oxylabs-Location': 'US'
    }).catch(() => {});
    console.log('  Oxylabs proxy location header set to US.');
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  await sleep(3000); // Wait for browser startup to fully settle and settle extension popup state

  try {
    if (!isCam) {
      // 1. Connect hide.me VPN first (hanya untuk Chromium/Brave dengan extensionPath)
      const vpnPage = await context.newPage();
      try {
        await configureVPN(vpnPage);
      } finally {
        await vpnPage.close().catch(() => {});
      }
      console.log('  Waiting 5 seconds for VPN proxy connection routing to stabilize...');
      await sleep(5000);
    } else {
      console.log('  Using Camoufox pre-configured VPN from persistent profile...');
    }

    // 2. Go to dev.meta.ai with reconnection retry
    console.log('Opening https://dev.meta.ai...');
    let navSuccess = false;
    for (let navAttempt = 1; navAttempt <= 8; navAttempt++) {
      try {
        await page.goto('https://dev.meta.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000); // Allow any geo-block page to load
        
        const bodyText = await page.innerText('body').catch(() => '');
        if (/available in your (country|region)/i.test(bodyText) || bodyText.includes("isn’t available") || bodyText.includes("isn't available")) {
          console.log(`  [GEO-BLOCK] Meta AI blocked this proxy IP (attempt ${navAttempt}/8). Retrying to rotate proxy IP...`);
          await sleep(2000);
          continue;
        }

        navSuccess = true;
        break;
      } catch (err) {
        console.log(`  [WARN] Navigation to dev.meta.ai failed (attempt ${navAttempt}/8): ${err.message}`);
        if (navAttempt < 8) {
          if (!isCam) {
            console.log('  Reconfiguring VPN to fetch a new proxy connection...');
            const vpnPage = await context.newPage();
            try {
              await configureVPN(vpnPage);
            } finally {
              await vpnPage.close().catch(() => {});
            }
            await sleep(5000);
          } else {
            console.log('  Navigation failed, waiting 5 seconds before retrying...');
            await sleep(5000);
          }
        }
      }
    }
    if (!navSuccess) {
      throw new Error('Failed to load dev.meta.ai after multiple VPN/proxy retry attempts.');
    }
    await sleep(5000);
    await handleCookies(page).catch(() => {});
    
    // Explicit cookie check for dev.meta.ai
    try {
      console.log('Waiting for explicit cookies modal...');
      const cookieBtn = page.locator('button, div[role="button"], span').filter({ hasText: /Allow all cookies/i }).filter({ visible: true }).first();
      await cookieBtn.waitFor({ state: 'visible', timeout: 10000 });
      console.log('Clicking "Allow all cookies" button...');
      await cookieBtn.click({ force: true });
      await sleep(2000);
    } catch (err) {
      console.log('Explicit cookie modal did not appear or error: ', err.message);
      // Fallback JS click on cookie button
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, div, span'));
        const target = els.find(el => (el.textContent || '').trim().toLowerCase() === 'allow all cookies');
        if (target) target.click();
      });
      await sleep(2000);
    }

    // Check if we are already logged in (redirected to dashboard or billing page)
    const currentUrl = page.url();
    const isLoggedIn = currentUrl.includes('/billing') || currentUrl.includes('/dashboard') || (await page.locator('a:has-text("Billing"), a[href*="billing"]').count().catch(() => 0) > 0);
    
    if (isLoggedIn) {
      console.log('  [INFO] Already logged in. Skipping registration steps.');
      if (!page.url().includes('/billing')) {
        console.log('  Navigating to billing page directly...');
        await page.goto('https://dev.meta.ai/billing/', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(5000);
      }
    } else {
      // 3. Click "Use mobile number or email"
      console.log('Clicking "Use mobile number or email"...');
      const loginButton = page.locator('text="Use mobile number or email"').first();
      await loginButton.waitFor({ state: 'visible', timeout: 45000 });
    await loginButton.click();
    await sleep(3000);

    // Enter email on the "What's your mobile number or email?" screen
    console.log(`Entering email address: ${email}`);
    const emailField = page.locator('input[placeholder*="Mobile number or email" i], input[type="text"]').first();
    await emailField.waitFor({ state: 'visible', timeout: 45000 });
    await emailField.fill(email);
    await sleep(rand(500, 1000));

    console.log('Clicking Continue...');
    const continueBtn = page.locator('div[role="button"]:has-text("Continue"), button:has-text("Continue"), [class*="button" i]:has-text("Continue"), span:has-text("Continue")').first();
    await continueBtn.waitFor({ state: 'visible', timeout: 15000 });
    await continueBtn.click();
    await sleep(5000);

    // Solve reCAPTCHA if it appears after entering email
    let solvedContinue = await solveRecaptchaIfPresent(page, browser);
    if (solvedContinue && await continueBtn.isVisible().catch(() => false)) {
      console.log('Re-clicking Continue after solving reCAPTCHA...');
      await continueBtn.click();
      await sleep(5000);
      await solveRecaptchaIfPresent(page, browser);
    }

    // 4. Fill signup details (Meta registration form with DOB and Password)
    // Check if Password field is present
    const passwordInput = page.locator('input[type="password"], input[placeholder*="Password" i]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await fillHuman(page, passwordInput, CONFIG.password);
    await sleep(rand(500, 1000));

    // Select Date of Birth (Random, but ensure >= 18 years old)
    console.log('Selecting random Date of Birth (>= 18 years old)...');
    const birthdayDay = page.locator('select#day, select[name="birthday_day"], select[placeholder*="day" i]').first();
    const birthdayMonth = page.locator('select#month, select[name="birthday_month"], select[placeholder*="month" i]').first();
    const birthdayYear = page.locator('select#year, select[name="birthday_year"], select[placeholder*="year" i]').first();

    const randomDay = String(rand(1, 28));
    // Months in dropdown might be names (e.g. 'Jan', 'Feb', 'July') or numbers
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const randomMonthName = months[rand(0, 11)];
    const randomYear = String(rand(1990, 2005));

    // Handle standard select elements
    if (await birthdayDay.isVisible().catch(() => false)) {
      await birthdayDay.selectOption(randomDay);
      await sleep(rand(300, 600));
    }
    if (await birthdayMonth.isVisible().catch(() => false)) {
      await birthdayMonth.selectOption({ label: randomMonthName }).catch(async () => {
        await birthdayMonth.selectOption(String(rand(1, 12))).catch(() => {});
      });
      await sleep(rand(300, 600));
    }
    if (await birthdayYear.isVisible().catch(() => false)) {
      await birthdayYear.selectOption(randomYear);
      await sleep(rand(300, 600));
    }

    // Handle custom dropdowns (e.g. divs with role="combobox" or button dropdowns if select elements are hidden)
    const customDropdowns = page.locator('div[role="combobox"], div[aria-haspopup="listbox"], button[id*="birthday" i]');
    const customCount = await customDropdowns.count().catch(() => 0);
    if (customCount >= 3) {
      console.log('  Handling custom DOB comboboxes...');
      // 1. Month dropdown
      await customDropdowns.nth(0).click().catch(() => {});
      await sleep(1000);
      const monthOption = page.locator('[role="option"], li').filter({ hasText: new RegExp('^' + randomMonthName + '$') }).first();
      if (await monthOption.isVisible().catch(() => false)) {
        await monthOption.click();
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await sleep(1000);

      // 2. Day dropdown
      await customDropdowns.nth(1).click().catch(() => {});
      await sleep(1000);
      const dayOption = page.locator('[role="option"], li').filter({ hasText: new RegExp('^' + randomDay + '$') }).first();
      if (await dayOption.isVisible().catch(() => false)) {
        await dayOption.click();
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await sleep(1000);

      // 3. Year dropdown
      await customDropdowns.nth(2).click().catch(() => {});
      await sleep(1000);
      const yearOption = page.locator('[role="option"], li').filter({ hasText: new RegExp('^' + randomYear + '$') }).first();
      if (await yearOption.isVisible().catch(() => false)) {
        await yearOption.click();
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await sleep(1000);
    }

    // Gender selection (custom radio button for Meta if it exists)
    const femaleRadio = page.locator('input[type="radio"][value="1"], input[value="1"]#u_0_4, text="Female"').first();
    if (await femaleRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
      await femaleRadio.click();
      await sleep(rand(300, 600));
    }

    // Submit form
    console.log('Submitting registration form...');
    const submitLocator = page.locator('button, div[role="button"], span').filter({ hasText: /^Confirm$/ }).filter({ visible: true });
    
    let clicked = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const solvedConfirm = await solveRecaptchaIfPresent(page, browser);
      if (solvedConfirm) {
        console.log('reCAPTCHA was solved, waiting for page state...');
        await sleep(3000);
      }

      const isVisible = await submitLocator.first().isVisible().catch(() => false);
      if (!isVisible) {
        console.log('  Confirm button is no longer visible (form submitted or page changed).');
        clicked = true;
        break;
      }
      
      console.log(`  Clicking Confirm button (attempt ${attempt}/5)...`);
      await submitLocator.first().click({ force: true }).catch(() => {});
      
      // Fallback JS click targeting div[role="button"] containing 'Confirm'
      await page.evaluate(() => {
        const confirmBtn = Array.from(document.querySelectorAll('div[role="button"]')).find(el => {
          return el.textContent && el.textContent.includes('Confirm');
        });
        if (confirmBtn) {
          confirmBtn.focus();
          const opts = { bubbles: true, cancelable: true, view: window };
          confirmBtn.dispatchEvent(new MouseEvent('mousedown', opts));
          confirmBtn.dispatchEvent(new MouseEvent('mouseup', opts));
          confirmBtn.click();
          confirmBtn.dispatchEvent(new MouseEvent('click', opts));
        }
      });

      await sleep(3000);
    }
    await sleep(5000);

    // 5. Retrieve OTP from tempmail
    console.log('Waiting for OTP email from webhook domain...');
    const otpCode = await tempmail.waitForOtp(email, CONFIG.otpTimeout);
    
    if (!otpCode) {
      console.log('  [ERROR] Did not receive OTP within the timeout.');
      await page.screenshot({ path: path.join(__dirname, 'meta_registration_no_otp.png') });
      throw new Error('OTP wait timed out.');
    }

    console.log(`\n========================================`);
    console.log(`SUCCESSFULLY RECEIVED OTP: ${otpCode}`);
    console.log(`Email:      ${email}`);
    console.log(`Password:   ${CONFIG.password}`);
    console.log(`========================================\n`);

    console.log('Received OTP. Proceeding to enter OTP...');
    saveOrUpdateAccount(email, CONFIG.password, otpCode, 'registered', '');

    // 6. Enter OTP in Meta page
    console.log(`Entering OTP: ${otpCode}`);
    const otpInputs = page.locator('input[name="code"], input[placeholder*="code" i], input[type="text"], input[type="number"]');
    await otpInputs.first().waitFor({ state: 'visible', timeout: 30000 });
    const otpInputCount = await otpInputs.count().catch(() => 0);
    
    if (otpInputCount === 6) {
      console.log('  Detected 6 separate digit input boxes. Filling digits...');
      for (let i = 0; i < 6; i++) {
        await fillHuman(page, otpInputs.nth(i), otpCode[i]);
        await sleep(rand(100, 200));
      }
    } else {
      console.log('  Filling OTP in the single code input field...');
      await fillHuman(page, otpInputs.first(), otpCode);
    }
    await sleep(rand(500, 1000));

    console.log('Submitting OTP...');
    const otpSubmitBtn = page.locator('button:has-text("Continue"), div[role="button"]:has-text("Continue"), button:has-text("Confirm"), div[role="button"]:has-text("Confirm"), button:has-text("Next"), div[role="button"]:has-text("Next")').first();
    await otpSubmitBtn.waitFor({ state: 'visible', timeout: 15000 });
    await otpSubmitBtn.click({ force: true });
    
    // Fallback JS click on the OTP submit button if visible
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, div[role="button"], span, div, a'));
      const sub = btns.find(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text === 'continue' || text === 'confirm' || text === 'next';
      });
      if (sub) {
        sub.click();
      }
    });

    console.log('Waiting for post-registration page loading...');
    
    // Selectors for onboarding screen (which means no captcha or captcha is already bypassed/done)
    const detectorFirstNameSelectors = ['input[placeholder*="First name" i]', 'input[name*="first" i]', 'input[id*="first" i]'];
    const detectorGetStartedSelectors = ['button:has-text("Get started")', 'div[role="button"]:has-text("Get started")'];
    const confirmHumanSelectors = ['text=to use your account', 'text=Confirm you\'re human'];
    const recaptchaSelector = 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]';

    let hasOnboarding = false;
    let hasCaptcha = false;
    
    const detectorDeadline = Date.now() + 30000;
    while (Date.now() < detectorDeadline) {
      // 1. Check if first name field is visible (means we are on the name details page)
      const nameInput = await findLocatorInPageOrFrames(page, detectorFirstNameSelectors);
      if (await nameInput.isVisible().catch(() => false)) {
        console.log('  Detected Name details/Onboarding screen. Skipping CAPTCHA.');
        hasOnboarding = true;
        break;
      }
      
      // 2. Check if "Get started" button is visible
      const getStartedBtn = await findLocatorInPageOrFrames(page, detectorGetStartedSelectors);
      if (await getStartedBtn.isVisible().catch(() => false)) {
        console.log('  Detected Get started button. Skipping CAPTCHA.');
        hasOnboarding = true;
        break;
      }

      // 3. Check if "Confirm you're human" header is visible
      const confirmHeader = await findLocatorInPageOrFrames(page, confirmHumanSelectors);
      if (await confirmHeader.isVisible().catch(() => false)) {
        console.log('  "Confirm you\'re human" screen detected.');
        hasCaptcha = true;
        break;
      }

      // 4. Check if recaptcha iframe is directly visible
      let foundIframe = false;
      for (const frame of [page, ...page.frames()]) {
        const el = frame.locator(recaptchaSelector).first();
        if (await el.count().catch(() => 0) > 0 && await el.isVisible().catch(() => false)) {
          foundIframe = true;
          break;
        }
      }
      if (foundIframe) {
        console.log('  reCAPTCHA iframe detected directly.');
        hasCaptcha = true;
        break;
      }

      await sleep(1000);
    }

    if (hasCaptcha) {
      // Handle the "Confirm you're human" screen if continue button is present
      const continueBtn = await findLocatorInPageOrFrames(page, [
        'text=Continue',
        'button:has-text("Continue")',
        'div[role="button"]:has-text("Continue")'
      ]);
      if (await continueBtn.isVisible().catch(() => false)) {
        console.log('  Clicking Continue to load challenge...');
        await continueBtn.click({ force: true });
        await sleep(5000);
      }

      console.log('  Waiting for reCAPTCHA challenge to load and solving...');
      const solved = await solveRecaptchaIfPresent(page, browser, 15000);
      if (solved) {
        console.log('  reCAPTCHA solved. Clicking Continue to proceed...');
        const submitBtn = await findLocatorInPageOrFrames(page, [
          'text=Continue',
          'button:has-text("Continue")',
          'div[role="button"]:has-text("Continue")'
        ]);
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click({ force: true });
          await sleep(5000);
        }
      }
    } else {
      if (!hasOnboarding) {
        console.log('  Neither CAPTCHA nor onboarding page detected within 30s, proceeding anyway...');
      }
    }

    // Step 6: Finish creating your Model API account
    console.log('Waiting for "Finish creating your Model API account" screen...');
    await sleep(5000);
    
    // Log all inputs to debug
    const inputsInfo = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(input => ({
        id: input.id,
        name: input.name,
        type: input.type,
        placeholder: input.placeholder,
        outerHTML: input.outerHTML,
        visible: input.offsetWidth > 0 && input.offsetHeight > 0
      }));
    });
    console.log('Inputs found on page:', JSON.stringify(inputsInfo, null, 2));

    // Let's find first and last name inputs robustly using findLocatorInPageOrFrames and findEditableInputsInPageOrFrames
    const firstNameSelectors = ['input[placeholder*="First name" i]', 'input[name*="first" i]', 'input[id*="first" i]'];
    const lastNameSelectors = ['input[placeholder*="Last name" i]', 'input[name*="last" i]', 'input[id*="last" i]'];

    // Wait for at least one of them to become visible in main page or any frame
    console.log('Waiting for First name field in page or frames...');
    let foundFirst = false;
    let firstNameLocator = null;
    let lastNameLocator = null;

    for (let attempt = 0; attempt < 30; attempt++) {
      const loc = await findLocatorInPageOrFrames(page, firstNameSelectors);
      if (await loc.isVisible().catch(() => false)) {
        firstNameLocator = loc;
        lastNameLocator = await findLocatorInPageOrFrames(page, lastNameSelectors);
        foundFirst = true;
        break;
      }
      // Check fallback inputs list as well
      const fallbackInputs = await findEditableInputsInPageOrFrames(page);
      if (fallbackInputs.length >= 2) {
        firstNameLocator = fallbackInputs[0];
        lastNameLocator = fallbackInputs[1];
        foundFirst = true;
        break;
      }
      await sleep(1000);
    }
    
    if (!foundFirst || !firstNameLocator || !lastNameLocator) {
      throw new Error('First name or Last name field not found in page or frames.');
    }

    // Use the name initialized at the top of the function
    console.log(`Filling random name: ${first} ${last}`);
    await firstNameLocator.fill(first);
    await sleep(rand(400, 800));
    
    await lastNameLocator.fill(last);
    await sleep(rand(400, 800));
    
    console.log('Clicking "Get started" button...');
    const getStartedSelectors = ['button:has-text("Get started")', '[role="button"]:has-text("Get started")', 'button[type="submit"]'];
    const getStartedBtn = await findLocatorInPageOrFrames(page, getStartedSelectors);
    await getStartedBtn.click({ force: true });
    await sleep(5000);
    
    // Step 7: Welcome modal popup
    console.log('Waiting for "Welcome to Meta Model API" modal...');
    const continueWelcomeBtn = page.locator('button:has-text("Continue"), [role="button"]:has-text("Continue")').first();
    await continueWelcomeBtn.waitFor({ state: 'visible', timeout: 30000 });
    console.log('Clicking Continue button on welcome modal...');
    await continueWelcomeBtn.click({ force: true });
    await sleep(5000);
    } // end of else (isLoggedIn)

    // Step 8: Navigate to billing
    console.log('Looking for "Go to billing" button/link...');
    const goToBillingBtn = page.locator('button, a, [role="button"], span').filter({ hasText: /Go to billing/i }).first();
    if (await goToBillingBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
      console.log('Clicking "Go to billing"...');
      await goToBillingBtn.click({ force: true });
    } else {
      console.log('  [WARN] "Go to billing" button not visible. Trying fallback by searching for "Billing" link/tab...');
      const billingLink = page.locator('a:has-text("Billing"), button:has-text("Billing"), span:has-text("Billing")').first();
      await billingLink.click({ force: true });
    }
    await sleep(5000);

    // Click "Add payment method"
    console.log('Clicking "Add payment method"...');
    const addPaymentBtn = page.locator('button:has-text("Add payment method"), [role="button"]:has-text("Add payment method")').first();
    await addPaymentBtn.waitFor({ state: 'visible', timeout: 15000 });
    await addPaymentBtn.click({ force: true });
    await sleep(5000);

    // Select VCC and Company Address
    let vccs = loadVCCs();
    let vccIndex = vccs.findIndex(v => v.status === 'active' && v.count < 7);
    if (vccIndex === -1) {
      throw new Error('No active VCC available in education.txt');
    }

    const { headers: compHeaders, data: compData } = loadCompanies();
    const activeCompanies = compData.filter(c => c.status === 'active');
    if (activeCompanies.length === 0) {
      throw new Error('No active company rows in company.csv');
    }
    const currentCompany = activeCompanies[Math.floor(Math.random() * activeCompanies.length)];
    console.log(`Selected company: ${currentCompany.name} (ZIP: ${currentCompany.zip})`);

    // Attempt card payments with active VCCs one by one
    while (vccIndex !== -1) {
      const vcc = vccs[vccIndex];
      console.log(`\n--- Filling payment details for VCC: ${vcc.card} ---`);

      // Log all inputs in the main page and frames
      const mainInputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(el => ({
          type: el.type,
          placeholder: el.placeholder,
          name: el.name,
          id: el.id,
          outerHTML: el.outerHTML,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0
        }));
      });
      console.log('Main page inputs:', JSON.stringify(mainInputs, null, 2));

      for (const frame of page.frames()) {
        const frameInputs = await frame.evaluate(() => {
          return Array.from(document.querySelectorAll('input')).map(el => ({
            type: el.type,
            placeholder: el.placeholder,
            name: el.name,
            id: el.id,
            outerHTML: el.outerHTML,
            visible: el.offsetWidth > 0 && el.offsetHeight > 0
          }));
        }).catch(() => []);
        if (frameInputs.length > 0) {
          console.log(`Frame inputs (${frame.name() || frame.url()}):`, JSON.stringify(frameInputs, null, 2));
        }
      }

      // Check if we are already on Screen 2 (Business details / address setup)
      let alreadyOnScreen2 = false;
      for (const frame of page.frames()) {
        try {
          const titleLoc = frame.locator(':text("Legal business name"), :text("Business address")').first();
          if (await titleLoc.isVisible().catch(() => false)) {
            alreadyOnScreen2 = true;
            break;
          }
        } catch (_) {}
      }

      let isTooManyScreen1 = false;
      let transitionedToScreen2 = alreadyOnScreen2;
      let transitionedToSuccess = false;

      if (!alreadyOnScreen2) {
        // Wait for Screen 1 inputs to settle in any frame
        let cardFieldInFrame = null;
        let activeFrameS1 = null;
        for (let attempt = 0; attempt < 30; attempt++) {
          for (const frame of page.frames()) {
            const loc = frame.locator('input[name="cardNumber"], input[placeholder*="Card number" i]').first();
            if (await loc.isVisible().catch(() => false)) {
              cardFieldInFrame = loc;
              activeFrameS1 = frame;
              break;
            }
          }
          if (cardFieldInFrame) break;
          await sleep(1000);
        }

        if (!activeFrameS1) {
          throw new Error('Timeout waiting for Screen 1 card number field in any frame.');
        }

        console.log(`Found Screen 1 inputs in frame: ${activeFrameS1.url()}`);

        // Helper to fill a field inside the active frame
        const fillInActiveS1Frame = async (selectors, value) => {
          for (const selector of selectors) {
            try {
              const locator = activeFrameS1.locator(selector).first();
              if (await locator.isVisible().catch(() => false)) {
                console.log(`  Filling field in S1 frame: ${selector}`);
                await locator.click({ force: true, timeout: 2000 }).catch(() => {});
                await sleep(rand(80, 150));
                await locator.fill('').catch(() => {});
                await sleep(rand(50, 100));
                for (const char of value) {
                  await locator.pressSequentially(char, { delay: rand(20, 50) });
                }
                return true;
              }
            } catch (_) {}
          }
          return false;
        };

        // Name on card
        const nameOnCard = `${first} ${last}`;
        console.log(`Filling Name on Card: ${nameOnCard}`);
        await fillInActiveS1Frame(['input[name*="name" i]', 'input[name="firstName"]'], nameOnCard);

        console.log(`Filling Card Number: ${vcc.card}`);
        await fillInActiveS1Frame(['input[name*="card" i]', 'input[name="cardNumber"]'], vcc.card);

        const expVal = `${vcc.month}/${vcc.year.slice(-2)}`;
        console.log(`Filling Expiry MM/YY: ${expVal}`);
        await fillInActiveS1Frame(['input[name*="exp" i]', 'input[name="expiration"]'], expVal);

        console.log(`Filling CVV/CVC: ${vcc.cvc}`);
        await fillInActiveS1Frame(['input[type="password"]', 'input[name="securityCode"]'], vcc.cvc);

        console.log(`Filling ZIP/Postal: ${currentCompany.zip}`);
        await fillInActiveS1Frame([
          'input[placeholder*="ZIP" i]',
          'input[placeholder*="Postal" i]',
          'input[name*="zip" i]',
          'input[name*="postal" i]',
          'input[id*="zip" i]',
          'input[id*="postal" i]'
        ], currentCompany.zip);

        await sleep(3000);
        await page.screenshot({ path: path.join(__dirname, 'meta_billing_filled.png') });

        // Click "Next" button on Card details screen (Screen 1)
        console.log('Submitting card details (clicking Next on Screen 1)...');
        const nextBtn1 = page.locator('button:has-text("Next"), [role="button"]:has-text("Next")').filter({ visible: true }).first();
        await nextBtn1.click({ force: true });
        await sleep(2000);

        // Wait for loading to finish: either error banner appears, Screen 2 inputs appear, or success Done button appears
        console.log('Waiting for card details submission/loading to finish...');
        for (let i = 0; i < 40; i++) {
          // Check if any loading spinner/loader is active in any frame
          let isLoaderActive = false;
          for (const frame of page.frames()) {
            try {
              const spinnerSelectors = [
                '[class*="spinner" i]', '[class*="loading" i]', '[id*="loading" i]',
                '#loader', '.loader', '.loading-wrapper', '[aria-busy="true"]', '[role="progressbar"]',
                'svg[class*="spin" i]', 'svg animateTransform'
              ];
              for (const sel of spinnerSelectors) {
                const spinner = frame.locator(sel).first();
                if (await spinner.isVisible().catch(() => false)) {
                  isLoaderActive = true;
                  break;
                }
              }
            } catch (_) {}
            if (isLoaderActive) break;
          }

          if (isLoaderActive) {
            console.log(`  [Loading] Submission is processing/loading (attempt ${i + 1}/40)...`);
            await sleep(1000);
            continue;
          }

          // Check for error banner
          for (const frame of page.frames()) {
            try {
              const content = await frame.content();
              if (content.toLowerCase().includes('already used by too many accounts') ||
                  content.toLowerCase().includes('too many accounts') ||
                  content.toLowerCase().includes('card is already used') ||
                  content.toLowerCase().includes("couldn't save card") ||
                  content.toLowerCase().includes("we weren't able to save your card") ||
                  content.toLowerCase().includes("please try again") ||
                  content.toLowerCase().includes("could not save card") ||
                  content.toLowerCase().includes("could not be verified") ||
                  content.toLowerCase().includes("declined")) {
                isTooManyScreen1 = true;
                break;
              }
            } catch (_) {}
          }
          if (isTooManyScreen1) break;

          // Check for Screen 2 text
          let foundS2Text = false;
          for (const frame of page.frames()) {
            try {
              const titleLoc = frame.locator(':text("Legal business name"), :text("Business address")').first();
              if (await titleLoc.isVisible().catch(() => false)) {
                foundS2Text = true;
                break;
              }
            } catch (_) {}
          }
          if (foundS2Text) {
            transitionedToScreen2 = true;
            break;
          }

          // Check for Success modal or Done button (direct transition to success)
          let foundSuccessModal = false;
          for (const frame of page.frames()) {
            try {
              const titleLoc = frame.locator(':text("Card successfully saved"), :text("Business information saved")').first();
              const doneLoc = frame.locator('button:has-text("Done"), [role="button"]:has-text("Done")').first();
              if (await titleLoc.isVisible().catch(() => false) || await doneLoc.isVisible().catch(() => false)) {
                foundSuccessModal = true;
                break;
              }
            } catch (_) {}
          }
          const mainDone = page.locator('button:has-text("Done"), [role="button"]:has-text("Done")').first();
          if (foundSuccessModal || await mainDone.isVisible().catch(() => false)) {
            transitionedToSuccess = true;
            break;
          }

          await sleep(500);
        }
      }

      if (isTooManyScreen1) {
        console.log(`[ERROR] VCC ${vcc.card} was rejected on Screen 1.`);
        await page.screenshot({ path: path.join(__dirname, `meta_billing_err_${vcc.card}.png`) });

        // Mark current VCC as too_many
        updateVccStatus(vcc.card, 'too_many');

        // Find next active VCC
        vccs = loadVCCs();
        vccIndex = vccs.findIndex(v => v.status === 'active' && v.count < 7);
        if (vccIndex === -1) {
          throw new Error('No active VCC available in education.txt after rotation');
        }
        
        // Reset by reloading page and re-opening payment modal to clear errors completely
        console.log('  Resetting payment modal by reloading page...');
        await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(10000);

        console.log('  Re-opening payment modal...');
        const goBillingBtn = page.locator('a:has-text("Go to billing"), button:has-text("Go to billing"), [role="button"]:has-text("Go to billing")').first();
        if (await goBillingBtn.isVisible().catch(() => false)) {
          await goBillingBtn.click({ force: true });
          await sleep(5000);
        }

        const addPaymentBtn = page.locator('button:has-text("Add payment method"), [role="button"]:has-text("Add payment method")').first();
        await addPaymentBtn.waitFor({ state: 'visible', timeout: 15000 });
        await addPaymentBtn.click({ force: true });
        await sleep(10000);

        // Loop will continue and re-fill Card details
        continue;
      }

      // Now fill Billing Address fields on the second screen (Screen 2) if required
      if (!transitionedToScreen2 && !transitionedToSuccess) {
        console.log('[ERROR] Did not transition to Screen 2 or Success. Rotating card...');
        updateVccStatus(vcc.card, 'too_many');
        vccs = loadVCCs();
        vccIndex = vccs.findIndex(v => v.status === 'active' && v.count < 7);
        if (vccIndex === -1) {
          throw new Error('No active VCC available in education.txt after rotation');
        }
        // Reset by reloading page and re-opening payment modal to clear errors completely
        console.log('  Resetting payment modal by reloading page...');
        await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(10000);

        console.log('  Re-opening payment modal...');
        const goBillingBtn = page.locator('a:has-text("Go to billing"), button:has-text("Go to billing"), [role="button"]:has-text("Go to billing")').first();
        if (await goBillingBtn.isVisible().catch(() => false)) {
          await goBillingBtn.click({ force: true });
          await sleep(5000);
        }

        const addPaymentBtn = page.locator('button:has-text("Add payment method"), [role="button"]:has-text("Add payment method")').first();
        await addPaymentBtn.waitFor({ state: 'visible', timeout: 15000 });
        await addPaymentBtn.click({ force: true });
        await sleep(10000);
        continue;
      }

      let isTooMany = false;

      if (transitionedToScreen2 && !transitionedToSuccess) {
        console.log('Filling Billing Address details on Screen 2...');
        
        // Wait a moment for Screen 2 transition to settle in DOM
        await sleep(3000);

        console.log('--- Printing all frames and inputs/selects for Screen 2 debugging ---');
        try {
          const mainPageInputs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input, select')).map(el => ({
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              placeholder: el.placeholder || '',
              name: el.name || '',
              id: el.id || '',
              outerHTML: el.outerHTML,
              visible: el.offsetWidth > 0 && el.offsetHeight > 0
            }));
          }).catch(() => []);
          console.log('Main page inputs/selects on Screen 2:', JSON.stringify(mainPageInputs, null, 2));

          for (const frame of page.frames()) {
            const frameInputs = await frame.evaluate(() => {
              return Array.from(document.querySelectorAll('input, select')).map(el => ({
                tag: el.tagName.toLowerCase(),
                type: el.type || '',
                placeholder: el.placeholder || '',
                name: el.name || '',
                id: el.id || '',
                outerHTML: el.outerHTML,
                visible: el.offsetWidth > 0 && el.offsetHeight > 0
              }));
            }).catch(() => []);
            if (frameInputs.length > 0) {
              console.log(`Frame inputs/selects (${frame.name() || frame.url()}):`, JSON.stringify(frameInputs, null, 2));
            }
          }
        } catch (err) {
          console.log('Error dumping frames/inputs:', err.message);
        }

        // Wait for Screen 2 active frame
        let activeFrame = null;
        for (let attempt = 0; attempt < 30; attempt++) {
          for (const frame of page.frames()) {
            const count = await frame.locator('input').count().catch(() => 0);
            let visibleCount = 0;
            for (let i = 0; i < count; i++) {
              const input = frame.locator('input').nth(i);
              const isVisible = await input.isVisible().catch(() => false);
              const type = await input.getAttribute('type').catch(() => 'text');
              if (isVisible && (type === 'text' || type === 'password')) {
                visibleCount++;
              }
            }
            if (visibleCount >= 4) {
              let hasCardNumber = false;
              for (let i = 0; i < count; i++) {
                const input = frame.locator('input').nth(i);
                const name = await input.getAttribute('name').catch(() => '');
                if (name === 'cardNumber' && await input.isVisible().catch(() => false)) {
                  hasCardNumber = true;
                  break;
                }
              }
              if (!hasCardNumber) {
                activeFrame = frame;
                break;
              }
            }
          }
          if (activeFrame) break;
          await sleep(1000);
        }

        if (!activeFrame) {
          throw new Error('Timeout waiting for Screen 2 active frame.');
        }

        console.log(`Found Screen 2 inputs in frame: ${activeFrame.url()}`);

        // Helper to fill a field inside the active frame by label
        const fillLabel = async (labelText, value) => {
          try {
            const locator = activeFrame.getByLabel(labelText, { exact: false }).first();
            if (await locator.isVisible().catch(() => false)) {
              console.log(`  Filling by label "${labelText}": ${value}`);
              await locator.click({ force: true, timeout: 2000 }).catch(() => {});
              await sleep(rand(80, 150));
              await locator.fill('').catch(() => {});
              await sleep(rand(50, 100));
              for (const char of value) {
                await locator.pressSequentially(char, { delay: rand(20, 50) });
              }
              return true;
            }
          } catch (_) {}
          return false;
        };

        // Try filling using precise labels first
        const filledNameS2 = await fillLabel('Legal business name', currentCompany.name);
        const filledAddressS2 = await fillLabel('Street address 1', currentCompany.address);
        const filledCityS2 = await fillLabel('City', currentCompany.city);
        const filledZipS2 = await fillLabel('Postal code', currentCompany.zip) || await fillLabel('ZIP', currentCompany.zip);

        // Check visible input elements inside the active frame
        const visibleInputs = [];
        const count = await activeFrame.locator('input').count();
        for (let i = 0; i < count; i++) {
          const input = activeFrame.locator('input').nth(i);
          const type = await input.getAttribute('type').catch(() => 'text');
          const isVisible = await input.isVisible().catch(() => false);
          const isDisabled = await input.getAttribute('disabled').catch(() => null);
          const isReadonly = await input.getAttribute('readonly').catch(() => null);
          
          if (isVisible && isDisabled === null && isReadonly === null && (type === 'text' || type === 'password')) {
            visibleInputs.push(input);
          }
        }

        console.log(`Found ${visibleInputs.length} visible text inputs inside the active frame.`);

        if (!filledNameS2 || !filledAddressS2 || !filledCityS2 || !filledZipS2) {
          console.log('Some fields were not filled by label. Using index fallback...');
          if (visibleInputs.length === 5) {
            const values = [
              currentCompany.name,    // 0: Legal business name
              currentCompany.address, // 1: Street address 1
              '',                     // 2: Street address 2 (optional)
              currentCompany.city,    // 3: City
              currentCompany.zip      // 4: ZIP/Postal code
            ];
            for (let i = 0; i < 5; i++) {
              if (values[i] === '') continue;
              const currentVal = await visibleInputs[i].inputValue().catch(() => '');
              if (currentVal.trim() === '') {
                await visibleInputs[i].click({ force: true }).catch(() => {});
                await sleep(rand(80, 150));
                await visibleInputs[i].fill('').catch(() => {});
                await sleep(rand(50, 100));
                for (const char of values[i]) {
                  await visibleInputs[i].pressSequentially(char, { delay: rand(20, 50) });
                }
              }
            }
          } else if (visibleInputs.length === 4) {
            const values = [
              currentCompany.name,    // 0: Legal business name
              currentCompany.address, // 1: Street address 1
              currentCompany.city,    // 2: City
              currentCompany.zip      // 3: ZIP/Postal code
            ];
            for (let i = 0; i < 4; i++) {
              const currentVal = await visibleInputs[i].inputValue().catch(() => '');
              if (currentVal.trim() === '') {
                await visibleInputs[i].click({ force: true }).catch(() => {});
                await sleep(rand(80, 150));
                await visibleInputs[i].fill('').catch(() => {});
                await sleep(rand(50, 100));
                for (const char of values[i]) {
                  await visibleInputs[i].pressSequentially(char, { delay: rand(20, 50) });
                }
              }
            }
          }
        }

        // State selector - we target the custom combobox role="button" matching text "State"
        let stateBtn = activeFrame.locator('[role="button"]').filter({ hasText: /State/ }).first();
        if (!(await stateBtn.isVisible().catch(() => false))) {
          stateBtn = activeFrame.locator('div[role="button"][id*="state" i], div[role="button"]:has-text("State")').first();
        }

        if (await stateBtn.isVisible().catch(() => false)) {
          console.log(`Clicking custom State dropdown button...`);
          await stateBtn.click({ force: true });
          await sleep(2000);

          const stateVal = currentCompany.state;
          const stateName = STATE_MAP[stateVal] || stateVal;
          console.log(`Selecting State: ${stateVal} (${stateName})`);

          let clickedOption = false;
          for (const frame of page.frames()) {
            const optionSelectors = [
              `[role="option"]`,
              `li`,
              `div`,
              `span`
            ];
            for (const sel of optionSelectors) {
              const loc = frame.locator(sel).filter({ hasText: new RegExp('^' + stateName + '$') }).first();
              if (await loc.isVisible().catch(() => false)) {
                console.log(`  Found option to click in frame: ${sel} containing exactly "${stateName}"`);
                await loc.click({ force: true });
                clickedOption = true;
                break;
              }
              const locVal = frame.locator(sel).filter({ hasText: new RegExp('^' + stateVal + '$') }).first();
              if (await locVal.isVisible().catch(() => false)) {
                console.log(`  Found option to click in frame: ${sel} containing exactly "${stateVal}"`);
                await locVal.click({ force: true });
                clickedOption = true;
                break;
              }
            }
            if (clickedOption) break;
          }

          if (!clickedOption) {
            console.log(`  [WARN] Option for state ${stateName} not found via click. Trying keyboard navigation fallback...`);
            await page.keyboard.type(stateName, { delay: 100 });
            await sleep(1000);
            await page.keyboard.press('Enter');
            await sleep(1000);
          }
        } else {
          console.log('  [WARN] State select button not found inside active frame.');
        }

        await sleep(2000);
        await page.screenshot({ path: path.join(__dirname, 'meta_billing_address_filled.png') });

        // Click "Next" button on Screen 2
        console.log('Submitting billing address (clicking Next on Screen 2)...');
        let nextBtn2 = activeFrame.locator('button:has-text("Next"), [role="button"]:has-text("Next")').filter({ visible: true }).first();
        if (!(await nextBtn2.isVisible().catch(() => false))) {
          nextBtn2 = (await findLocatorInPageOrFrames(page, ['button:has-text("Next")', '[role="button"]:has-text("Next")'])).filter({ visible: true }).first();
        }
        await nextBtn2.click({ force: true });
        await sleep(5000);

        // Final confirmation screen (Screen 3)
        console.log('Submitting final confirmation (clicking Save/Add/Submit on Screen 3)...');
        await page.screenshot({ path: path.join(__dirname, 'meta_billing_confirmation.png') });
        
        const saveSelectors = [
          'button:has-text("Save")',
          'button:has-text("Add")',
          'button:has-text("Submit")',
          '[role="button"]:has-text("Save")',
          '[role="button"]:has-text("Add")'
        ];
        let saveBtn = null;
        for (const sel of saveSelectors) {
          const loc = activeFrame.locator(sel).filter({ visible: true }).first();
          if (await loc.isVisible().catch(() => false)) {
            saveBtn = loc;
            break;
          }
        }
        if (!saveBtn) {
          saveBtn = (await findLocatorInPageOrFrames(page, saveSelectors)).filter({ visible: true }).first();
        }
        await saveBtn.click({ force: true });
        await sleep(10000);

        // Check for too many accounts error message in page & frames
        console.log('Checking for payment error...');
        const checkError = async (frame) => {
          try {
            const content = await frame.content();
            return content.toLowerCase().includes('already used by too many accounts') ||
                   content.toLowerCase().includes('too many accounts') ||
                   content.toLowerCase().includes('card is already used') ||
                   content.toLowerCase().includes("couldn't save card") ||
                   content.toLowerCase().includes("we weren't able to save your card") ||
                   content.toLowerCase().includes("please try again") ||
                   content.toLowerCase().includes("could not save card") ||
                   content.toLowerCase().includes("could not be verified") ||
                   content.toLowerCase().includes("declined");
          } catch (_) {
            return false;
          }
        };

        for (const frame of page.frames()) {
          if (await checkError(frame)) {
            isTooMany = true;
            break;
          }
        }
      }

      if (isTooMany) {
        console.log(`[ERROR] VCC ${vcc.card} failed validation.`);
        await page.screenshot({ path: path.join(__dirname, `meta_billing_err_${vcc.card}.png`) });

        // Mark current VCC as too_many
        updateVccStatus(vcc.card, 'too_many');

        // Find next active VCC
        vccs = loadVCCs();
        vccIndex = vccs.findIndex(v => v.status === 'active' && v.count < 7);
        if (vccIndex === -1) {
          throw new Error('No active VCC available in education.txt after rotation');
        }
        
        // Reset by reloading page and re-opening payment modal to clear errors completely
        console.log('  Resetting payment modal by reloading page...');
        await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(10000);

        console.log('  Re-opening payment modal...');
        const goBillingBtn = page.locator('a:has-text("Go to billing"), button:has-text("Go to billing"), [role="button"]:has-text("Go to billing")').first();
        if (await goBillingBtn.isVisible().catch(() => false)) {
          await goBillingBtn.click({ force: true });
          await sleep(5000);
        }

        const addPaymentBtn = page.locator('button:has-text("Add payment method"), [role="button"]:has-text("Add payment method")').first();
        await addPaymentBtn.waitFor({ state: 'visible', timeout: 15000 });
        await addPaymentBtn.click({ force: true });
        await sleep(10000);
      } else {
        // Done button to close Business information saved / Card successfully saved modal
        console.log('Dismissing billing success modal...');
        const doneBtn = page.locator('button:has-text("Done"), [role="button"]:has-text("Done")').filter({ visible: true }).first();
        if (await doneBtn.isVisible().catch(() => false)) {
          await doneBtn.click({ force: true });
          await sleep(5000);
        } else {
          // Alternative fallback to find Done button anywhere in page/frames
          const doneLoc = await findLocatorInPageOrFrames(page, ['button:has-text("Done")', '[role="button"]:has-text("Done")']);
          await doneLoc.click({ force: true }).catch(() => {});
          await sleep(5000);
        }

        // Force a page reload/navigation to refresh account state warning status
        console.log('Reloading page to refresh account state...');
        await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(5000);

        // Verify if the "No payment method on file" warning banner is still present
        const warningBanner = page.locator(':text("No payment method on file"), :text("Add one to make API requests")').first();
        const isBannerVisible = await warningBanner.isVisible().catch(() => false);
        if (isBannerVisible) {
          console.log('[ERROR] Warning banner "No payment method on file" is still visible on dashboard. Card was not added successfully.');
          
          // Mark current VCC as too_many
          updateVccStatus(vcc.card, 'too_many');

          // Find next active VCC
          vccs = loadVCCs();
          vccIndex = vccs.findIndex(v => v.status === 'active' && v.count < 7);
          if (vccIndex === -1) {
            throw new Error('No active VCC available in education.txt after rotation');
          }

          console.log('  Re-opening payment modal by clicking Go to billing / Add payment method...');
          const goBillingBtn = page.locator('a:has-text("Go to billing"), button:has-text("Go to billing"), [role="button"]:has-text("Go to billing")').first();
          if (await goBillingBtn.isVisible().catch(() => false)) {
            await goBillingBtn.click({ force: true });
            await sleep(5000);
          }
          
          const addPaymentBtn = page.locator('button:has-text("Add payment method"), [role="button"]:has-text("Add payment method")').first();
          if (await addPaymentBtn.isVisible().catch(() => false)) {
            await addPaymentBtn.click({ force: true });
            await sleep(5000);
          }
          continue;
        }

        console.log(`[SUCCESS] Payment method successfully added using VCC ${vcc.card}!`);
        saveOrUpdateAccount(email, CONFIG.password, otpCode, 'added_payment', '');
        
        // Increment usage count of VCC safely
        incrementVccCount(vcc.card);

        // Increment company usage count safely
        incrementCompanyCount(currentCompany.no);

        break;
      }
    }

    // Step 11: Create API Key
    console.log('Navigating to API keys page...');
    const apiKeysLink = page.locator('a:has-text("API keys"), button:has-text("API keys"), span:has-text("API keys")').first();
    await apiKeysLink.waitFor({ state: 'visible', timeout: 20000 });
    await apiKeysLink.click({ force: true });
    await sleep(5000);

    console.log('Clicking "Create API key"...');
    const createKeyBtn = page.locator(':text("Create API key"), :text("Create key"), :text("Generate key"), :text("Create new key"), button:has-text("Create API key"), button:has-text("Create key")').first();
    await createKeyBtn.waitFor({ state: 'visible', timeout: 20000 });
    await createKeyBtn.click({ force: true });
    await sleep(3000);

    // Check if name modal appears
    const keyNameInput = page.locator('input[placeholder*="Key name" i], input[name*="name" i], input[type="text"]').first();
    if (await keyNameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Filling key name...');
      await fillHuman(page, keyNameInput, 'MetaAutoKey');
      await sleep(1000);
      
      console.log('--- Printing dialog HTML for debugging ---');
      try {
        const dialogHTML = await page.evaluate(() => {
          const el = document.querySelector('[role="dialog"], div[class*="dialog"], div[class*="modal"]');
          return el ? el.outerHTML : 'No dialog element found';
        });
        console.log(dialogHTML);
      } catch (err) {
        console.log('Error printing dialog HTML:', err.message);
      }

      console.log('Clicking Create API key confirmation button in modal...');
      let confirmCreateBtn = page.locator('[role="dialog"] button:has-text("Create API key"), [role="dialog"] [role="button"]:has-text("Create API key"), [role="dialog"] :text("Create API key")').filter({ visible: true }).first();
      if (!(await confirmCreateBtn.isVisible().catch(() => false))) {
        // Fallback to any visible confirmation button with the text
        confirmCreateBtn = page.locator('button:has-text("Create API key"), [role="button"]:has-text("Create API key"), :text("Create API key")').filter({ visible: true }).last();
      }
      await confirmCreateBtn.click({ force: true });
      await sleep(5000);
    }

    // Retrieve the API key
    console.log('Retrieving API key...');
    const apiKey = await getApiKey(page);
    console.log(`\n========================================`);
    console.log(`GENERATED API KEY: ${apiKey}`);
    console.log(`========================================\n`);

    // Save to meta.csv
    saveOrUpdateAccount(email, CONFIG.password, otpCode, 'completed', apiKey);

    // Take final success screenshot
    await page.screenshot({ path: path.join(__dirname, 'meta_registration_success.png') });
    console.log('Saved success screenshot to meta_registration_success.png');

  } catch (err) {
    console.error('ERROR in registration sequence:', err.message);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err);
    }
    await page.screenshot({ path: path.join(__dirname, 'meta_error.png') }).catch(() => {});
    throw err;
  } finally {
    console.log('Closing browser and cleaning profile...');
    await browser.close();
  }
}

if (require.main === module) {
  (async () => {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await register();
        break; // Success!
      } catch (err) {
        console.error(`Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt === maxRetries) {
          process.exit(1);
        }
        console.log('Waiting 10 seconds before retrying clean run...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  })();
}
