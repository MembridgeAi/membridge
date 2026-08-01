# Measured Savings: ground truth, deterministic estimates, and a real control group

**Date:** 2026-07-31
**Status:** Approved design (Andrew, from mock `analytics-mockup.html`)
**Applies to:** `lib/` (ledger, recall, token estimation, server) and the React/TS dashboard in `ui/`
**Builds on:** `lib/server.js` `savingsPayload`, `lib/recall.js` `holdoutBucket`, `lib/token-estimate.js`, `lib/usage-normalize.js`, `lib/adapters/claude-code.js`, `lib/api-insights.js`, `ui/src/features/insights/`

## Problem

MemBridge's central value claim is that it reduces token spend, and today the product cannot substantiate it.

The savings ledger is well engineered as bookkeeping. Idempotency, dedupe, monotonicity, bounded state and the wire whitelist are real and heavily tested against hand-derived fixtures. What it reports is another matter:

1. **Every token figure is an estimate.** `avoided.tokens`, `billed.tokens` and `holdout.callTokens` all derive from `chars / 4` (`lib/token-estimate.js`) and `lines x 12` (`lib/recall.js:118`). No tokenizer is ever consulted. `lib/recall.js:137` documents an unfixed upward bias where one side of the comparison counts bytes and the other counts characters.
2. **The counterfactual cannot be closed by better arithmetic.** `lib/ledger-fold-recall-settle.js:23` records that against 57,941 real re-reads a 5 minute settlement window missed roughly 34% of follow-ups, that 60 minutes still leaves roughly 10% permanently overstated, and that no fixed window both settles promptly and waits long enough.
3. **Nothing is surfaced.** `/api/savings` exists and computes all of the above. No UI consumer reads it.
4. **There is no sufficiency gate.** A day one install returns `avoided.tokens: 0`, indistinguishable from a measured zero. The pattern to copy already exists at `lib/diagnostics.js:47` (`MIN_HOLDOUT_SKIPS`), whose own comment explains the reasoning: "reporting a number here would look precise while being noise."
5. **`assists.total` is not a coherent quantity.** `lib/api-insights.js:78` sums two cumulative counters with `mcpQueries`, which reads a per tool last used map and therefore saturates at 6. The total is dropped. `byKind` is kept, because the per kind counts are each coherent on their own; it is only their sum that is not.
6. **Insights is team only.** A solo user, which is every user on day one, sees no measurement surface at all.
7. **Two integrity leftovers.** USD is computed by `lib/pricing.js` and written to every user's disk (`lib/ledger-fold.js:269`) from a rate table the file itself flags as going stale, while the comment at `lib/server.js:471` claims no dollar figure is ever computed. The persisted figure stays. It is the only thing that lets a user-supplied-rate feature work later without re-folding every user's history, which is a cost that would not be recoverable once the history is written without it. The comment is the part that is wrong, so the comment is the part that changes. The persisted figure must still never be served. And `test/ledger-equivalence.js`, the oracle comparison `lib/ledger.js:2` names as authoritative, is referenced by neither CI workflow and has never run. Adding a workflow line does not make it run: it reads `MEMBRIDGE_REF` and skips outright when that is unset, and the token-spend-analysis corpus it points at is not in the repo.

## The model

Three tiers, plus a consolidation. Each tier stands alone and ships independently.

### Tier 1: ground truth

MemBridge already ingests real vendor reported token counts. `lib/adapters/claude-code.js:97` emits `kind:'usage'` events carrying `message.usage` verbatim, and `lib/usage-normalize.js` normalizes them across Anthropic, OpenAI and Google with correct cache subset handling.

Surface those directly: input, output and cache tokens per session, per project, per day. No estimation appears anywhere in this tier. This is the spine the rest of the page is positioned against.

### Tier 2: deterministic tokenization

Replace `chars / 4` inside `lib/token-estimate.js`, which is by design the single estimation point in the codebase, with a real BPE tokenizer loaded from a local vocabulary file. This removes the documented bytes versus characters bias and stops the estimate drifting on multibyte source.

It remains an approximation of Claude's tokenizer. Exact counts require Anthropic's count-tokens endpoint, which needs a key and a network call, and is therefore out of the question. The gain is determinism and a far smaller error, not exactness, and the UI must not imply otherwise.

**The tokenizer does not reach everywhere, and the word "measured" must not imply that it does.** `chars / 4` still drives auto-pause and rejection learning, which run on the recall hot path and on the sync pass and are decisions rather than reported figures. They are unchanged by this tier and they remain estimates. Only the numbers this spec marks as measured are measured; a reader who sees "measured" on the page must not conclude that every internal quantity behind recall's behavior was upgraded with it.

### Tier 3: the measurement

**Session level ASSIGNMENT.** `holdoutBucket` currently hashes `sessionId + relPath` (`lib/recall.js:77`), assigning the holdout per read. A session can therefore be partly served and partly withheld, which leaves no clean cohort to compare. Change the hash input to `sessionId` alone so a session is wholly in or wholly out. Rate stays at 3%, roughly one session in thirty.

**Assignment and measurement are two different choices and must not be conflated.** Assignment is per session, as above, because that is what gives a clean cohort with no within-session contamination. The unit the comparison is computed over is the eligible read, which is a separate decision made below. A future implementer who reads "per eligible read" and moves the hash back to per read has broken the cohort; a future implementer who reads "per session assignment" and computes the effect per session has thrown away most of the power. Both parts are required.

**Scope of the withholding is recall serves only.** Teammate note injection is never withheld. Withholding a note withholds information rather than tokens, which is a materially different act, and the number this measures is about avoided file reads, which is also what the Tier 2 estimate models. Keeping both sides of the comparison scoped identically is what makes them comparable.

**Local comparison, per eligible read.** The unit of comparison is the eligible read, not the session. Session size varies by far more than the effect does, so a comparison over a 1 in 30 sample of sessions is dominated by which sessions happened to land in the holdout rather than by anything MemBridge did. Both arms already record what is needed: `avoided.serves` on the served side, `holdout.skips` and `holdout.callTokens` on the withheld side.

Each machine accumulates, per project and period, four values: served token sum, served eligible read count (`avoided.serves`), withheld token sum (`holdout.callTokens`), withheld eligible read count (`holdout.skips`). The reported effect is the difference of the two per read means with a confidence interval. Pooled means compose correctly from sums and counts, which is why only these four values are ever needed.

This is not new bookkeeping. It is the bookkeeping both arms already keep, read at the unit it was recorded at. It controls for session size rather than being at its mercy, and it reaches a usable sample months sooner than a per session comparison would.

**Sufficiency gate, two thresholds.** Two counts are gated, not one: a minimum SERVED count and a minimum WITHHELD count, both of which must be crossed before any effect figure is rendered. One threshold is not enough, because the two arms fill at very different rates. The served arm reaches any threshold quickly and says nothing on its own about whether the withheld arm carries enough reads to separate a difference from noise. Below either threshold the UI states how many eligible reads have been collected on each side and projects a date. The projection is computed from the observed rate and projects **timing only**. It never projects a result.

**Pooling is a fleet figure, not a per install one.** The controlled comparison is computed across installs through the pooled diagnostics path in `lib/diagnostics.js`, which already exists for exactly this reason: its own header records that pooling "is the whole reason the holdout exists at all; a single install never sees enough held-out reads to prove causation on its own."

At 3% per session a single install accrues roughly one withheld session a fortnight. A per install "measured" number built on that is worse than the estimator it replaces, because the word "measured" carries an authority the sample has not earned. So the effect figure is a fleet figure and is presented as one.

The per install dashboard, and the team dashboard, show **counted quantities only**, behind the sufficiency gate: observed spend, serves, skips, and the two arm counts. No effect figure is computed or displayed from one install's own sample. Counted quantities per project per period still pool across a team through the existing end to end encrypted channel, the same one that already carries summaries, where the relay only ever moves ciphertext. Nothing here is ever sent to the counters Worker in `lib/counters.js`. No per session row, path, filename or prompt is included in any of it. Team totals are aggregated **by project only**; no per person savings figure is computed, stored or displayed.

### Consolidation: Insights becomes the one measurement surface

`ROUTES.insights` moves out from under `/team/` and the screen works in solo mode. Savings lives inside it rather than as a second page, because two screens both answering "is this working" is incoherent. In the same pass, `assists.total` is dropped and `byKind` is kept, since a saturating counter cannot be summed with unbounded ones. This is not an either/or: the total goes, the per kind breakdown stays.

## Presentation rules (locked)

- **Measured and estimated never share a row, a color, or a sentence.** Observed counts and the controlled comparison carry a "Measured" marker; the modelled avoidance carries an "Estimate" marker and its own visual container. Any single panel, screenshotted alone, must still be honest.
- **The controlled comparison is the headline, and it is labeled as a fleet figure.** The modelled figure is secondary and explicitly described as a guess about something that did not happen, including the fact that it can move down. A per install or per team surface shows counted quantities only and never derives an effect from its own sample.
- **No dollar figure is ever served.** This is a rule about the wire, not about the disk. USD continues to be computed and persisted, deliberately, so that a user-supplied-rate feature can work later without re-folding history. It must never reach a payload, a response, or a screen. The comment at `lib/server.js:471` currently claims no dollar figure is ever computed, which is false; the comment is corrected, the code is not.
- **Comparison charts use emphasis, not categorical color.** Served is the accent hue, withheld is the de-emphasis gray, and both bars are directly labeled so identity never rests on color alone.
- **The holdout control is described by what actually happens, which is narrower than it sounds.** A withheld session still receives the injected `CLAUDE.md` block and still has MCP. What is withheld is the recall serve, and nothing else. Copy that says a session runs "without MemBridge" or "without MemBridge memory" is wrong and must not appear anywhere. It is on by default, with first run copy that says a session occasionally runs with recall serves withheld, that the injected context and MCP are untouched, that nothing is hidden from the agent and nothing breaks, and that the only cost is a few extra tokens in that session.

## Contested and on hold

- **`lib/counters.js` opt-out to opt-in is CONTESTED and ON HOLD.** It is not a locked decision and must not be implemented until the owner rules.
  - *The original position:* `lib/counters.js` converts from opt-out to opt-in with a first run prompt, following the existing consent pattern in `lib/consent.js`. Telemetry that a user did not agree to is telemetry that should not be sent, and the consent pattern to copy already exists in the tree.
  - *Marco's counter:* opt-in keeps only 10 to 30 percent of installs. Counters exist to catch install classes that are silently broken, which is a job that needs breadth, and a 10 to 30 percent sample selected by who clicks yes is not breadth. His proposal is to keep the current default and add a first run notice plus a Settings toggle that reflects the real state.
  - Both positions are recorded here without one being picked. Implementation is on hold pending the owner's decision.

## What does NOT change

- The ledger's write path, fold logic, dedupe, TTL and eviction behavior. Tier 3 reads the existing ledger and the existing usage events; it does not restructure them.
- `lib/counters.js` payload contents and its deliberate separation from the Supabase customer backend. Its consent model is contested and on hold, per the section above.
- Team sync transport, encryption, or key handling. Tier 3 adds a payload to an existing encrypted channel.
- USD computation and persistence in `lib/pricing.js` and `lib/ledger-fold.js:269`. Only the false comment at `lib/server.js:471` changes.
- `chars / 4` as the input to auto-pause and rejection learning.
- The 3% rate.

## Error handling

- Missing or malformed `usage` on a transcript record: that record contributes nothing and is skipped. A session with no usage data at all is excluded from both cohorts rather than counted as zero.
- **A session is bucketed to a project only when all of its usage events share one `cwd`.** A session can span projects, and one that does is excluded from every per project total rather than assigned to whichever `cwd` happened to appear first. Attributing a mixed session to a single project produces a contaminated per project figure, which is the same class of error this work exists to fix, and it would be invisible once written.
- Tokenizer vocabulary missing or failing to load: fall back to the existing `chars / 4` and mark the estimate as degraded in the payload. Never throw into the recall hot path or the sync pass.
- Either sufficiency threshold unmet, served or withheld: the payload reports both counts and a null effect. The UI renders the measuring state. A null effect is never rendered as zero.
- Team pull unavailable: team totals fall back to this machine's own figures, labeled as such. Never silently present local numbers as team numbers.
- A project with holdout disabled contributes to Tier 1 spend but is excluded from the comparison, and the UI says how many machines the measurement covers.

## Testing

Daemon, via `test/run-tests.js`:

- Usage extraction: Anthropic, OpenAI and Google shapes each normalize correctly, with the cache subset rules already covered by `usage-normalize` tests asserted end to end into the new payload.
- `holdoutBucket` assigns on `sessionId` alone: the same session with different paths always lands on the same side. Assert the old two argument behavior is gone.
- Holdout scope: a teammate note injection is never withheld, even in a withheld session, and the injected `CLAUDE.md` block and MCP are unaffected in a withheld session.
- Project bucketing: a session whose usage events carry two different `cwd` values is excluded from every per project total rather than attributed to one.
- Comparison math: pooled mean from sums and counts equals the mean computed from raw per eligible read values on a fixture.
- Sufficiency gate: below either threshold, served or withheld, the payload carries a null effect and both counts, never a zero. Assert each threshold independently, including the case where the served count is far past its threshold and the withheld count is not. At both boundaries it carries a figure.
- Tokenizer swap: `estimateTokens` output changes deterministically for a fixture including multibyte source, and the vocabulary-missing path falls back without throwing.
- Pooled payload contains exactly the four aggregate values per project per period, and contains no path, filename, session id, prompt, or per person field. Assert by exact key set, as `test/run-tests.js:7610` already does for `/api/savings`.
- The existing "must never serve a dollar figure" assertions still pass. USD is still written to the ledger on disk; assert that it is present there and absent from every served payload.
- Commit a small fixture slice of the token-spend-analysis corpus so `test/ledger-equivalence.js` can stand alone, then wire it into CI. A workflow line by itself does not make it run, because it skips when `MEMBRIDGE_REF` is unset.

UI, via vitest and Testing Library:

- Insights renders in solo mode and is reachable outside `/team/`.
- Measuring state renders both counts and the projection and renders no effect figure. Assert the absence of a percentage.
- The per install surface renders counted quantities only. Assert that no effect figure is derived from one install's own sample, and that any effect figure shown is labeled as a fleet figure.
- Measured and estimated panels carry distinct markers, and the estimate panel states it can decrease.
- No copy anywhere says a session runs without MemBridge or without MemBridge memory. Assert against the holdout first run copy specifically.
- No per person savings figure appears anywhere on the surface. Assert absence against a fixture with ten members.
- Team unavailable renders local figures explicitly labeled as local.
