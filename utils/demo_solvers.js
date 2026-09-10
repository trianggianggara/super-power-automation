const path = require('path');
const fs = require('fs');
const os = require('os');
const { sleep, retry, fetchWithTimeout, rand } = require('./helpers');
const { solveImageCaptcha } = require('./captcha_solver.js');

async function clickCheck(page) {
  const checkBtn = page.locator('button:has-text("Check")').first();
  if (await checkBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  Clicking Check button...');
    await checkBtn.click({ force: true });
  } else {
    console.log('  No Check button visible, skipping click.');
  }
}

async function solveNormal(page, options) {
  console.log('  [Normal Captcha] Locating captcha image...');
  const imgLocator = page.locator('div[class*="captchaWidgetContainer"] img[alt*="example"], img[alt="normal captcha example"]').first();
  const solved = await solveImageCaptcha(imgLocator, page, {
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    model: options.model,
    inputSelector: '#simple-captcha-field',
    submitSelector: 'button:has-text("Check")',
    retries: 3
  });
  if (solved) {
    await clickCheck(page);
  }
  return solved;
}

async function solveText(page, options) {
  console.log('  [Text Captcha] Locating question...');
  const questionEl = page.locator('label[for="text-captcha-field"]').first();
  const question = await questionEl.textContent();
  console.log(`  Question text: "${question}"`);

  const apiKey = options.apiKey;
  const apiUrl = options.apiUrl;
  const model = options.model;

  const payload = {
    model: model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: `Answer this simple captcha question. Return ONLY the direct final answer (e.g. if the question is "what is 2+2", return "4"; if "what color is the sky", return "blue"). No punctuation, no explanation, no extra text.\nQuestion: ${question}`
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
  }), { retries: 3, delayMs: 1000, label: 'LLM solveText' });

  const data = await res.json();
  const answer = (data.choices[0].message.content || '').trim();
  console.log(`  LLM Answer: "${answer}"`);

  const input = page.locator('#text-captcha-field').first();
  await input.fill(answer);
  await clickCheck(page);
  return true;
}

async function solveClick(page, options) {
  console.log('  [Click Captcha] Locating image...');
  const imgLocator = page.locator('div[class*="captchaWidgetContainer"] img[alt*="example"]').first();
  const box = await imgLocator.boundingBox();
  if (!box) {
    throw new Error('Click captcha image bounding box not found');
  }

  const debugPath = path.join(os.tmpdir(), `click_captcha_${Date.now()}.png`);
  await imgLocator.screenshot({ path: debugPath });
  const b64 = fs.readFileSync(debugPath).toString('base64');
  try { fs.unlinkSync(debugPath); } catch (_) {}

  const apiKey = options.apiKey;
  const apiUrl = options.apiUrl;
  const model = options.model;

  const prompt = `This is a coordinate click captcha challenge image of width 200 and height 230 pixels. Look at the instructions/icons inside or at the top of the image. Identify the target icons/categories to click. Determine the center coordinates (X, Y) of the correct targets on the image space (0 <= X <= 200, 0 <= Y <= 230). Output the coordinates as JSON in the following format:\n{"clicks": [{"x": <x_coordinate>, "y": <y_coordinate>}, ...]}\nReturn ONLY the JSON block. Do not include markdown blocks or any other explanation.`;

  const payload = {
    model: model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
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
  }), { retries: 3, delayMs: 1000, label: 'LLM solveClick' });

  const data = await res.json();
  const rawResult = (data.choices[0].message.content || '').trim();
  console.log(`  LLM response content: "${rawResult}"`);

  let parsed = null;
  const match = rawResult.match(/\{[\s\S]*\}/);
  if (match) {
    parsed = JSON.parse(match[0]);
  } else {
    parsed = JSON.parse(rawResult);
  }

  if (parsed && parsed.clicks && Array.isArray(parsed.clicks)) {
    console.log(`  Clicking ${parsed.clicks.length} coordinates...`);
    for (const c of parsed.clicks) {
      const scaleX = box.width * (c.x / 200);
      const scaleY = box.height * (c.y / 230);
      const targetX = box.x + scaleX;
      const targetY = box.y + scaleY;
      console.log(`  Clicking target at: (${targetX.toFixed(1)}, ${targetY.toFixed(1)})`);
      await page.mouse.click(targetX, targetY);
      await sleep(500);
    }
  }

  await clickCheck(page);
  return true;
}

async function solveRotate(page, options) {
  console.log('  [Rotate Captcha] Locating image...');
  const imgLocator = page.locator('img[alt="rotatecaptcha example"]').first();
  const box = await imgLocator.boundingBox();
  if (!box) {
    throw new Error('Rotate captcha image bounding box not found');
  }

  const debugPath = path.join(os.tmpdir(), `rotate_captcha_${Date.now()}.png`);
  await imgLocator.screenshot({ path: debugPath });
  const b64 = fs.readFileSync(debugPath).toString('base64');
  try { fs.unlinkSync(debugPath); } catch (_) {}

  const apiKey = options.apiKey;
  const apiUrl = options.apiUrl;
  const model = options.model;

  const prompt = `This is a rotated circular image. Estimate the rotation angle (in degrees, clockwise, from 0 to 360) required to rotate it back to its upright (normal) orientation. Your estimate must be a multiple of 15 (e.g. 15, 30, 45, 90, 180, etc.).\nOutput ONLY the number of degrees, e.g. "90", with no other text or formatting.`;

  const payload = {
    model: model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
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
  }), { retries: 3, delayMs: 1000, label: 'LLM solveRotate' });

  const data = await res.json();
  const rawAngle = (data.choices[0].message.content || '').trim().replace(/[^\d]/g, '');
  const angle = parseInt(rawAngle, 10) || 0;
  console.log(`  LLM estimated degrees: ${angle}°`);

  const clicks = Math.round(angle / 15);
  console.log(`  Clicking Rotate Right button ${clicks} times...`);

  const rightBtn = page.locator('button[class*="rotateRightBtn"]').first();
  for (let i = 0; i < clicks; i++) {
    await rightBtn.click();
    await sleep(200);
  }

  await clickCheck(page);
  return true;
}

async function solveTurnstile(page) {
  console.log('  [Turnstile] Monitoring Turnstile...');
  let frame = null;
  for (let i = 0; i < 10; i++) {
    frame = page.frames().find(f => f.url().includes('challenges.cloudflare.com') || f.url().includes('turnstile'));
    if (frame) break;
    await sleep(1000);
  }

  if (frame) {
    console.log('  Turnstile frame detected. Clicking checkbox...');
    const frameElement = await frame.frameElement().catch(() => null);
    if (frameElement) {
      const box = await frameElement.boundingBox().catch(() => null);
      if (box) {
        const clickX = box.x + 30;
        const clickY = box.y + box.height / 2;
        await page.mouse.click(clickX, clickY);
        console.log(`  Clicked Turnstile checkbox at x=${clickX.toFixed(1)}, y=${clickY.toFixed(1)}`);
      }
    }
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const token = await page.evaluate(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]');
      return el ? el.value : '';
    }).catch(() => '');
    if (token && token.length > 50) {
      console.log('  Turnstile token verified!');
      break;
    }
    await sleep(1000);
  }

  await clickCheck(page);
  return true;
}

async function solveRecaptcha(page) {
  console.log('  [reCAPTCHA] Solving via recaptcha-solver...');
  const solver = require('recaptcha-solver');
  try {
    const solved = await solver.solve(page);
    console.log(`  reCAPTCHA solver status: ${solved}`);
  } catch (err) {
    console.log(`  [WARN] reCAPTCHA solver error: ${err.message}. Trying direct check...`);
  }

  await clickCheck(page);
  return true;
}

async function solveGeetest(page, options) {
  console.log('  [GeeTest] Waiting for verify button to load...');
  const clickVerify = page.locator('div[class*="geetest_btn_click"], .geetest_radar_btn').first();
  try {
    await clickVerify.waitFor({ state: 'visible', timeout: 15000 });
    console.log('  Clicking verify button...');
    await clickVerify.click();
    await sleep(3000);
  } catch (err) {
    console.log('  [WARN] GeeTest verify button not found or visible, proceeding...');
  }

  const windowEl = page.locator('div[class*="geetest_window"]').first();
  await windowEl.waitFor({ state: 'visible', timeout: 10000 });
  const box = await windowEl.boundingBox();
  if (!box) {
    throw new Error('GeeTest window bounding box not found');
  }

  const imgBuffer = await windowEl.screenshot();
  const b64 = imgBuffer.toString('base64');

  const apiKey = options.apiKey;
  const apiUrl = options.apiUrl;
  const model = options.model;

  const prompt = `This is a sliding puzzle captcha. There is a missing puzzle piece cutout on the background image. Estimate the horizontal percentage from the left edge of the image to the center of the missing cutout target (where the puzzle piece should be placed). Return ONLY the percentage value (for example, "55%"), with no other text or explanation.`;

  const payload = {
    model: model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
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
  }), { retries: 3, delayMs: 1000, label: 'LLM solveGeetest' });

  const data = await res.json();
  const rawResult = (data.choices[0].message.content || '').trim();
  console.log(`  LLM response content: "${rawResult}"`);

  const pctMatch = rawResult.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!pctMatch) {
    throw new Error(`Failed to parse GeeTest slider percentage from LLM: ${rawResult}`);
  }
  const percentage = parseFloat(pctMatch[1]);
  console.log(`  GeeTest slider percentage: ${percentage}%`);

  const handle = page.locator('div[class*="geetest_btn"]').first();
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('GeeTest slider handle bounding box not found');
  }

  const dragDistance = box.width * (percentage / 100);
  console.log(`  Calculated drag distance: ${dragDistance.toFixed(1)}px`);

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await sleep(200);

  const steps = 20;
  for (let s = 1; s <= steps; s++) {
    const progress = s / steps;
    const ease = 1 - (1 - progress) * (1 - progress);
    const curX = startX + dragDistance * ease;
    const jitterY = startY + (Math.random() - 0.5) * 1.5;
    await page.mouse.move(curX, jitterY);
    await sleep(20);
  }
  await sleep(300);
  await page.mouse.up();
  console.log('  GeeTest drag completed.');

  await sleep(3000);
  await clickCheck(page);
  return true;
}

async function solveMTCaptcha(page, options) {
  console.log('  [MTCaptcha] Locating MTCaptcha iframe...');
  const iframeLocator = page.frameLocator('#mtcaptcha-iframe-1');
  const imgLocator = iframeLocator.locator('#mtcap-image-1');

  await imgLocator.waitFor({ state: 'visible', timeout: 10000 });
  const box = await imgLocator.boundingBox();
  if (!box) {
    throw new Error('MTCaptcha image box not found');
  }

  const debugPath = path.join(os.tmpdir(), `mtcaptcha_${Date.now()}.png`);
  await imgLocator.screenshot({ path: debugPath });
  const b64 = fs.readFileSync(debugPath).toString('base64');
  try { fs.unlinkSync(debugPath); } catch (_) {}

  const apiKey = options.apiKey;
  const apiUrl = options.apiUrl;
  const model = options.model;

  const prompt = 'Identify the alphanumeric characters in this captcha image. Return only the code, no spaces, no explanation.';

  const payload = {
    model: model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
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
  }), { retries: 3, delayMs: 1000, label: 'LLM solveMTCaptcha' });

  const data = await res.json();
  const code = (data.choices[0].message.content || '').trim().replace(/[^a-zA-Z0-9]/g, '');
  console.log(`  MTCaptcha LLM Result: "${code}"`);

  const input = iframeLocator.locator('#mtcap-inputtext-1');
  await input.fill(code);
  await input.press('Enter');

  await sleep(3000);
  await clickCheck(page);
  return true;
}

async function solveLemin(page, options) {
  console.log('  [Lemin] Locating checkbox...');
  const checkbox = page.locator('a[id*="lemin-captcha-checkbox"], span.checkmark').first();
  if (await checkbox.isVisible()) {
    await checkbox.click();
    await sleep(3000);
  }

  const popup = page.locator('div.lemin-captcha-popup').first();
  await popup.waitFor({ state: 'visible', timeout: 10000 });

  const debugPath = path.join(os.tmpdir(), `lemin_${Date.now()}.png`);
  await popup.screenshot({ path: debugPath });
  const b64 = fs.readFileSync(debugPath).toString('base64');
  try { fs.unlinkSync(debugPath); } catch (_) {}

  const apiKey = options.apiKey;
  const apiUrl = options.apiUrl;
  const model = options.model;

  const prompt = `This is Lemin cropped puzzle challenge. Identify the puzzle piece at the bottom slot, and the target matching cutout on the main image above. Estimate the horizontal distance (as a percentage of the main background image width) needed to drag the puzzle piece to match the cutout. Return ONLY the percentage value (for example, "45%"), with no other text or explanation.`;

  const payload = {
    model: model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
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
  }), { retries: 3, delayMs: 1000, label: 'LLM solveLemin' });

  const data = await res.json();
  const rawResult = (data.choices[0].message.content || '').trim();
  console.log(`  LLM response content: "${rawResult}"`);

  const pctMatch = rawResult.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!pctMatch) {
    throw new Error(`Failed to parse Lemin percentage: ${rawResult}`);
  }
  const percentage = parseFloat(pctMatch[1]);
  console.log(`  Lemin percentage: ${percentage}%`);

  const piece = page.locator('div[id$="pieces"] > div').first();
  const pieceBox = await piece.boundingBox();
  const imgArea = page.locator('div[id$="image"]').first();
  const imgBox = await imgArea.boundingBox();

  if (!pieceBox || !imgBox) {
    throw new Error('Lemin layout boxes not found');
  }

  const dragDistance = imgBox.width * (percentage / 100);
  console.log(`  Calculated Lemin drag distance: ${dragDistance.toFixed(1)}px`);

  const startX = pieceBox.x + pieceBox.width / 2;
  const startY = pieceBox.y + pieceBox.height / 2;

  const endX = imgBox.x + dragDistance;
  const endY = imgBox.y + (imgBox.height / 2);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await sleep(200);

  await page.mouse.move(endX, endY, { steps: 25 });
  await sleep(300);
  await page.mouse.up();
  console.log('  Lemin drag completed.');

  await sleep(1000);
  const verifyBtn = page.locator('button[id$="verify-button"]').first();
  if (await verifyBtn.isVisible()) {
    await verifyBtn.click();
  }

  await sleep(2000);
  
  // Hide Lemin popup element to avoid intercepting clicks on the main page submit button
  await page.evaluate(() => {
    const p = document.querySelector('div.lemin-captcha-popup');
    if (p) p.style.display = 'none';
  }).catch(() => {});

  await clickCheck(page);
  return true;
}

module.exports = {
  solveNormal,
  solveText,
  solveClick,
  solveRotate,
  solveTurnstile,
  solveRecaptcha,
  solveGeetest,
  solveMTCaptcha,
  solveLemin
};
