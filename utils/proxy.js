const fs = require('fs');
const path = require('path');

const PROXY_FILE_PATH = path.resolve(__dirname, '..', 'http_proxies.txt');
const OUTLOOK_FAILED_PROXIES_FILE = path.resolve(__dirname, '..', 'data', 'outlook_failed_proxies.txt');
const GITHUB_FAILED_PROXIES_FILE = path.resolve(__dirname, '..', 'data', 'github_failed_proxies.txt');
const CHATGPT_FAILED_PROXIES_FILE = path.resolve(__dirname, '..', 'data', 'chatgpt_failed_proxies.txt');
const GENSPARK_FAILED_PROXIES_FILE = path.resolve(__dirname, '..', 'data', 'genspark_failed_proxies.txt');
const XL_FAILED_PROXIES_FILE = path.resolve(__dirname, '..', 'data', 'xl_failed_proxies.txt');

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Format date to YYYY-MM-DD HH:mm:ss
 */
function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Load Set of blacklisted / failed proxy host:ports
 */
function loadFailedProxies(serviceOrFile = null) {
  const failedSet = new Set();
  const filesToRead = [];

  if (serviceOrFile === 'outlook') {
    filesToRead.push(OUTLOOK_FAILED_PROXIES_FILE);
  } else if (serviceOrFile === 'github') {
    filesToRead.push(GITHUB_FAILED_PROXIES_FILE);
  } else if (serviceOrFile === 'chatgpt') {
    filesToRead.push(CHATGPT_FAILED_PROXIES_FILE);
  } else if (serviceOrFile === 'genspark') {
    filesToRead.push(GENSPARK_FAILED_PROXIES_FILE);
  } else if (serviceOrFile === 'xl' || serviceOrFile === 'esim') {
    filesToRead.push(XL_FAILED_PROXIES_FILE);
  } else if (typeof serviceOrFile === 'string' && serviceOrFile.includes('/')) {
    filesToRead.push(serviceOrFile);
  } else {
    filesToRead.push(OUTLOOK_FAILED_PROXIES_FILE, GITHUB_FAILED_PROXIES_FILE, CHATGPT_FAILED_PROXIES_FILE, GENSPARK_FAILED_PROXIES_FILE, XL_FAILED_PROXIES_FILE);
  }

  for (const fp of filesToRead) {
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
            const proxyPart = trimmed.split('#')[0].trim();
            const hostPort = extractHostPort(proxyPart);
            if (hostPort) failedSet.add(hostPort);
          }
        }
      } catch (_) { }
    }
  }
  return failedSet;
}

/**
 * Record a proxy permanently to the failed proxies blacklist
 */
function recordFailedProxy(proxyStrOrConfig, reason = 'DEAD', serviceOrFile = 'general') {
  if (!proxyStrOrConfig) return false;
  const hostPort = extractHostPort(proxyStrOrConfig);
  if (!hostPort) return false;

  let filePath = OUTLOOK_FAILED_PROXIES_FILE;
  if (serviceOrFile === 'github') {
    filePath = GITHUB_FAILED_PROXIES_FILE;
  } else if (serviceOrFile === 'chatgpt') {
    filePath = CHATGPT_FAILED_PROXIES_FILE;
  } else if (serviceOrFile === 'genspark') {
    filePath = GENSPARK_FAILED_PROXIES_FILE;
  } else if (serviceOrFile === 'xl' || serviceOrFile === 'esim') {
    filePath = XL_FAILED_PROXIES_FILE;
  } else if (typeof serviceOrFile === 'string' && serviceOrFile.includes('/')) {
    filePath = serviceOrFile;
  }

  const failedSet = loadFailedProxies(filePath);
  if (failedSet.has(hostPort)) return true;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = getTimestamp();
    const cleanReason = typeof reason === 'string' ? reason : extractReason(reason);
    const proxyUrl = typeof proxyStrOrConfig === 'string' ? (proxyStrOrConfig.includes('://') ? proxyStrOrConfig : `http://${proxyStrOrConfig}`) : `http://${hostPort}`;
    const entry = `${proxyUrl} # [${timestamp}] Reason: ${cleanReason}\n`;

    fs.appendFileSync(filePath, entry, 'utf8');
    console.log(`  🚫 [BLACKLIST] Added failed proxy to ${path.basename(filePath)}: ${hostPort} (${cleanReason})`);
    return true;
  } catch (err) {
    console.error(`  [BLACKLIST ERROR] Failed to write to blacklist: ${err.message}`);
    return false;
  }
}

/**
 * Normalize any proxy string into standard protocol://[user:pass@]host:port
 */
function normalizeProxyUrl(proxyStr) {
  if (!proxyStr) return '';
  let str = String(proxyStr).trim();
  // Strip inline comments (# or space-separated //)
  str = str.split('#')[0].replace(/\s+\/\/.*$/, '').trim();
  if (!str) return '';
  if (str.startsWith('http://') || str.startsWith('https://') || str.startsWith('socks5://') || str.startsWith('socks4://')) {
    const [proto, rest] = str.split('://');
    const parts = rest.split(':');
    if (parts.length === 4) {
      const [host, port, user, pass] = parts;
      return `${proto}://${user}:${pass}@${host}:${port}`;
    }
    return str;
  }
  const parts = str.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return `http://${str}`;
}

/**
 * Mask proxy credentials for safe logging
 */
function maskProxy(proxyStrOrConfig) {
  if (!proxyStrOrConfig) return '';
  if (typeof proxyStrOrConfig === 'object') {
    const server = proxyStrOrConfig.server || '';
    if (proxyStrOrConfig.username) {
      return server.replace('://', `://${proxyStrOrConfig.username}:*****@`);
    }
    return server;
  }
  return String(proxyStrOrConfig).replace(
    /:\/\/([^:]+):([^@]+)@/,
    '://$1:*****@'
  );
}

/**
 * Extract unique host and port identifier from proxy string or config
 * (Preserves username for authenticated rotating proxies like 711proxy/smartproxy)
 */
function extractHostPort(proxyStrOrConfig) {
  if (!proxyStrOrConfig) return '';
  if (typeof proxyStrOrConfig === 'object') {
    if (proxyStrOrConfig.server) {
      try {
        const u = new URL(proxyStrOrConfig.server.includes('://') ? proxyStrOrConfig.server : `http://${proxyStrOrConfig.server}`);
        const user = proxyStrOrConfig.username || u.username;
        const hp = u.port ? `${u.hostname}:${u.port}` : u.hostname;
        return user ? `${user}@${hp}` : hp;
      } catch (_) {
        return proxyStrOrConfig.server.replace(/^https?:\/\//, '').split('/').shift();
      }
    }
    return '';
  }

  const normalized = normalizeProxyUrl(proxyStrOrConfig);
  try {
    const u = new URL(normalized);
    const hp = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return u.username ? `${u.username}@${hp}` : hp;
  } catch (_) {
    return normalized.replace(/^[a-z0-9]+:\/\//i, '').split('/').shift();
  }
}

const geoCache = new Map();

/**
 * Get 2-letter ISO Country Code for an IP address or proxy URL
 */
async function getProxyCountry(proxyStrOrConfig) {
  const hostPort = extractHostPort(proxyStrOrConfig);
  const ip = hostPort.split(':')[0];
  if (!ip) return 'UNKNOWN';

  if (geoCache.has(ip)) return geoCache.get(ip);

  try {
    const res = await fetch(`https://api.country.is/${ip}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const cc = (data.country || '').toUpperCase();
      if (cc) {
        geoCache.set(ip, cc);
        return cc;
      }
    }
  } catch (_) { }

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const cc = (data.countryCode || '').toUpperCase();
      if (cc) {
        geoCache.set(ip, cc);
        return cc;
      }
    }
  } catch (_) { }

  geoCache.set(ip, 'UNKNOWN');
  return 'UNKNOWN';
}

/**
 * Check if a proxy belongs to Indonesia (ID)
 */
async function isIndonesiaProxy(proxyStrOrConfig) {
  const cc = await getProxyCountry(proxyStrOrConfig);
  return cc === 'ID';
}

/**
 * Load all active (uncommented and non-blacklisted) proxies from http_proxies.txt
 */
function loadProxyList({ includeEnv = true, filePath = PROXY_FILE_PATH, filterFailed = true } = {}) {
  if (envFlag('DISABLE_PROXY')) {
    return [];
  }

  const failedSet = filterFailed ? loadFailedProxies() : new Set();
  const list = [];
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
          const cleanPart = trimmed.split('#')[0].replace(/\s+\/\/.*$/, '').trim();
          if (cleanPart && cleanPart.includes(':')) {
            const formatted = normalizeProxyUrl(cleanPart);
            const hp = extractHostPort(formatted);
            if (!failedSet.has(hp)) {
              list.push(formatted);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`  [WARN] Failed to read proxy file (${filePath}): ${err.message}`);
    }
  }

  if (list.length === 0 && includeEnv && process.env.PROXY) {
    const envList = process.env.PROXY.split(',')
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => normalizeProxyUrl(p))
      .filter(p => !failedSet.has(extractHostPort(p)));
    list.push(...envList);
  }

  return list;
}

const LOCK_FILE = path.resolve(__dirname, '..', 'data', '.proxy_fetch.lock');
const LOG_FILE = path.resolve(__dirname, '..', 'data', 'proxy_fetcher.log');

/**
 * Check if the background proxy fetcher process is currently running
 */
function isFetcherRunning() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try {
    const pidStr = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (!pid || isNaN(pid)) return false;
    // Signal 0 tests if PID is active
    process.kill(pid, 0);
    return true;
  } catch (e) {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) { }
    return false;
  }
}

/**
 * Trigger proxy fetcher in a detached background process (separate thread)
 * so registrations continue without waiting.
 */
function triggerBackgroundProxyFetch({ service = (process.env.PROXY_TARGET_SERVICE || 'all') } = {}) {
  if (envFlag('DISABLE_PROXY')) return false;
  if (isFetcherRunning()) return true;

  try {
    const { spawn } = require('child_process');
    const dir = path.dirname(LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const flag = service === 'github' ? '--github' : (service === 'chatgpt' ? '--chatgpt' : (service === 'genspark' ? '--genspark' : (service === 'xl' || service === 'esim' ? '--xl' : (service === 'outlook' ? '--outlook' : '--all'))));

    // Redirect logs to data/proxy_fetcher.log
    const outLog = fs.openSync(LOG_FILE, 'a');
    const child = spawn('node', ['tools/fetch_and_test_proxies.js', flag], {
      cwd: path.resolve(__dirname, '..'),
      detached: true,
      stdio: ['ignore', outLog, outLog]
    });

    fs.writeFileSync(LOCK_FILE, String(child.pid), 'utf8');
    child.unref();

    console.log(`\n📡 [PROXY BACKGROUND] Started proxy fetcher thread in background (PID: ${child.pid}, Target: ${flag}). Continuing registration...\n`);
    return true;
  } catch (err) {
    console.warn(`  [WARN] Failed to trigger background proxy fetch: ${err.message}`);
    return false;
  }
}

/**
 * Ensure active proxies are available. Triggers background fetcher if proxy list is low/empty
 * without blocking the calling registration thread.
 */
function ensureProxiesAvailable({ filePath = PROXY_FILE_PATH, service = (process.env.PROXY_TARGET_SERVICE || 'all'), background = true } = {}) {
  let list = loadProxyList({ includeEnv: false, filePath });
  if (list.length <= 2 && !envFlag('DISABLE_PROXY')) {
    if (background) {
      triggerBackgroundProxyFetch({ service });
    } else {
      console.log(`\n[PROXY] http_proxies.txt is empty. Synchronously fetching fresh active proxies...\n`);
      try {
        const { execSync } = require('child_process');
        const flag = service === 'github' ? '--github' : (service === 'chatgpt' ? '--chatgpt' : (service === 'genspark' ? '--genspark' : (service === 'xl' || service === 'esim' ? '--xl' : (service === 'outlook' ? '--outlook' : '--all'))));
        execSync(`node tools/fetch_and_test_proxies.js ${flag}`, {
          stdio: 'inherit',
          cwd: path.resolve(__dirname, '..')
        });
        list = loadProxyList({ includeEnv: false, filePath });
      } catch (err) {
        console.warn(`  [WARN] Auto proxy fetch encountered an error: ${err.message}`);
      }
    }
  }
  return list;
}

const ACTIVE_LOCK_FILE = path.resolve(__dirname, '..', 'data', '.active_proxies.json');

function cleanAndGetLockedProxies() {
  if (!fs.existsSync(ACTIVE_LOCK_FILE)) return [];
  try {
    const data = fs.readFileSync(ACTIVE_LOCK_FILE, 'utf8');
    if (!data.trim()) return [];
    const list = JSON.parse(data);
    if (!Array.isArray(list)) return [];

    // Filter out dead PIDs
    const active = list.filter(item => {
      if (!item.pid) return false;
      try {
        process.kill(item.pid, 0);
        return true; // PID is alive
      } catch (e) {
        return false; // PID is dead, release lock
      }
    });

    // Write back if cleaned
    if (active.length !== list.length) {
      fs.writeFileSync(ACTIVE_LOCK_FILE, JSON.stringify(active, null, 2), 'utf8');
    }
    return active.map(item => item.proxy);
  } catch (err) {
    return [];
  }
}

function lockProxy(proxy) {
  if (!proxy) return;
  try {
    const dir = path.dirname(ACTIVE_LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const list = fs.existsSync(ACTIVE_LOCK_FILE) ? JSON.parse(fs.readFileSync(ACTIVE_LOCK_FILE, 'utf8') || '[]') : [];
    // Remove existing locks for this PID to prevent accumulation
    const filtered = list.filter(item => item.pid !== process.pid);
    filtered.push({ proxy, pid: process.pid, timestamp: Date.now() });
    fs.writeFileSync(ACTIVE_LOCK_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (err) {
    // Ignore
  }
}

function unlockProxy(proxy) {
  if (!proxy) return;
  try {
    if (!fs.existsSync(ACTIVE_LOCK_FILE)) return;
    const list = JSON.parse(fs.readFileSync(ACTIVE_LOCK_FILE, 'utf8') || '[]');
    const filtered = list.filter(item => !(item.proxy === proxy && item.pid === process.pid));
    fs.writeFileSync(ACTIVE_LOCK_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (err) {
    // Ignore
  }
}

const CHATGPT_PROXY_USAGE_FILE = path.resolve(__dirname, '..', 'data', 'chatgpt_proxy_usage.json');
const MAX_CHATGPT_REGISTRATIONS_PER_PROXY = Number(process.env.CHATGPT_MAX_ACCOUNTS_PER_PROXY || 5);

const GENSPARK_PROXY_USAGE_FILE = path.resolve(__dirname, '..', 'data', 'genspark_proxy_usage.json');
const MAX_GENSPARK_REGISTRATIONS_PER_PROXY = Number(process.env.GENSPARK_MAX_ACCOUNTS_PER_PROXY || 5);

function loadChatGPTProxyUsage() {
  if (!fs.existsSync(CHATGPT_PROXY_USAGE_FILE)) return {};
  try {
    const raw = fs.readFileSync(CHATGPT_PROXY_USAGE_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (_) {
    return {};
  }
}

function getChatGPTProxyUsage(proxy) {
  if (!proxy) return 0;
  const hostPort = extractHostPort(proxy);
  const usage = loadChatGPTProxyUsage();
  return Number(usage[hostPort] || 0);
}

function incrementChatGPTProxyUsage(proxy) {
  if (!proxy) return;
  const hostPort = extractHostPort(proxy);
  const usage = loadChatGPTProxyUsage();
  const currentCount = Number(usage[hostPort] || 0) + 1;
  usage[hostPort] = currentCount;

  try {
    const dir = path.dirname(CHATGPT_PROXY_USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHATGPT_PROXY_USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
    console.log(`  📊 [PROXY USAGE] ${hostPort} has registered ${currentCount}/${MAX_CHATGPT_REGISTRATIONS_PER_PROXY} ChatGPT accounts.`);

    if (currentCount >= MAX_CHATGPT_REGISTRATIONS_PER_PROXY) {
      console.log(`  🔄 [PROXY MAX REACHED] Proxy ${hostPort} reached maximum limit (${MAX_CHATGPT_REGISTRATIONS_PER_PROXY} accounts). Retiring for ChatGPT.`);
    }
  } catch (err) {
    console.warn(`  [WARN] Failed to write proxy usage: ${err.message}`);
  }
}

function loadGensparkProxyUsage() {
  if (!fs.existsSync(GENSPARK_PROXY_USAGE_FILE)) return {};
  try {
    const raw = fs.readFileSync(GENSPARK_PROXY_USAGE_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (_) {
    return {};
  }
}

function getGensparkProxyUsage(proxy) {
  if (!proxy) return 0;
  const hostPort = extractHostPort(proxy);
  const usage = loadGensparkProxyUsage();
  return Number(usage[hostPort] || 0);
}

function incrementGensparkProxyUsage(proxy) {
  if (!proxy) return;
  const hostPort = extractHostPort(proxy);
  const usage = loadGensparkProxyUsage();
  const currentCount = Number(usage[hostPort] || 0) + 1;
  usage[hostPort] = currentCount;

  try {
    const dir = path.dirname(GENSPARK_PROXY_USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GENSPARK_PROXY_USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
    console.log(`  📊 [GENSPARK PROXY USAGE] ${hostPort} has registered ${currentCount}/${MAX_GENSPARK_REGISTRATIONS_PER_PROXY} Genspark accounts.`);

    if (currentCount >= MAX_GENSPARK_REGISTRATIONS_PER_PROXY) {
      console.log(`  🚫 [PROXY MAX REACHED] Proxy ${hostPort} reached limit (${MAX_GENSPARK_REGISTRATIONS_PER_PROXY} accounts). Adding to Genspark blacklist and retiring...`);
      markProxyDead(proxy, `MAX_LIMIT_REACHED_${MAX_GENSPARK_REGISTRATIONS_PER_PROXY}_ACCOUNTS`, PROXY_FILE_PATH, { service: 'genspark' });
    }
  } catch (err) {
    console.warn(`  [WARN] Failed to write Genspark proxy usage: ${err.message}`);
  }
}

/**
 * Pick a random active proxy from http_proxies.txt (or fallback / env).
 * Proactively triggers background proxy fetch if proxy pool is low (<= 2) or empty.
 * Limits usage to max 5 accounts per proxy and rotates fairly.
 */
function selectProxy(fallbackProxyValue = process.env.PROXY || '', { filePath = PROXY_FILE_PATH, autoFetch = true, service = (process.env.PROXY_TARGET_SERVICE || 'all') } = {}) {
  if (envFlag('DISABLE_PROXY')) {
    return '';
  }

  if (fallbackProxyValue) {
    const list = String(fallbackProxyValue).split(',').map(p => p.trim()).filter(Boolean);
    if (list.length > 0) {
      const chosen = list[Math.floor(Math.random() * list.length)];
      const finalProxy = chosen.includes('://') ? chosen : `http://${chosen}`;
      lockProxy(finalProxy);
      return finalProxy;
    }
  }

  let activeList = loadProxyList({ includeEnv: false, filePath, filterFailed: true });

  // Filter out failed proxies specific to service
  const serviceFailedSet = loadFailedProxies(service);
  activeList = activeList.filter(p => !serviceFailedSet.has(extractHostPort(p)));

  // Filter out proxies that have reached max limit (max 5)
  let chatgptUsage = {};
  let gensparkUsage = {};

  if (service === 'chatgpt') {
    chatgptUsage = loadChatGPTProxyUsage();
    activeList = activeList.filter(p => {
      const hp = extractHostPort(p);
      const used = Number(chatgptUsage[hp] || 0);
      return used < MAX_CHATGPT_REGISTRATIONS_PER_PROXY;
    });
  } else if (service === 'genspark') {
    gensparkUsage = loadGensparkProxyUsage();
    activeList = activeList.filter(p => {
      const hp = extractHostPort(p);
      const used = Number(gensparkUsage[hp] || 0);
      return used < MAX_GENSPARK_REGISTRATIONS_PER_PROXY;
    });
  }

  if (autoFetch && activeList.length <= 2) {
    ensureProxiesAvailable({ filePath, service, background: true });
  }

  // Saring proxy yang sedang dipakai aktif oleh thread/proses lain
  const locked = cleanAndGetLockedProxies();
  const availableList = activeList.filter(p => !locked.includes(p));

  let chosen = '';
  if (availableList.length > 0) {
    if (service === 'chatgpt') {
      // Fair rotation: prioritize proxies with least usage count
      const sorted = [...availableList].sort((a, b) => {
        const uA = Number(chatgptUsage[extractHostPort(a)] || 0);
        const uB = Number(chatgptUsage[extractHostPort(b)] || 0);
        return uA - uB;
      });
      const minUsage = Number(chatgptUsage[extractHostPort(sorted[0])] || 0);
      const lowestTier = sorted.filter(p => Number(chatgptUsage[extractHostPort(p)] || 0) === minUsage);
      chosen = lowestTier[Math.floor(Math.random() * lowestTier.length)];
    } else if (service === 'genspark') {
      // Fair rotation: prioritize proxies with least usage count for Genspark
      const sorted = [...availableList].sort((a, b) => {
        const uA = Number(gensparkUsage[extractHostPort(a)] || 0);
        const uB = Number(gensparkUsage[extractHostPort(b)] || 0);
        return uA - uB;
      });
      const minUsage = Number(gensparkUsage[extractHostPort(sorted[0])] || 0);
      const lowestTier = sorted.filter(p => Number(gensparkUsage[extractHostPort(p)] || 0) === minUsage);
      chosen = lowestTier[Math.floor(Math.random() * lowestTier.length)];
    } else {
      // Prioritaskan proxy tercepat (top tier dari http_proxies.txt yang sudah terurut berdasarkan latensi terendah)
      const topCount = Math.min(5, availableList.length);
      const topTier = availableList.slice(0, topCount);
      chosen = topTier[Math.floor(Math.random() * topTier.length)];
    }
  } else if (activeList.length > 0) {
    // Jika semua proxy terpakai, fallback ke random dari activeList untuk menghindari crash
    chosen = activeList[Math.floor(Math.random() * activeList.length)];
  } else if (process.env.PROXY) {
    const list = process.env.PROXY.split(',').map(p => p.trim()).filter(Boolean);
    if (list.length > 0) {
      chosen = list[Math.floor(Math.random() * list.length)];
      chosen = chosen.includes('://') ? chosen : `http://${chosen}`;
    }
  }

  if (chosen) {
    lockProxy(chosen);
  }
  return chosen;
}


/**
 * Parse proxy string to Playwright proxy object
 */
function proxyFromUrl(proxyUrl = '') {
  if (!proxyUrl) return null;
  if (typeof proxyUrl === 'object' && proxyUrl.server) {
    return proxyUrl;
  }

  const list = String(proxyUrl).split(',').map(p => p.trim()).filter(Boolean);
  if (list.length === 0) return null;

  const chosen = list[Math.floor(Math.random() * list.length)];
  try {
    const raw = normalizeProxyUrl(chosen);
    const url = new URL(raw);
    let protocol = url.protocol.startsWith('socks') ? url.protocol : (url.protocol.startsWith('http') ? url.protocol : 'http:');
    const proxy = { server: `${protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}` };
    if (url.username) proxy.username = decodeURIComponent(url.username);
    if (url.password) proxy.password = decodeURIComponent(url.password);
    return proxy;
  } catch (err) {
    console.warn(`  [WARN] Failed to parse proxy URL '${chosen}': ${err.message}`);
    return null;
  }
}

/**
 * Determine if an error or error message is caused by proxy failure
 */
function isProxyError(err) {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : (err.message || String(err));
  const code = (err && err.code) ? String(err.code) : '';

  const proxyErrorPatterns = [
    /ERR_PROXY_/i,
    /ERR_TUNNEL_/i,
    /net::ERR_PROXY/i,
    /net::ERR_TUNNEL/i,
    /net::ERR_CONNECTION_/i,
    /net::ERR_TIMED_OUT/i,
    /net::ERR_NAME_NOT_RESOLVED/i,
    /net::ERR_EMPTY_RESPONSE/i,
    /net::ERR_HTTP_RESPONSE_CODE_FAILURE/i,
    /net::ERR_SOCKS_/i,
    /NS_ERROR_PROXY_/i,
    /NS_ERROR_NET_TIMEOUT/i,
    /NS_ERROR_UNKNOWN_PROXY_HOST/i,
    /NS_ERROR_CONNECTION_/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /EHOSTUNREACH/i,
    /ENETUNREACH/i,
    /socket hang up/i,
    /UND_ERR_CONNECT_TIMEOUT/i,
    /UND_ERR_SOCKET/i,
    /407 Proxy Authentication Required/i,
    /407/i,
    /502 Bad Gateway/i,
    /504 Gateway Timeout/i,
    /Proxy connection timed out/i,
    /Proxy authentication failed/i,
    /Proxy Error/i,
    /Access is restricted/i,
    /403 Forbidden/i,
    /Navigation timeout of \d+ms exceeded/i,
    /page\.goto: Timeout \d+ms exceeded/i,
    /page\.waitForURL: Timeout \d+ms exceeded/i,
    /locator\.waitFor: Timeout \d+ms exceeded/i,
    /Timeout \d+ms exceeded/i,
    /CHATGPT_IP_BLOCKED/i,
    /PROXY_ECHO/i,
    /FAKE_PROXY/i,
    /NS_ERROR_PROXY_/i,
    /NS_ERROR_ABORT/i,
    /sorry, you have been blocked/i,
    /access denied/i,
    /error code 1020/i,
    /error code 1015/i,
    /error 1020/i,
    /error 1015/i,
    /unusual activity/i,
    /BLOCKED_OR_RESTRICTED/i,
    /target closed/i,
    /Target page, context or browser has been closed/i,
  ];

  if (proxyErrorPatterns.some(p => p.test(msg))) {
    return true;
  }

  const socketCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'];
  if (socketCodes.includes(code)) {
    return true;
  }

  return false;
}

/**
 * Extract clean reason description for logging and commenting
 */
function extractReason(err) {
  if (!err) return 'DEAD';
  const msg = typeof err === 'string' ? err : (err.message || String(err));

  if (/PROXY_ECHO|FAKE_PROXY/i.test(msg)) return 'FAKE_ECHO_PROXY';
  if (/CHATGPT_IP_BLOCKED|sorry, you have been blocked|access denied|error code 1020|error code 1015|error 1020|error 1015/i.test(msg)) return 'CHATGPT_IP_BLOCKED_1020';
  if (/ERR_PROXY_CONNECTION_FAILED/i.test(msg)) return 'ERR_PROXY_CONNECTION_FAILED';
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(msg)) return 'ERR_TUNNEL_CONNECTION_FAILED';
  if (/ETIMEDOUT|ERR_TIMED_OUT|net::ERR_CONNECTION_TIMED_OUT|Navigation timeout|Timeout \d+ms exceeded|locator\.waitFor: Timeout/i.test(msg)) return 'TIMEOUT_SLOW_PROXY';
  if (/ECONNREFUSED|net::ERR_CONNECTION_REFUSED/i.test(msg)) return 'CONNECTION_REFUSED';
  if (/ECONNRESET|net::ERR_CONNECTION_RESET/i.test(msg)) return 'CONNECTION_RESET';
  if (/407/i.test(msg)) return 'AUTH_FAILED_407';
  if (/502/i.test(msg)) return 'BAD_GATEWAY_502';
  if (/504/i.test(msg)) return 'GATEWAY_TIMEOUT_504';
  if (/403 Forbidden|Access is restricted/i.test(msg)) return 'IP_BLOCKED_403';
  if (/NS_ERROR_PROXY_CONNECTION_REFUSED/i.test(msg)) return 'PROXY_CONNECTION_REFUSED';

  // Truncate message to 40 chars max
  const clean = msg.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 40 ? clean.substring(0, 40) + '...' : clean;
}

/**
 * Mark a dead proxy in http_proxies.txt by removing it and permanently blacklisting for Outlook
 */
function markProxyDead(proxyStrOrConfig, reason = 'DEAD', filePath = PROXY_FILE_PATH, { service = 'outlook' } = {}) {
  if (!proxyStrOrConfig) return false;

  const hostPort = extractHostPort(proxyStrOrConfig);
  if (!hostPort) return false;

  let username = '';
  if (typeof proxyStrOrConfig === 'object' && proxyStrOrConfig.username) {
    username = proxyStrOrConfig.username;
  } else if (hostPort.includes('@')) {
    username = hostPort.split('@')[0];
  }

  const cleanReason = typeof reason === 'string' ? reason : extractReason(reason);

  // 1. Permanently record to blacklist
  if (service === 'github') {
    recordFailedProxy(proxyStrOrConfig, cleanReason, GITHUB_FAILED_PROXIES_FILE);
  } else if (service === 'chatgpt') {
    recordFailedProxy(proxyStrOrConfig, cleanReason, CHATGPT_FAILED_PROXIES_FILE);
  } else if (service === 'genspark') {
    recordFailedProxy(proxyStrOrConfig, cleanReason, GENSPARK_FAILED_PROXIES_FILE);
  } else if (service === 'xl' || service === 'esim') {
    recordFailedProxy(proxyStrOrConfig, cleanReason, XL_FAILED_PROXIES_FILE);
  } else {
    recordFailedProxy(proxyStrOrConfig, cleanReason, OUTLOOK_FAILED_PROXIES_FILE);
  }

  // 2. Remove from active http_proxies.txt
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    let modified = false;
    let removedLine = '';
    const newLines = lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return true;

      // If proxy has a specific username/session, match by username
      if (username && trimmed.includes(username)) {
        modified = true;
        removedLine = trimmed;
        return false;
      }
      // Otherwise match by hostPort
      if (!username && trimmed.includes(hostPort)) {
        modified = true;
        removedLine = trimmed;
        return false;
      }
      return true;
    });

    if (modified) {
      fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
      console.log(`\n  ⚠️  [PROXY REMOVED] Removed from http_proxies.txt:\n      👉 Username/Session : ${username || 'N/A'}\n      👉 Line Content      : ${removedLine}\n      👉 Reason            : ${cleanReason}\n`);
      return true;
    }
  } catch (err) {
    console.error(`  [PROXY CLEANUP ERROR] Failed to update proxy file: ${err.message}`);
  }

  return false;
}

/**
 * Handle proxy failure: checks if the error is proxy-related and marks it dead if so
 */
function handleProxyFailure(proxyStrOrConfig, err, { force = false, filePath = PROXY_FILE_PATH, service = 'outlook' } = {}) {
  if (!proxyStrOrConfig) return false;
  if (force || isProxyError(err)) {
    const reason = extractReason(err);
    return markProxyDead(proxyStrOrConfig, reason, filePath, { service });
  }
  return false;
}

module.exports = {
  PROXY_FILE_PATH,
  OUTLOOK_FAILED_PROXIES_FILE,
  GENSPARK_FAILED_PROXIES_FILE,
  envFlag,
  getTimestamp,
  maskProxy,
  extractHostPort,
  loadFailedProxies,
  recordFailedProxy,
  getProxyCountry,
  isIndonesiaProxy,
  loadProxyList,
  ensureProxiesAvailable,
  triggerBackgroundProxyFetch,
  isFetcherRunning,
  selectProxy,
  proxyFromUrl,
  isProxyError,
  extractReason,
  markProxyDead,
  handleProxyFailure,
  loadChatGPTProxyUsage,
  getChatGPTProxyUsage,
  incrementChatGPTProxyUsage,
  loadGensparkProxyUsage,
  getGensparkProxyUsage,
  incrementGensparkProxyUsage,
};
