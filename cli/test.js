import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PORT = '0';
process.env.DB_PATH = ':memory:';
const { server } = await import('../server/index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const url = `http://localhost:${server.address().port}`;

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
  assert.deepEqual(events.map((e) => [e.agent, e.kind, e.author]), [['claude', 'commit', 'dev@x.io']]);
  server.close();
});
