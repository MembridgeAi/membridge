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
//
// SHAPE RULE: every per-agent difference lives in the SPECS table as DATA.
// Nothing in this file branches on an agent name, and nothing downstream
// should have to either -- a `switch (agent)` in the registrar is the failure
// mode this shape exists to prevent. Teaching MemBridge about a new tool, or
// about an env var a tool gains next year, must be a one-line edit to SPECS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');

// dirName:     the agent's config DIRECTORY, relative to home. Its existence is
//              our evidence the tool is installed -- nothing more.
// file:        the MCP config file's name INSIDE an explicitly-nominated config
//              directory (one named by the tool's env var, or by XDG).
// defaultFile: the config file's path relative to HOME when nothing nominated a
//              directory. Usually `[dirName, file]`, but not always: Claude Code
//              keeps `~/.claude.json` as a SIBLING of `~/.claude/`, so dir and
//              file legitimately diverge. Path segments, not a string, so
//              Windows separators come out right.
// envVar:      the tool's OWN documented variable naming its config directory.
//              A string, an array (first one set wins, for tools that rename a
//              variable and keep the old name working), or null when the tool
//              has no such variable. Null is the honest answer -- an invented
//              env var is worse than none, because it looks checked and will
//              silently never fire.
// xdg:         the subdirectory under $XDG_CONFIG_HOME, or null if the tool does
//              not read XDG for its own config.
// format:      how the file is written, so the registrar dispatches on DATA.
//              'claude-cli' means "do not write the file at all, shell out to
//              the tool's own CLI" (mcp spec §3.1).
//
// EVIDENCE for every env var and xdg value below was gathered 2026-07-29 by
// running the real tools / reading their shipped code. See the notes on each
// entry. Anything unverified is null, deliberately.
const SPECS = {
  // `CLAUDE_CONFIG_DIR=<d> claude mcp list` (Claude Code 2.1.220) read <d> and
  // created `<d>/.claude.json`. Note the leading dot and note that the default
  // is `~/.claude.json`, NOT `~/.claude/claude.json`.
  // No XDG: Claude Code has no XDG_CONFIG_HOME handling for its own config.
  'claude-code': {
    dirName: '.claude',
    file: '.claude.json',
    defaultFile: ['.claude.json'],
    envVar: 'CLAUDE_CONFIG_DIR',
    xdg: null,
    format: 'claude-cli',
  },
  // `CODEX_HOME=<d> codex doctor` reported `CODEX_HOME <d>` and
  // `config.toml <d>/config.toml`; `codex --help` documents
  // `$CODEX_HOME/<name>.config.toml`.
  // No XDG: with XDG_CONFIG_HOME set, `codex doctor` still reported ~/.codex.
  // The only XDG_CONFIG_HOME strings in the binary belong to its vendored git
  // library, for git's own config -- not Codex's.
  codex: {
    dirName: '.codex',
    file: 'config.toml',
    defaultFile: ['.codex', 'config.toml'],
    envVar: 'CODEX_HOME',
    xdg: null,
    format: 'toml',
  },
  // Cursor's own shipped code (Cursor.app .../cursor-local-agent-runtime and
  // .../cursor-agent-exec) resolves its config dir as:
  //   CURSOR_CONFIG_DIR || (XDG_CONFIG_HOME && join(XDG_CONFIG_HOME,'cursor'))
  //                     || join(homedir(),'.cursor')
  // CAVEAT: that chain governs the cursor-agent CLI. The Cursor IDE itself
  // (workbench.desktop.main.js `getUserConfigFilePath`) hardcodes
  // `userHome/.cursor/mcp.json` with no env var and no XDG. The two surfaces
  // disagree, which is why XDG is only preferred here when the XDG directory
  // actually exists -- see resolveAgentConfig step 3.
  cursor: {
    dirName: '.cursor',
    file: 'mcp.json',
    defaultFile: ['.cursor', 'mcp.json'],
    envVar: 'CURSOR_CONFIG_DIR',
    xdg: 'cursor',
    format: 'json',
  },
};

const AGENTS = Object.keys(SPECS);

// Format inferred from a user-declared config file's extension, so someone on a
// tool we have never heard of does not also have to tell us what a `.json` file
// is. Data, so a new format is one line.
const FORMAT_BY_EXT = { '.toml': 'toml', '.json': 'json', '.jsonc': 'json' };

const exists = p => { try { return fs.existsSync(p); } catch { return false; } };

const mcpConfig = config => (config && config.mcp && typeof config.mcp === 'object') ? config.mcp : {};

// Per-agent user config, e.g. config.mcp.codex = { configPath, format }.
// Non-agent knobs living under config.mcp (autoRegister, claudeBin) are plain
// values, never objects, so they can never be mistaken for an agent entry.
const agentEntry = (config, agent) => {
  const e = mcpConfig(config)[agent];
  return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
};

// The first env var in `spec.envVar` that is actually set. Accepts a string, an
// array, or null; returns null when nothing is set. Adding a second variable a
// tool starts honouring is therefore a data edit, not a code edit.
function envDir(spec, env) {
  const names = spec.envVar == null ? [] : (Array.isArray(spec.envVar) ? spec.envVar : [spec.envVar]);
  for (const name of names) {
    const v = env[name];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

// A spec for an agent MemBridge does not ship knowledge of, synthesised from
// what the user told us. There will always be more agents than we have added,
// and a stranger on a tool we have not heard of should not be stuck waiting for
// a release: `config.mcp.<name> = { configPath, format }` is enough for us to
// register with anything file-based.
function userSpec(config, agent) {
  const entry = agentEntry(config, agent);
  if (!entry || typeof entry.configPath !== 'string' || !entry.configPath) return null;
  const file = entry.configPath;
  const dir = path.dirname(file);
  return {
    dirName: null,
    file: path.basename(file),
    defaultFile: null,
    envVar: null,
    xdg: null,
    // An unrecognised extension yields null rather than a guess. The registrar
    // reports that as an unwritable agent naming `config.mcp.<agent>.format`,
    // which is the whole point: never silently skip (mcp spec §4.2).
    format: entry.format || FORMAT_BY_EXT[path.extname(file).toLowerCase()] || null,
  };
}

// Resolution order, first hit wins. `source` records WHICH authority answered,
// so `membridge status` can tell the user why we looked where we looked.
function resolveAgentConfig(agent, opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || util.getConfig();
  // util.homeDir() is MEMBRIDGE's home (~/.membridge). The OS home is what every
  // path here hangs off, and it is also what lib/adapters/*.js already use.
  // Getting this wrong resolves ~/.membridge/.codex/config.toml -- a path Codex
  // will never read, and one no test that injects `home` can ever catch.
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;

  const spec = SPECS[agent] || userSpec(config, agent);
  if (!spec) return null; // unknown agent, and the user has not declared one:
                          // no path is better than a guessed one.

  const out = (dir, file, source) => ({ agent, dir, file, source, format: spec.format, exists: exists(dir) });

  // 1. MemBridge config override -- the escape hatch for layouts we did not
  //    anticipate, and the only authority a user-declared agent has. Points at
  //    the FILE, not the directory, since a user who moved things may not have
  //    kept the filename either.
  const entry = agentEntry(config, agent);
  const override = entry && entry.configPath;
  if (override) return out(path.dirname(override), override, 'config');

  // 2. The tool's own environment variable -- the tool telling us where it
  //    lives. Always beats anything we could infer, and is honoured even when
  //    the directory does not exist yet: the user has stated a fact about their
  //    setup, not offered a hint.
  const fromEnv = envDir(spec, env);
  if (fromEnv) return out(fromEnv, path.join(fromEnv, spec.file), 'env');

  // 3. XDG, on linux only, and only when the XDG directory actually exists.
  //    macOS does not use XDG by convention and Windows has its own tree;
  //    applying a linux-shaped guess to three platforms is the mistake this
  //    module exists to avoid. The existence requirement matters on its own:
  //    a Linux user with XDG_CONFIG_HOME set (most of them) but Cursor
  //    installed at ~/.cursor would otherwise resolve to an empty XDG path,
  //    report exists:false, and never get registered at all -- a silent miss
  //    that looks exactly like the feature working.
  if (platform === 'linux' && spec.xdg && typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()) {
    const dir = path.join(env.XDG_CONFIG_HOME, spec.xdg);
    if (exists(dir)) return out(dir, path.join(dir, spec.file), 'xdg');
  }

  // 4. The documented default. `defaultFile` is relative to HOME, not to the
  //    detection directory, because they are not always the same place.
  const dir = path.join(home, spec.dirName);
  return out(dir, path.join(home, ...spec.defaultFile), 'default');
}

// The built-in agents plus any the user declared under `config.mcp`. Dynamic,
// because the set of agents a user runs is theirs to decide, not ours.
function knownAgents(opts = {}) {
  const config = opts.config || util.getConfig();
  const extra = Object.keys(mcpConfig(config)).filter(k => !SPECS[k] && userSpec(config, k));
  return [...AGENTS, ...extra];
}

// Only agents whose config DIRECTORY exists -- direct evidence the tool is
// installed. Absence is not an error and not a guess: it simply means there is
// nothing to register with.
function installedAgents(opts = {}) {
  return knownAgents(opts).map(a => resolveAgentConfig(a, opts)).filter(r => r && r.exists);
}

module.exports = { AGENTS, SPECS, FORMAT_BY_EXT, knownAgents, resolveAgentConfig, installedAgents };
