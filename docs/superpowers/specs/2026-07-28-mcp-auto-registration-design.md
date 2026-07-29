# MCP auto-registration — design

**Date:** 2026-07-28
**Status:** draft, awaiting review
**Supersedes:** the "zero runtime dependencies" property, deliberately (§7)

---

## 1. The problem

MemBridge ships an MCP server exposing six tools — `list_projects`,
`get_project_memory`, `get_recent_activity`, `search_memory`, `why`, `recall`.
**It has never been called once.** Not by Marco, not by anyone.

Two independent causes, either of which alone is fatal:

1. **Nothing registers it.** `install.sh` contains no MCP reference. MemBridge
   already self-registers its Stop and PreToolUse hooks into `settings.json` on
   every launch (`reconcileStopHook`, `reconcileRecallHook` in `lib/hooks.js`),
   but there is no equivalent for MCP. The `membridge mcp` command exists
   (`cmdMcp`, `bin/membridge.js:385`) and nothing tells any agent it is there.
   Verified on the author's machine: all 47 projects in `~/.claude.json` have
   an empty `mcpServers`.

2. **The dependencies are never shipped.** `@modelcontextprotocol/sdk` and
   `zod` are installed `--no-save` by `prepublishOnly` purely so tests can run,
   then discarded. They never reach the published package. `lib/mcp.js:36` says
   so outright — it tells the user they are "opt-in (not installed by a plain
   `npm install`)". So even a user who found the command and wired it by hand
   hits a missing-module error.

The fix for (1) is worthless without (2), and (2) is what forces the
dependency decision.

## 2. What we are trading away

MemBridge has been proud of a zero-dependency core. That property is **already
gone** — the recall layer added `web-tree-sitter` and E2E added
`libsodium-wrappers`, both real runtime `dependencies` today. The claim
survives only in prose.

Making MCP work adds two more. That is accepted deliberately: a working
integration is worth more than a boast, and a tool nobody can invoke has
negative value — it is surface area, documentation and test weight for zero
benefit.

**Consequence:** every "zero dependency" claim in user-facing material must go
(§7). Leaving them is worse than the dependencies themselves, because it makes
the project's own documentation untrustworthy.

## 3. Verified facts about each target

Probed on the author's machine, 2026-07-28. **These differ from what the docs
imply and drive the whole design.**

### 3.1 Claude Code — has a CLI, use it

`claude mcp add` exists with `-s, --scope <local|user|project>`. There is **no
root-level `mcpServers`** in `~/.claude.json`; MCP config is per-project under
`projects[path].mcpServers`, alongside `enabledMcpjsonServers` /
`disabledMcpjsonServers`.

Because the storage shape is an internal detail that has evidently already
moved, **MemBridge must not write `~/.claude.json` directly.** Shelling out to
`claude mcp add -s user` is version-proof: whatever the current version
expects, the current version writes.

### 3.2 Codex — no CLI, file surgery required

`codex` is **not on PATH** on a machine that actively uses Codex. `~/.codex/`
exists and `config.toml` already contains `[mcp_servers.node_repl]`,
`[mcp_servers.node_repl.env]` and `[mcp_servers.computer-use]` — this user
already runs MCP servers under Codex. There is no CLI to delegate to.

The file is TOML with **nested and quoted table keys** — real examples from
this machine include `plugins."github@openai-curated"` and
`projects."/Users/marco/Documents/AI Shit/CopyNigga"`, the latter containing
both a space and slashes.

### 3.3 Cursor — plain JSON, absent here

`~/.cursor/mcp.json`, a flat `{ "mcpServers": { ... } }`. Does not exist on
this machine, which is the point: Cursor is not installed, so nothing should be
written for it.

## 4. Which agents get registered

**Rule: register with every agent that is actually installed, detected by the
presence of its config directory. No opt-in flag.**

| Agent | Detection | Method |
|---|---|---|
| Claude Code | `claude` resolvable on PATH | `claude mcp add -s user` |
| Codex | `~/.codex/` exists | targeted TOML block surgery (§5.2) |
| Cursor | `~/.cursor/` exists | JSON merge (§5.3) |

Rejected: gating on `config.extraTargets`. That flag governs whether MemBridge
injects a **context file** into a repo — a different question the user answered
for a different reason. Someone can use Cursor daily and never have wanted a
`.cursor/rules/membridge.mdc` written into their repos. Presence of the tool's
own config directory is direct evidence they use it; `extraTargets` is not.

Detection re-runs on every daemon launch, like the existing hook reconcilers.
Install Cursor next month and the next tick registers it — no reinstall, no
command to remember.

## 5. Registration mechanics

The command string is built exactly as `lib/hooks.js`'s `hookCommand()` builds
the hook command: absolute `process.execPath`, absolute script path, prefixed
with `ELECTRON_RUN_AS_NODE=1` when running under Electron. Same reasoning — a
bare `membridge` may not be on the agent's PATH, and the app bundle's node is
not the system node.

Server name: `membridge`, everywhere.

### 5.1 Claude Code

Query first, register only if absent:

```
claude mcp list            → already registered? stop.
claude mcp add -s user membridge -- <execPath> <bin/membridge.js> mcp
```

Never parse or write `~/.claude.json`. A non-zero exit is logged and ignored —
this must never break a daemon launch.

### 5.2 Codex — block surgery, not a round trip

**A TOML library is explicitly rejected here**, despite dependencies now being
allowed. A parse-and-restringify rewrites the user's entire file: comments
lost, ordering churned, quoted keys re-quoted at the library's discretion. That
is precisely what MemBridge's hook reconcilers refuse to do to `settings.json`,
and the reasoning transfers unchanged.

Instead, own exactly one block and leave every byte outside it untouched:

- **Absent:** append `[mcp_servers.membridge]` plus its keys at end of file.
- **Present:** replace only the span from the `[mcp_servers.membridge]` header
  to the start of the next top-level table (or EOF).
- **Unparseable / ambiguous:** change nothing, log, move on.

This needs only enough TOML awareness to find a table header at line start and
the next one after it — no value parsing, no rewriting of anything we did not
write.

**Hard requirement:** a test must assert that registering into a fixture
containing `plugins."github@openai-curated"` and
`projects."/Users/marco/Documents/AI Shit/CopyNigga"` leaves both lines
byte-identical. Those exact strings, because they are what real files contain.

### 5.3 Cursor

Read `~/.cursor/mcp.json`, merge one key into `mcpServers`, write atomically
(tmp + rename, as everywhere else). Refuse to write if the file exists and is
not valid JSON, or if `mcpServers` is present but not an object — the same
"refuse rather than clobber" stance `readSettings` already takes.

### 5.4 Ownership, universally

Every format gets an ownership predicate, mirroring `isOwnStopHook` /
`isOwnRecallHook`: an entry is ours only if it is named `membridge` **and** its
command references a MemBridge path. A user's own server that happens to be
called `membridge` is never overwritten, and `remove-hooks` (or a new
`membridge mcp unregister`) strips only what we own.

## 6. Kill switch

`config.mcp.autoRegister === false` disables all registration. Only the literal
`false`, matching `config.recall.enabled` and `isNotesEnabled`. Absent or
malformed config leaves it on.

Registration is also skipped entirely when MemBridge is running from a test
harness (`MEMBRIDGE_HOME` pointing at a temp dir), so the suite can never write
into a developer's real agent configs.

## 7. Dependency and documentation changes

Move to `dependencies`:

```json
"@modelcontextprotocol/sdk": "^1",
"zod": "^4"
```

and drop the `--no-save` install from `prepublishOnly`, which then only runs
tests. `lib/mcp.js`'s "opt-in, not installed by a plain npm install" message
becomes false and must go.

**Every user-facing zero-dependency claim must be corrected**, not quietly
left:

- `docs/guide.md` — three claims (~lines 252, 340, 345)
- `README.md` and the package description, if they carry it
- The website (`mmelika/membridge-site`, served at membridge.app) — including
  `llms.txt` and `llms-full.txt`, which project memory flags as needing an
  update whenever product facts change, and the JSON-LD block

Historical plans and specs under `docs/superpowers/` are **not** edited. They
are records of what was true when written; rewriting them would be falsifying
the archive.

## 8. Failure modes

Same governing rule as every other MemBridge hook path: **every failure
degrades to ordinary behaviour, never to broken work.** Registration is a
convenience; nothing depends on it succeeding.

| Failure | Behaviour |
|---|---|
| `claude` not on PATH | Skip Claude Code; still try the others |
| `claude mcp add` non-zero exit | Log, continue |
| `~/.codex/config.toml` unreadable | Skip Codex, change nothing |
| Codex TOML shape unrecognised | Skip Codex, change nothing |
| `~/.cursor/mcp.json` invalid JSON | Refuse to write, log |
| Any write fails | Log, continue to the next agent |
| MCP deps missing at runtime | `membridge mcp` fails loudly; registration is unaffected |

No failure here may prevent the daemon from starting or the hooks from
reconciling.

## 9. Out of scope

- **Project-scope `.mcp.json`.** Writing into the user's repo, which they must
  then commit or ignore, and which prompts for approval per project. User scope
  first; revisit if teams ask.
- **Gemini, Windsurf, Copilot.** No session adapter, so MemBridge does not
  integrate with them beyond optional context files. Add when an adapter does.
- **Verifying the server is actually invoked.** Registration is necessary but
  not sufficient; whether agents *choose* to call the tools is a separate
  question about tool descriptions, and deserves its own look once calls are
  possible at all.
- **Rewriting historical plan/spec documents** for the dependency change (§7).

## 10. Open question for review

`claude mcp add -s user` is the right call for Claude Code, but it means
MemBridge shells out to another tool's CLI during its own launch. That is a new
kind of coupling — it inherits that CLI's exit codes, latency and prompting
behaviour. The alternative is writing `~/.claude.json` directly, which is
faster and dependency-free but bets on an internal shape that has demonstrably
already moved once.

Recommendation: take the CLI, bound it with a short timeout, and never let its
outcome affect the launch. But it is worth someone disagreeing with before it
ships.

## 11. Testing

- **Detection** — table-driven over fixture home directories: each agent
  present/absent, in every combination.
- **Codex surgery** — the byte-identical assertion from §5.2; plus insert into
  a file with no `mcp_servers` at all; plus replace an existing
  `[mcp_servers.membridge]` followed by another table; plus refuse on garbage.
- **Cursor merge** — new file, existing file with other servers, invalid JSON
  refusal, `mcpServers` present but not an object.
- **Ownership** — a foreign server named `membridge` is never overwritten or
  removed.
- **Kill switch** — `autoRegister: false` writes nothing anywhere.
- **Isolation** — the suite must prove it never touches a real `~/.claude.json`,
  `~/.codex/config.toml` or `~/.cursor/mcp.json`. Everything runs under a
  throwaway home, as the existing suite already does.
