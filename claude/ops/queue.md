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

## Found 2026-08-02 while dogfooding, not yet fixed

These came out of using the app rather than reading the code. Ordered by how
much they distort what a user sees.

- **Distillation stopped mid-session and nothing noticed.** Last summary written
  to `membridge/.membridge/summaries.jsonl` is `2026-08-02T00:35:00Z`. The
  session continued for hours past that and the Stop hook never prompted again.
  The hook IS registered in `~/.claude/settings.json` and its script IS readable
  (verified through Electron's fs), so the registration is not the problem. The
  hook appears to run and emit nothing. This is the highest-value open bug: the
  product's core loop silently stopped and the only symptom was a stale feed.

- **`isHookInstalled()` reports a false negative for every Electron install.**
  `lib/hooks.js` `commandIsLive` resolves the hook's script path with plain
  node's `fs`. The Electron registration points inside `app.asar`, which only
  resolves through Electron's patched `fs`, so a correct registration is judged
  dead. `membridge status` then says "Claude Code hook not installed" and tells
  the user to run `setup-hooks`, which would rewrite a registration that was
  already right. The irony is that `commandIsLive`'s own comment says it exists
  to close a hole; it opened the mirror-image one.

- **A session is attributed to its cwd, even when none of its edits are there.**
  Two days of membridge work landed under `mathetes` (270 events since Aug 2 vs
  6 for membridge) because the Claude Code session was started from
  `~/Desktop/mathetes`. MemBridge is doing what it was told: `cwd` is the signal
  it has. But `lib/project-resolve.js` already has `rehomeEvents`, and every
  edit event carries an absolute `ev.file`, so "most of this session's edits are
  under project X while it is filed under Y" is answerable with data already on
  hand. Do NOT auto-rehome silently. Surfacing it would have caught this on day
  one, and it belongs in the session analytics header.

## Known failing check, not a regression

`worktrees: a non-repo directory returns [] rather than throwing` fails on any
machine with a live git worktree, because it reads the real repository's
worktree registry rather than its own fixture. See `state.md`. Treat one
failure as green on such a machine; a second failure is real.
