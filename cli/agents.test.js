import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
const { server } = await import('../server/index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const url = `http://localhost:${server.address().port}`;
after(() => server.close());

const CLI = new URL('./whyline.js', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'whyline-agents-home-'));
const cli = (args, env, { cwd, input = '' } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, WHYLINE_HOME: home, ...env } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => resolve(out));
  p.stdin.end(input);
});
const workspace = async (name) => {
  const ws = await (await fetch(`${url}/api/workspaces`, { method: 'POST', body: JSON.stringify({ name }) })).json();
  return { ws, env: { WHYLINE_URL: url, WHYLINE_KEY: ws.key } };
};
const eventsOf = async (ws) => (await (await fetch(`${url}/api/events?limit=500`, { headers: { authorization: `Bearer ${ws.key}` } })).json()).events;
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'whyline-agents-repo-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=dev@x.io', '-c', 'user.name=dev', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  return { dir, git };
};
const claudeHook = (cwd, h) => JSON.stringify({ session_id: 's1', cwd, ...h });

// ------------------------------------------------------------------ one canonical name for Claude Code (B1)

test('Claude Code plugin events and Claude commit trailers record the same agent name', async () => {
  const { ws, env } = await workspace('canonical');
  const { dir, git } = repo();
  await cli(['hook', 'claude-code'], env, { cwd: dir, input: claudeHook(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'add orders' }) });
  writeFileSync(join(dir, 'orders.js'), 'const amount_cents = 1;\n');
  await cli(['hook', 'claude-code'], env, { cwd: dir, input: claudeHook(dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'orders.js') } }) });
  git('add', '.');
  git('commit', '-q', '-m', 'add orders\n\nCo-Authored-By: Claude <noreply@anthropic.com>'); // trailer AND recorded Claude edits
  await cli(['hook', 'git'], env, { cwd: dir });
  git('commit', '-q', '--allow-empty', '-m', 'second\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'); // trailer only
  await cli(['hook', 'git'], env, { cwd: dir });

  const events = await eventsOf(ws);
  assert.deepEqual(events.map((e) => [e.kind, e.agent]).sort(), [['commit', 'claude-code'], ['commit', 'claude-code'], ['edit', 'claude-code'], ['prompt', 'claude-code']]);
  assert.deepEqual([...new Set(events.map((e) => e.agent))], ['claude-code'], 'Claude Code must not be split into two agents');
  assert.ok(!(await cli(['events'], env)).includes('\tclaude\t'));
});

test('blame shows claude-code for a trailer commit, for a plugin-linked commit, and for rows stored by older versions as "claude"', async () => {
  const { ws, env } = await workspace('blame-canonical');
  const { dir, git } = repo();
  const post = (e) => fetch(`${url}/api/events`, { method: 'POST', headers: { authorization: `Bearer ${ws.key}` }, body: JSON.stringify(e) });

  writeFileSync(join(dir, 'a.js'), 'a\n');
  git('add', '.'); git('commit', '-q', '-m', 'via trailer\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  await cli(['hook', 'git'], env, { cwd: dir });
  const trailer = await cli(['blame', 'a.js:1'], env, { cwd: dir });

  await cli(['hook', 'claude-code'], env, { cwd: dir, input: claudeHook(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'make b' }) });
  writeFileSync(join(dir, 'b.js'), 'b\n');
  await cli(['hook', 'claude-code'], env, { cwd: dir, input: claudeHook(dir, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(dir, 'b.js') } }) });
  git('add', '.'); git('commit', '-q', '-m', 'via plugin');
  await cli(['hook', 'git'], env, { cwd: dir });
  const plugin = await cli(['blame', 'b.js:1'], env, { cwd: dir });

  writeFileSync(join(dir, 'c.js'), 'c\n');
  git('add', '.'); git('commit', '-q', '-m', 'old row');
  await post({ agent: 'claude', kind: 'commit', commit_sha: git('rev-parse', 'HEAD').trim(), summary: 'old row' }); // what older CLI versions stored
  const legacy = await cli(['blame', 'c.js:1'], env, { cwd: dir });

  for (const out of [trailer, plugin, legacy]) assert.match(out, / · claude-code · dev@x\.io|· claude-code · -/, out);
  assert.ok(![trailer, plugin, legacy].some((o) => / · claude · /.test(o)));
});

test('dashboard and CSV show legacy "claude" rows as claude-code, so filtering does not split the agent', () => {
  const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const snippet = html.match(/\/\/ agent-normalize:start\n([\s\S]*?)\/\/ agent-normalize:end/)[1];
  const { withCanonicalAgent } = vm.runInNewContext(`${snippet}; ({ withCanonicalAgent })`);
  const rows = [{ id: 1, agent: 'claude' }, { id: 2, agent: 'claude-code' }, { id: 3, agent: 'cursor' }, { id: 4, agent: 'none' }].map(withCanonicalAgent);
  assert.deepEqual(rows.map((r) => r.agent), ['claude-code', 'claude-code', 'cursor', 'none']);
  assert.equal(rows.filter((r) => `${r.agent}`.toLowerCase().includes('claude-code')).length, 2, 'a "claude-code" filter must find both');
  // The timeline and the CSV export are the two places rows are read; both must go through the helper.
  assert.ok(html.includes('events = data.events.map(withCanonicalAgent)'));
  assert.ok(html.includes('all.push(...data.events.map(withCanonicalAgent))'));
});

// ------------------------------------------------------------------ trailers name the agent, not a person who shares its name (B2)

const POSITIVE = {
  'claude-code': ['Co-Authored-By: Claude <noreply@anthropic.com>', 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', 'Co-authored-by: claude[bot] <209825114+claude[bot]@users.noreply.github.com>', 'AI-Agent: claude-code', 'AI-Agent: Claude', 'Assisted-by: Claude:claude-3-opus coccinelle sparse', 'Assisted-by: Claude coccinelle sparse'],
  cursor: ['Co-authored-by: Cursor Agent <cursoragent@cursor.com>', 'AI-Agent: cursor', 'Assisted-by: Cursor'],
  copilot: ['Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>', 'Co-authored-by: github-copilot[bot] <x@users.noreply.github.com>', 'AI-Agent: copilot', 'Assisted-by: GitHub Copilot'],
  codex: ['Co-authored-by: Codex CLI <noreply@openai.com>', 'Co-authored-by: Codex <noreply@openai.com>', 'AI-Agent: codex'],
  gemini: ['Co-authored-by: Gemini CLI <noreply@google.com>', 'AI-Agent: gemini'],
  aider: ['Co-authored-by: aider (gpt-4o) <noreply@aider.chat>', 'AI-Agent: aider'],
  devin: ['Co-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>', 'AI-Agent: devin'],
  windsurf: ['Co-authored-by: Windsurf <noreply@codeium.com>', 'AI-Agent: windsurf'],
};
const NEGATIVE = [
  'Co-authored-by: Claude Monet <claude@example.com>', 'Co-authored-by: Claude <claude@acme.fr>',
  'Co-authored-by: Cursor Johnson <cj@example.com>', 'Co-authored-by: Copilot Jones <cj@example.com>', 'Co-authored-by: Codex Rivera <c@example.com>',
  'Co-authored-by: Alice Gemini <a@example.com>', 'Co-authored-by: Gemini Rossi <g@example.com>', 'Co-authored-by: Aider Khan <a@example.com>',
  'Co-authored-by: Devin Smith <devin@example.com>', 'Co-authored-by: Devin <devin@acme.io>', 'Co-authored-by: Windsurf Pete <w@example.com>',
  'Reviewed with copilot yesterday', 'Co-authored-by: nobody <n@x.y>', 'AI-Agent: some-new-agent', 'Assisted-by: some-new-agent:v1', 'Generated with Claude Code',
];

test('trailers that identify a supported agent are recognised, and people who share an agent\'s name are not', async () => {
  const { ws, env } = await workspace('trailers');
  const { dir, git } = repo();
  const cases = [
    ...Object.entries(POSITIVE).flatMap(([agent, trailers]) => trailers.map((t) => [t, agent])),
    ...NEGATIVE.map((t) => [t, 'none']),
    ['Co-authored-by: Alice Gemini <a@example.com>\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', 'cursor'], // a person first, then the agent
  ];
  for (const [i, [trailer]] of cases.entries()) {
    git('commit', '-q', '--allow-empty', '-m', `change ${i}\n\n${trailer}`);
    await cli(['hook', 'git'], env, { cwd: dir });
  }
  const events = (await eventsOf(ws)).reverse();
  assert.equal(events.length, cases.length);
  for (const [i, [trailer, expected]] of cases.entries()) assert.equal(events[i].agent, expected, trailer);
  for (const agent of Object.keys(POSITIVE)) assert.ok(events.some((e) => e.agent === agent), `${agent} was never detected`);
});

// ------------------------------------------------------------------ prompts and edits from Cursor, Codex and Gemini hooks

// What each agent's hooks send on stdin (field names from their hook docs), and what it expects back on stdout.
const AGENT_HOOKS = {
  cursor: {
    prompt: (dir) => ({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', workspace_roots: [dir], prompt: 'cursor: add tax' }),
    edit: (dir) => ({ hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: [dir], file_path: join(dir, 'tax.js'), edits: [] }),
    file: 'tax.js', summary: 'Edit tax.js', reply: '{"continue":true}',
  },
  codex: {
    prompt: (dir) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'x1', cwd: dir, turn_id: 't', prompt: 'codex: add vat' }),
    edit: (dir) => ({ hook_event_name: 'PostToolUse', session_id: 'x1', cwd: dir, tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Add File: vat.js\n+vat\n*** Update File: lib/old.js\n*** Move to: lib/new.js\n@@\n-a\n+b\n*** End Patch\n' } }),
    file: 'vat.js', summary: 'apply_patch vat.js lib/old.js lib/new.js', reply: '',
  },
  gemini: {
    prompt: (dir) => ({ hook_event_name: 'BeforeAgent', session_id: 'g1', cwd: dir, prompt: 'gemini: add fees' }),
    edit: (dir) => ({ hook_event_name: 'AfterTool', session_id: 'g1', cwd: dir, tool_name: 'write_file', tool_input: { file_path: join(dir, 'fees.js'), content: 'fees' } }),
    file: 'fees.js', summary: 'write_file fees.js', reply: '{}',
  },
};

for (const [agent, h] of Object.entries(AGENT_HOOKS)) {
  test(`${agent} hooks record prompts and edits, and the next commit carries the prompt for blame`, async () => {
    const { ws, env } = await workspace(agent);
    const { dir, git } = repo();
    const replies = [
      await cli(['hook', agent], env, { cwd: dir, input: JSON.stringify(h.prompt(dir)) }),
      await cli(['hook', agent], env, { cwd: dir, input: JSON.stringify(h.edit(dir)) }),
    ];
    assert.deepEqual(replies, [h.reply, h.reply], 'stdout is exactly what the agent expects');
    writeFileSync(join(dir, h.file), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'no trailer');
    await cli(['hook', 'git'], env, { cwd: dir });

    const [commit, edit, prompt] = await eventsOf(ws);
    assert.deepEqual([prompt.agent, prompt.kind, prompt.prompt], [agent, 'prompt', h.prompt(dir).prompt]);
    assert.deepEqual([edit.agent, edit.kind, edit.summary], [agent, 'edit', h.summary]);
    assert.deepEqual([commit.agent, commit.kind, commit.prompt], [agent, 'commit', h.prompt(dir).prompt], 'agent and prompt come from the recorded edit');
    assert.match(await cli(['blame', `${h.file}:1`], env, { cwd: dir }), new RegExp(` · ${agent} · [\\s\\S]*${h.prompt(dir).prompt}`));
  });
}

test('agent hook events that edit no file are ignored, and broken input still answers and exits 0', async () => {
  const { ws, env } = await workspace('ignored');
  const shell = { hook_event_name: 'PostToolUse', session_id: 'x', cwd: '/r', tool_name: 'Bash', tool_input: { command: 'ls' } };
  assert.equal(await cli(['hook', 'codex'], env, { input: JSON.stringify(shell) }), '');
  assert.equal(await cli(['hook', 'cursor'], env, { input: JSON.stringify({ hook_event_name: 'afterTabFileEdit' }) }), '{"continue":true}');
  assert.equal(await cli(['hook', 'gemini'], env, { input: 'not json' }), '{}');
  assert.deepEqual(await eventsOf(ws), []);
});
