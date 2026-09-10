const path = require("path");
const { loadEnv } = require("../utils/env.js");
const { spawn } = require("child_process");

loadEnv();

const { selectProxy } = require("../utils/proxy.js");

// Optional static proxy override (one per line). Empty = auto-select from http_proxies.txt or PROXY env.
const targetScript = process.argv[2] || "registrars/register.js";
const serviceTarget = targetScript.includes("github")
  ? "github"
  : targetScript.includes("outlook")
    ? "outlook"
    : targetScript.includes("chatgpt")
      ? "chatgpt"
      : targetScript.includes("genspark")
        ? "genspark"
        : targetScript.includes("xl")
          ? "xl"
          : process.env.PROXY_TARGET_SERVICE || "all";

const PROXIES = [];

const fs = require("fs");

let count = 0;
let consecutiveErrors = 0;
let currentChild = null;
let isStopping = false;

function cleanOldTempProfiles() {
  try {
    const registrarsDir = path.resolve(__dirname, "..", "registrars");
    if (!fs.existsSync(registrarsDir)) return;
    const entries = fs.readdirSync(registrarsDir);
    const now = Date.now();
    for (const entry of entries) {
      if (
        entry.startsWith(".cloak_profile_tmp_") ||
        entry.startsWith(".chrome_profile_tmp_")
      ) {
        const fullPath = path.join(registrarsDir, entry);
        try {
          const stats = fs.statSync(fullPath);
          // Clean profiles older than 5 minutes
          if (now - stats.mtimeMs > 5 * 60 * 1000) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function getProxy() {
  if (
    process.argv.includes("--direct") ||
    process.argv.includes("--no-proxy")
  ) {
    return null;
  }
  if (PROXIES.length > 0) {
    return PROXIES[count % PROXIES.length];
  }
  // Ambil secara dinamis dari http_proxies.txt di setiap iterasi.
  // Jika proxy kosong/sedikit, background fetcher akan otomatis terpicu sesuai serviceTarget (misal: --xl).
  const dynamicProxy = selectProxy(process.env.PROXY || "", {
    autoFetch: true,
    service: serviceTarget,
  });
  if (dynamicProxy) {
    return dynamicProxy;
  }
  // Jika belum ada proxy yang siap/lolos uji, fallback ke null (direct) agar eksekusi tetap berjalan lancar.
  return null;
}

function run() {
  if (isStopping) return;
  count++;
  cleanOldTempProfiles();
  const proxy = getProxy();

  let proxyDisplay = "NO PROXY";
  if (proxy) {
    try {
      const u = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
      const user = decodeURIComponent(u.username || "");
      proxyDisplay = user
        ? `User/Session: ${user} | Server: ${u.host}`
        : u.host;
    } catch {
      proxyDisplay = proxy;
    }
  }

  console.log(`\n=== RUN #${count} [${proxyDisplay}] ===\n`);

  const targetScript = process.argv[2] || "registrars/register.js";
  const targetArgs = process.argv.slice(3);
  const isBatchScript =
    targetScript.includes("graph") || targetScript.includes("batch");

  const env = { ...process.env };
  if (proxy && !isBatchScript) env.PROXY = proxy;
  if (process.argv.includes("--outlook")) env.GITHUB_SIGNUP_MODE = "outlook";
  const PROJECT_ROOT = path.resolve(__dirname, "..");

  currentChild = spawn("node", [targetScript, ...targetArgs], {
    stdio: "inherit",
    cwd: PROJECT_ROOT,
    env,
  });

  currentChild.on("exit", (code) => {
    currentChild = null;
    if (isStopping) return;

    if (code === 0) {
      consecutiveErrors = 0;
      console.log(`\nRun #${count} completed successfully.`);
    } else {
      consecutiveErrors++;
      console.log(
        `\nRun #${count} stopped (code ${code}) [${consecutiveErrors}x beruntun].`,
      );
    }

    if (code === 99) {
      const idleMinutes = Number(process.env.LOOP_IDLE_MINUTES || 30);
      console.log(
        `\n[INFO] All target accounts have refresh tokens (code 99). Sleeping for ${idleMinutes} minutes before next check... Container remains alive.`,
      );
      const delay = idleMinutes * 60 * 1000;
      setTimeout(run, delay);
      return;
    }
    if (code === 88) {
      console.log(
        `\nRun #${count} hit rate limit (code 88). Sleeping this thread for 5 minutes...`,
      );
      const delay = 5 * 60 * 1000;
      setTimeout(run, delay);
      return;
    }
    if (code === 77) {
      console.log(
        `\nRun #${count} hit security/captcha cooldown (code 77). Sleeping this thread for 3 minutes...`,
      );
      const delay = 3 * 60 * 1000;
      setTimeout(run, delay);
      return;
    }

    let delay;
    if (consecutiveErrors >= 3) {
      delay = 3 * 60 * 1000; // 3 menit cooldown jika gagal 3x beruntun
      console.log(
        `\n⏳ [COOLDOWN] Terjadi ${consecutiveErrors}x gagal beruntun. Menunggu 3 menit agar sistem/IP kembali normal...`,
      );
    } else if (process.env.LOOP_DELAY_SEC) {
      delay = Number(process.env.LOOP_DELAY_SEC) * 1000;
    } else if (process.env.LOOP_DELAY) {
      delay = Number(process.env.LOOP_DELAY);
    } else {
      // 5-10s on success, 12-18s on error/stop
      delay =
        code === 0
          ? 5000 + Math.floor(Math.random() * 5000)
          : 12000 + Math.floor(Math.random() * 5000);
    }
    console.log(`Waiting ${Math.round(delay / 1000)}s before next run...\n`);
    setTimeout(run, delay);
  });
}

function handleTermination() {
  if (isStopping) return;
  isStopping = true;
  console.log("\n[loop.js] Stopping runner and cleaning child processes...");
  if (currentChild) {
    try {
      currentChild.kill("SIGTERM");
    } catch (_) {}
    setTimeout(() => {
      if (currentChild) {
        try {
          currentChild.kill("SIGKILL");
        } catch (_) {}
      }
      process.exit(0);
    }, 1500);
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", handleTermination);
process.on("SIGTERM", handleTermination);

run();
