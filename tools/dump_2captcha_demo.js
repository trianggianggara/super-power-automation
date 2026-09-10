const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
  });
  const page = await browser.newPage();
  try {
    console.log('Navigating to https://2captcha.com/demo ...');
    await page.goto('https://2captcha.com/demo', { waitUntil: 'networkidle' });
    
    // Dump title and main links/elements
    console.log('Page Title:', await page.title());
    
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim(),
        href: a.getAttribute('href'),
        id: a.id,
        className: a.className
      }));
    });
    console.log('Found Links:', JSON.stringify(links, null, 2));

    const pathScreenshot = path.join(__dirname, 'demo_screenshot.png');
    await page.screenshot({ path: pathScreenshot });
    console.log(`Saved screenshot to ${pathScreenshot}`);

  } catch (err) {
    console.error('Error occurred:', err);
  } finally {
    await browser.close();
  }
}

main();
