# Why recall serves 16 times (REV-2/REV-3)

**Status:** investigation only. No behaviour changed. Two findings below need
decisions; one is a latent correctness bug that should be fixed before anything
else on this path.

Re-run the acceptance measurement with
`node scripts/measure-skeleton-acceptance.js <repo> [repo ...]`.

## The funnel, on the author's machine

```
927  in-project Read calls (127 sessions, real transcripts)
644  repeat reads (69%)          <- opportunity is ABUNDANT
283  distinct files read
248  fileReaders keys
 71  hotPaths                    <- hotPathsOf: read by >1 session, cap 200
 27  store entries               <- warm() takes hotPaths.slice(0, 25)
 23  fresh (hash matches now)
 19  pass the serve gates today
 16  serves
```

**The mechanism is serving nearly everything it is allowed to serve.** 16
against 19 currently-eligible entries is not a serve-gate problem. The
constraint is *eligibility*: `tierFor` returns null without a fresh store entry,
the store is fed only by `warm()`, and `warm()` only ever sees the top 25
hotPaths.

Eliminated with evidence, not argument:

- **Opportunity is not rare.** 69% repeat-read rate corroborates the corpus's
  75–84%. The two measurements agree.
- **Not a bin-only wiring gap.** `updateLedger` (`lib/scan.js:855`) and
  `warm()` (`:873`) are both inside the shared sync pass, so the daemon and the
  tray app take the same path.
- **Not the worktree key bug.** `ledgerKeyFor` collapses all live worktree
  paths correctly today. The 38 worktree-prefixed keys still in the ledger
  (15%) are pre-fix residue from deleted worktrees, decaying as new reads land
  on the collapsed key.
- **Not the warm cap.** `MAX_WARM_PER_CALL = 25` sits past the knee of the
  coverage curve: top-10 covers 65% of repeat reads, top-25 covers 79%, top-100
  covers 98.9%. Raising 25 → 100 buys +19.9 points for 75 more files warmed.
  **The cap is well calibrated.**

## Finding 1 — Tier A's freshness gate is load-bearing, and insufficient

Tier A is a one-line notice needing no skeleton, yet `tierFor` gates it behind a
fresh store entry like every other tier. That looks spurious. It is not — but
it does not prove what Tier A claims.

Tier A's body says the file is **"unchanged since"** this session read it. The
evidence chain is:

- `readByThisSession` uses `ledger.fileReaders[relPath].sessions` — sessions and
  timestamps only. The record is
  `{sessions, reads, lastTs, firstTs, firstSession}`. **No hash.**
- `fresh` compares `storeEntry.contentHash` (hash at *warm* time) against
  `fileStat.hash` (hash *now*).

So the gate proves the file is unchanged over `[warm, now]`. Tier A claims it is
unchanged over `[read, now]`. **Those are different intervals**, and nothing
compares `storeEntry.updatedAt` against `rec.lastTs`.

The failing case is ordinary:

1. session reads the file at T1
2. someone edits it at T2
3. a sync pass warms the new content at T3
4. the session reads again at T4 — `fresh` passes, and Tier A says
   *"unchanged since"* about a file that changed at T2

**Do not remove the gate.** It is the only hash evidence on the path; removing
it turns a serve that is merely too rare into one that tells an agent not to
re-read a file that did change. That is worse than not serving.

**What Tier A would need to be honest without it:** the hash *at read time*,
compared against now. That data already exists at the right moment —
`lib/hooks-recall.js:371` computes `contentHashOf(absPath)` on every Read, and
`:418` keeps a per-session `served` map of `relPath -> hash`. It is simply never
persisted into the ledger's read record. Threading it into `fileReaders` would
make Tier A provable on its own terms and independent of the store entirely —
which is also what would let Tier A stop needing a skeleton it never uses.

## Finding 2 — the skeletonizer is not collapsing, and `noStructure: 6411` is an artefact

The hypothesis under test was that this repo's comment-dense style defeats the
compression floor. **It is refuted.**

| repo | accepted | declined | degenerate | floor | out/in p50 | comment share (acc / dec) |
|---|---|---|---|---|---|---|
| Membridge | **76%** | 53 | 12 | 41 | 0.41 | 39% / 38% |
| PolyBot | 85% | 32 | 0 | 32 | 0.38 | 28% / 56% |
| AI | 90% | 21 | 0 | 21 | 0.33 | 17% / 52% |

MemBridge is modestly worse (76% vs 85–90%), not collapsing. And comment share
**does not predict rejection here** — accepted files average 39%, declined 38%.
In the comparison repos it predicts strongly (28% vs 56%, 17% vs 52%). Whatever
costs MemBridge its 9–14 points, it is not comment density. The 12 degenerate
failures (a NUL byte or any line over `MAX_LINE_LEN = 2000`) are unique to this
repo and worth a look, but they are 12 files.

**`noStructure: 6411` does not mean 6,411 files failed.** The counter is
cumulative and `warm()` re-processes the same top-25 hotPaths on every sync
pass, so a handful of persistently-declined hot files are re-counted every tick
— roughly 320 passes' worth. It says nothing about distinct-file failure rate.
This was very nearly reported as the headline finding; the cross-repo
measurement is what caught it.

## The compression distribution, for setting the floor later

`COMPRESSION_CEILING = 0.6` (output lines must be under 60% of input lines) and
`lib/recall.js`'s `MIN_COMPRESSION = 2.25` (token ratio at serve time).

Accepted files land at p50 0.33–0.41 output/input lines, p90 0.50–0.57 — so the
0.60 ceiling is close to the p90 of what passes. Files near the ceiling are
exactly the marginal ones.

**Do not move either constant on this evidence alone.** Declining to cache a bad
skeleton is correct behaviour; loosening the floor buys serve volume by serving
worse skeletons, which raises `avoided` without the product working better.
What would justify a change is this table across more repos plus a quality
judgement on the skeletons at the margin — not the acceptance rate on its own.

## This machine is a worst case on the benefit side too

The block-cost work already established that this install is close to a worst
case on the *cost* side (one project dominating, carrying the largest block
measured). The same is true here, and it should be said plainly: MemBridge's
hottest files are `test/run-tests.js` (~24k lines), `lib/dashboard.js`,
`lib/teamsync.js`, `lib/server.js`. A 24k-line test monolith is not a normal
file, and this repo has the lowest skeleton acceptance of the three measured.

Both sides of the ratio in `docs/block-cost-measurement.md` are therefore
measured on an unusually unfavourable install. That does not make the finding
wrong; it makes re-running both harnesses on a normal install the highest-value
next step.


---

# REV-6: the funnel after the Tier A fix

**Provenance, because it decides what these numbers mean.** REV-4 (`7e9a6de`)
landed minutes before this was measured and has not yet run on any session, so
no session on this machine has a `reads` map. **Nothing below is observed new
behaviour.** Every figure is *current code's rules replayed over historical
reads* from the transcripts — a ceiling, not a count of serves that happened.
The REV-2 funnel above, by contrast, is observed history. Do not read the two
as the same kind of claim.

## The funnel, with Tier A traced separately

Tier A and Tiers B/C no longer share a bottleneck, so they no longer share a
funnel. Of 927 in-project `Read` calls:

| | reads | share | |
|---|---|---|---|
| first read, nobody had read it | 283 | 30.5% | no tier applies |
| repeat, same session, unchanged | **257** | 27.7% | **Tier A opportunity** |
| repeat, same session, written since | 135 | 14.6% | correctly refused |
| first read this session, another had read it | **252** | 27.2% | **Tier B/C opportunity** |

Cross-check: 257 + 135 + 252 = 644, exactly the repeat-read count measured
independently in REV-2.

## Answering the three questions

**1. How much did REV-4 lift the Tier A ceiling?** From 207 to 257 replayable
reads — **about 1.2x, not a transformation.** I flagged in REV-4 that Tier A
volume would rise and that it should be treated as suspect; the measurement says
the rise is real but modest.

Two caveats, both pointing the same way: the 207 uses *today's* 27-file store as
a proxy for what was stored historically, and it does not model the old rule's
**freshness** requirement at all. Both make 207 an *upper bound* on the old
ceiling, so the true lift is **≥1.2x and plausibly more**. It is not the
order-of-magnitude change the ticket hypothesised.

**2. Is Tier A now most of the opportunity?** No. **257 vs 252 — an almost exact
50/50 split.** Tier A does not make the skeletonizer irrelevant.

What changes is the *cost* of each half. Tier A needs no skeleton, no warm pass,
no store entry, and no freshness window — it is a pointer proved by a hash the
hook already computes. Tiers B/C need `warm()` to run, `skeletonize()` to
accept, the entry to be stored, and the hash to still match at read time. So the
honest framing is not "the skeletonizer stopped mattering" but **"half the
opportunity is now reachable at near-zero production cost, and the other half
still costs everything it did this morning."**

**3. Is the remaining B/C constraint worth attacking?** It still governs 27% of
reads, so it cannot be dismissed — but it is no longer the only lever, and it is
by far the more expensive one. The ordering that follows is: prove Tier A is
actually serving (it has never run), then re-measure, and only then decide
whether B/C's acceptance rate is worth engineering. The eligibility cap stays at
25 regardless; that curve was about which files get *stored*, and storage is now
irrelevant to half the opportunity.

## What this says about REV-4, quantified

135 same-session repeat reads in this history happened **after the file had been
written**. Under the pre-REV-4 rule those were candidates to be served a Tier A
notice saying the file was *"unchanged since"* this session read it — a false
statement handed to an agent that would then skip the re-read. That is the
concrete size of the bug: **135 opportunities to mislead an agent, in one
project's history.** It is also why the 14.6% row is labelled "correctly
refused" rather than "missed": refusing them is the fix working.

## Not modelled

`MIN_CALL_TOKENS` (400) applies to Tier A as well, so the 257 is an upper bound
on serves, not a prediction of them. Files under ~1600 bytes are excluded
regardless of tier.

# REV-7: Tier A does not serve in the real path

**`node scripts/prove-tier-a-serves.js` — 3/9.** A real PreToolUse payload
through the real hook binary, isolated scratch project, never touches a live
install. The first read does not record a hash and no session file is created
at all, so no second read can ever serve Tier A.

**Cause.** `lib/hooks-recall.js` returns early on a store miss, and its own
comment states the assumption:

> Nothing downstream can serve without a cache entry — recall.js's tierFor()
> requires one for every tier — so on a miss (the common case, in front of
> every read) return before parsing the ledger and, above all, before hashing
> the target file

That was true when it was written. **REV-4 made it false**: Tier A no longer
requires a store entry. But the early return still fires before the hash is
computed, so the read-time hash is never recorded for a file outside the store,
and Tier A can never bootstrap for exactly the ~90% of files the store does not
hold. REV-4 is inert in the real path.

`test/suites/recall-tier-a-interval.test.js` passes because it calls `tierFor`
directly and never crosses the early return. The unit test proves the policy;
this script proves the path — and only the second one was ever a claim about
the product working.

**This is not a one-line fix.** The early return exists for a measured reason:
the content hash is the most expensive thing the hook does (74ms on a 22MB
file), on the critical path of every single `Read`. Removing the guard puts a
file read plus sha1 in front of every read in every session. The fix has to
record a read-time hash for Tier A's candidates without paying that cost on
every miss — e.g. gating on "the ledger says this session already read this
file" (cheap, already parsed for other reasons) before deciding to hash, or
hashing only on the second read of a path. That is a design decision, not a
patch, and it is unmade.

**Both entry points are fine.** `bin/membridge.js:144` and `app/main.js:619`
both call `hooks.ensureInstalled()`, which calls `reconcileRecallHook()`. This
is not the CLI-vs-tray divergence that has shipped twice before.

**Upgrade path is fine in principle.** A pre-REV-4 session file (no `reads`
map) fails closed and does not serve, which is correct. It would start
recording on its next read — once the early return no longer prevents it.

## Suggested order

1. ~~**Persist the read-time hash**~~ — done in REV-4 (`7e9a6de`), via
   per-session state rather than `fileReaders`. See the REV-6 section above for
   what it changed and what it did not.
2. **Re-run both harnesses on a normal install** before drawing conclusions
   about the product from either number.
3. **Only then** consider whether eligibility (top-25) should widen — and note
   the coverage curve says it should not.
