'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// MemBridge home holds config.json, state.json, pid + log files.
// Env vars exist so tests/CI can fully isolate; end users use config.json.
function homeDir() {
  return process.env.MEMBRIDGE_HOME || path.join(os.homedir(), '.membridge');
}
const configPath = () => path.join(homeDir(), 'config.json');
const statePath = () => path.join(homeDir(), 'state.json');
const pidPath = () => path.join(homeDir(), 'membridge.pid');
const logPath = () => path.join(homeDir(), 'membridge.log');

// Opt-in injection targets beyond the default CLAUDE.md/AGENTS.md pair, keyed
// by the config.extraTargets flag that enables each one. Off by default so
// existing repos are unaffected; toggled per-key from the dashboard or by
// hand-editing config.json.
const EXTRA_TARGETS = {
  gemini: 'GEMINI.md',
  cursor: '.cursor/rules/membridge.mdc',
  windsurf: '.windsurfrules',
  copilot: '.github/copilot-instructions.md',
};

const DEFAULT_CONFIG = {
  $docs: 'MemBridge config. targets: context files injected per project. extraTargets: opt-in booleans (gemini/cursor/windsurf/copilot) for additional tool context files, off by default. exclude: project paths/globs to skip. redact: regexes scrubbed before injection. adapters.custom: point MemBridge at any JSONL session store (see README). graph: neural-map tuning. team: Supabase backend for team sync (set via `membridge team setup`). advisor: BYOK roadmaps key + planner model. distill: Claude Code Stop-hook session summaries (`membridge setup-hooks`).',
  intervalSec: 60,
  // 7437, one above stable MemBridge's 7437, so both dashboards can run at once.
  dashboardPort: 7437,
  targets: ['CLAUDE.md', 'AGENTS.md'],
  extraTargets: { gemini: false, cursor: false, windsurf: false, copilot: false },
  exclude: [],
  // Built-in secret redaction (lib/redact.js) is on by default and covers the
  // common credential shapes (AWS/GitHub/Google/Slack/Anthropic/OpenAI keys,
  // JWTs, private keys, connection URIs, auth headers, key=value assignments)
  // plus a high-entropy backstop, emitting named [redacted:<name>] markers.
  // redactDefaults: false opts out of that whole layer. redact and redactExtra
  // are your own regex lists (empty by default, same syntax, additive); their
  // matches become a bare [redacted]. All run through digest.redactText,
  // defaults first, before anything is written or pushed.
  redactDefaults: true,
  redact: [],
  redactExtra: [],
  maxPrompts: 8,
  maxFiles: 10,
  maxSessions: 5,
  // Injected teammate context (team sync): the context block carries at most
  // teamInjectMax pulled entries — the newest per teammate session — and none
  // older than teamMaxAgeHours. Trims only the injected slice; state and the
  // dashboard feed keep the full pulled history.
  teamInjectMax: 8,
  teamMaxAgeHours: 72,
  maxStoredEvents: 1000,
  // Token-measurement plumbing (usage events) is capped SEPARATELY from
  // narrative history, so a busy project's API-call rows can never evict the
  // prompts/edits/summaries memory is built from. See lib/digest.js.
  maxPlumbingEvents: 2000,
  // Read events get their own budget again, because usage outnumbers them
  // ~47:1 and was consuming the shared one almost entirely (measured: 1,958
  // usage rows against 42 reads). Recall needs reads to survive for DAYS --
  // a cross-session repeat read is only visible if the first read is still in
  // the window when the second one lands. See lib/digest.js.
  maxReadEvents: 2000,
  graph: { minSimilarity: 0.18, maxIdeaLinks: 3, maxChats: 500 },
  writeProjectMemory: true,
  maxEntries: 100,
  maxIndexFiles: 2000,
  // Team sync backend (Supabase project URL + anon public key). Empty means
  // team sync is off; login credentials live in credentials.json, never here.
  team: { url: '', anonKey: '' },
  // BYOK advisor (roadmaps): key + planner model, set from the dashboard
  // Settings screen. The key never leaves this file (chmod 600 once present);
  // ANTHROPIC_API_KEY env is honored as a fallback.
  advisor: { apiKey: '', model: 'claude-haiku-4-5' },
  // Session distillation (Claude Code Stop hook, `membridge setup-hooks`):
  // minEdits is how many edit events a session needs before the first summary
  // is asked for on stop; checkpointEvery re-asks once every that-many further
  // edits, so a long session keeps its summary current instead of freezing.
  //
  // checkpointEvery is deliberately NOT small. Only the newest checkpoint is
  // ever shown -- the CLAUDE.md block, memory.md and the team push all carry
  // just the latest -- so every earlier one is overwritten. Measured over 56
  // real sessions at the old default of 4: 166 summaries written, 56 used,
  // 110 discarded. Each costs the agent ~536 output tokens and surfaces one
  // scary-looking "Stop hook blocking error" block to the user, which is a
  // poor trade for a tool that sells token savings. What the re-asks really
  // buy is insurance: if a session dies without a clean stop, the newest
  // checkpoint is the prose that survives (the daemon captures the edit
  // events either way, so only the narrative is at risk). 12 keeps that
  // insurance at roughly a dozen edits' granularity for about half the cost.
  distill: { enabled: true, minEdits: 1, checkpointEvery: 12, consent: null },
  // Anonymous net-negative diagnostics (spec §8.5, Task 9): on by default --
  // see lib/diagnostics.js. `recall.pausedProjects` (below) is written by
  // that module, never hand-edited; it is separate from `recall.enabled`,
  // the global recall kill switch lib/recall.js reads.
  diagnostics: { enabled: true },
  recall: { pausedProjects: [] },
  indexIgnore: [
    // Both memory dirs are ignored: a project may also carry a stable
    // MemBridge .membridge/ dir, and neither edition should index the other's.
    '.git', 'node_modules', '.membridge', '.membridge', 'dist', 'build', 'out', '.next',
    '.nuxt', '.venv', 'venv', '__pycache__', 'target', 'coverage',
    '.idea', '.vscode', '.DS_Store',
  ],
  adapters: {
    'claude-code': { enabled: true },
    codex: { enabled: true },
    custom: [],
  },
};

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra !== undefined ? extra : base;
  if (base && extra && typeof base === 'object' && typeof extra === 'object') {
    const out = { ...base };
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
    return out;
  }
  return extra !== undefined ? extra : base;
}

// Write a starter config on first run so users have something to edit.
function ensureConfig() {
  fs.mkdirSync(homeDir(), { recursive: true });
  if (!fs.existsSync(configPath())) {
    fs.writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 2));
    return;
  }
  // Starter configs written before the graph feature materialized the old
  // maxStoredEvents default (200), which would starve the neural map of
  // history; the missing graph key marks such configs. One-time lift.
  const raw = loadUserConfig();
  if (raw.graph === undefined && raw.maxStoredEvents === 200) {
    raw.maxStoredEvents = DEFAULT_CONFIG.maxStoredEvents;
    raw.graph = DEFAULT_CONFIG.graph;
    saveUserConfig(raw);
  }
}

// Parse config.json. Missing file -> {} (safe default, nothing to lose).
// Unreadable or unparseable file -> throw, so callers refuse to write over
// it. config.json holds team credentials, the advisor API key and custom
// redact/exclude rules -- every real caller is a read-modify-write
// (toggleProject, saveSettings: load -> mutate -> save), so misreading a
// transient failure (an AV lock, EMFILE, a momentary EIO) as "no file yet"
// would make the mutate step start from {} and the save step below destroy
// everything the read failure hid. ONLY a genuinely absent file (ENOENT) is
// safe to default -- every other failure, including a present-but-corrupt
// file, means something IS there that must not be silently discarded. Same
// rule as lib/hooks.js's readSettings (see its own comment).
function loadUserConfig() {
  const p = configPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`refusing to touch ${p}: it exists but could not be read (${err && err.code}) — fix its permissions first`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to touch ${p}: it is not valid JSON — fix or remove it first`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`refusing to touch ${p}: expected a JSON object at the top level`);
  }
  return parsed;
}

// Everything under the home dir is private: API keys, captured prompt text,
// the TOFU pin store, session credentials. Create it 0700 and repair the mode
// on every use, so installs that predate this are fixed too (mkdir's mode
// applies only when it actually creates the directory).
function ensureHomeDir() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

// Monotonic per-process counter so two saveUserConfig calls in the same tick
// never collide on the temp path; combined with the pid, two daemons (app +
// CLI) writing config.json at once can't collide on it either.
let saveUserConfigCounter = 0;

// Atomic write: serialize, write to a throwaway temp file in the same
// directory as config.json, then rename it into place. Rename on the same
// filesystem is atomic on POSIX/macOS, so a crash or write error can only
// ever leave a stray temp file behind -- the real config.json is either the
// old good version or the new one, never a half-written mix that would lose
// team credentials, the advisor API key or custom redact rules. Mirrors
// saveState's pattern below.
//
// This is only safe alongside loadUserConfig's ENOENT-only "safe to default"
// rule above: a rename needs only the DIRECTORY writable, not the file, so
// nothing at THIS layer stops it replacing a config.json this process could
// never read. loadUserConfig refusing everything but ENOENT is the only
// guard against that -- do not weaken it without checking here too (same
// historical trap as lib/hooks.js's writeSettings: making the writer atomic
// while the reader still conflated missing-with-failed turned a latent bug
// into live destruction).
function saveUserConfig(raw) {
  ensureHomeDir();
  const target = configPath();
  const data = JSON.stringify(raw, null, 2); // throws (e.g. circular refs) before anything touches disk
  const tmp = path.join(path.dirname(target), `.config.json.${process.pid}.${saveUserConfigCounter++}.tmp`);
  try {
    // 0600 on the temp file, which rename carries over to config.json: this
    // file holds team credentials, the advisor API key and custom redact
    // rules and must not be world-readable.
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
    // SECURITY: unconditional repair, not just on creation. This used to
    // chmod only when the LEGACY advisor.apiKey field was set, but the
    // multi-provider path stores keys at advisor.providers[<id>].apiKey and
    // deletes the legacy field — so the guard never fired and a file full of
    // API keys sat at 0644. Belt-and-suspenders on top of the temp file's own
    // mode, in case an old config.json this rename replaced was ever wider.
    try { fs.chmodSync(target, 0o600); } catch {}
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
}

// Effective config: defaults < config.json < env vars. Read fresh each call so
// dashboard edits take effect without restarting the daemon.
function getConfig() {
  const cfg = deepMerge(DEFAULT_CONFIG, loadUserConfig());
  if (process.env.MEMBRIDGE_TARGETS) {
    cfg.targets = process.env.MEMBRIDGE_TARGETS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.MEMBRIDGE_INTERVAL) {
    cfg.intervalSec = parseInt(process.env.MEMBRIDGE_INTERVAL, 10) || cfg.intervalSec;
  }
  if (process.env.MEMBRIDGE_PORT) {
    cfg.dashboardPort = parseInt(process.env.MEMBRIDGE_PORT, 10) || cfg.dashboardPort;
  }
  cfg.adapters = cfg.adapters || {};
  cfg.adapters['claude-code'] = cfg.adapters['claude-code'] || {};
  cfg.adapters.codex = cfg.adapters.codex || {};
  if (process.env.MEMBRIDGE_CLAUDE_DIR) cfg.adapters['claude-code'].dir = process.env.MEMBRIDGE_CLAUDE_DIR;
  if (process.env.MEMBRIDGE_CODEX_DIR) cfg.adapters.codex.dir = process.env.MEMBRIDGE_CODEX_DIR;
  cfg.intervalSec = Math.max(15, cfg.intervalSec);
  return cfg;
}

// config.targets plus any opt-in extraTargets whose flag is on, deduped.
// This is what every injection/removal loop should iterate — config.targets
// itself stays the plain user-edited base list.
function effectiveTargets(config) {
  const extra = (config && config.extraTargets) || {};
  const out = [...((config && config.targets) || [])];
  for (const key of Object.keys(EXTRA_TARGETS)) {
    const file = EXTRA_TARGETS[key];
    if (extra[key] && !out.includes(file)) out.push(file);
  }
  return out;
}

// Bumped when the state shape changes. Discarding pre-v2 state intentionally
// forces a full rescan of every transcript from byte 0, rebuilding history
// with per-chat session ids (transcripts are the source of truth, so nothing
// is lost).
const STATE_VERSION = 2;

// Catch-Up read pointer: when the user last marked Home "caught up" (lastViewedTs),
// the prior pointer for one-step undo (prevViewedTs), and the cached AI briefing
// (Phase 2 writes { text, generatedAt, since } here; null until generated).
const DEFAULT_CATCHUP = { lastViewedTs: null, prevViewedTs: null, briefing: null };

// Post-install feedback nudges (local-only, no telemetry): whether the first-run
// and value-moment messages have been shown, and a running count of context-file
// amendments that gates the value moment. See lib/prompts.js.
const DEFAULT_FEEDBACK = { firstRunShown: false, valueShown: false, amendments: 0 };

function freshState() {
  return { version: STATE_VERSION, files: {}, projects: {}, catchup: { ...DEFAULT_CATCHUP }, feedback: { ...DEFAULT_FEEDBACK } };
}

// Parse state.json. Missing file -> a fresh state (safe default, nothing to
// lose). Unreadable or unparseable file -> throw, so callers refuse to write
// over it -- same rule as loadUserConfig above, for the same reason: every
// real caller (scan.js's syncOnce and friends) is a read-modify-write, and
// misreading a transient failure as "no file yet" would silently discard
// every tracked project's history the moment the next save lands. A version
// mismatch or pre-v2 shape is a DIFFERENT, intentional case (not corruption):
// the file was read fine, it is just an old schema this code deliberately
// rebuilds from the transcripts (nothing is lost -- they are the source of
// truth), so that stays a reset rather than a refusal.
function loadState() {
  const p = statePath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return freshState();
    throw new Error(`refusing to touch ${p}: it exists but could not be read (${err && err.code}) — fix its permissions first`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to touch ${p}: it is not valid JSON — fix or remove it first`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`refusing to touch ${p}: expected a JSON object at the top level`);
  }
  if (state.version !== STATE_VERSION) return freshState();
  // A pre-v2 daemon that outlived an npm upgrade round-trips the version
  // stamp but appends events without session ids. Treat such state as
  // pre-v2: discard it so the next sync rebuilds from the transcripts.
  for (const proj of Object.values(state.projects || {})) {
    for (const e of (proj && proj.events) || []) {
      if (!e || !e.session) return freshState();
    }
  }
  return {
    ...state,
    catchup: { ...DEFAULT_CATCHUP, ...(state.catchup || {}) },
    feedback: { ...DEFAULT_FEEDBACK, ...(state.feedback || {}) },
  };
}

// Monotonic per-process counter so two saveState calls in the same tick never
// collide on the temp path; combined with the pid, two daemons (app + CLI)
// writing state.json at once can't collide on it either.
let saveStateCounter = 0;

// Atomic write: serialize, write to a throwaway temp file in the same
// directory as state.json, then rename it into place. Rename on the same
// filesystem is atomic on POSIX/macOS, so a crash or write error can only
// ever leave a stray temp file behind — the real state.json is either the
// old good version or the new one, never a half-written mix. Signature,
// return value (undefined) and error-propagation contract are unchanged: a
// failure here still throws to the caller exactly as the old direct write did.
function saveState(state) {
  ensureHomeDir();
  const target = statePath();
  const data = JSON.stringify(state, null, 2); // throws (e.g. circular refs) before anything touches disk
  const tmp = path.join(path.dirname(target), `.state.json.${process.pid}.${saveStateCounter++}.tmp`);
  try {
    // 0600 on the temp file, which rename carries over to state.json: this
    // file holds captured prompt text and must not be world-readable.
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o600); } catch {} // repair a pre-existing 0644 state.json
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
}

function log(msg) {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // logging must never crash the daemon
  }
}

function walkFiles(dir, ext, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, ext, out);
    else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

const IS_WIN = process.platform === 'win32';
function normPath(p) {
  const r = path.resolve(String(p));
  return IS_WIN ? r.toLowerCase() : r;
}
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// exclude entries: exact path, parent path, or glob with '*'
function isExcluded(projectPath, config) {
  const p = normPath(projectPath);
  for (const raw of config.exclude || []) {
    if (!raw) continue;
    const pat = IS_WIN ? String(raw).toLowerCase() : String(raw);
    if (pat.includes('*')) {
      const rx = new RegExp('^' + pat.split('*').map(escapeRx).join('.*') + '$');
      if (rx.test(p) || rx.test(projectPath)) return true;
    } else {
      const n = normPath(pat);
      if (p === n || p.startsWith(n + path.sep)) return true;
    }
  }
  return false;
}

// True when `p` lives in throwaway space — an agent scratchpad or a Claude
// per-session temp root — so its edits are never attributed to a real project
// (the phantom "AI" project bug: scratchpad edits resolve to no tracked root
// and get pinned to the daemon's cwd). The `scratchpad` path segment is the
// reliable, root-agnostic signal; the `/private/tmp/` + `/tmp/claude-` prefixes
// catch Claude's mac/Linux temp roots, matched against the RAW path (not
// drive-resolved) so a POSIX-style path is still recognized when membridge
// itself runs on Windows (e.g. a teammate's synced path). `<tmpdir>\claude\`
// catches Claude's own Windows temp root the same way. os.tmpdir() itself is
// deliberately NOT used broadly: the test suite puts its own fixtures under
// os.tmpdir(), so matching it would classify every test project as temp.
function isTempPath(p) {
  if (!p) return false;
  const n = normPath(p);
  if (n.split(path.sep).includes('scratchpad')) return true;
  const raw = String(p).replace(/\\/g, '/');
  if (raw.startsWith('/private/tmp/') || raw.startsWith('/tmp/claude-')) return true;
  if (IS_WIN) {
    const tmp = normPath(os.tmpdir());
    if (n.startsWith(tmp + path.sep + 'claude' + path.sep)) return true;
  }
  return false;
}

// Per-project kill switch: drop a `.membridge-off` file in the project root.
function isProjectOff(projectPath, config) {
  if (isExcluded(projectPath, config)) return true;
  try {
    return fs.existsSync(path.join(projectPath, '.membridge-off'));
  } catch {
    return true;
  }
}

// The ONLY supported way to read a project's pulled teammate rows.
//
// `teamAccessLost` is stamped by lib/teamsync.js the moment the backend stops
// listing a project for this member. That pass also empties teamEntries and
// prunes the durable archive — but it only runs when the machine next syncs,
// and the whole point of the flag is the machine that never checks in again.
// Until then these rows are still on disk, and every reader of them is a
// surface that keeps serving a project this install may no longer read.
//
// Centralised deliberately: a review found the original guard covered ONE of
// five readers, and the one it missed was the worst — the injected context
// block, which does not merely answer questions about a revoked project but
// rewrites that teammate's activity into the CLAUDE.md/AGENTS.md files every
// agent reads at startup. A rule four files have to remember is a rule that
// gets forgotten, so read team rows through here and nowhere else.
function teamRowsFor(proj) {
  if (!proj || proj.teamAccessLost) return [];
  return Array.isArray(proj.teamEntries) ? proj.teamEntries : [];
}

module.exports = {
  teamRowsFor,
  homeDir, ensureHomeDir, configPath, statePath, pidPath, logPath,
  DEFAULT_CONFIG, EXTRA_TARGETS, STATE_VERSION, DEFAULT_CATCHUP, DEFAULT_FEEDBACK, ensureConfig, loadUserConfig, saveUserConfig, getConfig,
  effectiveTargets, loadState, saveState, log, walkFiles, isExcluded, isProjectOff, isTempPath, normPath,
};
