import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('./whyline.js', import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in server that records every event it receives and every one it answered with success.
// `mode(n, event, req)` decides how to answer request n: 'ok' | 'hold' (never answer) | an HTTP status | { delay: ms }.
async function stub() {
  const s = { received: [], acked: [], mode: () => 'ok', onReceive: () => {} };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const event = JSON.parse(body);
      s.received.push(event.prompt);
      const n = s.received.length;
      s.onReceive(n);
      const act = s.mode(n, event, req);
      const reply = (status) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 300 ? { id: n } : { error: 'nope' }), () => { if (status < 300) s.acked.push(event.prompt); });
      };
      if (act === 'hold') return;
      if (typeof act === 'number') return reply(act);
      if (act?.delay) return void setTimeout(() => reply(201), act.delay);
      reply(201);
    });
  });
  await new Promise((r) => s.server.listen(0, r));
  s.url = `http://localhost:${s.server.address().port}`;
  s.close = () => { s.server.closeAllConnections(); s.server.close(); };
  return s;
}

const servers = [];
const setup = async () => {
  const s = await stub();
  servers.push(s);
  return { s, home: mkdtempSync(join(tmpdir(), 'whyline-queue-')) };
};
after(() => servers.forEach((s) => s.close()));

const hookEvent = (prompt) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/tmp', prompt });
const start = (s, home, prompt, env = {}) => {
  const p = spawn(process.execPath, [CLI, 'hook', 'claude-code'], { env: { ...process.env, WHYLINE_HOME: home, WHYLINE_URL: s.url, WHYLINE_KEY: 'wl_test', ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
  const t0 = Date.now();
  let stderr = '';
  p.stderr.on('data', (d) => (stderr += d));
  p.stdin.end(hookEvent(prompt));
  p.done = new Promise((r) => p.on('close', (code, signal) => r({ code, signal, stderr, ms: Date.now() - t0 })));
  return p;
};
const run = (s, home, prompt, env) => start(s, home, prompt, env).done;
const queued = (n, prefix = 'q') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const line = (prompt) => JSON.stringify({ ts: new Date().toISOString(), agent: 'claude-code', kind: 'prompt', prompt }) + '\n';
const seed = (home, prompts, file = 'queue.jsonl') => writeFileSync(join(home, file), prompts.map(line).join(''));
const leftovers = (home) => readdirSync(home).filter((f) => f.startsWith('queue'));
const count = (list, x) => list.filter((y) => y === x).length;
const inOrder = (list, items) => items.every((x, i) => i === 0 || list.indexOf(items[i - 1]) < list.indexOf(x));
const deadPid = () => new Promise((resolve) => { const p = spawn(process.execPath, ['-e', '']); p.on('close', () => resolve(p.pid)); });

test('normal flush: queued events are sent in order after the new one, and the queue is left empty', async () => {
  const { s, home } = await setup();
  seed(home, queued(5));
  assert.equal((await run(s, home, 'primary')).code, 0);
  assert.deepEqual(s.received, ['primary', ...queued(5)]);
  assert.deepEqual(leftovers(home), []);
});

test('partial flush: a failure keeps the unsent events in order and the next run does not resend delivered ones', async () => {
  const { s, home } = await setup();
  s.mode = (n) => (n <= 3 ? 'ok' : 503); // primary, q0, q1 succeed; q2 fails
  seed(home, queued(5));
  await run(s, home, 'primary');
  assert.deepEqual(s.acked, ['primary', 'q0', 'q1']);
  assert.equal(leftovers(home).length, 1, 'the unsent events must stay on disk');

  s.mode = () => 'ok';
  await run(s, home, 'second');
  assert.deepEqual([...s.acked].sort(), ['primary', 'q0', 'q1', 'q2', 'q3', 'q4', 'second'].sort());
  for (const p of s.acked) assert.equal(count(s.acked, p), 1, `${p} delivered more than once`);
  assert.ok(inOrder(s.acked, queued(5)), 'queued events lost their order');
  assert.deepEqual(leftovers(home), []);
});

test('killed flush: the claimed queue is recovered by the next run, with nothing lost and acknowledged events not repeated', async () => {
  const { s, home } = await setup();
  s.mode = (n) => (n === 4 ? 'hold' : 'ok'); // primary, q0, q1 acknowledged; q2 is in flight when the process dies
  seed(home, queued(5));
  const p = start(s, home, 'primary');
  await new Promise((r) => { s.onReceive = (n) => n === 4 && r(); });
  await wait(150);
  p.kill('SIGKILL'); // what Claude Code does to a hook that overruns its timeout
  await p.done;
  assert.ok(leftovers(home).length > 0, 'the interrupted claim must still be on disk');
  const ackedBeforeKill = [...s.acked];
  assert.deepEqual(ackedBeforeKill, ['primary', 'q0', 'q1']);

  s.mode = () => 'ok';
  await run(s, home, 'after');
  for (const p of ackedBeforeKill) assert.equal(count(s.received, p), 1, `${p} was acknowledged before the kill but sent again`);
  for (const p of ['q2', 'q3', 'q4', 'after']) assert.ok(count(s.received, p) >= 1, `${p} was lost`);
  assert.equal(count(s.received, 'q3'), 1);
  assert.equal(count(s.received, 'q4'), 1);
  assert.ok(inOrder(s.received, queued(5)), 'queued events lost their order');
  assert.deepEqual(leftovers(home), []);
});

test('stale claims are taken over, oldest first: progress marks are honoured and claims from older versions are recovered', async () => {
  const { s, home } = await setup();
  const [pid1, pid2] = [await deadPid(), await deadPid()];
  seed(home, ['L0', 'L1'], `queue.jsonl.${pid1}`); // the name older versions left behind after a kill
  writeFileSync(join(home, `queue.jsonl.claimed.${Date.now() - 1000}.0.${pid2}`), ['C0', 'C1', 'C2'].map(line).join('') + '#\n'); // C0 already sent
  seed(home, ['Q0']);
  await run(s, home, 'primary');
  assert.deepEqual(s.received, ['primary', 'L0', 'L1', 'C1', 'C2', 'Q0']);
  assert.deepEqual(leftovers(home), []);
});

test('a claim held by a live process is left alone, so queued events are not sent out of order', async () => {
  const { s, home } = await setup();
  const claim = join(home, `queue.jsonl.claimed.${Date.now()}.0.${process.pid}`); // this test process is alive and the file is fresh
  writeFileSync(claim, ['C0', 'C1'].map(line).join(''));
  seed(home, ['Q0']);
  await run(s, home, 'primary');
  assert.deepEqual(s.received, ['primary']);
  assert.equal(readFileSync(claim, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.ok(existsSync(join(home, 'queue.jsonl')), 'the live queue must not be claimed while another flush is running');
});

test('concurrent flushes: every queued event is delivered exactly once, in order', async () => {
  const { s, home } = await setup();
  seed(home, queued(40));
  const racers = ['r0', 'r1', 'r2', 'r3', 'r4'];
  await Promise.all(racers.map((r) => run(s, home, r)));
  for (const p of [...queued(40), ...racers]) assert.equal(count(s.received, p), 1, `${p} delivered ${count(s.received, p)} times`);
  assert.ok(inOrder(s.received, queued(40)), 'queued events lost their order');
  assert.deepEqual(leftovers(home), []);
});

test('a slow server cannot hold the hook past its time budget, and the rest is sent on the next run', async () => {
  const { s, home } = await setup();
  s.mode = () => ({ delay: 700 });
  seed(home, queued(30));
  const { code, ms } = await run(s, home, 'primary');
  assert.equal(code, 0);
  assert.ok(ms < 5500, `hook ran ${ms}ms; Claude Code kills hooks at 5000ms`);
  assert.ok(s.acked.length < 31, 'the test needs a backlog that does not fit in one run');
  assert.equal(leftovers(home).length, 1);

  s.mode = () => 'ok';
  await run(s, home, 'next');
  for (const p of [...queued(30), 'primary', 'next']) assert.equal(count(s.acked, p), 1, `${p} delivered ${count(s.acked, p)} times`);
  assert.ok(inOrder(s.acked, queued(30)));
  assert.deepEqual(leftovers(home), []);
});

test('unreadable lines and events the server rejects as invalid are dropped without blocking the rest', async () => {
  const { s, home } = await setup();
  s.mode = (n, e) => (e.prompt === 'q1' ? 400 : 'ok');
  writeFileSync(join(home, 'queue.jsonl'), line('q0') + '{not json\n' + line('q1') + line('q2'));
  await run(s, home, 'primary');
  assert.deepEqual(s.acked, ['primary', 'q0', 'q2']);
  assert.deepEqual(leftovers(home), []);
});

// --- B7: a rejected key must not grow the queue or be retried forever; temporary failures still queue.

// What is still waiting to be sent: claimed files count their "#" progress marks as sent.
const queueLines = (home) => leftovers(home).sort().flatMap((f) => {
  const lines = readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean);
  return lines.filter((l) => l !== '#').slice(lines.filter((l) => l === '#').length).map((l) => JSON.parse(l).prompt);
});
const closedPort = async () => {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
};

for (const status of [401, 403]) {
  test(`${status}: the event is dropped, not queued; events already queued are kept untouched and not retried`, async () => {
    const { s, home } = await setup();
    s.mode = () => status;
    seed(home, queued(3));
    const before = readFileSync(join(home, 'queue.jsonl'), 'utf8');
    for (const p of ['a', 'b', 'c']) {
      const r = await run(s, home, p);
      assert.equal(r.code, 0, 'hooks always exit 0');
      assert.match(r.stderr, new RegExp(`the server rejected the API key \\(HTTP ${status}\\)\\. Run \`whyline login`));
      assert.doesNotMatch(r.stderr, /queued|wl_test/, 'not queued, and the key is never printed');
    }
    assert.deepEqual(s.received, ['a', 'b', 'c'], 'one attempt per event, and the queue is not retried with a rejected key');
    assert.equal(readFileSync(join(home, 'queue.jsonl'), 'utf8'), before);
  });
}

test('network failure, 500 and timeout: the event is queued and retried later', async () => {
  const { s, home } = await setup();
  const port = await closedPort();
  const offline = await run(s, home, 'offline', { WHYLINE_URL: `http://127.0.0.1:${port}` });
  assert.match(offline.stderr, new RegExp(`can't reach 127\\.0\\.0\\.1:${port}: ECONNREFUSED \\(queued, will retry\\)`));
  s.mode = () => 500;
  await run(s, home, 'server-error');
  s.mode = () => 'hold';
  const slow = await run(s, home, 'timeout');
  assert.ok(slow.ms < 5000, `hook ran ${slow.ms}ms`);
  assert.deepEqual(queueLines(home), ['offline', 'server-error', 'timeout']);

  s.mode = () => 'ok';
  await run(s, home, 'back');
  assert.deepEqual(s.acked, ['back', 'offline', 'server-error', 'timeout']);
  assert.deepEqual(leftovers(home), []);
});

test('recovery after the key is corrected: the outage queue is delivered once, in order; rejected events are not', async () => {
  const { s, home } = await setup();
  s.mode = (n, e, req) => (req.headers.authorization === 'Bearer wl_good' ? 'ok' : 401);
  seed(home, queued(3)); // queued during an earlier outage
  await run(s, home, 'with-bad-key', { WHYLINE_KEY: 'wl_bad' });
  assert.deepEqual(queueLines(home), queued(3));
  await run(s, home, 'with-good-key', { WHYLINE_KEY: 'wl_good' });
  assert.deepEqual(s.acked, ['with-good-key', ...queued(3)]);
  assert.equal(count(s.received, 'with-bad-key'), 1);
  assert.deepEqual(leftovers(home), []);
});

test('mixed queue: delivered, temporarily failing and key-rejected entries each end up delivered exactly once, in order', async () => {
  const { s, home } = await setup();
  seed(home, queued(5));
  s.mode = (n) => (n <= 2 ? 'ok' : 503); // primary and q0 delivered, q1 fails temporarily
  await run(s, home, 'r1');
  s.mode = (n, e) => (e.prompt === 'q2' ? 401 : 'ok'); // the key is revoked while q2 is sent
  await run(s, home, 'r2');
  assert.deepEqual(queueLines(home), ['q2', 'q3', 'q4'], 'a rejected key stops the flush and keeps the rest');
  s.mode = () => 'ok';
  await run(s, home, 'r3');
  for (const p of [...queued(5), 'r1', 'r2', 'r3']) assert.equal(count(s.acked, p), 1, `${p} delivered ${count(s.acked, p)} times`);
  assert.ok(inOrder(s.acked, queued(5)));
  assert.deepEqual(leftovers(home), []);
});
