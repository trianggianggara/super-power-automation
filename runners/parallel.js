// parallel.js — Meluncurkan beberapa proses registrasi secara concurrent/parallel
const { spawn } = require('child_process');
const path = require('path');
const { loadEnv } = require('../utils/env.js');

loadEnv();

// Konfigurasi parallel pendaftaran fleksibel
let TARGET_SCRIPT = 'registrars/register_chatgpt.js';
let CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

const rawArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
for (const arg of rawArgs) {
  if (/^\d+$/.test(arg)) {
    CONCURRENCY = parseInt(arg, 10);
  } else if (arg.endsWith('.js') || arg.includes('/')) {
    TARGET_SCRIPT = arg;
  }
}

console.log(`=======================================================`);
console.log(`🚀 MEMULAI PARALLEL RUNNER`);
console.log(`   Script Target: ${TARGET_SCRIPT}`);
console.log(`   Concurrency:   ${CONCURRENCY} thread(s)`);
console.log(`=======================================================\n`);

const fs = require('fs');

// Bersihkan file lock sisa dari run sebelumnya agar tidak terjadi bentrokan PID palsu
const lockFile = path.resolve(__dirname, '..', 'data', '.proxy_fetch.lock');
if (fs.existsSync(lockFile)) {
  try { fs.unlinkSync(lockFile); } catch (_) { }
}
const activeLockFile = path.resolve(__dirname, '..', 'data', '.active_proxies.json');
if (fs.existsSync(activeLockFile)) {
  try { fs.unlinkSync(activeLockFile); } catch (_) { }
}

const { loadProxyList, selectProxy, handleProxyFailure, isProxyError } = require('../utils/proxy.js');

// Definisikan proxy opsional untuk override manual antar thread
const STATIC_PROXIES = [];

const activeChildren = new Map();
const serviceTarget = TARGET_SCRIPT.includes('github') ? 'github' : (TARGET_SCRIPT.includes('outlook') ? 'outlook' : (TARGET_SCRIPT.includes('chatgpt') ? 'chatgpt' : (TARGET_SCRIPT.includes('genspark') ? 'genspark' : (TARGET_SCRIPT.includes('xl') ? 'xl' : (process.env.PROXY_TARGET_SERVICE || 'all')))));

function getThreadProxy(threadId) {
  if (STATIC_PROXIES.length > 0) {
    return STATIC_PROXIES[threadId % STATIC_PROXIES.length];
  }
  return selectProxy(process.env.PROXY || '', { service: serviceTarget });
}

function startThread(threadId) {
  const proxy = getThreadProxy(threadId);
  const env = { ...process.env };
  if (proxy) {
    env.PROXY = proxy;
  }
  env.THREAD_INDEX = String(threadId);

  const threadPrefix = `[Thread #${threadId + 1}]`;
  console.log(`${threadPrefix} Memulai proses ${proxy ? `dengan proxy: ${proxy.split('@').pop()}` : 'tanpa proxy'}...`);

  const PROJECT_ROOT = path.resolve(__dirname, '..');
  const extraFlags = process.argv.slice(2).filter(a => a.startsWith('--'));
  // Kita gunakan runners/loop.js sebagai wrapper agar thread yang mati otomatis restart
  const child = spawn('node', ['runners/loop.js', TARGET_SCRIPT, ...extraFlags], {
    cwd: PROJECT_ROOT,
    env,
  });

  activeChildren.set(threadId, child);

  // Salurkan stdout dengan prefix thread agar log di konsol tidak tercampur aduk
  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        console.log(`${threadPrefix} ${line}`);
      }
    });
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        console.error(`${threadPrefix} ❌ [ERROR] ${line}`);
        const isDirect = process.argv.includes('--direct') || extraFlags.includes('--direct') || Boolean(process.env.DISABLE_PROXY);
        if (proxy && !isDirect && isProxyError(line)) {
          handleProxyFailure(proxy, line, { service: serviceTarget });
        }
      }
    });
  });

  child.on('close', (code) => {
    activeChildren.delete(threadId);
    if (code === 99) {
      console.log(`${threadPrefix} Thread permanent shutdown requested (code 99). Stopping this thread permanently.`);
      return;
    }
    console.log(`${threadPrefix} Dihentikan dengan exit code: ${code}. Meluncurkan ulang thread dalam 5 detik...`);
    setTimeout(() => {
      // Only restart if the parent process isn't exiting
      if (!isExiting) {
        startThread(threadId);
      }
    }, 5000);
  });
}

let isExiting = false;

// Mulai semua thread dengan jeda startup (10 detik) agar inisialisasi browser tidak tabrakan di CPU
for (let i = 0; i < CONCURRENCY; i++) {
  setTimeout(() => {
    if (!isExiting) {
      startThread(i);
    }
  }, i * 10000);
}

function terminateAllThreads() {
  if (isExiting) return;
  console.log('\nStopping all threads and cleaning up Chrome processes...');
  isExiting = true;
  for (const [id, child] of activeChildren.entries()) {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
  }
  setTimeout(() => {
    for (const [id, child] of activeChildren.entries()) {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }
    process.exit(0);
  }, 1500);
}

process.on('SIGINT', terminateAllThreads);
process.on('SIGTERM', terminateAllThreads);

