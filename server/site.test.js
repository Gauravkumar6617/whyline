import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';

process.env.PORT = '0';
process.env.DB_PATH ??= ':memory:';
const { server } = await import('./index.js');
await new Promise((r) => server.listening ? r() : server.once('listening', r));
const port = server.address().port;
const base = `http://localhost:${port}`;
const PUBLIC = new URL('../public/', import.meta.url);
const SITE = 'https://whyline.wrklyst.com';

const pages = [];
(function walk(dir, prefix = '') {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) walk(new URL(`${f.name}/`, dir), `${prefix}${f.name}/`);
    else if (f.name.endsWith('.html')) pages.push(prefix + f.name);
  }
})(PUBLIC);
const read = (file) => readFileSync(new URL(file, PUBLIC), 'utf8');
const urlOf = (file) => (file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, ''));

// Raw request so the path is sent exactly as written (fetch would normalize ../).
const raw = (path) => new Promise((resolve, reject) => {
  http.get({ port, path }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('every page is served at its clean URL', async () => {
  for (const file of pages) {
    const res = await fetch(base + urlOf(file));
    assert.equal(res.status, 200, urlOf(file));
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
});

test('every internal link and asset resolves, and anchors exist', async () => {
  for (const file of pages) {
    const html = read(file);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const [path, hash] = href.split('#');
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${file} -> ${href}`);
      if (hash && res.headers.get('content-type').includes('html')) {
        assert.ok((await res.text()).includes(`id="${hash}"`), `${file} -> ${href}: missing anchor`);
      }
    }
    for (const [, hash] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`id="${hash}"`), `${file}: #${hash}`);
  }
});

test('public pages have complete SEO metadata; /app and 404 are noindex', () => {
  for (const file of pages) {
    const html = read(file);
    const title = html.match(/<title>(.+?)<\/title>/)?.[1];
    assert.ok(title, `${file}: title`);
    assert.ok(html.match(/<meta name="description" content="[^"]{20,}"/), `${file}: description`);
    assert.match(html, /<meta property="og:title"/, `${file}: og:title`);
    assert.match(html, /<meta property="og:image" content="https:\/\/whyline\.wrklyst\.com\/og\.png"/, `${file}: og:image`);
    // The dashboard has two h1s (sign-in state and workspace state) but only one is visible at a time.
    assert.equal((html.match(/<h1[ >]/g) ?? []).length, file === 'app.html' ? 2 : 1, `${file}: h1 count`);
    if (file === 'app.html' || file === '404.html') assert.match(html, /<meta name="robots" content="noindex">/, file);
    else assert.ok(html.includes(`<link rel="canonical" href="${SITE}${urlOf(file)}">`), `${file}: canonical`);
  }
});

// Header and footer are copied into every page (no build step), so make sure they stay identical.
test('header and footer are identical on every page', () => {
  const norm = (html) => {
    const header = html.match(/<a class="skip"[\s\S]*?<\/header>/)[0];
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
    return (header + footer).replace(/ aria-current="page"/g, '')
      .replace(/<a class="btn primary" href="\/app">Open dashboard<\/a>|<button type="button" class="btn" id="logout" hidden>Switch workspace<\/button>/, '@@cta@@');
  };
  const [first, ...rest] = pages.map((f) => norm(read(f)));
  for (const [i, n] of rest.entries()) assert.equal(n, first, `${pages[i + 1]}: header/footer differ`);
});

test('sitemap lists exactly the indexable pages and robots.txt points to it', async () => {
  const sitemap = (await (await fetch(`${base}/sitemap.xml`)).text()).match(/<loc>(.+?)<\/loc>/g).map((l) => l.replace(/<\/?loc>/g, ''));
  const expected = pages.filter((f) => f !== 'app.html' && f !== '404.html').map((f) => SITE + urlOf(f));
  assert.deepEqual(sitemap.sort(), expected.sort());
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Sitemap: https:\/\/whyline\.wrklyst\.com\/sitemap\.xml/);
});

test('static server blocks path traversal and dotfiles, serves a 404 page, keeps API 404 as JSON', async () => {
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/.git/config', '/site.js%00.png', '/docs/../../package.json']) {
    const { status, body } = await raw(path);
    assert.ok(status === 404 || status === 400, `${path}: ${status}`);
    assert.ok(!body.includes('"name": "whyline"'), `${path}: leaked a file`);
  }
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);
  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'not found' });
});

test('dashboard keeps the hooks its script depends on', () => {
  const html = read('app.html');
  for (const id of ['msg', 'auth', 'view', 'ws', 'list', 'q', 'export', 'refresh', 'logout', 'create', 'open', 'name', 'key', 'new', 'keybox', 'newkey', 'copykey', 'keydone']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes("'wl_key'"), 'localStorage key');
  assert.ok(!/innerHTML/.test(html), 'no innerHTML');
});

test('no unsupported claims on the site', () => {
  const banned = [/SOC ?2/i, /ISO ?27/i, /free while/i, /\bbeta\b/i, /open[- ]source/i, /pnpm add -g whyline\b/, /trusted by/i, /testimonial/i, /priya@acme/, /#812/];
  for (const file of [...pages, 'site.js']) {
    const text = read(file);
    for (const re of banned) assert.ok(!re.test(text), `${file}: ${re}`);
  }
  server.close();
});
