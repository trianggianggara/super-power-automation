const fs = require('fs');
const path = require('path');
const net = require('net');

// Accept file name as argument, default to '.tempmail-webhook-8787.json'
const defaultFilename = '.tempmail-webhook-8787.json';
const targetFileArg = process.argv[2] || defaultFilename;
const filePath = path.isAbsolute(targetFileArg) 
  ? targetFileArg 
  : path.join(__dirname, '..', targetFileArg);

if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found at ${filePath}`);
  console.error(`Usage: node scripts/import-to-mailpit.js [filename.json]`);
  process.exit(1);
}

let emails;
try {
  emails = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (e) {
  console.error(`Error parsing JSON file: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(emails)) {
  // If the webhook payload is a single object instead of an array
  emails = [emails];
}

console.log(`Successfully read ${emails.length} email(s) from ${path.basename(filePath)}.`);

function sendEmailViaSMTP(email) {
  return new Promise((resolve, reject) => {
    // Mailpit SMTP port is 1025 by default
    const socket = net.createConnection(1025, '127.0.0.1');
    let step = 0;
    
    socket.setTimeout(10000);
    
    socket.on('connect', () => {
      // Waiting for 220 banner
    });
    
    socket.on('data', (data) => {
      const response = data.toString();
      
      // Basic SMTP state machine
      if (response.startsWith('220') && step === 0) {
        socket.write('EHLO localhost\r\n');
        step = 1;
      } else if (response.startsWith('250') && step === 1) {
        // If from_address is missing, use a fallback
        const from = email.from_address || email.from || 'test@example.com';
        socket.write(`MAIL FROM:<${from}>\r\n`);
        step = 2;
      } else if (response.startsWith('250') && step === 2) {
        const to = email.to_address || email.to || 'recipient@example.com';
        socket.write(`RCPT TO:<${to}>\r\n`);
        step = 3;
      } else if (response.startsWith('250') && step === 3) {
        socket.write('DATA\r\n');
        step = 4;
      } else if (response.startsWith('354') && step === 4) {
        // Get raw MIME source. We prefer text_body since it contains full headers and multipart structure.
        // If text_body doesn't start with headers, we can construct minimal headers,
        // but since this is raw, it should be complete.
        let rawMime = email.text_body || email.text || '';
        
        // If the email is not raw MIME (e.g. lacks Subject header), build a simple one
        if (!rawMime.toLowerCase().includes('subject:')) {
          const from = email.from_address || email.from || 'test@example.com';
          const to = email.to_address || email.to || 'recipient@example.com';
          const subject = email.subject || 'Imported Webhook Email';
          const body = email.html_body || email.html || email.text_body || email.text || '';
          const isHtml = !!(email.html_body || email.html);
          
          rawMime = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
            `Date: ${email.received_at || new Date().toISOString()}`,
            '',
            body
          ].join('\r\n');
        }
        
        const lines = rawMime.split(/\r?\n/);
        for (const line of lines) {
          // SMTP Dot stuffing: if line starts with a dot, prefix with an extra dot
          if (line.startsWith('.')) {
            socket.write('.' + line + '\r\n');
          } else {
            socket.write(line + '\r\n');
          }
        }
        // End of mail DATA transmission
        socket.write('.\r\n');
        step = 5;
      } else if (response.startsWith('250') && step === 5) {
        socket.write('QUIT\r\n');
        step = 6;
      } else if (response.startsWith('221') && step === 6) {
        socket.end();
        resolve();
      } else if (response.startsWith('5') || response.startsWith('4')) {
        socket.end();
        reject(new Error(`SMTP server rejected command: ${response.trim()}`));
      }
    });

    socket.on('timeout', () => {
      socket.end();
      reject(new Error('SMTP connection timed out.'));
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });
}

async function run() {
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const idx = emails.length - i; // Webhook stores in reverse order (newest first), so process them logically
    const subject = email.subject || '(No Subject)';
    const from = email.from_address || email.from || 'Unknown';
    const to = email.to_address || email.to || 'Unknown';
    
    console.log(`[${i + 1}/${emails.length}] Importing: "${subject}" | From: ${from} -> To: ${to}...`);
    try {
      await sendEmailViaSMTP(email);
      console.log(`  -> Success!`);
      successCount++;
    } catch (err) {
      console.error(`  -> Failed: ${err.message}`);
      failCount++;
    }
  }
  
  console.log(`\nImport complete! Success: ${successCount}, Failed: ${failCount}`);
  console.log(`You can now check the Mailpit Web UI at http://localhost:8025 to view the emails.`);
}

run();
