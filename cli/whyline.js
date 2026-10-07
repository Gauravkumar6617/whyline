#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const DIR = process.env.WHYLINE_HOME ?? join(homedir(), '.config', 'whyline');
const CONFIG = join(DIR, 'config.json');
const QUEUE = join(DIR, 'queue.jsonl');
const EDITS = join(DIR, 'edits.jsonl');
// Claude Code kills a hook after 5s. Stop sending queued events a little before that; the rest wait for the next run.
const DEADLINE = Date.now() + 4500;

const HELP = `whyline: record what AI agents change

  whyline login --url <server> --key <wl_...>   save credentials (or set WHYLINE_URL / WHYLINE_KEY)
    [--no-prompts]                               never send prompt text (or set WHYLINE_NO_PROMPTS=1)
  whyline init                                   install the git post-commit hook in this repo
  whyline blame <file>:<line>                    which commit, agent and prompt produced this line
  whyline events [--since <id>]                  show recent events
  whyline hook claude-code                       (used by the Claude Code plugin, reads hook JSON on stdin)
  whyline hook git                               (used by the git hook)`;

function config() {
  let c = {};
  try { c = JSON.parse(readFileSync(CONFIG, 'utf8')); } catch {}
  return {
    url: process.env.WHYLINE_URL ?? c.url,
    key: process.env.WHYLINE_KEY ?? c.key,
    prompts: !process.env.WHYLINE_NO_PROMPTS && c.prompts !== false,
  };
}

async function api(method, path, body, { url, key } = config(), timeout = 4000) {
  if (!url || !key) throw new Error('not logged in: run `whyline login --url <server> --key <key>`');
  const res = await fetch(url.replace(/\/$/, '') + path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
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

// A flush claims the queue by renaming it to queue.jsonl.claimed.<ms>.<seq>.<pid>, then sends its events in order,
// appending a "#" line to that file after each one. If the process dies (Claude Code kills slow hooks), the claim is
// left behind with its progress marks, and the next run takes it over, so nothing is lost and nothing already sent is repeated.
// ponytail: an event sent just before a kill, whose "#" was not written yet, is sent again (no idempotency key).
const CLAIM = /^queue\.jsonl\.(?:claimed\.(\d+)\.(\d+)\.(\d+)|(\d+))$/; // the second form is what older versions left behind
const STALE_MS = 60e3;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const claimPath = (ms, seq, pid) => `${QUEUE}.claimed.${ms}.${seq}.${pid}`;

async function flush() {
  let claims;
  try {
    claims = readdirSync(DIR).map((name) => ({ name, m: name.match(CLAIM) })).filter((c) => c.m)
      .map(({ name, m }) => ({ path: join(DIR, name), ms: Number(m[1] ?? 0), seq: Number(m[2] ?? 0), pid: Number(m[3] ?? m[4]) }))
      .sort((a, b) => a.ms - b.ms || a.seq - b.seq || a.pid - b.pid);
  } catch { return; } // no config dir yet, so nothing is queued

  const mine = [], stale = [];
  for (const c of claims) {
    if (c.pid === process.pid) { mine.push(c.path); continue; }
    let idle;
    try { idle = Date.now() - statSync(c.path).ctimeMs; } catch { continue; } // renamed or finished by someone else
    if (alive(c.pid) && idle < STALE_MS) return; // another flush is running: leave everything in order for later
    stale.push(c);
  }
  for (const c of stale) {
    const taken = claimPath(c.ms, c.seq, process.pid);
    try { renameSync(c.path, taken); mine.push(taken); } catch {} // lost the race to another process
  }
  const fresh = claimPath(Date.now(), 0, process.pid);
  try { renameSync(QUEUE, fresh); mine.push(fresh); } catch {} // empty, or another process claimed it

  for (const file of mine) {
    const text = readFileSync(file, 'utf8');
    const done = (text.match(/^#$/gm) ?? []).length;
    const events = text.split('\n').filter((l) => l && l[0] !== '#');
    for (let i = done; i < events.length; i++) {
      const left = DEADLINE - Date.now();
      if (left < 300) return; // out of time: this claim stays, the next run continues from here
      let event;
      try { event = JSON.parse(events[i]); } catch { event = null; } // an unreadable line can never be sent
      if (event) {
        try { await api('POST', '/api/events', event, undefined, Math.min(4000, left)); }
        catch (err) { if (retryable(err)) return; } // keep this event and the rest for later
      }
      appendFileSync(file, '#\n');
    }
    unlinkSync(file);
  }
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const gitEmail = (cwd) => { try { return git(['config', 'user.email'], cwd); } catch { return null; } };
const cut = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);

// Claude edits are remembered locally until a commit includes those files; the commit then carries their prompts,
// which is what `whyline blame` shows. Records older than a day are dropped.
function remember(record) {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(EDITS, JSON.stringify(record) + '\n');
}

// ponytail: a hook appending while this rewrites the file can lose that one local record (blame context only,
// the event itself is still sent). Use the rename-claim trick from flush() if it ever matters.
function claimEdits(root, files) {
  let records;
  try { records = readFileSync(EDITS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return { sessions: [], prompts: [] }; }
  const wanted = new Set(files.map((f) => join(root, f)));
  const dayAgo = Date.now() - 864e5;
  const lastPrompt = {}, sessions = new Set(), prompts = [], keep = [];
  for (const r of records) {
    if (Date.parse(r.ts) < dayAgo) continue;
    if (r.prompt !== undefined) { lastPrompt[r.session] = r.prompt; keep.push(r); continue; }
    if (!wanted.has(r.file)) { keep.push(r); continue; }
    sessions.add(r.session);
    const p = lastPrompt[r.session];
    if (p && !prompts.includes(p)) prompts.push(p);
  }
  writeFileSync(EDITS, keep.map((r) => JSON.stringify(r) + '\n').join(''));
  return { sessions: [...sessions], prompts };
}

function fromClaude(h) {
  const ts = new Date().toISOString();
  const base = { ts, agent: 'claude-code', session: cut(h.session_id, 200), author: cut(gitEmail(h.cwd), 200) };
  if (h.hook_event_name === 'UserPromptSubmit') {
    if (!config().prompts) return { ...base, kind: 'prompt' };
    remember({ ts, session: h.session_id, prompt: h.prompt });
    return { ...base, kind: 'prompt', prompt: cut(h.prompt, 20000) };
  }
  if (h.hook_event_name === 'PostToolUse') {
    const f = h.tool_input?.file_path ?? h.tool_input?.notebook_path;
    if (f) remember({ ts, session: h.session_id, file: isAbsolute(f) ? f : join(h.cwd ?? '', f) });
    const file = f && h.cwd && isAbsolute(f) ? relative(h.cwd, f) : f;
    return { ...base, kind: 'edit', summary: cut(`${h.tool_name} ${file ?? ''}`.trim(), 5000), files: file ? [cut(file, 1000)] : [] };
  }
  return null;
}

// Agents mark their commits with a Co-Authored-By or AI-Agent trailer. A trailer counts only if it identifies the agent
// itself: a known agent address, an unmistakable agent name, or just the agent's own name with no personal address
// (so people called Claude, Devin or Gemini are not mistaken for AI). Keys are the names stored on events.
const AGENTS = {
  'claude-code': { email: [/^noreply@anthropic\.com$/, /\+claude\[bot\]@/], name: [/^claude code$/, /^claude\[bot\]$/, /^claude (opus|sonnet|haiku|fable)\b/], bare: /^claude([- ]code)?$/ },
  cursor: { email: [/^cursoragent@cursor\.com$/], name: [/^cursor agent$/, /^cursor\[bot\]$/], bare: /^cursor$/ },
  copilot: { email: [/^(\d+\+)?copilot@users\.noreply\.github\.com$/], name: [/^(github[- ])?copilot\[bot\]$/, /^github copilot$/, /^copilot (swe|coding) agent$/], bare: /^(github[- ])?copilot$/ },
  codex: { email: [], name: [/^codex (cli|agent)$/, /^codex\[bot\]$/, /^openai codex$/], bare: /^codex$/ },
  gemini: { email: [], name: [/^gemini[- ]cli(\[bot\])?$/, /^gemini[- ]code[- ]assist(\[bot\])?$/], bare: /^gemini([- ]cli)?$/ },
  aider: { email: [/^noreply@aider\.chat$/], name: [/^aider \(.+\)$/], bare: /^aider$/ },
  devin: { email: [/\+devin-ai-integration\[bot\]@/], name: [/^devin-ai-integration(\[bot\])?$/, /^devin ai$/], bare: /^devin$/ },
  windsurf: { email: [], name: [/^windsurf( cascade)?(\[bot\])?$/], bare: /^windsurf$/ },
};
const NON_PERSONAL = /noreply|no-reply|\[bot\]|(^|[^a-z])bot@/;
const TRAILER = /^(co-authored-by|ai-agent):[ \t]*(.+?)[ \t]*$/gim;

function agentOf(name, email, explicit) {
  for (const [agent, a] of Object.entries(AGENTS)) {
    if (a.email.some((re) => re.test(email)) || a.name.some((re) => re.test(name))) return agent;
    if (a.bare.test(name) && (explicit || !email || NON_PERSONAL.test(email))) return agent;
  }
}

function agentFromMessage(message) {
  for (const [, kind, value] of message.matchAll(TRAILER)) {
    const m = value.match(/^(.*?)\s*<([^>]*)>$/); // "Name <email>"
    const agent = agentOf((m ? m[1] : value).trim().toLowerCase(), (m ? m[2] : '').trim().toLowerCase(), kind.toLowerCase() === 'ai-agent');
    if (agent) return agent;
  }
}

// Events stored by older versions say "claude" for what is now "claude-code"; show them as one agent.
const canonical = (agent) => (agent === 'claude' ? 'claude-code' : agent);

function fromGit() {
  const [sha, email, ...msg] = git(['log', '-1', '--format=%H%n%ae%n%B']).split('\n');
  const body = msg.join('\n').trim();
  const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean);
  const { sessions, prompts } = claimEdits(git(['rev-parse', '--show-toplevel']), files);
  return {
    ts: new Date().toISOString(),
    agent: agentFromMessage(body) ?? (sessions.length ? 'claude-code' : 'none'),
    kind: 'commit',
    author: cut(email, 200),
    session: cut(sessions.at(-1), 200),
    prompt: prompts.length ? cut(prompts.join('\n\n---\n\n'), 20000) : null,
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

async function blame(target, lineArg) {
  const m = target?.match(/^(.+):(\d+)$/);
  const file = m ? m[1] : target;
  const line = parseInt(m ? m[2] : lineArg);
  if (!file || !(line > 0)) throw new Error('usage: whyline blame <file>:<line>');
  let out;
  try { out = git(['blame', '-L', `${line},${line}`, '--porcelain', '--', file]); }
  catch { throw new Error(`can't blame ${file}:${line} (not in a git repo, untracked file, or line out of range)`); }
  const sha = out.slice(0, 40);
  const code = out.split('\n').find((l) => l.startsWith('\t'))?.slice(1).trim() ?? '';
  console.log(`${file}:${line}  ${code}`);
  if (/^0+$/.test(sha)) return console.log('  not committed yet');

  const [e] = (await api('GET', `/api/events?commit=${sha}&limit=1`)).events;
  if (!e) return console.log(`  ${sha.slice(0, 8)}: no Whyline record (committed before Whyline was set up, or without the git hook)`);
  console.log(`  ${sha.slice(0, 8)} · ${canonical(e.agent)} · ${e.author ?? '-'} · ${new Date(e.ts).toLocaleString()}`);
  if (e.summary) console.log(`  ${e.summary.split('\n')[0]}`);
  if (e.prompt) console.log('\n  Prompt:\n' + e.prompt.split('\n').map((l) => '    ' + l).join('\n'));
  else if (e.agent === 'none') console.log('  no AI prompt linked (human commit, or agent without a hook)');
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

const { values: opts, positionals: [cmd, arg, arg2] } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    url: { type: 'string' }, key: { type: 'string' }, since: { type: 'string' },
    prompts: { type: 'boolean', default: true }, help: { type: 'boolean', short: 'h' },
  },
});

try {
  if (cmd === 'hook') await hook(arg);
  else if (cmd === 'init') init();
  else if (cmd === 'blame') await blame(arg, arg2);
  else if (cmd === 'login') {
    if (!opts.url || !opts.key) throw new Error('usage: whyline login --url <server> --key <key>');
    const { workspace } = await api('GET', '/api/events?limit=1', null, opts);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({ url: opts.url, key: opts.key, prompts: opts.prompts }, null, 2), { mode: 0o600 });
    console.log(`logged in to workspace "${workspace}"${opts.prompts ? '' : ' (prompt text will not be sent)'}`);
  } else if (cmd === 'events') {
    const { events } = await api('GET', `/api/events?since=${parseInt(opts.since) || 0}`);
    for (const e of events.reverse()) {
      console.log([e.id, e.ts, canonical(e.agent), e.kind, e.author ?? '-', (e.summary ?? e.prompt ?? '').split('\n')[0]].join('\t'));
    }
  } else {
    console.log(HELP);
    if (cmd && !opts.help) process.exitCode = 1;
  }
} catch (err) {
  console.error(`whyline: ${err.message}`);
  process.exitCode = 1;
}
