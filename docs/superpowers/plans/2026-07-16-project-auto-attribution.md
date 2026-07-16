# Project Auto-Attribution (Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File each AI session under the project its edits actually land in — resolved by walking up from edited files to the nearest already-tracked project root — instead of the directory the session was launched in (`cwd`).

**Architecture:** A new pure module `lib/project-resolve.js` exposes `resolveRoot(file, trackedRoots)` (nearest tracked ancestor, or null) and `rehomeEvents(events, trackedRoots)` (re-stamp each edit to its own resolved root; attach a session's prompt/summary/todos to the session's dominant root). `scan.js` runs `rehomeEvents` on the scanned events *before* `mergeEvents`, so all downstream grouping/rendering is unchanged. The Stop hook (`hooks.js`) resolves the same dominant root so it writes `summaries.jsonl` into the correct `.membridge/`. Files under no tracked root keep their `cwd` project — today's behavior, so nothing regresses.

**Tech Stack:** Node.js (CommonJS, zero deps), the custom `test/run-tests.js` harness (`check(name, fn)` + `npm test`), real temp dirs for filesystem-marker tests.

**Locked decisions (from the approved spec, Part B):**
- **#5 tracked-roots only** — a file re-homes only into a root MemBridge already tracks (a `state.projects` key, or a dir containing `.membridge/`). Unknown repos → fall back to `cwd`. Never auto-discover new roots.
- **#6 split multi-repo sessions** — each edit files under its own resolved root; the session's non-file events (prompt/summary/todos) attach to the **dominant** root (most edits).

---

## Data contracts

**Event** (produced by adapters in `scan.js` `scanAll`): `{ ts, source, kind:'prompt'|'edit'|'summary'|'todos', project, session, file?, text?, items?, … }`. `project` starts as the session `cwd`. Re-homing only ever rewrites `event.project`; no other field changes.

**`trackedRoots`**: a `Set<string>` of `normPath`-normalized absolute paths MemBridge already tracks = the keys of `state.projects`. (A dir with a `.membridge/` on disk is also treated as tracked via a filesystem check in the resolver, so a project seen for the first time this pass still counts.)

**`resolveRoot(file, trackedRoots, opts?) → string | null`**: the nearest ancestor directory of `file` that is tracked, else `null`.

---

## File structure

- **Create** `lib/project-resolve.js` — `resolveRoot` + `rehomeEvents` (pure; fs access injectable for tests). ~70 lines.
- **Modify** `lib/scan.js` — `syncOnce` runs `rehomeEvents` between `scanAll` and `mergeEvents`; export a `trackedRoots(state)` helper.
- **Modify** `lib/hooks.js` — `runStop` resolves the session's dominant tracked root instead of using `cwd` directly.
- **Modify** `test/run-tests.js` — new `check(...)` blocks per task.

---

## Task 1: `lib/project-resolve.js` — resolver + re-homing

**Files:**
- Create: `lib/project-resolve.js`
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing tests**

Append near the other unit checks (uses real temp dirs so the `.membridge/` filesystem check runs for real):

```js
const projectResolve = require('../lib/project-resolve');

check('project-resolve: resolveRoot returns nearest tracked ancestor, else null', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-resolve-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, '.membridge'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const tracked = new Set([require('../lib/util').normPath(repo)]);
  // a file inside the tracked repo → the repo root
  assert.strictEqual(
    projectResolve.resolveRoot(path.join(repo, 'src', 'a.js'), tracked),
    repo);
  // a file outside any tracked/.membridge dir → null
  assert.strictEqual(
    projectResolve.resolveRoot(path.join(base, 'loose', 'b.js'), new Set()),
    null);
  // untracked set but .membridge on disk still counts as tracked
  assert.strictEqual(
    projectResolve.resolveRoot(path.join(repo, 'src', 'a.js'), new Set()),
    repo);
});

check('project-resolve: rehomeEvents splits edits by root, prompt follows dominant', () => {
  const A = '/root/repoA', B = '/root/repoB';
  const tracked = new Set([require('../lib/util').normPath(A), require('../lib/util').normPath(B)]);
  const resolveRoot = f => (f.startsWith(A) ? A : f.startsWith(B) ? B : null);
  const events = [
    { kind: 'prompt', project: '/home', session: 's1', text: 'go' },
    { kind: 'edit', project: '/home', session: 's1', file: A + '/x.js' },
    { kind: 'edit', project: '/home', session: 's1', file: A + '/y.js' },
    { kind: 'edit', project: '/home', session: 's1', file: B + '/z.js' },
    { kind: 'summary', project: '/home', session: 's1', text: 'did' },
    { kind: 'edit', project: '/home', session: 's2', file: '/elsewhere/u.js' }, // untracked
  ];
  projectResolve.rehomeEvents(events, tracked, { resolveRoot });
  const by = k => events.filter(e => e.kind === k);
  // edits filed under their own root
  assert.deepStrictEqual(by('edit').map(e => e.project), [A, A, B, '/home']);
  // prompt + summary follow the dominant root (A has 2 edits, B has 1)
  assert.strictEqual(by('prompt')[0].project, A);
  assert.strictEqual(by('summary')[0].project, A);
  // untracked-only session s2 keeps cwd
  assert.strictEqual(by('edit')[3].project, '/home');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep "project-resolve:"`
Expected: two `FAIL … Cannot find module '../lib/project-resolve'`.

- [ ] **Step 3: Write `lib/project-resolve.js`**

```js
'use strict';
// Resolve which project a session's work actually belongs to by walking up
// from edited files to the nearest ALREADY-TRACKED root, then re-home each
// event's `project`. Tracked = a key in state.projects (passed in as
// trackedRoots) OR a directory containing a .membridge/ (checked on disk).
// Never discovers new roots: an edit under nothing tracked keeps its cwd.
const fs = require('fs');
const path = require('path');
const { normPath } = require('./util');

function defaultHasMembridge(dir) {
  try { return fs.statSync(path.join(dir, '.membridge')).isDirectory(); } catch { return false; }
}

// Nearest ancestor of `file` that is tracked, else null.
function resolveRoot(file, trackedRoots, opts = {}) {
  const hasMembridge = opts.hasMembridge || defaultHasMembridge;
  let dir = path.dirname(path.resolve(String(file)));
  for (;;) {
    if (trackedRoots.has(normPath(dir)) || hasMembridge(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root, nothing tracked
    dir = parent;
  }
}

// Re-stamp `events[].project` in place and return the array:
//  - each edit → its own resolved root (kept as cwd when it resolves to null);
//  - each session's non-edit events (prompt/summary/todos) → that session's
//    DOMINANT root (the resolved root with the most edits), when one exists.
function rehomeEvents(events, trackedRoots, opts = {}) {
  const resolve = opts.resolveRoot || (f => resolveRoot(f, trackedRoots, opts));
  const counts = new Map();   // session -> Map(normRoot -> {count, root})
  for (const ev of events) {
    if (ev.kind !== 'edit' || !ev.file) continue;
    const root = resolve(ev.file);
    if (!root) continue;                       // untracked edit: leave cwd
    if (normPath(root) !== normPath(ev.project)) ev.project = root;
    const s = ev.session || '';
    if (!counts.has(s)) counts.set(s, new Map());
    const m = counts.get(s);
    const key = normPath(root);
    const prev = m.get(key) || { count: 0, root };
    m.set(key, { count: prev.count + 1, root });
  }
  const dominant = new Map();   // session -> root path
  for (const [s, m] of counts) {
    let best = null;
    for (const v of m.values()) if (!best || v.count > best.count) best = v;
    if (best) dominant.set(s, best.root);
  }
  for (const ev of events) {
    if (ev.kind === 'edit') continue;
    const root = dominant.get(ev.session || '');
    if (root && normPath(root) !== normPath(ev.project)) ev.project = root;
  }
  return events;
}

module.exports = { resolveRoot, rehomeEvents };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep "project-resolve:"`
Expected: two `ok`. Then full `npm test` — confirm no regressions.

- [ ] **Step 5: Commit**

```bash
git add lib/project-resolve.js test/run-tests.js
git commit -m "feat: add project-resolve (nearest tracked root + event re-homing)"
```

---

## Task 2: Wire re-homing into the scan pass

**Files:**
- Modify: `lib/scan.js` — `syncOnce` (~144-150), plus a `trackedRoots` helper + export
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

This is an end-to-end check: a Claude Code session whose `cwd` is a parent dir but which edits files inside a tracked project must be filed under the project, not the cwd.

```js
check('scan: session edits re-home to the tracked project, not the launch cwd', () => {
  // proj1 is a real tracked fixture dir (has been synced). Simulate a session
  // launched in ROOT (parent) that edits a file inside proj1.
  const parent = path.dirname(proj1);
  const sessDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-rehome');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'rehome1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'edit the login file' }, cwd: parent, timestamp: '2026-07-16T12:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: parent, timestamp: '2026-07-16T12:00:01.000Z' },
  ]));
  // Ensure proj1 is a tracked root (it has a .membridge dir from prior syncs, or create one).
  fs.mkdirSync(path.join(proj1, '.membridge'), { recursive: true });
  spawnSync('node', [BIN, 'sync', '--once'], { env: process.env });
  const state = JSON.parse(read(path.join(process.env.MEMBRIDGE_HOME, '.membridge', 'state.json')));
  // The edit event is filed under proj1, and NOT under the parent cwd.
  const proj1Events = (state.projects[proj1] || { events: [] }).events;
  assert.ok(proj1Events.some(e => e.kind === 'edit' && e.session === 'rehome1'), 'edit filed under proj1');
  const parentEvents = (state.projects[parent] || { events: [] }).events;
  assert.ok(!parentEvents.some(e => e.session === 'rehome1'), 'nothing filed under the parent cwd');
});
```

Confirm the exact state.json path and the `sync --once` invocation against how existing scan tests drive the daemon (search `BIN` + `'sync'` in `test/run-tests.js`); match their pattern (env, args, and how they read `state.json`). Adjust the assertion mechanics to the existing tests' conventions if they differ.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "session edits re-home"`
Expected: FAIL — the edit is filed under `parent` (cwd), not `proj1`.

- [ ] **Step 3: Add a `trackedRoots` helper + call `rehomeEvents` (`lib/scan.js`)**

At the top of `lib/scan.js`, add to the existing `require` block:
```js
const projectResolve = require('./project-resolve');
```
Add the helper near `findProjectKey`:
```js
// The set of roots MemBridge already tracks — every known project key,
// normalized. project-resolve also treats any dir with a .membridge/ as
// tracked, so a first-seen project still resolves.
function trackedRoots(state) {
  return new Set(Object.keys(state.projects || {}).map(normPath));
}
```
In `syncOnce`, re-home the scanned events before merging. Change:
```js
  const events = scanAll(state, config);
  const touched = digest.mergeEvents(state, events, config);
```
to:
```js
  const events = scanAll(state, config);
  projectResolve.rehomeEvents(events, trackedRoots(state));
  const touched = digest.mergeEvents(state, events, config);
```
(Distilled summary events from `scanSummaries` are already keyed by the correct project — they read from each project's own `.membridge/summaries.jsonl` — so they are NOT re-homed.)

Add `trackedRoots` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep "session edits re-home"`
Expected: `ok`. Then full `npm test` — confirm the existing scan/attribution tests still pass (an existing test may assert a session lands under its cwd when the cwd IS the project root; that still holds because the cwd root is tracked and resolves to itself).

- [ ] **Step 5: Commit**

```bash
git add lib/scan.js test/run-tests.js
git commit -m "feat: re-home scanned events to their resolved project root"
```

---

## Task 3: Stop-hook resolves the dominant root

**Files:**
- Modify: `lib/hooks.js` — `runStop` (~99-124)
- Test: `test/run-tests.js`

- [ ] **Step 1: Write the failing test**

The Stop hook must target the project the session's edits landed in, so `summaries.jsonl` is written there — not under `cwd`.

```js
check('hooks: stop targets the resolved project, not the launch cwd', () => {
  // Session cwd = parent; its edits (already in state) are under proj1.
  const parent = path.dirname(proj1);
  fs.mkdirSync(path.join(proj1, '.membridge'), { recursive: true });
  const state = util.loadState();
  state.projects[proj1] = state.projects[proj1] || { events: [] };
  state.projects[proj1].events.push(
    { ts: '2026-07-16T12:00:00.000Z', source: 'Claude Code', kind: 'edit', session: 'hook-sess', file: path.join(proj1, 'src', 'login.js') });
  util.saveState(state);
  // Drive the stop hook with cwd = parent, enough edits to trigger.
  const payload = JSON.stringify({ session_id: 'hook-sess', cwd: parent });
  const res = spawnSync('node', [BIN, 'hook', 'stop'], { input: payload, env: process.env, encoding: 'utf8' });
  // It should block and name proj1's summaries.jsonl (resolved), not parent's.
  if (res.stdout && res.stdout.trim()) {
    const out = JSON.parse(res.stdout.trim());
    assert.ok(out.reason.includes(path.join(proj1, '.membridge', 'summaries.jsonl')),
      'hook targets resolved proj1');
    assert.ok(!out.reason.includes(path.join(parent, '.membridge')), 'not the cwd');
  }
});
```

Match the exact hook-invocation and config setup to the existing distill/hook tests (search `hook`, `stop`, `blockReason` in `test/run-tests.js`) — including making sure distill is enabled and `minEdits` is satisfied for this session so the hook actually blocks.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep "stop targets the resolved project"`
Expected: FAIL — the hook uses `cwd` (`parent`) and either finds no project or names the wrong `.membridge/`.

- [ ] **Step 3: Resolve the dominant root in `runStop` (`lib/hooks.js`)**

Add near the top of `lib/hooks.js`:
```js
const projectResolve = require('./project-resolve');
```
In `runStop`, after loading `state` and computing `key` via `findProjectKey`, resolve the session's real project from its edits. Replace:
```js
    const state = util.loadState();
    const { findProjectKey } = require('./scan'); // lazy: scan.js requires this module back
    const key = findProjectKey(state, cwd);
    if (!key || util.isProjectOff(key, config)) return; // untracked or paused: never nag
```
with:
```js
    const state = util.loadState();
    const scan = require('./scan'); // lazy: scan.js requires this module back
    // The session's edits may live under a project other than cwd (it was
    // launched elsewhere). Resolve the dominant tracked root from this
    // session's edit events; fall back to the cwd project.
    const tracked = scan.trackedRoots(state);
    const editRoots = new Map(); // normRoot -> {count, root}
    for (const pk of Object.keys(state.projects || {})) {
      for (const e of state.projects[pk].events || []) {
        if (e.kind !== 'edit' || e.session !== sessionId || !e.file) continue;
        const root = projectResolve.resolveRoot(e.file, tracked);
        if (!root) continue;
        const k = require('./util').normPath(root);
        const prev = editRoots.get(k) || { count: 0, root };
        editRoots.set(k, { count: prev.count + 1, root });
      }
    }
    let key = null;
    for (const v of editRoots.values()) if (!key || v.count > editRoots.get(require('./util').normPath(key)).count) key = v.root;
    if (!key) key = scan.findProjectKey(state, cwd);
    if (!key || util.isProjectOff(key, config)) return; // untracked or paused: never nag
```
Keep the rest of `runStop` unchanged — it already uses `key` for the edit-count worthiness gate, the checkpoint count, and `summariesPath(key)`. (The function still fails OPEN: any throw here is caught by the outer `try/catch` and the stop is allowed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep "stop targets the resolved project"`
Expected: `ok`. Then full `npm test` — confirm existing hook/distill tests still pass (a session whose cwd IS the project root still resolves to that same root).

- [ ] **Step 5: Commit**

```bash
git add lib/hooks.js test/run-tests.js
git commit -m "feat: Stop hook targets the resolved project, not the launch cwd"
```

---

## Self-review (completed)

- **Spec coverage:** B1 (marker resolver) → Task 1 `resolveRoot`; B2 (re-home at scan time, split multi-repo, dominant for non-file events, untracked→cwd) → Task 1 `rehomeEvents` + Task 2 wiring; B3 (Stop-hook resolution) → Task 3; B4 (forward-only, no historical rescan) → out of scope by design, no task. Decision #5 (tracked-only) is enforced in `resolveRoot` (returns null when nothing tracked). Decision #6 (split + dominant) is the core of `rehomeEvents`. ✓
- **Placeholders:** Task 2 Step 1 and Task 3 Step 1 tell the implementer to align the daemon/hook invocation mechanics with the existing scan/hook tests (the one place the harness's real conventions must be read live) — the assertions and logic are concrete; only the setup boilerplate is delegated. Flagged, not hidden.
- **Type consistency:** `resolveRoot(file, trackedRoots, opts)` and `rehomeEvents(events, trackedRoots, opts)` signatures and the `trackedRoots(state)` helper are identical across Tasks 1/2/3. `normPath` used everywhere for comparison. ✓

## Verification (whole feature)

- `npm test` green (existing + new checks).
- A session launched in a parent dir editing files inside a tracked project is filed under the project (state.json), and its prompt/summary follow.
- A multi-repo session splits edits per root; the dominant root gets the prompt/summary.
- Files under no tracked root still file under `cwd` (no regression).
- The Stop hook writes `summaries.jsonl` into the resolved project's `.membridge/`.
