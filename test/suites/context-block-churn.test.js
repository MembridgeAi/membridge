'use strict';
// The context block must not rewrite a file when nothing changed (#66).
//
// THE BUG. lib/digest.js inject() already refuses to write a file whose
// content is unchanged (`if (updated === existing) return false`). One line
// defeated that guard: the block's closing stamp was `new Date()` at render
// time, minute-granular. So re-rendering an untouched project produced a block
// differing by exactly that line, and the file was rewritten. Where the
// context file is TRACKED IN GIT — the normal way a team shares instructions —
// that is a diff in a file nobody edited, on every sync. One team's
// merge-then-`git pull --rebase` workflow breaks outright on it.
//
// WHY IT WENT UNNOTICED HERE: MemBridge gitignores its own CLAUDE.md, so the
// maintainers are structurally the one population immune to their own bug.
//
// THE FIX IS A NARROWING, NOT A CURE, and these checks are scoped to say so.
// New activity genuinely changes the block every session, by design; that
// churn is legitimate and is NOT what this suite pins. What it pins is that
// churn with no cause behind it is gone, and — the counter-check that keeps
// the fix honest — that real change still writes.
//
// Run directly, or via `node test/run.js context-block-churn`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const digest = require('../../lib/digest');
const hooksPrime = require('../../lib/hooks-prime');

// Render-time clock control. The point of the fix is that renderBlock does not
// read the clock at all, so the ONLY way to prove that is to move the clock
// between two renders and require the output to be identical. Without this the
// two renders land in the same minute and the check passes even unfixed.
function atClock(iso, fn) {
  const Real = global.Date;
  global.Date = class extends Real {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new Real(iso).getTime(); }
  };
  try { return fn(); } finally { global.Date = Real; }
}

function sessionEvents(session, token, ts) {
  return [
    { ts, source: 'Claude Code', kind: 'prompt', session, text: `wire up the ${token} path` },
    {
      ts, source: 'Distilled', kind: 'summary', session,
      text: `The ${token} path is wired.`, headline: `${token} is wired`,
      goal: '', decisions: '', gotchas: '', highlights: [],
    },
  ];
}

function makeProject(name, events) {
  const key = path.join(ROOT, 'churn-projects', name);
  fs.mkdirSync(key, { recursive: true });
  return { key, proj: { events } };
}

const footerOf = block => (block.split('\n').find(l => /^_(?:Last update|Latest activity):|^_No activity/.test(l)) || '');

function main() {
  util.ensureConfig();
  const config = util.getConfig();

  // ---- 1. the bug: an unchanged project must not rewrite its file ----
  {
    const { key, proj } = makeProject('unchanged', sessionEvents('s1', 'exporter', '2026-08-04T10:00:00.000Z'));
    const file = path.join(key, 'CLAUDE.md');
    const wroteFirst = atClock('2026-08-05T12:00:30Z', () =>
      digest.inject(file, digest.renderBlock(key, proj, config, 'CLAUDE.md'), digest.preambleFor('CLAUDE.md')));
    const wroteAgain = atClock('2026-08-05T12:01:30Z', () =>
      digest.inject(file, digest.renderBlock(key, proj, config, 'CLAUDE.md'), digest.preambleFor('CLAUDE.md')));

    check('unchanged project: the first render writes the file', () => {
      assert.strictEqual(wroteFirst, true, 'fixture: nothing was written, so the check below proves nothing');
    });
    check('unchanged project: a later render does NOT rewrite the file', () => {
      assert.strictEqual(wroteAgain, false,
        'an untouched project rewrote its context file on a later render. Where that file is tracked in git this is '
        + 'a diff nobody authored, on every sync (#66) — the block is carrying a clock reading that moves on its own');
    });
  }

  // ---- 2. THE COUNTER-CHECK: real change must still write ----
  // The fix must not be "stop writing". This is the check that fails if the
  // stamp is frozen, or the guard widened, or the render short-circuited.
  {
    const { key, proj } = makeProject('changed', sessionEvents('s1', 'exporter', '2026-08-04T10:00:00.000Z'));
    const file = path.join(key, 'CLAUDE.md');
    atClock('2026-08-05T12:00:30Z', () =>
      digest.inject(file, digest.renderBlock(key, proj, config, 'CLAUDE.md'), digest.preambleFor('CLAUDE.md')));

    const grown = { events: [...proj.events, ...sessionEvents('s2', 'importer', '2026-08-04T11:00:00.000Z')] };
    const wrote = atClock('2026-08-05T12:00:30Z', () => // SAME clock: only the content differs
      digest.inject(file, digest.renderBlock(key, grown, config, 'CLAUDE.md'), digest.preambleFor('CLAUDE.md')));

    check('COUNTER: a project whose content really changed still writes', () => {
      assert.strictEqual(wrote, true,
        'new activity stopped reaching the context file — the churn fix has become a delivery bug, which is far '
        + 'worse than the churn it replaced');
      assert.ok(fs.readFileSync(file, 'utf8').includes('importer'),
        'the new session never made it into the file');
    });
    check('COUNTER: the stamp tracks the newest rendered activity, so it stays true', () => {
      const footer = footerOf(digest.renderBlock(key, grown, config, 'CLAUDE.md'));
      assert.ok(/2026-08-04 11:00/.test(footer),
        `the stamp does not name the newest rendered activity: ${JSON.stringify(footer)}`);
      assert.ok(!/Last update/.test(footer),
        'the footer still says "Last update" while carrying an activity time — a label that no longer describes its '
        + 'own value is how documentation drifts');
    });
  }

  // ---- 3. an empty history still renders a STABLE stamp ----
  // A project with nothing to say still renders a block. If the empty case
  // fell back to the clock (or to an absent line that differs from what was
  // there before), it would churn in a new way instead of the old one.
  {
    const { key, proj } = makeProject('empty', []);
    const file = path.join(key, 'CLAUDE.md');
    const first = atClock('2026-08-05T12:00:30Z', () => digest.renderBlock(key, proj, config, 'CLAUDE.md'));
    atClock('2026-08-05T12:00:30Z', () => digest.inject(file, first, digest.preambleFor('CLAUDE.md')));
    const later = atClock('2026-08-05T23:59:30Z', () => digest.renderBlock(key, proj, config, 'CLAUDE.md'));
    const wroteAgain = atClock('2026-08-05T23:59:30Z', () =>
      digest.inject(file, later, digest.preambleFor('CLAUDE.md')));

    check('empty history: the stamp is a fixed sentence, not a clock reading', () => {
      assert.ok(/^_No activity recorded yet/.test(footerOf(first)),
        `an empty project produced ${JSON.stringify(footerOf(first))} — it must be stable and it must still say something`);
      assert.strictEqual(footerOf(later), footerOf(first));
    });
    check('empty history: a later render does not rewrite the file either', () => {
      assert.strictEqual(wroteAgain, false, 'an empty project churned its context file');
    });
  }

  // ---- 4. the upgrade path through lib/hooks-prime.js ----
  // Every block already on disk carries the OLD clock-based footer. The
  // SessionStart dedupe gate compares on-disk content against a fresh render;
  // if the two footers read as a difference, the gate misses and the hook
  // injects a duplicate copy on every single session start until the daemon
  // rewrites that file. That is a silent token-cost regression, so it gets a
  // check rather than a hope.
  {
    const { key, proj } = makeProject('upgrade', sessionEvents('s1', 'exporter', '2026-08-04T10:00:00.000Z'));
    const st = util.loadState();
    st.projects = { ...(st.projects || {}), [key]: proj };
    util.saveState(st);

    const fresh = digest.renderBlock(key, proj, config, 'CLAUDE.md');
    const legacy = fresh.replace(/_Latest activity:[^\n]*/, '_Last update: 2026-08-05 12:00 UTC · synced by MemBridge_');
    fs.writeFileSync(path.join(key, 'CLAUDE.md'), legacy);

    check('upgrade: a block still carrying the legacy footer is not read as stale', () => {
      const out = hooksPrime.buildPrimeOutput({ projectPath: key, cwd: key, source: 'startup', config, state: st });
      assert.strictEqual(out, null,
        'the session-start hook treated an up-to-date block as stale purely because its footer used the old label — '
        + 'every session on every upgraded install would carry a duplicate copy of the block');
    });

    // COUNTER: the gate must still fire for a block that is genuinely stale,
    // or the fix above has simply blinded it.
    check('COUNTER: a genuinely stale on-disk block still triggers the injection', () => {
      fs.writeFileSync(path.join(key, 'CLAUDE.md'),
        legacy.replace(/exporter/g, 'something-else-entirely'));
      const out = hooksPrime.buildPrimeOutput({ projectPath: key, cwd: key, source: 'startup', config, state: st });
      assert.ok(out && out.text,
        'the dedupe gate stopped firing for a block whose content really is stale — it is now blind, not accurate');
    });
  }

  h.finish();
}

main();
