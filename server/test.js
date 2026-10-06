import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '0';
process.env.DB_PATH ??= ":memory:";
const { server } = await import('./index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const base = `http://localhost:${server.address().port}`;

const call = async (method, path, body, key) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) },
    body: body && JSON.stringify(body),
  });
  return [res.status, await res.json()];
};

test('workspace -> event -> timeline, with auth and validation', async () => {
  const [s1, ws] = await call('POST', '/api/workspaces', { name: 'acme' });
  assert.equal(s1, 201);
  assert.match(ws.key, /^wl_/);

  assert.equal((await call('POST', '/api/events', { agent: 'x', kind: 'y' }, 'wl_wrong'))[0], 401);
  assert.equal((await call('POST', '/api/events', { kind: 'edit' }, ws.key))[0], 400);
  assert.equal((await call('POST', '/api/events', { agent: 'a', kind: 'b', files: 'nope' }, ws.key))[0], 400);

  const [s2, ev] = await call('POST', '/api/events',
    { agent: 'claude-code', kind: 'edit', prompt: 'rename total', files: ['api/orders.ts'] }, ws.key);
  assert.equal(s2, 201);

  // Other workspaces can't see it.
  const [, other] = await call('POST', '/api/workspaces', { name: 'other' });
  assert.equal((await call('GET', '/api/events', null, other.key))[1].events.length, 0);

  const [s3, list] = await call('GET', '/api/events', null, ws.key);
  assert.equal(s3, 200);
  assert.deepEqual(list.events.map((e) => [e.id, e.agent, e.files]), [[ev.id, 'claude-code', ['api/orders.ts']]]);
  assert.equal((await call('GET', `/api/events?since=${ev.id}`, null, ws.key))[1].events.length, 0);

  // Paging backwards and lookup by commit.
  const sha = 'a'.repeat(40);
  const [, ev2] = await call('POST', '/api/events', { agent: 'none', kind: 'commit', commit_sha: sha }, ws.key);
  assert.deepEqual((await call('GET', `/api/events?before=${ev2.id}`, null, ws.key))[1].events.map((e) => e.id), [ev.id]);
  assert.deepEqual((await call('GET', `/api/events?commit=${sha}`, null, ws.key))[1].events.map((e) => e.id), [ev2.id]);
  assert.equal((await call('GET', '/api/events?commit=nothex', null, ws.key))[0], 400);

  // Signup cap: 10 per IP per hour (2 created above).
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/workspaces', { name: `w${i}` }))[0], 201);
  assert.equal((await call('POST', '/api/workspaces', { name: 'one-too-many' }))[0], 429);

  server.close();
});
