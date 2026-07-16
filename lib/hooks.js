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
    const allEvents = [];
    for (const pk of Object.keys(state.projects || {})) {
      for (const e of state.projects[pk].events || []) allEvents.push(e);
    }
    let key = projectResolve.sessionDominantRoot(allEvents, sessionId, tracked);
    if (!key) key = scan.findProjectKey(state, cwd);
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

  if (current && !upgraded) {
    return `Claude Code Stop hook already installed in ${file} — nothing changed.`;
  }
  // Stop hooks take no matcher; 10s is generous for a local state read.
  const finalStop = (current || upgraded)
    ? upgradedStop
    : [...upgradedStop, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  writeSettings(file, { ...settings, hooks: { ...(settings.hooks || {}), Stop: finalStop } });
  if (upgraded) {
    return `Updated the MemBridge Stop hook command in ${file} (${upgraded} entr${upgraded === 1 ? 'y' : 'ies'} rewritten to the current install path).
Undo anytime with: membridge remove-hooks`;
  }
  return `Installed the MemBridge Stop hook in ${file} (appended after your existing hooks).
On every Claude Code session stop, \`${command}\` asks the agent for a 2-3 line
summary of sessions that edited files, written to <project>/.membridge/summaries.jsonl.
Undo anytime with: membridge remove-hooks`;
}

function removeHooks() {
  const file = claudeSettingsPath();
  const { settings, existed } = readSettings(file);
  if (!existed) return `No Claude Code settings file at ${file} — nothing to remove.`;
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
  if (!removed) return `No MemBridge hook found in ${file} — nothing changed.`;
  settings.hooks.Stop = kept;
  if (!kept.length) delete settings.hooks.Stop;
  writeSettings(file, settings);
  return `Removed the MemBridge Stop hook from ${file} (${removed} entr${removed === 1 ? 'y' : 'ies'}); your other hooks are untouched.
Re-enable anytime with: membridge setup-hooks`;
}

module.exports = {
  runStop, countSummaryLines, hasSummaryLine, blockReason, summariesPath, claudeSettingsPath, SUMMARIES_FILE,
  setupHooks, removeHooks, isHookInstalled, hookCommand,
};
