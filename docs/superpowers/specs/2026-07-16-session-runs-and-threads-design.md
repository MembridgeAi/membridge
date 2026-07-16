# Session Organization: Runs and Threads

**Date:** 2026-07-16
**Status:** Approved design (stages 2–4 pending; stage 1 shipped)
**Builds on:** [2026-07-15-summary-quality-and-attribution-design.md](2026-07-15-summary-quality-and-attribution-design.md) (Parts A & B)

## Problem

The feed shows one card per prompt. One piece of real work ("fix checkout
validation") appears as ten fragments; a long session mixing two tasks gets
conflated into noise; a chat launched from the wrong directory files under
the wrong project; and work resumed the next morning — or continued by a
teammate — looks unrelated to what it continues.

## The model

Stop organizing the feed around *prompts*. Organize it around *pieces of
work*, built in three layers:

- **Prompt** — what we capture today (an event stream: prompt / edit /
  summary / todos, per session).
- **Run** — one session's work inside one project: the `(session, project)`
  group of events. The atom the viewer should see.
- **Thread** — related runs linked across sessions and teammates by the
  files they touch. The unit of "a piece of work".

Delivered as four independently shippable stages. Stages 1–3 are
deterministic (no guessing). Stage 4 involves inference, so it debuts as a
harmless label rather than a load-bearing structure.

## Stage 1 — Attribution by edits (SHIPPED)

File a session's work under the project its edits actually land in, not the
launch `cwd`. Implemented per the
[Part B plan](../plans/2026-07-16-project-auto-attribution.md):
`lib/project-resolve.js` resolves each edited file to its nearest
already-tracked root (`.git` boundary stops escape into tracked parents);
`scan.js syncOnce` runs `rehomeEvents` before `mergeEvents`; the Stop hook
writes summaries into the dominant root's `.membridge/`. Tracked-roots
only; untracked edits keep `cwd`. On master as of commit `79ebda5`.

## Stage 2 — Detect & suggest untracked repos

**What:** When a session's edits resolve to *no* tracked root but land
inside an untracked git repo, surface a suggestion card in the dashboard:
"This session worked in `~/foo` — track it?" with **Track** / **Dismiss**.
Nothing is ever tracked automatically.

**How:**
- `resolveRoot` already stops at an untracked `.git` root and returns
  `null`. Extend the rehome pass to *collect* those untracked repo roots
  (root → edit count, per session) instead of discarding them.
- Persist candidates in `state.suggestedRoots`, with dismissed roots
  recorded in `state.dismissedRoots` so a dismissal is permanent until the
  user tracks the project manually.
- Dashboard renders at most a few suggestion cards above the feed, ranked
  by recent edit count. **Track** runs the same code path as adding a
  project manually; from the next sync, work files there (Stage 1 picks it
  up because the root is now tracked). Historical events re-home on the
  next full rescan; no special backfill pass.
- Home-directory and scratch paths (temp dirs, `node_modules`, tool caches)
  are never suggested.

## Stage 3 — Runs as the feed unit

**What:** The feed shows one card per **run** — a `(session, project)`
group — instead of one card per ask. This is where fragmentation and
conflation within a sitting die.

**Card contents:** person avatar, tool, project pill, the distilled
summary (Part A) leading, files touched, first→last timestamp span, and a
prompt count. The individual asks fold into an expandable detail section
(`Asked:` lines, newest last). A run whose session is still active shows
`Working on:` exactly as today, so unfinished work never looks finished.

**How:**
- Grouping happens at render time in `lib/feed.js` / `lib/dashboard.js`:
  bucket merged events by `(session, project)`, order runs by their latest
  event. No storage format change — events stay events.
- A multi-repo session yields one run per project (consistent with Part B
  decision #6: edits split by resolved root, non-edit events follow the
  dominant root).
- Sessions with no session id (older data, tools that don't emit one)
  degrade to today's per-ask cards.
- Team feed: teammates' entries already arrive summarized per-ask; group
  them by their session id where present, same rules.

## Stage 4 — Threads (quiet label first)

**What:** Link runs that are plausibly the same piece of work: same
project, overlapping touched files, within a recency window. Surface the
link as a **caption on the run card** — "Continues Monday's work" /
"Andrew also worked on these files" — clicking through to the related
run(s). The feed's structure does not change in this stage.

**Matcher (initial heuristic, expected to need tuning):**
- Candidates: runs in the same project within a 14-day window.
- Overlap: ≥ 2 shared touched files, excluding ubiquitous files
  (lockfiles, `package.json`, generated dirs — reuse/extend the existing
  dependency-file exclusion patterns).
- Same-file rarity weighting can come later; start with the simple rule
  and observe.

**Why label-first:** the matcher will sometimes be wrong. As a caption, a
bad match costs one misleading line; as a feed structure, it would break
the whole dashboard. Only after the label proves reliable on real data do
we consider grouping the feed by thread (explicitly out of scope here).

## Error handling

- Rehoming and grouping never throw the sync loop: malformed events keep
  their existing `project` and render per-ask (today's behavior is always
  the fallback).
- Suggestion cards render only when the dashboard can verify the root still
  exists on disk; stale candidates are pruned on scan.
- Thread captions render only when both runs are still present in the feed
  window; a dangling link is dropped silently.

## Testing

Custom harness (`test/run-tests.js`, `check(name, fn)`), per stage:
- Stage 2: untracked-repo collection (real temp dirs with `.git`),
  dismissal persistence, never-suggest paths (home dir, `node_modules`).
- Stage 3: run grouping (multi-ask session → one run; multi-repo session →
  two runs; missing session id → per-ask fallback; active session shows
  `Working on:`).
- Stage 4: overlap matcher (shared files above/below threshold, ubiquitous
  file exclusion, window cutoff), caption rendering, dangling-link drop.

## Out of scope (YAGNI)

- Grouping the feed *by thread* (Stage 4 stays a label until proven).
- Auto-tracking discovered repos (suggest-only, forever).
- Semantic/text-similarity matching of runs (files-only first).
- Backfill migration of historical events (natural rescan is enough).
- Cross-project threads.

## Sequencing

Each stage ships independently, in order: 2 → 3 → 4. Stage 3 delivers the
biggest visible improvement; Stage 2 is first only because it is small and
closes the attribution gap Stage 1 left (untracked repos). Rebuild and
reinstall MemBridge.app after each stage lands (per project convention).
