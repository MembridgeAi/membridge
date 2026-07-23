# The MemBridge guide

The full manual: installing, the dashboard, how sync works, session
summaries, team sync and privacy, roadmaps, the CLI, supported tools,
configuration, FAQ, and development. For the short version, start at the
[README](../README.md).

MemBridge is a menu-bar app (and CLI) for teams that code with AI. It gives
you one feed of what everyone's AI coding tools have been doing, and it keeps
the tools themselves in sync: Claude Code, Codex, Gemini CLI and any other
agent can see each other's recent work, across tools and across teammates.

<img src="screenshots/activity-feed.png" alt="The Activity feed: day cards for each person and project, with live sessions marked Working now" width="100%">

When Andrew's Codex refactors checkout validation, you see it in the feed,
and your Claude Code knows about it the next time you open the project.

Three things happen under the hood:

- A local daemon watches the session logs your AI tools already write to
  disk, and distills them into a small per-project memory.
- That memory is injected into the context files every tool already reads at
  startup (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), inside a clearly marked
  block. Your own notes are never touched.
- Optionally, a redacted digest of that memory syncs to your team, so
  everyone's dashboard (and everyone's agents) can see what happened in
  shared projects.

Everything starts local: no cloud, no accounts, no API keys until you decide
to connect a team.

## Install

macOS (Apple Silicon), one command:

```sh
curl -fsSL https://membridge.me/install.sh | sh
```

This installs `MemBridge.app` to `/Applications` and the `membridge` CLI to
`/usr/local/bin` (that step may ask for your password once), verifies the
download's SHA-256, and launches without a Gatekeeper warning. Want to read
it first? `curl -fsSL https://membridge.me/install.sh -o install.sh`.

On Intel Macs, Linux, Windows, or servers, use the CLI instead:

```sh
npm install -g @membridgeai/membridge
membridge scan       # read-only: see which AI tools and projects it found
membridge start      # run the background daemon
membridge dashboard  # open the dashboard at http://127.0.0.1:7437
```

That's the zero-setup core: your own tools start seeing each other's work,
and the dashboard fills with your sessions. No account needed for any of it.

To add your team: click **Invite** in the header (sign up, create the team,
share the invite link), have teammates join and install, then share a project
from its page. Commit the resulting `.membridge/team.json` so teammates'
clones connect too. Terminal folks: `membridge join <link>` does signup and
join in one command.

## The dashboard

The app is four views: Projects, Activity, Team, and Settings.

**Projects** lists what MemBridge is watching, local-only or shared, with a
week of stats per project. **Activity** is the feed above: one card per
person, project, and day, opening with the summary of what got done and
marking sessions that are still running. Filter by person, project, or tool.

Open a project and you get the merged stream: your sessions and your
teammates', interleaved and grouped by day. Each entry leads with the
outcome; the original prompt sits underneath as an `Intent` line.

<img src="screenshots/project-page.png" alt="A project page: your and your teammates' sessions in one stream, each entry leading with what got done" width="100%">

The **Copy for AI** button on a project page puts a trimmed, redacted digest
on your clipboard, for pasting into ChatGPT, claude.ai, or any web AI that
can't see your disk.

**Team** handles members, roles, and invites. Teammates who haven't
installed anything can follow along in the hosted web workspace
([`web/`](../web/README.md), Next.js + Supabase): invite links open at
`/join/<token>`, and the feed, project stats, and member management work
from any browser.

<img src="screenshots/team.png" alt="The Team view: members, roles, and the join code" width="100%">

## How it works

Every AI coding assistant keeps its own siloed session history. Claude Code
doesn't know what Codex did this morning; your Codex has no idea what your
teammate's Claude Code shipped an hour ago.

But every major tool already reads a per-project context file at startup,
and writes its session transcripts to a known folder on disk. MemBridge's
daemon connects the two:

```
Claude Code ─┐                          ┌─> CLAUDE.md   (read by Claude Code)
Codex ───────┼─> per-project shared ────┼─> AGENTS.md   (read by Codex & most agents)
any tool ────┘        memory            └─> GEMINI.md…  (configurable)
                        ⇅
      team sync (opt-in, redacted) — your teammates' MemBridge daemons
```

The injected block looks like this (taken from a real project):

```markdown
<!-- membridge:begin -->
## Shared AI memory (MemBridge)

Recent asks across tools:
- 2026-07-21 16:02 · Claude Code
  Intent: Fix the flaky cart total test
  Did: The cart total test is deterministic now — totals are summed in
  cents, so float order no longer changes the result.
  Changes: src/cart.js · test/cart.test.js
- 2026-07-21 17:34 · Claude Code: Migrate the product images to WebP

Teammates' AI activity (MemBridge team sync):
- 2026-07-21 14:43 · Andrew · Codex: Refactor checkout validation
  Did: Checkout validation runs address and payment checks in a single
  pass, so a bad card no longer hides an address error.

Files recently modified by AI tools: src/cart.js, test/cart.test.js
<!-- membridge:end -->
```

Only the content between the markers is ever rewritten. The **Remove block**
button (or `membridge remove`) strips it cleanly and restores your file
byte-for-byte.

Each project also gets a structured memory database in `.membridge/`:
`memory.json` (every update as a structured entry, plus an ignore-aware index
of the project's files) and `memory.md` (the same memory as readable
markdown). Add `.membridge/` to `.gitignore` if you don't want it committed,
or commit it to share AI context with your whole team.

## Session summaries

A summary harvested from the agent's last chat message is decent; a summary
the agent writes on purpose is better. The app asks once, on first run,
whether to turn this on (Settings toggles it any time; CLI:
`membridge setup-hooks` / `remove-hooks`).

Enabled, it registers a [Stop hook](https://docs.claude.com/en/docs/claude-code/hooks)
in `~/.claude/settings.json`. When a Claude Code session that edited files
tries to stop, the hook blocks the stop once and asks the agent to append
one JSON line to `<project>/.membridge/summaries.jsonl`: what was asked,
what changed, key decisions, surprises. These become Codex summary entries
that take precedence everywhere: the context block, `memory.md`,
the Copy-for-AI digest, and the team feed. The feed your teammates read is
written by the agent that did the work.

Long sessions get checkpoints rather than one shot: the hook re-asks every
few edits (defaults: first summary after 1 edit, then every 4), and the
newest line wins while `memory.md` keeps the full history. The hook is
strictly fail-open: any error, a paused project, or a too-small session
means Claude Code stops normally. Nothing is installed silently, and
turning it off removes exactly what was added.

Codex and other `AGENTS.md` readers have no hook, so the injected block
carries a standing instruction to append the same line on completion.
Well-behaved agents comply; when they don't, MemBridge falls back to the
harvested summary.

## Team sync and privacy

What leaves your machine, and only for projects you explicitly share: the
same redacted digest entries you see in `.membridge/memory.md`. Timestamps,
tool names, redacted asks, relative file paths. Never file contents, never
unshared projects. Row-level security limits every row to your team.

The daemon binds to `127.0.0.1` only. There is no telemetry. The only files
MemBridge writes are the context files (inside its own markers) and its own
state in `~/.membridge`; transcripts are read incrementally and never
modified.

Secrets are redacted before any text leaves a transcript, in every path
(context blocks, memory files, Copy-for-AI, roadmap prompts, team sync).
The built-in patterns cover AWS/GitHub/Google/Slack/Anthropic/OpenAI key
formats, JWTs, PEM blocks, credentials in connection URIs,
`Authorization`/`Bearer` headers, and `password=`/`api_key:` assignments,
plus a Shannon-entropy backstop for high-entropy blobs that match no known
shape. Each match becomes a named `[redacted:<name>]` marker. Add your own
patterns with `redact`/`redactExtra` in config.

Be clear about the limits: regex-and-entropy redaction cannot recognize
every secret shape. It's defense in depth, not permission to paste live
credentials into AI sessions. Use `exclude` or a `.membridge-off` file for
projects that handle sensitive material.

<details>
<summary>Running your own backend (self-hosting)</summary>

Team sync talks to a Supabase project. Official builds ship pointed at the
hosted backend ([`lib/backend.json`](../lib/backend.json)), so users configure
nothing. To run your own:

1. Create a [Supabase](https://supabase.com) project (free tier is plenty),
   and run [`supabase/schema.sql`](../supabase/schema.sql) plus the files in
   [`supabase/migrations/`](../supabase/migrations) in its SQL Editor.
2. Grab the Project URL and `anon` key from Settings → API (both are safe to
   publish; row-level security protects the data).
3. Bake them into `lib/backend.json` before building, or point an install at
   them: `membridge team setup --url https://<ref>.supabase.co --anon-key <key>`
</details>

## Roadmaps (optional, bring your own key)

The free core never calls any API. Add your own Anthropic key in Settings
and each project page grows a roadmap generator: describe what you want to
build, see the estimated cost on the button (about 1¢ with the default
model), and get a phased plan where every task names the AI model suited to
it, from "Everyday — Haiku" up to "Frontier — Fable", with a cross-check
task for a second tool. The plan is saved to `.membridge/plan.json` and one
`Current roadmap:` line joins the shared memory block, so your agents see
the plan too.

What's sent with your key, only when you click Generate: project name, your
goal, recent asks (already redacted), file paths, and top-level folder
names. Never file contents.

## The CLI

The app and the CLI are the same daemon with the same features, so headless
boxes and terminal-first teammates aren't second-class:

| Command | What it does |
| --- | --- |
| `membridge start` / `stop` / `status` | Manage the background daemon |
| `membridge dashboard` | Open the web UI at `http://127.0.0.1:7437` |
| `membridge sync [--dry-run] [--project <path>]` | One sync pass right now |
| `membridge scan` | Read-only report of discovered tools and projects |
| `membridge remove [--project <path>]` | Strip injected memory blocks |
| `membridge enable-autostart` / `disable-autostart` | Run at login |
| `membridge setup-hooks` / `remove-hooks` | Session summary hook |
| `membridge signup` / `login` / `logout` | Team account |
| `membridge join <link-or-code>` | Accept an invite (creates the account if needed) |
| `membridge team create` / `invite` / `revoke-invite` | Create a team, manage invites |
| `membridge team link` / `unlink` / `list` | Share or stop sharing a project |
| `membridge team setup` | Point at a self-hosted backend |
| `membridge mcp` | Read-only MCP server over stdio |

`membridge mcp` exposes the shared memory as read-only MCP tools
(`list_projects`, `get_project_memory`, `get_recent_activity`,
`search_memory`) for Claude Desktop, Cursor, and other MCP clients. Nothing
it exposes can write files or trigger sync, and every field passes through
the same redaction as the context files. The SDK isn't part of the
zero-dependency core, so install it once before first use:
`npm install @modelcontextprotocol/sdk zod`, then point your client at
`{ "command": "membridge", "args": ["mcp"] }`.

## Supported tools

| Tool | Support | How |
| --- | --- | --- |
| Claude Code | Built in | Reads `~/.claude/projects` transcripts, writes `CLAUDE.md` |
| Codex (OpenAI) | Built in | Reads `~/.codex/sessions` rollouts, writes `AGENTS.md` |
| Gemini CLI | Custom adapter | Point an adapter at its logs, add `GEMINI.md` to targets |
| Cursor, opencode, Copilot CLI, … | Custom adapter | Any tool that logs sessions as JSONL, no code required |

A custom adapter is a config entry that tells MemBridge where a tool's JSONL
logs live and which fields hold the project path, timestamp, and message:

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

Dot-paths reach nested fields (`payload.cwd`), and a project path that
appears only once per file (like Codex's `session_meta`) is carried forward
automatically.

## Configuration

Settings covers the common options. Under the hood it's
`~/.membridge/config.json`:

```jsonc
{
  "intervalSec": 60,                     // how often to sync
  "dashboardPort": 7437,
  "targets": ["CLAUDE.md", "AGENTS.md"], // add "GEMINI.md" etc.
  "exclude": ["C:\\work\\secret-project", "*archive*"],
  "redactDefaults": true,                // built-in secret redaction
  "redact": [],                          // your own regexes -> [redacted]
  "redactExtra": [],                     // additive, same syntax
  "maxPrompts": 8,
  "maxFiles": 10,
  "distill": { "enabled": true, "minEdits": 1, "checkpointEvery": 4 },
  "adapters": {
    "claude-code": { "enabled": true },
    "codex": { "enabled": true },
    "custom": []
  }
}
```

To pause a single project, click Pause in the dashboard, or drop an empty
`.membridge-off` file in its root.

## FAQ

**Do I need the terminal?** No. Installing, creating a team, inviting,
sharing projects, and every setting are in the UI. The CLI exists for
Linux, headless machines, and people who prefer it.

**Do I need an account or API key?** Only for the team layer (account) and
roadmaps (your own Anthropic key). Syncing your own tools with each other
needs neither, and never touches the network.

**Will it mess up my existing CLAUDE.md / AGENTS.md?** No. Only the content
between the `<!-- membridge -->` markers is rewritten, and removing the
block restores your file exactly.

**Does my whole team need it installed?** Everyone whose AI activity should
sync runs MemBridge. People who just want to watch can use the web
workspace from a browser.

**How much overhead does it add?** Near zero. It reads only the bytes
appended since the last pass, sleeps between syncs (60s default), and the
core has zero runtime dependencies.

## Development

```bash
node test/run-tests.js   # zero-dependency offline suite (temp dirs + mock Supabase)
npm run app              # run the tray app from source (Electron)
npm run dist:mac         # build the macOS menu-bar app
```

The core stays zero-dependency; Electron is a devDependency used only by
the tray app. CI runs the suite on Linux, Windows, and macOS across Node
18/20/22.

The suite is fully offline: it runs in temp dirs and talks to mock backends
(`MEMBRIDGE_API_BASE`, `MEMBRIDGE_TEAM_URL`). To hack on the dashboard
against fake data without touching your real `~/.membridge`, use the
`MEMBRIDGE_HOME`, `MEMBRIDGE_CLAUDE_DIR`, `MEMBRIDGE_CODEX_DIR`, and
`MEMBRIDGE_PORT` env overrides — or run `node scripts/readme-demo.js`,
which builds a two-user demo team on port 7541 (it's how the screenshots
in this guide were made).

Code map: [`lib/scan.js`](../lib/scan.js) (adapters → events → sync),
[`lib/digest.js`](../lib/digest.js) (memory block + injection),
[`lib/memorydb.js`](../lib/memorydb.js) (per-project `.membridge/` DB),
[`lib/redact.js`](../lib/redact.js) (redaction pipeline),
[`lib/hooks.js`](../lib/hooks.js) + [`lib/consent.js`](../lib/consent.js)
(summary hook + consent),
[`lib/feed.js`](../lib/feed.js) (merge local + team activity),
[`lib/advisor.js`](../lib/advisor.js) (BYOK roadmaps),
[`lib/teamsync.js`](../lib/teamsync.js) (team sync against Supabase),
[`lib/server.js`](../lib/server.js) (local HTTP API),
[`lib/dashboard.js`](../lib/dashboard.js) +
[`lib/dashboard-team.js`](../lib/dashboard-team.js) (the web UI, no build step),
[`bin/membridge.js`](../bin/membridge.js) (CLI),
[`web/`](../web/README.md) (hosted team workspace, Next.js).
The working plan is [PLAN.md](../PLAN.md); recent changes are in
[CHANGELOG.md](../CHANGELOG.md).

## Roadmap

Next up, in rough order:

- Presence ("Andrew's Claude Code is working in src/checkout right now")
- Web workspace parity with the desktop dashboard's team features
- LLM-powered summaries (optional API key)
- Import ChatGPT / claude.ai data exports
- First-class adapters for Gemini CLI, Cursor, opencode, Copilot CLI
- Signed + notarized macOS builds

## License

Source-available under the Functional Source License (FSL-1.1-ALv2); converts to Apache-2.0 two years after each release.
