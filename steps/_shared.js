// Shared helpers used across all registration steps.
// Each step receives a `ctx` object with the common dependencies pre-bound.

const fs = require('fs');
const path = require('path');
const {
  sleep,
  rand,
  fillHuman,
  humanMouseMove,
  humanScroll,
  clickFirst,
  gotoWithRetry,
  handleCookies: handleCookiesBase,
} = require('../utils/helpers');

const helpers = require('../utils/helpers');

// Cookies for Qoder flow use a 1000ms initial wait.
const handleCookies = (page) => handleCookiesBase(page, 1000);

// Save a debug screenshot
async function snap(page, name) {
  try {
    const screenshotsDir = path.join(__dirname, '../screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const filePath = path.join(screenshotsDir, `${name}.png`);
    await page.screenshot({ path: filePath });
    console.log(`  [snap] Saved screenshot to: ${filePath}`);
  } catch (err) {
    console.log(`  [snap] Failed to save screenshot: ${err.message}`);
  }
}

// Append a registration result row to the CSV output.
function saveResult(outputFile, data) {
  const csvHeaders = 'timestamp,platform,first_name,last_name,email,password,status';
  const csvRow = [
    new Date().toISOString(),
    'qoder',
    data.firstName,
    data.lastName,
    data.email,
    data.password,
    data.status || 'registered',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

  const exists = fs.existsSync(outputFile);
  if (!exists) {
    fs.writeFileSync(outputFile, csvHeaders + '\n', 'utf8');
  }
  fs.appendFileSync(outputFile, csvRow + '\n', 'utf8');
  console.log(`  Saved to: ${outputFile}`);
}

module.exports = {
  fs,
  path,
  sleep,
  rand,
  fillHuman,
  humanMouseMove,
  humanScroll,
  clickFirst,
  gotoWithRetry,
  handleCookies,
  snap,
  saveResult,
  helpers,
};
