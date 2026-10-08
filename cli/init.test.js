import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
const { server } = await import('../server/index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const url = `http://localhost:${server.address().port}`;
after(() => server.close());

const CLI = new URL('./whyline.js', import.meta.url).pathname;
const LINE = '(whyline hook git >/dev/null 2>&1 &)';
const posix = process.platform !== 'win32';

// A `whyline` on PATH that runs this checkout, the way a global install would.
const bin = mkdtempSync(join(tmpdir(), 'whyline-bin-'));
writeFileSync(join(bin, 'whyline'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
const PATH = `${bin}:${process.env.PATH}`;

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'whyline-init-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const git = (dir, ...a) => execFileSync('git', ['-c', 'user.email=dev@x.io', '-c', 'user.name=dev', ...a], { cwd: dir, encoding: 'utf8' });
const init = (cwd, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'init'], { cwd, env: { ...process.env, PATH, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, out, err }));
});
const hookOf = (dir) => join(dir, '.git', 'hooks', 'post-commit');
const mode = (file) => statSync(file).mode & 0o777;
const occurrences = (text) => text.split('whyline hook git').length - 1;
const noStack = (r) => assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');

test('clean repository: a new executable sh hook that calls whyline', async () => {
  const dir = repo();
  const r = await init(dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^installed: .*post-commit$/m);
  assert.equal(readFileSync(hookOf(dir), 'utf8'), `#!/bin/sh\n${LINE}\n`);
  if (posix) assert.equal(mode(hookOf(dir)) & 0o111, 0o111);
  assert.equal(r.err, '', 'whyline is on PATH, so no warning');
});

test('running init twice is idempotent: one whyline line, file untouched', async () => {
  const dir = repo();
  await init(dir);
  const before = readFileSync(hookOf(dir), 'utf8');
  const r = await init(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /^already installed: /m);
  assert.equal(readFileSync(hookOf(dir), 'utf8'), before);
  assert.equal(occurrences(before), 1);
});

test('existing shell hook: kept as it was, whyline added after the #! line, mode unchanged', async () => {
  const dir = repo();
  const original = '#!/usr/bin/env bash\nset -e\necho "$PWD" > /dev/null\nexit 0\n';
  writeFileSync(hookOf(dir), original, { mode: 0o700 });
  const r = await init(dir);
  assert.equal(r.code, 0, r.err);
  const now = readFileSync(hookOf(dir), 'utf8');
  assert.equal(now, `#!/usr/bin/env bash\n${LINE}\nset -e\necho "$PWD" > /dev/null\nexit 0\n`, 'runs before any exit in the hook');
  if (posix) assert.equal(mode(hookOf(dir)), 0o700);
  assert.equal(occurrences(now), 1);
});

test('existing hook that already calls whyline (older install or hand-written) is left alone', async () => {
  const dir = repo();
  const original = '#!/bin/sh\nnpm run lint\nwhyline hook git &\n';
  writeFileSync(hookOf(dir), original, { mode: 0o755 });
  const r = await init(dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^already installed: /m);
  assert.equal(readFileSync(hookOf(dir), 'utf8'), original);
});

for (const [label, content] of [
  ['Node hook', '#!/usr/bin/env node\nconsole.log("post-commit");\n'],
  ['Python hook', '#!/usr/bin/python3\nprint("post-commit")\n'],
  ['executable binary hook', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0])],
  ['executable without #! line', 'echo hi\n'],
]) {
  test(`existing ${label}: not edited, init fails and says what to do`, async () => {
    const dir = repo();
    writeFileSync(hookOf(dir), content, { mode: 0o755 });
    const r = await init(dir);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /installed/);
    assert.match(r.err, /not a shell script, so whyline won't edit it\. Make it run `whyline hook git`/);
    noStack(r);
    assert.deepEqual(readFileSync(hookOf(dir)), Buffer.from(content));
    if (posix) assert.equal(mode(hookOf(dir)), 0o755);
  });
}

test('existing shell hook that is not executable (git skips it) is not switched on', { skip: !posix }, async () => {
  const dir = repo();
  writeFileSync(hookOf(dir), '#!/bin/sh\nrm -rf build\n', { mode: 0o644 });
  const r = await init(dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /not executable, so git ignores it/);
  assert.equal(readFileSync(hookOf(dir), 'utf8'), '#!/bin/sh\nrm -rf build\n');
  assert.equal(mode(hookOf(dir)), 0o644);
});

test('a symlinked hook is not followed into the file it points at', { skip: !posix }, async () => {
  const dir = repo();
  writeFileSync(join(dir, 'shared-hook.sh'), '#!/bin/sh\necho shared\n', { mode: 0o755 });
  symlinkSync(join(dir, 'shared-hook.sh'), hookOf(dir));
  const r = await init(dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /is a symlink/);
  assert.equal(readFileSync(join(dir, 'shared-hook.sh'), 'utf8'), '#!/bin/sh\necho shared\n');
});

test('core.hooksPath is respected, also when init runs in a subdirectory', async () => {
  const dir = repo();
  git(dir, 'config', 'core.hooksPath', '.githooks');
  mkdirSync(join(dir, 'src'));
  const r = await init(join(dir, 'src'));
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(dir, '.githooks', 'post-commit'), 'utf8'), `#!/bin/sh\n${LINE}\n`);
  assert.ok(!existsSync(hookOf(dir)), 'nothing written to .git/hooks, which git would not run');
  assert.match(r.out, /\.githooks\/post-commit$/m);
});

test('invalid or unwritable hooks location: init fails clearly and never claims success', { skip: !posix || process.getuid?.() === 0 }, async () => {
  const locked = repo();
  chmodSync(join(locked, '.git', 'hooks'), 0o555);
  const r = await init(locked);
  chmodSync(join(locked, '.git', 'hooks'), 0o755);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /installed/);
  assert.match(r.err, /^whyline: can't write .*post-commit: EACCES$/m);
  noStack(r);

  const misconfigured = repo();
  writeFileSync(join(misconfigured, 'not-a-dir'), '');
  git(misconfigured, 'config', 'core.hooksPath', 'not-a-dir');
  const r2 = await init(misconfigured);
  assert.equal(r2.code, 1);
  assert.doesNotMatch(r2.out, /installed/);
  assert.match(r2.err, /^whyline: can't write /m);

  const notRepo = mkdtempSync(join(tmpdir(), 'whyline-norepo-'));
  const r3 = await init(notRepo, { GIT_CEILING_DIRECTORIES: tmpdir() });
  assert.equal(r3.code, 1);
  assert.match(r3.err, /^whyline: not inside a git repository/m);
});

test('warns when whyline is not on PATH (the hook could not run it), but still installs', async () => {
  const dir = repo();
  const r = await init(dir, { PATH: process.env.PATH.split(':').filter((d) => !existsSync(join(d, 'whyline'))).join(':') });
  assert.equal(r.code, 0);
  assert.match(r.err, /`whyline` is not on your PATH/);
});

test('after install, a commit runs the existing hook and records the commit through whyline', { skip: !posix }, async () => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{"name":"init"}' })).json();
  const dir = repo();
  const mark = join(dir, '.git', 'existing-hook-ran');
  writeFileSync(hookOf(dir), `#!/bin/sh\necho ran > "${mark}"\nexit 0\n`, { mode: 0o755 });
  assert.equal((await init(dir)).code, 0);

  const env = { ...process.env, PATH, WHYLINE_HOME: mkdtempSync(join(tmpdir(), 'whyline-home-')), WHYLINE_URL: url, WHYLINE_KEY: ws.key };
  execFileSync('git', ['-c', 'user.email=dev@x.io', '-c', 'user.name=dev', 'commit', '-q', '--allow-empty', '-m', 'ship it\n\nAI-Agent: cursor'], { cwd: dir, env });
  const sha = git(dir, 'rev-parse', 'HEAD').trim();

  let events = [];
  for (let i = 0; i < 50 && !events.length; i++) { // the hook records in the background
    await new Promise((r) => setTimeout(r, 100));
    ({ events } = await (await fetch(`${url}/api/events?commit=${sha}`, { headers: { authorization: `Bearer ${ws.key}` } })).json());
  }
  assert.deepEqual(events.map((e) => [e.kind, e.agent, e.commit_sha]), [['commit', 'cursor', sha]]);
  assert.equal(readFileSync(mark, 'utf8'), 'ran\n', 'the existing hook still ran');
});

test('after a rebase, each rebased commit is recorded once, with the prompt of the commit it replaces', { skip: !posix }, async () => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: '{"name":"rebase"}' })).json();
  const dir = repo();
  const r = await init(dir);
  assert.match(r.out, /^installed: .*post-rewrite$/m);

  const env = { ...process.env, PATH, WHYLINE_HOME: mkdtempSync(join(tmpdir(), 'whyline-home-')), WHYLINE_URL: url, WHYLINE_KEY: ws.key };
  const g = (...a) => execFileSync('git', ['-c', 'user.email=dev@x.io', '-c', 'user.name=dev', ...a], { cwd: dir, env, encoding: 'utf8' }).trim();
  // Async, so the server running in this process can answer the hook.
  const agent = (h) => new Promise((res) => {
    const p = spawn(process.execPath, [CLI, 'hook', 'claude-code'], { cwd: dir, env });
    p.on('close', res);
    p.stdin.end(JSON.stringify({ session_id: 's', cwd: dir, ...h }));
  });
  const eventsFor = async (sha) => (await (await fetch(`${url}/api/events?commit=${sha}`, { headers: { authorization: `Bearer ${ws.key}` } })).json()).events;
  const recorded = async (sha) => { // hooks record in the background
    for (let i = 0; i < 50; i++) { const events = await eventsFor(sha); if (events.length) return events; await new Promise((res) => setTimeout(res, 100)); }
    return [];
  };

  g('commit', '-q', '--allow-empty', '-m', 'base');
  const base = g('rev-parse', '--abbrev-ref', 'HEAD');
  g('checkout', '-q', '-b', 'feature');
  await agent({ hook_event_name: 'UserPromptSubmit', prompt: 'store money as integer cents' });
  writeFileSync(join(dir, 'orders.js'), 'const amount_cents = 1;\n');
  await agent({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'orders.js') } });
  g('add', '.');
  g('commit', '-q', '-m', 'add orders');
  const old = g('rev-parse', 'HEAD');
  assert.equal((await recorded(old))[0]?.agent, 'claude-code');

  g('checkout', '-q', base);
  g('commit', '-q', '--allow-empty', '-m', 'meanwhile on the base branch');
  g('checkout', '-q', 'feature');
  g('rebase', '-q', base);
  const sha = g('rev-parse', 'HEAD');
  assert.notEqual(sha, old);

  assert.deepEqual((await recorded(sha)).map((e) => [e.agent, e.prompt]), [['claude-code', 'store money as integer cents']]);
  await new Promise((res) => setTimeout(res, 1000)); // the post-commit hook that fired during the rebase has had time to run
  assert.equal((await eventsFor(sha)).length, 1, 'recorded once');
});
