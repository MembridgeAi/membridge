# MB-B8 — Rename/move-aware churn survival

## Why this, now

`churn.js` reported **50.5% survival** on our own repo (43 settled commits,
3,516 lines written, 1,777 landed). ~89% of that "churn" was one file:
`lib/dashboard.js`, reported at **0 landed out of 1,567 written**.

Commit `6bb5f54 refactor(dashboard): split the 4590-line dashboard.js into
fragment modules` moved that code into `lib/dashboard/{client,styles,body}.js`.
`lib/dashboard.js` is now 46 lines. **The lines were moved, not deleted.**

Hand-corrected survival excluding that refactor is ~91%. So the metric reads a
healthy refactor as total failure — a 40-point error, in the direction that
makes the product look worse than it is.

This metric is the foundation of the planned install report and the external
pitch. It has to be right before anything is built on top of it.

## Rigor: HEAVY

Provenance correctness. TDD-first: write the failing test, confirm RED, then
implement. Gate with task-completion-validator and code-quality-pragmatist
before calling it done.

## Scope

IN: `lib/churn.js` and its tests.

NOT touching: `lib/provenance.js`, `lib/commits.js`, `lib/hooks.js`,
`lib/digest.js`, `lib/teamsync.js`, `lib/memorydb.js`, `lib/dashboard*`,
`lib/server.js`. No new CLI command. No report rendering. No backfill work.

Marco's lane (`hooks.js`, `digest.js`, `teamsync.js`, `memorydb.js`, dashboard
summary rendering) is untouched by this task.

## Tasks

1. **RED repro.** A test with a fixture repo where a file's contents are moved
   wholesale to a new path, then `churn()` reports 0% survival for those lines.
   Confirm it fails before writing any fix.

2. **Make survival rename/move-aware.**
   - `git blame -M` (moved/copied lines within a file) and `-C` (across files in
     the same commit) so relocated lines keep their originating sha.
   - Use `-w`. **Decided (Andrew, 2026-07-25): whitespace-only reformats do NOT
     count as churn.** A reindent is not rework. Document this in the header
     comment as an explicit definition of the metric, not an implementation
     detail.
   - Watch the cost: `-M -C -w` together make blame materially slower, and
     `lib/dashboard/client.js` is 4,086 lines. The install report has to feel
     instant, so measure blame wall-time on this repo and note it in the report.
     If it is slow, cache per-file blame results keyed by (path, HEAD sha)
     rather than dropping any of the three flags.
   - Follow renames when building the candidate file set. Today `files` is the
     set of paths a session wrote; if a path no longer exists at HEAD, resolve
     its successor (rename detection / `--follow`) before declaring those lines
     dead.

3. **Preserve the existing guarantees.**
   - No author/teammate parameter. Cross-person comparison stays impossible by
     construction — this is deliberate, do not "improve" it.
   - Degrade to `status: 'unavailable'` rather than throwing into a caller.
   - Injected git runner so tests stay offline.

4. **Distinguish moved from deleted.** The product needs to say "refactored"
   rather than "thrown away". Suggested return shape:
   `{ commits, written, landed, moved, fraction, status }`.

## Acceptance

- The RED test goes green.
- `churn(repo, {sinceDays: 7})` on this repo returns a fraction in roughly the
  0.85–0.95 band, and `lib/dashboard.js` no longer reads 0/1567.
- Full suite green; report the count (was 331/331).
- Header comment rewritten to describe the new semantics honestly, including
  what still legitimately reads as churn.

## Known follow-ups — do NOT do these here

- **MB-B9:** line-level `why` returns `session: null, fallback: "unmapped"` on
  `lib/hooks.js:172`, even though blame resolves `837b4e4a` and that sha IS
  mapped to session `af96dcff` in `.membridge/commits.jsonl`. The sha→session
  lookup is failing despite the data existing. This is the tagline degrading to
  plain git blame.
- **MB-B10:** a real `membridge why <file>[:<line>]` CLI subcommand wrapping
  `whyFile`. Today `why` ships only as an MCP tool.
- **MB-B11:** `membridge report` — the install-time survival report, plus
  git-log backfill past the commit map's start date (the map only reaches
  ~2026-07-15, which is why sinceDays=14/30 return `too-recent`).
