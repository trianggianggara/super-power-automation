#!/usr/bin/env node

/**
 * check_proxies.js — Tool untuk memeriksa semua proxy di http_proxies.txt
 * dan otomatis menandai/mengomentari proxy yang mati / tidak bisa dihubungi.
 *
 * Penggunaan:
 *   node tools/check_proxies.js
 *   npm run proxy:check
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const tls = require('tls');
const zlib = require('zlib');

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
const {
  PROXY_FILE_PATH,
  loadProxyList,
  markProxyDead,
  maskProxy,
  extractHostPort,
  getProxyCountry,
  proxyFromUrl,
  isProxyError,
  extractReason,
} = require('../utils/proxy.js');

const CHECK_TIMEOUT_MS = Number(process.env.PROXY_CHECK_TIMEOUT_MS || 10000);
const MAX_LATENCY_MS = Number(process.env.PROXY_MAX_LATENCY_MS || 8000);
const CONCURRENCY = Number(process.env.PROXY_CHECK_CONCURRENCY || 20);

const TARGET_OUTLOOK = 'https://signup.live.com/signup?lic=1';
const TARGET_GITHUB = 'https://github.com/signup';
const TARGET_CHATGPT = 'https://chatgpt.com/';
const TARGET_BASETEN = 'https://login.baseten.co/sign-up';

const args = process.argv.slice(2);
let targetMode = 'all'; // Default: All targets for check_proxies
if (args.includes('--basten') || args.includes('--baseten')) targetMode = 'basten';
else if (args.includes('--chatgpt')) targetMode = 'chatgpt';
else if (args.includes('--github')) targetMode = 'github';
else if (args.includes('--outlook')) targetMode = 'outlook';
else if (args.includes('--all')) targetMode = 'all';

const targetLabel = targetMode === 'all'
  ? 'Outlook + GitHub + ChatGPT'
  : (targetMode === 'basten' ? 'Baseten + GitHub' : (targetMode === 'github' ? 'GitHub' : (targetMode === 'chatgpt' ? 'ChatGPT' : 'Outlook')));

function testSingleUrl(proxyUrl, targetUrl, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const raw = proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`;
    const startTime = Date.now();
    let isResolved = false;
    let connectReq = null;
    let tlsSocket = null;
    let hardTimer = null;

    const finish = (resObj) => {
      if (isResolved) return;
      isResolved = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (tlsSocket) try { tlsSocket.destroy(); } catch (_) {}
      if (connectReq) try { connectReq.destroy(); } catch (_) {}
      resolve(resObj);
    };

    hardTimer = setTimeout(() => {
      finish({ ok: false, proxy: proxyUrl, latency: Date.now() - startTime, reason: 'HARD_DEADLINE_EXCEEDED' });
    }, Math.round(timeoutMs * 1.5));

    try {
      const pObj = proxyFromUrl(raw);
      const urlObj = new URL(targetUrl);
      const targetHost = urlObj.hostname;
      const targetPath = urlObj.pathname + urlObj.search;

      let proxyHost = '';
      let proxyPort = 80;
      if (pObj && pObj.server) {
        const pUrl = new URL(pObj.server.includes('://') ? pObj.server : `http://${pObj.server}`);
        proxyHost = pUrl.hostname;
        proxyPort = parseInt(pUrl.port || '80', 10);
      } else {
        const pUrl = new URL(raw);
        proxyHost = pUrl.hostname;
        proxyPort = parseInt(pUrl.port || '80', 10);
      }

      const reqHeaders = {
        'Host': `${targetHost}:443`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      };
      if (pObj && pObj.username && pObj.password) {
        reqHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${pObj.username}:${pObj.password}`).toString('base64');
      }

      // 1. Strict CONNECT Request
      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:443`,
        headers: reqHeaders,
        timeout: timeoutMs
      });

      connectReq.on('connect', (res, socket, head) => {
        // STRICT REQUIREMENT: CONNECT must return 200 (not 301, 302, 308, 400, 403, 502)
        if (res.statusCode !== 200) {
          socket.destroy();
          const latency = Date.now() - startTime;
          return finish({ ok: false, proxy: proxyUrl, latency, reason: `CONNECT_FAILED_${res.statusCode}` });
        }

        // 2. Strict TLS Handshake over established tunnel
        const tlsSocket = tls.connect({
          socket,
          servername: targetHost,
          rejectUnauthorized: true,
          timeout: timeoutMs
        }, () => {
          // 3. Send HTTP GET over encrypted tunnel
          const getReq = `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\nAccept-Encoding: gzip, deflate, br\r\nConnection: close\r\n\r\n`;
          tlsSocket.write(getReq);
        });

        let rawChunks = [];
        tlsSocket.on('data', (chunk) => {
          rawChunks.push(chunk);
        });

        tlsSocket.on('end', () => {
          const latency = Date.now() - startTime;
          const rawBuffer = Buffer.concat(rawChunks);
          const headerEnd = rawBuffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            return finish({ ok: false, proxy: proxyUrl, latency, reason: 'INVALID_HTTP_RESPONSE' });
          }

          const headerStr = rawBuffer.slice(0, headerEnd).toString('utf8');
          const firstLine = headerStr.split('\r\n')[0] || '';
          const statusMatch = firstLine.match(/HTTP\/\d\.\d\s+(\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
          const bodyBuffer = rawBuffer.slice(headerEnd + 4);

          let decompressedBody = '';
          try {
            if (headerStr.toLowerCase().includes('content-encoding: gzip')) {
              decompressedBody = zlib.gunzipSync(bodyBuffer).toString('utf8');
            } else if (headerStr.toLowerCase().includes('content-encoding: br')) {
              decompressedBody = zlib.brotliDecompressSync(bodyBuffer).toString('utf8');
            } else if (headerStr.toLowerCase().includes('content-encoding: deflate')) {
              decompressedBody = zlib.inflateSync(bodyBuffer).toString('utf8');
            } else {
              decompressedBody = bodyBuffer.toString('utf8');
            }
          } catch (_) {
            decompressedBody = bodyBuffer.toString('utf8');
          }

          // 1. Check for common proxy error pages & transparent proxy banners
          const lowerBody = decompressedBody.toLowerCase();
          const lowerHeader = headerStr.toLowerCase();

          const hasProxyError = lowerBody.includes('squid') ||
            lowerBody.includes('tinyproxy') ||
            lowerBody.includes('mikrotik') ||
            lowerBody.includes('routeros') ||
            lowerBody.includes('proxy error') ||
            lowerBody.includes('gateway timeout') ||
            lowerBody.includes('bad gateway') ||
            lowerBody.includes('connection refused') ||
            lowerBody.includes('host unreachable') ||
            lowerBody.includes('unreachable') ||
            lowerBody.includes('network is unreachable') ||
            lowerBody.includes('cannot connect') ||
            lowerBody.includes('connection has timed out') ||
            lowerBody.includes('problem loading page') ||
            lowerBody.includes('remote_addr =') ||
            lowerBody.includes('request_method =') ||
            lowerBody.includes('http_user_agent =') ||
            lowerBody.includes('http_host =') ||
            lowerBody.includes('request_time_float');

          if (hasProxyError) {
            return finish({ ok: false, proxy: proxyUrl, latency, reason: 'PROXY_INTERNAL_ERROR_OR_ECHO_PAGE' });
          }

          // 2. Strict Target-Specific Authenticity Verification
          if (targetHost.includes('live.com')) {
            const isOutlookContent = (
              lowerBody.includes('microsoft corporation') ||
              lowerBody.includes('logincdn.msauth.net') ||
              lowerBody.includes('signup.live.com') ||
              lowerBody.includes('servername:') ||
              lowerHeader.includes('x-ms-request-id') ||
              lowerHeader.includes('amserver') ||
              lowerHeader.includes('.live.com')
            );

            if (!isOutlookContent || decompressedBody.length < 5000) {
              return finish({ ok: false, proxy: proxyUrl, latency, reason: `INVALID_OUTLOOK_PAYLOAD (${decompressedBody.length}B, HTTP_${statusCode})` });
            }
          } else if (targetHost.includes('github.com')) {
            const isGithubContent = (
              lowerBody.includes('github.com') ||
              lowerBody.includes('github') ||
              lowerHeader.includes('datadome') ||
              lowerHeader.includes('github')
            );
            if (!isGithubContent || decompressedBody.length < 300) {
              return finish({ ok: false, proxy: proxyUrl, latency, reason: `INVALID_GITHUB_PAYLOAD (${decompressedBody.length}B, HTTP_${statusCode})` });
            }
          } else if (targetHost.includes('chatgpt.com') || targetHost.includes('openai.com')) {
            const hasChatGptHeaders = (
              lowerHeader.includes('cloudflare') ||
              lowerHeader.includes('oai-') ||
              lowerHeader.includes('chatgpt') ||
              lowerHeader.includes('cf-ray') ||
              lowerHeader.includes('__cf_bm') ||
              lowerHeader.includes('_cfuvid') ||
              lowerHeader.includes('cf-cache-status')
            );
            const hasChatGptBody = (
              lowerBody.includes('chatgpt') ||
              lowerBody.includes('openai') ||
              lowerBody.includes('challenges.cloudflare.com') ||
              lowerBody.includes('cf_chl_opt') ||
              lowerBody.includes('data-build="prod-') ||
              lowerBody.includes('oai-') ||
              lowerBody.includes('<!doctype html') ||
              lowerBody.includes('<html') ||
              lowerBody.includes('just a moment')
            );

            const isGenuineChatGpt = hasChatGptHeaders || hasChatGptBody;
            if (!isGenuineChatGpt || rawBuffer.length < 300) {
              return finish({ ok: false, proxy: proxyUrl, latency, reason: `INVALID_CHATGPT_PAYLOAD (${rawBuffer.length}B, HTTP_${statusCode})` });
            }
          } else if (targetHost.includes('baseten.co')) {
            const isBasetenContent = (
              lowerBody.includes('baseten') ||
              lowerHeader.includes('baseten') ||
              lowerHeader.includes('cloudflare') ||
              lowerBody.includes('challenges.cloudflare.com') ||
              lowerHeader.includes('cf-ray') ||
              statusCode === 200 || statusCode === 302 || statusCode === 307
            );
            if (!isBasetenContent || rawBuffer.length < 200) {
              return finish({ ok: false, proxy: proxyUrl, latency, reason: `INVALID_BASETEN_PAYLOAD (${rawBuffer.length}B, HTTP_${statusCode})` });
            }
          }

        // 3. Check for Anti-Bot / Temporary IP Blocks
        const hasBlockedText = decompressedBody.includes('Access is temporarily restricted') ||
          decompressedBody.includes('We detected unusual activity from your device or network') ||
          decompressedBody.includes('Automated (bot) activity on your network') ||
          decompressedBody.includes('Use of developer or inspection tools') ||
          decompressedBody.includes('Access to this page has been denied') ||
          decompressedBody.includes('Account creation has been blocked') ||
          decompressedBody.includes('blocked the creation of this account') ||
          decompressedBody.includes('This site is temporarily unavailable') ||
          lowerBody.includes('error code 1020') ||
          lowerBody.includes('error code 1015') ||
          lowerBody.includes('error 1020') ||
          lowerBody.includes('error 1015') ||
          lowerBody.includes('sorry, you have been blocked');

        const isCloudflareChallenge = decompressedBody.includes('challenges.cloudflare.com') ||
          decompressedBody.includes('cf_chl_opt') ||
          lowerBody.includes('just a moment') ||
          lowerBody.includes('turnstile');

        const isCaptchaChallenge = isCloudflareChallenge ||
          decompressedBody.includes('geo.captcha-delivery.com') ||
          decompressedBody.includes('captcha-delivery') ||
          lowerHeader.includes('datadome');

        const isHardBlocked = hasBlockedText || ((statusCode === 403 || statusCode === 429) && !isCaptchaChallenge);
        const isSuccessful = (statusCode >= 200 && statusCode < 400) || (statusCode === 403 && isCaptchaChallenge && !hasBlockedText);

        if (isSuccessful && !isHardBlocked) {
          finish({ ok: true, status: statusCode, latency, reason: 'OK' });
        } else {
          let reason = `HTTP_${statusCode}`;
          if (isHardBlocked) {
            reason = 'BLOCKED_OR_RESTRICTED';
          }
          finish({ ok: false, status: statusCode, latency, reason });
        }
      });

      tlsSocket.on('error', (err) => {
        const latency = Date.now() - startTime;
        finish({ ok: false, proxy: proxyUrl, latency, reason: extractReason(err) });
      });
      tlsSocket.on('timeout', () => {
        tlsSocket.destroy();
        const latency = Date.now() - startTime;
        finish({ ok: false, proxy: proxyUrl, latency, reason: 'TLS_TIMEOUT' });
      });
    });

    connectReq.on('error', (err) => {
      const latency = Date.now() - startTime;
      finish({ ok: false, proxy: proxyUrl, latency, reason: extractReason(err) });
    });
    connectReq.on('timeout', () => {
      connectReq.destroy();
      const latency = Date.now() - startTime;
      finish({ ok: false, proxy: proxyUrl, latency, reason: 'CONNECT_TIMEOUT' });
    });
    connectReq.end();
  } catch (err) {
    const latency = Date.now() - startTime;
    finish({ ok: false, proxy: proxyUrl, latency, reason: extractReason(err) });
  }
});
}

async function checkHttpProxy(proxyUrl, timeoutMs = CHECK_TIMEOUT_MS, maxLatencyMs = MAX_LATENCY_MS) {
  let totalLatency = 0;
  let details = [];
  let count = 0;

  if (targetMode === 'basten') {
    const resBasten = await testSingleUrl(proxyUrl, TARGET_BASETEN, timeoutMs);
    if (!resBasten.ok) {
      return { ok: false, proxy: proxyUrl, latency: resBasten.latency, reason: `Baseten_${resBasten.reason}` };
    }
    if (resBasten.latency > maxLatencyMs) {
      return { ok: false, proxy: proxyUrl, latency: resBasten.latency, reason: `Baseten TOO_SLOW (${resBasten.latency}ms > ${maxLatencyMs}ms)` };
    }
    totalLatency += resBasten.latency;
    details.push(`Baseten: ${resBasten.latency}ms`);
    count++;

    const resGithub = await testSingleUrl(proxyUrl, TARGET_GITHUB, timeoutMs);
    if (!resGithub.ok) {
      return { ok: false, proxy: proxyUrl, latency: resGithub.latency, reason: `GitHub_${resGithub.reason}` };
    }
    if (resGithub.latency > maxLatencyMs) {
      return { ok: false, proxy: proxyUrl, latency: resGithub.latency, reason: `GitHub TOO_SLOW (${resGithub.latency}ms > ${maxLatencyMs}ms)` };
    }
    totalLatency += resGithub.latency;
    details.push(`GitHub: ${resGithub.latency}ms`);
    count++;
  }

  // Test Outlook if mode is outlook or all
  if (targetMode === 'outlook' || targetMode === 'all') {
    const resOutlook = await testSingleUrl(proxyUrl, TARGET_OUTLOOK, timeoutMs);
    if (!resOutlook.ok) {
      return { ok: false, proxy: proxyUrl, latency: resOutlook.latency, reason: `Outlook_${resOutlook.reason}` };
    }
    if (resOutlook.latency > maxLatencyMs) {
      return { ok: false, proxy: proxyUrl, latency: resOutlook.latency, reason: `Outlook TOO_SLOW (${resOutlook.latency}ms > ${maxLatencyMs}ms)` };
    }
    totalLatency += resOutlook.latency;
    details.push(`Outlook: ${resOutlook.latency}ms`);
    count++;
  }

  // Test GitHub if mode is github or all
  if (targetMode === 'github' || targetMode === 'all') {
    const resGithub = await testSingleUrl(proxyUrl, TARGET_GITHUB, timeoutMs);
    if (!resGithub.ok) {
      return { ok: false, proxy: proxyUrl, latency: resGithub.latency, reason: `GitHub_${resGithub.reason}` };
    }
    if (resGithub.latency > maxLatencyMs) {
      return { ok: false, proxy: proxyUrl, latency: resGithub.latency, reason: `GitHub TOO_SLOW (${resGithub.latency}ms > ${maxLatencyMs}ms)` };
    }
    totalLatency += resGithub.latency;
    details.push(`GitHub: ${resGithub.latency}ms`);
    count++;
  }

  // Test ChatGPT if mode is chatgpt or all
  if (targetMode === 'chatgpt' || targetMode === 'all') {
    const resChatgpt = await testSingleUrl(proxyUrl, TARGET_CHATGPT, timeoutMs);
    if (!resChatgpt.ok) {
      return { ok: false, proxy: proxyUrl, latency: resChatgpt.latency, reason: `ChatGPT_${resChatgpt.reason}` };
    }
    if (resChatgpt.latency > maxLatencyMs) {
      return { ok: false, proxy: proxyUrl, latency: resChatgpt.latency, reason: `ChatGPT TOO_SLOW (${resChatgpt.latency}ms > ${maxLatencyMs}ms)` };
    }
    totalLatency += resChatgpt.latency;
    details.push(`ChatGPT: ${resChatgpt.latency}ms`);
    count++;
  }

  const avgLatency = count > 0 ? Math.round(totalLatency / count) : 0;

  // Reject Indonesian Proxies
  const country = await getProxyCountry(proxyUrl);
  if (country === 'ID') {
    return { ok: false, proxy: proxyUrl, latency: avgLatency, reason: 'DISCARDED_INDONESIA_IP (ID)' };
  }

  return {
    ok: true,
    proxy: proxyUrl,
    status: 200,
    latency: avgLatency,
    reason: `OK [${country}] (${details.join(', ')})`
  };
}

async function main() {
  console.log('=======================================================');
  console.log('🔍 PROXY HEALTH & SPEED CHECKER');
  console.log(`   File:         ${PROXY_FILE_PATH}`);
  console.log(`   Targets:      ${targetLabel} (Non-Indonesia)`);
  console.log(`   Timeout:      ${CHECK_TIMEOUT_MS / 1000}s`);
  console.log(`   Max Latency:  ${MAX_LATENCY_MS}ms (Proxy harus cepat)`);
  console.log(`   Concurrency:  ${CONCURRENCY}`);
  console.log('=======================================================\n');

  if (!fs.existsSync(PROXY_FILE_PATH)) {
    console.error(`❌ File ${PROXY_FILE_PATH} tidak ditemukan!`);
    process.exit(1);
  }

  // Load all active (uncommented) proxies
  const activeProxies = loadProxyList({ includeEnv: false });
  if (activeProxies.length === 0) {
    console.log('ℹ️  Tidak ada proxy aktif (tanpa komentar) di http_proxies.txt.');
    process.exit(0);
  }

  console.log(`Ditemukan ${activeProxies.length} proxy aktif untuk diuji...\n`);

  const results = [];
  const aliveList = [];
  const deadList = [];

  // Run tests in chunks according to CONCURRENCY
  for (let i = 0; i < activeProxies.length; i += CONCURRENCY) {
    const chunk = activeProxies.slice(i, i + CONCURRENCY);
    const batchNum = Math.floor(i / CONCURRENCY) + 1;
    const totalBatches = Math.ceil(activeProxies.length / CONCURRENCY);
    console.log(`[Batch ${batchNum}/${totalBatches}] Menguji ${chunk.length} proxy...`);

    const chunkResults = await Promise.all(
      chunk.map(p => checkHttpProxy(p))
    );

    for (const res of chunkResults) {
      const masked = maskProxy(res.proxy);
      if (res.ok) {
        aliveList.push(res);
        console.log(`  ⚡ [FAST & ALIVE] ${masked} — Latency: ${res.latency}ms (HTTP ${res.status})`);
      } else {
        deadList.push(res);
        console.log(`  ❌ [DISCARDED]    ${masked} — Reason: ${res.reason} (Latency: ${res.latency}ms)`);
      }
      results.push(res);
    }
  }

  // Sort alive proxies by latency ascending (fastest first)
  aliveList.sort((a, b) => a.latency - b.latency);

  if (aliveList.length > 0) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const header = `# === FAST ACTIVE PROXIES (${aliveList.length} alive | Target: ${targetLabel} | Updated: ${timestamp}) ===`;
    const lines = [header, ...aliveList.map(a => a.proxy)];
    fs.writeFileSync(PROXY_FILE_PATH, lines.join('\n') + '\n', 'utf8');
  } else {
    fs.writeFileSync(PROXY_FILE_PATH, '# === NO ACTIVE FAST PROXIES FOUND ===\n', 'utf8');
  }

  console.log('\n=======================================================');
  console.log('📊 RINGKASAN HASIL PENGECEKAN PROXY');
  console.log('=======================================================');
  console.log(`  Total Diuji:           ${results.length}`);
  console.log(`  ⚡ Cepat & Lolos:       ${aliveList.length}`);
  console.log(`  ❌ Dibuang/Lambat/Mati: ${deadList.length}`);
  if (aliveList.length > 0) {
    console.log(`  🏆 Tercepat:           ${aliveList[0].latency}ms (${maskProxy(aliveList[0].proxy)})`);
    console.log(`  🐢 Terlambat Lolos:    ${aliveList[aliveList.length - 1].latency}ms (${maskProxy(aliveList[aliveList.length - 1].proxy)})`);
  }
  console.log('=======================================================\n');

  if (aliveList.length > 0) {
    console.log(`✅ Berhasil menyimpan ${aliveList.length} proxy aktif dan tercepat ke http_proxies.txt.\n`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error checking proxies:', err);
    process.exit(1);
  });
}

module.exports = { checkHttpProxy };
