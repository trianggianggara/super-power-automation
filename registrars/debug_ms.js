const { loadEnv } = require('../utils/env.js'); loadEnv();
const { browserTypeFor, isCamoufox, resolveBrowserExecutablePath, envFlag } = require('../utils/browser.js');
const StealthPlugin = require('puppeteer-extra-plugin-stealth')();
const bexec = resolveBrowserExecutablePath('');
const btype = browserTypeFor(bexec);
if (!isCamoufox(bexec)) btype.use(StealthPlugin);

(async () => {
  const browser = await btype.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  
  await page.goto('https://signup.live.com/signup?lic=1', { waitUntil: 'networkidle', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  
  const email = 'testuser' + Date.now().toString().slice(-6) + '@outlook.com';
  console.log('Email:', email);
  
  // Type slowly like human
  const emailField = page.locator('input[type=email]').first();
  await emailField.click();
  await new Promise(r => setTimeout(r, 300));
  await emailField.type(email, { delay: 50 + Math.random() * 80 });
  await new Promise(r => setTimeout(r, 1000));
  
  console.log('Typed email. Clicking Next...');
  await page.locator('button[type=submit], input[type=submit]').first().click();
  await new Promise(r => setTimeout(r, 6000));
  
  console.log('URL:', page.url());
  console.log('Title:', await page.title());
  
  // Check what's visible
  const pwVisible = await page.locator('input[type=password]').isVisible().catch(() => false);
  console.log('Password field visible:', pwVisible);
  
  const errorText = await page.locator('[role=alert], .error, #emailError, #MemberNameError').textContent().catch(() => 'no error');
  console.log('Error:', errorText);
  
  // Dump visible inputs
  const inputs = await page.evaluate(() => 
    Array.from(document.querySelectorAll('input:not([type=hidden]), button'))
      .filter(e => e.offsetParent)
      .map(e => ({ tag: e.tagName, type: e.type, name: e.name, text: (e.textContent || '').trim().substring(0, 30) }))
  );
  console.log('Inputs:', JSON.stringify(inputs));
  
  await page.screenshot({ path: '/tmp/ms_signup_debug2.png' });
  console.log('Screenshot saved');
  
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
