#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.resolve(__dirname, '..', 'data', 'github_accounts.csv');

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

function writeCsvLine(values) {
  return values.map(val => {
    const escaped = String(val).replace(/"/g, '""');
    return `"${escaped}"`;
  }).join(',');
}

async function checkProfileWithRetry(username, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://github.com/${username}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (res.status === 429) {
        console.log(`  ⚠️ Rate limited (429) checking ${username}. Waiting 5 seconds to retry... (Attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      return res.status;
    } catch (err) {
      if (attempt === retries) {
        return `ERROR: ${err.message}`;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return 'TIMEOUT/429';
}

async function main() {
  console.log('=== Checking GitHub Accounts & Updating CSV ===');
  console.log(`CSV Path: ${CSV_PATH}`);
  
  if (!fs.existsSync(CSV_PATH)) {
    console.error('CSV file not found!');
    process.exit(1);
  }

  const fileContent = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = fileContent.split(/\r?\n/);
  
  if (lines.length === 0 || !lines[0].trim()) {
    console.error('CSV is empty!');
    process.exit(1);
  }

  const header = parseCsvLine(lines[0]);
  let statusColIndex = header.indexOf('github_status');
  if (statusColIndex === -1) {
    header.push('github_status');
    statusColIndex = header.length - 1;
  }

  const usernameColIndex = header.indexOf('username');
  if (usernameColIndex === -1) {
    console.error('Username column not found in CSV header!');
    process.exit(1);
  }

  const outputLines = [writeCsvLine(header)];
  const total = lines.length - 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      outputLines.push('');
      continue;
    }

    const row = parseCsvLine(line);
    // Pad row fields to match header (excluding status field)
    while (row.length < header.length - 1) {
      row.push('');
    }

    const username = row[usernameColIndex];
    if (!username) {
      row[statusColIndex] = '';
      outputLines.push(writeCsvLine(row));
      continue;
    }

    console.log(`[${i}/${total}] Checking username: ${username}`);
    const statusCode = await checkProfileWithRetry(username);
    
    let statusText = 'unknown';
    if (statusCode === 200) {
      statusText = 'active';
    } else if (statusCode === 404) {
      statusText = 'banned';
    } else {
      statusText = `error (${statusCode})`;
    }
    
    console.log(`  -> Status: ${statusText.toUpperCase()}`);
    row[statusColIndex] = statusText;
    outputLines.push(writeCsvLine(row));

    // Wait 500ms between calls to avoid spamming GitHub
    await new Promise(r => setTimeout(r, 500));
  }

  // Join lines back to CSV content
  const newContent = outputLines.join('\n');
  fs.writeFileSync(CSV_PATH, newContent, 'utf8');
  console.log('\nCSV file updated successfully with "github_status" column!');
}

main().catch(console.error);
