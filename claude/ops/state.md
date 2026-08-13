# Operational state

**Verified against `0fc319a` (master tip) on 2026-08-03.** Every fact in the
status, release and CI sections below came from a command run that day.

This file and `decisions.md` live in the repo. The repo is canonical and the
Claude Project is the mirror, not the other way round. If the Project copy and
this file disagree, this file wins.

Read this first. `decisions.md` holds the reasoning behind the choices below.

---

## Master was red for two days. Fixed in `0fc319a`.

From `bae4b0e` through `80ba253`, **all six CI legs failed** at `tsc --noEmit`
with three `TS2591` errors: `ui/src/components/EntryRow.test.tsx` imports
`node:fs` and `node:path` and reads `process.cwd()`, but `@types/node` was never
a `ui/` devDependency. Adding it was the entire fix; the test's executable code
is unchanged.

**The lesson worth keeping: a green local build proved nothing.** `Build app`
stayed green that whole time and `npm run build:ui` succeeds locally, because
**neither runs `tsc`**. Only the `CI` workflow typechecks. If you want to know
whether master compiles, run `cd ui && npx tsc --noEmit` yourself.

Two tidier-looking fixes were tried and both fail — the reasons are recorded in
the test itself so they are not retried:

- `import css from './components.css?raw'` returns the **empty string**, because
  vitest stubs CSS imports. The assertion then fails while looking like a real
  CSS regression.
- `new URL('./components.css', import.meta.url)` throws `The URL must be of
  scheme file` **in that module**. The react plugin transforms `.tsx` and serves
  it over a non-file scheme. A probe in a plain `.ts` file *does* get a `file://`
  URL, so testing this idea in the wrong file type will tell you it works.

Note `@types/node` also makes node globals (`process`, `Buffer`) typecheck
anywhere in `src/`, despite `node` being deliberately absent from `tsconfig`'s
`types` array, because `vite.config.ts` is in `include` and pulls
`vite/dist/node/index.d.ts` with its `/// <reference types="node" />`. If that
ever matters, the fix is a separate tsconfig for the node-facing files.

## One-line status

**v0.2.4 shipped** on 2026-08-02: GitHub release, five assets, and
`@membridgeai/membridge@0.2.4` on npm. v0.2.3 was skipped entirely and will
never be published. Master went red for two days after that and is **green
again** as of `0fc319a`. The site installer, stuck at 0.2.2, was regenerated and
is live at 0.2.4.

---

## Where the code is

| Thing | Value |
| --- | --- |
| Local `master` | `0fc319a`, identical to `origin/master`. Nothing unpushed. |
| `origin/master` | `0fc319a` |
| Remotes | `origin` = `github.com/MembridgeAi/membridge`, and it is the ONLY remote. The `upstream` and `andrewb` remotes were removed, so a bare `git push` now goes to canonical rather than the dead fork. |
| Fork | `andrewb-eng/membridge` still exists on GitHub pending a permissions issue, but nothing local points at it. Treat it as deleted. |
| Push access | Marco's laptop clone **has write access**, confirmed 2026-08-03 by `git push --dry-run origin master` reaching the remote. A 403 seen from a cloud session was specific to that session's repo scoping, not account-wide. |
| Root suite | **1412/1412 clean**, on a quiet machine. A lone failure almost always means a second suite is running — see known issues. |
| UI suite | **green on all six CI legs.** Fails locally on this laptop; that is a machine artifact, see known issues. |
| `tsc --noEmit` | clean, as of `0fc319a` |
| Package version | `0.2.4`, root and `app/` in lockstep, pinned by a check |
| `engines.node` | `>=18`. Deliberate. See the CI section. |

## Release: v0.2.4 shipped. v0.2.3 was skipped and is dead.

Published 2026-08-02. Verified on 2026-08-03 against the GitHub API and the npm
registry, not from memory.

| Thing | Value |
| --- | --- |
| GitHub releases | `v0.1.0`, `v0.1.1`, `v0.1.2`, `v0.2.0`, `v0.2.2`, **`v0.2.4` (Latest)**. There is **no v0.2.3 release.** |
| `v0.2.4` tag | `b1b4ffe` |
| CI on `b1b4ffe` | **success**, both workflows |
| npm | `@membridgeai/membridge@0.2.4`, `latest`. Unpacked 5.5 MB, up from 784 KB at 0.2.3 — `ui/dist` now ships, as decided. |
| Assets | all five present: `MemBridge-0.2.4-arm64.dmg`, `MemBridge-0.2.4-arm64.zip`, `MemBridge-arm64.dmg`, `MemBridge-0.2.4-win.zip`, `MemBridge-win.zip` |

**The Windows build landed.** v0.2.4 is the first release carrying
`MemBridge-*-win.zip`; every release up to v0.2.2 has only the three mac assets.

### The stale `v0.2.3` tag: leave it alone

`v0.2.3` still exists on `origin` pointing at `802d366`. Earlier revisions of
this file called for retargeting it before publishing. **That instruction is
void.** Nothing was ever published from it, v0.2.4 supersedes it, and `802d366`
is a legitimate ancestor of master. Moving it now would point a tag at
two-releases-old code for no reason. Do not retag it and do not delete it.

Publishing remains a human step, and the mechanics are unchanged for next time:
create the release at
`https://github.com/MembridgeAi/membridge/releases/new?tag=<tag>` selecting the
**existing** tag. Publishing fires `release: published`, which is the only event
that makes the `Attach to release` steps run. **A tag alone attaches nothing.**
Verify assets by **content type, not status code** — a missing GitHub asset
redirects to HTML and still returns 200.

### DONE 2026-08-03: the site installer is regenerated and live at 0.2.4

Live `install.sh` on membridge.app now pins `VERSION="0.2.4"` and
`SHA256="2221760a…"`, verified by fetching the live URL and running
`curl -fsSL https://membridge.app/install.sh | sh -s -- --dry-run`, which
resolves the correct release URL. Landed as `ee6da53` here and
`db428bd` on `mmelika/membridge-site` (branch **`main`**, not `master`).

**Two things this exposed, and they are the reason to check it every release:**

1. **The committed artifact had drifted from its own template.**
   `scripts/install/install.sh` in this repo was pinned to **`0.1.2`** — four
   releases stale — and predated the sudo-free CLI install, the `CLI_STATUS`
   reporting and the launch-at-login step. Live was serving a *different* stale
   generation, `0.2.2`. Regeneration is evidently not part of anyone's release
   routine, and nothing fails when it is skipped: the old pin keeps working, so
   a `curl | sh` user silently gets an old build with no error anywhere.
2. **The local-vs-published hash distinction is real, not theoretical.**
   Measured on the same version: the local `dist/MemBridge-0.2.4-arm64.zip`
   hashes to `fde9c618…`, the published asset to `2221760a…`. Signed macOS
   binaries are not byte reproducible. The template **dies** on checksum
   mismatch, so pinning a local hash hard-fails every install.

The sequence, for next time: download the published zip with
`gh release download`, hash **that**, regenerate, deploy to the site repo's
`main`, then confirm against the live URL — a push is not a deploy, and it took
roughly 20 seconds for Pages to serve the new copy.

**Do not re-run CI against an already-published tag.** `--clobber` would replace
an attached asset with a freshly signed one carrying a different hash, and the
live `install.sh` is SHA pinned. Every new `curl | sh` install would hard fail.

## CI

On `0fc319a` (master tip, 2026-08-03): **CI success, all six legs** — node 20
and 22 across ubuntu, macos and windows. This is the first run since `b1b4ffe`
that got past `tsc` and actually executed the UI suite, and it passed
everywhere.

On `bae4b0e` and `80ba253`: **CI failure, all six legs**, at `tsc --noEmit`.
`Build app` was green on both, which is exactly why it went unnoticed. Fixed in
`0fc319a`.

On `b1b4ffe` (the `v0.2.4` tag): both workflows **success**. That is the commit
the release was cut from.

The history below is retained because the reasoning still applies.

### Earlier, on `802d366`:

- **Build app**: mac success, windows success. `npm run dist:win` ran and
  succeeded. `Attach to release` shows skipped because `github.event_name` is
  not `release`. Publishing flips that.
- **CI**: five of six legs pass. One failure, `node 20 on macos-latest`, at
  `redact: a 200-event render stays well under 200ms`, reporting 229ms.

### The 229ms failure was a flake, not a regression. Fixed.

Measured directly, benchmarking the same render at today's starting commit
versus now:

| | `a70fd32` (this morning) | `802d366` (now) |
| --- | --- | --- |
| median | 11 ms | 10 ms |
| min | 10 ms | 9 ms |
| cold first run | 48 ms | 23 ms |

The render is marginally faster than it was this morning and its cold path is
less than half. The preceding commit `bb64d39` had a fully green CI run
including this check. The real defect is that the assertion takes a **single
sample** against a 200ms bound on a shared runner.

**Fixed:** the check now samples three times and asserts the minimum. A real
regression raises the floor, so sensitivity is unchanged; runner noise only
inflates slower samples, which the minimum discards. Widening the bound was
considered and rejected as it would weaken the check. Proven still non-vacuous
by injecting a 250ms stall into the timed region: it fails at 261ms best-of-3.

### Node 18: the matrix and `engines` disagree on purpose

Node 18 was removed from the CI matrix. It cannot **build** the UI:
`vite@8.1.5` resolves `rolldown@1.1.5`, which imports `styleText` from
`node:util`, added in Node 20; both declare `engines: ^20.19.0 || >=22.12.0`.
Reproduced on real Node 18.20.8. Every CI run since the React UI landed on
2026-07-29 failed, and on the runs checked leg by leg, the Node 18 legs failed
at `npm run build` on all three operating systems and never reached the tests.

**`engines.node` stays at `>=18`, and that is correct.** `engines` is a claim
about the runtime. The tarball's `files` field is `bin`, `lib`, `vendor`,
`README.md`, `LICENSE`, so a consumer never runs vite. Verified rather than
assumed: a packed 0.2.3 tarball in a clean directory under real Node 18.20.8 ran
the CLI, started the daemon serving `/api/status` with a real payload, and
initialized MCP with all six tools. No Node 20+ API appears in `lib/` or `bin/`.

The reason is recorded beside the matrix in `.github/workflows/ci.yml`.

## What an npm install actually gives you

**Fixed in 0.2.4.** The 0.2.3 tarball was 784 KB, shipped no `ui/dist`, and
returned a 503 reading `UI not built. Run: cd ui && npm run build` — developer
instructions pointing at a directory the user does not have. `ui/dist` was
decided into 0.2.4 rather than 0.2.3, and the published 0.2.4 tarball unpacks to
5.5 MB, consistent with that having landed. Andrew verified the working
dashboard from the registry rather than from the repo.

The historical record below is what an 0.2.3-era npm-only install gave you, kept
because the shape of the failure is worth recognising if it recurs:

| Surface | Result at 0.2.3 |
| --- | --- |
| Tarball size | 784 KB |
| `membridge --version` | `0.2.3` |
| `membridge status` | full output |
| Daemon | starts, `/api/status` returns 200 with a real payload |
| MCP | initializes, lists all six tools |
| **Dashboard** | **503, `UI not built`** |

The live site copy implying npm gives Windows and Linux users the full product
was a separate false claim, fixed independently.

## The installed app lags the repo, and that is the usual cause of "it's missing"

Checked 2026-08-03: `/Applications/MemBridge.app` was **0.2.2, built Jul 31
17:42**, and its `app.asar` contained zero references to `api/search` — so the
search UI, which is on master and fully routed at `App.tsx` via `ROUTES.search`,
simply was not in the binary being run. `ui/dist` on disk was also a Jul 31
build with no `SearchPage` chunk.

**Before concluding a feature is missing, check three things in order:** is it on
master, is `ui/dist` newer than `ui/src`, and what version is
`/Applications/MemBridge.app`. The daemon on port 7437 is the installed app, not
the repo checkout — `ps -p <pid> -o command=` shows which. Rebuild with
`npm run build:ui` for the web UI and `npm run dist:mac` for the app.

## Closed since the last revision

- **PR #6.** The `build/signed-dmg` merge (`539ffda`) wrote a duplicated
  `entitlementsInherit` key with no separating comma, so `package.json` stopped
  being valid JSON for roughly twenty five minutes, and it reintroduced
  `"notarize": false` — the reason PR #6 had been closed earlier that day.
  Repaired in `16f4c0b`: duplicate key removed, `notarize` returned to unset.
  **Unset is correct.** electron-builder then notarizes exactly when Apple
  credentials are present, so forks and PR builds pass with no secrets while real
  releases get notarized; setting it false short-circuits before the credentials
  are read and silently ships signed-but-unnotarized builds.

  Raised with Marco on 2026-08-01. He elected to keep the process question
  separate from the release rather than gate on it. Closed as a release concern;
  the standing lesson is recorded in `decisions.md`: verify build config field by
  field after any merge claiming to be superseded, because a three-way merge
  contributes nothing for already-applied changes while still landing whatever
  was genuinely new.

## Merged as of 2026-08-01

Session detail page, projects tab archive work, measured savings Tier 1 and the
sufficiency gate, OAuth state binding with PKCE, the Windows CRLF CI fix, the
npm hoisting CI fix, eight Electron shell defects, a sudo free installer with
launch at login, plus the docs and these ops files.

## Not done, in priority order

1. **Security Tasks 2 through 9.** Task 1 is merged, but its human verification,
   a live sign-in and a replayed callback, has not happened.
2. ~~**MIN_COMPRESSION recalibration**, which unblocks the BPE tokenizer.~~
   **DONE** — re-measured against the honest tokenizer over 283 real files; the
   value stays `2.25` and no behaviour changed. The predicted drop in serves is
   a Markdown-only artefact that sits nowhere near the floor. Evidence and the
   full reasoning: `claude/ops/decisions.md`, pinned by
   `test/suites/compression-floor.test.js`.
3. **The 21 to 24 serve gap**, tracked separately and deliberately not folded
   into the recalibration.
4. **Land Andrew's `liveBasis` work.** As of 2026-08-03 it is five files,
   uncommitted, on his machine only — `liveBasis` appears nowhere in `lib/`,
   `ui/src/` or `test/` here. It qualifies the `live` flag the MCP already emits
   on cached team rows, which currently claims a teammate is active when all it
   knows is that a row synced. He also logged the matching Today-page gap
   (`ui/src/data/mappers.ts:397` filters on raw `live`) as a deliberate product
   call, not a bug.

## Parked, preserved off-laptop

The BPE tokenizer work is on branch **`wip/bpe-tokenizer`** on `origin`. It does
**not** pass the suite by design: it puts `MIN_COMPRESSION` on mismatched units,
so recall serves 19 files where it served 21, and the intended end state is 24.
Do not merge before the recalibration.

## Known issues not fixed

- **The root suite is 1401/1402, and WHICH check fails varies by machine.** Two
  independent runs at `bae4b0e` on 2026-08-03 both scored 1401/1402 and both
  failed a *different* check: Marco's laptop failed `provenance reconciliation:
  the settle pass attributes the commit to the ACTUAL session B, never stale
  session A`, and Andrew's failed `gitignore: .membridge/team.json is
  committable`. Neither is the worktrees check this file used to name, and that
  one now passes — presumably fixed by the realpath work in `2e770ea`.

  Both are pre-existing and unrelated to the `tsc` fix, which touches only `ui/`.

  **Correction, later the same night: an uncontended run is 1412/1412, clean.**
  The earlier "stable per machine" reading is withdrawn. Every run that showed a
  single failure — here and, by report, on Andrew's checkout — had *another*
  `run-tests.js` executing at the same time from a different worktree. This
  repo has ~16 worktrees and parallel agent sessions, so that overlap is easy to
  miss and easy to cause.

  The cause was hardcoded suite ports: two concurrent runs contend, and the
  loser sees failures that look like fixture or environment bugs. The
  `provenance reconciliation` failure did not reproduce once the machine was
  quiet.

  **`e661939` has since fixed this properly** — the suite is split into
  sections behind `test/run.js`, with per-run port reservation, and `npm test`
  now runs the orchestrator rather than `run-tests.js` directly. So this should
  stop happening. The diagnostic habit is still worth keeping for any suite
  that touches fixed resources: treat a lone failure as possible evidence of a
  second run before concluding it is a machine-specific defect. (One trap when
  checking — a bare `pgrep -f "run-tests.js"` inside a shell one-liner matches
  its own command line and waits forever. Bracket it: `pgrep -f "[r]un-tests.js"`.)

  Andrew's `gitignore: .membridge/team.json is committable` failure is still
  unexplained and may be genuine on his machine; `git check-ignore -v` says the
  shipped `.gitignore` is correct, so if it survives an uncontended run the
  fault is in what the fixture constructs.

  **The old "one failure is the known worktrees one" exemption is dead:**
  1401/1402 is not self-evidently fine, so read which check failed and compare
  against both known ones before assuming it is benign.

- **The UI suite fails on Marco's laptop but passes on CI and on Andrew's
  machine. They are timeouts, not assertions. Believe CI.** Diagnosed
  2026-08-03. Four consecutive local runs of the same unchanged tree failed
  16, 44, 2 and 7-8 tests — the count swings every run. In the run that was
  classified: **26 of 44 failures were `Test timed out in 5000ms`**, 16 were
  `TestingLibraryElementError` (an element that never appeared inside the wait,
  i.e. the same slowness one layer up), and only 2 were real `AssertionError`s.
  CI ran the identical suite green on Node 20 and 22 across ubuntu, macos and
  windows; Andrew reports 612/612 in seconds on his machine.

  **`--pool=threads` fixes collection but not the timeouts.** Without it the
  number of tests *collected* varies (612, then 415) — that part is worker
  exhaustion and threads cures it. With it all 612 collect every time and still
  time out under load. So the default 5s `testTimeout` is simply too tight for
  612 jsdom tests on a laptop also running the daemon, the Electron app and 16
  worktrees.

  **Do not chase these as real failures**, and do not run the UI suite next to
  an Electron build. For a trustworthy local signal run a single file. If
  someone wants this genuinely fixed rather than worked around, raising
  `testTimeout` in `ui/vite.config.ts` is the lever — deliberately not changed
  here, since it trades a slow-machine annoyance against CI's ability to catch a
  real hang.

- *(historical, now passing)* **1379/1380 on any machine with a live git
  worktree.** `worktrees: a non-repo directory returns [] rather than throwing`
  used to fail here.
  It is not a regression and not a defect in the shipped path: the check escapes
  its own fixture and reads the **real** repository's worktree registry, so it
  returns whatever `git worktree list` reports for the checkout it runs in and
  then asserts that is empty. On this laptop that is
  `.claude/worktrees/agent-ab35bd88006c82de8`.

  So it passes on CI and on any clean clone, and fails for every developer who
  has a worktree registered, which is exactly the population working on
  worktree code. **Treat 1379/1380 with this one failure as green on such a
  machine; a second failure is real.** Not fixed here because it is out of
  scope for the work that found it; the fix belongs with whoever owns the
  realpath work in `2e770ea`.

- **`npm audit` reports 3 vulnerabilities** at the root, 1 moderate and 2 high:
  `brace-expansion` and `tar` under `electron-builder` (devDependency, never
  ships), and `fast-uri` under `@modelcontextprotocol/sdk` (**does** ship).
  `ui/` reports zero.

  **No clean fix exists.** `@modelcontextprotocol/sdk@1.30.0` is already the
  latest and pulls `ajv@8.20.0`, also the latest, which declares
  `fast-uri: ^3.0.1`. The fixed version is `fast-uri@4.1.2`, a major outside
  that caret range, so nothing short of an `overrides` block forcing ajv onto an
  undeclared major would move it. This waits on ajv widening its range.

  Real exposure looks nil: the advisory is host confusion in URI parsing, and
  our MCP schemas contain zero `format: uri`, `$ref` or `$id` constructs, so
  ajv never asks `fast-uri` to parse anything.
- **Local tags diverge from upstream** for `v0.1.0`, `v0.1.1`, `v0.2.0` and
  `v0.2.1`. Local copies are pre-launch era; the remote is authoritative.
  Cleanup is `git tag -d` those four then `git fetch origin --tags`. **Never run
  `git push --tags` from this checkout**, which would try to publish stale local
  tags over correct remote ones.
- `archive/multidevice-e2e` points at a commit not on master. Deliberate archive
  tag, not a problem.
- The daemon prunes before it checks authorization on shared project delete and
  returns 200 for an authorization failure. The UI path is closed; other callers
  are not. Rated HIGH, queued as security Task 2b.
- Six branches exist on the fork but not on `origin`, all pre-launch era. Harmless
  while nothing pushes there.

## Secrets

Today's full diff (`a70fd32..802d366`) was grepped for `sk-`, `AKIA`, `ghp_`,
`eyJ` and `-----BEGIN`. **Zero credential-shaped tokens were added.** The only
matches are plan prose describing a test that plants a fake `sk-` value to prove
redaction works.
