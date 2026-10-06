# whyline

Vendor-neutral record of what AI agents changed in a codebase: which prompt, which
files, which commit, which agent.

## Use it

1. Create a workspace on the website and copy the API key (shown once).
2. Install the CLI and log in:
   ```sh
   pnpm add -g whyline
   whyline login --url https://<your-domain> --key wl_...
   ```
3. Capture AI work:
   - **Claude Code** (prompts + every file edit):
     ```
     /plugin marketplace add <github-user>/whyline
     /plugin install whyline@whyline
     ```
   - **Any agent** (Cursor, Copilot, Codex, ...): run `whyline init` in each repo. Every commit is
     recorded; the agent is detected from `Co-Authored-By:` or `AI-Agent:` trailers.
4. See it: the website timeline, or `whyline events`.

Offline? Events queue in `~/.config/whyline/queue.jsonl` and are sent with the next one.

## Run the server

```sh
pnpm start           # PORT=3000, DB_PATH=server/whyline.db
pnpm test
```
Node 22.13 or newer, no dependencies.

## Layout
```
server/                 API + SQLite + web timeline
cli/                    `whyline` CLI; every adapter calls it
adapters/claude-code/   Claude Code plugin (hooks -> cli)
.claude-plugin/         marketplace manifest, so the repo installs as a plugin source
```
