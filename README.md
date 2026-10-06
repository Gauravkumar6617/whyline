# Whyline

git blame tells you who. Whyline tells you why.

A vendor-neutral record of what AI agents changed in a codebase: which prompt, which files,
which commit, which agent. Live at https://whyline.wrklyst.com.

## Use it

1. Create a workspace at https://whyline.wrklyst.com/app and copy the API key (shown once).
2. Install the CLI and log in:
   ```sh
   pnpm add -g whyline
   whyline login --url https://whyline.wrklyst.com --key wl_...
   ```
3. Capture AI work:
   - **Claude Code** (prompts + every file edit):
     ```
     /plugin marketplace add Gauravkumar6617/whyline
     /plugin install whyline@whyline
     ```
   - **Any agent** (Cursor, Copilot, Codex, ...): run `whyline init` in each repo. Every commit is
     recorded; the agent is detected from `Co-Authored-By:` or `AI-Agent:` trailers.
4. Ask why:
   ```sh
   whyline blame src/orders.ts:42
   # src/orders.ts:42  const amount_cents = Math.round(order.total * 100);
   #   a41f9c2 · claude-code · priya@acme.io · 06/10/2026, 14:02
   #   add orders
   #
   #   Prompt:
   #     store money as integer cents
   ```
   Or use the website timeline (search, Export CSV for audits), or `whyline events`.

- **Offline?** Events queue in `~/.config/whyline/queue.jsonl` and are sent with the next one.
- **Keep prompts private:** `whyline login ... --no-prompts` (or `WHYLINE_NO_PROMPTS=1`) records that a
  prompt happened but never sends its text.
- **How blame links prompts:** Claude Code edits are remembered locally; the next commit that includes
  those files carries the prompts that produced them.

## Deploy (Vercel + Supabase)

1. Supabase SQL editor: run `supabase.sql` (tables are prefixed `whyline_`, safe in a shared project).
2. Vercel: import the repo, no build settings needed (`vercel.json` covers it). Set env vars
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Vercel → Domains: add `whyline.wrklyst.com`. Cloudflare DNS: add `CNAME whyline → cname.vercel-dns.com`,
   proxy off (grey cloud).
4. Check it: `WHYLINE_DB=supabase SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm test`
   runs the test suite against Supabase (creates a few test workspaces).

## Self-host / local dev

```sh
pnpm start           # SQLite at server/whyline.db, PORT=3000
pnpm test
```
Node 22.13 or newer, no dependencies.

## Layout
```
public/                 website: landing (/), app (/app), logo
api/                    Vercel functions -> lib/handle.js + Supabase
lib/handle.js           the API: auth, validation, routes (web Request -> Response)
lib/db-supabase.js      cloud storage (Supabase REST, no client library)
lib/db-sqlite.js        self-hosted storage
server/                 self-hosted server (node:http + SQLite), used by tests
cli/                    `whyline` CLI; every adapter calls it
adapters/claude-code/   Claude Code plugin (hooks -> cli)
.claude-plugin/         marketplace manifest, so the repo installs as a plugin source
supabase.sql            tables for the cloud deploy
```
