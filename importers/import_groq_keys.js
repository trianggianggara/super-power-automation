const fs = require('fs');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_GROQ_CSV || 'groq.csv',
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://100.103.220.104:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  validate: args.get('validate') !== 'false' && !args.has('no-validate'),
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

function readKeys(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    return [];
  }
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value])))
    .map(row => ({
      name: row.email,
      apiKey: row.api_key || row.apiKey,
      email: row.email,
      password: row.password,
    }))
    .filter(row => row.name && row.apiKey);
}

async function validateKey(apiKey) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text.slice(0, 160) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  console.log('=== Groq OmniRoute Connection Automation ===');
  console.log(`Reading keys from: ${config.csv}`);
  const rows = readKeys(config.csv);
  
  // Filter for unique Groq keys
  const seenKeys = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (!row.apiKey || row.apiKey.trim().length < 20) continue;
    if (seenKeys.has(row.apiKey)) continue;
    seenKeys.add(row.apiKey);
    uniqueRows.push(row);
  }

  console.log(`Found ${rows.length} total rows. Unique Groq keys: ${uniqueRows.length}`);
  if (uniqueRows.length === 0) {
    console.log('No Groq keys to import.');
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
      .filter(connection => connection.provider === 'groq')
      .map(connection => connection.name));
    
    const results = [];

    for (const row of uniqueRows) {
      if (existingNames.has(row.name)) {
        results.push({ name: row.name, status: 'skipped_duplicate_name' });
        continue;
      }

      if (config.validate) {
        console.log(`Validating key for ${row.name}...`);
        const validation = await validateKey(row.apiKey);
        if (!validation.ok) {
          console.log(`  Validation failed: ${validation.error}`);
          results.push({ name: row.name, status: 'skipped_validation_failed', detail: validation.error });
          continue;
        }
      }

      const payload = {
        provider: 'groq',
        authType: 'apikey',
        name: row.name,
        apiKey: row.apiKey,
        priority: 1,
        isActive: true,
        providerSpecificData: {},
      };

      console.log(`Saving connection for ${row.name} to OmniRoute...`);
      const saved = await page.evaluate(async payload => {
        const res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        let body = {};
        try { body = JSON.parse(text); } catch (_) {}
        return { ok: res.ok, status: res.status, body };
      }, payload);

      if (saved.ok) {
        existingNames.add(row.name);
        results.push({ name: row.name, status: 'added' });
        console.log(`  Added successfully.`);

        const connectionId = saved.body?.connection?.id;
        if (connectionId) {
          console.log(`  Syncing models for connection ${connectionId}...`);
          const syncRes = await page.evaluate(async id => {
            const res = await fetch(`/api/providers/${id}/sync-models`, { method: 'POST' });
            const text = await res.text();
            return { ok: res.ok, status: res.status, text };
          }, connectionId);
          console.log(`  Sync completed: status=${syncRes.status}`);
        }
      } else {
        const errDetail = saved.body?.error || saved.body?.message || 'Save failed';
        results.push({ name: row.name, status: 'failed_save', detail: saved.status, error: errDetail });
        console.error(`  Failed to save: status=${saved.status}, error=${errDetail}`);
      }
    }

    const summary = results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {});

    console.log('\n=== IMPORT SUMMARY ===');
    console.log(JSON.stringify({
      csvRows: rows.length,
      uniqueKeys: uniqueRows.length,
      validateEachKeyBeforeSaving: config.validate,
      summary,
      results,
    }, null, 2));

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
