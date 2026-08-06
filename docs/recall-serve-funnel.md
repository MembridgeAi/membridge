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

## Suggested order

1. **Persist the read-time hash** into `fileReaders` and key Tier A off it.
   Fixes the latent correctness bug and decouples the cheapest tier from the
   store. Smallest change with the clearest justification.
2. **Re-run both harnesses on a normal install** before drawing conclusions
   about the product from either number.
3. **Only then** consider whether eligibility (top-25) should widen — and note
   the coverage curve says it should not.
