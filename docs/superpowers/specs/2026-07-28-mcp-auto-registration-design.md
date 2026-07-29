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

**Correction (verified 2026-07-29, Task 6):** the reason stated here was wrong.
`claude mcp add -s user` *does* write a root-level `mcpServers` — the key simply
does not exist until a user-scope server is added, which is why probing a
machine with none found nothing. The conclusion still holds for a better reason:
the CLI owns scope semantics (`local` writes under `projects[cwd]`, `user`
writes the root key) and those are exactly the details we would be guessing at.

**MemBridge must not write `~/.claude.json` directly.** Shelling out to
`claude mcp add -s user` is version-proof: whatever the current version expects,
the current version writes.

**Also verified:** `claude mcp add` **refuses an existing name** ("already
exists") rather than updating it. So "already registered? stop" would leave a
registration pointing at a path that no longer runs, forever and invisibly. The
registrar queries with `claude mcp get <name>` — not `list`, which health-checks
by spawning *every* configured server — and does remove+add when the entry is
ours but stale.

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

`~/.cursor/mcp.json` by default, a flat `{ "mcpServers": { ... } }`. Does not
exist on this machine, which is the point: Cursor is not installed, so nothing
should be written for it.

**Treat every path in §3 as a default, not a fact** — see §4.1. These are what
one machine had on one day; users relocate configs and other platforms differ.

## 4. Which agents get registered, and how they are found

**Rule: register with every agent that is actually installed. No opt-in flag.**

Rejected: gating on `config.extraTargets`. That flag governs whether MemBridge
injects a **context file** into a repo — a different question the user answered
for a different reason. Someone can use Cursor daily and never have wanted a
`.cursor/rules/membridge.mdc` written into their repos.

Detection re-runs on every daemon launch, like the existing hook reconcilers.
Install Cursor next month and the next tick registers it.

### 4.1 Discovery: ask an authority, never hardcode a path

**`~/.codex/config.toml` and `~/.cursor/mcp.json` are defaults, not facts.**
Users relocate them, tools ship env vars precisely so they can, Linux has XDG,
and Windows is a different tree entirely. A location that happened to be right
on one machine is not a design.

MemBridge already has the correct pattern for exactly this problem — session
log discovery layers `MEMBRIDGE_CODEX_DIR` / `MEMBRIDGE_CLAUDE_DIR` over
`config.adapters.<agent>.dir` over a default (`lib/util.js`). **MCP config
discovery uses the same layering**, so a user who has already relocated one has
one concept to learn, not two.

Resolution order for every agent, first hit wins:

1. **MemBridge config override** — `config.mcp.<agent>.configPath`. Always wins.
   The escape hatch for anyone whose layout we did not anticipate.
2. **The tool's own documented environment variable** — e.g. `CODEX_HOME` for
   Codex. This is the tool telling us where it lives; prefer it over anything
   we could infer.
3. **Platform-standard location** — XDG (`$XDG_CONFIG_HOME`) on Linux,
   `%APPDATA%` / `%USERPROFILE%` on Windows, `~` on macOS. Not a macOS-shaped
   guess applied to three platforms.
4. **The documented default** — `~/.codex/`, `~/.cursor/`.

### 4.2 Never conjure a config file

If no location resolves, **write nothing**. Creating `~/.codex/config.toml`
because it was absent is actively harmful: the user relocated it, so the tool
will not read what we wrote, and we have littered their home directory with a
file that looks authoritative and does nothing.

An unresolved agent is a **reported outcome** — logged, and shown in
`membridge status` next to hook registration state, with the config key that
would fix it. A user who moved their config can point us at it in one step. A
silent skip teaches them nothing and looks identical to the feature working.

The one exception: an agent whose directory exists but has no MCP config file
yet. There, creating the file is correct — the tool is installed, it simply has
no servers registered.

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

Shelling out is not a new pattern here: MemBridge already spawns `git`
(`lib/teamsync.js` `repoUrl`, `lib/changes.js`), `security` and `powershell`
(`lib/keychain.js`). What is different is that `claude` is another AI tool's
CLI — updated far more often than git, and capable of prompting. Hence the
three constraints below.

#### 5.1.1 Registration happens at install time; the daemon only repairs

**This is the failure mode most likely to ship unnoticed.** A macOS app
launched from Finder inherits roughly `/usr/bin:/bin:/usr/sbin:/sbin`. The
`claude` binary is installed per-user — on the author's machine
`~/.local/bin/claude`, elsewhere under nvm, volta, asdf, homebrew, or a custom
prefix. **MemBridge.app would frequently fail to find it** while the same code
run from a terminal finds it instantly.

That asymmetry is dangerous precisely because it looks like success: whoever
tests from a terminal sees registration work, while packaged-app users silently
get nothing — indistinguishable from the bug this spec exists to fix.

**The fix is to stop doing it in the wrong place.** `install.sh` runs in the
user's own shell, with the user's own PATH, where `claude` resolves without any
searching at all. Primary registration belongs there. The daemon's job shrinks
from "find and register" to "verify and repair", which it can usually do from a
cached answer.

**Resolution order when the daemon genuinely must resolve it**, first hit wins:

1. `config.mcp.claudeBin` — explicit override, always wins.
2. **The path recorded at install time**, if it still exists on disk.
3. **Ask the user's login shell** — `$SHELL -lic 'command -v claude'`. A login
   + interactive shell reads the user's profile and rc files, so it returns the
   real PATH including every version manager's shims. This is asking the
   authority rather than guessing, and it is the standard remedy for
   GUI-launched apps on macOS. Bound it with a timeout: an rc file that is
   chatty or expects a terminal can hang.
4. A short probe list (`~/.local/bin`, homebrew, `/usr/local/bin`) — **last
   resort only**, explicitly acknowledged as incomplete.

Whatever resolves is **cached into config**, so later launches are instant and
re-resolution happens only when the cached path stops existing.

"Not found" is a **first-class, reported outcome** (§4.2): logged and shown in
`membridge status`, naming the config key that fixes it.

#### 5.1.2 No window, on any platform

`spawnSync` runs the child headless on macOS and Linux — no terminal window
appears and the child's output is captured by the parent. On **Windows**, a
console window can flash briefly unless `windowsHide: true` is set.
`lib/keychain.js` already sets it for its PowerShell call; the MCP spawn must
match. A window flashing at every daemon launch would be an unacceptable
regression in a background app.

#### 5.1.3 Never hang

The child gets a **5s timeout**, closed stdin, and its output captured rather
than inherited. If `claude mcp add` ever decides to prompt, it must fail on the
timeout rather than block the launch waiting on input that will never come —
the same defensive stance as `keychain.js`'s `-NonInteractive` flag on
PowerShell.

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
| `claude` binary not found anywhere (§5.1.1) | Skip Claude Code, **log and report in `membridge status`**; still try the others |
| An agent's config relocated, default absent (§4.2) | Write **nothing**; report the miss and the config key that fixes it |
| Login-shell PATH query hangs | Killed by timeout; fall through to the probe list |
| `claude mcp add` hangs | Killed at 5s; logged; launch unaffected |
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

Use `claude mcp add -s user`, or write `~/.claude.json` directly?

Shelling out is not itself novel — MemBridge already spawns `git`, `security`
and `powershell`. The genuine cost is §5.1.1: `claude` will not be on the PATH
of a Finder-launched app, so the CLI route needs its own binary-resolution
logic and a visible "couldn't find it" state. That is real work the direct-write
approach does not need.

Against that, writing the file means guessing a private format that has
**already moved once** — there is no root `mcpServers` in `~/.claude.json` any
more. When that guess breaks, it breaks silently, and the symptom is
indistinguishable from the bug this whole spec exists to fix: an MCP server
nobody is calling.

Recommendation: **take the CLI.** A failure we can see and log beats a failure
that looks like nothing happening. Bound it with a timeout, resolve the binary
explicitly, report when it is missing, and never let its outcome affect the
launch.

Worth disagreeing with before it ships — the honest counter-argument is that
the binary-probing list in §5.1.1 is itself a guess about install locations,
just a different one.

## 11. Testing

- **Detection** — table-driven over fixture home directories: each agent
  present/absent, in every combination; plus a relocated config reachable only
  via `config.mcp.<agent>.configPath`, and one reachable only via the tool's own
  env var, on each of macOS, Linux (XDG) and Windows path shapes.
- **Never conjure** — an agent whose config is relocated and whose default
  location is absent must leave the default location **still absent** and report
  the miss. This is the assertion that stops us littering a user's home.
- **Binary resolution** — the install-time record wins over the login-shell
  query; a stale recorded path (deleted binary) triggers re-resolution; a
  hanging login shell is killed by the timeout and does not block launch.
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
