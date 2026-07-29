# Live Teammate Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a teammate's distilled decisions into a running agent session — project-wide prose on arrival, file-keyed notes at the moment the agent touches the file.

**Architecture:** The daemon already pulls teammate `decisions`, `gotchas` and per-file `changes[].note` every tick. On each pull it folds them into one small per-project index, `.membridge/teammate-notes.json`. Three hook entry points read that index and inject via `additionalContext`; the human surface is the existing dashboard poll. Nothing new crosses the wire; the only wire change is making file paths repo-root-relative so monorepo teammates agree on file identity.

**Tech Stack:** Node.js (CommonJS), Claude Code hooks (`PreToolUse`, `SessionStart`, `PostCompact`), the repo's own offline test runner (`node test/run-tests.js`).

**Spike outcome (Task 1, done):** `FileChanged` cannot reach the human — it suppresses `systemMessage`, and its matcher rejects any filename containing `.` or `-`. Delivery point 1 is dashboard-only and `FileChanged` is dropped everywhere in this plan. See `docs/superpowers/spikes/2026-07-28-filechanged-findings.md`.

**Spec:** `docs/superpowers/specs/2026-07-28-live-teammate-decisions-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Fail open, always.** "Every failure degrades to ordinary agent behaviour, never to broken work." No hook in this feature may throw out to the caller; every entry point is wrapped in a try/catch that swallows into a no-op.
- **Never deny a tool call.** All model-facing injection uses `hookSpecificOutput.additionalContext`, paired with `permissionDecision: "allow"` or no decision at all. The single exception is the co-occurrence case in Task 8, where the recall feature was already denying that read on its own account.
- **150 ms working budget** on the read path. The `byFile` lookup must sit ahead of `lib/hooks-recall.js`'s `if (!storeEntry) return` gate and must not hash file content or parse the ledger.
- **Wording is binding.** Tokens, never dollars. "avoided", never "saved".
- **E2E encryption unchanged.** The server sees only ciphertext; decryption and all routing stay client-side.
- **The CLAUDE.md narrative block and the Activity feed are unchanged.** This feature must not shrink, grow, or restructure either one.
- **Redaction is mandatory** on anything injected: `lib/redact.js` runs before any decision text reaches an agent context.
- **Baseline is 860/865 passing in a worktree, 865/865 with complete deps.** The
  5 failures (`prepare-app` x2, `skeleton:` x2, `recall-store: warm()`) are a
  MISSING `web-tree-sitter` — a real declared dependency the main tree was never
  reinstalled for. They are not a regression. Record your own before/after
  numbers and compare deltas, never absolutes.
- **A test whose name claims more than its assertions is worse than no test.**
  The `MAX_PROSE` case asserted only a length while being titled "newest kept",
  so the half that mattered was unverified. When a test names a property, assert
  that property; where it is cheap, confirm the test fails against a deliberately
  broken implementation before trusting it.
- **A silent no-op is the enemy in this feature.** Several functions here answer
  '' or null for "I can't work this out", which is correct for genuinely
  impossible input but will happily swallow a real bug — exactly what happened
  with `trackedOffset` in Task 2 (symlinked paths). When a fallback fires in a
  case you did not expect, treat it as a defect, not as the design working.
- **No test may touch the network or a live backend.** Everything runs under a throwaway `MEMBRIDGE_HOME`, matching `test/run-tests.js`.
- **Atomic writes only:** tmp file + rename, matching `lib/util.js` `saveState`, `lib/ledger-store.js` `writeLedger`, `lib/recall-store.js` `put`.
- **No `Date.now()` inside pure functions.** Every selection and expiry function takes an injected `now` (an ISO string or ms number), so tests are deterministic.
- **Numbers from the spec, exact:** per-injection cap **3**; re-fire window **7 days**; index bounds **200** prose entries, **500** `byFile` paths; seen-pruning **7 days**.

## Preconditions

**This plan cannot start until `claude/scale-agent-waste-corpus-53abef` is merged to master.** It modifies `lib/hooks-recall.js`, `lib/recall-store.js` and `lib/ledger.js`, none of which exist on master. Verify before Task 1:

```bash
git log --oneline master -1 && ls lib/hooks-recall.js lib/ledger.js lib/recall-store.js
```

Expected: all three files exist. If they do not, stop and merge the recall branch first.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `lib/repo-root.js` | Repo-root discovery and the tracked-dir↔repo-root path offset. Nothing else. |
| `lib/teammate-notes.js` | Pure logic: build the index from pulled entries, select what to deliver, mark seen, prune, format. No fs, no clock. |
| `lib/teammate-notes-store.js` | The fs layer for `.membridge/teammate-notes.json`: atomic read/write/update. |
| `lib/hooks-notes.js` | The `SessionStart` and `PostCompact` hook bodies. |
| `test/teammate-notes-e2e.js` | Opt-in end-to-end proof, mirroring `test/recall-e2e.js`. |

**Modified:**

| File | Change |
|---|---|
| `lib/teamsync.js` | Translate `files` / `changes[].file` to repo-root-relative on push, back on receive. |
| `lib/hooks-recall.js` | `byFile` + prose lookup ahead of the `storeEntry` gate; `additionalContext` output path. |
| `lib/hooks.js` | Register and reconcile the three new hook entries in `settings.json`. |
| `lib/membridge-hook.js` | Route the new `notes-*` subcommands. |
| `bin/membridge.js` | Rebuild the index after each team pull. |
| `lib/ledger.js`, `lib/server.js` | Tag injected note tokens; add the Savings line. |
| `test/run-tests.js` | Unit tests for every new pure module. |

---

## Task 1: Spike — can `FileChanged` reach the human? ✅ DONE

**Outcome: NO-GO.** Run 2026-07-28 against Claude Code 2.1.220. Findings in
`docs/superpowers/spikes/2026-07-28-filechanged-findings.md`, committed.

- `FileChanged` **fires** and carries a usable payload (`file_path`, `event`).
- Its `systemMessage` is **suppressed** — verified against a `SessionStart`
  control whose `systemMessage` did surface in the same stream.
- Its matcher accepts letters, digits, `_` and `|` only, so
  `teammate-notes.json` **cannot be watched** under any spelling.

**Consequences, already applied to this plan and to spec §6/§11:**
`FileChanged` is dropped everywhere. Delivery point 1 becomes the existing
dashboard poll (5s), so Task 10 is now a dashboard task with no hook. Task 7's
`NOTES_HOOKS` registers `SessionStart` and `PostCompact` only, and
`lib/hooks-notes.js` needs no `runFileChanged`.

Nothing here blocks Tasks 2–9, 11 or 12.

---

## Task 2: Repo-root path translation ✅ DONE (`cf20d4c`, `feat/live-teammate-notes`)

**Correction applied after implementation.** The original implementation below
compared `git rev-parse --show-toplevel` against `path.resolve()`. Git resolves
symlinks and `path.resolve` does not, so on macOS (`/var` -> `/private/var`) and
under any symlinked home or volume the comparison produced a `..`-leading path,
`trackedOffset` returned `''`, and translation silently did nothing — monorepo
paths would have shipped untranslated with no error anywhere. The code below now
carries the `realPath` fix that shipped. Verified independently.


The monorepo fix (spec §7), as a standalone module with no knowledge of teams or notes.

> **⚠ ADDENDUM 2026-07-28 — read before Step 1.** Raised by the recall hot-path
> investigation (session `6821ee52`, worktree `hook-firing-sessions-90332c`). Not a
> re-litigation of §2.3 or §7; a third case neither of them covers.
>
> `repoRoot()` as specced uses `git rev-parse --show-toplevel`, which **returns the
> worktree itself, not the main repo**. Verified on this machine:
>
> ```
> git -C <main>/.claude/worktrees/projects-1c rev-parse --show-toplevel
>   → /Users/marco/Documents/Membridge/.claude/worktrees/projects-1c
> git -C <main>/.claude/worktrees/projects-1c rev-parse --git-common-dir
>   → /Users/marco/Documents/Membridge/.git          ← the main repo
> ```
>
> Three distinct file-identity axes, only two of which are handled:
> §2.3 closes **attribution** (which project owns a worktree file — correct, genuinely no
> work needed); §7 fixes **depth** (`packages/api/`); nothing addresses **same file,
> different worktree**.
>
> Measured against live state (`resolveTrackedKey` + `readKeyFor`, real `state.json`):
> every worktree file resolves to the main project but keeps a distinct key —
>
> ```
> <main>/lib/scan.js                              → lib/scan.js
> <main>/.claude/worktrees/projects-1c/lib/scan.js → .claude/worktrees/projects-1c/lib/scan.js
> <main>/.claude/worktrees/notes-index/lib/scan.js → .claude/worktrees/notes-index/lib/scan.js
> ```
>
> Because the tracked dir *is* the repo root here, `trackedOffset()` returns `''` and
> `toWirePath()` is the identity function — a worktree path crosses the wire verbatim.
> **A note keyed `.claude/worktrees/<name>/lib/scan.js` can never match a teammate's
> `lib/scan.js`.** That defeats file-keyed matching (§4.1, Tasks 6 and 8) for any session
> run from a worktree — on this machine, nearly all of them.
>
> **Suggested fix, inside this task:** resolve the root via `git rev-parse --git-common-dir`,
> strip a trailing `/.git`, and fall back to `--show-toplevel` when the two agree (i.e. not
> a worktree). A worktree and the main checkout then yield the same root, and `toWirePath()`
> maps both to `lib/scan.js`.
>
> **Add to Step 1's tests:**
> - `repoRoot()` on a linked worktree returns the *main* repo root, not the worktree path.
> - `toWirePath(<worktree>, 'lib/scan.js') === 'lib/scan.js'`, identical to the main checkout.
> - Every non-worktree case above stays byte-identical.
>
> Same defect independently strands the recall layer: `hotPathsOf` requires
> `sessions.length > 1` on one key, so per-session worktrees never accumulate a hot set and
> `.membridge/recall/` is never created. Not this task's job to fix, but one normalization
> closes both.

**Files:**
- Create: `lib/repo-root.js`
- Test: `test/run-tests.js` (append a new section)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `repoRoot(projectPath) -> string|null` — absolute path to the git top-level, or `null` if not a repo. Memoized per process.
  - `trackedOffset(projectPath) -> string` — POSIX prefix from repo root to the tracked dir, `''` when they are the same, e.g. `'packages/api/'`.
  - `toWirePath(projectPath, relPath) -> string` — tracked-relative → repo-root-relative.
  - `fromWirePath(projectPath, wirePath) -> string` — repo-root-relative → tracked-relative, falling back to `wirePath` unchanged when it does not sit under the offset.
  - `clearCache()` — test-only.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`, immediately before the results tally at the end of the file:

```js
// ---- repo-root path translation (teammate notes, spec §7) ----
const repoRoot = require('../lib/repo-root');

{
  const rr = path.join(ROOT, 'projects', 'mono');
  const api = path.join(rr, 'packages', 'api');
  fs.mkdirSync(api, { recursive: true });
  spawnSync('git', ['init', '-q', rr], { encoding: 'utf8' });
  repoRoot.clearCache();

  check('repo-root: resolves the git top-level from a subdirectory', () => {
    assert.strictEqual(fs.realpathSync(repoRoot.repoRoot(api)), fs.realpathSync(rr));
  });

  check('repo-root: offset is empty at the repo root', () => {
    assert.strictEqual(repoRoot.trackedOffset(rr), '');
  });

  check('repo-root: offset is the posix prefix for a tracked subdirectory', () => {
    assert.strictEqual(repoRoot.trackedOffset(api), 'packages/api/');
  });

  check('repo-root: toWirePath prefixes a tracked-relative path', () => {
    assert.strictEqual(repoRoot.toWirePath(api, 'src/validate.ts'), 'packages/api/src/validate.ts');
  });

  check('repo-root: toWirePath is identity at the repo root', () => {
    assert.strictEqual(repoRoot.toWirePath(rr, 'src/validate.ts'), 'src/validate.ts');
  });

  check('repo-root: fromWirePath strips the offset', () => {
    assert.strictEqual(repoRoot.fromWirePath(api, 'packages/api/src/validate.ts'), 'src/validate.ts');
  });

  check('repo-root: fromWirePath leaves a non-matching path alone (legacy row)', () => {
    assert.strictEqual(repoRoot.fromWirePath(api, 'src/validate.ts'), 'src/validate.ts');
  });

  check('repo-root: a non-repo directory yields null root and empty offset', () => {
    const plain = path.join(ROOT, 'projects', 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    repoRoot.clearCache();
    assert.strictEqual(repoRoot.repoRoot(plain), null);
    assert.strictEqual(repoRoot.trackedOffset(plain), '');
    assert.strictEqual(repoRoot.toWirePath(plain, 'a/b.js'), 'a/b.js');
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: the run **aborts** with `Error: Cannot find module '../lib/repo-root'`
and exit 1. Note it does NOT print per-check `FAIL` lines: the tests live inside
the suite's `async main()`, so a missing top-level `require` throws before any
check registers. That is the correct failure for the right reason — confirm the
module name in the error, then continue. The same applies to Tasks 4, 5 and 7,
which also add new top-level requires.

- [ ] **Step 3: Write the implementation**

Create `lib/repo-root.js`:

```js
'use strict';
// Repo-root discovery and the tracked-dir <-> repo-root path offset.
//
// WHY THIS EXISTS: lib/ledger-fold.js's readKeyFor and lib/hooks-recall.js's
// relFile both key paths against the TRACKED project directory, which
// lib/project-resolve.js deliberately allows to be a monorepo subdirectory.
// Two teammates on one remote tracking different depths therefore land on the
// same team project row (lib/teamsync.js's repoUrl) while producing
// incompatible path keys. Local structures keep their tracked-relative keys --
// they never leave the machine. Everything that CROSSES THE WIRE is translated
// through here, so both sides speak repo-root-relative.
//
// See docs/superpowers/specs/2026-07-28-live-teammate-decisions-design.md §7.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const toPosix = p => p.split(path.sep).join('/');

// CRITICAL (found while implementing Task 2): `git rev-parse --show-toplevel`
// returns a path with symlinks RESOLVED; path.resolve() does not. On macOS the
// temp dir alone diverges (/var -> /private/var), and any real project under a
// symlinked home or volume hits the same thing. Comparing the two directly
// yields a '..'-leading relative path, which trackedOffset() below then treats
// as impossible input and answers '' -- a SILENT no-op that ships monorepo
// paths untranslated so the teammate never matches. Resolve both sides the way
// git does before comparing. A path that does not exist yet cannot be
// realpath'd, so fall back to plain resolution for it.
const realPath = p => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Memoized: teamsync already spawns git per project for repoUrl(), and the
// top-level of a project cannot change while the daemon runs. A null result
// is cached too -- a non-repo stays a non-repo, and re-spawning git on every
// read would defeat the point.
const cache = new Map();

function repoRoot(projectPath) {
  const key = path.resolve(projectPath);
  if (cache.has(key)) return cache.get(key);
  let out = null;
  try {
    const r = spawnSync('git', ['-C', key, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.status === 0) {
      const s = String(r.stdout || '').trim();
      if (s) out = s;
    }
  } catch {
    out = null;
  }
  cache.set(key, out);
  return out;
}

// '' when the tracked dir IS the repo root (the common case, and byte-identical
// to pre-translation behaviour). 'packages/api/' when it sits below. '' as well
// for a non-repo, or for the impossible case of a tracked dir outside its own
// reported root -- in both, translation must be a no-op rather than a guess.
function trackedOffset(projectPath) {
  const root = repoRoot(projectPath);
  if (!root) return '';
  try {
    const rel = path.relative(realPath(root), realPath(projectPath));
    if (!rel) return '';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return `${toPosix(rel)}/`;
  } catch {
    return '';
  }
}

function toWirePath(projectPath, relPath) {
  const rel = String(relPath || '');
  if (!rel) return rel;
  return trackedOffset(projectPath) + rel;
}

// The inverse, with the legacy fallback spec §7 requires: rows already on the
// wire were written tracked-relative, so a path that does not sit under this
// project's offset is returned unchanged rather than mangled. Harmless when
// the offset is '' -- every path trivially "matches" and passes through.
function fromWirePath(projectPath, wirePath) {
  const wire = String(wirePath || '');
  if (!wire) return wire;
  const offset = trackedOffset(projectPath);
  if (!offset) return wire;
  return wire.startsWith(offset) ? wire.slice(offset.length) : wire;
}

// Test-only: the memo is keyed on absolute paths that outlive a single test
// fixture, and a suite that git-inits a directory after a miss was cached
// would otherwise read the stale null.
function clearCache() { cache.clear(); }

module.exports = { repoRoot, trackedOffset, toWirePath, fromWirePath, clearCache };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "repo-root"`

Expected: eight `ok repo-root: ...` lines, no `FAIL`.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: the existing pass count plus 8, zero failures. Note the pre-existing count before you start so you can compare.

- [ ] **Step 6: Commit**

```bash
git add lib/repo-root.js test/run-tests.js
git commit -m "feat(paths): repo-root-relative translation for cross-machine file identity"
```

---

## Task 3: Wire path translation into teamsync

**Files:**
- Modify: `lib/teamsync.js` (`entryToRow`, and the pull-side content mapping)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `repoRoot.toWirePath`, `repoRoot.fromWirePath` from Task 2.
- Produces: `entryToRow(e, projectId, creds, share, regexes, projectPath)` — one new trailing parameter, `projectPath`, optional. When omitted, translation is skipped and behaviour is exactly as today.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js` after the Task 2 block:

```js
// ---- teamsync path translation (spec §7) ----
{
  const rr2 = path.join(ROOT, 'projects', 'mono2');
  const api2 = path.join(rr2, 'packages', 'api');
  fs.mkdirSync(api2, { recursive: true });
  spawnSync('git', ['init', '-q', rr2], { encoding: 'utf8' });
  repoRoot.clearCache();

  const entry = {
    ts: '2026-07-28T09:00:00Z', source: 'Claude Code', session: 's1',
    ask: null, goal: null, decisions: 'Renamed the retry cap to maxAttempts.',
    gotchas: '', files: ['src/validate.ts'],
    changes: [{ file: 'src/validate.ts', status: 'edited', add: 3, del: 1, note: 'blocked pending 018', dep: false }],
    summary: 'did a thing', headline: 'a thing', distilled: true,
  };
  const creds = { userId: 'u1', displayName: 'Andrew' };

  check('teamsync: push translates files to repo-root-relative', () => {
    const row = teamsync.entryToRow(entry, 'p1', creds, false, [], api2);
    assert.deepStrictEqual(row.files, ['packages/api/src/validate.ts']);
  });

  check('teamsync: push translates changes[].file to repo-root-relative', () => {
    const row = teamsync.entryToRow(entry, 'p1', creds, false, [], api2);
    assert.strictEqual(row.changes[0].file, 'packages/api/src/validate.ts');
    assert.strictEqual(row.changes[0].note, 'blocked pending 018');
  });

  check('teamsync: push without a projectPath is unchanged (back-compat)', () => {
    const row = teamsync.entryToRow(entry, 'p1', creds, false, []);
    assert.deepStrictEqual(row.files, ['src/validate.ts']);
    assert.strictEqual(row.changes[0].file, 'src/validate.ts');
  });

  check('teamsync: push at the repo root is identity', () => {
    const row = teamsync.entryToRow(entry, 'p1', creds, false, [], rr2);
    assert.deepStrictEqual(row.files, ['src/validate.ts']);
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep "teamsync: push"`

Expected: the first two `FAIL` (paths come back untranslated); the two back-compat checks already pass.

- [ ] **Step 3: Implement the push side**

In `lib/teamsync.js`, add the require near the other local requires at the top of the file:

```js
const repoRootLib = require('./repo-root');
```

Change the `entryToRow` signature and the two path-bearing fields. Find:

```js
function entryToRow(e, projectId, creds, share, regexes) {
```

Replace with:

```js
// projectPath is optional and trailing so every existing caller keeps working
// untouched. When supplied, `files` and `changes[].file` ship repo-root-relative
// so a monorepo teammate tracking a different depth of the same remote agrees
// on file identity (spec §7). Omitted -> no translation, byte-identical output.
function entryToRow(e, projectId, creds, share, regexes, projectPath) {
  const wire = p => (projectPath ? repoRootLib.toWirePath(projectPath, p) : p);
```

Then find:

```js
    files: e.files,
    changes: Array.isArray(e.changes) && e.changes.length ? e.changes.map(c => ({ ...c, note: scrub(c.note, 240) })) : null,
```

Replace with:

```js
    files: Array.isArray(e.files) ? e.files.map(wire) : e.files,
    changes: Array.isArray(e.changes) && e.changes.length
      ? e.changes.map(c => ({ ...c, file: wire(c.file), note: scrub(c.note, 240) }))
      : null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "teamsync: push"`

Expected: four `ok` lines.

- [ ] **Step 5: Pass the project path at every push call site**

Find every call to `entryToRow` in `lib/teamsync.js`. Each sits inside a loop or function that already has the local project path in scope (the same value passed to `repoUrl()`). Add it as the sixth argument. Verify none were missed:

```bash
grep -n "entryToRow(" lib/teamsync.js
```

Expected: every call site passes six arguments. A call with five is a missed site — the row will ship untranslated and a monorepo teammate silently will not match it.

- [ ] **Step 6: Run the whole suite**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: previous count plus 4, zero failures.

- [ ] **Step 7: Commit**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat(teamsync): ship file paths repo-root-relative"
```

---

## Task 4: The notes index — pure logic ✅ DONE (`a4f6c2a` + `0a489c6`, `feat/notes-index`)

**Corrections applied after implementation.** The `MAX_PROSE` bounds test below
now actually tests what its name claims (see its comment); the original asserted
only length. Task 4 also originally had no full-suite regression step — Step 5
below adds it, matching Tasks 2, 3 and 6.


All decision-making for the feature, with no fs and no clock. This is the module the repetition rules live in, so it carries the heaviest tests.

**Files:**
- Create: `lib/teammate-notes.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `lib/redact.js` (`redactDefault`).
- Produces:
  - `PROSE_CAP = 3`, `REFIRE_DAYS = 7`, `MAX_PROSE = 200`, `MAX_FILES = 500`, `SEEN_PRUNE_DAYS = 7`
  - `emptyIndex() -> index`
  - `buildIndex(entries, prev, now) -> index` — `entries` are decrypted teammate rows (`{author_name, ts, decisions, gotchas, changes, files}`); `prev` supplies carried-over `seen`; `now` is an ISO string.
  - `selectProse(index, now) -> { items, overflow }` — unseen prose, newest first, capped at `PROSE_CAP`.
  - `selectFileNotes(index, relPath, sessionId, now) -> items` — notes for one path not yet shown to this session and inside the re-fire window.
  - `markProseSeen(index, ids, now) -> index` (new object)
  - `markFileSeen(index, sessionId, ids, now) -> index` (new object)
  - `pruneSeen(index, now) -> index` (new object)
  - `formatProse(items, overflow) -> string`
  - `formatFileNotes(items) -> string`
  - `noteId(author, ts, text) -> string`

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: pure index logic (spec §4, §5) ----
const notes = require('../lib/teammate-notes');

{
  const T0 = '2026-07-28T09:00:00Z';
  const T1 = '2026-07-28T10:00:00Z';
  const LATER = '2026-08-10T10:00:00Z'; // 13 days after T0

  const rows = [
    {
      author_name: 'Andrew', ts: T0,
      decisions: 'Renamed the retry cap to maxAttempts.',
      gotchas: '',
      files: ['lib/validate.ts'],
      changes: [{ file: 'lib/validate.ts', note: 'blocked pending migration 018' }],
    },
    {
      author_name: 'Andrew', ts: T1,
      decisions: '', gotchas: 'The parser silently drops BOMs.',
      files: [], changes: null,
    },
  ];

  check('notes: buildIndex extracts decisions and gotchas as prose', () => {
    const ix = notes.buildIndex(rows, null, T1);
    assert.strictEqual(ix.prose.length, 2);
    const kinds = ix.prose.map(p => p.kind).sort();
    assert.deepStrictEqual(kinds, ['decision', 'gotcha']);
  });

  check('notes: buildIndex skips empty prose fields', () => {
    const ix = notes.buildIndex([{ author_name: 'A', ts: T0, decisions: '', gotchas: '' }], null, T1);
    assert.strictEqual(ix.prose.length, 0);
  });

  check('notes: buildIndex groups file notes by path', () => {
    const ix = notes.buildIndex(rows, null, T1);
    assert.ok(ix.byFile['lib/validate.ts']);
    assert.strictEqual(ix.byFile['lib/validate.ts'][0].note, 'blocked pending migration 018');
  });

  check('notes: buildIndex ignores changes entries with no note', () => {
    const ix = notes.buildIndex(
      [{ author_name: 'A', ts: T0, changes: [{ file: 'a.js', note: '' }, { file: 'b.js', note: null }] }],
      null, T1);
    assert.deepStrictEqual(Object.keys(ix.byFile), []);
  });

  check('notes: buildIndex carries prior seen state forward', () => {
    const first = notes.buildIndex(rows, null, T1);
    const id = first.prose[0].id;
    const marked = notes.markProseSeen(first, [id], T1);
    const rebuilt = notes.buildIndex(rows, marked, T1);
    assert.ok(rebuilt.seen.prose[id]);
  });

  check('notes: ids are stable across rebuilds', () => {
    const a = notes.buildIndex(rows, null, T1).prose.map(p => p.id).sort();
    const b = notes.buildIndex(rows, null, LATER).prose.map(p => p.id).sort();
    assert.deepStrictEqual(a, b);
  });

  check('notes: selectProse returns unseen items newest first', () => {
    const ix = notes.buildIndex(rows, null, T1);
    const { items } = notes.selectProse(ix, T1);
    assert.strictEqual(items.length, 2);
    assert.ok(items[0].ts >= items[1].ts);
  });

  check('notes: prose delivers once, globally', () => {
    let ix = notes.buildIndex(rows, null, T1);
    const ids = notes.selectProse(ix, T1).items.map(i => i.id);
    ix = notes.markProseSeen(ix, ids, T1);
    assert.strictEqual(notes.selectProse(ix, T1).items.length, 0);
    // still zero in a brand-new session, and still zero much later
    assert.strictEqual(notes.selectProse(ix, LATER).items.length, 0);
  });

  check('notes: unseen prose never expires (the vacation case)', () => {
    const ix = notes.buildIndex(rows, null, T1);
    assert.strictEqual(notes.selectProse(ix, LATER).items.length, 2);
  });

  check('notes: selectProse caps at PROSE_CAP and reports the overflow', () => {
    const many = [];
    for (let i = 0; i < 9; i++) {
      many.push({ author_name: 'A', ts: `2026-07-2${i}T09:00:00Z`, decisions: `decision ${i}`, gotchas: '' });
    }
    const ix = notes.buildIndex(many, null, T1);
    const { items, overflow } = notes.selectProse(ix, T1);
    assert.strictEqual(items.length, notes.PROSE_CAP);
    assert.strictEqual(overflow, 9 - notes.PROSE_CAP);
  });

  check('notes: file notes deliver once per session per file', () => {
    let ix = notes.buildIndex(rows, null, T1);
    const first = notes.selectFileNotes(ix, 'lib/validate.ts', 'sess-A', T1);
    assert.strictEqual(first.length, 1);
    ix = notes.markFileSeen(ix, 'sess-A', first.map(n => n.id), T1);
    assert.strictEqual(notes.selectFileNotes(ix, 'lib/validate.ts', 'sess-A', T1).length, 0);
  });

  check('notes: file notes re-fire in a new session', () => {
    let ix = notes.buildIndex(rows, null, T1);
    const ids = notes.selectFileNotes(ix, 'lib/validate.ts', 'sess-A', T1).map(n => n.id);
    ix = notes.markFileSeen(ix, 'sess-A', ids, T1);
    assert.strictEqual(notes.selectFileNotes(ix, 'lib/validate.ts', 'sess-B', T1).length, 1);
  });

  check('notes: file notes stop re-firing after REFIRE_DAYS', () => {
    const ix = notes.buildIndex(rows, null, T1);
    assert.strictEqual(notes.selectFileNotes(ix, 'lib/validate.ts', 'sess-C', LATER).length, 0);
  });

  check('notes: an unknown path yields no file notes', () => {
    const ix = notes.buildIndex(rows, null, T1);
    assert.deepStrictEqual(notes.selectFileNotes(ix, 'lib/nope.ts', 'sess-A', T1), []);
  });

  check('notes: buildIndex bounds prose to MAX_PROSE, newest kept', () => {
    // Timestamps MUST be monotonic in i. An earlier draft cycled the seconds
    // field (i % 60) with a 4-digit fraction Date.parse truncates to 3, so
    // recency had no relationship to i and the eviction set came out as four
    // clusters rather than the oldest 25 -- with a length-only assertion, an
    // implementation that evicted the NEWEST passed identically.
    const base = Date.parse('2026-01-01T00:00:00Z');
    const many = [];
    for (let i = 0; i < notes.MAX_PROSE + 25; i++) {
      many.push({ author_name: 'A', ts: new Date(base + i * 60000).toISOString(), decisions: `d${i}`, gotchas: '' });
    }
    const ix = notes.buildIndex(many, null, T1);
    assert.strictEqual(ix.prose.length, notes.MAX_PROSE);
    const texts = new Set(ix.prose.map(p => p.text));
    for (let i = 0; i < 25; i++) {
      assert.ok(!texts.has(`d${i}`), `d${i} is among the 25 oldest and must have been evicted`);
    }
    assert.ok(texts.has(`d${notes.MAX_PROSE + 24}`), 'the single newest entry must be kept');
    assert.ok(texts.has(`d25`), 'the oldest SURVIVOR (d25) must be kept');
  });

  check('notes: pruneSeen drops session records older than SEEN_PRUNE_DAYS', () => {
    let ix = notes.buildIndex(rows, null, T1);
    ix = notes.markFileSeen(ix, 'old-session', ['x'], T0);
    ix = notes.pruneSeen(ix, LATER);
    assert.strictEqual(ix.seen.file['old-session'], undefined);
  });

  check('notes: redaction runs on prose and on file notes', () => {
    const leaky = [{
      author_name: 'A', ts: T0,
      decisions: 'use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for now',
      gotchas: '',
      changes: [{ file: 'a.js', note: 'key sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }],
    }];
    const ix = notes.buildIndex(leaky, null, T1);
    assert.ok(!ix.prose[0].text.includes('sk-ant-api03-AAAA'));
    assert.ok(!ix.byFile['a.js'][0].note.includes('sk-ant-api03-BBBB'));
  });

  check('notes: formatProse renders authors and an overflow pointer', () => {
    const ix = notes.buildIndex(rows, null, T1);
    const { items, overflow } = notes.selectProse(ix, T1);
    const s = notes.formatProse(items, overflow);
    assert.ok(s.includes('Andrew'));
    assert.ok(s.includes('maxAttempts'));
  });

  check('notes: formatProse names the catch-up when there is overflow', () => {
    const many = [];
    for (let i = 0; i < 9; i++) {
      many.push({ author_name: 'A', ts: `2026-07-2${i}T09:00:00Z`, decisions: `decision ${i}`, gotchas: '' });
    }
    const ix = notes.buildIndex(many, null, T1);
    const { items, overflow } = notes.selectProse(ix, T1);
    assert.ok(notes.formatProse(items, overflow).includes(String(overflow)));
  });

  check('notes: formatFileNotes names the author and the note', () => {
    const ix = notes.buildIndex(rows, null, T1);
    const s = notes.formatFileNotes(notes.selectFileNotes(ix, 'lib/validate.ts', 's', T1));
    assert.ok(s.includes('Andrew'));
    assert.ok(s.includes('migration 018'));
  });

  check('notes: buildIndex survives malformed rows', () => {
    const ix = notes.buildIndex([null, {}, { changes: 'nope' }, { author_name: 'A' }], null, T1);
    assert.strictEqual(ix.prose.length, 0);
    assert.deepStrictEqual(Object.keys(ix.byFile), []);
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: the run aborts with `Error: Cannot find module '../lib/teammate-notes'`
and exit 1 — not per-check `FAIL` lines, for the reason given in Task 2 Step 2.

- [ ] **Step 3: Write the implementation**

Create `lib/teammate-notes.js`:

```js
'use strict';
// Pure logic for the teammate-notes index: build it from decrypted teammate
// rows, decide what to deliver, mark what was delivered, format it.
//
// NO fs AND NO CLOCK LIVE HERE. Every function that needs the time takes an
// injected `now` (ISO string), so the repetition rules below are table-testable
// with plain object literals -- the same contract lib/ledger-fold.js holds.
// The fs layer is lib/teammate-notes-store.js.
//
// THE RULES (spec §5), because they are the whole feature:
//   - Prose decisions deliver ONCE, GLOBALLY. A rename is a fact; once told,
//     you know.
//   - File notes deliver once PER SESSION, per file. A standing condition is
//     still true tomorrow and tomorrow's agent does not know it.
//   - The clock governs REPETITION, NOT FIRST DELIVERY. Anything never shown
//     never expires -- a teammate on holiday must not lose decisions made
//     while they were away.
//   - REFIRE_DAYS bounds only the re-firing of file notes on contact.
const crypto = require('crypto');
const redact = require('./redact');

const PROSE_CAP = 3;        // spec §5: hard cap per injection
const REFIRE_DAYS = 7;      // spec §5: governs re-firing only
const MAX_PROSE = 200;      // spec §4: index bounds; the feed is the full record
const MAX_FILES = 500;
const SEEN_PRUNE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
const str = v => (typeof v === 'string' ? v : '');

// Stable across rebuilds: the index is rewritten on every team pull, and an id
// that changed would re-deliver everything already marked seen.
function noteId(author, ts, text) {
  return crypto.createHash('sha1').update(`${author} ${ts} ${text}`).digest('hex').slice(0, 16);
}

function emptyIndex() {
  return { version: 1, updatedAt: null, prose: [], byFile: {}, seen: { prose: {}, file: {} } };
}

// Belt and braces (spec §8): the text was already redacted locally before push
// and scrubbed again in teamsync's entryToRow. This is the last gate before it
// can reach an agent context, and it is the only one this module controls.
const clean = s => redact.redactDefault(str(s)).trim();

// entries: decrypted teammate rows. prev: the previous index, whose `seen` is
// carried forward -- rebuilding must never resurrect an already-delivered note.
function buildIndex(entries, prev, now) {
  const carried = prev && prev.seen ? prev.seen : { prose: {}, file: {} };
  const index = emptyIndex();
  index.updatedAt = now;
  index.seen = {
    prose: { ...(carried.prose || {}) },
    file: { ...(carried.file || {}) },
  };

  const prose = [];
  const byFile = {};

  for (const row of Array.isArray(entries) ? entries : []) {
    if (!row || typeof row !== 'object') continue;
    const author = str(row.author_name) || 'a teammate';
    const ts = str(row.ts);
    if (!ts) continue;

    for (const kind of ['decision', 'gotcha']) {
      const text = clean(kind === 'decision' ? row.decisions : row.gotchas);
      if (!text) continue;
      prose.push({ id: noteId(author, ts, text), author, ts, kind, text });
    }

    for (const c of Array.isArray(row.changes) ? row.changes : []) {
      if (!c || typeof c !== 'object') continue;
      const file = str(c.file);
      const note = clean(c.note);
      if (!file || !note) continue;
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push({ id: noteId(author, ts, note), author, ts, note });
    }
  }

  // Newest first, then bounded. Dropping the OLDEST keeps the bound from
  // silently hiding what just happened.
  prose.sort((a, b) => ms(b.ts) - ms(a.ts));
  index.prose = dedupeById(prose).slice(0, MAX_PROSE);

  const paths = Object.keys(byFile).sort((a, b) => newestOf(byFile[b]) - newestOf(byFile[a]));
  for (const p of paths.slice(0, MAX_FILES)) {
    index.byFile[p] = dedupeById(byFile[p].sort((a, b) => ms(b.ts) - ms(a.ts)));
  }
  return index;
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

const newestOf = list => list.reduce((max, n) => Math.max(max, ms(n.ts)), 0);

// Unseen prose, newest first, capped. NO age filter: spec §5's "the clock
// governs repetition, not first delivery" is exactly this absence.
function selectProse(index, now) {
  const ix = index || emptyIndex();
  const seen = (ix.seen && ix.seen.prose) || {};
  const unseen = (ix.prose || []).filter(p => !seen[p.id]);
  return { items: unseen.slice(0, PROSE_CAP), overflow: Math.max(0, unseen.length - PROSE_CAP) };
}

// Notes for one path, excluding what this session already saw, and excluding
// anything past the re-fire window.
function selectFileNotes(index, relPath, sessionId, now) {
  const ix = index || emptyIndex();
  const list = (ix.byFile || {})[relPath];
  if (!Array.isArray(list) || !list.length) return [];
  const seenHere = ((ix.seen && ix.seen.file) || {})[sessionId] || {};
  const cutoff = ms(now) - REFIRE_DAYS * DAY_MS;
  return list.filter(n => !seenHere[n.id] && ms(n.ts) >= cutoff);
}

function markProseSeen(index, ids, now) {
  const ix = index || emptyIndex();
  const next = { ...((ix.seen && ix.seen.prose) || {}) };
  for (const id of ids || []) next[id] = now;
  return { ...ix, seen: { prose: next, file: { ...((ix.seen && ix.seen.file) || {}) } } };
}

function markFileSeen(index, sessionId, ids, now) {
  const ix = index || emptyIndex();
  const files = { ...((ix.seen && ix.seen.file) || {}) };
  const forSession = { ...(files[sessionId] || {}) };
  for (const id of ids || []) forSession[id] = now;
  files[sessionId] = forSession;
  return { ...ix, seen: { prose: { ...((ix.seen && ix.seen.prose) || {}) }, file: files } };
}

// Session records are keyed by session id and would otherwise grow forever.
// Prose markers are NOT pruned: "delivers once, globally" has no expiry, and
// dropping a marker would re-deliver a decision the user already read.
function pruneSeen(index, now) {
  const ix = index || emptyIndex();
  const cutoff = ms(now) - SEEN_PRUNE_DAYS * DAY_MS;
  const files = {};
  for (const [sessionId, marks] of Object.entries((ix.seen && ix.seen.file) || {})) {
    const newest = Object.values(marks).reduce((max, t) => Math.max(max, ms(t)), 0);
    if (newest >= cutoff) files[sessionId] = marks;
  }
  return { ...ix, seen: { prose: { ...((ix.seen && ix.seen.prose) || {}) }, file: files } };
}

function formatProse(items, overflow) {
  if (!items || !items.length) return '';
  const lines = items.map(i => `- ${i.author}: ${i.text}`);
  const head = overflow > 0
    ? `Teammate decisions you have not seen yet (${items.length} of ${items.length + overflow} — the rest are in the MemBridge feed):`
    : 'Teammate decisions you have not seen yet:';
  return [head, ...lines].join('\n');
}

function formatFileNotes(items) {
  if (!items || !items.length) return '';
  const lines = items.map(i => `- ${i.author}: ${i.note}`);
  return ['Teammate notes on this file:', ...lines].join('\n');
}

module.exports = {
  PROSE_CAP, REFIRE_DAYS, MAX_PROSE, MAX_FILES, SEEN_PRUNE_DAYS,
  emptyIndex, buildIndex, selectProse, selectFileNotes,
  markProseSeen, markFileSeen, pruneSeen,
  formatProse, formatFileNotes, noteId,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "notes:"`

Expected: 21 `ok notes: ...` lines, no `FAIL`.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: the baseline plus 21, with the same 5 pre-existing dependency
failures and no others.

- [ ] **Step 6: Commit**

```bash
git add lib/teammate-notes.js test/run-tests.js
git commit -m "feat(notes): pure teammate-notes index, selection and repetition rules"
```

---

## Task 5: The notes store — fs layer

**Files:**
- Create: `lib/teammate-notes-store.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `lib/memorydb.js` (`DIR_NAME`), `lib/teammate-notes.js` (`emptyIndex`).
- Produces:
  - `notesPath(projectPath) -> string`
  - `read(projectPath) -> index|null` — `null` on any error (fail-open miss).
  - `write(projectPath, index)` — atomic; throws only on a genuine fs failure.
  - `update(projectPath, fn)` — read, apply `fn(index)`, write. Swallows all errors and returns the resulting index or `null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: store (spec §4) ----
const notesStore = require('../lib/teammate-notes-store');

{
  const np = path.join(ROOT, 'projects', 'notes-proj');
  fs.mkdirSync(np, { recursive: true });

  check('notes-store: read of a missing file is null, not a throw', () => {
    assert.strictEqual(notesStore.read(np), null);
  });

  check('notes-store: write then read round-trips', () => {
    const ix = notes.buildIndex(
      [{ author_name: 'Andrew', ts: '2026-07-28T09:00:00Z', decisions: 'renamed the cap', gotchas: '' }],
      null, '2026-07-28T09:00:00Z');
    notesStore.write(np, ix);
    const back = notesStore.read(np);
    assert.strictEqual(back.prose.length, 1);
    assert.strictEqual(back.prose[0].text, 'renamed the cap');
  });

  check('notes-store: a corrupt file reads as null', () => {
    fs.writeFileSync(notesStore.notesPath(np), '{not json');
    assert.strictEqual(notesStore.read(np), null);
  });

  check('notes-store: update applies the function and persists', () => {
    notesStore.write(np, notes.emptyIndex());
    notesStore.update(np, ix => notes.markProseSeen(ix, ['abc'], '2026-07-28T10:00:00Z'));
    assert.ok(notesStore.read(np).seen.prose.abc);
  });

  check('notes-store: update on a corrupt file starts from empty, never throws', () => {
    fs.writeFileSync(notesStore.notesPath(np), 'garbage');
    const out = notesStore.update(np, ix => notes.markProseSeen(ix, ['zzz'], '2026-07-28T10:00:00Z'));
    assert.ok(out.seen.prose.zzz);
  });

  check('notes-store: write leaves no temp files behind', () => {
    notesStore.write(np, notes.emptyIndex());
    const strays = fs.readdirSync(path.dirname(notesStore.notesPath(np))).filter(f => f.includes('.tmp'));
    assert.deepStrictEqual(strays, []);
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | tail -20`

Expected: the run aborts with `Error: Cannot find module '../lib/teammate-notes-store'`
and exit 1 — not per-check `FAIL` lines, for the reason given in Task 2 Step 2.

- [ ] **Step 3: Write the implementation**

Create `lib/teammate-notes-store.js`:

```js
'use strict';
// The fs layer for <project>/.membridge/teammate-notes.json -- the single
// source of truth every delivery point reads (spec §4).
//
// FAIL-OPEN, like lib/recall-store.js's get(): any read or parse error is a
// MISS (null), never a thrown error. A hook that cannot read this file must
// behave exactly as if there were no teammate notes at all.
//
// One file, not a directory of blobs: the hook path reads it ahead of
// lib/hooks-recall.js's storeEntry gate on every Read, so it must be a single
// small parse and nothing more (spec §4.1).
const fs = require('fs');
const path = require('path');
const { DIR_NAME } = require('./memorydb');
const notes = require('./teammate-notes');

const notesPath = projectPath => path.join(projectPath, DIR_NAME, 'teammate-notes.json');

// Same tmp + rename pattern as lib/util.js's saveState, lib/ledger-store.js's
// writeLedger and lib/recall-store.js's put: a crash mid-write can only ever
// leave a stray temp file, never a half-written index.
let writeCounter = 0;

function write(projectPath, index) {
  const target = notesPath(projectPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(index); // throws before anything touches disk
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function read(projectPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(notesPath(projectPath), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

// Read-modify-write. A missing or corrupt index starts from empty rather than
// aborting: a hook marking a note as delivered must not fail just because the
// file was damaged -- worst case it re-delivers once.
function update(projectPath, fn) {
  try {
    const current = read(projectPath) || notes.emptyIndex();
    const next = fn(current);
    write(projectPath, next);
    return next;
  } catch {
    return null;
  }
}

module.exports = { notesPath, read, write, update };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "notes-store:"`

Expected: six `ok` lines.

- [ ] **Step 5: Commit**

```bash
git add lib/teammate-notes-store.js test/run-tests.js
git commit -m "feat(notes): atomic fail-open store for the teammate-notes index"
```

---

## Task 6: Build the index on every team pull

**Files:**
- Modify: `bin/membridge.js` (`teamTick`)
- Modify: `lib/server.js` (export a helper that reads a project's teammate entries)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `notes.buildIndex`, `notes.pruneSeen`, `notesStore.read`, `notesStore.write`, `repoRoot.fromWirePath`.
- Produces: `rebuildTeammateNotes(projectPath, entries, now) -> index|null`, exported from `lib/teammate-notes-store.js`. Later tasks read the file, never this function.

- [ ] **Step 1: Write the failing test**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: rebuild on pull ----
{
  const rp = path.join(ROOT, 'projects', 'rebuild-proj');
  fs.mkdirSync(rp, { recursive: true });

  const wireRows = [{
    author_name: 'Andrew', ts: '2026-07-28T09:00:00Z',
    decisions: 'Renamed the retry cap to maxAttempts.', gotchas: '',
    files: ['lib/validate.ts'],
    changes: [{ file: 'lib/validate.ts', note: 'blocked pending migration 018' }],
  }];

  check('notes-rebuild: writes an index readable by the store', () => {
    notesStore.rebuildTeammateNotes(rp, wireRows, '2026-07-28T09:05:00Z');
    const ix = notesStore.read(rp);
    assert.strictEqual(ix.prose.length, 1);
    assert.ok(ix.byFile['lib/validate.ts']);
  });

  check('notes-rebuild: preserves seen markers across a rebuild', () => {
    notesStore.rebuildTeammateNotes(rp, wireRows, '2026-07-28T09:05:00Z');
    const id = notesStore.read(rp).prose[0].id;
    notesStore.update(rp, ix => notes.markProseSeen(ix, [id], '2026-07-28T09:06:00Z'));
    notesStore.rebuildTeammateNotes(rp, wireRows, '2026-07-28T09:07:00Z');
    assert.ok(notesStore.read(rp).seen.prose[id]);
  });

  check('notes-rebuild: never throws on malformed input', () => {
    assert.doesNotThrow(() => notesStore.rebuildTeammateNotes(rp, null, '2026-07-28T09:05:00Z'));
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "notes-rebuild:"`

Expected: `FAIL` with `notesStore.rebuildTeammateNotes is not a function`.

- [ ] **Step 3: Add the rebuild function**

Append to `lib/teammate-notes-store.js`, before `module.exports`, and add `repoRoot` to the requires at the top (`const repoRoot = require('./repo-root');`):

```js
// Called once per team pull (bin/membridge.js's teamTick). `entries` are the
// decrypted teammate rows for ONE project, carrying REPO-ROOT-RELATIVE paths
// (spec §7). They are translated back to this machine's tracked-relative
// layout here, so every hook downstream can look up a path without doing any
// arithmetic on the read path.
//
// Fail-open: a failure here leaves the PREVIOUS index in place and serving.
function rebuildTeammateNotes(projectPath, entries, now) {
  try {
    const local = (Array.isArray(entries) ? entries : []).map(row => {
      if (!row || typeof row !== 'object') return row;
      if (!Array.isArray(row.changes)) return row;
      return {
        ...row,
        changes: row.changes.map(c => (c && typeof c === 'object'
          ? { ...c, file: repoRoot.fromWirePath(projectPath, c.file) }
          : c)),
      };
    });
    const prev = read(projectPath);
    const built = notes.buildIndex(local, prev, now);
    const pruned = notes.pruneSeen(built, now);
    write(projectPath, pruned);
    return pruned;
  } catch {
    return null;
  }
}
```

Add `rebuildTeammateNotes` to the exports:

```js
module.exports = { notesPath, read, write, update, rebuildTeammateNotes };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "notes-rebuild:"`

Expected: three `ok` lines.

- [ ] **Step 5: Call it from the daemon**

In `bin/membridge.js`, find `teamTick`'s `.then(r => {` block:

```js
      .then(r => {
        for (const key of r.changed) syncOnce({ project: key });
```

Replace with:

```js
      .then(r => {
        for (const key of r.changed) syncOnce({ project: key });
        // Rebuild each changed project's teammate-notes index from what just
        // landed, so the hooks have it before the agent's next tool call
        // (spec §3.1, delivery points 2-5). Fail-open: a project that throws
        // keeps its previous index and the loop continues.
        const nowIso = new Date().toISOString();
        for (const key of r.changed) {
          try {
            const teammateEntries = memorydb.readEntries(key).filter(e => e.origin === 'team');
            notesStore.rebuildTeammateNotes(key, teammateEntries, nowIso);
          } catch (err) {
            util.log(`teammate notes: ${key}: ${err.message}`);
          }
        }
```

Add the require near the other `lib/` requires at the top of `bin/membridge.js`:

```js
const notesStore = require('../lib/teammate-notes-store');
```

- [ ] **Step 6: Verify the entry reader name is right**

`memorydb.readEntries` is the assumed accessor for a project's stored entries. Confirm the real name and the flag that marks a teammate row:

```bash
grep -n "origin === 'team'\|origin: 'team'\|function readEntries\|module.exports" lib/memorydb.js | head -20
```

If the accessor has a different name, use the real one. If teammate rows are distinguished by something other than `origin`, use that instead — `lib/server.js`'s feed builder is the reference for how local and team entries are told apart.

- [ ] **Step 7: Run the whole suite**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: previous count plus 3, zero failures.

- [ ] **Step 8: Commit**

```bash
git add lib/teammate-notes-store.js bin/membridge.js test/run-tests.js
git commit -m "feat(notes): rebuild the teammate-notes index on every team pull"
```

---

## Task 7: Kill switch and hook registration

Registering the three new hook entries before the bodies exist keeps Tasks 8–10 to one concern each.

**Files:**
- Modify: `lib/hooks.js`
- Modify: `lib/membridge-hook.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: the existing `reconcileRecallHook` pattern in `lib/hooks.js`.
- Produces:
  - `reconcileNotesHooks()` in `lib/hooks.js` — registers `SessionStart` and `PostCompact`.
  - `isNotesEnabled(config) -> boolean` in `lib/teammate-notes.js`.
  - CLI routes: `membridge hook notes-session-start`, `notes-post-compact`.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: kill switch + registration ----
{
  check('notes: enabled by default', () => {
    assert.strictEqual(notes.isNotesEnabled({}), true);
  });

  check('notes: kill switch disables the feature', () => {
    assert.strictEqual(notes.isNotesEnabled({ teammateNotes: { enabled: false } }), false);
  });

  check('notes: an unrelated config key does not disable it', () => {
    assert.strictEqual(notes.isNotesEnabled({ teammateNotes: {} }), true);
  });

  check('hooks: reconcileNotesHooks registers SessionStart and PostCompact', () => {
    const r = hooks.reconcileNotesHooks();
    const settings = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    const cmds = arr => (arr || []).flatMap(e => (e.hooks || []).map(h => h.command));
    assert.ok(cmds(settings.hooks.SessionStart).some(c => /notes-session-start/.test(c)));
    assert.ok(cmds(settings.hooks.PostCompact).some(c => /notes-post-compact/.test(c)));
  });

  check('hooks: reconcileNotesHooks is idempotent', () => {
    hooks.reconcileNotesHooks();
    const r = hooks.reconcileNotesHooks();
    const settings = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    const n = (settings.hooks.SessionStart || [])
      .flatMap(e => (e.hooks || []).map(h => h.command))
      .filter(c => /notes-session-start/.test(c)).length;
    assert.strictEqual(n, 1);
  });

  check('hooks: reconcileNotesHooks leaves a foreign SessionStart entry alone', () => {
    const r0 = hooks.reconcileNotesHooks();
    const s0 = JSON.parse(fs.readFileSync(r0.file, 'utf8'));
    s0.hooks.SessionStart = [
      { hooks: [{ type: 'command', command: 'echo mine' }] },
      ...(s0.hooks.SessionStart || []),
    ];
    fs.writeFileSync(r0.file, JSON.stringify(s0, null, 2));
    hooks.reconcileNotesHooks();
    const s1 = JSON.parse(fs.readFileSync(r0.file, 'utf8'));
    assert.ok(s1.hooks.SessionStart.flatMap(e => (e.hooks || []).map(h => h.command)).includes('echo mine'));
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep -E "notes: (enabled|kill|an unrelated)|hooks: reconcileNotes"`

Expected: all `FAIL` — `notes.isNotesEnabled is not a function` and `hooks.reconcileNotesHooks is not a function`.

- [ ] **Step 3: Add the kill switch**

Append to `lib/teammate-notes.js`, before `module.exports`:

```js
// Mirrors lib/util.js's isProjectOff / config.recall.enabled shape: only the
// literal `false` disables. An absent or malformed config must never silently
// switch the feature off.
function isNotesEnabled(config) {
  const c = config && config.teammateNotes;
  return !(c && c.enabled === false);
}
```

Add `isNotesEnabled` to its exports.

- [ ] **Step 4: Add the reconciler**

In `lib/hooks.js`, read `reconcileRecallHook` first — it is the exact pattern to copy, including the "never touch a hook we do not own" ownership predicate and the `settings.hooks.X is not an array` refusal. Add alongside it:

```js
// Reconcile the teammate-notes hooks the same way reconcileRecallHook does for
// PreToolUse: same settings file, same ownership discipline (a user's own
// SessionStart/PostCompact entries live in these arrays too and must never be
// touched), same absolute-command shape with a subcommand that
// lib/membridge-hook.js routes on.
//
// FileChanged is deliberately absent: the Task 1 spike proved it suppresses
// systemMessage and that its matcher rejects any filename containing '.' or
// '-'. See docs/superpowers/spikes/2026-07-28-filechanged-findings.md.
const NOTES_HOOKS = [
  { event: 'SessionStart', sub: 'notes-session-start', timeout: 5, matcher: null },
  { event: 'PostCompact', sub: 'notes-post-compact', timeout: 5, matcher: null },
];

function isOwnNotesHook(entry, sub) {
  return (entry.hooks || []).some(h =>
    typeof h.command === 'string' &&
    /membridge/i.test(h.command) &&
    h.command.includes(sub));
}

function reconcileNotesHooks() {
  return withSettings(settings => {
    const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
    for (const spec of NOTES_HOOKS) {
      const list = next.hooks[spec.event];
      if (list !== undefined && !Array.isArray(list)) {
        throw new Error(`refusing to touch settings: "hooks.${spec.event}" is not an array`);
      }
      const current = list || [];
      const command = `${hookCommand()} ${spec.sub}`;
      const owned = current.filter(e => isOwnNotesHook(e, spec.sub));
      const others = current.filter(e => !isOwnNotesHook(e, spec.sub));
      const entry = { hooks: [{ type: 'command', command, timeout: spec.timeout }] };
      // Exactly one owned entry, command refreshed; every foreign entry kept
      // in its original order ahead of ours.
      next.hooks[spec.event] = owned.length ? [...others, entry] : [...others, entry];
    }
    return next;
  });
}
```

`withSettings` and `hookCommand` are placeholders for whatever the existing file calls its settings-read/write wrapper and its absolute-command builder. Read `reconcileRecallHook` and `reconcileStopHook` and reuse their real helpers verbatim — do not introduce new ones.

Add `reconcileNotesHooks` to the module exports, and call it from the same launch path that already calls `reconcileRecallHook()`:

```js
    reconcileRecallHook();        // every launch: same, for the PreToolUse recall hook
    reconcileNotesHooks();        // every launch: same, for the teammate-notes hooks
```

- [ ] **Step 5: Route the subcommands**

In `lib/membridge-hook.js`, find the existing routing that sends `recall` to `runRecall()` and add two cases mapping `notes-session-start` and `notes-post-compact` to `hooksNotes.runSessionStart()` and `runPostCompact()`. Those functions arrive in Task 9; add stubs now so registration is testable:

Create `lib/hooks-notes.js` with placeholders that will be filled in:

```js
'use strict';
// SessionStart / PostCompact hook bodies for teammate notes.
// Every entry point follows lib/hooks-recall.js's fail-open contract: the
// whole body is wrapped so any exception degrades to ordinary behaviour.
function runSessionStart() {}
function runPostCompact() {}
module.exports = { runSessionStart, runPostCompact };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep -E "notes: (enabled|kill|an unrelated)|hooks: reconcileNotes"`

Expected: six `ok` lines.

- [ ] **Step 7: Also remove them on `remove-hooks`**

`removeHooks()` already strips MemBridge's `Stop` and `PreToolUse` entries with per-array ownership predicates. Extend it to strip the new arrays with `isOwnNotesHook`. Verify:

```bash
node -e "
process.env.MEMBRIDGE_HOME='/tmp/mb-rm-'+Date.now();
const h=require('./lib/hooks');h.reconcileNotesHooks();h.removeHooks();
const fs=require('fs');const r=h.reconcileNotesHooks();
" && echo "removeHooks did not throw"
```

Then confirm by hand that `settings.json` has no `notes-` command left after `removeHooks()`.

- [ ] **Step 8: Commit**

```bash
git add lib/hooks.js lib/hooks-notes.js lib/membridge-hook.js lib/teammate-notes.js test/run-tests.js
git commit -m "feat(notes): register teammate-notes hooks and add the kill switch"
```

---

## Task 8: Delivery points 2 and 3 — the PreToolUse path

The heart of the feature: prose on arrival and file notes on contact, both without denying the read.

**Files:**
- Modify: `lib/hooks-recall.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `notesStore.read/update`, `notes.selectProse/selectFileNotes/markProseSeen/markFileSeen/formatProse/formatFileNotes/isNotesEnabled`.
- Produces: `buildNotesOutput(input) -> { text, commit } | null`, exported from `lib/hooks-recall.js` for direct testing. `commit()` performs the seen-marking; the caller invokes it only after the output is actually written.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: PreToolUse delivery (spec §3.1, §4.1) ----
const hooksRecall = require('../lib/hooks-recall');

{
  const hp = path.join(ROOT, 'projects', 'hook-notes-proj');
  fs.mkdirSync(hp, { recursive: true });
  const NOW = '2026-07-28T10:00:00Z';
  const rows = [{
    author_name: 'Andrew', ts: '2026-07-28T09:00:00Z',
    decisions: 'Renamed the retry cap to maxAttempts.', gotchas: '',
    changes: [{ file: 'lib/validate.ts', note: 'blocked pending migration 018' }],
  }];

  const fresh = () => { notesStore.write(hp, notes.buildIndex(rows, null, NOW)); };

  check('notes-hook: prose is delivered on any read (arrival)', () => {
    fresh();
    const out = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/unrelated.js', sessionId: 's1', now: NOW, config: {},
    });
    assert.ok(out && out.text.includes('maxAttempts'));
  });

  check('notes-hook: file note is delivered on contact', () => {
    fresh();
    const out = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's1', now: NOW, config: {},
    });
    assert.ok(out.text.includes('migration 018'));
  });

  check('notes-hook: prose is not re-delivered after commit', () => {
    fresh();
    const first = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/other.js', sessionId: 's1', now: NOW, config: {},
    });
    first.commit();
    const second = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/other.js', sessionId: 's2', now: NOW, config: {},
    });
    assert.strictEqual(second, null);
  });

  check('notes-hook: a file note re-fires in a new session but not the same one', () => {
    fresh();
    const a = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's1', now: NOW, config: {},
    });
    a.commit();
    const again = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's1', now: NOW, config: {},
    });
    assert.strictEqual(again, null);
    const other = hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's2', now: NOW, config: {},
    });
    assert.ok(other && other.text.includes('migration 018'));
  });

  check('notes-hook: nothing to say returns null', () => {
    notesStore.write(hp, notes.emptyIndex());
    assert.strictEqual(hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's9', now: NOW, config: {},
    }), null);
  });

  check('notes-hook: kill switch silences it', () => {
    fresh();
    assert.strictEqual(hooksRecall.buildNotesOutput({
      projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's1', now: NOW,
      config: { teammateNotes: { enabled: false } },
    }), null);
  });

  check('notes-hook: a corrupt index yields null, never a throw', () => {
    fs.writeFileSync(notesStore.notesPath(hp), 'not json');
    assert.doesNotThrow(() => {
      assert.strictEqual(hooksRecall.buildNotesOutput({
        projectPath: hp, relPath: 'lib/validate.ts', sessionId: 's1', now: NOW, config: {},
      }), null);
    });
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep "notes-hook:"`

Expected: all `FAIL` with `hooksRecall.buildNotesOutput is not a function`.

- [ ] **Step 3: Add `buildNotesOutput`**

In `lib/hooks-recall.js`, add the requires alongside the existing ones:

```js
const notes = require('./teammate-notes');
const notesStore = require('./teammate-notes-store');
```

Add the function above `doRunRecall`:

```js
// Delivery points 2 and 3 (spec §3.1): unseen prose decisions on ANY read
// (arrival), plus this file's notes on contact. Returns null when there is
// nothing to say -- the overwhelmingly common case, and the reason this is
// safe to call ahead of the storeEntry gate.
//
// The seen-marking is deliberately NOT done here. It is returned as commit(),
// so a note is only ever marked delivered once its text has actually been
// written to stdout. Marking first would lose a note whenever a later write
// threw -- the same pending/confirmation discipline the serve path uses for
// its event rows.
function buildNotesOutput({ projectPath, relPath, sessionId, now, config }) {
  try {
    if (!notes.isNotesEnabled(config)) return null;
    const index = notesStore.read(projectPath);
    if (!index) return null;

    const { items: prose, overflow } = notes.selectProse(index, now);
    const fileNotes = notes.selectFileNotes(index, relPath, sessionId, now);
    if (!prose.length && !fileNotes.length) return null;

    const parts = [];
    if (fileNotes.length) parts.push(notes.formatFileNotes(fileNotes));
    if (prose.length) parts.push(notes.formatProse(prose, overflow));
    const text = parts.join('\n\n');

    const proseIds = prose.map(p => p.id);
    const fileIds = fileNotes.map(n => n.id);
    const commit = () => {
      notesStore.update(projectPath, ix => {
        let next = ix;
        if (proseIds.length) next = notes.markProseSeen(next, proseIds, now);
        if (fileIds.length) next = notes.markFileSeen(next, sessionId, fileIds, now);
        return next;
      });
    };
    return { text, commit };
  } catch {
    return null;
  }
}
```

Export it by adding `buildNotesOutput` to the existing `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "notes-hook:"`

Expected: seven `ok` lines.

- [ ] **Step 5: Wire it into the hook body, ahead of the storeEntry gate**

In `doRunRecall`, find:

```js
  const storeEntry = recallStore.get(projectPath, relPath); // null on any store error -- fail-open
```

Insert immediately **above** it:

```js
  // Teammate notes (spec §4.1) are looked up BEFORE the storeEntry gate below,
  // because a teammate's warning about a file matters whether or not that file
  // is hot enough to have a cached skeleton. Cost on a miss is one small JSON
  // parse -- no content hash, no ledger read -- so the ordering discipline the
  // comment on storeEntry describes still holds.
  const notesOut = buildNotesOutput({
    projectPath, relPath, sessionId,
    now: new Date().toISOString(),
    config,
  });
```

Then find the early return:

```js
  if (!storeEntry) return;
```

Replace with:

```js
  if (!storeEntry) {
    // No skeleton to serve, but possibly a teammate note. Emit it as
    // additionalContext with an explicit allow: the read goes through
    // untouched and the note lands beside its result (spec §3.1).
    if (notesOut) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: notesOut.text,
        },
      }) + '\n');
      notesOut.commit();
    }
    return;
  }
```

Finally, in the `if (decision.serve)` branch, find:

```js
    const reason = reasonFor(decision, sessionState);
```

Replace with:

```js
    // Co-occurrence (spec §4.1): this read is ALREADY being denied on the
    // recall feature's own account, so the note rides on that one output
    // rather than becoming a second, conflicting one.
    const base = reasonFor(decision, sessionState);
    const reason = notesOut ? `${notesOut.text}\n\n${base}` : base;
```

and immediately after the `process.stdout.write(...)` in that branch, before its `return;`:

```js
    if (notesOut) notesOut.commit();
```

- [ ] **Step 6: Verify no read is ever denied by this feature alone**

```bash
grep -n "permissionDecision" lib/hooks-recall.js
```

Expected: exactly two occurrences — the pre-existing `'deny'` in the serve branch, and the new `'allow'` in the no-skeleton branch. A `'deny'` anywhere in the notes path is a Global Constraints violation.

- [ ] **Step 7: Run the whole suite**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: previous count plus 7, zero failures.

- [ ] **Step 8: Commit**

```bash
git add lib/hooks-recall.js test/run-tests.js
git commit -m "feat(notes): deliver prose on arrival and file notes on contact"
```

---

## Task 9: Delivery points 4 and 5 — SessionStart and PostCompact

**Files:**
- Modify: `lib/hooks-notes.js` (replace the Task 7 stubs)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `buildNotesOutput` semantics, but session-scoped rather than file-scoped.
- Produces:
  - `buildSessionOutput({ projectPath, sessionId, now, config }) -> { text, commit } | null` — unseen prose only, catch-up framing above the cap.
  - `runSessionStart()`, `runPostCompact()` — stdin payload → stdout `additionalContext`.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: SessionStart / PostCompact (spec §3.1) ----
const hooksNotes = require('../lib/hooks-notes');

{
  const sp = path.join(ROOT, 'projects', 'session-notes-proj');
  fs.mkdirSync(sp, { recursive: true });
  const NOW2 = '2026-07-28T10:00:00Z';
  const VERY_LATER = '2026-08-20T10:00:00Z';

  const manyRows = [];
  for (let i = 0; i < 9; i++) {
    manyRows.push({ author_name: 'Andrew', ts: `2026-07-2${i}T09:00:00Z`, decisions: `decision ${i}`, gotchas: '' });
  }

  check('notes-session: delivers unseen prose at session start', () => {
    notesStore.write(sp, notes.buildIndex(
      [{ author_name: 'A', ts: '2026-07-28T09:00:00Z', decisions: 'renamed the cap', gotchas: '' }], null, NOW2));
    const out = hooksNotes.buildSessionOutput({ projectPath: sp, sessionId: 's1', now: NOW2, config: {} });
    assert.ok(out.text.includes('renamed the cap'));
  });

  check('notes-session: shows a catch-up count when over the cap', () => {
    notesStore.write(sp, notes.buildIndex(manyRows, null, NOW2));
    const out = hooksNotes.buildSessionOutput({ projectPath: sp, sessionId: 's1', now: NOW2, config: {} });
    assert.ok(out.text.includes(String(9 - notes.PROSE_CAP)));
  });

  check('notes-session: nothing unseen returns null', () => {
    notesStore.write(sp, notes.buildIndex(manyRows, null, NOW2));
    const out = hooksNotes.buildSessionOutput({ projectPath: sp, sessionId: 's1', now: NOW2, config: {} });
    out.commit();
    // three delivered; drain the rest
    for (let i = 0; i < 3; i++) {
      const more = hooksNotes.buildSessionOutput({ projectPath: sp, sessionId: 's1', now: NOW2, config: {} });
      if (more) more.commit();
    }
    assert.strictEqual(hooksNotes.buildSessionOutput({ projectPath: sp, sessionId: 's1', now: NOW2, config: {} }), null);
  });

  check('notes-session: an old undelivered decision still arrives (vacation)', () => {
    notesStore.write(sp, notes.buildIndex(
      [{ author_name: 'A', ts: '2026-07-01T09:00:00Z', decisions: 'decided long ago', gotchas: '' }], null, NOW2));
    const out = hooksNotes.buildSessionOutput({ projectPath: sp, sessionId: 's2', now: VERY_LATER, config: {} });
    assert.ok(out.text.includes('decided long ago'));
  });

  check('notes-session: kill switch silences it', () => {
    notesStore.write(sp, notes.buildIndex(manyRows, null, NOW2));
    assert.strictEqual(hooksNotes.buildSessionOutput({
      projectPath: sp, sessionId: 's3', now: NOW2, config: { teammateNotes: { enabled: false } },
    }), null);
  });

  check('notes-session: a corrupt index yields null, never a throw', () => {
    fs.writeFileSync(notesStore.notesPath(sp), 'nope');
    assert.doesNotThrow(() => {
      assert.strictEqual(hooksNotes.buildSessionOutput({
        projectPath: sp, sessionId: 's4', now: NOW2, config: {},
      }), null);
    });
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep "notes-session:"`

Expected: all `FAIL` with `hooksNotes.buildSessionOutput is not a function`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `lib/hooks-notes.js`:

```js
'use strict';
// SessionStart / PostCompact hook bodies for teammate notes
// (spec §3.1, delivery points 4 and 5). There is no human-facing hook: the
// Task 1 spike ruled FileChanged out, so the dashboard carries that (Task 10).
//
// GOVERNING RULE, identical to lib/hooks-recall.js: every failure degrades to
// ordinary agent behaviour. Each run* entry point wraps its whole body, so a
// corrupt index, a permission error or a malformed payload all end as a silent
// no-op with at most a line in the local log.
//
// WHY PostCompact MATTERS: injected context is linear and compaction summarises
// it away. Without re-injection a decision delivered in hour one is simply gone
// by hour four, which is exactly the long session this feature exists for.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const projectResolve = require('./project-resolve');
const notes = require('./teammate-notes');
const notesStore = require('./teammate-notes-store');

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

// Session-scoped delivery: unseen PROSE only. File notes deliberately do not
// appear here -- they are meaningless until the agent touches the file, which
// is delivery point 3's job.
function buildSessionOutput({ projectPath, sessionId, now, config }) {
  try {
    if (!notes.isNotesEnabled(config)) return null;
    const index = notesStore.read(projectPath);
    if (!index) return null;
    const { items, overflow } = notes.selectProse(index, now);
    if (!items.length) return null;
    const text = notes.formatProse(items, overflow);
    const ids = items.map(i => i.id);
    const commit = () => notesStore.update(projectPath, ix => notes.markProseSeen(ix, ids, now));
    return { text, commit };
  } catch {
    return null;
  }
}

// Shared payload handling for the two model-facing entry points. Returns the
// resolved project and session, or null if this is not a usable invocation.
function readPayload(eventName) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || !cwd) return null;
  const state = util.loadState();
  const hit = projectResolve.resolveTrackedKey(state, path.join(cwd, 'x'));
  if (!hit) return null;
  return { eventName, sessionId, projectPath: hit.key, config: util.getConfig() };
}

function emit(eventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  }) + '\n');
}

function deliver(eventName) {
  const ctx = readPayload(eventName);
  if (!ctx) return;
  const out = buildSessionOutput({
    projectPath: ctx.projectPath,
    sessionId: ctx.sessionId,
    now: new Date().toISOString(),
    config: ctx.config,
  });
  if (!out) return;
  emit(eventName, out.text);
  out.commit(); // only after the write actually happened
}

function runSessionStart() {
  try { deliver('SessionStart'); } catch (err) {
    try { util.log(`hook notes session-start error: ${err && err.stack ? err.stack : err}`); } catch {}
  }
}

function runPostCompact() {
  try { deliver('PostCompact'); } catch (err) {
    try { util.log(`hook notes post-compact error: ${err && err.stack ? err.stack : err}`); } catch {}
  }
}

module.exports = { runSessionStart, runPostCompact, buildSessionOutput };
```

- [ ] **Step 4: Verify `resolveTrackedKey`'s calling convention**

`buildNotesOutput`'s caller in `lib/hooks-recall.js` passes an absolute **file** path, and `readPayload` above fakes one by joining `'x'` onto the cwd. Confirm whether `resolveTrackedKey` accepts a directory directly:

```bash
grep -n "function resolveTrackedKey" -A 20 lib/project-resolve.js
```

If it accepts a directory, drop the `path.join(cwd, 'x')` and pass `cwd`. If it expects a file (because it calls `path.dirname` first), keep the join and note why in a comment.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "notes-session:"`

Expected: six `ok` lines.

- [ ] **Step 6: Manual smoke test**

```bash
node -e "
const h=require('./lib/hooks-notes');
console.log(typeof h.runSessionStart, typeof h.runPostCompact, typeof h.buildSessionOutput);
"
```

Expected: `function function function`. This also catches the template-literal/backtick hazard noted in project memory for files loaded via `require`.

- [ ] **Step 7: Commit**

```bash
git add lib/hooks-notes.js test/run-tests.js
git commit -m "feat(notes): SessionStart and PostCompact delivery of unseen decisions"
```

---

## Task 10: Delivery point 1 — the human surface

Task 1 proved the in-terminal line impossible. This task is now: make a newly
arrived teammate decision visible in the dashboard, which already polls every
5 seconds. No hook, no `systemMessage`, no new mechanism.

**Files:**
- Modify: `lib/server.js` (expose unseen teammate decisions on an existing payload)
- Modify: `lib/dashboard/client.js` (render them)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `notesStore.read` from Task 5.
- Produces: `teammateNotes: { fresh: [{author, ts, text}], total }` on the
  payload the dashboard already polls.

- [ ] **Step 1: Write the failing test**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: dashboard surface (spec §6) ----
{
  const dp = path.join(ROOT, 'projects', 'dash-notes-proj');
  fs.mkdirSync(dp, { recursive: true });
  const NOW3 = '2026-07-28T10:00:00Z';

  check('notes-dash: unseen decisions appear on the polled payload', () => {
    notesStore.write(dp, notes.buildIndex(
      [{ author_name: 'Andrew', ts: '2026-07-28T09:55:00Z', decisions: 'do not touch validate.ts yet', gotchas: '' }],
      null, NOW3));
    const out = notes.dashboardPayload(notesStore.read(dp), NOW3);
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.fresh[0].author, 'Andrew');
    assert.ok(out.fresh[0].text.includes('validate.ts'));
  });

  check('notes-dash: an empty index yields an empty payload, not null', () => {
    notesStore.write(dp, notes.emptyIndex());
    const out = notes.dashboardPayload(notesStore.read(dp), NOW3);
    assert.deepStrictEqual(out, { fresh: [], total: 0 });
  });

  check('notes-dash: a missing index yields an empty payload', () => {
    assert.deepStrictEqual(notes.dashboardPayload(null, NOW3), { fresh: [], total: 0 });
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/run-tests.js 2>&1 | grep "notes-dash:"`

Expected: all `FAIL` with `notes.dashboardPayload is not a function`.

- [ ] **Step 3: Add the payload builder**

Append to `lib/teammate-notes.js`, before `module.exports`, and add
`dashboardPayload` to the exports:

```js
// Spec §6: the human surface. Deliberately independent of the `seen` markers
// the agent surfaces use -- being shown a decision in the dashboard is not the
// same event as an agent having consumed it, and conflating the two would let
// a browser visit silently suppress an agent-side delivery.
function dashboardPayload(index, now) {
  const ix = index || emptyIndex();
  const all = ix.prose || [];
  return { fresh: all.slice(0, PROSE_CAP), total: all.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run-tests.js 2>&1 | grep "notes-dash:"`

Expected: three `ok` lines.

- [ ] **Step 5: Surface it in the dashboard**

Add `teammateNotes: notes.dashboardPayload(notesStore.read(projectPath), new Date().toISOString())`
to the payload `lib/dashboard/client.js` already polls, and render each entry as
`<author> · <text>`. Follow the existing card markup; add no new poll and no new
endpoint.

**Hazard from project memory:** `lib/dashboard/client.js` is one large template
literal. A backtick in any added comment or code breaks `require` — this has
bitten twice. Smoke-check before committing:

```bash
node -e "require('./lib/dashboard/client.js'); console.log('client.js loads OK')"
```

- [ ] **Step 6: Run the whole suite**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: previous count plus 3, zero failures.

- [ ] **Step 7: Commit**

```bash
git add lib/teammate-notes.js lib/server.js lib/dashboard/client.js test/run-tests.js
git commit -m "feat(notes): surface newly arrived teammate decisions in the dashboard"
```

## Task 11: Token accounting

**Files:**
- Modify: `lib/ledger.js` (a new counter), `lib/hooks-recall.js` and `lib/hooks-notes.js` (tag at serve time), `lib/server.js` (the Savings line)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: the existing recall event-log pattern in `lib/hooks-recall.js` (`appendEvent`).
- Produces: `notesInjectedTokens` on the folded ledger, and a `notesInjectedTokens` field on the Savings payload.

- [ ] **Step 1: Read how the ledger folds recall events**

```bash
grep -n "notesInjected\|skeletonTokens\|function fold\|module.exports" lib/ledger-fold.js lib/ledger.js | head -30
```

The recall path writes rows to `.membridge/recall/events.jsonl` and the fold reduces them. Teammate-note injections follow exactly that shape: one row per injection carrying the token count, folded into a cumulative total. Do not invent a second mechanism.

- [ ] **Step 2: Write the failing test**

Append to `test/run-tests.js`:

```js
// ---- teammate notes: token accounting (spec §9) ----
{
  check('notes-tokens: an injection records its own token cost', () => {
    const tp = path.join(ROOT, 'projects', 'token-notes-proj');
    fs.mkdirSync(tp, { recursive: true });
    notesStore.write(tp, notes.buildIndex(
      [{ author_name: 'Andrew', ts: '2026-07-28T09:00:00Z', decisions: 'renamed the retry cap to maxAttempts', gotchas: '' }],
      null, '2026-07-28T10:00:00Z'));
    const out = hooksRecall.buildNotesOutput({
      projectPath: tp, relPath: 'lib/x.js', sessionId: 's1', now: '2026-07-28T10:00:00Z', config: {},
    });
    out.commit();
    const rows = fs.readFileSync(path.join(tp, '.membridge', 'recall', 'events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    const injected = rows.filter(r => r.kind === 'notes_injected');
    assert.strictEqual(injected.length, 1);
    assert.ok(injected[0].tokens > 0);
  });
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep "notes-tokens:"`

Expected: `FAIL` — either the events file does not exist or no `notes_injected` row is present.

- [ ] **Step 4: Tag at serve time**

In `lib/hooks-recall.js`, add `estimateTokens` to the existing skeleton require, then extend `commit` inside `buildNotesOutput`:

```js
    const commit = () => {
      notesStore.update(projectPath, ix => {
        let next = ix;
        if (proseIds.length) next = notes.markProseSeen(next, proseIds, now);
        if (fileIds.length) next = notes.markFileSeen(next, sessionId, fileIds, now);
        return next;
      });
      // Spec §9: exact attribution, tagged at the moment of injection rather
      // than inferred from context growth. Best-effort -- a failed measurement
      // row must never cost the user the note itself.
      try {
        appendEvent(projectPath, {
          ts: now, sessionId, relPath,
          kind: 'notes_injected',
          tokens: estimateTokens(text),
        });
      } catch {}
    };
```

Apply the same three lines to `buildSessionOutput`'s `commit` in `lib/hooks-notes.js`, with `relPath: null`. That file will need the same `appendEvent` helper — export it from `lib/hooks-recall.js` rather than duplicating it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node test/run-tests.js 2>&1 | grep "notes-tokens:"`

Expected: one `ok` line.

- [ ] **Step 6: Fold and surface it**

Add `notesInjectedTokens` to the fold's accumulator (summing `tokens` across `kind === 'notes_injected'` rows), and add it to the Savings payload in `lib/server.js`. Render it as its own line, **outside** the net-savings arithmetic:

```
Tokens injected as teammate notes, this period: 4,120
Teammate notes are an input cost, not an avoidance — their value is work you
did not redo, which this ledger cannot measure. Counted here, kept out of the
figure above.
```

Check the copy against the Global Constraints before committing: tokens, never dollars; "avoided", never "saved".

- [ ] **Step 7: Verify the figure is excluded from the net**

```bash
grep -n "notesInjectedTokens" lib/server.js lib/ledger-fold.js
```

Confirm by reading that no net-savings expression references `notesInjectedTokens`. If one does, that is a spec §9 violation.

- [ ] **Step 8: Commit**

```bash
git add lib/ledger.js lib/ledger-fold.js lib/hooks-recall.js lib/hooks-notes.js lib/server.js test/run-tests.js
git commit -m "feat(notes): report injected note tokens outside the savings balance"
```

---

## Task 12: End-to-end proof

**Files:**
- Create: `test/teammate-notes-e2e.js`

**Interfaces:**
- Consumes: everything above.
- Produces: an opt-in suite, run directly, never wired into `npm test` — the same contract as `test/recall-e2e.js` and `test/ledger-equivalence.js`.

- [ ] **Step 1: Write the end-to-end test**

Create `test/teammate-notes-e2e.js`:

```js
'use strict';
// End-to-end proof for live teammate decisions
// (docs/superpowers/specs/2026-07-28-live-teammate-decisions-design.md).
//
// Drives the real path: a teammate row with repo-root-relative paths ->
// rebuildTeammateNotes -> the PreToolUse hook body -> the SessionStart body,
// against a throwaway monorepo fixture, so the whole feature can be watched
// working before dogfooding it.
//
// Opt-in, exactly like test/recall-e2e.js -- never wired into `npm test`:
//   node test/teammate-notes-e2e.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-notes-e2e-'));
process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home');
process.env.MEMBRIDGE_NO_DIAGNOSTICS = '1';

const notes = require('../lib/teammate-notes');
const notesStore = require('../lib/teammate-notes-store');
const repoRoot = require('../lib/repo-root');
const hooksRecall = require('../lib/hooks-recall');
const hooksNotes = require('../lib/hooks-notes');

// A monorepo where THIS machine tracks packages/api while the teammate
// tracked the repo root -- the case spec §7 exists for.
const repo = path.join(ROOT, 'mono');
const tracked = path.join(repo, 'packages', 'api');
fs.mkdirSync(path.join(tracked, 'src'), { recursive: true });
fs.writeFileSync(path.join(tracked, 'src', 'validate.ts'), 'export const ok = 1;\n');
spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
repoRoot.clearCache();

const NOW = '2026-07-28T10:00:00Z';

// Exactly what the wire delivers: repo-root-relative paths.
const wireRows = [{
  author_name: 'Andrew',
  ts: '2026-07-28T09:40:00Z',
  decisions: 'Renamed the retry cap to maxAttempts for SDK consistency.',
  gotchas: '',
  files: ['packages/api/src/validate.ts'],
  changes: [{ file: 'packages/api/src/validate.ts', note: 'blocked pending migration 018' }],
}];

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
};

console.log('teammate notes end-to-end\n');

notesStore.rebuildTeammateNotes(tracked, wireRows, NOW);

check('wire paths are translated into this machine\'s tracked layout', () => {
  const ix = notesStore.read(tracked);
  assert.ok(ix.byFile['src/validate.ts'], `expected src/validate.ts, got ${Object.keys(ix.byFile)}`);
});

check('the rename reaches the agent on a read of an UNRELATED file', () => {
  const out = hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/other.ts', sessionId: 'sess-1', now: NOW, config: {},
  });
  assert.ok(out && out.text.includes('maxAttempts'));
  out.commit();
});

check('the rename is not repeated in a later session', () => {
  const out = hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/other.ts', sessionId: 'sess-2', now: NOW, config: {},
  });
  assert.ok(!out || !out.text.includes('maxAttempts'));
});

check('the file warning arrives on contact with validate.ts', () => {
  const out = hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/validate.ts', sessionId: 'sess-2', now: NOW, config: {},
  });
  assert.ok(out && out.text.includes('migration 018'));
  out.commit();
});

check('the same session is not warned twice about the same file', () => {
  const out = hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/validate.ts', sessionId: 'sess-2', now: NOW, config: {},
  });
  assert.strictEqual(out, null);
});

check('a NEW session is warned again while the condition is live', () => {
  const out = hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/validate.ts', sessionId: 'sess-3', now: NOW, config: {},
  });
  assert.ok(out && out.text.includes('migration 018'));
});

check('the warning stops re-firing after the 7-day window', () => {
  const out = hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/validate.ts', sessionId: 'sess-4',
    now: '2026-08-10T10:00:00Z', config: {},
  });
  assert.strictEqual(out, null);
});

check('an undelivered decision survives a two-week absence', () => {
  const p2 = path.join(ROOT, 'mono2');
  fs.mkdirSync(p2, { recursive: true });
  spawnSync('git', ['init', '-q', p2], { encoding: 'utf8' });
  repoRoot.clearCache();
  notesStore.rebuildTeammateNotes(p2, [{
    author_name: 'Andrew', ts: '2026-07-01T09:00:00Z',
    decisions: 'switched the queue to at-least-once', gotchas: '',
  }], NOW);
  const out = hooksNotes.buildSessionOutput({
    projectPath: p2, sessionId: 'back-from-holiday', now: '2026-08-20T10:00:00Z', config: {},
  });
  assert.ok(out && out.text.includes('at-least-once'));
});

check('the kill switch silences every surface', () => {
  const off = { teammateNotes: { enabled: false } };
  assert.strictEqual(hooksRecall.buildNotesOutput({
    projectPath: tracked, relPath: 'src/validate.ts', sessionId: 'sess-9', now: NOW, config: off,
  }), null);
  assert.strictEqual(hooksNotes.buildSessionOutput({
    projectPath: tracked, sessionId: 'sess-9', now: NOW, config: off,
  }), null);
});

check('a corrupt index degrades to silence, not a throw', () => {
  fs.writeFileSync(notesStore.notesPath(tracked), 'not json at all');
  assert.doesNotThrow(() => {
    assert.strictEqual(hooksRecall.buildNotesOutput({
      projectPath: tracked, relPath: 'src/validate.ts', sessionId: 'sess-x', now: NOW, config: {},
    }), null);
  });
});

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `node test/teammate-notes-e2e.js`

Expected: eleven `ok` lines and `all checks passed`, exit 0.

- [ ] **Step 3: Run the full suite one last time**

Run: `node test/run-tests.js 2>&1 | tail -5`

Expected: zero failures.

Note from project memory: `test/run-tests.js` hardcodes ports 17941/17961, and a live daemon or a `readme-demo` run squatting them makes roughly 32 API checks silently hit the *old* daemon. Before trusting a green run, check with `lsof -i :17941 -i :17961` and take a differential baseline against the count you recorded at Task 2 — never kill the squatters.

- [ ] **Step 4: Commit**

```bash
git add test/teammate-notes-e2e.js
git commit -m "test(notes): end-to-end proof of live teammate decision delivery"
```

---

## Task 13: Rebuild and dogfood

Project memory: rebuild and reinstall MemBridge.app after every large change.

- [ ] **Step 1: Rebuild the app**

```bash
node scripts/prepare-app.js
```

- [ ] **Step 2: Verify the new modules are in the bundle**

```bash
npx asar list app/dist/*.asar 2>/dev/null | grep -E "teammate-notes|repo-root|hooks-notes" || echo "CHECK: modules missing from the bundle"
```

Expected: `lib/teammate-notes.js`, `lib/teammate-notes-store.js`, `lib/repo-root.js`, `lib/hooks-notes.js`. Project memory records a prior release shipping without a required dependency in the asar — do not skip this.

- [ ] **Step 3: Confirm the hooks registered**

```bash
node bin/membridge.js setup-hooks && grep -c "notes-" ~/.claude/settings.json
```

Expected: 2 — one `notes-session-start`, one `notes-post-compact`.

- [ ] **Step 4: Watch it work**

With the daemon running and a team project linked, have a teammate's session record a decision, then in your own session read a file they annotated. Confirm the note appears next to the tool result and the read was **not** blocked.

- [ ] **Step 5: Commit anything the rebuild changed**

```bash
git status --short
```

Commit only genuine source changes. Build artefacts stay untracked.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §3.1 delivery point 1 (human) | 10 |
| §3.1 delivery points 2, 3 (PreToolUse) | 8 |
| §3.1 delivery points 4, 5 (PostCompact, SessionStart) | 9 |
| §4 the index (shape, bounds, atomic writes) | 4, 5 |
| §4.1 placement ahead of the storeEntry gate | 8 (step 5) |
| §5 repetition, expiry, catch-up, cap | 4, 9 |
| §6 human surface; existing surfaces unchanged | 10 |
| §7 repo-root-relative identity, legacy fallback | 2, 3 |
| §8 redaction; team-membership boundary | 4 (`clean`), 12 |
| §9 token accounting outside the balance | 11 |
| §10 failure modes, kill switch | 5, 7, 8, 9, 12 |
| §11 assumptions (now resolved) | 1 — done, NO-GO; consequences applied to Tasks 7, 9, 10 |
| §14 testing | every task, plus 12 |

**Naming consistency check.** `buildNotesOutput` (file/read-scoped, Task 8) and `buildSessionOutput` (session-scoped, Task 9) are distinct on purpose; both return `{ text, commit }`. `notesStore` is the store module everywhere; `notes` is the pure module everywhere. `rebuildTeammateNotes` lives on the store, not the pure module, because it does fs work.

**Two names to confirm against the real code before relying on them**, flagged inline at their point of use: `memorydb.readEntries` and the teammate-row marker in Task 6 step 6, and `resolveTrackedKey`'s file-vs-directory calling convention in Task 9 step 4. Both are verification steps, not guesses left for the implementer to resolve silently.

**Known deviation from the spec's file bounds.** New tests land in `test/run-tests.js`, already over 7,000 lines. That is the established convention in this repo, and splitting it is out of scope here.
