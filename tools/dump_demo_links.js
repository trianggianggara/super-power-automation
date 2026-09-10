const { chromium } = require('playwright');
const fs = require('fs');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('https://2captcha.com/demo', { waitUntil: 'networkidle' });
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .map(a => ({
          text: a.textContent.trim(),
          href: a.getAttribute('href')
        }))
        .filter(l => l.href && l.href.includes('/demo/'));
    });
    console.log(JSON.stringify(links, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    await browser.close();
  }
}
main();
