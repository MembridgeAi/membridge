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
5. **`assists.total` is not a coherent quantity.** `lib/api-insights.js:78` sums two cumulative counters with `mcpQueries`, which reads a per tool last used map and therefore saturates at 6.
6. **Insights is team only.** A solo user, which is every user on day one, sees no measurement surface at all.
7. **Two integrity leftovers.** USD is computed by `lib/pricing.js` and written to every user's disk (`lib/ledger-fold.js:269`) from a rate table the file itself flags as going stale, despite the comment at `lib/server.js:471` claiming no dollar figure is ever computed. And `test/ledger-equivalence.js`, the oracle comparison `lib/ledger.js:2` names as authoritative, is referenced by neither CI workflow and has never run.

## The model

Three tiers, plus a consolidation. Each tier stands alone and ships independently.

### Tier 1: ground truth

MemBridge already ingests real vendor reported token counts. `lib/adapters/claude-code.js:97` emits `kind:'usage'` events carrying `message.usage` verbatim, and `lib/usage-normalize.js` normalizes them across Anthropic, OpenAI and Google with correct cache subset handling.

Surface those directly: input, output and cache tokens per session, per project, per day. No estimation appears anywhere in this tier. This is the spine the rest of the page is positioned against.

### Tier 2: deterministic tokenization

Replace `chars / 4` inside `lib/token-estimate.js`, which is by design the single estimation point in the codebase, with a real BPE tokenizer loaded from a local vocabulary file. This removes the documented bytes versus characters bias and stops the estimate drifting on multibyte source.

It remains an approximation of Claude's tokenizer. Exact counts require Anthropic's count-tokens endpoint, which needs a key and a network call, and is therefore out of the question. The gain is determinism and a far smaller error, not exactness, and the UI must not imply otherwise.

### Tier 3: the measurement

**Session level holdout.** `holdoutBucket` currently hashes `sessionId + relPath` (`lib/recall.js:77`), assigning the holdout per read. A session can therefore be partly served and partly withheld, which leaves no clean cohort to compare. Change the hash input to `sessionId` alone so a session is wholly in or wholly out. Rate stays at 3%, roughly one session in thirty.

**Scope of the withholding is recall serves only.** Teammate note injection is never withheld. Withholding a note withholds information rather than tokens, which is a materially different act, and the number this measures is about avoided file reads, which is also what the Tier 2 estimate models. Keeping both sides of the comparison scoped identically is what makes them comparable.

**Local comparison.** Each machine accumulates, per project and period, four values from the Tier 1 usage data: served input token sum, served session count, withheld input token sum, withheld session count. The reported effect is the difference of the two means with a confidence interval. Pooled means compose correctly from sums and counts, which is why only these four values are ever needed.

**Sufficiency gate.** No effect figure is rendered until the withheld session count crosses a threshold sufficient to separate the difference from noise. Below it the UI states how many sessions have been collected and projects a date. The projection is computed from the observed session rate and projects **timing only**. It never projects a result.

**Team pooling.** The four values per project per period are pushed through the existing end to end encrypted team channel, the same one that already carries summaries, where the relay only ever moves ciphertext. They are never sent to the counters Worker in `lib/counters.js`. No per session row, path, filename or prompt is included. Team totals are aggregated **by project only**; no per person savings figure is computed, stored or displayed.

### Consolidation: Insights becomes the one measurement surface

`ROUTES.insights` moves out from under `/team/` and the screen works in solo mode. Savings lives inside it rather than as a second page, because two screens both answering "is this working" is incoherent. In the same pass, `assists.total` either drops `mcpQueries` or stops being presented as a total, since a saturating counter cannot be summed with unbounded ones.

## Presentation rules (locked)

- **Measured and estimated never share a row, a color, or a sentence.** Observed counts and the controlled comparison carry a "Measured" marker; the modelled avoidance carries an "Estimate" marker and its own visual container. Any single panel, screenshotted alone, must still be honest.
- **The controlled comparison is the headline.** The modelled figure is secondary and explicitly described as a guess about something that did not happen, including the fact that it can move down.
- **No dollar figure is ever served.** Additionally, stop writing USD to disk.
- **Comparison charts use emphasis, not categorical color.** Served is the accent hue, withheld is the de-emphasis gray, and both bars are directly labeled so identity never rests on color alone.
- **The holdout control is described by what actually happens.** It is on by default, with first run copy that says a session occasionally runs exactly as it did before MemBridge was installed, that nothing is hidden from the agent and nothing breaks, and that the only cost is a few extra tokens in that session.
- **`lib/counters.js` converts from opt-out to opt-in** with a first run prompt, following the existing consent pattern in `lib/consent.js`.

## What does NOT change

- The ledger's write path, fold logic, dedupe, TTL and eviction behavior. Tier 3 reads the existing ledger and the existing usage events; it does not restructure them.
- `lib/counters.js` payload contents and its deliberate separation from the Supabase customer backend. Only its consent model changes.
- Team sync transport, encryption, or key handling. Tier 3 adds a payload to an existing encrypted channel.
- The 3% rate.

## Error handling

- Missing or malformed `usage` on a transcript record: that record contributes nothing and is skipped. A session with no usage data at all is excluded from both cohorts rather than counted as zero.
- Tokenizer vocabulary missing or failing to load: fall back to the existing `chars / 4` and mark the estimate as degraded in the payload. Never throw into the recall hot path or the sync pass.
- Insufficient withheld sessions: the payload reports the counts and a null effect. The UI renders the measuring state. A null effect is never rendered as zero.
- Team pull unavailable: team totals fall back to this machine's own figures, labeled as such. Never silently present local numbers as team numbers.
- A project with holdout disabled contributes to Tier 1 spend but is excluded from the comparison, and the UI says how many machines the measurement covers.

## Testing

Daemon, via `test/run-tests.js`:

- Usage extraction: Anthropic, OpenAI and Google shapes each normalize correctly, with the cache subset rules already covered by `usage-normalize` tests asserted end to end into the new payload.
- `holdoutBucket` assigns on `sessionId` alone: the same session with different paths always lands on the same side. Assert the old two argument behavior is gone.
- Holdout scope: a teammate note injection is never withheld, even in a withheld session.
- Comparison math: pooled mean from sums and counts equals the mean computed from raw per session values on a fixture.
- Sufficiency gate: below threshold the payload carries a null effect and a count, never a zero. At the boundary it carries a figure.
- Tokenizer swap: `estimateTokens` output changes deterministically for a fixture including multibyte source, and the vocabulary-missing path falls back without throwing.
- Team payload contains exactly the four aggregate values per project per period, and contains no path, filename, session id, prompt, or per person field. Assert by exact key set, as `test/run-tests.js:7610` already does for `/api/savings`.
- The existing "must never serve a dollar figure" assertions still pass, plus a new one that no USD value is written to the ledger on disk.
- Wire `test/ledger-equivalence.js` into CI, or delete the oracle claim at `lib/ledger.js:2`. Do not leave it as it is.

UI, via vitest and Testing Library:

- Insights renders in solo mode and is reachable outside `/team/`.
- Measuring state renders the count and projection and renders no effect figure. Assert the absence of a percentage.
- Measured and estimated panels carry distinct markers, and the estimate panel states it can decrease.
- No per person savings figure appears anywhere on the surface. Assert absence against a fixture with ten members.
- Team unavailable renders local figures explicitly labeled as local.
