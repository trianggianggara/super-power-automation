#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadEnv } = require('../utils/env.js');
const { loadOutlookAccounts, saveOutlookAccountData } = require('../utils/email.js');

loadEnv();

const CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || 'a48e86c0-e508-4b09-9d69-f735792ed3e3';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function postForm(hostname, path_, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: path_,
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0'
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Validate refresh token by exchanging it for a new access token
 * Returns { success: boolean, error?: string }
 */
async function validateRefreshToken(refreshToken) {
  try {
    const body = `client_id=${encodeURIComponent(CLIENT_ID)}&grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
    const res = await postForm('login.microsoftonline.com', '/consumers/oauth2/v2.0/token', body);
    
    if (res.status === 200 && res.body.access_token) {
      return { success: true };
    }
    
    const errorDescription = res.body && res.body.error_description ? res.body.error_description : JSON.stringify(res.body);
    return { success: false, error: errorDescription };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function main() {
  console.log('=== Checking Outlook Accounts Status via Refresh Token ===\n');
  
  const accounts = loadOutlookAccounts();
  const accountsWithToken = accounts.filter(acc => acc.refreshToken);
  
  if (accountsWithToken.length === 0) {
    console.log('[INFO] No accounts with refresh tokens found in data/outlook_accounts.csv.');
    process.exit(0);
  }
  
  console.log(`[INFO] Found ${accounts.length} total accounts, ${accountsWithToken.length} have refresh tokens to verify.`);
  console.log(`[INFO] Starting verification...\n`);
  
  let activeCount = 0;
  let blockedCount = 0;
  
  for (let i = 0; i < accountsWithToken.length; i++) {
    const acc = accountsWithToken[i];
    const indexStr = `[${i + 1}/${accountsWithToken.length}]`;
    
    // Add a small delay between requests to avoid triggering Microsoft rate limits
    if (i > 0) {
      await sleep(1200);
    }
    
    process.stdout.write(`${indexStr} Verifying ${acc.email}... `);
    
    const check = await validateRefreshToken(acc.refreshToken);
    
    if (check.success) {
      activeCount++;
      console.log('✅ ACTIVE');
      saveOutlookAccountData(acc.email, { status: 'active', refreshTokenStatus: 'valid' });
    } else {
      blockedCount++;
      const isBlockedOrSuspended = check.error.includes('AADSTS50053') || 
                                   check.error.includes('AADSTS70000') ||
                                   check.error.includes('abuse') ||
                                   check.error.includes('invalid_grant') ||
                                   check.error.includes('blocked') || 
                                   check.error.includes('suspended') || 
                                   check.error.includes('AADSTS50057') || 
                                   check.error.includes('disabled');
      const displayStatus = isBlockedOrSuspended ? 'blocked' : 'invalid';
      console.log(`❌ INACTIVE (${displayStatus}: ${check.error.substring(0, 60)}...)`);
      saveOutlookAccountData(acc.email, { status: displayStatus, refreshTokenStatus: 'invalid' });
    }
  }
  
  console.log('\n======================================');
  console.log('               SUMMARY                ');
  console.log('======================================');
  console.log(`  Total Verified : ${accountsWithToken.length}`);
  console.log(`  ✅ Active      : ${activeCount}`);
  console.log(`  ❌ Inactive    : ${blockedCount}`);
  console.log('======================================\n');

  // Archive blocked/inactive accounts to data/outlook_accounts_blocked.csv.bak
  try {
    const outlookCsv = process.env.OUTLOOK_ACCOUNTS_CSV || path.join(__dirname, '..', 'data', 'outlook_accounts.csv');
    const blockedCsvBak = path.join(__dirname, '..', 'data', 'outlook_accounts_blocked.csv.bak');
    const allAccountsRaw = fs.readFileSync(outlookCsv, 'utf8').split('\n').filter(Boolean);

    if (allAccountsRaw.length > 1) {
      const header = allAccountsRaw[0];
      const activeRows = [header];
      const blockedRows = fs.existsSync(blockedCsvBak) ? fs.readFileSync(blockedCsvBak, 'utf8').split('\n').filter(Boolean) : [header];

      for (let i = 1; i < allAccountsRaw.length; i++) {
        const line = allAccountsRaw[i];
        const lower = line.toLowerCase();
        if (lower.includes('"blocked"') || lower.includes('"invalid"') || lower.includes('"locked"')) {
          if (!blockedRows.includes(line)) {
            blockedRows.push(line);
          }
        } else {
          activeRows.push(line);
        }
      }

      // Write active to outlook_accounts.csv
      fs.writeFileSync(outlookCsv, activeRows.join('\n') + '\n', 'utf8');
      // Write blocked to outlook_accounts_blocked.csv.bak
      fs.writeFileSync(blockedCsvBak, blockedRows.join('\n') + '\n', 'utf8');

      console.log(`📦 [ARCHIVE] Berhasil memindahkan ${blockedCount} akun blocked/invalid ke:`);
      console.log(`   👉 data/outlook_accounts_blocked.csv.bak`);
      console.log(`✨ [CLEAN] File data/outlook_accounts.csv kini hanya berisi ${activeRows.length - 1} akun AKTIF.`);
    }
  } catch (err) {
    console.warn(`  [WARN] Failed to archive blocked accounts: ${err.message}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
