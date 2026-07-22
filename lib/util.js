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
  distill: { enabled: true, minEdits: 1, checkpointEvery: 4, consent: null },
  indexIgnore: [
    '.git', 'node_modules', '.membridge', 'dist', 'build', 'out', '.next',
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

function loadUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveUserConfig(raw) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(raw, null, 2));
  // A saved API key must not be world-readable.
  if (raw.advisor && raw.advisor.apiKey) {
    try {
      fs.chmodSync(configPath(), 0o600);
    } catch {}
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

function freshState() {
  return { version: STATE_VERSION, files: {}, projects: {}, catchup: { ...DEFAULT_CATCHUP } };
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (state.version !== STATE_VERSION) return freshState();
    // A pre-v2 daemon that outlived an npm upgrade round-trips the version
    // stamp but appends events without session ids. Treat such state as
    // pre-v2: discard it so the next sync rebuilds from the transcripts.
    for (const proj of Object.values(state.projects || {})) {
      for (const e of (proj && proj.events) || []) {
        if (!e || !e.session) return freshState();
      }
    }
    return { ...state, catchup: { ...DEFAULT_CATCHUP, ...(state.catchup || {}) } };
  } catch {
    return freshState();
  }
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
  fs.mkdirSync(homeDir(), { recursive: true });
  const target = statePath();
  const data = JSON.stringify(state, null, 2); // throws (e.g. circular refs) before anything touches disk
  const tmp = path.join(path.dirname(target), `.state.json.${process.pid}.${saveStateCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
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

module.exports = {
  homeDir, configPath, statePath, pidPath, logPath,
  DEFAULT_CONFIG, EXTRA_TARGETS, STATE_VERSION, DEFAULT_CATCHUP, ensureConfig, loadUserConfig, saveUserConfig, getConfig,
  effectiveTargets, loadState, saveState, log, walkFiles, isExcluded, isProjectOff, isTempPath, normPath,
};
