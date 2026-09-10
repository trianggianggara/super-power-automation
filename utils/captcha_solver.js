// Captcha solver using LLM (OpenAI-compatible vision endpoint) & Aliyun captcha stub.
//

const { sleep, retry, fetchWithTimeout, rand } = require('./helpers');

// ─── extractCaptchaConfig: find sceneId + prefix from the live page ──────
async function extractCaptchaConfig(page) {
  return await page.evaluate(() => {
    const out = { sceneId: null, prefix: null };

    // Strategy 1: global init config objects
    const globals = [
      window.__aliyunCaptchaConfig,
      window.AliyunCaptcha,
      window.aliyunCaptcha,
      window.captchaConfig,
    ];
    for (const g of globals) {
      if (g && g.sceneId) out.sceneId = g.sceneId;
      if (g && g.prefix) out.prefix = g.prefix;
    }

    // Strategy 2: any element carrying data-scene-id / data-prefix attributes
    const els = document.querySelectorAll('[data-scene-id], [data-prefix]');
    for (const el of els) {
      if (!out.sceneId) out.sceneId = el.getAttribute('data-scene-id');
      if (!out.prefix) out.prefix = el.getAttribute('data-prefix');
    }

    // Strategy 3: grep <script> contents for initAliyunCaptcha({ sceneId, prefix, ... })
    const re = /initAliyunCaptcha\s*\(\s*([\s\S]*?)\)\s*[;,)]/;
    const sceneRe = /sceneId\s*[:=]\s*["']([^"']+)["']/;
    const prefixRe = /prefix\s*[:=]\s*["']([^"']+)["']/;
    for (const s of document.querySelectorAll('script')) {
      const txt = s.textContent || '';
      if (!txt) continue;
      if (!out.sceneId) {
        const m = txt.match(sceneRe);
        if (m) out.sceneId = m[1];
      }
      if (!out.prefix) {
        const m = txt.match(prefixRe);
        if (m) out.prefix = m[1];
      }
      // also try to grab from the matched init block
      if (!out.sceneId || !out.prefix) {
        const block = txt.match(re);
        if (block) {
          if (!out.sceneId) {
            const m = block[1].match(sceneRe);
            if (m) out.sceneId = m[1];
          }
          if (!out.prefix) {
            const m = block[1].match(prefixRe);
            if (m) out.prefix = m[1];
          }
        }
      }
    }

    // Strategy 4: the aliyunCaptcha-* elements sometimes carry the sceneId in attributes / data
    const widget = document.querySelector('#aliyunCaptcha-window-float, [class*="aliyunCaptcha"]');
    if (widget) {
      if (!out.sceneId) out.sceneId = widget.getAttribute('data-scene') || widget.getAttribute('data-scene-id');
    }

    // Strategy 5: values captured by the network route intercept and injected
    const netCfg = window.__aliyunCaptchaNetworkConfig;
    if (netCfg) {
      if (!out.sceneId && netCfg.sceneId) out.sceneId = netCfg.sceneId;
      if (!out.prefix && netCfg.prefix) out.prefix = netCfg.prefix;
    }

    // Strategy 6: brute-force — search entire page HTML for sceneId pattern
    if (!out.sceneId) {
      const html = document.documentElement.innerHTML;
      const patterns = [
        /["']?(?:sceneId|SceneId|captchaSceneId|CaptchaSceneId)["']?\s*:\s*["']([a-zA-Z0-9_-]{4,})["']/i,
        /(?:sceneId|SceneId)["\s:=]+["']?([a-zA-Z0-9_-]{4,})/i,
      ];
      for (const p of patterns) {
        const m = html.match(p);
        if (m) { out.sceneId = m[1]; break; }
      }
    }

    // Also dump all script tag contents for sceneId in any JSON key
    if (!out.sceneId) {
      for (const s of document.querySelectorAll('script')) {
        const t = s.textContent || '';
        const jsonRe = /["']?(?:sceneId|SceneId)["']?\s*:\s*["']([a-zA-Z0-9_-]+)/i;
        const jm = t.match(jsonRe);
        if (jm) { out.sceneId = jm[1]; break; }
      }
    }

    // Strategy 7: read config captured by the initAliyunCaptcha setter hook
    if (!out.sceneId && window.__aliyunCaptchaConfig && window.__aliyunCaptchaConfig.sceneId) {
      out.sceneId = window.__aliyunCaptchaConfig.sceneId;
    }
    if (!out.prefix && window.__aliyunCaptchaConfig && window.__aliyunCaptchaConfig.prefix) {
      out.prefix = window.__aliyunCaptchaConfig.prefix;
    }

    return out;
  });
}

// ─── injectToken: push the solved token back into the widget ─────────────
async function injectToken(page, tokens) {
  const tokenObj = typeof tokens === 'string' ? JSON.parse(tokens) : tokens;
  const tokenStr = typeof tokens === 'string' ? tokens : JSON.stringify(tokens);
  const injected = await page.evaluate(async ({ tokenStr, tokenObj }) => {
    const results = [];
    const cbs = window.__aliyunCaptchaCallbacks || {};

    if (typeof cbs.success === 'function') {
      const argFormats = [
        { captchaVerifyParam: tokenStr },
        { captchaVerifyResult: true, captchaVerifyParam: tokenStr },
        tokenStr,
        tokenObj,
      ];
      for (let i = 0; i < argFormats.length; i++) {
        try {
          const ret = await cbs.success(argFormats[i]);
          results.push('success[' + i + ']->' + JSON.stringify(ret).slice(0, 80));
          break;
        } catch (e) {
          results.push('success[' + i + ']-err:' + e.message);
        }
      }
    } else {
      results.push('no success callback');
    }

    try {
      if (typeof cbs.getInstance === 'function') {
        const inst = cbs.getInstance();
        window.__aliyunCaptchaInstance = inst;
        results.push('getInstance: ' + (inst ? typeof inst : 'null'));
        if (inst) {
          for (const m of ['success', 'verifySuccess', 'onVerifySuccess', 'showSuccess', 'verify', 'setCaptchaSuccess']) {
            if (typeof inst[m] === 'function') {
              try {
                await inst[m]({ captchaVerifyParam: tokenStr });
                results.push('inst.' + m);
                break;
              } catch (_) {}
            }
          }
          results.push('inst-keys:' + Object.keys(inst).filter(k => typeof inst[k] === 'function').join(','));
        }
      }
    } catch (e) { results.push('getInstance-err:' + e.message); }

    try {
      const ac = window.AliyunCaptcha || window.aliyunCaptcha;
      if (ac) {
        for (const m of ['success', 'verifySuccess', 'getCaptchaSuccess', 'handleSuccess']) {
          if (typeof ac[m] === 'function') {
            try { await ac[m]({ captchaVerifyParam: tokenStr }); results.push('ac.' + m); break; } catch (_) {}
          }
        }
      }
    } catch (e) { results.push('ac-err:' + e.message); }

    try {
      window.__capmonsterToken = tokenStr;
      window.dispatchEvent(new CustomEvent('aliyun-captcha-success', { detail: tokenObj }));
      window.dispatchEvent(new CustomEvent('captcha-success', { detail: tokenObj }));
      results.push('global+event');
    } catch (e) { results.push('event-err:' + e.message); }

    return results;
  }, { tokenStr, tokenObj });
  console.log(`  Injection attempts: ${injected.join(' | ') || 'none'}`);
  return injected.length > 0;
}

// ─── verifySolved: confirm the widget closed / OTP field appeared ─────────
async function verifySolved(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const captchaSelectors = '#aliyunCaptcha-window-float, iframe[src*="tcaptcha"], #tcaptcha_iframe';
  
  while (Date.now() < deadline) {
    const windowVisible = await page.locator(captchaSelectors).first()
      .isVisible({ timeout: 500 }).catch(() => false);
    
    if (!windowVisible) {
      // If captcha window is not visible, confirm if the next step fields are visible
      const nextStepSelectors = [
        'input.ant-otp-input', 'input[aria-label*="OTP"]',
        'input[placeholder*="code" i]', 'input[placeholder*="OTP" i]',
        'input[placeholder*="Verification" i]', 'input[placeholder*="password" i]',
        'input[name*="code" i]', 'input[name*="otp" i]', 'input[type="password"]',
        'input#code', 'input#password', 'input#email-otp-code'
      ];
      for (const sel of nextStepSelectors) {
        if (await page.locator(sel).first().isVisible({ timeout: 100 }).catch(() => false)) {
          return true;
        }
      }
    }

    await sleep(500);
  }
  return false;
}

// ─── solveAliyunCaptcha: Solve Aliyun/Tencent Slider Captcha via LLM Vision API ───
async function solveAliyunCaptcha(page, options) {
  const {
    apiKey = process.env.LLM_API_KEY,
    apiUrl = process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions',
    model = process.env.LLM_MODEL || 'cx/gpt-5.4-mini',
    retries = 3,
    timeoutMs = 180000,
  } = options || {};

  if (!apiKey) {
    console.log('  [WARN] No LLM_API_KEY provided for slider captcha solving.');
    return false;
  }

  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  const cardSelectors = [
    '#tcaptcha_transform_dy',
    '.tencent-captcha__transform',
    'iframe[src*="tcaptcha"]',
    '#tcaptcha_iframe',
    '#aliyunCaptcha-window-float',
    '.aliyunCaptcha-window-float',
    '[class*="aliyunCaptcha-window"]',
    '.nc_wrapper',
    '#nc_1_wrapper',
  ];

  const handleSelectors = [
    '#aliyunCaptcha-sliding-slider',
    '.tencent-captcha-dy__slider-block',
    '.tencent-captcha-dy__slider-img--normal',
    '#tcaptcha_drag_button',
    '.tc-drag-button',
    '.tc-drag-thumb',
    '.tc-slide-icon',
    '.aliyunCaptcha-btn-slide',
    '[class*="aliyunCaptcha-btn-slide"]',
    '[class*="btn-slide"]',
    '.nc-lang-cnt [class*="btn_slide"]',
    'span.nc_iconfont.btn_slide',
    '.nc_scale span',
  ];

  const bgSelectors = [
    '#aliyunCaptcha-img',
    '#aliyunCaptcha-window-float img:not(#aliyunCaptcha-puzzle)',
    '.tencent-captcha-dy__verify-bg-img',
    '.tencent-captcha-dy__image-area',
    '#slideBg',
    '#slideBg img',
    'img[alt*="background" i]',
    'img.aliyunCaptcha-img-bg',
    '[class*="aliyunCaptcha-img-bg"]',
    '[class*="captcha-img-bg"]',
    'canvas.aliyunCaptcha-img-bg',
    '.aliyunCaptcha-img-bg',
    '#aliyunCaptcha-window-float img',
  ];

  const refreshSelectors = [
    '#aliyunCaptcha-btn-refresh',
    '.tencent-captcha-dy__footer-icon--refresh',
    '#reload',
    '.tc-reload',
    'img[alt*="new captcha" i]',
    'img[alt*="refresh" i]',
    '.aliyunCaptcha-btn-refresh',
    '[class*="aliyunCaptcha-btn-refresh"]',
    '[class*="refresh"]',
  ];

  for (let attempt = 0; attempt < retries; attempt++) {
    console.log(`  LLM Slider Captcha attempt ${attempt + 1}/${retries}...`);
    await sleep(2000);

    // Find the captcha card
    let card = null;
    let frame = page;
    let isIframe = false;
    for (const sel of cardSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        card = el;
        const tagName = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
        if (tagName === 'iframe') {
          frame = page.frameLocator(sel).first();
          isIframe = true;
          console.log(`  Found iframe-based captcha: ${sel}`);
        } else {
          console.log(`  Found DOM-based captcha: ${sel}`);
        }
        break;
      }
    }

    if (!card) {
      console.log('  [WARN] Captcha card element not found, checking if already solved...');
      try {
        const frames = page.frames();
        console.log(`  [DEBUG] Total frames: ${frames.length}`);
        for (const f of frames) {
          console.log(`    - Frame name: "${f.name()}", url: "${f.url()}"`);
        }
      } catch (err) {
        console.log(`  [DEBUG] Error getting frames: ${err.message}`);
      }
      if (await verifySolved(page)) return true;
      continue;
    }

    // Find the background image element inside the frame context to get its width
    let bgEl = null;
    let bgWidth = 300; // default fallback width
    for (const sel of bgSelectors) {
      const loc = frame.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 50 && box.x >= 0 && box.y >= 0) {
            bgEl = el;
            bgWidth = box.width;
            break;
          }
        }
      }
      if (bgEl) break;
    }
    console.log(`  Target background width detected: ${bgWidth}px`);

    // Find the slider handle inside the frame context
    let handle = null;
    for (const sel of handleSelectors) {
      const loc = frame.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          const box = await el.boundingBox().catch(() => null);
          if (box && box.x >= 0 && box.y >= 0) {
            handle = el;
            break;
          }
        }
      }
      if (handle) break;
    }

    if (!handle) {
      console.log('  [WARN] Slider handle element not found.');
      continue;
    }

    const debugPath = path.join(os.tmpdir(), `slider_captcha_${Date.now()}.png`);
    try {
      // Capture element screenshot of the card/iframe
      await card.screenshot({ path: debugPath, timeout: 10000 });
      const imgBuffer = fs.readFileSync(debugPath);
      const b64 = imgBuffer.toString('base64');

      // Ask LLM for the horizontal sliding percentage
      console.log(`  Sending captcha screenshot to LLM at ${apiUrl}...`);
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

      const res = await retry(() => fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
      }, timeoutMs), { retries: 3, delayMs: 2000, label: 'LLM solveSliderCaptcha' });

      const data = await res.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`LLM response error: ${JSON.stringify(data)}`);
      }

      const rawResult = (data.choices[0].message.content || '').trim();
      console.log(`  LLM response content: "${rawResult}"`);

      const percentageMatches = [...rawResult.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
      if (percentageMatches.length === 0) {
        console.log(`  [WARN] Could not parse percentage from: "${rawResult}". Retrying...`);
        continue;
      }
      // Take the last percentage match (usually the final answer/conclusion)
      const lastPctString = percentageMatches[percentageMatches.length - 1][1];
      const percentage = Math.round(parseFloat(lastPctString));
      if (percentage <= 0 || percentage >= 100) {
        console.log(`  [WARN] Invalid percentage parsed: ${percentage}%. Retrying...`);
        continue;
      }

      // Calculate sliding distance in pixels
      const dragDistance = bgWidth * (percentage / 100);
      console.log(`  Calculated drag distance: ${dragDistance.toFixed(1)}px (${percentage}% of ${bgWidth}px)`);

      // Drag the handle using mouse moves
      const handleBox = await handle.boundingBox().catch(() => null);
      if (!handleBox) {
        console.log('  [WARN] Failed to get handle bounding box.');
        continue;
      }

      // AliyunCaptcha slider handles are dragged from near the left edge.
      // E.g. startX = handleBox.x + 15
      const startX = handleBox.x + 15;
      const startY = handleBox.y + handleBox.height / 2;

      console.log(`  Starting drag from X: ${startX}, Y: ${startY}`);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await sleep(rand(100, 200));

      const steps = 20;
      for (let s = 1; s <= steps; s++) {
        const progress = s / steps;
        // Ease out quadratic deceleration to make it feel human
        const ease = 1 - (1 - progress) * (1 - progress);
        const currentX = startX + dragDistance * ease;
        // Add tiny vertical/horizontal micro-jitter
        const jitterY = startY + (Math.random() - 0.5) * 1.5;
        await page.mouse.move(currentX, jitterY);
        await sleep(rand(15, 30));
      }
      await sleep(rand(200, 400));
      await page.mouse.up();
      console.log('  Drag completed.');

      // Check if solved successfully
      await sleep(3000);
      const isSolved = await verifySolved(page);
      if (isSolved) {
        console.log('  Slider Captcha successfully solved!');
        return true;
      }

      console.log('  Slider placement failed or rejected. Refreshing captcha...');
      // Click refresh button to get a new image
      for (const sel of refreshSelectors) {
        const btn = frame.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click().catch(() => {});
          break;
        }
      }
    } catch (e) {
      console.log(`  Error during Slider solve: ${e.message}`);
    } finally {
      try { fs.unlinkSync(debugPath); } catch (_) {}
    }
  }

  return false;
}

// ─── solveImageCaptcha: solve a text/image captcha via LLM Vision API ─────
async function solveImageCaptcha(imgLocator, page, options) {
  const {
    apiKey = process.env.LLM_API_KEY,
    apiUrl = process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions',
    model = process.env.LLM_MODEL || 'cx/gpt-5.4-mini',
    retries = 5,
    timeoutMs = 180000,
    inputSelector = '.mi-captcha-field input, input[name*="icode"]',
    submitSelector = 'button[type="submit"], button:has-text("Verify"), button:has-text("Confirm")',
  } = options;

  if (!apiKey) {
    console.log('  [WARN] No LLM_API_KEY provided for image captcha.');
    return false;
  }

  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  for (let i = 0; i < retries; i++) {
    console.log(`  LLM ImageToText attempt ${i + 1}/${retries}...`);
    await sleep(1000);

    const debugPath = path.join(os.tmpdir(), `captcha_${Date.now()}.png`);
    try {
      // Check visibility first to avoid waiting for a hidden/removed element
      const isVisible = await imgLocator.isVisible().catch(() => false);
      if (!isVisible) {
        console.log('  [WARN] Captcha image element is not visible, retrying...');
        continue;
      }

      // Bypassing canvas fingerprint protection: Take clean screenshot of the element directly
      console.log('  Taking element screenshot to bypass canvas fingerprint protection...');
      await imgLocator.screenshot({ path: debugPath, timeout: 5000 });
      const imgBuffer = fs.readFileSync(debugPath);
      const b64 = imgBuffer.toString('base64');

      // Submit to LLM
      console.log(`  Sending request to LLM at ${apiUrl}...`);
      const imageContents = [
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${b64}` }
        }
      ];

      const textPrompt = options.promptOverride || 'Identify the alphanumeric characters in this captcha image. Return only the code, no spaces, no explanation.';

      const payload = {
        model: model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: textPrompt
              },
              ...imageContents
            ]
          }
        ]
      };

      const res = await retry(() => fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
      }, timeoutMs), { retries: 3, delayMs: 2000, label: 'LLM solveImageCaptcha' });

      const data = await res.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`LLM API error or unexpected response format: ${JSON.stringify(data)}`);
      }

      const code = (data.choices[0].message.content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
      console.log(`  LLM result: "${code}"`);

      if (code.length < 3 || code.length > 8) {
        console.log('  Invalid code length, retrying...');
        continue;
      }

      // Fill the answer into the input
      const input = page.locator(inputSelector).first();
      const inputFound = await input.isVisible({ timeout: 1000 }).catch(() => false);
      if (!inputFound) {
        console.log('  [WARN] Captcha input not found, retrying...');
        continue;
      }
      await input.focus();
      await input.fill('');
      await input.pressSequentially(code, { delay: 100 });
      await input.dispatchEvent('input', { bubbles: true });
      await input.dispatchEvent('change', { bubbles: true });
      await sleep(500);
      console.log(`  Filled captcha input with: "${code}"`);

      // Some Xiaomi captchas auto-verify on input — check if image refreshed
      await sleep(500);
      if (!(await imgLocator.isVisible({ timeout: 500 }).catch(() => false))) {
        console.log('  Captcha auto-verified!');
        return true;
      }

      // Click submit — try multiple selectors
      const allSubmitSelectors = [
        '.mi-dialog button:has-text("Submit")',
        '.mi-modal button:has-text("Submit")',
        '.mi-dialog button:has-text("Confirm")',
        '.mi-modal button:has-text("Confirm")',
        '.mi-dialog button:has-text("Verify")',
        '.mi-modal button:has-text("Verify")',
        'button:has-text("Submit")',
        'button:has-text("Confirm")',
        'button:has-text("Verify")',
        'button:has-text("OK")',
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Register")',
        'button[type="submit"]',
        'input[type="submit"]',
        '.mi-captcha-field button:has-text("Submit")',
        '.mi-captcha-field button:has-text("Confirm")',
        '.mi-captcha-field button',
        '.mi-captcha-field a',
        submitSelector,
      ];
      let submitClicked = false;
      for (const sel of allSubmitSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
          if (await btn.isEnabled().catch(() => false)) {
            await btn.click();
            submitClicked = true;
            console.log(`  Clicked submit via: ${sel}`);
            break;
          } else {
            console.log(`  Submit button ${sel} is visible but disabled, skipping...`);
          }
        }
      }

      // Fallback: press Enter on the input
      if (!submitClicked) {
        console.log('  No enabled submit button found, pressing Enter on input...');
        await input.press('Enter');
        submitClicked = true;
      }

      if (submitClicked) {
        console.log('  Waiting up to 8s for captcha image to disappear...');
        const isSolved = await imgLocator.waitFor({ state: 'hidden', timeout: 8000 })
          .then(() => true)
          .catch(() => false);

        if (isSolved) {
          return true;
        }
        console.log('  Wrong answer or slow response, retrying...');
      }
    } catch (e) {
      console.log(`  LLM ImageToText error: ${e.message}`);
    } finally {
      try { fs.unlinkSync(debugPath); } catch (_) {}
    }
  }
  return false;
}

async function generateProcessedImages(page, originalB64) {
  try {
    return await page.evaluate(async (base64) => {
      try {
        const loadImage = (src) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = (err) => reject(new Error('Image failed to load: ' + err.message));
          img.src = src;
        });

        const img = await loadImage(`data:image/png;base64,${base64}`);
        const W = img.width;
        const H = img.height;

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        const getDataURL = () => canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

        const result = {};

        // 1. High Contrast version
        ctx.drawImage(img, 0, 0);
        let imgData = ctx.getImageData(0, 0, W, H);
        let data = imgData.data;
        const contrastFactor = 2.5; // Stretches differences to emphasize shapes
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            let val = data[i + c];
            val = 128 + contrastFactor * (val - 128);
            data[i + c] = Math.min(255, Math.max(0, val));
          }
        }
        ctx.putImageData(imgData, 0, 0);
        result.contrast = getDataURL();

        // 2. Sobel Edge Detection
        ctx.drawImage(img, 0, 0);
        imgData = ctx.getImageData(0, 0, W, H);
        data = imgData.data;
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = W;
        tempCanvas.height = H;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0);
        const srcData = tempCtx.getImageData(0, 0, W, H).data;

        const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const ky = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

        for (let y = 1; y < H - 1; y++) {
          for (let x = 1; x < W - 1; x++) {
            let gx = 0;
            let gy = 0;
            for (let cy = -1; cy <= 1; cy++) {
              for (let cx = -1; cx <= 1; cx++) {
                const pixelIdx = ((y + cy) * W + (x + cx)) * 4;
                const luma = 0.299 * srcData[pixelIdx] + 0.587 * srcData[pixelIdx + 1] + 0.114 * srcData[pixelIdx + 2];
                const kernelIdx = (cy + 1) * 3 + (cx + 1);
                gx += luma * kx[kernelIdx];
                gy += luma * ky[kernelIdx];
              }
            }
            const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
            const idx = (y * W + x) * 4;
            data[idx] = mag;
            data[idx + 1] = mag;
            data[idx + 2] = mag;
            data[idx + 3] = 255;
          }
        }
        ctx.putImageData(imgData, 0, 0);
        result.edges = getDataURL();

        return result;
      } catch (err) {
        return { error: err.message };
      }
    }, originalB64);
  } catch (err) {
    console.log(`  [WARN] Image processing failed in browser context: ${err.message}`);
    return null;
  }
}

// Helper to snap click coordinates to the exact mathematical center of standard grid cells (3x3 or 5x5)
function snapToGrid(clicks, W, H, gridType) {
  if (!clicks || clicks.length === 0) return clicks;
  if (gridType === "none" || !gridType) {
    console.log(`  [Snapper] gridType is "${gridType || 'none'}". Keeping original coordinates.`);
    return clicks;
  }

  let X_3x3, Y_3x3, X_5x5, Y_5x5;

  if (W === 520 && H === 570) {
    X_3x3 = [180, 260, 360];
    Y_3x3 = [280, 360, 440];
    X_5x5 = [135, 195, 255, 315, 375];
    Y_5x5 = [200, 260, 320, 380, 440];
  } else if (W === 400 && H === 600) {
    X_3x3 = [100, 200, 300];
    Y_3x3 = [200, 320, 440];
    X_5x5 = [80, 140, 200, 260, 320];
    Y_5x5 = [180, 250, 320, 390, 460];
  } else {
    // Dynamic fallback based on common ratios
    X_3x3 = [Math.round(W * 0.35), Math.round(W * 0.5), Math.round(W * 0.69)];
    Y_3x3 = [Math.round(H * 0.49), Math.round(H * 0.63), Math.round(H * 0.77)];
    X_5x5 = [Math.round(W * 0.26), Math.round(W * 0.38), Math.round(W * 0.49), Math.round(W * 0.61), Math.round(W * 0.72)];
    Y_5x5 = [Math.round(H * 0.35), Math.round(H * 0.46), Math.round(H * 0.56), Math.round(H * 0.67), Math.round(H * 0.77)];
  }

  const getClosest = (val, arr) => {
    return arr.reduce((prev, curr) => Math.abs(curr - val) < Math.abs(prev - val) ? curr : prev);
  };

  if (gridType === "grid_3x3") {
    console.log(`  [Snapper] Snapping clicks to 3x3 grid centers...`);
    return clicks.map(c => ({
      x: getClosest(c.x, X_3x3),
      y: getClosest(c.y, Y_3x3)
    }));
  } else if (gridType === "grid_5x5") {
    console.log(`  [Snapper] Snapping clicks to 5x5 grid centers...`);
    return clicks.map(c => ({
      x: getClosest(c.x, X_5x5),
      y: getClosest(c.y, Y_5x5)
    }));
  }

  return clicks;
}

// ─── solveArkoseDragCaptcha: Solve Arkose/FunCaptcha drag-and-drop challenge via LLM ───
async function solveArkoseDragCaptcha(page, options) {
  const {
    apiKey = process.env.LLM_API_KEY,
    apiUrl = process.env.LLM_API_URL || 'http://localhost:20128/v1/chat/completions',
    model = process.env.LLM_MODEL || 'cx/gpt-5.4-mini',
    maxSteps = 15,
    timeoutMs = 180000,
  } = options || {};

  if (!apiKey) {
    console.log('  [WARN] No LLM_API_KEY provided for Arkose drag captcha.');
    return false;
  }

  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  // Selector for the Arkose/hCaptcha challenge iframe container
  const iframeSelector = 'iframe[src*="arkoselabs.com"], iframe[src*="hcaptcha.com"][src*="frame=challenge"], iframe[title*="challenge"], iframe[src*="funcaptcha"]';

  console.log('  Waiting for captcha iframe to appear...');
  let iframeLocator = null;
  let activeFrameIndex = 0;
  const startTime = Date.now();
  const timeout = 30000;

  while (Date.now() - startTime < timeout) {
    const locators = page.locator(iframeSelector);
    const count = await locators.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const loc = locators.nth(i);
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 290 && box.height > 250) {
        const isVis = await loc.isVisible().catch(() => false);
        if (isVis) {
          iframeLocator = loc;
          activeFrameIndex = i;
          break;
        }
      }
    }
    if (iframeLocator) break;
    await sleep(1000);
  }

  if (!iframeLocator) {
    console.log('  [WARN] Active challenge iframe (large & visible) not found after 30s. Skipping...');
    return 'no_challenge';
  }

  console.log(`  Found active challenge iframe at index ${activeFrameIndex}. Starting solving loop...`);
  for (let step = 1; step <= maxSteps; step++) {
    console.log(`  Step ${step}/${maxSteps}...`);
    
    // Check if still visible
    const isVisible = await iframeLocator.isVisible().catch(() => false);
    if (!isVisible) {
      console.log('  Iframe is no longer visible. Assuming solved or closed.');
      return true;
    }

    // Check if there is a start button like "Start puzzle" or "Verify" inside the iframe context
    const frame = page.frameLocator(iframeSelector).nth(activeFrameIndex);
    const iframeUrl = await iframeLocator.getAttribute('src').catch(() => '');
    if (!iframeUrl.includes('hcaptcha.com')) {
      const startBtn = frame.locator('button:has-text("Start puzzle"), button:has-text("Verify"), #game_meta_btn_start').first();
      if (await startBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('  Found Start button inside captcha iframe, clicking...');
        await startBtn.click();
        await sleep(3000);
      }
    }

    const iframeBox = await iframeLocator.boundingBox().catch(() => null);
    if (!iframeBox) {
      console.log('  [WARN] Failed to get iframe bounding box.');
      continue;
    }

    // Wait for challenge elements and images to load inside the frame
    console.log('  Waiting for captcha challenge images and elements to stabilize/load...');
    try {
      // 1. Wait for loader/spinner to hide
      const spinnerSelectors = [
        '[class*="spinner" i]', '[class*="loading" i]', '[id*="loading" i]',
        '#loader', '.loader', '.loading-wrapper', '[aria-busy="true"]'
      ];
      for (const sel of spinnerSelectors) {
        const spinner = frame.locator(sel).first();
        if (await spinner.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`  Detected active loader/spinner ("${sel}"), waiting for it to hide...`);
          await spinner.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
        }
      }

      // 2. Wait for image elements to load fully (complete status)
      await frame.locator('img').evaluateAll(async (imgs) => {
        await Promise.all(imgs.map(img => {
          if (img.complete) return Promise.resolve(true);
          return new Promise(resolve => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
          });
        }));
      }).catch(() => {});
    } catch (err) {
      console.log(`  [WARN] Non-blocking error waiting for frame assets: ${err.message}`);
    }

    // Add a small stable buffer sleep to let animations and layout settle
    await sleep(1500);

    // Inject grid overlay
    await page.evaluate((box) => {
      const old = document.getElementById('captcha-grid-overlay');
      if (old) old.remove();
      
      const overlay = document.createElement('canvas');
      overlay.id = 'captcha-grid-overlay';
      overlay.width = box.width;
      overlay.height = box.height;
      overlay.style.position = 'fixed';
      overlay.style.left = `${box.x}px`;
      overlay.style.top = `${box.y}px`;
      overlay.style.width = `${box.width}px`;
      overlay.style.height = `${box.height}px`;
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '2147483647';
      
      const ctx = overlay.getContext('2d');
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.35)';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(255, 0, 0, 0.85)';
      ctx.font = 'bold 9px sans-serif';
      
      const step = 40;
      // Vertical gridlines
      for (let x = step; x < box.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, box.height);
        ctx.stroke();
        ctx.fillText(x.toString(), x + 2, 10);
      }
      // Horizontal gridlines
      for (let y = step; y < box.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(box.width, y);
        ctx.stroke();
        ctx.fillText(y.toString(), 2, y - 2);
      }
      document.body.appendChild(overlay);
    }, iframeBox).catch(() => {});

    await sleep(200);

    const debugPath = path.join(os.tmpdir(), `arkose_drag_${Date.now()}.png`);
    try {
      // Capture page screenshot clipped to the iframe bounds to capture the grid overlay
      await page.screenshot({ path: debugPath, clip: iframeBox, timeout: 15000 });
      try {
        fs.copyFileSync(debugPath, path.join(__dirname, '../arkose_debug.png'));
      } catch (err) {
        console.log('  [WARN] Failed to copy debug screenshot:', err.message);
      }
      const imgBuffer = fs.readFileSync(debugPath);
      const b64 = imgBuffer.toString('base64');

      // Clean up overlay immediately after screenshot is taken
      await page.evaluate(() => {
        const overlay = document.getElementById('captcha-grid-overlay');
        if (overlay) overlay.remove();
      }).catch(() => {});

      console.log(`  Sending Arkose screenshot to LLM at ${apiUrl}...`);

      const promptText = `This challenge image has a red coordinate grid overlayed on top, with vertical and horizontal lines spaced every 40 CSS pixels. The top-left corner is (0, 0). Use the numbers and lines on the grid to locate the exact CSS pixel coordinates of the target items, matching templates, or pieces. Output coordinates directly in CSS pixel space matching the grid numbers (do NOT scale them, do NOT multiply them by any factor).

Look at the instruction at the top of the image to determine the task:

Case 1: If the challenge is a DRAG puzzle (e.g. "Drag the character to its matching silhouette" or "Drag the shape that fits the outline"):
- Locate the moving puzzle piece / character card: This is a card/box containing a character or shape.
- Locate the matching target area / silhouette / shadow outline.
- Determine the center coordinates of both the moving piece (source) and the matching target (target) directly in CSS pixel coordinates matching the grid.
- Output JSON in this format:
{
  "mode": "drag",
  "actions": [
    { "source": { "x": <x_coord>, "y": <y_coord> }, "target": { "x": <x_coord>, "y": <y_coord> } }
  ]
}

Case 2: If the challenge is a CLICK puzzle (e.g. "Click the shape that does not match", "Click on animals...", "Tap on all things...", or any selection challenge):
- Determine if candidates are arranged in a neat grid (e.g. 3x3 images, or 5x5 shapes) or scattered randomly on the background.
- Carefully locate the centers of the correct candidates. If the instruction contains plural words or implies multiple matching items (e.g., "Tap on all things...", "Click on animals..."), locate and output coordinates for ALL matching items on the screen.
- If there are no items matching the criteria/reference, or you want to skip/confirm directly, return an empty array for clicks.
- In the JSON response, include a "grid" parameter indicating whether the items are in a standard grid layout:
  - Use "grid_3x3" if the candidates are arranged in a neat 3x3 grid of square tiles (common in "Select ALL objects based on the counts shown" challenges).
  - Use "grid_5x5" if the candidates are arranged in a neat 5x5 grid of shapes (common in "Please click on all elements that break the pattern" challenges).
  - Use "none" if the items are scattered randomly on a scenic background, or if it is a drag-and-drop / slider challenge.
- Output JSON in this format:
{
  "mode": "click",
  "grid": "grid_3x3" | "grid_5x5" | "none",
  "clicks": [
    { "x": <x_coord>, "y": <y_coord> },
    ...
  ]
}

For each challenge, first write down your step-by-step thinking showing your identified shapes, reference, candidates, and calculated center coordinates matching the grid. Then, output the final JSON object containing the actions or clicks at the end of your response. All coordinates must be within the grid bounds. Be extremely precise.`;

      const contentArray = [
        {
          type: 'text',
          text: promptText
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${b64}` }
        }
      ];

      // Disable sending CV-processed variants (they distort patterns for advanced vision LLMs)
      /*
      const processed = await generateProcessedImages(page, b64);
      if (processed && !processed.error && processed.contrast && processed.edges) {
        console.log('  Adding high-contrast and Sobel edge-detection map to LLM payload message content...');
        contentArray.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${processed.contrast}` }
        });
        contentArray.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${processed.edges}` }
        });
      }
      */

      const payload = {
        model: model,
        stream: false,
        messages: [
          {
            role: 'user',
            content: contentArray
          }
        ]
      };

      const res = await retry(() => fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
      }, timeoutMs), { retries: 3, delayMs: 2000, label: 'LLM solveArkoseDrag' });

      const data = await res.json();
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error(`LLM response error: ${JSON.stringify(data)}`);
      }

      const rawResult = (data.choices[0].message.content || '').trim();
      console.log(`  LLM response content: "${rawResult}"`);

      // Clean JSON in case markdown formatting or extra text is returned
      let jsonStr = rawResult;
      
      // 1. Try matching ```json ... ``` code fence
      const fenceMatch = rawResult.match(/```json\s*([\s\S]*?)\s*```/i) || rawResult.match(/```\s*([\s\S]*?)\s*```/i);
      let parsed = null;
      
      if (fenceMatch) {
        try {
          const candidate = fenceMatch[1].trim();
          parsed = JSON.parse(candidate);
          jsonStr = candidate;
        } catch (_) {}
      }
      
      if (!parsed) {
        // 2. Try parsing brace-balanced substring from the beginning matching {"mode"
        let startIdx = rawResult.indexOf('{"mode"');
        if (startIdx === -1) startIdx = rawResult.indexOf('{\n  "mode"');
        if (startIdx === -1) startIdx = rawResult.indexOf('{\n"mode"');
        if (startIdx === -1) startIdx = rawResult.indexOf('{');
        
        if (startIdx !== -1) {
          const candidate = rawResult.substring(startIdx);
          let braceCount = 0;
          let endIdx = -1;
          for (let i = 0; i < candidate.length; i++) {
            if (candidate[i] === '{') braceCount++;
            else if (candidate[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIdx = i;
                break;
              }
            }
          }
          if (endIdx !== -1) {
            const finalCandidate = candidate.substring(0, endIdx + 1);
            try {
              parsed = JSON.parse(finalCandidate);
              jsonStr = finalCandidate;
            } catch (_) {}
          }
        }
      }
      
      if (!parsed) {
        // 3. Fallback to original match-all-braces regex
        const match = rawResult.match(/\{[\s\S]*\}/);
        if (match) {
          jsonStr = match[0];
        }
        parsed = JSON.parse(jsonStr);
      }

      const W = iframeBox.width;
      const H = iframeBox.height;
      console.log(`  [Grid Coordinates] Active iframe dimensions: ${W}x${H} CSS pixels`);

      const mode = parsed.mode || (parsed.clicks ? "click" : "drag");

      if (mode === "click" && parsed.clicks && Array.isArray(parsed.clicks)) {
        const gridType = parsed.grid || "none";
        const snappedClicks = snapToGrid(parsed.clicks, W, H, gridType);
        console.log(`  [Click Mode] Detected selection challenge with ${snappedClicks.length} clicks...`);
        for (let clickIdx = 0; clickIdx < snappedClicks.length; clickIdx++) {
          const clickCoords = snappedClicks[clickIdx];
          if (typeof clickCoords.x !== 'number' || typeof clickCoords.y !== 'number') continue;

          // Directly use coordinates from the CSS grid
          const actualX = clickCoords.x;
          const actualY = clickCoords.y;

          console.log(`  Performing click ${clickIdx + 1}/${parsed.clicks.length} inside iframe at relative (${actualX.toFixed(1)}, ${actualY.toFixed(1)})`);
          const startX = iframeBox.x + actualX;
          const startY = iframeBox.y + actualY;
          await page.mouse.click(startX, startY, { delay: rand(80, 150) }).catch((err) => {
            console.log(`  [WARN] Failed to click inside iframe via page mouse: ${err.message}`);
          });
          await sleep(rand(400, 700));
        }
      } else {
        // Drag mode
        let actions = [];
        if (parsed.actions && Array.isArray(parsed.actions)) {
          actions = parsed.actions;
        } else if (parsed.source && parsed.target) {
          actions = [parsed];
        }

        console.log(`  [Drag Mode] Detected drag challenge with ${actions.length} drags...`);
        for (let actIdx = 0; actIdx < actions.length; actIdx++) {
          const action = actions[actIdx];
          if (!action.source || typeof action.source.x !== 'number' || !action.target || typeof action.target.x !== 'number') {
            console.log('  [WARN] Invalid action structure, skipping:', action);
            continue;
          }

          // Directly use coordinates from the CSS grid
          const sourceX = action.source.x;
          const sourceY = action.source.y;
          const targetX = action.target.x;
          const targetY = action.target.y;

          const startX = iframeBox.x + sourceX;
          const startY = iframeBox.y + sourceY;
          const endX = iframeBox.x + targetX;
          const endY = iframeBox.y + targetY;

          console.log(`  Performing drag ${actIdx + 1}/${actions.length}: (${startX.toFixed(1)}, ${startY.toFixed(1)}) -> (${endX.toFixed(1)}, ${endY.toFixed(1)})`);
          
          await page.mouse.move(startX, startY);
          await page.mouse.down();
          await sleep(rand(200, 350));

          const steps = 25;
          for (let s = 1; s <= steps; s++) {
            const progress = s / steps;
            const ease = 1 - (1 - progress) * (1 - progress);
            const curX = startX + (endX - startX) * ease;
            const curY = startY + (endY - startY) * ease;
            // Only add jitter for non-final steps
            const jitterY = s === steps ? curY : curY + (Math.random() - 0.5) * 1.5;
            await page.mouse.move(curX, jitterY);
            await sleep(rand(15, 30));
          }
          
          // Force move to EXACT target coordinate block to guarantee absolute precision
          await page.mouse.move(endX, endY);
          await sleep(350);
          await page.mouse.up();
          console.log(`  Drag ${actIdx + 1} completed.`);
          await sleep(1500); // Wait between drags
        }
      }

      // Click bottom-right action button (Verify/Next/Submit/Skip/Confirm)
      const verifyBtn = frame.locator(
        'button:has-text("Verify"), button:has-text("Next"), button:has-text("Submit"), button:has-text("Skip"), button:has-text("Confirm"), ' +
        'div[role="button"]:has-text("Verify"), div[role="button"]:has-text("Next"), div[role="button"]:has-text("Submit"), div[role="button"]:has-text("Skip"), div[role="button"]:has-text("Confirm"), ' +
        '.button-submit, .submit, [title*="Verify"], [title*="Submit"], [title*="Skip"], [title*="Confirm"], [aria-label*="Verify"], [aria-label*="Submit"], [aria-label*="Skip"], [aria-label*="Confirm"]'
      ).first();
      if (await verifyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  Clicking bottom-right action button (Verify/Next/Submit)...');
        await verifyBtn.click({ force: true }).catch(() => {});
      }

      // Wait a moment for the transition/next step to load
      await sleep(4000);

    } catch (e) {
      console.log(`  Error during Arkose Drag solve step: ${e.message}`);
      await sleep(3000);
    } finally {
      try { fs.unlinkSync(debugPath); } catch (_) {}
    }
  }

  return false;
}

module.exports = {
  extractCaptchaConfig,
  injectToken,
  verifySolved,
  solveAliyunCaptcha,
  solveImageCaptcha,
  solveArkoseDragCaptcha,
};
