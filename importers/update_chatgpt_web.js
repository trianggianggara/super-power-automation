const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadEnv } = require('../utils/env.js');

loadEnv();

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const defaultCsv = fs.existsSync(path.join(__dirname, '..', 'data', 'chatgpt.csv'))
  ? path.join(__dirname, '..', 'data', 'chatgpt.csv')
  : 'chatgpt.csv';

const config = {
  csv: args.get('csv') || process.env.OMNIROUTE_CHATGPT_CSV || defaultCsv,
  url: args.get('url') || process.env.OMNIROUTE_URL || 'http://100.103.220.104:20128',
  password: args.get('password') || process.env.OMNIROUTE_PASSWORD || '123456',
  provider: args.get('provider') || 'chatgpt-web',
  headless: args.get('headed') !== 'true',
  dryRun: args.get('dry-run') === 'true' || args.get('dryrun') === 'true',
  dedup: args.get('dedup') === 'true',
  verbose: args.get('verbose') === 'true',
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

function parseCsvFull(content) {
  const rows = [];
  let currentRow = [];
  let currentVal = '';
  let insideQuote = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        currentVal += '"';
        i++;
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === ',' && !insideQuote) {
      currentRow.push(currentVal);
      currentVal = '';
    } else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentVal);
      currentVal = '';
      if (currentRow.some(c => c.trim().length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else {
      currentVal += char;
    }
  }

  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal);
    if (currentRow.some(c => c.trim().length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function readCookies(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    return [];
  }
  const content = fs.readFileSync(csvPath, 'utf8').trim();
  const allRows = parseCsvFull(content);
  if (allRows.length <= 1) return [];

  const header = allRows[0].map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  const cookiesIdx = header.indexOf('cookies');
  const passwordIdx = header.indexOf('password');
  const statusIdx = header.indexOf('status');

  if (emailIdx === -1 || cookiesIdx === -1) {
    console.error(`CSV header missing email or cookies column. Found: ${header.join(', ')}`);
    return [];
  }

  const result = [];
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    const email = (row[emailIdx] || '').trim();
    const cookies = (row[cookiesIdx] || '').trim();
    const password = passwordIdx !== -1 ? (row[passwordIdx] || '').trim() : '';
    const status = statusIdx !== -1 ? (row[statusIdx] || '').trim().toLowerCase() : '';

    if (status === 'deactivated') {
      console.log(`  [SKIP] Skipping deactivated account: ${email}`);
      continue;
    }

    if (email && cookies) {
      result.push({
        name: email,
        email: email,
        password: password,
        credential: cookies,
      });
    }
  }
  return result;
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
  console.log('=== ChatGPT-Web Connection Updater (OmniRoute) ===');
  console.log('Mode: UPDATE ONLY (No new connections will be created)');
  if (config.dryRun) console.log('Notice: --dry-run active, no changes will be written to OmniRoute.');
  console.log(`Reading cookies from: ${config.csv}`);

  const rows = readCookies(config.csv);
  console.log(`Found ${rows.length} account row(s) with cookies in CSV.`);
  if (rows.length === 0) {
    console.log('No rows to process. Exiting.');
    return;
  }

  // Deduplicate CSV rows by email (keep latest entry)
  const rowsByEmail = new Map();
  for (const row of rows) {
    rowsByEmail.set(row.email.toLowerCase(), row);
  }
  const uniqueRows = Array.from(rowsByEmail.values());
  console.log(`Unique email count in CSV: ${uniqueRows.length}`);

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    await login(page);

    console.log(`Fetching existing connections from OmniRoute (/api/providers)...`);
    const allConnections = await page.evaluate(async () => {
      const data = await fetch('/api/providers').then(res => res.json());
      return data.connections || [];
    });

    const targetConnections = allConnections.filter(c => c.provider === config.provider);
    console.log(`Found ${targetConnections.length} existing connection(s) for provider '${config.provider}'.`);

    // Group OmniRoute connections by lowercase name (email)
    const connMap = new Map();
    for (const c of targetConnections) {
      const key = (c.name || '').trim().toLowerCase();
      if (!connMap.has(key)) connMap.set(key, []);
      connMap.get(key).push(c);
    }

    const results = [];
    let updatedCount = 0;
    let skippedNotFoundCount = 0;
    let failedCount = 0;
    let duplicatesCleanedCount = 0;

    for (const row of uniqueRows) {
      const emailKey = row.email.toLowerCase();
      const matchingConns = connMap.get(emailKey) || [];

      if (matchingConns.length === 0) {
        if (config.verbose) console.log(`  [SKIP] Not found in OmniRoute: ${row.email}`);
        results.push({ email: row.email, status: 'skipped_not_found' });
        skippedNotFoundCount++;
        continue;
      }

      // Primary connection to update
      const primaryConn = matchingConns[0];
      const duplicates = matchingConns.slice(1);

      if (duplicates.length > 0) {
        console.log(`  [WARN] Found ${duplicates.length} duplicate connection(s) for ${row.email}`);
        if (config.dedup && !config.dryRun) {
          for (const dup of duplicates) {
            const delRes = await page.evaluate(async (id) => {
              const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
              return res.ok;
            }, dup.id);
            if (delRes) {
              console.log(`    [DEDUP] Deleted duplicate ID: ${dup.id}`);
              duplicatesCleanedCount++;
            }
          }
        }
      }

      if (config.dryRun) {
        console.log(`  [DRY RUN] Would update connection ID ${primaryConn.id} for ${row.email}`);
        results.push({ email: row.email, id: primaryConn.id, status: 'dry_run_matched' });
        updatedCount++;
        continue;
      }

      // Send PUT request to update credentials on existing connection
      const updatePayload = {
        apiKey: row.credential,
        testStatus: 'active',
        isActive: true,
      };

      const updateRes = await page.evaluate(async ({ id, payload }) => {
        try {
          const res = await fetch(`/api/providers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const text = await res.text();
          let body = {};
          try { body = JSON.parse(text); } catch (_) {}
          return { ok: res.ok, status: res.status, body };
        } catch (e) {
          return { ok: false, status: 0, body: { error: e.message } };
        }
      }, { id: primaryConn.id, payload: updatePayload });

      if (updateRes.ok) {
        console.log(`  [✓ UPDATED] ${row.email} (ID: ${primaryConn.id})`);
        results.push({ email: row.email, id: primaryConn.id, status: 'updated' });
        updatedCount++;
      } else {
        const err = updateRes.body?.error || updateRes.body?.message || JSON.stringify(updateRes.body).slice(0, 150);
        console.error(`  [✗ FAILED] ${row.email} (ID: ${primaryConn.id}) — HTTP ${updateRes.status}: ${err}`);
        results.push({ email: row.email, id: primaryConn.id, status: 'failed_update', error: `HTTP ${updateRes.status}` });
        failedCount++;
      }
    }

    console.log('\n=== UPDATE SUMMARY ===');
    console.log(`Total CSV Accounts:         ${uniqueRows.length}`);
    console.log(`Existing OmniRoute Conns:   ${targetConnections.length}`);
    console.log(`Successfully Updated:       ${updatedCount}`);
    console.log(`Skipped (Not Found):        ${skippedNotFoundCount}`);
    console.log(`Failed Updates:             ${failedCount}`);
    if (config.dedup) {
      console.log(`Duplicates Cleaned:         ${duplicatesCleanedCount}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error in updater:', error);
  process.exit(1);
});
