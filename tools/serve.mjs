#!/usr/bin/env node
/**
 * Zero-dependency static server for the WebAR app.
 *
 *   node tools/serve.mjs                       # http://localhost:8080
 *   node tools/serve.mjs --port 9000 --host 0.0.0.0
 *   node tools/serve.mjs --https --cert certs/cert.pem --key certs/key.pem
 *
 * WebXR and AR Quick Look need a secure context: use https:// on phones
 * (or http://localhost via `adb reverse` for Android, see README).
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(opt('root', path.join(here, '..', 'public')));
const port = Number(opt('port', process.env.PORT || 8080));
const host = opt('host', '0.0.0.0');
const useHttps = !!opt('https', false);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end('Forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
      const headers = {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      };
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  } catch {
    res.writeHead(400).end('Bad request');
  }
}

const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(opt('cert', 'certs/cert.pem')), key: fs.readFileSync(opt('key', 'certs/key.pem')) }, handler)
  : http.createServer(handler);

server.listen(port, host, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`Serving ${root}`);
  console.log(`  ${proto}://localhost:${port}/`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) if (n.family === 'IPv4' && !n.internal) console.log(`  ${proto}://${n.address}:${port}/`);
  }
  if (!useHttps) console.log('\nNote: phones need HTTPS for AR (see README › Testing AR on a phone).');
});
