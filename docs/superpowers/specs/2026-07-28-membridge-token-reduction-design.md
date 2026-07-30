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

## 5.5 The existing injected block — unchanged (decided)

An earlier draft proposed shrinking the `CLAUDE.md` block to a sub-200-token index once recall could serve content on demand. **Rejected, deliberately.**

The block is not a cache of things recall would replace. It carries **cross-tool, cross-teammate narrative memory** — what a teammate's Codex session decided, which agent owns what — and recall serves *file structure*, an entirely different thing. The block is also the only channel that reaches tools with no hook or MCP support.

Shrinking it would trade the product's existing, visible value for roughly 0.6 percentage points of token saving. The block stays exactly as it is.

**Consequence, accepted:** the ~0.9% standing cost of the block remains, and the 29% of sessions with no recoverable waste keep paying it. The ledger will measure that cost per project (§8.2), so the trade is visible rather than assumed — but MemBridge does not act on it unilaterally.

## 6. Terminal output

On an answered read:

```
● Read(checkout/validate.ts)
  ⎿ answered from MemBridge · saved 91% of this read (3,830 tokens)
    structure only — read the file directly for bodies
```

**The line leads with the percentage** — it is the figure a developer grasps at a glance mid-task — with the absolute in parentheses so the magnitude is still visible. (The dashboard is the opposite way round: it reports tokens, never percentages of spend. See §8.1.)

**Shown when the saving exceeds 1,000 tokens, and always on the first interception of a session** (so the user learns what happened once, then it goes quiet unless material).

Measured: median 9 interceptions per session (p75 19, p90 39). A >1,000-token rule fires on ~25% of them — about two lines in a median session.

**Critically, the percentage is presentation only — the threshold stays absolute.** With a 2.25× floor every answered read already saves ≥55.6%, so gating *display* on a percentage would be either inert or actively wrong: it would hide a 60%-saving read on an 8,000-token file (4,800 tokens) while showing a 90%-saving read on a 300-token file (270 tokens). Show the ratio; decide on the tokens.

## 7. Attribution — how savings are established

Three layers. The headline number is directly observed; nothing in it is modelled.

### 7.1 Direct avoidance — the headline

When the hook intercepts, it has seen the actual tool call. `Read(path)` with no `limit` means the agent was about to load the whole file; `offset`/`limit` state exactly how much. **That is an observed request, not a counterfactual.**

For each interception, with `followTokens` = any follow-up read of that path in the same session (0 if none):

```
net = callTokens − (skeletonTokens + followTokens)
```

| outcome | net |
|---|---|
| no follow-up read | full saving |
| smaller, targeted follow-up | partial saving — the skeleton did its job |
| full re-read | loss of the skeleton's tokens |

Worked: a 4,210-token call answered with a 380-token skeleton, followed by a targeted 600-token read, nets **+3,230**. The same call followed by a full re-read nets **−380**. The earlier rule was this formula with `followTokens` hardcoded to the whole file.

This supports a mechanism claim: *"answered 118 reads that would have loaded 1.6M tokens, using 190k instead."* Every figure is observed. Available from the first interception, covering 100% of them.

### 7.2 Holdout — a divergence check, not the headline

**3%** of eligible reads are not intercepted, chosen deterministically by `hash(sessionId + path)`. Runs **continuously** rather than for a fixed window.

Its job is narrow: catch cases where direct avoidance and total session cost disagree badly, which is the signature of second-order effects eating the gains. Pooled across installs via the diagnostics channel (§8.5); surfaces to a user only when the divergence is large.

It is deliberately **not** the quoted number. At a median of 9 interceptions per session, a 10% holdout yields roughly one held-out read per session — against per-developer spend that varies 4.7× between quartiles, no single project accumulates enough signal to produce a usable causal estimate in any reasonable window. **A holdout is the right instrument for a population, the wrong one for an individual.**

*(Note, final whole-branch review, MINOR 5: the diagnostics payload field for this was originally named `holdout_divergence`, implying it directly performs this check. It doesn't — both its terms live on the direct-avoidance side (avoided tokens per served read vs. call size per held-out read), never touching total session cost/volume, so it can't see the second-order effects described above. Renamed to `compression_realization`. The real divergence check this section describes needs per-session total volume and remains future work.)*

### 7.3 Rejection learning

A follow-up read only counts against us when **`net < 0`**. A smaller, targeted follow-up is a success and must never trip the rejection counter — otherwise we stop serving precisely the files where skeletons work best. Three net-negative outcomes on a path stop interception for it.

### 7.4 What this cannot claim

Direct avoidance measures **tokens not loaded**. It cannot see **induced reads** (a skeleton's import list sending the agent to files it would not have opened) or **trajectory changes** (more turns, each re-billing the whole context through the cache).

Therefore: *"avoided 1.4M tokens of file reading"* is defensible. *"Your spend fell 6%"* is not, from this data alone. Every user-facing surface states the first. The gap between them is what §7.2 exists to detect.

It also cannot tell you whether the agent would have made that targeted follow-up read anyway, without our skeleton. That question is unanswerable per-read — which is precisely what the holdout is for. This formula makes the diagnostic honest; the holdout remains the number you would actually quote about causation.

### 7.5 Ride-along accrual — the actual number (added 2026-07-29, Marco's direction)

§7.1's `avoided.tokens` counts a serve's net exactly **once**, but a session re-sends its whole context on every subsequent request: tokens a serve kept out of context are kept out of every one of those requests too. The once-only figure is therefore a floor, and at real session lengths (hundreds of requests) it hides most of the effect. Marco's direction: show the actual number.

`billed.tokens` is that same net **accrued over the session's observed subsequent requests**:

- Per receipt, `billed = netRecorded × rideRequests`, where `rideRequests` counts the serve's own session's **non-sidechain** requests with a ts after the serve's — measured off the usage stream the ledger already folds, never modelled from an average. A sidechain (subagent) request carries its own context and never counts.
- Counting **stops permanently at the first context reset** (compaction), detected with the same epoch rule the volume ledger uses: once the window is compacted, the read's content would have been summarized away regardless, so crediting later requests would fabricate accrual.
- Corrections propagate: billed is recomputed from the **corrected** net each pass, so a follow-up read retro-adjusts every ride already credited, and a serve that crosses negative drags its billed figure negative with it. Like `avoided.tokens`, this total may move down.
- When a receipt expires (24h TTL) or is evicted, its last figure stands — the same contract corrections accept.

`billed` is a **flat sibling** of `avoided` (the notes precedent), never a field inside it: §7.1 arithmetic stays once-only, and nothing doing that arithmetic can pick the multiplied figure up by accident. It is still tokens (§8.1) and still "avoided" (§8.2) — "kept out of N requests" claims nothing about the invoice.

Two estimator corrections landed with it, same date: a no-limit call is capped at the Read tool's real ~2000-line ceiling (big files could previously claim tokens the read would never have returned — the one bias that pointed in the flattering direction), and only content-bearing reads (Read/NotebookRead) may correct a serve (a follow-up **Grep** was priced as a full-file re-read, understating net and able to burn rejection strikes toward disabling recall on healthy paths).

## 8. UI

### 8.1 Unit: tokens, never spend

**No dollar figure is displayed by default.** Our cost model is list-price API; many users are on flat Max/enterprise plans, so a spend number would contradict their invoice and discredit every figure beside it. Tokens come straight from the usage objects, are exact, and mean the same thing on every plan.

A dollar estimate exists behind "set your rate", **off by default**.

### 8.2 Placement

- **Home** — roll-up: `1.4M tokens of file reading avoided · 6.1% of context loaded`, plus per-project contributions. The Home number is arithmetically the sum of the project numbers.
- **Project → Savings tab** — context loaded, reads answered, tokens avoided, then the per-file breakdown.

**The verb is load-bearing.** "Avoided" is what §7.1 measures — tokens not loaded. "Saved" implies the bill fell, which this data cannot support (§7.4). No user-facing surface may say "saved".

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

1. **Minimum-size floor of 400 tokens (§5.2).** An earlier draft said ~1,000. The read-size data shows that would skip more than half of all candidate reads. 400 is my recommendation; the number is a judgement call and should be Marco's.

_(Resolved 2026-07-28: shrinking the injected `CLAUDE.md` block is rejected — see §5.5.)_
