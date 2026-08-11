---
name: regression-test
description: Add a test to the MemBridge repo correctly, and verify only what changed. Use when writing a regression test for a confirmed bug, adding coverage for new behaviour, or deciding which verify command to run before marking work done.
---

# Writing and running tests here

**The full suite is a ship gate, not a development loop.** Do not run the whole
thing after every change, and never to "establish a baseline".

## Write the failing test first

For a confirmed finding: write the test, watch it fail for the reason in the
finding, then fix the code and watch it pass. A bug that lands without a
regression test comes back, and next time nobody remembers it was diagnosed.

If a finding is genuinely untestable without rebuilding the harness, say so
explicitly in your report. That is an answer. A silent skip is not.

## Where a new test goes

The suite is split. Self-contained sections live in `test/suites/*.test.js` and
each runs standalone in seconds. The rest is the legacy monolith
`test/run-tests.js`, about 24k lines of one sequential end-to-end story with
real HTTP servers and real git subprocesses, whose sections build on each
other's state on purpose.

- **New tests go in `test/suites/`.** Either an existing `<topic>.test.js` or a
  new one. Add to the monolith only when the test genuinely needs the
  accumulated fixture state, and justify it in your report.
- A new suite file **requires `../harness` first**, before anything else, and
  **ends with `h.finish()`**.
- A suite with wall-clock performance assertions carries **`@serial`** in its
  header comment, or it measures CPU contention instead of your code.
- Nothing to register. `node test/run.js --list` discovers suite files.

UI tests are vitest, colocated under `ui/src/`.

## Verify only what you touched

| What changed | How to verify it |
| --- | --- |
| `ui/` | `cd ui && npx tsc --noEmit` (seconds, the only local type check), then `npx vitest run <affected file(s)>`. Whole vitest suite only for shared code such as DataClient or the app shell |
| A `lib/` area with a suite | `node test/run.js <suite>`, seconds. `--list` for names |
| Other `lib/`, `bin/`, `scripts/` | `node -c <file>`, plus a targeted `node -e` smoke of the behaviour you changed |
| Migrations | Nothing local. Flag it for a human |
| Docs, config, `claude/ops/` | Nothing |

A targeted smoke means calling the function and printing what it returned. Not
starting the daemon and noting that it did not crash.

## When a full run is warranted

Immediately before pushing to master or cutting a release, at most once per
session. Or when the change touches core sync, daemon, or teamsync paths and a
targeted smoke cannot prove it safe.

A full run is `node test/run.js` followed by `cd ui && npx vitest run`.

If you suspect the tree was already broken before you touched it, check CI for
the branch point rather than running anything: `gh run list --branch master --limit 3`.

## Before you believe a red result

Any failing test goes through the gate before it becomes a bug, a fix, or a
blocker. See the verify-finding skill. Phantom failures under load are common
here and look exactly like real defects.
