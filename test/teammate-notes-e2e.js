'use strict';
// NOT_RUN_BY_CI: a manual demonstration harness, not coverage. CI runs
// `node test/run.js` and nothing else, which discovers test/suites/*.test.js
// plus test/run-tests.js — never this file. Run it by hand:
//     node test/teammate-notes-e2e.js        (~1.3s, 22 checks, passes today)
//
// AND IT IS NOT A COVERAGE GAP EITHER, which is the part worth knowing before
// anyone "fixes" this by wiring it into CI. Scored as a mutation runner
// (`node test/mutate.js --cmd "node test/teammate-notes-e2e.js"`) against the
// two regions the header below claims it uniquely covers:
//
//   lib/teamsync.js pull mapping   this file: 0 killed / 8
//                                  discovered suites: 6 killed / 8 (no core)
//   lib/teammate-notes-store.js    this file: 0 killed / 9
//                                  core: 5 killed BY ASSERTION
//
// Zero mutants killed that the suites do not already kill, and far fewer
// overall — in the file it is named after. Wiring it into CI would buy
// wall-clock and no discrimination. Its value is what its name says: watching
// the real pipeline work end to end, with real subprocesses, before
// dogfooding. Keep it for that; do not count it as coverage.
//
// The claim below — that it catches what "no fixture-fed test could see" — was
// true of the bug it was written for (Task 6's author rename). It is not a
// statement about the suite as it stands today, and the numbers above are.
//
// End-to-end proof for live teammate decisions
// (docs/superpowers/specs/2026-07-28-live-teammate-decisions-design.md,
// plan Task 12).
//
// WHAT MAKES THIS DIFFERENT FROM THE UNIT SUITE. Every notes check in
// test/run-tests.js hands the index a HAND-WRITTEN wire row. That is the one
// shape the daemon never actually has: lib/teamsync.js's pull renames
// `author_name` to `author` before storing, and Task 6 found that reading only
// the wire name attributed every note to "a teammate" AND changed every noteId,
// silently keying the whole seen/dedupe layer on a shadow set. No fixture-fed
// test could see it. So this script refuses to fabricate a row anywhere:
//
//   a teammate's real session events
//     -> lib/memorydb.js buildEntries (highlights -> changes)
//     -> lib/teamsync.js entryToRow (paths -> repo-root-relative WIRE keys)
//     -> a real HTTP round trip through the offline Supabase stand-in
//     -> lib/teamsync.js pullProject (the author rename)
//     -> `membridge sync`, the real CLI, which rebuilds the index
//     -> the real PreToolUse hook and the real SessionStart hook, spawned as
//        subprocesses, asserted on their actual stdout
//
// Two identity problems are proved with genuinely mismatched checkouts rather
// than simulations: the teammate tracks a monorepo ROOT while this machine
// tracks `packages/api` (spec §7), and one session runs from a nested linked
// worktree. Both assert that the naive tracked-relative path DIFFERS from the
// wire key, so neither can pass tautologically.
//
// Opt-in, exactly like test/recall-e2e.js -- never wired into `npm test`:
//   node test/teammate-notes-e2e.js
//
// NO NETWORK, and NOTHING OUTSIDE THE FIXTURE. The backend is an in-process
// mock on a free loopback port; HOME, MEMBRIDGE_HOME, the agent session dirs
// and the Claude settings path are all injected, into this process and into
// every child. The last check proves not one byte of the developer's own
// ~/.claude, ~/.claude.json, ~/.codex, ~/.cursor or ~/.membridge was touched.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Isolation. Captured BEFORE process.env.HOME is replaced, because that is
// what os.homedir() reads -- the snapshot must name the real files.
// ---------------------------------------------------------------------------
const REAL_HOME = os.homedir();

// Files this feature's code paths could plausibly write, and which no other
// process rewrites on a timer: byte-for-byte comparison is safe here.
const REAL_STABLE_FILES = [
  path.join(REAL_HOME, '.claude', 'settings.json'),   // hooks.js writes here
  path.join(REAL_HOME, '.codex', 'config.toml'),      // mcp-register writes here
  path.join(REAL_HOME, '.cursor', 'mcp.json'),
  path.join(REAL_HOME, '.membridge', 'config.json'),
];
// Files that DO churn independently: the user's own daemon rewrites
// ~/.membridge/state.json on every tick and Claude Code rewrites ~/.claude.json
// as it runs, so a content snapshot of these flakes on any live machine and
// would eventually be deleted for being noisy -- which is worse than a weaker
// check. They are held to the property that actually matters instead: not one
// byte of this run's fixture may appear in them.
const REAL_CHURNING_FILES = [
  path.join(REAL_HOME, '.membridge', 'state.json'),
  path.join(REAL_HOME, '.claude.json'),
];
const readOrAbsent = f => {
  try { return fs.readFileSync(f, 'utf8'); } catch (err) { return `absent:${err.code}`; }
};
const snapshotStable = () => REAL_STABLE_FILES.map(readOrAbsent);
const stableBefore = snapshotStable();

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-notes-e2e-'));
const FAKE_HOME = path.join(ROOT, 'fake-home');
const HOME_TEAMMATE = path.join(ROOT, 'home-teammate');
const HOME_MINE = path.join(ROOT, 'home-mine');
fs.mkdirSync(path.join(FAKE_HOME, '.claude'), { recursive: true });

// Injected into this process AND (via childEnv) into every subprocess.
const ISOLATION = {
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  MEMBRIDGE_NO_DIAGNOSTICS: '1',                                    // never a real network call
  MEMBRIDGE_CLAUDE_DIR: path.join(ROOT, 'claude-projects'),         // never the real ~/.claude/projects
  MEMBRIDGE_CODEX_DIR: path.join(ROOT, 'codex-sessions'),
  MEMBRIDGE_CLAUDE_SETTINGS: path.join(FAKE_HOME, '.claude', 'settings.json'),
  MEMBRIDGE_HOME: HOME_TEAMMATE,
};
Object.assign(process.env, ISOLATION);

const util = require('../lib/util');
const teamsync = require('../lib/teamsync');
const notes = require('../lib/teammate-notes');
const notesStore = require('../lib/teammate-notes-store');
const repoRoot = require('../lib/repo-root');
const hooksRecall = require('../lib/hooks-recall');
const hooksNotes = require('../lib/hooks-notes');
const { createMockSupabase } = require('./mock-supabase');

const HOOK_ENTRY = path.join(__dirname, '..', 'lib', 'membridge-hook.js');
const CLI = path.join(__dirname, '..', 'bin', 'membridge.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${r.stderr}`);
  return r.stdout;
};

// A real checkout with a real origin, because lib/teamsync.js's linkProject
// keys the shared project row on the remote URL -- which is exactly how two
// clones tracking DIFFERENT depths of one monorepo converge on one project.
function makeCheckout(dir, origin, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'Fixture');
  git(dir, 'config', 'remote.origin.url', origin);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const useHome = home => { process.env.MEMBRIDGE_HOME = home; };

// The plaintext sync hatch (team.encrypt=false). Encryption is on by default
// and is ORTHOGONAL to this feature: it changes how the row crosses the wire,
// not the row the index consumes -- pullProject hands buildIndex the same
// decrypted object either way. Standing up two devices' sealed team keys would
// test lib/teamcrypto, which test/run-tests.js already owns, and would put a
// keychain between this proof and the thing it is proving.
function plaintextTeamHome() {
  util.ensureConfig();
  const c = util.loadUserConfig();
  c.team = { ...(c.team || {}), encrypt: false, sharePrompts: true };
  util.saveUserConfig(c);
}

const childEnv = (home, extra = {}) => ({
  ...process.env, ...ISOLATION, MEMBRIDGE_HOME: home, ...extra,
});

// `membridge sync` must run ASYNCHRONOUSLY. The mock backend lives in this
// process, so spawnSync here would block our own event loop and the child's
// REST calls would never be answered -- a self-inflicted deadlock that looks
// exactly like a hung CLI.
const runCli = (home, argv, extra = {}) => new Promise(resolve => {
  const c = spawn(process.execPath, [CLI, ...argv], {
    env: childEnv(home, extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  c.stdout.on('data', d => { stdout += d; });
  c.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => c.kill('SIGKILL'), 90000);
  c.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

// The real hook entry point, fed a real payload on stdin -- the only way to
// see the actual permissionDecision an agent would receive. No network here,
// so spawnSync is safe.
const runHook = (sub, payload, home, extra = {}) => {
  const r = spawnSync(process.execPath, [HOOK_ENTRY, sub], {
    input: JSON.stringify(payload), encoding: 'utf8', env: childEnv(home, extra),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const hookOutput = res => {
  assert.strictEqual(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  assert.strictEqual(res.stderr, '', `hook wrote to stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `expected exactly one hook output, got: ${res.stdout}`);
  return JSON.parse(lines[0]).hookSpecificOutput;
};

// A teammate session that recorded a decision: a prompt, a real edit, and a
// distilled checkpoint. `highlights` is what becomes changes[].note downstream
// (lib/memorydb.js deriveEntryChanges), and its file keys are project-relative
// on the TEAMMATE's machine -- the mismatch this whole feature turns on.
const teammateSession = ({ session, ts, editRel, decisions, gotchas, highlights, projectPath }) => [
  { ts, source: 'Claude Code', kind: 'prompt', session, text: 'work on the retry path' },
  { ts, source: 'Claude Code', kind: 'edit', session, file: path.join(projectPath, editRel) },
  {
    ts, source: 'Distilled', kind: 'summary', session,
    text: 'Did the work.', goal: 'consistency',
    decisions, gotchas: gotchas || '', highlights: highlights || [],
  },
];

const isoAgo = mins => new Date(Date.now() - mins * 60000).toISOString();
const DAY_MIN = 24 * 60;

async function main() {
  console.log('teammate notes end-to-end\n');

  const port = await freePort();
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(port, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${port}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-e2e';
  ISOLATION.MEMBRIDGE_TEAM_URL = process.env.MEMBRIDGE_TEAM_URL;
  ISOLATION.MEMBRIDGE_TEAM_ANON_KEY = process.env.MEMBRIDGE_TEAM_ANON_KEY;

  try {
    // -----------------------------------------------------------------------
    // Three checkout PAIRS, each a different real-world identity problem.
    // -----------------------------------------------------------------------
    const ORIGIN_MONO = 'https://example.invalid/acme/mono.git';
    const ORIGIN_APP = 'https://example.invalid/acme/app.git';
    const ORIGIN_QUEUE = 'https://example.invalid/acme/queue.git';

    // (1) monorepo depth: the teammate tracks the repo root, I track packages/api.
    const theirMono = makeCheckout(path.join(ROOT, 'theirs', 'mono'), ORIGIN_MONO,
      { 'packages/api/src/validate.ts': 'export const ok = 1;\n' });
    const myMono = makeCheckout(path.join(ROOT, 'mine', 'mono'), ORIGIN_MONO,
      { 'packages/api/src/validate.ts': 'export const ok = 1;\n' });
    const myMonoTracked = path.join(myMono, 'packages', 'api');

    // (2) worktrees: both of us track the repo root, but my session runs from a
    //     nested linked worktree -- MemBridge's own .claude/worktrees layout.
    const theirApp = makeCheckout(path.join(ROOT, 'theirs', 'app'), ORIGIN_APP,
      { 'src/root.ts': 'export const b = 2;\n' });
    const myApp = makeCheckout(path.join(ROOT, 'mine', 'app'), ORIGIN_APP,
      { 'src/root.ts': 'export const b = 2;\n' });
    const myAppWorktree = path.join(myApp, '.claude', 'worktrees', 'feature');
    git(myApp, 'worktree', 'add', '-q', '-b', 'feature', myAppWorktree);

    // (3) the vacation case: a decision recorded a fortnight ago that nobody
    //     has ever been told.
    const theirQueue = makeCheckout(path.join(ROOT, 'theirs', 'queue'), ORIGIN_QUEUE,
      { 'src/queue.ts': 'export const q = 3;\n' });
    const myQueue = makeCheckout(path.join(ROOT, 'mine', 'queue'), ORIGIN_QUEUE,
      { 'src/queue.ts': 'export const q = 3;\n' });
    repoRoot.clearCache();

    // -----------------------------------------------------------------------
    // The teammate's machine: three sessions, three real pushes.
    // -----------------------------------------------------------------------
    useHome(HOME_TEAMMATE);
    plaintextTeamHome();
    const theirState = util.loadState();
    theirState.projects = {
      [theirMono]: {
        events: teammateSession({
          projectPath: theirMono, session: 'their-mono-1', ts: isoAgo(40),
          editRel: 'packages/api/src/validate.ts',
          decisions: 'Renamed the retry cap to maxAttempts for SDK consistency.',
          gotchas: 'The parser silently drops BOMs.',
          highlights: [{ file: 'packages/api/src/validate.ts', note: 'blocked pending migration 018' }],
        }),
      },
      // Deliberately NO decisions and NO gotchas: with prose in this index the
      // worktree assertion below would pass even if the file-keyed lookup
      // missed entirely.
      [theirApp]: {
        events: teammateSession({
          projectPath: theirApp, session: 'their-app-1', ts: isoAgo(35),
          editRel: 'src/root.ts', decisions: '',
          highlights: [{ file: 'src/root.ts', note: 'do not touch until 019 lands' }],
        }),
      },
      // Prose only, timestamped a fortnight ago and never delivered.
      [theirQueue]: {
        events: teammateSession({
          projectPath: theirQueue, session: 'their-queue-1', ts: isoAgo(14 * DAY_MIN),
          editRel: 'src/queue.ts',
          decisions: 'Switched the queue to at-least-once delivery.',
          highlights: [],
        }),
      },
    };
    util.saveState(theirState);

    await teamsync.signup(util.getConfig(), 'andrew@example.invalid', 'pw-teammate', 'Andrew');
    const team = await teamsync.createTeam(util.getConfig(), 'Acme');
    for (const p of [theirMono, theirApp, theirQueue]) {
      await teamsync.linkProject(util.getConfig(), p, team.team_id, 'Acme');
    }
    const theirPush = await teamsync.syncTeams();

    check('the teammate\'s push carries repo-root-relative WIRE keys, not tracked-relative ones', () => {
      assert.deepStrictEqual(theirPush.errors, [], `push errors: ${theirPush.errors}`);
      const row = mock.entries.find(e => e.decisions && e.decisions.includes('maxAttempts'));
      assert.ok(row, `no pushed row carries the decision (${mock.entries.length} rows on the server)`);
      assert.strictEqual(row.author_name, 'Andrew');
      // The teammate tracks the repo root here, so this is also the tracked
      // path -- the point is that it is keyed to the CHECKOUT, which is what
      // makes it matchable from a different depth below.
      assert.deepStrictEqual(row.files, ['packages/api/src/validate.ts']);
      assert.strictEqual(row.changes[0].file, 'packages/api/src/validate.ts');
      assert.strictEqual(row.changes[0].note, 'blocked pending migration 018');
    });

    // -----------------------------------------------------------------------
    // My machine: join, link at a DIFFERENT depth, then let the real CLI pull
    // and rebuild the index.
    // -----------------------------------------------------------------------
    useHome(HOME_MINE);
    teamsync.clearCredentials();
    plaintextTeamHome();
    const myState = util.loadState();
    myState.projects = {
      [myMonoTracked]: { events: [] },
      [myApp]: { events: [] },
      [myQueue]: { events: [] },
    };
    util.saveState(myState);
    await teamsync.signup(util.getConfig(), 'me@example.invalid', 'pw-mine', 'Me');
    const joined = await teamsync.joinTeam(util.getConfig(), team.invite_code);
    const myLinks = {};
    for (const p of [myMonoTracked, myApp, myQueue]) {
      myLinks[p] = await teamsync.linkProject(util.getConfig(), p, joined.team_id, joined.team_name);
    }

    check('a clone tracking a monorepo SUBDIRECTORY lands on the teammate\'s project row', () => {
      // Without this the pull is empty and every check below passes vacuously.
      assert.ok(myLinks[myMonoTracked].projectId, 'no project row for the subdirectory clone');
      const theirLink = JSON.parse(fs.readFileSync(path.join(theirMono, '.membridge', 'team.json'), 'utf8'));
      assert.strictEqual(myLinks[myMonoTracked].projectId, theirLink.projectId,
        'the two depths minted separate project rows — nothing could ever cross');
    });

    // THE REAL CLI. `membridge sync` is teamSyncPass: pull, re-render, then
    // rebuildNotesForChanged -- the same function the daemon tick calls.
    const sync = await runCli(HOME_MINE, ['sync']);

    check('`membridge sync` pulls the teammate rows and rebuilds every index', () => {
      assert.strictEqual(sync.status, 0, `sync exited ${sync.status}: ${sync.stderr}\n${sync.stdout}`);
      assert.ok(/3 with new teammate activity/.test(sync.stdout), `sync said: ${sync.stdout}`);
      for (const p of [myMonoTracked, myApp, myQueue]) {
        assert.ok(fs.existsSync(notesStore.notesPath(p)), `no index written for ${p}`);
      }
    });

    check('the index is keyed by the WIRE key, which is NOT this machine\'s tracked-relative path', () => {
      const ix = notesStore.read(myMonoTracked);
      const absFile = path.join(myMonoTracked, 'src', 'validate.ts');
      const trackedRel = path.relative(myMonoTracked, absFile).split(path.sep).join('/');
      assert.strictEqual(trackedRel, 'src/validate.ts');
      assert.strictEqual(repoRoot.wireKeyFor(absFile), 'packages/api/src/validate.ts');
      assert.notStrictEqual(trackedRel, repoRoot.wireKeyFor(absFile),
        'fixture regressed: the two keys coincide, so nothing below can fail');
      assert.ok(ix.byFile['packages/api/src/validate.ts'],
        `byFile is keyed ${JSON.stringify(Object.keys(ix.byFile))}`);
    });

    check('the teammate is named, not flattened to "a teammate" (the stored-row rename)', () => {
      // The ONLY way to catch this: the pull renames author_name -> author, and
      // a hand-written wire fixture can never exercise it.
      const ix = notesStore.read(myMonoTracked);
      const authors = new Set([
        ...ix.prose.map(p => p.author),
        ...Object.values(ix.byFile).flat().map(n => n.author),
      ]);
      assert.deepStrictEqual([...authors], ['Andrew'], `authors came out as ${JSON.stringify([...authors])}`);
    });

    // -----------------------------------------------------------------------
    // Delivery point 2/3: the real PreToolUse hook.
    // -----------------------------------------------------------------------
    const readPayload = (cwd, absFile, sessionId) => ({
      session_id: sessionId, cwd, tool_name: 'Read',
      tool_input: { file_path: absFile, limit: 100 },
    });
    const monoUnrelated = path.join(myMonoTracked, 'src', 'other.ts');
    fs.writeFileSync(monoUnrelated, 'export const z = 9;\n');
    const monoValidate = path.join(myMonoTracked, 'src', 'validate.ts');

    const arrival = runHook('recall', readPayload(myMonoTracked, monoUnrelated, 'agent-1'), HOME_MINE);

    check('the decision reaches the agent on a read of an UNRELATED file, and the read is ALLOWED', () => {
      const hso = hookOutput(arrival);
      assert.strictEqual(hso.hookEventName, 'PreToolUse');
      assert.strictEqual(hso.permissionDecision, 'allow', 'THE property: this feature may never block a read');
      assert.ok(!('permissionDecisionReason' in hso), 'a note must not masquerade as a denial reason');
      assert.ok(!/deny/.test(arrival.stdout), 'the notes path emitted a denial');
      assert.ok(hso.additionalContext.includes('maxAttempts'), hso.additionalContext);
      assert.ok(hso.additionalContext.includes('Andrew'), hso.additionalContext);
    });

    const contact1 = runHook('recall', readPayload(myMonoTracked, monoValidate, 'agent-2'), HOME_MINE);
    const contact2 = runHook('recall', readPayload(myMonoTracked, monoValidate, 'agent-2'), HOME_MINE);
    const contact3 = runHook('recall', readPayload(myMonoTracked, monoValidate, 'agent-3'), HOME_MINE);

    check('the standing file warning arrives on contact, keyed across the depth mismatch', () => {
      const hso = hookOutput(contact1);
      assert.strictEqual(hso.permissionDecision, 'allow');
      assert.ok(hso.additionalContext.includes('blocked pending migration 018'), hso.additionalContext);
    });

    check('the same session is never warned twice about the same file', () => {
      assert.ok(contact1.stdout.trim(), 'precondition: the first contact produced nothing');
      assert.strictEqual(contact2.status, 0, contact2.stderr);
      assert.strictEqual(contact2.stdout, '', `the warning re-fired inside one session: ${contact2.stdout}`);
    });

    check('a NEW session is warned again while the condition is still live', () => {
      const hso = hookOutput(contact3);
      assert.ok(hso.additionalContext.includes('blocked pending migration 018'),
        'a standing condition went missing for the next session');
    });

    check('the prose decision is not repeated once it has been delivered', () => {
      // Delivered on the very first read above; "once, globally" means a brand
      // new session must not hear it again.
      const ix = notesStore.read(myMonoTracked);
      const unseen = notes.selectProse(ix, new Date().toISOString()).items;
      assert.deepStrictEqual(unseen.map(p => p.text), [],
        `still offering: ${JSON.stringify(unseen.map(p => p.text))}`);
    });

    check('the warning stops re-firing once it is past the re-fire window', () => {
      const later = new Date(Date.now() + 14 * 86400000).toISOString();
      assert.strictEqual(hooksRecall.buildNotesOutput({
        projectPath: myMonoTracked, absPath: monoValidate, relPath: 'src/validate.ts',
        sessionId: 'agent-much-later', now: later, config: util.getConfig(),
      }), null);
    });

    // -----------------------------------------------------------------------
    // The worktree case, end to end through the hook.
    // -----------------------------------------------------------------------
    const wtFile = path.join(myAppWorktree, 'src', 'root.ts');
    const wt = runHook('recall', readPayload(myAppWorktree, wtFile, 'agent-worktree'), HOME_MINE);

    check('a session run from a nested worktree matches a note keyed to the main checkout', () => {
      assert.ok(fs.existsSync(wtFile), 'worktree fixture missing — `git worktree add` failed');
      // Non-tautological by construction: the hook resolves a nested worktree
      // to its MAIN repo, so the naive tracked-relative key carries the
      // worktree prefix and could never match what the teammate pushed.
      const naive = path.relative(myApp, wtFile).split(path.sep).join('/');
      assert.strictEqual(naive, '.claude/worktrees/feature/src/root.ts');
      assert.strictEqual(repoRoot.wireKeyFor(wtFile), 'src/root.ts');
      assert.notStrictEqual(naive, repoRoot.wireKeyFor(wtFile),
        'fixture regressed: the two keys coincide, so this check cannot fail');
      assert.ok(Object.keys(notesStore.read(myApp).byFile).includes('src/root.ts'));
      const hso = hookOutput(wt);
      assert.strictEqual(hso.permissionDecision, 'allow');
      assert.ok(hso.additionalContext.includes('do not touch until 019 lands'), hso.additionalContext);
      // This index carries no prose at all, so the text above can only have
      // come from the file-keyed lookup.
      assert.deepStrictEqual(notesStore.read(myApp).prose, []);
    });

    // -----------------------------------------------------------------------
    // The kill switch, on every surface the spec names (§10: "all five
    // delivery points"), and delivery point 5 alongside it.
    //
    // EVERY check here is PAIRED with the same call under the switch ON, on the
    // same project, the same file and (where it matters) the same session id.
    // Without that pairing "silenced" is indistinguishable from "already
    // delivered", and the check passes against a feature that does not consult
    // the switch at all -- which is how this block first passed while a real
    // surface was ignoring it.
    // -----------------------------------------------------------------------
    const server = require('../lib/server');
    const off = { teammateNotes: { enabled: false } };
    const sessionPayload = (cwd, sessionId, source) => ({ session_id: sessionId, cwd, source });
    const setSwitch = enabled => {
      const c = util.loadUserConfig();
      if (enabled) delete c.teammateNotes; else c.teammateNotes = { enabled: false };
      util.saveUserConfig(c);
    };

    check('an undelivered decision survives a two-week absence', () => {
      // The row is a fortnight old and has never been shown. Spec §5: the clock
      // governs REPETITION, not first delivery -- a teammate on holiday must
      // not lose what was decided while they were away.
      const ix = notesStore.read(myQueue);
      const age = Date.now() - Date.parse(ix.prose[0].ts);
      assert.ok(age > 13 * 86400000, `fixture is only ${Math.round(age / 86400000)} days old`);
      const out = hooksNotes.buildSessionOutput({
        projectPath: myQueue, sessionId: 'back-from-holiday',
        source: 'startup', now: new Date().toISOString(), config: util.getConfig(),
      });
      assert.ok(out && out.text.includes('at-least-once'), `session output was: ${out && out.text}`);
    });

    // Order is load-bearing: the switched-OFF runs come FIRST, while the notes
    // are still undelivered, so each one's control below proves the note was
    // genuinely there to be silenced.
    setSwitch(false);
    const killRead = runHook('recall', readPayload(myMonoTracked, monoValidate, 'agent-killswitch'), HOME_MINE);
    const killStart = runHook('notes-session-start', sessionPayload(myQueue, 'holiday-1', 'startup'), HOME_MINE);
    const killDetail = server.projectDetail(myMonoTracked);
    setSwitch(true);
    const liveRead = runHook('recall', readPayload(myMonoTracked, monoValidate, 'agent-killswitch'), HOME_MINE);
    const liveDetail = server.projectDetail(myMonoTracked);
    const start1 = runHook('notes-session-start', sessionPayload(myQueue, 'holiday-1', 'startup'), HOME_MINE);
    const start2 = runHook('notes-session-start', sessionPayload(myQueue, 'holiday-2', 'startup'), HOME_MINE);

    check('SessionStart hands the fortnight-old decision to the agent', () => {
      const hso = hookOutput(start1);
      assert.strictEqual(hso.hookEventName, 'SessionStart');
      assert.ok(hso.additionalContext.includes('at-least-once'), hso.additionalContext);
      assert.ok(hso.additionalContext.includes('Andrew'), hso.additionalContext);
      assert.ok(!('permissionDecision' in hso), 'SessionStart must not carry a permission decision');
    });

    check('and does not repeat it in the next session', () => {
      assert.ok(start1.stdout.trim(), 'precondition: the first SessionStart said nothing');
      assert.strictEqual(start2.status, 0, start2.stderr);
      assert.strictEqual(start2.stdout, '', `a delivered decision was repeated: ${start2.stdout}`);
    });

    check('the kill switch silences the PreToolUse surface', () => {
      // Control: the SAME session id, the SAME file, switch on -> the note
      // lands. So the empty run below is the switch working, not exhaustion.
      assert.ok(hookOutput(liveRead).additionalContext.includes('blocked pending migration 018'),
        'control failed: nothing was available to silence, so this check proves nothing');
      assert.strictEqual(killRead.status, 0, killRead.stderr);
      assert.strictEqual(killRead.stdout, '', `a note escaped the kill switch: ${killRead.stdout}`);
    });

    check('the kill switch silences the SessionStart surface', () => {
      assert.ok(start1.stdout.trim(),
        'control failed: this decision was already delivered, so silence proves nothing');
      assert.strictEqual(killStart.status, 0, killStart.stderr);
      assert.strictEqual(killStart.stdout, '', `a decision escaped the kill switch: ${killStart.stdout}`);
    });

    check('the kill switch silences the DASHBOARD surface (delivery point 1)', () => {
      // Spec §10: the switch "disables all five delivery points", and Task 1
      // made delivery point 1 the dashboard. Turning a feature off AFTER using
      // it is the normal case, and nothing ever deletes the index -- so the
      // dashboard has to consult the switch itself.
      //
      // dashboardPayload deliberately ignores `seen`, so this project's already
      // delivered decisions are still on the payload: the control below is what
      // makes the assertion discriminating.
      assert.ok(liveDetail && liveDetail.teammateNotes.total > 0,
        'control failed: the dashboard had nothing to show even with the switch on');
      assert.ok(killDetail, 'projectDetail returned nothing for a tracked project');
      assert.deepStrictEqual(killDetail.teammateNotes, { fresh: [], total: 0 },
        `the dashboard kept serving teammate decisions after the kill switch: ${JSON.stringify(killDetail.teammateNotes)}`);
    });

    check('the pure selectors honour the kill switch too', () => {
      assert.strictEqual(hooksRecall.buildNotesOutput({
        projectPath: myMonoTracked, absPath: monoValidate, relPath: 'src/validate.ts',
        sessionId: 'agent-off', now: new Date().toISOString(), config: off,
      }), null);
      assert.strictEqual(hooksNotes.buildSessionOutput({
        projectPath: myQueue, sessionId: 'agent-off', source: 'startup',
        now: new Date().toISOString(), config: off,
      }), null);
      assert.strictEqual(notes.isNotesEnabled(util.getConfig()), true, 'the switch was never restored');
    });

    const corruptTarget = notesStore.notesPath(myApp);
    fs.writeFileSync(corruptTarget, 'not json at all');
    const corruptHook = runHook('recall', readPayload(myAppWorktree, wtFile, 'agent-corrupt'), HOME_MINE);
    const corruptStart = runHook('notes-session-start', sessionPayload(myApp, 'corrupt-start', 'startup'), HOME_MINE);
    const corruptDetail = server.projectDetail(myApp);

    check('a corrupt index degrades to silence, not a throw', () => {
      assert.strictEqual(corruptHook.status, 0, `hook exited ${corruptHook.status}: ${corruptHook.stderr}`);
      assert.strictEqual(corruptHook.stderr, '', corruptHook.stderr);
      assert.strictEqual(corruptHook.stdout, '', corruptHook.stdout);
      assert.strictEqual(corruptStart.status, 0, `SessionStart exited ${corruptStart.status}: ${corruptStart.stderr}`);
      assert.strictEqual(corruptStart.stdout, '', corruptStart.stdout);
      assert.deepStrictEqual(corruptDetail.teammateNotes, { fresh: [], total: 0 });
      assert.strictEqual(hooksRecall.buildNotesOutput({
        projectPath: myApp, absPath: wtFile, relPath: 'src/root.ts',
        sessionId: 'agent-corrupt-unit', now: new Date().toISOString(), config: util.getConfig(),
      }), null);
    });

    // -----------------------------------------------------------------------
    // Isolation, asserted rather than assumed.
    // -----------------------------------------------------------------------
    check('the developer\'s own agent and MemBridge configs were not touched', () => {
      // Control: if the fixture home is empty, nothing ran and this proves
      // nothing at all.
      assert.ok(fs.existsSync(path.join(HOME_MINE, 'state.json')) ||
        fs.existsSync(path.join(HOME_MINE, 'config.json')),
        'precondition: nothing was written under the fixture home, so this check is vacuous');
      const after = snapshotStable();
      const changed = REAL_STABLE_FILES.filter((f, i) => after[i] !== stableBefore[i]);
      assert.deepStrictEqual(changed, [], `this run wrote to ${changed.join(', ')}`);
    });

    check('no fixture path leaked into the developer\'s own state', () => {
      for (const f of REAL_CHURNING_FILES) {
        const body = readOrAbsent(f);
        assert.ok(!body.includes(ROOT),
          `${f} carries this run's fixture path — the isolation env was not honoured somewhere`);
      }
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }
}

main().then(() => {
  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}).catch(err => {
  console.error('\nteammate notes e2e: ABORTED');
  console.error(err);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
