# Declared Project Identity (Core Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace git-remote-derived team-sync identity with a per-machine folder→project_id **binding**, so a fork/monorepo/no-remote folder syncs to the right project without guessing.

**Architecture:** A new `lib/binding.js` stores `boundProjectId`/`boundTeamId` on each `state.projects[path]` entry (source of truth) and writes a gitignored `.membridge/team.json` mirror. `syncTeams` reads the binding in place of `loadTeamLink`, falling back to a legacy committed `team.json` for continuity. A one-time migration seeds bindings from existing `team.json` files. CLI gains `bind`/`unbind` and a status line.

**Tech Stack:** Node.js (zero runtime deps), the bespoke `test/run-tests.js` harness (`check(name, fn)` assertions against a temp `MEMBRIDGE_HOME`), `lib/util.js` state helpers.

## Global Constraints

- Zero new runtime dependencies (raw `fs`/`path` only).
- State is the source of truth; the `.membridge/team.json` mirror is best-effort and **never** fails a bind if it can't be written.
- Non-breaking: a project with a legacy committed `team.json` but no binding must still sync exactly as today.
- Tests are added as `check('...', () => {...})` blocks in `test/run-tests.js`; run with `npm test`. Keep the full suite green.
- `boundTeamId` may be `null` (only the E2E-encryption path needs it; plaintext teams sync fine without it).

**Scope of THIS plan:** binding module, `syncTeams` wiring, migration, CLI. **Out of scope (follow-on plans):** `detectUnboundFolders` + remote/context pre-fill (Delta 3), desktop/dashboard bind chip (Delta 5 UI), backend `projects.repo_url`-optional metadata (Delta 4).

---

### Task 1: `resolveBinding` — pure ancestor-walk lookup

**Files:**
- Create: `lib/binding.js`
- Test: `test/run-tests.js` (append `check` blocks in the team-sync section)

**Interfaces:**
- Consumes: `util.normPath` from `lib/util.js`.
- Produces: `resolveBinding(state, folder) -> { projectId: string, teamId: string|null } | null`. Returns the binding on `folder` itself, else the nearest bound **ancestor** (worktree/sub-folder inheritance), else `null`.

- [ ] **Step 1: Write the failing test**

Add to `test/run-tests.js` (anywhere in the team-sync test area, e.g. near line 2000):

```js
const binding = require('../lib/binding');

check('binding.resolveBinding: direct binding on the folder', () => {
  const state = { projects: { '/repo': { boundProjectId: 'p1', boundTeamId: 't1' } } };
  assert.deepStrictEqual(binding.resolveBinding(state, '/repo'), { projectId: 'p1', teamId: 't1' });
});

check('binding.resolveBinding: worktree inherits nearest bound ancestor', () => {
  const state = { projects: { '/repo': { boundProjectId: 'p1', boundTeamId: 't1' } } };
  assert.deepStrictEqual(
    binding.resolveBinding(state, '/repo/.worktrees/feature'),
    { projectId: 'p1', teamId: 't1' });
});

check('binding.resolveBinding: unbound folder returns null', () => {
  const state = { projects: { '/repo': { events: [] } } };
  assert.strictEqual(binding.resolveBinding(state, '/repo/sub'), null);
});

check('binding.resolveBinding: nearest ancestor wins over farther one', () => {
  const state = { projects: {
    '/repo': { boundProjectId: 'root', boundTeamId: 't1' },
    '/repo/packages/api': { boundProjectId: 'api', boundTeamId: 't1' },
  } };
  assert.strictEqual(binding.resolveBinding(state, '/repo/packages/api/src').projectId, 'api');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "resolveBinding|Cannot find module"`
Expected: FAIL — `Cannot find module '../lib/binding'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/binding.js`:

```js
'use strict';
// Declared project identity: a per-machine binding of a folder path to a team
// project_id, set by an explicit user action and read by team sync in place of
// the old git-remote-derived link. A sub-folder or worktree with no binding of
// its own inherits the nearest bound ancestor, so a monorepo binds sub-projects
// independently and a worktree needs no separate bind.
const fs = require('fs');
const path = require('path');
const { normPath } = require('./util');

const DIR_NAME = '.membridge';
const MIRROR = 'team.json';
const mirrorPath = folder => path.join(folder, DIR_NAME, MIRROR);

// The binding for `folder`, or the nearest bound ancestor's, or null.
function resolveBinding(state, folder) {
  const projects = (state && state.projects) || {};
  const bound = new Map(); // normPath -> { projectId, teamId }
  for (const [k, p] of Object.entries(projects)) {
    if (p && p.boundProjectId) {
      bound.set(normPath(k), { projectId: p.boundProjectId, teamId: p.boundTeamId || null });
    }
  }
  let dir = path.resolve(String(folder));
  for (;;) {
    const hit = bound.get(normPath(dir));
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

module.exports = { resolveBinding, DIR_NAME, MIRROR, mirrorPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "resolveBinding"`
Expected: four `ok` lines, no `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add lib/binding.js test/run-tests.js
git commit -m "feat: add resolveBinding ancestor-walk for declared project identity"
```

---

### Task 2: `bindFolder` / `unbindFolder` — set state + gitignored mirror

**Files:**
- Modify: `lib/binding.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `resolveBinding` (Task 1).
- Produces:
  - `bindFolder(state, folder, projectId, teamId?) -> projEntry` — sets `boundProjectId`/`boundTeamId` on `state.projects[folder]` (creating the entry with `{ events: [] }` if absent), clears any `bindSuggestion`, and best-effort writes `.membridge/team.json` = `{ projectId, teamId, boundAt }`.
  - `unbindFolder(state, folder) -> void` — clears both fields and removes the mirror file.

- [ ] **Step 1: Write the failing test**

Add to `test/run-tests.js` (uses `ROOT`, the suite's temp dir):

```js
check('binding.bindFolder: writes state fields and a gitignored mirror', () => {
  const folder = path.join(ROOT, 'bind-test', 'repo');
  fs.mkdirSync(folder, { recursive: true });
  const state = { projects: {} };
  binding.bindFolder(state, folder, 'proj-abc', 'team-xyz');
  assert.strictEqual(state.projects[folder].boundProjectId, 'proj-abc');
  assert.strictEqual(state.projects[folder].boundTeamId, 'team-xyz');
  const mirror = JSON.parse(fs.readFileSync(path.join(folder, '.membridge', 'team.json'), 'utf8'));
  assert.strictEqual(mirror.projectId, 'proj-abc');
  assert.strictEqual(mirror.teamId, 'team-xyz');
  assert.ok(mirror.boundAt, 'mirror carries a boundAt timestamp');
});

check('binding.bindFolder: teamId defaults to null when omitted', () => {
  const folder = path.join(ROOT, 'bind-test', 'noteam');
  fs.mkdirSync(folder, { recursive: true });
  const state = { projects: {} };
  binding.bindFolder(state, folder, 'proj-only');
  assert.strictEqual(state.projects[folder].boundTeamId, null);
});

check('binding.unbindFolder: clears fields and removes the mirror', () => {
  const folder = path.join(ROOT, 'bind-test', 'repo2');
  fs.mkdirSync(folder, { recursive: true });
  const state = { projects: {} };
  binding.bindFolder(state, folder, 'p', 't');
  binding.unbindFolder(state, folder);
  assert.strictEqual(state.projects[folder].boundProjectId, undefined);
  assert.strictEqual(fs.existsSync(path.join(folder, '.membridge', 'team.json')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "bindFolder|unbindFolder"`
Expected: FAIL — `binding.bindFolder is not a function`.

- [ ] **Step 3: Write minimal implementation**

Edit `lib/binding.js` — add before `module.exports`:

```js
// Best-effort mirror write. State is the source of truth; a mirror we can't
// write must never fail the bind.
function writeMirror(folder, projectId, teamId) {
  try {
    fs.mkdirSync(path.join(folder, DIR_NAME), { recursive: true });
    fs.writeFileSync(mirrorPath(folder), JSON.stringify(
      { projectId, teamId: teamId || null, boundAt: new Date().toISOString() }, null, 2));
  } catch {}
}

function bindFolder(state, folder, projectId, teamId) {
  state.projects = state.projects || {};
  const proj = state.projects[folder] || (state.projects[folder] = { events: [] });
  proj.boundProjectId = projectId;
  proj.boundTeamId = teamId || null;
  delete proj.bindSuggestion;
  writeMirror(folder, projectId, teamId);
  return proj;
}

function unbindFolder(state, folder) {
  const proj = (state.projects || {})[folder];
  if (proj) { delete proj.boundProjectId; delete proj.boundTeamId; }
  try { fs.unlinkSync(mirrorPath(folder)); } catch {}
}
```

And extend the exports line:

```js
module.exports = { resolveBinding, bindFolder, unbindFolder, DIR_NAME, MIRROR, mirrorPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "bindFolder|unbindFolder"`
Expected: three `ok` lines, no `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add lib/binding.js test/run-tests.js
git commit -m "feat: bindFolder/unbindFolder set state + gitignored team.json mirror"
```

---

### Task 3: `syncTeams` reads the binding (with legacy fallback)

**Files:**
- Modify: `lib/teamsync.js` (the per-project loop in `syncTeams`, ~line 952-957)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `binding.resolveBinding` (Task 1); existing `loadTeamLink`.
- Produces: no signature change to `syncTeams`. Behavior: a folder with a binding syncs to `boundProjectId`; a folder with only a legacy committed `team.json` still syncs; a folder with neither is skipped.

- [ ] **Step 1: Write the failing test**

This reuses the existing mock-backend setup. Add near the other `syncTeams` tests (after the mock is started and a team/creds exist — mirror the pattern at lines ~2017-2132). Use an existing linked project's `projectId` so the push has a valid target:

```js
check('syncTeams: a bound folder (no team.json) syncs to boundProjectId', async () => {
  // linkA was created earlier in this block via teamsync.linkProject(...) → proj1.
  // Reuse its projectId, but bind a DIFFERENT folder that has no team.json.
  const linkAJson = teamsync.loadTeamLink(proj1);
  const boundOnly = path.join(ROOT, 'projects', 'bound-only');
  fs.mkdirSync(boundOnly, { recursive: true });
  const st = util.loadState();
  st.projects[boundOnly] = { events: [{ kind: 'edit', session: 's-bound', file: 'a.js', ts: new Date().toISOString() }] };
  binding.bindFolder(st, boundOnly, linkAJson.projectId, linkAJson.teamId || null);
  util.saveState(st);
  // Must NOT throw and must treat the folder as syncable (not skipped).
  const res = await teamsync.syncTeams({ project: boundOnly });
  assert.ok(res.synced.includes(boundOnly), 'bound folder was synced');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "bound folder was synced|a bound folder"`
Expected: FAIL — the folder is skipped (no `team.json`), so `res.synced` omits it.

- [ ] **Step 3: Write minimal implementation**

In `lib/teamsync.js`, add near the top with the other requires:

```js
const binding = require('./binding');
```

Then in `syncTeams`, replace:

```js
    const link = loadTeamLink(key);
    if (!link || !link.projectId) continue;
```

with:

```js
    // Declared binding is the source of truth; fall back to a legacy committed
    // team.json so projects linked the old way keep syncing during migration.
    const b = binding.resolveBinding(state, key);
    const link = b
      ? { projectId: b.projectId, teamId: b.teamId || null }
      : loadTeamLink(key);
    if (!link || !link.projectId) continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "a bound folder"`
Expected: `ok`. Then run the full suite: `npm test 2>&1 | tail -3` — expected no new `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat: syncTeams reads declared binding, legacy team.json as fallback"
```

---

### Task 4: One-time migration — seed bindings from legacy `team.json`

**Files:**
- Modify: `lib/binding.js`
- Modify: `lib/teamsync.js` (call migration once at the start of `syncTeams`, before the project loop)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `loadTeamLink` (imported into `binding.js` lazily to avoid a require cycle — see impl), `bindFolder` (Task 2).
- Produces: `migrateLegacyLinks(state) -> number` — for each `state.projects[path]` with a legacy `team.json` (`projectId` present) but **no** `boundProjectId`, set the binding from it (without rewriting the mirror). Returns how many were migrated. Idempotent.

- [ ] **Step 1: Write the failing test**

```js
check('binding.migrateLegacyLinks: seeds boundProjectId from a legacy team.json', () => {
  const folder = path.join(ROOT, 'migrate-test', 'legacy');
  fs.mkdirSync(path.join(folder, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.membridge', 'team.json'),
    JSON.stringify({ projectId: 'legacy-proj', teamId: 'legacy-team' }));
  const state = { projects: { [folder]: { events: [] } } };
  const n = binding.migrateLegacyLinks(state);
  assert.strictEqual(n, 1);
  assert.strictEqual(state.projects[folder].boundProjectId, 'legacy-proj');
  assert.strictEqual(state.projects[folder].boundTeamId, 'legacy-team');
  // idempotent: a second run migrates nothing
  assert.strictEqual(binding.migrateLegacyLinks(state), 0);
});

check('binding.migrateLegacyLinks: leaves already-bound projects untouched', () => {
  const folder = path.join(ROOT, 'migrate-test', 'already');
  const state = { projects: { [folder]: { boundProjectId: 'keep', boundTeamId: 'kt' } } };
  assert.strictEqual(binding.migrateLegacyLinks(state), 0);
  assert.strictEqual(state.projects[folder].boundProjectId, 'keep');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "migrateLegacyLinks"`
Expected: FAIL — `binding.migrateLegacyLinks is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `lib/binding.js`, add (requiring `teamsync` lazily inside the function to avoid the `teamsync ↔ binding` require cycle):

```js
// Seed bindings from legacy committed team.json files, once. Sets the binding
// in state WITHOUT rewriting the mirror (the legacy file already exists).
// Returns the count migrated; idempotent.
function migrateLegacyLinks(state) {
  const { loadTeamLink } = require('./teamsync');
  let n = 0;
  for (const [key, proj] of Object.entries((state && state.projects) || {})) {
    if (!proj || proj.boundProjectId) continue;
    const link = loadTeamLink(key);
    if (link && link.projectId) {
      proj.boundProjectId = link.projectId;
      proj.boundTeamId = link.teamId || null;
      n++;
    }
  }
  return n;
}
```

Extend exports:

```js
module.exports = { resolveBinding, bindFolder, unbindFolder, migrateLegacyLinks, DIR_NAME, MIRROR, mirrorPath };
```

In `lib/teamsync.js` `syncTeams`, right after `const state = util.loadState();`, add:

```js
  binding.migrateLegacyLinks(state); // one-time seed from legacy committed team.json
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "migrateLegacyLinks"`
Expected: two `ok` lines. Full suite: `npm test 2>&1 | tail -3` — no new `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add lib/binding.js lib/teamsync.js test/run-tests.js
git commit -m "feat: migrate legacy committed team.json into declared bindings"
```

---

### Task 5: CLI `bind` / `unbind` + `status` binding line

**Files:**
- Modify: `bin/membridge.js` (add `cmdBind`, `cmdUnbind`; register in the `commands` map ~line 680; add a line to `cmdStatus` ~the project loop)
- Test: `test/run-tests.js` (invoke the CLI via `spawnSync(BIN, ...)` — mirror existing CLI tests)

**Interfaces:**
- Consumes: `util.loadState/saveState`, `binding.bindFolder/unbindFolder/resolveBinding`.
- Produces: `membridge bind <projectId> [--team <teamId>]` binds `process.cwd()`; `membridge unbind` unbinds it; `membridge status` prints `bound → <projectId>` (or `unbound`) per project.

- [ ] **Step 1: Write the failing test**

```js
check('cli: bind then status shows the binding; unbind clears it', () => {
  const folder = path.join(ROOT, 'cli-bind', 'repo');
  fs.mkdirSync(folder, { recursive: true });
  const env = { ...process.env };
  let r = spawnSync(process.execPath, [BIN, 'bind', 'cli-proj', '--team', 'cli-team'], { cwd: folder, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const st = util.loadState();
  assert.strictEqual(binding.resolveBinding(st, folder).projectId, 'cli-proj');
  r = spawnSync(process.execPath, [BIN, 'unbind'], { cwd: folder, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(binding.resolveBinding(util.loadState(), folder), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "cli: bind then status"`
Expected: FAIL — `Unknown command: bind` (non-zero exit).

- [ ] **Step 3: Write minimal implementation**

In `bin/membridge.js`, add two command functions (place them near `cmdStatus`):

Commands take **no parameters** and read the module-level `args = process.argv.slice(2)` directly (so `args[0]` is `"bind"` and `args[1]` is the projectId), matching `cmdTeam`'s convention:

```js
function cmdBind() {
  const projectId = args[1];
  if (!projectId) die('Usage: membridge bind <projectId> [--team <teamId>]');
  const ti = args.indexOf('--team');
  const teamId = ti >= 0 ? args[ti + 1] : null;
  const folder = process.cwd();
  const state = util.loadState();
  binding.bindFolder(state, folder, projectId, teamId);
  util.saveState(state);
  console.log(`bound ${folder} → ${projectId}`);
}

function cmdUnbind() {
  const folder = process.cwd();
  const state = util.loadState();
  binding.unbindFolder(state, folder);
  util.saveState(state);
  console.log(`unbound ${folder}`);
}
```

(`die(...)` is the existing helper used elsewhere in `bin/membridge.js`; `args` is the module-level `process.argv.slice(2)`.)

Add the `binding` require near the top of `bin/membridge.js` with the other `require('../lib/...')` lines:

```js
const binding = require('../lib/binding');
```

Register in the `commands` map (~line 680):

```js
  bind: cmdBind,
  unbind: cmdUnbind,
```

In `cmdStatus`, inside the `for (const [key, proj] of projects)` loop, append the binding to the printed line — change:

```js
    console.log(`  ${key}${paused} — ${proj.events.length} event(s), last sync ${proj.lastSync || 'never'}`);
```

to:

```js
    const b = binding.resolveBinding(state, key);
    const bound = b ? `bound → ${b.projectId}` : 'unbound';
    console.log(`  ${key}${paused} — ${proj.events.length} event(s), ${bound}, last sync ${proj.lastSync || 'never'}`);
```

(Verified: the dispatcher calls `Promise.resolve().then(fn)` with **no arguments**; commands read the module-level `args`. `args[1]` is the first operand.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "cli: bind then status"`
Expected: `ok`. Full suite: `npm test 2>&1 | tail -3` — no new `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add bin/membridge.js test/run-tests.js
git commit -m "feat: membridge bind/unbind CLI + status binding line"
```

---

## Self-Review

- **Spec coverage (this plan's scope):** Delta 1 binding primitive → Tasks 1-2; Delta 2 sync reads binding → Task 3; Delta 6 migration → Task 4; Delta 5 CLI (`bind`/`unbind`/`status`) → Task 5. Deferred by design: Delta 3 detection/pre-fill, Delta 4 backend metadata, Delta 5 desktop/dashboard UI, and the `.gitignore` negation-revert (a docs/ops step done at rollout, not code) — each belongs to a follow-on plan.
- **Type consistency:** `resolveBinding` returns `{ projectId, teamId }|null` in Tasks 1, 3, 5; `bindFolder(state, folder, projectId, teamId?)` and `unbindFolder(state, folder)` consistent across Tasks 2, 5; `migrateLegacyLinks(state) -> number` in Task 4.
- **Placeholder scan:** none — every code and test step is complete.
- **CLI arg convention verified** (Task 5): dispatcher calls `fn` with no args; commands read module-level `args = process.argv.slice(2)`, so `cmdBind` uses `args[1]` for the projectId — matching `cmdTeam`.

## Follow-on plans (not this one)

1. **Detection + pre-fill** — `detectUnboundFolders`, git-remote and `CLAUDE.md` context-marker hints, `bindSuggestion`/dismiss (spec Delta 3).
2. **Backend metadata** — make `projects.repo_url` optional/non-identity; expose team project list for the picker (spec Delta 4).
3. **Desktop/dashboard bind chip** — the one-click / one-tap-confirm bind UX (spec Delta 5 UI).
4. **Rollout** — drop the `!**/.membridge/team.json` negation so the mirror becomes gitignored; archive the orphan fork project row (spec Delta 6 ops).
