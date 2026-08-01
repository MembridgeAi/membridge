# Operational state

**Verified against `802d366` on 2026-08-01, end of day.** Every number below came
from a command run at that commit. Where a command could not be run, that is
called out in place rather than filled in from memory.

This file and `decisions.md` live in the repo. The repo is canonical and the
Claude Project is the mirror, not the other way round. If the Project copy and
this file disagree, this file wins.

Read this first. `decisions.md` holds the reasoning behind the choices below.

---

## One-line status

Master is green on both suites and on every CI leg that still exists. v0.2.3 is
tagged but **not published**, which is the one thing genuinely waiting on a
human.

---

## Where the code is

| Thing | Value |
| --- | --- |
| `upstream/master` | `802d366` |
| Remote that matters | `upstream` = `github.com/MembridgeAi/membridge` |
| Fork | `origin` and `andrewb` both = `andrewb-eng/membridge`, master at `b297527`, far behind. **Nothing from today was pushed there.** Verified: fork master is an ancestor of upstream master. |
| Root suite | **1313/1313 checks passed**, from a clean `npm ci` |
| UI suite | **513 tests, 34 files passed**, from a clean `npm ci` |
| `tsc --noEmit` | clean |
| Package version | `0.2.3`, root and `app/` in lockstep, pinned by a check |
| `engines.node` | `>=18`. Deliberate. See the CI section. |

## Release: v0.2.3 is tagged, NOT published

The tag points at `802d366`, which is `upstream/master` itself. Verified as an
ancestor, not a dangling tag.

Publishing is a human step at
`https://github.com/MembridgeAi/membridge/releases/new?tag=v0.2.3`, selecting the
existing tag. Publishing fires `release: published`, which is the only event that
makes the `Attach to release` steps run. **A tag alone attaches nothing.**

Expect exactly five assets:

- `MemBridge-0.2.3-arm64.dmg`
- `MemBridge-0.2.3-arm64.zip`
- `MemBridge-arm64.dmg` (unversioned alias, what the site download button
  resolves through)
- `MemBridge-0.2.3-win.zip`
- `MemBridge-win.zip` (unversioned alias)

**The two Windows files are the ones to check for.** v0.2.2 carries only the
three mac assets, because the windows job failed before packaging on every prior
run. On `802d366` the windows job including `npm run dist:win` is green, so
0.2.3 should be the first release with a Windows build.

Verify assets by **content type, not status code**. A missing GitHub asset
redirects to HTML and still returns 200.

### install.sh is pinned to 0.2.2, and that is currently correct

Live `install.sh` pins `VERSION="0.2.2"` and that asset still resolves
(`application/octet-stream`), so new installs work today.

**It cannot be regenerated until v0.2.3 publishes.** `scripts/install/gen-install.js`
hashes a local `dist/` build, and signed macOS binaries are not byte
reproducible, so a local zip has a different hash than the one CI attaches. The
only correct source is the published asset. Sequence: publish, let CI attach,
download the published zip, regenerate through the generator, deploy.

**Do not re-run CI against the v0.2.2 tag.** `--clobber` would replace the
attached asset with a freshly signed one carrying a different hash, and the live
`install.sh` is SHA pinned to the current one. Every new `curl | sh` install
would hard fail.

## CI

On `802d366`:

- **Build app**: mac success, windows success. `npm run dist:win` ran and
  succeeded. `Attach to release` shows skipped because `github.event_name` is
  not `release`. Publishing flips that.
- **CI**: five of six legs pass. One failure, `node 20 on macos-latest`, at
  `redact: a 200-event render stays well under 200ms`, reporting 229ms.

### The 229ms failure is a flake, not a regression

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

**Proposed fix, awaiting approval:** sample three times, assert the minimum. A
real regression raises the floor, so sensitivity is unchanged; runner noise only
inflates slower samples. Widening the bound was considered and rejected as it
would weaken the check.

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

Verified against a packed tarball in a clean directory with no repo present:

| Surface | Result |
| --- | --- |
| Tarball size | 784 KB |
| `membridge --version` | `0.2.3` |
| `membridge status` | full output |
| Daemon | starts, `/api/status` returns 200 with a real payload |
| MCP | initializes, lists all six tools |
| **Dashboard** | **503, `UI not built. Run: cd ui && npm run build`** |

**An npm-only install has no working dashboard.** The tarball ships no `ui/dist`
and no build toolchain, and the failure is presented as developer instructions
telling a user to build in a directory they do not have. `/app` redirects to `/`,
which is the 503.

Decided: `ui/dist` goes into the tarball in **0.2.4**, not 0.2.3. The live site
copy implying npm gives Windows and Linux users the full product is a separate
false claim being fixed independently.

## Merged today

Session detail page, projects tab archive work, measured savings Tier 1 and the
sufficiency gate, OAuth state binding with PKCE, the Windows CRLF CI fix, the
npm hoisting CI fix, eight Electron shell defects, a sudo free installer with
launch at login, plus the docs and these ops files.

## Not done, in priority order

1. **Publish v0.2.3.** Human step. Blocks the install.sh regeneration.
2. **USD persistence revert.** `lib/ledger-fold.js` still implements a reversed
   instruction and persists no USD. The decision is to keep it persisted. Both
   plans say `REVERT REQUIRED`; the code does not match. Not small: it is two
   files plus a test.
3. **Security Tasks 2 through 9.** Task 1 is merged, but its human verification,
   a live sign-in and a replayed callback, has not happened.
4. **MIN_COMPRESSION recalibration**, which unblocks the BPE tokenizer.
5. **The 21 to 24 serve gap**, tracked separately and deliberately not folded
   into the recalibration.
6. **The 229ms flake**, per the proposal above.

## Parked, preserved off-laptop

The BPE tokenizer work is on branch **`wip/bpe-tokenizer`** on upstream. It does
**not** pass the suite by design: it puts `MIN_COMPRESSION` on mismatched units,
so recall serves 19 files where it served 21, and the intended end state is 24.
Do not merge before the recalibration.

## Known issues not fixed

- **`npm audit` reports 3 vulnerabilities** at the root, 1 moderate and 2 high:
  `brace-expansion` and `tar` under `electron-builder` (devDependency, never
  ships), and `fast-uri` under `@modelcontextprotocol/sdk` (**does** ship).
  `ui/` reports zero. Not fixed here because `npm audit fix` rewrites the
  lockfile broadly, which is not a sleeping-hours change.
- **Local tags diverge from upstream** for `v0.1.0`, `v0.1.1`, `v0.2.0` and
  `v0.2.1`. Local copies are pre-launch era; upstream is authoritative. Cleanup
  is `git tag -d` those four then `git fetch upstream --tags`. **Never run
  `git push --tags` from this checkout**, which would try to publish stale local
  tags over correct upstream ones.
- `archive/multidevice-e2e` points at a commit not on master. Deliberate archive
  tag, not a problem.
- The daemon prunes before it checks authorization on shared project delete and
  returns 200 for an authorization failure. The UI path is closed; other callers
  are not. Rated HIGH, queued as security Task 2b.
- Six branches exist on the fork but not upstream, all pre-launch era. Harmless
  while nothing pushes there.

## Secrets

Today's full diff (`a70fd32..802d366`) was grepped for `sk-`, `AKIA`, `ghp_`,
`eyJ` and `-----BEGIN`. **Zero credential-shaped tokens were added.** The only
matches are plan prose describing a test that plants a fake `sk-` value to prove
redaction works.
