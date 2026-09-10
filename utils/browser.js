const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium, firefox } = require("playwright-extra");

function getHomeDir() {
  return os.homedir();
}

function browserTypeFor(executablePath = "") {
  return isCamoufox(executablePath) ? firefox : chromium;
}

function isCamoufox(executablePath = "") {
  const value = (executablePath || "").toLowerCase();
  if (value.includes("cloak")) return false;
  return value.includes("camoufox") || value.includes("comufox");
}

function isAntiDetectBrowser(executablePath = "") {
  const lower = (executablePath || "").toLowerCase();
  return (
    lower.includes("camoufox") ||
    lower.includes("comufox") ||
    lower.includes("cloak")
  );
}

function resolveBrowserExecutablePath(executablePath = "") {
  const value = (executablePath || "").trim();
  const lower = value.toLowerCase();
  const home = getHomeDir();

  // If the exact path provided exists, use it immediately
  if (value && fs.existsSync(value)) return value;

  if (
    lower === "cloakbrowser" ||
    lower === "cloak" ||
    lower.includes("cloak")
  ) {
    const cloakDir = path.join(home, ".cloakbrowser");
    if (fs.existsSync(cloakDir)) {
      try {
        const entries = fs.readdirSync(cloakDir);
        for (const entry of entries) {
          const chromePath = path.join(cloakDir, entry, "chrome");
          if (fs.existsSync(chromePath)) return chromePath;
        }
      } catch {}
    }
    // Fallback: check playwright chromium if cloak directory is not mounted
    const pwDir = "/ms-playwright";
    if (fs.existsSync(pwDir)) {
      try {
        const entries = fs.readdirSync(pwDir);
        for (const entry of entries) {
          const chromePath = path.join(
            pwDir,
            entry,
            "chrome-linux64",
            "chrome",
          );
          if (fs.existsSync(chromePath)) return chromePath;
          const altPath = path.join(pwDir, entry, "chrome-linux", "chrome");
          if (fs.existsSync(altPath)) return altPath;
        }
      } catch {}
    }
    if (fs.existsSync("/usr/bin/google-chrome-stable"))
      return "/usr/bin/google-chrome-stable";
    if (fs.existsSync("/usr/bin/chromium-browser"))
      return "/usr/bin/chromium-browser";
    if (fs.existsSync("/usr/bin/chromium")) return "/usr/bin/chromium";
    const cloakDefault = path.join(
      home,
      ".cloakbrowser",
      "chromium-146.0.7680.177.5",
      "chrome",
    );
    if (fs.existsSync(cloakDefault)) return cloakDefault;
  }

  if (
    lower === "camoufox" ||
    lower === "comufox" ||
    lower.includes("camoufox")
  ) {
    const defaultCache = path.join(home, ".cache", "camoufox", "camoufox");
    if (fs.existsSync(defaultCache)) return defaultCache;
    const officialDir = path.join(
      home,
      ".cache",
      "camoufox",
      "browsers",
      "official",
    );
    if (fs.existsSync(officialDir)) {
      try {
        const versions = fs.readdirSync(officialDir);
        for (const v of versions) {
          const binPath = path.join(officialDir, v, "camoufox");
          if (fs.existsSync(binPath)) return binPath;
        }
      } catch {}
    }
  }

  // Fallback to installed browsers on macOS & Linux
  const fallbackCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/brave-browser",
  ];
  for (const candidate of fallbackCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return value;
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const {
  loadProxyList,
  ensureProxiesAvailable,
  triggerBackgroundProxyFetch,
  isFetcherRunning,
  selectProxy,
  proxyFromUrl,
  isProxyError,
  markProxyDead,
  handleProxyFailure,
} = require("./proxy.js");

const BLOCKED_DOMAINS = [
  "clarity.ms",
  "google-analytics.com",
  "googletagmanager.com",
  "bat.bing.com",
  "c.msn.com",
  "doubleclick.net",
  "adnxs.com",
  "scorecardresearch.com",
  "smartlook.com",
  "hotjar.com",
  "sentry.io",
  "analytics.",
  "telemetry.",
  "track.",
  "metrics.",
  "connect.facebook.net",
  "analytics.tiktok.com",
  "useinsider.com",
  "moengage.com",
  "webengage.com",
  "facebook.com/tr",
];

/**
 * Intercept and abort heavy, unnecessary network requests (analytics, telemetry, ads, video/media, fonts, images)
 * to speed up browsing over slow proxies without breaking captchas or core app functionality.
 */
async function setupNetworkOptimization(page, { blockImages = false, blockFonts = true } = {}) {
  if (!page || typeof page.route !== "function") return;
  try {
    await page.route("**/*", (route) => {
      const req = route.request();
      const url = req.url().toLowerCase();
      const resourceType = req.resourceType();

      // ALWAYS allow captcha, challenge, verification & authentication endpoints + GitHub & Microsoft & OpenAI / ChatGPT
      if (
        url.includes("github.com") ||
        url.includes("githubassets.com") ||
        url.includes("githubusercontent.com") ||
        url.includes("octocaptcha.com") ||
        url.includes("githubcopilot.com") ||
        url.includes("arkoselabs") ||
        url.includes("hsprotect") ||
        url.includes("captcha") ||
        url.includes("challenge") ||
        url.includes("datadome") ||
        url.includes("turnstile") ||
        url.includes("perimeterx") ||
        url.includes("live.com") ||
        url.includes("microsoft.com") ||
        url.includes("msauth.net") ||
        url.includes("msftauth.net") ||
        url.includes("chatgpt.com") ||
        url.includes("openai.com") ||
        url.includes("oaistatic.com") ||
        url.includes("oaiusercontent.com")
      ) {
        return route.continue().catch(() => {});
      }

      // Block heavy video/audio media
      if (resourceType === "media") {
        return route.abort().catch(() => {});
      }

      // Block fonts for faster loading
      if (blockFonts && resourceType === "font") {
        return route.abort().catch(() => {});
      }

      // Block images if requested (keep captcha/qr allowed)
      if (blockImages && resourceType === "image") {
        if (url.includes("qr") || url.includes("captcha")) {
          return route.continue().catch(() => {});
        }
        return route.abort().catch(() => {});
      }

      // Block known analytics, telemetry, and tracking domains
      if (BLOCKED_DOMAINS.some((d) => url.includes(d))) {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });
  } catch (_) {}
}

function getFirefoxUserAgent() {
  const versions = ["124.0", "125.0", "126.0", "127.0", "128.0"];
  const version = versions[Math.floor(Math.random() * versions.length)];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version.split(".")[0]}.0) Gecko/20100101 Firefox/${version}`;
}

module.exports = {
  browserTypeFor,
  isCamoufox,
  isAntiDetectBrowser,
  resolveBrowserExecutablePath,
  envFlag,
  proxyFromUrl,
  getFirefoxUserAgent,
  setupNetworkOptimization,
  loadProxyList,
  ensureProxiesAvailable,
  triggerBackgroundProxyFetch,
  isFetcherRunning,
  selectProxy,
  isProxyError,
  markProxyDead,
  handleProxyFailure,
};
