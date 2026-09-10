const crypto = require('crypto');
const { loadEnv } = require('../../utils/env.js');
loadEnv();

class TempMail {
    static PROVIDER = null;

    constructor(ownerToken = null) {
        if (!ownerToken) {
            this.ownerToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
        } else {
            this.ownerToken = ownerToken;
        }
    }

    _getGmailTokenFor(emailAddress) {
        const gmailUsers = (process.env.GMAIL_USER || '').split(',').map(u => u.trim()).filter(Boolean);
        const gmailRefreshTokens = (process.env.GMAIL_REFRESH_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean);

        const lowerAddress = emailAddress.toLowerCase();

        let lookupKey = '';
        if (lowerAddress.includes('@')) {
            const [local, domain] = lowerAddress.split('@');
            const baseLocal = local.split('+')[0].replace(/\./g, '');
            lookupKey = `${baseLocal}@${domain}`;
        } else {
            lookupKey = lowerAddress.replace(/\./g, '');
        }

        const index = gmailUsers.findIndex(u => {
            const lowerU = u.toLowerCase();
            if (lowerU.includes('@')) {
                const [local, domain] = lowerU.split('@');
                const baseLocal = local.replace(/\./g, '');
                return `${baseLocal}@${domain}` === lookupKey;
            }
            return lowerU.replace(/\./g, '') === lookupKey;
        });

        if (index !== -1 && gmailRefreshTokens[index]) {
            return gmailRefreshTokens[index];
        }

        // Return first token if not found or list is single-item
        return gmailRefreshTokens[0] || null;
    }

    async _refreshGmailToken(refreshToken = null) {
        const clientId = process.env.GMAIL_CLIENT_ID;
        const clientSecret = process.env.GMAIL_CLIENT_SECRET;
        let actualToken = refreshToken;
        if (!actualToken) {
            const tokens = (process.env.GMAIL_REFRESH_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean);
            actualToken = tokens[0] || null;
        }

        if (!clientId || !clientSecret || !actualToken) {
            throw new Error("Missing GMAIL credentials (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) in .env");
        }

        const res = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: actualToken,
                grant_type: "refresh_token"
            })
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Gmail Token Refresh Error ${res.status}: ${text}`);
        }

        const data = await res.json();
        return data.access_token;
    }

    async getDomains(includeVip = false) {
        const domainsEnv = process.env.TEMPMAIL_WEBHOOK_DOMAIN || '';
        const domainsList = domainsEnv.split(',').map(d => d.trim()).filter(Boolean);
        return domainsList.map(d => ({ domain: d, label: d, vip_only: false }));
    }

    async createInbox(desiredLocal = null, domain = null) {
        const provider = TempMail.PROVIDER || process.env.TEMPMAIL_PROVIDER || 'webhook';

        if (provider === 'supabase') {
            throw new Error("Supabase provider is disabled for privacy and security. Please configure TEMPMAIL_PROVIDER=webhook or TEMPMAIL_PROVIDER=mailpit in .env.");
        }

        if (provider === 'webhook') {
            if (!domain) {
                if (process.env.TEMPMAIL_WEBHOOK_DOMAIN) {
                    const targetDomains = process.env.TEMPMAIL_WEBHOOK_DOMAIN.split(',').map(d => d.trim()).filter(Boolean);
                    if (targetDomains.length > 0) {
                        domain = targetDomains[Math.floor(Math.random() * targetDomains.length)];
                    }
                }
            }
            if (!desiredLocal) {
                desiredLocal = `user_${crypto.randomBytes(4).toString('hex')}`;
            }
            return {
                address: `${desiredLocal}@${domain}`,
                owner_token: this.ownerToken
            };
        }

        if (provider === 'mailpit') {
            if (!domain) {
                domain = process.env.MAILPIT_DOMAIN || 'localhost';
            }
            if (!desiredLocal) {
                desiredLocal = `user_${crypto.randomBytes(4).toString('hex')}`;
            }
            return {
                address: `${desiredLocal}@${domain}`,
                owner_token: this.ownerToken
            };
        }

        if (provider === 'gmail') {
            const gmailUsersEnv = process.env.GMAIL_USER;
            if (!gmailUsersEnv) {
                throw new Error("Missing GMAIL_USER in .env");
            }
            const gmailUsers = gmailUsersEnv.split(',').map(u => u.trim()).filter(Boolean);
            if (gmailUsers.length === 0) {
                throw new Error("No emails found in GMAIL_USER in .env");
            }

            // Pick a random Gmail user from the list
            const selectedGmail = gmailUsers[Math.floor(Math.random() * gmailUsers.length)];

            const atIdx = selectedGmail.indexOf('@');
            if (atIdx === -1) {
                throw new Error(`Invalid GMAIL_USER format in .env for email: ${selectedGmail}`);
            }
            const username = selectedGmail.slice(0, atIdx);
            const domainName = selectedGmail.slice(atIdx + 1);

            if (!desiredLocal) {
                desiredLocal = `user_${crypto.randomBytes(4).toString('hex')}`;
            }
            const address = `${username}+${desiredLocal}@${domainName}`;
            return {
                address,
                owner_token: this.ownerToken
            };
        }

        throw new Error(`Unsupported TEMPMAIL_PROVIDER: ${provider}`);
    }

    async getMessages(address) {
        let provider = TempMail.PROVIDER || process.env.TEMPMAIL_PROVIDER || 'webhook';
        const gmailUsers = (process.env.GMAIL_USER || '').split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
        const isGmailUser = address && gmailUsers.some(u => {
            if (u.includes('@')) {
                const domain = u.split('@')[1];
                return address.toLowerCase().endsWith('@' + domain);
            }
            return false;
        });
        if (address && (address.toLowerCase().endsWith('@gmail.com') || address.toLowerCase().endsWith('@googlemail.com') || isGmailUser)) {
            provider = 'gmail';
        }

        if (provider === 'supabase') {
            throw new Error("Supabase provider is disabled for privacy and security. Please configure TEMPMAIL_PROVIDER=webhook or TEMPMAIL_PROVIDER=mailpit in .env.");
        }

        if (provider === 'webhook') {
            const apiBase = (process.env.TEMPMAIL_WEBHOOK_API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
            const headers = {};
            if (process.env.TEMPMAIL_WEBHOOK_SECRET) {
                headers['Authorization'] = `Bearer ${process.env.TEMPMAIL_WEBHOOK_SECRET}`;
            }
            const res = await fetch(`${apiBase}/messages?address=${encodeURIComponent(address)}`, { headers });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Webhook Error ${res.status}: ${text}`);
            }
            const data = await res.json();
            return data.messages || [];
        }

        if (provider === 'mailpit') {
            const apiBase = (process.env.MAILPIT_API_URL || 'http://127.0.0.1:8025').replace(/\/$/, '');
            const headers = {};
            if (process.env.MAILPIT_USERNAME && process.env.MAILPIT_PASSWORD) {
                headers['Authorization'] = `Basic ${Buffer.from(`${process.env.MAILPIT_USERNAME}:${process.env.MAILPIT_PASSWORD}`).toString('base64')}`;
            }
            const params = new URLSearchParams({ query: `to:"${address}"`, limit: '50' });
            const res = await fetch(`${apiBase}/api/v1/search?${params}`, { headers });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Mailpit Error ${res.status}: ${text}`);
            }
            const data = await res.json();
            const targetAddress = address.toLowerCase();
            const messages = (data.messages || []).filter(msg =>
                (msg.To || []).some(to => (to.Address || '').toLowerCase() === targetAddress)
            );

            const detailedMessages = await Promise.all(messages.map(async (msg) => {
                try {
                    const detailRes = await fetch(`${apiBase}/api/v1/message/${msg.ID}`, { headers });
                    if (detailRes.ok) {
                        const detail = await detailRes.json();
                        return {
                            id: msg.ID,
                            from_address: msg.From ? msg.From.Address : '',
                            to_address: address,
                            subject: msg.Subject || '',
                            text_body: detail.Text || '',
                            html_body: detail.HTML || '',
                            received_at: msg.Created || new Date().toISOString()
                        };
                    }
                } catch (e) {
                    console.error(`Error fetching Mailpit detailed message: ${e.message}`);
                }
                return {
                    id: msg.ID,
                    from_address: msg.From ? msg.From.Address : '',
                    to_address: address,
                    subject: msg.Subject || '',
                    text_body: '',
                    html_body: '',
                    received_at: msg.Created || new Date().toISOString()
                };
            }));

            return detailedMessages;
        }

        if (provider === 'gmail') {
            const refreshToken = this._getGmailTokenFor(address);
            const accessToken = await this._refreshGmailToken(refreshToken);
            let qStr = `to:${address}`;
            if (address && address.includes('@')) {
                const [localPart, domainPart] = address.split('@');
                const cleanLocal = localPart.replace(/\./g, '').split('+')[0];
                const cleanEmail = `${cleanLocal}@${domainPart}`;
                qStr = `to:${address} OR to:${cleanEmail}`;
            }
            const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(qStr)}&maxResults=10`, {
                headers: {
                    "Authorization": `Bearer ${accessToken}`
                }
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Gmail API List Error ${res.status}: ${text}`);
            }

            const data = await res.json();
            const messages = (data.messages || []).slice(0, 10);

            const detailedMessages = await Promise.all(messages.map(async (msg) => {
                try {
                    const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
                        headers: {
                            "Authorization": `Bearer ${accessToken}`
                        }
                    });
                    if (detailRes.ok) {
                        const detail = await detailRes.json();
                        const headersList = detail.payload ? detail.payload.headers || [] : [];

                        const getHeader = (name) => {
                            const h = headersList.find(h => h.name.toLowerCase() === name.toLowerCase());
                            return h ? h.value : '';
                        };

                        const bodies = { text: '', html: '' };
                        const extractBodies = (part) => {
                            if (part.body && part.body.data) {
                                const base64 = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
                                const decoded = Buffer.from(base64, 'base64').toString('utf8');
                                if (part.mimeType === 'text/plain') {
                                    bodies.text += decoded;
                                } else if (part.mimeType === 'text/html') {
                                    bodies.html += decoded;
                                }
                            }
                            if (part.parts) {
                                for (const sub of part.parts) {
                                    extractBodies(sub);
                                }
                            }
                        };

                        if (detail.payload) {
                            extractBodies(detail.payload);
                        }

                        if (!bodies.text && !bodies.html && detail.payload && detail.payload.body && detail.payload.body.data) {
                            const base64 = detail.payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
                            const decoded = Buffer.from(base64, 'base64').toString('utf8');
                            if (detail.payload.mimeType === 'text/plain') {
                                bodies.text = decoded;
                            } else if (detail.payload.mimeType === 'text/html') {
                                bodies.html = decoded;
                            }
                        }

                        return {
                            id: msg.id,
                            from_address: getHeader('from'),
                            to_address: address,
                            subject: getHeader('subject'),
                            text_body: bodies.text,
                            html_body: bodies.html,
                            received_at: new Date(parseInt(detail.internalDate, 10)).toISOString()
                        };
                    }
                } catch (e) {
                    console.error(`Error fetching Gmail detailed message ${msg.id}: ${e.message}`);
                }
                return null;
            }));

            return detailedMessages.filter(Boolean);
        }

        throw new Error(`Unsupported TEMPMAIL_PROVIDER: ${provider}`);
    }

    static decodeMimeHeader(str) {
        if (!str) return '';
        return str.replace(/=\?([^?]+)\?([QBqb])\?([^?]+)\?=/g, (match, charset, encoding, text) => {
            if (encoding.toUpperCase() === 'B') {
                return Buffer.from(text, 'base64').toString('utf8');
            } else if (encoding.toUpperCase() === 'Q') {
                return text.replace(/_=/g, ' ').replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            }
            return match;
        });
    }

    static stripEmailHeaders(text) {
        if (!text) return '';
        const lines = text.split(/\r?\n/);
        const bodyLines = [];
        let inHeaders = true;
        for (const line of lines) {
            if (inHeaders) {
                if (line.trim() === '') {
                    inHeaders = false;
                    continue;
                }
                if (/^(Received|ARC-|DKIM-|Authentication-Results|X-|Date:|From:|To:|Subject:|Message-ID:|MIME-Version:|Content-|SC-|REPLY-TO:)/i.test(line)) {
                    continue;
                }
                if (/^\s+/.test(line)) {
                    continue;
                }
                inHeaders = false;
            }
            bodyLines.push(line);
        }
        return bodyLines.join('\n');
    }

    static cleanHtml(rawHtml) {
        if (!rawHtml) return "";
        return rawHtml
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/https?:\/\/\S+/gi, " ")
            .replace(/\s(?:href|src|action|data-[\w-]+)\s*=\s*"[^"]*"/gi, " ")
            .replace(/\s(?:href|src|action|data-[\w-]+)\s*=\s*'[^']*'/gi, " ")
            .replace(/#[0-9a-fA-F]{3,8}\b/g, " ")
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, " ")
            .replace(/(?:expires?|valid|berlaku|kedaluwarsa)\s+(?:in|for|selama|within)?\s*\d+\s*(?:minutes?|mins?|menit|seconds?|secs?|detik|hours?|jam)/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&#(\d+);/g, (e, n) => String.fromCharCode(parseInt(n, 10)))
            .replace(/&zwnj;|&zwj;/gi, "");
    }

    static normalizeDigits(text) {
        let e = text.replace(/(?:\d[\s\-\u00A0]+){3,7}\d/g, n => {
            const t = n.replace(/[\s\-\u00A0]+/g, "");
            return t.length >= 4 && t.length <= 8 ? t : n;
        });
        return e.replace(/\b\d{2,4}(?:[\s\-\u00A0]+\d{2,4}){1,3}\b/g, n => {
            const t = n.replace(/[\s\-\u00A0]+/g, "");
            return t.length >= 4 && t.length <= 8 ? t : n;
        });
    }

    static isYear(code) {
        if (code.length !== 4) return false;
        const val = parseInt(code, 10);
        return val >= 1900 && val <= 2099;
    }

    static filterCodes(codes) {
        const valid = codes.filter(c => !TempMail.isYear(c));
        if (valid.length === 0) return null;
        return valid.find(c => c.length === 6) ?? valid[0];
    }

    static extractOtp(subject, textBody, htmlBody) {
        const p = "(?:otp|kode|code|verif(?:y|ication|ikasi)?|pin|password|passcode|security|launch\\s+code|one[-\\s]?time(?:\\s+code|\\s+password)?|2fa)";

        const decodedSubj = TempMail.decodeMimeHeader(subject || '');
        const cleanSubj = decodedSubj.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ');

        // Check subject first if it directly has OTP
        const subjMatch = cleanSubj.match(new RegExp(`${p}[^\\d]{0,40}\\b(\\d{4,8})\\b`, 'i')) || cleanSubj.match(/\b(\d{6})\b/);
        if (subjMatch) {
            const val = parseInt(subjMatch[1], 10);
            if (subjMatch[1].length !== 4 || (val < 1900 || val > 2099)) {
                return subjMatch[1];
            }
        }

        const cleanText = TempMail.stripEmailHeaders(textBody || '');
        const cleanHtmlBody = TempMail.stripEmailHeaders(htmlBody || '');

        const parts = [cleanSubj, cleanText, cleanHtmlBody].filter(Boolean);
        const rawCombined = parts.join("\n");
        if (!rawCombined) return null;

        const cleaned = TempMail.normalizeDigits(TempMail.cleanHtml(rawCombined));

        // Priority 1: Keyword followed by digits (4-8 digits, allowing newlines/spaces)
        const pattern1 = new RegExp(`${p}[^\\d]{0,100}\\b(\\d{4,8})\\b`, "gi");
        const matches1 = [];
        for (const s of cleaned.matchAll(pattern1)) {
            matches1.push(s[1]);
        }
        let otp = TempMail.filterCodes(matches1);
        if (otp) return otp;

        // Priority 2: Digits followed by keyword (4-8 digits)
        const pattern2 = new RegExp(`\\b(\\d{4,8})\\b[^\\d]{0,100}${p}`, "gi");
        const matches2 = [];
        for (const s of cleaned.matchAll(pattern2)) {
            matches2.push(s[1]);
        }
        otp = TempMail.filterCodes(matches2);
        if (otp) return otp;

        // Priority 3: Keyword followed by alphanumeric code (must contain digits or be hyphenated)
        const pattern3 = new RegExp(`${p}[^\\a-z0-9\\n]{0,20}\\b([A-Z0-9]{3}-[A-Z0-9]{3}|(?=.*\\d)[A-Z0-9]{4,8})\\b`, "gi");
        const matches3 = [];
        for (const s of cleaned.matchAll(pattern3)) {
            matches3.push(s[1].replace('-', ''));
        }
        if (matches3.length > 0) return matches3[0];

        // Priority 4: Hyphenated code formatted as XXX-XXX containing at least 1 digit or near keyword
        const hyphenMatch = cleaned.match(/\b(?=.*\d)([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
        if (hyphenMatch) return hyphenMatch[1].replace('-', '');

        // Priority 5: Fallback to any 4-8 digits
        const matches5 = cleaned.match(/\b\d{4,8}\b/g) ?? [];
        return TempMail.filterCodes(matches5);
    }

    async waitForEmail(address, timeoutMs = 120000, pollIntervalMs = 5000, since = Date.now() - 5000) {
        const startTime = Date.now();
        console.log(`Waiting for emails on ${address} (Timeout: ${timeoutMs / 1000}s, since: ${new Date(since).toISOString()})...`);

        while (Date.now() - startTime < timeoutMs) {
            try {
                const messages = await this.getMessages(address);
                if (messages && messages.length > 0) {
                    const newMessages = messages.filter(msg => {
                        const recTime = Date.parse(msg.received_at);
                        return isNaN(recTime) || recTime >= since;
                    });
                    if (newMessages.length > 0) {
                        return newMessages[0];
                    }
                }
            } catch (e) {
                console.error("Polling error:", e.message);
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        return null;
    }

    async waitForOtp(address, timeoutMs = 120000, pollIntervalMs = 2000, since = Date.now() - 120000) {
        const startTime = Date.now();
        console.log(`Waiting for OTP on ${address} (Timeout: ${timeoutMs / 1000}s, since: ${new Date(since).toISOString()})...`);

        while (Date.now() - startTime < timeoutMs) {
            try {
                const messages = await this.getMessages(address);
                if (messages && messages.length > 0) {
                    const newMessages = messages.filter(msg => {
                        const recTime = Date.parse(msg.received_at);
                        return isNaN(recTime) || recTime >= since;
                    }).sort((a, b) => (Date.parse(b.received_at) || 0) - (Date.parse(a.received_at) || 0));

                    for (const msg of newMessages) {
                        const otp = TempMail.extractOtp(msg.subject, msg.text_body, msg.html_body);
                        if (otp) {
                            console.log(`Received email from: ${msg.from_address} - Subject: ${msg.subject} -> Extracted OTP: ${otp}`);
                            return otp;
                        }
                    }
                }
            } catch (e) {
                console.error("Polling error:", e.message);
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        return null;
    }
}

module.exports = TempMail;

// CLI runner
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const client = new TempMail();

        if (args[0] === "domains") {
            console.log("Fetching active domains...");
            try {
                const domains = await client.getDomains();
                domains.forEach(d => console.log(`- ${d.domain} (${d.label})`));
            } catch (e) {
                console.error("Error:", e.message);
            }
        } else if (args[0] === "listen") {
            const addr = args[1];
            if (!addr) {
                console.log("Usage: node tempmail.js listen <email_address>");
                process.exit(1);
            }
            console.log(`Listening to ${addr}...`);
            const otp = await client.waitForOtp(addr, 300000);
            if (otp) {
                console.log(`SUCCESS! Detected OTP Code: ${otp}`);
            } else {
                console.log("TIMEOUT: No OTP detected.");
            }
        } else {
            console.log("Creating a temporary email address...");
            try {
                const inbox = await client.createInbox();
                const email = inbox.address;
                console.log(`\nCreated successfully! Alamat email: \x1b[1m\x1b[32m${email}\x1b[0m`);
                console.log("Token pemilik (owner_token):", inbox.owner_token);
                console.log("\nAnda bisa mengirimkan email ke alamat ini sekarang.");
                console.log("Menunggu email masuk dan mendeteksi kode verifikasi (OTP)...");

                const otp = await client.waitForOtp(email, 180000);
                if (otp) {
                    console.log(`\n\x1b[1m\x1b[36mKODE VERIFIKASI / OTP TERDETEKSI: ${otp}\x1b[0m\n`);
                } else {
                    console.log("\nTidak ada email baru / OTP terdeteksi dalam 3 menit.");
                }
            } catch (e) {
                console.error("Error:", e.message);
            }
        }
    })();
}
