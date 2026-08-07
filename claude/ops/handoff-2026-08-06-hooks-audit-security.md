# Handoff — hooks, savings audit, security · 2026-08-06

**For:** a fresh development session with no prior context.
**From:** run `run-mshuhden-b721` (2 phases, 20 agents).
**Read this whole file before touching code.** Everything below was verified against the repo or reproduced; where something is unverified it says so.

---

## 1. Where the code is

**Push-ready branch: `integrate/run-mshuhden-b721-phase2`**
- Base `origin/master` (`94c2d0a`). 14 source commits + 4 `--no-ff` merges = 18 commits.
- **Not pushed. Andrew has not said go.**
- Verified green: `node test/run.js` → **1949/1949 across 35 suites**; `cd ui && npx tsc --noEmit` exit 0; `npx vitest run` → **992/992 across 52 files**.

Contributing branches (all merged into the above, all still present):

| Branch | Commits | What |
|---|---|---|
| `integrate/run-mshuhden-b721-bugfixes` | `a12c31d`, `1e5bc35` | CLAUDE.md marker-span destruction; five leaking credential shapes |
| `worktree-agent-ad3ac2e3ba5e0ae39` | `f7b6845`, `20f25d1`, `2c9ab08`, `1ff9e96` | Security: ciphertext downgrade, path scrubbing, key rotation, deletion race |
| `worktree-agent-a086de07a618446a1` | `82158e7`, `da0ac2e` | Hook reliability + `test/suites/hooks.test.js` |
| `feat/measured-savings-tier2-tier3` | `7d04ab9`..`f794cd0` | BPE tokenizer, per-session holdout, `lib/roi.js`, calibration suites |

### Working-tree state you must not disturb
The main repo sits on `feat/feed-day-cards-and-delete` with three pre-existing dirty files that are **not this run's work**:
- `M ui/vite.config.ts` — **⚠️ contains an uncommitted `pool: 'threads'`, which is exactly what `origin/master`'s own 19-line comment forbids.** It unpins the timezone under CI's UTC and breaks 26 tests. This already turned CI red once (see project memory, 2026-08-05). Do not `git add -A`.
- `?? claude/ops/handoff-2026-08-06-feed-rework.md`
- `?? lib/adapters/cursor.js` — **dead draft, emits zero events by construction** (`scan.js` never sets the `sourceFile`/`sourceMtime` it depends on). Its own header says "unverified draft, do not register." That header is accurate. **Do not register it.**

To work on the integration branch without disturbing the above, use a worktree — `/Users/andrewbrown/membridge/wt-mergecaptain` is already on it. Checking out in the main repo would force git to clobber or refuse the dirty `vite.config.ts`.

---

## 2. The constraint that will waste your time if you miss it

**The hook that fires is not the code you are editing.**

Registration in `~/.claude/settings.json` points at `/Applications/MemBridge.app/Contents/Resources/app.asar/lib/membridge-hook.js` — the **installed app, 0.3.2**. This repo is **0.2.8**. Measured: the two emit different prompts (2998 vs 2925 chars).

**Consequence: edits to `lib/` and local hook tests do not affect captured data on this machine.** Any hook change needs a release + reinstall before it is live. Budget for that when validating.

This is fixed *in the branch* (see §3) but the fix is not live until shipped.

---

## 3. What was done

### Hooks — `82158e7`, `da0ac2e`

**Fixed the split-brain.** `hookVintage` compared registration fingerprints for **inequality, not order** — so a newer registration read as `outdated` and the remedy it offered was a **downgrade**. `ensureInstalled` took that invitation on *every launch*, repointing 0.3.2 at 0.2.8 and stripping the `hook-exec-wrapper.sh` prefix — an artifact **no code in this repo generates**, so it could not be restored.

- `compareVersions` now orders dotted segments **numerically**. String compare gets `0.10.0` vs `0.9.9` wrong; that would have reintroduced the bug at the next minor bump.
- New fourth state `newer`, whose correct action is nothing (`standDownReason` → `'newer'`, entry left byte-identical, reported `declined`).
- `splitHookCommand` lets a legitimate upgrade rewrite only MemBridge's half, preserving the wrapper prefix.
- **Guards applied to all four reconcilers**, because `ensureInstalled` runs all four.
- `membridge status` prints the effective script, version, wrapper, and a "NOT the code that runs on a stop" line.

**Fixed silent capture loss.** `runStop` gets edits only from daemon-owned `state.json`. Daemon down ⇒ never blocks ⇒ nothing captured. **39 of 49 logged stops were silent with nothing to distinguish the two states.**

- `lib/hook-stops.js` (new) names every exit path. `not-due` / `no-edits` / `no-edits-daemon-down` are **three distinct tokens**, from three cheap health signals (no state file, no live pid, state older than 3 intervals).
- **A `start` line is written before any work, so a start with no end *is* the timeout record.** The wrapper could never do this — it logs after its child returns, which is exactly why a killed child was invisible.
- `runAppend` records the capture (the hook exits before the append), closing the block-without-append gap and doubling as the last-successful-capture signal.
- `runStop` no longer copies all 4119 events to resolve one session.

**Verification groundwork, additive only.** New `verification` + `verificationChecks` fields grounded in the daemon's edit ledger and disk state. `verified` requires a checked correspondence; `contradicted` only for a cited file that neither exists nor was touched; a stale ledger yields `unverified`, **never** `contradicted`. Never blocks the write, never fails the append, **nothing reads it yet**.

> Design note worth preserving: the builder used the **edit ledger, not `git diff`**, because a diff cannot say *which session* touched a file — and session attribution is the thing being verified.

**`test/suites/hooks.test.js` created — 32/32 in 0.6s.** There was no hook suite before (≈58 assertions existed in the monolith; the gap was placement plus six uncovered modes).

### Savings audit — `7d04ab9`..`f794cd0`

**Tier 2 — real tokenizer.** `chars/4` is gone. `lib/bpe.js` runs a byte-pair merge loop over `vendor/tokenizer/claude-v1.json` — Anthropic's published Claude vocabulary from `@anthropic-ai/tokenizer` 0.0.4, 681 KB JSON, permissive, **no native module, no wasm**. `js-tiktoken` (22 MB) and `gpt-tokenizer` (53 MB) rejected on size. Lazy: 17.2 ms cold, 0.007 ms warm. The require-cache test still passes and now also pins that the recall hot path never loads the vocabulary.

Calibration: matches tiktoken exactly on 30 fixtures. `chars/4` understated this repo's source by **6.3%** aggregate, mean absolute error **7.98%**, range −40.9% to +1.1%. **The error tracks file type, so it does not cancel between files.** `BYTES_PER_TOKEN` (3.63) and `TOKENS_PER_LINE` (13.9) now measured, replacing the inherited 4 and 12.

**The ceiling, which matters more than the win:** against **313 real Claude responses**, ours −30.2%, `chars/4` −34.8%, cl100k −34.9%, o200k −35.2%. **Every offline tokenizer is ~30% under the vendor's billed count. No offline estimator reconciles with billing.** Everything stays labelled an estimate.

**Tier 3 — clean cohort.** `holdoutBucket` hashes `sessionId` alone (was `sessionId + relPath`). Proven whole-session through the real `decide()` path over 400 sessions × 5 paths: **0 split**, rate 2.94%. Old per-read evidence cannot mix — epoch-stamped `comparison` block, zeroed on epoch mismatch at the normalize boundary, refused again at pooling, drop count reported. `lib/roi.js` returns a difference of per-read means with a Welch 95% interval, gated on both arms independently, `null` never `0`.

**Andrew accepted that this restarts the measurement clock.**

### Security — `f7b6845`, `20f25d1`, `2c9ab08`, `1ff9e96` (+ phase 1)

- **Missing ciphertext now reads as a downgrade, not content.** Distinguished from a legitimately-plaintext row by append-only local evidence in `state.teamE2E`: `active` (server can set, never unset) and `minSealedId` (lowest row this device actually decrypted — lowering it costs the team key). Same hole swept out of `decryptTeamRows` (dashboard feed). `status.encryption` gained `verified` / `plaintextRows`.
- **`redact.scrubHomePaths`, applied at `entryToRow` only** — deliberately *not* in the shared table, because the local block legitimately needs real paths. Covers macOS/Linux/Windows/WSL, text plus `files[]` / `changes[].file`.
- **`rekeyTeam` now called on member removal.** It already existed and was never invoked; the removed device kept the epoch key forever.
- **Deletion watermark race** — a deletion confirmed during an in-flight sync was erased by that pass's stale `saveState`, and the next tick re-uploaded it. Enforced in `util.saveState`.
- Phase 1: five credential shapes (`https://user:pass@host`, lowercase `bearer`, AWS `ASIA…`, Slack `xoxc-`, and the JSON `{"password":...}` form every agent tool argument uses); and the marker-span bug where two `<!-- membridge -->` pairs made sync delete user notes and `membridge remove` delete the whole file.

---

## 4. What to do next, in order

### Tier 1 — fix before anything else. Both are in shipped 0.3.2.

**A. `search_memory` serves deleted, paused, excluded and archived projects (#46).**
Reproduced over the real MCP transport. `deleteProject` (`lib/server.js:1589`) strips blocks, wipes `.membridge`, prunes the archive, tombstones the path, deletes the state row — and **never touches `search.db`**. `freshenIndex` (`lib/activity.js:508`) only iterates `trackedProjectEntries`, so a project that leaves that set is never revisited. `runMatch` (`lib/search-index.js:355-375`) applies **no project-visibility predicate**; the only gate pushed into SQL is `excludeTeamFor`.

Nothing anywhere calls `replaceAll`/`replaceProject` to purge a project.

> **The fix pattern already exists in this repo.** `lib/hooks-search.js:151` gets it right — scopes the query with `project: projectPath` after an `isProjectOff` gate. And `test/run-tests.js:24725` already asserts `'a paused project must serve nothing'` for the *hook*. Two readers of one dataset disagreeing. Also hits `/api/search` (`lib/server.js:2491`).

**B. The first-run consent dialog is decorative (#48).**
`app/main.js:619` (`ensureInstalled`) writes Stop + both PreToolUse hooks + SessionStart + a Bash auto-approve rule — **then** `:654` shows the dialog. "Not now" → `applyConsent('declined')` writes only `distill.consent='declined'` and returns the literal string *"Session summaries declined — no hook installed."*

`runStop`'s only kill switch is `if (distill.enabled === false)` (`lib/hooks.js:303`). `applyConsent` never touches it. **`grep -n consent lib/hooks.js lib/hooks-recall.js lib/hooks-search.js lib/hooks-notes.js` → zero hits.** `needsConsentPrompt` then returns false forever.

Paired with **#49**: `ensureInstalled` (`lib/hooks.js:1599-1612`) reads neither `distill.enabled` nor `consent`, so `remove-hooks` is silently undone by the next launch. **Neither way a user can say no actually holds.**

> **The fix pattern exists here too.** `mcp-register.ensureRegistered` (`lib/mcp-register.js:762`) honours a recorded `'unregister'` opt-out forever. The hook side has no such record. Add one; have all four reconcilers consult it.

### Tier 2 — the systemic one

**#53 — success and absence markers written unconditionally.** Five instances, found by three independent agents who were not looking for this class:
1. `applyConsent`'s "no hook installed" string (#48)
2. Post-commit sweep stamps `hooksInstalledVersion` after installing zero hooks — **on every fresh install** (`lib/hooks.js:1579-1585`; `installPostCommitHooks()`'s return value discarded)
3. MCP fingerprint stamped regardless of row status (`lib/mcp-register.js:767-775`) — **broader than the known no-binary case**, since a transient `claude mcp add` timeout poisons it identically. `SPAWN_TIMEOUT_MS` is 5s; the CLI alone costs ~2.1s; `install.sh` registers while unzip is still settling
4. `autostart.enable()` discards the `systemctl` result (`lib/autostart.js:55-71`); `isEnabled()` tests file existence, not the enablement symlink. *Not reproduced — no systemd here*
5. Phase 1: hook tests asserted on emitted JSON, never receipt

Do one deliberate sweep, not five patches.

### Tier 3 — before building the top feature

**#45 — recall's measured yield is ~0.6%.** Injection provably works (canary-verified, see §6). But *"works when it fires"* and *"fires often enough to matter"* are different claims and only the first is established. **Do not raise a threshold. Instrument the rejection reasons first** — the serve policy in `lib/recall.js` has five candidate suppressors (tiering, already-served, `REJECTION_LIMIT`, the 3% holdout, and requiring a teammate call on that exact file). Ticket **#14** asks a closely related question and the same instrumentation answers both.

**This should gate F2 below**, since both ride the same path.

### Tier 4 — features (planned, not built)

Build order **F2 → F1 → F3**. Full specs in `runs/run-mshuhden-b721/phase2/top3-features.md`.

- **F2 · Decision recall at point of use** — ~1–2 weeks, no new deps, **no migration**; decisions are already in `summaries.jsonl` and merely rendered as feed prose. 17 HN + 5 Reddit voices. **Prerequisite: MiniSearch in front of `lib/search.js`** — 321 ms per 20k entries is too slow for the injection path (measured byte-identical top-5 on 7/7 real queries, 34 ms → 3.9 ms at 2,109 entries).
- **F1 · The Receipt** — per-team with/without proof. ~43 voices state the disbelief it answers. Tier 3 was the blocker and has landed.
- **F3 · The promotion boundary** — gated promote at `teamsync`'s `filterShareableEntries`, plus browse/edit/delete. ~2–3 weeks, touches sync core.

---

## 5. Decisions Andrew owes — do not guess these

| # | Decision |
|---|---|
| **#17** | Project revocation cannot be fixed client-side: **one team key spans all projects**, so there is no key to withhold. Needs project-scoped keys + schema change. Designed; **no migration written, nothing applied** — because it needs a design decision from Andrew, not a guess. ⚠️ **Corrected 2026-08-07:** an earlier version of this line also justified that on "035 is already outstanding." **That premise was wrong** — see #42 below. The decision stands on its own merits; do not repeat the migration-debt argument. |
| **#40** | Team-level savings **cannot be computed today at all.** `lib/api-insights.js` states teammates' token state is invisible server-side; the `savings` object is the *viewer's own* ledger; `team_feed` carries no token figures by design. Closing it needs opt-in aggregate telemetry, which trades against local-first — and local-first is now *also* Anthropic's argument. |
| **#42** | Self-serve deletion has **no user-facing surface**. Backend + RPC + 26 tests exist; nothing in the repo calls `/api/team/my-data` or `delete-my-data`. **Being built by another session** (working off this branch, so it picks up `1ff9e96`'s watermark race fix — a button built on `master` would wire up a delete that un-deletes itself).<br><br>⚠️ **Corrected 2026-08-07, verified against the live DB.** Earlier text here and elsewhere claimed a 035-vs-028 discrepancy and that the migration was unapplied. **Both wrong.** The file is `035_delete_own_entries.sql`; its own header (lines 6–11) documents the historical renumbering, and any `lib/`/`test/` comment citing "028" for the delete policy is stale (028 is project-access defaults). **035 is *partially* applied**: §2 `my_entry_counts`, §3 `delete_my_entries` (current per-project return shape) and §4 grants are all live and correct; **only §1, the `memory_entries_delete` RLS policy, is absent.** The **RPC works today** — `relforcerowsecurity = false` plus `security definer` owned by `postgres` means the delete runs as table owner, outside RLS. What §1's absence actually costs is the direct-DELETE path through PostgREST under a user JWT, which affects zero rows and **reports success** — i.e. #53's silent-success shape, in production, on a compliance surface. Applying §1 is a production DDL grant and is Andrew's call. |
| **#55** | The epoch reset **and** a lower `avoided.serves` (Tier 2 prices skeletons higher, pushing files below `MIN_COMPRESSION`) land in the same release. The product will look like it got worse at the moment it got honest. Ship with narrative, stage them, or re-tune `MIN_COMPRESSION` first — the old threshold was calibrated against a biased estimator. |
| **#39** | Codex capture is materially weaker and nothing discloses it.<br><br>⚠️ **Corrected 2026-08-07 — `phase2/hook-diagnostic.md` Part 2 is WRONG and you must not trust it.** It states "Codex has no Stop-hook equivalent." **False.** Codex CLI ships `SessionStart`, `SessionEnd`, `Stop`, `PreToolUse` and seven more; `SessionEnd` is stable. Verified at `learn.chatgpt.com/docs/hooks`. The diagnostic reached that conclusion by grepping *this repo* for a Codex registration path — which only proved **MemBridge doesn't register one**, never that Codex lacks them. A negative claim about another vendor made purely from local evidence.<br><br>**The real distinction, which still supports every downstream conclusion:** Codex's `SessionEnd` is **advisory** — it cannot block or delay termination, its output "won't steer Codex or keep the thread open", and its timeout is **1s default / 3s max vs 600s** for other events. MemBridge's Claude Code capture needs exactly what Codex withholds: blocking the stop so the *model* writes to a schema. **The difference is what a hook may do, not whether one exists.**<br><br>**This makes the fix concrete:** register a real Codex `SessionEnd` hook — it can't block, but it *can* read the transcript while it runs, which is enough to trigger a daemon-side distillation pass instead of the passive rollout poll. Owned by the Hook Rework session; Andrew wants to be told before hook work starts. Disclosure has landed in `docs/guide.md`. |
| **#11** | README's "Nobody else does this" for mid-session injection is refutable — Devin ships it. The narrower true claim: nobody injects a *teammate's passively captured, attributed* decision. |
| **Schema** | The hook schema rewrite (S1/S2/S4–S7/S9) is specced with estimates; **S1 alone is 3–5 days.** Not started deliberately — it changes live data that syncs to teammates. |

---

## 6. Things already settled — do not redo them

- **Mid-session injection works.** Canary-verified twice (first run discarded as confounded). The model returned `ZQX-CANARY-4417` verbatim; Claude Code 2.1.223 writes a dedicated `hook_additional_context` attachment record. `anthropics/claude-code#19432`, which claimed otherwise, has **zero human comments** and was bot-closed for inactivity.
- **The arXiv "context files hurt" result is defused.** *Evaluating AGENTS.md* (Gloaguen et al., ETH Zurich, workshop paper). **v1 said "reduce"; v2 says "do not generally improve" — the authors walked it back.** Effect is −0.5% / −2%, one run, no seeds, no significance tests. And the half usually dropped: developer-written files *improved* performance for 3 of 4 agents, and with README/`docs/` deleted the same generated files **"consistently improve performance by 2.7%"** — which is the condition MemBridge occupies, since it writes episodic session history that exists nowhere in the repo.
- **Injection is the right primitive, not search.** `claude-code#78795`: an agent pre-seeded with 4 relevant notes made **zero memory reads in 114 turns**. Push works; pull doesn't.
- **Competitive map corrections:** Windsurf no longer exists as a brand (→ Devin Desktop, Cascade memories now *legacy*); Continue is shut down (acqui-hired by Cursor, never shipped memory); Amp left Sourcegraph and has **no memory feature** (grepped its 78k-char manual: zero hits); Cursor **removed** Memories in 2.1.17.
- **Claude Code ships auto-memory, on by default, since v2.1.32** — but *"Files are not shared across machines or cloud environments."* That sentence is the remaining moat.
- **C1 test failure is environmental.** `vendor/grammars/*.wasm` **are tracked in git** (an earlier diagnosis said otherwise and was wrong). The only missing prerequisite in a fresh worktree is `ui/node_modules`, without which `prepack`→`build:ui` fails before npm inspects anything.

---

## 7. Repo rules that bind you

`.claude/rules/testing.md` — **read it.** The full suite is a ship gate, not a dev loop.
- New tests go in `test/suites/`, not the monolith. Require `../harness` **first**, end with `h.finish()`.
- `node test/run.js <name>` for one suite; `--list` for names.
- `ui/`: `cd ui && npx tsc --noEmit` (the **only** local check catching type errors — `npm run build:ui` does not), then `npx vitest run <file>`.
- Full run only immediately before pushing, at most once per session.

---

## 8. Where everything is written up

`~/.claude/command-center/runs/run-mshuhden-b721/`

| File | What |
|---|---|
| `report.md` | Phase 1 — research, competitors, pricing |
| `report-phase2.md` | Phase 2 — hooks, audit, security, features |
| `phase2/hook-diagnostic.md` | Full hook map, data flow, Codex comparison, failure modes |
| `phase2/hook-research.md` | Why the summary blob is the wrong primitive; schema proposals |
| `phase2/hook-changes.md` | Every hook change with its evidence |
| `phase2/audit-mvp.md` | Tokenizer choice, calibration numbers, honest limits |
| `phase2/audit-integration-plan.md` | The four-class vocabulary; surface-by-surface placement |
| `phase2/security-fixes.md` | Found/fixed bullets + what needs Andrew |
| `phase2/top3-features.md` | F1/F2/F3 fully specced + the 75% fold table |
| `phase2/pricing-gameplan.md` | N=25, the ROI clock (scoping only — nothing shipped) |
| `phase2/merge-captain-phase2.md` | Merge conflicts, resolutions, full verification output |
| `research/` (14 files) | Phase-1 evidence base, ~8,000 mined comments |

Board: 56 tickets, statuses honest. Open items needing Andrew are listed in §5.
