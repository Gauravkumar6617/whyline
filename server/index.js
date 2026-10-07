// Self-hosted server: same API and site as the Vercel deploy, stored in SQLite. Also used by tests and local dev.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../lib/handle.js';
import { sqliteDb } from '../lib/db-sqlite.js';
import { supabaseDb } from '../lib/db-supabase.js';

const db = process.env.WHYLINE_DB === 'supabase'
  ? supabaseDb
  : sqliteDb(process.env.DB_PATH ?? new URL('./whyline.db', import.meta.url).pathname);

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

const fail = (res, status, error) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));

export const server = http.createServer(async (req, res) => {
  // Nothing a client sends may take the process down: bad URLs get a 400, anything unexpected a 500.
  try {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); } catch { return fail(res, 400, 'bad request'); }
    if (req.method === 'GET' && !/^\/api(\/|$)/.test(url.pathname)) {
      const file = await staticFile(url.pathname);
      const notFound = !file && (await staticFile('/404'));
      res.writeHead(file ? 200 : 404, { 'content-type': TYPES[extname(file || notFound)], 'x-content-type-options': 'nosniff' })
        .end(await readFile(file || notFound));
      return;
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const response = await handle(new Request(url, { method: req.method, headers: req.headers, body: hasBody ? req : undefined, duplex: 'half' }), db);
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.destroy(); else fail(res, 500, 'internal error');
  }
});

server.listen(Number(process.env.PORT ?? 3000), () => console.log(`whyline on :${server.address().port}`));
