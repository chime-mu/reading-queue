# reading-queue

Local, keyboard-driven viewer for the Reading Compass system in the Logseq/Obsidian
vault (`READING_VAULT`, default `~/Documents/vault`). The scan is the reading; deep reads are rare,
pulled events. See the vault's `CLAUDE.md` and `compass/SPEC.md` for the model.

Links are captured by the "Reading capture" Shortcut into per-device files in the Shortcuts iCloud folder
and turned into `source/` pages by the processor (`/process`, below).

## Local files, not in this repo

No reading data lives here: the vault is a separate private repo. These stay on the machine
and are gitignored:

- `.env`: `READING_VAULT=/path/to/vault` and the like (Bun loads it automatically).
- `deploy/.env`: the mesh address and names for `deploy/compose.yaml` (see `.env.example`).
- `monitor.local.json`: feed and sitemap overrides for watched sources (see
  `monitor.local.example.json`). Without it, those sources are left to the browser.
- `.claude/skills/`: the `/process` and `/monitor` skills, `HANDOFF*.md` and the LaunchAgent plist.

## Run

```
bun start            # port 4321 (what the LaunchAgent runs)
bun run dev          # port 4322 with --watch, for development
bun test             # no vault needed
```

## Processor (`/process` in a Claude Code session here)

Captured links → `source/` pages. The browser reading and the summaries are agent work,
driven by `.claude/skills/process/SKILL.md` (procedure) and `WRITER.md` (style); the exact
parts are `process.ts`:

```
bun process.ts worklist [--limit N] [--out f.json]   # unprocessed captures, oldest first, lnkd.in resolved
bun process.ts lookup <url>                          # page that already holds this URL, if any
bun process.ts check <page.md> ...                   # validate against source/SPEC.md
bun process.ts record rows.json --note "..."         # ledger + run-log rows, commit, push
```

Inputs: `capture-*.txt` in the Shortcuts iCloud folder (`READING_CAPTURE_DIR` to override)
plus legacy `[[quick capture]]` journal lines. The dedup key is the captured URL with
tracking params stripped (`canonicalUrl`). Never writes capture files or journals.
Pages are read in the Playwright browser only — no WebFetch.

Environment overrides: `READING_VAULT`, `READING_APP_DIR`, `READING_PORT`.

## Serving it beyond localhost

The app has no login: being able to reach it is the only credential. It listens on
`READING_HOST` (default `127.0.0.1`), which must never be a public address; use a private
mesh address such as NetBird's. Set `READING_ALLOWED_HOSTS` to every name it is reached
by (e.g. `reading.mesh.example,100.64.0.1`) or it answers 403: `guard.ts` refuses
unknown Host headers and cross-site writes, because any web page open on a device on the
mesh can otherwise talk to it. Serve it over plain `http://` on the mesh and it can be
added to the Home Screen on iOS; there is no service worker, so no offline use.

On a server it runs from `deploy/compose.yaml`, after copying `deploy/.env.example` to
`deploy/.env`. The repo's gitignored `.data/` holds `vault/` (a clone
of the vault), `state/` (undo journal) and `key/` (the vault's deploy key and GitHub's host
key). To ship a change, run `docker compose up -d --build` in `deploy/`.

## Sessions

- **Scan** (daily): one card per inbox item, `s/d/f/q/y/u`, ≤15 items oldest-first.
  Nothing hits disk until the end-of-session review is confirmed with `enter`.
- **Read**: queued items grouped by their compass object; your pull line is the
  headline; finishing requires a one-line yield, filed to the object's Evidence.
- **Review** (monthly ceremony): walk theses/projects `c/x/k`, reassign orphans,
  mint next month's project. The only place compass files are created.
- **Backlog**: chunked scan over amnestied (`dropped` + `closed:`) items. Optional.
- **Library**: search and browse every item. Browsing changes nothing; deciding on an
  item goes through the same review-then-commit step as a scan, logged as task `library`,
  which does not count as an active day for aging.
- **Aging** (staged on home load): unread for >14 active days → dropped; queued >30
  active days without an active project → returned to inbox. Never silent. An
  *active day* is a day with a scan/backlog/read session in `pipeline/run-log.tsv`;
  calendar time doesn't count, so a pause or vacation never wipes the inbox.

## Guide and feedback

The app explains itself: **Guide** on the home screen (`g`) covers how to use it, and **The
model** (`m`) covers why it works this way. When you change how a session behaves, update the
guide in `guideView()`, in `public/app.js`, to match.

**Feedback** (`!`, on nearly every screen) appends your note, with the current screen and item,
to `feedback.jsonl` in `READING_APP_DIR`. It stays on the server and is never committed. See
"Feedback from the app" in `CLAUDE.md` for how an agent works through it.

## Write safety

`writer.ts` never re-serializes YAML: line surgery on exactly the owned fields
(`status`, `pull`, `yield`, `for`, `closed`), compare-and-swap against the session
snapshot, atomic temp-file + rename, conflict-marker quarantine. Undo journal at
`~/.reading-queue/undo.jsonl` allows "undo last session" for 24h. Git integration
is best-effort and never blocks the UI.
