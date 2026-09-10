// tools/fetch_esim_qrcodes.js — Tarik QR code dan PUK langsung dari Outlook berdasarkan CSV
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("../utils/env.js");
loadEnv();

const outlook = require("../utils/outlook.js");
const { loadOutlookAccounts } = require("../utils/email.js");

const OUTPUT_DIR = path.join(__dirname, "..", "data", "xl_esim");
const CSV_FILE = path.join(OUTPUT_DIR, "xl_esim_accounts.csv");

function parseCsvLine(line) {
  const parts = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  let clean = digits;
  if (clean.startsWith("62")) clean = "0" + clean.slice(2);

  if (clean.length === 12) {
    return `${clean.slice(0, 4)} ${clean.slice(4, 8)} ${clean.slice(8)}`;
  }
  if (clean.length === 11) {
    return `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7)}`;
  }
  return clean;
}

async function run() {
  const isForce =
    process.argv.includes("--force") || process.argv.includes("-f");
  const isScanAll =
    process.argv.includes("--scan") || process.argv.includes("--all");

  console.log("=".repeat(60));
  console.log("  XL eSIM QR CODE & PUK FETCHER");
  console.log("=".repeat(60));
  console.log(`  Lokasi CSV: ${CSV_FILE}`);
  console.log(`  Folder QR : ${OUTPUT_DIR}`);
  if (isForce) console.log("  Mode: FORCE (mengunduh ulang semua QR code)");
  if (isScanAll)
    console.log("  Mode: SCAN ALL (mencari QR di seluruh akun Outlook)");
  console.log("=".repeat(60) + "\n");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 1. Baca data dari CSV jika sudah ada
  const existingMap = new Map();
  if (fs.existsSync(CSV_FILE)) {
    const lines = fs.readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1);
    for (const l of lines) {
      if (!l.trim()) continue;
      const p = parseCsvLine(l).map((s) => s.replace(/^"|"$/g, ""));
      existingMap.set(p[0].toLowerCase(), {
        email: p[0],
        phone_number: p[1] || "",
        puk: p[2] || "",
        activation_code: p[3] || "",
        full_name: p[4] || "",
        whatsapp: p[5] || "",
        qr_code_file: p[6] || "",
        status: p[7] || "SUCCESS",
        created_at: p[8] || new Date().toISOString(),
      });
    }
  }

  // 2. Tentukan target akun yang akan diproses
  const allOutlookAccounts = loadOutlookAccounts();
  const outlookMap = new Map(
    allOutlookAccounts.map((a) => [a.email.toLowerCase(), a]),
  );

  let targets = [];
  if (isScanAll) {
    targets = allOutlookAccounts;
  } else {
    for (const [emailLower, row] of existingMap.entries()) {
      const acc = outlookMap.get(emailLower) || { email: row.email };
      targets.push(acc);
    }
  }

  console.log(`[*] Memeriksa ${targets.length} akun...\n`);

  let updatedCount = 0;
  let downloadedCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const acc = targets[i];
    const email = acc.email;
    const emailLower = email.toLowerCase();
    const existing = existingMap.get(emailLower);

    const cleanPhone = existing?.phone_number?.replace(/\D/g, "") || "";
    const expectedQrFilename = cleanPhone ? `qrcode_${cleanPhone}.png` : "";
    const expectedQrPath = expectedQrFilename
      ? path.join(OUTPUT_DIR, expectedQrFilename)
      : "";

    const needsCheck =
      isForce ||
      isScanAll ||
      !existing ||
      !existing.puk ||
      !existing.qr_code_file ||
      !fs.existsSync(expectedQrPath);

    if (!needsCheck) {
      continue;
    }

    try {
      const token = await outlook.getAccessToken(email);
      const msgs = await outlook.getMessages({ email, top: 10 });
      const qrMsg = msgs.find(
        (m) => m.subject && m.subject.includes("Scan QR Code"),
      );

      if (qrMsg) {
        const full = await outlook.getMessageBody(qrMsg.id, email);
        const cleanBody = full.body
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ");

        // Ekstrak Nomor eSIM
        const phoneMatch = cleanBody.match(/Nomor eSIM\s*:\s*(\d+)/i);
        const rawPhone = phoneMatch ? phoneMatch[1] : "";
        const phoneFormatted =
          normalizePhone(rawPhone) || existing?.phone_number || "";
        const phoneDigits =
          rawPhone.replace(/\D/g, "") || phoneFormatted.replace(/\D/g, "");

        // Ekstrak Kode PUK & Activation Code
        const pukMatch = cleanBody.match(/Kode PUK\s*:\s*(\d+)/i);
        const puk = pukMatch ? pukMatch[1] : existing?.puk || "";

        const actMatch = cleanBody.match(/Activation Code\s*(?:Activation Code)?\s*([A-Z0-9-]+)/i);
        const activationCode = actMatch ? actMatch[1] : existing?.activation_code || "";

        // Unduh File Gambar QR Code
        let qrFilename =
          existing?.qr_code_file ||
          (phoneDigits ? `qrcode_${phoneDigits}.png` : "");
        const targetPath = qrFilename ? path.join(OUTPUT_DIR, qrFilename) : "";

        if (!fs.existsSync(targetPath) || isForce) {
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
            qrFilename = `qrcode_${phoneDigits}.png`;
            fs.writeFileSync(
              path.join(OUTPUT_DIR, qrFilename),
              Buffer.from(att.contentBytes, "base64"),
            );
            downloadedCount++;
            console.log(
              `[${i + 1}/${targets.length}] 📥 Berhasil unduh QR: ${qrFilename} | No: ${phoneFormatted} | PUK: ${puk}`,
            );
          }
        } else {
          console.log(
            `[${i + 1}/${targets.length}] ⚡ QR sudah ada: ${qrFilename} | No: ${phoneFormatted} | PUK: ${puk}`,
          );
        }

        existingMap.set(emailLower, {
          email,
          phone_number: phoneFormatted,
          puk,
          activation_code: activationCode,
          full_name:
            existing?.full_name ||
            `${acc.firstName || ""} ${acc.lastName || ""}`.trim() ||
            "XL User",
          whatsapp:
            existing?.whatsapp ||
            "08" + Math.floor(100000000 + Math.random() * 900000000),
          qr_code_file: qrFilename,
          status: "SUCCESS",
          created_at:
            existing?.created_at ||
            qrMsg.receivedDateTime ||
            new Date().toISOString(),
        });

        updatedCount++;
      } else if (existing) {
        console.log(
          `[${i + 1}/${targets.length}] ⏳ ${email}: Belum menerima email QR dari XL`,
        );
      }
    } catch (err) {
      console.log(`[${i + 1}/${targets.length}] ⚠️ ${email}: ${err.message}`);
    }
  }

  // Simpan ulang CSV
  const rows = Array.from(existingMap.values());
  rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const header =
    '"email","phone_number","puk","activation_code","full_name","whatsapp","qr_code_file","status","created_at"';
  const outLines = [header];
  for (const r of rows) {
    outLines.push(
      `"${r.email}","${r.phone_number}","${r.puk}","${r.activation_code}","${r.full_name}","${r.whatsapp}","${r.qr_code_file}","${r.status}","${r.created_at}"`,
    );
  }
  fs.writeFileSync(CSV_FILE, outLines.join("\n") + "\n", "utf8");

  console.log("\n" + "=".repeat(60));
  console.log("  HASIL PENARIKAN QR CODE & PUK");
  console.log("=".repeat(60));
  console.log(`  Total Akun Terdata di CSV : ${rows.length}`);
  console.log(`  File QR Baru Diunduh      : ${downloadedCount}`);
  console.log(`  File CSV Tersimpan        : ${CSV_FILE}`);
  console.log("=".repeat(60) + "\n");
}

if (require.main === module) {
  run().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { run };
