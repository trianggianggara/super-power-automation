#!/usr/bin/env node
// utils/outlook_web.js — Direct Web Browser reader for Outlook/Hotmail Inboxes
// No Azure registration or API keys needed. Automates login & inbox OTP extraction via Playwright/Camoufox.

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { loadEnv } = require("./env.js");
loadEnv();

const {
  isCamoufox,
  browserTypeFor,
  resolveBrowserExecutablePath,
  envFlag,
} = require("./browser.js");
const { sleep, fillHuman, handleCookies } = require("./helpers.js");
const { loadOutlookAccounts } = require("./email.js");

function extractOtp(subject = "", body = "", email = "") {
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

async function loginToOutlookWeb(page, account) {
  console.log(`  [Outlook Web] Opening login page for ${account.email}...`);
  await page.goto("https://login.live.com/", {
    waitUntil: "domcontentloaded",
    timeout: 35000,
  });
  await sleep(2000);

  let emailEntered = false;
  let passwordEntered = false;
  const maxLoops = 25;

  for (let loop = 1; loop <= maxLoops; loop++) {
    const u = page.url();

    // Auto-dismiss cookie banner if present
    await handleCookies(page, 0);

    // If already in Outlook mailbox or Microsoft Account page
    if (
      u.includes("outlook.live.com/mail") ||
      u.includes("account.microsoft.com")
    ) {
      console.log(
        `  [Outlook Web] Successfully logged in! URL: ${u.substring(0, 70)}...`,
      );
      return true;
    }

    const pwdInput = page
      .locator(
        'input[type="password"], input[name="passwd"], input#i0118, input#password',
      )
      .first();
    const isPwdVisible = await pwdInput
      .isVisible({ timeout: 500 })
      .catch(() => false);

    let clickedSwitch = false;
    if (emailEntered && !isPwdVisible) {
      const passSwitchSelectors = [
        "#idA_PWD_SwitchToPassword",
        "a#idA_PWD_SwitchToPassword",
        "button#idA_PWD_SwitchToPassword",
        'div[data-value="Password"]',
        'div[role="button"][data-bind*="Password"]',
        '[role="button"]:has-text("Use your password")',
        'a:has-text("Use your password")',
        'button:has-text("Use your password")',
        "#idA_PWD_SwitchToCredPicker",
        'a:has-text("Other ways to sign in")',
        'button:has-text("Other ways to sign in")',
      ];

      for (const sel of passSwitchSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
          console.log(
            `  [Outlook Web] Clicking "Use your password instead" (${sel})...`,
          );
          await el.click({ force: true }).catch(async () => {
            await el.evaluate((e) => e.click()).catch(() => {});
          });
          await sleep(1500);
          clickedSwitch = true;
          break;
        }
      }
    }
    if (clickedSwitch) continue;

    // 2. Email input
    const emailInput = page
      .locator(
        'input#i0116, input[name="loginfmt"], input[type="email"]:not([placeholder*="someone@example.com" i])',
      )
      .first();
    if (
      !emailEntered &&
      (await emailInput.isVisible({ timeout: 600 }).catch(() => false))
    ) {
      console.log(`  [Outlook Web] Entering email: ${account.email}`);
      await fillHuman(page, emailInput, account.email);
      await sleep(300);
      const nextBtn = page
        .locator(
          'input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Next")',
        )
        .first();
      if (await nextBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await nextBtn.click();
      } else {
        await emailInput.press("Enter");
      }
      emailEntered = true;
      await sleep(2500);
      continue;
    }

    // 3. Password input
    if (await pwdInput.isVisible({ timeout: 800 }).catch(() => false)) {
      console.log(`  [Outlook Web] Entering password...`);
      await fillHuman(page, pwdInput, account.password);
      await sleep(300);
      const submitBtn = page
        .locator(
          'input[type="submit"], button#idSIButton9, input#idSIButton9, button:has-text("Sign in")',
        )
        .first();
      if (await submitBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await pwdInput.press("Enter");
      }
      passwordEntered = true;
      await sleep(3000);
      continue;
    }

    // 4. Stay signed in? (KMSI) prompt
    const kmsiBtn = page
      .locator(
        '#acceptButton, input#idSIButton9, button#idSIButton9, input[value="Yes"], button:has-text("Yes"), button:has-text("Stay signed in")',
      )
      .first();
    if (await kmsiBtn.isVisible({ timeout: 600 }).catch(() => false)) {
      console.log(
        `  [Outlook Web] "Stay signed in?" detected. Clicking Yes...`,
      );
      await kmsiBtn.click().catch(() => {});
      await sleep(3000);
      continue;
    }

    // 5. Promo / Passkeys skip
    const skipBtn = page
      .locator(
        '#declineButton, button#declineButton, button:has-text("No thanks"), button:has-text("Skip"), button:has-text("Skip for now"), a:text-is("Skip for now"), a:text-is("Cancel"), a#iCancel',
      )
      .first();
    if (await skipBtn.isVisible({ timeout: 600 }).catch(() => false)) {
      console.log(`  [Outlook Web] Skipping passkey/promo prompt...`);
      await skipBtn.click().catch(() => {});
      await sleep(2000);
      continue;
    }

    // 6. Privacy Notice / Continue
    const continueBtn = page
      .locator(
        'button:has-text("Continue"), button:has-text("Next"), button#acceptButton, input[value="Continue"], input[value="Next"], button:has-text("OK"), a:has-text("Continue")',
      )
      .first();
    if (await continueBtn.isVisible({ timeout: 600 }).catch(() => false)) {
      console.log(
        `  [Outlook Web] Privacy/Terms notice detected. Clicking Continue...`,
      );
      await continueBtn.click().catch(() => {});
      await sleep(2500);
      continue;
    }

    // 7. Check if logged into account.microsoft.com -> navigate to Outlook inbox
    if (u.includes("account.microsoft.com")) {
      console.log(`  [Outlook Web] Navigating to Outlook inbox directly...`);
      await page.goto("https://outlook.live.com/mail/0/inbox", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await sleep(3000);
      return true;
    }

    await sleep(1500);
  }

  // Final check: navigate to inbox
  await page
    .goto("https://outlook.live.com/mail/0/inbox", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    })
    .catch(() => {});
  await sleep(3000);
  return page.url().includes("outlook.live.com");
}

async function waitForOutlookOtpWeb(opts = {}) {
  const timeout = opts.timeout || 120000;
  const interval = opts.interval || 4000;
  const subjectContains = (opts.subjectContains || "").toLowerCase();

  let account = opts.account;
  if (!account) {
    const emailToFind = opts.email;
    const allAccounts = loadOutlookAccounts();
    account = allAccounts.find(
      (a) => a.email.toLowerCase() === (emailToFind || "").toLowerCase(),
    );
  }

  if (!account || !account.email || !account.password) {
    throw new Error(
      `[Outlook Web] Account credentials not found for: ${opts.email || "unknown"}`,
    );
  }

  console.log(
    `\n  [Outlook Web] Starting Inbox reader for ${account.email}...`,
  );

  const execPath = resolveBrowserExecutablePath(
    process.env.BROWSER_EXECUTABLE_PATH || "",
  );
  const isCam = isCamoufox(execPath);

  let context;
  let browser;

  try {
    if (isCam) {
      browser = await browserTypeFor(execPath).launch({
        headless: envFlag("HEADLESS"),
        args: ["--no-sandbox"],
        ignoreHTTPSErrors: true,
        ...(execPath ? { executablePath: execPath } : {}),
      });
      context = await browser.newContext({
        viewport: null,
        locale: "en-US",
        timezoneId: "Asia/Jakarta",
        ignoreHTTPSErrors: true,
      });
    } else {
      context = await chromium.launchPersistentContext(
        path.join(
          __dirname,
          "..",
          "scratch",
          ".chrome_outlook_inbox_" + Date.now(),
        ),
        {
          headless: envFlag("HEADLESS"),
          executablePath: execPath || undefined,
          viewport: { width: 1280, height: 800 },
          locale: "en-US",
          timezoneId: "Asia/Jakarta",
          ignoreHTTPSErrors: true,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
          ],
        },
      );
    }

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // 1. Log in to Outlook Web
    const loginOk = await loginToOutlookWeb(page, account);
    if (!loginOk) {
      console.warn(
        `  [Outlook Web] Login might have encountered an obstacle. Continuing to check inbox DOM...`,
      );
    }

    // 2. Ensure we are on inbox page
    if (!page.url().includes("outlook.live.com/mail")) {
      await page
        .goto("https://outlook.live.com/mail/0/inbox", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        })
        .catch(() => {});
      await sleep(4000);
    }

    console.log(
      `  [Outlook Web] Waiting for incoming OTP email (Timeout: ${Math.round(timeout / 1000)}s)...`,
    );
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Read text of all visible email items in the list
        const items = await page
          .locator(
            '[role="option"], [data-convid], [aria-label*="unread" i], [aria-label*="message" i], div.customScrollBar div[tabindex="0"]',
          )
          .all();

        for (const item of items) {
          const itemText = await item.innerText().catch(() => "");
          if (!itemText) continue;

          // Check if subject/text matches filter
          if (
            subjectContains &&
            !itemText.toLowerCase().includes(subjectContains)
          ) {
            continue;
          }

          const otp = extractOtp("", itemText);
          if (otp) {
            console.log(`  [Outlook Web] ✅ Found OTP in inbox list: ${otp}`);
            return otp;
          }
        }

        // If list items didn't match immediately, try clicking the newest email item to open body
        if (items.length > 0) {
          await items[0].click().catch(() => {});
          await sleep(1500);

          const readingPane = page
            .locator(
              '[role="main"], [aria-label*="Reading Pane" i], div.ReadingPaneContainer',
            )
            .first();
          if (
            await readingPane.isVisible({ timeout: 1000 }).catch(() => false)
          ) {
            const bodyText = await readingPane.innerText().catch(() => "");
            const otp = extractOtp("", bodyText);
            if (otp) {
              console.log(
                `  [Outlook Web] ✅ Found OTP in reading pane: ${otp}`,
              );
              return otp;
            }
          }
        }
      } catch (err) {
        // Ignore loop read error
      }

      await sleep(interval);
    }

    console.log(`  [Outlook Web] ⏱️ Timeout waiting for OTP.`);
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  console.log("=== Outlook Web Inbox & OTP Reader Test ===\n");

  const allAccounts = loadOutlookAccounts();
  const accounts = allAccounts.filter(
    (a) => a.recoveryEmail && a.recoveryEmail.trim().length > 0,
  );
  if (accounts.length === 0) {
    console.error("No accounts found in data/outlook_accounts.csv");
    process.exit(1);
  }

  const cliEmail = process.argv[2] || accounts[0].email;
  const targetAccount =
    allAccounts.find((a) => a.email.toLowerCase() === cliEmail.toLowerCase()) ||
    accounts[0];

  console.log(`Testing with account: ${targetAccount.email}`);
  const otp = await waitForOutlookOtpWeb({
    account: targetAccount,
    timeout: 60000,
  });
  console.log(`\nResult OTP: ${otp || "(none found in current inbox)"}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  loginToOutlookWeb,
  waitForOutlookOtpWeb,
  extractOtp,
};
