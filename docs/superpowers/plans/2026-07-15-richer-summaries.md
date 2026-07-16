# Richer Summaries (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every synced summary show a teammate three distinct, never-truncated things — intent, outcome, and meaningful changes — rendered richly on the dashboard and compactly in the injected context block.

**Architecture:** One captured data model (`goal` + `did`/`decisions`/`gotchas` + `highlights`, kept as separate fields instead of one truncated blob) flows through two paths: the injected text block (`digest.sessionGroups` → `digest.renderBlock`) and the dashboard/team feed (`memorydb.buildEntries` → `feed.normalizeLocal` → `server` payloads → `teamsync`). A new pure module `lib/changes.js` derives per-file change facts (new/edited/deleted, line counts, deps dimmed) from git, overlaying the agent's key-file tags.

**Tech Stack:** Node.js (CommonJS, zero runtime deps), `git` CLI (best-effort, degrades gracefully), custom `test/run-tests.js` harness (`check(name, fn)` + `npm test`).

---

## Data contracts (used across tasks — keep names identical)

**Distilled summary line** (`.membridge/summaries.jsonl`, one per checkpoint):
```json
{"session":"…","ts":"…","goal":"<1 line intent>","did":"<1-3 sentences>","decisions":"<or ''>","gotchas":"<or ''>","highlights":[{"file":"lib/mcp.js","note":"the MCP server & 4 tools"}]}
```
`goal` and `highlights` are OPTIONAL — a line without them is still valid.

**Summary event** (after `scanSummaries`, `kind:'summary'`):
```js
{ ts, project, source:'Distilled', kind:'summary', session,
  text,                 // = did (canonical outcome; harvested/legacy events have text only)
  goal,                 // string | undefined
  decisions,            // string | undefined
  gotchas,              // string | undefined
  highlights }          // [{file, note}] | undefined
```

**Change model** (output of `lib/changes.js` `deriveChanges`, one per file):
```js
{ file:'lib/mcp.js', status:'new'|'edited'|'deleted', add:Number|null, del:Number|null, note:String|null, dep:Boolean }
```
Order: non-dep (new → edited → deleted, then path) first, deps last (by path).

**Entry** (from `buildEntries`) and **session group** (from `sessionGroups`) both gain: `goal`, `decisions`, `gotchas`, `highlights`, `changes` (Change model array).

---

## File structure

- **Create** `lib/changes.js` — pure change-model derivation (git-backed, injectable runner). ~90 lines.
- **Modify** `lib/hooks.js` — `blockReason` prompt gains `goal` + `highlights`.
- **Modify** `lib/digest.js` — `blockReason`-style AGENTS.md ask text; `sessionGroups` exposes new fields + `changes`; `renderBlock` emits `Intent`/`Did`/`Notes`/`Changes`.
- **Modify** `lib/scan.js` — `scanSummaries` keeps structured fields instead of concatenating.
- **Modify** `lib/memorydb.js` — `buildEntries` attaches new fields + `changes`.
- **Modify** `lib/feed.js` — `normalizeLocal`/`normalizeTeam` pass new fields through.
- **Modify** `lib/server.js` — `feedPayload`/`projectDetail` redact/pass new fields.
- **Modify** `lib/teamsync.js` — push `goal` (gated) + change model in `files`; pull them back; goal-column fallback.
- **Modify** `lib/dashboard.js` — feed-card render shows Intent/Outcome/Changes.
- **Modify** `test/run-tests.js` — new `check(...)` blocks per task.

---

## Task 1: `lib/changes.js` — change-model derivation

**Files:**
- Create: `lib/changes.js`
- Test: `test/run-tests.js` (append `check(...)` blocks near the other unit checks)

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js` (after the existing digest checks):

```js
const changesLib = require('../lib/changes');

check('changes: git status + numstat → grouped model', () => {
  const runGit = args => {
    if (args[0] === 'status') return '?? lib/mcp.js\n M bin/membridge.js\n D old.js\n';
    if (args[0] === 'diff') return '312\t0\tlib/mcp.js\n28\t4\tbin/membridge.js\n0\t9\told.js\n';
    return '';
  };
  const out = changesLib.deriveChanges('/repo',
    ['bin/membridge.js', 'lib/mcp.js', 'old.js', 'package.json'],
    [{ file: 'lib/mcp.js', note: 'the MCP server' }],
    { runGit });
  // order: new, edited, deleted, then deps last
  assert.deepStrictEqual(out.map(c => c.file), ['lib/mcp.js', 'bin/membridge.js', 'old.js', 'package.json']);
  assert.strictEqual(out[0].status, 'new');
  assert.strictEqual(out[0].add, 312);
  assert.strictEqual(out[0].note, 'the MCP server');
  assert.strictEqual(out[1].status, 'edited');
  assert.strictEqual(out[2].status, 'deleted');
  assert.strictEqual(out[3].dep, true);
  assert.strictEqual(out[3].add, null); // deps: counts suppressed
});

check('changes: git failure degrades to filename-only', () => {
  const runGit = () => { throw new Error('not a git repo'); };
  const out = changesLib.deriveChanges('/repo', ['lib/a.js', 'package.json'], [], { runGit });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].status, 'edited');
  assert.strictEqual(out[0].add, null);
  assert.strictEqual(out[1].dep, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep "changes:"`
Expected: two `FAIL  changes: …` lines (`Cannot find module '../lib/changes'`).

- [ ] **Step 3: Write `lib/changes.js`**

```js
'use strict';
// Pure change-model derivation. Given a project root and the relative file
// paths a session edited, ask git for status + line counts (best-effort) and
// return an ordered, grouped model the renderers share. Any git failure
// degrades to a filename-only list — never throws into a render path.
const { execFileSync } = require('child_process');

const DEP_RE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile(\.lock)?|poetry\.lock|Cargo\.lock|go\.(sum|mod)|requirements\.txt|composer\.(json|lock))$/;
const STATUS_RANK = { new: 0, edited: 1, deleted: 2 };

function defaultRunGit(projectPath) {
  return args => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseStatus(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    if (!file) continue;
    map.set(file, code.includes('D') ? 'deleted' : (code === '??' || code.includes('A')) ? 'new' : 'edited');
  }
  return map;
}

function parseNumstat(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    const m = line.split('\t');
    if (m.length < 3) continue;
    const add = m[0] === '-' ? null : parseInt(m[0], 10);
    const del = m[1] === '-' ? null : parseInt(m[1], 10);
    map.set(m[2].trim(), { add: Number.isFinite(add) ? add : null, del: Number.isFinite(del) ? del : null });
  }
  return map;
}

// files: relative path strings. highlights: [{file, note}] (relative paths).
function deriveChanges(projectPath, files, highlights = [], opts = {}) {
  const rels = [...new Set(files.filter(Boolean))];
  const noteFor = new Map((highlights || []).filter(h => h && h.file).map(h => [h.file, String(h.note || '').trim() || null]));
  let status = new Map(), stat = new Map();
  try {
    const runGit = opts.runGit || defaultRunGit(projectPath);
    status = parseStatus(runGit(['status', '--porcelain', '--untracked-files=all', '--', ...rels]));
    stat = parseNumstat(runGit(['diff', 'HEAD', '--numstat', '--', ...rels]));
  } catch { /* not a repo / git missing → filename-only */ }

  const model = rels.map(file => {
    const dep = DEP_RE.test(file);
    const s = stat.get(file) || {};
    return {
      file,
      status: status.get(file) || 'edited',
      add: dep ? null : (s.add != null ? s.add : null),
      del: dep ? null : (s.del != null ? s.del : null),
      note: noteFor.get(file) || null,
      dep,
    };
  });
  return model.sort((a, b) =>
    (a.dep - b.dep) ||
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    a.file.localeCompare(b.file));
}

module.exports = { deriveChanges, DEP_RE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep "changes:"`
Expected: two `ok    changes: …` lines.

- [ ] **Step 5: Commit**

```bash
git add lib/changes.js test/run-tests.js
git commit -m "feat: add lib/changes.js change-model derivation"
```

---

## Task 2: Capture schema — ask the agent for `goal` + `highlights`

**Files:**
- Modify: `lib/hooks.js:68-79` (`blockReason`)
- Modify: `lib/digest.js:335` (AGENTS.md standing-ask line)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('hooks: blockReason asks for goal and highlights', () => {
  const r = hooks.blockReason('/p/.membridge/summaries.jsonl', 'sess-x', 0);
  assert.ok(/"goal"/.test(r), 'mentions goal field');
  assert.ok(/"highlights"/.test(r), 'mentions highlights field');
  assert.ok(/"did"/.test(r), 'still asks for did');
});
```

`blockReason` is already exported? Confirm `module.exports` in `lib/hooks.js` includes it; if not, add `blockReason` to the exports object in this step.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "hooks: blockReason"`
Expected: `FAIL … mentions goal field` (or `blockReason is not a function` if it needs exporting).

- [ ] **Step 3: Update `blockReason` (`lib/hooks.js`)**

Replace the body of `blockReason` (lines 68-79) with:

```js
function blockReason(target, sessionId, n) {
  const scope = n > 0
    ? `cover ONLY the work done since your previous summary line for this session (${n} already written) — do not repeat or modify earlier lines`
    : 'summarize what you accomplished this session';
  return 'MemBridge session distillation: before stopping, append exactly ONE new line of JSON to ' +
    `${target} (create the .membridge directory if it does not exist; do not modify existing lines): ` +
    `{"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","goal":"...","did":"...","decisions":"...","gotchas":"...","highlights":[{"file":"<path>","note":"..."}]} ` +
    `— goal: 1 short line on what you set out to do; ` +
    `did: 1-3 plain-text sentences that ${scope}; ` +
    'decisions: key choices a teammate would need to know, or ""; ' +
    'gotchas: surprises or pitfalls you hit, or ""; ' +
    'highlights: up to 2 of the most important files with a short note each, or []. ' +
    'Only what a teammate needs — no markdown. Then stop again.';
}
```

If `blockReason` is not already exported, add it: change the `module.exports = { … }` line in `lib/hooks.js` to include `blockReason`.

- [ ] **Step 4: Update the AGENTS.md standing ask (`lib/digest.js:335`)**

Replace that single `lines.push('As you complete work here, append a line …')` string with:

```js
    lines.push('As you complete work here, append a line to `.membridge/summaries.jsonl`: `{"session":"<your session id>","ts":"<ISO time>","goal":"<what you set out to do>","did":"<1-3 sentences on what you did>","decisions":"","gotchas":"","highlights":[]}` — plain text, only what a teammate needs; goal is one line, highlights is up to 2 key files with a short note each. On a long session, append a new line for each further chunk of work (covering only what is new); never edit earlier lines.');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test 2>&1 | grep "hooks: blockReason"`
Expected: `ok    hooks: blockReason asks for goal and highlights`.

- [ ] **Step 6: Commit**

```bash
git add lib/hooks.js lib/digest.js test/run-tests.js
git commit -m "feat: distill prompt captures goal and key-file highlights"
```

---

## Task 3: `scanSummaries` keeps structured fields

**Files:**
- Modify: `lib/scan.js:98-125` (`scanSummaries`)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('scan: distilled summary keeps goal/decisions/gotchas/highlights separate', () => {
  const state = { projects: { '/repo': { events: [] } }, files: {} };
  const line = JSON.stringify({
    session: 's1', ts: '2026-07-16T00:00:00.000Z',
    goal: 'Expose memory to MCP clients', did: 'Built a read-only MCP server',
    decisions: 'read-only by design', gotchas: '', highlights: [{ file: 'lib/mcp.js', note: 'the server' }],
  }) + '\n';
  const dir = path.join('/tmp/does-not-matter'); // path only used for summariesPath; we stub file read
  // Use a real temp project so summariesPath resolves.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-scan-'));
  fs.mkdirSync(path.join(repo, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.membridge', 'summaries.jsonl'), line);
  const st = { projects: { [repo]: { events: [] } }, files: {} };
  const evs = require('../lib/scan').scanSummaries(st, { distill: { enabled: true } });
  const ev = evs.find(e => e.session === 's1');
  assert.ok(ev, 'summary event produced');
  assert.strictEqual(ev.text, 'Built a read-only MCP server'); // text = did only
  assert.strictEqual(ev.goal, 'Expose memory to MCP clients');
  assert.strictEqual(ev.decisions, 'read-only by design');
  assert.deepStrictEqual(ev.highlights, [{ file: 'lib/mcp.js', note: 'the server' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "scan: distilled summary keeps"`
Expected: `FAIL` — `text` still equals the concatenated `did. Decisions: …` blob, and `ev.goal` is undefined.

- [ ] **Step 3: Rewrite the event push in `scanSummaries` (`lib/scan.js:107-122`)**

Replace the `for (const e of r.entries) { … }` body with:

```js
    for (const e of r.entries) {
      if (!e || typeof e.did !== 'string' || !e.did.trim()) continue;
      if (typeof e.session !== 'string' || !e.session) continue;
      const str = v => (typeof v === 'string' ? v.trim() : '');
      const highlights = Array.isArray(e.highlights)
        ? e.highlights
            .filter(h => h && typeof h.file === 'string' && h.file.trim())
            .slice(0, 2)
            .map(h => ({ file: h.file.trim(), note: str(h.note) }))
        : undefined;
      const ev = {
        ts: typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString(),
        project: key,
        source: 'Distilled',
        kind: 'summary',
        session: e.session,
        text: e.did.trim(),          // canonical outcome (= did), no longer a blob
      };
      const goal = str(e.goal), decisions = str(e.decisions), gotchas = str(e.gotchas);
      if (goal) ev.goal = goal;
      if (decisions) ev.decisions = decisions;
      if (gotchas) ev.gotchas = gotchas;
      if (highlights && highlights.length) ev.highlights = highlights;
      events.push(ev);
    }
```

Note: the stored event now carries the extra keys. `digest.mergeEvents` copies `ev.text`, `ev.file`, `ev.session`, `ev.items` today — extend it (Task 3b) so the new keys survive into `state.projects[key].events`.

- [ ] **Step 3b: Preserve the new keys in `mergeEvents` (`lib/digest.js:46-50`)**

Replace the `stored` construction:

```js
    const stored = { ts: ev.ts, source: ev.source, kind: ev.kind };
    if (ev.text) stored.text = ev.text;
    if (ev.file) stored.file = ev.file;
    if (ev.session) stored.session = ev.session;
    if (Array.isArray(ev.items)) stored.items = ev.items;
    if (ev.goal) stored.goal = ev.goal;
    if (ev.decisions) stored.decisions = ev.decisions;
    if (ev.gotchas) stored.gotchas = ev.gotchas;
    if (Array.isArray(ev.highlights)) stored.highlights = ev.highlights;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep "scan: distilled summary keeps"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/scan.js lib/digest.js test/run-tests.js
git commit -m "feat: keep distilled goal/decisions/gotchas/highlights as structured fields"
```

---

## Task 4: Injected block — `Intent` / `Did` / `Notes` / `Changes`

**Files:**
- Modify: `lib/digest.js` — `sessionGroups` (171-202), `renderBlock` (280-320)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('renderBlock: shows Intent/Did/Changes, no 240-char blob truncation', () => {
  const proj = { events: [
    { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'do the mcp thing' },
    { ts: '2026-07-16T00:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 's1', file: '/repo/lib/mcp.js' },
    { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
      text: 'Built a read-only MCP server with four tools.', goal: 'Expose memory to MCP clients',
      decisions: 'read-only by design', gotchas: '', highlights: [{ file: 'lib/mcp.js', note: 'the server' }] },
  ] };
  const block = digest.renderBlock('/repo', proj, { distill: { enabled: true }, team: {} }, 'CLAUDE.md');
  assert.ok(/Intent: Expose memory to MCP clients/.test(block), 'Intent line');
  assert.ok(/Did: Built a read-only MCP server/.test(block), 'Did line');
  assert.ok(/Notes:.*read-only by design/.test(block), 'Notes line');
  assert.ok(/Changes:.*lib\/mcp\.js/.test(block), 'Changes line');
  assert.ok(!/Result:/.test(block), 'no legacy Result label');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "renderBlock: shows Intent"`
Expected: `FAIL` — block still uses `Result:` and lacks `Intent:`.

- [ ] **Step 3: Expose new fields + changes in `sessionGroups` (`lib/digest.js:185-201`)**

In the `.map(events => { … })`, after `const summary = pickSummary(events);` add:

```js
      const changes = require('./changes').deriveChanges(
        projectPath,
        edits.files.map(f => f.file),
        summary && summary.highlights ? summary.highlights : []);
```

and extend the returned object with:

```js
        goal: summary && summary.goal ? summary.goal : '',
        decisions: summary && summary.decisions ? summary.decisions : '',
        gotchas: summary && summary.gotchas ? summary.gotchas : '',
        changes,
```

(keep the existing `summary`, `files`, etc. fields).

- [ ] **Step 4: Add a change-line formatter + rewrite the render loop (`lib/digest.js`)**

Add near `clip` (top of file):

```js
// Compact one-line change summary for the injected block.
function formatChanges(changes) {
  if (!changes || !changes.length) return '';
  let add = 0, del = 0, counted = false;
  const parts = changes.map(c => {
    if (c.add != null) { add += c.add; counted = true; }
    if (c.del != null) { del += c.del; counted = true; }
    const tag = c.dep ? ' (deps)' : c.status === 'new' ? ` (new${c.add != null ? `, +${c.add}` : ''})`
      : c.status === 'deleted' ? ' (deleted)' : '';
    return `${c.file}${tag}`;
  });
  const totals = counted ? ` — +${add} −${del}` : '';
  return parts.join(' · ') + totals;
}
```

Export it: add `formatChanges` to `module.exports`.

Replace the render block for a session (lines 291-299, the `Ask:`/`Result:`/`Files:` group) with:

```js
      lines.push(`- ${shortDate(s.ts)} · ${s.source}`);
      if (s.goal) lines.push(`  Intent: ${clip(redactText(s.goal, regexes), 160)}`);
      else lines.push(`  Ask: ${s.ask ? clip(redactText(s.ask, regexes)) : '(not captured)'}`);
      if (s.summary) lines.push(`  Did: ${clip(redactText(plainText(s.summary), regexes), 400)}`);
      const notes = [s.decisions, s.gotchas].filter(Boolean).join(' · ');
      if (notes) lines.push(`  Notes: ${clip(redactText(plainText(notes), regexes), 240)}`);
      if (s.todos) {
        const t = todoCounts(s.todos);
        lines.push(`  Tasks: ${t.done}/${t.total} done`);
      }
      if (s.changes && s.changes.length) lines.push(`  Changes: ${clip(redactText(formatChanges(s.changes), regexes), 300)}`);
      else if (s.files.length) lines.push(`  Files: ${s.files.map(f => f.file).join(', ')}`);
      else if (s.outsideOnly) lines.push('  Files: (outside project)');
```

- [ ] **Step 5: Update the teammate-section render (`lib/digest.js:313-318`)**

The teammate loop currently prints `ask` + `Result:`. Make it consistent — replace lines 313-318 with:

```js
    for (const e of team) {
      const intent = e.goal ? clip(redactText(e.goal, regexes), 160) : (e.ask ? clip(redactText(e.ask, regexes)) : '(prompt not shared)');
      lines.push(`- ${shortDate(e.ts)} · ${e.author} · ${e.source}: ${intent}`);
      if (e.summary) lines.push(`  Did: ${clip(redactText(plainText(e.summary), regexes), 400)}`);
      if (e.changes && e.changes.length) lines.push(`  Changes: ${clip(redactText(formatChanges(e.changes), regexes), 300)}`);
      else if (e.files && e.files.length) lines.push(`  Changes: ${e.files.slice(0, 5).join(', ')}`);
    }
```

(`e.goal`/`e.changes` arrive via Task 6's pull; absent for legacy rows → falls back cleanly.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test 2>&1 | grep "renderBlock: shows Intent"`
Expected: `ok`. Also run the full `npm test` and confirm no previously-green block/render checks regressed (the label changed `Result:`→`Did:` — update any existing assertion that greps `Result:`).

- [ ] **Step 7: Commit**

```bash
git add lib/digest.js test/run-tests.js
git commit -m "feat: injected block renders Intent/Did/Notes/Changes, no blob truncation"
```

---

## Task 5: Thread fields into the dashboard feed

**Files:**
- Modify: `lib/memorydb.js` — `buildEntries` (135-140 summary attach)
- Modify: `lib/feed.js` — `normalizeLocal` (19-40), `normalizeTeam` (42-63)
- Modify: `lib/server.js` — `feedPayload` (~124), `projectDetail` (341-348)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
check('feed: local entry carries goal + changes', () => {
  const proj = { events: [
    { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'mcp thing' },
    { ts: '2026-07-16T00:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 's1', file: path.join(proj1, 'src', 'login.js') },
    { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
      text: 'Did the thing.', goal: 'Ship MCP', decisions: 'read-only', gotchas: '', highlights: [] },
  ] };
  const entries = memorydb.buildEntries(proj1, proj, {});
  const withSummary = entries.find(e => e.summary);
  assert.strictEqual(withSummary.goal, 'Ship MCP');
  assert.strictEqual(withSummary.decisions, 'read-only');
  assert.ok(Array.isArray(withSummary.changes), 'changes array attached');
  const norm = require('../lib/feed').normalizeLocal(withSummary, { projectName: 'p' });
  assert.strictEqual(norm.goal, 'Ship MCP');
  assert.ok(Array.isArray(norm.changes));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "feed: local entry carries"`
Expected: `FAIL` — `withSummary.goal` undefined.

- [ ] **Step 3: Attach fields in `buildEntries` (`lib/memorydb.js:135-140`)**

Replace the `for (const [entry, evs] of summariesFor) { … }` loop with:

```js
  for (const [entry, evs] of summariesFor) {
    const best = digest.pickSummary(evs);
    if (!best) continue;
    entry.summary = clipSummary(best.text, 300);
    if (best.goal) entry.goal = clipSummary(best.goal, 160);
    if (best.decisions) entry.decisions = clipSummary(best.decisions, 240);
    if (best.gotchas) entry.gotchas = clipSummary(best.gotchas, 240);
    entry.changes = require('./changes').deriveChanges(projectPath, entry.files, best.highlights || []);
    if (best.source === 'Distilled') entry.distilled = true;
  }
```

Also, where sibling entries are cleared (the `delete entry.summary` block ~159), add `delete entry.goal; delete entry.decisions; delete entry.gotchas; delete entry.changes;` alongside so stale copies don't linger.

- [ ] **Step 4: Pass through in `feed.js`**

In `normalizeLocal` (before `cursor: null`) add:
```js
    goal: applyRedact(redact, e.goal) || null,
    decisions: applyRedact(redact, e.decisions) || null,
    gotchas: applyRedact(redact, e.gotchas) || null,
    changes: Array.isArray(e.changes) ? e.changes.slice() : [],
```
In `normalizeTeam` (before `cursor:`) add the same four, sourced from `row`:
```js
    goal: applyRedact(redact, row.goal) || null,
    decisions: null,
    gotchas: null,
    changes: Array.isArray(row.changes) ? row.changes.slice() : (Array.isArray(row.files) && row.files.length && typeof row.files[0] === 'object' ? row.files.slice() : []),
```
(Team rows ship the change model inside `files` — see Task 6; a legacy string `files` array yields `changes: []`.)

- [ ] **Step 5: Redact/pass in `server.js`**

In `projectDetail` (341-348), the entries are mapped through redaction — extend that map to also redact `goal`/`decisions`/`gotchas` and pass `changes` untouched (paths already relative, no free text beyond `note`). Add to the mapped object:
```js
      goal: e.goal ? digest.redactText(e.goal, rx) : e.goal,
      decisions: e.decisions ? digest.redactText(e.decisions, rx) : e.decisions,
      gotchas: e.gotchas ? digest.redactText(e.gotchas, rx) : e.gotchas,
      changes: Array.isArray(e.changes) ? e.changes.map(c => ({ ...c, note: c.note ? digest.redactText(c.note, rx) : c.note })) : [],
```
`feedPayload` already calls `feed.normalizeLocal`, which now carries the fields — no change needed there beyond confirming the redact closure is passed in `meta` (it is).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test 2>&1 | grep "feed: local entry carries"`
Expected: `ok`. Run full `npm test` — confirm existing feed/projectDetail checks still pass.

- [ ] **Step 7: Commit**

```bash
git add lib/memorydb.js lib/feed.js lib/server.js test/run-tests.js
git commit -m "feat: thread goal/decisions/gotchas/changes into the dashboard feed"
```

---

## Task 6: Team sync — ship `goal` (gated) + change model

**Files:**
- Modify: `lib/teamsync.js` — `pushProject` (432-458), `pullProject` (467-492)
- Test: `test/run-tests.js` (uses `createMockSupabase`)

- [ ] **Step 1: Write the failing test**

Model it on the existing team push/pull test (search `test/run-tests.js` for `createMockSupabase`). Assert that:
```js
check('teamsync: goal gated by sharePrompts; change model ships in files', () => {
  // with sharePrompts:false the pushed row.goal is null; row.files carries objects
  //   {file,status,...}. With sharePrompts:true, row.goal is the clipped goal.
  // (Build a proj with a distilled summary entry, run pushProject against the
  //  mock, inspect captured rows; then pullProject and assert entry.goal/.changes.)
});
```
Fill this in against the mock's captured-rows API exactly as the existing team test does.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "teamsync: goal gated"`
Expected: `FAIL`.

- [ ] **Step 3: Push `goal` + change model (`lib/teamsync.js:432-442`)**

Extend the row map:
```js
    const rows = entries.slice(i, i + PUSH_BATCH).map(e => ({
      project_id: link.projectId,
      author_id: creds.userId,
      author_name: creds.displayName,
      ts: e.ts,
      source: e.source,
      session: e.session || null,
      ask: share ? scrub(e.ask, 400) : null,
      goal: share ? scrub(e.goal, 200) : null,
      files: Array.isArray(e.changes) && e.changes.length
        ? e.changes.map(c => ({ ...c, note: scrub(c.note, 80) }))
        : e.files,
      summary: e.summary ? scrub(e.summary, 300) : null,
    }));
```

- [ ] **Step 4: Add a `goal`-column graceful fallback (`lib/teamsync.js:448-458`)**

Generalize the existing `summary`-column catch so an older backend missing the `goal` column also survives:
```js
    } catch (err) {
      const drop = /'summary' column/i.test(err.message) ? 'summary'
        : /'goal' column/i.test(err.message) ? 'goal' : null;
      if (!drop) throw err;
      await rest(config, creds, 'POST',
        'memory_entries?on_conflict=project_id,author_id,ts,source',
        rows.map(({ [drop]: _omit, ...bare }) => bare),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
```

- [ ] **Step 5: Pull `goal` back (`lib/teamsync.js:467-492`)**

Add `goal` to the `select` list (line 471):
```js
    '&select=author_name,ts,source,session,ask,goal,summary,files,created_at';
```
and to the pushed entry (after `ask: r.ask,`):
```js
      goal: r.goal || null,
```
`files` already flows through as-is; when it holds change objects, `feed.normalizeTeam` (Task 5) reads them as `changes`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test 2>&1 | grep "teamsync:"`
Expected: `ok`. Run full `npm test`.

- [ ] **Step 7: Commit**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat: team sync ships gated goal + change model, with column fallback"
```

---

## Task 7: Dashboard feed card — render Intent / Outcome / Changes

**Files:**
- Modify: `lib/dashboard.js` — the feed-entry card renderer (CSS block starts ~251; card HTML builder emits `.fsummary`)
- Test: manual/visual (client render isn't covered by the node harness) + a payload smoke check

- [ ] **Step 1: Locate the card builder**

Run: `grep -n "fsummary\|dayGroupHtml\|function .*[Ee]ntry" lib/dashboard.js` to find the function that turns one feed entry into HTML (it consumes `e.ask`, `e.summary`, `e.files`). That function now also receives `e.goal`, `e.decisions`, `e.gotchas`, `e.changes`.

- [ ] **Step 2: Add the render (inside that builder)**

Emit three labelled rows when the fields are present. Insert alongside the existing `.fsummary` markup (keep `esc()` on all free text; reuse existing class names where possible):

```js
    // Intent
    (e.goal ? '<div class="fmeta-row"><span class="flabel">Intent</span> ' + esc(e.goal) + '</div>' : '') +
    // Outcome (existing summary) + decisions/gotchas subline
    (e.summary ? '<div class="fsummary">' + esc(e.summary) + '</div>' : '') +
    ((e.decisions || e.gotchas) ? '<div class="fsub">' + esc([e.decisions, e.gotchas].filter(Boolean).join(' · ')) + '</div>' : '') +
    // Changes
    (Array.isArray(e.changes) && e.changes.length ? changesHtml(e.changes) : filesHtml(e.files))
```

Add a `changesHtml` helper in the same client script (icons/dimming per the approved mockup `redesign-v1.html`):
```js
function changesHtml(changes) {
  var icon = { new: '🆕', edited: '✏️', deleted: '🗑️' };
  var rows = changes.map(function (c) {
    var counts = (c.add != null || c.del != null) ? ' <span class="fcount">+' + (c.add||0) + ' −' + (c.del||0) + '</span>' : '';
    var note = c.note ? ' <span class="fnote">— ' + esc(c.note) + '</span>' : '';
    var cls = c.dep ? ' fdep' : '';
    return '<div class="fchange' + cls + '">' + (c.dep ? '📦' : (icon[c.status] || '✏️')) + ' <code>' + esc(c.file) + '</code>' + (c.dep ? ' <span class="fnote">(deps)</span>' : counts + note) + '</div>';
  });
  return '<div class="fchanges">' + rows.join('') + '</div>';
}
```
Add matching CSS near the `.fsummary` block (line ~262): `.flabel`, `.fsub`, `.fchanges`, `.fchange`, `.fdep{opacity:.5}`, `.fcount`, `.fnote{color:var(--text3)}` — mirroring existing feed typography.

- [ ] **Step 3: Verify the payload smoke check**

The node-level guarantee is Task 5's test (payload carries `goal`/`changes`). Add one more assert that `feedPayload` output includes them end-to-end:
```js
check('feedPayload: entries expose goal + changes', async () => {
  const p = await feedPayload({ limit: 10 });
  // find any entry with a summary and assert the keys exist (may be null/[])
  const e = (p.entries || [])[0];
  if (e) { assert.ok('goal' in e, 'goal key present'); assert.ok('changes' in e, 'changes key present'); }
});
```

- [ ] **Step 4: Build and eyeball**

Run: `npm test` (all green) then rebuild the app per the project convention and open the feed:
```bash
node scripts/prepare-app.js && npm run app
```
Confirm a distilled entry shows Intent, Outcome (+ decisions subline), and the Changes list with dimmed deps and tagged key files. Compare against `redesign-v1.html`.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "feat: dashboard feed card renders Intent/Outcome/Changes"
```

---

## Self-review (completed)

- **Spec coverage:** A1→T2, A2→T3, A3→T4(sessionGroups)+T5(buildEntries), A4→T1, A5→T4(block)+T7(card), A6→T6, A7→graceful defaults across T4/T5/T7 (all fields optional; harvested sessions render `Did`+`Changes` only). ✓
- **Placeholders:** Task 6 Step 1 leaves the mock-supabase assertions to be filled against the existing team test's captured-rows API (the one place the exact mock shape must be read live) — every other step has concrete code. Flagged, not hidden.
- **Type consistency:** `deriveChanges(projectPath, files, highlights, opts)` and the Change-model keys (`file/status/add/del/note/dep`) are identical in Tasks 1, 4, 5, 6, 7; summary-event keys (`text/goal/decisions/gotchas/highlights`) identical in Tasks 3, 4, 5. `formatChanges` (block) vs `changesHtml` (card) are intentionally distinct renderers of the same model. ✓

## Verification (whole feature)

- `npm test` green (existing 204 + new checks).
- Injected `CLAUDE.md` block for a distilled session shows `Intent`/`Did`/`Notes`/`Changes`, no `…` truncation, no `Result:`.
- Dashboard feed card matches `redesign-v1.html`.
- Team round-trip: `goal` withheld when `sharePrompts:false`, present when true; change model survives push→pull; legacy string-array `files` still renders.
```
