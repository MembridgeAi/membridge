# Suppress Ops Noise, Distill the Substance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rendering/sharing zero-edit "ops" sessions (browser, ad-gen, tool wrangling) while distilling substantive zero-edit sessions (diagnoses, decisions) so they render as a clean one-liner instead of raw harvest.

**Architecture:** A single pure predicate module (`lib/classify.js`) decides whether a session's work is worth sharing (`hasEdit || hasDistilled`). Five existing surfaces call it: the feed assembly and team push (both via `memorydb.buildEntries`), the CLAUDE.md block builder (`digest.sessionGroups`), and the two inbound teammate paths (`feed.buildFeed`, `digest.teamInjectSlice`). A new zero-edit branch in the Stop hook (`hooks.runStop`) asks the agent to distill-or-skip when a no-edit session crosses a prompt-count floor.

**Tech Stack:** Node.js (CommonJS), no framework. Custom test runner at `test/run-tests.js` invoked with `npm test` (uses `check('name', () => { ...assert... })` and `node:assert`). Hook is exercised via `spawnSync(process.execPath, [BIN, 'hook', 'stop'], { input: JSON })`.

## Global Constraints

- Node CommonJS modules; match surrounding style (2-space indent, `var`/`const` as the file already uses, no TypeScript).
- Distilled summary events are identified by `source === 'Distilled'` (raw local summary events carry NO `distilled` field). Team rows carry `distilled: !!row.distilled`.
- Event kinds in `proj.events`: `'prompt'`, `'edit'`, `'summary'`, `'todos'`. Each event has `session` (string, may be `''`) and `source`.
- `runStop` and all render/push filters MUST fail open: never throw, never trap a session. On malformed input a session is treated as **not shareable** (omitted), and the hook returns (allows the stop).
- Config default lives in `lib/util.js` `DEFAULT_CONFIG.distill` (currently `{ enabled: true, minEdits: 1, checkpointEvery: 4, consent: null }`).
- Run the FULL suite (`npm test`) at the end of every task, not just the new test — these filters change shared render paths and a pre-existing assertion that encoded the old "show harvested zero-edit session" behavior must be updated to the new expectation, not worked around.
- Commit after every task. Branch: `feat/suppress-ops-noise`.

---

### Task 1: `lib/classify.js` — the shareability predicate

**Files:**
- Create: `lib/classify.js`
- Test: `test/run-tests.js` (new `check` block; see Step 1 for placement)

**Interfaces:**
- Produces:
  - `shareableSessions(events: Array<Event>) -> Set<string>` — session ids (keyed by `e.session || ''`) that have ≥1 `edit` event OR ≥1 distilled `summary` event (`source === 'Distilled'`).
  - `isShareableLocal(events: Array<Event>, sessionId: string) -> boolean`
  - `isShareableTeam(entry: {distilled?: boolean}) -> boolean` — `!!entry.distilled`
  - `filterShareableEntries(entries: Array<{session?: string}>, events: Array<Event>) -> Array` — keeps entries whose `(entry.session || '')` is in `shareableSessions(events)`.
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing test**

Add near the other pure-unit blocks in `test/run-tests.js` (e.g. just after the `digest.pickSummary` block around line 4266, or any top-level `check` region). Insert:

```js
check('classify: shareableSessions keys on edit OR distilled summary', () => {
  const classify = require('../lib/classify');
  const events = [
    { kind: 'prompt', session: 'ops', source: 'Claude Code', text: 'open the browser' },
    { kind: 'prompt', session: 'ops', source: 'Claude Code', text: 'try again' },
    { kind: 'summary', session: 'ops', source: 'Claude Code', text: 'the tab is open now' }, // harvested
    { kind: 'prompt', session: 'edited', source: 'Claude Code', text: 'fix the bug' },
    { kind: 'edit', session: 'edited', source: 'Claude Code', file: '/p/a.js' },
    { kind: 'prompt', session: 'diag', source: 'Claude Code', text: 'why is x failing' },
    { kind: 'summary', session: 'diag', source: 'Distilled', text: 'root cause was the gate' },
  ];
  const set = classify.shareableSessions(events);
  assert.ok(!set.has('ops'), 'harvested zero-edit session must not be shareable');
  assert.ok(set.has('edited'), 'edit session must be shareable');
  assert.ok(set.has('diag'), 'distilled zero-edit session must be shareable');
  assert.strictEqual(classify.isShareableLocal(events, 'ops'), false);
  assert.strictEqual(classify.isShareableLocal(events, 'edited'), true);
  assert.strictEqual(classify.isShareableTeam({ distilled: true }), true);
  assert.strictEqual(classify.isShareableTeam({ distilled: false }), false);
  assert.strictEqual(classify.isShareableTeam({}), false);
  const filtered = classify.filterShareableEntries(
    [{ session: 'ops' }, { session: 'edited' }, { session: 'diag' }], events);
  assert.deepStrictEqual(filtered.map(e => e.session), ['edited', 'diag']);
  // Fail-open: garbage never throws
  assert.deepStrictEqual([...classify.shareableSessions(null)], []);
  assert.strictEqual(classify.isShareableLocal(null, 'x'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -i classify`
Expected: FAIL — `Cannot find module '../lib/classify'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/classify.js`:

```js
'use strict';
// Shareability: is a session's work worth putting in the feed, the CLAUDE.md
// block, the team push, and inbound rendering? The discriminator is substance
// vs. operations, not edits vs. no edits — a session qualifies if it changed a
// file OR produced a distilled summary. A zero-edit session whose only summary
// is a harvested last-message (source !== 'Distilled') is ops noise and is
// omitted everywhere. Pure functions over event arrays; every function fails
// open toward "not shareable" on malformed input and never throws.

// Distilled local summary events are marked by source === 'Distilled' (raw
// events carry no `distilled` field); the `e.distilled` check is defensive.
function isDistilledSummary(e) {
  return !!e && e.kind === 'summary' && (e.source === 'Distilled' || e.distilled === true);
}

function shareableSessions(events) {
  const set = new Set();
  if (!Array.isArray(events)) return set;
  for (const e of events) {
    if (!e) continue;
    if (e.kind === 'edit' || isDistilledSummary(e)) set.add(e.session || '');
  }
  return set;
}

function isShareableLocal(events, sessionId) {
  return shareableSessions(events).has(sessionId || '');
}

function isShareableTeam(entry) {
  return !!(entry && entry.distilled);
}

function filterShareableEntries(entries, events) {
  if (!Array.isArray(entries)) return [];
  const set = shareableSessions(events);
  return entries.filter(e => set.has((e && e.session) || ''));
}

module.exports = { shareableSessions, isShareableLocal, isShareableTeam, filterShareableEntries };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -i classify`
Expected: `ok    classify: shareableSessions keys on edit OR distilled summary`

- [ ] **Step 5: Commit**

```bash
git add lib/classify.js test/run-tests.js
git commit -m "feat(classify): shareability predicate for ops-noise suppression"
```

---

### Task 2: Distill trigger — zero-edit branch in the Stop hook

**Files:**
- Modify: `lib/util.js` (DEFAULT_CONFIG.distill — add `minPromptsZeroEdit`)
- Modify: `lib/hooks.js` (`blockReason` gains a `zeroEdit` flag; `runStop` gains the zero-edit branch)
- Test: `test/run-tests.js` (new fixture + checks in the section-10 distill block)

**Interfaces:**
- Consumes: `config.distill.minPromptsZeroEdit` (number, default 3).
- Produces: no new exports. Behavior change only:
  - A session with `edits === 0` and `promptCount >= minPromptsZeroEdit` and no summary line yet → hook emits `{ decision: 'block', reason: <skip-aware> }`.
  - The skip-aware reason contains the substring `only tool operations` and the same append command as the edit-session reason.

- [ ] **Step 1: Write the failing tests**

In `test/run-tests.js`, in the section-10 distill setup, add a zero-edit fixture next to `sessShort.jsonl` (the `sessShort`/`sessR` fixtures are written around line 3978-3991). After the `sessShort.jsonl` write, add:

```js
  // Zero-edit but substantive: 3 user prompts, no Edit tool_use. Exercises the
  // zero-edit distill branch (prompt-count floor + skip-aware block).
  fs.writeFileSync(path.join(rDir, 'sessDiag.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Why do teammate cards render empty?' }, cwd: projR, timestamp: '2026-07-12T09:12:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'Check the distilled flag path' }, cwd: projR, timestamp: '2026-07-12T09:13:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'Confirm it is a workload gap not a version gap' }, cwd: projR, timestamp: '2026-07-12T09:14:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It is a workload gap.' }] }, cwd: projR, timestamp: '2026-07-12T09:15:00.000Z' },
  ]));
```

Then add checks next to the existing `distill: worthiness gate — a session with no edits is not blocked` check (around line 4283). Note: that existing check uses `sessShort`, which has ONE prompt — keep it; it now doubly documents the floor. Add:

```js
  check('distill: zero-edit session with >= floor prompts blocks with a skip-aware reason', () => {
    const out = runHook(stopPayload('sessDiag'));
    assert.strictEqual(out.status, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.strictEqual(parsed.decision, 'block', 'substantive zero-edit session should block');
    assert.ok(parsed.reason.includes('only tool operations'), 'zero-edit reason lacks the skip option');
    assert.ok(parsed.reason.includes('"session":"sessDiag"'), 'reason lacks the session id');
    assert.ok(parsed.reason.includes('append'), 'reason lacks the append command');
  });
  check('distill: zero-edit session below the prompt floor is not blocked', () => {
    // sessShort has a single user prompt (< default floor of 3) and no edits.
    const out = runHook(stopPayload('sessShort'));
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stdout, '', 'below-floor zero-edit session must not block');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -i 'zero-edit'`
Expected: FAIL — `sessDiag` currently returns empty stdout (no block), so the first new check fails on `parsed.decision`.

- [ ] **Step 3a: Add the config default**

In `lib/util.js`, change the `distill` line in `DEFAULT_CONFIG` (currently line ~70):

```js
  distill: { enabled: true, minEdits: 1, checkpointEvery: 4, minPromptsZeroEdit: 3, consent: null },
```

Update the adjacent comment (lines ~66-69) to add one line:

```js
  // minEdits is how many edit events a session needs before the first summary
  // is asked for on stop; checkpointEvery re-asks once every that-many further
  // edits. minPromptsZeroEdit lets a session that changed NO files still earn a
  // summary turn once it has at least that many user prompts — the agent is
  // told it may skip if the session was only tool operations.
```

- [ ] **Step 3b: Add the `zeroEdit` flag to `blockReason`**

In `lib/hooks.js`, change the `blockReason` signature and its lead sentence (function starts ~line 83). Replace the first `return 'MemBridge session distillation: ...'` lead line with a branch. The full function becomes:

```js
function blockReason(target, sessionId, n, zeroEdit) {
  const scope = n > 0
    ? `summarize the whole session so far — this line supersedes the ${n} earlier line${n === 1 ? '' : 's'} already written for this session (never modify existing lines; just append)`
    : 'summarize the whole session so far';
  const lead = zeroEdit
    ? 'MemBridge session distillation: if this session produced something worth sharing with the user\'s teammates and their AI tools — a diagnosis, a decision, a plan, or a conclusion — save it so a teammate who was not here understands what was done and why. If it was only tool operations with nothing worth sharing, do nothing and just stop — do not append. To save, run exactly ONE command — '
    : 'MemBridge session distillation: MemBridge shares this summary with the user\'s teammates and their AI tools — every field is read by a team member who was not in this session and needs to understand what was done and why. Before stopping, save the summary by running exactly ONE command — ';
  return lead +
    'no commentary before or after it, and do not restate the summary in your reply: ' +
    `${hookCommand()} append ${quoteArg(target)} '<json>' ` +
    `where <json> is ONE line: {"session":"${sessionId}","ts":"<current UTC time, ISO-8601>","goal":"...","did":"...","headline":"...","decisions":"...","gotchas":"...","highlights":[{"file":"<path>","note":"..."}]} ` +
    'Pass the JSON as a single shell argument inside the single quotes; if any value contains an apostrophe, escape it for the shell as ' + String.raw`'\''` + ' (the command fails loudly if mis-quoted, so fix the quoting and re-run). ' +
    '— goal: 1 short line on what the user asked for — the intent behind the session, so a teammate knows why this work happened; ' +
    `did: 1-3 plain-text sentences that ${scope}, phrased as what changed in the project from a teammate's point of view (the outcome), never a list of files edited or tools run; ` +
    `headline: the single outcome a teammate reads at a glance, at most ${HEADLINE_MAX} characters — it renders verbatim on a card that never truncates, so put anything longer in did, or ""; ` +
    'decisions: choices made and why — the reasoning a teammate would need before building on or questioning this work, or ""; ' +
    'gotchas: surprises or pitfalls hit, written so a teammate does not hit them again, or ""; ' +
    'highlights: up to 2 of the most important files with a short note each on why they matter, or []. ' +
    'Write for a teammate catching up on what was done and why — plain language, no markdown, nothing they do not need. Then stop again.';
}
```

- [ ] **Step 3c: Add the zero-edit branch in `runStop`**

In `lib/hooks.js` `runStop`, replace the worthiness-gate + staleness-checkpoint tail (the block from `const minEdits = ...` through the final `process.stdout.write(...)`, currently lines ~193-208) with:

```js
    const minEdits = Number.isFinite(distill.minEdits) ? distill.minEdits : 1;
    const events = state.projects[key].events || [];
    const edits = events.filter(e => e && e.kind === 'edit' && e.session === sessionId).length;
    const n = countSummaryLines(key, sessionId);

    if (edits >= minEdits) {
      // Edit session: staleness checkpoint — re-block once every checkpointEvery
      // edits past the first. n = checkpoints already on disk.
      const every = Number.isFinite(distill.checkpointEvery) && distill.checkpointEvery >= 1
        ? distill.checkpointEvery : 4;
      if (edits < minEdits + n * every) return;
      process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(summariesPath(key), sessionId, n, false) }) + '\n');
      return;
    }

    if (edits === 0) {
      // Zero-edit session: worth a summary turn only if it has real back-and-forth
      // (prompt-count floor) and has not already been summarized once. The agent is
      // told it may skip pure tool-operation sessions, so an over-inclusive floor is
      // self-correcting — the block just offers the option, it does not force a write.
      if (n > 0) return; // already distilled once; never re-block a zero-edit session
      const floor = Number.isFinite(distill.minPromptsZeroEdit) ? distill.minPromptsZeroEdit : 3;
      const prompts = events.filter(e => e && e.kind === 'prompt' && e.session === sessionId).length;
      if (prompts < floor) return;
      process.stdout.write(JSON.stringify({ decision: 'block', reason: blockReason(summariesPath(key), sessionId, n, true) }) + '\n');
      return;
    }

    // 1..minEdits-1 edits (only reachable when minEdits > 1): below the edit
    // threshold and not a zero-edit session — unchanged behavior, no block.
    return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -iE 'zero-edit|worthiness|blocks with exact'`
Expected: the two new `zero-edit` checks PASS, and the existing `distill: hook stop blocks with exact decision/reason JSON` (edit path, `sessR`) still PASSES.

- [ ] **Step 5: Run the full suite and reconcile**

Run: `npm test 2>&1 | tail -5`
Expected: all checks pass. The edit-path reason is unchanged (the `false` flag preserves the exact old string), so existing reason-substring assertions still hold.

- [ ] **Step 6: Commit**

```bash
git add lib/util.js lib/hooks.js test/run-tests.js
git commit -m "feat(distill): distill substantive zero-edit sessions with a skip-aware block"
```

---

### Task 3: Filter the feed and the team push (local sessions)

**Files:**
- Modify: `lib/server.js` (`feedPayload` local loop, ~line 145-149)
- Modify: `lib/teamsync.js` (`pushProject`, ~line 738-740)
- Test: `test/run-tests.js` (new `check` block, in-process)

**Interfaces:**
- Consumes: `classify.filterShareableEntries` (Task 1), `memorydb.buildEntries`.
- Produces: no new exports. The feed's `local` array and the push `entries` array no longer contain entries from non-shareable sessions.

- [ ] **Step 1: Write the failing test**

Add a `check` block in `test/run-tests.js` near the existing `memorydb.buildEntries` usage (there is one around line 3879; place this after it or in any in-process region that already `require`s `memorydb`):

```js
check('feed/push: buildEntries source filters out zero-edit harvested sessions', () => {
  const classify = require('../lib/classify');
  const proj = { events: [
    { ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'ops', text: 'open browser' },
    { ts: '2026-07-20T09:01:00.000Z', source: 'Claude Code', kind: 'summary', session: 'ops', text: 'the tab is open' }, // harvested, no edit
    { ts: '2026-07-20T09:02:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'code', text: 'fix bug' },
    { ts: '2026-07-20T09:03:00.000Z', source: 'Claude Code', kind: 'edit', session: 'code', file: '/proj/lib/a.js' },
    { ts: '2026-07-20T09:04:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'diag', text: 'why failing' },
    { ts: '2026-07-20T09:05:00.000Z', source: 'Distilled', kind: 'summary', session: 'diag', text: 'root cause found' },
  ] };
  const all = memorydb.buildEntries('/proj', proj, util.getConfig());
  const kept = classify.filterShareableEntries(all, proj.events);
  const sessions = new Set(kept.map(e => e.session));
  assert.ok(!sessions.has('ops'), 'ops-noise session leaked into the feed/push source');
  assert.ok(sessions.has('code'), 'edit session missing from feed/push source');
  assert.ok(sessions.has('diag'), 'distilled diagnosis missing from feed/push source');
});
```

- [ ] **Step 2: Run test to verify it passes on the helper, then confirm the wiring gap**

Run: `npm test 2>&1 | grep -i 'buildEntries source filters'`
Expected: PASS — this is a guard on the exact expression the call sites will use (`filterShareableEntries(buildEntries(...), proj.events)`), which already works once Task 1 landed. It is NOT a RED-first test; it locks the contract. The wiring itself is verified in Step 4 by grep + full suite:

Run: `grep -n "filterShareableEntries" lib/server.js lib/teamsync.js`
Expected before Step 3: NO matches (the call sites are not wired yet — that is the real gap this task closes).

- [ ] **Step 3: Wire the feed and push call sites**

In `lib/server.js`, add the require near the other lib requires at the top of the file (find the block with `const teamsync = require('./teamsync');` / `const memorydb = require('./memorydb');` and add):

```js
const classify = require('./classify');
```

Then in `feedPayload`, change the local loop (currently):

```js
    for (const e of memorydb.buildEntries(key, proj, config)) {
      local.push(feed.normalizeLocal({ ...e, shared: teamsync.isShared(config, proj, e.session) }, meta));
    }
```

to:

```js
    for (const e of classify.filterShareableEntries(memorydb.buildEntries(key, proj, config), proj.events)) {
      local.push(feed.normalizeLocal({ ...e, shared: teamsync.isShared(config, proj, e.session) }, meta));
    }
```

In `lib/teamsync.js`, add near the top requires (find `const memorydb = require('./memorydb');`):

```js
const classify = require('./classify');
```

Then in `pushProject` (~line 738), change:

```js
  const entries = memorydb.buildEntries(projectPath, proj, config)
    .filter(e => e.ts > cursor);
```

to:

```js
  const entries = classify.filterShareableEntries(memorydb.buildEntries(projectPath, proj, config), proj.events)
    .filter(e => e.ts > cursor);
```

Also in `teamsync.js` around line 924 (the reshare path `const rowsSrc = memorydb.buildEntries(projectPath, proj, config).filter(e => (e.session || null) === sessionId);`), change to:

```js
  const rowsSrc = classify.filterShareableEntries(memorydb.buildEntries(projectPath, proj, config), proj.events)
    .filter(e => (e.session || null) === sessionId);
```

- [ ] **Step 4: Confirm the wiring and run the full suite**

Run: `grep -n "filterShareableEntries" lib/server.js lib/teamsync.js`
Expected: three matches (feed loop, pushProject, reshare path).
Run: `npm test 2>&1 | grep -i 'buildEntries source filters'` → PASS
Run: `npm test 2>&1 | tail -5`
Expected: all pass. If a pre-existing feed/push test now fails because it asserted a zero-edit harvested session appears, update that assertion — it encodes the behavior we are intentionally removing. Likely candidates use single-prompt harvested fixtures (e.g. `sessNoAsk`); re-read the failing assertion and flip it to expect suppression.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js lib/teamsync.js test/run-tests.js
git commit -m "feat(feed): suppress ops-noise sessions from the feed and team push"
```

---

### Task 4: Filter the CLAUDE.md context block (local sessions)

**Files:**
- Modify: `lib/digest.js` (`sessionGroups`, ~line 189-233)
- Test: `test/run-tests.js` (new `check` block, in-process)

**Interfaces:**
- Consumes: `classify.isShareableLocal` (Task 1). `sessionGroups` already groups events per session.
- Produces: `sessionGroups` no longer returns non-shareable session groups, so `renderBlock`'s "Recent asks" list omits them.

- [ ] **Step 1: Write the failing test**

```js
check('block: sessionGroups drops zero-edit harvested sessions, keeps edits and distilled', () => {
  const proj = { events: [
    { ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'ops', text: 'open browser' },
    { ts: '2026-07-20T09:01:00.000Z', source: 'Claude Code', kind: 'summary', session: 'ops', text: 'the tab is open now' },
    { ts: '2026-07-20T09:02:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'code', text: 'fix bug' },
    { ts: '2026-07-20T09:03:00.000Z', source: 'Claude Code', kind: 'edit', session: 'code', file: '/proj/lib/a.js' },
    { ts: '2026-07-20T09:04:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'diag', text: 'why failing' },
    { ts: '2026-07-20T09:05:00.000Z', source: 'Distilled', kind: 'summary', session: 'diag', text: 'root cause found' },
  ] };
  const groups = digest.sessionGroups('/proj', proj, util.getConfig());
  const sessions = new Set(groups.map(g => (g.prompts[0] && g.prompts[0].text) || ''));
  assert.ok(!sessions.has('open browser'), 'ops-noise session leaked into the context block');
  assert.ok(sessions.has('fix bug'), 'edit session missing from the context block');
  assert.ok(sessions.has('why failing'), 'distilled diagnosis missing from the context block');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -i 'sessionGroups drops'`
Expected: FAIL — `sessions.has('open browser')` is true (ops session still present).

- [ ] **Step 3: Wire the filter**

In `lib/digest.js`, add the require near the top (find the existing requires such as `const { deriveChanges } = require('./changes');`):

```js
const classify = require('./classify');
```

In `sessionGroups`, the return currently maps every group. Insert a `.filter` on the grouped list before `.slice(-maxSessions)`. Change:

```js
  return [...bySession.values()]
    .sort((a, b) => String(a[a.length - 1].ts).localeCompare(String(b[b.length - 1].ts)))
    .slice(-maxSessions)
    .map(events => {
```

to:

```js
  return [...bySession.values()]
    // Ops-noise suppression: a group with no edit and no distilled summary is
    // not worth a teammate's attention — drop it before the recency slice so a
    // quiet coding history is not crowded out by tool-operation sessions.
    .filter(events => classify.isShareableLocal(events, (events[0] && events[0].session) || ''))
    .sort((a, b) => String(a[a.length - 1].ts).localeCompare(String(b[b.length - 1].ts)))
    .slice(-maxSessions)
    .map(events => {
```

- [ ] **Step 4: Run the test and full suite**

Run: `npm test 2>&1 | grep -i 'sessionGroups drops'` → PASS
Run: `npm test 2>&1 | tail -5`
Expected: all pass. If a pre-existing block-render test fails because it asserted a harvested zero-edit session appears in "Recent asks", flip that assertion to expect suppression.

- [ ] **Step 5: Commit**

```bash
git add lib/digest.js test/run-tests.js
git commit -m "feat(block): suppress ops-noise sessions from the CLAUDE.md context block"
```

---

### Task 5: Filter inbound teammate data

**Files:**
- Modify: `lib/feed.js` (`buildFeed`, ~line 115-140)
- Modify: `lib/digest.js` (`teamInjectSlice`, ~line 274-290)
- Test: `test/run-tests.js` (new `check` block, in-process)

**Interfaces:**
- Consumes: `classify.isShareableTeam` (Task 1). Team entries carry `distilled: boolean`.
- Produces: `buildFeed` drops non-distilled team entries before merging; `teamInjectSlice` returns only distilled teammate entries.

- [ ] **Step 1: Write the failing tests**

```js
check('inbound: buildFeed drops non-distilled teammate rows, keeps distilled', () => {
  const feed = require('../lib/feed');
  const team = [
    { origin: 'team', ts: '2026-07-20T09:00:00.000Z', self: false, author: 'A', session: 't1', project: 'P', ask: 'x', summary: 'harvested tail', distilled: false },
    { origin: 'team', ts: '2026-07-20T09:01:00.000Z', self: false, author: 'A', session: 't2', project: 'P', ask: 'y', summary: 'clean brief', distilled: true },
  ];
  const out = feed.buildFeed({ local: [], team, limit: 50 });
  const sessions = out.entries.map(e => e.session);
  assert.ok(!sessions.includes('t1'), 'non-distilled teammate row leaked into the feed');
  assert.ok(sessions.includes('t2'), 'distilled teammate row missing from the feed');
});

check('inbound: teamInjectSlice returns only distilled teammate entries', () => {
  const entries = [
    { author: 'A', session: 't1', source: 'Claude Code', ts: '2026-07-20T09:00:00.000Z', summary: 'harvested', distilled: false },
    { author: 'A', session: 't2', source: 'Claude Code', ts: '2026-07-20T09:01:00.000Z', summary: 'clean', distilled: true },
  ];
  const out = digest.teamInjectSlice(entries, util.getConfig());
  const sessions = out.map(e => e.session);
  assert.ok(!sessions.includes('t1'), 'non-distilled teammate entry leaked into the block');
  assert.ok(sessions.includes('t2'), 'distilled teammate entry missing from the block');
});
```

Note on the `teamInjectSlice` test: its default `teamMaxAgeHours` is 72, so use timestamps within 72h of the test clock. If the suite runs against fixed dates, bump the timestamps to `new Date(Date.now() - 3600000).toISOString()` style, or set `config.teamMaxAgeHours` to a large number in the call: `digest.teamInjectSlice(entries, { teamMaxAgeHours: 1e9 })`. Prefer the large-age config to keep the test clock-independent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -i 'inbound:'`
Expected: FAIL — `t1` (non-distilled) currently appears in both surfaces.

- [ ] **Step 3: Wire the filters**

In `lib/feed.js`, add at the top (near the other requires; if the file has none, add after the `'use strict';` line):

```js
const classify = require('./classify');
```

In `buildFeed`, change:

```js
  const team = Array.isArray(input.team) ? input.team : [];
```

to:

```js
  // Inbound ops-noise suppression: a teammate row is trusted only when it is
  // distilled — team sync ships summaries, not raw edit events, so `distilled`
  // is the only substance signal we have for a teammate's session.
  const team = (Array.isArray(input.team) ? input.team : []).filter(classify.isShareableTeam);
```

In `lib/digest.js` `teamInjectSlice`, change the final return chain:

```js
  return [...latest.values()]
    .filter(e => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-max);
```

to:

```js
  return [...latest.values()]
    .filter(e => classify.isShareableTeam(e)) // distilled-only inbound (see feed.buildFeed)
    .filter(e => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .slice(-max);
```

(`digest.js` already gains `const classify = require('./classify');` in Task 4. If Task 5 is done before Task 4, add that require here too.)

- [ ] **Step 4: Run the tests and full suite**

Run: `npm test 2>&1 | grep -i 'inbound:'` → both PASS
Run: `npm test 2>&1 | tail -5`
Expected: all pass. A pre-existing teammate-render test that used a non-distilled team fixture and asserted it shows will now need its fixture marked `distilled: true` (to keep testing the render) or its assertion flipped to expect suppression — pick based on what the test is actually about.

- [ ] **Step 5: Commit**

```bash
git add lib/feed.js lib/digest.js test/run-tests.js
git commit -m "feat(team): suppress non-distilled inbound teammate rows (feed + block)"
```

---

## Post-implementation

- [ ] Run the full suite once more: `npm test 2>&1 | tail -3` — expect `NNN/NNN checks passed`.
- [ ] Rebuild + reinstall the app (project convention): `npm run dist:mac`, then quit the running app, swap `/Applications/MemBridge.app` (back up `.prev`), relaunch. Verify the feed no longer shows browser/ad-gen sessions and that a substantive zero-edit session (once it distills) renders a clean headline.
- [ ] Update `CHANGELOG.md` with a one-line entry under the current version.
- [ ] Leave `master` untouched; keep the work on `feat/suppress-ops-noise` per the branch policy until it is reviewed and Andrew has weighed in on the distilled-only inbound tradeoff.

## Self-Review

Spec coverage:
- Distill trigger (zero-edit branch, prompt floor, skip-aware) → Task 2. ✓
- `classify.js` predicate → Task 1. ✓
- Render filter, feed → Task 3 (server.js). ✓
- Render filter, CLAUDE.md block → Task 4 (digest.sessionGroups). ✓
- Push filter → Task 3 (teamsync.pushProject + reshare path). ✓
- Inbound filter → Task 5 (feed.buildFeed + digest.teamInjectSlice). ✓
- Config `minPromptsZeroEdit` default → Task 2. ✓
- No DB migration → satisfied (inbound uses existing `distilled`). ✓
- Fail-open behavior → classify returns "not shareable" on bad input; runStop keeps its try/catch. ✓
- Retroactive noise cleanup / forward-only rescue → filters read existing state (Tasks 3-5 immediate); rescue is new-sessions-only (Task 2). ✓

Type consistency: `filterShareableEntries(entries, events)`, `isShareableLocal(events, sessionId)`, `isShareableTeam(entry)`, `shareableSessions(events)` — names and argument order identical across Tasks 1, 3, 4, 5. Distilled detection (`source === 'Distilled'`) identical to the codebase's existing `pickSummary` rule.
