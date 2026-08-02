# Queue

What is being worked and in what order. `canonical-sources.md` lists this file
in the fresh-session read order; it did not exist until 2026-08-02, so anything
before that date was tracked in `state.md`'s "Not done" section instead.

`decisions.md` holds settled reasoning. `state.md` holds verified current
state. This file holds only what is next.

---

## In flight

**`feat/alpha-readiness-backfill`**, three commits, not merged and not pushed.
Alpha readiness Task 3 (adoption backfills prior history) plus the tombstone
that keeps a deliberately deleted project deleted. Task 3b passes at 17.3
seconds from install to visible memory. Merges cleanly into `master`.

## Next, in order

1. **Alpha readiness Task 5**, rewritten in full as 5A through 5E in
   `docs/superpowers/plans/2026-08-01-alpha-readiness.md`. Locked decision 5 in
   that plan is marked SUPERSEDED because of it; read both. 5A has a
   verification gate before any code: establish the provenance of `ask` versus
   `goal` and report before proceeding.
2. **Task 4**, the duplicate-daemon pid race.
3. **Task 6**, the duplicated `adoptProjects` at `lib/server.js:1347`. Both
   bodies were measured byte-identical (md5 `08e38450a77247e4f01b784f41751609`),
   so this one is mechanical.
4. **Task 7**, the installer SHA reconciliation. The repo copy and the deployed
   copy have drifted; fetch the live script before touching either.
5. **Task 8**, the Windows asset.

## Logged, not scheduled

These are real gaps found while doing other work. Neither is a defect in
something that was asked for, and neither is being fixed yet.

- **`membridge remove` purges memory but does not untrack, and there is no CLI
  untrack command at all.** `remove` strips the injected blocks and deletes
  `.membridge`, then leaves the project in `state.projects`. Untracking is only
  reachable through the dashboard's delete. One consequence is that the
  tombstone's re-add message cannot be reached from the CLI alone: a re-add of a
  still-tracked project reports "already tracked" and stops there.

- **There is no adopt surface in the React app, so `historyWithheld` has no
  consumer.** `ui/src` contains zero references to adopt or
  `/api/projects/add`. `adoptProjects` now reports `historyWithheld` so a
  re-add that withholds history can say why, and the CLI prints it, but nothing
  in the dashboard reads it. Whatever calls that route is not the React app.
  Worth resolving before anyone is told the dashboard surfaces this.

## Known failing check, not a regression

`worktrees: a non-repo directory returns [] rather than throwing` fails on any
machine with a live git worktree, because it reads the real repository's
worktree registry rather than its own fixture. See `state.md`. Treat one
failure as green on such a machine; a second failure is real.
