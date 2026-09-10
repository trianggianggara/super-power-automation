// Qoder Auto-Registration Bot — orchestrator.
//
// The heavy lifting lives in steps/* (one module per phase). This file wires
// everything together: config, browser launch, anti-bot init script, and the
// per-run loop.

// Load Environment Variables
const { loadEnv } = require('../utils/env.js');
loadEnv();

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag, proxyFromUrl, selectProxy, handleProxyFailure } = require('../utils/browser.js');

const { sleep, rand, withTimeout } = require('../utils/helpers');

// Modular steps
const { stepNavigatePlatform, stepNavigateQoder, handlePlatformPassword } = require('../steps/navigate');
const { stepOpenOAuth, stepHandleOAuth, stepNavigateOAuthDirect } = require('../steps/oauth');
const { stepCreateCredentials, stepFillForm, stepEnterPassword } = require('../steps/registration');
const { stepVerifyCaptcha } = require('../steps/captcha');
const { stepInputOtp } = require('../steps/otp');

// ─── CONFIG ──────────────────────────────────────────────
const CONFIG = {
  // Platform URL
  platformUrl: process.env.PLATFORM_URL,
  // Qoder provider page
  qoderUrl: process.env.QODER_URL,
  // Output file
  outputFile: path.join(__dirname, '..', 'data', 'qoder.csv'),
  // Platform password (for first-time access)
  platformPassword: process.env.PLATFORM_PASSWORD,
  // Password for Qoder accounts
  password: process.env.QODER_ACCOUNT_PASSWORD,
  // Timeouts (ms)
  otpTimeout: 180000,
  navigateTimeout: 30000,
  captchaTimeout: 180000,
  stepTimeout: Number(process.env.STEP_TIMEOUT_MS || 90000),
  captchaStepTimeout: Number(process.env.CAPTCHA_STEP_TIMEOUT_MS || 210000),
  // Number of registration loops
  loops: Number(process.env.LOOPS || 5),
  // Captcha mode: 'llm' (falls back to manual) | 'manual'
  captchaMode: 'llm',
  // LLM API configuration (Alibaba captcha is not supported automatically, falls back to manual)
  llmApiKey: process.env.LLM_API_KEY,
  llmApiUrl: process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions',
  llmModel: process.env.LLM_MODEL || 'cx/gpt-5.4-mini',
  // User-Agent (kept in sync with the context UA below; used by captcha solvers)
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  // Proxy (optional)
  proxy: process.env.PROXY || '',
  browserExecutablePath: resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || ''),
};

// ─── PKCE & REMOTE OMNIROUTE HELPERS ──────────────────────
async function pollDeviceTokenInBrowser(dashPage, nonce, verifier) {
  return await dashPage.evaluate(async ({ nonce, verifier }) => {
    const url = `https://openapi.qoder.sh/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`;
    const startTime = Date.now();
    const timeoutMs = 180000;
    const intervalMs = 2000;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const res = await fetch(url, {
          headers: { 'Accept': 'application/json' }
        });
        if (res.status === 200) {
          const body = await res.json();
          if (body && body.token) {
            return body;
          }
        }
      } catch (err) {
        // ignore and retry
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('Device token polling timed out');
  }, { nonce, verifier });
}

async function fetchUserPatInBrowser(dashPage, accessToken) {
  return await dashPage.evaluate(async (token) => {
    const res = await fetch('https://openapi.qoder.sh/api/v1/userinfo?accessToken=' + encodeURIComponent(token), {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const body = await res.json();
      if (body && body.success) {
        return body.data;
      }
    }
    return null;
  }, accessToken);
}

async function saveConnectionToOmniRoute(dashPage, { email, pat }) {
  const payload = {
    provider: 'qoder',
    authType: 'apikey',
    name: `qoder-${email}`,
    apiKey: pat,
    priority: 1,
    isActive: true,
    providerSpecificData: {
      authMode: 'pat',
      transport: 'qodercli'
    }
  };

  return await dashPage.evaluate(async (payload) => {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
  }, payload);
}

function saveQoderResult(outputFile, data) {
  const csvHeaders = 'timestamp,platform,first_name,last_name,email,password,status,api_key';
  const csvRow = [
    new Date().toISOString(),
    'qoder',
    data.firstName || '',
    data.lastName || '',
    data.email || '',
    data.password || '',
    data.status || 'registered',
    data.apiKey || ''
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

  const exists = fs.existsSync(outputFile);
  if (!exists) {
    fs.writeFileSync(outputFile, csvHeaders + '\n', 'utf8');
  }
  fs.appendFileSync(outputFile, csvRow + '\n', 'utf8');
  console.log(`  Saved to CSV: ${outputFile}`);
}

// ─── SINGLE REGISTRATION FLOW ────────────────────────────
async function registerOnce(dashPage, context, runIndex, capturedConfig) {
  const tag = `[Run ${runIndex}]`;
  const ctx = { dashPage, context, runIndex, tag, CONFIG, capturedConfig };
  const runStep = (label, fn, timeoutMs = CONFIG.stepTimeout) =>
    withTimeout(fn(), timeoutMs, `${tag} ${label}`);

  // Setup custom saveResult as a no-op so otp.js doesn't write incomplete CSV entries
  ctx.saveResult = () => {};

  try {
    // 1. Initiate PKCE and navigate to the direct registration URL
    await runStep('Preparing direct PKCE OAuth URL', () => stepNavigateOAuthDirect(ctx), 60000);

    // 2. Create the temp email and names
    await runStep('Creating credentials', () => stepCreateCredentials(ctx), 60000);

    // 3. Fill the sign up form
    await runStep('Filling form', () => stepFillForm(ctx), 90000);

    // 4. Enter password
    await runStep('Entering password', () => stepEnterPassword(ctx), 90000);

    // 5. Solve the verification captcha
    await runStep('Verifying captcha', () => stepVerifyCaptcha(ctx), CONFIG.captchaStepTimeout);

    // 6. Enter OTP to complete registration
    const otpSuccess = await runStep('Input OTP', () => stepInputOtp(ctx), CONFIG.otpTimeout + 120000);

    if (!otpSuccess) {
      saveQoderResult(CONFIG.outputFile, {
        firstName: ctx.firstName,
        lastName: ctx.lastName,
        email: ctx.email,
        password: CONFIG.password,
        status: 'otp_failed'
      });
      return false;
    }

    // 7. Poll token, fetch user profile, and save to OmniRoute
    await runStep('Polling and saving to OmniRoute', async () => {
      const { nonce, verifier } = ctx.pkce;
      console.log(`${tag} Polling Qoder device token...`);
      const tokenBody = await pollDeviceTokenInBrowser(dashPage, nonce, verifier);
      console.log(`${tag} Device token received! Fetching user PAT...`);

      const patBody = await fetchUserPatInBrowser(dashPage, tokenBody.token);
      if (!patBody || !patBody.apiKey) {
        throw new Error('Failed to retrieve Qoder PAT from userinfo');
      }

      console.log(`${tag} Qoder PAT retrieved: ${patBody.apiKey.slice(0, 10)}...`);

      // Save connection to OmniRoute
      const saveRes = await saveConnectionToOmniRoute(dashPage, {
        email: ctx.email,
        pat: patBody.apiKey
      });

      if (!saveRes.ok) {
        throw new Error(`Failed to save connection to OmniRoute: ${saveRes.status} ${saveRes.body}`);
      }

      console.log(`${tag} Successfully saved Qoder connection to OmniRoute!`);

      // Save to CSV
      saveQoderResult(CONFIG.outputFile, {
        firstName: ctx.firstName,
        lastName: ctx.lastName,
        email: ctx.email,
        password: CONFIG.password,
        apiKey: patBody.apiKey,
        status: 'registered_and_imported'
      });
    }, 180000);

    // Close the oauth tab after success
    await ctx.oauthPage?.close().catch(() => {});
    return true;
  } catch (err) {
    console.error(`${tag} ERROR: ${err.message}`);
    if (CONFIG.proxy) {
      handleProxyFailure(CONFIG.proxy, err);
    }
    // Save error state to CSV
    saveQoderResult(CONFIG.outputFile, {
      firstName: ctx.firstName,
      lastName: ctx.lastName,
      email: ctx.email,
      password: CONFIG.password,
      status: err.message.includes('timeout') ? 'timeout' : 'error'
    });
    await ctx.oauthPage?.close().catch(() => {});
    return false;
  } finally {
    console.log(`${tag} Done.`);
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────
async function main() {
  console.log('=== Qoder Auto-Registration Bot ===');
  console.log(`Loops: ${CONFIG.loops}`);
  console.log(`Captcha: ${CONFIG.captchaMode}`);
  console.log(`LLM API key: ${CONFIG.llmApiKey ? 'set' : 'NOT SET'}`);
  console.log('');

  console.log('[0] Launching browser...');
  const launchOpts = {
    headless: envFlag('HEADLESS'),
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
    ],
  };
  const selectedProxy = selectProxy(CONFIG.proxy);
  if (selectedProxy) {
    launchOpts.proxy = proxyFromUrl(selectedProxy);
    console.log(`  Proxy: ${selectedProxy}`);
  }
  if (CONFIG.browserExecutablePath) {
    launchOpts.executablePath = CONFIG.browserExecutablePath;
    console.log(`  Browser: ${CONFIG.browserExecutablePath}`);
  }
  const browser = await browserTypeFor(CONFIG.browserExecutablePath).launch(launchOpts);

  // Randomize viewport slightly
  const vpWidth = 1366 + rand(-20, 20);
  const vpHeight = 768 + rand(-10, 10);

  const contextOpts = {
    userAgent: CONFIG.userAgent,
    viewport: { width: vpWidth, height: vpHeight },
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
  };
  if (isCamoufox(CONFIG.browserExecutablePath)) contextOpts.viewport = null;
  const context = await browser.newContext(contextOpts);

  // Anti-bot: remove webdriver flag + patch chrome properties + hook AliyunCaptcha
  await context.addInitScript(() => {
    // Remove webdriver property
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'id'],
    });
    // Patch chrome
    window.chrome = { runtime: {} };
    // Patch permissions query
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);

    // ── AliyunCaptcha hook ────────────────────────────────────────────
    // The SDK defines initAliyunCaptcha AFTER our init script runs, so a plain
    // wrap at this point would miss it. We use a getter/setter trap on window
    // that intercepts the SDK's own assignment, then wraps the real function.
    window.__aliyunCaptchaConfig = { sceneId: null, prefix: null, mode: null };
    window.__aliyunCaptchaCallbacks = {};   // store ALL function opts from init
    let _initAliyunCaptcha;
    try {
      Object.defineProperty(window, 'initAliyunCaptcha', {
        configurable: true,
        get() { return _initAliyunCaptcha; },
        set(realFn) {
          _initAliyunCaptcha = function (opts) {
            try {
              if (opts) {
                window.__aliyunCaptchaConfig.sceneId = opts.SceneId || opts.sceneId || null;
                window.__aliyunCaptchaConfig.prefix = opts.prefix || opts.Prefix || null;
                window.__aliyunCaptchaConfig.mode = opts.mode || null;
                console.log('[hook] initAliyunCaptcha called with SceneId=' +
                  (opts.SceneId || opts.sceneId) + ', prefix=' + (opts.prefix || opts.Prefix));

                // Store EVERY function option so we can invoke the real callback later
                for (const key of Object.keys(opts)) {
                  if (typeof opts[key] === 'function') {
                    window.__aliyunCaptchaCallbacks[key] = opts[key];
                    console.log('[hook] captured callback: ' + key);
                  }
                }
              }
            } catch (_) {}
            const instance = realFn.apply(this, arguments);
            window.__aliyunCaptchaInstance = instance;
            return instance;
          };
        },
      });
    } catch (_) {}
  });

  // ── Observe AliyunCaptcha network responses ───────────────────────────
  // context.route() with glob wildcards is unreliable for subdomain matching.
  // We use a response listener instead — it observes without intercepting, and
  // we filter with regex so any Aliyun captcha endpoint is caught.
  const capturedConfig = { sceneId: null, prefix: null };

  // Regex helpers
  const findSceneId = (text) => {
    if (!text) return null;
    const patterns = [
      // "sceneId":"xxxx" or sceneId:"xxxx" (JSON / JS object, any case)
      /["']?(?:sceneId|SceneId|captchaSceneId|CaptchaSceneId)["']?\s*:\s*["']([a-zA-Z0-9_-]{4,})["']/i,
      // sceneId=xxxx or sceneId xxxx (query / loose)
      /(?:sceneId|SceneId)["\s:=]+["']?([a-zA-Z0-9_-]{4,})/i,
      // ?sceneId=xxxx or &sid=xxxx
      /[?&](?:sceneId|SceneId|sid)=([a-zA-Z0-9_-]+)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1];
    }
    return null;
  };
  // Match any Aliyun captcha-related URL: *.captcha-open.aliyuncs.com, aliyuncs.com/captcha, etc.
  const aliyunUrlRe = /aliyuncs\.com|aliyunCaptcha|captcha-open|aliyun captcha/i;

  context.on('response', async (response) => {
    try {
      const url = response.url();
      if (!aliyunUrlRe.test(url)) return;

      console.log(`  [observe] response: ${url.slice(0, 100)}`);

      // Prefix from subdomain: https://{prefix}.captcha-open[-region].aliyuncs.com/...
      // Note: subdomain is "captcha-open-southeast" for SG region, not just "captcha-open"
      const prefixMatch = url.match(/https?:\/\/([a-z0-9]+)\.(?:captcha-open[a-z-]*\.)*aliyuncs\.com/i);
      if (prefixMatch && !capturedConfig.prefix) {
        capturedConfig.prefix = prefixMatch[1];
        console.log(`  [observe] Aliyun prefix: ${capturedConfig.prefix}`);
      }

      // sceneId in URL
      const urlSid = findSceneId(url);
      if (urlSid && !capturedConfig.sceneId) {
        capturedConfig.sceneId = urlSid;
        console.log(`  [observe] Aliyun sceneId (from URL): ${capturedConfig.sceneId}`);
      }

      // sceneId in response body (only text/json responses)
      const ct = response.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('javascript') || ct.includes('html')) {
        const body = await response.text().catch(() => '');
        if (body) {
          const bodySid = findSceneId(body);
          if (bodySid && !capturedConfig.sceneId) {
            capturedConfig.sceneId = bodySid;
            console.log(`  [observe] Aliyun sceneId (from body): ${capturedConfig.sceneId}`);
          }
          // Debug: dump first 200 chars if no sceneId found yet (helps diagnose format)
          if (!capturedConfig.sceneId && body.length < 2000) {
            console.log(`  [observe] body preview: ${body.slice(0, 200).replace(/\n/g, ' ')}`);
          }
        }
      }
    } catch (_) {}
  });

  // Open persistent dashboard tab (stays open across all loops)
  const dashPage = await context.newPage();

  // Resolve correct platform URL/password
  const resolvedPlatformUrl = (CONFIG.platformUrl && !CONFIG.platformUrl.includes('your-platform-url'))
    ? CONFIG.platformUrl
    : (process.env.OMNIROUTE_URL || 'http://localhost:20128');
  CONFIG.platformUrl = resolvedPlatformUrl;

  const resolvedQoderUrl = (CONFIG.qoderUrl && !CONFIG.qoderUrl.includes('your-platform-url'))
    ? CONFIG.qoderUrl
    : (resolvedPlatformUrl.replace(/\/$/, '') + '/dashboard/providers/qoder');
  CONFIG.qoderUrl = resolvedQoderUrl;

  console.log(`[0] Logging in to platform at: ${CONFIG.platformUrl}...`);
  await dashPage.goto(CONFIG.platformUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // First-time access password prompt
  const hasPrompt = await handlePlatformPassword(dashPage, {
    platformPassword: (CONFIG.platformPassword && CONFIG.platformPassword !== 'your_platform_password')
      ? CONFIG.platformPassword
      : (process.env.OMNIROUTE_PASSWORD || '123456')
  });
  if (hasPrompt) {
    console.log('  Waiting for dashboard redirect...');
    await dashPage.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {});
    await sleep(2000);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 1; i <= CONFIG.loops; i++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  REGISTRATION LOOP ${i} / ${CONFIG.loops}`);
    console.log(`${'='.repeat(50)}\n`);

    const success = await registerOnce(dashPage, context, i, capturedConfig);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }

    // Delay between runs (except last)
    if (i < CONFIG.loops) {
      const delay = rand(15000, 30000);
      console.log(`\n  Waiting ${Math.round(delay / 1000)}s before next run...`);
      await sleep(delay);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log('  FINAL SUMMARY');
  console.log(`${'='.repeat(50)}`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Failed:  ${failCount}`);
  console.log(`  Total:   ${CONFIG.loops}`);
  console.log(`  Output:  ${CONFIG.outputFile}`);
  console.log(`${'='.repeat(50)}\n`);

  console.log('Browser will close in 10 seconds...');
  await sleep(10000);
  await browser.close();
}

// ─── CLI ─────────────────────────────────────────────────
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { registerOnce, CONFIG };
