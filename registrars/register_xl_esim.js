// registrars/register_xl_esim.js — Auto-claim XL Axiata Free Trial eSIM via Direct API & Stealth Token Provider
const { loadEnv } = require("../utils/env.js");
loadEnv();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth")();
chromium.use(StealthPlugin);

const {
  resolveBrowserExecutablePath,
  envFlag,
  selectProxy,
  proxyFromUrl,
  handleProxyFailure,
  isProxyError,
} = require("../utils/browser.js");
const { sleep, gotoWithRetry } = require("../utils/helpers.js");
const { randomFirstName, randomLastName } = require("../utils/names.js");
const { resolveEmail, waitForOtp } = require("../utils/email.js");
const gmail = require("../utils/gmail.js");

function shouldRunHeadless() {
  if (process.argv.includes("--headless")) return true;
  if (process.argv.includes("--headed")) return false;
  return envFlag("HEADLESS", true);
}

const OUTPUT_DIR = path.join(__dirname, "..", "data", "xl_esim");

const CONFIG = {
  claimUrl: "https://www.xl.co.id/esim-trial/claim",
  outputDir: OUTPUT_DIR,
  outputFile: path.join(OUTPUT_DIR, "xl_esim_accounts.csv"),
  headless: shouldRunHeadless(),
  timeout: Number(process.env.STEP_TIMEOUT_MS || 60000),
  otpTimeout: 120000,
  proxy: process.env.PROXY || "",
};

function ensureCsvHeader() {
  if (!fs.existsSync(CONFIG.outputDir))
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  if (!fs.existsSync(CONFIG.outputFile)) {
    fs.writeFileSync(
      CONFIG.outputFile,
      '"email","phone_number","puk","activation_code","full_name","whatsapp","qr_code_file","status","created_at"\n',
      "utf8",
    );
  }
}

function appendToCsv({
  email,
  phoneNumber,
  puk = "",
  activationCode = "",
  fullName,
  whatsapp,
  qrCodeFile = "",
  status = "SUCCESS",
}) {
  ensureCsvHeader();
  const createdAt = new Date().toISOString();
  const line = `"${email}","${phoneNumber}","${puk}","${activationCode}","${fullName}","${whatsapp}","${qrCodeFile}","${status}","${createdAt}"\n`;
  fs.appendFileSync(CONFIG.outputFile, line, "utf8");
}

function generateIndonesianPhone() {
  const prefixes = ["0812", "0813", "0821", "0857", "0858", "0877", "0878"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.floor(10000000 + Math.random() * 90000000)
    .toString()
    .slice(0, 7);
  return `${prefix}${suffix}`;
}

const https = require("https");
const { HttpsProxyAgent } = require("https-proxy-agent");

const API_TIMEOUT_MS = Number(process.env.XL_API_TIMEOUT_SEC || 18) * 1000;

function executeSingleRequest(url, options = {}, body = null, proxyUrl = "", timeoutMs = API_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let finished = false;

    const opts = { ...options };
    if (proxyUrl) {
      try {
        opts.agent = new HttpsProxyAgent(proxyUrl);
      } catch (_) {}
    }

    const cleanup = () => {
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const req = https.request(url, opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        cleanup();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), raw: data });
        } catch (_) {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });

    req.on("error", (err) => {
      if (finished) return;
      cleanup();
      reject(err);
    });

    // Hard JavaScript timer agar koneksi tidak pernah freeze/stuck saat proxy tunnel gantung
    timer = setTimeout(() => {
      if (finished) return;
      cleanup();
      try {
        req.destroy();
      } catch (_) {}
      reject(new Error(`ETIMEDOUT: API request timeout (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function httpsApiRequest(url, options = {}, body = null, proxyUrl = "", maxRetries = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await executeSingleRequest(url, options, body, proxyUrl);
    } catch (err) {
      lastError = err;
      const isNetworkErr =
        err.message.includes("ETIMEDOUT") ||
        err.message.includes("ECONNRESET") ||
        err.message.includes("socket hang up") ||
        err.message.includes("ENOTFOUND") ||
        err.message.includes("EHOSTUNREACH") ||
        err.message.includes("ECONNREFUSED");

      if (isNetworkErr && attempt < maxRetries) {
        console.log(
          `  ⚠️  [API Request] Attempt ${attempt}/${maxRetries} terkendala (${err.message}). Mencoba ulang dalam 1.5s...`,
        );
        await sleep(1500);
        continue;
      }
      break;
    }
  }

  // Jika proxy gagal/timeout setelah retry, coba fallback direct sebagai penyelamat terakhir (terutama saat OTP sudah masuk)
  if (proxyUrl && lastError) {
    try {
      console.log(
        `  ⚠️  [API Request] Proxy terkendala (${lastError.message}). Mencoba fallback direct...`,
      );
      return await executeSingleRequest(url, options, body, "", 20000);
    } catch (directErr) {
      throw lastError;
    }
  }

  throw lastError;
}

const jupiterUrl = "https://jupiter-mw-webxl.xlaxiata.my.id";

async function getClientTokenDirect(proxyUrl = "") {
  try {
    const res = await httpsApiRequest(
      "https://www.xl.co.id/api/auth/client-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      {},
      proxyUrl,
    );
    return res.data?.token || null;
  } catch (_) {
    return null;
  }
}

async function run() {
  ensureCsvHeader();
  console.log("=".repeat(60));
  console.log("  XL AXIATA FREE TRIAL eSIM REGISTRATION (DIRECT API)");
  console.log("=".repeat(60));

  // 1. Select Proxy
  const isDirect =
    process.argv.includes("--no-proxy") ||
    process.argv.includes("--direct") ||
    envFlag("DISABLE_PROXY", false);

  const cliProxy =
    process.argv.find((a) => a.startsWith("--proxy="))?.split("=")[1] ||
    (process.argv.includes("--proxy")
      ? process.argv[process.argv.indexOf("--proxy") + 1]
      : null) ||
    process.env.PROXY ||
    "";

  // Prioritaskan proxy jika tersedia. Jika kosong, auto-fetch background proxy against XL dan fallback ke direct.
  let selectedProxy = isDirect
    ? ""
    : (cliProxy ? cliProxy : selectProxy("", { service: "xl", autoFetch: true }));

  let preClientToken = null;
  if (selectedProxy) {
    try {
      // Test proxy terlebih dahulu dengan timeout 8s agar tidak meloloskan proxy mati ke Chromium
      const testRes = await executeSingleRequest(
        "https://www.xl.co.id/api/auth/client-token",
        { method: "POST", headers: { "Content-Type": "application/json" } },
        {},
        selectedProxy,
        8000,
      );
      preClientToken = testRes.data?.token || null;
    } catch (proxyErr) {
      console.log(
        `  ⚠️  Proxy ${selectedProxy} mati/lambat (${proxyErr.message}). Menghapus & beralih ke Direct...`,
      );
      handleProxyFailure(selectedProxy, proxyErr.message, { service: "xl", force: true });
      selectedProxy = "";
    }
  }

  if (!preClientToken) {
    try {
      const directRes = await executeSingleRequest(
        "https://www.xl.co.id/api/auth/client-token",
        { method: "POST", headers: { "Content-Type": "application/json" } },
        {},
        "",
        8000,
      );
      preClientToken = directRes.data?.token || null;
    } catch (_) {}
  }

  const proxyConfig = selectedProxy ? proxyFromUrl(selectedProxy) : null;
  if (proxyConfig) {
    const masked = String(selectedProxy).replace(
      /:\/\/([^:]+):([^@]+)@/,
      "://***:***@",
    );
    console.log(`  Menggunakan Proxy: ${masked}`);
  } else {
    console.log("  Koneksi Langsung (Tanpa Proxy)...");
  }

  // 2. Resolve fresh email account (Gmail Dot-Trick or Outlook) & Fast Eligibility Pre-Check
  const isGmailMode =
    process.argv.includes("--gmail") || process.env.EMAIL_MODE === "gmail";

  let email = "";
  let outlookAccount = null;
  let isEligibleVerified = false;

  if (isGmailMode) {
    console.log("\n[1/6] Mengambil alias Gmail Dot-Trick & verifikasi cepat...");
    const usedEmails = new Set();
    if (fs.existsSync(CONFIG.outputFile)) {
      try {
        const lines = fs
          .readFileSync(CONFIG.outputFile, "utf8")
          .split("\n")
          .filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i]
            .split(",")
            .map((p) => p.replace(/^"|"$/g, "").trim().toLowerCase());
          if (parts[0]) usedEmails.add(parts[0]);
        }
      } catch {}
    }

    let fresh = null;
    for (let checkAttempt = 0; checkAttempt < 8; checkAttempt++) {
      fresh = gmail.pickFreshGmailAlias(usedEmails);
      email = fresh.email;
      usedEmails.add(email.toLowerCase());

      if (preClientToken) {
        const eligCheck = await httpsApiRequest(
          `${jupiterUrl}/esim/free-trial/check-eligibility`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${preClientToken}`,
              Origin: "https://www.xl.co.id",
              Referer: "https://www.xl.co.id/esim-trial/claim",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          },
          { email },
          selectedProxy,
        ).catch(() => null);

        if (eligCheck?.data?.error || eligCheck?.data?.data?.code === "01") {
          const errMsg =
            eligCheck?.data?.data?.message ||
            eligCheck?.data?.message ||
            "Email has been used";
          console.log(
            `  ⚠️  [ALREADY USED] ${email} sudah pernah digunakan (${errMsg}). Menandai & mencari alias baru...`,
          );
          appendToCsv({
            email,
            phoneNumber: "-",
            puk: "-",
            activationCode: "-",
            fullName: "-",
            whatsapp: "-",
            status: "ALREADY_USED",
          });
          continue;
        }
        isEligibleVerified = true;
      }
      break;
    }

    console.log(
      `  Akun Gmail terpilih (Dot-Trick): ${email} (Induk: ${fresh?.baseEmail || "Gmail"})`,
    );
    if (isEligibleVerified) {
      console.log(`  ✅ Verifikasi instan: Email memenuhi syarat (Eligible)!`);
    }
  } else {
    console.log("\n[1/6] Memilih akun Outlook dari data/outlook_accounts.csv...");
    const res = await resolveEmail(null, {
      mode: "outlook",
      outputFile: CONFIG.outputFile,
    });
    email = res.email;
    outlookAccount = res.outlookAccount;
    console.log(`  Akun Outlook terpilih: ${email}`);
  }

  const fullName = `${randomFirstName()} ${randomLastName()}`;
  const whatsappNumber = generateIndonesianPhone();
  console.log(`  Nama Lengkap: ${fullName}`);
  console.log(`  Nomor WhatsApp: ${whatsappNumber}`);

  console.log("\n[2/6] Membuka Stealth Token Provider & Session...");

  let browser = null;
  let context = null;
  let page = null;
  let tempProfileDir = "";

  const threadIdx = parseInt(process.env.THREAD_INDEX || "0", 10);
  const posX = (threadIdx % 3) * 450;
  const posY = Math.floor(threadIdx / 3) * 350;

  try {
    tempProfileDir = path.join(
      __dirname,
      "..",
      "scratch",
      `.chrome_profile_xl_${process.env.THREAD_INDEX || "0"}_${Date.now()}`,
    );

    context = await chromium.launchPersistentContext(tempProfileDir, {
      headless: CONFIG.headless,
      viewport: { width: 1280, height: 720 },
      locale: "id-ID",
      timezoneId: "Asia/Jakarta",
      ignoreHTTPSErrors: true,
      proxy: proxyConfig || undefined,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        `--window-position=${posX},${posY}`,
      ],
    });

    page =
      context.pages().length > 0
        ? context.pages()[0]
        : await context.newPage();

    // Navigasi ke claim page untuk inisialisasi session, cookies, dan origin
    console.log("  Menghubungkan session ke XL eSIM...");
    await gotoWithRetry(page, CONFIG.claimUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#claim-name, input, body", { timeout: 25000 }).catch(() => {});

    // Pastikan reCAPTCHA script siap
    await page.evaluate(() => {
      const siteKey = "6LeSD6EtAAAAAEhlHq07pv8_6JawCKeXcSxHMrRA";
      if (!document.querySelector(`script[src*="${siteKey}"]`)) {
        const s = document.createElement("script");
        s.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
        document.head.appendChild(s);
      }
    }).catch(() => {});

    await page.waitForFunction(
      () => typeof window.grecaptcha !== "undefined" && typeof window.grecaptcha.execute === "function",
      { timeout: 15000 },
    ).catch(() => {});

    let clientIp = "";

    // Helper reCAPTCHA token generator (dengan in-page execution, public IP, dan fallback direct API validation)
    async function getFormToken(emailTarget, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(`  [reCAPTCHA] Mengambil token reCAPTCHA (percobaan ${attempt}/${retries})...`);

          const rcResult = await Promise.race([
            page.evaluate(async (email) => {
              const key = "6LeSD6EtAAAAAEhlHq07pv8_6JawCKeXcSxHMrRA";
              if (!window.grecaptcha || typeof window.grecaptcha.execute !== "function") {
                if (!document.querySelector(`script[src*="${key}"]`)) {
                  const s = document.createElement("script");
                  s.src = `https://www.google.com/recaptcha/api.js?render=${key}`;
                  document.head.appendChild(s);
                }
                const ready = await new Promise((resolve) => {
                  let checks = 0;
                  const intId = setInterval(() => {
                    checks++;
                    if (window.grecaptcha && typeof window.grecaptcha.execute === "function") {
                      clearInterval(intId);
                      resolve(true);
                    } else if (checks > 40) {
                      clearInterval(intId);
                      resolve(false);
                    }
                  }, 200);
                });
                if (!ready) return { error: "grecaptcha_not_loaded" };
              }

              return new Promise((resolve) => {
                const timeoutId = setTimeout(() => resolve({ error: "recaptcha_timeout" }), 10000);
                try {
                  window.grecaptcha.ready(async () => {
                    try {
                      // Ambil public IP seperti halnya di frontend XL (api.ipify.org)
                      let ip = "";
                      try {
                        const ipRes = await fetch("https://api.ipify.org/?format=json");
                        const ipJson = await ipRes.json();
                        ip = ipJson?.ip || "";
                      } catch (e) {}

                      const token = await window.grecaptcha.execute(key, {
                        action: "esim_trial_claim",
                      });

                      if (!token) {
                        clearTimeout(timeoutId);
                        return resolve({ error: "token_empty", ip });
                      }

                      // Langsung validasi token ke Next.js internal API di dalam page context
                      const postRes = await fetch("/api/esim-trial/captcha", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          token,
                          email,
                          ip,
                        }),
                      });

                      const resJson = await postRes.json().catch(() => ({}));
                      clearTimeout(timeoutId);
                      const formToken =
                        resJson?.data?.formToken || resJson?.formToken || null;
                      if (formToken) {
                        return resolve({ formToken, ip, token });
                      }
                      return resolve({
                        error: resJson?.errors || "captcha_rejected",
                        ip,
                        token,
                      });
                    } catch (e) {
                      clearTimeout(timeoutId);
                      resolve({ error: e.message || "execute_failed" });
                    }
                  });
                } catch (e) {
                  clearTimeout(timeoutId);
                  resolve({ error: e.message || "ready_failed" });
                }
              });
            }, emailTarget),
            sleep(16000).then(() => ({ error: "evaluate_timeout" })),
          ]);

          if (rcResult?.ip) {
            clientIp = rcResult.ip;
          }

          if (rcResult?.formToken) {
            console.log(`  [reCAPTCHA] FormToken berhasil didapatkan!`);
            return rcResult.formToken;
          }

          // Fallback ke Node API jika in-page fetch gagal tapi token reCAPTCHA berhasil di-generate
          if (rcResult?.token) {
            console.log(`  [reCAPTCHA] Mencoba verifikasi token via Node API fallback...`);
            const captchaRes = await httpsApiRequest(
              "https://www.xl.co.id/api/esim-trial/captcha",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
              },
              {
                token: rcResult.token,
                email: emailTarget,
                ip: rcResult.ip || clientIp || "",
              },
              selectedProxy,
            );

            const formToken =
              captchaRes.data?.data?.formToken || captchaRes.data?.formToken || null;
            if (formToken) {
              console.log(`  [reCAPTCHA] FormToken berhasil didapatkan via Node fallback!`);
              return formToken;
            }
          }

          console.log(`  ⚠️  [reCAPTCHA] Percobaan ${attempt} gagal (${rcResult?.error || "token_empty"})...`);
          if (attempt < retries) {
            await sleep(1500);
          }
        } catch (err) {
          console.log(`  ⚠️  [reCAPTCHA] Error percobaan ${attempt}: ${err.message}`);
          if (attempt < retries) {
            await sleep(1500);
          }
        }
      }
      return null;
    }

    // Helper client-token generator
    async function getClientToken() {
      return page.evaluate(async () => {
        const res = await fetch("/api/auth/client-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const json = await res.json().catch(() => ({}));
        return json?.token || null;
      });
    }

    // 3. Request Client Token & Send OTP
    console.log("\n[3/6] Meminta Client Token & Mempersiapkan sesi...");
    const clientToken = preClientToken || (await getClientToken());
    if (!clientToken) {
      throw new Error("Gagal mengambil client token dari /api/auth/client-token");
    }

    // Check Eligibility jika belum terverifikasi di step awal
    if (!isEligibleVerified) {
      console.log("  Memeriksa kelayakan email...");
      const eligRes = await httpsApiRequest(
        `${jupiterUrl}/esim/free-trial/check-eligibility`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${clientToken}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Origin: "https://www.xl.co.id",
            Referer: "https://www.xl.co.id/esim-trial/claim",
          },
        },
        { email },
        selectedProxy,
      );

      if (eligRes.data?.error || eligRes.data?.data?.code === "01") {
        const errMsg =
          eligRes.data?.data?.message ||
          eligRes.data?.message ||
          "Email has been used";
        throw new Error(`Respon XL: ${errMsg}`);
      }
    }

    console.log("  Mengirim OTP ke email...");

    const sendOtpRes = await httpsApiRequest(
      `${jupiterUrl}/esim/send-otp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clientToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Origin: "https://www.xl.co.id",
          Referer: "https://www.xl.co.id/esim-trial/claim",
        },
      },
      { email },
      selectedProxy,
    );

    if (sendOtpRes.status >= 400 || sendOtpRes.data?.data?.reason !== "OK") {
      const reason =
        sendOtpRes.data?.data?.reason ||
        sendOtpRes.data?.message ||
        sendOtpRes.data?.errors ||
        "Gagal mengirim OTP";
      throw new Error(`Respon XL Kirim OTP: ${reason}`);
    }

    const otpRequestedAt = Date.now();
    console.log("  ✅ OTP berhasil dikirim oleh XL!");

    // 4. Tunggu OTP masuk ke Gmail / Outlook
    console.log("\n[4/6] Menunggu kode OTP masuk...");
    let otpCode = null;
    if (isGmailMode) {
      console.log(`  Menunggu OTP masuk ke Gmail (${email})...`);
      otpCode = await gmail.waitForGmailOtp({
        email,
        timeout: CONFIG.otpTimeout,
        since: otpRequestedAt - 10000,
        interval: 2000,
      });
    } else {
      console.log(`  Menunggu OTP masuk ke Outlook (${email})...`);
      otpCode = await waitForOtp({
        mode: "outlook",
        email,
        account: outlookAccount,
        timeout: CONFIG.otpTimeout,
        since: otpRequestedAt - 10000,
        subjectContains: "OTP",
        interval: 1500,
      });
    }

    if (!otpCode) {
      throw new Error(
        `Gagal mendapatkan kode OTP untuk ${email} dalam ${CONFIG.otpTimeout / 1000}s`,
      );
    }
    console.log(`  🎉 KODE OTP DITERIMA: ${otpCode}`);

    // 5. Validasi OTP & Ambil Nomor eSIM
    console.log("\n[5/6] Memvalidasi OTP & Memilih nomor eSIM...");
    const valRes = await httpsApiRequest(
      `${jupiterUrl}/esim/validate-otp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clientToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Origin: "https://www.xl.co.id",
          Referer: "https://www.xl.co.id/esim-trial/claim",
        },
      },
      { email, otpCode },
      selectedProxy,
    );

    if (valRes.status >= 400 || valRes.data?.error) {
      const valErr =
        valRes.data?.message ||
        valRes.data?.errors ||
        "Kode OTP tidak valid atau kedaluwarsa";
      throw new Error(`Validasi OTP Gagal: ${valErr}`);
    }

    const numRes = await httpsApiRequest(
      `${jupiterUrl}/esim/free-trial/numbers?prefix=62&size=6`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${clientToken}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Origin: "https://www.xl.co.id",
          Referer: "https://www.xl.co.id/esim-trial/claim",
        },
      },
      null,
      selectedProxy,
    );

    const rawList =
      numRes.data?.data?.data || numRes.data?.data || [];
    const availableNumbers = Array.isArray(rawList) ? rawList : [];
    if (availableNumbers.length === 0) {
      throw new Error("Tidak ada nomor eSIM yang tersedia saat ini dari XL");
    }

    // 6. Final Claim eSIM via Direct API
    console.log("\n[6/6] Melakukan klaim akhir eSIM...");
    const formTokenFinal = await getFormToken(email);
    if (!formTokenFinal) {
      throw new Error("Koneksi proxy gagal mendapatkan token reCAPTCHA untuk sesi klaim akhir");
    }
    console.log(`  Captcha formToken Final: ${formTokenFinal.slice(0, 16)}...`);

    let claimSuccess = false;
    let chosenMsisdn = "";
    const remainingNumbers = [...availableNumbers];

    while (remainingNumbers.length > 0 && !claimSuccess) {
      const chosenIdx = Math.floor(Math.random() * remainingNumbers.length);
      chosenMsisdn = String(remainingNumbers.splice(chosenIdx, 1)[0]);
      console.log(`  Mencoba klaim dengan nomor eSIM: ${chosenMsisdn}`);

      const txId =
        "WEBESIMFT" +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 6).toUpperCase();
      const idempotencyKey = crypto.randomUUID();

      const claimHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clientToken}`,
        "X-Free-Trial-Session": formTokenFinal,
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Origin: "https://www.xl.co.id",
        Referer: "https://www.xl.co.id/esim-trial/claim",
      };
      if (clientIp) {
        claimHeaders["X-Forwarded-For"] = clientIp;
      }

      const claimRes = await httpsApiRequest(
        `${jupiterUrl}/esim/free-trial/claim`,
        {
          method: "POST",
          headers: claimHeaders,
        },
        {
          transactionId: txId,
          imei: "",
          referralCode: "",
          msisdn: chosenMsisdn,
          contact: {
            email,
            fullName,
            phoneNumber: whatsappNumber,
          },
        },
        selectedProxy,
      );

      const code = claimRes.data?.code || claimRes.data?.data?.code || "";
      const isOk =
        claimRes.status < 400 &&
        !claimRes.data?.errors &&
        (code === "00" ||
          code === "" ||
          claimRes.data?.status === "ok" ||
          !claimRes.data?.error);

      if (isOk) {
        claimSuccess = true;
        console.log(`  🎉 Status Klaim: Berhasil (200 OK) untuk nomor ${chosenMsisdn}`);
        break;
      }

      const errDetail =
        claimRes.data?.errors ||
        claimRes.data?.data?.message ||
        claimRes.data?.message ||
        "Gagal melakukan klaim eSIM";
      console.log(`  ⚠️  Klaim nomor ${chosenMsisdn} gagal: ${errDetail} (code: ${code})`);

      // Jika nomor sudah diambil pengguna lain, coba nomor lain yang tersisa
      const isTaken =
        /nomor|msisdn|taken|sudah diambil/i.test(String(errDetail)) ||
        ["02", "11", "12", "14", "15", "16", "19"].includes(code);
      if (isTaken && remainingNumbers.length > 0) {
        console.log(`  Nomor ${chosenMsisdn} sudah terpakai, mencoba nomor lain yang tersedia...`);
        await sleep(1000);
        continue;
      }

      throw new Error(`Respon XL Klaim: ${errDetail}`);
    }

    if (!claimSuccess) {
      throw new Error("Gagal melakukan klaim untuk semua nomor eSIM yang dicoba");
    }

    console.log(`  🎉 Status Klaim: Berhasil (200 OK)`);
    let displayPhone = chosenMsisdn.startsWith("62")
      ? "0" + chosenMsisdn.slice(2)
      : chosenMsisdn;
    if (displayPhone.length === 12) {
      displayPhone = `${displayPhone.slice(0, 4)} ${displayPhone.slice(4, 8)} ${displayPhone.slice(8)}`;
    }

    // Ambil QR Code, PUK & Activation Code dari email konfirmasi
    let pukCode = "";
    let activationCode = "";
    let qrCodeFilename = "";
    try {
      console.log("  Mengecek email konfirmasi untuk mengambil QR code, PUK & Activation Code...");
      if (isGmailMode) {
        const qrRes = await gmail.fetchGmailEsimQrCode({
          email,
          selectedNumber: chosenMsisdn,
          outputDir: CONFIG.outputDir,
          since: otpRequestedAt - 10000,
        });
        if (qrRes.success) {
          pukCode = qrRes.puk;
          activationCode = qrRes.activationCode || "";
          qrCodeFilename = qrRes.qrCodeFilename;
        }
      } else {
        const outlook = require("../utils/outlook.js");
        const token = await outlook.getAccessToken(email);
        for (let attempt = 0; attempt < 8; attempt++) {
          const msgs = await outlook.getMessages({
            email,
            top: 5,
            since: otpRequestedAt - 10000,
          });
          const qrMsg = msgs.find(
            (m) => m.subject && m.subject.includes("Scan QR Code"),
          );
          if (qrMsg) {
            const full = await outlook.getMessageBody(qrMsg.id, email);
            const cleanBody = full.body
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ");

            const pukMatch = cleanBody.match(/Kode PUK\s*:\s*(\d+)/i);
            if (pukMatch) pukCode = pukMatch[1];

            const actMatch = cleanBody.match(/Activation Code\s*(?:Activation Code)?\s*([A-Z0-9-]+)/i);
            if (actMatch) activationCode = actMatch[1];

            const res = await fetch(
              `https://graph.microsoft.com/v1.0/me/messages/${qrMsg.id}/attachments`,
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            );
            const data = await res.json();
            const att = data.value?.find(
              (a) => a.name && a.name.includes("qrcode"),
            );
            if (att) {
              qrCodeFilename = `qrcode_${chosenMsisdn || Date.now()}.png`;
              if (!fs.existsSync(CONFIG.outputDir)) {
                fs.mkdirSync(CONFIG.outputDir, { recursive: true });
              }
              fs.writeFileSync(
                path.join(CONFIG.outputDir, qrCodeFilename),
                Buffer.from(att.contentBytes, "base64"),
              );
              console.log(
                `  QR Code tersimpan: ${qrCodeFilename} (PUK: ${pukCode || "ada di email"}, Code: ${activationCode || "ada di email"})`,
              );
            }
            break;
          }
          await sleep(2500);
        }
      }
    } catch (err) {
      console.log(`  [WARN] Ambil QR code error: ${err.message}`);
    }

    // Simpan ke CSV di data/xl_esim/xl_esim_accounts.csv
    appendToCsv({
      email,
      phoneNumber: displayPhone,
      puk: pukCode,
      activationCode,
      fullName,
      whatsapp: whatsappNumber,
      qrCodeFile: qrCodeFilename,
      status: "SUCCESS",
    });

    console.log("\n" + "=".repeat(60));
    console.log("✅ SUKSES KLAIM XL FREE TRIAL eSIM!");
    console.log(`  Email      : ${email}`);
    console.log(`  Nomor eSIM : ${displayPhone}`);
    if (pukCode) console.log(`  Kode PUK   : ${pukCode}`);
    if (activationCode) console.log(`  Activation Code: ${activationCode}`);
    if (qrCodeFilename) console.log(`  File QR    : ${qrCodeFilename}`);
    console.log(`  Folder     : ${CONFIG.outputDir}`);
    console.log("=".repeat(60));
  } catch (err) {
    console.error(`\n❌ Gagal registrasi XL eSIM: ${err.message}`);
    if (selectedProxy) {
      handleProxyFailure(selectedProxy, err.message, { service: "xl", force: false });
    }
    if (page) {
      const errScreenshot = path.join(
        CONFIG.outputDir,
        `error_${Date.now()}.png`,
      );
      await page.screenshot({ path: errScreenshot }).catch(() => {});
    }
    const isAlreadyUsedErr =
      err.message.includes("sudah pernah digunakan") ||
      err.message.includes("Email has been used") ||
      err.message.toLowerCase().includes("has been used") ||
      err.message.includes("tidak memenuhi syarat") ||
      err.message.includes("Perangkat ini sudah");

    if (email && isAlreadyUsedErr) {
      console.log(
        `  [AUTO-EXCLUDE] Menyimpan ${email} dengan status ALREADY_USED ke CSV agar tidak dipilih lagi.`,
      );
      appendToCsv({
        email,
        phoneNumber: "-",
        puk: "-",
        activationCode: "-",
        fullName: fullName || "-",
        whatsapp: whatsappNumber || "-",
        status: "ALREADY_USED",
      });
    }
    throw err;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    try {
      if (tempProfileDir && fs.existsSync(tempProfileDir)) {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`\n[FATAL] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { run, generateIndonesianPhone };
