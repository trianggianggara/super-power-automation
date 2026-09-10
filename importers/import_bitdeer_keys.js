const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const DEFAULT_PROVIDER_ID = 'openai-compatible-chat-44c6a0da-5a0e-4acf-89c0-914363c15a9a';
const DEFAULT_URL = 'http://100.103.220.104:20128';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_BITDEER_CSV || path.join(__dirname, '..', 'data', 'bitdeer.csv'),
  url: args.get('url') || process.env.OMNIROUTE_URL || DEFAULT_URL,
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  provider: args.get('provider') || process.env.OMNIROUTE_PROVIDER_ID || DEFAULT_PROVIDER_ID,
  providerName: args.get('provider-name') || process.env.OMNIROUTE_PROVIDER_NAME || 'bitdeer',
  baseUrl: args.get('base-url') || process.env.OMNIROUTE_PROVIDER_BASE_URL || 'https://api-inference.bitdeer.ai/v1',
  prefix: args.get('prefix') || process.env.OMNIROUTE_PROVIDER_PREFIX || 'bitdeer',
  validationModel: args.get('validation-model') || process.env.OMNIROUTE_VALIDATION_MODEL || '',
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
  if (lines.length === 0) return [];
  
  // Notice that bitdeer.csv has no header row. It directly contains data.
  // Format: "email", "password", "api_key", "timestamp"
  return lines.map(line => {
    const row = parseCsvLine(line);
    return {
      name: row[0],
      apiKey: row[2] || '',
      email: row[0],
      password: row[1],
    };
  }).filter(row => row.name && row.apiKey);
}

async function validateKey(apiKey) {
  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
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
  console.log('=== Bitdeer OmniRoute Connection Automation ===');
  console.log(`Reading keys from: ${config.csv}`);
  const rows = readKeys(config.csv);
  
  // Filter for unique keys
  const seenKeys = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (!row.apiKey || row.apiKey.trim().length < 5) continue;
    if (seenKeys.has(row.apiKey)) continue;
    seenKeys.add(row.apiKey);
    uniqueRows.push(row);
  }

  console.log(`Found ${rows.length} total rows. Unique Bitdeer keys: ${uniqueRows.length}`);
  if (uniqueRows.length === 0) {
    console.log('No Bitdeer keys to import.');
    return;
  }

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    await login(page);

    // Ensure provider node has User-Agent customHeaders configured
    console.log('  Ensuring provider node has custom User-Agent headers...');
    await page.evaluate(async ({ providerId, providerName, baseUrl, prefix }) => {
      try {
        const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
        await fetch(`/api/provider-nodes/${providerId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: providerName,
            prefix: prefix,
            apiType: 'chat',
            baseUrl: baseUrl,
            chatPath: '/chat/completions',
            customHeaders: { 'User-Agent': ua }
          })
        });
      } catch (_) {}
    }, {
      providerId: config.provider,
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      prefix: config.prefix
    });

    const allConnections = await page.evaluate(async () => {
      const data = await fetch('/api/providers').then(res => res.json());
      return data.connections || [];
    });

    const existingNames = new Set(allConnections
      .filter(connection => connection.provider === config.provider)
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
          console.log(`  Validation failed: ${validation.error || validation.status}`);
          results.push({ name: row.name, status: 'skipped_validation_failed', detail: validation.error || validation.status });
          continue;
        }
      }

      const payload = {
        provider: config.provider,
        authType: 'apikey',
        name: row.name,
        apiKey: row.apiKey,
        priority: 1,
        isActive: true,
        proxyEnabled: true,
        providerSpecificData: {
          prefix: config.prefix,
          apiType: 'chat',
          baseUrl: config.baseUrl,
          nodeName: config.providerName,
          customUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          customHeaders: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          },
        },
      };

      if (config.validationModel) {
        payload.providerSpecificData.validationModel = config.validationModel;
      }

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
