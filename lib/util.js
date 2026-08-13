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
  //
  // NOTE: sharePrompts is deliberately ABSENT here and set only on a fresh
  // install (freshInstallConfig below). getConfig deep-merges this object into
  // every existing config on disk, so a default written here would silently
  // change what a pre-migration user's push carries — a privacy default must
  // never change under someone by update. teamsync.readShareMode is where the
  // absent/legacy/three-value interpretation is decided.
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
  // Hook consent (lib/hook-consent.js). The recorded answer to "may MemBridge
  // write hooks into your Claude Code settings, and may the ones already there
  // do anything": 'granted', 'declined', or null for never asked. null means
  // the launch path installs NOTHING -- `membridge setup-hooks`, the Settings
  // toggle or the first-run dialog is what turns it into an answer.
  hooks: { consent: null },
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

// The starter config for a machine that has never run MemBridge: the shared
// defaults plus the settings that are only ever chosen ONCE, at install, and
// must not move under an existing user afterwards.
//
// team.sharePrompts is the whole reason this exists. It governs one thing —
// what the sync push actually carries from a captured session:
//
//   'off'       nothing prompt-shaped uploads. Summaries, decisions, gotchas,
//               file lists and change lists still sync — those are the fields
//               a teammate row uses to be readable at all.
//   'distilled' the agent-written goal from summaries.jsonl uploads; the raw
//               user prompt (`ask`) does NOT. This is the fresh-install
//               default: distilled intent is what makes rows readable
//               without moving raw prompt text off the machine.
//   'verbatim'  raw ask AND goal both upload, redacted through the standard
//               pipeline but not clipped past the pinned wire caps.
//   (legacy)    boolean true is honored as 'verbatim' and false as 'off' by
//               teamsync.readShareMode; existing users' behavior never
//               changes under them. See docs/security/redaction-boundary.md.
//
// A new install picks 'distilled' rather than absent-in-DEFAULT_CONFIG,
// because getConfig deep-merges DEFAULT_CONFIG into every config already on
// disk — a default written there would flip the setting for people who
// installed under the old absent-by-default and never agreed to it. That is
// still true for the 'distilled' choice: it lives ONLY here, so it takes
// effect for fresh installs only, and any existing user keeps whatever they
// had (which readShareMode will interpret through the same normalizer). The
// setting stays reversible: `membridge team share-prompts <off|distilled|
// verbatim>`, or the per-session toggle in the app.
function freshInstallConfig() {
  return { ...DEFAULT_CONFIG, team: { ...DEFAULT_CONFIG.team, sharePrompts: 'distilled' } };
}

// Write a starter config on first run so users have something to edit.
function ensureConfig() {
  fs.mkdirSync(homeDir(), { recursive: true });
  if (!fs.existsSync(configPath())) {
    fs.writeFileSync(configPath(), JSON.stringify(freshInstallConfig(), null, 2));
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
  return tagSeenRevoked({ version: STATE_VERSION, files: {}, projects: {}, catchup: { ...DEFAULT_CATCHUP }, feedback: { ...DEFAULT_FEEDBACK } }, new Set());
}

// Which projects' revocations were ACTUALLY VISIBLE in the state this object
// was loaded from. Stamped here, read by lib/revocation-ledger.js reconcile at
// save time, and non-enumerable so it never reaches state.json, an API payload
// or a JSON.stringify anywhere else.
//
// It exists because "the flag is not in the state being saved" has two very
// different causes that are otherwise indistinguishable at the write boundary:
// a writer that loaded the flag and deliberately removed it (an un-revoke —
// lib/teamsync.js does this when the backend lists the project again), and a
// writer whose loaded state never had it because loadState DISCARDED the file
// below. Only the first is consent. A caller that hands saveState a state it
// built itself carries no tag, which reads as "saw nothing" — the safe answer.
const SEEN_REVOKED = Symbol('membridge.seenRevoked');
function tagSeenRevoked(state, seen) {
  try { Object.defineProperty(state, SEEN_REVOKED, { value: seen, enumerable: false, configurable: true }); } catch {}
  return state;
}
function seenRevoked(state) {
  const seen = state && state[SEEN_REVOKED];
  return seen instanceof Set ? seen : new Set();
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
//
// "Nothing is lost" holds for EVENTS and only for events. `teamAccessLost` is
// the counter-example: no transcript records a revocation, so a rescan cannot
// rebuild it, while the two caches it gates (the derived notes index and the
// durable team archive) both live outside this file and survive the discard
// untouched. That is why the fact is mirrored into
// lib/revocation-ledger.js at save time and consulted independently of this
// file -- narrowing the discard paths here would have traded this bug for the
// ones they exist to prevent.
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
  const seen = new Set();
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (proj && proj.teamAccessLost) seen.add(normPath(key));
  }
  return tagSeenRevoked({
    ...state,
    catchup: { ...DEFAULT_CATCHUP, ...(state.catchup || {}) },
    feedback: { ...DEFAULT_FEEDBACK, ...(state.feedback || {}) },
  }, seen);
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
// The deletion watermark is the one field in state.json that a last-writer-
// wins save may not lose.
//
// THE RACE, which needs nothing exotic. state.json has no locking and
// teamsync.syncTeams is one long `loadState() → await network… →
// saveState(state)` cycle, holding an in-memory copy across seconds of HTTP.
// The daemon serves /api/team/delete-my-data from that SAME process, so a
// user confirming a deletion while a pass is in flight writes
// teamDeletedThroughTs to disk and the pass then saves its stale copy over
// the top. The watermark is gone, the push cursor is back where the pass left
// it, and the next tick RE-UPLOADS everything the user just erased — while
// the audit trail says it was deleted. A 60-second tick that takes a couple of
// seconds is all the window it needs.
//
// The invariant already exists in the code that reads this field —
// teamsync.pushProject: "teamDeletedThroughTs is a fact that never moves
// backwards" — it was simply never enforced at the boundary that can break it.
// Enforcing it here covers every writer of state.json rather than the one that
// happened to be noticed, which is why this lives in saveState and not in
// syncTeams.
//
// Deliberately narrow: only projects present in BOTH copies (so an unlink that
// removed a project cannot resurrect it), only this one monotone field, and
// its two companions moved with it exactly as markTeamDataDeleted moves them —
// the push cursor cannot sit below the watermark, and the signature map
// describing deleted rows cannot come back. Any failure to read the old copy
// leaves the save byte-identical to before; a save must never fail because of
// this.
function instantAfter(a, b) {
  if (!b) return true;
  if (!a) return false;
  const x = Date.parse(a), y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x > y;
  return String(a) > String(b);
}

function preserveDeletionWatermarks(state, target) {
  const projects = (state && state.projects) || {};
  // Cheap guard so this costs nothing for a machine with no team sync: a
  // watermark is only ever written to a project that had already pushed
  // (markTeamDataDeleted skips projects with no teamPushTs), so a state where
  // nothing has ever pushed cannot have one to lose, and the read below —
  // which parses the whole file, megabytes on an active install — is skipped.
  let anyPushed = false;
  for (const proj of Object.values(projects)) {
    if (proj && (proj.teamPushTs || proj.teamDeletedThroughTs)) { anyPushed = true; break; }
  }
  if (!anyPushed) return;
  let disk;
  try {
    disk = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return; // no previous state (or unreadable) — nothing to preserve
  }
  const diskProjects = (disk && disk.projects) || {};
  for (const [key, proj] of Object.entries(projects)) {
    const mark = (diskProjects[key] || {}).teamDeletedThroughTs;
    if (!proj || !mark || !instantAfter(mark, proj.teamDeletedThroughTs)) continue;
    proj.teamDeletedThroughTs = mark;
    if (instantAfter(mark, proj.teamPushTs)) proj.teamPushTs = mark;
    delete proj.teamPushSig;
  }
}

function saveState(state) {
  ensureHomeDir();
  const target = statePath();
  // FIRST, and on `state` itself: preserveDeletionWatermarks mutates the
  // projects of the object it is handed, putting back any deletion watermark
  // this writer never saw. It has to run before reconcile so the watermarks it
  // restores are inside whatever reconcile returns.
  try { preserveDeletionWatermarks(state, target); } catch { /* never fail a save over this */ }
  // Mirror every revocation in this state out to the durable ledger before it
  // is written, and put back any the writer never saw (see
  // lib/revocation-ledger.js reconcile, and SEEN_REVOKED above). Returns the
  // state to actually persist; on a machine that has never had a revocation
  // this is the same object and the whole call is one failed stat.
  const toWrite = require('./revocation-ledger').reconcile(state);
  const data = JSON.stringify(toWrite, null, 2); // throws (e.g. circular refs) before anything touches disk
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

// The same question for DERIVED teammate content — content computed from the
// rows above and cached somewhere teamRowsFor cannot reach.
//
// There is exactly one such cache today: <project>/.membridge/
// teammate-notes.json, written once per team pull and read by three delivery
// points (lib/hooks-notes.js's SessionStart injection, lib/hooks-recall.js's
// on-contact file notes, lib/server.js's project-page card). Because it is a
// COPY rather than a reader, emptying teamEntries did nothing to it, and the
// copy has no expiry: an undelivered prose decision stays deliverable forever
// (lib/teammate-notes.js selectProse has no age filter, deliberately) and a
// file note re-fires on contact for REFIRE_DAYS past its own timestamp — never
// past the revocation. A revoked member's machine kept injecting their
// teammates' decisions into every agent session while the Projects page showed
// the project as private.
//
// It lives HERE, next to teamRowsFor, for the reason teamRowsFor exists: this
// is the one place that knows what "may no longer read this project" means, and
// a rule several files have to remember is a rule that gets forgotten.
//
// `proj` is the project's state record. Callers that already loaded state —
// which is all of them, since resolving the project needs it — pass it, and this
// costs nothing. OMITTING it does not open a hole: an omitted record is
// RESOLVED from state here rather than assumed innocent, so a caller that
// forgets the argument cannot mask a live revocation. That distinction matters,
// because the alternative (treat "unknown" as revoked) reads as safer and is
// not: it would silence teammate notes for every direct caller that happens not
// to hold a record, which is a way to lose information rather than protect it.
//
// A project with NO record is not a revoked project — it is an untracked one,
// and every delivery point has already established the project is tracked
// before it gets here. Revocation is a positive fact stamped in state; its
// absence is the ordinary case and is answered as such.
//
// NOTED, deliberately unfixed: an ABSENT record reading as "not revoked" is
// the lib/hooks.js readSettings shape — a missing file read as permission —
// applied to access control, and it is exactly what made a state.json discard
// silently un-revoke a project. Flipping the default HERE would be the wrong
// fix: it would silence every legitimate first-contact case (a project tracked
// this tick whose record has not been written yet) to close a hole that is not
// in this function. The hole is that the fact was only ever stored in a file
// this repo discards on purpose, so it is closed in the STORAGE layer — the
// ledger consulted below, which answers for a project whose record is gone.
//
// SCOPE, stated because the omission is deliberate. This answers only the
// revocation half. An UNLINKED project keeps its last pulled rows in state
// (unlinkProject stamps no flag, and syncTeams skips a project with no
// team.json entirely), so teamRowsFor keeps returning them too. The repo's
// existing answer for unlink is to prune the local copies AT THE SOURCE, which
// is what unlinkProject already does for the durable archive and now also does
// for the notes index. Adding "and is still linked" here would be a new
// invariant the row path does not hold, and on disk it is indistinguishable
// from a project that merely carries rows without a link file.
function mayServeTeammateNotes(projectPath, proj) {
  let record = proj;
  if (record === undefined) {
    try {
      record = (loadState().projects || {})[projectPath];
    } catch {
      record = undefined; // unreadable state is not evidence of a revocation
    }
  }
  if (record && record.teamAccessLost) return false;
  // The durable half: a revocation this state.json no longer remembers (it was
  // discarded and rebuilt) is still remembered here. Consulted for EVERY
  // project, not only record-less ones, because a rebuilt record looks exactly
  // like a never-revoked one.
  return !require('./revocation-ledger').isRevoked(projectPath);
}

// ---------------------------------------------------------------------------
// Liveness: is this session still running?
//
// THE definition, in one place, because there used to be two that disagreed.
// lib/provenance.js asked "was the session's newest event recent?" while the
// app asked "does this entry lack a summary?" -- and the second never looked
// at a clock, so a session that ended without landing a summary stayed green
// forever and Today counted every one of them under LIVE NOW.
//
// Note that "has a summary" is NOT the opposite of live and must never be
// used as one: the Stop hook re-summarizes a WORKING session every few edits
// (see collapseSessionCheckpoints in the app), so a session can carry several
// summaries and still be mid-flight. Recency of the last event is the only
// signal that actually tracks "still running".
//
// The window is 15 minutes, measured off this install's own history rather
// than picked for roundness (51 sessions, 1573 gaps between consecutive
// events inside a session):
//
//   * Marginal returns fall off a cliff at exactly 15 min. Widening the
//     window buys 0.317pp of extra coverage per minute up to 15, and 0.063pp
//     per minute after it -- a 5x drop at that boundary.
//   * 15 min is the p95 of the gap between consecutive events within one
//     session (p95 = 13.3 min), so a session that is genuinely working stays
//     marked live across 95.5% of its own quiet stretches.
//   * The median gap from a session's last event to the NEXT session starting
//     is 13.6 min. Past roughly that point "a new session began" is the
//     likelier reading than "the old one is still going".
//
// Three independent measures land between 13.3 and 15 min; 15 is the round
// number above all three, and the flat part of the curve means the exact
// choice inside that band costs almost nothing either way.
const LIVE_WINDOW_MS = 15 * 60 * 1000;

// Pure and clock-injected so liveness is testable without waiting or mocking.
// A missing or unparseable timestamp is NOT live: this decides whether to
// show a "still running" badge, and guessing yes on garbage input is how the
// stuck indicator looked plausible for so long.
//
// Both guards below fail CLOSED (not live), because every way this can go
// wrong ends in the same place -- a badge that is on and never goes off:
//   * `now` is validated rather than defaulted, because a caller reaching
//     this through an optional chain hands over null, not undefined, and a
//     default parameter does not fire for null. `null - t` is a large
//     negative number, which is less than the window, so a null clock would
//     have marked every entry in the feed live.
//   * A timestamp from the future is clock skew, not activity. One window of
//     tolerance either way absorbs a slightly-fast machine without letting a
//     nonsense far-future stamp hold the badge on permanently.
function isLive(ts, now) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  const ref = Number.isFinite(now) ? now : Date.now();
  const age = ref - t;
  return age < LIVE_WINDOW_MS && age > -LIVE_WINDOW_MS;
}

// GRADED presence: 'active' | 'recent' | 'idle'.
//
// isLive above is one flat 15-minute flag, which makes a row that arrived 20
// seconds ago indistinguishable from one that arrived 14 minutes ago. Every
// surface reading it therefore had to hedge on all of them equally ("never
// report this as presence"), which is both useless for the near case and
// misleading for the far one. Grading removes the need for that blanket hedge.
//
// THE ACTIVE THRESHOLD IS DERIVED, NOT PICKED. A teammate's row reaches the
// backend at most one push interval after the work itself, so a row whose
// arrival is within one interval bounds the real work at roughly two intervals
// ago -- about 90 seconds on the default 60s cadence, which is "now" by any
// practical reading. Deriving it from `intervalSec` rather than hardcoding is
// what keeps that true for a team that syncs every 10 seconds and one that
// syncs every 5 minutes; a fixed number would lie to both.
//
// Clamped to the live window so a pathologically long interval cannot stretch
// "active" past the point where the flag means anything.
//
// Fails toward IDLE on every doubtful input, for the same reason isLive fails
// closed: the expensive mistake is telling someone a teammate is at the
// keyboard when they are not. A FUTURE timestamp is never active -- it is
// clock skew or a model-authored guess (the exact bug that produced rows 69
// minutes ahead of real time), and neither is evidence of anybody working.
function presenceOf(ts, opts = {}) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 'idle';
  const ref = Number.isFinite(opts.now) ? opts.now : Date.now();
  const intervalSec = Number.isFinite(opts.intervalSec) && opts.intervalSec > 0
    ? opts.intervalSec
    : DEFAULT_CONFIG.intervalSec;
  const activeMs = Math.min(intervalSec * 1000, LIVE_WINDOW_MS);
  const age = ref - t;
  if (age < 0) return -age < LIVE_WINDOW_MS ? 'recent' : 'idle'; // skew, never presence
  if (age <= activeMs) return 'active';
  if (age < LIVE_WINDOW_MS) return 'recent';
  return 'idle';
}

// 'Distilled' is an internal label for a summary the daemon re-derived rather
// than read from the tool's own transcript; every surface that shows a tool
// name shows those rows as Codex. The dashboard's tool dropdown is built from
// these PUBLIC names, so anything matching on a tool name has to fold the same
// way or the filter silently misses every distilled row.
const publicSource = source => (source === 'Distilled' ? 'Codex' : (source || ''));

module.exports = {
  teamRowsFor, mayServeTeammateNotes, LIVE_WINDOW_MS, isLive, presenceOf, publicSource,
  homeDir, ensureHomeDir, configPath, statePath, pidPath, logPath,
  DEFAULT_CONFIG, freshInstallConfig, EXTRA_TARGETS, STATE_VERSION, DEFAULT_CATCHUP, DEFAULT_FEEDBACK, ensureConfig, loadUserConfig, saveUserConfig, getConfig,
  effectiveTargets, loadState, saveState, seenRevoked, log, walkFiles, isExcluded, isProjectOff, isTempPath, normPath,
};
