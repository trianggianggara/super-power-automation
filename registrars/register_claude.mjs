/**
 * register_claude.mjs
 *
 * End-to-end automation that registers a fresh Claude account and completes the
 * passwordless login via the mailpit magic link.
 *
 * Reuses the CloakBrowser launch scaffolding from ternak_claude.mjs: a persistent
 * profile with the Claude SEPA Helper extension loaded (--load-extension) and
 * pinned to the toolbar, plus the humanize() patches. CloakBrowser's persistent
 * context is Chromium driven over CDP under the hood; where a raw CDP session is
 * handy we use Playwright's context.newCDPSession(page).
 *
 * Flow:
 *   1. Launch CloakBrowser (headed) with the pinned extension.
 *   2. Open https://claude.ai/.
 *   3. Generate a new email via random_email.mjs (used as-is, @dellakuyang.com).
 *   4. Register with the generated email.
 *   5. Open a new tab: https://mailpit.dellakuyang.my.id/search?q=<generatedEmail>.
 *   6. Poll until the "Secure link to log in to Claude.ai" email appears; open it.
 *   7. Read the email and extract the claude.ai/magic-link URL.
 *   8. Open the magic link in a new tab to finish login; keep the browser open.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";

import pino from "pino";
import { launchPersistentContext } from "cloakbrowser";
import { patchContext, resolveConfig } from "cloakbrowser/human";

import { randomEmail } from "../tools/random_email.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Structured logger for the whole registration flow.
 *
 * - LOG_LEVEL controls verbosity (default "info"; use "debug" for step detail).
 * - LOG_PRETTY=false forces raw JSON (useful when piping to a file/collector);
 *   otherwise, when stdout is a TTY we pretty-print for the headed session.
 * Per-step context is attached via child loggers (e.g. logger.child({ step })),
 * so every line carries which stage of the flow it belongs to.
 */
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const LOG_PRETTY = process.env.LOG_PRETTY
  ? process.env.LOG_PRETTY !== "false"
  : process.stdout.isTTY;

const logger = pino({
  level: LOG_LEVEL,
  base: { service: "register-claude" },
  ...(LOG_PRETTY
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service",
          },
        },
      }
    : {}),
});

/**
 * Redact the secret fragment of a magic link before logging. The token after
 * `#` authenticates the login, so we keep the origin/path but mask the fragment.
 */
function redactMagicLink(url) {
  try {
    const u = new URL(url);
    return u.hash ? `${u.origin}${u.pathname}#<redacted>` : url;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * Append one `email|iban|<profile-basename>` line to OUTPUT_FILE after a
 * successful registration (login succeeded and the IBAN was generated). The
 * profile is stored as its directory basename so each account maps back to the
 * per-run `.chrome-profile-*` that owns its logged-in session.
 */
function recordRegistration({ email, iban, userDataDir }) {
  const profile = path.basename(userDataDir);
  const line = `${email}|${iban}|${profile}\n`;
  appendFileSync(OUTPUT_FILE, line);
  logger.info(
    { step: "record", email, iban, profile, outputFile: OUTPUT_FILE },
    "Recorded registration to output.txt",
  );
}

const TARGET_URL = process.env.TARGET_URL ?? "https://claude.ai/";

// Mailpit web UI base. The requirement drives the UI (not the auth-gated API),
// so we open <base>/search?q=<email> as a browser tab.
const MAILPIT_BASE = (
  process.env.MAILPIT_BASE ?? "https://mailpit.dellakuyang.my.id"
).replace(/\/+$/, "");

// Mailpit sits behind HTTP Basic Auth. Scope the credentials to the mailpit
// origin only (via Playwright's httpCredentials.origin) so they never leak to
// claude.ai. Override via MAILPIT_USER / MAILPIT_PASS.
const MAILPIT_USER = process.env.MAILPIT_USER ?? "della";
const MAILPIT_PASS = process.env.MAILPIT_PASS ?? "kuyang0321";
const MAILPIT_ORIGIN = new URL(MAILPIT_BASE).origin;

// Magic-link email polling. Delivery is async, so we reload the mailpit search
// tab on an interval until the target email shows up (or we time out).
const POLL_INTERVAL_MS = Number.parseInt(
  process.env.POLL_INTERVAL_MS ?? "3000",
  10,
);
const POLL_TIMEOUT_MS = Number.parseInt(
  process.env.POLL_TIMEOUT_MS ?? "60000",
  10,
);

const MAGIC_EMAIL_SUBJECT = "Secure link to log in to Claude.ai";

// IBAN generator. The upgrade/plan page is reached by following the onboarding
// flow, so no upgrade URL is navigated to directly.
const RANDOMIBAN_URL = process.env.RANDOMIBAN_URL ?? "http://randomiban.com/";
const IBAN_COUNTRY = process.env.IBAN_COUNTRY ?? "Germany";

// After choosing personal use, onboarding displays the plan-selection screen.
// Clicking "Get Max plan" must naturally navigate here; we never open it directly.
const MAX_ONBOARDING_URL =
  process.env.MAX_ONBOARDING_URL ?? "https://claude.ai/upgrade/max?from=onboarding";
const MAX_ONBOARDING_URL_TIMEOUT_MS = Number.parseInt(
  process.env.MAX_ONBOARDING_URL_TIMEOUT_MS ?? "60000",
  10,
);

// Successful-registration ledger: one `email|iban|<profile-basename>` line is
// appended per run once login succeeded and the IBAN was generated.
const OUTPUT_FILE = path.resolve(
  process.env.OUTPUT_FILE ?? path.join(__dirname, "output.txt"),
);

// How long to wait for the user to complete the (stealth-only) captcha/login and
// to manually open the extension SEPA panel before we give up.
const LOGIN_TIMEOUT_MS = Number.parseInt(
  process.env.LOGIN_TIMEOUT_MS ?? "180000",
  10,
);
const EXTENSION_WAIT_MS = Number.parseInt(
  process.env.EXTENSION_WAIT_MS ?? "300000",
  10,
);
// Max wait for the SEPA payment status to appear after clicking pay.
const PAY_STATUS_TIMEOUT_MS = Number.parseInt(
  process.env.PAY_STATUS_TIMEOUT_MS ?? "120000",
  10,
);

/**
 * Persistent Chrome profile — required so the extension's pinned-to-toolbar
 * state (which lives in <profile>/Default/Preferences) survives across runs.
 *
 * Each run gets its own unique `.chrome-profile-<timestamp>-<rand>` directory so
 * concurrent/repeated runs never share state (cookies, the logged-in session,
 * pinned-extension prefs). Set USER_DATA_DIR to pin a specific profile instead.
 */
const USER_DATA_DIR = path.resolve(
  process.env.USER_DATA_DIR ??
    path.join(
      __dirname,
      `.chrome-profile-${Date.now()}-${randomBytes(4).toString("hex")}`,
    ),
);

/**
 * Unpacked (not .crx) directory of the Claude SEPA Helper extension. Chromium's
 * --load-extension only accepts an unpacked directory containing manifest.json.
 */
let resolvedExtensionPath = path.resolve(
  process.env.EXTENSION_PATH ??
    path.join(__dirname, "claude-sepa-helper-v1.0.8-protected"),
);
let hasExtension = existsSync(path.join(resolvedExtensionPath, "manifest.json"));

if (!hasExtension && !process.env.EXTENSION_PATH) {
  const fallbackPath = path.join(__dirname, "extension-cloude");
  if (existsSync(path.join(fallbackPath, "manifest.json"))) {
    resolvedExtensionPath = fallbackPath;
    hasExtension = true;
  }
}

const EXTENSION_PATH = resolvedExtensionPath;
const HAS_EXTENSION = hasExtension;

// MV3 extensions do not load in Chromium's (old) headless mode. When loading the
// extension, force a headed session so it actually runs.
const HEADLESS = HAS_EXTENSION ? false : process.env.HEADLESS === "true";
if (HAS_EXTENSION && process.env.HEADLESS === "true") {
  logger.warn(
    "HEADLESS=true ignored: MV3 extensions require a headed browser.",
  );
}

/**
 * Compute the deterministic ID Chromium assigns to an unpacked extension.
 * SHA-256 of the absolute directory path, first 32 hex chars, map each nibble
 * 0..f to a..p. Matches crx_file::id_util::GenerateIdForPath (valid while the
 * manifest has no "key"; this one doesn't).
 */
function computeExtensionId(absDir) {
  const hex = createHash("sha256")
    .update(absDir, "utf8")
    .digest("hex")
    .slice(0, 32);
  return [...hex]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
}

/**
 * Seed <profile>/Default/Preferences so the extension is pinned to the toolbar.
 * Merge into any existing Preferences rather than overwrite so a reused profile
 * keeps its other settings.
 */
function pinExtension(userDataDir, extensionId) {
  const defaultDir = path.join(userDataDir, "Default");
  mkdirSync(defaultDir, { recursive: true });
  const prefsPath = path.join(defaultDir, "Preferences");

  let prefs = {};
  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    } catch {
      prefs = {};
    }
  }

  prefs.extensions ??= {};
  const pinned = new Set(prefs.extensions.pinned_extensions ?? []);
  pinned.add(extensionId);
  prefs.extensions.pinned_extensions = [...pinned];

  writeFileSync(prefsPath, JSON.stringify(prefs));
  logger.info(
    { step: "launch", extensionId },
    "Pinned extension to the toolbar",
  );
}

/**
 * Userscript-equivalent injected into every page before its own scripts run.
 * Mirrors script.js: rewrites the checkout_capabilities response to `cassia` in
 * the page context (client-side only; does not touch server state).
 */
const CASSIA_MOCK_INIT_SCRIPT = () => {
  const TARGET_PATH =
    /^\/api\/organizations\/[^/]+\/subscription\/checkout_capabilities\/?$/;
  const MOCK = { checkout_flow: "cassia" };

  const matches = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.hostname.endsWith("claude.ai") && TARGET_PATH.test(u.pathname);
    } catch {
      return false;
    }
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (url && matches(url)) {
      return new Response(JSON.stringify(MOCK), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cassiaMock = matches(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__cassiaMock) {
      Object.defineProperty(this, "responseText", {
        get: () => JSON.stringify(MOCK),
      });
      Object.defineProperty(this, "response", {
        get: () => JSON.stringify(MOCK),
      });
      Object.defineProperty(this, "status", { get: () => 200 });
      Object.defineProperty(this, "readyState", { get: () => 4 });
      setTimeout(() => {
        this.onreadystatechange?.();
        this.onload?.();
      }, 0);
      return;
    }
    return origSend.apply(this, args);
  };

  console.info("[Cassia Mock] installed:", location.href);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Find the first locator from an ordered list of selectors that is visible on
 * the page within `timeout`. Returns null instead of throwing so callers can
 * apply their own fallback / error messaging.
 */
async function firstVisible(page, selectors, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      try {
        if (await loc.isVisible()) return loc;
      } catch {
        // selector may be momentarily detached during hydration; keep trying.
      }
    }
    await sleep(300);
  }
  return null;
}

/**
 * Resolve a selector that may live in the main document OR in any child iframe.
 * Claude's checkout/SEPA form (e.g. #payment-ibanInput) is commonly rendered
 * inside an iframe, and Playwright's page.locator() does not pierce frames, so
 * we poll every frame until a visible match appears. Returns the matching
 * Locator (bound to its frame) or null on timeout. On timeout, logs the frames
 * that were present to aid debugging.
 */
async function findInAnyFrame(page, selector, { timeout = 60000, log } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const loc = frame.locator(selector).first();
      try {
        if (await loc.isVisible()) return loc;
      } catch {
        // frame may be navigating/detached; skip and retry.
      }
    }
    await sleep(400);
  }
  if (log) {
    const frames = page.frames().map((f) => f.url());
    log.warn({ selector, frameCount: frames.length, frames }, "Selector not found in any frame");
  }
  return null;
}

/**
 * Step 4: Register on claude.ai with the generated email. claude.ai uses a
 * single email field then a "Continue with email" button; selectors are ordered
 * fallbacks so minor markup changes don't break the flow.
 */
async function registerWithEmail(page, email) {
  const log = logger.child({ step: "register", email });
  log.info("Locating email input on claude.ai");

  const emailInput = await firstVisible(
    page,
    [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="email" i]',
    ],
    { timeout: 30000 },
  );
  if (!emailInput) {
    log.error("Email input not found on claude.ai");
    throw new Error("Could not find the email input on claude.ai.");
  }
  log.debug("Email input located");

  await emailInput.click();
  await emailInput.fill("");
  // Humanized per-character typing (patchContext already installed the wrapper).
  await emailInput.type(email, { delay: 40 });
  log.info("Filled registration email");

  const submit = await firstVisible(
    page,
    [
      'button:has-text("Continue with email")',
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Sign up")',
      'button:has-text("Log in")',
    ],
    { timeout: 10000 },
  );
  if (!submit) {
    log.error("Continue/submit button not found on claude.ai");
    throw new Error("Could not find the continue/submit button on claude.ai.");
  }
  log.debug("Submit button located");

  await submit.click();
  log.info("Submitted registration form; awaiting 'check your email' state");

  // Best-effort wait for the confirmation screen; don't hard-fail if the copy
  // differs — the real proof of success is the email arriving in mailpit.
  await page
    .waitForFunction(
      () =>
        /check your email|verify|sent you|magic link/i.test(
          document.body?.innerText ?? "",
        ),
      { timeout: 20000 },
    )
    .then(() => log.info("Registration confirmation screen detected"))
    .catch(() => {
      log.warn("Did not detect an explicit confirmation screen; continuing");
    });
}

const MAGIC_LINK_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*claude\.ai\/magic-link[^\s"'<>]*/i;

/**
 * Decode quoted-printable soft wraps in an email body. Mailpit serves message
 * HTML with the transfer encoding intact: `=` at end-of-line is a soft break
 * (the URL is split across lines) and `=3D` encodes a literal `=`. Without this
 * the magic-link URL is truncated at the first line wrap, which is why a naive
 * regex over the raw body finds nothing.
 */
function decodeQuotedPrintable(body) {
  return body.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
}

/**
 * Steps 5-7: open the mailpit search tab (visible, per the requirement), then use
 * mailpit's authenticated API to deterministically find the message addressed to
 * `email`, open it in the tab so it's "read", and extract the magic-link URL from
 * its (quoted-printable-decoded) HTML.
 *
 * Why the API and not the rendered list rows? The real subject carries a
 * ` | <timestamp>` suffix and the list markup changes between mailpit versions,
 * so text-row matching is brittle. `page.request` shares the browser context's
 * httpCredentials, so the API calls are authenticated just like the UI.
 */
async function fetchMagicLink(mailPage, email) {
  const log = logger.child({ step: "mailpit", email });
  const searchUrl = `${MAILPIT_BASE}/search?q=${encodeURIComponent(email)}`;
  log.info(
    {
      searchUrl,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollTimeoutMs: POLL_TIMEOUT_MS,
    },
    "Opening mailpit search tab",
  );
  // Show the search tab first so the flow is visible; the API drives the lookup.
  await mailPage
    .goto(searchUrl, { waitUntil: "domcontentloaded" })
    .catch(() => {});

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const message = await findMessageForEmail(mailPage, email, log);
    if (message) {
      log.info(
        { messageId: message.ID, subject: message.Subject, attempt },
        "Magic-link email found; opening it",
      );

      // Open the message in the visible tab so it is actually read on screen.
      await mailPage
        .goto(`${MAILPIT_BASE}/view/${message.ID}`, {
          waitUntil: "domcontentloaded",
        })
        .catch(() => {});

      const magicLink = await extractMagicLinkForMessage(
        mailPage,
        message.ID,
        log,
      );
      if (magicLink) {
        log.info(
          { messageId: message.ID, magicLink: redactMagicLink(magicLink) },
          "Extracted magic link from email",
        );
        return magicLink;
      }
      log.warn(
        { messageId: message.ID, attempt },
        "Email opened but no magic-link URL found yet; retrying",
      );
    } else {
      log.debug({ attempt }, "Magic-link email not delivered yet; polling");
      // Keep the visible search tab in sync while we wait for delivery.
      await mailPage
        .goto(searchUrl, { waitUntil: "domcontentloaded" })
        .catch(() => {});
    }

    await sleep(POLL_INTERVAL_MS);
  }

  log.error(
    { attempts: attempt, pollTimeoutMs: POLL_TIMEOUT_MS },
    "Timed out waiting for magic-link email",
  );
  throw new Error(
    `Timed out after ${POLL_TIMEOUT_MS}ms waiting for the "${MAGIC_EMAIL_SUBJECT}" email for ${email}.`,
  );
}

/**
 * Query mailpit's search API for a message addressed to `email` whose subject is
 * the magic-link subject. Returns the message summary (with .ID) or null.
 *
 * Note: mailpit's `total` field reports the global mailbox count, so we key off
 * the returned `messages` array and re-check the recipient/subject ourselves.
 */
async function findMessageForEmail(mailPage, email, log = logger) {
  const query = `to:${email} ${MAGIC_EMAIL_SUBJECT}`;
  const url = `${MAILPIT_BASE}/api/v1/search?query=${encodeURIComponent(query)}&limit=20`;
  try {
    const res = await mailPage.request.get(url);
    if (!res.ok()) {
      log.warn(
        { status: res.status() },
        "Mailpit search API returned a non-OK status",
      );
      return null;
    }
    const data = await res.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    log.debug(
      { candidates: messages.length },
      "Mailpit search returned candidates",
    );
    return (
      messages.find(
        (m) =>
          (m.Subject ?? "").includes(MAGIC_EMAIL_SUBJECT) &&
          (m.To ?? []).some(
            (t) => (t.Address ?? "").toLowerCase() === email.toLowerCase(),
          ),
      ) ?? null
    );
  } catch (err) {
    log.warn({ err: err?.message }, "Mailpit search API request failed");
    return null;
  }
}

/**
 * Extract the claude.ai/magic-link URL for a given mailpit message ID. Prefers
 * the rendered iframe anchor (browser-decoded), then falls back to fetching the
 * message HTML and de-wrapping quoted-printable before regexing.
 */
async function extractMagicLinkForMessage(mailPage, messageId, log = logger) {
  // 1. Rendered iframe / page: the browser decodes quoted-printable, so an
  //    <a href> or visible text yields a clean URL.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const frame of mailPage.frames()) {
      const href = await frame
        .evaluate((reSource) => {
          const rx = new RegExp(reSource, "i");
          for (const a of document.querySelectorAll("a[href]")) {
            if (rx.test(a.href)) return a.href;
          }
          const m = (document.body?.innerHTML ?? "").match(rx);
          return m ? m[0] : null;
        }, MAGIC_LINK_RE.source)
        .catch(() => null);
      if (href) {
        log.debug(
          { messageId, source: "rendered-iframe" },
          "Magic link found in rendered message",
        );
        return href;
      }
    }
    await sleep(400);
  }

  // 2. Deterministic fallback: fetch the raw HTML and de-wrap quoted-printable.
  log.debug(
    { messageId },
    "Rendered extraction empty; falling back to raw fetch + quoted-printable decode",
  );
  for (const suffix of [
    `/view/${messageId}.html`,
    `/api/v1/message/${messageId}`,
  ]) {
    try {
      const res = await mailPage.request.get(`${MAILPIT_BASE}${suffix}`);
      if (!res.ok()) {
        log.warn(
          { messageId, suffix, status: res.status() },
          "Mailpit message fetch returned non-OK status",
        );
        continue;
      }
      const text = await res.text();
      // The API returns JSON ({HTML, Text}); /view returns HTML directly. In
      // either case, de-wrapping the whole payload exposes the full URL.
      const decoded = decodeQuotedPrintable(text);
      const m = decoded.match(MAGIC_LINK_RE);
      if (m) {
        log.debug(
          { messageId, source: suffix },
          "Magic link found via raw fetch fallback",
        );
        return m[0];
      }
    } catch (err) {
      log.warn(
        { messageId, suffix, err: err?.message },
        "Mailpit message fetch failed",
      );
    }
  }

  log.warn({ messageId }, "No magic-link URL found in message via any source");
  return null;
}

/**
 * Open randomiban.com in a new tab, pick the country, generate an IBAN, and read
 * it from the `#demo.ibandisplay` element. Selectors verified against the live
 * page: <select id="country_input">, <button id="gen_button">, <p id="demo"
 * class="ibandisplay">. The country <option>s are injected by the site's JS, so
 * we select by visible label (default "Germany") which is value-agnostic.
 */
function calculateIBANCheckDigits(ibanWithoutCheckDigits) {
  const rearranged = ibanWithoutCheckDigits.slice(4) + ibanWithoutCheckDigits.slice(0, 4);
  let numeric = "";
  for (let i = 0; i < rearranged.length; i++) {
    const char = rearranged[i];
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) { // A-Z
      numeric += (code - 55).toString();
    } else {
      numeric += char;
    }
  }
  const remainder = BigInt(numeric) % 97n;
  const checkDigits = 98n - remainder;
  return checkDigits.toString().padStart(2, "0");
}

/**
 * Generates a valid IBAN programmatically for Germany or Netherlands
 * to bypass flaky network requests to randomiban.com.
 */
async function getIban(page) {
  const log = logger.child({ step: "iban", country: IBAN_COUNTRY });
  log.info({ country: IBAN_COUNTRY }, "Generating IBAN programmatically");

  const randomDigits = (len) => {
    let res = "";
    for (let i = 0; i < len; i++) {
      res += Math.floor(Math.random() * 10).toString();
    }
    return res;
  };

  let ibanWithoutCheckDigits = "";
  if (
    IBAN_COUNTRY.toLowerCase() === "netherlands" ||
    IBAN_COUNTRY.toLowerCase() === "nl"
  ) {
    const banks = ["ABNA", "INGB", "RABO", "SNSB", "ASNB", "TRIO"];
    const bank = banks[Math.floor(Math.random() * banks.length)];
    const account = randomDigits(10);
    ibanWithoutCheckDigits = `NL00${bank}${account}`;
  } else {
    // Default to Germany (DE)
    const bankCode = "37040044";
    const account = randomDigits(10);
    ibanWithoutCheckDigits = `DE00${bankCode}${account}`;
  }

  const checkDigits = calculateIBANCheckDigits(ibanWithoutCheckDigits);
  const iban =
    ibanWithoutCheckDigits.substring(0, 2) +
    checkDigits +
    ibanWithoutCheckDigits.substring(4);

  log.info({ iban }, "Generated IBAN");
  return iban;
}

/**
 * Stealth-only login wait: after the magic link opens, poll until the page looks
 * logged in (navigated away from the magic-link/login URL and the app shell has
 * rendered). No captcha solver — we rely on CloakBrowser stealth and, if a
 * challenge appears, the user resolving it in the headed window.
 */
async function waitForLogin(page) {
  const log = logger.child({ step: "login" });
  log.info(
    { timeoutMs: LOGIN_TIMEOUT_MS },
    "Waiting for login to complete (stealth-only)",
  );
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let warnedChallenge = false;
  while (Date.now() < deadline) {
    const url = page.url();
    const onAuthPage = /\/(magic-link|login)\b/.test(url);
    const loggedIn = await page
      .evaluate(() => {
        if (/\/(magic-link|login)\b/.test(location.href)) return false;
        // Heuristics for the app shell being present.
        return (
          !!document.querySelector(
            '[data-testid], main, textarea, [contenteditable="true"]',
          ) && /claude\.ai/.test(location.hostname)
        );
      })
      .catch(() => false);

    if (loggedIn) {
      log.info({ url: page.url() }, "Login detected");
      return true;
    }
    if (onAuthPage && !warnedChallenge) {
      log.warn(
        "Still on auth/challenge page — if a captcha is shown, please solve it in the browser window",
      );
      warnedChallenge = true;
    }
    await sleep(2000);
  }
  log.error("Timed out waiting for login");
  throw new Error("Login did not complete before the timeout.");
}

/**
 * Best-effort onboarding handler. New accounts land on an onboarding screen that
 * asks to tick some checkboxes (e.g. consent/preferences) and choose an intended
 * use. When it appears we check every visible checkbox, then click the option
 * labelled "personal". If no onboarding UI shows up within a short wait, we log
 * and continue — onboarding is not guaranteed for every account.
 */
async function completeOnboarding(page) {
  const log = logger.child({ step: "onboarding" });
  const waitMs = Number.parseInt(process.env.ONBOARDING_WAIT_MS ?? "15000", 10);
  log.info({ waitMs }, "Checking for onboarding screen");

  // Screen 1: check every visible checkbox on the screen.
  const boxes = page.locator('input[type="checkbox"], [role="checkbox"]');
  const count = await boxes.count().catch(() => 0);
  log.info(
    { checkboxCount: count },
    "Onboarding detected; checking all checkboxes",
  );
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    if (!(await box.isVisible().catch(() => false))) continue;
    await setChecked(box, true, log, `onboarding-checkbox-${i}`);
  }

  // Screen 1: after the checkboxes, click the "Create account" button. Primary
  // selector is its stable data-testid; text-based matches are kept as fallbacks.
  const createBtn = await firstVisible(
    page,
    [
      '[data-testid="continue"]',
      'button:has-text("Create account")',
      'button:has-text("Create Account")',
      '[role="button"]:has-text("Create account")',
      ':is(button,a):has-text("Create account")',
    ],
    { timeout: 15000 },
  );
  if (!createBtn) {
    log.warn(
      'No "Create account" button found after checking the checkboxes; continuing',
    );
    return true;
  }
  await createBtn.click();
  log.info('Clicked "Create account"');

  // Screen 2: the "for personal use" choice appears after Create account.
  const personal = await firstVisible(
    page,
    [
      'button:has-text("personal")',
      '[role="radio"]:has-text("personal")',
      'label:has-text("personal")',
      ':is(button,label,div,a,li):has-text("personal")',
    ],
    { timeout: 15000 },
  );
  if (!personal) {
    log.warn('No "personal" option found after Create account; continuing');
    return true;
  }
  await personal.click();
  log.info('Clicked "for personal use"');

  // Screen 3: wait for the plan-selection screen before interacting with it.
  log.info('Waiting for "Plans that grow with you"');
  const plansHeading = page.getByText("Plans that grow with you", { exact: true });
  await plansHeading.waitFor({ state: "visible", timeout: 30000 });
  log.info('Plan-selection screen loaded: "Plans that grow with you"');

  const getMaxBtn = await firstVisible(
    page,
    [
      'button:has-text("Get Max plan")',
      '[role="button"]:has-text("Get Max plan")',
      ':is(button,a):has-text("Get Max plan")',
    ],
    { timeout: 15000 },
  );
  if (!getMaxBtn) {
    log.error('No "Get Max plan" button found on the plan-selection screen');
    throw new Error('Could not find the "Get Max plan" button.');
  }

  // Start the URL wait before clicking so a fast client-side navigation cannot
  // race past the listener. This follows the UI; it never opens the URL directly.
  log.info(
    {
      expectedUrl: MAX_ONBOARDING_URL,
      timeoutMs: MAX_ONBOARDING_URL_TIMEOUT_MS,
    },
    'Clicking "Get Max plan" and waiting for the Max onboarding URL',
  );
  await Promise.all([
    page.waitForURL((url) => url.href.startsWith(MAX_ONBOARDING_URL), {
      timeout: MAX_ONBOARDING_URL_TIMEOUT_MS,
    }),
    getMaxBtn.click(),
  ]);
  log.info({ url: page.url() }, 'Clicked "Get Max plan" and reached the Max onboarding URL');
  return true;
}

/**
 * Select the "Max 20x" plan by following the onboarding flow. We do NOT navigate
 * to any upgrade URL — onboarding is expected to land on the plan page — and act
 * on the current page. The upgrade UI markup isn't stable/known, so we match by
 * the "20x" text with fallbacks.
 */
async function selectMaxPlan(page) {
  const log = logger.child({ step: "upgrade" });

  // Give any post-onboarding navigation a moment to settle before selecting.
  await page.waitForLoadState("networkidle").catch(() => {});

  const option = await firstVisible(
    page,
    [
      'button:has-text("Max 20x")',
      '[role="radio"]:has-text("20x")',
      'label:has-text("20x")',
      ':is(button,label,div,li):has-text("20x")',
    ],
    { timeout: 30000 },
  );

  if (!option) {
    log.error(
      { url: page.url() },
      'Could not find the "Max 20x" plan option after onboarding',
    );
    throw new Error(
      'Could not find the "Max 20x" plan option (expected onboarding to land on the plan page).',
    );
  }
  log.info({ url: page.url() }, "Following onboarding to the plan selection");
  await option.click();
  log.info("Selected Max 20x plan");
}

/**
 * Manual gate: ask the user to click the extension icon and the SEPA button,
 * then auto-detect the injected panel by polling for #csh-create. The extension
 * is obfuscated and injects its panel at runtime, so we cannot open it reliably
 * from script — we wait for its presence instead.
 */
async function waitForExtensionPanel(page) {
  const log = logger.child({ step: "extension" });
  log.warn(
    { waitMs: EXTENSION_WAIT_MS },
    "ACTION NEEDED: click the 'Claude SEPA Helper' extension icon, then click the 'SEPA' button in its panel",
  );

  const panel = await findInAnyFrame(page, "#csh-create", { timeout: EXTENSION_WAIT_MS, log });
  if (!panel) {
    log.error("Timed out waiting for the SEPA panel (#csh-create) to appear");
    throw new Error("SEPA panel (#csh-create) did not appear before the timeout.");
  }
  log.info("Detected injected SEPA panel (#csh-create)");
}

/**
 * Drive the injected SEPA form: open it (#csh-create), fill the IBAN into
 * #payment-ibanInput, tick "Save payment details" and the #csh-consent checkbox,
 * click #csh-pay, and wait for the #csh-status result. Selectors come from the
 * requirement/screenshot; the extension code is obfuscated so they are not
 * statically verifiable here.
 */
async function payWithSepa(page, iban) {
  const log = logger.child({ step: "sepa-pay" });

  log.info("Clicking #csh-create to open the SEPA form");
  const createBtn = await findInAnyFrame(page, "#csh-create", { timeout: 15000, log });
  if (!createBtn) {
    log.error("#csh-create not found in any frame");
    throw new Error("SEPA create button (#csh-create) not found in any frame.");
  }
  await createBtn.click();

  // #payment-ibanInput belongs to Claude's checkout form, which is typically
  // rendered inside an iframe — search every frame, not just the main document.
  log.info("Waiting for #payment-ibanInput (searching all frames)");
  const ibanInput = await findInAnyFrame(page, "#payment-ibanInput", {
    timeout: 90000,
    log,
  });
  if (!ibanInput) {
    log.error("#payment-ibanInput did not appear in any frame after #csh-create");
    throw new Error("SEPA IBAN input (#payment-ibanInput) not found in any frame.");
  }

  await ibanInput.click();
  await ibanInput.fill(iban);
  log.info({ iban }, "Pasted IBAN into #payment-ibanInput");

  // "Save payment details for future purchases" — match by label text, fall back
  // to a nearby checkbox. Like the IBAN input, this lives in Claude's checkout
  // form, so search across frames.
  let saveToggle = null;
  for (const selector of [
    'label:has-text("Save payment details") input[type="checkbox"]',
    'input[type="checkbox"][name*="save" i]',
    'text=Save payment details for future purchases',
  ]) {
    saveToggle = await findInAnyFrame(page, selector, { timeout: 8000 });
    if (saveToggle) break;
  }
  if (saveToggle) {
    await setChecked(saveToggle, true, log, "save-payment-details");
  } else {
    log.warn('Could not find the "Save payment details" checkbox; continuing');
  }

  const consent = await findInAnyFrame(page, "#csh-consent", { timeout: 15000, log });
  if (!consent) {
    log.error("#csh-consent checkbox not found in any frame");
    throw new Error("SEPA consent checkbox (#csh-consent) not found in any frame.");
  }
  await setChecked(consent, true, log, "csh-consent");

  log.info("Clicking #csh-pay");
  const payBtn = await findInAnyFrame(page, "#csh-pay", { timeout: 15000, log });
  if (!payBtn) {
    log.error("#csh-pay button not found in any frame");
    throw new Error("SEPA pay button (#csh-pay) not found in any frame.");
  }
  await payBtn.click();

  log.info({ timeoutMs: PAY_STATUS_TIMEOUT_MS }, "Waiting for #csh-status (searching all frames)");
  const status = await findInAnyFrame(page, "#csh-status", { timeout: PAY_STATUS_TIMEOUT_MS, log });
  if (!status) {
    log.error("#csh-status did not appear in any frame");
    throw new Error("SEPA status (#csh-status) not found in any frame.");
  }
  const statusText = (await status.textContent())?.trim() ?? "";
  log.info({ statusText }, "SEPA payment status shown");
  return statusText;
}

/**
 * Ensure a checkbox-like locator is in the desired checked state. Uses check()/
 * uncheck() when possible and falls back to a click if the control is custom.
 */
async function setChecked(locator, desired, log, name) {
  try {
    if (desired) await locator.check();
    else await locator.uncheck();
    log.info({ checkbox: name, checked: desired }, "Set checkbox state");
    return;
  } catch {
    // Non-standard checkbox — toggle via click if the state differs.
  }
  const isChecked = await locator.isChecked().catch(() => null);
  if (isChecked === desired) {
    log.info(
      { checkbox: name, checked: desired },
      "Checkbox already in desired state",
    );
    return;
  }
  await locator.click().catch(() => {});
  log.info({ checkbox: name, checked: desired }, "Toggled checkbox via click");
}

async function main() {
  const launchLog = logger.child({ step: "launch" });
  launchLog.info(
    {
      userDataDir: USER_DATA_DIR,
      headless: HEADLESS,
      hasExtension: HAS_EXTENSION,
    },
    "Starting Claude registration flow",
  );

  if (HAS_EXTENSION) {
    launchLog.info({ extensionPath: EXTENSION_PATH }, "Loading extension");
    // Pin BEFORE launch: Chromium reads pinned_extensions from Preferences on
    // startup, so the profile must already carry the pin when the browser opens.
    const extensionId = computeExtensionId(EXTENSION_PATH);
    pinExtension(USER_DATA_DIR, extensionId);
  } else {
    launchLog.warn(
      { extensionPath: EXTENSION_PATH },
      "No manifest.json found; launching without the extension",
    );
  }

  // Step 1: launch the stealth binary with a persistent profile. The persistent
  // context IS the browser (Chromium over CDP under the hood); stealth + humanize
  // patches are applied directly to it. extensionPaths adds --load-extension +
  // --disable-extensions-except for us.
  const context = await launchPersistentContext({
    userDataDir: USER_DATA_DIR,
    headless: HEADLESS,
    ...(HAS_EXTENSION ? { extensionPaths: [EXTENSION_PATH] } : {}),
    // Basic-auth for the mailpit tab, scoped to its origin so claude.ai is
    // unaffected. Forwarded to launchPersistentContext via contextOptions.
    contextOptions: {
      httpCredentials: {
        username: MAILPIT_USER,
        password: MAILPIT_PASS,
        origin: MAILPIT_ORIGIN,
      },
    },
  });

  launchLog.info("Persistent context launched");

  try {
    // humanize() is a wrapper feature — re-apply it on the persistent context.
    patchContext(context, resolveConfig("default"));

    // Forward in-page console output (e.g. the Cassia mock) into pino so the
    // browser-side logs land in the same structured stream.
    context.on("page", (p) => {
      p.on("console", (msg) => {
        logger.debug(
          { step: "page-console", type: msg.type(), url: p.url() },
          msg.text(),
        );
      });
      p.on("pageerror", (err) => {
        logger.warn(
          { step: "page-error", url: p.url(), err: err?.message },
          "Uncaught page error",
        );
      });
    });

    // Inject the Cassia checkout mock before any page scripts execute.
    await context.addInitScript(CASSIA_MOCK_INIT_SCRIPT);

    // Step 2: open claude.ai.
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    logger.info(
      { step: "open-claude", url: TARGET_URL, title: await page.title() },
      "Opened claude.ai",
    );

    // Step 3: generate a fresh email (used as-is, @dellakuyang.com).
    const email = randomEmail();
    logger.info(
      { step: "generate-email", email },
      "Generated registration email",
    );

    // Step 4: register.
    await registerWithEmail(page, email);

    // Steps 5-7: open mailpit, poll for the magic-link email, extract the URL.
    const mailPage = await context.newPage();
    const magicLink = await fetchMagicLink(mailPage, email);

    // Step 8: open the magic link in a new tab to complete login.
    const magicLog = logger.child({ step: "open-magic-link", email });
    magicLog.info(
      { magicLink: redactMagicLink(magicLink) },
      "Opening magic link to complete login",
    );
    const magicPage = await context.newPage();
    await magicPage.goto(magicLink, { waitUntil: "domcontentloaded" });
    magicLog.info(
      { title: await magicPage.title(), landedOn: magicPage.url() },
      "Magic link opened",
    );

    // Step 9: wait for login (captcha stealth-only; user may solve in-window).
    await waitForLogin(magicPage);

    // Step 9b: best-effort onboarding — check all checkboxes, pick personal use,
    // click Create account. This naturally advances toward the upgrade page.
    await completeOnboarding(magicPage);

    // Step 10: generate an IBAN from randomiban.com in a separate tab.
    const ibanPage = await context.newPage();
    const iban = await getIban(ibanPage);

    // Registration is confirmed (login succeeded) and the IBAN exists — persist
    // the email|iban|profile record to output.txt.
    recordRegistration({ email, iban, userDataDir: USER_DATA_DIR });

    // Step 11: select the Max 20x plan. Runs on the same tab so it follows the
    // onboarding flow onto the plan page (no direct upgrade-URL navigation).
    await selectMaxPlan(magicPage);

    // Step 12: user manually activates the extension + SEPA button; we detect
    // the injected panel, then drive the SEPA form to completion.
    await waitForExtensionPanel(magicPage);
    const sepaStatus = await payWithSepa(magicPage, iban);

    // Step 13: open a fresh claude.ai tab.
    const finalPage = await context.newPage();
    await finalPage.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    logger.info(
      {
        step: "open-claude-final",
        url: TARGET_URL,
        title: await finalPage.title(),
      },
      "Opened final claude.ai tab",
    );

    logger.info(
      { step: "done", email, iban, sepaStatus },
      "Registration + SEPA flow finished successfully",
    );

    // Keep the session open when headed so you can interact manually.
    if (!HEADLESS) {
      logger.info("Headed session running. Press Ctrl+C to exit.");
      await new Promise(() => {});
    }
  } finally {
    // Closing the persistent context also closes the owning browser process.
    logger.debug({ step: "teardown" }, "Closing persistent context");
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  logger.error(
    { err: err?.stack ?? err?.message ?? String(err) },
    "Registration flow failed",
  );
  process.exit(1);
});
