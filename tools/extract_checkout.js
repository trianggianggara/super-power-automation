const { loadEnv } = require('../utils/env.js');
loadEnv();

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(StealthPlugin);

const { browserTypeFor, resolveBrowserExecutablePath, envFlag, proxyFromUrl, isCamoufox } = require('../utils/browser.js');
const { sleep } = require('../utils/helpers.js');
const { spawn } = require('child_process');

// Parse CLI arguments
const args = process.argv.slice(2);
let at = '';
let plan = 'chatgptplusplan';
let country = 'US';
let currency = 'USD';
let headless = true;
let customProxy = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--at' || args[i] === '-a') {
    at = args[++i];
  } else if (args[i] === '--plan' || args[i] === '-p') {
    plan = args[++i];
  } else if (args[i] === '--country' || args[i] === '-c') {
    country = args[++i];
  } else if (args[i] === '--currency' || args[i] === '-y') {
    currency = args[++i];
  } else if (args[i] === '--headless') {
    headless = args[++i] !== 'false';
  } else if (args[i] === '--proxy') {
    customProxy = args[++i];
  }
}

// Automatically enforce KRW currency if country is KR
if (country.toUpperCase() === 'KR' && currency.toUpperCase() === 'USD') {
  console.log('[INFO] Automatically setting currency to KRW for South Korea (KR) to support NICEPAY payment method.');
  currency = 'KRW';
}

if (!at) {
  console.log('Error: Access Token (--at) is required.');
  console.log('\nUsage: node extract_checkout.js --at <Access_Token> [options]');
  console.log('\nOptions:');
  console.log('  --at, -a         ChatGPT Access Token (Required)');
  console.log('  --plan, -p       Plan name (default: chatgptplusplan)');
  console.log('  --country, -c    Billing country code (default: US)');
  console.log('  --currency, -y   Billing currency code (default: USD)');
  console.log('  --headless       Headless browser run (true/false, default: true)');
  console.log('  --proxy          Proxy URL (e.g. http://user:pass@host:port)');
  process.exit(1);
}

// Monitor Turnstile state changes via polling iframe DOM
async function monitorTurnstile(page, resolve) {
  console.log('[INFO] monitorTurnstile started.');
  try {
    // 1. Wait for the Turnstile iframe to load and exist in DOM (max 30s)
    console.log('Waiting for Turnstile frame to appear...');
    let frame = null;
    for (let i = 0; i < 30; i++) {
      if (page.isClosed()) return;
      const frames = page.frames();
      frame = frames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
      if (frame) break;
      await sleep(1000);
    }
    
    if (!frame) {
      console.log('Turnstile frame not found in frame list. Proceeding directly...');
      resolve();
      return;
    }

    // Wait longer to let layout settle
    console.log('Turnstile frame detected. Waiting 5s for layout to settle...');
    await sleep(5000);

    // 2. Loop to check for token and click the checkbox if needed (max 2 minutes)
    console.log('Waiting for Turnstile response token to populate...');
    const startTime = Date.now();
    const timeoutMs = 120000; // 2 minutes
    let clickCount = 0;
    let lastClickTime = 0;

    while (Date.now() - startTime < timeoutMs) {
      if (page.isClosed()) return;

      // Check if token is populated in the page
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

      // Check if the Turnstile frame is still present
      const currentFrames = page.frames();
      const activeFrame = currentFrames.find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));

      if (!activeFrame) {
        console.log('Turnstile frame is no longer present. Checking if token appears...');
        await sleep(1000);
        continue;
      }

      // Check if Turnstile iframe element is visible and has a positive bounding box
      const frameElement = await activeFrame.frameElement().catch(() => null);
      if (frameElement) {
        const isFrameVisible = await frameElement.isVisible().catch(() => false);
        if (isFrameVisible) {
          const box = await frameElement.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const now = Date.now();
            // If it's been at least 8 seconds since the last click (or we haven't clicked yet), click it.
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

      await sleep(2000);
    }

    console.log('⚠ Auto-click did not solve captcha in 2 minutes. Proceeding anyway...');
  } catch (err) {
    console.log(`[ERROR] monitorTurnstile failed: ${err.message}`);
  }
  resolve();
}

async function ensureChromeRunning(executablePath = 'google-chrome', port = 9222, proxyStr = '') {
  try {
    const checkRes = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (checkRes && checkRes.ok) {
      console.log(`Google Chrome with Remote Debugging is already running on port ${port}.`);
      return true;
    }

    console.log(`Google Chrome Remote Debugging port ${port} NOT detected. Spawning Chrome...`);

    let chromePath = executablePath;
    const lower = chromePath.toLowerCase();
    if (lower === 'cloakbrowser' || lower === 'cloak') {
      chromePath = '/home/nbs59/.cloakbrowser/chromium-146.0.7680.177.5/chrome';
    } else if (lower === 'camoufox' || lower === 'comufox') {
      chromePath = '/home/nbs59/.cache/camoufox/camoufox';
    }

    const tempProfileDir = `/tmp/chrome-debug-profile-${port}`;
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempProfileDir}`,
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check'
    ];

    if (proxyStr) {
      const pc = proxyFromUrl(proxyStr);
      if (pc) {
        args.push(`--proxy-server=${pc.server}`);
      }
    }

    console.log(`Spawning chrome: ${chromePath} ${args.join(' ')}`);

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    chromeProcess.unref();

    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      if (res && res.ok) {
        console.log('Google Chrome spawned and remote debugging port is active!');
        return true;
      }
    }
    throw new Error(`Timeout waiting for Google Chrome remote debugging port ${port} to respond.`);
  } catch (err) {
    console.log(`[ERROR] ensureChromeRunning failed: ${err.message}`);
    throw err;
  }
}

async function run() {
  const browserExecutablePath = resolveBrowserExecutablePath(process.env.BROWSER_EXECUTABLE_PATH || '');
  const proxyStr = customProxy || process.env.PROXY || '';

  let browser;
  let context;
  let connectedCDP = false;
  let dynamicPortUsed = null;

  try {
    if (!isCamoufox(browserExecutablePath)) {
      const dynamicPort = Math.floor(19000 + Math.random() * 6000);
      dynamicPortUsed = dynamicPort;
      await ensureChromeRunning(browserExecutablePath, dynamicPort, proxyStr);
      const checkRes = await fetch(`http://127.0.0.1:${dynamicPort}/json/version`).catch(() => null);
      if (checkRes && checkRes.ok) {
        console.log(`Found active Google Chrome Remote Debugging port at http://127.0.0.1:${dynamicPort}! Connecting...`);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${dynamicPort}`);
        
        const contextOpts = {
          ignoreHTTPSErrors: true,
        };
        if (proxyStr) {
          const pc = proxyFromUrl(proxyStr);
          if (pc) {
            contextOpts.proxy = {
              server: pc.server,
              username: pc.username,
              password: pc.password,
            };
          }
        }
        context = await browser.newContext(contextOpts);
        connectedCDP = true;
      }
    }
  } catch (err) {
    console.log(`CDP connection error: ${err.message}`);
  }

  if (!connectedCDP) {
    const launchOpts = {
      headless: headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    };

    if (proxyStr) {
      launchOpts.proxy = proxyFromUrl(proxyStr);
      console.log(`Using Proxy: ${proxyStr.split('@').pop()}`);
    }
    if (browserExecutablePath) {
      launchOpts.executablePath = browserExecutablePath;
    }

    console.log('Launching browser...');
    browser = await browserTypeFor(browserExecutablePath).launch(launchOpts);
    
    const contextOpts = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: null,
      ignoreHTTPSErrors: true,
    };
    context = await browser.newContext(contextOpts);
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    console.log('Navigating to chatgpt.com to bypass Cloudflare protection...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Wait slightly to ensure Cloudflare/cookies stabilize
    await sleep(2000);

    // Monitor Turnstile captcha if it appears on the page
    console.log('Monitoring for Cloudflare Turnstile challenge...');
    let resolvePromise;
    const solvedPromise = new Promise((res) => {
      resolvePromise = res;
    });
    monitorTurnstile(page, resolvePromise);
    await solvedPromise;

    console.log('Initiating checkout API request inside browser context...');
    const result = await page.evaluate(async ({ at, plan, country, currency }) => {
      try {
        const response = await fetch('https://chatgpt.com/backend-api/payments/checkout', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${at}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            plan_name: plan,
            billing_details: {
              country: country,
              currency: currency
            },
            cancel_url: 'https://chatgpt.com/#pricing',
            checkout_ui_mode: 'hosted'
          })
        });

        const status = response.status;
        const text = await response.text();
        return { status, text };
      } catch (err) {
        return { error: err.message };
      }
    }, { at, plan, country, currency });

    if (result.error) {
      console.error('Request failed during evaluation:', result.error);
    } else if (result.status === 200) {
      try {
        const data = JSON.parse(result.text);
        let finalUrl = data.url;
        if (!finalUrl && data.checkout_session_id) {
          finalUrl = `https://chatgpt.com/checkout/openai_llc/${data.checkout_session_id}`;
        }

        let stripeUrl = '';
        if (data.checkout_session_id) {
          try {
            const stripeApiKey = 'pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n';
            const stripeRes = await fetch(`https://api.stripe.com/v1/payment_pages/${data.checkout_session_id}?key=${stripeApiKey}`, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "application/json",
                "Origin": "https://checkout.stripe.com",
                "Referer": "https://checkout.stripe.com/"
              }
            });
            if (stripeRes.ok) {
              const stripeData = await stripeRes.json();
              stripeUrl = stripeData.stripe_hosted_url;
            }
          } catch (e) {
            console.error('Failed to get direct Stripe link:', e.message);
          }
        }

        if (finalUrl) {
          console.log('\n==================================================');
          console.log('  SUCCESS: Checkout URL generated successfully!');
          console.log('==================================================');
          console.log('ChatGPT Checkout Link:');
          console.log(finalUrl);
          if (stripeUrl) {
            console.log('\nDirect Stripe Link:');
            console.log(stripeUrl);
          }
          console.log('==================================================\n');

          if (country.toUpperCase() === 'KR' && stripeUrl) {
            console.log('[INFO] Country is South Korea (KR). Automating NICEPAY redirection...');
            try {
              // Fake South Korea identities generator
              const fakeNames = [
                'Hana Shin', 'Minji Kim', 'Jimin Lee', 'Seojun Park', 'Jungwoo Choi',
                'Yuna Jung', 'Jiwoo Kang', 'Hyunwoo Jo', 'Sujin Yoon', 'Sangwook Lim',
                'Eunji Song', 'Donghyun Seo', 'Soomin Shin', 'Daehyun Ahn', 'Minho Hwang'
              ];
              const fakeAddresses = [
                { state: 'Daegu', city: 'Suseong-gu', line1: 'Apt 440, Dalgubeol-daero 2000', line2: 'Suseong-gu', postal: '42012' },
                { state: 'Seoul', city: 'Gangnam-gu', line1: '12 Teheran-ro 8-gil', line2: 'Apt 101', postal: '06240' },
                { state: 'Busan', city: 'Haeundae-gu', line1: '45 Centum seo-ro', line2: 'Apt 502', postal: '48059' },
                { state: 'Incheon', city: 'Yeonsu-gu', line1: '80 Songdomirae-ro', line2: 'Apt 703', postal: '21990' },
                { state: 'Daejeon', city: 'Seo-gu', line1: '132 Daedeok-daero', line2: 'Apt 201', postal: '35229' }
              ];
              
              const chosenName = fakeNames[Math.floor(Math.random() * fakeNames.length)];
              const chosenAddr = fakeAddresses[Math.floor(Math.random() * fakeAddresses.length)];

              await page.goto(stripeUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch((err) => {
                console.log('  Page goto warning:', err.message);
              });
              await sleep(6000);
              
              // Ensure we take a screenshot of Stripe Checkout for debugging
              await page.screenshot({ path: '/home/nbs59/autoregister-account/scratch/stripe_checkout_kr.png' }).catch(() => {});
              
              // Email input handling
              const emailInput = page.locator('input#email, input[type="email"]').first();
              if (await emailInput.count() > 0 && await emailInput.isVisible()) {
                const val = await emailInput.inputValue().catch(() => '');
                if (!val) {
                  const dummyEmail = `user_${Math.floor(100000 + Math.random() * 900000)}@gmail.com`;
                  console.log(`  Filling default billing email: ${dummyEmail}`);
                  await emailInput.fill(dummyEmail);
                  await sleep(1000);
                }
              }
              
              // Billing name input handling
              const nameInput = page.locator('input#billingName, input[autocomplete="name"]').first();
              if (await nameInput.count() > 0 && await nameInput.isVisible()) {
                const val = await nameInput.inputValue().catch(() => '');
                if (!val) {
                  console.log(`  Filling default billing name: ${chosenName}`);
                  await nameInput.fill(chosenName);
                  await sleep(1000);
                }
              }

              // Address Line 1 input handling
              const addressInput = page.locator('input#billingAddressLine1, input[autocomplete="address-line1"], input[placeholder*="Address line 1" i]').first();
              if (await addressInput.count() > 0 && await addressInput.isVisible()) {
                const val = await addressInput.inputValue().catch(() => '');
                if (!val) {
                  console.log(`  Filling default address line 1: ${chosenAddr.line1}`);
                  await addressInput.fill(chosenAddr.line1);
                  await sleep(1000);
                }
              }

              // Address Line 2 input handling
              const address2Input = page.locator('input#billingAddressLine2, input[autocomplete="address-line2"], input[placeholder*="Address line 2" i]').first();
              if (await address2Input.count() > 0 && await address2Input.isVisible()) {
                const val = await address2Input.inputValue().catch(() => '');
                if (!val) {
                  console.log(`  Filling default address line 2: ${chosenAddr.line2}`);
                  await address2Input.fill(chosenAddr.line2);
                  await sleep(1000);
                }
              }

              // City input handling
              const cityInput = page.locator('input#billingAddressLevel2, input[autocomplete="address-level2"], input[placeholder*="City" i]').first();
              if (await cityInput.count() > 0 && await cityInput.isVisible()) {
                const val = await cityInput.inputValue().catch(() => '');
                if (!val) {
                  console.log(`  Filling default city: ${chosenAddr.city}`);
                  await cityInput.fill(chosenAddr.city);
                  await sleep(1000);
                }
              }

              // State/Province/Do-Si Dropdown
              const stateSelect = page.locator('select#billingState, select[autocomplete="address-level1"], select[name="billingState"]').first();
              if (await stateSelect.count() > 0 && await stateSelect.isVisible()) {
                const val = await stateSelect.inputValue().catch(() => '');
                if (!val || val === '') {
                  console.log(`  Selecting state/province from native select (${chosenAddr.state})...`);
                  await stateSelect.selectOption({ label: chosenAddr.state }).catch(async () => {
                    await stateSelect.selectOption({ index: 1 }).catch(() => {});
                  });
                  await sleep(1000);
                }
              } else {
                // If it's a custom dropdown trigger (like a button or div)
                const stateTrigger = page.locator('button#billingState, [autocomplete="address-level1"] button, [data-testid*="state" i], .state-dropdown-trigger, span:has-text("Do Si"), button:has-text("Do Si")').first();
                if (await stateTrigger.count() > 0 && await stateTrigger.isVisible()) {
                  console.log('  Clicking custom Do Si / state dropdown...');
                  await stateTrigger.click();
                  await sleep(1500);
                  const option = page.locator(`[role="option"]:has-text("${chosenAddr.state}"), [role="option"]`).first();
                  if (await option.count() > 0) {
                    await option.click();
                    await sleep(1000);
                  }
                }
              }

              // Postal Code
              const postalInput = page.locator('input#billingPostalCode, input[autocomplete="postal-code"]').first();
              if (await postalInput.count() > 0 && await postalInput.isVisible()) {
                const val = await postalInput.inputValue().catch(() => '');
                if (!val) {
                  console.log(`  Filling default postal code: ${chosenAddr.postal}`);
                  await postalInput.fill(chosenAddr.postal);
                  await sleep(1000);
                }
              }

              // Check if there is a Save button (for billing edit modal) and click it
              const saveBtn = page.locator('button:has-text("Save"), button:has-text("Simpan")').first();
              if (await saveBtn.count() > 0 && await saveBtn.isVisible()) {
                console.log('  Found "Save" button for billing edit. Clicking it...');
                await saveBtn.click();
                await sleep(5000);
                await page.screenshot({ path: '/home/nbs59/autoregister-account/scratch/stripe_billing_saved.png' }).catch(() => {});
              }

              // NICEPAY Terms/consent checkbox if exists
              const consentSelectors = [
                'input[type="checkbox"]',
                '.Checkbox',
                'input#tos-approval',
                'input#nicepay-approval'
              ];
              for (const sel of consentSelectors) {
                const cb = page.locator(sel).first();
                if (await cb.count() > 0 && await cb.isVisible()) {
                  console.log(`  Checking consent checkbox matching: ${sel}`);
                  await cb.check({ force: true }).catch(() => {});
                  await sleep(500);
                }
              }
              
              // Try to find the Submit button/Pay button on Stripe checkout
              const payBtn = page.locator('button[type="submit"], button.SubmitButton').first();
              if (await payBtn.count() > 0) {
                console.log('  Clicking pay button to trigger redirect...');
                await page.screenshot({ path: '/home/nbs59/autoregister-account/scratch/stripe_before_pay.png' }).catch(() => {});
                
                await payBtn.click();
                await sleep(5000);
                
                // Polling check for the Nicepay URL in case of immediate load/ajax
                let nicepayUrl = '';
                for (let attempt = 0; attempt < 25; attempt++) {
                  const u = page.url();
                  if (u.includes('nicepay.co.kr')) {
                    nicepayUrl = u;
                    break;
                  }
                  await sleep(1500);
                }
                
                if (nicepayUrl) {
                  console.log('\n==================================================');
                  console.log('  SUCCESS: NICEPAY Direct QR/Checkout Link:');
                  console.log('==================================================');
                  console.log(nicepayUrl);
                  console.log('==================================================\n');
                  await page.screenshot({ path: '/home/nbs59/autoregister-account/scratch/nicepay_redirected.png' }).catch(() => {});
                } else {
                  console.error('  Failed to retrieve NICEPAY redirect URL. Current URL:', page.url());
                  await page.screenshot({ path: '/home/nbs59/autoregister-account/scratch/stripe_pay_failed.png' }).catch(() => {});
                }
              } else {
                console.error('  Stripe pay button not found on the page.');
              }
            } catch (err) {
              console.error('  Error during NICEPAY redirection automation:', err.message);
            }
          }
        } else {
          console.log('SUCCESS (No URL or Session ID in response):', result.text);
        }
      } catch (e) {
        console.log('Response is not JSON:', result.text);
      }
    } else {
      console.error(`ERROR: API returned status code ${result.status}`);
      console.error('Response:', result.text);
    }

  } catch (err) {
    console.error('Error during execution:', err.message);
  } finally {
    if (typeof browser !== 'undefined' && browser) {
      await browser.close().catch(() => {});
    }
    if (dynamicPortUsed) {
      try {
        const { execSync } = require('child_process');
        execSync(`fuser -k ${dynamicPortUsed}/tcp`, { stdio: 'ignore' });
        console.log(`Terminated Chrome process on dynamic port ${dynamicPortUsed}.`);
      } catch (err) {
        // ignore errors
      }
    }
  }
}

run().catch(console.error);
