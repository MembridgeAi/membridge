# Projects Tab — Implementation Plan (light workflow)

> **For agentic workers:** single implementer per task + **ONE final whole-branch review**. Mostly UI over primitives that already exist — match rigor to risk. Use `superpowers:executing-plans` (single-agent, TDD), not the full adversarial review loop. Steps use checkbox (`- [ ]`) syntax.
>
> **Task 1 is the one to be careful with.** Everything else is presentational; Task 1 writes user config and rewrites files on disk. Its ordering assertion is load-bearing.

**Goal:** The projects grid holds a constant width at any team size, projects can be archived out of the list without destroying anything, and a shared project opens shared — per [the spec](../specs/2026-07-31-projects-tab-scale-and-archive-design.md).

**Architecture:** New `config.archived` array + `archiveProject`/`unarchiveProject` in `lib/server.js` composing the existing `toggleProject` and `removeBlockFromProject`. `ProjectsPage`'s member columns replaced by one Access cell + a new `AccessPopover`. Select mode + bulk archive. Delete demoted to a single-project typed confirmation. Project-page shared-state defect fixed.

**Tech stack:** Daemon is plain Node, harness `test/run-tests.js` (`node test/run-tests.js`). UI is React 19 + TS + wouter + react-query under `ui/` (`cd ui && npm test`). **First: run BOTH suites on a fresh branch and record the real baselines — do not assume any number.**

**Conventions:** commit `<type>: <description>`, no footer. TDD: failing test first, run it, watch it fail, then implement. Route paths from `ui/src/app/routes.ts`. Styles in `projects.css` using `styles/tokens.css` variables — no inline style objects, no hardcoded hex.

**Locked (do not relitigate):** archive destroys nothing (`.membridge/`, `memory.json`, `state.projects`, team archive all survive); archive pauses BEFORE stripping the block; archive is local-only and needs no role; existing feed history is not hidden by archiving; private rows render no checkbox at all; edit toggles are owner/admin only and members get a read-only roster (not disabled toggles); **Delete is not a bulk action.**

---

## Task 0: branch baselines

- [ ] Branch from current master. Run `node test/run-tests.js` and `cd ui && npm test`; record both real baselines in the branch's first commit message.

## Task 1: archive / unarchive in the daemon

**Files:** `lib/server.js`, `lib/util.js`, `test/run-tests.js`.

- [ ] **Failing tests:** `POST /api/projects/archive` puts the path in `config.archived` AND `config.exclude`; **asserts the write ORDER — pause is persisted before `removeBlockFromProject` runs** (spy/sequence assertion, not a comment); after archiving, `.membridge/memory.json` still exists on disk, `state.projects[key]` still exists, and the context file no longer contains the MemBridge block; `POST /api/projects/unarchive` removes both config entries and leaves memory intact; archiving an untracked path returns 404 with a JSON body, never 500; archiving an already-archived path is idempotent, not an error.
- [ ] Run → expect FAIL.
- [ ] Implement `archiveProject`/`unarchiveProject` composing `toggleProject` and `removeBlockFromProject`. **Do not modify either primitive.** Resolve through `findProjectKey` like every other destructive-adjacent handler. Register both endpoints beside `/api/projects/toggle`.
- [ ] Run → green + full suite. Commit: `feat(server): archive a project without destroying its memory`.

## Task 2: archived projects in the projects payload

**Files:** `lib/server.js`, `test/run-tests.js`.

- [ ] **Failing tests:** `projectsPayload` marks archived entries with an `archived: true` flag and still returns them (the UI sections them; it does not re-fetch); an archived path whose folder no longer exists is returned with a `missing` flag rather than omitted or thrown on.
- [ ] Run → expect FAIL. Implement. Run → green + full suite.
- [ ] Commit: `feat(server): projectsPayload reports archived state`.

## Task 3: verify the shared-pull question, then the access popover data path

**Files:** `ui/src/data/{types,DataClient,LocalDaemonClient,FakeDataClient,queries}.ts`, contract test.

- [ ] **First, answer the spec's open question:** trace whether `isProjectOff` / `config.exclude` also stops `teamsync` pulling teammates' entries for that project. Record the answer in the branch as a comment on `archiveProject`. If pulling DOES stop, add that sentence to the archive confirmation copy in Task 6.
- [ ] **Failing tests:** `Project` type carries `archived`/`missing`; `useArchiveProject`/`useUnarchiveProject` hit the Task-1 endpoints and invalidate the projects query; `FakeDataClient` gains a 10-member team fixture, a 30-member fixture, an archived project, and a member-role viewer.
- [ ] Run → expect FAIL. Implement. Run → green + both suites.
- [ ] Commit: `feat(ui): archive mutations, archived project state, 10/30-member fixtures`.

## Task 4: the Access cell + popover

**Files:** `ui/src/features/projects/{AccessSummary,AccessPopover}.tsx`, `ProjectsPage.tsx`, `projects.css`, tests alongside.

- [ ] **Failing tests:** a shared row renders 4 avatars + a `+N` chip + the label (`Whole team` / `6 of 10`); a private row renders `Only you` and **no checkbox exists in that row** (assert absence); the table's column count is IDENTICAL for the 3-member and 30-member fixtures; admin fixture → popover has toggles and Everyone/No one; member fixture → popover has **no toggles and no shortcuts** (assert absence) plus the explanatory note; the viewer's own row is never toggleable; the search field appears only above 8 members; `Escape` closes the popover and focus returns to the cell.
- [ ] Run → expect FAIL.
- [ ] Implement. Remove the per-member `<th>`/`<td>` block and the `scroll-x` wrapper from `ProjectsPage`. Keep `AccessCell.tsx` on disk — it is still valid for a raw matrix surface; it simply leaves this grid. Writes continue through `useSetProjectAccess` unchanged.
- [ ] Run → green + suite. Commit: `feat(ui): one Access column with an admin-gated popover`.

## Task 5: select mode + bulk archive + the Archived section

**Files:** `ProjectsPage.tsx`, `projects.css`, tests.

- [ ] **Failing tests:** `Select` reveals a checkbox gutter and swaps the header controls for `Done`; the action bar shows `N selected`; `Archive` calls the mutation once per selected path; **no Delete control exists anywhere in select mode** (assert absence); a partial failure (3 of 5) reports which failed and does NOT roll back the successes; `Cancel`/`Done` clears selection; archived projects render in a collapsed `Archived (N)` section with a working `Unarchive`; a `missing` archived row shows the muted note and still unarchives.
- [ ] Run → expect FAIL. Implement. Run → green + suite.
- [ ] Commit: `feat(ui): select mode, bulk archive, archived section`.

## Task 6: delete demoted to a single-project typed confirmation

**Files:** `ProjectsPage.tsx` or the project page's menu, `ConfirmDialog.tsx` if it needs a typed-input variant, tests.

- [ ] **Failing tests:** the confirm requires typing the exact project name before the destructive button enables; the copy names `.membridge/`, the context files, and the team archive; a shared project keeps the existing owner/manager gate; the dialog is reachable only for ONE project at a time.
- [ ] Run → expect FAIL. Implement. Run → green + suite.
- [ ] Commit: `feat(ui): delete requires a typed confirmation and leaves bulk`.

## Task 7: shared project opens shared

**Files:** `ui/src/features/project/ProjectPage.tsx`, `ProjectPage.test.tsx`, and whichever mapper supplies the shared flag.

- [ ] **Failing tests:** a project with a team link renders the `Shared` badge (not `Private`); its stream contains an entry authored by someone other than the viewer (assert a teammate-authored row is present — this is the actual defect); the member avatar stack renders.
- [ ] Run → expect FAIL.
- [ ] Implement: source the badge from the team link rather than a stale local flag, and remove the `self` filter from the project stream. **Diagnose before patching** — if the wrong data is arriving from the daemon, fix it there rather than compensating in the component.
- [ ] Run → green + both suites. Commit: `fix(ui): a shared project opens shared, with every author's sessions`.

## Final review (one pass)

- [ ] Whole-branch review against the spec: archive destroys nothing (re-read Task 1's assertions), pause-before-strip ordering intact, no Delete in bulk, private rows render no checkbox, members get a read-only roster rather than disabled toggles, no pre-existing test modified to pass, no hardcoded hex or route literals.
- [ ] Human pass with the real daemon: archive a private project and confirm `.membridge/memory.json` survives on disk; unarchive and confirm the block returns after a sync; open the popover as an admin and as a member; bulk-archive two projects; confirm the delete dialog refuses until the name is typed; open a shared project.

## Self-review

- Spec "constant width" → Task 4 (proven by the 3-vs-30 column-count assertion). "archive not delete" → Tasks 1, 2, 5, 6. "shared opens shared" → Task 7. "admin-only editing" → Task 4, reusing the existing `isTeamAdmin` gate.
- Out of scope and untouched: the session detail page (separate spec), the stale-`live` defect, analytics.
- Delegated (flagged): the shared-pull question in Task 3 — answer it before Task 6's copy is written; the assertions above stay as written either way.
