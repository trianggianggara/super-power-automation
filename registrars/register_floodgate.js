#!/usr/bin/env node
/**
 * register_floodgate.js — Auto-register FloodGate.dev account
 * Uses Chrome CDP incognito mode + Turnstile solver (same pattern as register_cloudflare.js)
 * 
 * Usage: node registrars/register_floodgate.js
 * Env: HEADLESS=false (default), PROXY=http://host:port, AFF=GCTp
 */

const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealthPlugin);

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { setTimeout: sleep } = require('timers/promises');

const CONFIG = {
  signupUrl: `https://floodgate.dev/sign-up?aff=${process.env.AFF || 'GCTp'}`,
  signInUrl: 'https://floodgate.dev/sign-in',
  password: process.env.PASSWORD || 'PortoAuto2025!',
  outputFile: path.join(__dirname, '..', 'data', 'floodgate_accounts.csv'),
  proxy: process.env.PROXY || null,
  browserExecutable: '/usr/bin/google-chrome-stable',
  headless: process.env.HEADLESS === 'true',
};

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function randomString(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function generateEmail() {
  const domains = (process.env.TEMPMAIL_WEBHOOK_DOMAIN || 'dellakuyang.com,dellakuyang.my').split(',').map(d => d.trim()).filter(Boolean);
  const domain = domains[Math.floor(Math.random() * domains.length)];
  const user = randomString(10);
  return `${user}@${domain}`;
}

function generateUsername() {
  const prefixes = ['user', 'dev', 'test', 'auto', 'bot'];
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]}${randomString(6)}`;
}

async function fillHuman(page, locator, text) {
  await locator.click({ force: true }).catch(() => {});
  await sleep(rand(80, 150));
  await locator.fill('');
  for (let i = 0; i < text.length; i++) {
    await locator.type(text[i]);
    await sleep(rand(30, 70));
  }
  await locator.dispatchEvent('input').catch(() => {});
  await locator.dispatchEvent('change').catch(() => {});
  await sleep(rand(80, 150));
}

async function ensureChromeRunning(executablePath = CONFIG.browserExecutable, port = 9222, proxy = null) {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      log(`Chrome CDP already running on port ${port}.`);
      return true;
    }

    const tempProfileDir = `/tmp/chrome-floodgate-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--start-maximized',
    ];

    if (proxy && proxy.server) {
      args.push(`--proxy-server=${proxy.server}`);
    }

    const chromeProcess = spawn(executablePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    chromeProcess.unref();

    for (let i = 0; i < 25; i++) {
      await sleep(400);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (res && res.ok) {
        log('Chrome spawned and CDP port active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Chrome CDP port ${port}.`);
  } catch (err) {
    log(`[ERROR] ensureChromeRunning: ${err.message}`);
    throw err;
  }
}

/**
 * Monitor and solve Cloudflare Turnstile challenge.
 * Same pattern as register_cloudflare.js — click checkbox in turnstile iframe.
 */
async function monitorTurnstile(page, maxWaitMs = 30000) {
  const startTime = Date.now();
  let lastClickTime = 0;
  let clickCount = 0;

  while (Date.now() - startTime < maxWaitMs) {
    const frames = page.frames();
    let activeFrame = null;

    for (const f of frames) {
      const url = f.url();
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
        activeFrame = f;
        break;
      }
    }

    // Also check for turnstile widget on page
    const pageState = await page.evaluate(() => {
      const challenges = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile, [data-sitekey]');
      const challengeStage = document.querySelector('#challenge-stage');
      return {
        hasChallenge: challenges.length > 0,
        hasChallengeStage: !!challengeStage,
        isChallengePage: window.location.href.includes('challenges.cloudflare.com'),
      };
    }).catch(() => ({ hasChallenge: false, hasChallengeStage: false, isChallengePage: false }));

    // Check if turnstile already solved (token injected)
    const token = await page.evaluate(() => {
      const input = document.querySelector('input[name="cf-turnstile-response"], input[name="turnstile-token"]');
      return input ? input.value : null;
    }).catch(() => null);

    if (token && token.length > 10) {
      log('[Turnstile] Token detected — challenge solved!');
      return true;
    }

    const now = Date.now();
    if (now - lastClickTime > 3000) {
      // Strategy A: Click inside turnstile iframe
      if (activeFrame) {
        try {
          const frameElement = await activeFrame.frameElement().catch(() => null);
          if (frameElement) {
            await frameElement.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(300);
            const box = await frameElement.boundingBox().catch(() => null);
            if (box && box.width > 0 && box.height > 0) {
              const clickX = box.x + Math.min(30, box.width / 2);
              const clickY = box.y + Math.min(35, box.height / 2);
              clickCount++;
              log(`[Turnstile Click #${clickCount}] (${Math.round(clickX)}, ${Math.round(clickY)})`);
              await page.mouse.move(clickX - 50, clickY - 30, { steps: 8 });
              await sleep(rand(100, 200));
              await page.mouse.move(clickX, clickY, { steps: 5 });
              await sleep(rand(50, 100));
              await page.mouse.click(clickX, clickY).catch(() => {});
              lastClickTime = now;
            }
          }
        } catch (_) {}

        // Strategy B: Direct locator click inside frame
        try {
          const cb = activeFrame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, .mark').first();
          if (await cb.isVisible({ timeout: 1000 }).catch(() => false)) {
            await cb.click().catch(() => {});
            lastClickTime = now;
          }
        } catch (_) {}
      }

      // Strategy C: Click challenge-stage on main page
      if (pageState.hasChallengeStage || pageState.isChallengePage) {
        try {
          const stage = page.locator('#challenge-stage, .cf-turnstile-wrapper, #turnstile-wrapper').first();
          if (await stage.isVisible({ timeout: 1000 }).catch(() => false)) {
            const box = await stage.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
              lastClickTime = now;
            }
          }
        } catch (_) {}
      }
    }

    await sleep(500);
  }

  log('[Turnstile] Timeout waiting for token.');
  return false;
}

function saveAccount(account) {
  const dir = path.dirname(CONFIG.outputFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CONFIG.outputFile)) {
    fs.writeFileSync(CONFIG.outputFile, '"email","password","username","created_at"\n');
  }
  const line = `"${account.email}","${account.password}","${account.username}","${new Date().toISOString()}"\n`;
  fs.appendFileSync(CONFIG.outputFile, line);
  log(`[SUCCESS] Account saved to ${CONFIG.outputFile}`);
}

async function main() {
  const email = generateEmail();
  const username = generateUsername();
  log(`Generated Email: ${email}`);
  log(`Generated Username: ${username}`);

  const proxyArg = CONFIG.proxy;
  let pc = null;
  if (proxyArg) {
    const match = proxyArg.match(/^(https?:\/\/)?([^:]+):(\d+)$/);
    if (match) {
      pc = { server: `${match[2]}:${match[3]}` };
    }
  }

  log(`Using Browser: Chrome Stable (Incognito CDP)`);
  if (pc) log(`Using Proxy: ${pc.server}`);

  let browser;
  let context;

  try {
    const dynamicPort = Math.floor(19000 + Math.random() * 6000);
    await ensureChromeRunning(CONFIG.browserExecutable, dynamicPort, pc);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  } catch (err) {
    log(`CDP failed: ${err.message}. Falling back to standard launch...`);
    const launchOpts = {
      headless: CONFIG.headless,
      executablePath: CONFIG.browserExecutable,
      args: [
        '--incognito',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    };
    if (pc) {
      launchOpts.proxy = { server: pc.server };
    }
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // Inject stealth: hide webdriver, fake plugins, etc
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  // Store affiliate code in localStorage before page loads
  await page.addInitScript((affCode) => {
    try { window.localStorage.setItem('aff', affCode); } catch (e) {}
  }, process.env.AFF || 'GCTp');

  try {
    log(`Navigating to ${CONFIG.signupUrl}...`);
    await page.goto(CONFIG.signupUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

    // Wait for React SPA to render
    log('Waiting for sign-up form to render...');
    await page.waitForSelector('input', { timeout: 15000 });
    await sleep(1000);

    // Take screenshot of form for debugging
    await page.screenshot({ path: path.join(__dirname, 'floodgate_form.png') }).catch(() => {});
    log('Screenshot saved: floodgate_form.png');

    // Find and fill username field
    log('Filling username...');
    const usernameInput = page.locator('input[name="username"], input[placeholder*="username" i], input[type="text"]').first();
    if (await usernameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await fillHuman(page, usernameInput, username);
    } else {
      log('[WARN] Username field not found, trying generic input...');
    }

    // Find and fill email field
    log('Filling email...');
    const emailInput = page.locator('input[name="email"], input[type="email"], input[placeholder*="email" i]').first();
    if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await fillHuman(page, emailInput, email);
    } else {
      log('[WARN] Email field not found.');
    }

    // Find and fill password field
    log('Filling password...');
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
    if (await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await fillHuman(page, passwordInput, CONFIG.password);
    }

    // Find and fill confirm password if present
    const confirmInput = page.locator('input[name="confirmPassword"], input[name="confirm_password"], input[placeholder*="confirm" i]').first();
    if (await confirmInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      log('Filling confirm password...');
      await fillHuman(page, confirmInput, CONFIG.password);
    }

    await sleep(500);

    // Check for Turnstile CAPTCHA
    log('Checking for Turnstile CAPTCHA...');
    const turnstileFound = await page.evaluate(() => {
      return !!document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-sitekey]');
    }).catch(() => false);

    if (turnstileFound) {
      log('[Turnstile] Challenge detected. Attempting to solve...');
      const solved = await monitorTurnstile(page, 30000);
      if (solved) {
        log('[Turnstile] Solved!');
      } else {
        log('[Turnstile] Failed to auto-solve. Waiting 60s for manual solve...');
        const manualSolved = await monitorTurnstile(page, 60000);
        if (!manualSolved) {
          log('[Turnstile] Manual solve timeout. Continuing anyway...');
        }
      }
    } else {
      log('No Turnstile detected.');
    }

    // Click submit button
    log('Clicking Sign Up button...');
    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("Sign Up"), button:has-text("Register"), button:has-text("Create")').first();
    await submitBtn.waitFor({ timeout: 10000 });
    await sleep(rand(300, 600));
    await submitBtn.click();
    log('Submit button clicked.');

    // Wait for response
    log('Waiting for registration confirmation...');
    const submitStart = Date.now();
    let resultUrl = page.url();
    while (Date.now() - submitStart < 20000) {
      resultUrl = page.url();
      if (!resultUrl.includes('sign-up') && !resultUrl.includes('signup')) {
        log(`Redirected to: ${resultUrl}`);
        break;
      }
      // Check for error messages
      const errorText = await page.evaluate(() => {
        const errorEls = Array.from(document.querySelectorAll('[role="alert"], .text-danger, .text-red, .error, [class*="error" i], [class*="alert" i]'));
        return errorEls.map(e => (e.textContent || '').trim()).filter(Boolean).join(' | ');
      }).catch(() => '');
      if (errorText) {
        log(`⚠️ Error: ${errorText}`);
        break;
      }
      await sleep(500);
    }

    await page.screenshot({ path: path.join(__dirname, 'floodgate_result.png') }).catch(() => {});
    log(`Result URL: ${resultUrl}`);

    // Check for verification OTP prompt
    const otpPrompt = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return /verification|verify|otp|code|email.*sent/i.test(text);
    }).catch(() => false);

    if (otpPrompt) {
      log('Email verification required. Waiting for OTP...');
      // TODO: integrate TempMail for OTP retrieval
      log('[INFO] Manual OTP entry may be required at this point.');
    }

    // Save account
    saveAccount({ email, password: CONFIG.password, username });
    log('[DONE] Registration flow completed.');

  } catch (err) {
    log(`[ERROR] ${err.message}`);
    await page.screenshot({ path: path.join(__dirname, 'floodgate_error.png') }).catch(() => {});
    throw err;
  } finally {
    try { await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
