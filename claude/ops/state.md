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
again** as of `0fc319a`. The one open item is a site installer still pinned to
0.2.2.

---

## Where the code is

| Thing | Value |
| --- | --- |
| Local `master` | `0fc319a`, identical to `origin/master`. Nothing unpushed. |
| `origin/master` | `0fc319a` |
| Remotes | `origin` = `github.com/MembridgeAi/membridge`, and it is the ONLY remote. The `upstream` and `andrewb` remotes were removed, so a bare `git push` now goes to canonical rather than the dead fork. |
| Fork | `andrewb-eng/membridge` still exists on GitHub pending a permissions issue, but nothing local points at it. Treat it as deleted. |
| Push access | Marco's laptop clone **has write access**, confirmed 2026-08-03 by `git push --dry-run origin master` reaching the remote. A 403 seen from a cloud session was specific to that session's repo scoping, not account-wide. |
| Root suite | **1401/1402 locally**, one failure — but NOT the one this file used to predict. See known issues. |
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

### OPEN: the site installer is two releases behind

Live `install.sh` on membridge.app still pins `VERSION="0.2.2"`, confirmed
2026-08-03. The v0.2.2 assets still resolve, so `curl | sh` installs succeed —
they just silently deliver 0.2.2 to a user who thinks they are getting current.

This is now regenerable, and was not before: it was blocked on a v0.2.3 publish
that never happened, and v0.2.4's published assets satisfy the same requirement.
`scripts/install/gen-install.js` hashes a `dist/` build, and signed macOS
binaries are not byte reproducible, so a locally built zip will never match.
**The only correct source is the downloaded published asset.** Sequence:
download the published 0.2.4 zip, regenerate through the generator, deploy to
`mmelika/membridge-site` — which publishes from **`main`**, not `master`.

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

1. **Regenerate `install.sh` off the published 0.2.4 assets and deploy it.** No
   longer blocked. Deploy target is `mmelika/membridge-site`, branch `main`.
3. **Security Tasks 2 through 9.** Task 1 is merged, but its human verification,
   a live sign-in and a replayed callback, has not happened.
4. **MIN_COMPRESSION recalibration**, which unblocks the BPE tokenizer.
5. **The 21 to 24 serve gap**, tracked separately and deliberately not folded
   into the recalibration.

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
  Andrew confirmed his by stashing and re-running, and reports `git check-ignore`
  says the repo's own rules are correct, so his looks like a fixture problem.
  Neither was investigated. **The old "one failure is the known worktrees one"
  exemption is dead:** 1401/1402 is not self-evidently fine, so read which check
  failed and compare against both known ones before assuming it is benign.

- **The UI suite fails on Marco's laptop but passes on all six CI legs.
  Believe CI.** Locally, consecutive runs reported 39 files / 612 tests and then
  30 files / 415 tests, with 7-8 files failing and 9 unhandled errors, across
  `Shell.test.tsx`, `projectRouting.test.tsx`, `refetchBanner.test.tsx` and
  `FeedPage.test.tsx`. On `0fc319a`, CI ran that same suite green on Node 20 and
  22 across ubuntu, macos and windows.

  The tell is that the number of tests *collected* changed between runs: that is
  resource exhaustion, not assertions. jsdom environment setup dominates the
  runtime (546s of a 191s wall-clock run, i.e. heavily parallel). **Do not chase
  these as real failures**, and do not run the UI suite alongside an Electron
  build or a busy daemon. If you need a trustworthy local signal, run a single
  file rather than the whole suite.

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
