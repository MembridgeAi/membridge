'use strict';
// Hook reliability: the failure modes that were live on a real machine and
// that nothing in the suite could have caught.
//
// Placement matters as much as coverage here. ~58 hook assertions already
// exist inside test/run-tests.js (isCheckpointDue, blockReason, runAppend
// validation, reconcile fingerprint stamping), but that file is a 24k-line
// sequential monolith that per .claude/rules/testing.md "still only runs
// whole" -- so nobody runs it while developing a hook change, and every one of
// the defects below shipped anyway. This file runs in seconds:
//
//   node test/run.js hooks
//
// Ordered by the diagnostic's priorities 1-7. Each block names the failure it
// pins and, where the failure was observed rather than theorised, the number.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LIB = path.join(__dirname, '..', '..', 'lib');
const HOOK_JS = path.join(LIB, 'membridge-hook.js');

// Each block gets its own settings file and MemBridge home, so nothing here
// can be order-dependent and nothing can touch the real ~/.claude.
let box = 0;
function sandbox(name) {
  const dir = path.join(ROOT, `hooks-${++box}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    settings: path.join(dir, 'settings.json'),
    home: path.join(dir, 'home'),
  };
}
function withSettings(file, fn) {
  const prev = process.env.MEMBRIDGE_CLAUDE_SETTINGS;
  process.env.MEMBRIDGE_CLAUDE_SETTINGS = file;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MEMBRIDGE_CLAUDE_SETTINGS;
    else process.env.MEMBRIDGE_CLAUDE_SETTINGS = prev;
  }
}
function withHome(dir, fn) {
  const prev = process.env.MEMBRIDGE_HOME;
  process.env.MEMBRIDGE_HOME = dir;
  try { return fn(); } finally { process.env.MEMBRIDGE_HOME = prev; }
}
// Pin OUR install location for the reconcile blocks.
//
// Not cosmetic: installKind() calls a linked git worktree 'transient', and
// these suites usually run from one (.claude/worktrees/agent-*). A transient
// install correctly YIELDS to a durable one (shouldYieldTo), which would make
// the upgrade-path assertions below pass or fail depending on where the
// checkout happens to live. Pointing at a plain file in the temp ROOT makes
// this install 'durable' and the test about the rule it is actually for.
const DURABLE_SCRIPT = path.join(ROOT, 'durable-install', 'membridge-hook.js');
fs.mkdirSync(path.dirname(DURABLE_SCRIPT), { recursive: true });
fs.writeFileSync(DURABLE_SCRIPT, '// stand-in for a durable install\n');
function asDurableInstall(fn) {
  const prev = process.env.MEMBRIDGE_HOOK_SCRIPT;
  process.env.MEMBRIDGE_HOOK_SCRIPT = DURABLE_SCRIPT;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MEMBRIDGE_HOOK_SCRIPT;
    else process.env.MEMBRIDGE_HOOK_SCRIPT = prev;
  }
}
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// A registration in the exact shape found in the wild on the author's machine:
// routed through the hand-installed exec wrapper, stamped with a version.
const WRAPPER = '/Users/somebody/.membridge/hook-exec-wrapper.sh';
const wrappedCommand = (label, script, sub) =>
  `${WRAPPER} ${label} env ELECTRON_RUN_AS_NODE=1 "/Applications/MemBridge.app/Contents/MacOS/MemBridge" "${script}"${sub ? ` ${sub}` : ''}`;
const APP_SCRIPT = '/Applications/MemBridge.app/Contents/Resources/app.asar/lib/membridge-hook.js';

async function main() {
  const hooks = require('../../lib/hooks');
  const hookStops = require('../../lib/hook-stops');
  const hookVerify = require('../../lib/hook-verify');
  const util = require('../../lib/util');
  // Relative to whatever this checkout's version happens to be, so these never
  // need editing at release time.
  const VERSION = require('../../package.json').version;
  const NEWER = `${Number(String(VERSION).split('.')[0]) + 1}.0.0`;
  const OLDER = '0.0.1';

  // ---------------------------------------------------------------------
  // Priority 4 (F1): the vintage comparison must know which way is up.
  // ---------------------------------------------------------------------
  {
    check('version compare: orders releases, prereleases and unparseable input honestly', () => {
      assert.strictEqual(hooks.compareVersions('0.3.2', '0.2.8'), 1);
      assert.strictEqual(hooks.compareVersions('0.2.8', '0.3.2'), -1);
      assert.strictEqual(hooks.compareVersions('0.3.2', '0.3.2'), 0);
      assert.strictEqual(hooks.compareVersions('0.10.0', '0.9.9'), 1, 'dotted segments compare NUMERICALLY, not as strings');
      assert.strictEqual(hooks.compareVersions('1.2.3', '1.2.3-beta.1'), 1, 'a release beats its own prerelease');
      assert.strictEqual(hooks.compareVersions('nonsense', '0.3.2'), null, 'unparseable is null, never a guessed order');
    });

    check('vintage: a registration stamped NEWER than this build reports "newer", never "outdated"', () => {
      const s = sandbox('vintage-newer');
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: wrappedCommand('Stop', APP_SCRIPT), membridgeFingerprint: `v=${NEWER}` }] }] },
      });
      const status = withSettings(s.settings, () => hooks.hooksVersionStatus());
      // THE bug: this returned 'outdated' for a registration that is ahead of
      // us, so the dashboard offered "update available" and the update was a
      // downgrade. Observed live as repo 0.2.8 judging the app's 0.3.2 entry.
      assert.strictEqual(status.stop, 'newer',
        'a newer registration must never be reported as outdated -- that invites a downgrade');
    });

    check('vintage: a genuinely older stamp still reports "outdated"', () => {
      const s = sandbox('vintage-old');
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: wrappedCommand('Stop', APP_SCRIPT), membridgeFingerprint: `v=${OLDER}` }] }] },
      });
      assert.strictEqual(withSettings(s.settings, () => hooks.hooksVersionStatus()).stop, 'outdated');
    });

    check('vintage: an unstamped (pre-fingerprint) registration is outdated, not newer', () => {
      const s = sandbox('vintage-unstamped');
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: wrappedCommand('Stop', APP_SCRIPT) }] }] },
      });
      assert.strictEqual(withSettings(s.settings, () => hooks.hooksVersionStatus()).stop, 'outdated');
    });
  }

  // ---------------------------------------------------------------------
  // Priority 2 (F3): reconcile must refuse to downgrade, and must refuse to
  // strip a prefix it does not own. This is the one that silently degraded a
  // working install on every single launch, via ensureInstalled().
  // ---------------------------------------------------------------------
  {
    check('reconcile: REFUSES to downgrade a registration stamped by a newer MemBridge', () => {
      const s = sandbox('no-downgrade');
      const before = wrappedCommand('Stop', APP_SCRIPT);
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: before, timeout: 10, membridgeFingerprint: `v=${NEWER}` }] }] },
      });
      const r = withSettings(s.settings, () => hooks.reconcileStopHook());
      const after = readJson(s.settings).hooks.Stop[0].hooks[0];
      assert.strictEqual(r.declined, 1, 'the newer entry must be declined, not upgraded');
      assert.strictEqual(r.upgraded, 0);
      assert.strictEqual(after.command, before, 'the command must be byte-identical after a refused downgrade');
      assert.strictEqual(after.membridgeFingerprint, `v=${NEWER}`,
        'our fingerprint must never be stamped onto a hook a newer build wrote');
    });

    check('reconcile: REFUSES to strip the hook-exec-wrapper prefix when it does upgrade', () => {
      const s = sandbox('keep-wrapper');
      // Older stamp, so this IS a legitimate upgrade -- the command must be
      // rewritten to point at us AND keep the user's wrapper in front of it.
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: wrappedCommand('Stop', APP_SCRIPT), timeout: 10, membridgeFingerprint: `v=${OLDER}` }] }] },
      });
      const r = asDurableInstall(() => withSettings(s.settings, () => hooks.reconcileStopHook()));
      const after = readJson(s.settings).hooks.Stop[0].hooks[0];
      assert.strictEqual(r.upgraded, 1, 'an older stamp is a real upgrade');
      assert.ok(after.command.startsWith(`${WRAPPER} Stop `),
        `the wrapper prefix must survive the upgrade, got: ${after.command}`);
      assert.ok(after.command.includes(DURABLE_SCRIPT),
        'the upgrade must still repoint the command at this install');
      assert.ok(!after.command.includes(APP_SCRIPT), 'the old script path must be gone');
      assert.strictEqual(after.membridgeFingerprint, `v=${VERSION}`);
    });

    check('reconcile: a wrapped registration at our own version is already CURRENT (no churn per launch)', () => {
      const s = sandbox('wrapped-current');
      const cmd = asDurableInstall(() => `${WRAPPER} Stop ${hooks.hookCommand()}`);
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: cmd, timeout: 10, membridgeFingerprint: hooks.hookFingerprint() }] }] },
        permissions: { allow: [asDurableInstall(() => hooks.appendAllowRule())] },
      });
      const r = asDurableInstall(() => withSettings(s.settings, () => hooks.reconcileStopHook()));
      assert.strictEqual(r.current, true, 'a wrapper in front of OUR command must not read as a foreign command');
      assert.strictEqual(r.wrote, false, 'ensureInstalled runs this every launch -- it must not rewrite on every launch');
      assert.strictEqual(readJson(s.settings).hooks.Stop[0].hooks[0].command, cmd);
    });

    check('reconcile: the downgrade guard covers the PreToolUse hooks too (ensureInstalled runs all four)', () => {
      const s = sandbox('no-downgrade-pretooluse');
      const before = wrappedCommand('PreToolUse-Read', APP_SCRIPT, 'recall');
      writeJson(s.settings, {
        hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: before, timeout: 5, membridgeFingerprint: `v=${NEWER}` }] }] },
      });
      const r = withSettings(s.settings, () => hooks.reconcileRecallHook());
      assert.strictEqual(r.declined, 1);
      assert.strictEqual(r.upgraded, 0);
      assert.strictEqual(readJson(s.settings).hooks.PreToolUse[0].hooks[0].command, before);
    });

    check('reconcile: declining does NOT append a second, duplicate entry alongside the one it left', () => {
      const s = sandbox('no-dupe-on-decline');
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: wrappedCommand('Stop', APP_SCRIPT), membridgeFingerprint: `v=${NEWER}` }] }] },
      });
      withSettings(s.settings, () => hooks.reconcileStopHook());
      withSettings(s.settings, () => hooks.reconcileStopHook());
      const stop = readJson(s.settings).hooks.Stop;
      const owned = stop.flatMap(e => e.hooks || []).filter(x => /membridge-hook\.js/.test(x.command || ''));
      assert.strictEqual(owned.length, 1, 'a declined hook still counts as owned -- appending a second is how a machine ends up with two');
    });

    check('splitHookCommand: separates a foreign prefix from our half, and leaves an unwrapped command alone', () => {
      const wrapped = hooks.splitHookCommand(wrappedCommand('Stop', APP_SCRIPT));
      assert.strictEqual(wrapped.prefix, `${WRAPPER} Stop`);
      assert.strictEqual(wrapped.script, APP_SCRIPT);
      assert.ok(wrapped.ours.startsWith('env ELECTRON_RUN_AS_NODE=1 '), wrapped.ours);
      const plain = hooks.splitHookCommand(hooks.hookCommand());
      assert.strictEqual(plain.prefix, '', 'an unwrapped command has no prefix to preserve');
    });
  }

  // ---------------------------------------------------------------------
  // Priority 1 (F2): daemon down must be DISTINGUISHABLE from not-due.
  //
  // The diagnostic notes this test "should fail on the current code" -- it
  // could not pass before lib/hook-stops.js existed, because the two cases
  // were byte-identical from outside (rc=0, 0B stdout). They still are, on
  // purpose: the hook must keep failing open. What changed is that the reason
  // is now written down.
  // ---------------------------------------------------------------------
  {
    // One tracked project shared by the runStop blocks below.
    const proj = path.join(ROOT, 'stopproj');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });

    const runHook = (payload, home, args = []) => spawnSync(process.execPath, [HOOK_JS, ...args], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, MEMBRIDGE_HOME: home },
    });
    const stateWith = (events, ts) => ({
      version: util.STATE_VERSION,
      files: {},
      projects: { [proj]: { events, lastSync: ts || new Date().toISOString() } },
      catchup: {}, feedback: {},
    });
    const edit = (session, file, ts) => ({ ts, kind: 'edit', session, file: path.join(proj, file), project: proj });

    check('runStop: a daemon-down silence is recorded as "cannot know", NOT as "nothing to capture"', () => {
      const s = sandbox('daemon-down');
      fs.mkdirSync(s.home, { recursive: true });
      // A tracked project, a session with no edit events, and NO daemon: no
      // pid file, and a state.json written long enough ago to be stale. This
      // is precisely the shape of a total capture outage.
      const statePath = path.join(s.home, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify(stateWith([edit('other-session', 'a.js', '2020-01-01T00:00:00Z')])));
      const old = Date.now() / 1000 - 86400;
      fs.utimesSync(statePath, old, old);
      const r = runHook({ cwd: proj, session_id: 'ghost' }, s.home);
      assert.strictEqual(r.status, 0, 'still fails open');
      assert.strictEqual(r.stdout, '', 'still silent on stdout -- the behaviour must not change');
      const recs = withHome(s.home, () => hookStops.readRecent());
      const end = recs.filter(x => x.k === 'end').pop();
      assert.ok(end, 'the invocation must be recorded at all');
      assert.strictEqual(end.outcome, hookStops.OUTCOME.NO_EDITS_DAEMON_DOWN,
        `daemon-down silence must be its own outcome, got ${end && end.outcome}`);
    });

    check('runStop: a healthy daemon with a genuinely empty session records "no-edits" instead', () => {
      const s = sandbox('no-edits');
      fs.mkdirSync(s.home, { recursive: true });
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify(stateWith([edit('other-session', 'a.js', new Date().toISOString())])));
      // A live daemon: this process's own pid is, definitionally, running.
      fs.writeFileSync(path.join(s.home, 'membridge.pid'), String(process.pid));
      const r = runHook({ cwd: proj, session_id: 'empty-session' }, s.home);
      assert.strictEqual(r.stdout, '');
      const end = withHome(s.home, () => hookStops.readRecent()).filter(x => x.k === 'end').pop();
      assert.strictEqual(end.outcome, hookStops.OUTCOME.NO_EDITS,
        'a healthy daemon knows the session did nothing -- that is a different fact');
      assert.notStrictEqual(end.outcome, hookStops.OUTCOME.NO_EDITS_DAEMON_DOWN);
    });

    check('runStop: edits present but checkpoint not due records "not-due", a third distinct outcome', () => {
      const s = sandbox('not-due');
      fs.mkdirSync(s.home, { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify(stateWith([edit('sess-nd', 'a.js', now)])));
      fs.writeFileSync(path.join(s.home, 'membridge.pid'), String(process.pid));
      // A checkpoint already exists and only one edit has landed since, while
      // checkpointEvery defaults to 12: due=false, for a completely healthy
      // reason.
      fs.writeFileSync(path.join(proj, '.membridge', 'summaries.jsonl'),
        JSON.stringify({ session: 'sess-nd', ts: now, did: 'earlier checkpoint' }) + '\n');
      const r = runHook({ cwd: proj, session_id: 'sess-nd' }, s.home);
      assert.strictEqual(r.stdout, '', 'not due: allow');
      const end = withHome(s.home, () => hookStops.readRecent()).filter(x => x.k === 'end').pop();
      assert.strictEqual(end.outcome, hookStops.OUTCOME.NOT_DUE);
      fs.rmSync(path.join(proj, '.membridge', 'summaries.jsonl'));
    });

    check('runStop: the three silent outcomes are genuinely different tokens (the invariant, stated)', () => {
      const { OUTCOME } = hookStops;
      const trio = [OUTCOME.NOT_DUE, OUTCOME.NO_EDITS, OUTCOME.NO_EDITS_DAEMON_DOWN];
      assert.strictEqual(new Set(trio).size, 3,
        '"captured nothing" and "had nothing to capture" must never share a representation');
    });

    check('runStop: a block is recorded, and the untracked/loop-guard allows are recorded distinctly', () => {
      const s = sandbox('block');
      fs.mkdirSync(s.home, { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify(stateWith([edit('sess-b', 'a.js', now)])));
      fs.writeFileSync(path.join(s.home, 'membridge.pid'), String(process.pid));
      const blocked = runHook({ cwd: proj, session_id: 'sess-b' }, s.home);
      assert.ok(blocked.stdout.includes('"decision":"block"'), 'a due checkpoint still blocks');
      runHook({ cwd: proj, session_id: 'sess-b', stop_hook_active: true }, s.home);
      // A session with no edits anywhere AND a cwd under no tracked project:
      // sess-b would re-home to `proj` via its own edit history, which is the
      // right behaviour and the wrong fixture for this assertion.
      runHook({ cwd: path.join(ROOT, 'nowhere'), session_id: 'sess-unknown' }, s.home);
      const outcomes = withHome(s.home, () => hookStops.readRecent()).filter(x => x.k === 'end').map(x => x.outcome);
      assert.deepStrictEqual(outcomes, [hookStops.OUTCOME.BLOCKED, hookStops.OUTCOME.LOOP_GUARD, hookStops.OUTCOME.UNTRACKED],
        `each allow must name its own reason, got ${JSON.stringify(outcomes)}`);
    });

    check('runStop: a garbled payload is recorded rather than vanishing', () => {
      const s = sandbox('garbled');
      fs.mkdirSync(s.home, { recursive: true });
      const r = spawnSync(process.execPath, [HOOK_JS], {
        input: 'not json', encoding: 'utf8', env: { ...process.env, MEMBRIDGE_HOME: s.home },
      });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '');
      const end = withHome(s.home, () => hookStops.readRecent()).filter(x => x.k === 'end').pop();
      assert.strictEqual(end.outcome, hookStops.OUTCOME.NO_PAYLOAD);
    });

    // -------------------------------------------------------------------
    // Priority 3 (F4): a killed hook must leave a trace. The exec wrapper
    // cannot do this -- it logs only after its child returns, so a hook killed
    // at the 10s Stop timeout (5s for PreToolUse) writes nothing at all, which
    // is exactly the failure it was built to catch.
    // -------------------------------------------------------------------
    check('timeout: a hook run that is killed mid-flight still leaves an "incomplete" record', () => {
      const s = sandbox('killed');
      fs.mkdirSync(s.home, { recursive: true });
      withHome(s.home, () => {
        const rec = hookStops.begin('stop');   // start line written BEFORE any work
        void rec;                              // killed here: no end line ever comes
        const summary = hookStops.summarize();
        assert.strictEqual(summary.incomplete, 1,
            'a start with no end is the only self-record a killed process can leave');
        hookStops.end(rec, hookStops.OUTCOME.NOT_DUE);
        assert.strictEqual(hookStops.summarize().incomplete, 0, 'a completed run must not read as killed');
      });
    });

    // -------------------------------------------------------------------
    // Priority 5 (F5): a block the agent ignored must be countable. The Stop
    // hook exits before the append happens, so it can never observe this
    // itself -- runAppend records the capture from the other side.
    // -------------------------------------------------------------------
    check('block-without-append: an unanswered summary ask is counted; answering it clears the count', () => {
      const s = sandbox('unhonored');
      fs.mkdirSync(s.home, { recursive: true });
      withHome(s.home, () => {
        const a = hookStops.begin('stop');
        hookStops.end(a, hookStops.OUTCOME.BLOCKED, { session: 'sess-x', project: proj, lines: 0 });
        assert.strictEqual(hookStops.summarize().unhonoredBlocks, 1,
          'a block with no capture after it is the model ignoring the ask -- previously invisible');
        hookStops.capture({ session: 'sess-x', project: proj, verification: 'unverified' });
        const after = hookStops.summarize();
        assert.strictEqual(after.unhonoredBlocks, 0, 'the capture answers the ask');
        assert.ok(after.lastCapture, 'and gives status a last-successful-capture signal');
        assert.strictEqual(after.lastCapture.session, 'sess-x');
      });
    });

    check('capture health: a summary that never arrives leaves lastCapture null rather than implying success', () => {
      const s = sandbox('nocapture');
      fs.mkdirSync(s.home, { recursive: true });
      withHome(s.home, () => {
        hookStops.end(hookStops.begin('stop'), hookStops.OUTCOME.NO_EDITS_DAEMON_DOWN, { session: 'z' });
        const sum = hookStops.summarize();
        assert.strictEqual(sum.lastCapture, null, 'no capture must never be reported as a capture');
        assert.strictEqual(sum.silentBecauseUnknown, 1);
      });
    });

    check('hook-stops: the log is bounded, and a torn line never breaks a read', () => {
      const s = sandbox('rotate');
      fs.mkdirSync(s.home, { recursive: true });
      withHome(s.home, () => {
        for (let i = 0; i < 4000; i++) {
          hookStops.end(hookStops.begin('stop'), hookStops.OUTCOME.NOT_DUE, { session: `s${i}`, filler: 'x'.repeat(120) });
        }
        const size = fs.statSync(hookStops.logPath()).size;
        assert.ok(size < 1024 * 1024, `an unbounded diagnostic log is a second bug; size=${size}`);
        fs.appendFileSync(hookStops.logPath(), '{"k":"end","truncated');
        assert.ok(hookStops.readRecent().length > 0, 'a torn tail line must be skipped, not thrown on');
      });
    });
  }

  // ---------------------------------------------------------------------
  // Priority 3 of the brief: verification groundwork. ADDITIVE ONLY.
  // ---------------------------------------------------------------------
  {
    const vproj = path.join(ROOT, 'verifyproj');
    fs.mkdirSync(path.join(vproj, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(vproj, 'real.js'), '// a file that exists\n');
    const stateFor = files => ({
      projects: {
        [vproj]: {
          events: files.map(f => ({ ts: new Date().toISOString(), kind: 'edit', session: 'vs', file: path.join(vproj, f) })),
        },
      },
    });
    const healthy = { running: true, stale: false, stateMissing: false };

    check('verify: a cited file the session really edited is VERIFIED', () => {
      const r = hookVerify.verifySummary({
        projectPath: vproj,
        entry: { session: 'vs', did: 'changed the thing', highlights: [{ file: 'real.js', note: 'why' }] },
        state: stateFor(['real.js']),
        health: healthy,
      });
      assert.strictEqual(r.status, 'verified');
      assert.ok(r.checks.some(c => c.check === 'cited-file' && c.result === 'pass'));
    });

    check('verify: a cited file that neither exists nor was touched is CONTRADICTED', () => {
      const r = hookVerify.verifySummary({
        projectPath: vproj,
        entry: { session: 'vs', did: 'refactored the imaginary module', highlights: [{ file: 'nope/ghost.js', note: 'x' }] },
        state: stateFor(['real.js']),
        health: healthy,
      });
      assert.strictEqual(r.status, 'contradicted',
        'the one thing that CAN be checked deterministically, checked');
    });

    check('verify: a summary with nothing checkable is UNVERIFIED, never optimistically verified', () => {
      const r = hookVerify.verifySummary({
        projectPath: vproj,
        entry: { session: 'vs', did: 'thought hard about the architecture' },
        state: stateFor(['real.js']),
        health: healthy,
      });
      assert.strictEqual(r.status, 'unverified', 'unverifiable prose must never be stamped verified');
    });

    check('verify: a stale ledger yields UNVERIFIED, never CONTRADICTED -- absence of evidence is not evidence', () => {
      const r = hookVerify.verifySummary({
        projectPath: vproj,
        entry: { session: 'vs', did: 'did real work', highlights: [{ file: 'ghost.js', note: 'x' }] },
        state: { projects: {} },
        health: { running: false, stale: true, stateMissing: true },
      });
      assert.strictEqual(r.status, 'unverified',
        'when the daemon is down MemBridge cannot check -- that is the same distinction as F2, applied to claims');
    });

    check('runAppend: stamps the verification additively, without touching any existing field', () => {
      const s = sandbox('append-stamp');
      fs.mkdirSync(s.home, { recursive: true });
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify({
        version: util.STATE_VERSION, files: {}, catchup: {}, feedback: {},
        projects: { [vproj]: { events: [{ ts: new Date().toISOString(), kind: 'edit', session: 'vs2', file: path.join(vproj, 'real.js') }] } },
      }));
      fs.writeFileSync(path.join(s.home, 'membridge.pid'), String(process.pid));
      const target = path.join(vproj, '.membridge', 'summaries.jsonl');
      const line = { session: 'vs2', ts: '2026-08-06T00:00:00Z', goal: 'g', did: 'd', headline: 'hd', decisions: 'one', gotchas: 'two', highlights: [{ file: 'real.js', note: 'n' }] };
      const r = spawnSync(process.execPath, [HOOK_JS, 'append', target, JSON.stringify(line)], {
        encoding: 'utf8', env: { ...process.env, MEMBRIDGE_HOME: s.home },
      });
      assert.strictEqual(r.status, 0, r.stderr);
      const written = JSON.parse(fs.readFileSync(target, 'utf8').trim().split('\n').pop());
      for (const k of Object.keys(line)) {
        assert.deepStrictEqual(written[k], line[k], `existing field "${k}" must survive byte-for-byte`);
      }
      assert.strictEqual(written.verification, 'verified');
      assert.ok(Array.isArray(written.verificationChecks));
      const cap = withHome(s.home, () => hookStops.summarize()).lastCapture;
      assert.ok(cap && cap.session === 'vs2', 'the append is the only place that can record a real capture');
      fs.rmSync(target);
    });

    check('runAppend: a contradicted line is still WRITTEN -- this records a fact, it does not adjudicate', () => {
      const s = sandbox('append-contradicted');
      fs.mkdirSync(s.home, { recursive: true });
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify({
        version: util.STATE_VERSION, files: {}, catchup: {}, feedback: {},
        projects: { [vproj]: { events: [{ ts: new Date().toISOString(), kind: 'edit', session: 'vs3', file: path.join(vproj, 'real.js') }] } },
      }));
      fs.writeFileSync(path.join(s.home, 'membridge.pid'), String(process.pid));
      const target = path.join(vproj, '.membridge', 'summaries.jsonl');
      const r = spawnSync(process.execPath, [HOOK_JS, 'append', target,
        JSON.stringify({ session: 'vs3', did: 'd', highlights: [{ file: 'imaginary/ghost.js', note: 'n' }] })], {
        encoding: 'utf8', env: { ...process.env, MEMBRIDGE_HOME: s.home },
      });
      assert.strictEqual(r.status, 0, 'refusing the write would be a product decision nobody has made');
      const written = JSON.parse(fs.readFileSync(target, 'utf8').trim().split('\n').pop());
      assert.strictEqual(written.verification, 'contradicted');
      fs.rmSync(target);
    });

    check('backward compatibility: a legacy line with no verification field still counts as a checkpoint', () => {
      const legacyProj = path.join(ROOT, 'legacyproj');
      fs.mkdirSync(path.join(legacyProj, '.membridge'), { recursive: true });
      const f = path.join(legacyProj, '.membridge', 'summaries.jsonl');
      // Exactly the shape already on Andrew's disk: no verification, no
      // verificationChecks. It must keep parsing and keep counting.
      fs.writeFileSync(f, JSON.stringify({ session: 'old', ts: '2026-01-01T00:00:00Z', did: 'legacy work', headline: 'h' }) + '\n');
      assert.strictEqual(hooks.countSummaryLines(legacyProj, 'old'), 1);
      assert.strictEqual(hooks.lastSummaryTs(legacyProj, 'old'), '2026-01-01T00:00:00Z');
      assert.strictEqual(hooks.hasSummaryLine(legacyProj, 'old'), true);
    });

    check('scan: the new fields are inert downstream -- a stamped line produces the same summary event', () => {
      const scan = require('../../lib/scan');
      const sp = path.join(ROOT, 'scanproj');
      fs.mkdirSync(path.join(sp, '.membridge'), { recursive: true });
      const mk = extra => JSON.stringify({ session: 'sc', ts: '2026-01-01T00:00:00Z', did: 'the outcome', headline: 'hd', ...extra }) + '\n';
      fs.writeFileSync(path.join(sp, '.membridge', 'summaries.jsonl'), mk({}));
      const bare = scan.scanSummaries({ projects: { [sp]: { events: [] } }, files: {} }, {});
      fs.writeFileSync(path.join(sp, '.membridge', 'summaries.jsonl'),
        mk({ verification: 'verified', verificationChecks: [{ check: 'cited-file', result: 'pass' }] }));
      const stamped = scan.scanSummaries({ projects: { [sp]: { events: [] } }, files: {} }, {});
      assert.strictEqual(stamped.length, 1);
      assert.deepStrictEqual(
        { ...stamped[0], ts: 'X' }, { ...bare[0], ts: 'X' },
        'nothing downstream may change shape because of the new fields');
    });
  }

  // ---------------------------------------------------------------------
  // Priority 7 (F11) + hot-path discipline.
  // ---------------------------------------------------------------------
  {
    check('registration: SubagentStop is deliberately NOT registered (a recorded decision, not an oversight)', () => {
      const s = sandbox('subagent');
      writeJson(s.settings, {});
      withSettings(s.settings, () => {
        hooks.reconcileStopHook();
        hooks.reconcileNotesHooks();
      });
      const events = Object.keys(readJson(s.settings).hooks || {});
      assert.ok(!events.includes('SubagentStop'),
        'a parallel agent run yields ONE summary, written by the parent; changing that is a product decision');
      assert.ok(events.includes('Stop'));
    });

    check('hot path: requiring lib/hooks.js never pulls the verifier into the require cache', () => {
      // The recall hook reaches runStop's module on every Read. hook-stops is
      // required eagerly (runStop's first statement needs it, and it pulls in
      // nothing but fs/path/util); hook-verify is append-only work and must
      // stay lazy. Same discipline as the tree-sitter pin on hooks-recall.
      const script = `require(${JSON.stringify(path.join(LIB, 'hooks.js'))});
        console.log(JSON.stringify(Object.keys(require.cache).filter(k => /hook-verify/.test(k))));`;
      const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env } });
      assert.strictEqual(out.status, 0, out.stderr);
      assert.deepStrictEqual(JSON.parse(out.stdout.trim()), [], 'the verifier loaded on the hot path');
    });
  }

  h.finish();
}

main();
