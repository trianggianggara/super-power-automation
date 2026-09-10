const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const https = require("https");
const http = require("http");
const tls = require("tls");
const zlib = require("zlib");
const {
  loadFailedProxies,
  extractHostPort,
  getProxyCountry,
} = require("../utils/proxy.js");

const PROXY_FILE = path.join(__dirname, "..", "http_proxies.txt");
const STATS_FILE = path.join(
  __dirname,
  "..",
  "data",
  "proxy_sources_stats.json",
);
const TIMEOUT_MS = Number(process.env.PROXY_CHECK_TIMEOUT_MS || 5000);
const MAX_LATENCY_MS = Number(process.env.PROXY_MAX_LATENCY_MS || 5000);
let CONCURRENCY = Number(process.env.PROXY_CHECK_CONCURRENCY || 150);
const TARGET_ALIVE_COUNT = Number(process.env.PROXY_TARGET_COUNT || 25);

const TARGET_OUTLOOK = "https://signup.live.com/signup?lic=1";
const TARGET_GITHUB = "https://github.com/signup";
const TARGET_CHATGPT = "https://chatgpt.com/";
const TARGET_GENSPARK = "https://www.genspark.ai/";
const TARGET_BASETEN = "https://login.baseten.co/sign-up";
const TARGET_XL = "https://www.xl.co.id/esim-trial/claim";
const LOCK_FILE = path.join(__dirname, "..", "data", ".proxy_fetch.lock");

function cleanupLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pidStr = fs.readFileSync(LOCK_FILE, "utf8").trim();
      if (parseInt(pidStr, 10) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (_) {}
}

process.on("exit", cleanupLock);
process.on("SIGINT", () => {
  cleanupLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupLock();
  process.exit(0);
});

function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return fetchUrl(res.headers.location, timeoutMs)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP_${res.statusCode}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("REQUEST_TIMEOUT"));
    });
    req.on("error", reject);
  });
}

// Curated list of proxy sources
const ALL_SOURCES = [
  {
    id: "proxyscrape_id",
    name: "ProxyScrape (Indonesia HTTP)",
    type: "text_list",
    url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=ID&ssl=all&anonymity=all",
    recommended: true,
  },
  {
    id: "proxyscrape_id_socks5",
    name: "ProxyScrape (Indonesia SOCKS5)",
    type: "text_list",
    url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=ID",
    recommended: true,
  },
  {
    id: "geonode",
    name: "Geonode API",
    type: "geonode",
    url: "https://geonode.com/free-proxy-list",
    recommended: true,
  },
  {
    id: "proxyscrape_v2",
    name: "ProxyScrape (v2 HTTP/S)",
    type: "text_list",
    url: "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=3000&country=all&ssl=yes&anonymity=elite,anonymous",
    recommended: true,
  },
  {
    id: "proxyscrape_v4",
    name: "ProxyScrape (v4 Display)",
    type: "text_list",
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text",
    recommended: true,
  },
  {
    id: "monosans",
    name: "monosans Proxy List",
    type: "text_list",
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    recommended: true,
  },
  {
    id: "sunny9577",
    name: "sunny9577 Proxy-Scraper",
    type: "text_list",
    url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt",
    recommended: false,
  },
  {
    id: "roosterkid",
    name: "roosterkid OpenProxyList",
    type: "text_list",
    url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    recommended: false,
  },
  {
    id: "clarketm",
    name: "clarketm Proxy-List",
    type: "text_list",
    url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    recommended: false,
  },
  {
    id: "thespeedx",
    name: "TheSpeedX Proxy-List",
    type: "text_list",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    recommended: false,
  },
  {
    id: "proxyscraper",
    name: "ProxyScraper Repo",
    type: "text_list",
    url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt",
    recommended: false,
  },
];

async function fetchGeonodeProxies(maxPages = 10) {
  const proxies = [];
  const limit = 500;
  let page = 1;
  let totalAvailable = null;

  while (page <= maxPages) {
    const url = `https://proxylist.geonode.com/api/proxy-list?limit=${limit}&page=${page}&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps`;
    try {
      const content = await fetchUrl(url, 12000);
      const json = JSON.parse(content);
      if (!json || !Array.isArray(json.data) || json.data.length === 0) {
        break;
      }
      if (typeof json.total === "number") {
        totalAvailable = json.total;
      }
      for (const item of json.data) {
        if (item && item.ip && item.port) {
          // Exclude Indonesian proxies early if country is provided
          if (item.country === "ID") continue;
          const port = parseInt(item.port, 10);
          if (port > 0 && port <= 65535) {
            proxies.push(`http://${item.ip}:${port}`);
          }
        }
      }
      const totalPages = totalAvailable
        ? Math.ceil(totalAvailable / limit)
        : "?";
      console.log(
        `  [+] Geonode API: page ${page}/${totalPages} (${json.data.length} proxies retrieved, total valid: ${proxies.length})`,
      );

      if (totalAvailable && page * limit >= totalAvailable) {
        break;
      }
      page++;
    } catch (err) {
      console.warn(
        `  [WARN] Failed fetching Geonode page ${page}: ${err.message}`,
      );
      break;
    }
  }

  return proxies;
}

function testSingleUrl(proxyUrl, targetUrl, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let isResolved = false;
    let connectReq = null;
    let tlsSocket = null;
    let hardTimer = null;

    const finish = (ok, error = null, latency = Date.now() - startTime) => {
      if (isResolved) return;
      isResolved = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (tlsSocket)
        try {
          tlsSocket.destroy();
        } catch (_) {}
      if (connectReq)
        try {
          connectReq.destroy();
        } catch (_) {}
      resolve({
        ok,
        error: error ? error.message || String(error) : null,
        latency,
      });
    };

    // Hard deadline: kill everything after 1.5x timeout
    hardTimer = setTimeout(
      () => {
        finish(false, new Error("HARD_DEADLINE_EXCEEDED"));
      },
      Math.round(timeoutMs * 1.5),
    );

    try {
      const hp = extractHostPort(proxyUrl);
      const [proxyHost, proxyPortStr] = hp.split(":");
      const proxyPort = parseInt(proxyPortStr || "80", 10);
      const urlObj = new URL(targetUrl);
      const targetHost = urlObj.hostname;
      const targetPath = urlObj.pathname + urlObj.search;

      // 1. Strict CONNECT Request
      connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${targetHost}:443`,
        headers: {
          Host: `${targetHost}:443`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        timeout: timeoutMs,
      });

      connectReq.on("connect", (res, socket, head) => {
        // STRICT REQUIREMENT: CONNECT must return 200 (not 301, 302, 308, 400, 403, 502)
        if (res.statusCode !== 200) {
          socket.destroy();
          return finish(false, new Error(`CONNECT_FAILED_${res.statusCode}`));
        }

        // 2. Strict TLS Handshake over established tunnel
        tlsSocket = tls.connect(
          {
            socket,
            servername: targetHost,
            rejectUnauthorized: true,
            timeout: timeoutMs,
          },
          () => {
            // 3. Send HTTP GET over encrypted tunnel
            const getReq = `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\nAccept-Encoding: gzip, deflate, br\r\nConnection: close\r\n\r\n`;
            tlsSocket.write(getReq);
          },
        );

        const rawChunks = [];
        tlsSocket.on("data", (chunk) => {
          rawChunks.push(chunk);
        });

        tlsSocket.on("end", () => {
          const rawBuffer = Buffer.concat(rawChunks);
          const headerEnd = rawBuffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            return finish(false, new Error("INVALID_HTTP_RESPONSE"));
          }

          const headerStr = rawBuffer.slice(0, headerEnd).toString("utf8");
          const firstLine = headerStr.split("\r\n")[0] || "";
          const statusMatch = firstLine.match(/HTTP\/\d\.\d\s+(\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
          const bodyBuffer = rawBuffer.slice(headerEnd + 4);

          let decompressedBody = "";
          try {
            if (headerStr.toLowerCase().includes("content-encoding: gzip")) {
              decompressedBody = zlib.gunzipSync(bodyBuffer).toString("utf8");
            } else if (
              headerStr.toLowerCase().includes("content-encoding: br")
            ) {
              decompressedBody = zlib
                .brotliDecompressSync(bodyBuffer)
                .toString("utf8");
            } else if (
              headerStr.toLowerCase().includes("content-encoding: deflate")
            ) {
              decompressedBody = zlib.inflateSync(bodyBuffer).toString("utf8");
            } else {
              decompressedBody = bodyBuffer.toString("utf8");
            }
          } catch (_) {
            decompressedBody = bodyBuffer.toString("utf8");
          }

          // 1. Check for common proxy error pages & transparent proxy banners
          const lowerBody = decompressedBody.toLowerCase();
          const lowerHeader = headerStr.toLowerCase();

          const hasProxyError =
            lowerBody.includes("squid") ||
            lowerBody.includes("tinyproxy") ||
            lowerBody.includes("mikrotik") ||
            lowerBody.includes("routeros") ||
            lowerBody.includes("proxy error") ||
            lowerBody.includes("gateway timeout") ||
            lowerBody.includes("bad gateway") ||
            lowerBody.includes("connection refused") ||
            lowerBody.includes("host unreachable") ||
            lowerBody.includes("unreachable") ||
            lowerBody.includes("network is unreachable") ||
            lowerBody.includes("cannot connect") ||
            lowerBody.includes("connection has timed out") ||
            lowerBody.includes("problem loading page") ||
            lowerBody.includes("remote_addr =") ||
            lowerBody.includes("request_method =") ||
            lowerBody.includes("http_user_agent =") ||
            lowerBody.includes("http_host =") ||
            lowerBody.includes("request_time_float");

          if (hasProxyError) {
            return finish(
              false,
              new Error("PROXY_INTERNAL_ERROR_OR_ECHO_PAGE"),
            );
          }

          // 2. Strict Target-Specific Authenticity Verification
          if (targetHost.includes("live.com")) {
            // Outlook requires genuine Microsoft identity and >= 5,000 bytes (real page is >150 KB)
            const isOutlookContent =
              lowerBody.includes("microsoft corporation") ||
              lowerBody.includes("logincdn.msauth.net") ||
              lowerBody.includes("signup.live.com") ||
              lowerBody.includes("servername:") ||
              lowerHeader.includes("x-ms-request-id") ||
              lowerHeader.includes("amserver") ||
              lowerHeader.includes(".live.com");

            if (!isOutlookContent || decompressedBody.length < 5000) {
              return finish(
                false,
                new Error(
                  `INVALID_OUTLOOK_PAYLOAD (size: ${decompressedBody.length}B, HTTP_${statusCode})`,
                ),
              );
            }
          } else if (targetHost.includes("github.com")) {
            const isGithubContent =
              lowerBody.includes("github.com") ||
              lowerBody.includes("github") ||
              lowerHeader.includes("datadome") ||
              lowerHeader.includes("github");
            if (!isGithubContent || decompressedBody.length < 300) {
              return finish(
                false,
                new Error(
                  `INVALID_GITHUB_PAYLOAD (size: ${decompressedBody.length}B, HTTP_${statusCode})`,
                ),
              );
            }
          } else if (
            targetHost.includes("chatgpt.com") ||
            targetHost.includes("openai.com")
          ) {
            const hasChatGptHeaders =
              lowerHeader.includes("cloudflare") ||
              lowerHeader.includes("oai-") ||
              lowerHeader.includes("chatgpt") ||
              lowerHeader.includes("cf-ray") ||
              lowerHeader.includes("__cf_bm") ||
              lowerHeader.includes("_cfuvid") ||
              lowerHeader.includes("cf-cache-status");
            const hasChatGptBody =
              lowerBody.includes("chatgpt") ||
              lowerBody.includes("openai") ||
              lowerBody.includes("challenges.cloudflare.com") ||
              lowerBody.includes("cf_chl_opt") ||
              lowerBody.includes('data-build="prod-') ||
              lowerBody.includes("oai-") ||
              lowerBody.includes("<!doctype html") ||
              lowerBody.includes("<html") ||
              lowerBody.includes("just a moment");

            const isGenuineChatGpt = hasChatGptHeaders || hasChatGptBody;
            if (!isGenuineChatGpt || rawBuffer.length < 300) {
            } else if (targetHost.includes("baseten.co")) {
              const isBasetenContent =
                lowerBody.includes("baseten") ||
                lowerHeader.includes("baseten") ||
                lowerHeader.includes("cloudflare") ||
                lowerBody.includes("challenges.cloudflare.com") ||
                lowerHeader.includes("cf-ray") ||
                statusCode === 200 ||
                statusCode === 302 ||
                statusCode === 307;
              if (!isBasetenContent || rawBuffer.length < 200) {
                return finish(
                  false,
                  new Error(
                    `INVALID_BASETEN_PAYLOAD (size: ${rawBuffer.length}B, HTTP_${statusCode})`,
                  ),
                );
              }
            } else if (targetHost.includes("xl.co.id")) {
              const isXlContent =
                lowerBody.includes("xl") ||
                lowerBody.includes("esim") ||
                lowerHeader.includes("cloudflare") ||
                statusCode === 200;
              if (!isXlContent || rawBuffer.length < 200) {
                return finish(
                  false,
                  new Error(
                    `INVALID_XL_PAYLOAD (size: ${rawBuffer.length}B, HTTP_${statusCode})`,
                  ),
                );
              }
            }
          }

          // 3. Check for Anti-Bot / Temporary IP Blocks
          const hasBlockedText =
            decompressedBody.includes("Access is temporarily restricted") ||
            decompressedBody.includes(
              "We detected unusual activity from your device or network",
            ) ||
            decompressedBody.includes(
              "Automated (bot) activity on your network",
            ) ||
            decompressedBody.includes("Use of developer or inspection tools") ||
            decompressedBody.includes("Access to this page has been denied") ||
            decompressedBody.includes("Account creation has been blocked") ||
            decompressedBody.includes("blocked the creation of this account") ||
            decompressedBody.includes("This site is temporarily unavailable") ||
            lowerBody.includes("error code 1020") ||
            lowerBody.includes("error code 1015") ||
            lowerBody.includes("error 1020") ||
            lowerBody.includes("error 1015") ||
            lowerBody.includes("sorry, you have been blocked");

          const isCloudflareChallenge =
            decompressedBody.includes("challenges.cloudflare.com") ||
            decompressedBody.includes("cf_chl_opt") ||
            lowerBody.includes("just a moment") ||
            lowerBody.includes("turnstile");

          const isCaptchaChallenge =
            isCloudflareChallenge ||
            decompressedBody.includes("geo.captcha-delivery.com") ||
            decompressedBody.includes("captcha-delivery") ||
            lowerHeader.includes("datadome");

          const isHardBlocked =
            hasBlockedText ||
            ((statusCode === 403 || statusCode === 429) && !isCaptchaChallenge);
          const isSuccessful =
            (statusCode >= 200 && statusCode < 400) ||
            (statusCode === 403 && isCaptchaChallenge && !hasBlockedText);

          if (isSuccessful && !isHardBlocked) {
            finish(true, null);
          } else {
            let reason = `HTTP_${statusCode}`;
            if (isHardBlocked) {
              reason = "BLOCKED_OR_RESTRICTED";
            }
            finish(false, new Error(reason));
          }
        });

        tlsSocket.on("error", (err) => finish(false, err));
        tlsSocket.on("timeout", () => {
          tlsSocket.destroy();
          finish(false, new Error("TLS_TIMEOUT"));
        });
      });

      connectReq.on("error", (err) => finish(false, err));
      connectReq.on("timeout", () => {
        connectReq.destroy();
        finish(false, new Error("CONNECT_TIMEOUT"));
      });
      connectReq.end();
    } catch (err) {
      finish(false, err);
    }
  });
}

const args = process.argv.slice(2);
let targetMode = "outlook"; // Default: Outlook

if (args.includes("--xl") || args.includes("--esim")) {
  targetMode = "xl";
} else if (args.includes("--basten") || args.includes("--baseten")) {
  targetMode = "basten";
} else if (args.includes("--github")) {
  targetMode = "github";
} else if (args.includes("--chatgpt")) {
  targetMode = "chatgpt";
} else if (args.includes("--genspark")) {
  targetMode = "genspark";
} else if (
  args.includes("--all") ||
  args.includes("--both") ||
  args.includes("--dual")
) {
  targetMode = "all";
} else if (args.includes("--outlook")) {
  targetMode = "outlook";
} else if (process.env.PROXY_TARGET_SERVICE) {
  const envTarget = process.env.PROXY_TARGET_SERVICE.toLowerCase();
  if (
    [
      "github",
      "outlook",
      "chatgpt",
      "genspark",
      "basten",
      "baseten",
      "all",
      "both",
    ].includes(envTarget)
  ) {
    targetMode =
      envTarget === "both"
        ? "all"
        : envTarget === "baseten"
          ? "basten"
          : envTarget;
  }
}

// Parse selected sources filter if requested (e.g. --source=geonode,proxyscrape_v2, --best, or PROXY_SOURCES env)
let requestedSourceFilters = null;
const sourceArg = args.find(
  (a) => a.startsWith("--source=") || a.startsWith("--sources="),
);
const isBestOnly =
  args.includes("--best") ||
  args.includes("--top") ||
  args.includes("--recommended");

if (sourceArg) {
  requestedSourceFilters = sourceArg
    .split("=")[1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
} else if (isBestOnly) {
  requestedSourceFilters = ALL_SOURCES.filter((s) => s.recommended).map(
    (s) => s.id,
  );
} else if (process.env.PROXY_SOURCES) {
  requestedSourceFilters = process.env.PROXY_SOURCES.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Parse concurrency argument (e.g. --concurrency=300 or -c=300)
const concurrencyArg = args.find(
  (a) => a.startsWith("--concurrency=") || a.startsWith("-c="),
);
if (concurrencyArg) {
  const parsed = parseInt(concurrencyArg.split("=")[1], 10);
  if (parsed > 0) CONCURRENCY = parsed;
}

const targetLabel =
  targetMode === "all"
    ? "Outlook + GitHub + ChatGPT + Genspark"
    : targetMode === "xl"
      ? "XL eSIM (Indonesia)"
      : targetMode === "basten"
        ? "Baseten + GitHub"
        : targetMode === "github"
          ? "GitHub"
          : targetMode === "chatgpt"
            ? "ChatGPT"
            : targetMode === "genspark"
              ? "Genspark"
              : "Outlook";

async function testProxy(
  proxyUrl,
  timeoutMs = TIMEOUT_MS,
  maxLatencyMs = MAX_LATENCY_MS,
) {
  let avgLatency = 0;
  let details = "";
  let count = 0;

  if (targetMode === "xl") {
    const resXl = await testSingleUrl(proxyUrl, TARGET_XL, timeoutMs);
    if (!resXl.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `XL: ${resXl.error}`,
        latencyMs: resXl.latency,
      };
    }
    if (resXl.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `XL TOO_SLOW (${resXl.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resXl.latency,
      };
    }
    avgLatency += resXl.latency;
    details += `XL: ${resXl.latency}ms`;
    count++;
  }

  if (targetMode === "basten") {
    const resBasten = await testSingleUrl(proxyUrl, TARGET_BASETEN, timeoutMs);
    if (!resBasten.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `Baseten: ${resBasten.error}`,
        latencyMs: resBasten.latency,
      };
    }
    if (resBasten.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `Baseten TOO_SLOW (${resBasten.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resBasten.latency,
      };
    }
    avgLatency += resBasten.latency;
    details += `Baseten: ${resBasten.latency}ms`;
    count++;

    const resGithub = await testSingleUrl(proxyUrl, TARGET_GITHUB, timeoutMs);
    if (!resGithub.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `GitHub: ${resGithub.error}`,
        latencyMs: resGithub.latency,
      };
    }
    if (resGithub.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `GitHub TOO_SLOW (${resGithub.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resGithub.latency,
      };
    }
    avgLatency += resGithub.latency;
    details += details
      ? `, GitHub: ${resGithub.latency}ms`
      : `GitHub: ${resGithub.latency}ms`;
    count++;
  }

  if (targetMode === "outlook" || targetMode === "all") {
    const resOutlook = await testSingleUrl(proxyUrl, TARGET_OUTLOOK, timeoutMs);
    if (!resOutlook.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `Outlook: ${resOutlook.error}`,
        latencyMs: resOutlook.latency,
      };
    }
    if (resOutlook.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `Outlook TOO_SLOW (${resOutlook.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resOutlook.latency,
      };
    }
    avgLatency += resOutlook.latency;
    details += `Outlook: ${resOutlook.latency}ms`;
    count++;
  }

  if (targetMode === "github" || targetMode === "all") {
    const resGithub = await testSingleUrl(proxyUrl, TARGET_GITHUB, timeoutMs);
    if (!resGithub.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `GitHub: ${resGithub.error}`,
        latencyMs: resGithub.latency,
      };
    }
    if (resGithub.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `GitHub TOO_SLOW (${resGithub.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resGithub.latency,
      };
    }
    avgLatency += resGithub.latency;
    details += details
      ? `, GitHub: ${resGithub.latency}ms`
      : `GitHub: ${resGithub.latency}ms`;
    count++;
  }

  if (targetMode === "chatgpt" || targetMode === "all") {
    const resChatgpt = await testSingleUrl(proxyUrl, TARGET_CHATGPT, timeoutMs);
    if (!resChatgpt.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `ChatGPT: ${resChatgpt.error}`,
        latencyMs: resChatgpt.latency,
      };
    }
    if (resChatgpt.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `ChatGPT TOO_SLOW (${resChatgpt.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resChatgpt.latency,
      };
    }
    avgLatency += resChatgpt.latency;
    details += details
      ? `, ChatGPT: ${resChatgpt.latency}ms`
      : `ChatGPT: ${resChatgpt.latency}ms`;
    count++;
  }

  if (targetMode === "genspark" || targetMode === "all") {
    const resGenspark = await testSingleUrl(
      proxyUrl,
      TARGET_GENSPARK,
      timeoutMs,
    );
    if (!resGenspark.ok) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `Genspark: ${resGenspark.error}`,
        latencyMs: resGenspark.latency,
      };
    }
    if (resGenspark.latency > maxLatencyMs) {
      return {
        proxy: proxyUrl,
        alive: false,
        error: `Genspark TOO_SLOW (${resGenspark.latency}ms > ${maxLatencyMs}ms)`,
        latencyMs: resGenspark.latency,
      };
    }
    avgLatency += resGenspark.latency;
    details += details
      ? `, Genspark: ${resGenspark.latency}ms`
      : `Genspark: ${resGenspark.latency}ms`;
    count++;
  }

  if (count > 1) {
    avgLatency = Math.round(avgLatency / count);
  }

  // Strictly Reject Indonesian Proxies
  const country = await getProxyCountry(proxyUrl);
  if (country === "ID") {
    return {
      proxy: proxyUrl,
      alive: false,
      error: "DISCARDED_INDONESIA_IP (ID)",
      latencyMs: avgLatency,
    };
  }

  return {
    proxy: proxyUrl,
    alive: true,
    latencyMs: avgLatency,
    country: country,
    details: `[${country}] | ${details}`,
    error: null,
  };
}

process.on("uncaughtException", () => {});
process.on("unhandledRejection", () => {});

async function runPool(items, limit, workerFn, stopCondition = () => false) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length && !stopCondition()) {
      const current = items[idx++];
      try {
        const res = await workerFn(current);
        results.push(res);
      } catch (err) {
        results.push({ proxy: current, alive: false, error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

function saveActiveProxies(aliveList) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const fileLines = [
    `# === FAST ACTIVE PROXIES (${aliveList.length} alive | Target: ${targetLabel} | Updated: ${timestamp}) ===`,
  ];

  if (aliveList.length > 0) {
    aliveList.forEach((a) => {
      const sourceStr = a.source ? ` | Source: ${a.source}` : "";
      const countryStr = a.country ? `[${a.country}] ` : "";
      fileLines.push(`${a.proxy} # ${countryStr}${a.latencyMs}ms${sourceStr}`);
    });
  } else {
    fileLines.push("# (No active proxies found)");
  }

  fs.writeFileSync(PROXY_FILE, fileLines.join("\n") + "\n", "utf8");
}

function saveSourceStats(statsMap, target) {
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const statsArray = Object.values(statsMap).map((s) => {
      const rate =
        s.tested > 0 ? ((s.alive / s.tested) * 100).toFixed(2) : "0.00";
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        url: s.url,
        fetched: s.fetched,
        tested: s.tested,
        alive: s.alive,
        successRate: `${rate}%`,
        aliveProxies: s.aliveProxies,
      };
    });

    // Sort by alive count descending
    statsArray.sort((a, b) => b.alive - a.alive || b.tested - a.tested);

    const payload = {
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      targetService: target,
      totalSourcesTested: statsArray.length,
      sources: statsArray,
    };

    fs.writeFileSync(STATS_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.warn(`  [WARN] Failed to write stats file: ${err.message}`);
  }
}

async function main() {
  console.log("=== PROXY SCRAPER & VERIFIER (ACTIVE ONLY) ===");
  console.log(
    `🎯 Target Verification Mode: [${targetLabel}] (Flags: --outlook [default], --github, --all)\n`,
  );

  // Map to record: proxyHostPort -> Set of source names
  const proxySourceMap = new Map();
  // Stats tracking for each source
  const sourceStats = {};

  const recordProxySource = (proxyUrl, sourceId, sourceName) => {
    const hp = extractHostPort(proxyUrl);
    if (!hp) return;
    if (!proxySourceMap.has(hp)) {
      proxySourceMap.set(hp, new Set());
    }
    proxySourceMap.get(hp).add(sourceName);

    if (!sourceStats[sourceId]) {
      sourceStats[sourceId] = {
        id: sourceId,
        name: sourceName,
        fetched: 0,
        tested: 0,
        alive: 0,
        aliveProxies: [],
      };
    }
    sourceStats[sourceId].fetched++;
  };

  // Determine active sources to fetch
  let activeSources = ALL_SOURCES;
  if (requestedSourceFilters && requestedSourceFilters.length > 0) {
    activeSources = ALL_SOURCES.filter((s) =>
      requestedSourceFilters.some(
        (f) =>
          s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f),
      ),
    );
    if (activeSources.length === 0) {
      console.warn(
        `[WARN] No sources matched filter "${requestedSourceFilters.join(",")}". Defaulting to all sources.`,
      );
      activeSources = ALL_SOURCES;
    } else {
      console.log(
        `[*] Filter applied: using ${activeSources.length} source(s) (${activeSources.map((s) => s.name).join(", ")})`,
      );
    }
  }

  // Initialize stats for active sources
  activeSources.forEach((s) => {
    sourceStats[s.id] = {
      id: s.id,
      name: s.name,
      type: s.type,
      url: s.url,
      fetched: 0,
      tested: 0,
      alive: 0,
      aliveProxies: [],
    };
  });

  // 1. Read existing active proxies from http_proxies.txt (skip comments/dead)
  const existingProxies = [];
  if (fs.existsSync(PROXY_FILE)) {
    const rawLines = fs.readFileSync(PROXY_FILE, "utf8").split("\n");
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//"))
        continue;
      const cleanLine = trimmed
        .split("#")[0]
        .replace(/\s+\/\/.*$/, "")
        .trim();
      const match = cleanLine.match(/(https?:\/\/[^\s]+)/i);
      if (match) {
        const proxy = match[1];
        existingProxies.push(proxy);
        recordProxySource(proxy, "existing_file", "Existing Active File");
      }
    }
  }

  const uniqueExisting = Array.from(new Set(existingProxies));
  console.log(
    `[*] Found ${uniqueExisting.length} existing active proxies in http_proxies.txt.`,
  );

  // 2. Fetch fresh proxies from public sources
  console.log("[*] Fetching fresh proxies from public sources...");
  const scrapedProxies = [];

  for (const src of activeSources) {
    if (src.type === "geonode") {
      console.log(`[*] Fetching proxies from ${src.name} (${src.url})...`);
      try {
        const geonodeProxies = await fetchGeonodeProxies(10);
        geonodeProxies.forEach((p) => {
          scrapedProxies.push(p);
          recordProxySource(p, src.id, src.name);
        });
        console.log(
          `[*] Successfully fetched ${geonodeProxies.length} proxies from ${src.name}.`,
        );
      } catch (e) {
        console.warn(`  [WARN] Failed fetching from ${src.name}: ${e.message}`);
      }
    } else {
      try {
        const content = await fetchUrl(src.url);
        const lines = content
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        let srcCount = 0;
        for (const item of lines) {
          const trimmed = item.trim();
          if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//"))
            continue;
          const match = trimmed.match(
            /^(?:https?:\/\/)?([0-9a-zA-Z.-]+):(\d{2,5})$/,
          );
          if (match) {
            const host = match[1];
            const port = parseInt(match[2], 10);
            if (port > 0 && port <= 65535) {
              const p = `http://${host}:${port}`;
              scrapedProxies.push(p);
              recordProxySource(p, src.id, src.name);
              srcCount++;
            }
          }
        }
        console.log(`  [+] ${src.name}: fetched ${srcCount} proxies`);
      } catch (e) {
        console.warn(
          `  [WARN] Failed fetching from ${src.name} (${src.url}): ${e.message}`,
        );
      }
    }
  }

  const uniqueScraped = Array.from(new Set(scrapedProxies));
  console.log(
    `\n[*] Scraped total ${uniqueScraped.length} unique fresh proxies from all online sources.`,
  );

  // Load and filter out blacklisted proxies
  const failedSet = loadFailedProxies(
    targetMode === "github"
      ? "github"
      : targetMode === "chatgpt"
        ? "chatgpt"
        : targetMode === "all"
          ? null
          : "outlook",
  );
  const rawAll = Array.from(new Set([...uniqueExisting, ...uniqueScraped]));
  const allToTest = rawAll.filter((p) => !failedSet.has(extractHostPort(p)));
  if (rawAll.length > allToTest.length) {
    console.log(
      `[*] Excluded ${rawAll.length - allToTest.length} proxies previously blacklisted for ${targetLabel}.`,
    );
  }
  console.log(
    `\n[*] Testing total ${allToTest.length} proxies against [${targetLabel}] (Concurrency: ${CONCURRENCY})...\n`,
  );

  // Count tested per source
  for (const proxyUrl of allToTest) {
    const hp = extractHostPort(proxyUrl);
    const sources = proxySourceMap.get(hp);
    if (sources) {
      for (const src of Object.values(sourceStats)) {
        if (sources.has(src.name)) {
          src.tested++;
        }
      }
    }
  }

  let testedCount = 0;
  const aliveList = [];
  let deadCount = 0;

  await runPool(
    allToTest,
    CONCURRENCY,
    async (proxyUrl) => {
      const res = await testProxy(proxyUrl, TIMEOUT_MS, MAX_LATENCY_MS);
      testedCount++;
      const hp = extractHostPort(proxyUrl);
      const sourcesSet = proxySourceMap.get(hp);
      let primarySource = "Unknown Source";
      if (sourcesSet && sourcesSet.size > 0) {
        const arr = Array.from(sourcesSet);
        primarySource = arr.find((s) => s !== "Existing Active File") || arr[0];
      }
      res.source = primarySource;

      if (res.alive) {
        aliveList.push(res);

        // Increment alive in sourceStats
        if (sourcesSet) {
          for (const src of Object.values(sourceStats)) {
            if (sourcesSet.has(src.name)) {
              src.alive++;
              src.aliveProxies.push(proxyUrl);
            }
          }
        }

        console.log(
          `  [${testedCount}/${allToTest.length}] ⚡ VERIFIED ALIVE: ${res.proxy} (Avg: ${res.latencyMs}ms | ${res.details} | Source: ${sourceLabel})`,
        );
        // Progressive save
        const sorted = [...aliveList].sort((a, b) => a.latencyMs - b.latencyMs);
        saveActiveProxies(sorted);
      } else {
        deadCount++;
        if (testedCount % 50 === 0 || testedCount === allToTest.length) {
          process.stdout.write(
            `  ... Tested ${testedCount}/${allToTest.length} proxies (${aliveList.length}/${TARGET_ALIVE_COUNT} alive)\r`,
          );
        }
      }
      return res;
    },
    () => aliveList.length >= TARGET_ALIVE_COUNT,
  );

  // Final sort and save ONLY alive proxies
  aliveList.sort((a, b) => a.latencyMs - b.latencyMs);
  saveActiveProxies(aliveList);

  // Save source statistics to data/proxy_sources_stats.json
  saveSourceStats(sourceStats, targetLabel);

  console.log(`\n\n========================================`);
  console.log(`  PROXY SCAN RESULTS [${targetLabel}]`);
  console.log(`========================================`);
  console.log(`  Total Tested: ${allToTest.length}`);
  console.log(`  ✅ Alive:      ${aliveList.length}`);
  console.log(`  ❌ Dead:       ${deadCount}`);
  console.log(`========================================\n`);

  // Print Detailed Proxy Sources Quality Breakdown Table
  const sortedStats = Object.values(sourceStats).sort(
    (a, b) => b.alive - a.alive || b.tested - a.tested,
  );
  console.log(
    `========================================================================================================`,
  );
  console.log(
    `  📊 PROXY SOURCE QUALITY BREAKDOWN (Ranked by Working Proxies)`,
  );
  console.log(
    `========================================================================================================`,
  );
  console.log(
    `  ${"#".padEnd(3)} | ${"Source Name".padEnd(28)} | ${"Scraped".padEnd(9)} | ${"Tested".padEnd(8)} | ${"Alive".padEnd(7)} | ${"Rate".padEnd(8)} | Quality Rating`,
  );
  console.log(
    `--------------------------------------------------------------------------------------------------------`,
  );

  sortedStats.forEach((s, idx) => {
    const rate =
      s.tested > 0 ? `${((s.alive / s.tested) * 100).toFixed(2)}%` : "0.00%";
    let rating = "❌ Dead / Low Yield";
    if (s.alive >= 3) {
      rating = "⭐⭐⭐ High Yield (Top Quality)";
    } else if (s.alive >= 1) {
      rating = "⭐⭐ Working (Good)";
    } else if (s.tested > 0) {
      rating = "⚠️ 0 Alive (Dead List)";
    } else {
      rating = "⚪ Not Tested";
    }

    console.log(
      `  ${String(idx + 1).padEnd(3)} | ${s.name.padEnd(28)} | ${String(s.fetched).padEnd(9)} | ${String(s.tested).padEnd(8)} | ${String(s.alive).padEnd(7)} | ${rate.padEnd(8)} | ${rating}`,
    );
  });

  console.log(
    `========================================================================================================`,
  );
  console.log(`💡 Stats saved to: ${STATS_FILE}`);
  console.log(
    `💡 Tip: To run with top recommended sources only: npm run proxy:fetch -- --best`,
  );
  console.log(
    `💡 Tip: To filter specific source(s): node tools/fetch_and_test_proxies.js --sources=geonode,proxyscrape_v2`,
  );
  console.log(
    `========================================================================================================\n`,
  );

  console.log(
    `✅ Successfully saved ONLY ${aliveList.length} active proxies to ${PROXY_FILE}`,
  );
}

main().catch(console.error);
