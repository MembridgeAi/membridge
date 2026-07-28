# Memo: reworking MemBridge to actually reduce token spend

**To:** Andrew
**From:** Marco
**Date:** 28 July 2026
**Evidence:** 6,104 Claude Code sessions · 310 developers · 216 repos · 76.3B tokens · $56,666 list price. Method and reconciliation in `token-spend-analysis/` (`corpus_summary.md`, `savings_v4.md`, `reconciliation_v4.md`).

---

## 1. The one-paragraph version

We now have the largest measured corpus of real agent sessions we know of, and it tells us three things. **Re-orientation is 26% of every dollar spent on coding agents.** **Up to 18.6% of all billed volume is addressable** by returning less than the file when an agent reads. And the thing that captures it is **not what MemBridge currently stores** — we store a narrative of who did what; the waste is in re-opening the same *files*. Closing that gap is the rework.

> **Correction, 28 July.** An earlier draft of this memo said 8.3% was recoverable. That figure is correct for a pure *memory* layer — recalling what an earlier session already read — and it is the number the corpus study reports, deliberately as a floor. It understates what we can actually build, because a *compression* layer does not need memory at all: a structural skeleton of a file the agent has never seen still returns fewer tokens than the file. The addressable ceiling is 18.6%, decomposed in §3.1.

---

## 2. How MemBridge works today

Three stages, all local:

**Watch.** A daemon tails the JSONL session logs Claude Code, Codex and Gemini CLI already write. No API keys, no interception — we read what the tools leave on disk.

**Distill.** Each finished session becomes a small per-project memory: the ask, what changed, decisions, gotchas, files touched. The agent writes its own summary via a Stop hook, so it's the agent's account of the work, not a heuristic reconstruction.

**Inject.** That memory is written between markers into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` — the files every agent reads at startup. Optionally a redacted digest syncs to teammates, so your agent starts knowing what theirs did.

There's also an **MCP server** exposing five tools (`list_projects`, `get_project_memory`, `get_recent_activity`, `search_memory`, `why`) — the same memory as a queryable API rather than a file. Today that's a secondary path. **The rework makes it the primary one.**

---

## 3. The uncomfortable measurement

Injection is not free. A block in `CLAUDE.md` is loaded before the first request and **stays in context for the entire session**, so it is billed on every single API call. In my own repos the block is currently **~1,400 tokens**. The median session in our corpus makes **41 requests**; the mean is 82.

So a 1,400-token block is billed 41–82 times over.

| always-on block | cost across the corpus | as % of all spend |
|---|---|---|
| 500 tokens | $184 | 0.3% |
| 1,000 tokens | $369 | 0.7% |
| **1,400 tokens (today)** | **$516** | **0.9%** |
| 2,000 tokens | $737 | 1.3% |
| 4,000 tokens | $1,475 | 2.6% |

**The good news, and it is genuinely good:** we spend 0.9% to chase 8.3%. That's a 9:1 return, and it means the basic bet is sound. Nobody should read this memo as "injection was a mistake."

**The bad news is the distribution.** The tax is uniform; the benefit is not.

- **29% of sessions have zero recoverable waste** — first session in a repo, or every file opened is genuinely new. They pay the block and get nothing.
- **40% of sessions are net-negative** at a 1,400-token block.
- The median session could justify a block up to **3,469 tokens** — but the 25th percentile justifies **zero**.

We are charging every session for a benefit that four in ten never receive. In aggregate we win; per session we are visibly wasteful to exactly the user who is watching their bill.

---

## 4. The three things that have to change

### 3.1 What is actually addressable

Measured across all 120,874 read events in the corpus, by the mechanism that would capture each:

| mechanism | reads | share of all billed volume |
|---|---|---|
| Same-session repeat — agent re-reads a file it already read this session | 24.1% | **3.8%** |
| Cross-session repeat — an earlier session already read it (memory) | 45.0% | **8.7%** |
| First-ever read — nobody has read it (pure compression) | 30.9% | **6.1%** |
| **Total addressable** | 100% | **18.6%** |

Three things follow. **The cheapest win is the one we never counted:** a quarter of all reads are a session re-reading a file it already has in context. Answering "you read this at turn 12, unchanged" costs a handful of tokens and carries almost no correctness risk, because we know exactly what the agent was shown.

**Memory alone caps out at 8.7%.** Everything above that requires compression, which is a different mechanism with a different risk profile.

**These are gross ceilings** assuming perfect displacement at zero replacement cost. Real net is lower — subtract the skeleton's own tokens and every serve the agent rejects and reads anyway. Treat 18.6% as the size of the pool, not the take.

### 4.1 Change the payload: from "who did what" to "what this file is"

This is the important one. Our redundancy measurement counts **re-reads of the same file path** by a later session. To stop a re-read, memory has to answer the question the agent was about to open the file to answer: what's in it, what it exports, what its invariants are, what changed recently.

Today we store: *"Marco capped retries at 3 in validate.ts, two hours ago."* Useful context. It does not stop an agent opening `validate.ts`.

We need, keyed by path: *"`checkout/validate.ts` — exports `validateCart`, `applyPromo`. Retries capped at 3, exponential backoff. Depends on `pricing/rates.ts`. Touched 4× in 14 days. Invariant: never call before session lock."*

That's a **file-level knowledge store**, not an activity feed. The activity feed stays — it's good product and it's how we get the raw signal — but it becomes an *input* to the thing that saves money, not the thing itself.

### 4.2 Change the delivery: from always-on injection to on-demand retrieval

Push-everything-to-everyone is what makes the 29% pay for nothing. The fix has a shape MCP already gives us:

- **The always-on block stays as it is.** An earlier draft of this memo proposed shrinking it to a sub-200-token index. That is now rejected: the block carries cross-tool, cross-teammate *narrative* memory — what a teammate's Codex decided — which file-structure recall does not replace, and it is the only channel reaching tools without hook or MCP support. Trading that for ~0.6pp of token saving is a bad deal. The ~0.9% standing cost stays, measured and visible rather than assumed.
- **The content moves behind an MCP tool** the agent calls when it's about to read something. Sessions that need nothing fetch nothing and pay nothing.
- The prize: a `recall(path)` that returns 300 tokens instead of the agent reading a 4,000-token file. That's where an 8% saving actually comes from.

This inverts the current design. Today the file is primary and MCP is a convenience. It should be the reverse.

### 4.3 Measure our own effect, per session, and show it

**This is the part nobody else can copy, and I'd argue it's the whole moat.**

We already tail the session logs. Those logs contain the exact per-request `usage` objects — `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. That is precisely the data the entire study above was built from. **MemBridge is already sitting on the measurement apparatus and doing nothing with it.**

We can compute, locally and exactly:

- what this project spent on agents this week,
- how much of that was re-reading files an earlier session already read,
- how much MemBridge avoided, priced at the user's actual blended rate.

Not a model. Not an estimate. The user's own numbers, from their own logs, on their own machine.

That turns MemBridge from "shared memory, sounds nice" into "here is $264 a year per developer, measured." It also disciplines us: if a change makes things worse, our own dashboard says so.

---

## 5. Build order

| # | What | Why now |
|---|---|---|
| **R0** | **Ledger engine.** Port the parser: per-request usage → residence-weighted ledger → orientation and redundant-read share, per project. Local only. | Everything else needs a scoreboard. Ship this first even if nothing else changes — it is independently valuable and immediately demoable. |
| **R1** | **Savings panel.** Surface R0 in the dashboard: spend, waste, what we saved, this week. | This is the demo. It's also the honest test of whether we help. |
| **R2** | **File-level knowledge store.** Build the per-path record (exports, invariants, dependencies, churn, recent decisions) from the session logs and git we already read. | The payload change. Without it, R3 has nothing worth serving. |
| **R3** | **PreToolUse hook + `recall(path)` MCP tool.** | The delivery change. This is where the money actually moves. |
| **R4** | **Team-wide recall.** Cross-developer, not just cross-session. | Our redundancy figure already counts *other people's* earlier reads. Team sync is where the number gets big. |
| **R5** | **Surface the block's cost per project.** Use R0 to show what the injected memory costs and whether it earned out. | Makes the trade visible so the *user* can decide. We do not suppress their memory block for them. |

R0 and R1 are the ones I'd start Monday. They're small, they're honest, and they give us a number to sell.

---

## 6. What we must not promise

I want to be blunt here, because the temptation is real and it will bite us in a customer meeting.

- **"MemBridge eliminates 26% of your agent spend" is false.** 26% is orientation. The addressable pool is **18.6% gross**, and that is a ceiling assuming every serve lands and costs nothing. Until we have acceptance data from real installs, quote **5–8% net**, which is what the memory tier alone supports and what we can defend today. Revise upward only when the holdout says so.
- **Savings do not scale with orientation.** Our corpus doubled orientation share versus the original single-developer study (13.5% → 26.3%) and savings only went 5.1% → 8.3%, because most of the increase is *first* reads. Anyone who assumes proportionality will be wrong, and a sharp buyer will test exactly that.
- **The per-developer dollar figure is softer than the percentage.** $264/developer/year (median, net) rests on an annualisation assumption. The **10% of a sustained user's spend** ratio is robust; the dollars are the worked example. Lead with the ratio.
- **24.3% is a ceiling, not a target.** It's what you'd get if agents did no orientation at all, which is not a working agent.

Under-promising here is strategically correct: 5–8% of a real, growing, painful bill is a strong claim, and it's one we can *prove on the customer's own logs* within a week of install. That's much better than a big number we have to defend.

---

## 7. Decisions I need from you

1. **Do we reposition from "shared memory" to "measured token reduction"?** The evidence supports it and it's a sharper wedge, but it changes the pitch, the site and the roadmap. Everything above assumes yes.
2. **Does R0/R1 (the ledger and savings panel) jump the BYOK planner in PLAN.md?** My view: yes. The planner *spends* tokens; this *saves* them and proves it. Given the positioning, that ordering matters.
3. **Zero-dependency promise.** R2 wants light structural parsing of source files to build the per-path record. That likely means a parser dependency or a lot of hand-rolled regex. Which way?
4. **Does file-level content leave the machine on team sync?** Today we sync a redacted activity digest. Cross-developer recall (R4) is where the savings get big, but it means shipping *what code is*, not just *what happened*. This is the biggest privacy call in the rework and it's yours.

---

## Appendix: the numbers behind this memo

| finding | value |
|---|---|
| Corpus | 6,104 sessions, 310 developers, 216 repos, $56,666 |
| Orientation share of billed volume | 26.3% |
| Redundant reads (median repo with history) | 53.1% |
| **Recoverable by memory alone, gross** | **8.7%** |
| **Recoverable by memory, net of 20% replacement cost** | **6.6%** |
| **Total addressable incl. compression, gross ceiling** | **18.6%** |
| — of which same-session repeats (cheapest, lowest risk) | 3.8% |
| — of which cross-session repeats (memory) | 8.7% |
| — of which first-ever reads (compression only) | 6.1% |
| Ceiling (all orientation removed — unachievable) | 24.3% |
| Median sustained developer: agent spend | $2,973/year |
| Median sustained developer: net saving | $264/year |
| Requests per session (median / mean) | 41 / 82 |
| Cost of today's ~1,400-token injected block | 0.9% of all spend |
| Sessions where that block is net-negative | 40% |
| Sessions with zero recoverable waste | 29% |
| Max always-on block the median session justifies | 3,469 tokens |

Caveats that belong with any external use: the corpus is self-selected (developers who opted into publishing checkpoints, skewed toward SWE-chat's public-repo early adopters); 26 sessions have truncated transcripts and are under-counted; SWE-chat is ODC-BY and requires citing Baumann et al. 2026 (arXiv:2604.20779).
