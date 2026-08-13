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

  // ---------------------------------------------------------------------
  // Consent (#48, #49). Two defects, one missing record.
  //
  // #48: the first-run dialog was decorative. ensureInstalled() wrote the Stop
  // hook, BOTH PreToolUse hooks, the SessionStart hook and a Bash auto-approve
  // rule, and only THEN did the dialog ask. "Not now" wrote
  // distill.consent='declined', which no hook body and no reconciler ever
  // read, and returned the sentence "no hook installed" over an install that
  // had just happened.
  //
  // #49: `remove-hooks` and the Settings toggle stripped the entries and the
  // next launch put them all back, because ensureInstalled consulted nothing.
  //
  // Every test below pins the RECORD, not a sentence: the same shape
  // mcp-register uses for its 'unregister' opt-out.
  // ---------------------------------------------------------------------
  {
    const hookConsent = require('../../lib/hook-consent');
    const consentLib = require('../../lib/consent');
    // A sandbox with its own MemBridge home, so each block gets its own
    // config.json and one block's decision can never leak into another's.
    const consentBox = (name, config) => {
      const s = sandbox(name);
      fs.mkdirSync(s.home, { recursive: true });
      if (config) fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify(config, null, 2));
      return s;
    };
    const inBox = (s, fn) => withHome(s.home, () => withSettings(s.settings, () => asDurableInstall(fn)));
    const ourEntries = settings => JSON.stringify(settings.hooks || {}).match(/membridge-hook\.js/g) || [];

    check('#48 first run: ensureInstalled writes NOTHING into settings.json before the user has been asked', () => {
      const s = consentBox('consent-fresh');
      writeJson(s.settings, { model: 'opus' });
      const r = inBox(s, () => hooks.ensureInstalled());
      assert.deepStrictEqual(readJson(s.settings), { model: 'opus' },
        'the dialog asks AFTER this runs -- anything written here was written without consent');
      assert.strictEqual(r.registration, 'no-consent');
      assert.strictEqual(r.consent, 'unknown');
    });

    check('#48 first run: "Not now" leaves nothing installed and SAYS so truthfully', () => {
      const s = consentBox('consent-declined');
      writeJson(s.settings, { model: 'opus' });
      const msg = inBox(s, () => {
        hooks.ensureInstalled();              // the launch path, as it really runs
        return consentLib.applyConsent('declined');
      });
      assert.deepStrictEqual(readJson(s.settings), { model: 'opus' });
      assert.ok(/no hook installed/.test(msg), `message must stay true: ${msg}`);
      assert.strictEqual(withHome(s.home, () => hookConsent.state()), 'declined');
    });

    check('#48: a decline over an unreadable settings.json is still RECORDED, and says it could not clean up', () => {
      // The cleanup reads settings.json, which throws on a malformed file. That
      // must never take the first-run dialog handler down with it, and it must
      // never report the removal it did not do -- but the decision itself lives
      // in config.json and is honoured regardless.
      const s = consentBox('consent-declined-unreadable');
      fs.writeFileSync(s.settings, '{ not json');
      const msg = inBox(s, () => consentLib.applyConsent('declined'));
      assert.ok(/could not be read/.test(msg), `the failure must be reported, not swallowed: ${msg}`);
      assert.ok(!/no hook installed/.test(msg), 'and it must not claim an install that could not be checked');
      assert.strictEqual(withHome(s.home, () => hookConsent.state()), 'declined',
        'the decision must survive a cleanup that could not run');
      assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), '{ not json', 'the unreadable file must be left alone');
    });

    check('#48: a decline that finds a pre-consent install REMOVES it, and says what it removed', () => {
      // The state every user who ever clicked "Not now" is in today: the hooks
      // went in before the question. Recording the decline is not enough --
      // the sentence is only true if the entries are gone.
      const s = consentBox('consent-declined-cleanup', { hooks: { consent: 'granted' } });
      writeJson(s.settings, { model: 'opus' });
      const msg = inBox(s, () => {
        hooks.ensureInstalled();
        assert.ok(ourEntries(readJson(s.settings)).length >= 3, 'fixture: the pre-consent install must be there to remove');
        return consentLib.applyConsent('declined');
      });
      const after = readJson(s.settings);
      assert.deepStrictEqual(ourEntries(after), [], 'a decline must leave no MemBridge hook behind');
      assert.strictEqual((after.permissions || {}).allow, undefined, 'the auto-approve rule is part of the install');
      assert.ok(/removed/i.test(msg), `the message must report the removal, not claim nothing was installed: ${msg}`);
    });

    check('#48: the Stop hook body stands down when consent was declined', () => {
      const s = consentBox('consent-body-stop', { distill: { enabled: true, consent: 'declined' } });
      const proj = path.join(s.dir, 'proj');
      fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify({
        version: util.STATE_VERSION, files: {}, catchup: {}, feedback: {},
        projects: { [proj]: { events: [{ ts: new Date().toISOString(), kind: 'edit', session: 'sd1', file: path.join(proj, 'a.js') }] } },
      }));
      fs.writeFileSync(path.join(s.home, 'membridge.pid'), String(process.pid));
      const run = () => spawnSync(process.execPath, [HOOK_JS], {
        input: JSON.stringify({ session_id: 'sd1', cwd: proj, hook_event_name: 'Stop' }),
        encoding: 'utf8', env: { ...process.env, MEMBRIDGE_HOME: s.home },
      });
      const declined = run();
      assert.strictEqual(declined.status, 0, 'a declined user must never have their session end trapped');
      assert.strictEqual(declined.stdout, '',
        'the block JSON is how this hook stops a session end -- a declined user must not get one');
      assert.strictEqual(withHome(s.home, () => hookStops.summarize()).lastStop.outcome, 'declined',
        'the flight recorder must say WHY it was silent -- "declined" is not "no edits"');
      // The same fixture with consent granted DOES block: this proves the test
      // above measures the gate and not a broken fixture.
      fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ distill: { enabled: true, consent: 'granted' } }));
      const granted = run();
      assert.strictEqual(JSON.parse(granted.stdout || '{}').decision, 'block',
        `fixture check: a consenting user is still asked (${granted.stdout} ${granted.stderr})`);
    });

    // The three PreToolUse/SessionStart bodies. Each is asserted as a PAIR --
    // the same fixture, once granted and once declined -- because "produced no
    // output" on its own is what a broken fixture looks like too. These are the
    // hooks that had NO consent check of any kind: recall and search run off
    // `config.recall.enabled` (default ON) and the notes hook off its own
    // switch, so all three kept running for a user who had said no.
    const bodyBox = name => {
      const s = consentBox(name);
      const proj = path.join(s.dir, 'proj');
      fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(path.join(s.home, 'state.json'), JSON.stringify({
        version: util.STATE_VERSION, files: {}, catchup: {}, feedback: {},
        projects: { [proj]: { events: [
          { ts: now, kind: 'prompt', session: 's1', text: 'make the widget exporter work', source: 'Claude Code' },
          { ts: now, kind: 'edit', session: 's1', file: path.join(proj, 'a.js') },
          { ts: now, kind: 'summary', session: 's1', text: 'built the widget exporter' },
        ] } },
      }));
      return { ...s, proj };
    };
    // Both sides of every pair run the same command with the same payload; only
    // the recorded decision differs.
    const runBody = (s, sub, payload) => {
      const r = spawnSync(process.execPath, sub ? [HOOK_JS, sub] : [HOOK_JS], {
        input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, MEMBRIDGE_HOME: s.home },
      });
      assert.strictEqual(r.status, 0, `the hook must always fail open: ${r.stderr}`);
      return r.stdout;
    };
    const withDecision = (s, decision, fn) => {
      fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ distill: { enabled: true, consent: decision } }));
      return fn();
    };

    check('#48: the recall hook body (every Read) stands down when consent was declined', () => {
      const s = bodyBox('consent-body-recall');
      const file = path.join(s.proj, 'big.js');
      const content = Array.from({ length: 40 }, (_, i) => `function f${i}() { doWork(${i}); }`).join('\n') + '\n';
      fs.writeFileSync(file, content);
      const recallStore = require('../../lib/recall-store');
      const ledgerStore = require('../../lib/ledger-store');
      const recallLib = require('../../lib/recall');
      withHome(s.home, () => {
        recallStore.put(s.proj, 'big.js', {
          contentHash: require('crypto').createHash('sha1').update(content).digest('hex'),
          skeleton: 'SKELETON_FOR_BIG', skeletonTokens: 50, fileTokens: 900, engine: 'strip', rejections: 0,
        });
        ledgerStore.writeLedger(s.proj, {
          fileReaders: { 'big.js': { sessions: ['other-session'], reads: 2, lastTs: 't', firstTs: 't', firstSession: 'other-session' } },
        });
      });
      // Outside the 3% measurement holdout, chosen deterministically the way
      // lib/recall.js's own tests do -- never a flaky pick.
      const bucket = sid => require('crypto').createHash('sha1').update(String(sid)).digest().readUInt32BE(0) % 100;
      let session = null;
      for (let i = 0; i < 1000 && !session; i++) {
        const cand = `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`;
        if (bucket(cand) >= recallLib.HOLDOUT_PCT) session = cand;
      }
      const payload = { session_id: session, cwd: s.proj, tool_name: 'Read', tool_input: { file_path: file, limit: 100 } };
      assert.strictEqual(withDecision(s, 'declined', () => runBody(s, 'recall', payload)), '',
        'a declined user must not have their Read intercepted');
      const granted = withDecision(s, 'granted', () => runBody(s, 'recall', payload));
      assert.strictEqual(JSON.parse(granted).hookSpecificOutput.permissionDecision, 'deny',
        'fixture check: this same read IS intercepted for a consenting user');
    });

    check('#48: the search hook body (every Grep/Glob) stands down when consent was declined', () => {
      const s = bodyBox('consent-body-search');
      const payload = {
        session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: s.proj,
        tool_name: 'Grep', tool_input: { pattern: 'widget exporter' },
      };
      assert.strictEqual(withDecision(s, 'declined', () => runBody(s, 'search', payload)), '',
        'the search hook ships with no switch of its own -- consent is the only thing that can stop it');
      const granted = withDecision(s, 'granted', () => runBody(s, 'search', payload));
      assert.ok(/MemBridge memory/.test(granted), `fixture check: a consenting user still gets memory: ${granted}`);
    });

    check('#48: the teammate-notes SessionStart body stands down when consent was declined', () => {
      const s = bodyBox('consent-body-notes');
      fs.writeFileSync(path.join(s.proj, '.membridge', 'summaries.jsonl'),
        JSON.stringify({ session: 's1', ts: new Date().toISOString(), did: 'built the widget exporter', headline: 'widget exporter' }) + '\n');
      const payload = {
        session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: s.proj,
        source: 'startup', hook_event_name: 'SessionStart',
      };
      assert.strictEqual(withDecision(s, 'declined', () => runBody(s, 'notes-session-start', payload)), '',
        'a declined user must not have context injected into their session');
      const granted = withDecision(s, 'granted', () => runBody(s, 'notes-session-start', payload));
      assert.ok(/SessionStart/.test(granted), `fixture check: a consenting user still gets the block: ${granted}`);
    });

    check('#49: remove-hooks records an opt-out that the next launch HONOURS -- all four reconcilers', () => {
      const s = consentBox('consent-remove', { hooks: { consent: 'granted' } });
      writeJson(s.settings, { model: 'opus' });
      inBox(s, () => {
        hooks.ensureInstalled();
        const installed = readJson(s.settings);
        assert.deepStrictEqual(Object.keys(installed.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
        hooks.removeHooks();
      });
      assert.deepStrictEqual(ourEntries(readJson(s.settings)), [],
        'fixture: remove-hooks already worked -- the bug is what comes next');
      assert.strictEqual(withHome(s.home, () => hookConsent.state()), 'declined',
        'remove-hooks must record the opt-out, exactly like mcp-register.unregisterNow');
      const r = inBox(s, () => hooks.ensureInstalled());
      const afterLaunch = readJson(s.settings);
      assert.deepStrictEqual(ourEntries(afterLaunch), [],
        'the next launch restored the hooks the user just removed');
      assert.strictEqual((afterLaunch.permissions || {}).allow, undefined,
        'and the auto-approve rule came back with them');
      assert.strictEqual(r.registration, 'no-consent');
    });

    check('#49: each reconciler refuses on its own -- gating only the Stop one leaves three doors open', () => {
      const s = consentBox('consent-four-doors', { hooks: { consent: 'declined' } });
      writeJson(s.settings, { model: 'opus' });
      const results = inBox(s, () => [
        hooks.reconcileStopHook(), hooks.reconcileRecallHook(),
        hooks.reconcileSearchHook(), hooks.reconcileNotesHooks(),
      ]);
      for (const r of results) {
        assert.strictEqual(r.optedOut, true, 'a reconciler called directly must honour the opt-out too');
        assert.strictEqual(r.wrote, false);
      }
      assert.deepStrictEqual(readJson(s.settings), { model: 'opus' });
    });

    check('#49: setup-hooks is the documented way back in, and it sticks across a launch', () => {
      const s = consentBox('consent-back-in', { hooks: { consent: 'declined' } });
      writeJson(s.settings, { model: 'opus' });
      const r = inBox(s, () => {
        hooks.setupHooks();
        return hooks.ensureInstalled();
      });
      assert.ok(ourEntries(readJson(s.settings)).length >= 3, 'an explicit setup-hooks must override an earlier opt-out');
      assert.strictEqual(withHome(s.home, () => hookConsent.state()), 'granted');
      assert.notStrictEqual(r.registration, 'no-consent', 'the launch after an explicit opt-IN must keep reconciling');
    });

    check('existing install: a granted user keeps working, with no record and no re-prompt', () => {
      // Andrew's live config: distill.consent granted, written long before
      // config.hooks existed. This must reconcile exactly as it always did.
      const s = consentBox('consent-legacy-grant', { distill: { enabled: true, consent: 'granted' } });
      writeJson(s.settings, { model: 'opus' });
      inBox(s, () => hooks.ensureInstalled());
      const after = readJson(s.settings);
      assert.deepStrictEqual(Object.keys(after.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
      assert.strictEqual(consentLib.needsConsentPrompt(withHome(s.home, () => util.getConfig())), false,
        'a user who already said yes must never be asked again');
    });

    check('existing install: hooks on disk but no consent record anywhere is grandfathered, once', () => {
      // The CLI user who ran `membridge setup-hooks` and never saw a dialog.
      // Standing down would break a working install to satisfy bookkeeping.
      const s = consentBox('consent-legacy-install');
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: asDurableInstall(() => hooks.hookCommand()), timeout: 10 }] }] },
      });
      const r = inBox(s, () => hooks.ensureInstalled());
      assert.notStrictEqual(r.registration, 'no-consent', 'an install that predates the record must keep reconciling');
      assert.ok(ourEntries(readJson(s.settings)).length >= 3, 'the launch must still repair the rest of the install');
      const cfg = withHome(s.home, () => util.getConfig());
      assert.strictEqual(cfg.hooks.consent, 'granted', 'the grandfathered grant must be recorded so the probe runs once');
      assert.strictEqual(cfg.hooks.via, 'pre-existing-install', 'and it must say it was inferred, not answered');
      assert.strictEqual(consentLib.needsConsentPrompt(cfg), false, 'a working install must not be interrupted by a dialog');
    });

    check('existing install: grandfathering asks whether a hook is REGISTERED, not whether it still resolves', () => {
      // The commonest legacy shape on a real machine: the app moved, npm
      // relinked, or the worktree the command points at is gone. Judging that
      // install by liveness would read it as "never installed", stand down,
      // and leave the one machine that most needs a repair reconcile without
      // one -- the exact repair this launch path exists to perform.
      const s = consentBox('consent-legacy-dead-path');
      writeJson(s.settings, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/nonexistent/bin/node" "/gone/lib/membridge-hook.js"', timeout: 10 }] }] },
      });
      assert.strictEqual(inBox(s, () => hooks.isHookInstalled()), false,
        'fixture: this install is genuinely broken -- that is the point');
      const r = inBox(s, () => hooks.ensureInstalled());
      assert.notStrictEqual(r.registration, 'no-consent', 'a broken consented install must still be repaired');
      assert.strictEqual(inBox(s, () => hooks.isHookInstalled()), true, 'and the repair must have actually happened');
    });
  }

  // ---------------------------------------------------------------------
  // Area prefixes on distilled points (session-area-headers, task 1).
  // ---------------------------------------------------------------------
  {
    const { splitAreaPrefix, AREAS, POINT_MAX } = require('../../lib/hooks.js');

    // Matches the calling convention of the `runAppend:` checks above: a
    // fresh sandbox home, a summaries.jsonl path under a throwaway project
    // dir, invoked via the real CLI entrypoint. Failures land on stderr
    // (see fail() in runAppend), which is what this returns.
    function runAppendResult(line) {
      const s = sandbox('area-prefix');
      fs.mkdirSync(s.home, { recursive: true });
      const target = path.join(s.dir, 'proj', '.membridge', 'summaries.jsonl');
      const r = spawnSync(process.execPath, [HOOK_JS, 'append', target, line], {
        encoding: 'utf8', env: { ...process.env, MEMBRIDGE_HOME: s.home },
      });
      return r.stderr;
    }

    check('splitAreaPrefix reads a known area off the front', () => {
      assert.strictEqual(splitAreaPrefix('[UI/UX] Removed the menu item').area, 'UI/UX');
    });
    check('splitAreaPrefix returns the text without the prefix', () => {
      assert.strictEqual(splitAreaPrefix('[UI/UX] Removed the menu item').text, 'Removed the menu item');
    });
    check('splitAreaPrefix reports no area for an unprefixed line', () => {
      assert.strictEqual(splitAreaPrefix('Removed the menu item').area, null);
    });
    check('splitAreaPrefix leaves an unprefixed line whole', () => {
      assert.strictEqual(splitAreaPrefix('Removed the menu item').text, 'Removed the menu item');
    });
    // A bracket that is not a prefix must not be eaten -- points legitimately
    // contain brackets mid-sentence.
    check('splitAreaPrefix ignores a bracket that is not leading', () => {
      assert.strictEqual(splitAreaPrefix('Fixed the [object Object] label').area, null);
    });
    check('AREAS holds exactly eight areas', () => {
      assert.strictEqual(AREAS.length, 8);
    });

    // The area parser exists twice on purpose: this one validates what an agent
    // writes, ui/src/features/session/distill.ts parseAreaPoint renders what any
    // tool ever wrote, and no module can be shared across the CommonJS/TypeScript
    // boundary between them. A rule that changes on one side only is a point
    // accepted one way and displayed another, so this table is MIRRORED VERBATIM
    // in ui/src/features/session/distill.test.ts -- change one, change both, or
    // one side fails.
    //
    // Two of these rows are the divergences a review found and this pins shut:
    // a "]" not followed by whitespace is not a label (so "[clipWords](...)"
    // keeps its text), and the length bound is measured on the label with its
    // internal whitespace collapsed (the UI flattens the line first; this side
    // used to bound the raw string, so "[a<30 spaces>b]" was a prefix there and
    // not here).
    const PARSER_TABLE = [
      { input: '[UI/UX] Removed the menu item', area: 'UI/UX', text: 'Removed the menu item' },
      { input: 'Removed the menu item', area: null, text: 'Removed the menu item' },
      { input: 'Fixed the [object Object] label', area: null, text: 'Fixed the [object Object] label' },
      { input: '[clipWords](src/mappers.ts) now trims', area: null, text: '[clipWords](src/mappers.ts) now trims' },
      { input: '[Tests]no space', area: null, text: '[Tests]no space' },
      { input: '[ ] x', area: null, text: '[ ] x' },
      { input: '[] x', area: null, text: '[] x' },
      { input: `[a${' '.repeat(30)}b] note`, area: 'a b', text: 'note' },
      { input: `[${'x'.repeat(20)}] note`, area: 'x'.repeat(20), text: 'note' },
      { input: `[${'x'.repeat(21)}] note`, area: null, text: `[${'x'.repeat(21)}] note` },
      { input: '[Tests]', area: 'Tests', text: '' },
    ];
    for (const row of PARSER_TABLE) {
      check(`splitAreaPrefix classifies ${JSON.stringify(row.input)}`, () => {
        const out = splitAreaPrefix(row.input);
        assert.strictEqual(out.area, row.area, `area for ${JSON.stringify(row.input)}`);
        assert.strictEqual(out.text, row.text, `text for ${JSON.stringify(row.input)}`);
      });
    }

    // The whole point of the bracket rule: a point that opens with a bracket
    // that is not a label must reach summaries.jsonl unrejected and unaltered.
    const bracketOpener = JSON.stringify({
      session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
      decisions: '[clipWords](src/mappers.ts) now trims to the word',
    });
    check('a point opening with a non-label bracket is not rejected as an area', () => {
      assert.ok(!/not one of the areas/.test(String(runAppendResult(bracketOpener))));
    });

    // POINT_MAX applies to the POINT, not to the prefix. A 120-char point with a
    // 15-char prefix is still a legal 120-char point.
    const longPoint = 'x'.repeat(POINT_MAX);
    const okLine = JSON.stringify({
      session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
      decisions: `[Integrations] ${longPoint}`,
    });
    check('a full-length point is not rejected for carrying a prefix', () => {
      assert.ok(!/invalid line/.test(String(runAppendResult(okLine))));
    });

    const badArea = JSON.stringify({
      session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
      decisions: '[Frontend] Renamed the thing',
    });
    check('an unknown area label is rejected loudly', () => {
      assert.ok(/not one of the areas/.test(String(runAppendResult(badArea))));
    });

    const noPrefix = JSON.stringify({
      session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
      decisions: 'Renamed the thing',
    });
    check('an unprefixed point is still accepted', () => {
      assert.ok(!/invalid line/.test(String(runAppendResult(noPrefix))));
    });
  }

  // ---------------------------------------------------------------------
  // The two vocabularies are one vocabulary (session-area-headers, task 4).
  // The hook writes "[UI/UX] ..." onto a point; the day card derives
  // "UI/UX" from file paths. They are separate literals in two languages,
  // so nothing but this test stops them drifting into a header and a tag
  // that name the same work differently.
  // ---------------------------------------------------------------------
  {
    const { AREAS } = require('../../lib/hooks.js');
    // ROOT (from the harness) is a throwaway sandbox dir (fs.mkdtempSync),
    // not this checkout's repo root, so it cannot find areaTags.ts. Use the
    // same __dirname-relative path the file already uses for LIB above, and
    // that audit-story.test.js uses for its own real-repo-source reads.
    const REPO = path.join(__dirname, '..', '..');
    const src = h.readSource(path.join(REPO, 'ui/src/features/feed/areaTags.ts'));
    // The union type is the tags' declaration of the vocabulary.
    const union = /export type Area =([\s\S]*?)\n\n/.exec(src);
    check('areaTags.ts still declares an Area union', () => {
      assert.ok(union, 'the Area union regex must still match areaTags.ts');
    });
    const declared = union ? (union[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];
    check('every hook area exists in the tag vocabulary', () => {
      for (const a of AREAS) {
        assert.ok(declared.includes(a), `AREAS has "${a}" but areaTags.ts's Area union does not`);
      }
    });
    check('every tag area exists in the hook vocabulary', () => {
      for (const a of declared) {
        assert.ok(AREAS.includes(a), `areaTags.ts's Area union has "${a}" but AREAS does not`);
      }
    });
  }

  h.finish();
}

main();
