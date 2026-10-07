// Self-hosted server: same API and site as the Vercel deploy, stored in SQLite. Also used by tests and local dev.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../lib/handle.js';
import { supabaseDb } from '../lib/db-supabase.js';

// node:sqlite needs 22.13; check first (and import it lazily) so an old Node gets a message, not a stack trace.
const MIN_NODE = '22.13';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`whyline server: Node.js ${MIN_NODE} or newer is required (this is ${process.versions.node}).`);
  process.exit(1);
}

const db = process.env.WHYLINE_DB === 'supabase'
  ? supabaseDb
  : (await import('../lib/db-sqlite.js')).sqliteDb(process.env.DB_PATH ?? new URL('./whyline.db', import.meta.url).pathname);

// Same security headers as the Vercel deploy: vercel.json is the one place they are defined.
const SECURITY_HEADERS = Object.fromEntries(JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  .headers.find((h) => h.source === '/(.*)').headers.map(({ key, value }) => [key.toLowerCase(), value]));

// Signups are limited per client address. Unset, X-Forwarded-For is ignored (anyone can send one) and the socket
// address is used. Behind reverse proxies, set WHYLINE_TRUST_PROXY to how many there are (usually 1): the address is
// then the entry that many places from the right of X-Forwarded-For, the part those proxies wrote themselves.
function clientAddress(req) {
  const hops = Number(process.env.WHYLINE_TRUST_PROXY) || 0;
  const chain = (req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return (hops > 0 && chain.length >= hops ? chain[chain.length - hops] : req.socket.remoteAddress) ?? 'unknown';
}

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url)); // ends with '/'
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

// Maps a URL path to a file inside public/, like Vercel's cleanUrls: / -> index.html, /docs -> docs.html.
// Only whitelisted extensions, no dotfiles, and nothing outside public/ (path traversal).
async function staticFile(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\0') || /(^|[\\/])\./.test(p)) return null;
  const base = p.replace(/\/+$/, '') || '/index';
  for (const candidate of [base, base + '.html']) {
    const file = resolve(PUBLIC, '.' + candidate);
    if (!file.startsWith(PUBLIC) || !TYPES[extname(file)]) continue;
    if ((await stat(file).catch(() => null))?.isFile()) return file;
  }
  return null;
}

const fail = (res, status, error) => res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json' }).end(JSON.stringify({ error }));

export const server = http.createServer(async (req, res) => {
  // Nothing a client sends may take the process down: bad URLs get a 400, anything unexpected a 500.
  try {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); } catch { return fail(res, 400, 'bad request'); }
    if (req.method === 'GET' && !/^\/api(\/|$)/.test(url.pathname)) {
      const file = await staticFile(url.pathname);
      const notFound = !file && (await staticFile('/404'));
      res.writeHead(file ? 200 : 404, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file || notFound)] })
        .end(await readFile(file || notFound));
      return;
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const headers = { ...req.headers, 'x-forwarded-for': clientAddress(req) };
    const response = await handle(new Request(url, { method: req.method, headers, body: hasBody ? req : undefined, duplex: 'half' }), db);
    // After an early 413, Node reads and discards the rest of the upload (never buffered; requestTimeout bounds it).
    // Closing instead would make the client's next write hit a reset, which can arrive before it reads the 413.
    res.writeHead(response.status, { ...SECURITY_HEADERS, ...Object.fromEntries(response.headers) }).end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.destroy(); else fail(res, 500, 'internal error');
  }
});

server.listen(Number(process.env.PORT ?? 3000), () => console.log(`whyline on :${server.address().port}`));
