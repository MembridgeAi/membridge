# MemBridge token-reduction backend — design

**Date:** 2026-07-28
**Status:** design approved, ready for implementation planning
**Evidence base:** `token-spend-analysis/` — 6,104 Claude Code sessions, 310 developers, 216 repos, 76.3B tokens. See `corpus_summary.md`, `savings_v4.md`, `reconciliation_v4.md`.
**Related:** `MEMO-token-reduction-rework.md` (CEO memo)

---

## 1. Problem

MemBridge distills each AI session into a per-project memory and injects it into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`. That memory is a narrative of *who did what*. The measured waste is elsewhere: agents repeatedly **re-reading the same files**.

Two measurements frame the work.

**The injected block is not free.** It loads before the first request and is billed on every request thereafter. Measured at ~1,400 tokens against a median session of 41 requests (mean 82), it costs **0.9% of all spend**. That buys access to an **18.6% addressable pool**, so the bet is sound — but the tax is uniform while the benefit is not: **40% of sessions are net-negative** on it and **29% have no recoverable waste at all**.

**What is addressable**, across 120,874 read events:

| mechanism | reads | share of all billed volume |
|---|---|---|
| Same-session repeat — session re-reads a file it already read | 24.1% | 3.8% |
| Cross-session repeat — an earlier session read it (memory) | 45.0% | 8.7% |
| First-ever read — nobody has read it (pure compression) | 30.9% | 6.1% |
| **Total** | 100% | **18.6%** |

These are gross ceilings assuming perfect displacement at zero replacement cost. Real net is lower.

## 2. Goal and non-goals

**Goal.** Reduce tokens agents burn re-deriving context, and prove the reduction from each user's own session logs.

**Non-goals.**
- Replacing the activity feed or team sync. Both stay; the feed becomes an *input*.
- Claiming the 26.3% orientation share is recoverable. It is not.
- Any saving figure that depends on a model rather than observation.

## 3. Architecture

```
session JSONL ──(adapter, +2 event kinds)──▶ prompt · edit · read · usage · summary
                                                    │
                                                    ▼
                                            lib/ledger.js
                                     residence-weighted cost ledger
                                                    │
                                ┌───────────────────┴───────────────────┐
                                ▼                                       ▼
                     .membridge/ledger.json                    hot set: paths read
                     (tokens, waste, savings)                  by 2+ sessions
                                │                                       │
                                ▼                                       ▼
                        savings UI                             lib/skeleton.js
                                                                        │
                                                                        ▼
                                                                lib/recall.js
                                                                  ▲         ▲
                                                       PreToolUse hook   MCP recall()
```

### 3.1 Units

| unit | status | responsibility |
|---|---|---|
| `lib/adapters/claude-code.js` | change | emit `usage` (per-request token counts) and `read` (Read/Grep/Glob targets). It already iterates the assistant records carrying both and discards them. |
| `lib/ledger.js` | new | pure function, transcript → residence-weighted ledger. Dedupe on `message.id`; epoch-split on context reset; price with exact cache multipliers. |
| `lib/skeleton.js` | new | `skeletonize(path, content) → text`, behind a pluggable extractor interface. Cached by content hash. |
| `lib/recall.js` | new | the store and the serve/step-aside policy. |
| `lib/hooks.js` | change | PreToolUse on Read/Grep/Glob. |
| `lib/mcp.js` | change | `recall(path)` tool over the same store. |

### 3.2 Store build strategy

Lazy by default; the ledger's hot set (paths read by 2+ sessions) is pre-warmed. Indexing targets exactly what is being wasted on. No repo-wide walk, no file watcher — the watcher is the likeliest source of silent staleness bugs and buys little here.

### 3.3 Store shape

Keyed by repo-relative path, under `.membridge/recall/`:

```
path → { contentHash, skeleton, skeletonTokens, fileTokens,
         readBy: [sessionIds], lastEdit, decisions: [from summaries],
         rejections: n }
```

The skeleton is regenerated whenever `contentHash` changes, so it tracks the working tree and **cannot go stale**.

## 4. The payload

A **structural skeleton**: exports, signatures, imports, types; bodies stripped.

**Extractor** is a pluggable interface with two implementations:

1. `web-tree-sitter` with per-language grammars — the default. Accepted at ~61 MB against the current ~1 MB install, with eyes open (decision recorded in §9).
2. A dependency-free brace/indent depth stripper — the fallback for file types with no grammar, so unknown languages still get something.

**Deferred: diff payloads.** Measurement showed redundant reads split near 50/50 between files unchanged since the previous read (54.4%) and files edited in between (45.6%), so a diff would optimise for under half the opportunity while requiring stored per-session baselines and reintroducing staleness. The skeleton is regenerated fresh and covers both cases. Revisit if the ledger shows material residual waste on changed files.

## 5. Serve policy

### 5.1 Tiers

| tier | trigger | response | default |
|---|---|---|---|
| **A** | same session re-reads a path, file unchanged since it was shown | pointer: "read at turn N, unchanged" | **on** |
| **B** | an earlier, different session read this path | skeleton | **on** |
| **C** | first-ever read of the path | skeleton (pure compression) | **flag-gated off** |

Tier C is built but disabled per project until acceptance data shows it is safe — it is the largest single chunk (6.1pp) and the likeliest to fail the agent, since nobody has seen the file before.

### 5.2 Interception conditions

All must hold, or the read proceeds untouched:

1. Tier A, B, or enabled-C applies.
2. The call would pull **≥400 tokens**, priced from its actual `offset`/`limit` — never from file size. See the note below: this floor was 1,000 in an earlier draft and the data says that was too high.
3. The skeleton achieves **≥2.25× compression** against that specific call (≥55.6% saving).
4. This path has not already been served in this session.
5. Not held out (§7.1).

**Note on the minimum-size floor (needs Marco's confirmation).** Intercepted reads are mostly small: median **835 tokens**, p25 424, p75 1,799. A 1,000-token floor would therefore skip **more than half** of all candidate reads and forfeit a large share of the addressable pool — the opposite of the goal. 400 tokens keeps roughly three-quarters of candidates in scope while still ignoring trivial ones. At the 2.25× compression floor a 400-token read saves ~222 tokens, which is small but positive, and the terminal stays quiet about it because display is gated separately at >1,000 saved.

The trade: a lower floor means more interceptions, so more chances to be rejected, and each rejection costs the skeleton's tokens on top of the full read. Acceptance data should be used to tune this within the first weeks.

### 5.3 Response

Skeleton plus an explicit header: this is a structural summary, the full file is at `<path>`, read it directly for bodies. **The agent must be able to reject us.** Hiding the intervention would be both a correctness hazard and unmeasurable.

### 5.4 Learning from rejection

If the agent reads the file anyway after being served, increment `rejections` and stop intercepting that path for the rest of the session. Persisted across sessions with decay, so files that consistently need full content stop being intercepted at all.

## 5.5 The existing injected block

Carried from the CEO memo §4.2 and **not yet separately confirmed** — flagged for Marco in §13.

Today's `CLAUDE.md` block (~1,400 tokens) is loaded before request one and billed on every request after, costing **0.9% of all spend** whether or not the session benefits. Once recall serves content on demand, the block no longer needs to carry content at all. It shrinks to an **index under 200 tokens**: what MemBridge knows about this project, and how to ask.

Effect: the standing tax drops from 0.9% to ~0.3%, and the share of sessions where the block is net-positive rises from 60% to ~69%.

This matters because it is the only part of the design that helps the **29% of sessions with no recoverable waste** — they stop paying for a benefit they never receive.

## 6. Terminal output

On an answered read:

```
● Read(checkout/validate.ts)
  ⎿ answered from MemBridge · 380 tokens instead of 4,210
    structure only — read the file directly for bodies
```

**Shown when the saving exceeds 1,000 tokens, and always on the first interception of a session** (so the user learns what happened once, then it goes quiet unless material).

Measured: median 9 interceptions per session (p75 19, p90 39). A >1,000-token rule fires on ~25% of them — about two lines in a median session.

**The threshold is absolute, not a percentage, deliberately.** With a 2.25× floor every answered read already saves ≥55.6%, so a percentage threshold is either inert or filters on compression *ratio* rather than benefit — it would hide a 60%-saving read on an 8,000-token file (4,800 tokens) while showing a 90%-saving read on a 300-token file (270 tokens).

## 7. Attribution — how savings are established

Three layers, each with a different job. **The distinction matters: once we intervene, the counterfactual is unobservable, so per-read credit is an assumption unless bounded.**

### 7.1 Calibration holdout — the causal claim

For a project's first **14 days**, `hash(sessionId + path) % 100 < 10` is **not** intercepted. Those reads are a control group inside the user's own work. Held-out versus served totals give a measured causal estimate. After 14 days the holdout switches off and the project captures 100% of the benefit. Re-runnable on demand.

Deterministic hashing, so the same session and path always land the same side — no flakiness, reproducible in tests.

### 7.2 Tool-input pricing — the per-read credit

Credit is priced from the intercepted call's actual `offset`/`limit`, never file size. Agents frequently read part of a file; crediting the whole file would overstate by an order of magnitude.

### 7.3 Acceptance rate — the diagnostic

Interception followed by a full read of the same path is recorded as a **loss** of the skeleton's tokens. Acceptance rate is the fast signal for whether skeleton quality is the bottleneck, and is the evidence loop for whether the tree-sitter investment is paying off.

### 7.4 Known inflation risks, explicitly not modelled away

- **Induced reads** — a skeleton listing imports may send the agent to files it would never have opened. Caught by holdout totals, not by per-read accounting.
- **Abandoned reads** — the agent may have opened the file and moved on after a screen. Same.

## 8. UI

### 8.1 Unit: tokens, never spend

**No dollar figure is displayed by default.** Our cost model is list-price API; many users are on flat Max/enterprise plans, so a spend number would contradict their invoice and discredit every figure beside it. Tokens come straight from the usage objects, are exact, and mean the same thing on every plan.

A dollar estimate exists behind "set your rate", **off by default**.

### 8.2 Placement

- **Home** — roll-up: `4.1M saved · 6.1% of context loaded`, plus per-project contributions. The Home number is arithmetically the sum of the project numbers.
- **Project → Savings tab** — context loaded, reads answered, tokens saved, then the per-file breakdown.

One click from claim to evidence.

### 8.3 States

- **No calibrating state.** Measured avoidance is arithmetic on observed values and appears from the first answered read. The holdout runs silently underneath and only confirms causation later.
- **Nothing to save** — "no repeat reads yet". An honest zero, not a hidden panel.
- **Net negative** — no red number and no scary chart. Recall pauses for that project, the card says so, and a "Try again" is offered.

### 8.4 Honesty constraints

- The displayed figure is **net**: rejected serves are subtracted. Wins-only counting is forbidden — it is the vanity metric this whole design exists to avoid.
- The per-file *loss* breakdown is **not** shown to users (they cannot act on it and it makes a net-positive feature look broken). It goes to a local dev log.
- Denominator is "% of context loaded", which is the conservative choice.

### 8.5 Diagnostics

A single Settings toggle, **"Send anonymous diagnostics"**, on by default, with a **"See exactly what is sent"** link revealing the literal payload. A net-negative project auto-flags to Supabase.

Payload — no code, no file names, no project names, no account:

```
install_id      random uuid, generated locally
version
net_tokens
acceptance
reads_answered
reject_reasons  {read_after_serve: n, no_structure: n}
languages       {ts: n, sql: n}
```

A second toggle, **"Answer reads from memory"**, is the recall kill switch in plain English.

## 9. Decisions and rationale

| decision | rationale |
|---|---|
| Measured from user's own logs, not a lab benchmark | Buyers discount vendor benchmarks; MemBridge already tails the logs containing exact per-request usage. |
| Hook intercepts; MCP also exposes the store | Interception is deterministic and measurable; cooperative recall depends on model compliance, which varies and cannot be measured in advance. |
| Skeleton, regenerated on hash change | Cannot go stale; no stored baselines. |
| Diff deferred | Redundant reads split ~50/50 unchanged/edited, so a diff addresses under half the opportunity at the cost of state and staleness risk. |
| `web-tree-sitter` accepted (~61 MB) | Chosen with size numbers in hand. Wasm avoids the Electron ABI problem that native bindings would introduce. |
| 2.25× serve floor | Guarantees ≥55.6% saving per answered read while serving more often than a 3× floor. |
| Tier C flag-gated | Largest chunk but highest rejection risk; enable on evidence. |
| Calibration holdout, not permanent | Causal proof for ~0.4% of a year's opportunity rather than a standing 10% tax. |
| Tokens not dollars | List-price dollars contradict subscription invoices. |
| Diagnostics on by default | Solo users are the majority of installs and the population we most need failure data from; opt-in would skew the sample toward enthusiasts. |

## 10. Safety and failure

**Governing rule: every failure degrades to ordinary agent behaviour, never to broken work.**

- **Fail-open, always.** Any exception, missing store, parse error or corrupt cache returns "no opinion" and the read runs. Wrapped at the outermost boundary.
- **~150 ms budget.** Exceeded → step aside. Better to miss a saving than make every read feel slow.
- **Freshness verified at serve time** by re-hashing the file on disk. Tier A additionally requires the hash to match what the agent was shown.
- **Tracked, non-paused projects only** — reuses the existing `isTrackedProject` gate.
- **Skip files where a skeleton is meaningless**: binaries, minified bundles, lockfiles, anything without grammar or recognisable structure.
- **Three kill switches**: global setting, per-project pause, and an env var for a single session.
- **Redaction before storage and before any sync.** Skeletons derive from source and can carry a hardcoded key in a `const` or default argument. This is a materially different exposure from the prose digests synced today, and `lib/redact.js` must run on the skeleton, not just the narrative.

## 11. Testing

Suite stays offline.

- **Ledger equivalence** — the strongest test available. `external_ledger_v4.json` holds 6,104 sessions parsed by the reference Python implementation. `lib/ledger.js` runs the same transcripts and must match on requests, volume and cost within tolerance. The corpus becomes a regression fixture.
- **Skeleton** — fixture files per language; assert signatures survive, bodies are gone, compression clears 2.25×. Must include cases this codebase has already been bitten by: template literals with backticks, JSX, Python (no braces).
- **Policy** — table-driven across the five conditions and three tiers. Assert holdout determinism.
- **Fail-open** — inject a throwing skeletonizer, a corrupt store, a timeout. Assert the read proceeds every time.
- **Accounting honesty** — simulate an agent reading the file after being served; assert it is recorded as a loss and the path stops being intercepted.
- **Redaction** — plant a secret in a fixture source file; assert it never appears in the stored skeleton or a sync payload.

## 12. Build order

| # | what | why this order |
|---|---|---|
| R0 | Ledger engine + adapter change | Everything needs a scoreboard; independently valuable and demoable. |
| R1 | Savings UI (Home roll-up + project tab) | The demo, and the honest test of whether we help. |
| R2 | Skeleton extractor + recall store | The payload. |
| R3 | PreToolUse hook + MCP `recall()`, tiers A and B | Where tokens actually move. |
| R4 | Holdout, diagnostics flag, dev log | Makes the claim defensible. |
| R5 | Tier C behind a flag; team-wide recall | Evidence-gated expansion. |

## 13. Open risks

1. **Site copy conflicts with diagnostics.** The README says "local-first · no account" and that everything stays local until you join a team. Default-on diagnostics needs the marketing copy qualified, or it is a broken promise.
2. **Unauthenticated Supabase endpoint.** All current writes go through authenticated team sync. An anonymous flag needs a new endpoint with rate limiting and an anon key — new backend surface, not a reuse.
3. **Electron bundling of `web-tree-sitter`.** The libsodium incident (dependency missing from the asar, encryption silently paused) is the precedent. Bundling must be verified in the packaged app, not just under Node.
4. **Tier C acceptance is unknown** until real data arrives. The 6.1pp may not be capturable at acceptable quality.
5. **Grammar coverage.** Files with no grammar fall back to the depth stripper, whose compression on Python and JSX is unmeasured.

## 14. Needs Marco's confirmation before implementation

Two items in this spec were not explicitly approved during the design session:

1. **Minimum-size floor of 400 tokens (§5.2).** An earlier draft said ~1,000. The read-size data shows that would skip more than half of all candidate reads. 400 is my recommendation; the number is a judgement call and should be Marco's.
2. **Shrinking the injected `CLAUDE.md` block to a <200-token index (§5.5).** Carried from the approved CEO memo but not separately discussed. It is the only part of the design that helps sessions with no recoverable waste, and it halves the standing tax — but it changes what every agent sees at startup, which is a bigger behavioural change than anything else here.
