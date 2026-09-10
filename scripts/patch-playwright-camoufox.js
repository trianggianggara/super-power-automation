const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
if (!fs.existsSync(file)) process.exit(0);

let source = fs.readFileSync(file, 'utf8');

// Patch 1: pageError location crash
const before1 = `url: pageError.location.url,
              line: pageError.location.lineNumber,
              column: pageError.location.columnNumber`;
const after1 = `url: pageError.location?.url || '',
              line: pageError.location?.lineNumber || 0,
              column: pageError.location?.columnNumber || 0`;

if (source.includes(before1)) {
  source = source.split(before1).join(after1);
  console.log('Applied Playwright Camoufox pageError patch.');
}

// Patch 2: WebSocket assertion crash
const before2 = `_onWebSocketOpened(event) {
        const request2 = this._webSocketRequests.get(event.requestId);
        assert(request2);
        const response2 = this._webSocketResponses.get(event.requestId);
        assert(response2);`;

const after2 = `_onWebSocketOpened(event) {
        const request2 = this._webSocketRequests.get(event.requestId);
        const response2 = this._webSocketResponses.get(event.requestId);
        if (!request2 || !response2)
          return;`;

if (source.includes(before2)) {
  source = source.split(before2).join(after2);
  console.log('Applied Playwright Camoufox webSocket assertion patch.');
}

fs.writeFileSync(file, source);

