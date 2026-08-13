# Session headers and day-card area tags

**Date:** 2026-08-12
**Status:** approved, ready for planning

## Problem

Two related surfaces present work as a flat list, and both stop scaling at
exactly the point the product becomes useful.

**The session page** renders `decisions` and `gotchas` as one undifferentiated
list (`whatBullets`, `ui/src/features/session/distill.ts:113`). Up to eight
points — the `POINTS_MAX = 4` ceiling on each of two fields
(`lib/hooks.js:78`) — arrive with no indication that the first three were about
the React app and the last two were about the MCP server. The reader has to
parse each line to recover a structure the writer already knew.

**The day view** cannot answer the question people actually bring to it: *who
worked on UX this week?* A day card states what was done and how many files were
touched, but nothing on it is scannable by area. Finding the person who touched
the frontend means opening cards one at a time.

Both are legibility failures, which is the one class of defect this product
cannot ship: MemBridge's job is making accumulated memory legible, and a
twelve-line undifferentiated list is memory that has been captured but not made
usable.

## What we are building

1. The session page's "What was done" list is **grouped under headers** naming
   the area each point belongs to.
2. Day cards carry **area tags** derived from the files the session touched, so
   the day view can be scanned by area at a glance.

Both draw on **one fixed vocabulary of eight areas**, so a header on a session
page and a tag on a day card mean the same thing.

## The vocabulary

| Area | Class | Matches |
|---|---|---|
| # | Area | Class | Matches |
|---|---|---|---|
| 1 | `Data/Schema` | punctual | `migrations/`, `supabase/`, `prisma/`, `db/`, `*.sql` |
| 2 | `Build/CI` | punctual | `.github/`, `Dockerfile`, `Makefile`, bundler configs |
| 3 | `Tests` | ambient | `test/`, `spec/`, `__tests__/`, `e2e/`, `*.test.*`, `*.spec.*` |
| 4 | `Docs` | ambient | `docs/`, `*.md` |
| 5 | `UI/UX` | ambient | `ui/`, `frontend/`, `components/`, `views/`, `styles/`, `*.tsx`, `*.css`, `*.html` |
| 6 | `Integrations` | punctual | `adapters/`, `connectors/`, `hooks/`, `mcp*.js`, `webhook*`, `oauth*` |
| 7 | `Config` | ambient | `.claude/`, `config.*`, `settings.*`, `.*rc`, `.env` |
| 8 | `Backend` | ambient | `lib/`, `src/`, `server/`, `api/`, `services/`, `bin/`, `scripts/`, `*.js`, `*.py`, `*.go` |

Matching is **first-match-wins in the numbered order above**, and that order is
load-bearing — the measured distributions in this spec assume it exactly.

Two positions carry decisions rather than convenience:

- **`Tests` (3) precedes `UI/UX` (5)**, so `ui/src/features/feed/FeedPage.test.tsx`
  tags `Tests`. This is the "test files under `ui/`" decision below.
- **`Integrations` (6) follows `Tests` (3)**, so `test/suites/mcp-config.test.js`
  tags `Tests`, not `Integrations`. A test is a test whatever it covers;
  `Integrations` is reserved for the integration code itself.

Note that `Integrations` is *punctual* despite sitting low in the order. Class
and precedence are independent: precedence decides which area a file belongs to,
class decides what threshold that area must clear to earn a tag.

## Decisions

Each was asked and answered. Recorded because the reasoning is not recoverable
from the diff.

| Decision | Choice | Why |
|---|---|---|
| Vocabulary | **Fixed list of 8, path-derived** | Freeform LLM headers fragment — `UI/UX` vs `UI` vs `Frontend` become three tags — which defeats scanning, the entire point. A fixed list is also mechanically testable. |
| Tag source | **Files touched, not LLM** | Path derivation is deterministic, verifiable against real history, and works **retroactively on every session already captured**. An LLM label would cover new sessions only. |
| Header source | **LLM, at capture time** | A bullet is prose; no path maps to it. Only the model that wrote the point knows its area. |
| Selection | **Ambient by share, punctual on presence** | See below. This is the decision the feature lives or dies on. |
| Tag ordering | **By weight, always** | Punctual areas bypass the threshold but earn no ordering privilege. Measured cost of the alternative: one `.github` file headlined a session that was really 8 files of UI work. |
| Test files under `ui/` | **`Tests` wins** | Keeps `Tests` meaningful wherever tests live. Accepted cost: a session that only wrote UI tests does not surface as UX work. |
| `scripts/` | **`Backend`** | In this repo `scripts/` holds real logic (`gen-install.js`, `measure-recall-refusals.js`), not build tooling. |
| Storage | **No schema change** | Header prefixes ride the existing `decisions`/`gotchas` TEXT columns. See "Why no migration". |
| Backfill | **None, and none is possible** | The daemon has no model and BYOK was cut. Headers exist only for sessions captured after this ships. |

## The selection rule

Tagging every area a session touched produces tags that fire on everything and
therefore mean nothing. Measured across the full local corpus — 4,547 events,
100 team rows, 26 sessions:

| Rule | Tags/session | Tags firing on >50% of sessions |
|---|---|---|
| Every area touched | 3.2 | 4 — `UI/UX` 68%, `Docs` 68%, `Tests` 59%, `Backend` 59% |
| Top 3 by weight | 2.5 | 3 — `Docs` 59%, `UI/UX` 55%, `Tests` 55% |
| Material share only (≥25%) | 1.7 | none, but `Integrations` and `Config` never fire at all |
| **Ambient by share + punctual on presence** | **2.1** | **none; highest is `UI/UX` at 45%** |

A tag that appears on most cards cannot answer "who worked on X", so the rule is:

- An **ambient** area (`UI/UX`, `Backend`, `Tests`, `Docs`, `Config`) earns a tag
  when it is **≥25% of the session's matched files**. These are touched by
  almost every session; only a material share means anything.
- A **punctual** area (`Data/Schema`, `Build/CI`, `Integrations`) earns a tag
  **on presence**. These are rarely touched at all, so touching one *is* the
  signal — "they went into the MCP server" must survive being 2 files out of 20.
- Tags are **ordered by files touched** and **capped at 3**.
- A session whose areas all fall below threshold takes its heaviest area — and
  **every area tied with it**, still capped at 3 — so a session with files never
  renders zero tags. "Single heaviest" was the original wording and it is wrong
  where nothing is heaviest: ordering breaks ties alphabetically, so a day of
  five areas at 20% each rendered exactly `Backend`, presenting an alphabetical
  accident as a finding about where the day's work went.

Resulting distribution: `UI/UX` 45%, `Tests` 41%, `Docs` 36%, `Backend` 36%,
`Data/Schema` 27%, `Build/CI` 14%, `Integrations` 14%.

**These figures are a snapshot of a live, small corpus, and they drift.** The
backtest reads one machine's `state.json`, which grows as work happens. Between
two runs during this design's own implementation the corpus went from 26 to 27
sessions and `UI/UX` moved from 48% to 52% — over the 50% line — on the
strength of a single new session. That session was the one implementing this
feature, which touched nothing but `ui/src/features/feed/`.

Two things follow, and both matter more than the numbers above. First, a
measurement over ~23 tagged sessions moves ~4 points per session, so no single
run of this script either proves or disproves the invariant. Second, the
committed guard is deliberately NOT this script: it is the 18-day modelled
corpus in `areaTags.test.ts`, which is stable, hand-checkable, and carries a
canary proving it can detect the degradation it guards against. The backtest
is corroboration on real shapes; the unit corpus is the gate.

**Known cost of ordering by weight:** a session that touched two MCP files among
twelve tags as `[Docs][Backend][Integrations]` — the distinctive signal reads
last. Accepted deliberately; the alternative let one config file headline a
session it did not characterise.

## Two guards the backtest found

Neither was predicted by reading the code. Both are required.

**Path normalisation.** Raw paths tag every worktree session as `Config`,
because `.claude/worktrees/agent-x/lib/scan.js` begins `.claude/`. Almost all
work in this repo happens inside a worktree, so this is the common case, not the
edge. Keys must resolve through `repoRoot.ledgerKeyFor` / `wireKeyFor` — never a
raw relative path. Absolute paths appear in stored events too and must resolve
the same way.

**Agent scratch is not project work.** Before filtering, 33 distinct unmatched
paths were agent working files — `/tmp/**/scratchpad/*.png`, `tasks/*.output`.
Left in, they inflate file counts and hand tags to sessions that edited nothing
but their own scratch. Excluded: `tmp/`, `scratchpad/`, `tasks/*.output`,
`node_modules/`, `.git/`, `dist|build|coverage/`, images, lockfiles. After
filtering, 6 unmatched paths remain across the whole corpus.

## Session-page headers

The Stop hook's ask for `decisions` and `gotchas` gains an area prefix, one per
line:

```
[UI/UX] Removed the transfer-ownership menu item, no RPC can perform it
[Data/Schema] Migration 057 adds the partial unique index on member name
```

**Rendering.** `whatBullets` returns groups rather than a flat array. Grouping
engages only at **≥4 points spanning ≥2 areas**; below that the list renders
flat. Three headers over one bullet each is worse than the flat list it replaces,
and with a hard ceiling of 8 points that case is common, not hypothetical.

**Validation.** `runAppend` rejects an unknown area label loudly and
agent-correctably, the way `HEADLINE_MAX` already does (`lib/hooks.js:255`), so
the model rewrites inside the same summary turn rather than persisting a label
no renderer knows.

**Budget.** `POINT_MAX` (120) must be measured **after** the prefix is stripped.
Measured against the raw line, `[Integrations] ` silently consumes 15 characters
of every point's budget.

**Degradation.** An unprefixed point — all existing history, and any session
where the hook did not run — renders flat, exactly as today. 4 of 11 recent
sessions carry no points at all; those pages are unchanged.

## Why no migration

`bulletClip` preserves newlines on the wire (`lib/digest.js:348`) and
`NOTE_MAX` is 1200, so prefixed points reach teammates through the existing
`decisions`/`gotchas` TEXT columns with no schema change. `/api/feed` ships the
full `files` array uncapped (`lib/feed.js:99`), so tags compute client-side from
data already on the wire.

This matters beyond convenience: the migration ledger is currently drifted from
production and is keeping master CI red. A design needing migration 058 would
queue behind that. This one does not touch it.

## Testing

| What | How |
|---|---|
| `areaOf(path)` | Pure function, table-driven unit tests in `test/suites/`. Every row of the vocabulary table, plus worktree-prefixed, absolute, and excluded paths. |
| Selection rule | Fixture sessions covering ambient-below-threshold, punctual-single-file, all-below-threshold fallback, and the 3-tag cap. |
| **Distribution invariant** | The backtest becomes a regression test asserting **no area tags >50% of sessions** in the corpus. A future rule change that reintroduces tag soup fails a test instead of quietly degrading the feature. |
| Header parsing | vitest on `whatBullets`: prefixed, unprefixed, mixed, unknown label, and the ≥4/≥2 grouping threshold. |
| Hook validation | `test/suites/` coverage that an unknown label is rejected and that `POINT_MAX` is measured post-prefix. |

Per `.claude/rules/testing.md`, verification is `node test/run.js <suite>` for
the lib work and `cd ui && npx tsc --noEmit` plus targeted `npx vitest run` for
the UI work. No full-suite run.

## Out of scope

- Filtering or searching **by** tag. This is display only; a filter is a
  separate ticket once the tags are proven to read well.
- Per-repo vocabulary overrides. The eight areas are heuristics tuned on this
  repo and will be less accurate on an unfamiliar layout; a config surface for
  that is its own design.
- Backfilling headers onto historical sessions. Not possible without a model in
  the daemon.
- The CLAUDE.md injected block, which deliberately flattens bullets to one line
  per field and is unaffected.
- Day-card tags on the **project** page, which today renders an entry stream
  with no bullets at all.

## Open coordination

Team memory reports a staged branch addressing "the twelve-bullet session page."
No such ref exists in this repo. Confirm with marco before touching
`SessionPage`, or the two changes collide.
