async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function retry(fn, { retries = 3, delayMs = 1000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const waitMs = delayMs * attempt;
      console.log(`  [WARN] ${label} failed (${attempt}/${retries}): ${err.message}. Retrying in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function handleSecurityWarning(page) {
  try {
    const advancedBtn = page.locator('#advancedButton');
    if (await advancedBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('  [SECURITY WARNING] "Potential Security Risk Ahead" page detected. Clicking Advanced...');
      await advancedBtn.click();
      await sleep(500);
      const exceptionBtn = page.locator('#exceptionDialogButton');
      if (await exceptionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  [SECURITY WARNING] Clicking "Accept the Risk and Continue"...');
        await exceptionBtn.click();
        await sleep(2000);
        return true;
      }
    }
  } catch (err) {
    console.log('  [WARN] Failed to handle security warning:', err.message);
  }
  return false;
}

async function gotoWithRetry(page, url, options = {}, retries = 2) {
  const isFatalProxyErr = (msg = '') => /NS_ERROR_PROXY_|NS_ERROR_CONNECTION_|ERR_PROXY_|ERR_TUNNEL_|ECONNREFUSED|PR_CONNECT_RESET|refusing connections|Problem loading page/i.test(msg);

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const timeout = options.timeout || 25000;
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout, ...options });
      await handleSecurityWarning(page);
      return response;
    } catch (err) {
      const bypassed = await handleSecurityWarning(page);
      if (bypassed) {
        return;
      }
      lastError = err;
      if (isFatalProxyErr(err.message) || attempt === retries) {
        throw err;
      }
      console.log(`  [WARN] open ${url} failed (${attempt}/${retries}): ${err.message}. Retrying in 1.5s...`);
      await sleep(1500);
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

// Human-like typing for Xiaomi registration (character by character press)
async function typeHuman(page, selector, text) {
  const el = page.locator(selector).first();
  try {
    await el.click({ force: true, timeout: 3000 });
  } catch (err) {
    await el.focus();
  }
  await sleep(rand(200, 500));
  for (const char of text) {
    await el.press(char);
    await sleep(rand(60, 180));
  }
}

// Human-like typing for Qoder registration (using pressSequentially with thinking pauses)
async function typeHumanQoder(page, selector, text) {
  const el = page.locator(selector).first();
  try {
    await el.click({ force: true, timeout: 3000 });
  } catch (err) {
    await el.focus();
  }
  await sleep(rand(200, 600));
  for (const char of text) {
    await el.pressSequentially(char, { delay: rand(50, 180) });
    // Occasional pause (like thinking)
    if (Math.random() < 0.05) await sleep(rand(300, 800));
  }
}

// Human-like fast input filling
async function fillHuman(page, locator, text) {
  try {
    await locator.click({ timeout: 2000 }).catch(() => {});
    await locator.fill(''); // Always clear input completely first to prevent duplicate/appended text
    await sleep(rand(50, 100));
    await locator.pressSequentially(text, { delay: rand(30, 80) });
    await sleep(rand(100, 200));
    
    // Verify value matches exactly
    const val = await locator.inputValue().catch(() => '');
    if (val !== text) {
      await locator.fill(text);
    }
  } catch (_) {
    await locator.fill(text).catch(() => {});
  }
}

// Random mouse movement to simulate human behavior
async function humanMouseMove(page) {
  const x = rand(100, 1200);
  const y = rand(100, 600);
  await page.mouse.move(x, y, { steps: rand(5, 15) });
  await sleep(rand(100, 400));
}

// Random scroll behavior
async function humanScroll(page) {
  const deltaY = rand(-200, 200);
  await page.mouse.wheel(0, deltaY);
  await sleep(rand(300, 800));
}

// Try to click the first visible element matching any of the selectors/texts
async function clickFirst(page, selectors, description = 'element', timeout = 1000) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout }).catch(() => false)) {
      await el.click();
      console.log(`  Clicked: ${description} (${sel})`);
      return true;
    }
  }
  console.log(`  [WARN] ${description} not found`);
  return false;
}

// Cookie agreement handler
async function handleCookies(page, waitMs = 500) {
  if (waitMs > 0) await sleep(waitMs);

  const buttonSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Reject non-essential")',
    'div:has-text("We use cookies") button:has-text("Accept all")',
    'div:has-text("We use cookies") button:has-text("Reject non-essential")',
    'div:has-text("We use cookies") button[aria-label="Close"]',
    '#wcpConsentBannerCtrl button:has-text("Accept")',
    '#wcpConsentBannerCtrl button:has-text("Reject")',
    'div:has-text("We use optional cookies") button:has-text("Accept")',
    'div:has-text("We use optional cookies") button:has-text("Reject")',
    '#js-global-screen-reader-notice + div button:has-text("Accept")',
    '#onetrust-accept-btn-handler',
    '#onetrust-reject-all-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept all cookies")',
    'button:text-is("Accept")',
    'button:has-text("Accept")',
    'button:has-text("Allow all")',
    'button:has-text("Allow All")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Confirm My Choices")',
    'button:has-text("Confirm my choices")',
    'button:has-text("Reject All")',
    'button:has-text("Reject all")',
    'button:text-is("Reject")',
    'a:has-text("Accept all")',
    '[class*="cookie"] button:has-text("Accept")',
    '[class*="cookie"] button:has-text("OK")',
    '[aria-label*="cookies"] button',
    '.save-preferences-btn-handler',
    '.onetrust-close-btn-handler',
    '.cookie-accept',
  ];

  for (const selector of buttonSelectors) {
    try {
      const btn = page.locator(selector).filter({ visible: true }).first();
      if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
        await btn.click({ timeout: 2000, force: true }).catch(() => {});
        console.log(`  Cookies banner dismissed via: ${selector}`);
        await sleep(500);
        return;
      }
    } catch (_) {}
  }
}

// Click an element with Bezier curve mouse movement and random offset click
async function clickHuman(page, locator, timeout = 5000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    const box = await locator.boundingBox();
    if (box && box.width > 2 && box.height > 2) {
      const startX = rand(100, 1200);
      const startY = rand(100, 700);
      
      const targetX = box.x + rand(Math.floor(box.width * 0.2), Math.floor(box.width * 0.8));
      const targetY = box.y + rand(Math.floor(box.height * 0.2), Math.floor(box.height * 0.8));
      
      const ctrl1X = startX + (targetX - startX) * 0.3 + rand(-50, 50);
      const ctrl1Y = startY + (targetY - startY) * 0.3 + rand(-50, 50);
      const ctrl2X = targetX + rand(-20, 20);
      const ctrl2Y = targetY + rand(-20, 20);
      
      const steps = rand(10, 20);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = Math.pow(1-t, 3) * startX + 3 * Math.pow(1-t, 2) * t * ctrl1X + 3 * (1-t) * Math.pow(t, 2) * ctrl2X + Math.pow(t, 3) * targetX;
        const y = Math.pow(1-t, 3) * startY + 3 * Math.pow(1-t, 2) * t * ctrl1Y + 3 * (1-t) * Math.pow(t, 2) * ctrl2Y + Math.pow(t, 3) * targetY;
        await page.mouse.move(x, y);
        await sleep(rand(10, 25));
      }
      
      await sleep(rand(80, 200));
      await page.mouse.click(targetX, targetY);
      return true;
    }
  } catch (_) {}
  
  await locator.click({ force: true }).catch(() => {});
  return false;
}

const {
  loadProxyList,
  selectProxy,
  proxyFromUrl,
  isProxyError,
  markProxyDead,
  handleProxyFailure,
} = require('./proxy.js');

module.exports = {
  sleep,
  retry,
  gotoWithRetry,
  fetchWithTimeout,
  withTimeout,
  rand,
  typeHuman,
  typeHumanQoder,
  fillHuman,
  clickHuman,
  humanMouseMove,
  humanScroll,
  clickFirst,
  handleCookies,
  loadProxyList,
  selectProxy,
  proxyFromUrl,
  isProxyError,
  markProxyDead,
  handleProxyFailure,
};

