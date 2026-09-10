#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ageArg = process.argv.find((arg) => /^\d+(\.\d+)?$/.test(arg));
const maxAgeHours = Number(process.env.MAX_AGE_HOURS || ageArg || 0);
const dryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
const scanDirs = [root, os.tmpdir()];
const patterns = [
  /^\.chrome_profile_tmp_/,
  /^\.chrome_profile_tmp_login_/,
  /^\.com\.google\.Chrome\./,
  /^chrome-debug-profile-/,
  /^\.org\.chromium\.Chromium\./,
  /^playwright[-_]/i,
  /^puppeteer_dev/i,
  /^brave-/i,
  /^camoufox/i,
  /^cloakbrowser-/i,
];
const processList = (() => {
  try {
    return require('child_process').execSync('ps -eo args', { encoding: 'utf8' });
  } catch (_) {
    return '';
  }
})();

let count = 0;
let bytes = 0;

function sizeOf(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
}

for (const dir of scanDirs) {
  if (!fs.existsSync(dir)) continue;

  for (const name of fs.readdirSync(dir)) {
    if (!patterns.some((pattern) => pattern.test(name))) continue;

    const target = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (_) {
      continue;
    }
    if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
    if (processList.includes(target)) {
      console.log(`skip in-use ${target}`);
      continue;
    }

    const targetSize = sizeOf(target);
    bytes += targetSize;
    count += 1;
    console.log(`${dryRun ? 'would remove' : 'removed'} ${target} (${(targetSize / 1024 / 1024).toFixed(1)} MB)`);

    if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  }
}

console.log(`${dryRun ? 'dry run:' : 'done:'} ${count} dirs, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
