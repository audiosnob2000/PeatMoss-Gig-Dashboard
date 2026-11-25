'use strict';
// Serves the real index.html (and the rest of the repo) for end-to-end tests, with
// ONE rewrite: the Firebase project id and emulator hookups, so the unmodified app code
// talks to the local Auth, Firestore and Functions emulators instead of production.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function rewrite(html) {
  const needle = 'const fns=firebase.functions();';
  if (!html.includes(needle)) throw new Error('index.html changed: cannot find the emulator hook point');
  let out = html.replace(/projectId:\s*['"][^'"]+['"]/, "projectId:'demo-peatmoss'");
  out = out.replace(needle, needle + "\ndb.useEmulator('127.0.0.1',8085);auth.useEmulator('http://127.0.0.1:9099',{disableWarnings:true});fns.useEmulator('127.0.0.1',5001);");
  out = out.replace('const storage=firebase.storage();', "const storage=firebase.storage();storage.useEmulator('127.0.0.1',9199);");
  return out;
}

// A test can set control.down = true to make the server drop every request (a phone with no signal, as the service worker sees it).
const control = { down: false };

function start(port = 8099) {
  const server = http.createServer((req, res) => {
    if (control.down) return req.socket.destroy();
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    let body = fs.readFileSync(file);
    if (p === '/index.html') body = Buffer.from(rewrite(body.toString('utf8')));
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}
module.exports = { start, rewrite, control };
if (require.main === module) start().then(() => console.log('serving on http://127.0.0.1:8099'));
