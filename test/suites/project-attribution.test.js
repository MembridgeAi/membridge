'use strict';
// Attribution of edits to files that live OUTSIDE every tracked project.
//
// THE RULE: a session that edited nothing inside a project does not appear in
// that project. rehomeEvents (lib/project-resolve.js) re-stamps each edit from
// its own file path; when the file resolves to no tracked root it now CLEARS
// ev.project so the ingestion gate drops the edit, instead of leaving it on the
// session cwd. The cwd is not a fallback owner.
//
// WHY. Measured on a real machine (607 transcripts, 4941 edit events after the
// scratchpad filter): 403 edits resolved to no tracked root, and 235 of those
// were stamped to a project a human can actually see. 172 were another
// project's agent-memory files under ~/.claude/projects/<slug>/memory, 47 were
// loose files under the home directory or an untracked git repo, 14 were other
// ~/.claude state, 2 were /tmp patches. None had a re-attribution target: the
// only "owner" of those paths is the home directory, which isTrackedProject
// refuses unconditionally. In the same corpus the number of unresolvable edits
// that were genuinely INSIDE their cwd was ZERO.
//
// WHAT IT COSTS, WHICH IS THE POINT AND NOT AN OVERSIGHT. Clearing the project
// does not remove a wrong file from a project -- no file surface ever showed it,
// see half 2 -- it removes the SESSION. A Claude Code session with no edit event
// is ops noise by definition (lib/classify.js), so a session whose ONLY edits
// were outside the project loses its ask and its agent summary from the injected
// block, the memory DB, the feed and the team push too. On the machine above
// that is 16 sessions: 13 in Documents/Membridge, 2 in Documents/AI, 1 in
// Websites. A session that also edited something real keeps everything and just
// loses the foreign file. Both halves of that are pinned below, because the
// deletion looks like a bug on its own and invites someone to "fix" it back.
//
// THE FIX IS CAPTURE-SIDE AND FORWARD-ONLY. rehomeEvents runs on newly scanned
// events only (offsets advance once), so every foreign path already sitting in
// state.json keeps its old attribution forever. That is why half 2 still pins
// containment at the file surfaces: memorydb.relFile and digest.dedupeFiles are
// the only thing standing between those legacy events and a teammate's screen,
// and they must not be removed now that capture is stricter.
//
// Run via `node test/run.js project-attribution`, or this file directly.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../../lib/util');
const digest = require('../../lib/digest');
const memorydb = require('../../lib/memorydb');
const projectResolve = require('../../lib/project-resolve');
const { filterTrackedSessions } = require('../../lib/scan');

async function main() {
  const config = util.getConfig();

  // --- half 1: containment at capture ---------------------------------------

  // The live shape, with the REAL resolveRoot and a real project fixture on
  // disk: a session working in a tracked project edits another project's
  // agent-memory file under the home directory. The walk-up reaches the home
  // directory, which is never a root (isProtectedDir), so nothing resolves --
  // and the edit is dropped rather than credited to the cwd.
  check('rehome: an edit outside every tracked root does not carry the cwd project', () => {
    const proj = path.join(ROOT, 'attr-project');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    const foreign = path.join(os.homedir(), '.claude', 'projects', '-Users-x-Documents-Other', 'memory', 'NOTE.md');
    const events = [
      { kind: 'prompt', project: proj, session: 's1', ts: '2026-08-01T10:00:00.000Z', text: 'consolidate the notes' },
      { kind: 'edit', project: proj, session: 's1', ts: '2026-08-01T10:01:00.000Z', file: foreign },
      { kind: 'summary', project: proj, session: 's1', ts: '2026-08-01T10:02:00.000Z', text: 'rewrote the other project memory file' },
    ];
    projectResolve.rehomeEvents(events, new Set([util.normPath(proj)]));
    assert.strictEqual(events[1].project, null,
      'an edit to a file outside the project must not be recorded against it');
    const kept = filterTrackedSessions(events, new Set([util.normPath(proj)]));
    assert.ok(!kept.some(e => e.kind === 'edit'), 'the ingestion gate must drop the cleared edit');
    assert.strictEqual(kept.length, 2, 'the ask and summary are still ingested; classify is what suppresses them');
  });

  // The consequence, stated as an executable fact so nobody has to re-derive it
  // from lib/classify.js and so nobody mistakes it for a separate bug: with the
  // edit gone the session is a zero-edit Claude Code session, and the whole
  // session stops being shown.
  // Note the fixture shape: a SECOND session with a real in-project edit is
  // present on purpose. classify infers which tools capture edits from the event
  // set it is handed, so an outside-only session judged completely alone would
  // make Claude Code look like a tool that never emits edits and would be
  // spared. In the real pipeline the whole project's events are judged together
  // and the tool is known to capture edits.
  check('rehome: clearing the edit removes the SESSION, ask and summary included', () => {
    const classify = require('../../lib/classify');
    const proj = path.join(ROOT, 'attr-drop');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    const events = [
      { source: 'Claude Code', kind: 'prompt', project: proj, session: 'other', ts: '2026-08-01T09:00:00.000Z', text: 'real work' },
      { source: 'Claude Code', kind: 'edit', project: proj, session: 'other', ts: '2026-08-01T09:01:00.000Z', file: path.join(proj, 'real.js') },
      { source: 'Claude Code', kind: 'prompt', project: proj, session: 's2', ts: '2026-08-01T10:00:00.000Z', text: 'patch the build script' },
      { source: 'Claude Code', kind: 'edit', project: proj, session: 's2', ts: '2026-08-01T10:01:00.000Z', file: path.join(os.homedir(), 'Desktop', 'tmp-script.sh') },
      { source: 'Claude Code', kind: 'summary', project: proj, session: 's2', ts: '2026-08-01T10:02:00.000Z', text: 'patched it' },
    ];
    projectResolve.rehomeEvents(events, new Set([util.normPath(proj)]));
    const kept = filterTrackedSessions(events, new Set([util.normPath(proj)]));
    assert.ok(!classify.shareableSessions(kept).has('s2'),
      'a session left with no in-project edit must not appear in the project');
    assert.ok(classify.shareableSessions(kept).has('other'),
      'the session that did edit something real is untouched');
    // End to end: the ask and the summary are gone from the injected block.
    const block = digest.renderBlock(proj, { events: kept }, config, 'CLAUDE.md');
    assert.ok(!block.includes('patch the build script'), "the dropped session's ask leaked into the block");
    assert.ok(!block.includes('patched it'), "the dropped session's summary leaked into the block");
    assert.ok(block.includes('real work'), 'the session with real work must still be shown');
  });

  // A session that edited something real keeps everything; only the foreign file
  // goes. This is the half that stops the rule being read as "any session that
  // touched an outside file disappears".
  check('rehome: a mixed session keeps its ask, summary and in-project edit', () => {
    const proj = path.join(ROOT, 'attr-mixed');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    const events = [
      { source: 'Claude Code', kind: 'prompt', project: proj, session: 'm1', ts: '2026-08-01T11:00:00.000Z', text: 'fix the scanner' },
      { source: 'Claude Code', kind: 'edit', project: proj, session: 'm1', ts: '2026-08-01T11:01:00.000Z', file: path.join(proj, 'src', 'own.js') },
      { source: 'Claude Code', kind: 'edit', project: proj, session: 'm1', ts: '2026-08-01T11:02:00.000Z', file: path.join(os.homedir(), '.claude', 'settings.json') },
      { source: 'Claude Code', kind: 'summary', project: proj, session: 'm1', ts: '2026-08-01T11:03:00.000Z', text: 'scanner fixed' },
    ];
    projectResolve.rehomeEvents(events, new Set([util.normPath(proj)]));
    assert.strictEqual(util.normPath(events[1].project), util.normPath(proj), 'the in-project edit lost its project');
    assert.strictEqual(events[2].project, null, 'the foreign edit kept a project it has no business in');
    const kept = filterTrackedSessions(events, new Set([util.normPath(proj)]));
    assert.strictEqual(kept.length, 3, 'ask, in-project edit and summary all survive');
  });

  // The escape hatch, and why it is containment rather than attribution: a file
  // that genuinely lives INSIDE the project keeps its project even when the
  // walk-up never reaches the root. An untracked nested `.git` is the boundary
  // that does this (resolveRoot stops there on purpose so a nested repo's work
  // is not captured by its tracked parent). Dropping such an edit would lose
  // real in-project work, which the rule above is not for.
  check('rehome: an unresolvable edit that IS inside the project keeps it', () => {
    const proj = path.join(ROOT, 'attr-nested');
    const nested = path.join(proj, 'vendor', 'thirdparty');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    const events = [
      { kind: 'edit', project: proj, session: 'n1', ts: '2026-08-01T15:00:00.000Z', file: path.join(nested, 'lib.c') },
    ];
    projectResolve.rehomeEvents(events, new Set([util.normPath(proj)]));
    assert.strictEqual(util.normPath(events[0].project), util.normPath(proj),
      'an edit inside the project must survive even when the walk-up is blocked before the root');
  });

  // --- half 2: containment at every file surface -----------------------------
  //
  // STILL REQUIRED, AND NOT MADE REDUNDANT BY HALF 1. The capture rule is
  // forward-only: every foreign path already merged into state.json is still
  // stamped to a project and still flows through these surfaces until it ages
  // out of the sliding window. The fixture below is exactly that shape -- events
  // stamped to `proj` directly, the way the old fallback left them -- so these
  // checks are a live path, not belt-and-braces for its own sake. Removing
  // relFile's or dedupeFiles's filter would make half 1 load-bearing for
  // something it structurally cannot cover.

  const proj = path.join(ROOT, 'attr-surfaces');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'own.js'), '// own\n');
  const foreignPaths = [
    path.join(os.homedir(), '.claude', 'projects', '-Users-x-Documents-Other', 'memory', 'MEMORY.md'),
    path.join(os.homedir(), 'Desktop', 'handoff.md'),
    '/tmp/mine.patch',
  ];
  // Two sessions: `mixed` edits its own file and a foreign one; `outside` edits
  // nothing but foreign files. Both are stamped to `proj`, exactly as the old
  // capture-side fallback left them in state.json before the containment rule.
  const projData = { events: [
    { ts: '2026-08-01T11:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'mixed', project: proj, text: 'fix the scanner' },
    { ts: '2026-08-01T11:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 'mixed', project: proj, file: path.join(proj, 'src', 'own.js') },
    { ts: '2026-08-01T11:02:00.000Z', source: 'Claude Code', kind: 'edit', session: 'mixed', project: proj, file: foreignPaths[0] },
    { ts: '2026-08-01T11:03:00.000Z', source: 'Claude Code', kind: 'summary', session: 'mixed', project: proj, text: 'scanner fixed and notes updated' },
    { ts: '2026-08-01T12:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'outside', project: proj, text: 'write the handoff' },
    { ts: '2026-08-01T12:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 'outside', project: proj, file: foreignPaths[1] },
    { ts: '2026-08-01T12:02:00.000Z', source: 'Claude Code', kind: 'edit', session: 'outside', project: proj, file: foreignPaths[2] },
    { ts: '2026-08-01T12:03:00.000Z', source: 'Claude Code', kind: 'summary', session: 'outside', project: proj, text: 'handoff written' },
  ] };

  // The memory DB is the source for the feed, the project page, the search
  // index and the team push, so a foreign path getting past relFile here would
  // reach all four -- including other people's machines.
  check('entries: a legacy foreign path never reaches the memory DB', () => {
    const entries = memorydb.buildEntries(proj, projData, config);
    const body = JSON.stringify(entries);
    for (const f of foreignPaths) {
      assert.ok(!body.includes(f), `foreign absolute path leaked into entries: ${f}`);
      assert.ok(!body.includes(path.basename(f)), `foreign basename leaked into entries: ${path.basename(f)}`);
    }
    const mixed = entries.find(e => e.session === 'mixed');
    assert.deepStrictEqual(mixed.files, ['src/own.js'], "the mixed session shows only the project's own file");
    const outside = entries.find(e => e.session === 'outside');
    assert.ok(outside, 'a legacy outside-only session still produces an entry (buildEntries does not apply classify)');
    assert.deepStrictEqual(outside.files, [], 'its file list is empty, not foreign');
  });

  // The injected CLAUDE.md block is the most-read surface and the one that goes
  // into other agents' context windows.
  check('block: a legacy outside-only session says so and leaks no foreign path', () => {
    const block = digest.renderBlock(proj, projData, config, 'CLAUDE.md');
    for (const f of foreignPaths) {
      assert.ok(!block.includes(f), `foreign absolute path leaked into the block: ${f}`);
      assert.ok(!block.includes(path.basename(f)), `foreign basename leaked into the block: ${path.basename(f)}`);
    }
    // Reachable only for events captured BEFORE the containment rule -- a
    // session in this shape can no longer be created. Kept because the
    // placeholder is what those stored events render as until they age out.
    assert.ok(block.includes('Files: (outside project)'),
      'a legacy outside-only session must say so rather than lying about its files');
    assert.ok(/src\/own\.js/.test(block), "the project's own file is still listed");
  });

  // recentFiles feeds the block's trailing "Files recently modified" line and
  // the project page; it shares dedupeFiles with the block but is reached by a
  // different caller, so it is pinned separately.
  check('recentFiles / project stats: foreign paths are excluded from both', () => {
    const recent = digest.recentFiles(proj, projData, config).map(f => f.file);
    assert.deepStrictEqual(recent, ['src/own.js'], 'recentFiles must list only in-project files');
    const stats = memorydb.projectStats
      ? memorydb.projectStats(proj, projData, config)
      : null;
    if (stats && Array.isArray(stats.files)) {
      for (const f of stats.files) {
        assert.ok(!path.isAbsolute(f) && !f.startsWith('..'), `project stats exposed a foreign path: ${f}`);
      }
    }
  });

  // --- the boundary the containment rule must not cross ----------------------

  // Containment is not the same as dropping every unresolved edit: an edit
  // inside ANOTHER tracked project is re-homed to that project, so one
  // project's work is credited to its real owner rather than deleted. This is
  // the case that would be a genuine bug either way.
  check('rehome: an edit inside ANOTHER tracked project is re-homed to it, not dropped', () => {
    const A = path.join(ROOT, 'attr-A');
    const B = path.join(ROOT, 'attr-B');
    for (const d of [A, B]) fs.mkdirSync(path.join(d, '.membridge'), { recursive: true });
    const tracked = new Set([util.normPath(A), util.normPath(B)]);
    const events = [
      { kind: 'prompt', project: A, session: 's3', ts: '2026-08-01T13:00:00.000Z', text: 'cross-repo change' },
      { kind: 'edit', project: A, session: 's3', ts: '2026-08-01T13:01:00.000Z', file: path.join(A, 'a.js') },
      { kind: 'edit', project: A, session: 's3', ts: '2026-08-01T13:02:00.000Z', file: path.join(B, 'b.js') },
    ];
    projectResolve.rehomeEvents(events, tracked);
    assert.strictEqual(util.normPath(events[1].project), util.normPath(A));
    assert.strictEqual(util.normPath(events[2].project), util.normPath(B),
      "an edit inside another tracked project must be credited to it, never dropped and never left on the cwd");
  });

  // The home directory is where every misattributed path in the corpus walked
  // up to, so pin that it can never become the owner even when it is already a
  // state.projects key (a shape a previous bug really minted on this machine).
  check('rehome: the home directory never claims an edit, even as an existing key', () => {
    const home = os.homedir();
    const events = [
      { kind: 'edit', project: home, session: 's4', ts: '2026-08-01T14:00:00.000Z', file: path.join(home, '.tmux.conf') },
    ];
    projectResolve.rehomeEvents(events, new Set([util.normPath(home)]));
    const kept = filterTrackedSessions(events, new Set([util.normPath(home)]));
    assert.deepStrictEqual(kept, [], 'nothing rooted at the home directory survives the gate');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
