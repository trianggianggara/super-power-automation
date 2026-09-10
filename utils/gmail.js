// utils/gmail.js — Gmail API client & Pure Dot-Trick generator for XL eSIM
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("./env.js");
loadEnv();

const tokenCache = new Map(); // baseEmail -> { accessToken, expiresAt }

/**
 * Load all Gmail base accounts and refresh tokens from .env
 */
function loadGmailAccounts() {
  const users = (process.env.GMAIL_USER || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  const tokens = (process.env.GMAIL_REFRESH_TOKEN || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const accounts = [];
  for (let i = 0; i < users.length; i++) {
    if (tokens[i]) {
      accounts.push({
        email: users[i],
        refreshToken: tokens[i],
      });
    }
  }
  return accounts;
}

/**
 * Normalize any Gmail address to its clean base key (lowercase, no dots, no plus)
 */
function getGmailBaseKey(email) {
  if (!email || !email.includes("@")) return (email || "").toLowerCase();
  const [local, domain] = email.toLowerCase().split("@");
  const cleanLocal = local.split("+")[0].replace(/\./g, "");
  return `${cleanLocal}@${domain}`;
}

/**
 * Get OAuth2 access token for a given Gmail address
 */
async function getGmailAccessToken(emailAddress) {
  const accounts = loadGmailAccounts();
  if (accounts.length === 0) {
    throw new Error(
      "No Gmail accounts found. Please configure GMAIL_USER and GMAIL_REFRESH_TOKEN in .env",
    );
  }

  const baseKey = getGmailBaseKey(emailAddress);
  const account =
    accounts.find((a) => getGmailBaseKey(a.email) === baseKey) || accounts[0];

  const cached = tokenCache.get(account.email);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.accessToken;
  }

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET in environment variables",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: account.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to refresh Gmail token for ${account.email} (${res.status}): ${errText}`,
    );
  }

  const data = await res.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  tokenCache.set(account.email, {
    accessToken: data.access_token,
    expiresAt,
  });

  return data.access_token;
}

/**
 * Generate a randomized pure dot-trick alias (ONLY using dots, NO plus sign)
 * Compatible with XL Axiata's email regex validation.
 */
function generatePureGmailDotAlias(baseEmail, existingEmails = new Set()) {
  const [local, domain] = baseEmail.toLowerCase().split("@");
  const cleanUser = local.replace(/\./g, "").split("+")[0];

  if (cleanUser.length < 2) {
    return `${cleanUser}@${domain}`;
  }

  let attempts = 0;
  while (attempts < 2000) {
    let dotted = cleanUser[0];
    for (let i = 1; i < cleanUser.length; i++) {
      // 50% probability of inserting a dot, never consecutive
      if (Math.random() < 0.5 && !dotted.endsWith(".")) {
        dotted += ".";
      }
      dotted += cleanUser[i];
    }
    const candidate = `${dotted}@${domain}`.toLowerCase();
    if (!existingEmails.has(candidate)) {
      return candidate;
    }
    attempts++;
  }

  // Fallback: guaranteed single dot placement
  const mid = Math.floor(cleanUser.length / 2);
  return `${cleanUser.slice(0, mid)}.${cleanUser.slice(mid)}@${domain}`.toLowerCase();
}

/**
 * Pick a fresh unique Gmail alias
 */
function pickFreshGmailAlias(existingEmails = new Set()) {
  const accounts = loadGmailAccounts();
  if (accounts.length === 0) {
    throw new Error("No Gmail accounts configured in .env");
  }

  const chosenBase = accounts[Math.floor(Math.random() * accounts.length)];
  const alias = generatePureGmailDotAlias(chosenBase.email, existingEmails);
  return {
    email: alias,
    baseEmail: chosenBase.email,
  };
}

/**
 * Extract OTP from subject/body preview
 */
function extractOtp(subject = "", body = "") {
  const text = `${subject}\n${body}`;

  // 1. Explicit verification code / OTP pattern (XL uses 6-character uppercase letters or digits)
  const explicit = text.match(
    /\b(?:otp(?:\s*code)?|verification\s*code|security\s*code|one-time\s*(?:code|password)|kode(?:\s*otp)?)\s*[:\s]*([a-zA-Z0-9]{6})\b/i,
  );
  if (explicit) {
    return explicit[1].toUpperCase();
  }

  // 2. Standalone 6 alphanumeric characters or digits
  const match = text.match(/\b([a-zA-Z0-9]{6})\b/);
  if (match) {
    return match[1].toUpperCase();
  }

  return null;
}

/**
 * Poll Gmail API for XL eSIM OTP message
 */
async function waitForGmailOtp({
  email,
  timeout = 120000,
  since = Date.now() - 30000,
  interval = 3000,
}) {
  const startTime = Date.now();
  console.log(
    `  [Gmail OTP] Menunggu OTP untuk ${email} (timeout: ${timeout / 1000}s)...`,
  );

  while (Date.now() - startTime < timeout) {
    try {
      const accessToken = await getGmailAccessToken(email);
      // Query XL OTP emails
      const q = encodeURIComponent("xlsmart OR OTP OR (One Time Password)");
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      if (res.ok) {
        const listData = await res.json();
        const messages = listData.messages || [];

        for (const msg of messages) {
          const mRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          );
          if (!mRes.ok) continue;

          const mData = await mRes.json();
          const internalDate = parseInt(mData.internalDate || "0", 10);
          if (internalDate && internalDate < since - 15000) {
            continue; // Skip older emails
          }

          const headers = mData.payload?.headers || [];
          const subj =
            headers.find((h) => h.name.toLowerCase() === "subject")?.value ||
            "";
          const snippet = mData.snippet || "";

          // Check if subject or snippet matches OTP keywords
          if (
            subj.toLowerCase().includes("otp") ||
            subj.toLowerCase().includes("one time password") ||
            snippet.toLowerCase().includes("otp") ||
            snippet.toLowerCase().includes("kode")
          ) {
            const otp = extractOtp(subj, snippet);
            if (otp) {
              console.log(`  [Gmail OTP] Ditemukan: ${otp} (${subj})`);
              return otp;
            }
          }
        }
      }
    } catch (err) {
      console.log(`  [Gmail OTP] Poll warn: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  console.log("  [Gmail OTP] Timeout.");
  return null;
}

/**
 * Fetch confirmation email from XL Axiata via Gmail API, extract phone number, PUK, and download QR Code image
 */
async function fetchGmailEsimQrCode({
  email,
  outputDir,
  since = Date.now() - 60000,
}) {
  const accessToken = await getGmailAccessToken(email);
  const q = encodeURIComponent('subject:("Scan QR Code")');

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (res.ok) {
        const data = await res.json();
        const messages = data.messages || [];

        for (const msg of messages) {
          const mRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          );
          if (!mRes.ok) continue;

          const mData = await mRes.json();
          const internalDate = parseInt(mData.internalDate || "0", 10);
          if (since > 0 && internalDate && internalDate < since - 15000) {
            continue;
          }

          const headers = mData.payload?.headers || [];
          const toHeader = headers.find((h) => h.name.toLowerCase() === "to")?.value || "";
          if (email && email.includes("@") && toHeader && messages.length > 1) {
            if (!toHeader.toLowerCase().includes(email.toLowerCase())) {
              continue;
            }
          }

          const snippet = mData.snippet || "";

          // Decode body text from parts
          let bodyText = snippet;
          function extractParts(part) {
            if (part.body && part.body.data) {
              const decoded = Buffer.from(
                part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
                "base64",
              ).toString("utf8");
              bodyText += " " + decoded;
            }
            if (part.parts) {
              for (const sub of part.parts) {
                extractParts(sub);
              }
            }
          }
          if (mData.payload) {
            extractParts(mData.payload);
          }

          const cleanBody = bodyText
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ");

          // Ekstrak Nomor eSIM
          let cleanPhone = "";
          let selectedNumber = "";
          const phoneMatch = cleanBody.match(/Nomor eSIM\s*:\s*(\d+)/i);
          if (phoneMatch && phoneMatch[1]) {
            cleanPhone = phoneMatch[1].trim().replace(/\D/g, "");
            let fPhone = cleanPhone;
            if (fPhone.startsWith("62")) fPhone = "0" + fPhone.slice(2);
            if (fPhone.length === 12) {
              selectedNumber = `${fPhone.slice(0, 4)} ${fPhone.slice(4, 8)} ${fPhone.slice(8)}`;
            } else if (fPhone.length === 11) {
              selectedNumber = `${fPhone.slice(0, 4)} ${fPhone.slice(4, 7)} ${fPhone.slice(7)}`;
            } else {
              selectedNumber = fPhone;
            }
          }

          // Ekstrak PUK & Activation Code
          let pukCode = "";
          const pukMatch = cleanBody.match(/Kode PUK\s*:\s*(\d+)/i);
          if (pukMatch) {
            pukCode = pukMatch[1];
          }

          let activationCode = "";
          const actMatch = cleanBody.match(/Activation Code\s*(?:Activation Code)?\s*([A-Z0-9-]+)/i);
          if (actMatch) {
            activationCode = actMatch[1];
          }

          // Cari attachment QR code
          let qrCodeFilename = "";
          function findAttachment(part) {
            if (
              part.filename &&
              part.filename.includes("qrcode") &&
              part.body?.attachmentId
            ) {
              return {
                id: part.body.attachmentId,
                filename: part.filename,
              };
            }
            if (part.parts) {
              for (const sub of part.parts) {
                const found = findAttachment(sub);
                if (found) return found;
              }
            }
            return null;
          }

          const attInfo = mData.payload ? findAttachment(mData.payload) : null;
          if (attInfo) {
            const attRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/attachments/${attInfo.id}`,
              {
                headers: { Authorization: `Bearer ${accessToken}` },
              },
            );
            if (attRes.ok) {
              const attData = await attRes.json();
              const base64 = (attData.data || "")
                .replace(/-/g, "+")
                .replace(/_/g, "/");
              qrCodeFilename = `qrcode_${cleanPhone || Date.now()}.png`;
              if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
              }
              fs.writeFileSync(
                path.join(outputDir, qrCodeFilename),
                Buffer.from(base64, "base64"),
              );
              console.log(
                `  [Gmail] QR Code berhasil diunduh: ${qrCodeFilename} (PUK: ${pukCode || "ada di email"}, Code: ${activationCode || "ada di email"})`,
              );
            }
          }

          return {
            success: true,
            phoneNumber: selectedNumber || cleanPhone,
            puk: pukCode,
            activationCode,
            qrCodeFilename,
          };
        }
      }
    } catch (err) {
      console.log(`  [Gmail] Ambil QR error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  return { success: false, phoneNumber: "", puk: "", qrCodeFilename: "" };
}

module.exports = {
  loadGmailAccounts,
  getGmailAccessToken,
  generatePureGmailDotAlias,
  pickFreshGmailAlias,
  extractOtp,
  waitForGmailOtp,
  fetchGmailEsimQrCode,
};
