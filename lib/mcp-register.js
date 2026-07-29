'use strict';
// THE REGISTRAR: compose config discovery, TOML surgery, JSON merge and binary
// resolution into one operation -- "make every agent this user actually has
// able to call MemBridge's MCP server" (mcp spec §5, §6).
//
// SHAPE RULE, inherited from lib/agent-config.js: nothing here branches on an
// agent NAME. Every resolution carries a `format` ('claude-cli' | 'toml' |
// 'json') and dispatch is a table lookup on that. This is what lets a user on a
// tool MemBridge has never heard of work today rather than after a release --
// they declare `config.mcp.<name> = { configPath, format }` and every rule
// below applies to them unchanged. A `switch (agent)` here would quietly undo
// that; there is a check in the suite that fails if one appears.
//
// THREE RULES THAT OUTRANK GETTING REGISTERED (Global Constraints):
//   1. Never clobber. An entry is ours only if it is named `membridge` AND its
//      command references a MemBridge path -- the same anchoring discipline as
//      lib/hooks.js's isOwnStopHook, and for the same reason: a bare
//      "membridge" substring matches any script a user keeps under a directory
//      named Membridge, and claiming one was destructive in both directions.
//   2. Never conjure. If an agent's config cannot be resolved, write NOTHING.
//      The one allowed creation is a file inside a directory that already
//      exists -- the tool is installed, it simply has no servers yet.
//   3. Never silently skip. Every agent produces a ROW, including the ones we
//      did nothing for, with the config key that would fix it. A silent skip is
//      indistinguishable from the feature working -- which is precisely the bug
//      this feature exists to fix.
//
// FAIL OPEN: every agent runs inside its own try/catch, so one unreadable
// config cannot stop the others, and nothing here may prevent a daemon launch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const agentConfig = require('./agent-config');
const mcpToml = require('./mcp-toml');
const mcpJson = require('./mcp-json');
const claudeBinMod = require('./claude-bin');
const util = require('./util');

// The server name, everywhere (Global Constraints).
const SERVER_NAME = 'membridge';

// Codex-shaped TOML keeps servers in `[mcp_servers.<name>]`. Keyed off the
// FORMAT, not off any agent, so a second tool adopting the same file shape
// needs no code here.
const TOML_TABLE = `mcp_servers.${SERVER_NAME}`;

// Same ceiling as lib/claude-bin.js's shell query (spec §5.1.3): if the CLI
// ever decides to prompt, it must die on the timeout rather than block a
// launch waiting for input that will never come.
const SPAWN_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// What we register
// ---------------------------------------------------------------------------

// Absolute execPath + absolute script, exactly as lib/hooks.js's hookCommand()
// builds the hook command and for the same reason: a bare `membridge` is not on
// a GUI-launched agent's PATH, and the app bundle's node is not the system one.
//
// ONE DELIBERATE DIVERGENCE from hookCommand(). It returns a SHELL STRING and
// prefixes `ELECTRON_RUN_AS_NODE=1 `, which works because a shell parses that
// as an assignment. An MCP entry is not a shell string -- every consumer here
// (Codex TOML `command`/`args`, Cursor JSON `command`/`args`, `claude mcp add
// -- <cmd> <args>`) spawns the executable DIRECTLY. Carrying the prefix across
// would make the command "ELECTRON_RUN_AS_NODE=1 /path/to/Electron", a filename
// no execve will ever find, and we would register a server that can never
// start -- the silent-failure shape this whole feature exists to end. So it
// travels as an env FIELD, which all three formats support.
//
// `opts.electron` is injectable ONLY so that divergence stays testable. The
// suite runs under plain node, so a check written against the ambient
// process.versions.electron exercises the empty branch and passes no matter
// what the Electron branch does -- it would have accepted the shell prefix
// silently, which is the whole failure this comment is about.
function serverCommand(opts = {}) {
  const script = path.join(__dirname, '..', 'bin', 'membridge.js');
  const electron = opts.electron === undefined ? !!process.versions.electron : !!opts.electron;
  return {
    command: process.execPath,
    args: [script, 'mcp'],
    env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

// Split a command line, a JSON entry or a raw TOML block into the tokens a
// shell/TOML/JSON reader would see. One tokenizer for all three formats keeps
// the ownership rule identical everywhere, which is the point of having one.
const TOKEN_SPLIT = /[\s"',[\]{}=]+/;

// A path ENDING in our script (or our launcher), never a bare substring. The
// separator class covers both platforms' path shapes.
const OWN_SCRIPT_RE = /(^|[/\\])membridge\.js$/i;
const OWN_LAUNCHER_RE = /(^|[/\\])membridge(\.cmd|\.bat|\.exe)?$/i;

function ownTokens(entry) {
  if (entry == null) return [];
  if (typeof entry === 'string') return entry.split(TOKEN_SPLIT).filter(Boolean);
  if (typeof entry !== 'object') return [];
  const parts = [];
  if (typeof entry.command === 'string') parts.push(entry.command);
  if (Array.isArray(entry.args)) for (const a of entry.args) if (typeof a === 'string') parts.push(a);
  return parts.join(' ').split(TOKEN_SPLIT).filter(Boolean);
}

// True only for a registration MemBridge itself would write: our script (or our
// launcher) immediately followed by the `mcp` subcommand. Anything else keeping
// the name `membridge` -- a user's own server, an HTTP entry, a script that
// merely lives under a Membridge directory -- is theirs, and is neither
// overwritten nor removed.
function isOurs(entry) {
  const t = ownTokens(entry);
  for (let i = 0; i + 1 < t.length; i++) {
    if (t[i + 1].toLowerCase() !== 'mcp') continue;
    if (OWN_SCRIPT_RE.test(t[i]) || OWN_LAUNCHER_RE.test(t[i])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Serialising into each format
// ---------------------------------------------------------------------------

// A TOML basic string. NOT optional politeness: a Windows command is
// `C:\Program Files\nodejs\node.exe`, and inside a basic string `\P` and `\U`
// are escape sequences -- writing the path raw produces a file the tool can no
// longer parse, i.e. we break the config we were registering into, on the one
// platform hardest to notice it from here.
const tomlString = s => `"${String(s)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/[\u0000-\u001f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;

function tomlBody(cmd) {
  const lines = [
    `command = ${tomlString(cmd.command)}`,
    `args = [${(cmd.args || []).map(tomlString).join(', ')}]`,
  ];
  const keys = Object.keys(cmd.env || {});
  if (keys.length) {
    lines.push(`env = { ${keys.map(k => `${k} = ${tomlString(cmd.env[k])}`).join(', ')} }`);
  }
  return lines;
}

function jsonEntry(cmd) {
  const entry = { command: cmd.command, args: [...(cmd.args || [])] };
  // Omitted when empty rather than written as {}: an absent key and an empty
  // object mean the same thing to the reader, but only one of them makes a
  // re-run compare equal against what a human or another tool wrote.
  if (cmd.env && Object.keys(cmd.env).length) entry.env = { ...cmd.env };
  return entry;
}

// ---------------------------------------------------------------------------
// Reading and writing files
// ---------------------------------------------------------------------------

// The distinction lib/mcp-json.js's readConfig makes, for text formats, which
// have no reader of their own. ONLY a genuinely absent file is safe to create.
// Every other read failure means something IS there that we cannot see -- mode
// 000 (EACCES), a directory in its place (EISDIR), a bad disk (EIO) -- and
// since rename needs only the DIRECTORY writable, treating those as "empty"
// destroys the user's config just as surely as a deliberate overwrite.
function readTextConfig(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), existed: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { text: '', existed: false };
    return null; // refusal, not emptiness
  }
}

// Atomic, matching lib/util.js saveState and lib/mcp-json.js writeConfig: a
// crash leaves a stray temp file, never a half-written config. Deliberately
// does NOT mkdir -- the caller has already proved the directory exists, and
// creating one here would be the conjuring rule 2 forbids.
let writeCounter = 0;
function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The claude CLI surface (spec §3.1, §5.1)
// ---------------------------------------------------------------------------
//
// We never write this agent's file. Its storage shape is an internal detail
// that has already moved once, so whatever the current version expects, let the
// current version write it.

function runClaude(ctx, bin, args, resolved) {
  const env = { ...(ctx.env || {}) };
  // A user who pointed us at a relocated config with config.mcp.<agent>
  // .configPath gets the CLI pointed at the same place. The CLI takes a
  // DIRECTORY and picks its own filename inside it, so a custom basename
  // cannot be honoured here -- the directory is the most we can pass on.
  if (resolved && resolved.source === 'config' && resolved.dir) env.CLAUDE_CONFIG_DIR = resolved.dir;
  let r;
  try {
    r = ctx.spawn(bin, args, {
      encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, windowsHide: true, input: '', env,
    });
  } catch (err) {
    return { ok: false, detail: err && err.message ? err.message : String(err) };
  }
  if (!r) return { ok: false, detail: 'no result from spawn' };
  const ok = !r.error && r.status === 0;
  return {
    ok,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    detail: r.error ? (r.error.message || 'spawn failed') : `exited ${r.status}`,
  };
}

// Read back what the CLI says is registered. Parsing human-readable output is
// fragile by nature, so the failure direction is chosen deliberately: anything
// we cannot parse yields null, callers treat null as NOT ours, and not-ours is
// always "leave it completely alone". A format change therefore costs us the
// ability to repair a stale entry; it can never cost a user their config.
function parseClaudeGet(stdout) {
  const out = { scope: null, command: null, args: [], env: {} };
  let inEnv = false;
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(Scope|Type|Command|Args|Environment):\s*(.*)$/.exec(line);
    if (m) {
      inEnv = m[1] === 'Environment';
      const v = m[2].trim();
      if (m[1] === 'Scope') out.scope = (v.split(/\s+/)[0] || '').toLowerCase();
      else if (m[1] === 'Command') out.command = v;
      else if (m[1] === 'Args') out.args = v ? v.split(/\s+/) : [];
      continue;
    }
    if (inEnv) {
      const e = /^\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (e) { out.env[e[1]] = e[2]; continue; }
      inEnv = false;
    }
  }
  return out.command ? out : null;
}

// `claude mcp get` joins args with spaces, so compare the joined forms on both
// sides: symmetric, and it never reports a spurious difference that would make
// us remove-and-re-add on every single launch.
function sameRegistration(current, cmd) {
  if ([current.command, ...current.args].join(' ') !== [cmd.command, ...(cmd.args || [])].join(' ')) return false;
  const want = cmd.env || {};
  const have = current.env || {};
  const wk = Object.keys(want).sort();
  const hk = Object.keys(have).sort();
  if (wk.join(',') !== hk.join(',')) return false;
  return wk.every(k => String(want[k]) === String(have[k]));
}

const addArgv = cmd => [
  'mcp', 'add', '-s', 'user', SERVER_NAME,
  ...Object.entries(cmd.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  '--', cmd.command, ...(cmd.args || []),
];

const REMOVE_ARGV = ['mcp', 'remove', SERVER_NAME, '-s', 'user'];
const GET_ARGV = ['mcp', 'get', SERVER_NAME];

function registerViaCli(resolved, ctx) {
  const bin = ctx.claudeBin();
  if (!bin) {
    return skip('no-binary', 'could not find the `claude` binary; set config.mcp.claudeBin to its full path');
  }
  const got = runClaude(ctx, bin.path, GET_ARGV, resolved);
  if (got.ok) {
    const current = parseClaudeGet(got.stdout);
    if (!current || !isOurs(current)) {
      return skip('foreign', `a server named ${SERVER_NAME} is already registered here and is not ours; leaving it untouched`);
    }
    // Another scope owns it. Removing from a scope we did not write to would
    // be reaching into a project or machine-local config we were never asked
    // about, so report and stop.
    if (current.scope && current.scope !== 'user') {
      return { status: 'unchanged', reason: 'other-scope', detail: `already registered at ${current.scope} scope` };
    }
    if (sameRegistration(current, ctx.command)) return { status: 'unchanged', reason: 'current' };
    // STALE. `claude mcp add` refuses an existing name (verified: exit 1,
    // "already exists"), so there is no update verb -- leaving it would mean a
    // registration pointing at a path that no longer runs, forever, which
    // looks exactly like the feature working. Remove ours, then re-add.
    const rm = runClaude(ctx, bin.path, REMOVE_ARGV, resolved);
    if (!rm.ok) return fail('remove-failed', `could not replace a stale registration: ${rm.detail}`);
  }
  const add = runClaude(ctx, bin.path, addArgv(ctx.command), resolved);
  if (!add.ok) return fail('cli-failed', `\`claude mcp add\` ${add.detail}${add.stderr ? `: ${add.stderr.trim()}` : ''}`);
  return { status: 'registered', reason: 'cli' };
}

function unregisterViaCli(resolved, ctx) {
  const bin = ctx.claudeBin();
  if (!bin) return skip('no-binary', 'could not find the `claude` binary; set config.mcp.claudeBin to its full path');
  const got = runClaude(ctx, bin.path, GET_ARGV, resolved);
  if (!got.ok) return { status: 'unchanged', reason: 'absent', detail: 'nothing registered' };
  const current = parseClaudeGet(got.stdout);
  if (!current || !isOurs(current)) {
    return skip('foreign', `a server named ${SERVER_NAME} is registered here but is not ours; leaving it untouched`);
  }
  if (current.scope && current.scope !== 'user') {
    return skip('other-scope', `registered at ${current.scope} scope, which we did not write`);
  }
  const rm = runClaude(ctx, bin.path, REMOVE_ARGV, resolved);
  if (!rm.ok) return fail('cli-failed', `\`claude mcp remove\` ${rm.detail}`);
  return { status: 'removed', reason: 'cli' };
}

// ---------------------------------------------------------------------------
// The TOML surface (spec §5.2)
// ---------------------------------------------------------------------------

const blockText = (text, span) => text.split('\n').slice(span.start, span.end).join('\n');

function registerToml(resolved, ctx) {
  const read = readTextConfig(resolved.file);
  if (!read) return fail('unreadable', `${resolved.file} exists but cannot be read; refusing to write over it`);
  const found = mcpToml.findBlock(read.text, TOML_TABLE);
  if (found && !isOurs(blockText(read.text, found))) {
    return skip('foreign', `[${TOML_TABLE}] is already present and is not ours; leaving it untouched`);
  }
  const { text, changed } = mcpToml.upsertBlock(read.text, TOML_TABLE, tomlBody(ctx.command));
  if (!changed) return { status: 'unchanged', reason: 'current' };
  writeTextAtomic(resolved.file, text);
  return { status: 'registered', reason: read.existed ? 'updated' : 'created' };
}

// The remove side needs no ctx: nothing about the command we WOULD write
// matters when the question is only whether what is there is ours.
function unregisterToml(resolved) {
  const read = readTextConfig(resolved.file);
  if (!read) return fail('unreadable', `${resolved.file} exists but cannot be read; refusing to write over it`);
  const found = mcpToml.findBlock(read.text, TOML_TABLE);
  if (!found) return { status: 'unchanged', reason: 'absent', detail: 'nothing registered' };
  if (!isOurs(blockText(read.text, found))) {
    return skip('foreign', `[${TOML_TABLE}] is not ours; leaving it untouched`);
  }
  const { text, changed } = mcpToml.removeBlock(read.text, TOML_TABLE);
  if (!changed) return { status: 'unchanged', reason: 'absent' };
  writeTextAtomic(resolved.file, text);
  return { status: 'removed', reason: 'stripped' };
}

// ---------------------------------------------------------------------------
// The JSON surface (spec §5.3)
// ---------------------------------------------------------------------------

function registerJson(resolved, ctx) {
  const read = mcpJson.readConfig(resolved.file);
  if (!read) return fail('unreadable', `${resolved.file} is not valid JSON we understand; refusing to write over it`);
  const current = read.data.mcpServers && read.data.mcpServers[SERVER_NAME];
  if (current && !isOurs(current)) {
    return skip('foreign', `a server named ${SERVER_NAME} is already present and is not ours; leaving it untouched`);
  }
  const { data, changed } = mcpJson.upsertServer(read.data, SERVER_NAME, jsonEntry(ctx.command));
  if (!changed) return { status: 'unchanged', reason: 'current' };
  mcpJson.writeConfig(resolved.file, data);
  return { status: 'registered', reason: read.existed ? 'updated' : 'created' };
}

function unregisterJson(resolved) {
  const read = mcpJson.readConfig(resolved.file);
  if (!read) return fail('unreadable', `${resolved.file} is not valid JSON we understand; refusing to write over it`);
  const current = read.data.mcpServers && read.data.mcpServers[SERVER_NAME];
  if (!current) return { status: 'unchanged', reason: 'absent', detail: 'nothing registered' };
  const { data, changed } = mcpJson.removeServer(read.data, SERVER_NAME, isOurs);
  if (!changed) return skip('foreign', `a server named ${SERVER_NAME} is present but is not ours; leaving it untouched`);
  mcpJson.writeConfig(resolved.file, data);
  return { status: 'removed', reason: 'stripped' };
}

// Dispatch on the resolution's FORMAT. The only place agents differ.
const HANDLERS = {
  register: { 'claude-cli': registerViaCli, toml: registerToml, json: registerJson },
  unregister: { 'claude-cli': unregisterViaCli, toml: unregisterToml, json: unregisterJson },
};
const FORMATS = Object.keys(HANDLERS.register);

// ---------------------------------------------------------------------------
// Driving them all
// ---------------------------------------------------------------------------

const skip = (reason, detail) => ({ status: 'skipped', reason, detail });
const fail = (reason, detail) => ({ status: 'failed', reason, detail });

const mcpSetting = (config, key) => {
  const m = config && config.mcp;
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m[key] : undefined;
};

const realish = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const under = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// A guard rail for the SUITE, not for users (spec §6). MEMBRIDGE_HOME pointing
// into the system temp directory means a test harness, and a check that forgot
// to inject `home` would otherwise resolve a developer's real ~/.codex,
// ~/.cursor and ~/.claude and edit them for keeps. Narrowed to "under
// os.tmpdir()" precisely so a user who legitimately relocates MEMBRIDGE_HOME
// (a second profile, the beta fork) still gets registered.
// Both spellings of both paths are compared, because they routinely differ:
// macOS's /tmp and /var/folders/... are symlinks into /private, realpath only
// resolves a path that EXISTS (a fixture home that has not been created yet
// resolves to neither form), and the suite's own MEMBRIDGE_HOME is the
// unresolved spelling. Comparing one pair silently missed the guard entirely.
function isTestHarness(env) {
  const h = env && env.MEMBRIDGE_HOME;
  if (typeof h !== 'string' || !h.trim()) return false;
  const homes = new Set([path.resolve(h), realish(h)]);
  const tmps = new Set([path.resolve(os.tmpdir()), realish(os.tmpdir())]);
  for (const home of homes) for (const tmp of tmps) if (under(home, tmp)) return true;
  return false;
}

// One row per agent, ALWAYS -- including the ones we did nothing for.
// `status`: 'registered' | 'removed' | 'unchanged' | 'skipped' | 'failed'.
// `reason` is a stable machine token for `membridge status`; `detail` is the
// sentence a human reads, and for anything actionable it names the config key
// that fixes it.
function run(mode, opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || util.getConfig();
  const agents = agentConfig.knownAgents({ config });
  const row = (agent, out, resolved) => ({
    agent,
    status: out.status,
    reason: out.reason || null,
    detail: out.detail || null,
    file: resolved ? resolved.file : null,
    source: resolved ? resolved.source : null,
    format: resolved ? resolved.format : null,
  });

  if (isTestHarness(env)) {
    return agents.map(a => row(a, skip('test-harness',
      'MEMBRIDGE_HOME points into the system temp directory; refusing to touch real agent configs')));
  }

  // The kill switch (spec §6): only the literal false, matching
  // config.recall.enabled and isNotesEnabled. It governs REGISTRATION only --
  // turning auto-registration off must never strand an entry we already wrote,
  // and `remove-hooks` has to clean up regardless of it.
  if (mode === 'register' && mcpSetting(config, 'autoRegister') === false) {
    return agents.map(a => row(a, skip('disabled', 'config.mcp.autoRegister is false')));
  }

  const ctx = {
    env,
    config,
    command: opts.command || serverCommand(),
    spawn: opts.spawn || spawnSync,
    claudeBin: null, // memoised below
  };
  // Resolved LAZILY, and at most once: on a machine without Claude Code the
  // login-shell query (77 ms at best, seconds under oh-my-zsh) must never be
  // paid at all, and on one with it, never twice.
  let binCache;
  ctx.claudeBin = () => {
    if (binCache === undefined) {
      const resolve = opts.resolveClaudeBin || claudeBinMod.resolveClaudeBin;
      const recorded = opts.recordedClaudeBin !== undefined
        ? opts.recordedClaudeBin
        : mcpSetting(config, 'claudeBinRecorded');
      try { binCache = resolve({ config, env, recorded }) || null; } catch { binCache = null; }
    }
    return binCache;
  };

  const rows = [];
  for (const agent of agents) {
    let resolved = null;
    try {
      resolved = agentConfig.resolveAgentConfig(agent, {
        config, env, home: opts.home, platform: opts.platform,
      });
      if (!resolved) {
        rows.push(row(agent, skip('unknown', `unknown agent; declare it with config.mcp.${agent}.configPath`)));
        continue;
      }
      // NEVER CONJURE. The directory's existence is our only evidence the tool
      // is installed. Absent, we write nothing -- not the file, not the
      // directory -- and say so, naming the key a user who relocated it needs.
      if (!resolved.exists) {
        rows.push(row(agent, skip('not-installed',
          `${resolved.dir} does not exist, so nothing was written; if you keep this config elsewhere, set config.mcp.${agent}.configPath`), resolved));
        continue;
      }
      const handler = HANDLERS[mode][resolved.format];
      if (!handler) {
        rows.push(row(agent, skip('unknown-format',
          `no writer for format ${JSON.stringify(resolved.format)}; set config.mcp.${agent}.format to one of ${FORMATS.join(', ')}`), resolved));
        continue;
      }
      rows.push(row(agent, handler(resolved, ctx), resolved));
    } catch (err) {
      // Fail open, per agent: an unreadable config, a full disk or a
      // permission wall costs that one agent, never the rest and never the
      // launch.
      rows.push(row(agent, fail('error', err && err.message ? err.message : String(err)), resolved));
    }
  }
  return rows;
}

const registerAll = (opts = {}) => run('register', opts);
const unregisterAll = (opts = {}) => run('unregister', opts);

// ---------------------------------------------------------------------------
// The wiring surface: install-time, launch-time, and what `status` reads
// ---------------------------------------------------------------------------
//
// THE COST THAT SHAPES ALL OF THIS. A reconcile is ~2s on a miss and ~6s on a
// repair, almost all of it `claude mcp get` -- the CLI spends ~2.1s starting up
// before it prints anything -- on top of a login-shell query that costs 77ms on
// a bare zsh and seconds under oh-my-zsh with nvm. Running that unconditionally
// at every daemon launch would make MemBridge feel broken to buy a repair that
// is almost never needed. So:
//
//   - registerNow()      explicit and user-driven (install.sh, `membridge mcp
//                        register`). Always runs, always records.
//   - ensureRegistered() the launch path. Gated on a fingerprint of everything
//                        a registration decision depends on, so the common
//                        already-registered launch costs a state read and a
//                        few statSync calls -- microseconds, not seconds.
//   - lastRegistration() what `membridge status` prints. Reading the RECORDED
//                        rows keeps status read-only and instant; re-running a
//                        registration to report on it would both write from a
//                        read-only command and add seconds to it.
//
// The rows are persisted precisely because of the "never silently skip" rule:
// an agent we could not register is only actually reported if the report
// survives the process that produced it.
const STATE_KEY = 'mcpRegistration';

function membridgeVersion() {
  try { return require('../package.json').version || ''; } catch { return ''; }
}

// Everything a registration decision depends on, cheaply. Deliberately NOT a
// re-read of the agents' configs: that is the expensive half, and re-reading it
// to decide whether to read it is no saving at all.
//
// What each part catches:
//   version           a MemBridge upgrade may change what we register at all.
//   command/args/env  a reinstall, a new node, app-bundle -> npm: the recorded
//                     command is stale and every entry points at a dead path.
//   claudeBin/...     the user set an override, or install.sh recorded a path
//                     after the daemon had already run.
//   autoRegister      flipping the kill switch must produce a fresh report.
//   <agent>=file:0|1  an agent installed (or relocated) since the last run --
//                     the "I installed Cursor yesterday" case, which is the
//                     single most likely reason a reconcile is needed at all.
//
// What it deliberately does NOT catch: a user (or another tool) deleting our
// entry by hand. Detecting that means reading every agent config, and for
// Claude Code that is the 2.1s spawn this gate exists to avoid. `membridge mcp
// register` repairs it on demand, and the next upgrade repairs it anyway.
function registrationFingerprint(opts = {}) {
  const env = opts.env || process.env;
  const config = opts.config || util.getConfig();
  const cmd = opts.command || serverCommand();
  const parts = [
    `v=${membridgeVersion()}`,
    `cmd=${cmd.command}`,
    `args=${(cmd.args || []).join(' ')}`,
    `env=${Object.keys(cmd.env || {}).sort().map(k => `${k}=${cmd.env[k]}`).join(',')}`,
    `bin=${mcpSetting(config, 'claudeBin') || ''}`,
    `rec=${mcpSetting(config, 'claudeBinRecorded') || ''}`,
    `auto=${mcpSetting(config, 'autoRegister') === false ? 'off' : 'on'}`,
  ];
  for (const agent of agentConfig.knownAgents({ config })) {
    let r = null;
    try {
      r = agentConfig.resolveAgentConfig(agent, { config, env, home: opts.home, platform: opts.platform });
    } catch { r = null; }
    parts.push(`${agent}=${r ? `${r.file}:${r.exists ? 1 : 0}` : '-'}`);
  }
  return parts.join('|');
}

function lastRegistration() {
  try {
    const rec = util.loadState()[STATE_KEY];
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

// Read-modify-write against the live state rather than a caller-held copy: the
// daemon writes state.json on every tick, and this runs alongside it.
function saveRegistration(rec) {
  try {
    util.saveState({ ...util.loadState(), [STATE_KEY]: rec });
  } catch { /* a registration report is never worth failing a launch over */ }
}

const stamp = (mode, fingerprint, rows) => ({
  mode, at: new Date().toISOString(), version: membridgeVersion(), fingerprint, rows,
});

// INSTALL-TIME ONLY (plan Task 7 Step 1). install.sh runs in the user's own
// shell, where `claude` resolves without searching -- that is the whole reason
// registration happens there rather than being left to the daemon. Recording
// what it found is what lets every later launch skip the login-shell query.
//
// Only a 'shell' answer is recorded, and that restriction is the point:
//   'config'   the user already named it; re-recording it would just make a
//              second copy of their setting that can drift from it.
//   'recorded' nothing new was learned.
//   'probe'    a GUESS from a fixed list. It cannot see nvm/volta/asdf, so on a
//              machine where an old /usr/local/bin/claude happens to exist it
//              would pin that one FOREVER -- it exists, so the stale-record
//              check never discards it -- while the user's real binary moves
//              with their version manager. A wrong cached path is worse than
//              no cached path: the miss is loud, the wrong hit is silent.
function recordClaudeBin(binPath) {
  try {
    const raw = util.loadUserConfig();
    const mcp = (raw.mcp && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)) ? raw.mcp : {};
    if (mcp.claudeBinRecorded === binPath) return false;
    util.saveUserConfig({ ...raw, mcp: { ...mcp, claudeBinRecorded: binPath } });
    return true;
  } catch {
    return false; // an unwritable config costs the cache, never the install
  }
}

const safeFingerprint = opts => { try { return registrationFingerprint(opts); } catch { return null; } };

// Explicit registration. Records the resolved binary and clears any earlier
// opt-out, because running this command IS the opt back in.
function registerNow(opts = {}) {
  const resolve = opts.resolveClaudeBin || claudeBinMod.resolveClaudeBin;
  // Wrapped rather than called up front so a machine with no Claude Code never
  // pays the login-shell query at all: registerAll resolves lazily, and this
  // only observes what it actually asked for.
  let seen;
  const rows = registerAll({ ...opts, resolveClaudeBin: o => { seen = resolve(o); return seen; } });
  const recorded = (opts.recordBin !== false && seen && seen.source === 'shell')
    ? recordClaudeBin(seen.path)
    : false;
  saveRegistration(stamp('register', safeFingerprint(opts), rows));
  return { rows, recordedBin: recorded ? seen.path : null };
}

// Explicit removal. Recorded as an OPT-OUT: a user who ran `membridge
// remove-hooks` to take MemBridge out of their tools must not find it back in
// their config after the next daemon launch. `membridge mcp register` (which
// install.sh runs) is the way back in, and remove-hooks says so.
function unregisterNow(opts = {}) {
  const rows = unregisterAll(opts);
  saveRegistration(stamp('unregister', null, rows));
  return { rows };
}

// The launch path (plan Task 7 Step 3). Fail-open in every direction: it
// returns a reason rather than throwing, and its caller defers it so even the
// rare real reconcile lands behind the launch rather than in front of it.
function ensureRegistered(opts = {}) {
  try {
    if (isTestHarness(opts.env || process.env)) return { ran: false, reason: 'test-harness', rows: [] };
    const prev = lastRegistration();
    if (prev && prev.mode === 'unregister') return { ran: false, reason: 'opted-out', rows: prev.rows || [] };
    const fingerprint = registrationFingerprint(opts);
    if (prev && prev.fingerprint && prev.fingerprint === fingerprint) {
      return { ran: false, reason: 'current', rows: prev.rows || [] };
    }
    const rows = registerAll(opts);
    saveRegistration(stamp('register', fingerprint, rows));
    return { ran: true, reason: 'reconciled', rows };
  } catch (err) {
    try { util.log(`mcp auto-register skipped: ${err && err.message}`); } catch {}
    return { ran: false, reason: 'error', rows: [] };
  }
}

module.exports = {
  SERVER_NAME, TOML_TABLE, FORMATS, SPAWN_TIMEOUT_MS, STATE_KEY,
  serverCommand, isOurs, registerAll, unregisterAll,
  registerNow, unregisterNow, ensureRegistered, lastRegistration,
  registrationFingerprint, recordClaudeBin,
  // Exported for the suite and for `membridge status`, not for general use.
  // readTextConfig in particular is exported so its missing-vs-unreadable
  // classification can be asserted DIRECTLY: driven only through registerAll,
  // an unreadable fixture also breaks the write, so a swallow-everything catch
  // still reports 'failed' and the check passes for the wrong reason.
  tomlBody, jsonEntry, parseClaudeGet, readTextConfig,
};
