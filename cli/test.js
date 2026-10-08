import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PORT = '0';
process.env.DB_PATH ??= ":memory:";
const { server } = await import('../server/index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const url = `http://localhost:${server.address().port}`;
after(() => server.close());

const CLI = new URL('./whyline.js', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'whyline-'));
const run = (args, env, input = '') => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, WHYLINE_HOME: home, ...env } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
  p.stdin.end(input);
});

test('claude hook sends events, queues while offline, flushes when back', async () => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{"name":"t"}' })).json();
  const up = { WHYLINE_URL: url, WHYLINE_KEY: ws.key };
  const down = { WHYLINE_URL: 'http://127.0.0.1:9', WHYLINE_KEY: ws.key };
  const edit = (f) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/repo', tool_name: 'Edit', tool_input: { file_path: `/repo/${f}` } });

  // Prompt hook output goes into Claude's context, so stdout must stay empty.
  const r = await run(['hook', 'claude-code'], up, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }));
  assert.deepEqual([r.code, r.out], [0, '']);

  assert.equal((await run(['hook', 'claude-code'], down, edit('a.ts'))).code, 0);
  assert.ok(existsSync(join(home, 'queue.jsonl')));

  await run(['hook', 'claude-code'], up, edit('b.ts'));
  assert.equal(readFileSync(join(home, 'queue.jsonl'), { flag: 'a+' }).length, 0);

  const { out } = await run(['events'], up);
  assert.deepEqual(out.trim().split('\n').map((l) => l.split('\t').slice(2, 4).concat(l.split('\t')[5])), [
    ['claude-code', 'prompt', 'hi'],
    ['claude-code', 'edit', 'Edit b.ts'],
    ['claude-code', 'edit', 'Edit a.ts'],
  ]);
});

test('git hook detects agent from commit trailer', async () => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{"name":"g"}' })).json();
  const repo = mkdtempSync(join(tmpdir(), 'whyline-repo-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=dev@x.io', '-c', 'user.name=dev', ...a], { cwd: repo });
  g('init', '-q');
  g('commit', '-q', '--allow-empty', '-m', 'add orders\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>');

  const p = spawn(process.execPath, [CLI, 'hook', 'git'], { cwd: repo, env: { ...process.env, WHYLINE_HOME: home, WHYLINE_URL: url, WHYLINE_KEY: ws.key } });
  await new Promise((r) => p.on('close', r));

  const { events } = await (await fetch(`${url}/api/events`, { headers: { authorization: `Bearer ${ws.key}` } })).json();
  assert.deepEqual(events.map((e) => [e.agent, e.kind, e.author]), [['claude-code', 'commit', 'dev@x.io']]); // the same agent name the Claude Code plugin uses
});

test('blame: line -> commit -> the Claude prompt that edited it', async () => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{"name":"b"}' })).json();
  const env = { WHYLINE_URL: url, WHYLINE_KEY: ws.key };
  const repo = mkdtempSync(join(tmpdir(), 'whyline-blame-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.email=dev@x.io', '-c', 'user.name=dev', ...a], { cwd: repo, encoding: 'utf8' });
  const inRepo = (args, input = '') => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, WHYLINE_HOME: home, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
    p.stdin.end(input);
  });
  g('init', '-q');

  const hookIn = (h) => JSON.stringify({ session_id: 'sess-9', cwd: repo, ...h });
  await inRepo(['hook', 'claude-code'], hookIn({ hook_event_name: 'UserPromptSubmit', prompt: 'store money as integer cents' }));
  writeFileSync(join(repo, 'orders.js'), 'const amount_cents = 1;\n');
  await inRepo(['hook', 'claude-code'], hookIn({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(repo, 'orders.js') } }));
  g('add', '.');
  g('commit', '-q', '-m', 'add orders'); // no trailer: agent comes from the linked Claude edit
  await inRepo(['hook', 'git']);

  const out = await inRepo(['blame', 'orders.js:1']);
  assert.match(out, /orders\.js:1 {2}const amount_cents = 1;/);
  assert.match(out, /claude-code · dev@x\.io/);
  assert.match(out, /store money as integer cents/);

  // An amend keeps the agent and prompt; the next ordinary commit does not inherit them.
  g('commit', '-q', '--amend', '-m', 'add orders, reworded');
  await inRepo(['hook', 'git']);
  assert.match(await inRepo(['blame', 'orders.js:1']), /claude-code · dev@x\.io[^]*reworded[^]*store money as integer cents/);
  // A day later the local record is gone: an amend then gets the agent and prompt from the server.
  rmSync(join(home, 'edits.jsonl'));
  g('commit', '-q', '--amend', '-m', 'add orders, reworded again');
  await inRepo(['hook', 'git']);
  assert.match(await inRepo(['blame', 'orders.js:1']), /claude-code · dev@x\.io[^]*again[^]*store money as integer cents/);
  writeFileSync(join(repo, 'orders.js'), 'const amount_cents = 2;\n');
  g('commit', '-q', '-am', 'by hand');
  await inRepo(['hook', 'git']);
  assert.match(await inRepo(['blame', 'orders.js:1']), / · none · /);

  // Opt-out: prompt event recorded, text not sent.
  await run(['hook', 'claude-code'], { ...env, WHYLINE_NO_PROMPTS: '1' }, hookIn({ hook_event_name: 'UserPromptSubmit', prompt: 'secret' }));
  const { events } = await (await fetch(`${url}/api/events?limit=1`, { headers: { authorization: `Bearer ${ws.key}` } })).json();
  assert.deepEqual([events[0].kind, events[0].prompt], ['prompt', null]);
});

test('rotate-key saves the new key and the old one stops working; delete-workspace needs --yes, then logs out', async () => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{"name":"keys"}' })).json();
  const env = { WHYLINE_HOME: mkdtempSync(join(tmpdir(), 'whyline-keys-')), WHYLINE_URL: '', WHYLINE_KEY: '' };
  delete env.WHYLINE_URL; delete env.WHYLINE_KEY;
  const status = async (key) => (await fetch(`${url}/api/events`, { headers: { authorization: `Bearer ${key}` } })).status;
  await run(['login', '--url', url, '--key', ws.key], env);

  const rotated = await run(['rotate-key'], env);
  const key = rotated.out.match(/wl_\S+/)[0];
  assert.equal(rotated.code, 0);
  assert.deepEqual([await status(ws.key), await status(key)], [401, 200]);
  assert.equal(JSON.parse(readFileSync(join(env.WHYLINE_HOME, 'config.json'), 'utf8')).key, key);

  assert.equal((await run(['delete-workspace'], env)).code, 1);
  assert.equal(await status(key), 200, 'nothing deleted without --yes');
  const deleted = await run(['delete-workspace', '--yes'], env);
  assert.match(deleted.out, /deleted workspace "keys"/);
  assert.equal(await status(key), 401);
  assert.equal(JSON.parse(readFileSync(join(env.WHYLINE_HOME, 'config.json'), 'utf8')).key, undefined);
});
