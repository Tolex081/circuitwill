// Minimal static server for local development (no dependencies). Serves frontend/ and circuits/lib/ (the reference
// NAND simulator used by the offline re-evaluation check) on 127.0.0.1 only.
//   node frontend/serve.mjs            -> http://127.0.0.1:5173/frontend/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 5173);
const ALLOWED = ['/frontend/', '/circuits/lib/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/' || path === '/frontend') {
      res.writeHead(302, { Location: '/frontend/' }).end();
      return;
    }
    if (!ALLOWED.some((p) => path.startsWith(p))) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (!(await stat(file)).isFile()) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' }).end(e.code === 'ENOENT' ? 'Not found' : 'Error');
  }
}).listen(port, '127.0.0.1', () => console.log(`CircuitWill dashboard: http://127.0.0.1:${port}/frontend/`));
