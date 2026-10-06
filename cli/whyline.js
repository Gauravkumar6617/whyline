#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const DIR = process.env.WHYLINE_HOME ?? join(homedir(), '.config', 'whyline');
const CONFIG = join(DIR, 'config.json');
const QUEUE = join(DIR, 'queue.jsonl');

const HELP = `whyline: record what AI agents change

  whyline login --url <server> --key <wl_...>   save credentials (or set WHYLINE_URL / WHYLINE_KEY)
  whyline init                                   install the git post-commit hook in this repo
  whyline events [--since <id>]                  show recent events
  whyline hook claude-code                       (used by the Claude Code plugin, reads hook JSON on stdin)
  whyline hook git                               (used by the git hook)`;

function config() {
  let c = {};
  try { c = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch {}
  return { url: process.env.WHYLINE_URL ?? c.url, key: process.env.WHYLINE_KEY ?? c.key };
}

async function api(method, path, body, { url, key } = config()) {
  if (!url || !key) throw new Error('not logged in: run `whyline login --url <server> --key <key>`');
  const res = await fetch(url.replace(/\/$/, '') + path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

// Bad input (400/413) can never succeed, so drop it. Anything else (offline, 5xx, wrong key) is retried later.
const retryable = (err) => err.status !== 400 && err.status !== 413;

function enqueue(events) {
  mkdirSync(DIR, { recursive: true });
  // O_APPEND writes are atomic per call, so parallel hooks can't clobber each other.
  appendFileSync(QUEUE, events.map((e) => JSON.stringify(e) + '\n').join(''));
}

// Never lose an event: failures go to a local queue, flushed on the next successful send.
async function send(event) {
  try {
    await api('POST', '/api/events', event);
  } catch (err) {
    if (!retryable(err)) throw err;
    enqueue([event]);
    throw err;
  }
  await flush();
}

async function flush() {
  const claimed = `${QUEUE}.${process.pid}`;
  try { renameSync(QUEUE, claimed); } catch { return; } // empty, or another process is flushing it
  const events = readFileSync(claimed, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (let i = 0; i < events.length; i++) {
    try {
      await api('POST', '/api/events', events[i]);
    } catch (err) {
      if (retryable(err)) { enqueue(events.slice(i)); break; }
    }
  }
  unlinkSync(claimed);
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const gitEmail = (cwd) => { try { return git(['config', 'user.email'], cwd); } catch { return null; } };
const cut = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

function fromClaude(h) {
  const base = { ts: new Date().toISOString(), agent: 'claude-code', session: cut(h.session_id, 200), author: cut(gitEmail(h.cwd), 200) };
  if (h.hook_event_name === 'UserPromptSubmit') return { ...base, kind: 'prompt', prompt: cut(h.prompt, 20000) };
  if (h.hook_event_name === 'PostToolUse') {
    const f = h.tool_input?.file_path ?? h.tool_input?.notebook_path;
    const file = f && h.cwd && isAbsolute(f) ? relative(h.cwd, f) : f;
    return { ...base, kind: 'edit', summary: cut(`${h.tool_name} ${file ?? ''}`.trim(), 5000), files: file ? [cut(file, 1000)] : [] };
  }
  return null;
}

// Agents mark their commits with trailers; anything unmarked is recorded as 'none' (human or unknown).
const AGENT_RE = /^(?:co-authored-by|ai-agent):.*?\b(claude|cursor|copilot|codex|gemini|aider|devin|windsurf)/im;

function fromGit() {
  const [sha, email, ...msg] = git(['log', '-1', '--format=%H%n%ae%n%B']).split('\n');
  const body = msg.join('\n').trim();
  const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean);
  return {
    ts: new Date().toISOString(),
    agent: body.match(AGENT_RE)?.[1].toLowerCase() ?? 'none',
    kind: 'commit',
    author: cut(email, 200),
    commit_sha: sha,
    summary: cut(body, 5000),
    files: files.slice(0, 1000).map((f) => cut(f, 1000)),
  };
}

async function hook(source) {
  // Hooks must never break the agent or the commit: stay silent on stdout, always exit 0.
  try {
    let event;
    if (source === 'claude-code') event = fromClaude(JSON.parse(readFileSync(0, 'utf8')));
    else if (source === 'git') event = fromGit();
    else throw new Error(`unknown hook source: ${source}`);
    if (event) await send(event);
  } catch (err) {
    console.error(`whyline: ${err.message}${retryable(err) && err.status !== undefined ? ' (queued)' : ''}`);
  }
}

function init() {
  const dir = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  const file = join(dir, 'post-commit');
  const line = '(whyline hook git >/dev/null 2>&1 &)';
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '#!/bin/sh\n';
  if (current.includes('whyline hook git')) return console.log(`already installed: ${file}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, current.replace(/\n?$/, '\n') + line + '\n');
  chmodSync(file, 0o755);
  console.log(`installed: ${file}`);
}

const { values: opts, positionals: [cmd, arg] } = parseArgs({
  allowPositionals: true,
  options: { url: { type: 'string' }, key: { type: 'string' }, since: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});

try {
  if (cmd === 'hook') await hook(arg);
  else if (cmd === 'init') init();
  else if (cmd === 'login') {
    if (!opts.url || !opts.key) throw new Error('usage: whyline login --url <server> --key <key>');
    const { workspace } = await api('GET', '/api/events?limit=1', null, opts);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({ url: opts.url, key: opts.key }, null, 2), { mode: 0o600 });
    console.log(`logged in to workspace "${workspace}"`);
  } else if (cmd === 'events') {
    const { events } = await api('GET', `/api/events?since=${parseInt(opts.since) || 0}`);
    for (const e of events.reverse()) {
      console.log([e.id, e.ts, e.agent, e.kind, e.author ?? '-', (e.summary ?? e.prompt ?? '').split('\n')[0]].join('\t'));
    }
  } else {
    console.log(HELP);
    if (cmd && !opts.help) process.exitCode = 1;
  }
} catch (err) {
  console.error(`whyline: ${err.message}`);
  process.exitCode = 1;
}
