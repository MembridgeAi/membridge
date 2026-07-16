# Session Runs & Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship stages 2–4 of the [runs-and-threads spec](../specs/2026-07-16-session-runs-and-threads-design.md): suggestion cards for untracked repos a session edited, one feed card per `(session, project)` run instead of per ask, and a quiet "continues earlier work" thread caption linking related runs.

**Architecture:** Stage 2 extends `lib/project-resolve.js` with an untracked-git-root collector, folds candidates into `state.suggestedRoots` during `syncOnce`, and mirrors the existing auto-link suggestion card/endpoint pattern (`/api/team/suggestion` → new `/api/repo-suggestion`). Stage 3 threads `session` through the feed normalizers, adds a pure `feed.groupRuns(entries)` that buckets normalized entries into runs, has `feedPayload` return `runs` alongside `entries` (catch-up and project pages keep using `entries`), and renders Home from runs. Stage 4 adds a pure `lib/threads.js` matcher whose captions attach to runs server-side and render as a clickable caption line. Storage format never changes — events stay events; everything new is derived at read time.

**Tech Stack:** Node.js (CommonJS, zero runtime deps), custom test harness `test/run-tests.js` (`check(name, fn)`, `npm test`; async work is `await`ed inside `main()` *outside* the sync `check` blocks), dashboard = ES5-style client JS embedded in `lib/dashboard.js`'s page template.

**Scope notes (locked in the spec):**
- Suggest-only: nothing is ever auto-tracked. Dismissal is permanent (until manually tracked).
- Runs group at render time; entries without a session id stay per-ask singleton cards.
- Stage 3 changes the **Home feed only**. Project pages and Catch-Up keep per-ask entries (a project page is the detail view; finer grain is a feature there).
- Threads are a **caption**, not a structure. Same project only, 14-day window, ≥2 shared non-dependency files.
- A run split across a "Load more" page boundary shows only its newest page's asks until the next full poll — accepted v1 tradeoff, commented in code.

---

## Data contracts

**Suggestion state** (in `~/.membridge/state.json`, written by scan):
```
state.suggestedRoots = { [normPath(root)]: { root, count, lastTs, firstSeen } }
state.dismissedRoots = { [normPath(root)]: "<ISO ts of dismissal>" }
```

**Normalized feed entry** (`feed.normalizeLocal` / `normalizeTeam`): existing shape **plus `session: string`** (`''` when absent).

**Run** (`feed.groupRuns` output):
```
{ key, origin, self, author, authorId, source,
  project, projectPath, projectId, session,
  ts,            // latest entry ts (sort key)
  tsStart,       // earliest entry ts
  ask,           // the OPENING ask (names the run, same rule as digest.sessionGroups)
  asks,          // [{ts, ask}] oldest-first
  askCount,
  files,         // union, deduped, insertion order
  summary, distilled, goal, decisions, gotchas, checkpoints, changes,  // from the LATEST summary-bearing entry, as a unit
  tasks,         // from the latest entry that carried tasks
  thread }       // optional, attached by server: see caption below
```

**Thread caption** (`threads.threadCaptions` value, keyed by run key):
```
{ kind: 'continues' | 'teammate', target: <other run's key>,
  author, authorId, ts: <other run's ts>, sharedFiles: [up to 5] }
```

## File structure

- **Modify** `lib/project-resolve.js` — add `untrackedRepoRoots(events, trackedRoots, opts)` (+ private `untrackedGitRoot`); needs `os` require.
- **Modify** `lib/scan.js` — new exported `updateSuggestedRoots(state, events, opts)`; called from `syncOnce` right after `rehomeEvents`.
- **Modify** `lib/server.js` — `feedPayload` gains `repoSuggestions` and `runs` (+ `thread` on runs); new exported `resolveRepoSuggestion(root, action)`; new route `POST /api/repo-suggestion`.
- **Modify** `lib/feed.js` — `session` in both normalizers; new `runKey` + `groupRuns` exports.
- **Create** `lib/threads.js` — pure `threadCaptions(runs, opts)` (~50 lines).
- **Modify** `lib/dashboard.js` — `repoSuggestCardHtml`, Home renders runs, `feedEntryHtml` folds asks + thread caption, delegated click handlers, ~3 CSS rules.
- **Modify** `test/run-tests.js` — new `check(...)` blocks per task (placement noted per task).
- **Modify** `README.md`, `CHANGELOG.md` — Task 12.

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
git checkout master && git pull --ff-only 2>/dev/null; git checkout -b feat/runs-and-threads
```

---

## Stage 2 — Detect & suggest untracked repos

### Task 1: `untrackedRepoRoots` collector in project-resolve

**Files:**
- Modify: `lib/project-resolve.js`
- Test: `test/run-tests.js` (append next to the existing `project-resolve:` checks, near line ~4003)

- [ ] **Step 1: Write the failing tests**

```js
check('project-resolve: untrackedRepoRoots collects untracked git roots with counts', () => {
  const { normPath } = require('../lib/util');
  const tracked = new Set([normPath('/root/tracked')]);
  const hasGit = d => d === '/root/newrepo' || d === '/root/tracked';
  const hasMembridge = () => false;
  const events = [
    { kind: 'edit', project: '/launch', session: 's1', ts: '2026-07-16T10:00:00Z', file: '/root/newrepo/src/a.js' },
    { kind: 'edit', project: '/launch', session: 's1', ts: '2026-07-16T11:00:00Z', file: '/root/newrepo/src/b.js' },
    { kind: 'edit', project: '/launch', session: 's1', ts: '2026-07-16T09:00:00Z', file: '/root/tracked/c.js' },  // tracked → not a candidate
    { kind: 'edit', project: '/launch', session: 's1', ts: '2026-07-16T09:00:00Z', file: '/root/loose/d.js' },    // no repo at all → not a candidate
    { kind: 'prompt', project: '/launch', session: 's1', ts: '2026-07-16T09:00:00Z', text: 'go' },                // non-edit → ignored
  ];
  const m = projectResolve.untrackedRepoRoots(events, tracked,
    { hasGit, hasMembridge, homedir: '/home/me', tmpdir: '/mb-no-tmp' });
  assert.strictEqual(m.size, 1);
  const cand = m.get(normPath('/root/newrepo'));
  assert.ok(cand, 'the untracked repo is a candidate');
  assert.strictEqual(cand.count, 2);
  assert.strictEqual(cand.lastTs, '2026-07-16T11:00:00Z');
});

check('project-resolve: untrackedRepoRoots never suggests home, tmp, or node_modules', () => {
  const hasGit = d => d === '/home/me' || d === '/mb-tmp/scratch' || d === '/root/app/node_modules/dep';
  const events = [
    { kind: 'edit', project: '/x', session: 's', ts: '2026-07-16T10:00:00Z', file: '/home/me/notes.md' },
    { kind: 'edit', project: '/x', session: 's', ts: '2026-07-16T10:00:00Z', file: '/mb-tmp/scratch/t.js' },
    { kind: 'edit', project: '/x', session: 's', ts: '2026-07-16T10:00:00Z', file: '/root/app/node_modules/dep/i.js' },
  ];
  const m = projectResolve.untrackedRepoRoots(events, new Set(),
    { hasGit, hasMembridge: () => false, homedir: '/home/me', tmpdir: '/mb-tmp' });
  assert.strictEqual(m.size, 0);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test 2>&1 | grep -E "FAIL|untrackedRepoRoots"`
Expected: both new checks `FAIL` with `projectResolve.untrackedRepoRoots is not a function`.

- [ ] **Step 3: Implement**

In `lib/project-resolve.js`, add `const os = require('os');` under the existing requires, then append before `module.exports`:

```js
// The git root containing `file` when that repo is NOT tracked, else null.
// Mirror of resolveRoot's walk with the outcomes flipped: reaching a tracked
// root / .membridge first means the edit is already homed (null); reaching an
// untracked .git root first makes that root a suggestion candidate.
function untrackedGitRoot(file, trackedRoots, opts = {}) {
  const hasMembridge = opts.hasMembridge || defaultHasMembridge;
  const hasGit = opts.hasGit || defaultHasGit;
  let dir = path.dirname(path.resolve(String(file)));
  for (;;) {
    if (trackedRoots.has(normPath(dir)) || hasMembridge(dir)) return null;
    if (hasGit(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Aggregate a scan pass's untracked-repo candidates from its edit events:
// Map(normRoot -> { root, count, lastTs }). The home directory itself, temp
// dirs, and anything inside node_modules are noise, never suggestions.
// homedir/tmpdir are injectable so tests can use real temp fixtures.
function untrackedRepoRoots(events, trackedRoots, opts = {}) {
  const home = normPath(opts.homedir || os.homedir());
  const tmp = normPath(opts.tmpdir || os.tmpdir());
  const memo = new Map(); // dirname -> root|null, one walk per directory per pass
  const out = new Map();
  for (const ev of events) {
    if (ev.kind !== 'edit' || !ev.file) continue;
    const abs = absEditFile(ev);
    const dirKey = path.dirname(path.resolve(abs));
    if (!memo.has(dirKey)) memo.set(dirKey, untrackedGitRoot(abs, trackedRoots, opts));
    const root = memo.get(dirKey);
    if (!root) continue;
    const norm = normPath(root);
    if (norm === home) continue;
    if (norm === tmp || norm.startsWith(tmp + path.sep)) continue;
    if (norm.split(/[\\/]/).includes('node_modules')) continue;
    const prev = out.get(norm) || { root, count: 0, lastTs: '' };
    prev.count++;
    if (String(ev.ts || '') > prev.lastTs) prev.lastTs = String(ev.ts);
    out.set(norm, prev);
  }
  return out;
}
```

Extend the exports line:

```js
module.exports = { resolveRoot, rehomeEvents, sessionDominantRoot, untrackedRepoRoots };
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test 2>&1 | grep -E "FAIL|untrackedRepoRoots"`
Expected: both checks print `ok`, no `FAIL` lines anywhere.

- [ ] **Step 5: Commit**

```bash
git add lib/project-resolve.js test/run-tests.js
git commit -m "feat: collect untracked git roots a session edited (suggestion candidates)"
```

### Task 2: Fold candidates into state during sync

**Files:**
- Modify: `lib/scan.js` (function after `trackedRoots`, call site in `syncOnce`, exports)
- Test: `test/run-tests.js` (append next to the existing `scan:` checks, near line ~407)

- [ ] **Step 1: Write the failing test**

Real temp dirs so the default `.git` disk check runs; the real tmpdir hosts the fixture, so the scratch filter is lifted via the injectable `tmpdir`:

```js
check('scan: untracked repo edits become suggestions; dismissal and tracking prune them', () => {
  const scanLib = require('../lib/scan');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-suggest-'));
  const repo = path.join(base, 'fresh-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const norm = util.normPath(repo);
  const events = [
    { kind: 'edit', project: base, session: 's9', ts: '2026-07-16T10:00:00Z', file: path.join(repo, 'src', 'a.js') },
    { kind: 'edit', project: base, session: 's9', ts: '2026-07-16T11:00:00Z', file: path.join(repo, 'src', 'b.js') },
  ];
  const opts = { tmpdir: '/mb-not-tmp' };

  const state = { projects: {} };
  scanLib.updateSuggestedRoots(state, events, opts);
  assert.ok(state.suggestedRoots[norm], 'suggestion recorded');
  assert.strictEqual(state.suggestedRoots[norm].count, 2);
  assert.strictEqual(state.suggestedRoots[norm].lastTs, '2026-07-16T11:00:00Z');
  assert.ok(state.suggestedRoots[norm].firstSeen, 'firstSeen stamped');

  // a second pass accumulates counts instead of resetting
  scanLib.updateSuggestedRoots(state, events, opts);
  assert.strictEqual(state.suggestedRoots[norm].count, 4);

  // dismissal prunes it and blocks resurfacing
  state.dismissedRoots = { [norm]: '2026-07-16T12:00:00Z' };
  scanLib.updateSuggestedRoots(state, events, opts);
  assert.ok(!state.suggestedRoots[norm], 'dismissed root pruned and never re-added');

  // a now-tracked root is pruned too
  delete state.dismissedRoots[norm];
  scanLib.updateSuggestedRoots(state, events, opts);
  assert.ok(state.suggestedRoots[norm], 'back after undismiss');
  state.projects[repo] = { events: [] };
  scanLib.updateSuggestedRoots(state, [], opts);
  assert.ok(!state.suggestedRoots[norm], 'tracked root pruned');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test 2>&1 | grep -E "FAIL|become suggestions"`
Expected: `FAIL` with `scanLib.updateSuggestedRoots is not a function`.

- [ ] **Step 3: Implement**

In `lib/scan.js`, add after the `trackedRoots` function:

```js
// Fold this pass's untracked-repo candidates into state.suggestedRoots,
// honoring dismissals and pruning entries that stopped qualifying (tracked
// now, dismissed, or gone from disk). Suggest-only: nothing is ever tracked
// here — the user confirms from the dashboard card. Counts accumulate across
// passes because offsets mean each pass only sees new events.
function updateSuggestedRoots(state, events, opts = {}) {
  const dismissed = state.dismissedRoots || {};
  const suggested = state.suggestedRoots || (state.suggestedRoots = {});
  const found = projectResolve.untrackedRepoRoots(events, trackedRoots(state), opts);
  for (const [norm, cand] of found) {
    if (dismissed[norm]) continue;
    const prev = suggested[norm];
    suggested[norm] = {
      root: cand.root,
      count: (prev ? prev.count : 0) + cand.count,
      lastTs: prev && String(prev.lastTs) > String(cand.lastTs) ? prev.lastTs : cand.lastTs,
      firstSeen: prev ? prev.firstSeen : new Date().toISOString(),
    };
  }
  const tracked = trackedRoots(state);
  for (const [norm, s] of Object.entries(suggested)) {
    let stale = !!dismissed[norm] || tracked.has(norm);
    if (!stale) { try { stale = !fs.statSync(s.root).isDirectory(); } catch { stale = true; } }
    if (stale) delete suggested[norm];
  }
}
```

In `syncOnce`, directly under the existing `projectResolve.rehomeEvents(...)` line (lib/scan.js:156), add:

```js
  updateSuggestedRoots(state, events);
```

Extend the exports line:

```js
module.exports = { readNewLines, getAdapters, scanAll, scanSummaries, syncOnce, findProjectKey, trackedRoots, updateSuggestedRoots };
```

(Existing e2e fixtures all live under `os.tmpdir()`, so the default scratch filter keeps `syncOnce`-based tests suggestion-free — no other test should change.)

- [ ] **Step 4: Run the FULL suite, verify green**

Run: `npm test 2>&1 | tail -5`
Expected: no `FAIL` lines; summary reports all checks passing.

- [ ] **Step 5: Commit**

```bash
git add lib/scan.js test/run-tests.js
git commit -m "feat: persist untracked-repo suggestions in state during sync"
```

### Task 3: Server — expose suggestions, track/dismiss endpoint

**Files:**
- Modify: `lib/server.js` (`feedPayload` ~line 194, new function near `addProject` ~line 394, route near `/api/team/suggestion` ~line 866, exports line ~1029, and the `require('./util')` destructuring at the top — add `normPath` if not present)
- Test: `test/run-tests.js` (inside `main()`, near the existing `feedPayload` awaits ~line 1504)

- [ ] **Step 1: Write the failing tests**

```js
  // --- repo suggestions: track / dismiss ---
  const rsBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rs-'));
  const rsRepoA = path.join(rsBase, 'repo-a');
  const rsRepoB = path.join(rsBase, 'repo-b');
  for (const r of [rsRepoA, rsRepoB]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
  {
    const st = util.loadState();
    st.suggestedRoots = {
      [util.normPath(rsRepoA)]: { root: rsRepoA, count: 3, lastTs: '2026-07-16T10:00:00Z', firstSeen: '2026-07-16T09:00:00Z' },
      [util.normPath(rsRepoB)]: { root: rsRepoB, count: 1, lastTs: '2026-07-16T11:00:00Z', firstSeen: '2026-07-16T09:00:00Z' },
    };
    util.saveState(st);
  }
  const rsFeed = await feedPayload({ limit: 5 });
  check('feedPayload: exposes repoSuggestions ranked by edit count', () => {
    assert.ok(Array.isArray(rsFeed.repoSuggestions));
    assert.strictEqual(rsFeed.repoSuggestions.length, 2);
    assert.strictEqual(rsFeed.repoSuggestions[0].root, rsRepoA, 'more edits ranks first');
    assert.strictEqual(rsFeed.repoSuggestions[0].name, 'repo-a');
    assert.strictEqual(rsFeed.repoSuggestions[0].count, 3);
  });
  check('server: resolveRepoSuggestion track adds the project; dismiss blocks it', () => {
    const { resolveRepoSuggestion } = require('../lib/server');
    const tracked = resolveRepoSuggestion(rsRepoA, 'track');
    assert.strictEqual(tracked.tracked, true);
    let st = util.loadState();
    assert.ok(st.projects[rsRepoA], 'project registered via addProject path');
    assert.ok(!(st.suggestedRoots || {})[util.normPath(rsRepoA)], 'suggestion consumed');

    const dismissed = resolveRepoSuggestion(rsRepoB, 'dismiss');
    assert.strictEqual(dismissed.dismissed, true);
    st = util.loadState();
    assert.ok(st.dismissedRoots[util.normPath(rsRepoB)], 'dismissal recorded');
    assert.ok(!(st.suggestedRoots || {})[util.normPath(rsRepoB)], 'suggestion consumed');

    assert.ok(resolveRepoSuggestion('/nope', 'track').error, 'unknown root errors');
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test 2>&1 | grep -E "FAIL|repoSuggestion"`
Expected: both `FAIL` (`repoSuggestions` undefined; `resolveRepoSuggestion` not exported).

- [ ] **Step 3: Implement**

(a) In `feedPayload`, right after the existing `suggestions` block (~line 198), add:

```js
  // Untracked repos this machine's sessions edited (Stage 2 of the runs-and-
  // threads spec) — suggest-only cards, ranked by edit count. Existence is
  // re-checked at read time; scan prunes stale entries on its next pass.
  const repoSuggestions = Object.values(state.suggestedRoots || {})
    .filter(s => { try { return fs.statSync(s.root).isDirectory(); } catch { return false; } })
    .sort((a, b) => (b.count - a.count) || String(b.lastTs).localeCompare(String(a.lastTs)))
    .slice(0, 3)
    .map(s => ({ root: s.root, name: path.basename(s.root), count: s.count, lastTs: s.lastTs }));
```

and add `repoSuggestions` to `feedPayload`'s return object (the `return { ...out, signedIn... }` line).

(b) Near `addProject` (~line 394), add:

```js
// Consume an untracked-repo suggestion: 'track' registers the directory via
// the same path as adding a project manually; anything else records a
// permanent dismissal so scan never resurfaces the root.
function resolveRepoSuggestion(root, action) {
  const state = loadState();
  const norm = normPath(path.resolve(String(root || '')));
  const sug = (state.suggestedRoots || {})[norm];
  if (!sug) return { error: 'unknown suggestion' };
  delete state.suggestedRoots[norm];
  if (action === 'track') {
    saveState(state); // addProject re-loads state, so persist the consumed suggestion first
    const added = addProject(sug.root);
    return added.error ? added : { tracked: true, path: added.path };
  }
  state.dismissedRoots = state.dismissedRoots || {};
  state.dismissedRoots[norm] = new Date().toISOString();
  saveState(state);
  return { dismissed: true };
}
```

(c) Route, next to the `/api/team/suggestion` handler (~line 866):

```js
    } else if (req.method === 'POST' && url.pathname === '/api/repo-suggestion') {
      // Track or dismiss an untracked-repo suggestion. Suggest-only:
      // nothing is ever tracked without this explicit user action.
      const body = await readBody(req);
      const root = String(body.root || '').trim();
      if (!root) return json(res, 400, { error: 'root is required' });
      const out = resolveRepoSuggestion(root, String(body.action || ''));
      json(res, out.error ? (out.error === 'unknown suggestion' ? 404 : 400) : 200, out);
```

(d) Add `resolveRepoSuggestion` to `module.exports` (~line 1029), and `normPath` to the `require('./util')` destructuring if it isn't already there.

- [ ] **Step 4: Run the FULL suite, verify green**

Run: `npm test 2>&1 | tail -5` — no `FAIL` lines.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: repo-suggestion feed payload + track/dismiss endpoint"
```

### Task 4: Dashboard — suggestion cards

**Files:**
- Modify: `lib/dashboard.js` (`suggestCardHtml` ~line 1637, `renderHome` ~line 1560, and the Home module's delegated click handler — find it with `grep -n "sug-accept" lib/dashboard.js`)
- Test: `test/run-tests.js` (next to the existing `dashboard: card render` check, ~line 1510)

- [ ] **Step 1: Write the failing test**

```js
    check('dashboard: untracked-repo suggestion card wiring present', () => {
      const html = require('../lib/dashboard').dashboardPage();
      assert.ok(/repoSuggestCardHtml/.test(html), 'card builder present');
      assert.ok(/repo-track/.test(html), 'track button class present');
      assert.ok(/repo-dismiss/.test(html), 'dismiss button class present');
      assert.ok(/api\/repo-suggestion/.test(html), 'endpoint wired');
    });
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test 2>&1 | grep -E "FAIL|repo suggestion card"` — expected `FAIL`.

- [ ] **Step 3: Implement**

All edits are inside the client-JS sections of `lib/dashboard.js` — keep to the surrounding ES5 style (`var`, `function`, string concatenation, `\\u2019`-style escapes).

(a) Below `suggestCardHtml`, add:

```js
// Untracked-repo suggestion card(s): a session edited files in a repo
// MemBridge doesn't track (runs-and-threads spec, Stage 2). Suggest-only —
// nothing happens behind the user's back; Dismiss is permanent.
function repoSuggestCardHtml(d) {
  var list = (d && d.repoSuggestions) || [];
  if (!list.length) return '';
  return list.map(function (s) {
    return '<div class="card slim-suggest"><div class="grow">' +
      '<strong>Track ' + esc(s.name) + '?</strong>' +
      '<small class="path">A session edited ' + s.count + ' file' + (s.count === 1 ? '' : 's') +
      ' in ' + esc(s.root) + ', which isn\\u2019t tracked yet.</small>' +
      '</div>' +
      '<button class="btn primary repo-track" data-root="' + esc(s.root) + '">Track</button>' +
      '<button class="btn repo-dismiss" data-root="' + esc(s.root) + '">Dismiss</button></div>';
  }).join('');
}
```

(b) In `renderHome` (~line 1560), change the `homeSuggest` line to:

```js
  document.getElementById('homeSuggest').innerHTML = suggestCardHtml(d) + repoSuggestCardHtml(d);
```

(c) In the same delegated click handler that handles `.sug-accept` / `.sug-dismiss` (grep `sug-accept`), add sibling branches:

```js
    var rt = e.target.closest('.repo-track, .repo-dismiss');
    if (rt) {
      if (rt.disabled) return;
      rt.disabled = true;
      fetch('/api/repo-suggestion', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: rt.getAttribute('data-root'),
          action: rt.classList.contains('repo-track') ? 'track' : 'dismiss' }),
      }).then(function () { loadHome(); }).catch(function () { setPill(false); rt.disabled = false; });
      return;
    }
```

(Use the same refresh call the `sug-*` handlers use in that module — if they call something other than `loadHome()`, mirror it.)

- [ ] **Step 4: Run the FULL suite, verify green**

Run: `npm test 2>&1 | tail -5` — no `FAIL` lines.

- [ ] **Step 5: Commit — Stage 2 complete**

```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "feat: untracked-repo suggestion cards on the Home feed"
```

---

## Stage 3 — Runs as the feed unit

### Task 5: Carry `session` through the feed normalizers

**Files:**
- Modify: `lib/feed.js` (`normalizeLocal` ~line 19, `normalizeTeam` ~line 46)
- Test: `test/run-tests.js` (next to the existing `feed.normalize*` checks, ~line 3628)

- [ ] **Step 1: Write the failing tests**

```js
  check('feed.normalizeLocal and normalizeTeam carry the session id', () => {
    const l = feed.normalizeLocal({ ts: 't', ask: 'a', files: [], session: 'sess-1' }, {});
    assert.strictEqual(l.session, 'sess-1');
    const l2 = feed.normalizeLocal({ ts: 't', ask: 'a', files: [] }, {});
    assert.strictEqual(l2.session, '', 'missing session normalizes to empty string');
    const t = feed.normalizeTeam({ ts: 't', ask: 'a', session: 'sess-2' }, {});
    assert.strictEqual(t.session, 'sess-2');
    const t2 = feed.normalizeTeam({ ts: 't', ask: 'a' }, {});
    assert.strictEqual(t2.session, '');
  });
```

- [ ] **Step 2: Run test, verify it fails** — `npm test 2>&1 | grep -E "FAIL|carry the session"` → `FAIL` (`undefined !== 'sess-1'`).

- [ ] **Step 3: Implement**

In `normalizeLocal`'s returned object add (next to `source`):

```js
    session: e.session || '',
```

In `normalizeTeam`'s returned object add (team rows already select and push `session` — see lib/teamsync.js:438,494):

```js
    session: row.session || '',
```

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Commit**

```bash
git add lib/feed.js test/run-tests.js
git commit -m "feat: feed entries carry their session id"
```

### Task 6: `feed.groupRuns` — pure run grouping

**Files:**
- Modify: `lib/feed.js`
- Test: `test/run-tests.js` (same feed section)

- [ ] **Step 1: Write the failing tests**

```js
  const mkFeedEntry = over => Object.assign({
    origin: 'local', self: true, author: 'You', authorId: 'u1', source: 'Claude Code',
    project: 'shop', projectPath: '/p/shop', projectId: null, session: 'sA',
    ts: '2026-07-16T10:00:00Z', ask: '', summary: null, distilled: false,
    files: [], tasks: null, goal: null, decisions: null, gotchas: null, changes: [], cursor: null,
  }, over);

  check('feed.groupRuns folds one session into one run; the latest summary wins as a unit', () => {
    const runs = feed.groupRuns([
      mkFeedEntry({ ts: '2026-07-16T10:00:00Z', ask: 'fix checkout', files: ['src/a.js'] }),
      mkFeedEntry({ ts: '2026-07-16T10:30:00Z', ask: 'now the tests', files: ['src/a.js', 'test/a.test.js'] }),
      mkFeedEntry({ ts: '2026-07-16T11:00:00Z', ask: 'ship it', summary: 'Fixed checkout validation',
        distilled: true, goal: 'green tests', files: ['src/b.js'] }),
    ]);
    assert.strictEqual(runs.length, 1);
    const r = runs[0];
    assert.strictEqual(r.askCount, 3);
    assert.strictEqual(r.ask, 'fix checkout', 'the opening ask names the run');
    assert.deepStrictEqual(r.asks.map(a => a.ask), ['fix checkout', 'now the tests', 'ship it'], 'asks oldest-first');
    assert.strictEqual(r.summary, 'Fixed checkout validation');
    assert.strictEqual(r.distilled, true);
    assert.strictEqual(r.goal, 'green tests');
    assert.deepStrictEqual(r.files.slice().sort(), ['src/a.js', 'src/b.js', 'test/a.test.js']);
    assert.strictEqual(r.ts, '2026-07-16T11:00:00Z');
    assert.strictEqual(r.tsStart, '2026-07-16T10:00:00Z');
    assert.ok(r.key, 'run has a stable key');
  });

  check('feed.groupRuns splits by project and author, keeps sessionless entries per-ask', () => {
    const runs = feed.groupRuns([
      mkFeedEntry({ ask: 'a1' }),
      mkFeedEntry({ ask: 'a2', project: 'api', projectPath: '/p/api' }),          // same session, other project
      mkFeedEntry({ ask: 'a3', author: 'Andrew', authorId: 'u2', self: false }),  // same session id, other author
      mkFeedEntry({ ask: 'b1', session: '' }),
      mkFeedEntry({ ask: 'b2', session: '' }),                                    // no session → two singleton runs
    ]);
    assert.strictEqual(runs.length, 5);
  });

  check('feed.groupRuns leaves a summary-less run in progress (summary=null)', () => {
    const runs = feed.groupRuns([mkFeedEntry({ ask: 'wip' })]);
    assert.strictEqual(runs[0].summary, null);
  });

  check('feed.groupRuns sorts runs newest-first and does not mutate its input', () => {
    const a = mkFeedEntry({ session: 's1', ts: '2026-07-16T09:00:00Z', ask: 'old' });
    const b = mkFeedEntry({ session: 's2', ts: '2026-07-16T12:00:00Z', ask: 'new' });
    const input = [a, b];
    const snapshot = JSON.stringify(input);
    const runs = feed.groupRuns(input);
    assert.strictEqual(runs[0].session, 's2');
    assert.strictEqual(JSON.stringify(input), snapshot, 'input untouched');
  });
```

- [ ] **Step 2: Run tests, verify they fail** — `npm test 2>&1 | grep -E "FAIL|groupRuns"` → all new checks `FAIL` (`feed.groupRuns is not a function`).

- [ ] **Step 3: Implement**

Append to `lib/feed.js` before `module.exports`:

```js
// ---------------------------------------------------------------------------
// Runs: the feed unit of the runs-and-threads spec — one session's work
// inside one project. Pure grouping over already-normalized entries; the
// storage format is untouched. Entries without a session id (older data,
// tools that don't emit one) stay singleton runs, i.e. today's per-ask cards.
// ---------------------------------------------------------------------------
function runKey(e) {
  const proj = e.projectId || e.projectPath || e.project || '';
  const who = e.authorId || e.author || '';
  return who + '|' + (e.session || '') + '|' + proj;
}

function groupRuns(entries) {
  const runs = new Map();
  let solo = 0;
  for (const e of entries || []) {
    if (!e) continue;
    const key = e.session ? runKey(e) : 'solo|' + (solo++) + '|' + runKey(e);
    if (!runs.has(key)) {
      runs.set(key, {
        key, origin: e.origin, self: e.self, author: e.author, authorId: e.authorId,
        source: e.source, project: e.project, projectPath: e.projectPath, projectId: e.projectId,
        session: e.session || '', ts: e.ts, tsStart: e.ts,
        asks: [], files: [], summary: null, distilled: false, checkpoints: null,
        goal: null, decisions: null, gotchas: null, tasks: null, changes: [],
      });
    }
    const run = runs.get(key);
    if (String(e.ts) > String(run.ts)) run.ts = e.ts;
    if (String(e.ts) < String(run.tsStart)) run.tsStart = e.ts;
    if (e.ask) run.asks.push({ ts: e.ts, ask: e.ask });
    for (const f of e.files || []) if (!run.files.includes(f)) run.files.push(f);
    // The latest summary-bearing entry is the run's outcome; its companion
    // fields (goal/decisions/gotchas/changes/checkpoints) travel with it as a
    // unit so fields from different checkpoints never mix.
    if (e.summary && String(e.ts) >= String(run._summaryTs || '')) {
      run.summary = e.summary; run.distilled = !!e.distilled;
      run.goal = e.goal || null; run.decisions = e.decisions || null; run.gotchas = e.gotchas || null;
      run.changes = Array.isArray(e.changes) ? e.changes.slice() : [];
      run.checkpoints = Array.isArray(e.checkpoints) ? e.checkpoints.slice() : null;
      run._summaryTs = e.ts;
    }
    if (e.tasks && String(e.ts) >= String(run._tasksTs || '')) {
      run.tasks = e.tasks; run._tasksTs = e.ts;
    }
  }
  const out = [...runs.values()];
  for (const r of out) {
    r.asks.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    r.askCount = r.asks.length;
    // The opening ask names the run — same rule as digest.sessionGroups.
    r.ask = r.asks.length ? r.asks[0].ask : '';
    delete r._summaryTs;
    delete r._tasksTs;
  }
  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return out;
}
```

Extend exports:

```js
module.exports = { normalizeLocal, normalizeTeam, buildFeed, runKey, groupRuns };
```

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Commit**

```bash
git add lib/feed.js test/run-tests.js
git commit -m "feat: groupRuns — fold feed entries into (session, project) runs"
```

### Task 7: `feedPayload` returns runs

**Files:**
- Modify: `lib/server.js` (`feedPayload` return, ~line 217)
- Test: `test/run-tests.js` (near the other `feedPayload` awaits)

- [ ] **Step 1: Write the failing test**

```js
  const runsFeed = await feedPayload({ limit: 50 });
  check('feedPayload: returns runs derived from the page entries', () => {
    assert.ok(Array.isArray(runsFeed.runs), 'runs array present');
    assert.ok(runsFeed.runs.length <= (runsFeed.entries || []).length, 'runs never outnumber entries');
    for (const r of runsFeed.runs) {
      assert.ok(r.key && r.ts, 'run has key and ts');
      assert.ok(Array.isArray(r.asks), 'run has asks');
    }
  });
```

- [ ] **Step 2: Run test, verify it fails** — `npm test 2>&1 | grep -E "FAIL|returns runs"` → `FAIL`.

- [ ] **Step 3: Implement**

In `feedPayload`, change the final return to derive runs from the page:

```js
  const runs = feed.groupRuns(out.entries);
  return { ...out, runs, signedIn: !!creds, hasTeam: teamList.length > 0, suggestions, repoSuggestions, offlineTeammates };
```

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: feed payload returns (session, project) runs"
```

### Task 8: Home renders runs

**Files:**
- Modify: `lib/dashboard.js` — `feedKey` (~line 1552), `renderHome` (~line 1555), `loadMoreHome` (~line 1571), `feedEntryHtml` (find with `grep -n "function feedEntryHtml" lib/dashboard.js`)
- Test: `test/run-tests.js` (next to the `dashboard:` checks)

- [ ] **Step 1: Write the failing test**

```js
    check('dashboard: home feed renders runs with folded asks', () => {
      const html = require('../lib/dashboard').dashboardPage();
      assert.ok(/d\.runs/.test(html), 'home consumes d.runs');
      assert.ok(/The asks/.test(html), 'multi-ask detail label present');
      assert.ok(/askCount/.test(html), 'ask-count pill wired');
    });
```

- [ ] **Step 2: Run test, verify it fails** — `npm test 2>&1 | grep -E "FAIL|renders runs"` → `FAIL`.

- [ ] **Step 3: Implement** (client JS inside dashboard.js — ES5 style)

(a) `feedKey` — runs carry a stable key; entries keep the old composite:

```js
function feedKey(e) {
  if (e.key) return e.key;
  return (e.projectId || e.projectPath || e.project || '') + '|' + (e.ts || '') + '|' + (e.ask || '');
}
```

(b) `renderHome` — swap the source array (first line of the function):

```js
  homeEntries = ((d.runs && d.runs.length ? d.runs : d.entries) || []).slice();
```

(c) `loadMoreHome` — same swap for the fetched page. Replace `var fresh = (d.entries || []).filter(...)` with:

```js
    // Runs when the server sends them, entries otherwise. A run split across
    // the page boundary keeps only its newest page's asks until the next full
    // poll — accepted v1 tradeoff (same class as the poll collapsing pages).
    var incoming = (d.runs && d.runs.length ? d.runs : d.entries) || [];
    var fresh = incoming.filter(function (e) { return !seen[feedKey(e)]; });
```

(d) `feedEntryHtml` — three changes:

1. In `meta`, after the project button term, add an ask-count pill:

```js
    + (e.askCount > 1 ? '<span class="fago">' + e.askCount + ' asks</span>' : '')
```

2. In the detail block, replace the single-ask line

```js
  if (e.ask) detail += '<div class="fd-label">The ask</div><p class="fd-ask">&ldquo;' + esc(e.ask) + '&rdquo;</p>';
```

with:

```js
  if (e.asks && e.asks.length > 1) {
    detail += '<div class="fd-label">The asks &middot; ' + e.asks.length + '</div>'
      + e.asks.map(function (a) { return '<p class="fd-ask">&ldquo;' + esc(a.ask) + '&rdquo;</p>'; }).join('');
  } else if (e.ask) {
    detail += '<div class="fd-label">The ask</div><p class="fd-ask">&ldquo;' + esc(e.ask) + '&rdquo;</p>';
  }
```

3. On the returned `<article>` tag, add a run anchor (used by Stage 4's caption):

```js
  return '<article class="fentry' + (wip ? ' pending' : '') + (opts.headline ? ' headline' : '')
    + '" data-run="' + esc(e.key || '') + '">'
```

(Runs are entry-shaped for every other field the card reads — author/summary/ask/files/changes/goal/checkpoints — so day grouping, chips, and the project stream keep working unchanged; project/catch-up surfaces still pass plain entries, which render exactly as before.)

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Verify visually, then commit — Stage 3 complete**

Run `npm start` (or use the already-running daemon) and open the dashboard: Home should show one card per work session with an "N asks" pill and the asks folded into the expanded detail.

```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "feat: Home feed renders one card per run, asks folded in detail"
```

---

## Stage 4 — Thread captions

### Task 9: `lib/threads.js` — the matcher

**Files:**
- Create: `lib/threads.js`
- Test: `test/run-tests.js` (new section next to the feed checks; add `const threadsLib = require('../lib/threads');` with the other requires at the top)

- [ ] **Step 1: Write the failing tests**

```js
  const mkRun = over => Object.assign({
    key: 'k', author: 'You', authorId: 'u1', project: 'shop', projectPath: '/p/shop',
    projectId: null, session: 's', ts: '2026-07-16T10:00:00Z', files: [],
  }, over);

  check('threads: an earlier same-author run sharing 2+ files gets a continues caption', () => {
    const a = mkRun({ key: 'a', session: 's1', ts: '2026-07-14T10:00:00Z', files: ['src/x.js', 'src/y.js', 'package.json'] });
    const b = mkRun({ key: 'b', session: 's2', ts: '2026-07-16T10:00:00Z', files: ['src/x.js', 'src/y.js'] });
    const caps = threadsLib.threadCaptions([a, b]);
    const c = caps.get('b');
    assert.ok(c, 'later run linked');
    assert.strictEqual(c.kind, 'continues');
    assert.strictEqual(c.target, 'a');
    assert.deepStrictEqual(c.sharedFiles.slice().sort(), ['src/x.js', 'src/y.js']);
    assert.ok(!caps.get('a'), 'the earlier run gets no caption');
  });

  check('threads: a teammate run gets the teammate caption', () => {
    const a = mkRun({ key: 'a', session: 's1', author: 'Andrew', authorId: 'u2',
      ts: '2026-07-15T10:00:00Z', files: ['src/x.js', 'src/y.js'] });
    const b = mkRun({ key: 'b', session: 's2', ts: '2026-07-16T10:00:00Z', files: ['src/x.js', 'src/y.js'] });
    const c = threadsLib.threadCaptions([a, b]).get('b');
    assert.ok(c);
    assert.strictEqual(c.kind, 'teammate');
    assert.strictEqual(c.author, 'Andrew');
  });

  check('threads: dependency manifests alone never link; 1 shared file is not enough', () => {
    const a = mkRun({ key: 'a', session: 's1', ts: '2026-07-15T10:00:00Z',
      files: ['package.json', 'pnpm-lock.yaml', 'src/x.js'] });
    const b = mkRun({ key: 'b', session: 's2', ts: '2026-07-16T10:00:00Z',
      files: ['package.json', 'pnpm-lock.yaml', 'src/x.js', 'src/z.js'] });
    assert.ok(!threadsLib.threadCaptions([a, b]).get('b'), 'deps excluded, only 1 real shared file');
  });

  check('threads: no link across projects or outside the 14-day window', () => {
    const shared = ['src/x.js', 'src/y.js'];
    const otherProj = mkRun({ key: 'a', session: 's1', ts: '2026-07-15T10:00:00Z',
      project: 'api', projectPath: '/p/api', files: shared });
    const old = mkRun({ key: 'o', session: 's0', ts: '2026-06-01T10:00:00Z', files: shared });
    const b = mkRun({ key: 'b', session: 's2', ts: '2026-07-16T10:00:00Z', files: shared });
    assert.strictEqual(threadsLib.threadCaptions([otherProj, old, b]).size, 0);
  });

  check('threads: the most recent qualifying run wins', () => {
    const a1 = mkRun({ key: 'a1', session: 's1', ts: '2026-07-13T10:00:00Z', files: ['src/x.js', 'src/y.js'] });
    const a2 = mkRun({ key: 'a2', session: 's2', ts: '2026-07-15T10:00:00Z', files: ['src/x.js', 'src/y.js'] });
    const b = mkRun({ key: 'b', session: 's3', ts: '2026-07-16T10:00:00Z', files: ['src/x.js', 'src/y.js'] });
    assert.strictEqual(threadsLib.threadCaptions([a1, a2, b]).get('b').target, 'a2');
  });
```

- [ ] **Step 2: Run tests, verify they fail** — `npm test 2>&1 | grep -E "FAIL|threads:"` → module-not-found failure.

- [ ] **Step 3: Implement**

Create `lib/threads.js`:

```js
'use strict';
// Thread captions (runs-and-threads spec, Stage 4): link runs that are
// plausibly the same piece of work — same project, at least MIN_SHARED
// shared touched files (dependency manifests excluded via changes.DEP_RE),
// within WINDOW_DAYS. Pure; runs on the feed page's runs at read time.
// Deliberately a LABEL, not a structure: a wrong guess costs one caption
// line, never a broken feed. Cross-project threads are out of scope.
const { DEP_RE } = require('./changes');

const WINDOW_DAYS = 14;
const MIN_SHARED = 2;

const projKey = r => r.projectId || r.projectPath || r.project || '';
const whoKey = r => r.authorId || r.author || '';

// Map(run.key -> { kind, target, author, authorId, ts, sharedFiles }): for
// each run, the most recent strictly-earlier run sharing enough real files.
function threadCaptions(runs, opts = {}) {
  const windowMs = (opts.windowDays || WINDOW_DAYS) * 86400000;
  const minShared = opts.minShared || MIN_SHARED;
  const captions = new Map();
  const list = (runs || []).filter(r => r && r.key && Array.isArray(r.files));
  for (const run of list) {
    const t = Date.parse(run.ts);
    if (!Number.isFinite(t)) continue;
    const mine = new Set(run.files.filter(f => !DEP_RE.test(f)));
    if (mine.size < minShared) continue;
    let best = null, bestT = -Infinity;
    for (const other of list) {
      if (other === run || other.key === run.key || projKey(other) !== projKey(run)) continue;
      const ot = Date.parse(other.ts);
      if (!Number.isFinite(ot) || ot >= t || t - ot > windowMs) continue;
      if (ot <= bestT) continue;
      const shared = (other.files || []).filter(f => mine.has(f));
      if (shared.length < minShared) continue;
      bestT = ot;
      best = { target: other.key, author: other.author, authorId: other.authorId,
        ts: other.ts, sharedFiles: shared.slice(0, 5) };
    }
    if (!best) continue;
    const kind = whoKey(best) === whoKey(run) ? 'continues' : 'teammate';
    captions.set(run.key, { kind, ...best });
  }
  return captions;
}

module.exports = { threadCaptions, WINDOW_DAYS, MIN_SHARED };
```

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Commit**

```bash
git add lib/threads.js test/run-tests.js
git commit -m "feat: thread matcher — link runs by shared touched files"
```

### Task 10: Attach captions server-side

**Files:**
- Modify: `lib/server.js` (`feedPayload` return block from Task 7; add `const threads = require('./threads');` with the other requires)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
  const thrFeed = await feedPayload({ limit: 50 });
  check('feedPayload: runs carry a thread caption field (present or absent, never crashing)', () => {
    assert.ok(Array.isArray(thrFeed.runs));
    for (const r of thrFeed.runs) {
      if (r.thread) {
        assert.ok(r.thread.kind === 'continues' || r.thread.kind === 'teammate');
        assert.ok(r.thread.target, 'caption names its target run');
      }
    }
  });
```

(The deep matcher behavior is already unit-tested in Task 9; this check pins the payload contract.)

- [ ] **Step 2: Run test, verify it fails** — it passes vacuously only if `runs` exists; to make it a real RED, write it BEFORE the implementation with an extra assertion that `feedPayload` computed captions at all:

```js
    assert.ok('runs' in thrFeed && thrFeed.runs.every(r => !('thread' in r) || r.thread), 'thread attached only when found');
```

Run `npm test 2>&1 | grep -E "FAIL|thread caption"` — with fixture overlap this stays green only after wiring; if it is green pre-wiring (no overlapping fixtures), proceed — the unit tests are the RED here.

- [ ] **Step 3: Implement**

In `feedPayload` (Task 7's return block), attach captions before returning:

```js
  const runs = feed.groupRuns(out.entries);
  // Quiet thread captions: attached to the fresh runs we just built, computed
  // over this page only — a dangling target (related run outside the page)
  // simply renders without a scroll target.
  const captions = threads.threadCaptions(runs);
  for (const r of runs) {
    const c = captions.get(r.key);
    if (c) r.thread = c;
  }
```

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat: attach thread captions to feed runs"
```

### Task 11: Render the caption

**Files:**
- Modify: `lib/dashboard.js` — `feedEntryHtml`, the Home delegated click handler (same one as Task 4), and the page stylesheet (find the `.fentry` CSS rules with `grep -n "\.fentry" lib/dashboard.js`)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

```js
    check('dashboard: thread caption wiring present', () => {
      const html = require('../lib/dashboard').dashboardPage();
      assert.ok(/fthread/.test(html), 'caption class present');
      assert.ok(/data-run-target/.test(html), 'caption click target wired');
      assert.ok(/Continues earlier work/.test(html), 'continues wording present');
      assert.ok(/also worked on these files/.test(html), 'teammate wording present');
    });
```

- [ ] **Step 2: Run test, verify it fails** — `npm test 2>&1 | grep -E "FAIL|thread caption wiring"` → `FAIL`.

- [ ] **Step 3: Implement** (client JS, ES5 style)

(a) In `feedEntryHtml`, before the `return`, build the caption and append it after `meta` inside the `grow` div:

```js
  var thread = !e.thread ? '' :
    '<div class="fthread" data-run-target="' + esc(e.thread.target) + '">&#8618; ' +
    (e.thread.kind === 'continues'
      ? 'Continues earlier work'
      : esc(e.thread.author || 'A teammate') + ' also worked on these files') +
    ' &middot; ' + esc(homeDayLabel(e.thread.ts)) + '</div>';
```

and change the head markup to include it:

```js
    + '<div class="fentry-head">' + avatar + '<div class="grow">' + summaryLine + meta + thread + '</div></div>' + detail + '</article>';
```

(b) In the Home delegated click handler (same listener as the chips / suggestion buttons), add before the chip branch:

```js
    var th = e.target.closest('[data-run-target]');
    if (th) {
      var card = document.querySelector('[data-run="' + CSS.escape(th.getAttribute('data-run-target')) + '"]');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('flash');
        setTimeout(function () { card.classList.remove('flash'); }, 1600);
      }
      return;
    }
```

(c) In the stylesheet, next to the other `.fentry`/`.fsub` rules, add:

```css
.fthread{font-size:11.5px;color:var(--text3);margin-top:6px;cursor:pointer;width:fit-content}
.fthread:hover{color:var(--text2)}
.fentry.flash{outline:2px solid var(--amber);outline-offset:3px;border-radius:12px}
```

(Check `--amber` exists in the theme variables — it is already used by `feedEntryHtml`'s todo bar; if the CSS var set differs, use whichever accent variable the `.fwip-dot` rule uses.)

- [ ] **Step 4: Run the FULL suite, verify green** — `npm test 2>&1 | tail -5`.

- [ ] **Step 5: Commit — Stage 4 complete**

```bash
git add lib/dashboard.js test/run-tests.js
git commit -m "feat: quiet thread caption on run cards with scroll-to-related"
```

---

### Task 12: Docs, full verification, ship

**Files:**
- Modify: `README.md` (the "Home — the unified feed" section), `CHANGELOG.md`

- [ ] **Step 1: Update README**

In the Home section, update the paragraph beginning "The default view is a single centered column: every ask your team's AI tools completed…" to describe runs: one card per work session leading with what got done, the individual asks folded into the expanded detail, and the quiet "Continues earlier work / <name> also worked on these files" caption linking related sessions. Mention the untracked-repo suggestion card ("This session worked in a repo you don't track yet — Track / Dismiss") in the same section. Keep the existing voice; no new sections.

- [ ] **Step 2: Update CHANGELOG**

Add entries under a new version heading following the file's existing format:

```
- Home feed now shows one card per work session (run), not one per prompt; the asks fold into the card's detail.
- Untracked repos a session edited surface as suggest-only Track/Dismiss cards — nothing is ever tracked automatically.
- Related sessions get a quiet caption ("Continues earlier work" / "<name> also worked on these files") linking runs that touched the same files.
```

- [ ] **Step 3: Full suite + commit**

Run: `npm test 2>&1 | tail -5` — all green.

```bash
git add README.md CHANGELOG.md
git commit -m "docs: runs-and-threads — README + changelog"
```

- [ ] **Step 4: Merge and rebuild the app** (project convention: rebuild + reinstall MemBridge.app after every large change)

Follow superpowers:finishing-a-development-branch for the merge decision, then:

```bash
npm run dist:mac
```

Copy the built `MemBridge.app` from `dist/` (mac-arm64 output dir) over the installed copy in `/Applications`, then quit and relaunch the menu-bar app. Verify the dashboard shows run cards and (if an untracked repo was edited recently) a suggestion card.
