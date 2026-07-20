# Activity Display: Outcome Headlines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every activity card lead with a one-glance outcome — never harvested AI monologue, a raw error prompt, or a mid-sentence blob — per [the spec](../specs/2026-07-20-activity-display-headline-design.md).

**Architecture:** Four deltas. (1) An optional `headline` field on distilled summaries plumbed hooks→scan→feed. (2/3) Pure client helpers `firstSentence`/`askHeadline`/`runHeadline` that decide the card's main line, banning harvested prose and guarding noisy live asks. (4) A 2-line CSS clamp plus moving the full `did` into the expander, wired into `threadHtml` and `unitHtml`.

**Tech Stack:** Zero-dependency Node (CommonJS) for hooks/scan/feed; the dashboard cards are functions inside the **client-side embedded `<script>`** of `lib/dashboard.js`, tested by extracting the function source from the rendered page (`extractFn(embeddedScript, name)`) and asserting on source and/or evaluating it. Custom harness `test/run-tests.js` (`check(name, fn)` + `assert`), run with `node test/run-tests.js`. Baseline 436/436.

**Conventions:** Commit `<type>: <description>`, no attribution footer. TDD: failing test first. Client card fns use `var`, `esc()`, and CSS vars.

---

### Task 1: `headline` field plumbing (hooks → scan → feed)

**Files:** Modify `lib/hooks.js` (`blockReason`, `runAppend`), `lib/scan.js` (`scanSummaries`), `lib/feed.js` (both normalizers). Test: `test/run-tests.js`.

- [ ] **Step 1: Failing tests**

Add near the existing `blockReason`/append checks:

```js
  check('headline: blockReason asks for a short headline field', () => {
    const r = hooks.blockReason('/p/.membridge/summaries.jsonl', 's1', 0);
    assert.ok(/"headline"/.test(r), 'JSON template includes headline');
    assert.ok(/10 words|glance/i.test(r), 'headline guidance present');
  });
  check('headline: append accepts a line with headline and one without; rejects non-string headline', () => {
    const proj = path.join(ROOT, 'projects', 'hl-app'); fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const base = { session: 's1', ts: '2026-07-20T00:00:00Z', did: 'did a thing' };
    const run = obj => spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'membridge-hook.js'), 'append', target, JSON.stringify(obj)], { encoding: 'utf8' });
    assert.strictEqual(run({ ...base, headline: 'Short outcome' }).status, 0, 'headline line rejected');
    assert.strictEqual(run(base).status, 0, 'headline-less line rejected');
    assert.notStrictEqual(run({ ...base, headline: 42 }).status, 0, 'non-string headline accepted');
  });
  check('headline: scanSummaries carries headline when present', () => {
    const proj = path.join(ROOT, 'projects', 'hl-scan'); fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.membridge', 'summaries.jsonl'),
      JSON.stringify({ session: 's1', ts: '2026-07-20T00:00:00Z', did: 'full did', headline: 'tight line' }) + '\n');
    const st = { projects: { [proj]: { events: [] } }, files: {} };
    const evs = require('../lib/scan').scanSummaries(st, {});
    const ev = evs.find(e => e.session === 's1');
    assert.ok(ev && ev.headline === 'tight line', 'headline not carried by scanSummaries');
  });
  check('headline: feed normalizeLocal carries headline', () => {
    const row = feed.__normalizeLocalForTest
      ? feed.__normalizeLocalForTest({ session: 's', headline: 'H', did: 'D', summary: 'D' }, { projectPath: '/p' })
      : null;
    // If no test hook exists, assert via buildFeed path instead (see impl note).
    if (row) assert.strictEqual(row.headline, 'H', 'headline not carried by feed');
  });
```

Note: if `scanSummaries` isn't exported, export it (mirrors other exports in scan.js). For the feed check, prefer an existing feed-building test path; only add `__normalizeLocalForTest` if the file already exposes such hooks — otherwise assert `headline` presence through the same payload path other feed tests use, and delete the placeholder branch.

- [ ] **Step 2: Run — expect FAIL** (`node test/run-tests.js 2>&1 | grep -i headline`).

- [ ] **Step 3: Implement**

`lib/hooks.js` `blockReason` — add to the JSON template (after `did`) `"headline":"..."` and add guidance in the field list: `headline: ≤10 words, the single outcome a teammate reads at a glance, or "";`. Keep the existing shell-escaping and command shape.

`lib/hooks.js` `runAppend` — after the `did` check, add:
```js
  if (e.headline !== undefined && typeof e.headline !== 'string') return fail('invalid line: "headline" must be a string when present');
```

`lib/scan.js` `scanSummaries` — where it copies `goal`/`decisions`/`gotchas`:
```js
      const headline = str(e.headline);
      if (headline) ev.headline = headline;
```

`lib/feed.js` — in BOTH `normalizeLocal` and `normalizeTeam`, add next to `goal`:
```js
    headline: applyRedact(redact, e.headline) || null,   // normalizeLocal: e.headline
    headline: applyRedact(redact, row.headline) || null, // normalizeTeam: row.headline
```

- [ ] **Step 4: Run — expect PASS**, full suite still green (437+ / total).

- [ ] **Step 5: Commit** `feat: carry optional headline field through summaries pipeline`

---

### Task 2: pure client headline helpers

**Files:** Modify `lib/dashboard.js` (embedded client `<script>`, near the other card helpers before `threadHtml`). Test: `test/run-tests.js`.

- [ ] **Step 1: Failing tests** (extract sources + eval)

```js
  check('headline helpers: firstSentence / askHeadline behavior', () => {
    const src = ['esc', 'firstSentence', 'askHeadline'].map(n => extractFn(embeddedScript, n)).join('\n');
    const sandbox = new Function(src + '\nreturn { firstSentence: firstSentence, askHeadline: askHeadline };')();
    assert.strictEqual(sandbox.firstSentence('One thing. Two thing.'), 'One thing.');
    assert.strictEqual(sandbox.firstSentence(''), '');
    assert.ok(sandbox.firstSentence('x'.repeat(200)).length <= 92, 'not capped');
    assert.strictEqual(sandbox.askHeadline(''), null);
    assert.strictEqual(sandbox.askHeadline('Add a logout button'), 'Add a logout button');
    assert.strictEqual(sandbox.askHeadline('Install failed: Error at /x lockdownd\n\n\nstack'), null, 'noisy ask not degraded');
  });
```

(`extractFn` and `embeddedScript` are already in scope in that test section; if this new check lives outside that section, compute `embeddedScript` the same way it is computed there — from the rendered dashboard page — or move the check inside it.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** — add to the embedded client script (before `threadHtml`):

```js
// One-glance helpers for card headlines (see specs/2026-07-20-activity-display-headline).
function firstSentence(text) {
  var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  var m = s.match(/^(.+?[.!?])(\s|$)/);
  var out = m ? m[1] : s;
  return out.length > 90 ? out.slice(0, 89).replace(/\s+\S*$/, '') + '…' : out;
}
// Returns the safe ask text for a live headline, or null to show "Working…".
function askHeadline(ask) {
  var raw = String(ask == null ? '' : ask);
  var s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  var noisy = s.length > 120
    || /(Error|Exception|failed:|Traceback|LOCKDOWN|at\s+\/)/.test(s)
    || (raw.match(/\n/g) || []).length >= 3;
  return noisy ? null : firstSentence(s);
}
// The card's main line. Distilled headline/first-sentence wins; harvested prose
// is NEVER used; live shows a guarded ask; finished falls back to the ask's first
// sentence, else a plain placeholder. Returns already-escaped HTML.
function runHeadline(rep, newest, live) {
  if (rep) return esc(rep.headline || firstSentence(rep.summary));
  if (live) {
    var a = askHeadline(newest && newest.ask);
    return a
      ? '<span style="color:var(--amber)">Working on:&nbsp;</span>' + esc(a)
      : '<span style="color:var(--amber)">Working…</span>';
  }
  var ask = newest && newest.ask ? firstSentence(newest.ask) : '';
  return ask ? esc(ask) : '<span style="color:var(--text3)">session ended · no summary shared</span>';
}
```

- [ ] **Step 4: Run — expect PASS**, full suite green.

- [ ] **Step 5: Commit** `feat: pure card-headline helpers (firstSentence, askHeadline, runHeadline)`

---

### Task 3: wire helpers into cards + clamp + expander

**Files:** Modify `lib/dashboard.js` (`threadHtml` ~2440, `unitHtml` ~2524, and the run-thread label inside `unitHtml`). Test: `test/run-tests.js`.

- [ ] **Step 1: Failing tests** (assert on function source)

```js
  check('cards: headline uses runHeadline and never repHarvested; headline clamps', () => {
    const th = extractFn(embeddedScript, 'threadHtml');
    const uh = extractFn(embeddedScript, 'unitHtml');
    assert.ok(/runHeadline\(/.test(th) && /runHeadline\(/.test(uh), 'cards do not call runHeadline');
    assert.ok(!/repHarvested\)\s*\?/.test(th) && !/repHarvested\)\s*\?/.test(uh), 'repHarvested still in a headline ternary');
    assert.ok(/-webkit-line-clamp:2/.test(th), 'headline is not 2-line clamped');
  });
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

In `threadHtml`, replace the `var headline = t.rep ? ... : live ? ... : (t.repHarvested ? ...)` block with:
```js
  var headline = runHeadline(t.rep, newest, live);
```
In `unitHtml`, replace the analogous `var headline = u.rep ? esc(u.rep.rep.summary) : u.live ? ... : (harvested ? ...)` block with:
```js
  var headline = runHeadline(u.rep && u.rep.rep, newest, u.live);
```
(Confirm `u.rep.rep` is the distilled summary object on a unit — match the existing `u.rep.rep.summary` access; if the shape differs, pass whatever object exposes `.headline`/`.summary`.) Remove the now-unused `harvested` local ONLY if nothing else uses it; if the expander uses it, leave it.

In the per-run agent-thread label inside `unitHtml` (the `u.runs.slice().reverse().map` block, `rlabel`), replace its `r.rep ? esc(r.rep.summary) : rlive ? ... : (r.repHarvested ? ...)` with `runHeadline(r.rep, r.entries[0], rlive)`.

Add the 2-line clamp to the headline `<div>` in BOTH cards — change the headline div's inline style to include:
```
display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
```
Clamp the Intent and decisions·gotchas sublines to one line each (append `white-space:nowrap;overflow:hidden;text-overflow:ellipsis` to `.fmeta-row`/`.fsub` inline, or add a scoped class).

Move the FULL outcome into the expander: at the top of the expanded body (the `kidsBlock`/`body` string), when `t.rep`/`u.rep` exists, prepend the full text:
```js
  var fullBrief = (t.rep && (t.rep.summaryFull || t.rep.summary))
    ? '<div class="fd-label">Summary</div><div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:10px">' + esc(t.rep.summaryFull || t.rep.summary) + '</div>'
    : '';
```
and include `fullBrief` before the existing `changesBlock` in the expanded body. Mirror in `unitHtml` using `u.rep && u.rep.rep`.

- [ ] **Step 4: Run — expect PASS**, full suite green. Also render a card manually if practical; at minimum confirm no template/JS syntax error by loading the dashboard page in a test (the existing embedded-script extraction tests will fail loudly on a broken script).

- [ ] **Step 5: Commit** `feat: cards lead with outcome headline, clamp, full brief in expander`

---

### Task 4: docs, verify, rebuild

**Files:** `CHANGELOG.md`.

- [ ] **Step 1:** Add a CHANGELOG bullet under `## Unreleased` (create if absent):
```markdown
- **Activity cards lead with a one-glance outcome.** Distilled summaries carry an
  optional short `headline`; cards never headline with harvested AI monologue, guard
  noisy live prompts to "Working…", clamp to two lines, and move the full summary
  into the expander.
```
- [ ] **Step 2:** `node test/run-tests.js 2>&1 | tail -2` — full suite green, 0 failures.
- [ ] **Step 3: Commit** `docs: changelog for outcome headlines`.
- [ ] **Step 4: Rebuild** — handled by the coordinator after merge (merge feat/activity-headline → master, `npm run dist:mac`, reinstall `/Applications`). Do NOT run build/install commands inside task execution.

---

## Verification against spec
- Delta 1 (headline field, no migration) → Task 1. Delta 2 (picker bans harvested) → Tasks 2–3. Delta 3 (live-ask guard) → Task 2 `askHeadline`, wired Task 3. Delta 4 (clamp + expander) → Task 3. Pure/total helpers, tested → Tasks 2–3.
