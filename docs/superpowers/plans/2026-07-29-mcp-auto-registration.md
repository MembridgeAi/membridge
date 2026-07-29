# MCP Auto-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MemBridge's MCP server actually usable — ship its dependencies, and register it with every AI agent the user actually has installed, without ever clobbering or inventing their config.

**Architecture:** Four small, independently testable modules — config-path discovery, TOML block surgery, JSON merge, binary resolution — composed by one registrar. Primary registration happens in `install.sh`, which runs in the user's own shell where everything resolves; the daemon reconciles on launch as repair, exactly as it already does for hooks.

**Tech Stack:** Node.js (CommonJS), the repo's offline test runner (`node test/run-tests.js`).

**Spec:** `docs/superpowers/specs/2026-07-28-mcp-auto-registration-design.md` — read §3 (verified facts), §4 (discovery), §5 (mechanics) before starting any task.

## Why this exists

MemBridge's MCP server exposes six tools and **has never been called once**, for two independent reasons: nothing registers it anywhere, and its dependencies are installed `--no-save` at publish time so they never ship. Either alone is fatal.

## Global Constraints

Every task's requirements implicitly include this section.

- **Never clobber a user's config.** Every format gets an ownership predicate; an entry is ours only if it is named `membridge` **and** its command references a MemBridge path. This mirrors `isOwnStopHook` / `isOwnRecallHook` in `lib/hooks.js`.
- **Never conjure a config file.** If an agent's config cannot be resolved, write **nothing** and report it. Creating `~/.codex/config.toml` for someone who relocated theirs leaves a file the tool never reads. The one exception: an agent whose directory exists but has no MCP config yet.
- **Fail open.** No failure here may prevent the daemon starting or the hooks reconciling. Registration is a convenience.
- **Never silently skip.** An unresolvable agent is a *reported* outcome — logged and surfaced in `membridge status` with the config key that fixes it. A silent skip is indistinguishable from the feature working.
- **His machine is evidence, not the spec.** Paths that were right on one Mac are defaults, not facts. Cover Linux (XDG) and Windows.
- **No test may touch the real `~/.claude.json`, `~/.codex/config.toml` or `~/.cursor/mcp.json`**, or the network. Everything runs under a throwaway home, as `test/run-tests.js` already does.
- **Atomic writes only:** serialize, write a temp file in the same directory, rename. Matches `lib/util.js` `saveState`, `lib/ledger-store.js` `writeLedger`, `lib/recall-store.js` `put`.
- **Server name is `membridge`**, everywhere.
- **Tests go INSIDE `main()`, immediately before the `// --- summary ---` block** — never at the end of the file. The whole suite lives inside `async function main()`, whose summary block prints the count, `fs.rmSync(ROOT)`s the fixture root and may `process.exit(1)`. Appending after it puts your checks out of scope, after the fixtures are deleted and after the count was printed. "Append to `test/run-tests.js`" below always means this insertion point.
- **Verify your `node_modules` before trusting a baseline.** `test/run-tests.js` requires the MCP SDK at top level, so a worktree missing it dies instantly with a friendly message and NO baseline at all. Check with `node -e "require('@modelcontextprotocol/sdk/server/mcp.js');require('zod');console.log('deps ok')"` before your first run. If it fails, give your worktree its own `node_modules` (copy a sibling's) rather than running `npm install` in the shared main tree — those packages are `--no-save` there and a plain install PRUNES them along with the demo pipeline's `playwright-core`. That has already happened once.
- **Use `grep -a`, never plain `grep`,** on plan files and suite output. Some files here carry a non-UTF8 byte; plain `grep` treats them as binary and reports **zero matches**, which reads exactly like "nothing found". This has already misled one agent.

## Task Independence

Tasks 1–5 touch disjoint files and can run fully in parallel. Task 6 composes 2–5. Task 7 wires 6 into the product.

| Task | Creates / modifies | Depends on |
|---|---|---|
| 1 Ship the dependencies | `package.json`, `lib/mcp.js`, `docs/guide.md` | — |
| 2 Config discovery | `lib/agent-config.js` | — |
| 3 Codex TOML surgery | `lib/mcp-toml.js` | — |
| 4 JSON merge | `lib/mcp-json.js` | — |
| 5 Claude binary resolution | `lib/claude-bin.js` | — |
| 6 The registrar | `lib/mcp-register.js` | 2, 3, 4, 5 |
| 7 Wiring | `install.sh`, `bin/membridge.js`, `lib/server.js` | 6 |

All tasks append tests to `test/run-tests.js`; parallel branches will conflict
there. **Do not resolve by concatenating the conflict hunks** — git's regions cut
across block boundaries and `OURS + THEIRS` can leave a block unclosed
(observed). Take `--ours`, then splice the incoming `// ---- <name> ----` blocks
in before the summary, and parse the result before trusting it. Note this carries
NEW blocks only: an **in-place rewrite** of an existing check is invisible to it
and must be carried by hand (Task 1 hit exactly this).

**They do not run in parallel at the test level.** `test/run-tests.js` binds
hardcoded ports (17944/17945/17949/17951/17959…) with no listen-retry, so
concurrent sibling suites crash each other with `EADDRINUSE` — producing **no
baseline at all**, not a visible failure. Independently reproduced on a pristine
tree: three of three runs crashed. Treat "the whole suite is green" as a claim
needing a clean run, and check any log for `EADDRINUSE` before believing a
baseline.

---

## Task 1: Ship the MCP dependencies ✅ DONE (`8993529`, merged)

**Four things this task's text missed, all fixed in the shipped commit:**

- **It breaks a pre-existing test and never says so.** A check asserted the exact
  text of `MISSING_DEPS_MESSAGE`; Step 4 deletes that constant, so the check
  throws on an undefined export. Rewritten in place to the new contract.
- **Step 5's own grep misses a claim it asks you to fix** — a fourth
  zero-dependency line in `docs/guide.md` that the supplied pattern does not match.
- **CI silently defeated the new test.** Four workflow call sites ran
  `npm install --no-save @modelcontextprotocol/sdk zod`, with comments asserting
  the packages are "deliberately opt-in". Left in place, CI would stay green even
  if someone dropped the dependency again — exactly the regression the test
  exists to catch. Removed; `npm ci --omit=dev` now proves it on three platforms.
- **`membridge help` carried the most harmful claim of all**, telling users to run
  an install that is now wrong. The spec's §7 list omitted it.

**Known-weak check:** `mcp-deps: they resolve from a plain install` passes
vacuously — `require.resolve` only proves something is on disk in this tree, not
that `package.json` declares it. Replace it with a **lockfile** assertion (root
prod deps, non-dev, resolved entry present) if you want a local guard with teeth;
the CI change is what actually protects this now.

**Bonus worth knowing before Task 7:** `scripts/prepare-app.js` copies the
`dependencies` closure into `app/node_modules`, so the packaged Electron app now
bundles the SDK — it previously could not have run the MCP server at all.


**Files:**
- Modify: `package.json`, `lib/mcp.js`, `docs/guide.md`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `membridge mcp` after a plain `npm install`. No new exports.

- [ ] **Step 1: Write the failing test**

Append to `test/run-tests.js`, immediately before the results tally:

```js
// ---- MCP dependencies ship by default (mcp spec §7) ----
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  check('mcp-deps: the SDK and zod are real dependencies, not opt-in', () => {
    assert.ok(pkg.dependencies['@modelcontextprotocol/sdk'], '@modelcontextprotocol/sdk must be a dependency');
    assert.ok(pkg.dependencies.zod, 'zod must be a dependency');
  });

  check('mcp-deps: prepublishOnly no longer side-installs them', () => {
    const pre = pkg.scripts.prepublishOnly || '';
    assert.ok(!/modelcontextprotocol/.test(pre), 'prepublishOnly must not --no-save install the SDK');
    assert.ok(!/\bzod\b/.test(pre), 'prepublishOnly must not --no-save install zod');
  });

  check('mcp-deps: they resolve from a plain install', () => {
    assert.doesNotThrow(() => require.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
    assert.doesNotThrow(() => require.resolve('zod'));
  });

  check('mcp-deps: lib/mcp.js no longer calls them opt-in', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp.js'), 'utf8');
    assert.ok(!/opt-in/i.test(src), 'the opt-in message is now false and must be gone');
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep -a "mcp-deps:"`

Expected: `mcp-deps: the SDK and zod are real dependencies` and `prepublishOnly no longer side-installs them` and `no longer calls them opt-in` all `FAIL`. (`they resolve` may already pass if a previous `npm install` left them present — that is fine and is exactly why the other three exist.)

- [ ] **Step 3: Move the dependencies**

In `package.json`, add to `dependencies` (keeping the existing entries):

```json
    "@modelcontextprotocol/sdk": "^1",
    "zod": "^4"
```

and change `prepublishOnly` to just run the tests:

```json
    "prepublishOnly": "npm test",
```

Then install so the lockfile and tree match:

```bash
npm install --no-audit --no-fund
```

- [ ] **Step 4: Delete the opt-in message**

In `lib/mcp.js`, remove the `MISSING_DEPS_MESSAGE` constant and whatever branch prints it. The dependencies are now guaranteed present; a genuine load failure should surface as an ordinary error rather than advice to run an install that already happened.

Verify nothing still references it:

```bash
grep -an "MISSING_DEPS_MESSAGE\|opt-in" lib/mcp.js
```

Expected: no output.

- [ ] **Step 5: Correct the zero-dependency claims**

`docs/guide.md` carries three (near lines 252, 340, 345). Rewrite them to be true — the core has runtime dependencies now (`libsodium-wrappers`, `web-tree-sitter`, and these two). Say what is actually true: the **test suite** is dependency-free and offline.

```bash
grep -an "zero-dependency\|zero dependency\|no depend" docs/guide.md README.md
```

Fix every user-facing hit. **Do NOT edit anything under `docs/superpowers/`** — those are dated records of what was true when written; rewriting them falsifies the archive.

- [ ] **Step 6: Run the tests**

Run: `node test/run-tests.js 2>&1 | grep -a "mcp-deps:"`

Expected: four `ok` lines.

- [ ] **Step 7: Run the whole suite**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: your measured baseline plus 4, zero failures.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/mcp.js docs/guide.md test/run-tests.js
git commit -m "feat(mcp): ship the MCP dependencies instead of calling them opt-in"
```

---

## Task 2: Agent config discovery

Resolves **where** each agent keeps its MCP config, by asking authorities rather than hardcoding one machine's layout. Spec §4.1.

**Files:**
- Create: `lib/agent-config.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `lib/util.js` (`getConfig`, `homeDir`).
- Produces:
  - `AGENTS` — `['claude-code', 'codex', 'cursor']`
  - `resolveAgentConfig(agent, opts) -> { agent, dir, file, source, exists } | null`
    - `source` is one of `'config'`, `'env'`, `'xdg'`, `'default'` — which authority answered.
    - `exists` is whether the **directory** exists (the tool is installed).
    - `null` when the agent is unknown.
  - `installedAgents(opts) -> [resolved]` — only those whose directory exists.
  - `opts` is `{ config, env, home }`, all injectable so tests never read the real environment.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- MCP agent config discovery (mcp spec §4.1) ----
const agentConfig = require('../lib/agent-config');

{
  const acRoot = path.join(ROOT, 'agentcfg');
  const mkHome = name => {
    const h = path.join(acRoot, name);
    fs.mkdirSync(h, { recursive: true });
    return h;
  };

  check('agent-config: default locations under a bare home', () => {
    const home = mkHome('bare');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const r = agentConfig.resolveAgentConfig('codex', { home, env: {}, config: {} });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.file, path.join(home, '.codex', 'config.toml'));
    assert.strictEqual(r.exists, true);
  });

  check('agent-config: a missing agent directory reports exists:false, not null', () => {
    const home = mkHome('empty');
    const r = agentConfig.resolveAgentConfig('cursor', { home, env: {}, config: {} });
    assert.ok(r, 'must still resolve a candidate path');
    assert.strictEqual(r.exists, false);
  });

  check('agent-config: the tool\'s own env var beats the default', () => {
    const home = mkHome('envvar');
    const moved = path.join(acRoot, 'moved-codex');
    fs.mkdirSync(moved, { recursive: true });
    const r = agentConfig.resolveAgentConfig('codex', { home, env: { CODEX_HOME: moved }, config: {} });
    assert.strictEqual(r.source, 'env');
    assert.strictEqual(r.dir, moved);
    assert.strictEqual(r.exists, true);
  });

  check('agent-config: MemBridge config override beats everything', () => {
    const home = mkHome('override');
    const custom = path.join(acRoot, 'custom', 'my.toml');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    const r = agentConfig.resolveAgentConfig('codex', {
      home, env: { CODEX_HOME: path.join(acRoot, 'moved-codex') },
      config: { mcp: { codex: { configPath: custom } } },
    });
    assert.strictEqual(r.source, 'config');
    assert.strictEqual(r.file, custom);
  });

  check('agent-config: XDG_CONFIG_HOME is honoured on linux', () => {
    const home = mkHome('xdg');
    const xdg = path.join(acRoot, 'xdgroot');
    fs.mkdirSync(path.join(xdg, 'cursor'), { recursive: true });
    const r = agentConfig.resolveAgentConfig('cursor', {
      home, env: { XDG_CONFIG_HOME: xdg }, config: {}, platform: 'linux',
    });
    assert.strictEqual(r.source, 'xdg');
    assert.strictEqual(r.dir, path.join(xdg, 'cursor'));
  });

  check('agent-config: XDG is ignored on darwin (it is not the convention there)', () => {
    const home = mkHome('xdgmac');
    const xdg = path.join(acRoot, 'xdgroot');
    const r = agentConfig.resolveAgentConfig('cursor', {
      home, env: { XDG_CONFIG_HOME: xdg }, config: {}, platform: 'darwin',
    });
    assert.strictEqual(r.source, 'default');
    assert.strictEqual(r.dir, path.join(home, '.cursor'));
  });

  check('agent-config: installedAgents lists only agents whose dir exists', () => {
    const home = mkHome('mixed');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const list = agentConfig.installedAgents({ home, env: {}, config: {}, platform: 'darwin' });
    const names = list.map(a => a.agent).sort();
    assert.deepStrictEqual(names, ['codex']);
  });

  check('agent-config: an unknown agent is null, never a guessed path', () => {
    assert.strictEqual(agentConfig.resolveAgentConfig('nonesuch', { home: mkHome('u'), env: {}, config: {} }), null);
  });

  check('agent-config: every known agent resolves to a file, never a bare dir', () => {
    const home = mkHome('all');
    for (const a of agentConfig.AGENTS) {
      const r = agentConfig.resolveAgentConfig(a, { home, env: {}, config: {}, platform: 'darwin' });
      assert.ok(r && r.file && path.isAbsolute(r.file), `${a} must resolve an absolute file path`);
    }
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: the run **aborts** with `Cannot find module '../lib/agent-config'` and exit 1. It does NOT print per-check `FAIL` lines — a missing top-level `require` throws before any check registers. Confirm the module name in the error, then continue.

- [ ] **Step 3: Write the implementation**

Create `lib/agent-config.js`:

```js
'use strict';
// WHERE each agent keeps its MCP config.
//
// GOVERNING RULE (mcp spec §4.1): ask an authority, never hardcode one
// machine's layout. `~/.codex/config.toml` and `~/.cursor/mcp.json` are
// DEFAULTS, not facts -- users relocate them, tools ship env vars precisely so
// they can, Linux has XDG and Windows is a different tree entirely.
//
// This mirrors how lib/util.js already layers session-log discovery
// (MEMBRIDGE_CODEX_DIR over config.adapters.<agent>.dir over a default), so a
// user who has relocated one has a single concept to learn.
//
// Everything is injectable (`opts.home`, `opts.env`, `opts.config`,
// `opts.platform`) so tests never read a real home directory. That is not a
// convenience -- writing into a developer's real ~/.codex from a test run
// would be unforgivable.
const fs = require('fs');
const path = require('path');
const util = require('./util');

// dirName: the agent's config directory, relative to home.
// file:    the MCP config file inside it.
// envVar:  the tool's OWN documented variable pointing at its config dir.
// xdg:     the subdirectory under $XDG_CONFIG_HOME on linux, or null if the
//          tool does not follow XDG.
const SPECS = {
  'claude-code': { dirName: '.claude', file: 'claude.json', envVar: 'CLAUDE_CONFIG_DIR', xdg: null },
  codex: { dirName: '.codex', file: 'config.toml', envVar: 'CODEX_HOME', xdg: 'codex' },
  cursor: { dirName: '.cursor', file: 'mcp.json', envVar: 'CURSOR_CONFIG_DIR', xdg: 'cursor' },
};

const AGENTS = Object.keys(SPECS);

const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

// Resolution order, first hit wins. `source` records WHICH authority answered,
// so `membridge status` can tell the user why we looked where we looked.
function resolveAgentConfig(agent, opts = {}) {
  const spec = SPECS[agent];
  if (!spec) return null; // unknown agent: no path is better than a guessed one

  const env = opts.env || process.env;
  const config = opts.config || util.getConfig();
  const home = opts.home || util.homeDir();
  const platform = opts.platform || process.platform;

  // 1. MemBridge config override -- the escape hatch for layouts we did not
  //    anticipate. Points at the FILE, not the directory, since a user who
  //    moved things may not have kept the filename either.
  const override = config && config.mcp && config.mcp[agent] && config.mcp[agent].configPath;
  if (override) {
    return { agent, dir: path.dirname(override), file: override, source: 'config', exists: exists(path.dirname(override)) };
  }

  // 2. The tool's own environment variable -- the tool telling us where it
  //    lives. Always beats anything we could infer.
  const fromEnv = spec.envVar && env[spec.envVar];
  if (fromEnv) {
    return { agent, dir: fromEnv, file: path.join(fromEnv, spec.file), source: 'env', exists: exists(fromEnv) };
  }

  // 3. XDG, on linux only. macOS does not use it by convention and Windows has
  //    its own tree; applying a linux-shaped guess to three platforms is the
  //    mistake this whole module exists to avoid.
  if (platform === 'linux' && spec.xdg && env.XDG_CONFIG_HOME) {
    const dir = path.join(env.XDG_CONFIG_HOME, spec.xdg);
    return { agent, dir, file: path.join(dir, spec.file), source: 'xdg', exists: exists(dir) };
  }

  // 4. The documented default.
  const dir = path.join(home, spec.dirName);
  return { agent, dir, file: path.join(dir, spec.file), source: 'default', exists: exists(dir) };
}

// Only agents whose config DIRECTORY exists -- direct evidence the tool is
// installed. Absence is not an error and not a guess: it simply means there is
// nothing to register with.
function installedAgents(opts = {}) {
  return AGENTS.map(a => resolveAgentConfig(a, opts)).filter(r => r && r.exists);
}

module.exports = { AGENTS, SPECS, resolveAgentConfig, installedAgents };
```

- [ ] **Step 4: Run the tests**

Run: `node test/run-tests.js 2>&1 | grep -a "agent-config:"`

Expected: nine `ok` lines.

**If `CLAUDE_CONFIG_DIR` or `CURSOR_CONFIG_DIR` turn out not to be real variables those tools honour, say so in your report** rather than leaving a fabricated env var in the table. An invented authority is worse than no authority. The Codex one (`CODEX_HOME`) is documented; verify the other two before trusting them, and if unverifiable, set `envVar: null` and note it.

- [ ] **Step 5: Run the whole suite and commit**

```bash
node test/run-tests.js 2>&1 | tail -5
git add lib/agent-config.js test/run-tests.js
git commit -m "feat(mcp): resolve each agent's config by authority, never a hardcoded path"
```

---

## Task 3: Codex TOML block surgery ✅ DONE (`9466822`, merged)

**The implementation printed below was BROKEN in two ways. Both are fixed in the
shipped module; read `lib/mcp-toml.js` rather than the sketch here.**

1. **CRLF — data corruption on Windows.** `split('\n')` leaves a trailing `\r`
   on every line, and the header regex could not match `[mcp_servers.membridge]\r`.
   On any Windows config `findBlock` returned `null`, `upsertBlock` took the
   append path, and we wrote a **second** `[mcp_servers.membridge]` — a duplicate
   table is a TOML parse error, so we would break the very file we were
   registering into, and grow it on every run. Windows is explicitly in scope.
2. **`.replace(/\n{3,}/g, '\n\n')` violated the module's entire purpose.** It ran
   over the whole result, so a user's double blank line anywhere in the file got
   silently reflowed and `changed` went true on a no-op. That is precisely the
   whole-file churn this module rejects a TOML library to avoid, hand-rolled.
   Removed; `findBlock`'s span already swallows the blank lines after our header.

**Three of the plan's own nine checks survive total input loss** (the
idempotence, end-of-file and empty-input cases only assert our own bytes are
present). The mutation step is what exposed that — do not skip it.

Seven checks were added beyond the plan, the load-bearing ones being CRLF
replace-in-place, blank-line runs elsewhere surviving byte-identically, and a
next-header carrying a trailing comment (a header we fail to *recognise* is
swallowed into our span and **deleted** — a data-loss class with no test
otherwise).


**Files:**
- Create: `lib/mcp-toml.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing. Pure string in, string out — no fs, no clock.
- Produces:
  - `upsertBlock(tomlText, tableName, lines) -> { text, changed }`
  - `findBlock(tomlText, tableName) -> { start, end } | null`
  - `removeBlock(tomlText, tableName) -> { text, changed }`

**Why not a TOML library:** parse-and-restringify rewrites the user's entire file — comments lost, ordering churned, quoted keys re-quoted at the library's discretion. Real config files contain keys like `plugins."github@openai-curated"` and `projects."/Users/marco/Documents/AI Shit/CopyNigga"`. MemBridge's hook reconcilers already refuse to rewrite `settings.json` wholesale; the reasoning transfers unchanged. Own one block, leave every other byte alone.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- Codex TOML block surgery (mcp spec §5.2) ----
const mcpToml = require('../lib/mcp-toml');

{
  // A fixture with the shapes that actually break naive parsers.
  const REAL = [
    '# my codex config',
    '[plugins."github@openai-curated"]',
    'enabled = true',
    '',
    '[projects."/Users/marco/Documents/AI Shit/CopyNigga"]',
    'trust = "full"',
    '',
    '[mcp_servers.node_repl]',
    'command = "node"',
    '',
    '[mcp_servers.node_repl.env]',
    'FOO = "bar"',
    '',
  ].join('\n');

  const BLOCK = ['command = "/usr/bin/node"', 'args = ["/opt/membridge/bin/membridge.js", "mcp"]'];

  check('mcp-toml: appends a new block and leaves every other byte alone', () => {
    const { text, changed } = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK);
    assert.strictEqual(changed, true);
    assert.ok(text.startsWith(REAL), 'existing content must be a byte-identical prefix');
    assert.ok(text.includes('[mcp_servers.membridge]'));
    assert.ok(text.includes('args = ["/opt/membridge/bin/membridge.js", "mcp"]'));
  });

  check('mcp-toml: quoted keys with spaces, slashes and @ survive verbatim', () => {
    const { text } = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK);
    assert.ok(text.includes('[plugins."github@openai-curated"]'), 'the @ key must be untouched');
    assert.ok(text.includes('[projects."/Users/marco/Documents/AI Shit/CopyNigga"]'), 'the spaced path key must be untouched');
    assert.ok(text.includes('# my codex config'), 'comments must survive');
  });

  check('mcp-toml: replaces only our block, keeping neighbours', () => {
    const once = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK).text;
    const twice = mcpToml.upsertBlock(once, 'mcp_servers.membridge', ['command = "/new/node"']);
    assert.strictEqual(twice.changed, true);
    assert.strictEqual((twice.text.match(/\[mcp_servers\.membridge\]/g) || []).length, 1, 'exactly one block');
    assert.ok(twice.text.includes('command = "/new/node"'));
    assert.ok(!twice.text.includes('/usr/bin/node'), 'the old body must be gone');
    assert.ok(twice.text.includes('[mcp_servers.node_repl]'), 'the neighbouring server must survive');
    assert.ok(twice.text.includes('FOO = "bar"'), 'its sub-table must survive');
  });

  check('mcp-toml: re-running with identical content reports changed:false', () => {
    const once = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK).text;
    const again = mcpToml.upsertBlock(once, 'mcp_servers.membridge', BLOCK);
    assert.strictEqual(again.changed, false, 'idempotent: no rewrite when nothing differs');
    assert.strictEqual(again.text, once);
  });

  check('mcp-toml: a block at end of file replaces cleanly', () => {
    const atEnd = REAL + '\n[mcp_servers.membridge]\ncommand = "old"\n';
    const { text } = mcpToml.upsertBlock(atEnd, 'mcp_servers.membridge', ['command = "new"']);
    assert.ok(text.includes('command = "new"'));
    assert.ok(!text.includes('command = "old"'));
    assert.strictEqual((text.match(/\[mcp_servers\.membridge\]/g) || []).length, 1);
  });

  check('mcp-toml: our own sub-table is replaced with the block, not orphaned', () => {
    const withSub = REAL + '\n[mcp_servers.membridge]\ncommand = "old"\n\n[mcp_servers.membridge.env]\nA = "1"\n\n[other]\nx = 1\n';
    const { text } = mcpToml.upsertBlock(withSub, 'mcp_servers.membridge', ['command = "new"']);
    assert.ok(!text.includes('A = "1"'), 'our stale sub-table must not survive');
    assert.ok(text.includes('[other]'), 'a foreign table after it must survive');
  });

  check('mcp-toml: findBlock returns null when absent', () => {
    assert.strictEqual(mcpToml.findBlock(REAL, 'mcp_servers.membridge'), null);
  });

  check('mcp-toml: removeBlock strips only ours', () => {
    const once = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK).text;
    const { text, changed } = mcpToml.removeBlock(once, 'mcp_servers.membridge');
    assert.strictEqual(changed, true);
    assert.ok(!text.includes('[mcp_servers.membridge]'));
    assert.ok(text.includes('[mcp_servers.node_repl]'));
  });

  check('mcp-toml: empty input yields just our block', () => {
    const { text } = mcpToml.upsertBlock('', 'mcp_servers.membridge', BLOCK);
    assert.ok(text.trim().startsWith('[mcp_servers.membridge]'));
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: aborts with `Cannot find module '../lib/mcp-toml'`, exit 1.

- [ ] **Step 3: Write the implementation**

Create `lib/mcp-toml.js`:

```js
'use strict';
// Targeted TOML surgery: own exactly one table, leave every other byte alone.
//
// WHY NOT A TOML LIBRARY (mcp spec §5.2). A parse-and-restringify rewrites the
// user's ENTIRE file: comments lost, key order churned, quoted keys re-quoted
// at the library's discretion. Real Codex configs contain
// `plugins."github@openai-curated"` and
// `projects."/Users/marco/Documents/AI Shit/CopyNigga"`. MemBridge's hook
// reconcilers already refuse to rewrite settings.json wholesale; the same
// reasoning applies here, and a dependency would not change it.
//
// This needs only enough TOML awareness to recognise a table header at the
// start of a line and find the next one. It parses no values and rewrites
// nothing it did not write.
//
// PURE: string in, string out. No fs, no clock.

// A table header at line start: [name] or [ name ] with optional trailing
// comment. Deliberately not anchored to any particular key syntax -- we only
// need to know THAT a table starts here, never what it means.
const HEADER_RE = /^[ \t]*\[([^\]]*)\][ \t]*(?:#.*)?$/;

const headerName = line => {
  const m = HEADER_RE.exec(line);
  return m ? m[1].trim() : null;
};

// Ours, or one of our own sub-tables (`mcp_servers.membridge.env`). A foreign
// table that merely starts with a similar prefix (`mcp_servers.membridgeous`)
// is NOT ours -- the dot boundary is what makes that safe.
const isOursOrChild = (name, table) => name === table || name.startsWith(`${table}.`);

// findBlock -> { start, end } as LINE indices, end exclusive. Spans our table
// and any of our sub-tables, stopping at the first table that is not ours.
function findBlock(text, table) {
  const lines = String(text).split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = headerName(lines[i]);
    if (name === null) continue;
    if (start === -1) {
      if (name === table) start = i;
      continue;
    }
    if (!isOursOrChild(name, table)) return { start, end: i };
  }
  return start === -1 ? null : { start, end: lines.length };
}

// upsertBlock -> { text, changed }. Absent: append. Present: replace exactly
// the span findBlock reports. `changed:false` when the result is identical, so
// callers can skip the write entirely and never touch mtime for nothing.
function upsertBlock(text, table, bodyLines) {
  const src = String(text == null ? '' : text);
  const block = [`[${table}]`, ...bodyLines];
  const found = findBlock(src, table);

  let out;
  if (!found) {
    const base = src.length && !src.endsWith('\n') ? `${src}\n` : src;
    const sep = base.trim().length ? '\n' : '';
    out = `${base}${sep}${block.join('\n')}\n`;
  } else {
    const lines = src.split('\n');
    // Preserve a single trailing blank line after our block if one was there,
    // so repeated runs do not slowly eat the file's spacing.
    const tail = lines.slice(found.end);
    out = [...lines.slice(0, found.start), ...block, '', ...tail]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return { text: out, changed: out !== src };
}

function removeBlock(text, table) {
  const src = String(text == null ? '' : text);
  const found = findBlock(src, table);
  if (!found) return { text: src, changed: false };
  const lines = src.split('\n');
  const out = [...lines.slice(0, found.start), ...lines.slice(found.end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { text: out, changed: out !== src };
}

module.exports = { findBlock, upsertBlock, removeBlock };
```

- [ ] **Step 4: Run the tests**

Run: `node test/run-tests.js 2>&1 | grep -a "mcp-toml:"`

Expected: nine `ok` lines.

- [ ] **Step 5: Prove the byte-identity claim by mutation**

The "leaves every other byte alone" guarantee is the whole reason this module exists rather than a library, so verify the test would catch a violation. Temporarily make `upsertBlock` return `block.join('\n')` (discarding the input), confirm the quoted-keys test FAILS, then restore. Report both outputs.

- [ ] **Step 6: Run the whole suite and commit**

```bash
node test/run-tests.js 2>&1 | tail -5
git add lib/mcp-toml.js test/run-tests.js
git commit -m "feat(mcp): targeted TOML block surgery that never rewrites a user's file"
```

---

## Task 4: JSON config merge ✅ DONE (`29ae736`, merged)

**`readConfig` as sketched below destroys user configs. Read `lib/mcp-json.js`,
not the sketch.** Its bare `catch` classified *every* read failure as "missing,
safe to create", so an existing-but-unreadable config (mode 000, or a directory
in its place) read as `{}` — and since `rename` needs only the **directory**
writable, the following write destroyed it. Reproduced end to end with a config
holding a teammate's server. That is the exact "single worst thing this module
could do" named in the module's own header. Fixed: only `ENOENT` counts as
missing; everything else is a refusal.

**The same conflation is live in `lib/hooks.js`'s `readSettings`**, which this
task was told to mirror. It is harmless there today *only* because
`writeSettings` uses a plain `writeFileSync`, which fails EACCES on a mode-000
file. Make that writer atomic — the obvious refactor — and it becomes real data
loss. Fix `readSettings` first if anyone touches it.

**Two more defects in the plan's tests:** the atomicity check passes against a
plain `writeFileSync` (a non-atomic write never creates a temp file, so "no
strays" is trivially true), and the `removeServer` test contradicts its own
fixture — its `isOurs` demands `/membridge/` in `command`, but the entry's
command is `/usr/bin/node`, so the stated "nine ok lines" was never achievable.


For Cursor and any other agent storing `{ "mcpServers": { ... } }`.

**Files:**
- Create: `lib/mcp-json.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing beyond `fs`/`path`.
- Produces:
  - `readConfig(file) -> { data, existed } | null` — `null` means "exists but is not usable", which callers must treat as **refuse to write**, never as empty.
  - `upsertServer(data, name, entry) -> { data, changed }` — pure.
  - `writeConfig(file, data)` — atomic tmp+rename.
  - `removeServer(data, name, isOurs) -> { data, changed }` — pure; `isOurs(entry)` guards it.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- MCP JSON config merge (mcp spec §5.3) ----
const mcpJson = require('../lib/mcp-json');

{
  const jRoot = path.join(ROOT, 'mcpjson');
  fs.mkdirSync(jRoot, { recursive: true });
  const ENTRY = { command: '/usr/bin/node', args: ['/opt/membridge/bin/membridge.js', 'mcp'] };

  check('mcp-json: a missing file reads as empty-but-writable', () => {
    const r = mcpJson.readConfig(path.join(jRoot, 'absent.json'));
    assert.ok(r, 'a missing file is writable, not a refusal');
    assert.strictEqual(r.existed, false);
    assert.deepStrictEqual(r.data, {});
  });

  check('mcp-json: invalid JSON is a REFUSAL (null), never treated as empty', () => {
    const f = path.join(jRoot, 'broken.json');
    fs.writeFileSync(f, '{not json');
    assert.strictEqual(mcpJson.readConfig(f), null);
  });

  check('mcp-json: mcpServers present but not an object is a refusal', () => {
    const f = path.join(jRoot, 'wrongshape.json');
    fs.writeFileSync(f, JSON.stringify({ mcpServers: ['nope'] }));
    assert.strictEqual(mcpJson.readConfig(f), null);
  });

  check('mcp-json: upsert adds ours and preserves foreign servers', () => {
    const { data, changed } = mcpJson.upsertServer({ mcpServers: { other: { command: 'x' } }, unrelated: 7 }, 'membridge', ENTRY);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(data.mcpServers.other, { command: 'x' });
    assert.strictEqual(data.unrelated, 7, 'unrelated top-level keys must survive');
    assert.deepStrictEqual(data.mcpServers.membridge, ENTRY);
  });

  check('mcp-json: upsert is idempotent', () => {
    const first = mcpJson.upsertServer({}, 'membridge', ENTRY);
    const second = mcpJson.upsertServer(first.data, 'membridge', ENTRY);
    assert.strictEqual(second.changed, false);
  });

  check('mcp-json: upsert updates a stale command', () => {
    const stale = { mcpServers: { membridge: { command: '/old/node', args: [] } } };
    const { data, changed } = mcpJson.upsertServer(stale, 'membridge', ENTRY);
    assert.strictEqual(changed, true);
    assert.strictEqual(data.mcpServers.membridge.command, '/usr/bin/node');
  });

  check('mcp-json: removeServer only removes what isOurs approves', () => {
    const foreign = { mcpServers: { membridge: { command: '/somebody/elses/thing' } } };
    const isOurs = e => /membridge/.test(e.command) && /bin\/membridge\.js/.test((e.args || []).join(' '));
    const kept = mcpJson.removeServer(foreign, 'membridge', isOurs);
    assert.strictEqual(kept.changed, false, 'a foreign server merely NAMED membridge must survive');
    const ours = mcpJson.removeServer({ mcpServers: { membridge: ENTRY } }, 'membridge', isOurs);
    assert.strictEqual(ours.changed, true);
    assert.strictEqual(ours.data.mcpServers.membridge, undefined);
  });

  check('mcp-json: write is atomic and leaves no temp files', () => {
    const f = path.join(jRoot, 'out.json');
    mcpJson.writeConfig(f, { mcpServers: { membridge: ENTRY } });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.membridge, ENTRY);
    const strays = fs.readdirSync(jRoot).filter(n => n.includes('.tmp'));
    assert.deepStrictEqual(strays, []);
  });

  check('mcp-json: write creates missing parent directories', () => {
    const f = path.join(jRoot, 'deep', 'nested', 'mcp.json');
    mcpJson.writeConfig(f, { mcpServers: {} });
    assert.ok(fs.existsSync(f));
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: aborts with `Cannot find module '../lib/mcp-json'`.

- [ ] **Step 3: Write the implementation**

Create `lib/mcp-json.js`:

```js
'use strict';
// Merge one server into a `{ "mcpServers": { ... } }` config (Cursor, and any
// agent using the same shape).
//
// THE IMPORTANT DISTINCTION (mcp spec §5.3): a MISSING file is writable and
// reads as `{}`. A file that EXISTS but cannot be parsed, or whose mcpServers
// is not an object, returns null -- a REFUSAL. Callers must not write. Treating
// an unreadable config as empty would overwrite whatever the user had, which is
// the single worst thing this module could do.
//
// This mirrors lib/hooks.js's readSettings, which throws rather than write over
// a settings file it cannot understand.
const fs = require('fs');
const path = require('path');

// null = "exists but unusable, refuse to write". { data:{}, existed:false } =
// "not there yet, safe to create".
function readConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { data: {}, existed: false };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if ('mcpServers' in data) {
    const m = data.mcpServers;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  }
  return { data, existed: true };
}

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure. Returns a NEW object; the input is never mutated, so a caller that
// decides not to write has not already changed anything.
function upsertServer(data, name, entry) {
  const base = data && typeof data === 'object' ? data : {};
  const servers = base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {};
  if (sameEntry(servers[name], entry)) return { data: base, changed: false };
  return {
    data: { ...base, mcpServers: { ...servers, [name]: entry } },
    changed: true,
  };
}

// isOurs(entry) is the ownership predicate (Global Constraints): a server that
// merely shares our NAME but is not ours must never be removed.
function removeServer(data, name, isOurs) {
  const base = data && typeof data === 'object' ? data : {};
  const servers = base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {};
  const entry = servers[name];
  if (!entry) return { data: base, changed: false };
  let mine = false;
  try { mine = !!isOurs(entry); } catch { mine = false; }
  if (!mine) return { data: base, changed: false };
  const next = { ...servers };
  delete next[name];
  return { data: { ...base, mcpServers: next }, changed: true };
}

// Atomic: same tmp+rename pattern as lib/util.js's saveState and
// lib/recall-store.js's put. A crash leaves a stray temp file, never a
// half-written config.
let writeCounter = 0;
function writeConfig(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`; // throws before touching disk
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = { readConfig, upsertServer, writeConfig, removeServer };
```

- [ ] **Step 4: Run the tests, then the suite, then commit**

```bash
node test/run-tests.js 2>&1 | grep -a "mcp-json:"
node test/run-tests.js 2>&1 | tail -5
git add lib/mcp-json.js test/run-tests.js
git commit -m "feat(mcp): JSON config merge that refuses rather than clobbers"
```

Expected: nine `ok` lines, then a clean suite.

---

## Task 5: Claude binary resolution ✅ DONE (`e98bd95`, merged)

**Three defects fixed beyond the sketch below:**

1. **A chatty rc file silently defeats the shell query.** `-l` makes it a *login*
   shell, so `~/.zlogout` / `~/.bash_logout` run **after** the command — trailing
   noise made `.pop()` return junk and the resolver return `null`. On a machine
   where `claude` lives under nvm, that means falling to a probe list which
   cannot see nvm: the feature is quietly off. Fixed by scanning every stdout
   line and preferring the last that is a real file on disk. (Dropping `-i` is
   NOT the fix — that skips `~/.zshrc`, where the version managers install their
   shims.)
2. **`env.SHELL || '/bin/sh'` is the same bug one level down.** A GUI-launched
   `.app` — the entire reason this module exists — is not guaranteed `SHELL`, and
   `/bin/sh -lic` reads `~/.profile` but never `~/.zshrc`, returning the
   impoverished PATH we were escaping. Now falls back to the **user record**
   (`os.userInfo().shell`).
3. **The hang path was untested.** The plan's test injects a `throw`; a real hang
   returns normally with `.error` set to ETIMEDOUT and `status === null` — a
   different mode. Now driven against a real `sleep 30` stub shell (measured
   5002 ms, returns null, does not throw).

**Measured on the author's machine:** `{ source: 'shell' }`, 77–96 ms for the
shell query, 12 ms for the cached `recorded` path. Fine here, but that is one
zsh — oh-my-zsh with nvm and pyenv routinely costs 500 ms–2 s against a 5 s
ceiling. **Task 7 must write the resolved path back to config**; calling
`resolveClaudeBin` per-reconcile without caching turns a one-off into a
per-launch tax. And what Task 7 records must come from the **install-time**
resolution, not a daemon-time `source: 'probe'` hit, or a machine where the probe
happens to work caches a path that breaks on the next version-manager switch.


**Files:**
- Create: `lib/claude-bin.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `lib/util.js`.
- Produces:
  - `resolveClaudeBin(opts) -> { path, source } | null` — `source` is `'config'`, `'recorded'`, `'shell'`, `'probe'` or `'path'`.
  - `CANDIDATES` — the probe list, exported so tests and `membridge status` can name it.
  - `opts` is `{ config, env, home, exists, runShell }`, all injectable.

**Why this is not simply `spawnSync('claude', ...)`:** a macOS app launched from Finder inherits roughly `/usr/bin:/bin:/usr/sbin:/sbin`. `claude` is installed per-user — `~/.local/bin`, nvm, volta, asdf, homebrew, or a custom prefix. The packaged app would frequently fail to find it while the same code from a terminal finds it instantly, and that asymmetry looks like success to whoever tests from a terminal.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- claude binary resolution (mcp spec §5.1.1) ----
const claudeBin = require('../lib/claude-bin');

{
  const cbRoot = path.join(ROOT, 'claudebin');
  fs.mkdirSync(cbRoot, { recursive: true });
  const mk = name => {
    const f = path.join(cbRoot, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '#!/bin/sh\n');
    return f;
  };
  const real = mk('bin/claude');
  const other = mk('elsewhere/claude');

  check('claude-bin: config override wins over everything', () => {
    const r = claudeBin.resolveClaudeBin({
      config: { mcp: { claudeBin: real } },
      recorded: other, env: {}, runShell: () => other,
    });
    assert.strictEqual(r.source, 'config');
    assert.strictEqual(r.path, real);
  });

  check('claude-bin: a recorded path is used when it still exists', () => {
    const r = claudeBin.resolveClaudeBin({ config: {}, recorded: real, env: {}, runShell: () => other });
    assert.strictEqual(r.source, 'recorded');
    assert.strictEqual(r.path, real);
  });

  check('claude-bin: a STALE recorded path is discarded, not returned', () => {
    const gone = path.join(cbRoot, 'deleted', 'claude');
    const r = claudeBin.resolveClaudeBin({ config: {}, recorded: gone, env: {}, runShell: () => other });
    assert.notStrictEqual(r && r.path, gone, 'a deleted binary must never be returned');
    assert.strictEqual(r.source, 'shell');
  });

  check('claude-bin: falls back to asking the login shell', () => {
    const r = claudeBin.resolveClaudeBin({ config: {}, recorded: null, env: {}, runShell: () => other });
    assert.strictEqual(r.source, 'shell');
    assert.strictEqual(r.path, other);
  });

  check('claude-bin: a shell that hangs or errors does not throw', () => {
    assert.doesNotThrow(() => {
      const r = claudeBin.resolveClaudeBin({
        config: {}, recorded: null, env: {},
        runShell: () => { throw new Error('timed out'); },
        candidates: [],
      });
      assert.strictEqual(r, null);
    });
  });

  check('claude-bin: probe list is the LAST resort, after the shell', () => {
    const r = claudeBin.resolveClaudeBin({
      config: {}, recorded: null, env: {},
      runShell: () => null,
      candidates: [other],
    });
    assert.strictEqual(r.source, 'probe');
    assert.strictEqual(r.path, other);
  });

  check('claude-bin: nothing found is null, never a bare "claude" guess', () => {
    const r = claudeBin.resolveClaudeBin({
      config: {}, recorded: null, env: {}, runShell: () => null, candidates: [],
    });
    assert.strictEqual(r, null);
  });

  check('claude-bin: the probe list is exported and non-empty', () => {
    assert.ok(Array.isArray(claudeBin.CANDIDATES) && claudeBin.CANDIDATES.length > 0);
  });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: aborts with `Cannot find module '../lib/claude-bin'`.

- [ ] **Step 3: Write the implementation**

Create `lib/claude-bin.js`:

```js
'use strict';
// Find the `claude` binary, for `claude mcp add` (mcp spec §5.1.1).
//
// WHY THIS IS NOT JUST spawnSync('claude', ...). A macOS app launched from
// Finder inherits roughly /usr/bin:/bin:/usr/sbin:/sbin. `claude` installs
// per-user -- ~/.local/bin, nvm, volta, asdf, homebrew, custom prefixes. The
// packaged app would frequently fail to find it while the identical code run
// from a terminal finds it instantly. That asymmetry is dangerous precisely
// because it looks like success to whoever tests from a terminal, while every
// app user silently gets nothing -- indistinguishable from the bug this whole
// feature exists to fix.
//
// So: ask authorities in order, and treat "not found" as a REPORTED outcome
// (never a silent skip, never a bare 'claude' handed to spawnSync in hope).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// LAST RESORT ONLY, and knowingly incomplete -- it cannot cover nvm, volta,
// asdf or a custom prefix, which is exactly why the login-shell query above it
// exists. Exported so `membridge status` can show what was tried.
const CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Ask the user's LOGIN + INTERACTIVE shell where claude is. -l reads the
// profile, -i reads the rc file, so this returns the real PATH including every
// version manager's shims. This is asking the authority rather than guessing.
//
// Bounded and quiet: an rc file that is chatty or expects a terminal can hang,
// so the timeout is the contract, not a suggestion. windowsHide matches
// lib/keychain.js so no console window can flash on Windows.
function defaultRunShell(env) {
  const shell = env.SHELL || '/bin/sh';
  const r = spawnSync(shell, ['-lic', 'command -v claude'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  const out = String(r.stdout || '').trim().split('\n').pop();
  return out && path.isAbsolute(out) ? out : null;
}

function resolveClaudeBin(opts = {}) {
  const config = opts.config || {};
  const env = opts.env || process.env;
  const exists = opts.exists || isFile;
  const candidates = opts.candidates || CANDIDATES;
  const runShell = opts.runShell || defaultRunShell;

  // 1. Explicit override. Always wins, no existence check second-guessing the
  //    user -- if they named it, we use it.
  const override = config.mcp && config.mcp.claudeBin;
  if (override) return { path: override, source: 'config' };

  // 2. What install.sh recorded, IF it still exists. A stale record (upgraded
  //    node, removed tool) must fall through rather than be handed onward.
  if (opts.recorded && exists(opts.recorded)) return { path: opts.recorded, source: 'recorded' };

  // 3. Ask the login shell.
  let fromShell = null;
  try { fromShell = runShell(env); } catch { fromShell = null; }
  if (fromShell && exists(fromShell)) return { path: fromShell, source: 'shell' };

  // 4. Probe list, last resort.
  for (const c of candidates) if (exists(c)) return { path: c, source: 'probe' };

  // Nothing. Deliberately NOT a bare 'claude' for spawnSync to maybe resolve:
  // that would convert a knowable, reportable miss into a silent one.
  return null;
}

module.exports = { resolveClaudeBin, CANDIDATES };
```

- [ ] **Step 4: Run the tests, then the suite, then commit**

```bash
node test/run-tests.js 2>&1 | grep -a "claude-bin:"
node test/run-tests.js 2>&1 | tail -5
git add lib/claude-bin.js test/run-tests.js
git commit -m "feat(mcp): resolve the claude binary by authority, never by PATH alone"
```

Expected: eight `ok` lines, then a clean suite.

**Also report:** whether `defaultRunShell` actually returns a path on this machine when you call it directly (`node -e "console.log(require('./lib/claude-bin').resolveClaudeBin({config:{},recorded:null}))"`), and how long it takes. If the login shell is slow enough to be felt at daemon launch, say so — that changes whether step 3 should be cached more aggressively.

---

## Task 6: The registrar

Composes Tasks 2–5 into one operation. **Do not start until Tasks 2, 3, 4 and 5 are merged.**

**Files:**
- Create: `lib/mcp-register.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `agent-config`, `mcp-toml`, `mcp-json`, `claude-bin`, `lib/hooks.js`'s command-building approach.
- Produces:
  - `serverCommand() -> { command, args }` — absolute `process.execPath` + `bin/membridge.js mcp`, with the `ELECTRON_RUN_AS_NODE` treatment `hookCommand()` uses.
  - `isOurs(entry) -> boolean` — the ownership predicate.
  - `registerAll(opts) -> [{ agent, status, detail }]` — `status` is `'registered'`, `'unchanged'`, `'skipped'` or `'failed'`.
  - `unregisterAll(opts) -> [...]` — same shape.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum, one check each:

- Codex: a fixture `config.toml` with the quoted-key shapes gains `[mcp_servers.membridge]` and every other byte is unchanged.
- Cursor: a fixture `mcp.json` with a foreign server gains ours and keeps theirs.
- Claude Code: with a stubbed binary and a stubbed spawn, `claude mcp add -s user` is invoked with the right arguments; **assert on the argv, not on side effects.**
- Claude Code: with `resolveClaudeBin` returning null, the result is `status: 'skipped'` with a detail naming `config.mcp.claudeBin`, and no other agent is affected.
- An agent whose directory does not exist is `'skipped'` and **no file is created anywhere** — assert the default path is still absent afterwards.
- An invalid Cursor JSON is `'failed'` and the file is left **byte-identical**.
- `config.mcp.autoRegister === false` writes nothing for any agent.
- Running twice reports `'unchanged'` the second time.
- A foreign server named `membridge` survives `unregisterAll`.

Every test must run against a throwaway home. **No test may read or write the real `~/.claude.json`, `~/.codex/config.toml` or `~/.cursor/mcp.json`** — inject `home` and `env` into every call.

- [ ] **Step 2–6: Fail, implement, pass, suite, commit**

The implementation is mechanical given Tasks 2–5: for each `installedAgents()` entry, dispatch on agent kind, apply the right module, honour the kill switch, and collect a status row. Keep the whole body inside a try/catch per agent so one bad config cannot stop the others.

```bash
git commit -m "feat(mcp): register the MemBridge server with every installed agent"
```

---

## Task 7: Wiring

**Do not start until Task 6 is merged.**

**Files:**
- Modify: `install.sh`, `bin/membridge.js`, `lib/server.js`, `lib/hooks.js` (removal path)
- Test: `test/run-tests.js`

- [ ] **Step 1: Register during install**

`install.sh` runs in the user's own shell, where `claude` resolves without searching. Add a step after the daemon install that runs `membridge mcp register`, records the resolved `claude` path into MemBridge's config, and prints what it did. A failure must warn, never abort the install.

- [ ] **Step 2: Add the CLI verbs**

`membridge mcp register` and `membridge mcp unregister` in `bin/membridge.js`, printing one line per agent from the status rows.

- [ ] **Step 3: Reconcile on launch**

Call `registerAll()` from the same launch path that already calls `reconcileStopHook()` and `reconcileRecallHook()`. It must be fail-open and must not measurably slow startup — the cached binary path is what makes that true.

- [ ] **Step 4: Report in `membridge status`**

One line per agent: registered / unchanged / skipped (with the reason and the config key that fixes it) / failed. This is the requirement that stops an unregisterable agent being invisible.

- [ ] **Step 5: Strip on removal**

Extend the existing `remove-hooks` path to call `unregisterAll()`, so uninstalling leaves no MemBridge entry behind in anyone's config.

- [ ] **Step 6: Suite, then commit**

```bash
git commit -m "feat(mcp): register at install, reconcile at launch, report in status"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 the two causes | 1 (deps), 6+7 (registration) |
| §3.1 Claude Code via CLI | 5, 6 |
| §3.2 Codex TOML, no CLI | 3, 6 |
| §3.3 Cursor JSON | 4, 6 |
| §4 which agents, detection | 2, 6 |
| §4.1 discovery by authority | 2 |
| §4.2 never conjure a config | 2, 6 |
| §5.1.1 binary resolution, install-time | 5, 7 |
| §5.1.2 no window (`windowsHide`) | 5 |
| §5.1.3 never hang (timeout) | 5 |
| §5.4 ownership | 4 (`removeServer`), 6 |
| §6 kill switch | 6 |
| §7 dependencies and doc claims | 1 |
| §8 failure modes | 6, 7 |
| §11 testing | every task |

**One thing deliberately left to the implementer:** Task 2's `envVar` values for Claude Code and Cursor are unverified — only Codex's `CODEX_HOME` is documented. Task 2 Step 4 instructs the implementer to verify them and set `envVar: null` with a note rather than leave a fabricated authority in the table. An invented env var is worse than none, because it looks like it was checked.

**Known conflict:** all tasks append to `test/run-tests.js`. Parallel branches will conflict there; the resolution is always keep-both.
