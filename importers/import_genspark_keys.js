// importers/import_genspark_keys.js — Import Genspark API Keys to OmniRoute
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const DEFAULT_PROVIDER_ID = 'openai-compatible-chat-144c01e1-5480-41e5-b651-981bb913a76b';
const DEFAULT_URL = 'http://100.103.220.104:20128';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_GENSPARK_CSV || path.join(__dirname, '..', 'data', 'genspark_accounts.csv'),
  url: args.get('url') || process.env.OMNIROUTE_URL || DEFAULT_URL,
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  provider: args.get('provider') || process.env.OMNIROUTE_PROVIDER_ID || DEFAULT_PROVIDER_ID,
  providerName: args.get('provider-name') || process.env.OMNIROUTE_PROVIDER_NAME || 'genspark',
  baseUrl: args.get('base-url') || process.env.OMNIROUTE_PROVIDER_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1',
  prefix: args.get('prefix') || process.env.OMNIROUTE_PROVIDER_PREFIX || 'gnsprk',
  validationModel: args.get('validation-model') || process.env.OMNIROUTE_VALIDATION_MODEL || '',
  validate: args.get('validate') === 'true',
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

  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase().trim());
  const emailIdx = headers.indexOf('email');
  const keyIdx = headers.indexOf('api_key');
  const passIdx = headers.indexOf('password');

  return lines.slice(1).map(line => {
    const row = parseCsvLine(line).map(val => val.replace(/^"|"$/g, '').trim());
    const email = row[emailIdx >= 0 ? emailIdx : 0] || '';
    const apiKey = row[keyIdx >= 0 ? keyIdx : 2] || '';
    const password = row[passIdx >= 0 ? passIdx : 1] || '';
    return {
      name: email,
      apiKey: apiKey,
      email: email,
      password: password,
    };
  }).filter(row => row.name && row.apiKey && row.apiKey.startsWith('gsk-'));
}

async function validateKey(apiKey) {
  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
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

  console.log('  Filling password...');
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
  console.log('  Login successful.');
}

async function main() {
  console.log('=======================================================');
  console.log('🚀 IMPORT GENSPARK API KEYS TO OMNIROUTE');
  console.log(`   Source CSV:    ${config.csv}`);
  console.log(`   Target Server: ${config.url}`);
  console.log(`   Provider ID:   ${config.provider}`);
  console.log('=======================================================\n');

  const rows = readKeys(config.csv);
  console.log(`Loaded ${rows.length} valid Genspark key row(s) from CSV.`);

  const seen = new Set();
  const uniqueRows = rows.filter(row => {
    if (seen.has(row.apiKey)) return false;
    seen.add(row.apiKey);
    return true;
  });
  console.log(`Found ${uniqueRows.length} unique API key(s) to process.`);

  if (uniqueRows.length === 0) {
    console.log('No keys to import. Exiting.');
    return;
  }

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    await login(page);

    // Navigate to dashboard to ensure session state
    await page.goto(`${config.url}/dashboard/providers/${config.provider}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

    const allConnections = await page.evaluate(async () => {
      try {
        const data = await fetch('/api/providers').then(res => res.json());
        return data.connections || [];
      } catch (_) {
        return [];
      }
    });

    const existingNames = new Set(allConnections
      .filter(connection => connection.provider === config.provider)
      .map(connection => connection.name));

    console.log(`Found ${existingNames.size} existing connection(s) under provider in OmniRoute.`);

    const results = [];

    for (const row of uniqueRows) {
      if (existingNames.has(row.name)) {
        console.log(`Skipping duplicate account: ${row.name}`);
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
        },
      };

      if (config.validationModel) {
        payload.providerSpecificData.validationModel = config.validationModel;
      }

      console.log(`Adding connection for ${row.name} to OmniRoute...`);
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
        console.log(`  ✅ Added successfully!`);

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
        console.error(`  ❌ Failed to save: status=${saved.status}, error=${errDetail}`);
      }
    }

    const summary = results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {});

    console.log('\n=======================================================');
    console.log('📊 IMPORT SUMMARY:');
    console.log(JSON.stringify({
      csvRows: rows.length,
      uniqueKeys: uniqueRows.length,
      summary,
      results,
    }, null, 2));
    console.log('=======================================================');

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
