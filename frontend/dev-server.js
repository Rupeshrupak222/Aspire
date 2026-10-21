// Zero-dependency static dev server for the Aspire frontend.
// Serves the files in this folder and proxies /api/* to the backend so the
// student/admin pages work exactly like production (same-origin API calls).
//
//   npm run dev            -> http://localhost:5173  (API proxied to :3000)
//
// Env:
//   FRONTEND_PORT   port to listen on            (default 5173)
//   API_TARGET      backend base URL for /api/*  (default http://localhost:3000)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.FRONTEND_PORT, 10) || 5173;
const API_TARGET = (process.env.API_TARGET || 'http://localhost:3000').replace(/\/+$/, '');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function proxyApi(req, res) {
  const target = new URL(API_TARGET + req.url);
  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    method: req.method,
    headers: { ...req.headers, host: target.host }
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Backend not reachable at ' + API_TARGET, detail: err.message }));
  });
  req.pipe(proxyReq);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve safely inside ROOT (no path traversal).
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + urlPath);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxyApi(req, res);
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[frontend] dev server on http://localhost:${PORT}`);
  console.log(`[frontend] proxying /api/* -> ${API_TARGET}`);
});
