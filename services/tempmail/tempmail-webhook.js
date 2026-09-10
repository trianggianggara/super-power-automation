const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadEnv } = require('../../utils/env.js');

loadEnv();

const PORT = Number(process.env.TEMPMAIL_WEBHOOK_PORT || 8787);
const STORE_PATH = process.env.TEMPMAIL_WEBHOOK_STORE || path.join(__dirname, '..', '..', 'data', '.tempmail-webhook.json');
const SECRET = process.env.TEMPMAIL_WEBHOOK_SECRET || '';

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return [];
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function writeStore(messages) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(messages.slice(0, 500), null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function allowed(req) {
  return !SECRET || req.headers.authorization === `Bearer ${SECRET}`;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/inbound') {
      const payload = JSON.parse(await readBody(req) || '{}');
      const messages = readStore();
      messages.unshift({
        id: crypto.randomUUID(),
        from_address: payload.from || '',
        to_address: payload.to || '',
        subject: payload.subject || '',
        text_body: payload.text || '',
        html_body: payload.html || '',
        received_at: new Date().toISOString(),
      });
      writeStore(messages);
      console.log(`${new Date().toISOString()} inbound ${payload.from || '-'} -> ${payload.to || '-'} ${payload.subject || ''}`);
      return send(res, 200, { ok: true });
    }

    if (!allowed(req)) {
      console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} 401`);
      return send(res, 401, { error: 'unauthorized' });
    }

    if (req.method === 'GET' && url.pathname === '/messages') {
      const address = (url.searchParams.get('address') || '').toLowerCase();
      const messages = readStore().filter(message =>
        !address || message.to_address.toLowerCase() === address
      );
      return send(res, 200, { messages });
    }

    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`tempmail webhook listening on :${PORT}`);
});
