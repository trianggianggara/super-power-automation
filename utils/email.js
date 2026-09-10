// utils/email.js — Shared email + OTP resolver for Gmail & Outlook/Hotmail
const fs = require('fs');
const path = require('path');

/**
 * Helper to safely parse CSV line handling quotes
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Load all Outlook/Hotmail accounts from CSV
 */
function loadOutlookAccounts() {
  const outlookCsv = process.env.OUTLOOK_ACCOUNTS_CSV || path.join(__dirname, '..', 'data', 'outlook_accounts.csv');
  if (!fs.existsSync(outlookCsv)) return [];
  try {
    const content = fs.readFileSync(outlookCsv, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
    const emailIdx = headers.indexOf('email');
    const passIdx = headers.indexOf('password');
    const fnIdx = headers.indexOf('first_name');
    const lnIdx = headers.indexOf('last_name');
    const recovIdx = headers.indexOf('recovery_email');
    const totpIdx = headers.indexOf('totp_secret');
    const tokenIdx = headers.indexOf('refresh_token');
    const statusIdx = headers.indexOf('status');
    const tokenStatusIdx = headers.indexOf('refresh_token_status');
    const recovStatusIdx = headers.indexOf('recovery_status');
    const createdIdx = headers.indexOf('created_at');

    const accounts = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
      const email = parts[emailIdx >= 0 ? emailIdx : 0] || '';
      const password = parts[passIdx >= 0 ? passIdx : 1] || '';
      const firstName = parts[fnIdx >= 0 ? fnIdx : 2] || '';
      const lastName = parts[lnIdx >= 0 ? lnIdx : 3] || '';
      const recoveryEmail = parts[recovIdx >= 0 ? recovIdx : 4] || '';
      const totpSecret = totpIdx >= 0 ? (parts[totpIdx] || '') : (parts[5] || '');
      const refreshToken = tokenIdx >= 0 ? (parts[tokenIdx] || '') : '';
      const status = statusIdx >= 0 ? (parts[statusIdx] || '') : '';
      const refreshTokenStatus = tokenStatusIdx >= 0 ? (parts[tokenStatusIdx] || '') : '';
      const recoveryStatus = recovStatusIdx >= 0 ? (parts[recovStatusIdx] || '') : '';
      const createdAt = createdIdx >= 0 ? (parts[createdIdx] || '') : '';

      if (email && password && (email.includes('@outlook.') || email.includes('@hotmail.'))) {
        accounts.push({
          email,
          password,
          firstName,
          lastName,
          recoveryEmail: recoveryEmail || '',
          totpSecret: totpSecret || '',
          refreshToken: refreshToken || '',
          status: status || '',
          refreshTokenStatus: refreshTokenStatus || '',
          recoveryStatus: recoveryStatus || '',
          createdAt: createdAt || '',
        });
      }
    }
    return accounts;
  } catch (err) {
    console.log(`  [WARN] Failed to read outlook_accounts.csv: ${err.message}`);
    return [];
  }
}

/**
 * Save or update refresh token and/or recovery email or status for an Outlook account in CSV
 */
function saveOutlookAccountData(email, updates = {}) {
  const outlookCsv = process.env.OUTLOOK_ACCOUNTS_CSV || path.join(__dirname, '..', 'data', 'outlook_accounts.csv');
  if (!fs.existsSync(outlookCsv)) return false;

  try {
    const content = fs.readFileSync(outlookCsv, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return false;

    const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
    const emailIdx = headers.indexOf('email');
    const passIdx = headers.indexOf('password');
    const fnIdx = headers.indexOf('first_name');
    const lnIdx = headers.indexOf('last_name');
    const recovIdx = headers.indexOf('recovery_email');
    const totpIdx = headers.indexOf('totp_secret');
    let tokenIdx = headers.indexOf('refresh_token');
    let statusIdx = headers.indexOf('status');
    const tokenStatusIdx = headers.indexOf('refresh_token_status');
    const recovStatusIdx = headers.indexOf('recovery_status');
    const createdIdx = headers.indexOf('created_at');

    const updatedLines = [];
    // Include the recovery_status header
    updatedLines.push('"email","password","first_name","last_name","recovery_email","totp_secret","refresh_token","status","refresh_token_status","recovery_status","created_at"');

    let updated = false;
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
      const accEmail = parts[emailIdx >= 0 ? emailIdx : 0] || '';
      let recov = parts[recovIdx >= 0 ? recovIdx : 4] || '';
      let token = tokenIdx >= 0 ? (parts[tokenIdx] || '') : '';
      let status = statusIdx >= 0 ? (parts[statusIdx] || '') : '';
      let rTokenStatus = tokenStatusIdx >= 0 ? (parts[tokenStatusIdx] || '') : '';
      let recovStatus = recovStatusIdx >= 0 ? (parts[recovStatusIdx] || '') : '';

      if (accEmail.toLowerCase() === email.toLowerCase()) {
        if (updates.recoveryEmail !== undefined && updates.recoveryEmail) {
          recov = updates.recoveryEmail;
        }
        if (updates.refreshToken !== undefined && updates.refreshToken) {
          token = updates.refreshToken;
          status = 'ACTIVE';
        }
        if (updates.status !== undefined) {
          status = updates.status;
        }
        if (updates.refreshTokenStatus !== undefined) {
          rTokenStatus = updates.refreshTokenStatus;
        }
        if (updates.recoveryStatus !== undefined) {
          recovStatus = updates.recoveryStatus;
        }
        updated = true;
      }

      const row = [
        parts[emailIdx >= 0 ? emailIdx : 0] || '',
        parts[passIdx >= 0 ? passIdx : 1] || '',
        parts[fnIdx >= 0 ? fnIdx : 2] || '',
        parts[lnIdx >= 0 ? lnIdx : 3] || '',
        recov,
        parts[totpIdx >= 0 ? totpIdx : 5] || '',
        token,
        status,
        rTokenStatus,
        recovStatus,
        parts[createdIdx >= 0 ? createdIdx : 6] || new Date().toISOString()
      ];

      updatedLines.push(row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }

    fs.writeFileSync(outlookCsv, updatedLines.join('\n') + '\n', 'utf8');
    return updated;
  } catch (err) {
    console.error(`  [WARN] Failed to update outlook_accounts.csv: ${err.message}`);
    return false;
  }
}

/**
 * Remove an account from outlook_accounts.csv
 */
function removeOutlookAccountFromCsv(emailToRemove) {
  const outlookCsv = process.env.OUTLOOK_ACCOUNTS_CSV || path.join(__dirname, '..', 'data', 'outlook_accounts.csv');
  if (!fs.existsSync(outlookCsv) || !emailToRemove) return false;
  try {
    const content = fs.readFileSync(outlookCsv, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length < 2) return false;
    const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
    const emailIdx = headers.indexOf('email');
    if (emailIdx === -1) return false;

    const kept = [lines[0]];
    let removed = false;
    for (let i = 1; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
      if (parts[emailIdx] && parts[emailIdx].toLowerCase() === emailToRemove.toLowerCase()) {
        removed = true;
        continue;
      }
      kept.push(lines[i]);
    }
    if (removed) {
      fs.writeFileSync(outlookCsv, kept.join('\n') + '\n', 'utf8');
      return true;
    }
  } catch (err) {
    console.error(`  [WARN] Failed removing ${emailToRemove} from CSV: ${err.message}`);
  }
  return false;
}

/**
 * Save or update refresh token for an Outlook account in CSV
 */
function saveOutlookRefreshToken(email, refreshToken) {
  return saveOutlookAccountData(email, { refreshToken });
}

const ACTIVE_EMAILS_LOCK_FILE = path.resolve(__dirname, '..', 'data', '.active_emails.json');

/**
 * Filter out active locks and get list of email addresses currently locked by running PIDs
 */
function cleanAndGetLockedEmails() {
  if (!fs.existsSync(ACTIVE_EMAILS_LOCK_FILE)) return [];
  try {
    const data = fs.readFileSync(ACTIVE_EMAILS_LOCK_FILE, 'utf8');
    if (!data.trim()) return [];
    const list = JSON.parse(data);
    if (!Array.isArray(list)) return [];

    // Filter out dead PIDs
    const active = list.filter(item => {
      if (!item.pid) return false;
      try {
        process.kill(item.pid, 0);
        return true; // PID is alive
      } catch (e) {
        return false; // PID is dead, release lock
      }
    });

    // Write back if cleaned
    if (active.length !== list.length) {
      const dir = path.dirname(ACTIVE_EMAILS_LOCK_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ACTIVE_EMAILS_LOCK_FILE, JSON.stringify(active, null, 2), 'utf8');
    }
    return active.map(item => item.email.toLowerCase());
  } catch (err) {
    return [];
  }
}

/**
 * Lock an email address for the current PID to prevent other threads from picking it
 */
function lockEmail(email) {
  if (!email) return;
  try {
    const dir = path.dirname(ACTIVE_EMAILS_LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const list = fs.existsSync(ACTIVE_EMAILS_LOCK_FILE) ? JSON.parse(fs.readFileSync(ACTIVE_EMAILS_LOCK_FILE, 'utf8') || '[]') : [];
    // Remove existing locks for this PID to prevent accumulation
    const filtered = list.filter(item => item.pid !== process.pid);
    filtered.push({ email: email.toLowerCase(), pid: process.pid, timestamp: Date.now() });
    fs.writeFileSync(ACTIVE_EMAILS_LOCK_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  } catch (err) {
    // Ignore
  }
}

/**
 * Pick fresh Outlook account not yet in output CSV (requires active refresh token, ignores LOCKED/DEAD, filters active email locks)
 */
function pickFreshOutlook(accounts, outputFile, { requireToken = true } = {}) {
  const usedEmails = new Set();
  if (outputFile && fs.existsSync(outputFile)) {
    try {
      const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 0) {
        const headerParts = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').toLowerCase());
        let emailColIdx = headerParts.indexOf('email');
        if (emailColIdx === -1) emailColIdx = 1;

        for (let i = 1; i < lines.length; i++) {
          const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
          const e = (parts[emailColIdx] || parts[1] || parts[0])?.trim().toLowerCase();
          if (e && e.includes('@')) usedEmails.add(e);
        }
      }
    } catch (_) {}
  }

  // Get currently locked emails by other running threads
  const lockedEmails = cleanAndGetLockedEmails();

  // Exclude used emails, locked emails, accounts without tokens, and case-insensitive locked, blocked, invalid, or dead accounts
  const valid = accounts.filter(a => {
    const emailLower = a.email.toLowerCase();
    if (usedEmails.has(emailLower)) return false;
    if (lockedEmails.includes(emailLower)) return false;
    const status = String(a.status || '').toUpperCase().trim();
    const tokenStatus = String(a.refreshTokenStatus || '').toUpperCase().trim();
    if (tokenStatus === 'INVALID' || tokenStatus === 'BLOCKED' || tokenStatus === 'DEAD') return false;
    if (status === 'LOCKED' || status === 'BLOCKED' || status === 'INVALID' || status === 'DEAD') return false;
    if (requireToken && (!a.refreshToken || a.refreshToken.trim().length === 0)) return false;
    return true;
  });
  if (valid.length === 0) return null;

  const chosen = valid[Math.floor(Math.random() * valid.length)];
  if (chosen) {
    lockEmail(chosen.email);
  }
  return chosen;
}

/**
 * Gmail dot-trick alias generator
 */
function generateGmailAlias(baseEmail, existingEmails = new Set(), prefix = '') {
  const atIdx = baseEmail.indexOf('@');
  const username = baseEmail.slice(0, atIdx);
  const domain = baseEmail.slice(atIdx + 1);
  const clean = username.replace(/\./g, '').split('+')[0];
  const plusSuffix = prefix ? `+${prefix}_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}` : '';

  let attempts = 0;
  while (attempts < 2000) {
    let dotted = '';
    for (let i = 0; i < clean.length; i++) {
      dotted += clean[i];
      if (i < clean.length - 1 && Math.random() < 0.4) dotted += '.';
    }
    const candidate = `${dotted}${plusSuffix}@${domain}`.toLowerCase();
    if (!existingEmails.has(candidate)) return candidate;
    attempts++;
  }
  return `${clean}${plusSuffix}@${domain}`.toLowerCase();
}

/**
 * Unified email resolver
 * @param {Object} tempmail - TempMail instance (optional)
 * @param {Object} opts
 * @param {'gmail'|'outlook'} opts.mode
 * @param {string} opts.outputFile - CSV for dedup
 * @param {string} opts.prefix - alias prefix
 * @returns {{ email: string, mode: string, outlookAccount?: object, gmailUser?: string }}
 */
async function resolveEmail(tempmail, opts = {}) {
  const mode = opts.mode || 'gmail';
  const outputFile = opts.outputFile || '';
  const prefix = opts.prefix || '';

  const existingEmails = new Set();
  if (outputFile && fs.existsSync(outputFile)) {
    try {
      const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean);
      for (let i = 1; i < lines.length; i++) {
        const parts = parseCsvLine(lines[i]).map(p => p.replace(/^"|"$/g, ''));
        const e = parts[1]?.trim().toLowerCase();
        if (e) existingEmails.add(e);
      }
    } catch (_) {}
  }

  // === Outlook/Hotmail ===
  if (mode === 'outlook') {
    const accounts = loadOutlookAccounts();
    if (accounts.length === 0) throw new Error('No Outlook accounts in outlook_accounts.csv');
    const chosen = pickFreshOutlook(accounts, outputFile);
    if (!chosen) throw new Error('All Outlook accounts already in output CSV');
    console.log(`[*] Outlook: ${chosen.email}`);
    return { email: chosen.email, mode: 'outlook', outlookAccount: chosen };
  }

  // === Gmail ===
  let gmailUser = process.env.GMAIL_USER || '';
  if (!gmailUser && tempmail) {
    try {
      const token = await tempmail._refreshGmailToken?.();
      if (token) {
        const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) gmailUser = (await res.json()).emailAddress;
      }
    } catch (_) {}
  }
  if (!gmailUser) throw new Error('No Gmail account. Set GMAIL_USER or GMAIL_REFRESH_TOKEN');

  const bases = gmailUser.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const base = bases[Math.floor(Math.random() * bases.length)];
  const alias = generateGmailAlias(base, existingEmails, prefix);
  console.log(`[*] Gmail: ${alias} (via ${base})`);
  return { email: alias, mode: 'gmail', gmailUser: base };
}

/**
 * Wait for OTP email — automatically picks Gmail or Outlook reader
 * @param {Object} opts
 * @param {string} opts.mode - 'gmail' | 'outlook'
 * @param {Object} opts.tempmail - TempMail instance (for Gmail)
 * @param {number} opts.timeout - max wait ms
 * @param {number} opts.interval - poll interval ms
 * @param {number} opts.since - since timestamp
 * @returns {string|null} OTP code
 */
async function waitForOtp(opts = {}) {
  const mode = opts.mode || 'gmail';
  const timeout = opts.timeout || 180000;
  const interval = opts.interval || 3000;
  const since = opts.since || Date.now() - 30000;

  if (mode === 'outlook') {
    // Do not retry locked Microsoft accounts: invalid_grant/service-abuse is terminal.
    try {
      if (opts.email) {
        const accounts = loadOutlookAccounts();
        const current = accounts.find(a => (a.email || '').toLowerCase() === opts.email.toLowerCase());
        if (current && String(current.status || '').toUpperCase() === 'LOCKED') {
          console.log(`  [Outlook OTP] Skipping locked account ${opts.email}.`);
          return null;
        }
      }
    } catch (_) {}
    try {
      const outlook = require('./outlook.js');
      const hasGraphToken = outlook.getRefreshTokenForEmail(opts.email);
      if (hasGraphToken) {
        const tokenOtp = await outlook.waitForOtp({ timeout, interval, since, email: opts.email }).catch(() => null);
        if (tokenOtp) return tokenOtp;
      }
      if (opts.disableWebFallback) {
        console.log('  [Outlook API] OTP not found via API. Web fallback disabled for this step.');
        return null;
      }
      const outlookWeb = require('./outlook_web.js');
      return await outlookWeb.waitForOutlookOtpWeb({
        timeout,
        interval,
        since,
        email: opts.email,
        account: opts.account || opts.outlookAccount,
        subjectContains: opts.subjectContains,
      });
    } catch (err) {
      console.error('  [email.js] Outlook OTP failed:', err.message);
      return null;
    }
  }

  // Gmail: use tempmail
  if (!opts.tempmail) throw new Error('tempmail required for Gmail mode');
  const tempmail = opts.tempmail;

  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const messages = await tempmail.getAllMessages?.() || [];
      const recent = messages.filter(m => {
        const t = Date.parse(m.received_at);
        return !isNaN(t) && t >= since;
      });
      for (const msg of recent) {
        const otp = tempmail.constructor?.extractOtp?.(msg.subject, msg.text_body, msg.html_body)
          || msg.subject?.match(/\b(\d{4,8})\b/)?.[1];
        if (otp) return otp;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, interval));
  }
  return null;
}

module.exports = {
  parseCsvLine,
  loadOutlookAccounts,
  saveOutlookRefreshToken,
  saveOutlookAccountData,
  removeOutlookAccountFromCsv,
  pickFreshOutlook,
  generateGmailAlias,
  resolveEmail,
  waitForOtp,
};
