# Projects Tab: constant-width access, archive instead of delete, shared-project fix

**Date:** 2026-07-31
**Status:** Approved design (Andrew, from mock `projects-tab-mockups.html`, variant A)
**Applies to:** the React/TS dashboard in `ui/` — `features/projects/`, `features/project/`
**Builds on:** `ui/src/features/projects/{ProjectsPage,AccessCell}.tsx`, `lib/server.js` (`projectsPayload`, `toggleProject`, `removeBlockFromProject`, `deleteProject`), `lib/util.js` `isProjectOff`

## Problem

Three separate failures of the same screen, all visible at a 10-person team:

1. **The access grid grows a column per member.** `ProjectsPage` renders one `AccessCell` checkbox per member per project. Ten members means ten columns and a horizontal scrollbar; a private project still renders ten *dead* dashed cells for people who can never be granted access until it's shared. The layout's width is O(team size).
2. **There is no way to get a project out of the list.** The only removal path is `POST /api/projects/delete`, and `deleteProject()` is genuinely destructive: it wipes `.membridge/`, strips MemBridge's block out of `CLAUDE.md`/`AGENTS.md`, prunes the team archive, and drops central state. The user's actual need is organizational — "get this out of my view" — and the only tool available severs history.
3. **A shared project opens as private and shows only your own sessions.** Tapping into a project that is shared with a teammate renders the Private badge and a self-filtered stream, so the one screen meant to show shared work shows none of it.

## The model

### 1. One Access column, constant width

The N member columns collapse into a single **Access** cell per row.

- **Shared project** → a stacked avatar group: the first 4 members, then a `+N` chip, then a short label (`Whole team`, `6 of 10`, `3 of 10`). The whole cell is one button.
- **Private project** → the text `🔒 Only you`. **No checkboxes render for a project nobody else can be added to** — the dead dashed cells are removed, not restyled.
- Clicking the cell opens an **access popover**: a searchable member list (search appears at >8 members), one row per member with a toggle, and `Everyone` / `No one` shortcuts in the footer.

**Permissions.** The popover's toggles are owner/admin only. This reuses the gate that already exists — `showMatrix = !solo && client.capabilities.teamAdminSupported && isTeamAdmin` — rather than inventing a permission concept:

- **owner / admin** → toggles are live; changes write through `useSetProjectAccess` exactly as today and land in the audit trail.
- **member** → the same popover opens as a **read-only roster**: avatars and names, no toggles, no shortcuts, and a one-line note that only owners and admins change access. A member must still be able to *see* who can read a project; they must not be able to change it.
- The viewer's own row is always shown and never toggleable (unchanged from today's self-revoke guard).

The table's column set becomes fixed: `Project · Sessions 7d · Last activity · Sync · Access · (Open)`. No `scroll-x` at any team size.

### 2. Archive, not delete

**Archive is the bulk action. Delete is not.**

**Archive** removes a project from the Projects list and stops MemBridge watching it, while destroying nothing. It composes two existing, tested primitives plus one new flag:

1. Add the path to a new `config.archived` array (same shape and mechanism as `config.exclude` in `toggleProject`).
2. Pause watching — the path goes into `config.exclude`, so `isProjectOff` reports it off. **This happens BEFORE step 3**: `removeBlockFromProject`'s own contract notes that a sync will re-add the block unless the project is paused first.
3. Strip MemBridge's injected block from the project's context files via `removeBlockFromProject`, which by its own definition leaves `.membridge/` history, memory, and central state untouched.

What archive does **not** touch: `.membridge/memory.json`, `memory.md`, `state.projects[key]`, the team archive, team links, or any teammate's view. **Unarchive is total**: drop both config entries, and the next sync re-adds the block. Nothing is reconstructed because nothing was destroyed.

**Locked properties of archive:**

- **Local only, no permission required.** `config` is per-machine, so archiving is a personal view change. Archiving a shared project does not affect teammates, and a member may archive as freely as an owner.
- **History stays in the Feed.** Archive stops *new* capture; it does not retroactively hide entries already captured. The user's stated intent is organizing, not severing.
- **Archived projects live in a collapsed `Archived (N)` section** at the bottom of the Projects list, with a per-row `Unarchive`. They are never silently gone.
- **Archive implies paused.** An archived project that kept capturing, kept posting to the Feed, and kept injecting into `CLAUDE.md` would be an invisible ghost. `Pause` remains its own separate control for a project you want visible but idle.

**Delete** keeps its current destructive behavior and is **removed from bulk selection entirely**. It survives only as a single-project action behind a confirmation that (a) names what is destroyed in plain language — `.membridge/`, the context-file blocks, the team archive — and (b) requires typing the project name. A shared project's delete additionally keeps today's owner/manager gate.

### 3. Select mode

A `Select` button in the header swaps the table into selection mode: a checkbox gutter appears as the first column, the header's controls collapse to `Done`, and a sticky action bar appears at the bottom of the list showing `N selected`, a one-line blast-radius note, `Cancel`, and `Archive N projects`. Selecting rows does nothing until an action is pressed. Exiting select mode clears the selection.

### 4. Shared-project fix

Opening a shared project must render its shared identity and its shared stream: the `Shared` badge (from the project's team link, not a stale local flag), the member avatar stack, and a feed containing **every author's** sessions for that project — not a `self`-filtered one. This is a defect fix, not a design change; the project page already has the components.

## What does NOT change

- `/api/team/access-matrix` and `useSetProjectAccess` — the popover is a new presentation of the same data and the same write.
- `AccessCell` remains for any surface still rendering a raw matrix; it simply leaves the projects grid.
- `deleteProject()`, `removeBlockFromProject()`, `toggleProject()` — behavior untouched. Archive orchestrates them; it does not modify them.
- Sync state, the `Add project` dialog, project filtering, and the sessions/activity columns.

## Error handling

- Archiving a path the daemon does not track → 404 with a JSON body; the row returns to its unselected state and an inline error appears. Never a partial bulk apply reported as success.
- **Bulk archive is per-project and reports per-project.** If 3 of 5 succeed, the action bar says so and names the 2 that failed; it does not roll back the 3 that worked.
- `config.archived` containing a path that no longer exists on disk → the row renders in the Archived section with a muted `folder missing` note and an Unarchive that still works.
- Access popover write failure → the toggle reverts to its server state with an inline message, matching how `useSetProjectAccess` already surfaces failure.
- A member somehow reaching an edit path (stale role, race) → the daemon already 403s; the UI surfaces that rather than optimistically showing the change.

## Open question for the implementer

Whether pausing a **shared** project also stops pulling teammates' entries for it. If it does, an archived shared project goes quiet in the Feed as well as the Projects list. Verify against `teamsync` before implementing; if pulling does stop, say so in the archive confirmation copy rather than letting the user discover it.

## Accessibility

- The Access cell is a `<button>` with an accessible name naming the project and count (`Access for membridge-web, 6 of 10 members`).
- The popover is a focus-trapped dialog dismissed by `Escape` and by outside click; focus returns to the triggering cell.
- Selection checkboxes are real `<input type="checkbox">` with per-row labels naming the project.
- The read-only member view is not a disabled control set — disabled toggles read as "broken" to a screen reader. It renders as a plain list plus explanatory text.

## Testing (`vitest` + Testing Library for `ui/`, `test/run-tests.js` for the daemon)

- Access cell: shared row renders 4 avatars + `+N` + label; private row renders `Only you` and **no checkbox at all** (assert absence).
- Table width is independent of member count: a 3-member and a 30-member fixture produce the same column count.
- Popover: admin fixture renders toggles and shortcuts; member fixture renders neither (assert absence) plus the explanatory note; self row never toggleable; search appears only above 8 members.
- Select mode: gutter appears, action bar counts, `Cancel` clears, `Archive` calls the endpoint once per selected path, **no Delete control exists in bulk** (assert absence).
- Archive round trip (daemon): after archive, the path is in `config.archived` AND `config.exclude`, `.membridge/memory.json` still exists, `state.projects[key]` still exists, and the context file no longer contains the block. After unarchive, both config entries are gone and a sync re-adds the block. **Assert the ordering**: pause is written before the block strip.
- `projectsPayload` excludes archived paths from the main list and reports them under an `archived` flag the UI can section on.
- Delete: single-project only, requires the typed name, and the confirmation copy names `.membridge/`, the context files, and the team archive.
- Shared project page: renders the `Shared` badge and entries authored by someone other than the viewer (assert a teammate-authored row is present).
