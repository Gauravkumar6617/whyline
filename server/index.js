// Self-hosted server: same API and site as the Vercel deploy, stored in SQLite. Also used by tests and local dev.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { handle } from '../lib/handle.js';
import { sqliteDb } from '../lib/db-sqlite.js';
import { supabaseDb } from '../lib/db-supabase.js';

const db = process.env.WHYLINE_DB === 'supabase'
  ? supabaseDb
  : sqliteDb(process.env.DB_PATH ?? new URL('./whyline.db', import.meta.url).pathname);

const asset = (file, type) => [readFileSync(new URL(`../public/${file}`, import.meta.url)), type];
const PAGES = {
  '/': asset('index.html', 'text/html; charset=utf-8'),
  '/app': asset('app.html', 'text/html; charset=utf-8'),
  '/style.css': asset('style.css', 'text/css'),
  '/logo.svg': asset('logo.svg', 'image/svg+xml'),
};

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const page = req.method === 'GET' && PAGES[url.pathname];
  if (page) {
    res.writeHead(200, { 'content-type': page[1] }).end(page[0]);
    return;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const response = await handle(new Request(url, { method: req.method, headers: req.headers, body: hasBody ? req : undefined, duplex: 'half' }), db);
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
});

server.listen(Number(process.env.PORT ?? 3000), () => console.log(`whyline on :${server.address().port}`));
