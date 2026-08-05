'use strict';
// Subagent (sidechain) activity capture. Shared plumbing lives in
// test/harness.js; run this file directly, or via
// `node test/run.js subagent-activity`.
//
// A lead-plus-teammates agent team makes every file edit from a subagent, and
// the adapter used to drop everything about a sidechain turn except its token
// spend. MemBridge therefore recorded what the subagents COST and nothing about
// what they DID: real asks, real summaries, `files: []` on every session, on
// exactly the days the most work happened. Subagent EDITS are now kept and
// attributed to the parent session; prompts, summaries, todos and reads are
// still dropped on purpose. See lib/adapters/claude-code.js for the per-kind
// rationale, and keep these tests together so nobody re-drops one half of it.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const path = require('path');
const claudeAdapter = require('../../lib/adapters/claude-code');
const projectResolve = require('../../lib/project-resolve');
const scan = require('../../lib/scan');
const classify = require('../../lib/classify');

const FS = () => ({ pendingCreates: {}, tasks: {} });
const sidechain = (over = {}) => Object.assign({
  type: 'assistant', timestamp: '2026-08-04T10:00:00Z', cwd: '/repo',
  sessionId: 'parent-session', isSidechain: true,
}, over);

async function main() {
  // --- adapter: which sidechain kinds survive ---
  check('sidechain: every edit-shaped tool emits an edit on the parent session', () => {
    const entries = [sidechain({
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.js' } },
          { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/repo/b.js' } },
          { type: 'tool_use', id: 't3', name: 'MultiEdit', input: { file_path: '/repo/c.js' } },
          { type: 'tool_use', id: 't4', name: 'NotebookEdit', input: { file_path: '/repo/d.ipynb' } },
        ],
      },
    })];
    const edits = claudeAdapter.extractEvents(entries, FS()).filter(e => e.kind === 'edit');
    assert.deepStrictEqual(edits.map(e => e.file),
      ['/repo/a.js', '/repo/b.js', '/repo/c.js', '/repo/d.ipynb'],
      'all four edit-shaped tools must be captured from a subagent, same as main-chain');
    for (const e of edits) {
      assert.strictEqual(e.session, 'parent-session',
        'a sidechain record names the PARENT session, so its edits attribute there');
      assert.strictEqual(e.source, 'Claude Code');
      assert.strictEqual(e.project, '/repo', 'the adapter stamps cwd; rehomeEvents re-homes by file path later');
    }
  });

  check('sidechain: an edit tool_use with no file_path emits nothing', () => {
    const entries = [sidechain({ message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] } })];
    const events = claudeAdapter.extractEvents(entries, FS());
    assert.strictEqual(events.filter(e => e.kind === 'edit').length, 0);
  });

  // scan.js falls back to the transcript FILENAME when an event has no session,
  // and a subagent transcript is named `agent-<hex>` -- a session with no prompt
  // and no summary, i.e. a phantom card on the feed. Attribute to the parent or
  // not at all.
  check('sidechain: a record with no sessionId emits no edit (no phantom agent-* session)', () => {
    const entries = [sidechain({
      sessionId: undefined,
      message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.js' } }] },
    })];
    const events = claudeAdapter.extractEvents(entries, FS());
    assert.strictEqual(events.filter(e => e.kind === 'edit').length, 0,
      'an edit that cannot name the parent session must be dropped, not filed under agent-<hex>');
  });

  check('sidechain: usage is unchanged — still emitted, still sidechain:true', () => {
    const entries = [sidechain({
      message: {
        id: 'm1', model: 'claude-opus-4-6', usage: { input_tokens: 3, output_tokens: 7 },
        content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.js' } }],
      },
    })];
    const usage = claudeAdapter.extractEvents(entries, FS()).filter(e => e.kind === 'usage');
    assert.strictEqual(usage.length, 1, 'the ledger still needs every sidechain request');
    assert.strictEqual(usage[0].sidechain, true,
      'sidechain must stay a distinct request stream — the ledger epoch-splits on it');
    assert.strictEqual(usage[0].messageId, 'm1');
    assert.strictEqual(usage[0].session, 'parent-session');
  });

  check('sidechain: a record with no usage still yields its edits', () => {
    const entries = [sidechain({
      message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.js' } }] },
    })];
    const events = claudeAdapter.extractEvents(entries, FS());
    assert.strictEqual(events.filter(e => e.kind === 'edit').length, 1);
    assert.strictEqual(events.filter(e => e.kind === 'usage').length, 0);
  });

  check('sidechain: reads are still dropped (they are the ledger savings denominator)', () => {
    const entries = [sidechain({
      message: {
        id: 'm1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.js' } },
          { type: 'tool_use', id: 't2', name: 'Grep', input: { path: '/repo' } },
          { type: 'tool_use', id: 't3', name: 'Glob', input: { path: '/repo' } },
        ],
      },
    })];
    const events = claudeAdapter.extractEvents(entries, FS());
    assert.strictEqual(events.filter(e => e.kind === 'read').length, 0,
      'subagent reads would silently re-baseline the published redundant-read figures');
  });

  // A subagent's user turn is the spawn prompt the LEAD wrote, not a human ask.
  check('sidechain: a human-looking user turn emits no prompt', () => {
    const entries = [{
      type: 'user', timestamp: '2026-08-04T10:00:00Z', cwd: '/repo',
      sessionId: 'parent-session', isSidechain: true,
      message: { content: [{ type: 'text', text: 'Please refactor the parser and report back with what you changed.' }] },
    }];
    const events = claudeAdapter.extractEvents(entries, FS());
    assert.strictEqual(events.filter(e => e.kind === 'prompt').length, 0,
      'the spawn prompt is the lead talking to a tool, not a human ask — surfacing it would fabricate asks');
  });

  // A subagent's closing text is a report addressed to the lead, and it must not
  // become the session's summary NOR poison fileState.lastText for a later pass.
  check('sidechain: assistant text emits no summary and does not touch fileState.lastText', () => {
    const long = 'I rewrote the parser, extracted the tokenizer into its own module, and updated every caller accordingly.';
    assert.ok(long.length >= 80, 'fixture must clear MIN_SUMMARY_CHARS or the test proves nothing');
    const fileState = FS();
    const entries = [sidechain({ message: { id: 'm1', content: [{ type: 'text', text: long }] } })];
    const events = claudeAdapter.extractEvents(entries, fileState);
    assert.strictEqual(events.filter(e => e.kind === 'summary').length, 0,
      'a subagent report is not the session summary');
    assert.strictEqual(fileState.lastText, undefined,
      'a sidechain record must not become the carried lastText, or a later pass would emit it as a summary');
  });

  // Todos are one snapshot per session and renderers keep only the LATEST, so a
  // subagent's private checklist would overwrite the lead's "Where you left
  // off" list. This is corruption of a working feature, not a value judgement.
  check('sidechain: TodoWrite emits no todos (must not overwrite the lead\'s list)', () => {
    const entries = [sidechain({
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
          { content: 'read the adapter', status: 'completed' },
          { content: 'grep for callers', status: 'in_progress' },
        ] } }],
      },
    })];
    const events = claudeAdapter.extractEvents(entries, FS());
    assert.strictEqual(events.filter(e => e.kind === 'todos').length, 0,
      'a subagent checklist must never replace the human session\'s task snapshot');
  });

  check('sidechain: TaskCreate/TaskUpdate feed the same snapshot and stay out too', () => {
    const fileState = FS();
    const entries = [
      sidechain({ message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'port the parser' } }] } }),
      { type: 'user', timestamp: '2026-08-04T10:00:01Z', cwd: '/repo', sessionId: 'parent-session', isSidechain: true,
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Task #7 created successfully: port the parser' }] } },
    ];
    const events = claudeAdapter.extractEvents(entries, fileState);
    assert.strictEqual(events.filter(e => e.kind === 'todos').length, 0);
    assert.deepStrictEqual(fileState.tasks, {}, 'a sidechain TaskCreate must not even be parked in fileState');
  });

  // Main-chain behaviour must be untouched by all of the above.
  check('sidechain: main-chain records still emit prompt, edit, read, summary and todos', () => {
    const long = 'Rewrote the parser and updated every caller, then verified the suite still passes end to end.';
    const entries = [
      { type: 'user', timestamp: '2026-08-04T10:00:00Z', cwd: '/repo', sessionId: 's1',
        message: { content: [{ type: 'text', text: 'refactor the parser please' }] } },
      { type: 'assistant', timestamp: '2026-08-04T10:00:01Z', cwd: '/repo', sessionId: 's1',
        message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 }, content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.js' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/a.js' } },
          { type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'ship it', status: 'pending' }] } },
          { type: 'text', text: long },
        ] } },
    ];
    const kinds = new Set(claudeAdapter.extractEvents(entries, FS()).map(e => e.kind));
    for (const k of ['prompt', 'edit', 'read', 'todos', 'summary', 'usage']) {
      assert.ok(kinds.has(k), `main-chain must still emit ${k}`);
    }
  });

  // --- pipeline: where a kept sidechain edit is FILED ---
  // The project comes from the edited FILE, not the record's cwd. That is what
  // makes a subagent editing another worktree (or another repo) land correctly,
  // and it is the whole reason no cwd-based attribution was added above.
  {
    const A = path.resolve('/repoA'), B = path.resolve('/repoB'), U = path.resolve('/untracked');
    const tracked = new Set([A, B]);
    const stubs = {
      hasMembridge: d => d === A || d === B,
      hasGit: d => d === A || d === B || d === U,
      worktreeMain: () => null,
      isProtectedDir: () => false,
    };
    const edit = (project, file) => ({
      ts: '2026-08-04T10:00:00Z', source: 'Claude Code', kind: 'edit', session: 's1', project, file,
    });
    const route = evs => {
      projectResolve.rehomeEvents(evs, tracked, stubs);
      return scan.filterTrackedSessions(evs, tracked, stubs);
    };

    check('sidechain edit: a cross-project edit is filed by FILE path, not by cwd', () => {
      const evs = [edit(A, path.join(B, 'x.js'))];
      const kept = route(evs);
      assert.strictEqual(kept.length, 1);
      assert.strictEqual(kept[0].project, B,
        'a subagent editing another repo must land on that repo, never on the session cwd');
    });

    check('sidechain edit: a scratchpad edit is dropped, never filed anywhere', () => {
      const evs = [edit(A, '/private/tmp/claude-501/x/scratchpad/t.js')];
      assert.deepStrictEqual(route(evs), [],
        'throwaway subagent work must not reach a project (the phantom-project bug)');
      assert.strictEqual(evs[0].project, null, 'rehome nulls the project so the ingestion gate drops it');
    });

    check('sidechain edit: an edit inside the session\'s own project is unchanged', () => {
      const evs = [edit(A, path.join(A, 'z.js'))];
      const kept = route(evs);
      assert.strictEqual(kept.length, 1);
      assert.strictEqual(kept[0].project, A);
    });

    // filterScratchpadResidue drops a session ENTIRELY -- prompt and summary
    // included -- when it had a temp edit and no real edit. Subagent temp edits
    // now count toward that, so a session whose subagent wrote scratchpad files
    // AND real files must keep everything but the scratchpad edit. (Measured on
    // the live corpus: 0 of 130 edit-bearing sessions newly drop from this.)
    check('sidechain edit: a subagent\'s temp edit does not take the session down with it', () => {
      const evs = [
        { ts: '2026-08-04T10:00:00Z', source: 'Claude Code', kind: 'prompt', session: 's1', project: A, text: 'do the thing' },
        edit(A, '/private/tmp/claude-501/x/scratchpad/t.js'),
        edit(A, path.join(A, 'real.js')),
      ];
      const surviving = scan.filterScratchpadResidue(evs);
      assert.strictEqual(surviving.filter(e => e.kind === 'prompt').length, 1,
        'the session must survive: its subagent made a real edit too');
      assert.deepStrictEqual(surviving.filter(e => e.kind === 'edit').map(e => e.file),
        [path.join(A, 'real.js')], 'only the scratchpad edit is dropped');
    });
  }

  // --- the second win: shareability on merit ---
  // classify.js suppresses zero-edit sessions from edit-capturing sources out of
  // the feed, the CLAUDE.md block AND the team push. A pure-lead session has no
  // main-chain edits, so it only ever survived because the Stop hook's
  // `Distilled` source never emits edits and therefore is not edit-capturing --
  // its mere presence rescued the session. That is why Marco saw real asks and
  // summaries with `files: []`. Such a session now qualifies on its own merit.
  check('sidechain edit: a lead session whose only edits came from subagents is shareable on its own merit', () => {
    const events = [
      // Another session establishes Claude Code as edit-capturing for this project.
      { ts: '2026-08-04T09:00:00Z', source: 'Claude Code', kind: 'edit', session: 'other', file: '/repoA/x.js' },
      { ts: '2026-08-04T10:00:00Z', source: 'Claude Code', kind: 'prompt', session: 'lead', text: 'plan and delegate the fix' },
      { ts: '2026-08-04T10:05:00Z', source: 'Claude Code', kind: 'edit', session: 'lead', file: '/repoA/y.js' }, // from a subagent
    ];
    assert.ok(classify.shareableSessions(events).has('lead'),
      'the lead session is shareable because of its subagents\' edits, not because a Distilled summary happened to exist');

    // Without the subagent edit it is ops noise, which is what shipped before.
    const before = events.filter(e => !(e.session === 'lead' && e.kind === 'edit'));
    assert.ok(!classify.shareableSessions(before).has('lead'),
      'proves the mechanism: the same session with no edits is suppressed entirely');
  });

  h.finish();
}

main();
