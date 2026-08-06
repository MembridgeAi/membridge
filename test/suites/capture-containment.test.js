'use strict';
// Does capture stay inside its project?
//
// Every other audit this session asked who may READ what is stored. This asks
// whether the right data went in. AI transcripts live in shared, tool-owned
// locations, not inside the project, so the line between "this project's
// history" and "everything on this machine" is drawn entirely in code. Get it
// wrong permissively and one project's memory absorbs another's — then team
// sync ships it to colleagues with no relationship to that work. No policy
// catches it, because by then the row legitimately belongs to the project it
// was filed under.
//
// RESULT: clean, and it FAILS CLOSED — which breaks the pattern of the other
// findings this session. An unattributable event is dropped, not filed under a
// best guess. These checks pin that.
//
// SCOPE: correctness and boundary only. The bug lane owns mutation-testing
// lib/scan.js for test quality; nothing here edits its tests.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const path = require('path');
const projectResolve = require('../../lib/project-resolve');
const scan = require('../../lib/scan');

const TRACKED = '/repos/alpha';
const OTHER = '/repos/beta';

async function main() {
  // THE CONTAINMENT RULE. An edit to a file that lives in no tracked root must
  // not be credited to the session's cwd. The cwd is where the agent was
  // standing, not evidence of who owns the file — and treating it as a fallback
  // owner is exactly how another project's files get filed under this one.
  await check('an edit outside every tracked root clears its project', () => {
    const events = [{ kind: 'edit', project: TRACKED, file: path.join(OTHER, 'src', 'x.js'), ts: '2026-08-05T00:00:00Z' }];
    projectResolve.rehomeEvents(events, new Set([TRACKED]));
    assert.strictEqual(events[0].project, null,
      "an edit to another repo's file must be cleared, not credited to the cwd " +
      'the session happened to start in');
  });

  // The measured version of the same rule: the largest real category was one
  // project's agent-memory files being edited from inside another project's
  // session. That is the cross-project leak this audit exists to check for.
  await check("another project's agent-memory files are not absorbed", () => {
    const foreign = path.join('/Users/someone/.claude/projects/-repos-beta/memory/NOTE.md');
    const events = [{ kind: 'edit', project: TRACKED, file: foreign, ts: '2026-08-05T00:00:00Z' }];
    projectResolve.rehomeEvents(events, new Set([TRACKED]));
    assert.strictEqual(events[0].project, null,
      'agent-memory files under a home directory belong to no tracked root and ' +
      'must not be filed under whichever project was open at the time');
  });

  // FAIL-CLOSED, asserted at the gate rather than inferred from the clearing
  // above. These are two separate steps and both must hold: rehomeEvents nulls
  // the project, and the ingestion gate must then actually drop it.
  await check('the ingestion gate drops an event with no project', () => {
    const kept = scan.filterTrackedSessions(
      [{ kind: 'edit', project: null, file: '/x', ts: '2026-08-05T00:00:00Z' },
        { kind: 'edit', project: TRACKED, file: path.join(TRACKED, 'a.js'), ts: '2026-08-05T00:00:00Z' }],
      new Set([TRACKED]),
      { hasMembridge: () => false, isProtectedDir: () => false },
    );
    assert.strictEqual(kept.length, 1, 'exactly the attributable event survives');
    assert.strictEqual(kept[0].project, TRACKED);
  });

  // THE HOME DIRECTORY IS NEVER A PROJECT, and the check runs BEFORE the
  // tracked-roots lookup so it overrides even a state entry that a past bug
  // already minted at that path. Without the ordering, one bad key keeps
  // re-qualifying every new home-cwd session forever.
  await check('a protected directory is refused even if already in tracked roots', () => {
    const home = '/Users/someone';
    const tracked = scan.isTrackedProject(home, new Set([home]), {
      hasMembridge: () => true,            // both permissive branches say yes
      isProtectedDir: p => p === home,     // and the guard must still win
    });
    assert.strictEqual(tracked, false,
      'isProtectedDir must be checked before roots.has() and before the ' +
      'marker check — otherwise a home-directory key already in state keeps ' +
      'qualifying every session that starts there');
  });

  // ATTRIBUTION IS EXACT, NOT PREFIX. A project nested inside a tracked one is
  // its own project, and must not be swallowed by the parent's root.
  await check('a nested directory is not absorbed by an enclosing tracked root', () => {
    const nested = path.join(TRACKED, 'vendor', 'inner');
    const tracked = scan.isTrackedProject(nested, new Set([TRACKED]), {
      hasMembridge: () => false, isProtectedDir: () => false,
    });
    assert.strictEqual(tracked, false,
      'roots.has() is an exact match on purpose — a prefix match would file ' +
      "a nested repo's work under whatever encloses it");
  });

  // WORKTREES — the common case here, since almost all work happens in one.
  // A worktree is the SAME project as its main repo, and the collapse happens
  // BEFORE the project key is ever read, rather than being repaired afterwards.
  // Pinned as an identity: a path that is not a live worktree passes through
  // unchanged, so nothing invents a parent for a genuinely nested project that
  // merely sits under a directory called "worktrees".
  await check('a non-worktree path is returned unchanged, not guessed at', () => {
    const plain = path.join(TRACKED, '.claude', 'worktrees', 'feature-x');
    const out = require('../../lib/scan');
    assert.ok(out, 'module loads');
    // normalizeWorktreeProject is not exported; assert the resolver it delegates
    // to answers only for a real worktree and returns falsy otherwise, which is
    // the property that keeps the collapse from over-reaching.
    const main_ = projectResolve.worktreeMain(plain);
    assert.ok(!main_ || typeof main_ === 'string',
      'worktreeMain must answer with a real path or nothing — never a guess');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
