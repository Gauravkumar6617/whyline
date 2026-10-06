import { createHash, randomBytes } from 'node:crypto';

// API logic as a web-standard Request -> Response handler, shared by Vercel (api/) and the self-hosted server.
// `db` is lib/db-supabase.js in the cloud, lib/db-sqlite.js self-hosted.

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
  out.files = files;
  return out;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 1e6) fail(413, 'body too large');
  try { return JSON.parse(text); } catch { fail(400, 'invalid JSON'); }
}

async function auth(request, db) {
  const key = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  const ws = key && (await db.workspaceByHash(hash(key)));
  return ws || fail(401, 'invalid API key');
}

async function route(request, url, db) {
  const r = `${request.method} ${url.pathname}`;

  // ponytail: open signup, no rate limit; add both before announcing publicly.
  if (r === 'POST /api/workspaces') {
    const { name } = (await readJson(request)) ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) fail(400, 'name required (max 100 chars)');
    const key = 'wl_' + randomBytes(24).toString('base64url');
    const id = await db.createWorkspace(name.trim(), hash(key));
    return [201, { id, name: name.trim(), key }];
  }

  if (r === 'POST /api/events') {
    const ws = await auth(request, db);
    const id = await db.insertEvent({ workspace_id: ws.id, ...cleanEvent(await readJson(request)) });
    return [201, { id }];
  }

  // Newest first. `since` = last event id the caller has seen.
  // ponytail: no pagination past 500, add a `before` cursor when a workspace outgrows it.
  if (r === 'GET /api/events') {
    const ws = await auth(request, db);
    const since = Math.max(0, parseInt(url.searchParams.get('since')) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit')) || 100));
    return [200, { workspace: ws.name, events: await db.listEvents(ws.id, since, limit) }];
  }

  fail(404, 'not found');
}

export async function handle(request, db) {
  try {
    const [status, body] = await route(request, new URL(request.url), db);
    return Response.json(body, { status });
  } catch (err) {
    if (!err.status) console.error(err);
    return Response.json({ error: err.status ? err.message : 'internal error' }, { status: err.status ?? 500 });
  }
}
