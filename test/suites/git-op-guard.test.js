'use strict';
// The daemon must not write its managed block into a working tree git is
// mid-way through rewriting.
//
// THE FAILURE, reproduced at the git level before any of this was written, and
// against a control that ran the identical sequence with no write:
//
//   $ git rebase origin/main             # pauses on a real conflict in app.js
//   $ <resolve app.js>; git add app.js   # index: NO unmerged entries left
//   $ git rebase --continue
//   You must edit all merge conflicts and then
//   mark them as resolved using git add
//
// `git ls-files -u` was empty. `git diff --name-only --diff-filter=U` was empty.
// The conflict WAS resolved. `git diff-files` held exactly one path: the file
// MemBridge had written while the rebase was paused. git refuses `--continue` on
// any unstaged change and reports it as an unresolved conflict, so the message
// sends the user hunting for markers that do not exist. Dirtying an unrelated
// tracked file instead reproduces it identically — this is not about which file,
// it is about writing into a tree git is holding.
//
// The sibling failure needs no code from us and is not fixable here: with a dirty
// tree, `git pull --rebase` refuses up front ("cannot pull with rebase: You have
// unstaged changes", exit 128) and leaves the checkout on pre-merge code while
// the merge has already landed upstream. That one is git declining loudly and is
// answered by `rebase.autoStash`, not by a daemon change — see the T-57 report.
//
// WHY THE GUARD IS "OPERATION IN PROGRESS" AND NOT "TREE IS DIRTY". After the
// first write the block itself is what makes the tree dirty, so a skip-if-dirty
// rule would write once and then never refresh the context again until the user
// committed. That trades a loud git error for a silently stale block, which is
// the worse failure and the product failing rather than git failing.
//
// WHAT THESE CANNOT PROVE: that a real 60s tick lands inside a real user's
// rebase. These drive syncOnce directly against a paused rebase, which is the
// same state a tick would find, deterministically.
//
// Run directly, or via `node test/run.js git-op-guard`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, jsonl } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const util = require('../../lib/util');
const repoRoot = require('../../lib/repo-root');
const { syncOnce } = require('../../lib/scan');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(ROOT, 'gitconfig'),
  GIT_CONFIG_SYSTEM: path.join(ROOT, 'gitconfig-system'),
  GIT_AUTHOR_NAME: 'T57', GIT_AUTHOR_EMAIL: 't57@test.dev',
  GIT_COMMITTER_NAME: 'T57', GIT_COMMITTER_EMAIL: 't57@test.dev',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitTry = (cwd, ...args) => {
  try { return { ok: true, out: git(cwd, ...args) }; } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

// A project the daemon tracks: a real git repo, a `.membridge` marker, a tracked
// CLAUDE.md, and a Claude Code transcript so syncOnce has work to render.
function makeProject(name, sessionId) {
  const proj = path.join(ROOT, 'gitop', name);
  fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
  git(proj, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Project instructions\n\nRun the tests.\n');
  fs.writeFileSync(path.join(proj, 'app.js'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(proj, '.gitignore'), '.membridge/\n');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-q', '-m', 'initial');

  const cdir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, `slug-${name}`);
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, `${sessionId}.jsonl`), jsonl([
    { type: 'user', message: { role: 'user', content: `wire up the ${name} path` }, cwd: proj, timestamp: '2026-08-05T11:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj, 'app.js') } }] }, cwd: proj, timestamp: '2026-08-05T11:01:00.000Z' },
  ]));
  return proj;
}

// Pause a rebase on a genuine conflict, exactly as a user's `git pull --rebase`
// would after a teammate's PR touched the same line.
let rebaseSeq = 0;
function pauseRebaseOn(proj) {
  // A fresh branch name per call: this helper runs several times per repo, and
  // reusing one name fails on `checkout -b` rather than on anything under test.
  const br = `upstream${++rebaseSeq}`;
  git(proj, 'checkout', '-q', '-b', br);
  fs.writeFileSync(path.join(proj, 'app.js'), `line1\nUPSTREAM-${br}\nline3\n`);
  git(proj, 'commit', '-q', '-am', `merged PR ${br}`);
  git(proj, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(proj, 'app.js'), `line1\nLOCAL-${br}\nline3\n`);
  git(proj, 'commit', '-q', '-am', `local change ${br}`);
  const r = gitTry(proj, 'rebase', br);
  assert.strictEqual(r.ok, false, 'the fixture rebase must stop on a conflict');
  return { ...r, branch: br };
}

const blockOf = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const hasBlock = file => /MemBridge/.test(blockOf(file));
const projRecord = key => (util.loadState().projects || {})[key] || {};

async function main() {
  // ---- gitOperationInProgress, on its own -------------------------------
  const probe = makeProject('probe', 'probe1');

  await check('gitOperationInProgress: a clean repo answers null', () => {
    assert.strictEqual(repoRoot.gitOperationInProgress(probe), null);
  });

  await check('gitOperationInProgress: a non-repo directory and junk input answer null (fails OPEN)', () => {
    const plain = path.join(ROOT, 'gitop', 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    assert.strictEqual(repoRoot.gitOperationInProgress(plain), null, 'a directory with no .git is not "busy"');
    assert.strictEqual(repoRoot.gitOperationInProgress(''), null, 'blank input must not resolve to cwd');
    assert.strictEqual(repoRoot.gitOperationInProgress(null), null);
    // A .git FILE that is not a gitdir pointer must not throw or guess.
    const weird = path.join(ROOT, 'gitop', 'weird');
    fs.mkdirSync(weird, { recursive: true });
    fs.writeFileSync(path.join(weird, '.git'), 'not a gitdir pointer at all\n');
    assert.strictEqual(repoRoot.gitOperationInProgress(weird), null);
  });

  await check('gitOperationInProgress: a paused rebase is detected', () => {
    pauseRebaseOn(probe);
    const marker = repoRoot.gitOperationInProgress(probe);
    assert.ok(marker === 'rebase-merge' || marker === 'rebase-apply',
      `expected a rebase marker, got ${JSON.stringify(marker)}`);
  });

  await check('gitOperationInProgress: aborting the rebase clears it', () => {
    git(probe, 'rebase', '--abort');
    assert.strictEqual(repoRoot.gitOperationInProgress(probe), null);
  });

  await check('gitOperationInProgress: an interrupted merge and cherry-pick are detected too', () => {
    // MERGE_HEAD, not a rebase dir: the same tree-is-git's rule applies, and a
    // guard that only knew about rebase would miss the workflow's other half.
    const r = gitTry(probe, 'merge', 'upstream1');
    assert.strictEqual(r.ok, false, 'the fixture merge must conflict');
    assert.strictEqual(repoRoot.gitOperationInProgress(probe), 'MERGE_HEAD');
    git(probe, 'merge', '--abort');
    assert.strictEqual(repoRoot.gitOperationInProgress(probe), null);
    const c = gitTry(probe, 'cherry-pick', 'upstream1');
    assert.strictEqual(c.ok, false, 'the fixture cherry-pick must conflict');
    const m = repoRoot.gitOperationInProgress(probe);
    assert.ok(m === 'CHERRY_PICK_HEAD' || m === 'sequencer', `expected a cherry-pick marker, got ${m}`);
    gitTry(probe, 'cherry-pick', '--abort');
  });

  await check('gitOperationInProgress: a linked worktree is judged on ITS OWN git dir, not the main one', () => {
    // Per-worktree state lives in <main>/.git/worktrees/<name>/, so a rebase in
    // the main checkout must not silence writes into a sibling worktree that is
    // perfectly idle — and vice versa. scan.js injects into every linked
    // worktree, so getting this wrong would either wedge a rebase or freeze a
    // worktree's context.
    const wt = path.join(ROOT, 'gitop', 'probe-wt');
    git(probe, 'worktree', 'add', '-q', '-b', 'wtbranch', wt);
    assert.strictEqual(repoRoot.gitOperationInProgress(wt), null, 'the fresh worktree is idle');
    pauseRebaseOn(probe);
    assert.ok(repoRoot.gitOperationInProgress(probe), 'the main checkout is mid-rebase');
    assert.strictEqual(repoRoot.gitOperationInProgress(wt), null,
      "a rebase in the main checkout must not mark an idle worktree busy");
    git(probe, 'rebase', '--abort');
  });

  // ---- the sync path -----------------------------------------------------
  const app = makeProject('app', 'app1');
  const target = path.join(app, 'CLAUDE.md');

  await check('control: an ordinary sync writes the block and marks the project synced', () => {
    const r = syncOnce();
    assert.ok(r.changes.some(c => c.file === target && c.action === 'updated'),
      `expected an update for ${target}, got ${JSON.stringify(r.changes.map(c => c.action + ':' + c.file))}`);
    assert.ok(hasBlock(target), 'the block must be on disk');
    const rec = projRecord(app);
    assert.strictEqual(rec.dirty, undefined, 'a completed sync clears dirty');
    assert.ok(rec.lastSync, 'and stamps lastSync');
  });

  await check('a sync during a paused rebase DEFERS the write and leaves the file untouched', () => {
    // New work, so the project is dirty and the inject loop is reached.
    const cdir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-app');
    // A prompt ALONE may not reach the rendered block (a zero-edit session can be
    // suppressed), so this is a full session: prompt, edit, summary. Otherwise the
    // "nothing was lost" assertion below would pass or fail for the wrong reason.
    fs.writeFileSync(path.join(cdir, 'app2.jsonl'), jsonl([
      { type: 'user', message: { role: 'user', content: 'second turn, mid-rebase' }, cwd: app, timestamp: '2026-08-05T12:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(app, 'app.js') } }] }, cwd: app, timestamp: '2026-08-05T12:01:00.000Z' },
    ]));
    fs.writeFileSync(path.join(app, '.membridge', 'summaries.jsonl'),
      JSON.stringify({ session: 'app2', ts: '2026-08-05T12:02:00.000Z', did: 'Landed the second turn while a rebase was paused.' }) + '\n');
    pauseRebaseOn(app);
    const before = blockOf(target);
    const r = syncOnce();
    assert.strictEqual(blockOf(target), before, 'CLAUDE.md must be byte-identical after the tick');
    const deferred = r.changes.filter(c => c.file === target && c.action === 'deferred');
    assert.strictEqual(deferred.length, 1, `expected one deferred change, got ${JSON.stringify(r.changes)}`);
    assert.match(String(deferred[0].reason), /in progress/, 'and it must say why');
    assert.ok((r.skipped || []).some(s => s.project === app && /in progress/.test(s.reason)),
      'the project must be reported as skipped, not silently dropped');
  });

  await check('a deferred write records NO success: dirty survives and lastSync does not move', () => {
    // The characteristic defect of this codebase, guarded. Clearing dirty would
    // strand the stale block (a full sync only visits dirty projects) and
    // stamping lastSync would tell the badge, `membridge status` and the MCP that
    // work is captured while the file on disk predates it.
    const rec = projRecord(app);
    assert.strictEqual(rec.dirty, true, 'the project must still be dirty so the next tick retries');
    assert.ok(rec.lastSync, 'precondition: it had a lastSync from the control above');
    const stamped = Date.parse(rec.lastSync);
    assert.ok(Number.isFinite(stamped));
    // It must be the OLD stamp, not a fresh one. The control ran moments ago, so
    // compare against the block on disk instead of a clock: the honest invariant
    // is that lastSync never claims to be newer than the last real write.
    assert.strictEqual(hasBlock(target), true);
    const secondTick = syncOnce();
    assert.ok(secondTick.changes.some(c => c.file === target && c.action === 'deferred'),
      'a second tick while still paused defers again rather than giving up');
    assert.strictEqual(projRecord(app).dirty, true, 'and stays dirty across repeated deferrals');
    assert.strictEqual(projRecord(app).lastSync, rec.lastSync, 'lastSync must not advance on a deferral');
  });

  await check('the rebase completes cleanly with the guard in place', () => {
    // The whole point: `git rebase --continue` succeeds because nothing dirtied
    // the tree behind git's back. Resolve the fixture conflict as a user would.
    fs.writeFileSync(path.join(app, 'app.js'), 'line1\nRESOLVED\nline3\n');
    git(app, 'add', 'app.js');
    const r = gitTry(app, '-c', 'core.editor=true', 'rebase', '--continue');
    assert.strictEqual(r.ok, true, `rebase --continue must succeed, got: ${r.out}`);
    assert.strictEqual(fs.existsSync(path.join(app, '.git', 'rebase-merge')), false, 'no rebase left in progress');
    assert.strictEqual(fs.existsSync(path.join(app, '.git', 'rebase-apply')), false);
    assert.strictEqual(repoRoot.gitOperationInProgress(app), null);
  });

  await check('the very next tick after the rebase ends writes the block it deferred', () => {
    // The deferral is a retry, not a drop. This is the check that would fail if
    // the skip path had cleared dirty.
    const before = blockOf(target);
    const r = syncOnce();
    assert.ok(r.changes.some(c => c.file === target && c.action === 'updated'),
      `expected the deferred write to land, got ${JSON.stringify(r.changes.map(c => c.action + ':' + c.file))}`);
    assert.notStrictEqual(blockOf(target), before, 'the file must actually change');
    assert.ok(/second turn, mid-rebase/.test(blockOf(target)),
      'and it must contain the work that arrived while the rebase was paused — nothing was lost');
    const rec = projRecord(app);
    assert.strictEqual(rec.dirty, undefined, 'now it is genuinely synced');
    assert.ok(rec.lastSync);
  });

  await check('a dry run is unaffected: it reports what it would do and asks nothing of git', () => {
    // dryRun never writes, so the guard must not turn `membridge sync --dry-run`
    // into a different answer depending on whether a rebase happens to be open.
    const cdir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-app');
    fs.writeFileSync(path.join(cdir, 'app3.jsonl'), jsonl([
      { type: 'user', message: { role: 'user', content: 'third turn' }, cwd: app, timestamp: '2026-08-05T13:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(app, 'app.js') } }] }, cwd: app, timestamp: '2026-08-05T13:01:00.000Z' },
    ]));
    pauseRebaseOn(app);
    try {
      const r = syncOnce({ dryRun: true });
      assert.ok(r.changes.some(c => c.file === target && c.action === 'would update'),
        `a dry run must still say "would update", got ${JSON.stringify(r.changes.map(c => c.action))}`);
      assert.strictEqual(r.changes.some(c => c.action === 'deferred'), false,
        'and must not report a deferral it never had to make');
    } finally {
      git(app, 'rebase', '--abort');
    }
  });

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
