import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
const { server } = await import('./index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const port = server.address().port;
const base = `http://localhost:${port}`;

// Sends a raw request line so the target reaches the server exactly as written (fetch would normalise it).
const raw = (requestLine, { host = 'localhost', body = '' } = {}) => new Promise((resolve, reject) => {
  const s = net.connect(port, 'localhost', () => s.write(
    `${requestLine}\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  let data = '';
  s.on('data', (d) => (data += d));
  s.on('close', () => resolve(data));
  s.on('error', reject);
  setTimeout(() => { s.destroy(); resolve(data); }, 2000);
});
const statusOf = (response) => Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
const stillServing = async (label) => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404, `${label}: server stopped answering`);
  assert.equal((await fetch(`${base}/`)).status, 200, `${label}: pages stopped being served`);
};

// Each of these used to end the process with an uncaught `TypeError: Invalid URL`.
for (const [label, line, opts] of [
  ['GET //', 'GET // HTTP/1.1'],
  ['GET /\\', 'GET /\\ HTTP/1.1'],
  ['POST //', 'POST // HTTP/1.1', { body: '{}' }],
  ['absolute-form with a broken host', 'GET http://[::1 HTTP/1.1'],
  ['GET //?x=1', 'GET //?x=1 HTTP/1.1'],
  ['POST /\\ with a body', 'POST /\\ HTTP/1.1', { body: '{"name":"x"}' }],
  ['a malformed Host header', 'GET /docs HTTP/1.1', { host: '[' }],
]) {
  test(`malformed request target does not crash the server: ${label}`, async () => {
    const response = await raw(line, opts);
    assert.equal(statusOf(response), 400, `expected a 400, got: ${response.split('\r\n')[0] || '(no response)'}`);
    assert.match(response, /\{"error":"bad request"\}/);
    await stillServing(label);
  });
}

test('weird but parseable targets get ordinary answers and the server keeps running', async () => {
  for (const [line, expected] of [
    ['GET /%zz HTTP/1.1', 404], ['GET /docs?a=%zz HTTP/1.1', 200], ['GET * HTTP/1.1', 404], ['GET //evil.example/x HTTP/1.1', 404],
    ['GET /a//b HTTP/1.1', 404], ['GET /api/events?x=%zz HTTP/1.1', 401], ['GET /%00 HTTP/1.1', 404],
  ]) assert.equal(statusOf(await raw(line)), expected, line);
  await stillServing('weird targets');
});

test('valid routes still behave exactly as before', async () => {
  assert.equal((await fetch(`${base}/docs/api`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const api = await fetch(`${base}/api/nope`);
  assert.deepEqual([api.status, await api.json()], [404, { error: 'not found' }]);
  const ws = await fetch(`${base}/api/workspaces`, { method: 'POST', body: '{"name":"hostile-test"}' });
  assert.equal(ws.status, 201);
  server.close();
});
