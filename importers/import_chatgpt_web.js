const fs = require('fs');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const path = require('path');

const defaultCsv = fs.existsSync(path.join(__dirname, '..', 'data', 'chatgpt.csv'))
  ? path.join(__dirname, '..', 'data', 'chatgpt.csv')
  : 'chatgpt.csv';

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_CHATGPT_CSV || defaultCsv,
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://100.103.220.104:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  provider: args.get('provider') || 'chatgpt-web',
  headless: args.get('headed') !== 'true',
};

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  out.push(value);
  return out;
}

function readCookies(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    return [];
  }
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1)
    .map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value])))
    .map(row => ({
      name: row.email,
      email: row.email,
      password: row.password,
      credential: row.cookies,
    }))
    .filter(row => row.name && row.credential);
}

async function login(page) {
  const loginUrl = `${config.url}/login`;
  console.log(`Navigating to OmniRoute login page: ${loginUrl}`);
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    console.log(`  Navigation info: ${err.message}`);
  }

  const currentUrl = page.url();
  if (!currentUrl.includes('/login')) {
    console.log('  Already logged in.');
    return;
  }

  console.log('  Filling OmniRoute password...');
  const passwordInput = page.getByRole('textbox', { name: /password|enter your password/i })
    .or(page.locator('input[type="password"]'))
    .first();
  await passwordInput.fill(config.password);

  const loginButton = page.getByRole('button', { name: /continue|login|sign in|submit/i }).first();
  if (await loginButton.isVisible().catch(() => false)) {
    await loginButton.click();
  } else {
    await passwordInput.press('Enter');
  }

  console.log('  Waiting for redirect...');
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  console.log('  Logged in successfully.');
}

async function main() {
  console.log('=== ChatGPT-Web Cookie Importer (OmniRoute) ===');
  console.log(`Reading cookies from: ${config.csv}`);
  const rows = readCookies(config.csv);

  // Dedup by credential so a re-import doesn't create duplicate rows.
  const seenCreds = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    const key = row.credential.trim();
    if (seenCreds.has(key)) continue;
    seenCreds.add(key);
    uniqueRows.push(row);
  }
  console.log(`Found ${rows.length} rows, ${uniqueRows.length} unique.`);
  if (uniqueRows.length === 0) {
    console.log('No cookies to import.');
    return;
  }

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    await login(page);

    const allConnections = await page.evaluate(async () => {
      const data = await fetch('/api/providers').then(res => res.json());
      return data.connections || [];
    });
    const existingNames = new Set(allConnections
      .filter(c => c.provider === config.provider)
      .map(c => c.name));

    const results = [];
    const toAdd = [];

    for (const row of uniqueRows) {
      if (existingNames.has(row.name)) {
        results.push({ name: row.name, status: 'skipped_duplicate_name' });
        continue;
      }
      toAdd.push(row);
    }

    if (toAdd.length > 0) {
      console.log(`Importing ${toAdd.length} connection(s) via POST /api/providers (apiKey=cookie)...`);
      for (const row of toAdd) {
        const saved = await page.evaluate(async (payload) => {
          const res = await fetch('/api/providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const text = await res.text();
          let body = {};
          try { body = JSON.parse(text); } catch (_) {}
          return { ok: res.ok, status: res.status, body };
        }, {
          provider: config.provider,
          name: row.name,
          apiKey: row.credential,
          priority: 1,
          testStatus: 'active',
        });

        if (saved.ok) {
          console.log(`  Added: ${row.name}`);
          results.push({ name: row.name, status: 'added' });
        } else {
          const err = saved.body?.error || saved.body?.message || JSON.stringify(saved.body).slice(0, 200);
          console.error(`  Failed: ${row.name} — HTTP ${saved.status} ${err}`);
          results.push({ name: row.name, status: 'failed_save', error: `HTTP ${saved.status}` });
        }
      }
    }

    const summary = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    console.log('\n=== IMPORT SUMMARY ===');
    console.log(JSON.stringify({ csvRows: rows.length, unique: uniqueRows.length, summary, results }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
