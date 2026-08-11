# Feed rework — run-msgyghv4-3f7f

Lead's report for Andrew. Final.

> This file lives here because `~/.claude/command-center/runs/run-msgyghv4-3f7f/`
> is not writable by this session, and neither is `/tmp`. The run contract asked
> for `report.md` and `result.json` in the run directory; both are inlined here
> instead. `result.json` is at the bottom.

## Outcome: PARTIAL. Read this first.

All six asks were designed, built, and adversarially reviewed. **Nothing was
compiled, tested, committed, or merged.** `node` is absent from every session
here, including mine, and the sandbox refuses to reach a binary installed
elsewhere. `ui/node_modules/.bin/` has `tsc` and `vitest`, but they are Node
scripts with no interpreter. `git commit` is denied in every agent worktree.

So three complete diffs sit staged in three worktrees. A human has to land them.
Since no test could be run, I put the two large diffs under adversarial review
instead — that caught **four real defects**, three of which are fixed.

## Before you run the gate: revert one uncommitted file

`ui/vite.config.ts` has an **uncommitted** change adding `pool: 'threads'`. The
committed version of that exact spot says, in capitals:

> DO NOT set pool: 'threads' here. It was tried and it broke CI on every...
> A threads pool worker shares the parent process, the assignment lands too
> late... TZ=UTC with threads gives 10 failures in localTime.test.ts alone,
> TZ=UTC with forks gives 14 passes.

Project memory corroborates it: *"CI then went red from a vitest pool setting
that silently unpinned the timezone."* Every assertion in the changed feed tests
is pinned to `America/Los_Angeles`. **Run the gate with this in place and it
fails for reasons unrelated to this work, burying the real results.** Stash or
revert it first. I did not touch it: it is your uncommitted work.

Ticket #16.

## What you asked for

| # | Your ask | Built | Reviewed | Verified |
|---|---|---|---|---|
| 1 | Hover is transparent, make it solid and readable | Yes | By me | No |
| 2 | Sessions drop down, should be instant click-in | Yes | Yes | No |
| 3 | Bullets grouped per session under one fold named Summaries | Yes | Yes | No |
| 4 | Files touched above that, a fold, top 3 most-changed | Yes | Yes | No |
| 5 | Top 3 files and tool(s) on the day cards | Yes | Yes | No |
| 6 | A week of feed before Show more, +1 week per press | Yes | Yes | No |

## The answer to the hover complaint

**It is not transparency. It is contrast.** Every feed hover resolved to
`background: var(--panel2)`, and those rows sit directly on `--bg`:

| Mode | Ratio | ΔL\* |
|---|---|---|
| Dark | 1.09:1 | 4.2 |
| Light | **1.05:1** | **1.9** |

ΔL\* 1.9 is at or below the threshold of human vision. There is no translucency
anywhere in the feed tree. Two agents computed this independently, by hand, and
matched on 11 of 12 figures.

Fix: a `--hover` token (`#202E4A` dark, `#D9E2EC` light), plus a **step-up rule**
moving muted `--text3` to `--text2` while hovered — because `--text3` on the new
fill is 1.96:1 in light, so a fill-only change would have traded an invisible
hover for an unreadable one.

## Defects found in review, and what happened to them

**1. Dead "Loading…" button after a filter change. HIGH, user-visible, unrecoverable. FIXED.**
The auto-pager latches "already asked at this page count" in a ref, and `useFeed`
keys its cache on the filters — so picking a filter restarts the page count at
zero and the stale latch matches immediately, leaving the pager refusing to walk.
Under the old button that was a survivable no-op with a live "Show more". Under
the new target-keyed button it renders a **disabled "Loading…" that no request
will ever finish**, escapable only by another filter change or a reload. Fixed by
resetting the ref on the filters identity, with a regression test.

**2. `DayPage.test.tsx` bounded-walk test breaks. HIGH, would turn CI red. FIXED.**
It asserted a literal `<= 5` against a 160-row fixture. Raising `MAX_AUTO_PAGES`
to 14 broke it twice: 6 calls instead of 5, **and** the fixture became
exhaustible, so the day *was* reached and the test's own "not in view" premise
collapsed — it would have failed on that assertion first. Fixture raised to 420
rows; the assertion now reads the constant, so it holds at either cap.

**3. Tautological invariant test. MEDIUM. FIXED.**
`dayCards.test.ts` compared `dayBulletGroups(...).flatMap(g => g.bullets)`
against `dayBullets(...)` — which *is* that expression. It was `x === x` and
could not fail, while carrying a comment claiming it guarded the Summaries count.
Replaced with an assertion on `buildDayCards` output, where the two fields can
actually disagree.

**4. Two spec defects, caught by the bug-fixer during implementation. FIXED.**
The spec put the colour transition on `.day-card`, but `transition` is not
inherited and the step-up recolours *children* — it would have animated nothing.
And the step-up list missed `.day-card-overview-empty`, so on exactly the days
with least to show, "No summary yet for this day." would have sat at 1.96:1.

**One reviewer recommendation I rejected.** It wanted `buildDayCards` to call
`dayBullets` rather than flatten inline. That is wrong: `buildDayCards` already
derives both fields from the *same array in the same scope*, so drift is
structurally impossible, and the change would compute the groups twice.

**One reviewer "high" finding that was a false alarm.** It claimed the other two
worktrees carry an old `DayPage.tsx` that would silently revert the day-view
work depending on merge order. Both files are byte-identical to master, i.e.
never modified, and git merges by diff from the common ancestor. Merge order does
not matter here.

## The three branches to land

All staged-but-uncommitted, all based on `94c2d0a` = `origin/master` tip.

| Branch | Contents |
|---|---|
| `worktree-agent-a9409f0992baafd55` | `--hover` token, feed hover rules, global `button:hover`, `localTime.ts` docstring |
| `worktree-agent-a1acdfa5a9c5ccbd4` | Day view: Files fold, Summaries fold, `DaySessionRow`, chevron fix, 2 test fixes |
| `worktree-agent-ac801c62d7ba59fa6` | Day card files/tools, week paging, dup-key fix, dead-button fix, undated-bucket fix |

```
cd /Users/andrewbrown/membridge/membridge
git stash push ui/vite.config.ts          # see the warning above

git -C .claude/worktrees/agent-a9409f0992baafd55 commit -m "fix(ui): make hover states solid and readable"
git -C .claude/worktrees/agent-a1acdfa5a9c5ccbd4 commit -m "feat(feed): files fold above a summaries fold, sessions click straight in"
git -C .claude/worktrees/agent-ac801c62d7ba59fa6 commit -m "feat(feed): top files and tools on day cards, week-at-a-time paging"

git switch -c integrate/feed-rework 94c2d0a
git merge worktree-agent-a9409f0992baafd55
git merge worktree-agent-a1acdfa5a9c5ccbd4
git merge worktree-agent-ac801c62d7ba59fa6

node test/run.js && (cd ui && npx vitest run) && (cd ui && npx tsc --noEmit)
```

### One integration break that will NOT announce itself

Both builders added `export function tailPath` to `dayCards.ts`, **byte-identical
but at different offsets** (line 583 and line 539). The hunks do not overlap, so
**git may merge both cleanly with no conflict marker**, leaving two identical
function implementations and a `TS2393: Duplicate function implementation`.
Delete either copy. Do not skip this because the merge reported success.

Other expected conflicts are small: `feed.css` has three editors in mostly
disjoint regions, and the day-view branch deletes `.day-session-link:hover`,
which still exists in the hover branch. That deletion is correct.

## Decisions that need you

1. **Light-mode AA gap.** `--text2` on the new hover fill is **3.63:1**, short of
   4.5:1. Dark is fine at 5.28:1. It was already failing before this run (4.34:1
   on the old hover), so this exposes a pre-existing floor rather than creating
   one, and 3.63:1 is still far better than the 1.96:1 it replaces. Options:
   accept, or darken light `--text2` to `#55637A` (4.65:1 on the fill, 5.83:1 at
   rest). **I recommend the darkening.** Ticket #7.
2. **A session appears twice on the day view** — in Summaries with its bullets,
   in Sessions with its prompts, clickable in both. Deliberate, but it follows
   from your asking for both "click straight into a session" and "a dropdown
   named summaries." The reviewer notes both links have near-identical
   accessible names, and a `?session=` deep link highlights only the Sessions
   copy. Say if you want them merged into one list.
3. **Cold-open cost on a pasted day link tripled.** `DayPage` imports the same
   `MAX_AUTO_PAGES`, so an out-of-reach day now walks up to 14 pages before
   saying "That day is not in view", versus 5. Bounded, but it may deserve its
   own cap rather than sharing the feed's.
4. **Look at the hover in both themes at 900×600.** Nobody has seen it. Hover
   fill is CSS, jsdom never computes it, and `grep -rln getComputedStyle ui/src`
   returns nothing — no unit test in this repo could cover it even with a shell.

## Board

| # | Ticket | Status |
|---|---|---|
| 1 | Design spec | completed |
| 2 | Day view folds and session click-in | completed (unverified) |
| 3 | Day card files/tools, week paging | completed (unverified) |
| 4 | Solid readable hover | completed (unverified) |
| 5 | Integrate into one push-ready branch | **blocked**: no Node, no commit |
| 6 | Mission screenshots unreadable | closed, nothing further possible |
| 7 | Light `--text2` fails AA on hover fill | **open, needs Andrew** |
| 8 | Flip remaining `--panel2` hovers | partial: global button done, rows deferred |
| 9 | Focus lost on every route change | open, deferred with reason |
| 10 | Duplicate day-group React keys | completed |
| 11 | `localDayRangeUtc` boundary docstring | completed |
| 12 | Agent sandbox has no Node | **open, only Andrew can fix** |
| 13 | Session-row chevron in two positions | completed |
| 14 | Undated bucket counted as a day | completed |
| 15 | Day card CSS mixed 10px and token | completed |
| 16 | **CRITICAL** uncommitted `pool: 'threads'` | **open, revert before the gate** |
| 17 | Undated key collision edge case | open, low reachability |

## Why #8 and #9 were not finished

**#8**: flipping `.ruled-row`/`.entry-row`/`.btn-warn`/`.dialog-btn` hovers
*without* the step-up rule makes them worse, not better — those rows carry
`--text3` children that would land at 1.96:1. Doing it properly needs a
per-component audit, and `.ruled-row` is generic: its children come from each
calling feature, so there is no list to enumerate. It touches every screen and
needs the full suite. Not landable blind.

**#9**: route-change focus belongs in `Shell.tsx`, which every screen renders
through — the case the testing rules explicitly say requires the whole vitest
suite. Focus management is also easy to get subtly wrong in ways no type checker
catches.

## result.json

```json
{
  "runId": "run-msgyghv4-3f7f",
  "team": "lead + ui-designer + 2 ui builders + bug-fixer + 2 diff reviewers",
  "project": "/Users/andrewbrown/membridge/membridge",
  "outcome": "partial",
  "summary": "All six feed asks were built against origin/master and adversarially reviewed, but nothing was compiled, tested, committed or merged: node is absent from every session here and git commit is denied in every agent worktree. Three staged diffs sit in three worktrees. Review caught four real defects, three fixed: a dead disabled Loading button after any filter change, a DayPage test broken twice over by the raised page cap, and a tautological invariant test. The hover complaint was confirmed as a contrast defect, not transparency: panel2 as a hover fill is 1.09:1 dark and 1.05:1 light against the page background.",
  "fixed": [
    "#2 day view: Files fold, Summaries fold with per-session bullets, whole-row session click-in",
    "#3 feed list: top 3 files and tools on day cards, week-at-a-time paging",
    "#4 hover: --hover token, step-up rule, two spec defects corrected",
    "#10 duplicate day-group React keys (also merged two years into one section)",
    "#11 localDayRangeUtc docstring vs the server's inclusive bound",
    "#13 session-row chevron landing in two positions",
    "#14 undated bucket counted as one of the week's seven days",
    "#15 day card CSS mixing hardcoded 10px with var(--fs-xs)",
    "post-review: dead Loading button after filter change (stale pager latch)",
    "post-review: DayPage bounded-walk test fixture and literal cap assertion",
    "post-review: tautological dayBullets invariant test"
  ],
  "blockers": [
    "#16 CRITICAL uncommitted pool:'threads' in ui/vite.config.ts unpins the test timezone; revert before running the gate",
    "#5 integration impossible here: node absent from every session, git commit denied in every agent worktree",
    "#12 agent sandbox has no Node, so no UI agent can verify its own work",
    "#7 light --text2 is 3.63:1 on the new hover fill, short of AA; needs Andrew's call",
    "tailPath is defined byte-identically in two worktrees at different offsets; git may merge both with no conflict marker and produce a duplicate function implementation"
  ],
  "commits": [],
  "links": ["claude/ops/handoff-2026-08-06-feed-rework.md"],
  "followups": ["#5", "#7", "#8", "#9", "#12", "#16", "#17"],
  "pushReady": null,
  "pushReadyNote": "No push-ready branch exists. Source branches, all staged-but-uncommitted on 94c2d0a: worktree-agent-a9409f0992baafd55, worktree-agent-a1acdfa5a9c5ccbd4, worktree-agent-ac801c62d7ba59fa6.",
  "finishedAt": "2026-08-06T17:40:00Z"
}
```
