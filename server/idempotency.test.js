import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
const { server } = await import('./index.js');
const { sqliteDb } = await import('../lib/db-sqlite.js');
const { supabaseDb } = await import('../lib/db-supabase.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const base = `http://localhost:${server.address().port}`;
const closers = [() => server.close()];
after(() => closers.forEach((c) => c()));

const workspace = async (name) => (await (await fetch(`${base}/api/workspaces`, { method: 'POST', body: JSON.stringify({ name }) })).json()).key;
const post = async (key, event) => {
  const res = await fetch(`${base}/api/events`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(event) });
  return [res.status, await res.json()];
};
const list = async (key) => (await (await fetch(`${base}/api/events?limit=500`, { headers: { authorization: `Bearer ${key}` } })).json()).events;

test('the same event sent twice is stored once; the retry gets the stored id back', async () => {
  const key = await workspace('idem');
  const event = { event_id: randomUUID(), agent: 'claude-code', kind: 'prompt', prompt: 'p' };
  const [s1, first] = await post(key, event);
  const [s2, again] = await post(key, event);
  assert.deepEqual([s1, s2], [201, 200]);
  assert.equal(again.id, first.id);
  assert.equal((await list(key)).length, 1);
});

test('the same event sent concurrently is stored once', async () => {
  const key = await workspace('idem-concurrent');
  const event = { event_id: randomUUID(), agent: 'claude-code', kind: 'edit', summary: 'Edit a.ts' };
  const results = await Promise.all(Array.from({ length: 25 }, () => post(key, event)));
  assert.equal(results.filter(([s]) => s === 201).length, 1);
  assert.equal(new Set(results.map(([, b]) => b.id)).size, 1);
  assert.equal((await list(key)).length, 1);
});

test('different events stay separate, even with identical content; events without event_id work as before', async () => {
  const key = await workspace('idem-distinct');
  const same = { agent: 'claude-code', kind: 'prompt', prompt: 'run the tests' };
  await post(key, { ...same, event_id: randomUUID() });
  await post(key, { ...same, event_id: randomUUID() });
  await post(key, same); // an older CLI
  await post(key, same);
  assert.equal((await list(key)).length, 4);

  // An id is only unique within its workspace.
  const other = await workspace('idem-other');
  const shared = randomUUID();
  assert.equal((await post(key, { ...same, event_id: shared }))[0], 201);
  assert.equal((await post(other, { ...same, event_id: shared }))[0], 201);

  assert.equal((await post(key, { ...same, event_id: 'a b' }))[0], 400);
  assert.equal((await post(key, { ...same, event_id: 'x'.repeat(101) }))[0], 400);
});

test('protection survives a restart, and an existing database is migrated without losing rows', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'whyline-db-')), 'old.db');
  // A database created by the previous version: no event_id column.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, creator_ip_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE events (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), agent TEXT NOT NULL, kind TEXT NOT NULL,
    author TEXT, session TEXT, prompt TEXT, summary TEXT, files TEXT, commit_sha TEXT);
    INSERT INTO workspaces (name, key_hash) VALUES ('w', 'h');
    INSERT INTO events (workspace_id, agent, kind, files) VALUES (1, 'claude', 'prompt', '[]');`);
  old.close();

  const event = { workspace_id: 1, ts: null, agent: 'claude-code', kind: 'prompt', author: null, session: null, prompt: 'x', summary: null, commit_sha: null, files: [], event_id: randomUUID() };
  const first = sqliteDb(file).insertEvent(event);
  return first.then(async ({ id }) => {
    const restarted = sqliteDb(file); // a new process opening the same file
    assert.deepEqual(await restarted.insertEvent(event), { id, duplicate: true });
    const rows = await restarted.listEvents(1, { since: 0, before: null, commit: null, limit: 10 });
    assert.deepEqual(rows.map((r) => r.agent), ['claude-code', 'claude'], 'the old row is still there');
  });
});

// A proxy that passes a request to the server, lets the server store it, then drops the connection instead of answering:
// the client sees a network error although the event was accepted.
const lossyProxy = async () => {
  const p = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      await fetch(base + req.url, { method: req.method, headers: { authorization: req.headers.authorization }, body: body || undefined });
      res.socket.destroy();
    });
  });
  await new Promise((r) => p.listen(0, r));
  closers.push(() => { p.closeAllConnections(); p.close(); });
  return `http://localhost:${p.address().port}`;
};
const CLI = new URL('../cli/whyline.js', import.meta.url).pathname;
const hook = (home, env, prompt) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'hook', 'claude-code'], { env: { ...process.env, WHYLINE_HOME: home, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
  p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/tmp', prompt }));
  p.on('close', resolve);
});

test('server accepts an event but the answer is lost: the queued retry does not duplicate it', async () => {
  const key = await workspace('idem-lost-ack');
  const home = mkdtempSync(join(tmpdir(), 'whyline-idem-'));
  await hook(home, { WHYLINE_URL: await lossyProxy(), WHYLINE_KEY: key }, 'accepted, answer lost');
  assert.equal((await list(key)).length, 1, 'the server stored it');
  await hook(home, { WHYLINE_URL: base, WHYLINE_KEY: key }, 'next prompt'); // flushes the queue, which still has the first event
  assert.deepEqual((await list(key)).map((e) => e.prompt).sort(), ['accepted, answer lost', 'next prompt']);
});

test('a queued event retried after a kill (sent, but not marked as sent) is stored once', async () => {
  const key = await workspace('idem-queue');
  const home = mkdtempSync(join(tmpdir(), 'whyline-idem-'));
  const queued = { event_id: randomUUID(), ts: new Date().toISOString(), agent: 'claude-code', kind: 'prompt', prompt: 'queued' };
  await post(key, queued); // delivered by a run that was killed before writing its "#" mark
  writeFileSync(join(home, `queue.jsonl.claimed.1.0.999999999`), JSON.stringify(queued) + '\n');
  await hook(home, { WHYLINE_URL: base, WHYLINE_KEY: key }, 'new');
  assert.deepEqual((await list(key)).map((e) => e.prompt).sort(), ['new', 'queued']);
});

test('Supabase: inserts use ON CONFLICT DO NOTHING on (workspace_id, event_id) and return the stored id for a repeat', async () => {
  const seen = [];
  const rows = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, prefer: req.headers.prefer });
      const u = new URL(req.url, 'http://x');
      let out;
      if (req.method === 'POST') {
        const row = JSON.parse(body);
        const dup = row.event_id && rows.find((r) => r.workspace_id === row.workspace_id && r.event_id === row.event_id);
        if (!dup) rows.push({ ...row, id: rows.length + 1 });
        out = dup ? [] : [{ id: rows.length }]; // what PostgREST returns with resolution=ignore-duplicates
      } else {
        out = rows.filter((r) => `eq.${r.event_id}` === u.searchParams.get('event_id')).map((r) => ({ id: r.id }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  closers.push(() => stub.close());
  Object.assign(process.env, { SUPABASE_URL: `http://localhost:${stub.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'test-only' });

  const event = { workspace_id: 7, ts: null, agent: 'a', kind: 'k', files: [], event_id: randomUUID() };
  assert.deepEqual(await supabaseDb.insertEvent(event), { id: 1, duplicate: false });
  assert.deepEqual(await supabaseDb.insertEvent(event), { id: 1, duplicate: true });
  assert.match(seen[0].url, /^\/rest\/v1\/whyline_events\?select=id&on_conflict=workspace_id,event_id$/);
  assert.equal(seen[0].prefer, 'return=representation,resolution=ignore-duplicates');
  assert.match(seen[2].url, new RegExp(`workspace_id=eq\\.7&event_id=eq\\.${event.event_id}$`));
  assert.equal(rows.length, 1);
});
