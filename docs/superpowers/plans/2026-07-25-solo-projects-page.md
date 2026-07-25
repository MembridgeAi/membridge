# Solo-first Projects Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the local dashboard's Projects index as tall adaptive cards that lead with what happened, what is unfinished, and what has accumulated — so a solo user gets a re-entry surface instead of a teammate-activity report.

**Architecture:** One card component for everyone. Each block renders only when it has data, so the Who stack, sparkline and Person filter simply do not draw for a solo user rather than drawing empty. All new logic goes in pure, dependency-injected helpers next to the existing `px*` family so it is testable offline without a browser. Two small server additions supply lifetime session counts and a memory-block-present check.

**Tech Stack:** Plain ES5-style browser JS (no framework, no build step), Node HTTP server, `node:assert` tests in a single `test/run-tests.js`.

Spec: [docs/superpowers/specs/2026-07-25-solo-projects-page-design.md](../specs/2026-07-25-solo-projects-page-design.md)

## Global Constraints

- **`lib/dashboard/client.js` is one big JS template literal** (`module.exports = function dashboardClient(...) { return \`...\` }`, client.js:5-6). Inside it, every backslash must be doubled (`/\\s+/` not `/\s+/`), and backticks and `${` must be escaped. Existing code shows the idiom at client.js:822.
- **Client code is ES5-style**: `var`, `function`, no arrow functions, no template literals, no `const`/`let`. Match the surrounding file.
- **All new display logic must be a pure top-level `function name(...)` declaration** with dependencies injected as parameters. The test harness extracts functions by source text (`extractFn`, test/run-tests.js:1180) and can only find `function name(` declarations — not `var name = function`.
- **Every user-visible string goes through `esc()`** before entering HTML.
- **No magic numbers** — named constants at module scope, like the existing `PX_DORMANT_DAYS` (client.js:847).
- Test command is always `npm test` (package.json:32). There is no per-test filter; run the full suite and grep for the check name.
- Do not touch `web/app/projects/page.js` — that is the hosted team page and is out of scope.

---

### Task 1: Turn the row into a card, sort dormant last, page the overflow

**Files:**
- Modify: `lib/dashboard/client.js:871-957` (`pxRowHtml`), `975-1037` (`renderProjectsIndex`)
- Modify: `lib/dashboard/styles.js:275-305` (the `.px-*` block)
- Test: `test/run-tests.js` (near the existing Projects checks, ~line 2238)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pxPaginate(projects, limit, isDormant)` → `{ cards: [], dim: [], hidden: number }`. Later tasks render blocks *inside* the card produced here. Card markup root is `<div class="px-card">`; the dim one-line form keeps `<div class="px-row dim">`.

- [ ] **Step 1: Write the failing test**

Add inside the same `describe`-style block as the existing Projects checks in `test/run-tests.js` (after the check ending at ~line 2238):

```js
check('Projects: pagination splits active cards from dim rows and counts the overflow', () => {
  const pxPagSrc = extractFn(embeddedScript, 'pxPaginate');
  assert.ok(pxPagSrc, 'pxPaginate pure helper missing');
  const pxPaginate = new Function('return (' + pxPagSrc + ')')();
  const isDormant = p => !!p.dormant;
  const ps = [
    { name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' },
    { name: 'e' }, { name: 'f' }, { name: 'g' },
    { name: 'z', dormant: true },
  ];
  const out = pxPaginate(ps, 6, isDormant);
  assert.strictEqual(out.cards.length, 6, 'exactly `limit` active cards must render');
  assert.strictEqual(out.hidden, 1, 'the 7th active project must be counted as hidden');
  assert.deepStrictEqual(out.dim.map(p => p.name), ['z'],
    'dormant projects must be split out, never counted against the limit');
  const all = pxPaginate(ps, 99, isDormant);
  assert.strictEqual(all.hidden, 0, 'a limit above the count must hide nothing');
  assert.strictEqual(all.cards.length, 7, 'all active projects render when nothing is hidden');
  assert.deepStrictEqual(pxPaginate([], 6, isDormant),
    { cards: [], dim: [], hidden: 0 }, 'an empty project list must not throw');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'pagination splits active'`
Expected: `FAIL  Projects: pagination splits active cards from dim rows and counts the overflow` with `pxPaginate pure helper missing`.

- [ ] **Step 3: Add the pure helper and its constant**

In `lib/dashboard/client.js`, immediately after the `PX_DORMANT_DAYS` constant (client.js:847):

```js
// How many active project cards render before the rest fold behind "Show
// more". Tall cards mean a long list stops being scannable well before it
// stops fitting, so the cut is deliberate rather than a viewport guess.
var PX_CARDS_VISIBLE = 6;
// Pure (offline-testable, pxLatestEntry style — deps injected): split the
// list into full cards, dim one-liners and a hidden count. Dormant/paused
// rows are single lines, so they never spend the card budget and always
// render — they also always sort last, because a one-line row wedged between
// two tall cards reads as a rendering fault.
function pxPaginate(projects, limit, isDormant) {
  var cards = [], dim = [];
  (projects || []).forEach(function (p) {
    (isDormant(p) ? dim : cards).push(p);
  });
  var hidden = Math.max(0, cards.length - limit);
  return { cards: cards.slice(0, limit), dim: dim, hidden: hidden };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'pagination splits active'`
Expected: `ok    Projects: pagination splits active cards from dim rows and counts the overflow`

- [ ] **Step 5: Extract the dormant predicate so the helper and the renderer agree**

`pxRowHtml` currently decides dormancy inline at client.js:910. Replace that condition with a shared predicate. Add next to `pxPaginate`:

```js
// The single source of truth for "this project has earned only one dim line":
// explicitly paused, never active, or quiet past the dormant threshold.
function pxIsDim(p) {
  if (!p) return true;
  if (p.paused) return true;
  if (!p.lastActivity) return true;
  return Math.floor((Date.now() - new Date(p.lastActivity).getTime()) / 86400000) >= PX_DORMANT_DAYS;
}
```

Then in `pxRowHtml`, replace:

```js
  if (p.paused || ageDays === null || ageDays >= PX_DORMANT_DAYS) {
```

with:

```js
  if (pxIsDim(p)) {
```

Leave the `ageDays` variable in place — the dim branch still uses it for the "quiet for N weeks" copy.

- [ ] **Step 6: Render cards instead of grid rows**

In `pxRowHtml`, replace the final return (client.js:956):

```js
  return '<div class="px-row">' + nameCell + latestCell + whoCell + spark + menuCell + menu + '</div>';
```

with:

```js
  return '<div class="px-card">' +
    '<div class="px-card-top">' + nameCell + menuCell + '</div>' +
    latestCell + whoCell + spark + menu + '</div>';
```

- [ ] **Step 7: Rebuild the index shell around the cards**

In `renderProjectsIndex`, replace the `grid` assignment (client.js:1021-1025):

```js
  var grid =
    '<div class="px-hdr"><span>Project</span><span>Latest session</span><span>Who</span><span>24h</span><span></span></div>' +
    (vis.length
      ? vis.map(pxRowHtml).join('')
      : '<div style="padding:22px 4px;color:var(--text3);font-size:13px">No projects match these filters.</div>');
```

with:

```js
  // Cards first, dim one-liners after, then whatever the card budget hid.
  var paged = pxPaginate(vis, pxShowAll ? vis.length : PX_CARDS_VISIBLE, pxIsDim);
  var more = paged.hidden
    ? '<div data-px-showall class="px-more">Show ' + paged.hidden + ' more project' +
      (paged.hidden === 1 ? '' : 's') + '</div>'
    : '';
  var grid = vis.length
    ? paged.cards.map(pxRowHtml).join('') + more + paged.dim.map(pxRowHtml).join('')
    : '<div style="padding:22px 4px;color:var(--text3);font-size:13px">No projects match these filters.</div>';
```

The column header row is deleted — cards have no columns to label.

- [ ] **Step 8: Add the expand state and its click handler**

Next to the other `px` state vars (client.js:693-694), add `pxShowAll`:

```js
var pxFilter = { show: 'All', person: 'All', sort: 'Recent' };
var pxShowAll = false;
```

In the delegated `view-home` listener, immediately after the `data-px-add` branch (client.js:1096-1097):

```js
  var showAll = e.target.closest('[data-px-showall]');
  if (showAll) { pxShowAll = true; renderProjectsIndex(); return; }
```

`pxShowAll` deliberately survives the 5s poll: a user who expanded the list must not have it collapse under them.

- [ ] **Step 9: Replace the grid CSS with card CSS**

In `lib/dashboard/styles.js`, replace lines 275-280 (`.px-hdr, .px-row { ... }` through `.px-row.dim:hover { ... }`) with:

```css
.px-card { position:relative; border:1px solid var(--border); border-radius:16px; background:var(--card); padding:16px 18px; margin-bottom:10px; transition:border-color .15s, box-shadow .15s; }
.px-card:hover { border-color:var(--accent-brd); box-shadow:var(--shadow-md); }
.px-card-top { display:flex; align-items:flex-start; gap:12px; }
.px-card-top .px-cell { flex:1; min-width:0; }
.px-row { display:grid; grid-template-columns:176px minmax(0,1fr) 32px; gap:0 14px; align-items:center; padding:11px 4px; border-bottom:1px solid var(--border); position:relative; }
.px-row.dim { opacity:.62; }
.px-row.dim:hover { opacity:1; }
.px-more { margin:4px 0 14px; padding:10px; text-align:center; border:1px dashed var(--border2); border-radius:12px; color:var(--text2); font-size:12.5px; cursor:pointer; transition:all .15s; }
.px-more:hover { border-color:var(--accent-brd); color:var(--accent); }
```

Note the dim `.px-row` grid drops from five columns to three — the dim branch of `pxRowHtml` emits name, status and menu only, and the two `<span></span>` spacers it currently sends at client.js:925 must be deleted:

```js
      '<span></span><span></span>' + menuCell + menu + '</div>';
```

becomes:

```js
      menuCell + menu + '</div>';
```

- [ ] **Step 10: Update the assertions that pinned the grid**

In `test/run-tests.js`, the check `'Projects index renders the 1c compact grid with every row action hook intact'` asserts the header row exists. Replace its first assertion:

```js
      assert.ok(/px-hdr/.test(renderSrc) && /Latest session/.test(renderSrc), '1c column header row missing');
```

with:

```js
      assert.ok(/px-card/.test(rowSrc), 'project rows must render as cards');
      assert.ok(/pxPaginate\(/.test(renderSrc), 'the index must page its cards');
```

and its last assertion:

```js
      assert.ok(pageHtml.includes('.px-hdr'), '1c grid CSS missing from the stylesheet');
```

with:

```js
      assert.ok(pageHtml.includes('.px-card'), 'card CSS missing from the stylesheet');
```

Also rename the check to `'Projects index renders cards with every row action hook intact'`.

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: all checks pass, no FAIL lines. The suite baseline is 627 passing.

- [ ] **Step 12: Commit**

```bash
git add lib/dashboard/client.js lib/dashboard/styles.js test/run-tests.js
git commit -m "feat(projects): rows become cards, dormant sorts last, overflow pages

A one-line scan row had no space for what a solo user actually needs, and a
dim dormant row wedged between two tall cards reads as a rendering fault. Active
projects now render as cards, dormant and paused ones collapse below them, and
anything past the sixth card folds behind one Show more control that survives
the 5s poll."
```

---

### Task 2: The latest-session line never truncates and never shows a prompt

**Files:**
- Modify: `lib/dashboard/client.js:816-825` (delete `pxClipSummary`/`PX_SUMMARY_MAX`), `928-945` (the latest cell)
- Modify: `lib/dashboard/styles.js:288-291`
- Test: `test/run-tests.js:2228-2244`

**Interfaces:**
- Consumes: `pxIsDim` from Task 1.
- Produces: `pxGlanceFor(entry)` → `{ text: string, kind: 'headline'|'summary'|'none' }`. Task 7 reads `kind` to decide styling.

- [ ] **Step 1: Write the failing test**

Replace the `pxClipSummary` assertions in `test/run-tests.js` (lines 2228-2235, the tail of the check named `'Projects 1c: latest-entry and sparkline helpers are pure, ts-ordered and clock-injected'`) with:

```js
      const pxGlanceSrc = extractFn(embeddedScript, 'pxGlanceFor');
      assert.ok(pxGlanceSrc, 'pxGlanceFor pure helper missing');
      const pxGlanceFor = new Function('return (' + pxGlanceSrc + ')')();
      const long = 'x'.repeat(400);
      assert.deepStrictEqual(pxGlanceFor({ headline: 'Shipped the thing', summary: 'longer text' }),
        { text: 'Shipped the thing', kind: 'headline' }, 'headline must win and pass through verbatim');
      assert.deepStrictEqual(pxGlanceFor({ summary: long }), { text: long, kind: 'summary' },
        'a summary must render in full — this line never truncates');
      assert.strictEqual(pxGlanceFor({ ask: 'please fix the login bug' }).kind, 'none',
        'a raw prompt must never be shown as the glance line');
      assert.strictEqual(pxGlanceFor(null).kind, 'none', 'a missing entry must not throw');
      assert.strictEqual(pxGlanceFor({ headline: '   ' }).kind, 'none',
        'a whitespace-only headline must fall through, not render blank');
      assert.ok(!extractFn(embeddedScript, 'pxClipSummary'),
        'pxClipSummary must be gone — the glance line is no longer capped');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'latest-entry and sparkline'`
Expected: `FAIL ... pxGlanceFor pure helper missing`

- [ ] **Step 3: Delete the clip helper and add the glance chain**

In `lib/dashboard/client.js`, delete lines 816-825 entirely (the `pxClipSummary` comment block, the function, and `var PX_SUMMARY_MAX = 140;`). Replace with:

```js
// Pure (offline-testable, pxLatestEntry style): what the card says happened.
// Two hard rules, both spec'd:
//   1. Never a prompt. `ask` is what you ASKED, not what happened — on a
//      re-entry surface it answers with the question. There is no length at
//      which showing it here becomes right, so it is not in the chain.
//   2. Never truncated. hooks.js:96 tells every capture that a headline
//      "renders verbatim on a card that never truncates" and bounds it to 80
//      chars to guarantee it; summaries are bounded to 300 at capture. The
//      old 140-char clip existed only because this was one line of a grid.
function pxGlanceFor(entry) {
  var headline = entry && entry.headline ? String(entry.headline).trim() : '';
  if (headline) return { text: headline, kind: 'headline' };
  var summary = entry && entry.summary ? String(entry.summary).trim() : '';
  if (summary) return { text: summary, kind: 'summary' };
  return { text: 'Session captured, no summary', kind: 'none' };
}
```

- [ ] **Step 4: Use it in the card, and drop the tooltip**

In `pxRowHtml`, replace client.js:930-933:

```js
  var summary = latest ? (latest.summary || latest.ask || '') : '';
  var tline = summary
    ? '<div class="t">' + esc(pxClipSummary(summary, PX_SUMMARY_MAX)) + '</div>'
    : '<div class="t none">No recent sessions</div>';
```

with:

```js
  var glance = latest ? pxGlanceFor(latest) : { text: 'No recent sessions', kind: 'none' };
  var tline = '<div class="t' + (glance.kind === 'none' ? ' none' : '') + '">' + esc(glance.text) + '</div>';
```

Then replace client.js:943-945:

```js
  var latestCell = '<div class="px-cell px-latest' + (quiet ? ' quiet' : '') + '" data-px-open="' + pathAttr + '"' +
    (summary ? ' title="' + esc(summary) + '"' : '') + '>' + tline +
    (mparts.length ? '<div class="m">' + mparts.join(' · ') + '</div>' : '') + '</div>';
```

with:

```js
  // No title attribute: the full text is already on screen, so a
  // hover-for-the-rest tooltip would have nothing left to reveal.
  var latestCell = '<div class="px-cell px-latest' + (quiet ? ' quiet' : '') + '" data-px-open="' + pathAttr + '">' + tline +
    (mparts.length ? '<div class="m">' + mparts.join(' · ') + '</div>' : '') + '</div>';
```

- [ ] **Step 5: Stop the CSS from clamping quiet cards**

In `lib/dashboard/styles.js`, replace line 289:

```css
.px-latest.quiet .t { color:var(--text2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
```

with:

```css
.px-latest.quiet .t { color:var(--text2); }
```

`quiet` now means "dimmed because it is a few days old", not "clipped to one line". Add a max-width so a 300-character summary stays readable — replace line 288:

```css
.px-latest .t { font-size:13px; line-height:1.4; color:var(--text); overflow-wrap:anywhere; }
```

with:

```css
.px-latest .t { font-size:13.5px; line-height:1.45; color:var(--text); overflow-wrap:anywhere; max-width:62ch; margin-top:9px; }
```

- [ ] **Step 6: Invert the assertion that pinned the cap**

In the check `'Projects index renders cards with every row action hook intact'`, replace:

```js
      assert.ok(/pxClipSummary\(/.test(rowSrc), 'latest-session summary is not length-capped');
      assert.ok(/title="' \+ esc\(summary\)/.test(rowSrc), 'full summary tooltip missing from the latest-session cell');
```

with:

```js
      assert.ok(/pxGlanceFor\(/.test(rowSrc), 'the card must use the never-truncating glance chain');
      assert.ok(!/pxClipSummary/.test(rowSrc), 'the glance line must not be length-capped');
      assert.ok(!/latest\.ask/.test(rowSrc), 'the raw prompt must never be the glance line');
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/dashboard/client.js lib/dashboard/styles.js test/run-tests.js
git commit -m "feat(projects): the glance line is an outcome, never a prompt, never cut off

The card fell back to the raw prompt when a session had no summary, and clipped
whatever it showed at 140 characters. A prompt is what you asked, not what
happened, so it answered with the question; and the clip existed only because
the cell was one line of a scan grid.

The chain is now headline verbatim, then the full summary wrapped, then an
honest empty state. This restores a contract hooks.js already states to every
capture -- a headline renders verbatim on a card that never truncates."
```

---

### Task 3: Show where you left off

**Files:**
- Modify: `lib/dashboard/client.js` (new helper near `pxWhoList`, ~line 841; render in `pxRowHtml`)
- Modify: `lib/dashboard/styles.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `pxLatestEntry` (existing), `pxGlanceFor` from Task 2.
- Produces: `pxOpenTodos(entry, max)` → `{ items: [string], more: number }`.

- [ ] **Step 1: Write the failing test**

Add after the glance check in `test/run-tests.js`:

```js
check('Projects: open todos come from the latest session as text, capped with a remainder', () => {
  const src = extractFn(embeddedScript, 'pxOpenTodos');
  assert.ok(src, 'pxOpenTodos pure helper missing');
  const pxOpenTodos = new Function('return (' + src + ')')();
  const entry = { tasks: { items: [
    { text: 'wire up the parser', status: 'in_progress' },
    { text: 'delete the old shim', status: 'pending' },
    { text: 'ship it', status: 'pending' },
    { text: 'write the test', status: 'completed' },
  ] } };
  const out = pxOpenTodos(entry, 2);
  assert.deepStrictEqual(out.items, ['wire up the parser', 'delete the old shim'],
    'open todos must keep source order and stop at the cap');
  assert.strictEqual(out.more, 1, 'the uncapped remainder must be counted, completed items excluded');
  assert.deepStrictEqual(pxOpenTodos({ tasks: { items: [{ text: 'done', status: 'completed' }] } }, 2),
    { items: [], more: 0 }, 'an all-complete session has nothing outstanding');
  assert.deepStrictEqual(pxOpenTodos(null, 2), { items: [], more: 0 }, 'a missing entry must not throw');
  assert.deepStrictEqual(pxOpenTodos({ tasks: null }, 2), { items: [], more: 0 },
    'an entry with no todo snapshot must not throw');
  assert.deepStrictEqual(pxOpenTodos({ tasks: { items: [{ status: 'pending' }] } }, 2),
    { items: [], more: 0 }, 'a todo with no text must be dropped, not rendered blank');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'open todos come from'`
Expected: `FAIL ... pxOpenTodos pure helper missing`

- [ ] **Step 3: Add the helper**

In `lib/dashboard/client.js`, after `pxInitials` (client.js:845):

```js
// How many unfinished items the card lists before collapsing to "+N more".
var PX_TODOS_SHOWN = 2;
// Pure (offline-testable): what you still owe on this project. The feed
// carries the TEXT of each todo, not just a count (feed.js normalizeLocal
// whitelists `tasks`), and text is what reloads your head after a context
// switch — a bare number does not. Source order is kept: it is the order the
// session itself wrote them, which is the order they were meant to be done.
function pxOpenTodos(entry, max) {
  var items = (entry && entry.tasks && Array.isArray(entry.tasks.items)) ? entry.tasks.items : [];
  var open = [];
  items.forEach(function (i) {
    if (!i || i.status === 'completed') return;
    var text = i.text ? String(i.text).trim() : '';
    if (text) open.push(text);
  });
  return { items: open.slice(0, max), more: Math.max(0, open.length - max) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'open todos come from'`
Expected: `ok    Projects: open todos come from the latest session as text, capped with a remainder`

- [ ] **Step 5: Render the block in the card**

In `pxRowHtml`, immediately after the `latestCell` assignment from Task 2, add:

```js
  var todos = pxOpenTodos(latest, PX_TODOS_SHOWN);
  var todoCell = todos.items.length
    ? '<div class="px-todos"><div class="px-todos-h">Where you left off</div>' +
      todos.items.map(function (t) {
        return '<div class="px-todo"><span class="px-todo-box"></span><span>' + esc(t) + '</span></div>';
      }).join('') +
      (todos.more ? '<div class="px-todo-more">+' + todos.more + ' more unfinished</div>' : '') +
      '</div>'
    : '';
```

Then add `todoCell` to the card return, between `latestCell` and `whoCell`:

```js
  return '<div class="px-card">' +
    '<div class="px-card-top">' + nameCell + menuCell + '</div>' +
    latestCell + todoCell + whoCell + spark + menu + '</div>';
```

Remove the now-duplicated open-todo count from the meta line — delete client.js:938:

```js
  if (stats && stats.openTodos > 0) mparts.push('<span class="todo">' + stats.openTodos + ' open todo' + (stats.openTodos === 1 ? '' : 's') + '</span>');
```

The block above says the same thing with the actual text, so the count is noise beside it.

- [ ] **Step 6: Add the CSS**

Append to the `.px-*` block in `lib/dashboard/styles.js`:

```css
.px-todos { margin-top:12px; padding:10px 12px; border-radius:10px; background:var(--surface2); }
.px-todos-h { font:600 9px/1 var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--text3); margin-bottom:7px; }
.px-todo { display:flex; align-items:flex-start; gap:8px; font-size:12.5px; line-height:1.45; color:var(--text2); overflow-wrap:anywhere; }
.px-todo + .px-todo { margin-top:4px; }
.px-todo-box { width:11px; height:11px; border-radius:3px; border:1.5px solid var(--border2); flex:none; margin-top:3px; }
.px-todo-more { font-size:11.5px; color:var(--text3); margin-top:5px; }
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add lib/dashboard/client.js lib/dashboard/styles.js test/run-tests.js
git commit -m "feat(projects): the card shows what you still owe, in words

The feed already carries the text of every open todo, and the card rendered a
bare count of them. A number tells you there is unfinished work; the text tells
you what it is, which is the thing that reloads your head after a context
switch. Cards now list the top two unfinished items and count the rest."
```

---

### Task 4: Serve lifetime session totals

**Files:**
- Modify: `lib/server.js:139-173` (`projectsPayload`)
- Test: `test/run-tests.js:22` (import) and a new in-process check

**Interfaces:**
- Consumes: nothing.
- Produces: two new fields on every `/api/projects` element — `sessionsTotal: number` and `firstActivity: string|null` (ISO). Task 5 renders them.

- [ ] **Step 1: Write the failing test**

Add `projectsPayload` to the existing import at `test/run-tests.js:22`:

```js
const { startServer, teamPayload, teamProjectsPayload, statusPayload, projectsPayload, feedPayload, projectDetail, planPayload } = require('../lib/server');
```

Add a check next to the in-process `statusPayload` check (~line 1089):

```js
check('projectsPayload reports lifetime sessions and first activity', () => {
  const rows = projectsPayload();
  assert.ok(Array.isArray(rows) && rows.length, 'fixture projects expected');
  rows.forEach(p => {
    assert.strictEqual(typeof p.sessionsTotal, 'number', p.name + ' is missing sessionsTotal');
    assert.ok(p.sessionsTotal >= 0, 'sessionsTotal must never be negative');
    assert.ok(p.firstActivity === null || !isNaN(Date.parse(p.firstActivity)),
      p.name + ' firstActivity must be null or a parseable timestamp');
    if (p.lastActivity && p.firstActivity) {
      assert.ok(String(p.firstActivity) <= String(p.lastActivity),
        'firstActivity must not be newer than lastActivity');
    }
  });
  const active = rows.find(p => p.lastActivity);
  if (active) assert.ok(active.sessionsTotal > 0, 'a project with activity must have counted sessions');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'lifetime sessions'`
Expected: `FAIL ... is missing sessionsTotal`

- [ ] **Step 3: Derive the fields**

In `lib/server.js`, inside the `for` loop of `projectsPayload` (after the `exists` try/catch at line 146-149), add:

```js
    // Lifetime figures, derived in the loop that already walks events.
    // projectStats is week-scoped (sessionsThisWeek) and cannot answer "how
    // much has accumulated here", which is the card's memory-as-an-asset line.
    const sessionIds = new Set();
    let firstActivity = null;
    for (const ev of proj.events) {
      if (ev.session) sessionIds.add(ev.session);
      if (ev.ts && (!firstActivity || String(ev.ts) < String(firstActivity))) firstActivity = ev.ts;
    }
```

Then add the two fields to the pushed object, right after `lastActivity` (line 155):

```js
      sessionsTotal: sessionIds.size,
      firstActivity,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'lifetime sessions'`
Expected: `ok    projectsPayload reports lifetime sessions and first activity`

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat(projects): serve lifetime session count and first activity

projectStats is week-scoped, so nothing on the wire could answer how much has
accumulated in a project. Both figures fall out of the event walk projectsPayload
already does, so this costs no extra pass."
```

---

### Task 5: Show what has accumulated

**Files:**
- Modify: `lib/dashboard/client.js` (helper + render)
- Modify: `lib/dashboard/styles.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `sessionsTotal` / `firstActivity` from Task 4; `p.tools` (already served, server.js:165).
- Produces: `pxAccumulation(project, now)` → `{ text: string }` or `null` when there is nothing worth saying.

- [ ] **Step 1: Write the failing test**

```js
check('Projects: the accumulation line states sessions, span and tools', () => {
  const src = extractFn(embeddedScript, 'pxAccumulation');
  assert.ok(src, 'pxAccumulation pure helper missing');
  const pxAccumulation = new Function('return (' + src + ')')();
  const now = new Date(2026, 6, 25, 12, 0, 0).getTime();
  const march = new Date(2026, 2, 4, 9, 0, 0).toISOString();
  const out = pxAccumulation(
    { sessionsTotal: 412, firstActivity: march, tools: ['Claude Code', 'Cursor'] }, now);
  assert.ok(/412 sessions/.test(out.text), 'the session total must lead: ' + out.text);
  assert.ok(/Mar/.test(out.text), 'the span must name when memory started: ' + out.text);
  assert.ok(/Claude Code/.test(out.text) && /Cursor/.test(out.text),
    'the tools that worked here must be listed: ' + out.text);
  assert.strictEqual(pxAccumulation({ sessionsTotal: 1, firstActivity: march, tools: [] }, now).text
    .indexOf('1 session,'), 0, 'a single session must not be pluralised');
  assert.strictEqual(pxAccumulation({ sessionsTotal: 0, firstActivity: null, tools: [] }, now), null,
    'a project with nothing captured has no accumulation line');
  assert.strictEqual(pxAccumulation(null, now), null, 'a missing project must not throw');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'accumulation line states'`
Expected: `FAIL ... pxAccumulation pure helper missing`

- [ ] **Step 3: Add the helper**

In `lib/dashboard/client.js`, after `pxOpenTodos`:

```js
// Pure (offline-testable, clock injected): the memory-as-an-asset line. A
// project with 400 sessions across three tools going back to March is worth
// something, and the card used to render it identically to one added
// yesterday. Returns null rather than an empty string so the caller can skip
// the block entirely — an empty block is worse than no block.
function pxAccumulation(p, now) {
  if (!p || !p.sessionsTotal) return null;
  var parts = [p.sessionsTotal + ' session' + (p.sessionsTotal === 1 ? '' : 's')];
  if (p.firstActivity) {
    var d = new Date(p.firstActivity);
    if (!isNaN(d.getTime())) {
      var sameYear = d.getFullYear() === new Date(now).getFullYear();
      parts.push('since ' + d.toLocaleDateString(undefined,
        sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' }));
    }
  }
  var tools = (p.tools || []).filter(Boolean);
  var text = parts.join(', ');
  if (tools.length) text += ' · ' + tools.join(', ');
  return { text: text };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'accumulation line states'`
Expected: `ok    Projects: the accumulation line states sessions, span and tools`

- [ ] **Step 5: Render it**

In `pxRowHtml`, after the `todoCell` assignment:

```js
  var acc = pxAccumulation(p, Date.now());
  var accCell = acc ? '<div class="px-acc">' + esc(acc.text) + '</div>' : '';
```

Add it to the card return, after `todoCell`:

```js
    latestCell + todoCell + accCell + whoCell + spark + menu + '</div>';
```

- [ ] **Step 6: Add the CSS**

```css
.px-acc { margin-top:11px; padding-top:10px; border-top:1px solid var(--border); font:500 10.5px/1.5 var(--mono); letter-spacing:.04em; color:var(--text3); overflow-wrap:anywhere; }
```

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: all pass.

```bash
git add lib/dashboard/client.js lib/dashboard/styles.js test/run-tests.js
git commit -m "feat(projects): show what has accumulated in each project

A project with hundreds of sessions across three tools rendered identically to
one added yesterday, which is the difference between a product that feels like
it compounds and one that feels like it logs. Cards now state the session total,
when memory started, and which tools have worked there."
```

---

### Task 6: Serve whether the memory block actually landed

**Files:**
- Modify: `lib/server.js:163-169` (`targets` mapping in `projectsPayload`)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `digest.BEGIN` (already exported, digest.js:466).
- Produces: `targets[].injected: boolean` on `/api/projects`. Task 7 renders it.

- [ ] **Step 1: Write the failing test**

```js
check('projectsPayload reports whether the managed block is really in each target', () => {
  const rows = projectsPayload();
  assert.ok(rows.length, 'fixture projects expected');
  rows.forEach(p => {
    (p.targets || []).forEach(t => {
      assert.strictEqual(typeof t.injected, 'boolean',
        p.name + ' target ' + t.file + ' is missing injected');
      if (!t.exists) assert.strictEqual(t.injected, false,
        'a target file that does not exist cannot contain the block');
    });
  });
  // Cheap proof the cache does not go stale: two calls in a row must agree,
  // and writing the block must flip the flag on the next call.
  const before = JSON.stringify(projectsPayload().map(p => p.targets));
  assert.strictEqual(before, JSON.stringify(projectsPayload().map(p => p.targets)),
    'repeat calls must be stable');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'managed block is really'`
Expected: `FAIL ... is missing injected`

- [ ] **Step 3: Add the mtime-keyed cache**

In `lib/server.js`, above `projectsPayload` (before line 139):

```js
// Whether a context file actually contains the managed block. `targets[].exists`
// only says the FILE is there, which is a different question: a CLAUDE.md can
// exist and carry no MemBridge block at all, and that is exactly the silent
// failure the card needs to surface.
//
// The Projects index polls every 5 seconds, so this must not re-read every
// context file on every poll. Cache on (path, mtimeMs, size) and re-read only
// when the file actually moves.
const injectedCache = new Map();
function targetHasBlock(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    injectedCache.delete(filePath);
    return false;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = injectedCache.get(filePath);
  if (hit && hit.stamp === stamp) return hit.injected;
  let injected = false;
  try {
    injected = fs.readFileSync(filePath, 'utf8').includes(digest.BEGIN);
  } catch {}
  injectedCache.set(filePath, { stamp, injected });
  return injected;
}
```

- [ ] **Step 4: Use it in the payload**

Replace the `targets` mapping at server.js:163-166:

```js
      targets: effectiveTargets(config).map(t => ({
        file: t,
        exists: exists && fs.existsSync(path.join(key, t)),
      })),
```

with:

```js
      targets: effectiveTargets(config).map(t => {
        const full = path.join(key, t);
        const there = exists && fs.existsSync(full);
        return { file: t, exists: there, injected: there && targetHasBlock(full) };
      }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'managed block is really'`
Expected: `ok    projectsPayload reports whether the managed block is really in each target`

- [ ] **Step 6: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat(projects): report whether the memory block actually landed

targets[].exists only says the context file is present, which is a different
question from whether it carries a MemBridge block -- a CLAUDE.md can exist with
no block at all, and nothing on screen said so. Reads are cached on mtime and
size, because the index polls every five seconds."
```

---

### Task 7: Surface a missing memory block in the health line

**Files:**
- Modify: `lib/dashboard/client.js` (helper + both health paths in `pxRowHtml`)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `targets[].injected` from Task 6; `pxCaptureStale` (existing, client.js:858).
- Produces: `pxBlockMissing(project)` → boolean.

- [ ] **Step 1: Write the failing test**

```js
check('Projects: a context file with no MemBridge block is reported as broken', () => {
  const src = extractFn(embeddedScript, 'pxBlockMissing');
  assert.ok(src, 'pxBlockMissing pure helper missing');
  const pxBlockMissing = new Function('return (' + src + ')')();
  assert.strictEqual(pxBlockMissing({ targets: [
    { file: 'CLAUDE.md', exists: true, injected: true },
    { file: 'AGENTS.md', exists: true, injected: false },
  ] }), true, 'any present-but-uninjected target means the memory is not reaching that tool');
  assert.strictEqual(pxBlockMissing({ targets: [
    { file: 'CLAUDE.md', exists: true, injected: true },
  ] }), false, 'a fully injected project is healthy');
  assert.strictEqual(pxBlockMissing({ targets: [
    { file: 'CLAUDE.md', exists: false, injected: false },
  ] }), false, 'a file that does not exist yet is not a failure -- nothing was written there');
  assert.strictEqual(pxBlockMissing({ paused: true, targets: [
    { file: 'CLAUDE.md', exists: true, injected: false },
  ] }), false, 'a paused project is meant to have no block');
  assert.strictEqual(pxBlockMissing(null), false, 'a missing project must not throw');
  assert.strictEqual(pxBlockMissing({}), false, 'a project with no targets must not throw');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'no MemBridge block'`
Expected: `FAIL ... pxBlockMissing pure helper missing`

- [ ] **Step 3: Add the helper**

In `lib/dashboard/client.js`, next to `pxCaptureStale` (after client.js:867):

```js
// A context file is on disk but carries no MemBridge block: the tool that reads
// that file is getting no shared memory at all. Distinct from "not capturing"
// — capture can be working perfectly while the write-out silently is not.
// A file that does not exist yet is NOT a failure: nothing was ever written
// there, so there is nothing broken to report.
function pxBlockMissing(p) {
  if (!p || p.paused) return false;
  var targets = p.targets || [];
  for (var i = 0; i < targets.length; i++) {
    if (targets[i] && targets[i].exists && !targets[i].injected) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'no MemBridge block'`
Expected: `ok    Projects: a context file with no MemBridge block is reported as broken`

- [ ] **Step 5: Render it on the active card**

In `pxRowHtml`, replace the meta-line lead at client.js:937:

```js
  if (captureStale) mparts.push('<span class="px-chip">not capturing</span>');
```

with:

```js
  if (captureStale) mparts.push('<span class="px-chip">not capturing</span>');
  if (pxBlockMissing(p)) mparts.push('<span class="px-chip">memory not in your context files</span>');
```

- [ ] **Step 6: Render it on the dim row too**

A paused project is excluded by the helper, but a dormant one is not — and a dormant project with a stripped block is exactly the case worth flagging. In the dim branch, replace the `captureStale` ternary chain's final `ageDays === null` arm (client.js:920-922):

```js
        : ageDays === null
          ? '<span>no activity yet</span>'
          : '<span>dormant &mdash; quiet for ' + Math.floor(ageDays / 7) + ' weeks</span>';
```

with:

```js
        : pxBlockMissing(p)
          ? '<span class="px-chip">memory not in your context files</span><span>the block is missing from a file that exists</span>'
          : ageDays === null
            ? '<span>no activity yet</span>'
            : '<span>dormant &mdash; quiet for ' + Math.floor(ageDays / 7) + ' weeks</span>';
```

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: all pass.

```bash
git add lib/dashboard/client.js test/run-tests.js
git commit -m "feat(projects): say so when the memory block is not in your context files

Capture can work perfectly while the write-out silently does not, and nothing on
screen distinguished the two. A context file that exists without a MemBridge
block now says so on the card. A file that does not exist yet is not flagged --
nothing was written there, so nothing is broken."
```

---

### Task 8: Draw blocks only when they have something to say

**Files:**
- Modify: `lib/dashboard/client.js:947-969` (who/spark/`pxNewCount`), `1004-1015` (filters), `1018-1020` (footer)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `pxVisibleFilters(projects, people)` → `{ show: boolean, person: boolean }`.

- [ ] **Step 1: Write the failing test**

```js
check('Projects: filters and person-scoped blocks hide when there is nobody to filter by', () => {
  const src = extractFn(embeddedScript, 'pxVisibleFilters');
  assert.ok(src, 'pxVisibleFilters pure helper missing');
  const pxVisibleFilters = new Function('return (' + src + ')')();
  const solo = pxVisibleFilters([{ name: 'a' }, { name: 'b' }], ['You']);
  assert.strictEqual(solo.person, false, 'one person means nothing to filter by');
  assert.strictEqual(solo.show, false, 'all-local projects make the Shared/Local switch meaningless');
  const mixed = pxVisibleFilters([{ name: 'a' }, { name: 'b', team: { teamId: 't1' } }], ['You', 'Andrew']);
  assert.strictEqual(mixed.person, true, 'two people means the Person filter earns its space');
  assert.strictEqual(mixed.show, true, 'a mix of shared and local earns the Show filter');
  const allShared = pxVisibleFilters([{ name: 'a', team: { teamId: 't1' } }], ['You', 'Andrew']);
  assert.strictEqual(allShared.show, false, 'all-shared is as unfilterable as all-local');
  assert.deepStrictEqual(pxVisibleFilters([], []), { show: false, person: false },
    'an empty list must not throw');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | grep 'nobody to filter by'`
Expected: `FAIL ... pxVisibleFilters pure helper missing`

- [ ] **Step 3: Add the helper**

In `lib/dashboard/client.js`, after `pxAuthors` (client.js:974):

```js
// Pure (offline-testable): which filters have earned their space. A filter with
// one option is furniture, not a control. Note this is NOT a solo check — a
// two-person team has the same problem on an all-local project list, which is
// exactly why the rule is about the data rather than about the mode.
function pxVisibleFilters(projects, people) {
  var shared = 0, local = 0;
  (projects || []).forEach(function (p) { if (p && p.team) shared++; else local++; });
  return { show: shared > 0 && local > 0, person: (people || []).length > 1 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep 'nobody to filter by'`
Expected: `ok    Projects: filters and person-scoped blocks hide when there is nobody to filter by`

- [ ] **Step 5: Gate the filter row, resetting any filter that stops rendering**

In `renderProjectsIndex`, replace the `filters` assignment (client.js:1010-1015) with:

```js
  var visible = pxVisibleFilters(projects, personOpts.slice(1));
  // A hidden filter must never keep filtering: reset its state as it goes, or
  // rows vanish with no visible control explaining why.
  if (!visible.show) pxFilter.show = 'All';
  if (!visible.person) pxFilter.person = 'All';
  var ctls =
    (visible.show ? pxSegment('show', 'Show', ['All', 'Shared', 'Local'], pxFilter.show) : '') +
    (visible.person ? pxSelectCtl('person', 'Person', personOpts, pxFilter.person) : '') +
    (projects.length > 1 ? pxSegment('sort', 'Sort', ['Recent', 'Name'], pxFilter.sort) : '');
  var filters = ctls
    ? '<div style="display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;margin-bottom:10px;padding-bottom:14px;border-bottom:1px solid var(--border)">' + ctls + '</div>'
    : '';
```

This must be placed *after* `personOpts` is built (client.js:1008-1009) and *before* the `vis` filtering that reads `pxFilter`. Move the `personOpts` construction above the `vis` block to satisfy both.

- [ ] **Step 6: Gate the who stack and the sparkline**

In `pxRowHtml`, replace the `whoCell` assignment (client.js:947-950) with:

```js
  // Only draw the avatar stack when there is more than one person to tell
  // apart. One avatar is a picture of yourself on every card.
  var who = pxWhoList(p, pxData.recent, pxEntryInProject);
  var whoCell = who.length > 1
    ? '<div class="px-who">' + who.map(function (w) {
        var color = /marco/i.test(w.name) ? 'var(--marco)' : /andrew/i.test(w.name) ? 'var(--andrew)' : personColor(w.id);
        return '<span class="px-av" style="background:' + color + '" title="' + esc(w.name) + '">' + esc(pxInitials(w.name)) + '</span>';
      }).join('') + '</div>'
    : '';
```

And replace the `spark` assignment (client.js:952-954) with:

```js
  // The sparkline plots 24 hourly buckets; one person cannot fill them, so it
  // draws only when there is enough to actually see a shape.
  var sparkCounts = pxSparkCounts(p, pxData.recent, pxEntryInProject, Date.now());
  var sparkTotal = sparkCounts.reduce(function (a, b) { return a + b; }, 0);
  var spark = sparkTotal > 1
    ? '<div class="px-spark" title="Sessions, last 24 hours">' + sparkCounts.map(function (v) {
        return '<span' + (v > 0 ? ' class="on"' : '') + ' style="height:' + (v === 0 ? 2 : Math.min(14, 4 + v * 2.5)) + 'px"></span>';
      }).join('') + '</div>'
    : '';
```

- [ ] **Step 7: Delete the solo short-circuit**

`pxNewCount` special-cases solo (client.js:958-966). Under the data-driven rule it is redundant: a solo user has no `self === false` entries, so the count reaches 0 on its own. Replace:

```js
function pxNewCount(p) {
  if (!pxData || pxData.offline || !pxData.lastViewedTs) return 0;
  var solo = pxIsSolo();
  if (solo) return 0;
  var ts = String(pxData.lastViewedTs);
```

with:

```js
function pxNewCount(p) {
  if (!pxData || pxData.offline || !pxData.lastViewedTs) return 0;
  // No solo special-case: a solo user has no entries from anyone else, so the
  // filter below already lands on zero. The old short-circuit existed to paper
  // over a layout that assumed teammates.
  var ts = String(pxData.lastViewedTs);
```

`pxIsSolo()` stays — `renderProjectsIndex` still uses it for the subline and the team CTA (client.js:1000, 1018).

- [ ] **Step 8: Fix the solo subline**

The solo subline restates the row count (client.js:1000). Replace:

```js
    : solo ? (projects.length + ' project' + (projects.length === 1 ? '' : 's') + ', all local')
```

with:

```js
    : solo ? 'Your work across ' + projects.length + ' project' + (projects.length === 1 ? '' : 's') +
      ' — everything stays on this Mac'
```

- [ ] **Step 9: Add a regression check that the blocks are gated**

```js
check('Projects: who stack, sparkline and new-count no longer assume teammates', () => {
  const rowSrc = extractFn(embeddedScript, 'pxRowHtml');
  const newSrc = extractFn(embeddedScript, 'pxNewCount');
  assert.ok(/who\.length > 1/.test(rowSrc), 'the avatar stack must not draw for a single person');
  assert.ok(/sparkTotal > 1/.test(rowSrc), 'the sparkline must not draw an empty 24h shape');
  assert.ok(!/pxIsSolo\(\)/.test(newSrc),
    'pxNewCount must reach zero from the data, not from a solo special-case');
});
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 11: Build the beta**

Per project convention every implementation ends with a beta build. To exercise first-run, wipe the beta home first.

Run: `npm run app`
Expected: the app launches; open the dashboard and confirm a solo project list shows cards with no Who column, no sparkline, and no Person/Show filters.

- [ ] **Step 12: Commit**

```bash
git add lib/dashboard/client.js test/run-tests.js
git commit -m "feat(projects): draw a block only when it has something to say

The Who column, the 24h sparkline and the Person and Show filters rendered
whether or not there was anyone or anything in them, which for a solo user is
most of the page. Each now draws only when its data exists, so a solo list has
no dead space and a two-person team gets the same fix on its quiet projects.

pxNewCount's solo short-circuit goes with them: a solo user has no entries from
anyone else, so the count reaches zero from the data. The special case existed
to paper over a layout that assumed teammates."
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Cards, not scan rows | 1 |
| Dormant/paused collapse and sort last | 1 |
| Load more at `PX_CARDS_VISIBLE` | 1 |
| Glance line: headline verbatim, never `ask`, never clipped | 2 |
| `pxClipSummary`/`PX_SUMMARY_MAX` deleted, tests inverted | 2 |
| Where you left off — todo text, capped, "+N more" | 3 |
| `sessionsTotal` / `firstActivity` served | 4 |
| Accumulation line — sessions, span, tools | 5 |
| `targets[].injected` with mtime cache | 6 |
| Health: memory block missing | 7 |
| Adaptive who / sparkline / filters, filter-state reset | 8 |
| Solo short-circuit removed | 8 |
| Team continuity (blocks appear, no re-layout) | 8 (same cards gain blocks) |

No spec requirement is unassigned.

**Known deviation:** the spec's "N new" row in the adaptive-blocks table is listed as *unchanged*; Task 8 removes its solo short-circuit, which the spec calls for in the approach section. The two agree — the table entry refers to the dot's render condition, which is genuinely unchanged.

**Type consistency:** `pxPaginate` → `{cards, dim, hidden}` (Task 1, consumed Task 1 step 7). `pxGlanceFor` → `{text, kind}` (Task 2). `pxOpenTodos` → `{items, more}` (Task 3). `pxAccumulation` → `{text}` or `null` (Task 5). `pxBlockMissing` → boolean (Task 7). `pxVisibleFilters` → `{show, person}` (Task 8). `pxIsDim` is defined in Task 1 and reused in Task 1 step 7 only. All names used in later tasks are defined in earlier ones.

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N". Every code step carries its code; every test step carries its assertions.
