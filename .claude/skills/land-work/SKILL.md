---
name: land-work
description: Consolidate agent worktrees and land finished work on master safely. Use when a teammate says a ticket is done, when several worktree branches need to be combined, before any merge or push, and when cleaning up worktrees afterwards. Covers the traps that make parallel worktrees lose work.
---

# Landing work from agent worktrees

**No agent merges, pushes, tags, or publishes. Ever.** An agent prepares the
land and reports; a human runs the last two commands. If you are an agent and
you find yourself typing `git merge` or `git push`, you have left your lane.

## The rules that make parallel work safe

- **One agent per working tree.** Not a preference. `state.json` has no locking,
  so any load-work-save cycle erases whatever another process wrote in between.
  Two agents in one tree silently destroy each other's work with no error.
- **Untracked files do not exist in a worktree.** `git worktree add` checks out
  tracked files only. Anything a teammate needs at runtime, including tooling
  scripts and `.claude/skills/`, must be committed to the branch the worktree is
  cut from or it will simply be missing.
- **Path keys fragment per worktree.** Any project-relative path used as a key
  splits the same file into a different row per worktree. Correct code keys
  through `repoRoot.ledgerKeyFor` / `wireKeyFor`. Expect ledger noise from
  parallel worktrees and do not "fix" it by rewriting keys.
- **`origin` is `github.com/MembridgeAi/membridge` and it is the only remote.**
  `andrewb-eng/membridge` is a dead fork, hundreds of commits behind. If you see
  it in `git remote -v`, stop and say so.

## Before landing anything

Run these in the teammate's worktree, not in the main checkout.

```sh
git -C <worktree> status --short          # expect a clean tree, or know why not
git -C <worktree> log --oneline master..HEAD
git -C <worktree> diff master...HEAD --stat
```

Read the diff against the ticket. The most common failure is not a broken
change, it is a correct change plus three unrelated ones. A diff wider than its
ticket goes back, even if every line is defensible.

Then verify only what the diff touches:

| Diff touches | Run |
| --- | --- |
| `ui/` | `cd ui && npx tsc --noEmit`, then `npx vitest run <affected files>` |
| A `lib/` area with a suite | `node test/run.js <suite>` |
| Other `lib/`, `bin/`, `scripts/` | `node -c <file>` plus a targeted `node -e` smoke |

Any red result goes through `node scripts/verify-finding.js` before it counts.
See the verify-finding skill. A phantom failure has stopped more good landings
here than a real one.

## Consolidating several worktrees

Land them **one at a time**, verifying between each. Batching is how a
conflict-driven mistake gets attributed to the wrong change.

Order by blast radius, smallest first. When two branches touch the same file,
land one, then rebase the other onto the result and re-run its verify sequence.
Do not merge both and reconcile afterwards.

If two teammates edited the same file, that is a lead failure to be recorded,
not just a conflict to resolve.

## The land itself, for a human

```sh
git switch master
git pull --ff-only origin master
git merge --no-ff <branch>          # human runs this
cd ui && npx tsc --noEmit
node test/run.js                    # full run is warranted here, once
cd ui && npx vitest run
git push origin master              # human runs this
gh run list --branch master --limit 3
```

**A green local run is not a green build.** `npm run build:ui` does not run
`tsc`, and only CI typechecks. Master was red for two days behind a passing
local build for exactly this reason. Watch the CI run finish before you call it
landed.

## Cleanup

```sh
git worktree list
git worktree remove <path>
git worktree prune
git branch -d <branch>
```

Remove the worktree before deleting the branch. A stale worktree entry pointing
at a deleted branch produces errors that look like repo corruption.

## Report

State which branches landed in which order, the verify output for each, the CI
run result, and anything you deliberately left unlanded. If you are an agent,
stop before the merge and hand the human the exact commands with the branch
names filled in.
