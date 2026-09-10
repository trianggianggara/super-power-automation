// utils/outlook.js — Microsoft Graph API client untuk baca inbox Outlook/Hotmail
// Arsitektur: refresh token (dari data/outlook_accounts.csv atau .env) → access token → baca email
//
// Env vars:
//   OUTLOOK_CLIENT_ID     — dari Azure app registration
//   OUTLOOK_CLIENT_SECRET — dari Azure app registration (optional)
//   OUTLOOK_REDIRECT_URI  — optional

const https = require("https");
const { loadEnv } = require("./env.js");
const { loadOutlookAccounts, saveOutlookRefreshToken } = require("./email.js");

loadEnv();

const CONFIG = {
  clientId:
    process.env.OUTLOOK_CLIENT_ID || "a48e86c0-e508-4b09-9d69-f735792ed3e3",
  clientSecret: process.env.OUTLOOK_CLIENT_SECRET || "",
  tenant: "consumers",
  redirectUri:
    process.env.OUTLOOK_REDIRECT_URI ||
    "https://login.microsoftonline.com/common/oauth2/nativeclient",
};

const tokenCache = new Map(); // email → { accessToken, expiry }

function getRefreshTokenForEmail(email) {
  // 1. Try reading from data/outlook_accounts.csv
  try {
    const accounts = loadOutlookAccounts();
    if (email) {
      const cleanEmail = email.toLowerCase().trim();
      const matched = accounts.find(
        (a) =>
          a.email.toLowerCase() === cleanEmail ||
          cleanEmail.includes(a.email.toLowerCase()) ||
          a.email.toLowerCase().includes(cleanEmail),
      );
      if (matched && matched.refreshToken) return matched.refreshToken;
    } else {
      const withToken = accounts.find(
        (a) => a.refreshToken && a.refreshToken.trim().length > 0,
      );
      if (withToken) return withToken.refreshToken;
    }
  } catch (_) {}

  // 2. Fallback to process.env (backward compatibility)
  const envTokens = (process.env.OUTLOOK_REFRESH_TOKEN || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const envUsers = (process.env.OUTLOOK_USER || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (envTokens.length > 0) {
    if (!email) return envTokens[0];
    const cleanEmail = email.toLowerCase().trim();
    const idx = envUsers.findIndex(
      (u) => u.includes(cleanEmail) || cleanEmail.includes(u),
    );
    if (idx >= 0 && idx < envTokens.length) return envTokens[idx];
    return envTokens[0];
  }

  return null;
}

async function getAccessToken(email) {
  const cacheKey = email || "__default__";
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry - 60000) return cached.accessToken;

  const refreshToken = getRefreshTokenForEmail(email);
  if (!refreshToken) {
    throw new Error(
      `No refresh token found for ${email || "default"} in data/outlook_accounts.csv or .env`,
    );
  }

  const clientId = process.env.OUTLOOK_CLIENT_ID || CONFIG.clientId;
  if (!clientId) {
    throw new Error("Missing OUTLOOK_CLIENT_ID in .env");
  }

  const data = new URLSearchParams({
    client_id: clientId,
    scope: "https://graph.microsoft.com/Mail.Read offline_access",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (CONFIG.clientSecret) data.append("client_secret", CONFIG.clientSecret);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "login.microsoftonline.com",
        path: `/${CONFIG.tenant}/oauth2/v2.0/token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            if (
              email &&
              (body.includes("invalid_grant") ||
                body.includes("abuse") ||
                body.includes("AADSTS70000"))
            ) {
              try {
                const { saveOutlookAccountData } = require("./email.js");
                saveOutlookAccountData(email, { status: "LOCKED" });
                console.log(
                  `  [Outlook API] Account ${email} marked as LOCKED due to invalid grant/service abuse.`,
                );
              } catch (_) {}
            }
            reject(
              new Error(
                `Token refresh failed: ${res.statusCode} ${body.substring(0, 200)}`,
              ),
            );
            return;
          }
          let d;
          try {
            d = JSON.parse(body);
          } catch (e) {
            reject(
              new Error(`Failed to parse token refresh response: ${e.message}`),
            );
            return;
          }
          const entry = {
            accessToken: d.access_token,
            expiry: Date.now() + (d.expires_in || 3600) * 1000,
          };
          tokenCache.set(cacheKey, entry);
          if (d.refresh_token) {
            // If token was rotated by Microsoft, persist it to CSV
            if (email) {
              saveOutlookRefreshToken(email, d.refresh_token);
            }
          }
          resolve(d.access_token);
        });
      },
    );
    req.on("error", reject);
    req.write(data.toString());
    req.end();
  });
}

async function graphGet(path, token) {
  const t = token || (await getAccessToken());
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: "graph.microsoft.com",
          path: `/v1.0${path}`,
          headers: { Authorization: `Bearer ${t}` },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            if (res.statusCode === 401) {
              tokenCache.clear();
              reject(new Error("TOKEN_EXPIRED"));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error(`Failed to parse Graph response: ${e.message}`));
            }
          });
        },
      )
      .on("error", reject);
  });
}

async function getMessages(opts = {}) {
  try {
    const token = await getAccessToken(opts.email);
    let filter = "";
    if (opts.since) {
      filter += `receivedDateTime ge ${new Date(opts.since).toISOString()}`;
    }
    if (opts.subject) {
      if (filter) filter += " and ";
      filter += `contains(subject,'${(opts.subject || "").replace(/'/g, "''")}')`;
    }
    const params = [];
    if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);
    params.push(`$top=${opts.top || 10}`);
    params.push("$orderby=" + encodeURIComponent("receivedDateTime desc"));
    params.push(
      "$select=" +
        encodeURIComponent("id,subject,bodyPreview,receivedDateTime,from"),
    );
    const queryStr = params.length ? "?" + params.join("&") : "";

    // Query Inbox
    const inboxData = await graphGet(`/me/messages${queryStr}`, token).catch(
      () => ({ value: [] }),
    );
    const inboxMsgs = inboxData.value || [];

    // Query Junk Email
    const junkData = await graphGet(
      `/me/mailFolders/junkemail/messages${queryStr}`,
      token,
    ).catch(() => ({ value: [] }));
    const junkMsgs = junkData.value || [];

    // Combine and sort by date descending
    const allMsgs = [...inboxMsgs, ...junkMsgs];
    allMsgs.sort(
      (a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime),
    );

    return allMsgs;
  } catch (err) {
    if (err.message === "TOKEN_EXPIRED") {
      tokenCache.clear();
      return getMessages(opts);
    }
    console.error("  [Outlook API] getMessages error:", err.message);
    return [];
  }
}

async function getMessageBody(messageId, email) {
  try {
    const token = await getAccessToken(email);
    const data = await graphGet(
      `/me/messages/${messageId}?$select=body,subject,from`,
      token,
    );
    return {
      subject: data.subject || "",
      body: data.body?.content || "",
      contentType: data.body?.contentType || "text",
      from: data.from?.emailAddress?.address || "",
    };
  } catch {
    return { subject: "", body: "", contentType: "text", from: "" };
  }
}

function extractOtp(subject, body, email = "") {
  if (!body && !subject) return null;
  const combined = `${subject}\n${body}`;
  const cleanUser = (email || "").split("@")[0].toLowerCase();

  // 1. Explicit verification/OTP code pattern (6-8 alphanumeric e.g. XL IOMGIQ, or 4-8 digits)
  const explicitMatches = combined.matchAll(
    /\b(?:otp\s*code|verification\s*code|security\s*code|launch\s*code|one-time\s*(?:code|password)|code\s*is|kode(?:\s*otp)?)\s*[:\s]*([a-zA-Z0-9]{6,8}|\d{4})\b/gi,
  );
  for (const m of explicitMatches) {
    const code = m[1].toUpperCase();
    if (!cleanUser || !cleanUser.includes(code.toLowerCase())) {
      return code;
    }
  }

  // 2. 6 to 8 digit standalone numbers (GitHub / Microsoft standard OTP)
  const sixToEight = combined.match(/\b(\d{6,8})\b/);
  if (sixToEight) {
    const code = sixToEight[1];
    if (!cleanUser || !cleanUser.includes(code)) return code;
  }

  // 3. 4-digit numbers (excluding year ranges 1900-2099)
  const fourDigitMatches = combined.matchAll(/\b(\d{4})\b/g);
  for (const m of fourDigitMatches) {
    const num = parseInt(m[1], 10);
    if (num < 1900 || num > 2099) {
      if (!cleanUser || !cleanUser.includes(m[1])) return m[1];
    }
  }

  return null;
}

async function waitForOtp(opts = {}) {
  const timeout = opts.timeout || 180000;
  const interval = opts.interval || 5000;
  const since = opts.since || Date.now() - 60000;
  const email = opts.email || "";
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const messages = await getMessages({ since, top: 5, email });
      for (const msg of messages) {
        const fromAddr = msg.from?.emailAddress?.address || "";
        const subj = msg.subject || "";

        const matchFilter =
          !opts.subjectContains ||
          subj.toLowerCase().includes(opts.subjectContains.toLowerCase()) ||
          fromAddr.toLowerCase().includes(opts.subjectContains.toLowerCase()) ||
          subj.toLowerCase().includes("one time password") ||
          fromAddr.toLowerCase().includes("xlsmart.co.id");

        if (!matchFilter) continue;

        const otp = extractOtp(subj, msg.bodyPreview || "", email);
        if (otp) {
          console.log(`  [Outlook OTP] Found: ${otp} (${subj})`);
          return otp;
        }

        if (msg.bodyPreview) {
          const full = await getMessageBody(msg.id, email);
          const fullOtp = extractOtp(full.subject, full.body, email);
          if (fullOtp) {
            console.log(`  [Outlook OTP] From body: ${fullOtp}`);
            return fullOtp;
          }
        }
      }
    } catch (err) {
      console.error("  [Outlook OTP] Poll error:", err.message);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  console.log("  [Outlook OTP] Timeout");
  return null;
}

function getAuthUrl() {
  if (!CONFIG.clientId) throw new Error("Missing OUTLOOK_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: "code",
    redirect_uri: CONFIG.redirectUri,
    response_mode: "query",
    scope: "https://graph.microsoft.com/Mail.Read offline_access",
  });
  return `https://login.microsoftonline.com/${CONFIG.tenant}/oauth2/v2.0/authorize?${params}`;
}

async function exchangeCode(authCode) {
  if (!CONFIG.clientId) throw new Error("Missing OUTLOOK_CLIENT_ID");
  const data = new URLSearchParams({
    client_id: CONFIG.clientId,
    scope: "https://graph.microsoft.com/Mail.Read offline_access",
    code: authCode,
    redirect_uri: CONFIG.redirectUri,
    grant_type: "authorization_code",
  });
  if (CONFIG.clientSecret) data.append("client_secret", CONFIG.clientSecret);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "login.microsoftonline.com",
        path: `/${CONFIG.tenant}/oauth2/v2.0/token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Code exchange failed: ${res.statusCode} ${body.substring(0, 200)}`,
              ),
            );
            return;
          }
          let d;
          try {
            d = JSON.parse(body);
          } catch (e) {
            reject(
              new Error(`Failed to parse code exchange response: ${e.message}`),
            );
            return;
          }
          resolve({
            accessToken: d.access_token,
            refreshToken: d.refresh_token,
            expiresIn: d.expires_in,
            scope: d.scope,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data.toString());
    req.end();
  });
}

module.exports = {
  getAccessToken,
  getMessages,
  getMessageBody,
  extractOtp,
  waitForOtp,
  getAuthUrl,
  exchangeCode,
  getRefreshTokenForEmail,
  CONFIG,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const email = args.find((a) => !a.startsWith("--")) || "";
  const isWait = args.includes("--wait") || args.includes("-w");

  (async () => {
    console.log(`\n=== Checking Outlook/Hotmail Inbox ===`);
    if (email) console.log(`Target Email: ${email}`);

    if (isWait) {
      console.log(`Waiting for new OTP message (timeout 2 min)...`);
      const otp = await waitForOtp({ email, timeout: 120000 });
      console.log(`\nResult OTP: ${otp || "None / Timed out"}\n`);
      return;
    }

    const messages = await getMessages({ email, top: 5 });
    if (messages.length === 0) {
      console.log("No messages found or token not found for this account.");
      return;
    }

    console.log(`\nFound ${messages.length} recent message(s):\n`);
    for (const [idx, msg] of messages.entries()) {
      const from =
        msg.from?.emailAddress?.address ||
        msg.from?.emailAddress?.name ||
        "Unknown";
      const otp = extractOtp(msg.subject || "", msg.bodyPreview || "");
      console.log(`[${idx + 1}] Dari: ${from}`);
      console.log(`    Waktu: ${msg.receivedDateTime}`);
      console.log(`    Subject: ${msg.subject}`);
      console.log(`    👉 OTP: ${otp || "Tidak terdeteksi"}`);
      console.log(`    Preview: ${(msg.bodyPreview || "").slice(0, 120)}...`);
      console.log("--------------------------------------------------");
    }
  })().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
