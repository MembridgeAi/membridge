# Operational state

Written 2026-07-31. Every number below came from a command run against this
checkout on that date. Where a command could not be run, that is called out in
place rather than filled in from memory.

This file and `decisions.md` live in the repo. The repo is canonical and the
Claude Project is the mirror, not the other way round. If the Project copy and
this file disagree, this file wins.

## Where the code is

| Thing | Value |
| --- | --- |
| Branch | `master` |
| Measured against | `fbd1aed303e5c76ad52488b4cc409adbe453cc7f` |
| `upstream/master` at measurement time | `fbd1aed303e5c76ad52488b4cc409adbe453cc7f` (identical, nothing unpushed) |

Everything below was measured at `fbd1aed`. Two documentation-only commits
landed on top of it while this was being written, one of them this file. If
`git log` shows commits above `fbd1aed`, check whether they touch code before
assuming any figure here is stale. At the time of writing they did not.
| Working tree | clean apart from the untracked agent worktree dir `.claude/worktrees/` |
| Package | `@membridgeai/membridge` `0.2.2` |
| `engines.node` on master | `">=18"` |

Last fifteen commits, newest first:

```
fbd1aed fix(auth): bind the OAuth callback to the request that started it
138188b fix(test): resolve the dependency closure the way require() does (CI)
3c6dc47 fix(test): make source-shape checks line-ending agnostic (Windows CI)
7e9c330 Merge pull request #12 from MembridgeAi/fix/teamsync-duplicate-upsert
77bd410 fix(server): delete now prunes config.exclude too, not just config.archived
888e45e docs: security audit and remediation plan (2026-08-01)
b39dd8f feat(server): sufficiency gate, stop persisting USD
5f19869 feat(server): measured token spend from vendor-reported usage
a636d3c fix: fail closed on an unrecognized delete body, log a failed archived-prune
e495198 fix(ui,server): a member's delete of a shared project pruned their team archive and reported success
e5f9ad9 style: drop an em dash from the ConfirmDialog comment (house style)
f5678a9 fix(ui): a shared project opens shared, with every author's sessions
c0c0da9 feat(ui): delete requires a typed confirmation and leaves bulk
69fc89d feat(ui): select mode, bulk archive, archived section
99c6ea2 feat(ui): one Access column with an admin-gated popover
```

## Test suites, as measured

Both were run locally on Node `v24.16.0`.

| Suite | Command | Result |
| --- | --- | --- |
| Root | `node test/run-tests.js` | **1313 / 1313 checks passed** |
| UI | `cd ui && npm test` (vitest 4.1.10) | **34 files, 513 tests, all passed** |

Both suites are green locally. Local green does not mean CI green. See below.

## Release topology

Published GitHub release, latest first:

- **v0.2.2**, published 2026-07-31. Assets, exactly three:
  - `MemBridge-0.2.2-arm64.dmg`
  - `MemBridge-0.2.2-arm64.zip`
  - `MemBridge-arm64.dmg`
- Earlier tags with releases: v0.2.1, MemBridge 0.2.0, v0.1.2, v0.1.1.

Read this carefully: **v0.2.2 has no Windows asset and no macOS x64 asset.**
Every published artifact is macOS arm64. The Windows packaging job failed
before it produced anything, so there is nothing to download for Windows users
on the current release. The npm package is the only install path that works
everywhere.

npm says:

```
@membridgeai/membridge dist-tags -> { latest: '0.2.2' }
```

So npm `latest` and the GitHub release tag agree at 0.2.2. The desktop app
assets are the piece that is incomplete, not the CLI.

Mac builds are signed **and** notarized in CI. `.github/workflows/build-app.yml`
gates notarization on the `APPLE_API_KEY` / `APPLE_API_KEY_ID` /
`APPLE_API_ISSUER` trio being present and deliberately leaves `notarize` unset
so that "notarize exactly when signing happened" is the behavior. This was
log-verified earlier in the session. I confirmed the workflow shape but did not
re-read a CI log myself, because the API quota was gone (see the caveat below).

## CI: currently failing

The CI badge for `ci.yml` reads **failing**.

Verified run history, newest first:

| Run | Commit | Result |
| --- | --- | --- |
| 197 | `fbd1aed` OAuth state binding | in progress at time of check |
| 196 | `138188b` dependency closure fix | failed |
| 195 | `3c6dc47` CRLF fix | failed |
| 194 | `7e9c330` merge PR #12 | failed |
| 193 | `77bd410` delete prunes exclude | failed |
| 192 | `888e45e` security plan doc | failed |
| 191 | `a636d3c` fail closed on delete body | failed |
| 190 | `docs: split the six-document work bundle` | failed |
| 189 | `fix(app): child windows inherit the navigation guards` | failed |
| 188 | `docs: split the 2026-07-31 UI bundle` | failed |

Nine consecutive failed runs. The matrix in `.github/workflows/ci.yml` is
`os: [ubuntu-latest, windows-latest, macos-latest]` crossed with
`node: [18, 20, 22]`, so nine legs per run.

### The one live cause: Node 18 cannot build the UI

This is the remaining failure and it is not a product bug.

Verified from the installed tree in `ui/node_modules`:

- `vite` `8.1.5`, `engines: {"node":"^20.19.0 || >=22.12.0"}`
- `rolldown` `1.1.5`, `engines: {"node":"^20.19.0 || >=22.12.0"}`
- `rolldown/dist/shared/rolldown-build-*.mjs` and `rolldown/dist/cli.mjs`
  contain literally `import { formatWithOptions, styleText } from "node:util"`

`styleText` does not exist in `node:util` before Node 20. Vite 8 builds through
rolldown, so the UI build cannot run on Node 18 at all. Both packages declare
engines that exclude 18. The three Node 18 legs have failed on every run since
the React UI landed on 2026-07-29.

`engines.node` on master still says `">=18"`. **That is a false claim in the
published manifest.** It promises a runtime the dependency tree does not
support.

The fix already exists and is not merged. Branch `fix/release-pipeline` is one
commit ahead of master at `da584f4`, "chore(ci): drop Node 18, engines >=20 and
remove it from the CI matrix". It changes `package.json` `engines.node` to
`">=20"` and removes 18 from the CI matrix, keeping all three operating
systems. Merging it is the agreed next step. See `decisions.md`.

Caveat on my own verification: I could not re-run the Node 18 failure myself,
because no Node 18 is installed on this machine (only `v24.16.0`). The runtime
reproduction on Node 18.20.8 was done earlier in the session. What I verified
independently is the static evidence: the declared engines and the `styleText`
import. That evidence is sufficient on its own.

### Two CI failures already fixed, do not re-diagnose them

Both landed today and neither was a product bug:

1. `3c6dc47` source-shape checks in `test/run-tests.js` did not tolerate CRLF,
   so they failed on the Windows checkout.
2. `138188b` a test assumed npm hoisting, which broke under
   `npm ci --omit=dev` on every Node 20 and Node 22 leg.

If a Node 20 or 22 leg fails again, it is something new, not these.

## Done, in flight, parked, broken

### Done and on master

- Session detail page.
- Projects tab archive work, including bulk archive, the archived section, the
  typed delete confirmation, and one Access column with an admin-gated popover.
- Measured savings Tier 1: measured token spend from vendor-reported usage
  (`5f19869`), plus the sufficiency gate (`b39dd8f`).
- `deleteProject` prunes both `config.archived` and `config.exclude`
  (`77bd410`, code at `lib/server.js:1367` onward).
- OAuth state binding with PKCE (`fbd1aed`), which is Task 1 of the security
  plan.

### In flight

- **Merge `fix/release-pipeline` (`da584f4`) into master** to move
  `engines.node` to `>=20` and drop 18 from the CI matrix. This is what unblocks
  CI. Nothing else is waiting on anything.
- CI run 197 on `fbd1aed` was still running when this was written. Its result is
  unknown. Expect the three Node 18 legs to fail regardless.

### Parked, explicitly not done

- **Measured savings Tier 2, the BPE tokenizer.** `lib/token-estimate.js` is
  still the chars/4 heuristic: `Math.ceil(String(str).length / 4)`. The work is
  uncommitted and sits in the agent worktree
  `.claude/worktrees/agent-ab35bd88006c82de8` (based on `b39dd8f`), with
  modifications to `lib/token-estimate.js` and `test/run-tests.js` and untracked
  `scripts/build-tokenizer-vocab.js` and `vendor/tokenizer/`. It is blocked on
  the `MIN_COMPRESSION` recalibration decision, not on code. `MIN_COMPRESSION`
  is `2.25` at `lib/recall.js:41`. See `decisions.md`.
- **Counters opt-in.** Contested, on hold, not decided. Counters are opt-out
  today: `countersEnabled()` in `lib/counters.js` defers wholesale to
  `diagnostics.diagnosticsEnabled(config)`, with `MEMBRIDGE_NO_DIAGNOSTICS=1` as
  the single kill switch for the family. Do not change this without reading the
  entry in `decisions.md` first, both positions are recorded there.

### Broken right now

1. **CI is red on master**, cause understood, fix sitting unmerged on
   `fix/release-pipeline`.
2. **`engines.node` claims `>=18` and that is untrue.** Users on Node 18 get a
   silent failure later instead of an install-time warning.
3. **v0.2.2 ships no Windows asset.** Windows users have no desktop download.
4. **Security remediation is 1 of 10 tasks done.** Plan is at
   `docs/superpowers/plans/2026-08-01-security-audit-and-remediation.md`. It has
   ten task headings, Task 0 through Task 9. Task 1 is merged as `fbd1aed`.
   Tasks 2 through 9 are not started. Note that no checkbox in that file is
   ticked, including Task 1's, so the file's checkboxes are not a reliable
   progress signal. Use git history instead.
5. **Task 1 is not fully proven.** Its own plan text requires a live human
   sign-in test: start a sign-in, complete it, replay the same callback URL, and
   confirm the replay is rejected. That has not happened. The automated proof
   ran against a mocked Supabase.

## A code and comment mismatch worth knowing before you touch the ledger

The standing decision is that USD stays persisted in the ledger, so that a
user-supplied-rate feature can work later without re-folding history, and that
the persisted figure must never be served. See `decisions.md`.

The code on master does not match that decision. `lib/ledger-fold.js` around
lines 289 to 297 says the opposite in a deliberate comment and implements the
opposite: no USD is computed into the ledger, nothing is written down, and a
legacy ledger's `inCost` / `outCost` are dropped on the next fold. A matching
comment sits at `lib/server.js:496`, which is the comment referred to elsewhere
as being at `:471`; the line moved when `fbd1aed` landed.

So both the code and the comments currently implement "stop persisting", while
the ratified decision is "keep persisting, never serve". Reconcile these before
building anything on top of the ledger. Do not assume the comment is the only
thing that is wrong.

## What I could not verify, and why

- **Per-leg CI results.** The unauthenticated GitHub API quota was fully
  exhausted at check time: `rate_limit` reported `0 of 60` remaining, and the
  `gh` CLI is installed but not logged in to any host. Run-level pass and fail
  and the workflow badge came from the public HTML and Atom endpoints, which are
  not rate limited. Which specific legs failed inside runs 188 through 196 could
  not be enumerated. The per-leg attribution above is inferred from the matrix
  definition plus the reproduced dependency evidence, and from the two leg
  causes fixed earlier today.
- **The release asset list** likewise came from the public releases page and
  Atom feed, not from the API. Asset names are exact; byte sizes and upload
  timestamps were not retrieved.
- **The Node 18 runtime failure**, for the reason given above: no Node 18 on
  this machine. Static evidence verified instead.
- **CI run 197's outcome**, because it had not finished.
