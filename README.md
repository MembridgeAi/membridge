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

## Quick start

Requires Node.js 18+.

```bash
npm install -g membridge

membridge scan       # read-only: see which AI tools and projects it found
membridge start      # run the background daemon
membridge dashboard  # open the local web dashboard
```

Optional: `membridge enable-autostart` launches MemBridge at login
(Startup folder on Windows, launchd on macOS, systemd user unit on Linux —
no admin rights needed).

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

- **100% local.** The daemon binds to `127.0.0.1` only; nothing ever leaves
  your machine. No telemetry, no accounts.
- **Secrets are redacted** before anything is written into a context file:
  common API-key shapes (`sk-…`, `AKIA…`, `ghp_…`, `key=value`) are scrubbed
  by default, and you can add your own patterns.
- **Transcripts are read-only** (incrementally, by byte offset). The only files
  MemBridge writes are the configured context files — inside its own markers —
  plus its own state in `~/.membridge`.

## FAQ

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
```

CI runs the suite on Linux, Windows, and macOS across Node 18/20/22.

## Roadmap

- LLM-powered summaries (optional API key): richer memory in fewer lines
- First-class adapters for Gemini CLI, Cursor, opencode, Copilot CLI
- Team sync: share project memory across machines
- System tray app

## License

MIT
