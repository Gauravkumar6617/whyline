# Whyline

git blame tells you who. Whyline tells you why.

A vendor-neutral record of what AI agents changed in a codebase: which prompt, which files,
which commit, which agent. Live at https://whyline.wrklyst.com.

## Use it

1. Create a workspace at https://whyline.wrklyst.com/app and copy the API key (shown once).
2. Install the CLI and log in:
   ```sh
   pnpm add -g github:Gauravkumar6617/whyline   # or: npm install -g github:Gauravkumar6617/whyline
   whyline login --url https://whyline.wrklyst.com --key wl_...
   ```
3. Capture AI work:
   - **Claude Code** (prompts + every file edit):
     ```
     /plugin marketplace add Gauravkumar6617/whyline
     /plugin install whyline@whyline
     ```
   - **Cursor, Codex CLI, Gemini CLI** (prompts + edits): add `whyline hook cursor|codex|gemini` to the agent's
     hook file; copy-paste configs are at https://whyline.wrklyst.com/docs#other-agents.
   - **Any agent** (Copilot, Aider, ...): run `whyline init` in each repo (do this for the agents above too). Every
     commit is recorded; the agent comes from edits a connected agent made, or from a `Co-Authored-By:`,
     `AI-Agent:` or `Assisted-by:` trailer.
4. Ask why:
   ```sh
   whyline blame src/orders.ts:2
   # src/orders.ts:2  const amount_cents = Math.round(order.total * 100);
   #   a7394e0b · claude-code · dev@example.com · 10/7/2026, 11:10:20 AM
   #   add orders
   #
   #   Prompt:
   #     store money as integer cents
   ```
   Or use the website timeline (search, Export CSV for audits), or `whyline events`.

- **Offline?** Events queue in `~/.config/whyline/queue.jsonl` (owner-only, like the rest of that directory) and
  are sent with the next one. Each carries an `event_id`, so a retry is never stored twice. If the server rejects
  the API key (401/403), new events are not queued and the error says so; queued ones wait for a valid key.
- **Keep prompts private:** `whyline login ... --no-prompts` (or `WHYLINE_NO_PROMPTS=1`/`true`/`yes`/`on`) records
  that a prompt happened but never sends its text. Logging in again keeps that until `--prompts`.
- **`whyline init`** installs into the hooks directory git uses (`core.hooksPath` included). An existing shell
  hook is kept; any other hook is left untouched and init exits with an error explaining what to add.
- **How blame links prompts:** agent edits are remembered locally; the next commit that includes
  those files carries the prompts that produced them, and amending that commit (within a day) keeps them.

## Deploy (Vercel + Supabase)

1. Supabase SQL editor: run `supabase.sql` (tables are prefixed `whyline_`, safe in a shared project).
   **Upgrading:** run it again *before* deploying new code; it adds the `event_id` column and unique index
   that retries are deduplicated by (safe to re-run).
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
Node 22.13 or newer, no dependencies. Behind a reverse proxy, set `WHYLINE_TRUST_PROXY=1` (the number of
proxies) so the signup limit uses the client address from `X-Forwarded-For`; without it the header is ignored.
Security headers (CSP etc.) live in `vercel.json` and the self-hosted server reuses them; after editing an inline
`<script>`, update its hash there (`pnpm test` fails until you do).

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
