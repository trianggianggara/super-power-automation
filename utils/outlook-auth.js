// utils/outlook-auth.js — Generate Microsoft refresh token via Device Code flow (no app registration needed)
//
// Usage: node utils/outlook-auth.js
//
// Flow:
//   1. Prints device code + URL
//   2. Buka https://microsoft.com/devicelogin di browser
//   3. Masukin kode yang ditampilkan
//   4. Login pake akun Outlook
//   5. Token otomatis kedetect & disave ke .env

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadEnv } = require('./env.js');

loadEnv();

function postForm(hostname, path_, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: path_,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

async function main() {
  const clientId = process.env.OUTLOOK_CLIENT_ID || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';

  console.log('=== Outlook OAuth Device Code Flow ===\n');
  console.log(`Client ID: ${clientId}`);
  console.log('');

  // Step 1: Request device code
  console.log('Requesting device code...');
  const scope = 'https://graph.microsoft.com/Mail.Read offline_access';
  
  const deviceRes = await postForm(
    'login.microsoftonline.com',
    '/consumers/oauth2/v2.0/devicecode',
    `client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scope)}`
  );

  if (deviceRes.status !== 200) {
    console.error('Device code request failed:', JSON.stringify(deviceRes.body));
    console.error('\nClient ID mungkin ga support device code flow.');
    console.error('Coba daftar app dulu di https://portal.azure.com/');
    process.exit(1);
  }

  const dc = deviceRes.body;
  console.log(`\n==================================`);
  console.log(`  BUKA: ${dc.verification_uri || 'https://microsoft.com/devicelogin'}`);
  console.log(`  KODE: ${dc.user_code}`);
  console.log(`==================================\n`);
  console.log('Login pake akun Outlook lo, masukin kode di atas.');
  console.log('Nunggu... (expire dalam 15 menit)\n');

  // Step 2: Poll for token
  const start = Date.now();
  const interval = (dc.interval || 5) * 1000;
  const expiresIn = (dc.expires_in || 900) * 1000;

  while (Date.now() - start < expiresIn) {
    await new Promise(r => setTimeout(r, interval));

    const tokenRes = await postForm(
      'login.microsoftonline.com',
      '/consumers/oauth2/v2.0/token',
      `client_id=${encodeURIComponent(clientId)}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${encodeURIComponent(dc.device_code)}`
    );

    if (tokenRes.status === 200) {
      console.log('✅ Token dapet!\n');
      console.log(`Access Token: ${tokenRes.body.access_token.substring(0, 30)}...`);
      console.log(`Refresh Token: ${tokenRes.body.refresh_token.substring(0, 30)}...`);
      console.log(`Expires In: ${tokenRes.body.expires_in}s`);

      const { saveOutlookRefreshToken } = require('./email.js');

      // Fetch user profile to know which email this belongs to
      let accountEmail = '';
      try {
        const profileRes = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'graph.microsoft.com',
            path: '/v1.0/me',
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${tokenRes.body.access_token}`,
              'User-Agent': 'Mozilla/5.0'
            }
          }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { resolve({}); }
            });
          });
          req.on('error', reject);
          req.end();
        });
        accountEmail = profileRes.userPrincipalName || profileRes.mail || '';
      } catch (_) {}

      if (accountEmail) {
        saveOutlookRefreshToken(accountEmail, tokenRes.body.refresh_token);
        console.log(`\n✅ Saved refresh token for ${accountEmail} to data/outlook_accounts.csv`);
      } else {
        console.log(`\n⚠️  Could not detect email automatically. Refresh token:`);
        console.log(tokenRes.body.refresh_token);
      }

      console.log('\nDone!');
      process.exit(0);
    }

    if (tokenRes.body.error === 'authorization_pending') {
      // Still waiting for user
      process.stdout.write('.');
      continue;
    }

    if (tokenRes.body.error === 'authorization_declined') {
      console.error('\n❌ User nolak authorization.');
      process.exit(1);
    }

    if (tokenRes.body.error === 'expired_token') {
      console.error('\n❌ Kode expired. Jalanin ulang.');
      process.exit(1);
    }

    console.error(`\nError: ${tokenRes.body.error} - ${tokenRes.body.error_description}`);
    process.exit(1);
  }

  console.error('\n❌ Timeout.');
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
