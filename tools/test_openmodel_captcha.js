const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../utils/env.js');
const { solveAliyunCaptcha } = require('../utils/captcha_solver.js');

loadEnv();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    console.log('Navigating to auth page...');
    await page.goto('https://console.openmodel.ai/auth', { waitUntil: 'networkidle' });

    // Handle policy agreement modal if present
    const agreeBtn = page.getByRole('button', { name: /agree/i });
    if (await agreeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Clicking Policy Agreement button...');
      await agreeBtn.click();
      await sleep(1000);
    }

    // Switch to Register tab
    console.log('Switching to Register tab...');
    await page.getByRole('tab', { name: 'Register' }).or(page.locator('button:has-text("Register")')).first().click();
    await sleep(1000);

    // Fill email
    const email = `test_llm_${Math.floor(Math.random() * 100000)}@dellakuyang.my.id`;
    console.log(`Filling email: ${email}`);
    await page.locator('input#email-otp').fill(email);
    await sleep(500);

    // Take screenshot before clicking Send code
    await page.screenshot({ path: path.join(__dirname, 'before_send_code.png') });

    // Click Send code
    console.log('Clicking Send code...');
    await page.getByRole('button', { name: 'Send code' }).click();
    
    // Wait for captcha popup to appear generally
    console.log('Waiting 5 seconds for captcha to load...');
    await sleep(5000);

    // Deep recursive search of DOM including all shadow roots, starting from html root
    console.log('Inspecting DOM recursively from html root...');
    const domDetails = await page.evaluate(() => {
      const results = [];
      const positionedElements = [];

      function search(node) {
        if (!node) return;
        
        if (node.nodeType === Node.ELEMENT_NODE) {
          const id = node.id || '';
          const className = typeof node.className === 'string' ? node.className : '';
          const tagName = node.tagName.toLowerCase();
          
          // Check styles for overlays
          const style = window.getComputedStyle(node);
          const position = style.position;
          const zIndex = parseInt(style.zIndex, 10);
          
          if ((position === 'fixed' || position === 'absolute' || zIndex > 50) && node.offsetWidth > 0 && node.offsetHeight > 0) {
            positionedElements.push({
              tagName,
              id,
              className,
              position,
              zIndex,
              width: node.offsetWidth,
              height: node.offsetHeight
            });
          }

          if (
            id.toLowerCase().includes('captcha') || id.toLowerCase().includes('verify') || id.toLowerCase().includes('slide') ||
            className.toLowerCase().includes('captcha') || className.toLowerCase().includes('verify') || className.toLowerCase().includes('slide') ||
            tagName.includes('captcha') || tagName.includes('verify')
          ) {
            results.push({
              tagName,
              id,
              className,
              visible: node.offsetWidth > 0 && node.offsetHeight > 0
            });
          }
        }
        
        // Traverse children
        for (const child of node.childNodes) {
          search(child);
        }
        
        // Traverse shadow root if present
        if (node.shadowRoot) {
          search(node.shadowRoot);
        }
      }
      
      search(document.documentElement);
      return { matches: results, positioned: positionedElements };
    });
    console.log('Found matches:', JSON.stringify(domDetails.matches, null, 2));
    console.log('Found positioned elements:', JSON.stringify(domDetails.positioned, null, 2));

    // Take screenshot of captcha popup
    await page.screenshot({ path: path.join(__dirname, 'captcha_popup.png') });

    // Wait for the captcha to be resolved manually by the user
    console.log('>>> CAPTCHA: Solve the captcha MANUALLY in the browser window.');
    
    // First, wait up to 10s for the captcha to be visible
    console.log('Waiting for captcha to appear...');
    await page.locator('#tCaptchaVerifyArea, .tencent-captcha__verify-area').first()
      .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      
    // Then wait for it to disappear (user solved it)
    console.log('Waiting for captcha to disappear (solved)...');
    let solved = false;
    try {
      await page.locator('#tCaptchaVerifyArea, .tencent-captcha__verify-area').first()
        .waitFor({ state: 'hidden', timeout: 120000 });
      solved = true;
    } catch (e) {
      console.log('Timeout waiting for captcha to be solved.');
    }

    console.log(`Captcha solved status: ${solved}`);
    await sleep(2000);

    // Capture screenshot of the next screen
    const afterCaptchaPath = path.join(__dirname, 'after_captcha.png');
    await page.screenshot({ path: afterCaptchaPath });
    console.log(`Saved screenshot to ${afterCaptchaPath}`);

    // Wait for the OTP to arrive in the webhook store (.tempmail-webhook-8787.json)
    console.log(`Waiting for OTP email for ${email} in webhook store...`);
    const tempMailStorePath = path.join(__dirname, '.tempmail-webhook-8787.json');
    let otpCode = '';
    const otpStartTime = Date.now();
    
    while (Date.now() - otpStartTime < 120000) {
      if (fs.existsSync(tempMailStorePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(tempMailStorePath, 'utf8'));
          // Find emails sent to our address
          const match = content.find(msg => msg.to_address.toLowerCase() === email.toLowerCase());
          if (match) {
            console.log(`Found email with subject: "${match.subject}"`);
            // Extract 6 digit code
            const codeMatch = match.text_body.match(/verification code is (\d{6})/i) || 
                              match.text_body.match(/\b(\d{6})\b/);
            if (codeMatch) {
              otpCode = codeMatch[1];
              console.log(`Extracted OTP Code: ${otpCode}`);
              break;
            }
          }
        } catch (e) {
          console.error('Error reading webhook store:', e.message);
        }
      }
      await sleep(2000);
    }

    if (!otpCode) {
      throw new Error('Timeout waiting for OTP email in webhook store');
    }

    // Fill the OTP input
    console.log('Filling OTP code...');
    await page.locator('input#otp-code').fill(otpCode);
    await sleep(500);

    // Click Verify
    console.log('Clicking Verify...');
    await page.locator('button[type="submit"]:has-text("Verify")').click();
    await sleep(5000);

    // Take screenshot of the screen after verification
    const afterVerifyPath = path.join(__dirname, 'after_verify.png');
    await page.screenshot({ path: afterVerifyPath });
    console.log(`Saved screenshot to ${afterVerifyPath}`);

    // Print all inputs and buttons on this new screen (e.g. password or dashboard)
    const afterVerifyInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, button')).map(el => ({
        tagName: el.tagName.toLowerCase(),
        id: el.id,
        className: el.className,
        type: el.type,
        placeholder: el.placeholder || '',
        text: el.innerText || el.textContent || '',
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        outerHTML: el.outerHTML
      }));
    });
    console.log('Visible elements after Verify:', afterVerifyInputs.filter(e => e.visible));

  } catch (err) {
    console.error('Error:', err);
    try {
      await page.screenshot({ path: path.join(__dirname, 'error.png') });
      console.log('Saved error.png screenshot.');
      const html = await page.content();
      console.log('Page HTML snippet around body:', html.slice(0, 1000));
    } catch (e) {
      console.error('Failed to capture error screenshot:', e);
    }
  } finally {
    console.log('Closing browser in 5 seconds...');
    await sleep(5000);
    await browser.close();
  }
}

main();
