# Decisions

Standing decisions and the reasoning behind them, most recent first. This is
the record, not a summary of one. The repo is canonical and the Claude Project
is the mirror. If they disagree, this file wins.

An entry here means the reasoning is settled. Reopen one only with a new fact,
not with a fresh opinion. Entries explicitly marked contested are not settled
and are flagged as such.

---

## Node 18 is dropped, `engines.node` moves to `>=20`

**Status:** decided, not yet merged. The change is one commit, `da584f4`, on
branch `fix/release-pipeline`, one ahead of master.

**Reasoning.** Every CI run since the React UI landed on 2026-07-29 has failed,
and the Node 18 legs are the reason. This was reproduced locally on a real Node
18.20.8. The static evidence stands on its own: `vite` 8.1.5 and `rolldown`
1.1.5 both declare `engines: {"node":"^20.19.0 || >=22.12.0"}`, and rolldown's
distributed build does `import { formatWithOptions, styleText } from "node:util"`,
where `styleText` does not exist before Node 20. Vite 8 builds through rolldown,
so the UI build is impossible on 18 no matter what the manifest says.

The framing matters and should not be lost. `engines.node: ">=18"` was a promise
the dependency tree does not support. Moving to `>=20` is a **correctness fix to
the manifest**, not a reduction of the support matrix to make a red build go
green. The support was never there; the manifest was simply wrong about it.
Users pinned to Node 18 currently get a silent failure later. After the change
they get an honest engines warning at install time.

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
