# MemBridge — shared memory for AI coding tools

[![CI](https://github.com/mmelika/membridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mmelika/membridge/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

**Sync context between Claude Code, Codex, and any other AI coding agent — automatically.**

MemBridge is a tiny background daemon that gives your AI coding tools a shared,
always-current memory of every project. Ask Claude Code to build a feature, and
the next time you open Codex (or Gemini CLI, Cursor, or any agent) in that
project, it already knows what happened. No cloud, no accounts, no API keys —
everything stays on your machine.

```
Claude Code sessions ─┐                       ┌─> CLAUDE.md   (read by Claude Code)
Codex sessions ───────┼─> brief per-project ──┼─> AGENTS.md   (read by Codex & most agents)
any other tool ───────┘    "shared memory"    └─> GEMINI.md…  (configurable)
```

## Why your AI tools forget each other's work

Every AI coding assistant keeps its own siloed session history. Claude Code
doesn't know what Codex did this morning; Codex has no idea what Claude Code
shipped an hour ago. So you re-explain the same context, tool after tool,
project after project.

But every major tool already reads a per-project context file at startup —
`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex and most agents,
`GEMINI.md` for Gemini CLI — and writes its session transcripts to a known
folder on disk. MemBridge connects the two: it watches the transcripts,
distills a brief per-project memory, and injects it into every context file
inside a clearly-delimited block:

```markdown
<!-- membridge:begin -->
## Shared AI memory (MemBridge)

Recent asks across tools:
- 2026-07-09 10:00 · Claude Code: Build the login page with OAuth
- 2026-07-09 10:06 · Codex: Add unit tests for the login form

Files recently modified by AI tools: src/login.js
<!-- membridge:end -->
```

The rest of your file is never touched, and `membridge remove` strips the
blocks cleanly.

## Per-project memory database and file index

Beyond the brief context block, MemBridge keeps a structured memory database
inside each project at `.membridge/`:

- **`memory.json`** — every AI update as a structured entry: timestamp, which
  tool, what was asked, and exactly which files it touched. It also carries an
  **index of the project's local files** (relative path, size, modified time —
  ignore-aware, so `node_modules`/`.git` never pollute it), which lets one LLM
  point another at the precise files a change refers to.
- **`memory.md`** — the same memory rendered as markdown, readable by humans
  and by any agent that opens the project.

The injected context block links to these files, so a tool that wants more
than the brief summary can follow the reference. Add `.membridge/` to your
project's `.gitignore` if you don't want the memory committed — or commit it
to share AI context with your whole team.

## Session distillation (Claude Code hook)

Harvested summaries (the agent's last chat message) are decent; a summary the
agent writes *on purpose* is better. With one opt-in command, the agent that
did the work distills its own session before it ends:

```bash
membridge setup-hooks
```

This registers a [Stop hook](https://docs.claude.com/en/docs/claude-code/hooks)
in `~/.claude/settings.json`. When a Claude Code session that edited files
tries to stop without having written a summary, the hook blocks the stop once
and asks the agent to append one JSON line to
`<project>/.membridge/summaries.jsonl`:

```json
{"session":"<id>","ts":"<ISO time>","did":"What was accomplished.","decisions":"Key choices.","gotchas":"Surprises."}
```

MemBridge merges these as high-quality `Distilled` summaries that take
precedence over harvested ones everywhere — the context block, `memory.md`,
the Copy-for-AI digest, and team sync (redacted like everything else before
it leaves the machine).

**Consent model.** Nothing is installed automatically: the daemon never
touches `~/.claude/settings.json`; only the explicit `membridge setup-hooks`
does, it appends without disturbing your existing hooks, and
`membridge remove-hooks` strips exactly what it added. The hook itself is
strictly fail-open — any error, a paused/untracked project, a session with
fewer than `distill.minEdits` edits (default 1), or `distill.enabled: false`
in config means Claude Code stops normally, uninterrupted. It never blocks
the same stop twice. `membridge status` shows whether distillation is on and
the hook installed.

**Codex fallback (tiering).** Claude Code is the *enforced* tier — the Stop
hook guarantees the ask. Tools reading `AGENTS.md` (Codex and friends) have
no hook, so they get the *requested* tier: the injected block carries a
standing instruction to append the same summary line on task completion.
Well-behaved agents comply; nothing breaks when they don't — MemBridge just
falls back to the harvested summary.

## The dashboard

`membridge dashboard` opens a local web UI (the menu-bar app shows the same
thing):

- **Projects grid** — every project with AI activity: tool badges, last
  activity, paused state. Click one for its page.
- **Project pages** — the full ask-by-ask activity feed with the files each
  ask touched; a Memory tab showing exactly what gets injected where, with a
  read-only view of the full memory log; pause/resume and delete; and a
  **Copy for AI** button that puts a trimmed, redacted digest on your
  clipboard for pasting into ChatGPT, claude.ai, or any web AI that cannot
  see your disk.
- **Neural map** — a force-directed map of every chat across every project,
  linked by shared files and shared ideas.
- **Settings** — bring-your-own-key, planner model, sync interval and target
  files. No config-file editing required.

## Team sync (beta) — shared memory for your whole team

Solo MemBridge syncs your own AI tools with each other. Team sync extends
that to your teammates: everyone's MemBridge pushes its per-project memory
entries (already redacted) to a shared backend and pulls everyone else's
down, so **your Claude Code knows what your teammate's Codex did an hour
ago** — with attribution:

```markdown
Teammates' AI activity (MemBridge team sync):
- 2026-07-12 09:00 · Andrew · Codex: Refactor checkout validation — files: src/checkout.js
```

The backend ships with MemBridge — there is nothing to install or configure.
Just sign up:

```bash
membridge signup --email you@company.com --password ... --name "Marco"

# one person creates the team and mints an invite link...
membridge team create acme
membridge team invite             # optional: --expires-days 7 --max-uses 5

# ...everyone else joins with one command (creates the account if needed)
membridge join <link-or-token> --email you@co.com --password ...

# inside a project you want to share
membridge team link               # commit .membridge/team.json for teammates
```

From then on the daemon syncs the linked project with your team on its
normal interval. When your clone of a repo a teammate already shares is
detected (same normalized git remote), MemBridge **suggests** the link in the
dashboard — nothing is shared until you confirm (or opt into automatic
linking with `"team": { "autoLink": true }`). `membridge team list` shows
your teams and linked projects; `membridge team unlink` stops sharing;
`membridge team revoke-invite <token>` kills a link you regret sending.

Prefer a browser? The [`web/`](web/README.md) folder is the hosted team
workspace (Next.js + Supabase): invite landings at `/join/<token>`, the team
feed, project stats, and member/role/invite management — teammates can see
who did what without installing anything.

**What leaves your machine (and only for linked projects):** the same
redacted digest entries you see in `.membridge/memory.md` — timestamps, tool
names, redacted asks, relative file paths. Never file contents, never
unlinked projects, and row-level security means only your team's members can
read any of it.

<details>
<summary><b>Running your own backend</b> (self-hosting / operators)</summary>

Team sync talks to a Supabase project. Official builds ship pointed at the
hosted MemBridge backend (baked into [`lib/backend.json`](lib/backend.json)),
so users configure nothing. To run your own instead:

1. Create a [Supabase](https://supabase.com) project (free tier is plenty),
   open its SQL Editor, and run [`supabase/schema.sql`](supabase/schema.sql)
   followed by [`supabase/migrations/002_team_v2.sql`](supabase/migrations/002_team_v2.sql)
   (invite links, roles, the feed the web app uses).
2. Grab the Project URL and `anon` public key from Settings → API. Both are
   safe to publish — the anon key is meant for client apps, and row-level
   security is what protects the data.
3. Either bake them into `lib/backend.json` before building, or point an
   existing install at them per-machine:
   ```bash
   membridge team setup --url https://<ref>.supabase.co --anon-key <anon key>
   ```
</details>

## Roadmaps — the bring-your-own-key upgrade

The free core never talks to any API. Add your own Anthropic API key in
Settings and each project's **Plan tab** becomes a roadmap generator:

- Describe what you want to build next; the estimated cost sits on the
  button before you click (about 1¢ per roadmap with the default model).
- You get a phased plan where **every task names the AI model that should do
  it** — "Everyday — Haiku" up to "Frontier — Fable", plus an independent
  "Cross-check — Codex" — each with a one-line reason and a size. The
  routing philosophy is baked in: start cheap, escalate on failure — never
  the reverse.
- The actual cost, from real usage, is shown afterwards. The plan is saved
  to `.membridge/plan.json`, and one line — `Current roadmap: …` — is
  written into the shared memory block, **so Claude Code and Codex see the
  plan too**.
- What's sent to Anthropic (with your key, only when you click Generate):
  the project's name, your goal, recent asks (already redacted), file paths
  touched, and top-level folder names. Never file contents, never other
  projects.

## Quick start

**macOS menu-bar app:** download `MemBridge-<version>.dmg` from the
[latest release](https://github.com/mmelika/membridge/releases), drag it to
Applications, and launch — a bridge icon appears in your menu bar with
status, dashboard, pause, and start-at-login. (Builds are unsigned for now:
right-click → Open on first launch.)

**CLI daemon** (any OS, Node.js 18+):

```bash
npm install -g membridge

membridge scan       # read-only: see which AI tools and projects it found
membridge start      # run the background daemon
membridge dashboard  # open the local web dashboard
```

Optional: `membridge enable-autostart` launches MemBridge at login
(Startup folder on Windows, launchd on macOS, systemd user unit on Linux —
no admin rights needed). The tray app has its own "Start at login" toggle.

## Supported AI coding tools

| Tool | Support | How |
| --- | --- | --- |
| Claude Code | Built in | Reads `~/.claude/projects` transcripts, writes `CLAUDE.md` |
| Codex (OpenAI) | Built in | Reads `~/.codex/sessions` rollouts, writes `AGENTS.md` |
| Gemini CLI | Custom adapter | Point a config-driven adapter at its logs, add `GEMINI.md` to targets |
| Cursor, opencode, Copilot CLI, … | Custom adapter | Any tool that logs sessions as JSONL works — no code required |

## Commands

| Command | What it does |
| --- | --- |
| `membridge start` / `stop` / `status` | Manage the background daemon |
| `membridge dashboard` | Open the web UI at `http://127.0.0.1:7437` |
| `membridge sync [--dry-run] [--project <path>]` | One sync pass right now |
| `membridge scan` | Read-only report of discovered tools and projects |
| `membridge remove [--project <path>]` | Strip injected memory blocks |
| `membridge enable-autostart` / `disable-autostart` | Run at login |
| `membridge setup-hooks` / `remove-hooks` | Session distillation via the Claude Code Stop hook (see above) |
| `membridge team <setup\|create\|join\|link\|unlink\|list>` | Team sync (see above) |
| `membridge signup` / `login` / `logout` | Team sync account |

## Configuration

`~/.membridge/config.json` (created on first run):

```jsonc
{
  "intervalSec": 60,                     // how often to sync
  "dashboardPort": 7437,
  "targets": ["CLAUDE.md", "AGENTS.md"], // add "GEMINI.md" etc.
  "exclude": ["C:\\work\\secret-project", "*archive*"],
  "redact": ["sk-[A-Za-z0-9_-]{8,}", "..."],  // scrubbed before injection
  "maxPrompts": 8,
  "maxFiles": 10,
  "distill": { "enabled": true, "minEdits": 1 }, // Stop-hook session summaries
  "adapters": {
    "claude-code": { "enabled": true },
    "codex": { "enabled": true },
    "custom": []
  }
}
```

To pause a single project, drop an empty `.membridge-off` file in its root, or
click Pause in the dashboard.

### Connect any other AI tool (custom adapters)

If a tool logs its sessions as JSONL anywhere on disk, wire it up in config —
no code required:

```jsonc
"custom": [{
  "id": "mytool",
  "displayName": "MyTool",
  "dir": "/home/me/.mytool/sessions",
  "fields": {
    "project": "dir",        // dot-path to the project path on each line
    "timestamp": "when",     // dot-path to an ISO timestamp
    "text": "say",           // dot-path to the user's message
    "role": "who",           // optional filter field...
    "roleValue": "user"      // ...and required value
  }
}]
```

Dot-paths work for nested fields (`payload.cwd`). If the project path appears
only once per file (like Codex's `session_meta`), MemBridge carries it forward
automatically.

## Privacy and security

- **100% local by default.** The daemon binds to `127.0.0.1` only; nothing
  leaves your machine unless you opt in. The two optional network paths:
  team sync (only redacted digest entries, only for projects you explicitly
  link) and the roadmap generator (your own Anthropic key, only when you
  click Generate, sending only the redacted digest listed above; the key
  lives in `~/.membridge/config.json`, chmod 600, never in any project
  folder, and is never shown back to the dashboard page). No telemetry.
- **Secrets are redacted** before anything is written into a context file:
  common API-key shapes (`sk-…`, `AKIA…`, `ghp_…`, `key=value`) are scrubbed
  by default, and you can add your own patterns.
- **Transcripts are read-only** (incrementally, by byte offset). The only files
  MemBridge writes are the configured context files — inside its own markers —
  plus its own state in `~/.membridge`.

## FAQ

**Do I need an API key?**
No. Syncing works with zero keys and zero network. An Anthropic API key
(added in Settings) unlocks exactly one optional feature: per-project
roadmaps on the Plan tab, billed to your key at roughly a cent per roadmap.

**How do I make Codex aware of what Claude Code did?**
Install MemBridge and run `membridge start`. It summarizes recent Claude Code
activity into `AGENTS.md`, which Codex reads automatically — and vice versa
into `CLAUDE.md`.

**Does it work with more than two tools?**
Yes. Adapters are pluggable: Claude Code and Codex are built in, and the
config-driven custom adapter connects anything that logs JSONL. All tools share
the same memory.

**Will it mess up my existing CLAUDE.md / AGENTS.md?**
No. MemBridge only ever rewrites the content between its `<!-- membridge -->`
markers. Your own notes are preserved byte-for-byte, and `membridge remove`
restores files exactly.

**How much overhead does it add?**
Near zero: it reads only the bytes appended since the last pass, sleeps between
syncs (60s default), and has zero runtime dependencies.

## Development

```bash
node test/run-tests.js   # zero-dependency end-to-end suite (temp dirs only)
npm run app              # run the tray app from source (Electron)
npm run dist:mac         # build the macOS menu-bar app (dmg + zip)
```

The core stays zero-dependency; Electron is a devDependency used only by the
tray app. CI runs the suite on Linux, Windows, and macOS across Node 18/20/22,
and the "Build app" workflow produces macOS builds on Apple runners.

The suite is fully offline and hermetic: it runs in temp dirs and talks to
mock backends (the advisor honors a `MEMBRIDGE_API_BASE` override; team sync
honors `MEMBRIDGE_TEAM_URL`). To hack
on the dashboard against fake data without touching your real
`~/.membridge`, run the daemon with the `MEMBRIDGE_HOME`,
`MEMBRIDGE_CLAUDE_DIR`, `MEMBRIDGE_CODEX_DIR` and `MEMBRIDGE_PORT` env
overrides pointed at a scratch folder.

Code map: [`lib/scan.js`](lib/scan.js) (adapters → events → sync),
[`lib/digest.js`](lib/digest.js) (memory block + injection),
[`lib/memorydb.js`](lib/memorydb.js) (per-project `.membridge/` DB),
[`lib/graph.js`](lib/graph.js) (neural-map data),
[`lib/advisor.js`](lib/advisor.js) (BYOK roadmaps, raw fetch, zero deps),
[`lib/teamsync.js`](lib/teamsync.js) (team sync, raw fetch against Supabase),
[`lib/server.js`](lib/server.js) (local HTTP API),
[`lib/dashboard.js`](lib/dashboard.js) (the whole web UI, one file, no build
step), [`bin/membridge.js`](bin/membridge.js) (CLI). The working product plan
is [PLAN.md](PLAN.md); recent changes are in [CHANGELOG.md](CHANGELOG.md).

## Roadmap

The working plan lives in [PLAN.md](PLAN.md). Next up:

- Team sync v2: dashboard UI for teams, hosted backend option (SaaS),
  presence ("Andrew's Claude Code is working in src/checkout right now")
- LLM-powered summaries (optional API key): richer memory in fewer lines
- Neural map v2: calmer 2D layout by default, 3D behind a toggle
- Import ChatGPT / claude.ai data exports, and a `membridge mcp` server so
  MCP-capable clients can query project memory live
- First-class adapters for Gemini CLI, Cursor, opencode, Copilot CLI
- Signed + notarized macOS builds

## License

MIT
