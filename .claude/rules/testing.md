# Testing policy for this repo

**The full suite is a ship gate, not a development-loop tool.** Do not run
`node test/run-tests.js` after every change. It is one sequential end-to-end
story (~26k lines, real HTTP servers, real git subprocesses) that takes several
minutes and cannot run partially — there is no filter flag, and its sections
build on each other's state on purpose.

This rule intentionally overrides the global ECC rules (`testing.md`,
`code-review.md`, `development-workflow.md`) wherever they require a full local
test pass or coverage verification before work is marked complete. In this repo
that gate is CI's job: `.github/workflows/ci.yml` runs the full suite, the UI
suite, and `cd ui && npx tsc --noEmit` on every push.

## During development, verify only what you touched

| What changed | How to verify it |
|---|---|
| `ui/` (React app) | `cd ui && npx tsc --noEmit` (seconds — the ONLY local check that catches type errors; `npm run build:ui` does not), then `npx vitest run <affected test file(s)>`. The whole vitest suite only if you touched shared code (DataClient, app shell). |
| `lib/`, `bin/`, `scripts/` | `node -c <file>` syntax check, plus a targeted smoke of the changed behavior (`node -e ...` against the function you changed). |
| Docs, site, config, `claude/ops/`, memory files | No test run. |

## When a full local run IS warranted

- Immediately before pushing to master or cutting a release — at most once per
  session, not once per edit.
- When the change touches the core sync/daemon/teamsync paths and a targeted
  smoke genuinely cannot prove it safe.

A full run means `node test/run-tests.js` followed by `cd ui && npx vitest run`.

Never run the full suite "to establish a baseline" at the start of a session.
If you suspect the tree is already broken, check CI status for the branch
point instead (`gh run list --branch master --limit 3`).
