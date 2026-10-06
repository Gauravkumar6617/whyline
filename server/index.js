import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const db = new DatabaseSync(process.env.DB_PATH ?? new URL('./whyline.db', import.meta.url).pathname);
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    author TEXT, session TEXT, prompt TEXT, summary TEXT, files TEXT, commit_sha TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ws ON events(workspace_id, id);
`);

const asset = (file, type) => [readFileSync(new URL(`./public/${file}`, import.meta.url)), type];
const PAGES = {
  '/': asset('index.html', 'text/html; charset=utf-8'),
  '/app': asset('app.html', 'text/html; charset=utf-8'),
  '/style.css': asset('style.css', 'text/css'),
  '/logo.svg': asset('logo.svg', 'image/svg+xml'),
};
const hash = (key) => createHash('sha256').update(key).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Max length per string field; agent + kind required.
const FIELDS = { ts: 40, agent: 100, kind: 50, author: 200, session: 200, prompt: 20000, summary: 5000, commit_sha: 64 };

function cleanEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    const v = body[k] ?? null;
    if (v !== null && (typeof v !== 'string' || v.length > max)) fail(400, `${k} must be a string of at most ${max} chars`);
    out[k] = v;
  }
  if (!out.agent || !out.kind) fail(400, 'agent and kind are required');
  // Client time, so events queued offline keep when they happened.
  if (out.ts !== null) {
    const d = new Date(out.ts);
    if (isNaN(d)) fail(400, 'ts must be an ISO date');
    out.ts = d.toISOString();
  }
  const files = body.files ?? [];
  if (!Array.isArray(files) || files.length > 1000 || files.some((f) => typeof f !== 'string' || f.length > 1000)) {
    fail(400, 'files must be an array of strings');
  }
  out.files = JSON.stringify(files);
  return out;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    if ((size += c.length) > 1e6) fail(413, 'body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { fail(400, 'invalid JSON'); }
}

function auth(req) {
  const key = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const ws = key && db.prepare('SELECT id, name FROM workspaces WHERE key_hash = ?').get(hash(key));
  return ws || fail(401, 'invalid API key');
}

async function route(req, url) {
  const r = `${req.method} ${url.pathname}`;

  // ponytail: open signup, no rate limit; add both before announcing publicly.
  if (r === 'POST /api/workspaces') {
    const { name } = (await readJson(req)) ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) fail(400, 'name required (max 100 chars)');
    const key = 'wl_' + randomBytes(24).toString('base64url');
    const { lastInsertRowid } = db.prepare('INSERT INTO workspaces (name, key_hash) VALUES (?, ?)').run(name.trim(), hash(key));
    return [201, { id: Number(lastInsertRowid), name: name.trim(), key }];
  }

  if (r === 'POST /api/events') {
    const ws = auth(req);
    const e = cleanEvent(await readJson(req));
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO events (workspace_id, ts, agent, kind, author, session, prompt, summary, files, commit_sha)
       VALUES (?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ws.id, e.ts, e.agent, e.kind, e.author, e.session, e.prompt, e.summary, e.files, e.commit_sha);
    return [201, { id: Number(lastInsertRowid) }];
  }

  // Newest first. `since` = last event id the caller has seen.
  // ponytail: no pagination past 500, add a `before` cursor when a workspace outgrows it.
  if (r === 'GET /api/events') {
    const ws = auth(req);
    const since = Math.max(0, parseInt(url.searchParams.get('since')) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit')) || 100));
    const events = db.prepare(
      `SELECT id, ts, agent, kind, author, session, prompt, summary, files, commit_sha
       FROM events WHERE workspace_id = ? AND id > ? ORDER BY id DESC LIMIT ?`,
    ).all(ws.id, since, limit).map((e) => ({ ...e, files: JSON.parse(e.files) }));
    return [200, { workspace: ws.name, events }];
  }

  fail(404, 'not found');
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const page = req.method === 'GET' && PAGES[url.pathname];
  if (page) {
    res.writeHead(200, { 'content-type': page[1] }).end(page[0]);
    return;
  }
  let status, body;
  try {
    [status, body] = await route(req, url);
  } catch (err) {
    status = err.status ?? 500;
    body = { error: err.status ? err.message : 'internal error' };
    if (!err.status) console.error(err);
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});

server.listen(Number(process.env.PORT ?? 3000), () => console.log(`whyline on :${server.address().port}`));
