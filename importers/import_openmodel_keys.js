const fs = require('fs');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const DEFAULT_PROVIDER_ID = 'anthropic-compatible-9f020958-7450-4447-9521-674b4d294a4e';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_OPENMODEL_CSV || 'openmodel.csv',
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://localhost:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  provider: args.get('provider') || process.env.OMNIROUTE_OPENMODEL_PROVIDER_ID || DEFAULT_PROVIDER_ID,
  providerName: args.get('provider-name') || process.env.OMNIROUTE_OPENMODEL_PROVIDER_NAME || 'openmodel',
  baseUrl: args.get('base-url') || process.env.OMNIROUTE_OPENMODEL_BASE_URL || 'https://api.openmodel.ai',
  prefix: args.get('prefix') || process.env.OMNIROUTE_OPENMODEL_PREFIX || 'openmodel',
  validationModel: args.get('validation-model') || process.env.OMNIROUTE_OPENMODEL_VALIDATION_MODEL || 'claude-3-5-sonnet',
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
    .map(row => ({ name: row.email || row.username, apiKey: row.api_key }))
    .filter(row => row.name && row.apiKey && row.apiKey !== 'MANUAL_REQUIRED');
}

async function validateKey(apiKey) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.validationModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: 'Unauthorized/Forbidden' };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`  Validation request failed: ${err.message}. Assuming valid.`);
    return { ok: true };
  }
}

async function login(page) {
  console.log(`Navigating to: ${config.url}/dashboard/providers/${config.provider}`);
  try {
    await page.goto(`${config.url}/dashboard/providers/${config.provider}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    console.log(`  Navigation status: ${err.message}`);
  }
  
  const currentUrl = page.url();
  console.log(`  Current URL: ${currentUrl}`);
  if (!currentUrl.includes('/login')) {
    console.log('  Already logged in or on dashboard.');
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

  console.log('  Waiting for login redirect...');
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  
  try {
    await page.goto(`${config.url}/dashboard/providers/${config.provider}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    console.log(`  Redirect navigation info: ${err.message}`);
  }
}

function isDuplicateKey(newKey, existingKey) {
  if (!existingKey) return false;
  if (newKey === existingKey) return true;
  
  const cleanNew = newKey.replace(/^(sk|om)-/, '');
  const cleanExisting = existingKey.replace(/^(sk|om)-/, '');
  
  if (cleanExisting.includes('...') || cleanExisting.includes('*')) {
    const parts = cleanExisting.split(/[\*\.]+/).filter(Boolean);
    if (parts.length >= 2) {
      return cleanNew.startsWith(parts[0]) && cleanNew.endsWith(parts[parts.length - 1]);
    }
  }
  return false;
}

async function main() {
  console.log(`Reading OpenModel keys from: ${config.csv}`);
  const rows = readKeys(config.csv);
  console.log(`Found ${rows.length} total entries.`);
  
  const seenKeys = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (seenKeys.has(row.apiKey)) continue;
    seenKeys.add(row.apiKey);
    uniqueRows.push(row);
  }
  console.log(`Found ${uniqueRows.length} unique API keys.`);

  if (uniqueRows.length === 0) {
    console.log('No keys to import.');
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

    const matchedConnection = allConnections.find(connection =>
      connection.providerSpecificData?.nodeName === config.providerName &&
      connection.providerSpecificData?.baseUrl === config.baseUrl
    );
    const provider = matchedConnection?.provider || config.provider;
    const existing = allConnections.filter(connection => connection.provider === provider);

    const existingNames = new Set(existing.map(connection => connection.name));
    const results = [];

    for (const row of uniqueRows) {
      if (existingNames.has(row.name)) {
        results.push({ name: row.name, status: 'skipped_duplicate_name' });
        continue;
      }

      const isDuplicate = existing.some(connection => {
        const existingKey = connection.apiKey || connection.providerSpecificData?.apiKey;
        return isDuplicateKey(row.apiKey, existingKey);
      });
      if (isDuplicate) {
        results.push({ name: row.name, status: 'skipped_duplicate_key' });
        continue;
      }

      if (config.validate) {
        console.log(`Validating key for ${row.name}...`);
        const validation = await validateKey(row.apiKey);
        if (!validation.ok) {
          results.push({ name: row.name, status: 'skipped_validation_failed', detail: validation.status || validation.error });
          continue;
        }
      }

      const payload = {
        provider,
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

      if (config.validationModel) payload.providerSpecificData.validationModel = config.validationModel;

      const saved = await page.evaluate(async payload => {
        const res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
      }, payload);

      if (saved.ok) {
        existingNames.add(row.name);
        results.push({ name: row.name, status: 'added' });
        console.log(`Successfully added key for ${row.name}`);
      } else {
        results.push({ name: row.name, status: 'failed_save', detail: saved.status, body: saved.body });
        console.error(`Failed to add key for ${row.name}: status=${saved.status}`);
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
