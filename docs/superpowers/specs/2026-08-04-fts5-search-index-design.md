# FTS5/BM25 search index

**Date:** 2026-08-04
**Status:** approved, implementation in progress

## Why

`lib/search.js` is a hand-rolled weighted-field token scorer over an in-memory
array. Its own header justifies that choice: *"at the observed scale (<= ~200
entries per project) a linear scan beats any index we would have to keep
consistent."*

That was true when written and is not true now. `lib/team-archive.js` caps the
durable archive at 50,000 rows ("~3 years of history for a busy 20-person
team") and `activity.searchMemory` passes `includeArchive: true`, so a mature
team's every search linearly scans tens of thousands of rows.

### What the numbers actually say

Two very different measurements, and conflating them would oversell this.

**The raw query**, on the shipped Electron runtime (43.1.0 / Node 24.18 /
SQLite 3.53.1), 50k rows, cold (process start, open, query):

| | selective | common phrase | broad OR |
|---|---|---|---|
| in-memory scorer over the same rows | 463ms | 428ms | — |
| SQLite FTS5 + `bm25()` | 0.63ms | 5.8ms | 11.6ms |

**End to end through `searchMemory`**, at the realistic corpus shape — 20
projects, ~100 team rows each in state.json (the working cache), 50,000 rows in
the durable archives:

| | old scorer | FTS5 index |
|---|---|---|
| first search (index build included) | 598ms | 1300ms |
| selective query (704 hits) | 204ms | **107ms** |
| no hits | 171ms | **39ms** |

So: **~2x on a selective query and ~4x on a miss, not the ~400x the
microbenchmark suggests.** The query itself really does drop to ~1ms; what
remains is fixed overhead the index cannot touch — chiefly `loadContext`
parsing state.json (measured at 457ms on a deliberately inflated 10MB state,
~40ms at a realistic 1MB). That is pre-existing and the old path paid it too.
The first search is ~2x SLOWER because it builds the index.

The gap widens with archive size, which is the case this exists for: the old
path scores every archive row on every search, the new one scores none.

Index build is 443ms for 50k rows inside a transaction (76s without one —
always use a transaction), 14.6MB on disk. All figures are from one loaded
machine and should be re-measured before being quoted anywhere externally.

Beyond speed, BM25 brings **real IDF**, which the current scorer has none of:
today a match on a flooded common word counts as much as a rare one.

`node:sqlite` with FTS5 and `bm25()` is compiled into both the shipped Electron
runtime and modern Node. **Zero new dependencies.**

## Decisions taken

Three forks were put to the user; all three answers are recorded here because
each one closes off an alternative that would otherwise look attractive later.

1. **Node floor: bump `engines.node` to `>=22`.** `node:sqlite` is unflagged
   from 22.13/23.4. Node 18 EOL'd April 2025, Node 20 EOL'd April 2026. One
   code path, no permanent fallback branch. Rejected: feature-detect with
   fallback to the old scorer (two ranking paths forever, both needing gates).
2. **Index scope: whole corpus, index stores full rows.** The index answers a
   search on its own without corpus assembly on the read path. Rejected:
   archive-only (merging two ranked lists on incomparable score scales ranks
   wrong quietly) and key-only (an extra hydration pass for no gain once the
   safety guards below exist).
3. **Rollout: cut over directly**, gated by the recall-quality harness.
   Rejected: shadow-mode comparison and a config flag, both of which defer the
   decision and double the surface every future search change is tested against.

## Architecture

### Location

One global index at `~/.membridge/search.db` (via `util.homeDir()` — note that
returns `~/.membridge`, not the OS home).

Global, not per-project, for three reasons: search is cross-project so a single
open beats opening N project databases per query; metadata filters (project,
author, tool, date) become SQL `WHERE` clauses evaluated *with* the ranking
instead of a JS pre-filter pass over every entry; and no binary lands in any
repo's `.membridge/`.

### Module boundary

New `lib/search-index.js` owns schema, writer and reader — everything that
touches SQLite.

`lib/search.js` keeps `tokenize`, the strict/relaxed two-pass policy and the
retrievals boost. Those are ranking *policy* and stay storage-agnostic and
pure; `usageBoost` in particular is reused unchanged.

### Schema

One FTS5 table. UNINDEXED metadata columns carry everything filters and
hydration need; the eight text columns are the searchable surface.

```sql
create virtual table entries using fts5(
  key UNINDEXED,      -- activity.eventKey: session|ts|source
  project UNINDEXED,  -- absolute project path
  author UNINDEXED, author_id UNINDEXED, tool UNINDEXED,
  ts UNINDEXED, origin UNINDEXED, self UNINDEXED,
  row UNINDEXED,      -- the full REDACTED normalized entry, JSON
  headline, decisions, gotchas, files, goal, ask, summary, change_notes,
  tokenize = 'unicode61'
);
```

Ranking weights mirror today's `FIELD_WEIGHTS` exactly. The `bm25()` weight
vector must cover **all** columns including UNINDEXED ones (0 for those):

```sql
bm25(entries, 0,0,0,0,0,0,0,0,0, 4.0,4.0,4.0,3.0,3.0,2.0,2.0,2.0)
```

A `meta` table holds `schema_version` and `redaction_signature`.

**Tokenizer:** default `unicode61`, deliberately. The obvious-looking
`tokenize = "unicode61 tokenchars '_-.$'"` is wrong here — it keeps `auth.js`
whole so a search for `auth` stops finding it. The default splits identifiers
into parts, which is the behaviour the current tokenizer works hard to
approximate. Verified experimentally; do not "fix" this.

### Safety is structural, not conventional

Storing full rows makes the index a second source of truth. That is the risk
the user accepted, and it is contained by construction rather than by
remembering to do the right thing at each call site:

- **Redaction.** The writer's only input is corpus-assembly output, which has
  already passed the redaction closure. Raw team rows never reach the writer,
  so unredacted text cannot physically land in the DB.
- **Dedup and identity twins.** `key` is the eventKey and is unique. Collapse
  happens on upsert; cache-wins precedence is expressed as write order.
- **Revocation.** Two layers, because this codebase has already shipped this
  bug once (see `revocation-does-not-reach-local-disk`). The writer deletes a
  project's team rows when `teamAccessLost` is stamped, AND the reader excludes
  those projects in SQL on every query. A stale index still cannot serve
  revoked memory.
- **Redaction-config drift.** A signature of the compiled patterns lives in
  `meta`, mirroring `lib/block-signature.js`. A mismatch forces a rebuild, so
  adding a redaction pattern cannot leave old text searchable.

### Query translation

Queries are natural language ("who touched auth.js"), not FTS5 syntax.

1. `search.tokenize` + stopword drop (reused unchanged).
2. Each term wrapped in double quotes with internal quotes doubled.
3. Each term given a `*` suffix for prefix matching.
4. Strict pass joins with `AND`; relaxed fallback joins with `OR` — the same
   two-pass policy as today, pushed into SQL.

Escaping is load-bearing: unescaped user text containing `NEAR(`, an unbalanced
paren or a bare `"` throws inside SQLite. Verified that quote-wrapping
neutralises all of these.

**Known behaviour change:** today `auth` matches `authorization` *and* `reauth`
(substring over tokens). Prefix matching keeps the first and loses the second.
Small recall difference, accepted. The `trigram` tokenizer is the escape hatch
if it proves to matter.

### Scores and the retrievals boost

`bm25()` returns **negative** scores, more negative being better. The reader
negates to a positive relevance figure before anything else touches it, so the
existing multiplicative `usageBoost` keeps working unchanged and the `score` an
agent reads stays intuitive (higher = better).

### Lifecycle

The daemon maintains the index on the `syncOnce` path it already uses to
rewrite `memory.json`. A first search with no DB builds it lazily. Rebuild is
forced by a `schema_version` or `redaction_signature` mismatch. Writes always
run inside a transaction.

### Cutover

- `activity.searchMemory` queries the index instead of assembling and scanning.
- `lib/hooks-search.js` **still ranks in memory** via `rankWithFallback`, and
  was deliberately left alone. It is a fail-open PreToolUse path in a process
  that exits after one tool call, it reads only one project (never the
  archive), and freshening the index there would make it pay for indexing work
  on behalf of every OTHER project. The shared policy is what keeps the two
  honest: `rankWithFallback` and `searchPasses` are the same strict/relaxed
  decision written for two backends, they live side by side in lib/search.js,
  and the corpus-invariant check in test/run-tests.js asserts both.
- `package.json` `engines.node` → `>=22`.

### Still open

- Daemon-side maintenance. `freshenIndex` is currently driven by whoever
  searches first, so the first search after a busy period pays the refill. The
  daemon should freshen on its own `syncOnce` tick.
- `loadContext` parsing state.json is now the dominant cost of a search. The
  index could eventually answer without it — everything it needs is indexed
  except the revocation gate — but that is a separate change.

## Testing

TDD throughout; new tests go in `test/suites/` per `.claude/rules/testing.md`.

New `test/suites/search-index.test.js`:
- schema round-trip: write entries, query, hydrate identical rows
- hostile query input does not throw (`NEAR(a b)`, `foo* OR "`, `a AND (b`)
- revocation: a project with `teamAccessLost` yields no team rows, both when
  the writer has pruned and when it has not (proving the reader guard)
- redaction-signature mismatch forces a rebuild
- upsert dedups on eventKey; cache row wins over its archive twin
- BM25 ordering: a rare term outranks a flooded common one (the IDF property
  the current scorer lacks)

`test/suites/recall-quality.test.js` is the real gate — every scenario must
stay green through the cutover, and the vocabulary scenarios should improve.

## Risks

- Touches the read path of every search surface. Larger blast radius than any
  recent change.
- Benchmarks are synthetic and from a loaded machine. Re-measure on the real
  corpus; do not quote these figures externally.
- 14.6MB index for a 50k-row archive is fine on disk but is a new artifact the
  user did not have before; it must be safe to delete at any time (it is — the
  rebuild path is the recovery path).
