# What MemBridge's own context block costs (REV-1)

**Status:** measurement complete. No user-visible surface has been changed —
that decision is Marco's, and this document exists so he can make it.

Re-run with `node scripts/measure-block-cost.js` (add `--json` for machine
output). **The single most useful thing anyone can do with this document is
re-run the harness on an install that is not the one measured here** — see
[What would change the answer](#what-would-change-the-answer).

---

## Provenance of the measurement — read this first

This is the first thing a skeptical reader should challenge, so it is answered
before anything else.

**The ruler is not `chars / 4`.** `lib/token-estimate.js` on master is
`Math.ceil(str.length / 4)`. Its own header calls it "deliberately coarse".
It understates real repo source by roughly 8%, so **every token figure the
ledger reports today is understated by about that much** — the existing
`notesInjectedTokens`, the `avoided` figures, all of it.

The figures below instead use the BPE tokenizer from the **unmerged**
`wip/bpe-tokenizer` commit `ad6c9ff`, which vendors **Anthropic's published
Claude BPE vocabulary** (MIT, © 2023 Anthropic PBC). That commit validated it
against js-tiktoken driving the same vocabulary: **exact match on 8 real repo
files and 3000 random-unicode fuzz strings.**

**Why it is legitimate to use an unmerged branch here.** That branch is
unmerged because of an unrelated recalibration: it puts `MIN_COMPRESSION` on
mismatched units, so the recall serve path serves 19 files where it served 21
and the intended end state is 24. That blocks using it as **policy**. It says
nothing about its accuracy as a **ruler**. This measurement uses it only to
count tokens; nothing in the product's behaviour depends on it.

**The harness refuses to guess.** It bootstraps the tokenizer out of git at the
pinned sha, runs a self-test against pinned expected counts, and **exits
non-zero rather than falling back to `chars/4`** — a silent 8% error in a
contested figure is the exact defect shape this codebase keeps finding. Its
failure modes are exit 2 (tokenizer unreachable), 3 (loaded but degraded),
4 (self-test mismatch), 5 (nothing to measure). The self-test earned its keep
immediately: it rejected a hand-written expected value during development.

Figures below captured **2026-08-05** against the author's install. The install
is live, so re-running gives slightly different totals.

---

## The block itself

20 blocks across 10 tracked projects:

| | BPE tokens |
|---|---|
| min | 157 |
| median | 830 |
| p90 | 2,708 |
| max | 2,861 |
| mean | 958 |

`chars/4` on the same blocks understates by **8.3%** overall, and by up to
18% on individual blocks.

## Cost vs. measured avoidance

Both sides on matched bases. 99 sessions, ~22,700 requests.

| Basis | Ledger figure | Block cost | Net |
|---|---|---|---|
| **Once-only** (vs `avoided`) | 57,071 | **211,041** (370%) | **−153,970** |
| **Ride-along** (vs `billed`) | 6,343,671 | **56,916,006** (897%) | **−50,572,335** |

The ride-along basis uses the same model as `lib/ledger-fold-recall-ride.js`
(tokens × subsequent requests), with one deliberate difference: that model
excludes sidechain (subagent) requests, because an avoided read was never in a
subagent's context. **A subagent does load `CLAUDE.md`**, so the block rides
along there too and those requests are counted.

---

## Baseline snapshot — 2026-08-05, immediately after the Tier A fix

Captured deliberately at this moment: **after** REV-4 (`7e9a6de`, which decoupled
Tier A from the store) and **before** any eligibility change. A before-and-after
is only useful if someone wrote down the before.

| | value |
|---|---|
| sessions / requests | 99 / 23,280 |
| `avoided.tokens` | 57,071 |
| `avoided.serves` | 16 |
| `avoided.tierA` / `tierB` / `tierUnknown` | **3 / 13 / 0** |
| `billed.tokens` | 6,452,031 |
| `holdout.skips` | 1 (gate is 30) |
| block cost, once-only / ride-along | 149,994 / 38,436,524 |

**What to expect, and how to read it.** REV-4 lets Tier A serve when the store
entry is missing or stale — cases where it previously stayed silent for no
reason, since Tier A never reads a skeleton. **`tierA` should therefore rise on
its own, and that rise is a side effect of a correctness fix, not the mechanism
working better.** If `avoided` moves and `tierA` is what moved, that is this
change and nothing more. If `tierB` moves, that is genuinely more files becoming
eligible.

`tierUnknown` is 0 here and should stay 0. Any non-zero value means serve rows
are arriving without a tier, and the attribution above stops being reliable
until that is explained — it is a tripwire, not a metric.

Numbers move between runs because the install is live; re-run
`node scripts/measure-block-cost.js` for current values.

## The three qualifiers

**These carry equal weight with the ratio above. A reader who takes the ratio
without them will reach a conclusion the data does not support.**

### 1. The benefit side has barely run — this asymmetry *is* the finding

- `avoided.serves`: **16**
- `holdout.skips`: **1**, against `MIN_HOLDOUT_FOR_EFFECT = 30`

So `savingsPayload().measurement.state` is `measuring`, not `sufficient`, and
`effect` is `null` — by design, because the payload declines to claim an effect
it cannot support.

**The cost is fully accrued and invisible. The benefit is barely accrued and
correctly labelled insufficient.** The 897% is not an effect size and must
never be quoted as one. It is the ratio of a mechanism that has been running
the whole time to a measurement that has hardly started.

### 2. This machine is close to a worst case

19,919 of ~22,700 requests are the MemBridge project itself, which carries the
**largest block measured** (2,678 tokens) because it is big, active and
team-synced. One install dominated by its own worst-case project is evidence,
not the userbase — and this repo already has a standing rule about that
(`design-for-the-userbase`: his machine is evidence, never the spec).

### 3. In absolute terms it is under 1% of context

The block ride-along is **0.95% of all context ever sent** on this machine.
96.8% of input-side tokens here are cache reads, and the block sits in the
stable cached prefix, so at roughly 10% of input price it is on the order of
**0.3% of the input-equivalent bill**.

Caching does **not** rescue the ratio — both sides ride along as cache reads,
so the discount scales numerator and denominator together. What it does mean is
that nobody's bill is being wrecked by this.

---

## What the ticket got wrong, and why it matters

The ticket framed this as "a gross saving presented as if it were net". That is
not what the surface does. `savingsPayload()` (`lib/server.js:596`):

- says **"avoided", never "saved"** (spec §8.2) — "tokens not loaded, not a
  claim the bill fell"
- **never computes a dollar figure** (spec §8.1)
- reports **`effect: null`** behind a sufficiency gate rather than rendering a
  day-one install as "0% saved"
- **already carries an injection cost**: `notesInjectedTokens`, a *flat
  sibling* of `avoided`, with a written rule that netting it in is "a spec §9
  violation, not an improvement" — because what an injection buys (a mistake
  nobody made) is unobservable to this ledger

This is a careful design with **one inconsistency**, not a dishonest one:
teammate-note injections have a representation, and the block — the much larger
cost — has none.

### Why prime-hook injections were excluded

Not an oversight, and not "it's small". `lib/hooks-prime.js`'s header states
it: the measurement queue only accepts row kinds that
`ledger-fold-recall-settle.js` settles, teaching it a new family is its own
change, "and the FILE-delivered block this hook substitutes for was never
counted either. **When block cost accounting lands, it should cover both
paths.**"

The author anticipated this exact ticket and specified the fix's shape.
`lib/recall-events.js` confirms the constraint: an unrecognised `kind` is
dropped by the fold's rewrite.

---

## What would change the answer

**For the ratio to flip, the benefit side has to actually run.** Nothing about
the cost side is in doubt — it is arithmetic over blocks that provably sit in
context. The uncertainty is entirely on the benefit side, and it is an
uncertainty of *sample size*, not of method.

**The next experiment, stated plainly:** run until `holdout.skips ≥ 30`, then
re-measure. At the current rate — 1 holdout skip across 99 sessions — that is
not weeks away, it is **thousands of sessions away** on this install. The
sufficiency gate will not be met by waiting.

That makes the honest next steps:

1. **Find out why the avoidance mechanism is barely firing.** 16 serves across
   99 sessions and 22,700 requests is the number worth explaining first. The
   recall layer is described elsewhere in this project's history as
   "built-but-unmerged and its savings UNMEASURED" — if it is not fully wired
   on this install, the ratio is measuring a cost against a benefit that was
   never switched on, and no amount of waiting fixes that.
2. **Re-run the harness on a different install** — ideally a multi-project team
   machine not dominated by one huge block. `MEMBRIDGE_HOME=... node
   scripts/measure-block-cost.js --json`.
3. **Only then** compare. A ratio computed on a machine where both sides are
   running is worth more than this one.

**What would make the cost genuinely smaller**, independent of the above: the
`mcpLive` path already replaces inline history with a `search_memory`
instruction, which costs tokens only when used. Note that #66 part 2 (moving
the block out of the tracked file) would **not** reduce this cost — it
relocates the block, it does not shrink it.

---

## Recommendations — awaiting Marco's decision

Both of these are recommendations, not decisions taken.

### 1. Extend the existing §9 pattern; do not net

Add `blockInjectedTokens` as a **flat sibling** of `avoided`, covering both
delivery paths (file-delivered and prime-hook), rendered on its own line with
one sentence saying what it is.

**Do not subtract it from `avoided`.** The spec forbids netting for
`notesInjectedTokens` for a reason that applies identically here: the ledger
cannot observe what an injection buys, so a net figure would be a subtraction
with a measured minuend and an unmeasurable subtrahend, presented as though
both were known.

### 2. Decide what the page says before shipping a cost line

Today, a cost line would show a large accrued cost against a benefit the
product itself declines to claim yet (`effect: null`, state `measuring`). That
is honest — and it is also **the least flattering possible moment to show it**,
for reasons that are about sample size rather than about whether the product
works.

That is worth saying out loud rather than being discovered after it ships. The
options are roughly:

- ship the cost line now, gated by the same sufficiency language as the benefit
  ("cost to date: X; effect not yet measurable")
- hold it until the benefit side clears its own gate, and fix the mechanism
  first
- ship it only in a diagnostics view, not the main savings surface

All three are defensible. Choosing between them is a product call.
