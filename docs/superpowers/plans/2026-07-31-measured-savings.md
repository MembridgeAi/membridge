# Measured Savings, Tiers 1 to 3 plus Insights consolidation. Implementation Plan

> **For agentic workers:** single implementer per task, with **TWO review points**: one after Task 4 (the holdout change, which alters product behavior) and one whole-branch review at the end. Use `superpowers:executing-plans` (single agent, TDD). Steps use checkbox (`- [ ]`) syntax.
>
> **This plan is larger than the two UI plans that preceded it and it changes runtime behavior.** Tasks 1 through 3 are additive and safe. Task 4 changes how the recall holdout is assigned, which means roughly one session in thirty runs without MemBridge memory. Do not batch Task 4 with anything else.

**Goal:** Replace an unsubstantiated estimate with a measured, locally computed comparison, surfaced in a consolidated Insights screen that never mixes measured and estimated figures, per [the spec](../specs/2026-07-31-measured-savings-design.md).

**Architecture:** Tier 1 reads the `usage` events already ingested by the adapters and serves them as measured spend. Tier 2 swaps the single estimation point in `lib/token-estimate.js` for a real BPE tokenizer. Tier 3 changes holdout assignment to session level, accumulates four aggregate values per project per period, gates the effect figure behind a sufficiency threshold, and pushes those aggregates through the existing E2E team channel. Insights moves out of `/team/` and absorbs the savings surface.

**Tech stack:** Daemon is plain Node, harness `test/run-tests.js` (`node test/run-tests.js`). UI is React 19 with TS, wouter and react-query under `ui/` (`cd ui && npm test`). **First: run BOTH suites on a fresh branch and record the real baselines. Do not assume any number.**

**Conventions:** commit `<type>: <description>`, no footer. TDD: failing test first, run it, watch it fail, then implement. Route paths from `ui/src/app/routes.ts`. Styles use `styles/tokens.css` variables, no hardcoded hex. **No em dashes in any prose, code comment, or UI copy.**

**Locked (do not relitigate):** measured and estimated never share a row, color or sentence; holdout is session level, hashed on `sessionId` alone, 3%; holdout withholds recall serves only and never teammate notes; on by default with first run copy; team aggregation is four values per project per period through the E2E channel, never the counters Worker; no per person savings figure anywhere; no dollar figure served, and none written to disk; no effect figure before the sufficiency threshold; the projection projects timing only, never a result.

---

## Task 0: branch baselines
- [ ] Branch from current master. Run `node test/run-tests.js` and `cd ui && npm test`; record both real baselines in the branch's first commit message.

## Task 1: measured spend payload (Tier 1)
**Files:** `lib/server.js`, `lib/scan.js` or wherever usage events are accumulated, `test/run-tests.js`.
- [ ] **Failing tests:** a new payload reports input, output and cache tokens per project and per day, sourced from `kind:'usage'` events; Anthropic, OpenAI and Google fixtures each normalize correctly through `lib/usage-normalize.js` into the payload (assert the cache subset rules hold end to end, since OpenAI and Google nest cached tokens inside input and Anthropic does not); a record with missing or malformed usage contributes nothing and does not throw; a session with no usage data at all is absent rather than present as zero.
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(server): measured token spend from vendor-reported usage`.

## Task 2: sufficiency gate and payload integrity on /api/savings
**Files:** `lib/server.js`, `test/run-tests.js`.
- [ ] **Failing tests:** the savings payload carries an explicit availability state; below threshold it reports counts with a **null** effect, never a zero (assert null specifically); the exact key set assertion at `test/run-tests.js:7610` is extended, not replaced; the existing "must never serve a dollar figure" assertions still pass; a new assertion that **no USD value is written to the ledger on disk**.
- [ ] Run, expect FAIL.
- [ ] Implement. Follow the `MIN_HOLDOUT_SKIPS` pattern at `lib/diagnostics.js:47`. Remove USD from what `lib/ledger-fold.js:269` persists, and correct the now-accurate comment at `lib/server.js:471`.
- [ ] Run, expect green plus full suite. Commit: `feat(server): sufficiency gate, stop persisting USD`.

## Task 3: deterministic tokenizer (Tier 2)
**Files:** `lib/token-estimate.js`, vocabulary asset, `package.json`, `test/run-tests.js`.
- [ ] **Failing tests:** `estimateTokens` returns deterministic BPE counts for a fixture including multibyte source; a missing or unloadable vocabulary falls back to `chars / 4` and marks the estimate degraded rather than throwing; the require-cache test that pins `token-estimate.js` as free of the tree-sitter dependency still passes (this module is on the PreToolUse recall hot path, so load cost matters).
- [ ] Run, expect FAIL. Implement, loading the vocabulary lazily. Run, expect green plus full suite.
- [ ] Commit: `feat(tokens): deterministic BPE tokenization with a safe fallback`.

## Task 4: session level holdout (behavior change, review point)
**Files:** `lib/recall.js`, `lib/hooks-recall.js`, `test/run-tests.js`.
- [ ] **Failing tests:** `holdoutBucket` takes `sessionId` only; the same session with three different paths lands on the same side every time (assert identical outcomes); the rate remains 3%; **a teammate note is never withheld, even inside a withheld session** (assert the note still injects); the old two argument signature is gone (assert its absence rather than leaving it as dead surface).
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(recall): assign the holdout per session so cohorts are comparable`.
- [ ] **STOP. Review point.** This changes what users experience. Confirm with a human that roughly one session in thirty running without memory is understood and accepted before continuing.

## Task 5: local comparison and aggregates (Tier 3, local half)
**Files:** `lib/ledger-fold*.js` or a new module, `lib/server.js`, `test/run-tests.js`.
- [ ] **Failing tests:** four values accumulate per project per period (served token sum, served session count, withheld token sum, withheld session count); the pooled mean computed from sums and counts equals the mean computed from raw per session values on a fixture (this is the property that makes aggregates sufficient, so assert it directly); the effect is the difference of means with a confidence interval; below the sufficiency threshold the effect is null; a project with holdout disabled contributes to spend but is excluded from the comparison.
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(ledger): served versus withheld comparison from measured tokens`.

## Task 6: team pooling through the E2E channel (Tier 3, team half)
**Files:** `lib/teamsync.js`, `test/run-tests.js`.
- [ ] **Failing tests:** the pushed payload contains **exactly** the four aggregate values per project per period, asserted by exact key set; it contains no path, filename, session id, prompt, author name or per person field (assert absence explicitly for each); it goes through the existing encrypted push path, **not** `lib/counters.js` (assert the counters module is not called); pulling with the team unavailable yields local-only figures flagged as local.
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(teamsync): pooled savings aggregates over the encrypted channel`.

## Task 7: Insights leaves /team/ and absorbs savings
**Files:** `ui/src/app/routes.ts`, `App.tsx`, `ui/src/features/insights/*`, `ui/src/data/*`, tests alongside.
- [ ] **Failing tests:** Insights renders in solo mode and resolves outside `/team/`; `assists.total` no longer sums `mcpQueries` with the unbounded counters (either dropped or no longer presented as a total, assert whichever is implemented); measured and estimated panels carry distinct markers; the measuring state renders counts and a projection and renders **no percentage** (assert absence); the estimate panel states that it can decrease; **no per person savings figure appears anywhere**, asserted against a ten member fixture; team unavailable renders local figures labeled local.
- [ ] Run, expect FAIL. Implement to the mock `analytics-mockup.html`: KPI row, spend trend, emphasis comparison chart with both bars directly labeled, walled-off estimate panel, method section.
- [ ] Run, expect green plus both suites. Commit: `feat(ui): Insights works solo and carries measured savings`.

## Task 8: holdout consent and counters opt-in
**Files:** `lib/consent.js` or a sibling, `lib/counters.js`, `ui/src/features/settings/*`, tests.
- [ ] **Failing tests:** the holdout control defaults on and its stored state round trips; turning it off stops withholding entirely (assert no withheld sessions accumulate); `lib/counters.js` sends nothing until consent is explicitly granted (assert the default state sends nothing even with a baked URL present, which is the actual behavior change); the first run prompt appears once and its decision persists.
- [ ] Run, expect FAIL. Implement, following the existing distillation consent pattern in `lib/consent.js`. UI copy per the mock, no em dashes.
- [ ] Run, expect green plus both suites. Commit: `feat(consent): holdout control on by default, counters opt-in`.

## Final review (one pass)
- [ ] Whole-branch review against the spec: measured and estimated never mixed; holdout session level and scoped to recall serves only; no per person figure; no USD served or persisted; null effect never rendered as zero; projection projects timing only; team payload key set exact; no pre-existing test modified to pass; no em dashes in prose, comments or UI copy.
- [ ] Resolve the oracle: wire `test/ledger-equivalence.js` into a CI workflow, or delete the authoritative-reference claim at `lib/ledger.js:2`. Do not leave it as it is.
- [ ] Human pass with the real daemon: confirm a fresh install shows the measuring state and not a zero; confirm the spend figures match what the transcripts report; toggle the holdout off and confirm withholding stops; confirm Insights loads solo.

## Self-review
- Spec Tier 1 maps to Task 1. Tier 2 to Task 3. Tier 3 to Tasks 4, 5 and 6. Consolidation to Task 7. Presentation rules to Task 7. Consent rules to Task 8. Integrity leftovers to Task 2 and the final review.
- Out of scope and untouched: the session detail page and the projects tab, both of which have their own specs and land first; the stale `live` defect.
- Delegated and flagged: the choice of BPE vocabulary in Task 3, and whether `assists.total` is dropped or merely re-presented in Task 7. The assertions above hold either way.
