# Alpha readiness: plan

**Design doc:** `docs/superpowers/specs/2026-08-01-alpha-readiness-design.md`

## Locked decisions

These were argued through. If you think one is wrong, stop and say so rather than implementing a variation.

1. **The enroll command is `membridge add [path]`, defaulting to cwd.** Not `init`, not `track`. `add` mirrors the dashboard's language and reads correctly with no argument.
2. **`add` backfills by default.** A `--no-backfill` flag exists for the rare case, but the default is the behavior a new user expects. An adoption that shows nothing is worse than a slow adoption.
3. **Backfill is scoped to the adopted root, not global.** Resetting all offsets would re-inject every project. Reset only `state.files` entries whose events home to the newly adopted path.
4. **The duplicate-daemon fix is a liveness check, not a lockfile.** Read the pid, check the process is alive and is actually MemBridge, exit with a clear message if so. A real lockfile is a larger change and this is an alpha.
5. **SUPERSEDED. Secret handling is now a default change plus two deterministic layers, not documentation alone.** This decision originally read "a boundary plus a control, not better detection". It was made before the prompt-sharing branch merged and turned sharing on for every fresh install, which moved the default across the boundary the documentation was going to describe. Task 5 was rewritten in full and carries its own locked decisions. Prose-password detection is still not attempted, and that limit is still documented; what changed is that the default no longer uploads verbatim prompts, and two deterministic layers (env-value deny-list, carrier-phrase capture) now sit in front of it.
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

## Task 5: prompt sharing that survives a security review

**This replaces the original Task 5 in full.** That version said "document the
boundary, do not attempt better detection." It was written before the
prompt-sharing branch merged and made sharing the default for fresh installs.
Documenting a boundary is no longer sufficient when the default walks users
across it.

**Do this after Task 3b, not before.** It is not an alpha blocker the way the
enroll path is, but it is the thing most likely to end a conversation with a
company, so it ships before anyone is pitched.

### The problem, stated precisely

`lib/redact.js` catches secrets by shape. `DEFAULT_PATTERNS` matches known key
formats, and `redactHighEntropy` catches anything with at least
`ENTROPY_MIN_LEN` characters at `ENTROPY_THRESHOLD` bits per character.

A password typed in prose has neither property. `hunter2corgi` is a short,
low-entropy string with no recognizable prefix. It is not distinguishable from
a project name by any threshold that does not also destroy normal text. This is
not an implementation gap. It is undecidable from the string alone.

Meanwhile `lib/teamsync.js` uploads `ask` at 400 characters and `goal` at 200
when sharing is on, and after the prompt-sharing merge, sharing is on for every
fresh install.

So the current alpha default is: a company installs MemBridge, an engineer types
a credential into a prompt, and it lands in Supabase without anyone having
chosen that.

Three changes, in order of value. All three ship together.

### Decisions already made

Do not implement variations of these. If you think one is wrong, stop and say
so.

1. **Distilled intent is the default sharing mode, not verbatim prompts.**
   Verbatim remains available as an explicit opt-in.
2. **Nobody's existing setting changes.** A user who chose verbatim sharing
   keeps verbatim sharing. The same reasoning the prompt-sharing branch used for
   keeping `sharePrompts` out of `DEFAULT_CONFIG` applies here with more force.
3. **The env deny-list never persists the values it reads.** Compiled in
   memory, used, discarded. A file on disk containing a user's secrets, created
   by the tool that was supposed to protect them, is worse than the original
   problem.
4. **There stays exactly one redaction pipeline.** `lib/digest.js` calls its
   `redactText` "THE single redaction pipeline" and `lib/recall-store.js`
   documents its backstop as depending on that. Every addition here goes through
   it. Two redactors that disagree is the same class of defect as the two
   `lib/activity.js` extractions.
5. **Carrier-phrase matching redacts the captured secret, not the surrounding
   sentence.** "the staging password is [redacted:phrase]" keeps its meaning.
   "[redacted:phrase]" does not.

### Task 5A: share distilled intent by default

Establish the facts first, before writing any code.

- [ ] `lib/teamsync.js` around line 803 uploads both `ask` and `goal`. Determine
      and report the provenance of each: which one is the raw user prompt text
      and which is agent-written, and whether `goal` is populated on every entry
      or only on distilled ones. `lib/digest.js` `pickSummary` and the two
      adapters' harvested-summary fallback are the places to look.
- [ ] **Do not proceed on the assumption that `goal` is distilled.** If both are
      raw, or if `goal` is frequently absent, this task changes shape. Come back
      with what you found before continuing.

**Failing test first.** Assert that with fresh-install defaults, a pushed entry
carries no verbatim prompt text. Run it. Watch it fail.

- [ ] Widen `team.sharePrompts` from a boolean to `'off' | 'distilled' |
      'verbatim'`, accepting the boolean for back-compat.
- [ ] Back-compat mapping, exactly: `true` maps to `'verbatim'`, `false` maps to
      `'off'`, absent stays absent. An existing user's behavior does not change.
- [ ] `freshInstallConfig` sets `'distilled'`, replacing the current
      on-by-default.
- [ ] At the upload site, `'distilled'` sends the agent-written field and sends
      the verbatim field as `null`. Keep the existing explicit-null convention;
      the comment near line 789 explains why `undefined` is wrong here.
- [ ] Check `shouldSharePrompts` around line 1196 and the per-project override
      around 1229. Both need to understand three states, and the legacy boolean
      fallback has to keep working for projects untouched by the migration.
- [ ] Update `membridge team share-prompts` to take `off|distilled|verbatim`,
      keeping `on` and `off` as aliases for verbatim and off so no one's muscle
      memory or script breaks. Update the help text.
- [ ] Update the dashboard setting to three options, with one plain sentence
      each on what actually leaves the machine.
- [ ] Test that a distilled-mode push carries a **readable** row. The whole
      justification for the prompt-sharing branch was that rows without intent
      are a name and a timestamp. If distilled mode reproduces that emptiness,
      this task has failed even with a green suite. Measure it against real
      captured data and report the number, the same way the branch reported 13
      of 21.

### Task 5B: environment-value deny-list

Redact any literal string that appears as a value in the project's own env
files, wherever that string shows up in captured text. Deterministic, no
heuristics, and it catches the realistic case, which is someone pasting a
credential they already have on disk rather than inventing one in chat.

**Failing test first.** Fixture project with a `.env` containing a known value,
a captured prompt containing that value verbatim, assert it is redacted. Run it.
Watch it fail.

- [ ] Read `.env`, `.env.local`, `.env.development`, `.env.production` and
      `.env.*.local` from the tracked project root only. Never walk upward,
      never follow symlinks out of the root.
- [ ] Explicitly exclude `.env.example`, `.env.sample`, `.env.template` and
      anything matching `*.example`. Those hold placeholders, and redacting
      placeholder text would corrupt normal prose.
- [ ] Parse values only. Keys are not secrets and redacting them destroys
      readability.
- [ ] Minimum value length of 8 characters, and skip a stop-list of obvious
      non-secrets: `true`, `false`, `localhost`, bare integers, `development`,
      `production`, `test`, and anything that is only digits or only a URL
      scheme and host.
- [ ] Match **literally, not as a regex**. Escape every metacharacter. A value
      like `p@ss.w+rd` compiled as a pattern would silently redact unrelated
      text.
- [ ] Case-sensitive. Secrets are.
- [ ] Emit `[redacted:env]` so a reader can tell why something disappeared.
- [ ] Never write the compiled values to disk, to logs, to `state.json`, or to
      an error message. Add a test that greps every artifact the fixture run
      produces for the known value and fails if it appears anywhere.
- [ ] Cache the compiled matcher per project with an mtime check, so this is not
      a file read on every event.

**One design question to answer, not guess.** `compileRedactions` in
`lib/digest.js` takes config and has no project context, but this deny-list is
inherently per project. Decide how project scope reaches the pipeline without
creating a second pipeline, and write the reasoning in the commit. If the honest
answer is that it requires a signature change across several callers, do that
rather than adding a parallel path.

### Task 5C: carrier-phrase detection

Match the sentence that introduces a secret rather than the secret itself.

**Failing test first.** Assert that `the staging password is hunter2corgi` has
the value redacted and the sentence preserved. Run it. Watch it fail.

- [ ] Cover the common carriers: `password`, `passwd`, `pwd`, `passphrase`,
      `secret`, `token`, `api key`, `apikey`, `access key`, `credential`,
      `creds`, `auth`, followed by `is`, `are`, `was`, `=`, `:` or `->`, then
      the value.
- [ ] Redact only the captured value. Check whether the `DEFAULT_PATTERNS`
      mechanism supports capture-group replacement. If it replaces matches
      wholesale, that mechanism needs extending, and that is part of this task.
- [ ] Emit `[redacted:phrase]`.
- [ ] Skip captures that are obviously not secrets: `empty`, `blank`,
      `required`, `wrong`, `incorrect`, `correct`, `missing`, `null`,
      `undefined`, `set`, `unset`, and any capture under 4 characters. "the
      password field is empty" must survive intact.
- [ ] Handle quoted values, since `password: "hunter2corgi"` is at least as
      common as the bare form. Redact inside the quotes and keep the quotes.
- [ ] **Measure the false-positive rate before calling this done.** Run it
      across the existing captured corpus on this machine, count how many
      redactions fire, and hand-check a sample. Report the number. If it is
      redacting ordinary prose at a noticeable rate, tighten it and say what you
      tightened.
- [ ] It lands in `DEFAULT_PATTERNS`, so `config.redactDefaults: false` turns it
      off along with everything else. That is the correct escape hatch and no
      separate flag is needed.

### Task 5D: the boundary document

Still required. It is now shorter, because the boundary moved.

- [ ] Write `docs/security/redaction-boundary.md`: what each layer catches, in
      order, with the entropy thresholds named. What the three sharing modes
      actually put on the wire. What is still not caught after all three
      changes, stated plainly rather than softened.
- [ ] Keep the test from the original Task 5 asserting that a novel prose secret
      with no carrier phrase and no env presence is **not** caught, commented as
      documented behavior rather than a bug. That test is the honest part of the
      document and it should exist in code.
- [ ] Surface one sentence of it in the dashboard sharing setting and in the
      `team share-prompts` help.

### Task 5E: report, do not implement

- [ ] With distilled mode as the fresh-install default, say whether a first-run
      choice is still warranted, and identify the exact surface where it would
      appear. Propose the smallest version. Andrew decides; do not implement it
      in this branch.

### Verification for the whole task

- [ ] A single fixture run with all three layers active, containing a shaped API
      key, an env-file value, a carrier-phrase password, and a novel prose
      password. Assert the first three are redacted, the fourth is not, and the
      surrounding text is readable.
- [ ] Confirm the redaction runs **before** clipping. `lib/digest.js` already
      carries the comment explaining why truncation must not sever a pattern's
      anchor. These additions must not break that ordering.
- [ ] Report both suite counts and any test that disappeared.
- [ ] The `lib/teamsync.js` line references above were taken before the NUL-byte
      fix and may have drifted. Verify against the current tree.

### Not in scope

Lowering the entropy threshold. An LLM redaction pass. Retroactive scrubbing of
already-uploaded rows, which is a real question but a separate one, and the
number of affected rows comes before that decision.

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
