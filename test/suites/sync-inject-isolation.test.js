'use strict';
// Shared plumbing lives in test/harness.js; run this file directly, or via
// `node test/run.js sync-inject-isolation`.
// --- syncOnce: one unwritable context file must not abort the whole pass ---
//
// The block-injection loop in lib/scan.js was the only unguarded write in that
// loop body. Its two neighbours are both wrapped and say why -- memorydb
// ("memory db error for ...") and the token ledger, whose comment reads "a
// write failure here must not block the rest of the sync". digest.inject was
// not, so a single project whose target file cannot be written (read-only
// mount, root-owned file, a directory sitting where CLAUDE.md should be, a
// full disk) threw straight out of syncOnce.
//
// That is worse than losing one project's block, because saveState(state) is
// the LAST thing syncOnce does: the throw skips it, so the pass discards every
// offset advance and lastSync stamp it had already earned, and every project
// ordered after the broken one is never injected at all. The daemon's tick()
// catches the throw and writes one line to the logfile, so the daemon still
// reports "running" while capture is frozen for an unbounded set of projects
// and every later pass re-does and re-loses the same work.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const { syncOnce } = require('../../lib/scan');

// Two tracked projects, both dirty. The BROKEN one sorts first so the healthy
// one is genuinely downstream of the failure in the loop's iteration order.
const BROKEN = path.join(ROOT, 'projects', 'aaa-broken-target');
const HEALTHY = path.join(ROOT, 'projects', 'zzz-healthy-target');

function projectFixture(key) {
  return {
    dirty: true,
    events: [
      { kind: 'prompt', session: 's-inj', ts: '2026-07-15T01:00:00.000Z', text: `work in ${path.basename(key)}`, source: 'Claude Code' },
      { kind: 'edit', session: 's-inj', ts: '2026-07-15T01:01:00.000Z', file: path.join(key, 'index.js'), source: 'Claude Code' },
    ],
  };
}

function seed() {
  fs.mkdirSync(BROKEN, { recursive: true });
  fs.mkdirSync(HEALTHY, { recursive: true });
  // The unwritable target: a DIRECTORY where the context file belongs, which
  // makes the real write raise EISDIR without needing root or a special mount.
  fs.rmSync(path.join(BROKEN, 'CLAUDE.md'), { recursive: true, force: true });
  fs.mkdirSync(path.join(BROKEN, 'CLAUDE.md'), { recursive: true });
  fs.rmSync(path.join(HEALTHY, 'CLAUDE.md'), { force: true });

  util.saveState({
    version: util.STATE_VERSION,
    files: {},
    projects: { [BROKEN]: projectFixture(BROKEN), [HEALTHY]: projectFixture(HEALTHY) },
  });
}

async function main() {
  const cfg = util.loadUserConfig();
  cfg.targets = ['CLAUDE.md'];
  util.saveUserConfig(cfg);

  check('sync: an unwritable context file does not abort the pass or lose the healthy project', () => {
    seed();
    assert.doesNotThrow(() => syncOnce({}),
      'one unwritable target threw out of syncOnce, abandoning the rest of the pass');
    assert.strictEqual(fs.existsSync(path.join(HEALTHY, 'CLAUDE.md')), true,
      'the healthy project was never injected because an earlier project failed');
  });

  check('sync: the pass still persists its state when one project cannot be injected', () => {
    seed();
    try { syncOnce({}); } catch { /* asserted above; keep this check independent */ }
    const after = util.loadState();
    // saveState is the last statement in syncOnce, so a throw anywhere in the
    // loop discards the whole pass's bookkeeping. The healthy project's dirty
    // flag clearing is the observable proof the pass reached the end.
    assert.ok(after.projects[HEALTHY] && !after.projects[HEALTHY].dirty,
      'the pass never reached saveState, so every offset advance and lastSync stamp was discarded');
  });

  check('sync: the broken project is reported rather than silently dropped', () => {
    seed();
    let res;
    try { res = syncOnce({}); } catch { res = null; }
    assert.ok(res, 'syncOnce did not return a result');
    const mentioned = JSON.stringify(res).includes('aaa-broken-target');
    assert.ok(mentioned,
      'the unwritable project vanished from the pass result -- a failure nothing reports is the shape this fix exists to avoid');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
