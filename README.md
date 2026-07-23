<p align="center">
  <img src="docs/brand/svg/membridge-mark-blue.svg" width="72" alt="MemBridge">
</p>

<h1 align="center">Your team shares a codebase.<br>Now your AI shares a memory.</h1>

<p align="center">
  <a href="https://github.com/MembridgeAi/membridge/actions/workflows/ci.yml"><img src="https://github.com/MembridgeAi/membridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="node >= 18"></a>
</p>

MemBridge is a menu-bar app and CLI for teams that code with AI. A tiny
local daemon watches the session logs your tools already write, distills
each one into a small per-project memory, and injects it into the context
files every agent reads at startup.

```sh
curl -fsSL https://membridge.me/install.sh | sh
```

<p align="center"><sub><code>local-first · no account · no API keys</code></sub></p>

The one-liner is macOS (Apple Silicon). Everywhere else:
`npm install -g @membridgeai/membridge && membridge start`. Every install option, the
full CLI, configuration, and the FAQ live in **[the guide](docs/guide.md)** —
and this page has an animated twin at
**[docs/readme.html](docs/readme.html)** ([membridge.me](https://membridge.me)).

## One session ends. Every agent remembers.

When Andrew's Codex refactors checkout validation, a redacted digest syncs
to the team. Next time you open the project, your Claude Code already knows.

<img src="docs/readme-sync.svg" width="100%" alt="Animated demo: andrew's Codex session ends and its memory is distilled; a dot carries the digest across the MemBridge tile; your Claude Code answers from project memory: andrew capped retries at 3 with exponential backoff in checkout/validate.ts, two hours ago.">

## Three quiet steps

| 01 · Watch — **Session logs** | 02 · Distill — **Per-project memory** | 03 · Inject — **Context files** |
| --- | --- | --- |
| A tiny local daemon tails the JSONL session logs your tools already write — Claude Code, Codex, Gemini CLI, any JSONL logger. | Each session is distilled into a small per-project memory: decisions made, gotchas found, who owns what. | The memory lands between markers in `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` — read by every tool at startup. |

## A memory block, between markers

MemBridge owns only what sits between its markers. The rest of your file is
never touched.

```markdown
<!-- membridge:begin -->
## Project memory · updated 2h ago
checkout retries cap at 3 with exponential backoff (validate.ts)
payment webhooks replay from stripe-cli in dev — never mocked
e2e tests need POSTGRES_ISOLATION=strict or they flake              ← new
andrew owns the pricing service — ask before touching rate tables   ← new
<!-- membridge:end -->
```

## Small surface, sharp edges

- **Team feed** — a redacted digest syncs to your team — optionally.
  Everything starts local: no cloud, no account, no API keys until you
  join one.
- **Summaries by the agent itself** — session summaries are written by the
  agent that did the work, not reconstructed by a heuristic after the fact.
- **Copy-for-AI digest** — one click copies a compact project digest for
  any chat window that can't read your files.
- **MCP server** — project memory is also exposed over MCP, for tools that
  would rather query than read a file.
- **Custom adapters** — point MemBridge at any tool that logs JSONL with a
  small adapter. If it writes sessions, it can share them.
- **Secret redaction** — keys, tokens and private paths are scrubbed before
  anything leaves your machine.

There's more in **[the guide](docs/guide.md)**: the dashboard tour with
screenshots, session summaries and the Stop hook, team sync and privacy,
self-hosting, BYOK roadmaps, the CLI table, custom adapter config, and
development docs.

---

<p align="center"><sub><code>source-available · free core, zero runtime dependencies · <a href="https://membridge.me">membridge.me</a></code></sub></p>
