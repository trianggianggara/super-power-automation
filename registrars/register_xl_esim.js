// registrars/register_xl_esim.js — Auto-claim XL Axiata Free Trial eSIM using Playwright + Outlook
const { loadEnv } = require("../utils/env.js");
loadEnv();

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth")();
chromium.use(StealthPlugin);

const {
  isCamoufox,
  resolveBrowserExecutablePath,
  envFlag,
  selectProxy,
  proxyFromUrl,
} = require("../utils/browser.js");
const { sleep, gotoWithRetry } = require("../utils/helpers.js");
const { randomFirstName, randomLastName } = require("../utils/names.js");
const { resolveEmail, waitForOtp } = require("../utils/email.js");

const rawBrowserPath = resolveBrowserExecutablePath(
  process.env.BROWSER_EXECUTABLE_PATH || "",
);
const browserExecutable =
  rawBrowserPath && !isCamoufox(rawBrowserPath) && fs.existsSync(rawBrowserPath)
    ? rawBrowserPath
    : undefined;

function shouldRunHeadless() {
  if (process.argv.includes("--headless")) return true;
  if (process.argv.includes("--headed")) return false;
  // Default: false (buka browser langsung agar terlihat dan reCAPTCHA lolos natural)
  return envFlag("HEADLESS", false);
}

const OUTPUT_DIR = path.join(__dirname, "..", "data", "xl_esim");

const CONFIG = {
  claimUrl: "https://www.xl.co.id/esim-trial/claim",
  outputDir: OUTPUT_DIR,
  outputFile: path.join(OUTPUT_DIR, "xl_esim_accounts.csv"),
  headless: shouldRunHeadless(),
  timeout: Number(process.env.STEP_TIMEOUT_MS || 60000),
  otpTimeout: 120000,
  browserExecutablePath: browserExecutable,
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
  // Common prefixes: 0812, 0813, 0821, 0857, 0858, 0877, 0878
  const prefixes = ["0812", "0813", "0821", "0857", "0858", "0877", "0878"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.floor(10000000 + Math.random() * 90000000)
    .toString()
    .slice(0, 7);
  return `${prefix}${suffix}`;
}

async function clickUntilNavigated(
  page,
  buttonSelector,
  targetUrlPattern,
  { timeout = 40000, label = "Lanjut" } = {},
) {
  console.log(`  Memencet tombol "${label}" (retry sampai pindah halaman)...`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (page.url().includes(targetUrlPattern)) {
      return true;
    }

    // 1. Playwright native click
    const btn = page.locator(buttonSelector).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
    }

    // 2. DOM evaluate click as fallback
    await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el && !el.disabled) {
          el.click();
        }
      }, buttonSelector)
      .catch(() => {});

    // 3. Wait for URL to match target
    try {
      await page.waitForURL(`**${targetUrlPattern}**`, { timeout: 2000 });
      return true;
    } catch {}

    // 4. Log if any error alert/toast appears
    const toast = await page
      .locator(".claim-toast p, .claim-otp-error")
      .allInnerTexts()
      .catch(() => []);
    if (toast.length > 0 && toast[0].trim()) {
      const msg = toast[0].trim();
      console.log(`  [Pemberitahuan XL] ${msg}`);
      if (
        msg.includes("sudah pernah digunakan") ||
        msg.includes("tidak memenuhi syarat") ||
        msg.includes("Perangkat ini sudah")
      ) {
        throw new Error(`Respon XL: ${msg}`);
      }
      if (
        msg.includes("sudah diambil") ||
        msg.includes("pilih nomor lainnya")
      ) {
        console.log(
          "  🔄 Nomor sudah diambil orang lain, memilih nomor acak lain...",
        );
        await page
          .evaluate(() => {
            const cards = Array.from(
              document.querySelectorAll(
                ".claim-number, .claim-numbers-grid button:not(.is-selected)",
              ),
            );
            if (cards.length > 0) {
              const randCard = cards[Math.floor(Math.random() * cards.length)];
              randCard.click();
            }
          })
          .catch(() => {});
        await sleep(1500);
        continue;
      }
      const minMatch = msg.match(/(\d+)\s*(?:menit|minute)/i);
      const secMatch = msg.match(/(\d+)\s*(?:detik|second)/i);
      if (minMatch) {
        const waitMs = (parseInt(minMatch[1], 10) * 60 + 5) * 1000;
        console.log(
          `  ⏳ Diminta menunggu ${minMatch[1]} menit. Istirahat ${waitMs / 1000}s...`,
        );
        await sleep(waitMs);
        timeout += waitMs;
        continue;
      } else if (secMatch) {
        const waitMs = (parseInt(secMatch[1], 10) + 3) * 1000;
        console.log(`  ⏳ Diminta menunggu ${secMatch[1]} detik...`);
        await sleep(waitMs);
        timeout += waitMs;
        continue;
      } else if (
        msg.includes("sedang diproses") ||
        msg.includes("beberapa saat") ||
        msg.includes("keamanan gagal")
      ) {
        console.log("  ⏳ Menunggu 6s sebelum mencoba lagi...");
        await sleep(6000);
        continue;
      }
    }

    await sleep(1000);
  }

  if (!page.url().includes(targetUrlPattern)) {
    throw new Error(
      `Gagal berpindah ke ${targetUrlPattern} setelah memencet "${label}" selama ${timeout / 1000}s`,
    );
  }
  return true;
}

async function run() {
  console.log("=".repeat(60));
  console.log("  XL AXIATA FREE TRIAL eSIM REGISTRATION");
  console.log("=".repeat(60));

  // 1. Resolve fresh Outlook account
  console.log("\n[1/5] Memilih akun Outlook dari data/outlook_accounts.csv...");
  const { email, outlookAccount } = await resolveEmail(null, {
    mode: "outlook",
    outputFile: CONFIG.outputFile,
  });
  console.log(`  Akun Outlook terpilih: ${email}`);

  const fullName = `${randomFirstName()} ${randomLastName()}`;
  const whatsappNumber = generateIndonesianPhone();
  console.log(`  Nama Lengkap: ${fullName}`);
  console.log(`  Nomor WhatsApp: ${whatsappNumber}`);

  // 2. Launch Browser
  console.log("\n[2/5] Membuka Browser...");
  const proxyArg =
    process.argv.find((a) => a.startsWith("--proxy="))?.split("=")[1] ||
    (process.argv.includes("--proxy")
      ? process.argv[process.argv.indexOf("--proxy") + 1]
      : null);
  // XL eSIM default selalu koneksi langsung (direct) karena target operator Indonesia,
  // KECUALI jika secara eksplisit diberikan parameter --proxy
  const isDirect =
    process.argv.includes("--no-proxy") ||
    process.argv.includes("--direct") ||
    envFlag("DISABLE_PROXY") ||
    !proxyArg;
  const selectedProxy = isDirect ? "" : selectProxy(proxyArg || "");
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

  const tempProfileDir = path.join(
    __dirname,
    "..",
    "scratch",
    `.chrome_profile_xl_${process.env.THREAD_INDEX || "0"}_${Date.now()}`,
  );
  let context = null;
  let page = null;

  const threadIdx = parseInt(process.env.THREAD_INDEX || "0", 10);
  const posX = (threadIdx % 3) * 450;
  const posY = Math.floor(threadIdx / 3) * 350;

  try {
    context = await chromium.launchPersistentContext(tempProfileDir, {
      headless: CONFIG.headless,
      executablePath: CONFIG.browserExecutablePath,
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
      context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    // 3. Step 1: Mulai Isi Data (Sesuai Screenshot Step 1)
    console.log("\n[3/5] Navigasi ke halaman klaim XL eSIM...");
    await gotoWithRetry(page, CONFIG.claimUrl, { timeout: 30000 });
    await sleep(1500);

    // Tutup banner cookie jika ada agar tidak menutupi tombol
    const cookieBtn = page.locator('button:has-text("Setuju")').first();
    if (await cookieBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cookieBtn.click().catch(() => {});
      await sleep(300);
    }

    console.log("  Mengisi form klaim...");
    const nameInput = page.locator("#claim-name");
    await nameInput.waitFor({ state: "visible", timeout: 15000 });
    await nameInput.fill(fullName);

    const emailInput = page.locator("#claim-email");
    await emailInput.fill(email);

    const waInput = page.locator("#claim-whatsapp");
    await waInput.fill(whatsappNumber);

    // Centang checkbox syarat & ketentuan
    console.log("  Menyetujui Syarat & Ketentuan...");
    const tncCheckbox = page.locator("#claim-agree-tnc");
    await tncCheckbox.setChecked(true, { force: true });
    await sleep(300);

    // Pemicu React prototype setter untuk memastikan state React aktif 100% dan tombol tidak disabled
    await page.evaluate(
      ({ name, email, wa }) => {
        function setReactInput(selector, val) {
          const el = document.querySelector(selector);
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          ).set;
          setter.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        function setReactCheck(selector) {
          const el = document.querySelector(selector);
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "checked",
          ).set;
          setter.call(el, true);
          el.dispatchEvent(new Event("click", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        setReactInput("#claim-name", name);
        setReactInput("#claim-email", email);
        setReactInput("#claim-whatsapp", wa);
        setReactCheck("#claim-agree-tnc");
      },
      { name: fullName, email, wa: whatsappNumber },
    );
    await sleep(500);

    // Klik tombol Lanjut (retry sampai berpindah ke /claim/otp)
    const otpRequestedAt = Date.now();
    const submitStep1BtnSelector =
      'button.claim-cta, button:has-text("Lanjut")';
    await clickUntilNavigated(page, submitStep1BtnSelector, "/claim/otp", {
      timeout: 35000,
      label: "Lanjut (Step 1)",
    });

    // 4. Step 2: Kode Konfirmasi (OTP - Sesuai Screenshot Step 2)
    console.log("\n[4/5] Menunggu halaman OTP & Kode Verifikasi...");
    await page.waitForURL("**/claim/otp**", { timeout: 20000 }).catch(() => {});

    // Tunggu input OTP muncul
    const otpInputLocator = page.locator(
      ".claim-otp-fields input, input.claim-otp-input",
    );
    await otpInputLocator.first().waitFor({ state: "visible", timeout: 20000 });

    console.log(`  Menunggu OTP masuk ke inbox Outlook (${email})...`);
    const otpCode = await waitForOtp({
      mode: "outlook",
      email,
      account: outlookAccount,
      timeout: CONFIG.otpTimeout,
      since: otpRequestedAt - 10000,
      subjectContains: "OTP",
      interval: 1500,
    });

    if (!otpCode) {
      throw new Error(
        `Gagal mendapatkan kode OTP untuk ${email} dalam ${CONFIG.otpTimeout / 1000}s`,
      );
    }
    console.log(`  Kode OTP didapatkan: ${otpCode}`);

    // Input OTP via Paste (didukung langsung oleh react-pin-field onPaste)
    console.log(`  Memasukkan OTP: ${otpCode}...`);
    const firstOtpInput = otpInputLocator.first();
    await firstOtpInput.click();

    // 1. Dispatch native ClipboardEvent paste
    await firstOtpInput.evaluate((el, code) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", code);
      dt.setData("Text", code);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, otpCode);

    // 2. Tunggu tombol Lanjut menjadi aktif (berwarna biru / disabled hilang)
    const isReady = await page
      .waitForFunction(
        () => {
          const btn = document.querySelector(
            ".claim-footer button.claim-cta, button.claim-cta",
          );
          return btn && !btn.disabled && !btn.hasAttribute("disabled");
        },
        { timeout: 2000 },
      )
      .catch(() => false);

    if (!isReady) {
      // Fallback: ketik cepat via keyboard asli jika paste belum tertangkap state
      console.log("  Ketik cepat via keyboard...");
      await firstOtpInput.click();
      for (const char of otpCode) {
        await page.keyboard.press(char);
        await sleep(50);
      }
    }

    // 3. Pastikan tombol benar-benar aktif
    await page
      .waitForFunction(
        () => {
          const btn = document.querySelector(
            ".claim-footer button.claim-cta, button.claim-cta",
          );
          return btn && !btn.disabled && !btn.hasAttribute("disabled");
        },
        { timeout: 6000 },
      )
      .catch(() => {});

    // 4. Klik tombol Lanjut sampai berpindah halaman ke /pick-number
    const submitOtpBtnSelector =
      '.claim-footer button.claim-cta, button.claim-cta, button:has-text("Lanjut")';
    await clickUntilNavigated(page, submitOtpBtnSelector, "/pick-number", {
      timeout: 35000,
      label: "Lanjut (OTP)",
    });

    // 5. Step 3: Pilih Nomor eSIM (Pilih Acak)
    console.log("\n[5/5] Memilih nomor eSIM...");
    await page
      .waitForURL("**/claim/pick-number**", { timeout: 20000 })
      .catch(() => {});

    // Tunggu opsi nomor muncul
    const numberCards = page.locator(
      ".claim-number, .claim-number-radio, .claim-numbers-grid > div, .claim-numbers-grid button",
    );
    await numberCards.first().waitFor({ state: "visible", timeout: 20000 });

    const totalCards = await numberCards.count();
    const randIdx = Math.floor(Math.random() * Math.max(1, totalCards));
    const chosenCard = numberCards.nth(randIdx);
    const numberText = await chosenCard.textContent().catch(() => "");
    const selectedNumber = (numberText || "").replace(/\s+/g, " ").trim();
    console.log(
      `  Nomor eSIM yang dipilih (acak #${randIdx + 1}/${totalCards}): ${selectedNumber || "Pilihan acak"}`,
    );
    await chosenCard.click();
    await sleep(800);

    // Klik tombol Lanjut sampai berpindah ke /result
    const submitPickBtnSelector = 'button.claim-cta, button:has-text("Lanjut")';
    await clickUntilNavigated(page, submitPickBtnSelector, "/result", {
      timeout: 35000,
      label: "Lanjut (Pilih Nomor)",
    });

    // 6. Step 4: Menunggu konfirmasi selesai
    console.log("\n[SELESAI] Menunggu konfirmasi aktivasi...");
    await page
      .waitForURL("**/claim/result**", { timeout: 30000 })
      .catch(() => {});
    await page
      .waitForSelector(
        '.claim-result, img[alt*="QR" i], h1:has-text("eSIM Kamu sudah siap"), body:has-text("eSIM")',
        { timeout: 20000 },
      )
      .catch(() => {});

    // Ambil Kode PUK, Activation Code, dan file QR Code resmi dari email XL
    let pukCode = "";
    let activationCode = "";
    let qrCodeFilename = "";
    try {
      console.log(
        "  Mengecek email konfirmasi untuk mengambil QR code, PUK & Activation Code...",
      );
      const outlook = require("../utils/outlook.js");
      const token = await outlook.getAccessToken(email);
      const cleanPhone = selectedNumber.replace(/\D/g, "");
      const normalizedPhone = cleanPhone.startsWith("0")
        ? "62" + cleanPhone.slice(1)
        : cleanPhone;

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

          // Validasi ketat: pastikan nomor telepon di email ini cocok dengan nomor pilihan
          const phoneMatch = cleanBody.match(/Nomor eSIM\s*:\s*(\d+)/i);
          if (
            phoneMatch &&
            normalizedPhone &&
            phoneMatch[1] !== normalizedPhone
          ) {
            console.log(
              `  [Verifikasi] Nomor di email (${phoneMatch[1]}) belum cocok dengan pilihan (${normalizedPhone}), menunggu email terbaru...`,
            );
            await sleep(2500);
            continue;
          }

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
            qrCodeFilename = `qrcode_${cleanPhone}.png`;
            fs.writeFileSync(
              path.join(CONFIG.outputDir, qrCodeFilename),
              Buffer.from(att.contentBytes, "base64"),
            );
            console.log(
              `  QR Code terverifikasi & tersimpan: ${qrCodeFilename} (PUK: ${pukCode || "ada di email"}, Code: ${activationCode || "ada di email"})`,
            );
          }
          break;
        }
        await sleep(2500);
      }
    } catch (err) {
      console.log(`  [WARN] Ambil QR code error: ${err.message}`);
    }

    // Simpan ke CSV di data/xl_esim/xl_esim_accounts.csv
    appendToCsv({
      email,
      phoneNumber: selectedNumber,
      puk: pukCode,
      activationCode,
      fullName,
      whatsapp: whatsappNumber,
      qrCodeFile: qrCodeFilename,
      status: "SUCCESS",
    });

    console.log("\n✅ SUKSES KLAIM eSIM!");
    console.log(`  Email      : ${email}`);
    console.log(`  Nomor eSIM : ${selectedNumber}`);
    if (pukCode) console.log(`  Kode PUK   : ${pukCode}`);
    console.log(`  Folder Output: ${CONFIG.outputDir}`);
  } catch (err) {
    console.error(`\n❌ Gagal registrasi XL eSIM: ${err.message}`);
    if (page) {
      const errScreenshot = path.join(
        CONFIG.outputDir,
        `error_${Date.now()}.png`,
      );
      await page.screenshot({ path: errScreenshot }).catch(() => {});
      console.error(`  Error screenshot: ${errScreenshot}`);
    }
    throw err;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    try {
      if (fs.existsSync(tempProfileDir)) {
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

module.exports = { run };
