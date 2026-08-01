# Alpha readiness: plan

**Design doc:** `docs/superpowers/specs/2026-08-01-alpha-readiness-design.md`

## Locked decisions

These were argued through. If you think one is wrong, stop and say so rather than implementing a variation.

1. **The enroll command is `membridge add [path]`, defaulting to cwd.** Not `init`, not `track`. `add` mirrors the dashboard's language and reads correctly with no argument.
2. **`add` backfills by default.** A `--no-backfill` flag exists for the rare case, but the default is the behavior a new user expects. An adoption that shows nothing is worse than a slow adoption.
3. **Backfill is scoped to the adopted root, not global.** Resetting all offsets would re-inject every project. Reset only `state.files` entries whose events home to the newly adopted path.
4. **The duplicate-daemon fix is a liveness check, not a lockfile.** Read the pid, check the process is alive and is actually MemBridge, exit with a clear message if so. A real lockfile is a larger change and this is an alpha.
5. **Secret handling for alpha is a boundary plus a control, not better detection.** Document what redaction does and does not catch, and make the control visible. Do not attempt to solve prose-password detection.
6. **`install.sh` is verified before it is touched.** F7 is a suspicion. Confirm or kill it with a real fetch first.

## Task 1: ship the UI in the npm tarball

**Failing test first.** Write a test that runs `npm pack`, extracts the tarball, and asserts `ui/dist/index.html` exists. Run it. Watch it fail.

- [ ] Add `"ui/dist"` to `files` in `package.json`.
- [ ] Add a UI build to the publish path so a fresh clone produces `ui/dist` before packing. `prepublishOnly` currently runs `npm test` only; extend it rather than replacing it.
- [ ] Confirm the dashboard server's static path resolves correctly from an installed location, not just from a repo checkout. A path relative to `process.cwd()` will pass in-repo and fail installed.
- [ ] **Verification, mandatory, not optional:** `npm pack`, install the resulting tarball globally into a clean prefix, run `membridge dashboard`, and confirm a 200 with `text/html`. A 200 alone is not proof. Check the content type and that the body is the app shell, not an error page.

Do not mark this done off a green test suite.

## Task 2: add the CLI enroll command

**Failing test first.** Assert `membridge add <tmpdir>` results in a `state.projects` key for that path. Run it. Watch it fail with "unknown command".

- [ ] Export `addProject` and `adoptProjects` from a place the CLI can reach without pulling in the whole server. If that means moving them out of `lib/server.js`, do that and re-export from `server.js` for compatibility.
- [ ] Add `add` to the `commands` table in `bin/membridge.js`, defaulting the path to `process.cwd()`.
- [ ] Accept multiple paths, reusing `adoptProjects`' existing per-path skip reporting. Do not reimplement it.
- [ ] Print what happened per path: adopted, already tracked, or skipped with the reason.
- [ ] Add `add` to the help text at line 976, in the top block near `scan` and `sync`, not buried.
- [ ] Add a matching `membridge remove --project` cross-reference in the help so the pair is discoverable.

## Task 3: backfill history on adoption

**Failing test first.** Build a fixture with an existing transcript, run a sync so offsets advance past it, adopt the project, sync again, and assert the events appear. Run it. Watch it fail with zero events.

- [ ] In `addProject`, after the `state.projects` key is written, reset the `state.files` offsets for session files whose events home to that root.
- [ ] Determine "homes to that root" using the same resolution the scanner uses (`projectResolve.rehomeEvents` / `findProjectKey`). Do not reimplement the matching, or adoption and ingestion will disagree.
- [ ] If per-file attribution is not cheaply determinable before scanning, the acceptable fallback is: on adoption, clear offsets for all session files whose stored project attribution is unset or points at an untracked root. Never clear offsets for files attributed to an already-tracked project.
- [ ] Wire `--no-backfill` to skip the reset.
- [ ] Preserve the once-only offset invariant for the steady state. The dirty-flag comment at `lib/scan.js:651` explains why it exists. This change is a scoped reset at adoption, nothing more.
- [ ] Second test: adopting project A must not re-inject project B. Assert B's block is byte-identical before and after.

## Task 3b: end-to-end acceptance

This is the design doc's success criterion, run as an actual test rather than asserted.

- [ ] From the packed tarball, in a clean prefix, in a temp repo seeded with a realistic Claude Code transcript: install, `start`, `add .`, wait one interval, assert the memory block contains the seeded history.
- [ ] Record the wall-clock time from install to visible memory. If it is over five minutes, say so; that is the number the pitch lives or dies on.

Tasks 1 to 3 plus 3b are one shippable unit. Stop here and report before starting Task 4.

## Task 4: kill the duplicate-daemon race

**Failing test first.** Assert that starting a second daemon while a first is live does not overwrite the pid file. Run it. Watch it fail.

- [ ] In `cmdDaemon` (`bin/membridge.js:127`), before writing the pid file, read any existing pid and check whether that process is alive and is MemBridge. Checking liveness alone is not enough; pids are reused.
- [ ] If a live MemBridge daemon is found, exit with a clear message naming the existing pid and port. Do not silently no-op and do not kill it.
- [ ] If the pid file is stale (process dead, or alive but not MemBridge), take it over and log that you did.
- [ ] Leave the existing `cleanup` handler's `readPid() === process.pid` guard alone. It is already correct.

## Task 5: secret handling boundary

No detection changes. Document and control.

- [ ] Write `docs/security/redaction-boundary.md`: what `DEFAULT_PATTERNS` catches, what the entropy heuristic catches and its `ENTROPY_MIN_LEN`/`ENTROPY_THRESHOLD` thresholds, and the explicit statement that a password typed in prose is not caught.
- [ ] Confirm whether prompt capture is opt-in or opt-out today, and whether `team share-prompts` defaults to off. Report what you find; do not change the default in this task.
- [ ] Surface the boundary where it matters: the prompt-sharing setting in the dashboard and the `team share-prompts` CLI help both need one plain sentence about what redaction does not catch.
- [ ] Add a test asserting a known-format key is redacted and a prose password is not, with a comment naming this as documented behavior rather than a bug. This makes the boundary a tested contract instead of an accident.

## Task 6: remove the duplicated function

- [ ] Delete the second `adoptProjects` at `lib/server.js:1347`, keeping the one at 1315.
- [ ] Restore `deleteProject`'s doc comment to sit above `deleteProject`.
- [ ] Confirm the bodies were byte-identical before deleting. If they are not, stop and report; that would be a real behavioral bug rather than dead code.
- [ ] Check `git log -S adoptProjects` for the merge that introduced it and note the commit in the branch. If a bad merge duplicated one function, it may have duplicated others.

## Task 7: verify the installer SHA

- [ ] Fetch the live `install.sh` from a machine with real network access. If the fetch is blocked, stop and report; do not act on the suspicion.
- [ ] Compare the pinned SHA against the currently published asset.
- [ ] If it pins a stale asset, fix the SHA against the published asset only. Signed macOS binaries are not byte-reproducible, so the SHA cannot be regenerated from a local build. This has already been established once.

## Task 8: restore the Windows asset

- [ ] Determine why the `windows` job's upload did not produce an asset on the last release. The job is at `.github/workflows/build-app.yml:147`; the upload is gated on `github.event_name == 'release'`.
- [ ] Check whether `releases/latest/download/MemBridge.dmg` returning 404 is a filename mismatch or a genuinely missing asset. Report which; do not assume.
- [ ] Fix the workflow so both assets land under stable unversioned alias names.
- [ ] This cannot be proven until a release is cut, and Andrew cuts releases. State clearly what you changed and what still needs a real release to verify.

## What Andrew does, not you

- Re-tag `v0.2.3` off the post-fix commit, or cut `v0.2.4`.
- `npm publish`.
- Run the first-run test on a real Mac, since no agent here has one.
- Decide the prompt-capture default if Task 5 turns up something uncomfortable.
