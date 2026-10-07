import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
delete process.env.WHYLINE_TRUST_PROXY;
const { server } = await import('./index.js');
const { PAGE_BYTES } = await import('../lib/handle.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const port = server.address().port;
const base = `http://localhost:${port}`;
after(() => { server.closeAllConnections(); server.close(); });

const signup = (xff) => fetch(`${base}/api/workspaces`, { method: 'POST', headers: xff ? { 'x-forwarded-for': xff } : {}, body: JSON.stringify({ name: 'w' }) });
// Every workspace this file needs, made up front from distinct trusted addresses so the per-address limit doesn't interfere.
process.env.WHYLINE_TRUST_PROXY = '1';
const keys = await Promise.all([1, 2, 3].map(async (i) => (await (await signup(`192.0.2.${i}`)).json()).key));
delete process.env.WHYLINE_TRUST_PROXY;
const [key, bigKey] = keys;
const postEvent = (body, k = key) => fetch(`${base}/api/events`, { method: 'POST', headers: { authorization: `Bearer ${k}` }, body });
const statusOf = async (res) => [res.status, (await res.json()).error];

// A raw POST whose body is written in chunks, with no Content-Length (chunked transfer encoding).
const chunked = (mb) => new Promise((resolve) => {
  const chunk = Buffer.alloc(1 << 20, 'a');
  const req = http.request({ port, method: 'POST', path: '/api/events', headers: { authorization: `Bearer ${key}` } }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => resolve([res.statusCode, b]));
  });
  req.on('error', (e) => resolve([0, e.code]));
  let i = 0;
  const write = () => { while (i < mb && req.write(chunk)) i++; if (i < mb) req.once('drain', () => { i++; write(); }); else req.end(); };
  write();
});

// --- P5: request bodies

test('body limit: exactly 1,000,000 characters is accepted, one more is 413; counted in characters, as documented', async () => {
  const event = '{"agent":"a","kind":"k"}';
  assert.equal((await postEvent(event + ' '.repeat(1e6 - event.length))).status, 201);
  assert.deepEqual(await statusOf(await postEvent(event + ' '.repeat(1e6 - event.length + 1))), [413, 'body too large']);
  // 1,000,000 two-byte characters (2 MB of UTF-8) are still within the limit.
  const wide = '{"agent":"a","kind":"k","x":"' + 'é'.repeat(1e6 - 31) + '"}';
  assert.equal(wide.length, 1e6);
  assert.equal((await postEvent(wide)).status, 201);
});

test('normal event, malformed JSON and a missing body', async () => {
  assert.equal((await postEvent('{"agent":"claude-code","kind":"prompt","prompt":"hi"}')).status, 201);
  assert.deepEqual(await statusOf(await postEvent('{"agent":')), [400, 'invalid JSON']);
  assert.deepEqual(await statusOf(await postEvent(undefined)), [400, 'invalid JSON']);
  assert.deepEqual(await statusOf(await postEvent('')), [400, 'invalid JSON']);
});

test('an oversized chunked body (no Content-Length) gets 413 without being buffered', async () => {
  const [status, body] = await chunked(20);
  assert.equal(status, 413, body);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404, 'still serving');
});

test('concurrent oversized uploads get 413 each and memory stays bounded', async () => {
  const before = process.memoryUsage().rss;
  const results = await Promise.all(Array.from({ length: 8 }, () => chunked(30))); // 240 MB in total
  assert.deepEqual(results.map(([s]) => s), Array(8).fill(413));
  const grew = (process.memoryUsage().rss - before) / 1e6;
  assert.ok(grew < 120, `memory grew ${grew.toFixed(0)} MB while 240 MB were uploaded`);
  // A declared Content-Length over the cap is refused before reading anything.
  const res = await fetch(`${base}/api/events`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-length': String(5e6) }, body: 'x'.repeat(5e6) });
  assert.equal(res.status, 413);
});

// --- P6: authentication and headers

test('Bearer authentication: scheme is case-insensitive, malformed headers are 401, and the key never comes back', async () => {
  const get = (authorization) => fetch(`${base}/api/events?limit=1`, { headers: authorization === undefined ? {} : { authorization } });
  for (const ok of [`Bearer ${key}`, `bearer ${key}`, `BEARER  ${key} `]) assert.equal((await get(ok)).status, 200, ok);
  for (const bad of [undefined, '', 'Bearer', 'Bearer ', `Basic ${key}`, `Bearer ${key} extra`, `Bearer ${key}x`, `${key}`, 'Bearer wl_' + 'a'.repeat(5000)]) {
    const res = await get(bad);
    assert.equal(res.status, 401, String(bad).slice(0, 40));
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    const text = await res.text();
    assert.equal(text, '{"error":"invalid API key"}');
  }
});

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const expected = Object.fromEntries(vercel.headers.find((h) => h.source === '/(.*)').headers.map(({ key: k, value }) => [k.toLowerCase(), value]));

test('pages and API responses carry the vercel.json security headers; API responses are never cached; no CORS', async () => {
  assert.deepEqual(Object.keys(expected).sort(), ['content-security-policy', 'referrer-policy', 'x-content-type-options', 'x-frame-options']);
  assert.match(expected['content-security-policy'], /frame-ancestors 'none'/);
  for (const path of ['/', '/app', '/docs/api', '/nope', '/api/events', '/api/nope']) {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${key}`, origin: 'https://evil.example' } });
    for (const [k, v] of Object.entries(expected)) assert.equal(res.headers.get(k), v, `${path}: ${k}`);
    assert.equal(res.headers.get('access-control-allow-origin'), null, `${path}: no CORS`);
    if (path.startsWith('/api')) assert.equal(res.headers.get('cache-control'), 'no-store', path);
  }
  const preflight = await fetch(`${base}/api/events`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('the CSP allows exactly the inline scripts the pages have, and pages load nothing from other origins', () => {
  const csp = expected['content-security-policy'];
  const allowed = new Set([...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]));
  const needed = new Set();
  const pages = [];
  (function walk(dir) {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(new URL(`${f.name}/`, dir)); else if (f.name.endsWith('.html')) pages.push(new URL(f.name, dir));
    }
  })(new URL('../public/', import.meta.url));
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) needed.add(createHash('sha256').update(body).digest('base64'));
    assert.doesNotMatch(html, /\son[a-z]+=["']/i, `${page}: inline event handler (blocked by the CSP)`);
    assert.doesNotMatch(html, /<(script|img|iframe)[^>]+src="https?:|<link(?![^>]*rel="canonical")[^>]+href="https?:/i, `${page}: external resource (blocked by the CSP)`);
    assert.doesNotMatch(html, /javascript:/i, `${page}: javascript: URL`);
  }
  assert.deepEqual([...allowed].sort(), [...needed].sort(), 'update the hashes in vercel.json after changing an inline <script>');
});

// --- P7: signup limit per client address

test('without WHYLINE_TRUST_PROXY, X-Forwarded-For is ignored: spoofing it does not get past the signup limit', async () => {
  let created = 0, limited = 0;
  for (let i = 0; i < 14; i++) {
    const res = await signup(`10.${i}.${i}.${i}, 203.0.113.${i}`); // a different "client" every time
    if (res.status === 201) created++; else if (res.status === 429) limited++;
  }
  assert.ok(created <= 10, `${created} workspaces from one address`);
  assert.ok(limited >= 4);
  assert.equal((await signup()).status, 429, 'no header: the same address, still limited');
});

test('with WHYLINE_TRUST_PROXY=1, the address the proxy appended counts; values the client prepends do not', async (t) => {
  process.env.WHYLINE_TRUST_PROXY = '1';
  t.after(() => delete process.env.WHYLINE_TRUST_PROXY);
  for (let i = 0; i < 10; i++) assert.equal((await signup(`6.6.6.${i}, 198.51.100.7`)).status, 201);
  assert.equal((await signup('7.7.7.7, 198.51.100.7')).status, 429, 'spoofed first value is ignored');
  assert.equal((await signup('198.51.100.8')).status, 201, 'another client is not affected');
  assert.equal((await signup('::ffff:198.51.100.7')).status, 429, 'IPv4-mapped form is the same address');
  // IPv6: one host usually has a whole /64, so the limit applies per /64.
  for (let i = 1; i <= 10; i++) assert.equal((await signup(`2001:db8:1:2::${i.toString(16)}`)).status, 201);
  assert.equal((await signup('2001:db8:1:2:abcd:ef01:2345:6789')).status, 429);
  assert.equal((await signup('2001:db8:1:3::1')).status, 201, 'a different /64');
  // Header missing behind a proxy: falls back to the socket address (localhost, limited by the test above), no crash.
  assert.equal((await signup('')).status, 429);
});

// --- P12: response size

test('a page of large events stays under the Vercel response limit, and paging until empty returns every event once', async () => {
  const files = Array.from({ length: 900 }, (_, i) => `${i}`.padEnd(1000, 'x')); // ~0.9 MB per event
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push((await (await postEvent(JSON.stringify({ agent: 'a', kind: 'commit', files }), bigKey)).json()).id);

  const seen = [];
  for (let before = ''; ;) {
    const res = await fetch(`${base}/api/events?limit=500${before && `&before=${before}`}`, { headers: { authorization: `Bearer ${bigKey}` } });
    const text = await res.text();
    assert.ok(Buffer.byteLength(text) < 4.5e6, `page is ${Buffer.byteLength(text)} bytes`);
    const { events } = JSON.parse(text);
    if (!events.length) break;
    assert.ok(events.length < 10, 'the budget cut the page short');
    seen.push(...events.map((e) => e.id));
    before = events.at(-1).id;
  }
  assert.deepEqual(seen, ids.reverse());
  assert.ok(PAGE_BYTES <= 4e6);
});
