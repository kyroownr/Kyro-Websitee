/* Minimal static file server for local preview: node tools/serve.js
   Mirrors GitHub Pages clean-URL behaviour: /windows -> windows/index.html */
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp' };
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let p = path.normalize(path.join(root, url === '/' ? 'index.html' : url));
  if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.stat(p, (err, st) => {
    if (!err && st.isDirectory()) p = path.join(p, 'index.html');
    fs.readFile(p, (e, buf) => {
      if (e) {
        fs.readFile(path.join(root, '404.html'), (error, page) => {
          res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-store' });
          res.end(error ? 'not found' : page);
        });
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
}).listen(4173, () => console.log('Kyro running at http://localhost:4173'));
