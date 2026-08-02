# Decisions

Standing decisions and the reasoning behind them, most recent first. This is
the record, not a summary of one. The repo is canonical and the Claude Project
is the mirror. If they disagree, this file wins.

An entry here means the reasoning is settled. Reopen one only with a new fact,
not with a fresh opinion. Entries explicitly marked contested are not settled
and are flagged as such.

---

## A deliberately deleted project does not come back on re-add

**Decided 2026-08-01.** Alpha readiness F3 makes adoption backfill a project's
history: the daemon consumes transcript bytes for projects it is not tracking
yet, so without a reset an adopted project shows an empty block. Correct for a
project that was never tracked. Wrong for one the user deleted on purpose.

`deleteProject` and `membridge remove` now write a tombstone into
`state.deletedProjects`. `addProject` consults it, skips the backfill, and
clears it, so a second delete-and-re-add behaves the same way rather than
inheriting a stale entry. `membridge add --backfill` overrides it explicitly.
Opt-in, never default.

### Why this beat the tidiness argument

`deleteProject`'s own comment argues the other way, and it is a good argument:
a re-add "is a fresh decision to track it, and it starts capturing like any
other newly added project", and any other newly added project now backfills.

It loses to the CLI help text. `membridge remove` tells the user it
**permanently** deletes their local memory history and that **this cannot be
undone**. After F3 that promise was breakable from a dashboard checkbox, by
accident. A documented permanence guarantee is not something to break to avoid
one state key.

The security case is the reason rather than a tiebreaker. Delete is currently
the only purge a user has for a credential captured into a prompt, which is the
gap the rewritten Task 5 exists to close. A purge that silently reverses is not
a purge.

### The uncomfortable part, recorded on purpose

**The transcript was never actually gone.** What `remove` deletes is
MemBridge's own `.membridge` history and the injected blocks. The underlying
Claude Code or Codex transcript on disk is untouched, and it is still readable
by anything that cares to read it.

Before F3 the purge held only because the scanner's read offsets had already
been consumed, so nothing re-read the file. That is a side effect, not a
guarantee. Anything that reset those offsets, which is exactly what F3 added,
would have undone the purge without a single line of the deletion code
changing.

So the permanence the help text claims was always weaker than it sounded. The
tombstone makes it deliberate rather than accidental, and that is a real
improvement, but it still only binds MemBridge. **Someone should revisit
whether the help text is honest**, because a user reading "permanently deleted
and cannot be undone" is likely to believe the underlying prompt is gone from
their machine, and it is not.

Related: a credential that reached a teammate's machine through team sync is
not covered by any of this either, which is the retroactive-scrubbing question
Task 5 explicitly puts out of scope pending a count of affected rows.

## `lib/activity.js` is one shared corpus, reconciled from two independent extractions

**Decided 2026-08-01.** `lib/activity.js` was extracted out of `lib/mcp.js`
**twice**, by two people who could not see each other's work.

- `2500761` on master pulled out 78 lines so `lib/hooks-search.js`, the
  PreToolUse Grep/Glob hook, could build the same entries without loading the
  MCP SDK at module scope.
- `3d951a7` on `claude/prompt-sharing-mcp-visibility-26de91`, branched from
  `802d366` and unaware of the above, pulled out 315 lines so the dashboard's
  `GET /api/search` could answer from the same corpus.

Same header rationale, same stated goal, different code. They collided as an
add/add conflict.

**Neither version was a superset.** This was measured before anything was
chosen, because the obvious move (take the 315-line one, it is bigger) would
have silently broken the hook.

Master had, the branch lacked:

- `projectEntries(key, proj, config, regexes)`, the single-project assembly.
  `lib/hooks-search.js` calls it directly. The branch had no `hooks-search.js`
  at all, so nothing on that side revealed the dependency.
- Master's `allActivity` **calls** `projectEntries`. The branch's `allActivity`
  re-inlined the same `buildEntries` + `normalizeLocal` + `teamRowsFor` body,
  which is precisely the duplication the module exists to delete.
- `searchLib.rankWithFallback`, the strict-then-relaxed ranking policy moved
  into `lib/search.js` so the hook and `search_memory` cannot disagree about
  what "no results" means. The branch reimplemented that two-pass privately
  inside `searchMemory`.

The branch had, master lacked: `collapseIdentityTwins`/`contentRank`, the LRU
archive-entry cache, `loadContext`, `trackedProjectEntries`, the archive loop's
own `seen.add` so the archive cannot return its own twins, and the dedup key
change below. `mapTeamRow` was byte-identical on both sides.

**Resolution:** the branch's module as the base, with `projectEntries`
restored, `allActivity` delegating to it, and `searchMemory` ranking through
`rankWithFallback`. `lib/mcp.js` and the one conflicting test hunk take the
branch side, which is correct once both halves live in `activity.js`.

### The dedup key changed from author to session, and that is observable

Master keyed duplicate detection on `${author}|${ts}|${source}`. The branch's
`eventKey` keys on the session id instead, falling back to the author spelling
only for session-less rows (older captures, harvested rows). The branch's key
won.

**Why, because someone will ask.** A session id is minted per tool run and is
never shared between two people, so it names the event itself. An author key
does not: one human can reach a project's history under two display names, an
account first pushed as `andrewludwigbrown` that later renders as
`Andrew Brown`, and every such row is a genuine separate row on the backend.
Keyed on the author they read as two people doing identical work in the same
millisecond. On live data this put the same two events in 4 of 8 search
results.

The visible effect is that search and activity return **fewer** rows than
before for anyone whose display name has ever changed. That is the fix, not a
regression.

### The three-leg invariant is now pinned in the suite

The hook, the MCP tools and `/api/search` must answer out of the same entries
and the same scorer. That is the whole reason the module exists, and it broke
twice by accident, so it is no longer left to good intentions: a check in
`test/run-tests.js` asserts at source level that `allActivity` delegates to
`projectEntries` rather than calling `buildEntries` itself, that both
`lib/activity.js` and `lib/hooks-search.js` rank through `rankWithFallback` and
never call `rankEntries` directly, and that `lib/mcp.js` and `lib/server.js`
both delegate to `activity.searchMemory`.

It is source-level on purpose. The failure being guarded against is two code
paths that each work correctly in isolation and quietly answer differently,
which no behavioral assertion catches. Proven non-vacuous in both directions:
re-inlining the assembly fails it with "allActivity no longer delegates to
projectEntries", bypassing the scorer fails it with "does not rank through
rankWithFallback".

**A third extraction is the thing to watch for.** If a future surface needs
this corpus, it imports from `lib/activity.js`. It does not carve out its own.

## Node 18 leaves the CI matrix, `engines.node` STAYS at `>=18`

**Status:** decided and merged. The matrix change came from `da584f4` on
`fix/release-pipeline`. The `engines` half of that commit was reverted after the
runtime was actually tested.

**Reasoning, and the distinction that matters.** Node 18 cannot BUILD the UI.
`vite` 8.1.5 and `rolldown` 1.1.5 both declare
`engines: {"node":"^20.19.0 || >=22.12.0"}`, rolldown's distributed build does
`import { formatWithOptions, styleText } from "node:util"`, and `styleText` does
not exist before Node 20. Reproduced on real Node 18.20.8. Every CI run since
the React UI landed on 2026-07-29 failed, and on the runs checked leg by leg,
the Node 18 legs failed at `npm run build` on all three operating systems and
never reached the test step. So 18 leaves the matrix.

**But that is a build-time constraint, and `engines` is a claim about the
runtime.** The npm tarball's `files` field is `bin`, `lib`, `vendor`,
`README.md`, `LICENSE`. It ships no `ui/dist` and no build toolchain, so an npm
consumer never runs vite and never reaches `styleText`. Verified rather than
assumed: a packed 0.2.3 tarball was installed into a clean directory under real
Node 18.20.8, and `membridge --version`, `--help` and `status` all worked, the
daemon started and served `/api/status` with a real payload after a successful
sync, and the MCP server initialized and listed all six tools. A grep of `lib/`
and `bin/` for Node 20+ APIs finds none.

Raising the floor to `>=20` on build-toolchain evidence would have locked out
users who are fine. That is the mirror image of the bug being fixed, which is a
manifest making a claim reality does not support. The matrix and `engines`
disagree deliberately, and the reason is recorded in a comment in
`.github/workflows/ci.yml` beside the matrix so it is not re-litigated.

The matrix keeps all three operating systems. `windows-latest` is load-bearing,
not decoration: it is the only place `lib/keychain.js`'s DPAPI backend ever
runs, and those checks print a visible skip everywhere else. Dropping that leg
would silently delete all coverage of Windows private-key storage while the
suite still reported green.

---

## `deleteProject` prunes both `config.archived` and `config.exclude`

**Status:** decided and shipped, `77bd410`.

This deviates from the projects-tab spec, which said "deleteProject behavior
untouched". The deviation is deliberate and was ratified by the owner.

**Reasoning.** `archiveProject` writes the path into **both** `config.archived`
and `config.exclude`, because archive implies paused. Cleaning only one on
delete leaves a trap: archive, then delete, then re-add the same path, and the
project comes back either invisible (still in `archived`) or visible but
permanently paused (still in `exclude`). That is the exact invisible-state bug
the archived prune was written to close, wearing a different hat.

Pruning `exclude` is correct whether the entry got there from archive or from
the user hitting Pause. Delete removes the project from the daemon entirely, so
either entry is stale, and re-adding the path is a fresh decision to track it.

Both prunes sit in the same guarded block, under the same rule that a config
write failure never turns a completed delete into a reported failure, and log
when they do fail. Code at `lib/server.js:1367` onward.

---

## `MIN_COMPRESSION` gets recalibrated when the BPE tokenizer lands

**Status:** decided in principle, blocking the Tier 2 tokenizer work. The
tokenizer sits uncommitted in an agent worktree and `lib/token-estimate.js` on
master is still chars/4.

**Reasoning.** `MIN_COMPRESSION` is `2.25` at `lib/recall.js:41`, and it gates a
ratio: `callTokens / skeletonTokens`. That constant was calibrated while both
sides of the ratio were produced by the chars/4 heuristic. A real BPE tokenizer
changes the units on one side of that comparison only, so `2.25` stops
expressing the thing it was chosen to express.

Recalibrating **restores the original intent**. It is not relaxing a quality
bar, and it should not be argued about as though it were. The number was a
measurement in one unit system and it needs to be re-measured in the new one.
Shipping the tokenizer without doing that would silently move the gate.

---

## USD stays persisted in the ledger, and is still never served

**Status:** decided. An earlier instruction to stop persisting USD was
**reversed**. Important: the code on master currently implements the reversed,
superseded instruction. See the mismatch note below.

**Reasoning.** The persisted figure is the only thing that makes a
user-supplied-rate feature work without re-folding the entire history. If the
dollar figure is never written down, then the day a user supplies their own
rate, there is nothing to apply it to and every past period has to be recomputed
from scratch. Keeping it on disk is what buys that option.

The serving rule is unchanged and absolute: **the persisted USD figure must
never go out on the wire.** MemBridge prices at list-price API rates while many
users are on flat subscription plans, so a dollar number would contradict, and
therefore discredit, every token figure beside it. Persisted, never served.

**Mismatch to reconcile before building on the ledger.** As of `fbd1aed`,
`lib/ledger-fold.js` around lines 289 to 297 both states and implements the
opposite of this decision: no USD is computed into the ledger, none is written,
and a legacy ledger's `inCost` / `outCost` are dropped on the next fold. The
matching comment is at `lib/server.js:496`, which is the comment previously
referred to as being at `:471`; the line moved when `fbd1aed` landed. So the
wrong comment is not the only wrong thing. The behavior is wrong against this
decision too, and both need fixing together.

---

## OAuth callbacks are bound to the request that started them, with PKCE

**Status:** decided and shipped as `fbd1aed`, which is Task 1 of the security
remediation plan. Not fully proven, see below.

**Reasoning.** The authorize request carried no `state`. That meant any page the
user visited could hand the local daemon an attacker-issued session, and the
daemon would accept it as the completion of a sign-in it never started. With
auto-link on top, that does not stop at a wrong session: it pushes the victim's
prompts into the attacker's team. That is the whole reason this jumped the queue
and merged ahead of the UI work.

The fix generates a CSPRNG `state` per authorize request, holds it in daemon
memory with a five minute TTL, carries it through `redirect_to`, and verifies
and consumes it before `loginWithTokens` is ever reached. `state` is single use.
The callback page clears `window.location.hash` after reading it. PKCE is
included.

**What is and is not proven, stated honestly.** The automated tests ran against
a **mocked** Supabase, so they prove the daemon's half of the contract and
nothing about the real provider. A real first-hop probe against live GoTrue did
confirm three things: it preserves the redirect query string, it echoes `state`
back, and it accepts PKCE. The **final redirect leg remains unproven.** It stays
unproven until a human does a live sign-in, completes it, replays the same
callback URL a second time, and confirms the replay is rejected. That test has
not happened. Do not describe this hole as closed end to end until it does.

---

## Counters opt-in is CONTESTED and on hold

**Status:** not decided. On hold. Counters remain opt-out today, which is the
current shipped behavior, not an endorsement of it.

Current state, for reference: `countersEnabled()` in `lib/counters.js` defers
entirely to `diagnostics.diagnosticsEnabled(config)`, deliberately reusing that
kill switch rather than inventing a second one, so `MEMBRIDGE_NO_DIAGNOSTICS=1`
turns off the whole family at once.

Both positions are recorded here because neither has won.

**For converting to opt-in.** It follows the consent pattern the product
already uses elsewhere. Collecting by default is inconsistent with how the rest
of the product asks before it gathers, and consistency in consent is worth more
than the data.

**Against converting to opt-in.** Opt-in retains somewhere in the range of 10 to
30 percent of installs. Counters exist specifically to catch install classes
that are **silently broken**, which is a failure mode that produces no bug
report by definition. Detecting it needs breadth, and a sample skewed toward the
users engaged enough to opt in is precisely the sample least likely to contain
the broken installs. Under opt-in, the counters would keep running while
quietly ceasing to do the job they were built for.

**Proposed middle path, not yet ratified.** Keep the current default, add a
clear first-run notice so nothing is happening in secret, and add a Settings
toggle that reflects the real state and actually controls it. That gets
informed consent and keeps the breadth. It has not been agreed to, and this
entry stays contested until someone agrees to something.
