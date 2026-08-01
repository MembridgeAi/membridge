# Measured Savings, Tiers 1 to 3 plus Insights consolidation. Implementation Plan

> **For agentic workers:** single implementer per task, with **TWO review points**: one after Task 4 (the holdout change, which alters product behavior) and one whole-branch review at the end. Use `superpowers:executing-plans` (single agent, TDD). Steps use checkbox (`- [ ]`) syntax.
>
> **This plan is larger than the two UI plans that preceded it and it changes runtime behavior.** Tasks 1 through 3 are additive and safe. Task 4 changes how the recall holdout is assigned, which means roughly one session in thirty has its recall serves withheld. That session still gets the injected `CLAUDE.md` block and still has MCP. Do not describe it as running without MemBridge or without MemBridge memory, because it does neither. Do not batch Task 4 with anything else.

**Goal:** Replace an unsubstantiated estimate with a measured, locally computed comparison, surfaced in a consolidated Insights screen that never mixes measured and estimated figures, per [the spec](../specs/2026-07-31-measured-savings-design.md).

**Architecture:** Tier 1 reads the `usage` events already ingested by the adapters and serves them as measured spend. Tier 2 swaps the single estimation point in `lib/token-estimate.js` for a real BPE tokenizer. Tier 3 changes holdout assignment to session level, accumulates four aggregate values per project per period, gates the effect figure behind a sufficiency threshold, and pushes those aggregates through the existing E2E team channel. Insights moves out of `/team/` and absorbs the savings surface.

**Tech stack:** Daemon is plain Node, harness `test/run-tests.js` (`node test/run-tests.js`). UI is React 19 with TS, wouter and react-query under `ui/` (`cd ui && npm test`). **First: run BOTH suites on a fresh branch and record the real baselines. Do not assume any number.**

**Conventions:** commit `<type>: <description>`, no footer. TDD: failing test first, run it, watch it fail, then implement. Route paths from `ui/src/app/routes.ts`. Styles use `styles/tokens.css` variables, no hardcoded hex. **No em dashes in any prose, code comment, or UI copy.**

**Locked (do not relitigate):** measured and estimated never share a row, color or sentence; holdout ASSIGNMENT is per session, hashed on `sessionId` alone, 3%; the comparison is computed per ELIGIBLE READ, which is a separate choice from assignment and must not be collapsed into it; holdout withholds recall serves only, never teammate notes, never the injected `CLAUDE.md` block and never MCP; on by default with first run copy; the effect figure is a FLEET figure through the pooled diagnostics path, and per install and per team surfaces show counted quantities only; aggregation is four values per project per period, never through the counters Worker; no per person savings figure anywhere; no dollar figure served, while USD continues to be persisted on purpose; TWO sufficiency thresholds, a minimum served count and a minimum withheld count, and no effect figure before both are crossed; the projection projects timing only, never a result.

**Contested and on hold, do NOT implement:** the `lib/counters.js` opt-out to opt-in conversion. See the spec's "Contested and on hold" section and the note on Task 8.

---

## Task 0: branch baselines
- [ ] Branch from current master. Run `node test/run-tests.js` and `cd ui && npm test`; record both real baselines in the branch's first commit message.

## Task 1: measured spend payload (Tier 1)
**Files:** `lib/server.js`, `lib/scan.js` or wherever usage events are accumulated, `test/run-tests.js`.
- [ ] **Failing tests:** a new payload reports input, output and cache tokens per project and per day, sourced from `kind:'usage'` events; Anthropic, OpenAI and Google fixtures each normalize correctly through `lib/usage-normalize.js` into the payload (assert the cache subset rules hold end to end, since OpenAI and Google nest cached tokens inside input and Anthropic does not); a record with missing or malformed usage contributes nothing and does not throw; a session with no usage data at all is absent rather than present as zero; **a session is bucketed to a project only when all of its usage events share one `cwd`**, and a session whose events carry two different `cwd` values is excluded from every per project total rather than attributed to the first one seen (assert the two-`cwd` fixture contributes to no project).
- [ ] A session can span projects. Attributing a mixed session to one of them contaminates that project's totals, which is the same class of error this work exists to fix and is invisible once written.
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(server): measured token spend from vendor-reported usage`.

## Task 2: sufficiency gate and payload integrity on /api/savings
**Files:** `lib/server.js`, `test/run-tests.js`.
- [ ] **Failing tests:** the savings payload carries an explicit availability state; there are **TWO** thresholds, a minimum served count and a minimum withheld count, and the effect is **null** until both are crossed (assert null specifically, and assert each threshold independently, including the case where served is far past its threshold and withheld is not); below either threshold the payload reports **both** counts, never a zero; the exact key set assertion at `test/run-tests.js:7610` is extended, not replaced; the existing "must never serve a dollar figure" assertions still pass; a new assertion that USD **is** present in the ledger on disk and **absent** from every served payload.
- [ ] One threshold is not enough. The two arms fill at very different rates, so a served count clearing its bar says nothing about whether the withheld arm carries enough reads to separate a difference from noise.
- [ ] Run, expect FAIL.
- [ ] Implement. Follow the `MIN_HOLDOUT_SKIPS` pattern at `lib/diagnostics.js:47`, with two constants rather than one. **Keep the persisted USD at `lib/ledger-fold.js:269`.** Amend the comment at `lib/server.js:471`, which currently claims no dollar figure is ever computed: the rule is that none is ever *served*, and the persisted figure is deliberate, because it is the only thing that lets a user-supplied-rate feature work later without re-folding every user's history.
- [ ] **REVERT REQUIRED before this task can pass.** An earlier commit implemented a now-reversed instruction and stopped persisting USD. That code change must be reverted. Whoever picks up this task does the revert; it was deliberately left in place rather than reverted alongside this plan edit.
- [ ] Run, expect green plus full suite. Commit: `feat(server): two-threshold sufficiency gate, correct the USD comment`.

## Task 3: deterministic tokenizer (Tier 2)
**Files:** `lib/token-estimate.js`, vocabulary asset, `package.json`, `test/run-tests.js`.
- [ ] **Failing tests:** `estimateTokens` returns deterministic BPE counts for a fixture including multibyte source; a missing or unloadable vocabulary falls back to `chars / 4` and marks the estimate degraded rather than throwing; the require-cache test that pins `token-estimate.js` as free of the tree-sitter dependency still passes (this module is on the PreToolUse recall hot path, so load cost matters).
- [ ] Run, expect FAIL. Implement, loading the vocabulary lazily. Run, expect green plus full suite.
- [ ] `chars / 4` still drives auto-pause and rejection learning, and stays that way. The tokenizer does not reach everywhere, and no UI copy may let "measured" imply that it does.
- [ ] Commit: `feat(tokens): deterministic BPE tokenization with a safe fallback`.

## Task 4: session level holdout ASSIGNMENT (behavior change, review point)
**Files:** `lib/recall.js`, `lib/hooks-recall.js`, `test/run-tests.js`.

This task changes ASSIGNMENT only. The unit the comparison is computed over is the eligible read, and that lives in Task 5. Do not let one change follow from the other: per session assignment is what gives a clean cohort, per eligible read measurement is what gives it power, and they are independent.

- [ ] **Failing tests:** `holdoutBucket` takes `sessionId` only; the same session with three different paths lands on the same side every time (assert identical outcomes); the rate remains 3%; **a teammate note is never withheld, even inside a withheld session** (assert the note still injects); **the injected `CLAUDE.md` block and MCP are unaffected in a withheld session** (assert both); the old two argument signature is gone (assert its absence rather than leaving it as dead surface).
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(recall): assign the holdout per session so cohorts are comparable`.
- [ ] **STOP. Review point.** This changes what users experience. Confirm with a human that roughly one session in thirty having its **recall serves withheld** is understood and accepted before continuing. State it that way and not as "running without memory": the withheld session keeps the injected `CLAUDE.md` block and keeps MCP, so what is isolated is the recall layer, not MemBridge.

## Task 5: local comparison and aggregates, per eligible read (Tier 3, local half)
**Files:** `lib/ledger-fold*.js` or a new module, `lib/server.js`, `test/run-tests.js`.

The unit is the **eligible read**, not the session. Session size varies by far more than the effect does, so a comparison over a 1 in 30 sample of sessions is dominated by which sessions landed in the holdout rather than by anything MemBridge did. Both arms already record what is needed, so this is no new bookkeeping: it controls for session size and reaches a usable sample months sooner.

- [ ] **Failing tests:** four values accumulate per project per period, all per eligible read (served token sum, served eligible read count from `avoided.serves`, withheld token sum from `holdout.callTokens`, withheld eligible read count from `holdout.skips`); the pooled mean computed from sums and counts equals the mean computed from raw **per eligible read** values on a fixture (this is the property that makes aggregates sufficient, so assert it directly); the effect is the difference of per read means with a confidence interval; below **either** sufficiency threshold the effect is null; a project with holdout disabled contributes to spend but is excluded from the comparison.
- [ ] Assert explicitly that no per session accumulation remains. A fixture of two sessions with wildly different read counts must produce the same per read means as a fixture of many equal ones carrying the same totals.
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(ledger): served versus withheld comparison per eligible read`.

## Task 6: fleet pooling of the comparison (Tier 3, pooled half)
**Files:** `lib/diagnostics.js`, `lib/teamsync.js`, `test/run-tests.js`.

**The comparison is a FLEET figure, not a per install one.** At 3% per session a single install accrues roughly one withheld session a fortnight. A per install "measured" number built on that is worse than the estimator it replaces, because "measured" carries an authority the sample has not earned. Ship the comparison through the pooled diagnostics path, which exists for exactly this reason: `lib/diagnostics.js`'s own header records that pooling is why the holdout exists at all, since one install never sees enough held-out reads to prove causation.

- [ ] **Failing tests:** the pooled payload contains **exactly** the four aggregate values per project per period, asserted by exact key set; it contains no path, filename, session id, prompt, author name or per person field (assert absence explicitly for each); it goes through the diagnostics path, **not** `lib/counters.js` (assert the counters module is not called); counted quantities per project still pool across a team over the existing encrypted push path; pulling with the team unavailable yields local-only figures flagged as local.
- [ ] Assert that **no effect figure is computed from a single install's own sample** anywhere in the local payload. The local payload carries counted quantities and the two arm counts, and nothing derived from them.
- [ ] Run, expect FAIL. Implement. Run, expect green plus full suite.
- [ ] Commit: `feat(diagnostics): pool the served versus withheld comparison across the fleet`.

## Task 7: Insights leaves /team/ and absorbs savings
**Files:** `ui/src/app/routes.ts`, `App.tsx`, `ui/src/features/insights/*`, `ui/src/data/*`, tests alongside.
- [ ] **Failing tests:** Insights renders in solo mode and resolves outside `/team/`; **`assists.total` is dropped and `byKind` is kept** (assert the total is absent and the per kind breakdown is present, not one or the other); measured and estimated panels carry distinct markers; the measuring state renders **both** counts and a projection and renders **no percentage** (assert absence); the estimate panel states that it can decrease; **the per install and per team surfaces render counted quantities only**, with no effect figure derived from this install's own sample, and any effect figure shown is labeled a fleet figure (assert both); **no per person savings figure appears anywhere**, asserted against a ten member fixture; team unavailable renders local figures labeled local; **no copy says a session runs without MemBridge or without MemBridge memory** (assert against the holdout copy specifically).
- [ ] Run, expect FAIL. Implement to the mock `analytics-mockup.html`: KPI row, spend trend, emphasis comparison chart with both bars directly labeled, walled-off estimate panel, method section.
- [ ] Run, expect green plus both suites. Commit: `feat(ui): Insights works solo and carries measured savings`.

## Task 8: holdout consent (counters opt-in is ON HOLD)
**Files:** `lib/consent.js` or a sibling, `ui/src/features/settings/*`, tests.

> **Do NOT implement the `lib/counters.js` opt-out to opt-in conversion in this task.** That decision is CONTESTED and on hold pending the owner's ruling. The original position and Marco's counter are both recorded in the spec's "Contested and on hold" section: in short, opt-in keeps only 10 to 30 percent of installs, and counters exist to catch silently-broken install classes, which needs breadth. His proposal is to keep the default and add a first run notice plus a Settings toggle reflecting real state. Implement the holdout half of this task now; leave the counters half alone until the owner rules, then come back for it.

- [ ] **Failing tests:** the holdout control defaults on and its stored state round trips; turning it off stops withholding entirely (assert no withheld sessions accumulate); the first run prompt appears once and its decision persists; the first run copy says recall serves are withheld and does **not** say the session runs without MemBridge or without MemBridge memory (assert the wrong phrasing is absent).
- [ ] Run, expect FAIL. Implement, following the existing distillation consent pattern in `lib/consent.js`. UI copy per the mock, no em dashes.
- [ ] Run, expect green plus both suites. Commit: `feat(consent): holdout control on by default`.

## Final review (one pass)
- [ ] Whole-branch review against the spec: measured and estimated never mixed; holdout ASSIGNMENT per session and the comparison computed per ELIGIBLE READ, with neither collapsed into the other; withholding scoped to recall serves only, with the injected `CLAUDE.md` block and MCP untouched; no per person figure; no USD served, USD still persisted on purpose and the comment at `lib/server.js:471` corrected; both sufficiency thresholds present; null effect never rendered as zero; the effect presented as a fleet figure and never derived from one install's sample; projection projects timing only; pooled payload key set exact; sessions spanning two `cwd` values excluded from per project totals; no pre-existing test modified to pass; no em dashes in prose, comments or UI copy.
- [ ] Grep the branch for "without MemBridge", "without memory" and equivalents in prose, comments and UI copy. Expect zero. A withheld session keeps the injected block and MCP, so that phrasing is factually wrong wherever it appears.
- [ ] Confirm the counters opt-in conversion was NOT implemented, per Task 8's hold.
- [ ] Resolve the oracle: **commit a small fixture slice of the token-spend-analysis corpus** so `test/ledger-equivalence.js` can stand alone, then wire it into CI and confirm it actually runs. A workflow line alone does not do it: the harness reads `MEMBRIDGE_REF`, skips when it is unset, and the corpus it names is not in the repo, so a CI line with no fixture buys a green check on a test that never executed. Assert the run is not a skip. The alternative of deleting the authoritative-reference claim at `lib/ledger.js:2` is closed; the fixture is the decision.
- [ ] Human pass with the real daemon: confirm a fresh install shows the measuring state and not a zero; confirm the spend figures match what the transcripts report; toggle the holdout off and confirm withholding stops; confirm Insights loads solo.

## Self-review
- Spec Tier 1 maps to Task 1. Tier 2 to Task 3. Tier 3 to Tasks 4, 5 and 6. Consolidation to Task 7. Presentation rules to Task 7. Consent rules to Task 8. Integrity leftovers to Task 2 and the final review.
- Out of scope and untouched: the session detail page and the projects tab, both of which have their own specs and land first; the stale `live` defect.
- Delegated and flagged: the choice of BPE vocabulary in Task 3, and which slice of the token-spend-analysis corpus is small enough to commit while still exercising the oracle.
- Blocked on the owner: the `lib/counters.js` consent model, per Task 8.
- Carried debt: Task 2 requires reverting an earlier commit that stopped persisting USD, since that instruction has since been reversed.
