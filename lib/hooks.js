'use strict';
// Session distillation via Claude Code's Stop hook: as a session accumulates
// edits, the hook blocks the stop and asks the agent to append a checkpoint
// line to <project>/.membridge/summaries.jsonl. scan.js merges those lines
// back as high-quality kind:'summary' events (source 'Distilled').
//
// Staleness, not one-shot: the first checkpoint is asked at minEdits edits,
// and another every checkpointEvery edits after that — so a long session
// keeps its summary current instead of freezing on an early note. The hook
// only ever blocks once per stop cycle (the loop guard below).
//
// Contract (verified against docs.claude.com/en/docs/claude-code/hooks):
// the Stop hook receives a JSON payload on stdin — session_id, cwd,
// transcript_path and the top-level stop_hook_active loop guard — and blocks
// by printing {"decision":"block","reason":"..."} to stdout and exiting 0.
// A plain exit 0 with no output allows the stop.
//
// Everything in the hook path fails OPEN: a MemBridge bug must never trap a
// user's Claude Code session, so any internal error is logged and the stop
// is allowed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');
const memorydb = require('./memorydb');
const projectResolve = require('./project-resolve');
const { defaultRunGit } = require('./changes');

const SUMMARIES_FILE = 'summaries.jsonl';
const summariesPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, SUMMARIES_FILE);

// Env override so tests never touch the real ~/.claude/settings.json.
function claudeSettingsPath() {
  return process.env.MEMBRIDGE_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

// How many usable checkpoint lines summaries.jsonl already holds for this
// session (session matches, did is a non-empty string). Malformed JSON lines
// count as absent — the agent is simply asked again.
function countSummaryLines(projectPath, sessionId) {
  let raw;
  try {
    raw = fs.readFileSync(summariesPath(projectPath), 'utf8');
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.session === sessionId && typeof e.did === 'string' && e.did.trim()) n++;
    } catch {
      // malformed line: ignore
    }
  }
  return n;
}

// Retained for callers that only care whether any checkpoint exists.
function hasSummaryLine(projectPath, sessionId) {
  return countSummaryLines(projectPath, sessionId) > 0;
}

// n is the count of checkpoints already written for this session. The first
// (n === 0) asks for a summary of the whole session; later ones ask for a
// fresh line covering only work since the previous checkpoint.
function blockReason(target, sessionId, n) {
  const scope = n > 0
    ? `cover ONLY the work done since your previous summary line for this session (${n} already written) — do not repeat or modify earlier lines`
    : 'summarize what you accomplished this session';
  return 'MemBridge session distillation: before stopping, append exactly ONE new line of JSON to ' +
    `${target} (create the .membridge directory if it does not exist; do not modify existing lines): ` +
    `{"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","goal":"...","did":"...","decisions":"...","gotchas":"...","highlights":[{"file":"<path>","note":"..."}]} ` +
    `— goal: 1 short line on what you set out to do; ` +
    `did: 1-3 plain-text sentences that ${scope}; ` +
    'decisions: key choices a teammate would need to know, or ""; ' +
    'gotchas: surprises or pitfalls you hit, or ""; ' +
    'highlights: up to 2 of the most important files with a short note each, or []. ' +
    'Only what a teammate needs — no markdown. Then stop again.';
}

// `membridge hook stop` — reads the Stop-hook payload from stdin and either
// allows the stop (exit 0, no output) or blocks it once with instructions.
function runStop() {
  try {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      return; // no/garbled payload: not a real hook invocation, allow
    }
    if (!payload || typeof payload !== 'object') return;
    // NEVER block twice: a prior block already asked for the summary.
    if (payload.stop_hook_active === true) return;

    const config = util.getConfig();
    const distill = config.distill || {};
    if (distill.enabled === false) return;

    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    if (!cwd || !sessionId) return;

    const state = util.loadState();
    const scan = require('./scan'); // lazy: scan.js requires this module back
    // The session's edits may live under a project other than cwd (it was
    // launched elsewhere). Resolve the dominant tracked root from this
    // session's edit events; fall back to the cwd project.
    const tracked = scan.trackedRoots(state);
    // NOTE: this resolves dominance over the session's FULL accumulated edit
    // history, whereas scan.js re-homes each pass's events by that pass's
    // dominant root. For a rare multi-repo session whose edit balance flips
    // across daemon passes, the distilled summary lands in the overall-dominant
    // project while an earlier pass's prompt may sit under a different one.
    // Accepted: both are real roots the session touched; no data is lost.
    const allEvents = [];
    for (const pk of Object.keys(state.projects || {})) {
      for (const e of state.projects[pk].events || []) allEvents.push(e);
    }
    // Prefer the project the session's edits resolve to; canonicalize the
    // resolved root to its actual state.projects key (normPath match) and
    // fall back to the cwd project when it isn't a tracked project.
    let key = projectResolve.sessionDominantRoot(allEvents, sessionId, tracked);
    key = (key && scan.findProjectKey(state, key)) || scan.findProjectKey(state, cwd);
    if (!key || util.isProjectOff(key, config)) return; // untracked or paused: never nag

    // Worthiness gate: only sessions that actually changed files are worth a
    // summary. The daemon may not have scanned the tail of this session yet;
    // undercounting fails open (no block), never traps.
    const minEdits = Number.isFinite(distill.minEdits) ? distill.minEdits : 1;
    const edits = (state.projects[key].events || [])
      .filter(e => e && e.kind === 'edit' && e.session === sessionId).length;
    if (edits < minEdits) return;

    // Staleness checkpoint: re-block once every checkpointEvery edits have
    // accumulated past the first. n = checkpoints already on disk; the next
    // is due at minEdits + n * checkpointEvery. Pure read — the daemon owns
    // state.json, so the hook writes nothing.
    const every = Number.isFinite(distill.checkpointEvery) && distill.checkpointEvery >= 1
      ? distill.checkpointEvery : 4;
    const n = countSummaryLines(key, sessionId);
    if (edits < minEdits + n * every) return;
    process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(summariesPath(key), sessionId, n) }) + '\n');
  } catch (err) {
    // fail open — log and allow the stop
    try {
      util.log(`hook stop error: ${err && err.stack ? err.stack : err}`);
    } catch {}
  }
}

// `membridge hook post-commit` — the git post-commit hook body (provenance
// reconciliation): record HEAD for the tracked project containing cwd.
// Everything FAILS OPEN (return, exit 0, nothing on stdout): a git hook must
// never block or dirty a user's commit, so an untracked cwd, a paused
// project, an empty repo, or any internal error is at most a log line. Like
// runStop, this writes NOTHING to state.json — the daemon owns it; the
// sync-side recorded-shas check converges the cursor on the next pass.
//
// The hook NEVER attributes a commit itself anymore. It used to call
// attributeCommit here, against state.json as of commit time — but a commit
// usually lands seconds after the edits that produced it, before the next
// scan tick has read them, so state.json is STALE at exactly the moment the
// hook fires. Attributing from stale state risks crediting the WRONG
// session: if session A's old events are already in state and session B's
// fresh edits to the same file are not yet scanned, the hook would see only
// A's edit and permanently (recorded shas are never re-attributed) credit
// A for B's work. So a LOCAL commit is recorded PROVISIONALLY — sessions:[],
// unattributed: its files, provisional:true — and the daemon settles it once
// its events have caught up past the commit (lib/scan.js,
// settleProvisionalCommits), always attributing from FRESH events, so it is
// always correct.
//
// Authorship gate placement (the one place the hook still decides anything):
// a commit not committed by this machine's identity (a pulled teammate
// commit, or any commit when user.email is unset — fail closed) is recorded
// unattributed-locally and SETTLED (no provisional flag) immediately, never
// provisional. This is deliberate, not an oversight: "is this commit's
// committer my local identity" is knowable and stable right now — no amount
// of future scanning changes who committed it — so there is nothing to defer.
// It also makes the settle step simpler and airtight: because a foreign
// commit is NEVER written provisional, settleProvisionalCommits never needs
// to re-check the authorship gate — by construction, everything it finds
// provisional already passed the gate as a local commit.
function runPostCommit() {
  try {
    const state = util.loadState();
    const config = util.getConfig();
    const commits = require('./commits');
    // Probe with a child of cwd: resolveRoot walks from the file's dirname.
    const hit = projectResolve.resolveTrackedKey(state, path.join(process.cwd(), '_'));
    if (!hit || util.isProjectOff(hit.key, config)) return;
    const sha = commits.headSha(hit.key);
    if (!sha) return;
    if (commits.loadCommitMap(hit.key).some(r => r.sha === sha)) return; // already recorded
    const c = commits.readCommit(hit.key, sha);
    if (!commits.isLocalCommitter(c.email, commits.gitUserEmail(hit.key))) {
      commits.recordCommit(hit.key, {
        sha, ts: c.ts, project: hit.key,
        sessions: [], unattributed: [...(c.files || [])],
      });
      return;
    }
    commits.recordCommit(hit.key, {
      sha, ts: c.ts, project: hit.key,
      sessions: [], unattributed: [...(c.files || [])],
      provisional: true,
    });
  } catch (err) {
    try {
      util.log(`hook post-commit error: ${err && err.stack ? err.stack : err}`);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// setup-hooks / remove-hooks: register the Stop hook in ~/.claude/settings.json.
// This file belongs to the user and may carry hooks MemBridge knows nothing
// about, so the rules are strict: never overwrite or reorder existing
// entries, preserve every unknown key, refuse to touch a file that does not
// parse, and only ever add/remove entries containing 'membridge'. Explicit
// opt-in command only — the daemon never installs this by itself.
// ---------------------------------------------------------------------------

const mentionsMembridge = v => JSON.stringify(v).toLowerCase().includes('membridge');

// The hook command must run without `membridge` on PATH: GUI-launched Claude
// Code sessions get a minimal PATH, and app-only installs never have a global
// CLI at all. So the command is absolute — the current runtime binary plus
// lib/membridge-hook.js, which ships in every install layout (git checkout,
// npm -g, and the app's asar; the packaged app bundles lib/ but not bin/).
// Under Electron, ELECTRON_RUN_AS_NODE makes the app binary act as plain
// Node while keeping its asar read support, so the same command shape works
// from inside the packaged app.
const quoteArg = s => `"${s}"`;
function hookCommand() {
  const script = path.join(__dirname, 'membridge-hook.js');
  const prefix = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}${quoteArg(process.execPath)} ${quoteArg(script)}`;
}

// First token of a hook command that is not an env assignment, unquoted —
// the executable the shell would run.
function commandExecutable(command) {
  const tokens = String(command).match(/"[^"]*"|\S+/g) || [];
  const exe = tokens.find(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  return exe ? exe.replace(/^"|"$/g, '') : null;
}

function executableResolves(exe) {
  if (!exe) return false;
  if (exe.includes(path.sep)) return fs.existsSync(exe);
  return String(process.env.PATH || '').split(path.delimiter)
    .filter(Boolean)
    .some(dir => {
      try {
        return fs.existsSync(path.join(dir, exe));
      } catch {
        return false;
      }
    });
}

// Every MemBridge-owned command string in the Stop hook list.
function membridgeCommands(settings) {
  const commands = [];
  for (const entry of (settings.hooks || {}).Stop || []) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && typeof h.command === 'string' && mentionsMembridge(h)) commands.push(h.command);
    }
  }
  return commands;
}

// Parse the settings file. Missing file -> empty settings; unparseable or
// unexpectedly-shaped file -> throw, so callers refuse to write over it.
function readSettings(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { settings: {}, existed: false };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`refusing to touch ${file}: it is not valid JSON — fix or remove it first`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`refusing to touch ${file}: expected a JSON object at the top level`);
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error(`refusing to touch ${file}: "hooks" is not an object`);
  }
  if (settings.hooks && settings.hooks.Stop !== undefined && !Array.isArray(settings.hooks.Stop)) {
    throw new Error(`refusing to touch ${file}: "hooks.Stop" is not an array`);
  }
  return { settings, existed: true };
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

// Installed means "will actually run": the entry must exist AND its
// executable must resolve. A stale entry (e.g. `membridge hook stop` with no
// global CLI on PATH) fails silently on every stop, so reporting it as
// installed would hide exactly the breakage this check exists to surface.
function isHookInstalled() {
  try {
    const { settings } = readSettings(claudeSettingsPath());
    return membridgeCommands(settings).some(c => executableResolves(commandExecutable(c)));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Git post-commit hook install/remove, one file per tracked repo, with the
// same safety rules as the settings.json merge above: never clobber a user's
// hook — append our one line and preserve everything else byte-for-byte;
// removal strips ONLY lines mentioning membridge and deletes the file only
// when nothing but our own scaffolding (the shebang we wrote) remains.
// ---------------------------------------------------------------------------
const postCommitCommand = () => `${hookCommand()} post-commit`;

// Only lines WE wrote are ours: they invoke the membridge-hook.js shim with
// the post-commit argument. mentionsMembridge is too broad here — a user's
// own hook line may legitimately call the membridge CLI (`membridge sync &`)
// and must never be upgraded away or stripped.
const isOurPostCommitLine = l =>
  String(l).includes('membridge-hook.js') && String(l).includes('post-commit');

// Where a repo's hooks actually live. A user who sets core.hooksPath moves
// them out of .git/hooks — install/remove MUST follow, or those users get no
// commit->session capture at all. A relative core.hooksPath is resolved
// against the repo root (git's own rule); an unset value or any git failure
// falls back to the default .git/hooks. Injected runner for offline tests.
function postCommitHookDir(projectKey, deps = {}) {
  const runGit = deps.runGit || defaultRunGit(projectKey);
  try {
    const hp = String(runGit(['config', '--get', 'core.hooksPath'])).trim();
    if (hp) return path.isAbsolute(hp) ? hp : path.join(projectKey, hp);
  } catch { /* unset (git config exits 1) or git failure: default below */ }
  return path.join(projectKey, '.git', 'hooks');
}

function postCommitHookPath(projectKey, deps = {}) {
  return path.join(postCommitHookDir(projectKey, deps), 'post-commit');
}

// Repos eligible for the hook: tracked, not paused, with a real .git dir
// (a .git FILE — worktree/submodule pointer — keeps its hooks elsewhere;
// skipped rather than guessed at).
function postCommitRepos(state, config) {
  return Object.keys((state && state.projects) || {}).filter(key => {
    if (util.isProjectOff(key, config)) return false;
    try {
      return fs.statSync(path.join(key, '.git')).isDirectory();
    } catch {
      return false;
    }
  });
}

function installPostCommitHooks() {
  const state = util.loadState();
  const config = util.getConfig();
  const cmd = postCommitCommand();
  let installed = 0, current = 0, upgraded = 0, failed = 0;
  for (const key of postCommitRepos(state, config)) {
    // Per-repo try/catch: one unwritable hooks dir (permissions, weird
    // mounts) must not abort the install for every other repo — nor block
    // the Stop-hook settings write that runs after this.
    try {
      const file = postCommitHookPath(key);
      let existing = '';
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {}
      if (existing.includes(cmd)) {
        current++;
        continue;
      }
      const stale = existing.split('\n').findIndex(isOurPostCommitLine);
      if (stale !== -1) {
        // Our line from an older install location: upgrade in place.
        const lines = existing.split('\n');
        lines[stale] = cmd;
        fs.writeFileSync(file, lines.join('\n'));
        upgraded++;
      } else if (!existing) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`);
        installed++;
      } else {
        const sep = existing.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(file, `${existing}${sep}${cmd}\n`);
        installed++;
      }
      try {
        fs.chmodSync(file, fs.statSync(file).mode | 0o755);
      } catch {}
    } catch {
      failed++;
    }
  }
  return { installed, current, upgraded, failed };
}

function removePostCommitHooks() {
  const state = util.loadState();
  let removed = 0;
  // Paused projects included on purpose: removal must reach every hook a
  // previous (pre-pause) install may have written. Per-repo try/catch for
  // the same reason as install: one broken repo must not strand the rest.
  for (const key of Object.keys((state && state.projects) || {})) {
    try {
      const file = postCommitHookPath(key);
      let existing;
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!existing.split('\n').some(isOurPostCommitLine)) continue;
      const rest = existing.split('\n').filter(l => !isOurPostCommitLine(l)).join('\n');
      if (!rest.replace(/^#!\/bin\/sh\s*/, '').trim()) {
        fs.unlinkSync(file); // only our scaffolding left — the file was ours
      } else {
        fs.writeFileSync(file, rest);
      }
      removed++;
    } catch { /* unwritable repo: skip, keep going */ }
  }
  return removed;
}

function setupHooks() {
  const file = claudeSettingsPath();
  const { settings } = readSettings(file);
  const command = hookCommand();
  const stop = (settings.hooks || {}).Stop || [];

  // Upgrade in place: any MemBridge command that differs from the current
  // resolved form (old PATH-based `membridge hook stop`, or a previous
  // install location) is rewritten; user entries are never touched.
  let upgraded = 0;
  let current = false;
  const upgradedStop = stop.map(entry => {
    if (!entry || !Array.isArray(entry.hooks)) return entry;
    const inner = entry.hooks.map(h => {
      if (!h || typeof h.command !== 'string' || !mentionsMembridge(h)) return h;
      if (h.command === command) {
        current = true;
        return h;
      }
      upgraded++;
      return { ...h, command };
    });
    return inner.some((h, i) => h !== entry.hooks[i]) ? { ...entry, hooks: inner } : entry;
  });

  // The git post-commit hook installs on every path — the Stop hook being
  // current says nothing about repos linked since the last setup run.
  const pc = installPostCommitHooks();
  const pcLine = `Git post-commit hook (commit->session provenance): ${pc.installed} installed, ${pc.upgraded} upgraded, ${pc.current} already current across tracked repos.${pc.failed ? ` ${pc.failed} repo(s) skipped (hooks dir not writable).` : ''}`;

  if (current && !upgraded) {
    return `Claude Code Stop hook already installed in ${file} — nothing changed.
${pcLine}`;
  }
  // Stop hooks take no matcher; 10s is generous for a local state read.
  const finalStop = (current || upgraded)
    ? upgradedStop
    : [...upgradedStop, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  writeSettings(file, { ...settings, hooks: { ...(settings.hooks || {}), Stop: finalStop } });
  if (upgraded) {
    return `Updated the MemBridge Stop hook command in ${file} (${upgraded} entr${upgraded === 1 ? 'y' : 'ies'} rewritten to the current install path).
${pcLine}
Undo anytime with: membridge remove-hooks`;
  }
  return `Installed the MemBridge Stop hook in ${file} (appended after your existing hooks).
On every Claude Code session stop, \`${command}\` asks the agent for a 2-3 line
summary of sessions that edited files, written to <project>/.membridge/summaries.jsonl.
${pcLine}
Undo anytime with: membridge remove-hooks`;
}

function removeHooks() {
  // Post-commit hooks come out first and unconditionally — they exist per
  // repo, independent of the settings file's state.
  const pcRemoved = removePostCommitHooks();
  const pcLine = pcRemoved
    ? `\nRemoved the git post-commit hook line from ${pcRemoved} repo(s).`
    : '';
  const file = claudeSettingsPath();
  const { settings, existed } = readSettings(file);
  if (!existed) return `No Claude Code settings file at ${file} — nothing to remove.${pcLine}`;
  const stop = (settings.hooks || {}).Stop || [];
  let removed = 0;
  const kept = [];
  for (const entry of stop) {
    // Surgical: only membridge command(s) are dropped. A user entry that
    // mixes its own hooks with ours keeps everything else; an entry left
    // with no hooks is removed whole.
    if (entry && Array.isArray(entry.hooks)) {
      const inner = entry.hooks.filter(h => !mentionsMembridge(h));
      if (inner.length === entry.hooks.length) {
        kept.push(entry); // nothing of ours inside — untouched
      } else {
        removed += entry.hooks.length - inner.length;
        if (inner.length) kept.push({ ...entry, hooks: inner });
      }
    } else if (mentionsMembridge(entry)) {
      removed++;
    } else {
      kept.push(entry);
    }
  }
  if (!removed) return `No MemBridge hook found in ${file} — nothing changed.${pcLine}`;
  settings.hooks.Stop = kept;
  if (!kept.length) delete settings.hooks.Stop;
  writeSettings(file, settings);
  return `Removed the MemBridge Stop hook from ${file} (${removed} entr${removed === 1 ? 'y' : 'ies'}); your other hooks are untouched.${pcLine}
Re-enable anytime with: membridge setup-hooks`;
}

module.exports = {
  runStop, runPostCommit, countSummaryLines, hasSummaryLine, blockReason, summariesPath, claudeSettingsPath, SUMMARIES_FILE,
  setupHooks, removeHooks, isHookInstalled, hookCommand, postCommitCommand,
};
