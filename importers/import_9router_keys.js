const fs = require('fs');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const DEFAULT_PROVIDER_ID = '';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const config = {
  csv: args.get('csv') || process.env.NINE_ROUTER_KEYS_CSV || 'xiaomi.csv',
  url: args.get('url') || process.env.NINE_ROUTER_URL || 'http://localhost:20131',
  password: args.get('password') || process.env.NINE_ROUTER_PASSWORD || '123456',
  provider: args.get('provider') || process.env.NINE_ROUTER_PROVIDER_ID || DEFAULT_PROVIDER_ID,
  providerName: args.get('provider-name') || process.env.NINE_ROUTER_PROVIDER_NAME || 'mimo-free',
  baseUrl: args.get('base-url') || process.env.NINE_ROUTER_PROVIDER_BASE_URL || 'https://api.xiaomimimo.com/v1',
  prefix: args.get('prefix') || process.env.NINE_ROUTER_PROVIDER_PREFIX || 'mimo',
  validationModel: args.get('validation-model') || process.env.NINE_ROUTER_VALIDATION_MODEL || '',
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
  await page.goto(`${config.url}/dashboard/providers/${config.provider}`, { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('/login')) return;

  await page.getByRole('textbox', { name: /password|enter your password/i }).fill(config.password);
  await page.getByRole('button', { name: /continue|login/i }).click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.goto(`${config.url}/dashboard/providers/${config.provider}`, { waitUntil: 'domcontentloaded' });
}

async function loadProviderState(page) {
  return page.evaluate(async () => {
    const [providersRes, nodesRes] = await Promise.all([
      fetch('/api/providers'),
      fetch('/api/provider-nodes'),
    ]);
    if (!providersRes.ok) throw new Error(`Failed to fetch providers: ${providersRes.status}`);
    if (!nodesRes.ok) throw new Error(`Failed to fetch provider nodes: ${nodesRes.status}`);
    const providers = await providersRes.json();
    const nodes = await nodesRes.json();
    return {
      connections: providers.connections || [],
      nodes: nodes.nodes || [],
    };
  });
}

async function saveBulk(page, payload) {
  return page.evaluate(async payload => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('/api/providers/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      const body = JSON.parse(text || '{}');
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }, payload);
}

async function saveOne(page, payload) {
  return page.evaluate(async payload => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : {} };
    } finally {
      clearTimeout(timeout);
    }
  }, payload);
}

function resolveProviderId(nodes) {
  const byId = nodes.find(node => node.id === config.provider);
  if (byId) return byId.id;

  const byDetails = nodes.find(node =>
    node.name === config.providerName &&
    node.baseUrl === config.baseUrl &&
    (!config.prefix || node.prefix === config.prefix)
  );
  if (byDetails) return byDetails.id;

  throw new Error(`Provider node not found: ${config.providerName} ${config.baseUrl}`);
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

    const state = await loadProviderState(page);
    const baseProvider = resolveProviderId(state.nodes);
    const existingNames = new Set(state.connections.map(connection => connection.name));
    const results = [];
    const entries = [];

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

      entries.push({ name: row.name, apiKey: row.apiKey });
    }

    let usedSingleFallback = false;
    for (let index = 0; index < entries.length; index += 100) {
      const batch = entries.slice(index, index + 100);
      const saved = await saveBulk(page, {
        provider: baseProvider,
        entries: batch,
        priority: 1,
        validateKeys: false,
      });

      if (saved.status === 404 || saved.status === 405) {
        usedSingleFallback = true;
        break;
      }

      if (!saved.ok) {
        for (const entry of batch) results.push({ name: entry.name, status: 'failed_save', detail: saved.status, body: saved.body });
        continue;
      }

      const errors = new Map((saved.body.errors || []).map(error => [error.name, error]));
      for (const entry of batch) {
        const error = errors.get(entry.name);
        if (error) results.push({ name: entry.name, status: 'failed_save', detail: error.message });
        else results.push({ name: entry.name, status: 'added' });
      }
    }

    if (usedSingleFallback) {
      const existingPriorities = state.connections
        .filter(connection => connection.provider === baseProvider)
        .map(connection => Number(connection.priority) || 0);
      let priority = Math.max(0, ...existingPriorities) + 1;

      for (const entry of entries) {
        const saved = await saveOne(page, {
          provider: baseProvider,
          apiKey: entry.apiKey,
          name: entry.name,
          priority: priority++,
          testStatus: 'unknown',
        });

        if (saved.ok) results.push({ name: entry.name, status: 'added' });
        else results.push({ name: entry.name, status: 'failed_save', detail: saved.status, body: saved.body });
      }
    }

    const summary = results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {});

    console.log(JSON.stringify({
      csvRows: rows.length,
      uniqueKeys: uniqueRows.length,
      provider: baseProvider,
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
