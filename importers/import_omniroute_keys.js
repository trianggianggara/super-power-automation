const fs = require('fs');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const DEFAULT_PROVIDER_ID = 'openai-compatible-chat-3ab61b5f-89e2-4749-ac20-e936b69f223f';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_KEYS_CSV || 'xiaomi.csv',
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://localhost:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  provider: args.get('provider') || process.env.OMNIROUTE_PROVIDER_ID || DEFAULT_PROVIDER_ID,
  providerName: args.get('provider-name') || process.env.OMNIROUTE_PROVIDER_NAME || 'mimo-free',
  baseUrl: args.get('base-url') || process.env.OMNIROUTE_PROVIDER_BASE_URL || 'https://api.xiaomimimo.com/v1',
  prefix: args.get('prefix') || process.env.OMNIROUTE_PROVIDER_PREFIX || 'mimo',
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
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value])))
    .map(row => ({ name: row.api_key_name || row.email, apiKey: row.api_key }))
    .filter(row => row.name && row.apiKey);
}

async function validateKey(apiKey) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/models`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  return { ok: false, status: res.status, error: text.slice(0, 160) };
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

async function main() {
  const rows = readKeys(config.csv);
  const seenKeys = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (seenKeys.has(row.apiKey)) continue;
    seenKeys.add(row.apiKey);
    uniqueRows.push(row);
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

      if (config.validate) {
        const validation = await validateKey(row.apiKey);
        if (!validation.ok) {
          results.push({ name: row.name, status: 'skipped_validation_failed', detail: validation.status });
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
      } else {
        results.push({ name: row.name, status: 'failed_save', detail: saved.status, body: saved.body });
      }
    }

    const summary = results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {});

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
  console.error(error.message);
  process.exit(1);
});
