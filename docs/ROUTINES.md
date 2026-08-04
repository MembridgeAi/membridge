# The routines that matter

Distilled from the shared AI memory and the ops docs for Andrew. These are the
recurring procedures that break silently when skipped. Each has bitten us at
least once; the dates and commits are in the memory files and
`claude/ops/state.md`. For current release/CI state, always read
`claude/ops/state.md` first; numbers in this doc describe the routine, not
today's state.

---

## 1. Cutting a release and updating the curl installer

The `curl | sh` installer at `https://membridge.app/install.sh` is pinned to
one version + SHA-256. **Regenerating it is part of every release and nothing
fails when you skip it**: the old pin keeps working, so users silently get an
old build with no error anywhere. It has drifted multiple releases behind,
twice.

Full runbook: `docs/releasing-macos.md`. The load-bearing rules:

1. Publish the GitHub release (publishing, not tagging, fires the Build app
   workflow; a tag alone attaches nothing).
2. **Wait for CI, then stamp the pin from the published asset, never a local
   build.** CI attaches assets with `--clobber`, so a locally built zip gets
   replaced and its SHA invalidated. Also, signed macOS binaries are not
   byte-reproducible: the local zip and the published zip hash differently for
   the same version, and the installer hard-fails on checksum mismatch.
   `gh release download`, hash that file, then `node scripts/install/gen-install.js`.
3. Deploy the regenerated `install.sh` to the **site repo** (`mmelika/membridge-site`),
   branch **`main`** (see section 3), and commit the copy in this repo too.
4. Verify against the live URL, not the git push:
   `curl -fsSL https://membridge.app/install.sh | sh -s -- --dry-run`.
   A push is not a deploy; Pages takes ~20s.
5. **Never re-run CI against an already-published tag.** `--clobber` would
   replace the asset with a freshly signed zip carrying a different hash, and
   every new `curl | sh` install would hard-fail against the live SHA pin.

Same-release checklist that also drifts if forgotten: npm publish (human step,
OTP, three 2FA gates CI cannot satisfy), the site's JSON-LD `softwareVersion`
(tracks the public release, not master), and `llms.txt` / `llms-full.txt` when
product facts change.

## 2. Proving a build is real

- **Only CI produces signed builds.** The Developer ID is Andrew's and lives in
  repo secrets; Marco's keychain has zero identities, so a local
  `npm run dist:mac` is always ad-hoc signed. For a signed install, take the
  CI artifact.
- A green CI log is not proof of signing (a build killed after the signing line
  comes out ad-hoc). The only proof is downloading the published asset and
  running `codesign -dv --verbose=4`, `spctl -a -vv`, `xcrun stapler validate`.
- A 200 is not proof a download works. A missing GitHub release asset redirects
  to an HTML page and still returns 200. Check the content type: zip or
  octet-stream is real, `text/html` is a dead link.
- The repo working is not proof the product works. Test the published artifact
  (the npm tarball ships a subset of the repo; a whole class of defects only
  exists there).

## 3. Site checks (membridge.app)

- The site repo `mmelika/membridge-site` publishes from **`main`**. The app
  repo uses `master`, and muscle memory has pushed site changes to a stray
  `master` that Pages never serves: the push succeeds, the site never changes.
  Verify on the served page, not in the repo.
- Checking the membridge.me redirect: `curl -sSI https://membridge.me/` and
  expect a 301 to membridge.app. **Never check with `curl -L`**, which follows
  the redirect and makes a working 301 look like a duplicate 200-serving
  domain.
- Any Pages custom-domain change silently resets `https_enforced` to false.
  Turn it back on by hand; `.app` is HSTS-preloaded so there is no HTTP
  fallback while it is off.
- When product facts change (version, pricing, install command, adapters):
  update `llms.txt` and `llms-full.txt` (AI assistants read them verbatim),
  keep the FAQ JSON-LD identical to the visible FAQ, and re-ping IndexNow with
  the existing key (that key file stays forever).

## 4. Rebuild the installed app after merging to master

`/Applications/MemBridge.app` runs bundled code. Merges and pushes do not reach
it, and the stale installed app is the usual cause of "the feature is missing".
Marco's standing expectation: rebuild and reinstall as part of finishing any
merge to master, not as a step for later.

- Sequence: `npm run dist:mac`, quit the app, replace it in `/Applications`,
  relaunch, then curl its `/api/status` and expect 200. Keep the previous
  `.app` as `.prev` for instant rollback.
- **Never build with a symlinked `node_modules`** (use a real copy, APFS clone
  `cp -Rc`). A symlink makes electron-builder drop the base `libsodium`
  package from the asar, and the installed app then pauses E2E encryption.
  Before installing, check `asar list ... | grep '^/node_modules/libsodium/'`
  is non-empty.
- "Is it missing?" triage, in order: is it on master, is `ui/dist` newer than
  `ui/src`, and what version is the installed app. The daemon on port 7437 is
  the installed app, not the repo checkout.

## 5. Testing routine

The tracked rule is `.claude/rules/testing.md` and it deliberately overrides
the global always-run-everything habits:

- **The full suite is a ship gate, not a dev-loop tool.** Targeted checks while
  developing; a full run at most once per session, right before pushing. CI
  runs everything on every push anyway.
- **A green local build proves nothing about types.** Neither `Build app` nor
  `npm run build:ui` runs tsc; master was red for two days while both stayed
  green. The only local check is `cd ui && npx tsc --noEmit`.
- A suite run counts only if it printed the `N/N checks passed` tally AND
  exited 0. A port-collision crash produces neither, and an agent grepping for
  "FAIL" will read that crash as a pass.
- Broad UI-suite failure sweeps on a loaded laptop are timeouts, not bugs.
  Believe CI. If touching the timeouts: Testing Library's `asyncUtilTimeout`
  and vitest's `testTimeout` must move together.
- Before trusting weird suite failures, `lsof` the MemBridge ports. A live repo
  daemon or readme-demo squatting a port sends checks to the wrong process.
  **Never kill the squatters**; they belong to Marco or a parallel session.

## 6. Git rules

- **Everything pushes to `origin/master` on `MembridgeAi/membridge`.** Forks
  are fetch-only; `andrewb-eng/membridge` is hundreds of commits stale, treat
  it as deleted, and say so out loud if a connector points there.
- **Stage narrowly, never `git add -A`.** The working tree is mutated
  continuously by the daemon and parallel AI sessions; a broad add has captured
  another session's half-finished edits into a commit before. Verify the branch
  diff contains only your hunks before merging. One agent per working tree.
- Never `git push --tags` from Marco's checkout (stale pre-launch local tags
  would overwrite correct remote ones).
- Site repo pushes go to `main` (section 3).

## 7. Starting a session and using memory

- Read order for a fresh session: `claude/ops/state.md` (verified current
  state), `queue.md` (what is in flight), `decisions.md` (settled calls),
  `blocked.md` (waiting on a human). Any number not in `state.md` may be stale.
- Reconstructing prior work: one `search_memory` call first (keywords or a
  filename, not a sentence); `why <path>` before asking why a file looks the
  way it does.
- If a session claims it cannot see teammate work, check **which CLAUDE.md
  actually loaded** before blaming sync, encryption, or the share toggle. The
  worktree/injection races are fixed, but this diagnosis order stands.

## 8. The house bug shape

MemBridge's characteristic defect is **state claiming success it never
earned**: a `done: true` written after archiving nothing, a green suite that
only passed because of an untracked local build, an opt-out flag that still
phones home. The codebase is fail-open by design, so nothing throws when this
happens.

In review, ask of every completion flag: "can this be set on a path that did
no work?" Prefer terminal states that distinguish outcomes over a single
boolean, and make tests assert the work, not the flag.

## 9. Small recurring traps

- `lib/dashboard/client.js` is one giant template literal: a single backtick
  anywhere in added code or comments breaks the module at require time. Smoke
  it after editing: `node -e "require('./lib/dashboard.js')"`.
- Anything keyed by a file path must go through `repoRoot.ledgerKeyFor` /
  `wireKeyFor`. Marco works almost entirely in `.claude/worktrees/`, so a
  hand-rolled relative path splits the same file into a different key per
  worktree and the feature silently counts nothing.
- House style: no em dashes, anywhere.
