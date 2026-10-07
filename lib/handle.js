import { createHash, randomBytes } from 'node:crypto';

// API logic as a web-standard Request -> Response handler, shared by Vercel (api/) and the self-hosted server.
// `db` is lib/db-supabase.js in the cloud, lib/db-sqlite.js self-hosted.

const hash = (key) => createHash('sha256').update(key).digest('hex');
const SIGNUPS_PER_HOUR = 10;
const MAX_BODY = 1e6; // characters, as documented
// A JSON response over ~4.5 MB fails on Vercel, so a page of events stops before this many bytes (always at least one).
export const PAGE_BYTES = 4e6;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Max length per string field; agent + kind required. event_id is the client's idempotency key (see insertEvent).
const FIELDS = { ts: 40, agent: 100, kind: 50, author: 200, session: 200, prompt: 20000, summary: 5000, commit_sha: 64, event_id: 100 };

function cleanEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    const v = body[k] ?? null;
    if (v !== null && (typeof v !== 'string' || v.length > max)) fail(400, `${k} must be a string of at most ${max} chars`);
    out[k] = v;
  }
  if (!out.agent || !out.kind) fail(400, 'agent and kind are required');
  // Letters, digits, - and _ only (a UUID fits), so it is safe in a Supabase query string.
  if (out.event_id !== null && !/^[\w-]+$/.test(out.event_id)) fail(400, 'event_id may only contain letters, digits, - and _');
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
  out.files = files;
  return out;
}

// The limit is checked while reading, so an oversized (or chunked, length-less) upload is cut off instead of buffered.
// Up to 3 UTF-8 bytes make one character, so reading stops at 3x the limit and the exact limit is checked on the text.
async function readJson(request) {
  const maxBytes = MAX_BODY * 3;
  if (Number(request.headers.get('content-length')) > maxBytes) fail(413, 'body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) fail(413, 'body too large'); // leaving the loop cancels the rest of the stream
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length > MAX_BODY) fail(413, 'body too large');
  try { return JSON.parse(text); } catch { fail(400, 'invalid JSON'); }
}

// Keys are looked up by their SHA-256, never compared as strings, so lookup time says nothing about a key's characters.
async function auth(request, db) {
  const key = request.headers.get('authorization')?.match(/^Bearer +(\S+) *$/i)?.[1];
  const ws = key && (await db.workspaceByHash(hash(key)));
  return ws || fail(401, 'invalid API key');
}

// One signup bucket per IPv4 address or IPv6 /64: a single host usually controls a whole /64.
function addressBucket(ip) {
  ip = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '').replace(/%.*$/, '');
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => parseInt(x, 16) || 0).join(':') + '::/64';
}

async function route(request, url, db) {
  const r = `${request.method} ${url.pathname}`;

  // Signup is open; capped per IP. ponytail: IP limit only, add captcha/email verification if abused.
  if (r === 'POST /api/workspaces') {
    const { name } = (await readJson(request)) ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) fail(400, 'name required (max 100 chars)');
    // On Vercel, X-Forwarded-For is set by the platform; the self-hosted server overwrites it (server/index.js).
    const ipHash = hash(addressBucket(request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown'));
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    if ((await db.countWorkspacesSince(ipHash, hourAgo)) >= SIGNUPS_PER_HOUR) fail(429, 'too many workspaces created, try again later');
    const key = 'wl_' + randomBytes(24).toString('base64url');
    const id = await db.createWorkspace(name.trim(), hash(key), ipHash);
    return [201, { id, name: name.trim(), key }];
  }

  if (r === 'POST /api/events') {
    const ws = await auth(request, db);
    // A repeat of an event_id already stored in this workspace is a retry: answer with the stored id, store nothing.
    const { id, duplicate } = await db.insertEvent({ workspace_id: ws.id, ...cleanEvent(await readJson(request)) });
    return [duplicate ? 200 : 201, { id }];
  }

  // Newest first. `since` = last id the caller has seen; `before` pages backwards; `commit` = full sha.
  if (r === 'GET /api/events') {
    const ws = await auth(request, db);
    const q = url.searchParams;
    const commit = q.get('commit');
    if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) fail(400, 'commit must be a full 40-char sha');
    const filter = {
      since: Math.max(0, parseInt(q.get('since')) || 0),
      before: Math.max(0, parseInt(q.get('before')) || 0) || null,
      commit,
      limit: Math.min(500, Math.max(1, parseInt(q.get('limit')) || 100)),
    };
    const events = [];
    let bytes = 0;
    for (const e of await db.listEvents(ws.id, filter)) {
      bytes += Buffer.byteLength(JSON.stringify(e));
      if (events.length && bytes > PAGE_BYTES) break; // fewer than `limit`: callers page with `before` until a page is empty
      events.push(e);
    }
    return [200, { workspace: ws.name, events }];
  }

  fail(404, 'not found');
}

// Responses carry workspace data and keys: never cached by browsers or proxies.
const NO_STORE = { 'cache-control': 'no-store' };

export async function handle(request, db) {
  try {
    const [status, body] = await route(request, new URL(request.url), db);
    return Response.json(body, { status, headers: NO_STORE });
  } catch (err) {
    if (!err.status) console.error(err);
    const headers = err.status === 401 ? { ...NO_STORE, 'www-authenticate': 'Bearer' } : NO_STORE;
    return Response.json({ error: err.status ? err.message : 'internal error' }, { status: err.status ?? 500, headers });
  }
}
