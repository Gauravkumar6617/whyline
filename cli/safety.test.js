import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
const { server } = await import('../server/index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const url = `http://localhost:${server.address().port}`;
after(() => server.close());

const CLI = new URL('./whyline.js', import.meta.url).pathname;
const SERVER = new URL('../server/index.js', import.meta.url).pathname;
const posix = process.platform !== 'win32';
const OFFLINE = 'http://127.0.0.1:1';

const run = (args, { env = {}, input = '', node = [] } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [...node, ...args], { env: { ...process.env, ...env } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, out, err }));
  p.stdin.end(input);
});
const cli = (args, opts = {}) => run([CLI, ...args], opts);
const home = () => mkdtempSync(join(tmpdir(), 'whyline-safety-'));
const mode = (path) => statSync(path).mode & 0o777;
const noStack = (r) => assert.doesNotMatch(r.err, /\n\s+at |Error \[ERR_/, `stack trace in: ${r.err}`);
const workspace = async (name) => (await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: JSON.stringify({ name }) })).json()).key;
const prompt = (text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/tmp', prompt: text });

// --- P4: local files can hold the API key and prompt text.

test('new config dir and files are owner-only, even under a permissive umask', { skip: !posix }, async () => {
  const old = process.umask(0o002); // the umask that produced 775/664 in the audit
  try {
    const h = home();
    const dir = join(h, '.config', 'whyline'); // the default location
    const r = await cli(['hook', 'claude-code'], { env: { HOME: h, WHYLINE_URL: OFFLINE, WHYLINE_KEY: 'wl_x', WHYLINE_HOME: undefined }, input: prompt('secret') });
    assert.equal(r.code, 0);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'queue.jsonl')), 0o600);
    assert.equal(mode(join(dir, 'edits.jsonl')), 0o600);

    const key = await workspace('perm');
    await cli(['login', '--url', url, '--key', key], { env: { HOME: h, WHYLINE_HOME: undefined } });
    assert.equal(mode(join(dir, 'config.json')), 0o600);
  } finally { process.umask(old); }
});

test('existing loose files are tightened when whyline next runs; unrelated files are not touched', { skip: !posix }, async () => {
  const h = home();
  const dir = join(h, 'wl');
  mkdirSync(dir);
  chmodSync(dir, 0o775);
  for (const [f, m] of [['config.json', 0o644], ['queue.jsonl', 0o664], ['edits.jsonl', 0o664], ['queue.jsonl.claimed.1.0.2', 0o664], ['notes.txt', 0o664]]) {
    writeFileSync(join(dir, f), f === 'config.json' ? '{}' : '');
    chmodSync(join(dir, f), m);
  }
  const r = await cli(['events'], { env: { WHYLINE_HOME: dir } }); // any command, even one that fails (not logged in)
  assert.equal(r.code, 1);
  assert.equal(mode(dir), 0o700);
  for (const f of ['config.json', 'queue.jsonl', 'edits.jsonl', 'queue.jsonl.claimed.1.0.2']) assert.equal(mode(join(dir, f)), 0o600, f);
  assert.equal(mode(join(dir, 'notes.txt')), 0o664, 'not a whyline file');

  // Logging in over an existing config file (which keeps its mode on write) still leaves it owner-only.
  chmodSync(join(dir, 'config.json'), 0o644);
  const key = await workspace('perm2');
  await cli(['login', '--url', url, '--key', key], { env: { WHYLINE_HOME: dir } });
  assert.equal(mode(join(dir, 'config.json')), 0o600);
});

// --- P8: unsupported Node versions.

const asNode = (version) => [`--import=data:text/javascript,Object.defineProperty(process.versions,'node',{value:'${version}'})`];

test('an unsupported Node version gets a clear message, not a stack trace; hooks still exit 0', async () => {
  for (const args of [['events'], ['login', '--url', url, '--key', 'wl_x', '--no-prompts'], ['init']]) {
    const r = await cli(args, { node: asNode('20.11.1') });
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, 'whyline: Node.js 22.13 or newer is required (this is 20.11.1). Update Node and try again.\n');
  }
  const hook = await cli(['hook', 'claude-code'], { node: asNode('22.12.0'), input: prompt('x') });
  assert.equal(hook.code, 0, 'a hook never fails the agent or the commit');
  assert.match(hook.err, /22\.13 or newer is required \(this is 22\.12\.0\)/);

  const srv = await run([SERVER], { node: asNode('22.4.0'), env: { PORT: '0', DB_PATH: ':memory:' } });
  assert.equal(srv.code, 1);
  assert.equal(srv.err, 'whyline server: Node.js 22.13 or newer is required (this is 22.4.0).\n');

  assert.equal((await cli(['--help'], { node: asNode('22.13.0') })).code, 0, 'the minimum itself is accepted');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.13', 'package.json engines matches the runtime check');
});

// --- P9: bad arguments.

test('invalid arguments give one readable line and exit 1, without a stack trace', async () => {
  for (const [args, message] of [
    [['events', '--limit', '5'], "whyline: Unknown option '--limit'. Run `whyline --help` for usage.\n"],
    [['blame', '--foo'], "whyline: Unknown option '--foo'. Run `whyline --help` for usage.\n"],
    [['login', '--url'], "whyline: Option '--url <value>' argument missing. Run `whyline --help` for usage.\n"],
    [['events', '--since', 'abc'], 'whyline: --since must be an event id (a whole number)\n'],
    [['blame'], 'whyline: usage: whyline blame <file>:<line>\n'],
  ]) {
    const r = await cli(args, { env: { WHYLINE_HOME: home(), WHYLINE_URL: OFFLINE, WHYLINE_KEY: 'wl_x' } });
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.err, message);
    assert.equal(r.out, '');
    noStack(r);
  }
  const help = await cli(['--help'], { env: { WHYLINE_HOME: home() } });
  assert.equal(help.code, 0);
  assert.match(help.out, /whyline login --url <server> --key <wl_\.\.\.>/);
  assert.equal((await cli(['nope'], { env: { WHYLINE_HOME: home() } })).code, 1);

  const offline = await cli(['events'], { env: { WHYLINE_HOME: home(), WHYLINE_URL: 'http://user:hunter2@127.0.0.1:1', WHYLINE_KEY: 'wl_x' } });
  assert.equal(offline.code, 1);
  assert.match(offline.err, /^whyline: can't reach 127\.0\.0\.1:1: /);
  assert.doesNotMatch(offline.err, /hunter2/, 'credentials in the URL are not echoed');
});

test('a rejected key gives a clear message that never contains the key', async () => {
  const r = await cli(['events'], { env: { WHYLINE_HOME: home(), WHYLINE_URL: url, WHYLINE_KEY: 'wl_not-a-real-key' } });
  assert.equal(r.code, 1);
  assert.equal(r.err, 'whyline: the server rejected the API key (HTTP 401). Run `whyline login --url <server> --key <key>` with a valid key\n');
});

// --- P10: WHYLINE_NO_PROMPTS and the saved opt-out.

const sentPrompt = async (key, h, env) => {
  await cli(['hook', 'claude-code'], { env: { WHYLINE_HOME: h, WHYLINE_URL: url, WHYLINE_KEY: key, ...env }, input: prompt('the prompt') });
  const { events } = await (await fetch(`${url}/api/events?limit=1`, { headers: { authorization: `Bearer ${key}` } })).json();
  return events[0].prompt;
};

test('WHYLINE_NO_PROMPTS: 1/true/yes/on opt out, 0/false/no/off/empty/unset do not, anything else opts out', async () => {
  const key = await workspace('prompts-env');
  const h = home();
  for (const v of [undefined, '0', 'false', 'FALSE', 'no', 'off', '', ' 0 ']) {
    assert.equal(await sentPrompt(key, h, { WHYLINE_NO_PROMPTS: v }), 'the prompt', `WHYLINE_NO_PROMPTS=${v}`);
  }
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'banana']) {
    assert.equal(await sentPrompt(key, h, { WHYLINE_NO_PROMPTS: v }), null, `WHYLINE_NO_PROMPTS=${v}`);
  }
});

test('the saved opt-out survives a new login and wins over WHYLINE_NO_PROMPTS=0; --prompts turns prompts back on', async () => {
  const key = await workspace('prompts-login');
  const h = home();
  const login = (...flags) => cli(['login', '--url', url, '--key', key, ...flags], { env: { WHYLINE_HOME: h } });
  const saved = () => JSON.parse(readFileSync(join(h, 'config.json'), 'utf8')).prompts;

  assert.match((await login('--no-prompts')).out, /\(prompt text will not be sent\)/);
  assert.equal(saved(), false);
  assert.match((await login()).out, /\(prompt text will not be sent\)/, 'logging in again keeps the opt-out');
  assert.equal(saved(), false);
  assert.equal(await sentPrompt(key, h, { WHYLINE_NO_PROMPTS: '0' }), null, 'an opt-out from either place wins');

  assert.doesNotMatch((await login('--prompts')).out, /will not be sent/);
  assert.equal(saved(), true);
  assert.equal(await sentPrompt(key, h, {}), 'the prompt');
});
