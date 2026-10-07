// Runs the dashboard's real script (from public/app.html) against a minimal fake DOM, storage and fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];

function element() {
  return {
    hidden: false, value: '', textContent: '', className: '', disabled: false, attrs: {}, children: [], focused: 0,
    get childNodes() { return this.children; },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); }, prepend() {},
    focus() { this.focused++; }, click() {},
  };
}

// `pages(path, key)` answers each request: an object with a `status` (default 200) and JSON `body`.
function dashboard({ saved = null, pages }) {
  const els = {};
  const storage = new Map(saved ? [['wl_key', saved]] : []);
  const requests = [];
  const downloads = [];
  const ctx = {
    document: { querySelector: (s) => (els[s] ??= element()), createElement: () => element(), createRange: () => ({ selectNodeContents() {} }) },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    location: { hash: '' },
    fetch: async (path, opts = {}) => {
      const key = opts.headers?.authorization?.replace('Bearer ', '');
      requests.push({ path, key });
      const r = pages(path, key);
      return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body };
    },
    Blob: class { constructor(parts) { downloads.push(parts.join('')); } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout, console, navigator: {}, getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { ctx, els, storage, requests, downloads, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

const ev = (id, extra = {}) => ({ id, ts: '2026-10-07T10:00:00.000Z', agent: 'claude-code', kind: 'prompt', author: null, session: null, prompt: `p${id}`, summary: null, commit_sha: null, files: [], ...extra });

test('a saved key that the server rejects is forgotten after one request, with a way to recover', async () => {
  const d = dashboard({ saved: 'wl_stale', pages: () => ({ status: 401, body: { error: 'invalid API key' } }) });
  await d.settle();
  assert.equal(d.requests.length, 1);
  assert.equal(d.storage.has('wl_key'), false, 'the stale key is removed from storage');
  assert.equal(d.els['#auth'].hidden, false, 'the sign-in form is shown');
  assert.equal(d.els['#view'].hidden, true);
  assert.match(d.els['#msg'].textContent, /This API key was not accepted.*Paste a valid key/);
  assert.ok(d.els['#key'].focused > 0);

  // The next visit starts at the sign-in form without calling the API.
  const next = dashboard({ saved: d.storage.get('wl_key') ?? null, pages: () => assert.fail('no request expected') });
  await next.settle();
  assert.equal(next.requests.length, 0);
});

test('other failures (offline, 500) keep the saved key, since it may still be valid', async () => {
  const d = dashboard({ saved: 'wl_good', pages: () => ({ status: 500, body: { error: 'internal error' } }) });
  await d.settle();
  assert.equal(d.storage.get('wl_key'), 'wl_good');
  assert.equal(d.els['#msg'].textContent, 'internal error');
});

test('a valid key is saved, cleared from the input, and never put in a URL', async () => {
  const d = dashboard({ pages: () => ({ body: { workspace: 'acme', events: [ev(1)] } }) });
  d.ctx.document.querySelector('#key').value = '  wl_typed  ';
  d.ctx.document.querySelector('#open').onsubmit({ preventDefault() {} });
  await d.settle();
  assert.equal(d.storage.get('wl_key'), 'wl_typed');
  assert.equal(d.els['#key'].value, '', 'the key does not stay in the form');
  assert.equal(d.els['#ws'].textContent, 'acme');
  assert.ok(d.requests.every((r) => !r.path.includes('wl_typed')), 'key only in the Authorization header');
});

test('a key revoked while the dashboard is open is forgotten on the next refresh', async () => {
  let revoked = false;
  const d = dashboard({ saved: 'wl_k', pages: () => (revoked ? { status: 401, body: { error: 'invalid API key' } } : { body: { workspace: 'w', events: [ev(1)] } }) });
  await d.settle();
  revoked = true;
  d.els['#refresh'].onclick();
  await d.settle();
  assert.equal(d.storage.has('wl_key'), false);
  assert.equal(d.els['#view'].hidden, true);
  assert.equal(d.els['#logout'].hidden, true);
});

test('CSV export pages until an empty page, so short pages (large events) do not end it early', async () => {
  // 7 events, served 3 per page as a server under its byte budget would.
  const all = Array.from({ length: 7 }, (_, i) => ev(7 - i, i === 2 ? { agent: 'claude', prompt: '=HYPERLINK("x")', files: ['a.js', 'b "q".js'] } : {}));
  const d = dashboard({
    saved: 'wl_k',
    pages: (path) => {
      const before = Number(new URL(path, 'http://x').searchParams.get('before')) || Infinity;
      return { body: { workspace: 'w', events: all.filter((e) => e.id < before).slice(0, 3) } };
    },
  });
  await d.settle();
  await d.ctx.exportCsv();
  const rows = d.downloads[0].split('\r\n');
  assert.equal(rows[0], 'id,ts,agent,kind,author,commit_sha,session,summary,prompt,files');
  assert.deepEqual(rows.slice(1).map((r) => r.split(',')[0]), ['"7"', '"6"', '"5"', '"4"', '"3"', '"2"', '"1"'], 'every event once, newest first');
  assert.equal(rows[3], '"5","2026-10-07T10:00:00.000Z","claude-code","prompt","","","","","\'=HYPERLINK(""x"")","a.js b ""q"".js"',
    'legacy agent name normalised, formula neutralised, quotes escaped');
  assert.match(d.els['#msg'].textContent, /Exported 7 events/);
});
