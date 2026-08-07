#!/usr/bin/env node
'use strict';
// node:sqlite is required eagerly below (bin -> lib/activity -> lib/search-index),
// and on Node 22.13-23.x the runtime greets EVERY invocation -- including
// `--version` and `--help`, the first thing a new user ever runs -- with
// "(node:NNNN) ExperimentalWarning: SQLite is an experimental feature..." plus a
// --trace-warnings hint on stderr. It reads as an error. Suppress exactly that
// one warning, in-process and before any require that could trigger it, rather
// than: re-exec with --disable-warning (an extra process spawn on every hook
// invocation, and the flag is missing before 20.11), or a blanket
// warnings-off node flag in the shebang/shim (swallows the deprecation
// warnings we DO want users to see, and shebang args don't survive the npm
// cmd shim on Windows anyway). Everything that is
// not this one warning passes through untouched. Node >= 24 stopped emitting
// it, so there the filter simply never matches.
{
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = (rest[0] && typeof rest[0] === 'object') ? rest[0].type : rest[0];
    const isExperimental =
      (warning != null && warning.name === 'ExperimentalWarning') || type === 'ExperimentalWarning';
    const text = String((warning != null && warning.message) || warning || '');
    if (isExperimental && text.includes('SQLite')) return;
    return emitWarning.apply(process, [warning, ...rest]);
  };
}
// Fast path: the Claude Code Stop hook fires on every session stop and the
// git post-commit hook on every commit — neither may pay for the full CLI
// require tree below (server, dashboard, team sync).
if (process.argv[2] === 'hook' && (process.argv[3] === 'stop' || process.argv[3] === 'post-commit' || process.argv[3] === 'recall' || process.argv[3] === 'search')) {
  // `search` (the PreToolUse Grep/Glob hook) is required on its own, not via
  // lib/hooks, for the same reason it is lazy in lib/membridge-hook.js: it
  // drags in the feed normalizers and the ranker, and the far hotter stop /
  // recall paths above must not pay for a module they never touch.
  if (process.argv[3] === 'search') { require('../lib/hooks-search').runSearch(); return; }
  const hooks = require('../lib/hooks');
  if (process.argv[3] === 'stop') hooks.runStop();
  else if (process.argv[3] === 'post-commit') hooks.runPostCommit();
  else hooks.runRecall();
  return;
}
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
// The published package name, single-sourced: anything that installs or names
// this package must read it from here, never re-type it (see cmdUpdate).
const PKG_NAME = require('../package.json').name;
const util = require('../lib/util');
const { scanAll, syncOnce, getAdapters, findProjectKey } = require('../lib/scan');
const digest = require('../lib/digest');
const memorydb = require('../lib/memorydb');
// adoptProjects comes from the same module as startServer, which this file
// already loads unconditionally, so reaching it costs nothing extra. The plan
// allowed moving these out of lib/server.js "so the CLI can reach them without
// pulling in the whole server"; that move would buy nothing while line 28
// requires the server anyway, and it would churn a file three other branches
// are editing. Revisit if the CLI ever stops loading the server eagerly.
const { startServer, adoptProjects, noteTick } = require('../lib/server');
const autostart = require('../lib/autostart');
const teamsync = require('../lib/teamsync');
const hooks = require('../lib/hooks');
const counters = require('../lib/counters');
const activity = require('../lib/activity');
const notes = require('../lib/teammate-notes');
const notesStore = require('../lib/teammate-notes-store');
const prompts = require('../lib/prompts');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = name => args.includes(name);
const opt = name => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

function readPid() {
  try {
    return parseInt(fs.readFileSync(util.pidPath(), 'utf8'), 10) || null;
  } catch {
    return null;
  }
}
// A thrown EPERM means the process EXISTS but this caller lacks the rights to
// signal it -- which is alive, not dead. Reading it as dead (the old
// `catch { return false }`) is wrong on Windows in particular: libuv's kill
// opens the target with PROCESS_TERMINATE, so a pid another process owns can
// answer EPERM. ESRCH (and anything else) is genuinely not-running. Used by
// cmdStop/cmdStatus on every platform; no subprocess (an earlier tasklist probe
// here hung the daemon on a loaded Windows runner). The duplicate-daemon guard
// in cmdDaemon does NOT rely on this on Windows -- it is gated to POSIX there.
function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Best-effort check that a live pid actually belongs to a MemBridge process.
// Aliveness alone is not enough: the OS reuses pids, and the pid file can name
// a live process that is not MemBridge -- taking that as a peer would silently
// refuse legitimate starts. Uses `ps -o command=` on unix to read the command
// line and match `/membridge/i`, which covers `node .../bin/membridge.js daemon`
// (dev), the npm shim `node .../bin/membridge daemon` (global install), and
// the Electron-invoked variants. On Windows the process image is a generic
// `node.exe` / `MemBridge.exe`, and reading a process's full command line needs
// wmic (removed on current Windows) or a PowerShell CIM query (slow, and not
// guaranteed present) -- both too fragile to gate daemon startup on. So on
// Windows we conservatively assume a live pid IS MemBridge (isRunning above
// gets Windows liveness right via the EPERM read), erring toward "refuse to
// start a second daemon" -- the alternative (two daemons racing state.json,
// which has no locking) is worse than a rare false-positive refusal a user
// clears with `membridge stop`.
function isMembridgeProcess(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') return true;
  try {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    return /membridge/i.test(r.stdout || '');
  } catch {
    return false;
  }
}

function printChanges(result) {
  for (const c of result.changes) console.log(`  ${c.action}: ${c.file}`);
  for (const s of result.skipped || []) console.log(`  skipped ${s.project} (${s.reason})`);
  if (!result.changes.length) console.log('  nothing to update');
}

function cmdSync() {
  util.ensureConfig();
  const dryRun = flag('--dry-run');
  const result = syncOnce({ dryRun, project: opt('--project') });
  console.log(`${dryRun ? '[dry run] ' : ''}${result.newEvents} new event(s), ${result.projects.length} project(s) affected`);
  printChanges(result);
  prompts.flushValueMoment(util.getConfig());
  if (!dryRun && teamsync.isConfigured(util.getConfig())) {
    return teamSyncPass({ project: opt('--project') }).catch(err => console.error(`team sync failed: ${err.message}`));
  }
}

// Post-pull teammate-notes work (rebuild for changed projects + first-install
// backfill) lives in lib/teammate-notes-store.js's afterTeamPull, because the
// tray app (app/main.js) runs its own sync loop and must run the same logic --
// the first version lived here as glue and the app never executed it.
function rebuildNotesForChanged(changed) {
  notesStore.afterTeamPull(changed);
}

// One team push/pull pass; pulled teammate entries re-render those projects'
// context blocks right away.
async function teamSyncPass(opts = {}) {
  const r = await teamsync.syncTeams(opts);
  for (const key of r.changed) syncOnce({ project: key });
  rebuildNotesForChanged(r.changed);
  for (const e of r.errors) util.log(`team sync: ${e}`);
  if (r.synced.length || r.errors.length) {
    console.log(`team sync: ${r.synced.length} project(s), ${r.changed.length} with new teammate activity${r.errors.length ? `, ${r.errors.length} error(s) (see log)` : ''}`);
  }
  return r;
}

function cmdScan() {
  util.ensureConfig();
  const config = util.getConfig();
  console.log('Read-only scan (nothing is written).\n');
  console.log('Adapters:');
  for (const a of getAdapters(config)) {
    for (const root of a.sessionRoots(config)) {
      const exists = fs.existsSync(root);
      console.log(`  ${a.displayName.padEnd(14)} ${root} ${exists ? '' : '(not found)'}`);
    }
  }
  const state = { files: {}, projects: {} }; // fresh: scan everything from byte 0
  const events = scanAll(state, config);
  digest.mergeEvents(state, events, config);
  const projects = Object.entries(state.projects);
  console.log(`\nProjects with AI activity: ${projects.length}`);
  for (const [key, proj] of projects) {
    const bySource = {};
    for (const e of proj.events) bySource[e.source] = (bySource[e.source] || 0) + 1;
    const parts = Object.entries(bySource).map(([s, n]) => `${s}: ${n}`).join(', ');
    const off = util.isProjectOff(key, config) ? '  [paused]' : '';
    console.log(`  ${key}${off}\n    ${parts}`);
  }
}

function cmdDaemon() {
  util.ensureConfig();
  const config = util.getConfig();
  fs.mkdirSync(util.homeDir(), { recursive: true });

  // Refuse to start a second daemon on top of a running one. Without this
  // guard, the unconditional pid write below silently overwrites the running
  // daemon's marker; both keep running, both scribble state.json (which has
  // NO locking -- see the state-json-cross-process-clobber landmine), and
  // only one is ever cleaned up by SIGTERM. Classic "flag recording a success
  // the code never achieved" (state-claiming-unearned-success) -- claiming to
  // be the daemon without checking whether one already exists.
  //
  // Aliveness alone is not enough; pids get reused. isMembridgeProcess()
  // reads the process command line to distinguish a real peer from a random
  // program that happened to inherit the pid. A stale pid file (dead process
  // or live-but-not-MemBridge) falls through to the normal takeover path.
  //
  // Deliberately NOT a real lockfile: the plan (locked decision #4) calls for
  // a liveness check at this scope; a lockfile is a bigger surface.
  //
  // Restart handoff exception. `POST /api/daemon/restart` replaces this daemon
  // by spawning a new `membridge daemon` while the OLD one is still alive (it
  // must outlive the request long enough to flush the response, then exits
  // ~200ms later -- see lib/server.js and api-machine.spawnReplacement). To the
  // replacement that predecessor looks exactly like a duplicate to refuse, so
  // without a signal the guard below kills the restart and the pid never
  // changes. spawnReplacement sets MEMBRIDGE_TAKEOVER=1 to authorize THIS boot
  // to take over a live daemon. It is read once and deleted so it can never
  // leak into an unrelated child this process later spawns, nor wave through a
  // genuine second daemon -- a user-run `membridge daemon` never carries it, so
  // the refusal below still fires for a real duplicate.
  const isRestartHandoff = process.env.MEMBRIDGE_TAKEOVER === '1';
  delete process.env.MEMBRIDGE_TAKEOVER;
  // POSIX-only. On Windows this liveness/refusal path is unverified and may hang
  // daemon startup: build-app's Windows CI shows the second `membridge daemon`
  // in daemon-pid-race hanging -- empty stdout/stderr, the pid never
  // overwritten, killed at the 4s timeout with status=null -- so the guard
  // neither refuses nor takes over, it just stalls. A guard that can wedge
  // startup is worse than no guard, so it is gated to POSIX until the true cause
  // is observed on a real Windows env (tracked in task #34). Windows keeps the
  // pre-0.3.2 behavior: fall through and overwrite the pid (no duplicate
  // protection, but no hang). Restart handoff still works there -- the
  // replacement simply takes over unconditionally and the pid changes. The
  // MEMBRIDGE_TAKEOVER read/delete above stays on every platform (harmless, and
  // keeps the env from leaking into a child).
  if (process.platform !== 'win32') {
    const existingPid = readPid();
    if (existingPid && isRunning(existingPid)) {
      if (isMembridgeProcess(existingPid) && !isRestartHandoff) {
        const port = config.dashboardPort;
        console.error(
          `MemBridge is already running (pid ${existingPid}, dashboard http://127.0.0.1:${port}). ` +
          `Refusing to start a second daemon -- run \`membridge stop\` first if you meant to restart.`
        );
        process.exit(1);
      }
      if (isRestartHandoff) {
        util.log(`restart handoff: taking over from daemon pid ${existingPid}`);
      } else {
        util.log(`pid file names live but non-MemBridge process ${existingPid}; taking over (stale)`);
      }
    } else if (existingPid) {
      util.log(`pid file names dead process ${existingPid}; taking over (stale)`);
    }
  }

  fs.writeFileSync(util.pidPath(), String(process.pid));
  util.log(`daemon started (pid ${process.pid}, interval ${config.intervalSec}s, v${pkg.version})`);

  // Reconcile the Claude Code hooks on every daemon boot, so a consented
  // install stays current however MemBridge was installed (git clone, npm,
  // curl). Silent and fail-open — never blocks the daemon.
  //
  // It no longer INSTALLS on its own say-so: a machine that has never been
  // asked, and one that opted out with `remove-hooks`, both get nothing
  // written (#48/#49). There is no dialog on this path, so say so once in the
  // log rather than leaving a CLI user wondering why no summaries appear —
  // silence is what made the old behaviour invisible in the first place.
  const { registration, consent } = hooks.ensureInstalled() || {};
  if (registration === 'no-consent') {
    util.log(consent === 'declined'
      ? 'Claude Code hooks are turned off for this machine — nothing was written to your settings (`membridge setup-hooks` re-enables them)'
      : 'Claude Code hooks are not installed and nothing was written to your settings — run `membridge setup-hooks` to enable session summaries, recall and teammate notes');
  }

  const cleanup = () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(util.pidPath());
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const tick = () => {
    try {
      // An npm upgrade can migrate the state while this daemon keeps running:
      // never write a state version this code did not produce — exit instead
      // so a restart picks up the new code.
      let onDisk = null;
      try {
        onDisk = JSON.parse(fs.readFileSync(util.statePath(), 'utf8'));
      } catch {}
      if (onDisk && typeof onDisk.version === 'number' && onDisk.version > util.STATE_VERSION) {
        util.log(`state v${onDisk.version} is newer than this daemon writes (v${util.STATE_VERSION}); exiting for restart`);
        cleanup();
        return;
      }
      const r = syncOnce();
      if (r.changes.length) {
        util.log(`sync: ${r.newEvents} new event(s) -> ${r.changes.map(c => c.file).join('; ')}`);
      }
      // Keep the BM25 search index current here, AFTER syncOnce has landed
      // this round's events, so a search never has to refill it on the user's
      // time. Cheap when nothing moved (one stat per project, no writes), and
      // it swallows its own errors — a search-index problem must not stop
      // memory from syncing.
      const idx = activity.refreshSearchIndex();
      if (idx && idx.refreshed) util.log(`search index: refreshed ${idx.refreshed} project(s)`);
      // Logged separately from `refreshed`: this one DELETES rows (a project
      // that was paused, archived, marked off or removed), and a deletion
      // nothing records is a deletion nobody can explain afterwards.
      if (idx && idx.purged) util.log(`search index: purged ${idx.purged} hidden/removed project(s)`);
      teamTick();
      countersTick();
      // Record that a pass completed, so /api/status can report the sync loop's
      // real state instead of asserting a healthy one. This covers the
      // SYNCHRONOUS work above (local sync + search index) and claims nothing
      // about teamTick/countersTick, which are fire-and-forget and surface
      // their own outcomes through state (teamLastSync, teamAuthPaused).
      noteTick({ ok: true });
    } catch (err) {
      util.log(`sync error: ${err.stack || err}`);
      // A throwing pass is NOT a dead loop — this catch is why the loop keeps
      // going — so it is recorded as erroring rather than left to age into
      // "stalled", which would describe the wrong problem.
      noteTick({ ok: false, error: err.message });
    }
  };
  // Anonymous product-health counters, on the same tick and guarded the same
  // way. emitCounters decides internally whether anything is actually worth
  // sending (state change, or once a day) — calling it every pass is cheap and
  // keeps the cadence logic in one place. Cannot block or fail the sync: it
  // swallows its own errors and this adds a second net.
  let countersBusy = false;
  const countersTick = () => {
    if (countersBusy) return;
    countersBusy = true;
    // The MCP process itself never calls out to the network (lib/mcp.js) —
    // it only tallies locally (lib/mcp-usage.js). This daemon reads that
    // tally on its own existing cadence and folds it into the same payload.
    const mcpToolsUsed = require('../lib/mcp-usage').toolsUsedWithin(24 * 3600000, {});
    counters.emitCounters(util.loadState(), util.getConfig(), { registration, mcpToolsUsed })
      .catch(err => util.log(`counters error: ${err && err.message}`))
      .finally(() => { countersBusy = false; });
  };
  // Team sync rides the same tick, guarded so a slow network round cannot
  // overlap the next one. Best-effort: errors are logged, local sync is never
  // blocked by the backend being unreachable.
  let teamBusy = false;
  const teamTick = () => {
    if (teamBusy || !teamsync.isConfigured(util.getConfig())) return;
    teamBusy = true;
    teamsync.syncTeams()
      .then(r => {
        for (const key of r.changed) syncOnce({ project: key });
        rebuildNotesForChanged(r.changed);
        for (const e of r.errors) util.log(`team sync: ${e}`);
        if (r.changed.length) util.log(`team sync: pulled teammate activity into ${r.changed.length} project(s)`);
      })
      .catch(err => util.log(`team sync error: ${err.message}`))
      .finally(() => { teamBusy = false; });
  };
  // Chained timeout instead of setInterval: the delay is re-read from config
  // each round, so an interval change in Settings applies from the next check
  // without restarting the daemon.
  const schedule = () => setTimeout(() => {
    tick();
    schedule();
  }, util.getConfig().intervalSec * 1000);
  tick();
  schedule();
  startServer(config.dashboardPort);
}

// A killed daemon whose parent has not reaped it yet (kill -9, then `start`
// within the ~1-2s reap window) is a zombie: kill(pid, 0) still succeeds, so
// isRunning() reads it as alive and cmdStart refuses a perfectly good start.
// `ps -o stat=` reports state Z for exactly that window, and a LIVE daemon is
// never state Z, so treating Z as dead cannot weaken the duplicate-daemon
// guard in cmdDaemon (which is POSIX-gated and, independently, already treats
// a zombie as stale: its `ps -o command=` probe sees `<defunct>`, not
// "membridge"). win32 has no zombies and no ps; callers gate on platform.
function isZombie(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    return /^Z/.test((r.stdout || '').trim());
  } catch {
    return false;
  }
}

function cmdStart() {
  const pid = readPid();
  if (isRunning(pid) && !isZombie(pid)) {
    console.log(`MemBridge is already running (pid ${pid}).`);
    return;
  }
  util.ensureConfig();
  const out = fs.openSync(util.logPath(), 'a');
  const child = spawn(process.execPath, [__filename, 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  const config = util.getConfig();
  console.log(`MemBridge daemon started in the background (pid ${child.pid}).`);
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);
  // First-run + any due value-moment nudge, on the interactive foreground
  // command (never in the detached daemon's logfile — see lib/prompts.js).
  prompts.maybeFirstRun(config);
  prompts.flushValueMoment(config);
}

function cmdStop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    // The daemon is gone but its pid file may not be: a crash or kill -9 never
    // reaches cmdDaemon's cleanup handler. Leaving the stale file means every
    // later stop/status re-reads a dead pid forever; clear it now so the next
    // start begins from a clean slate.
    if (pid) {
      try { fs.unlinkSync(util.pidPath()); } catch {}
    }
    console.log('MemBridge is not running.');
    return;
  }
  process.kill(pid);
  try {
    fs.unlinkSync(util.pidPath());
  } catch {}
  console.log(`Stopped MemBridge (pid ${pid}).`);
}

function cmdStatus() {
  const config = util.getConfig();
  const state = util.loadState();
  const pid = readPid();
  const running = isRunning(pid);
  console.log(`MemBridge v${pkg.version}`);
  console.log(`Daemon:    ${running ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Dashboard: http://127.0.0.1:${config.dashboardPort}${running ? '' : ' (offline)'}`);
  console.log(`Home:      ${util.homeDir()}`);
  console.log(`Interval:  ${config.intervalSec}s   Targets: ${util.effectiveTargets(config).join(', ')}`);
  console.log(`Autostart: ${autostart.isEnabled() ? 'enabled' : 'disabled'}`);
  const distillOn = !config.distill || config.distill.enabled !== false;
  // "not installed" now has two very different causes, and a status line that
  // conflated them would send an opted-out user hunting a bug: nobody has been
  // asked yet, or they said no and MemBridge is honouring it.
  const consentState = hooks.hookConsent.state(config);
  const notInstalled = consentState === 'declined'
    ? 'not installed (hooks turned off for this machine; `membridge setup-hooks` re-enables)'
    : 'not installed (run `membridge setup-hooks`)';
  console.log(`Distill:   ${distillOn ? 'enabled' : 'disabled'}, Claude Code hook ${hooks.isHookInstalled() ? 'installed' : notInstalled}`);
  printEffectiveHook();
  printCaptureHealth(config);
  printMcpStatus(config);
  const encOn = ((config.team || {}).encrypt !== false);
  const keyAlerts = Array.isArray(state.keyAlerts) ? state.keyAlerts.length : 0;
  let encLine = encOn ? 'on (E2E, fail-closed)' : 'OFF, plaintext sync (explicit team.encrypt=false hatch)';
  if (encOn && state.teamCryptoPaused) encLine += `, PAUSED: ${state.teamCryptoPaused}`;
  if (keyAlerts) encLine += `, ${keyAlerts} KEY ALERT(S): verify with \`membridge team fingerprint\`, then \`membridge team trust\``;
  console.log(`Encrypt:   ${encLine}`);
  const projects = Object.entries(state.projects || {});
  console.log(`Projects:  ${projects.length}`);
  let captured = 0;
  for (const [key, proj] of projects) {
    const paused = util.isProjectOff(key, config) ? ' [paused]' : '';
    const events = (proj.events || []).length;
    captured += events;
    // A project MemBridge has nothing for must not read like an active one:
    // that sameness is what makes a working install look broken.
    const detail = events
      ? `${events} event(s), last sync ${proj.lastSync || 'never'}`
      : emptyProjectDetail(proj);
    console.log(`  ${key}${paused}, ${detail}`);
  }
  if (!captured) printEmptyState(config, running);
  prompts.flushValueMoment(config);
}

// WHICH copy of MemBridge actually runs when a session stops.
//
// `membridge status` reports on the process you just launched; the hook that
// fires reports to whatever absolute path is in ~/.claude/settings.json. Those
// are routinely different copies (an installed app plus a dev checkout is the
// normal developer setup) and until this line existed the difference was
// inferable only by reading three files by hand. It matters because the
// registered copy is the one whose prompt, caps and checkpoint rule decide
// what gets captured — editing the other one changes nothing.
function printEffectiveHook() {
  let e;
  try { e = hooks.effectiveHooks(); } catch { return; }
  if (!e) return;
  if (e.error) {
    console.log(`Hook:      cannot read ${e.file}: ${e.error}`);
    return;
  }
  const stop = e.stop || {};
  if (!stop.registered) {
    console.log(`Hook:      no Stop hook registered in ${e.file}`);
    return;
  }
  const version = stop.version ? `v${stop.version}` : 'version unstamped';
  const note = stop.vintage === 'newer'
    ? ` — NEWER than this install (v${e.self.version}); do not "update", that is a downgrade`
    : stop.vintage === 'outdated'
      ? ` — older than this install (v${e.self.version}); \`membridge setup-hooks\` refreshes it`
      : '';
  console.log(`Hook:      Stop runs ${stop.script || '(unparseable command)'} (${version})${note}`);
  if (stop.wrapper) console.log(`           via wrapper: ${stop.wrapper}`);
  if (!stop.live) console.log('           WARNING: that command does not resolve — every stop is silently doing nothing');
  if (stop.script && e.self.script && path.resolve(stop.script) !== path.resolve(e.self.script)) {
    console.log(`           this install: ${e.self.script} (v${e.self.version}) — NOT the code that runs on a stop`);
  }
}

// Did capture actually happen, and when it didn't, WHY.
//
// Every silent allow in the Stop hook used to look identical from outside:
// exit 0, no output. That covered "nothing to capture" and "the daemon is
// dead so nothing CAN be captured" with one representation, and on this
// machine 39 of 49 logged stops were silent with no way to tell them apart.
// lib/hook-stops.js records the distinction; this prints it.
function printCaptureHealth(config) {
  let s;
  try { s = require('../lib/hook-stops').summarize(); } catch { return; }
  if (!s || !s.stops) return;
  const last = s.lastCapture
    ? `${s.lastCapture.ts}${s.lastCapture.verification ? ` (${s.lastCapture.verification})` : ''}`
    : 'NEVER — no summary line has been written since this log began';
  console.log(`Capture:   ${s.stops} recorded stop(s), ${s.blocked} asked for a summary; last capture ${last}`);
  const warn = [];
  if (s.silentBecauseUnknown) warn.push(`${s.silentBecauseUnknown} stop(s) could not be judged at all (daemon down or state.json stale)`);
  if (s.incomplete) warn.push(`${s.incomplete} hook run(s) started and never finished (killed, most likely the 10s timeout)`);
  if (s.unhonoredBlocks) warn.push(`${s.unhonoredBlocks} summary ask(s) never answered by the agent`);
  for (const w of warn) console.log(`           ${w}`);
  void config;
}

// Which AI tools can actually call MemBridge's MCP server, and — the part that
// matters — which ones CANNOT and why.
//
// An agent MemBridge failed to register is the whole reason this feature
// exists: a silent skip is indistinguishable from the feature working, so
// every agent gets a line here, including the ones nothing was written for,
// carrying the config key that fixes it.
//
// Read from the RECORDED rows, never re-run. `status` is a read-only command,
// and re-registering to report on it would both write from a read and add
// seconds to it (`claude mcp get` alone costs ~2.1s).
function printMcpStatus(config) {
  let rec = null;
  try { rec = require('../lib/mcp-register').lastRegistration(); } catch {}
  if ((config.mcp || {}).autoRegister === false && !rec) {
    console.log('MCP:       auto-registration off (config.mcp.autoRegister is false)');
    return;
  }
  if (!rec || !Array.isArray(rec.rows) || !rec.rows.length) {
    console.log('MCP:       not registered with any AI tool yet. Run `membridge mcp register`');
    return;
  }
  const when = rec.at ? ` (last checked ${rec.at})` : '';
  if (rec.mode === 'unregister') {
    console.log(`MCP:       removed from your AI tools${when}. Re-register with \`membridge mcp register\``);
  } else {
    console.log(`MCP:       server name \`membridge\`${when}`);
  }
  for (const r of rec.rows) console.log(mcpRow(r));
}

// Teammate activity is still something to inject, so a project with no local
// sessions of its own says which of the two it is rather than reading as dead.
// Through util.teamRowsFor, never proj.teamEntries directly (lib/util.js's own
// note on that function): a revoked project still has its last pulled rows in
// the local cache, and reading them raw made `status` report teammate work
// waiting to be injected for a project nothing will ever inject again.
function emptyProjectDetail(proj) {
  const n = util.teamRowsFor(proj).length;
  if (!n) return 'no sessions captured yet, nothing to inject';
  return `no local sessions yet, ${n} teammate entr${n === 1 ? 'y' : 'ies'} synced`;
}

// Where each enabled adapter looks for sessions, and whether that root is
// actually there. Best-effort: an adapter that throws is reported as not found
// rather than taking `status` down with it.
function sessionRootsOf(config) {
  const roots = [];
  for (const adapter of getAdapters(config)) {
    try {
      for (const root of adapter.sessionRoots(config)) {
        let found = false;
        try {
          found = fs.existsSync(root);
        } catch {}
        roots.push({ name: adapter.displayName, root, found });
      }
    } catch {}
  }
  return roots;
}

const joinNames = names =>
  names.length < 2 ? (names[0] || '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// Nothing captured anywhere. Two users read that state — printed identically to
// a healthy one — as proof MemBridge was broken, when it was working and simply
// had nothing to inject yet. Two different causes, two different next steps.
function printEmptyState(config, running) {
  const roots = sessionRootsOf(config);
  const tools = joinNames([...new Set(roots.map(r => r.name))]);
  console.log('');
  if (!roots.length) {
    console.log('No session adapters are enabled, so nothing can be captured. Every tool is');
    console.log(`switched off in the \`adapters\` section of ${util.configPath()}.`);
    return;
  }
  if (!roots.some(r => r.found)) {
    console.log(`No supported AI tool found. MemBridge reads ${tools} session logs,`);
    console.log('and none of those directories exist on this machine:');
    for (const r of roots) console.log(`  ${r.name.padEnd(14)} ${r.root} (not found)`);
    console.log('Run one of those tools once, or point MemBridge at another tool via the');
    console.log(`\`adapters\` section of ${util.configPath()}.`);
    return;
  }
  console.log(`No agent sessions captured yet. MemBridge reads ${tools} session logs;`);
  console.log(running
    ? `open a project in one of those tools and check back after a sync (every ${config.intervalSec}s).`
    : 'open a project in one of those tools. Nothing is captured while the daemon is\nstopped. Start it with `membridge start`.');
}

// What `remove` actually deletes beyond the injected blocks. Named here rather
// than described loosely, because the whole point of the wording fix below is
// that the user learns what is going before it goes.
const REMOVED_MEMORY_CONTENTS = 'memory.json, ledger.json, summaries.jsonl, commits.jsonl, recall cache';

// `membridge remove` was documented as "strip injected memory blocks", and it
// also wiped each project's ENTIRE `.membridge/` directory without ever saying
// so. That directory is not derived data a later sync rebuilds: ledger.json,
// summaries.jsonl and commits.jsonl are the only copy of that history on the
// machine. A real run of this command destroyed 274KB of it on a live folder,
// and nothing in the help text or the output had warned.
//
// So: the deletion is announced by path BEFORE anything is touched, the
// summary line says what went, and --keep-memory strips the blocks alone.
//
// Deliberately NOT a stdin confirmation. This command is scriptable (install
// and uninstall flows call it non-interactively), and blocking on a prompt
// would hang every one of those callers. Announcing plus an opt-out is the
// non-breaking way to make it honest.
// `membridge add [path...]` -- enroll a project so the ingestion gate starts
// keeping its sessions. Before this existed there was no CLI enrollment path
// at all: isTrackedProject only keeps events for a state.projects key or a
// directory that already has a .membridge/, nothing in the daemon discovers a
// new root, and the sole way in was a dashboard button.
//
// Defaults to the cwd, because `cd my-project && membridge add` is the motion
// a new user actually makes. Takes several paths so adopting a handful of
// repos is one command.
//
// The per-path adopted/already-tracked/skipped-with-reason accounting is
// adoptProjects' own, reused verbatim rather than reimplemented: the dashboard
// and the CLI must not be able to disagree about what happened to a path.
function cmdAdd() {
  util.ensureConfig();
  const paths = args.slice(1).filter(a => !a.startsWith('--'));
  // Canonicalize before adopting. addProject keys state.projects on
  // path.resolve(), which does NOT follow symlinks, while process.cwd()
  // hands back an already-resolved path. On macOS that alone is enough to
  // key the SAME directory twice: `membridge add /var/foo` stores
  // /var/foo and `cd /var/foo && membridge add` stores /private/var/foo,
  // and findProjectKey's existing-project check never matches across the
  // pair. realpath here makes both spellings land on one key.
  //
  // Failures pass through untouched: a path that does not exist cannot be
  // realpathed, and adoptProjects already reports it as "not a directory",
  // which is the message the user should get.
  const targets = (paths.length ? paths : [process.cwd()]).map(p => {
    try { return fs.realpathSync(p); } catch { return p; }
  });
  // Backfill is the default: an adoption that shows nothing is worse than a
  // slow one, and prior history is the whole reason to adopt. Undefined rather
  // than true when neither flag is given, so addProject can still withhold it
  // for a project that was deliberately deleted.
  const backfill = flag('--backfill') ? true : flag('--no-backfill') ? false : undefined;
  const r = adoptProjects(targets, { backfill });
  const withheld = new Set(r.historyWithheld || []);
  for (const p of r.adopted) {
    console.log(withheld.has(p)
      ? `  adopted: ${p} (history not restored, this project was previously deleted; \`--backfill\` restores it)`
      : `  adopted: ${p}`);
  }
  for (const s of r.skipped) console.log(`  skipped: ${s.path} (${s.reason})`);
  console.log(r.adoptedCount
    ? `${r.adoptedCount} project(s) adopted. Memory lands on the next sync; run \`membridge sync\` to not wait.`
    : 'Nothing adopted.');
}

function cmdRemove() {
  const state = util.loadState();
  const config = util.getConfig();
  const only = opt('--project');
  const keepMemory = flag('--keep-memory');
  let keys = Object.keys(state.projects || {});
  if (only) {
    const k = findProjectKey(state, only);
    keys = k ? [k] : [path.resolve(only)];
  }

  // Announce first, act second. Only directories that actually exist are
  // listed, so the warning never cries wolf on a project with no local memory.
  const memoryDirs = keepMemory
    ? []
    : keys.map(key => path.join(key, memorydb.DIR_NAME)).filter(dir => fs.existsSync(dir));
  if (memoryDirs.length) {
    console.log(`About to permanently delete the local memory history (${REMOVED_MEMORY_CONTENTS}) in:`);
    for (const dir of memoryDirs) console.log(`  ${dir}`);
    console.log('This cannot be undone. Re-run with --keep-memory to strip the injected blocks and keep it.');
  }

  let n = 0;
  let wiped = 0;
  for (const key of keys) {
    for (const target of util.effectiveTargets(config)) {
      const file = path.join(key, target);
      const res = digest.removeBlock(file, { preamble: digest.preambleFor(target), projectRoot: key });
      if (res) {
        console.log(`  ${res === 'deleted' ? 'deleted (was only the memory block)' : 'block removed'}: ${file}`);
        n++;
      }
    }
    if (!keepMemory && memorydb.removeProjectMemory(key)) {
      console.log(`  local memory history deleted: ${path.join(key, memorydb.DIR_NAME)}`);
      n++;
      wiped++;
    }
  }
  // Tombstone every path whose memory history this actually purged, so a later
  // re-add cannot restore it from the transcripts. `remove` promises the
  // deletion cannot be undone; without this, adoption's backfill would undo it.
  // --keep-memory purges nothing, so it lays no tombstone.
  if (wiped) {
    const st = util.loadState();
    st.deletedProjects = st.deletedProjects || {};
    for (const key of keys) {
      if (fs.existsSync(path.join(key, memorydb.DIR_NAME))) continue; // nothing was wiped here
      st.deletedProjects[key] = new Date().toISOString();
    }
    util.saveState(st);
  }
  const wipedNote = wiped ? ` Local memory history deleted in ${wiped} project(s).` : '';
  const keptNote = keepMemory ? ' Local memory history kept (--keep-memory).' : '';
  console.log(n
    ? `Done, ${n} file(s) cleaned.${wipedNote}${keptNote}`
    : `No MemBridge blocks found.${keptNote}`);
}

// `membridge config <get|set> <key> [value]`. Minimal + generic, but only the
// `prompts` key is wired today: it toggles the local feedback nudges (no
// telemetry either way — the messages are the only thing being suppressed).
function cmdConfig(sub, key, val) {
  if (sub === 'get' && key === 'prompts') {
    // Effective value: default on unless explicitly disabled.
    console.log(`prompts ${util.getConfig().prompts === false ? 'off' : 'on'}`);
    return;
  }
  if (sub === 'set' && key === 'prompts') {
    if (val !== 'on' && val !== 'off') {
      console.error('Usage: membridge config set prompts <on|off>');
      process.exit(1);
    }
    const raw = util.loadUserConfig();
    raw.prompts = (val === 'on');
    util.saveUserConfig(raw);
    console.log(`prompts ${val === 'on' ? 'on' : 'off'}`);
    return;
  }
  console.error('Usage:\n  membridge config get prompts\n  membridge config set prompts <on|off>');
  process.exit(1);
}

function openBrowser(url) {
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else if (process.platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}

function cmdDashboard() {
  const config = util.getConfig();
  const url = `http://127.0.0.1:${config.dashboardPort}`;
  if (!isRunning(readPid())) {
    cmdStart();
    // give the detached daemon a moment to bind the port
    setTimeout(() => openBrowser(url), 1500);
  } else {
    openBrowser(url);
  }
  console.log(`Dashboard: ${url}`);
  prompts.flushValueMoment(config);
}

// lib/mcp.js (and its @modelcontextprotocol/sdk + zod dependencies) is
// required lazily, here only, so every other command stays on the
// dependency-light main path — `membridge status` etc. never load the SDK.
// `membridge mcp` with NO subcommand is the server itself — that exact argv is
// what every registered entry runs, so it must stay the default forever. The
// verbs hang off it rather than replacing it.
async function cmdMcp() {
  const sub = args[1];
  if (!sub) return require('../lib/mcp').startMcpServer();
  if (sub === 'register') return cmdMcpRegister();
  if (sub === 'unregister') return cmdMcpUnregister();
  // Never fall through to starting the server: a typo would hang the terminal
  // on a stdio server waiting for a client that will never speak.
  die(`Unknown mcp subcommand: ${sub}\nUsage: membridge mcp [register|unregister]`);
}

// One line per agent, for both the `mcp register` output and `membridge
// status`. `reason` is the stable machine token; `detail` is the sentence, and
// for anything actionable it already names the config key that fixes it.
function mcpRow(r) {
  const head = `  ${String(r.agent).padEnd(14)}${r.status}`;
  // The reason token is a fallback only where something is wrong and no
  // sentence was written; on a success it is internal detail ('created',
  // 'cli') that reads as noise next to the status word.
  const why = r.detail || ((r.status === 'skipped' || r.status === 'failed') ? r.reason : '');
  return why ? `${head}, ${why}` : head;
}

function cmdMcpRegister() {
  const mcpRegister = require('../lib/mcp-register');
  const { rows, recordedBin } = mcpRegister.registerNow();
  console.log('MCP server registration (server name: membridge):');
  for (const r of rows) console.log(mcpRow(r));
  if (recordedBin) console.log(`Recorded the \`claude\` binary at ${recordedBin} so later launches need not search for it.`);
  const failed = rows.filter(r => r.status === 'failed').length;
  if (failed) console.log(`${failed} agent(s) could not be written; nothing of theirs was changed.`);
}

function cmdMcpUnregister() {
  const mcpRegister = require('../lib/mcp-register');
  const { rows } = mcpRegister.unregisterNow();
  console.log('MCP server removal (server name: membridge):');
  for (const r of rows) console.log(mcpRow(r));
  console.log('Re-register anytime with: membridge mcp register');
}

// `membridge update` — check GitHub for a newer release and update in place.
// `--check` only reports (never runs anything). For npm installs we run the
// upgrade inline; for the macOS app we PRINT the one-liner instead of running
// it, because the installer quits and replaces the very app whose runtime is
// executing this command — that must happen in the user's own terminal.
async function cmdUpdate() {
  const updateCheck = require('../lib/update-check');
  console.log('Checking for updates…');
  const r = await updateCheck.check({ force: true });
  if (!r.latest) {
    console.log(`Couldn't reach the update server (offline or rate-limited). You're on v${r.current}.`);
    return;
  }
  if (!r.updateAvailable) {
    console.log(`You're on the latest version (v${r.current}).`);
    return;
  }
  const kind = updateCheck.installKind();
  const command = updateCheck.updateCommand(kind);
  console.log(`Update available: v${r.current} → v${r.latest}\n`);
  if (flag('--check')) {
    console.log(`Update with:\n  ${command}`);
    return;
  }
  if (kind === 'app') {
    // Auto-running the installer here would pkill this process mid-run.
    console.log('This is the macOS app. Run this in your terminal to update');
    console.log('(it quits MemBridge, swaps the app, and relaunches):\n');
    console.log(`  ${command}\n`);
    return;
  }
  console.log(`Updating via: ${command}\n`);
  // SECURITY: never write the package name out by hand here. This ran the BARE
  // name `membridge`, which is unclaimed on the registry and squattable — the
  // printed command above was the correct scoped one, and that divergence is
  // exactly what hid the bug. Derive both from package.json so they cannot
  // drift apart again.
  const res = spawnSync('npm', ['install', '-g', PKG_NAME], { stdio: 'inherit' });
  if (res.status !== 0) {
    die(`Update failed (exit ${res.status}). Run it manually:\n  ${command}`);
  }
  console.log(`\nUpdated to v${r.latest}. Restart the daemon if it was running: membridge start`);
}

// File-level provenance: which AI sessions (yours and teammates') edited a
// file, newest first. Works from any subdirectory — the file argument is
// resolved against cwd, then walked up to the nearest tracked project root.
// The file does not have to exist on disk: a deleted file's history is still
// a legitimate provenance question.
// Explicit, human reasons for every line-level fallback — printed before the
// file-level list so `why <file>:<line>` never dead-ends on a line git can't
// resolve to a single owning commit.
const LINE_FALLBACK = {
  'no-line': 'no valid line number given',
  'uncommitted': 'that line was last touched by an edit that is not committed yet, not yet attributable',
  'pending': 'attribution pending',
  'unmapped': 'that line traces to a commit with no local session attribution',
  'merge': 'that line traces to a merge commit (no single ask)',
  'git-unavailable': 'git blame is unavailable here',
};

function cmdWhy() {
  const rawArg = args[1];
  if (!rawArg || rawArg.startsWith('--')) die('Usage: membridge why <file>[:<line>]  (run inside a tracked project)');
  const state = util.loadState();
  const config = util.getConfig();
  const projectResolve = require('../lib/project-resolve');
  const provenance = require('../lib/provenance');
  // Split an optional :<line> off first; only the file part is path-resolved.
  const { file: fileArg, line } = provenance.parseFileLineArg(rawArg);
  // Shell cwd is realpath'd by node while project keys keep the tool-log
  // spelling; resolveTrackedKey matches both spellings (it's the same logic
  // the git post-commit hook uses). The file itself may not exist (a deleted
  // file's history is still a fair question), so only its parent directory
  // is realpath'd, and only best-effort.
  let abs = path.resolve(process.cwd(), fileArg);
  try {
    abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {}
  const hit = projectResolve.resolveTrackedKey(state, abs);
  if (!hit) die(`${fileArg} is not inside a tracked project. No MemBridge activity recorded there.`);
  // Relativize against hit.root (the spelling the walk matched, an ancestor
  // of abs) and hand fileProvenance the RELATIVE path — relative paths are
  // spelling-independent, so the key's own spelling no longer matters.
  const rel = provenance.normalizeRel(hit.root, abs);
  if (!rel) die(`${fileArg} is not inside a tracked project. No MemBridge activity recorded there.`);
  const key = hit.key;
  const proj = state.projects[key];

  // Rows come pre-redacted from fileProvenance/lineProvenance (both reuse the
  // same redaction pipeline), so the CLI just formats them.
  const renderRow = r => {
    console.log(`${digest.shortDate(r.ts)} · ${r.who} · ${r.tool}${r.live ? '  [working now]' : ''}`);
    console.log(`  Ask: ${r.ask || '(prompt not shared)'}`);
    if (r.summary) console.log(`  Did: ${r.summary}`);
    const notes = [r.decisions, r.gotchas].filter(Boolean).join(' · ');
    if (notes) console.log(`  Notes: ${notes}`);
    console.log('');
  };
  const renderFileLevel = () => {
    const rows = provenance.fileProvenance(key, proj, config, rel);
    if (!rows.length) {
      console.log(`No recorded AI edits for ${rel} in ${key}.`);
      return;
    }
    console.log(`Why ${rel}: ${rows.length} session(s), newest first:\n`);
    for (const r of rows) renderRow(r);
  };

  if (line == null) {
    renderFileLevel();
    return;
  }

  // Line-level: blame → SHA → the commit map → the one owning session, or an
  // explicit fallback reason followed by the file-level history.
  const res = provenance.lineProvenance(key, proj, config, rel, line, Date.now());
  if (res.fallback || !res.session) {
    console.log(`Line ${rel}:${line}: ${LINE_FALLBACK[res.fallback] || 'no line-level attribution'}; showing file-level history instead.\n`);
    renderFileLevel();
    return;
  }
  console.log(`Why ${rel}:${line} at commit ${(res.sha || '').slice(0, 10)}:\n`);
  renderRow(res.session);
}

// `membridge churn [--session <id>] [--since <Nd>] [--project <path>]` — the
// diagnostic-only landed-vs-reverted view. There is DELIBERATELY no per-person
// option: an unknown flag is rejected rather than silently scoped to anyone.
function cmdChurn() {
  const churnLib = require('../lib/churn');
  const projectResolve = require('../lib/project-resolve');
  const ALLOWED = new Set(['--session', '--since', '--project']);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    if (!ALLOWED.has(a)) {
      die(`Unknown option "${a}". churn takes only --session <id>, --since <Nd>, --project <path>. It has no per-person/teammate/author option by design, churn is never compared across people.`);
    }
    i++; // skip the flag's value
  }
  const state = util.loadState();
  const projectArg = opt('--project');
  const base = projectArg ? path.resolve(process.cwd(), projectArg) : process.cwd();
  let abs = base;
  try { abs = fs.realpathSync(base); } catch {}
  // resolveTrackedKey walks up from a file's dirname — probe with a child.
  const hit = projectResolve.resolveTrackedKey(state, path.join(abs, '_'));
  if (!hit) die(`${base} is not inside a tracked project. No MemBridge commits recorded there.`);
  const key = hit.key;
  const proj = state.projects[key] || { events: [] };

  const sinceGiven = opt('--since');
  const sinceDays = churnLib.parseSince(sinceGiven);
  let session = opt('--session');
  // Bare invocation defaults to the current/most-recent session; an explicit
  // --since (window) mode spans every locally-attributed commit instead.
  if (!session && !sinceGiven) session = churnLib.mostRecentSession(proj);
  const result = churnLib.churn(key, { session: session || null, sinceDays, now: Date.now() });
  console.log(churnLib.renderChurn(result, { session: session || null, sinceDays }));
}

// ---------------------------------------------------------------------------
// Team sync commands (Supabase backend, see supabase/schema.sql + README)
// ---------------------------------------------------------------------------
function die(msg) {
  console.error(msg);
  process.exit(1);
}

function credArgs() {
  const email = opt('--email');
  const password = opt('--password') || process.env.MEMBRIDGE_PASSWORD || null;
  if (!email || !password) {
    die('Usage: membridge <signup|login> --email you@company.com --password <pass> [--name "Your Name"]\n(The password can also come from the MEMBRIDGE_PASSWORD env var.)');
  }
  return { email, password, name: opt('--name') };
}

async function cmdSignup() {
  util.ensureConfig();
  const { email, password, name } = credArgs();
  const r = await teamsync.signup(util.getConfig(), email, password, name);
  if (r.needsConfirmation) {
    console.log(`Check ${email} for a confirmation link, then run: membridge login --email ${email} --password ...`);
    return;
  }
  console.log(`Signed up and logged in as ${r.email} (display name: ${r.displayName}).`);
}

async function cmdLogin() {
  util.ensureConfig();
  const { email, password, name } = credArgs();
  const r = await teamsync.login(util.getConfig(), email, password, name);
  console.log(`Logged in as ${r.email} (display name: ${r.displayName}).`);
}

// Two outcomes, reported as two (see teamsync.signOut). "Logged out." over a
// session the backend still honours would be the one sentence a user acts on
// — and the copy of credentials.json they are worried about would still work.
// The remedy line is there because "we could not revoke it" is useless without
// "here is what to do instead".
async function cmdLogout() {
  const out = await teamsync.signOut(util.getConfig());
  if (!out.wasSignedIn) {
    console.log('Already logged out.');
    return;
  }
  if (out.revoked) {
    console.log('Logged out. The session was ended on the server too.');
    return;
  }
  console.log('Logged out on this machine ONLY.');
  console.log(`The session could NOT be ended on the server: ${out.error}`);
  // Deliberately NOT "try again later": the credentials are gone from this
  // machine now, so there is nothing left here to revoke WITH. Retrying is
  // not a remedy, and offering it as one would be the comfortable lie.
  console.log('A copy of this machine\'s credentials taken before now can still use that session until it expires.');
  console.log('Changing your account password is the way to end it for certain.');
}

// One command from invite to member: `membridge join <link-or-token-or-code>`.
// Logged out + --email given -> logs in, or signs up if the account is new.
async function cmdJoin() {
  util.ensureConfig();
  const config = util.getConfig();
  const input = args[1];
  if (!input || input.startsWith('--')) {
    die('Usage: membridge join <invite link or code> [--email you@company.com --password <pass> [--name "Your Name"]]');
  }
  if (!teamsync.isConfigured(config)) {
    die('Team sync is not available in this build (see the Team sync section of the README).');
  }
  if (!teamsync.loadCredentials()) {
    const email = opt('--email');
    const password = opt('--password') || process.env.MEMBRIDGE_PASSWORD || null;
    if (!email || !password) {
      die('You are not logged in. Add --email and --password and MemBridge will log you in, or create the account if it is new.');
    }
    try {
      await teamsync.login(config, email, password, opt('--name'));
    } catch {
      const r = await teamsync.signup(config, email, password, opt('--name'));
      if (r.needsConfirmation) {
        die(`Account created. Check ${email} for a confirmation link, then run this join command again.`);
      }
    }
  }
  const t = await teamsync.join(config, input);
  console.log(`Joined team "${t.team_name}".`);
  console.log('Next: link a project with `membridge team link` inside it, or just work; matching git remotes are detected and suggested automatically.');
}

async function cmdTeam() {
  util.ensureConfig();
  const sub = args[1] || 'list';
  const config = util.getConfig();

  // Advanced/self-host override: point MemBridge at your own backend instead
  // of the one shipped with the build. Normal users never need this.
  if (sub === 'setup') {
    const url = opt('--url');
    const anonKey = opt('--anon-key');
    if (!url || !anonKey) {
      die('Usage: membridge team setup --url https://<ref>.supabase.co --anon-key <anon key>\n(Advanced, self-hosting your own backend. On a normal build team sync already works; just run `membridge signup`.)');
    }
    const raw = util.loadUserConfig();
    raw.team = { ...(raw.team && typeof raw.team === 'object' ? raw.team : {}), url, anonKey };
    util.saveUserConfig(raw);
    console.log('Custom team backend saved (overrides the built-in one).');
    return;
  }

  // Privacy gate. Three modes plus two legacy aliases (`on` → verbatim, `off`
  // → off) so a script or muscle memory keeps working. Local config only, so
  // it works before login and on unconfigured builds.
  //   off        summaries and file lists only, no ask, no goal
  //   distilled  agent-written goal ships; raw ask does not (fresh-install default)
  //   verbatim   full ask + goal upload, redacted through the standard pipeline
  if (sub === 'share-prompts') {
    const rawArg = args[2];
    // Aliases: keep the historical on/off working, translate to modes.
    const alias = rawArg === 'on' ? 'verbatim' : rawArg;
    if (!['off', 'distilled', 'verbatim'].includes(alias)) {
      die('Usage: membridge team share-prompts <off|distilled|verbatim>\n' +
          '  off        summaries and file lists only\n' +
          '  distilled  also share the agent-written goal (default for new installs)\n' +
          '  verbatim   also share your raw prompts (redacted through the same pipeline)');
    }
    const raw = util.loadUserConfig();
    raw.team = { ...(raw.team && typeof raw.team === 'object' ? raw.team : {}), sharePrompts: alias };
    util.saveUserConfig(raw);
    const msg = alias === 'off'
      ? 'Prompt sharing OFF: future pushes upload summaries and file lists only.'
      : alias === 'distilled'
      ? 'Prompt sharing DISTILLED: future pushes upload the agent-written goal (no raw prompts).'
      : 'Prompt sharing VERBATIM: future pushes include your (redacted) raw prompts.';
    console.log(msg);
    return;
  }

  // Key fingerprints for out-of-band verification (E2E). Purely local: your
  // own key from the keychain, teammates' from the TOFU pin store.
  if (sub === 'fingerprint') {
    const r = await teamsync.fingerprintReport();
    if (!r.ok) die(r.error);
    console.log(`Your key:   ${r.mine || '(no identity yet, created on the first team sync)'}`);
    if (!r.members.length) console.log('No teammate keys pinned yet.');
    for (const m of r.members) console.log(`  ${m.name || m.userId}:  ${m.fingerprint}`);
    console.log('Compare these with your teammate over a trusted channel (a call, in person), never through the synced backend itself.');
    return;
  }

  if (!teamsync.isConfigured(config)) {
    die('Team sync is not available in this build. If you are building MemBridge yourself, an operator must fill lib/backend.json (see the Team sync section of the README); or point at your own backend with `membridge team setup`.');
  }

  // Deliberate re-pin after an out-of-band fingerprint check — the only way
  // a changed teammate key is ever accepted.
  if (sub === 'trust') {
    const needle = args[2];
    if (!needle) die('Usage: membridge team trust <user-id or display name>\n(Only after verifying fingerprints out-of-band, `membridge team fingerprint` on both machines.)');
    const r = await teamsync.trustMember(config, needle);
    if (!r.ok) die(r.error);
    console.log(`Re-pinned ${r.name || r.userId}.`);
    if (r.previous) console.log(`  old: ${r.previous}`);
    console.log(`  new: ${r.current}`);
    return;
  }

  // Owner/admin recovery: mint a fresh team key sealed to every trusted
  // member's CURRENT key. Use when this device can't get the existing key
  // (e.g. a new machine whose keypair rotated) and can't wait for a teammate
  // to re-share. Forward-only — encrypted history from before the rekey stays
  // readable only by whoever already holds those older keys.
  if (sub === 'rekey') {
    let teamId = opt('--team') || args[2];
    const teams = await teamsync.listTeams(config);
    if (!teams.length) die('You are not in any team yet.');
    if (!teamId && teams.length === 1) teamId = teams[0].team_id;
    if (!teamId) {
      die('You are in multiple teams. Pick one with --team <id>:\n' +
        teams.map(t => `  ${t.team_id}  ${t.team_name || ''}`).join('\n'));
    }
    const r = await teamsync.rekeyTeam(config, teamId);
    if (!r.ok) die(r.error);
    console.log(`Team rekeyed, new epoch ${r.epoch}, sealed to ${r.sealed} member(s). Encryption is active on this device now.`);
    if (r.withheld && r.withheld.length) {
      console.log(`  Withheld from (unpublished or unverified key): ${r.withheld.join(', ')}`);
      console.log('  They rejoin encryption once their key is trusted (`membridge team trust <name>`) and they sync.');
    }
    return;
  }

  if (sub === 'create') {
    const name = args[2];
    if (!name) die('Usage: membridge team create <name>');
    const t = await teamsync.createTeam(config, name);
    console.log(`Team created.\n  id:          ${t.team_id}\n  invite code: ${t.invite_code}\nTeammates join with: membridge team join ${t.invite_code}`);
    return;
  }

  if (sub === 'join') {
    const code = args[2];
    if (!code) die('Usage: membridge team join <invite link or code>');
    const t = await teamsync.join(config, code);
    console.log(`Joined team "${t.team_name}" (${t.team_id}).`);
    return;
  }

  if (sub === 'invite') {
    let teamId = opt('--team');
    const teams = await teamsync.listTeams(config);
    if (!teamId && teams.length === 1) teamId = teams[0].team_id;
    if (!teamId) {
      die(`Pick a team with --team <id>:\n` + teams.map(t => `  ${t.team_id}  ${t.team_name}`).join('\n'));
    }
    const days = parseInt(opt('--expires-days') || '', 10);
    const maxUses = parseInt(opt('--max-uses') || '', 10);
    const inv = await teamsync.createInvite(config, teamId, {
      expiresAt: Number.isFinite(days) ? new Date(Date.now() + days * 86400000).toISOString() : null,
      maxUses: Number.isFinite(maxUses) ? maxUses : null,
    });
    console.log(`Invite link created${inv.expires_at ? `, expires ${inv.expires_at.slice(0, 10)}` : ''}${inv.max_uses ? `, max ${inv.max_uses} use(s)` : ''}.`);
    if (inv.url) console.log(`  ${inv.url}`);
    console.log(`  membridge join ${inv.token}`);
    return;
  }

  if (sub === 'revoke-invite') {
    const token = args[2];
    if (!token) die('Usage: membridge team revoke-invite <token or link>');
    await teamsync.revokeInvite(config, token);
    console.log('Invite revoked. Anyone holding that link can no longer join.');
    return;
  }

  if (sub === 'link') {
    const projectPath = path.resolve(opt('--project') || process.cwd());
    let teamId = opt('--team');
    const teams = await teamsync.listTeams(config);
    if (!teams.length) die('You are not in any team yet. Run `membridge team create <name>` or `team join <code>` first.');
    if (!teamId && teams.length === 1) teamId = teams[0].team_id;
    if (!teamId) {
      die(`You are in ${teams.length} teams. Pick one with --team <id>:\n` +
        teams.map(t => `  ${t.team_id}  ${t.team_name}`).join('\n'));
    }
    const team = teams.find(t => t.team_id === teamId);
    const link = await teamsync.linkProject(config, projectPath, teamId, team ? team.team_name : '');
    if (link.adopted) {
      console.log(`Adopted the existing ${path.join(memorydb.DIR_NAME, 'team.json')}, linked ${projectPath} to team "${link.teamName || link.teamId}", the same shared project as the teammate who committed it.`);
    } else {
      console.log(`Linked ${projectPath} to team "${team ? team.team_name : teamId}".\nRedacted memory entries for this project now sync with your team (${path.join(memorydb.DIR_NAME, 'team.json')}, commit it so teammates' clones link to the same project from any fork; if ${memorydb.DIR_NAME}/ is gitignored, add a \`!${memorydb.DIR_NAME}/team.json\` exception).`);
    }
    // First pass right away so the link is visible without waiting a tick.
    await teamSyncPass({ project: projectPath });
    return void link;
  }

  if (sub === 'unlink') {
    const projectPath = path.resolve(opt('--project') || process.cwd());
    console.log(teamsync.unlinkProject(projectPath)
      ? `Unlinked ${projectPath}, this project no longer syncs with any team.`
      : 'This project was not linked.');
    return;
  }

  if (sub === 'repull') return cmdTeamRepull(config);

  if (sub === 'list') {
    const creds = teamsync.loadCredentials();
    console.log(creds ? `Logged in as ${creds.email} (${creds.displayName})` : 'Not logged in.');
    if (!creds) return;
    const teams = await teamsync.listTeams(config);
    if (!teams.length) {
      console.log('No teams yet. Create one with: membridge team create <name>');
      return;
    }
    console.log('Teams:');
    for (const t of teams) {
      console.log(`  ${t.team_name} (${t.role})  id: ${t.team_id}${t.role === 'owner' ? `  invite: ${t.invite_code}` : ''}`);
    }
    const state = util.loadState();
    const linked = Object.keys(state.projects || {}).filter(k => teamsync.loadTeamLink(k));
    if (linked.length) {
      console.log('Linked projects:');
      for (const k of linked) {
        const l = teamsync.loadTeamLink(k);
        console.log(`  ${k} -> ${l.teamName || l.teamId}`);
      }
    }
    return;
  }

  die(`Unknown team subcommand: ${sub}\nUsage: membridge team <setup|create|invite|revoke-invite|join|link|unlink|list|repull|share-prompts|fingerprint|trust>`);
}

// ---------------------------------------------------------------------------
// team repull — re-walk a linked project's team history from the beginning.
// ---------------------------------------------------------------------------
// WHY THIS EXISTS. Rows pulled before the daemon carried author_id have no
// stable identity on this disk (lib/teamsync.js mapPulledRow), and the two
// features built on that id — filtering search by person, and resolving one
// account's several display names to one person — are forward-only by
// construction. A full re-walk is the ONLY way rows already on disk acquire it.
// It self-heals both stores: proj.teamEntries is replaced in place by the
// pull's own name-key fallback, and the durable archive heals because readRows
// is last-line-wins per rowKey, so a re-appended line carrying the id beats the
// original.
//
// EXPLICITLY OPT-IN, NEVER AUTOMATIC, and a CLI verb rather than a setting: a
// toggle would imply standing state something has to clear later, while this is
// a one-shot maintenance walk with a real cost (one page per pass, every pass
// marks the project dirty so the injected block is rewritten each time).
//
// It adds NO pull machinery. The cursor is reset once, then this loops the
// ordinary syncTeams({ project }) pass the daemon already runs every tick — so
// every state.json write here is exactly as wide as one the daemon does anyway,
// which matters on a file with no locking. Nothing new is persisted: progress
// is printed, not stored, because it is worthless once this process exits.
//
// COMPACTION IS A PRECONDITION, not a nicety. Before lib/team-archive.js
// rewrote on duplicate keys, this walk re-appended every row it re-fetched and
// roughly doubled the .ndjson permanently. Do not ship one without the other.
const REPULL_MAX_PASSES = 400; // 400 * PULL_LIMIT(200) = 80k rows/project, well past the 50k archive cap

function repullTargets(all, projectPath) {
  const state = util.loadState();
  const linked = Object.keys(state.projects || {}).filter(k => teamsync.loadTeamLink(k));
  if (all) return linked;
  const key = findProjectKey(state, projectPath);
  if (!key) die(`Not a tracked project: ${projectPath}\n(Use --project <path>, or --all for every linked project.)`);
  if (!linked.includes(key)) die(`${key} is not linked to a team, so there is no team history to re-pull.`);
  return [key];
}

// Distinct archived rows, and how many carry the stable author id — the actual
// point of the walk, read once per project rather than per pass.
function archiveIdCoverage(projectId) {
  try {
    const rows = require('../lib/team-archive').loadArchive(projectId).rows;
    return { total: rows.length, withId: rows.filter(r => r && r.authorId).length };
  } catch {
    return { total: 0, withId: 0 };
  }
}

async function cmdTeamRepull(config) {
  if (!teamsync.isConfigured(config)) die('Team sync is not set up on this machine. Run `membridge signup` (or `membridge login`) first.');
  if (!teamsync.loadCredentials()) die('Not logged in. Run `membridge login` first.');
  const all = flag('--all');
  const targets = repullTargets(all, path.resolve(opt('--project') || process.cwd()));
  if (!targets.length) {
    console.log('No linked projects to re-pull.');
    return;
  }

  console.log(`Re-pulling team history for ${targets.length} project(s), one page per pass.`);
  console.log('This re-fetches history you already have, so it is safe to interrupt and safe to re-run.');
  if (isRunning(readPid())) {
    // Not a refusal: the daemon and this command both go through syncTeams, so
    // they interleave safely. But every pass marks the project dirty, so the
    // user's context files get rewritten repeatedly for the duration, and they
    // should hear that from the command rather than notice it in git.
    console.log('NOTE: the MemBridge daemon is running, so your CLAUDE.md/AGENTS.md blocks will be rewritten repeatedly while this runs.');
  }
  // The one way this opt-in operation continues without being asked to. Said
  // here, in the command's own output, because a user who hits Ctrl-C is owed
  // the fact that it has not fully stopped.
  console.log('If you interrupt this, the reset cursor stays reset: the running daemon will keep walking the');
  console.log('remaining history on its own, one page per sync tick. Re-run this command to finish it in the foreground.\n');

  for (const key of targets) {
    const link = teamsync.loadTeamLink(key);
    const before = archiveIdCoverage(link.projectId);
    const name = path.basename(key);

    // Reset the FORWARD cursor only, in one narrow load->save. The archive's
    // backward backfill cursor is deliberately untouched: it walks the other
    // direction and is separately capped.
    {
      const st = util.loadState();
      if (!st.projects || !st.projects[key]) {
        console.log(`${name}: no longer tracked, skipped.`);
        continue;
      }
      st.projects[key].teamPullTs = null;
      // The forward cursor is a PAIR — timestamp plus row id (lib/teamsync.js
      // fetchPullPage). Resetting only the timestamp would leave the id half
      // describing a position in a page this walk is about to re-read.
      st.projects[key].teamPullId = null;
      util.saveState(st);
    }

    let passes = 0;
    let cursor = null;
    for (; passes < REPULL_MAX_PASSES; passes += 1) {
      const r = await teamsync.syncTeams({ project: key });
      for (const e of r.errors) console.log(`  ${name}: ${e}`);
      const proj = (util.loadState().projects || {})[key];
      // Progress is the PAIR moving, not the timestamp moving. A run of rows
      // pushed in one batch shares one created_at, so a walk through a tie
      // group larger than a page advances only the id half — real progress
      // that a timestamp-only comparison reads as a stalled cursor and
      // abandons, leaving the rest of the tie group unpulled.
      const next = proj ? (proj.teamPullTs ? `${proj.teamPullTs}#${proj.teamPullId ?? ''}` : null) : null;
      const shown = proj ? (proj.teamPullTs || null) : null;
      if (!r.changed.includes(key)) break; // a pass that pulled nothing is the end of history
      if (next && next === cursor) {
        // The cursor stopped moving while rows kept arriving: pulling the same
        // page forever would be an infinite loop, so stop and say so rather
        // than spin. Reported, never silently treated as completion.
        console.log(`  ${name}: stopped — the pull cursor stopped advancing at ${shown} while rows were still arriving.`);
        break;
      }
      cursor = next;
      console.log(`  ${name}: pass ${passes + 1} · cursor now ${shown || 'start of history'}`);
    }
    if (passes >= REPULL_MAX_PASSES) console.log(`  ${name}: stopped at the ${REPULL_MAX_PASSES}-pass safety limit; re-run to continue.`);

    // Rebuild what the pulled rows feed, exactly as a normal sync pass would.
    syncOnce({ project: key });
    rebuildNotesForChanged([key]);

    const after = archiveIdCoverage(link.projectId);
    console.log(`${name}: ${passes} pass(es) · archive holds ${after.total} row(s), ` +
      `${after.withId} with an author id (was ${before.withId} of ${before.total}).\n`);
  }
  console.log('Done. Search person-filters and display-name resolution now cover the re-walked history.');
}

// ---------------------------------------------------------------------------
// Distillation (Claude Code Stop hook, see lib/hooks.js)
// ---------------------------------------------------------------------------
function cmdHook() {
  const sub = args[1];
  if (sub === 'stop') return hooks.runStop();
  if (sub === 'post-commit') return hooks.runPostCommit();
  if (sub === 'recall') return hooks.runRecall();
  if (sub === 'search') return require('../lib/hooks-search').runSearch();
  die('Usage: membridge hook <stop|post-commit|recall|search>  (invoked by the installed hooks, see `membridge setup-hooks`)');
}

function cmdHelp() {
  console.log(`MemBridge v${pkg.version}: shared memory across your AI coding tools

Your AI tools each keep their own session history. MemBridge watches them all,
distills a brief per-project memory, and writes it into the context files every
tool reads (CLAUDE.md, AGENTS.md, ...), so Codex knows what Claude Code did,
and vice versa. Everything stays on your machine.

Usage: membridge <command>

  start               run the background daemon (sync + dashboard)
  stop                stop the background daemon
  status              daemon state, watched projects, config summary
  dashboard           open the local web dashboard (starts daemon if needed)
  sync [--dry-run] [--project <path>]   one sync pass right now
  scan                read-only: show which tools/projects were discovered
  add [<path>...] [--backfill|--no-backfill]
                      start tracking a project (defaults to the current
                      directory). Existing AI history for it is recovered on
                      the next sync, EXCEPT for a project you deleted on
                      purpose, whose history stays deleted; --backfill
                      restores it anyway, --no-backfill registers without
                      re-reading. The reverse is \`remove --project <path>\`.
  remove [--project <path>] [--keep-memory]
                      strip injected memory blocks AND permanently delete each
                      project's local memory history in .membridge/
                      (${REMOVED_MEMORY_CONTENTS}).
                      This cannot be undone. --keep-memory strips the blocks
                      only and leaves that history alone.
  enable-autostart    launch MemBridge automatically at login
  disable-autostart   remove the login launcher
  update [--check]    check for a newer release and update in place
                      (--check only reports; never runs anything)
  config get prompts            show whether feedback nudges are on
  config set prompts <on|off>   turn the local feedback nudges on or off
  daemon              run in the foreground (used internally / by services)
  help                this text

Provenance (why a file/line looks the way it does, see README):
  why <file>[:<line>] which AI sessions edited this file, newest first; add
                      :<line> for the one session behind a single line
  churn [--session <id>] [--since <Nd>] [--project <path>]
                      diagnostic-only: what fraction of a session's committed
                      lines still survive in HEAD (a rework health signal,
                      never a target, never compared across people)

Distillation (agent-written session summaries, see README):
  setup-hooks         add a Claude Code Stop hook (agent-written session
                      summaries) AND a git post-commit hook in every tracked
                      repo (instant commit->session provenance capture)
  remove-hooks        remove the MemBridge hooks (your other hooks are kept)
  hook stop           the Stop hook itself (invoked by Claude Code, not by you)
  hook post-commit    the git hook itself (invoked by git, not by you)
  hook recall         the PreToolUse recall hook itself (answers a repeat
                      Read/Grep/Glob from memory; invoked by Claude Code)
  hook search         the PreToolUse search hook itself (puts matching
                      project memory in front of a Grep/Glob before it runs;
                      invoked by Claude Code)

MCP (expose project memory, read-only, to MCP-capable clients: Claude
Desktop, Cursor, Cowork, ...; see README):
  mcp                 start a read-only MCP server over stdio
                      Nothing to install. It ships with MemBridge, and the
                      installer registers it with every AI tool you have.
  mcp register        register the server with every installed AI tool
                      (Claude Code, Codex, Cursor, ...); prints one line per
                      tool, including the ones it could not write and why.
                      Turn the automatic pass off with config.mcp.autoRegister
  mcp unregister      remove MemBridge's entry from those tools' configs
                      (a foreign server that happens to be named "membridge"
                      is never touched)

Team sync (share project memory with your team, see README):
  join <link-or-code> [--email <e> --password <p>]   one command from invite to member
  signup / login --email <e> --password <p> [--name "You"]
  logout
  team create <name>       new team (prints the invite code)
  team invite [--team <id>] [--expires-days N] [--max-uses N]   create an invite link
  team revoke-invite <token>                   kill an invite link
  team join <link-or-code> join a teammate's team (same as top-level join)
  team link [--project <path>] [--team <id>]   sync this project with the team
  team unlink [--project <path>]               stop syncing this project
  team list                your login, teams and linked projects
  team repull [--project <path>|--all]         re-walk team history so older entries gain a
                           stable author id (search person-filters, one name per teammate).
                           Opt-in and one-shot; safe to interrupt and re-run. If you do
                           interrupt it, a running daemon keeps walking the rest one page
                           per tick.
  team share-prompts <off|distilled|verbatim>
                            off        summaries and file lists only
                            distilled  also share the agent-written goal (default for new installs)
                            verbatim   also share your raw prompts (redacted through the same pipeline)
                            legacy: "on" is an alias for verbatim
  team setup ...           advanced: point at your own self-hosted backend

Config: ${util.configPath()}
Docs:   https://github.com/MembridgeAi/membridge#readme`);
}

const commands = {
  add: cmdAdd,
  sync: cmdSync,
  scan: cmdScan,
  why: cmdWhy,
  churn: cmdChurn,
  daemon: cmdDaemon,
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  remove: cmdRemove,
  config: () => cmdConfig(args[1], args[2], args[3]),
  dashboard: cmdDashboard,
  update: cmdUpdate,
  mcp: cmdMcp,
  signup: cmdSignup,
  login: cmdLogin,
  logout: cmdLogout,
  join: cmdJoin,
  team: cmdTeam,
  hook: cmdHook,
  'setup-hooks': () => {
    console.log(hooks.setupHooks());
    const raw = util.loadUserConfig();
    if (!raw.distill) raw.distill = {};
    if (raw.distill.consent !== 'granted') {
      raw.distill.consent = 'granted';
      util.saveUserConfig(raw);
    }
  },
  // `remove-hooks` is the documented "take MemBridge back out of my tools"
  // command, so it also strips the MCP registration — uninstalling must leave
  // nothing of ours behind in anyone's config.
  //
  // Wired HERE and not inside hooks.removeHooks(), deliberately. That function
  // is also called by lib/server.js when the dashboard's Settings toggle turns
  // *distillation* off, and by lib/consent.js when the first-run prompt is
  // declined. Session summaries and the MCP server are unrelated features:
  // putting the unregister inside removeHooks() would silently tear the MCP
  // server out of Codex and Cursor because someone switched off Stop-hook
  // summaries, and would do it from inside an HTTP handler that would then
  // block for seconds on `claude mcp remove`.
  'remove-hooks': () => {
    console.log(hooks.removeHooks());
    cmdMcpUnregister();
  },
  'enable-autostart': () => console.log(autostart.enable()),
  'disable-autostart': () => console.log(autostart.disable()),
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
  '--version': () => console.log(pkg.version),
  version: () => console.log(pkg.version),
};

const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command: ${cmd}\n`);
  cmdHelp();
  process.exit(1);
}
// .then(fn), not .resolve(fn()): a synchronous throw must reach the same
// clean error path as an async rejection.
Promise.resolve().then(fn).catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
