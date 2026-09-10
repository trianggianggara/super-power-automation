#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseCsvLine } = require('../utils/email.js');

const csvPath = path.join(__dirname, '..', 'data', 'outlook_accounts.csv');
const backupPath = csvPath + '.bak';

function main() {
  console.log('=== Outlook Accounts Database Cleanup ===\n');

  if (!fs.existsSync(csvPath)) {
    console.error(`[ERROR] CSV file not found at: ${csvPath}`);
    process.exit(1);
  }

  // 1. Create a backup
  try {
    fs.copyFileSync(csvPath, backupPath);
    console.log(`[BACKUP] Created backup at: ${backupPath}`);
  } catch (err) {
    console.error(`[ERROR] Failed to create backup: ${err.message}`);
    process.exit(1);
  }

  // 2. Read and Parse the CSV
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    console.error('[ERROR] The CSV file is empty.');
    process.exit(1);
  }

  const headerRow = lines[0];
  const headers = parseCsvLine(headerRow).map(h => h.replace(/^"|"$/g, '').toLowerCase());

  console.log(`[INFO] CSV Headers found: ${headers.join(', ')}`);
  console.log(`[INFO] Total lines in CSV (excluding header): ${lines.length - 1}\n`);

  const cleanedRows = [];
  let lockedCount = 0;
  let blockedCount = 0;
  let invalidCount = 0;
  let deadCount = 0;
  let repairedCount = 0;
  let activeCount = 0;

  // Expected 10-column headers
  const outputHeaders = [
    'email', 'password', 'first_name', 'last_name', 'recovery_email',
    'totp_secret', 'refresh_token', 'status', 'refresh_token_status', 'created_at'
  ];

  cleanedRows.push(outputHeaders.map(h => `"${h}"`).join(','));

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    const parts = parseCsvLine(rawLine).map(p => p.replace(/^"|"$/g, ''));

    let email = '';
    let password = '';
    let firstName = '';
    let lastName = '';
    let recoveryEmail = '';
    let totpSecret = '';
    let refreshToken = '';
    let status = '';
    let refreshTokenStatus = '';
    let createdAt = '';

    // If the line has 8 columns, it was generated with the legacy format:
    // email, password, first_name, last_name, recovery_email, totp_secret, refresh_token, created_at
    if (parts.length === 8) {
      email = parts[0] || '';
      password = parts[1] || '';
      firstName = parts[2] || '';
      lastName = parts[3] || '';
      recoveryEmail = parts[4] || '';
      totpSecret = parts[5] || '';
      refreshToken = parts[6] || '';
      status = ''; // Empty status for fresh accounts
      refreshTokenStatus = '';
      createdAt = parts[7] || ''; // 8th element is the registration timestamp
      repairedCount++;
    } else {
      // Standard 10-column parser using header indices
      const emailIdx = headers.indexOf('email');
      const passIdx = headers.indexOf('password');
      const fnIdx = headers.indexOf('first_name');
      const lnIdx = headers.indexOf('last_name');
      const recovIdx = headers.indexOf('recovery_email');
      const totpIdx = headers.indexOf('totp_secret');
      const tokenIdx = headers.indexOf('refresh_token');
      const statusIdx = headers.indexOf('status');
      const rStatusIdx = headers.indexOf('refresh_token_status');
      const createdIdx = headers.indexOf('created_at');

      email = parts[emailIdx] || '';
      password = parts[passIdx] || '';
      firstName = parts[fnIdx] || '';
      lastName = parts[lnIdx] || '';
      recoveryEmail = parts[recovIdx] || '';
      totpSecret = parts[totpIdx] || '';
      refreshToken = parts[tokenIdx] || '';
      status = parts[statusIdx] || '';
      refreshTokenStatus = parts[rStatusIdx] || '';
      createdAt = parts[createdIdx] || '';

      // If status has a timestamp format (legacy bug), repair it
      if (status && (status.includes('Z') || status.includes('T')) && status.length > 15) {
        createdAt = status;
        status = '';
        repairedCount++;
      }
    }

    const statusUpper = status.toUpperCase().trim();
    const rStatusUpper = refreshTokenStatus.toUpperCase().trim();

    // Determine filter conditions
    if (statusUpper === 'LOCKED') {
      lockedCount++;
      continue;
    }
    if (statusUpper === 'BLOCKED') {
      blockedCount++;
      continue;
    }
    if (statusUpper === 'INVALID' || rStatusUpper === 'INVALID') {
      invalidCount++;
      continue;
    }
    if (statusUpper === 'DEAD') {
      deadCount++;
      continue;
    }

    // Keep this row
    activeCount++;
    const row = [
      email, password, firstName, lastName, recoveryEmail,
      totpSecret, refreshToken, status, refreshTokenStatus, createdAt
    ];
    cleanedRows.push(row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  }

  // 3. Write cleaned content back
  try {
    fs.writeFileSync(csvPath, cleanedRows.join('\n') + '\n', 'utf8');
    console.log(`[SUCCESS] Database cleaned successfully!\n`);
  } catch (err) {
    console.error(`[ERROR] Failed to write cleaned CSV: ${err.message}`);
    process.exit(1);
  }

  // 4. Print Summary
  const totalRemoved = lockedCount + blockedCount + invalidCount + deadCount;
  console.log('======================================');
  console.log('           CLEANUP SUMMARY            ');
  console.log('======================================');
  console.log(`  Initial Accounts : ${lines.length - 1}`);
  console.log(`  Repaired Format  : ${repairedCount}`);
  console.log(`  Removed Accounts : ${totalRemoved}`);
  console.log(`    - Locked       : ${lockedCount}`);
  console.log(`    - Blocked      : ${blockedCount}`);
  console.log(`    - Invalid      : ${invalidCount}`);
  console.log(`    - Dead         : ${deadCount}`);
  console.log(`  Saved Accounts   : ${activeCount}`);
  console.log('======================================');
}

main();
