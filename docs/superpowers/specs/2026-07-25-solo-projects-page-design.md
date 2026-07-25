# Solo-first Projects page — design

Date: 2026-07-25
Surface: the local dashboard's Projects index (`#home`), `lib/dashboard/client.js`
Status: approved

## Problem

The Projects index was designed to answer *"what did other people do while I was
away?"* For a solo user — who has no other people — roughly half the page is
structurally dead:

| Element | Why it is dead for a solo user |
|---|---|
| **Who** column | Always one avatar: the user's own initials, on every row |
| **"N new"** dot and count | `pxNewCount` returns 0 whenever `pxIsSolo()` (client.js:960) |
| **Person** filter dropdown | Only ever contains "All" and the user |
| **Show: All / Shared / Local** | Every row is Local |
| **Subline** | "3 projects, all local" — restates the row count |
| **24h sparkline** | One person cannot fill 24 hourly buckets across several projects |

Worse, the one cell that does carry information shows the *weakest field
available*. Every captured session already carries a purpose-built `headline`,
plus `goal`, `decisions`, `gotchas`, and the **text** of open todos
(`memorydb.js:165-200`). The row renders a 140-character clip of `summary`
instead (`client.js:930`) and discards the rest.

So "where did I leave off" is a plumbing problem, not a capture problem. The
answers are already in the database and already cross the HTTP boundary.

## What the page must answer

Agreed with Marco, in priority order:

1. **"What do I know about this project?"** — memory depth as an accumulating
   asset. Sessions, span, tools.
2. **"Where did I leave off?"** — a re-entry surface that reloads the user's own
   head after a context switch.
3. **"Is MemBridge working?"** — health, but **as an exception only**. Health
   never occupies space when things are fine; a broken project says so loudly.

Point 1 is the retention story: a project with 400 sessions across three tools
going back to March is *worth something*, and today's page renders it
identically to a project added yesterday. That is the difference between the
product feeling like it compounds and feeling like it logs.

## Approach: one adaptive card, not a solo fork

Rejected: a separate solo layout branched on `pxIsSolo()`.

Two reasons, both about long-term quality rather than build cost:

- **Forks rot asymmetrically.** The solo branch is the one that falls behind,
  because team is where attention goes. In two years the solo page is a year
  stale.
- **Solo is not a permanent state.** The product arc is solo → team. If those
  are two different pages, the upgrade silently rearranges a page the user has
  learned. If it is one page that *grows a column* when a second person appears,
  the upgrade explains itself — and that transition is the main conversion.

Chosen: **one card component everywhere, where each block renders only when it
has something to say.** "Who" appears when more than one person has worked on a
project. The sparkline appears when there is activity to plot. The Person filter
appears when there is more than one person.

The columns are not dead *because the user is solo* — they are dead *because
there is no data in them*. A two-person team has the same flat sparklines and
the same single-avatar rows on half its projects. Fixing the rule fixes both.

Solo-ness therefore affects only **copy** and the **team CTA**, which is where
it belongs.

A useful confirmation that the rule is the right one: `pxNewCount` currently
short-circuits to 0 whenever `pxIsSolo()` (client.js:960). Under the data-driven
rule that special case becomes **redundant** — a solo user has no `self === false`
entries, so the count is naturally 0 without asking whether they are solo. The
short-circuit is removed rather than kept, and `pxIsSolo()` survives only for
copy and the team CTA.

### The lead-slot rule

Blocks appearing and disappearing is defensive — it yields a page that is less
wrong, never actually right. The card has a fixed hierarchy, and what fills the
**lead slot** changes with what is true:

> Lead with what changed since you last looked, and what you still owe.

For a solo user that is almost always their own unfinished work. For a team user
with unread teammate activity it is that activity. Same card, one rule.

## Card anatomy

Priority order, top to bottom:

1. **Name + the latest session, stated as an outcome and never truncated.** See
   the section below — this is a hard rule, not a formatting preference.
2. **Where you left off.** The **text** of the top unfinished todos from the
   latest session (cap: 2 items, each clipped), not a bare count. A "+N more"
   affordance when there are more.
3. **What's accumulated.** Sessions captured, the span they cover, and the tools
   seen: e.g. *"412 sessions since 4 March · Claude Code, Cursor, Codex"*.
4. **Health, only when broken.** `paused`, `not capturing` (the existing
   `pxCaptureStale` divergence check), or the new **memory block missing** check.
5. **Everything else.** Recent files, last activity, the `⋯` menu.

Blocks 2 and 3 are new to this surface. Block 1 is a field swap. Block 4 gains
one new condition.

### The latest-session line: an outcome, never a prompt, never cut off

Two hard rules for block 1.

**It never shows a prompt.** Today the cell falls back to `latest.ask` when no
summary is present (client.js:930). A prompt is what you *asked*, not what
*happened* — on a re-entry surface it shows the question instead of the answer,
which is precisely backwards. It is also the rawest text on the page. The
fallback to `ask` is removed outright; there is no length at which showing a
prompt here becomes correct.

**It never truncates.** The 140-character clip (`pxClipSummary` +
`PX_SUMMARY_MAX`, client.js:819-825) exists only because the cell was one line
of a scan grid. Cards remove that constraint, so the text wraps instead of
clipping. No ellipsis, no hover-for-the-rest.

The codebase already agrees with this and this page is the holdout: `hooks.js:96`
instructs every capture that headline *"renders verbatim on a card that never
truncates,"* and `HEADLINE_MAX = 80` enforces it at the source (hooks.js:39,
134). The Activity view honors that contract; the Projects row does not.

Resulting chain:

| Order | Source | Rendering |
|---|---|---|
| 1 | `headline` | Verbatim. Capture-bounded to 80 chars; a wire headline can reach 160 after redaction growth (teamsync.js:44), so it wraps rather than clips |
| 2 | `summary` | In full, wrapped. Already bounded to 300 chars at capture (memorydb.js:186) |
| 3 | — | *"Session captured, no summary"* — an honest empty state |

`ask` appears nowhere in that chain.

Consequences: `pxClipSummary` and `PX_SUMMARY_MAX` lose their only caller and are
deleted along with their tests. The `title` attribute holding the full summary
for hover becomes pointless and goes too. The card needs a sensible max-width so
a wrapped 300-character summary stays readable rather than spanning the viewport.

### Adaptive blocks

| Block | Renders when |
|---|---|
| Who (avatar stack) | ≥ 2 distinct people on the project's recent entries |
| 24h sparkline | ≥ 1 session in the trailing 24 hours |
| "N new" dot | Non-self entries exist newer than `lastViewedTs` (unchanged) |
| Where you left off | The latest session has ≥ 1 non-completed todo |
| Health line | Paused, capture-stale, or memory block missing |
| Person filter | ≥ 2 people across recent entries ∪ team members |
| Show filter | ≥ 1 shared **and** ≥ 1 local project |

Removing a filter must not strand its state: when a filter stops rendering, its
`pxFilter` key resets to `All` so a hidden filter can never silently exclude
rows.

## States

- **First run / empty** — unchanged. `renderProjectsEmpty` already leads with
  discovered projects and one-click Watch (client.js:1039).
- **Dormant** (quiet ≥ `PX_DORMANT_DAYS`) and **paused** — keep collapsing to a
  single dim status line. A card that earns no space should not take any. These
  collapse *below* active cards regardless of sort.
- **Load more** — show the first `PX_CARDS_VISIBLE` (6) active cards, then a
  `Show N more projects` control that reveals the rest. Dormant and paused rows,
  being single lines, are not counted against the limit and always render.

## Data sources

Everything for blocks 1 and 2 **already reaches the client** — `feed.normalizeLocal`
whitelists `headline`, `goal`, `decisions`, `gotchas`, `tasks` (with
`items[{text, status}]`), and `files` (lib/feed.js:19-58). The index already
fetches `/api/feed?limit=100`. **No server change is required for the two
highest-value blocks.**

### Server additions required

Block 3 needs lifetime figures; `projectStats` is week-scoped
(`sessionsThisWeek`). Add to `projectsPayload` (lib/server.js:139), derived in
the loop that already walks `proj.events`:

- `sessionsTotal` — count of distinct `session` ids across all events
- `firstActivity` — earliest event `ts`

Block 4's new condition needs to know whether the managed block is actually in
the file. `targets[].exists` only reports that *the file* exists
(server.js:163). Add:

- `targets[].injected` — whether the file contains `digest.BEGIN`
  (`<!-- membridge-beta:begin -->`, digest.js:13)

**Implementation note:** the index polls every 5 seconds, so `injected` must not
read every target file on every poll. Cache the result keyed by target path +
`mtimeMs`, and re-read only when the mtime moves. `digest.BEGIN` is already
exported (digest.js:466), so no new export is needed.

### Known limitation (accepted)

`pxLatestEntry` selects from the shared `/api/feed?limit=100` window, which
spans all projects. A project quiet enough to fall out of that window shows no
headline and no todos. This is existing behavior, it is bounded by the dormant
collapse, and at 1–5 projects it is unreachable in practice. Not addressed here.

## Team continuity

The solo → team transition must be additive, never a re-layout:

- The `Create a team` footer nudge stays (client.js:1018), solo only.
- When a second person appears, the Who stack and Person filter *appear on the
  same cards* — no other change.
- Health, headline, todos and accumulation blocks are person-agnostic and are
  identical in both modes.

## Testing

`test/run-tests.js` already covers the pure, dependency-injected helpers
(`pxLatestEntry`, `pxSparkCounts`, `pxCaptureStale`, `pxPersonFilter`,
`pxClipSummary`). New logic follows the same rule — pure functions with injected
deps, tested offline:

- `pxGlanceFor(entry)` — the headline → summary → empty-state chain, asserting
  that `ask` can never be selected and that nothing is ever clipped
- `pxOpenTodos(entry, max)` — non-completed items from the latest session, capped
- `pxAccumulation(project)` — sessions total, span label, tools list
- `pxBlockMissing(project)` — any effective target present on disk without the block
- `pxVisibleFilters(projects, recent, members)` — which filters render
- `pxPaginate(projects, limit)` — active/dormant split and the load-more count

Server-side: `sessionsTotal` / `firstActivity` derivation and the mtime-keyed
`injected` cache each get a unit test.

**Two existing assertions must be inverted, not deleted** — they currently
enforce the behavior this design removes:

- `test/run-tests.js:2243` asserts the latest-session cell *is* length-capped
  (`/pxClipSummary\(/.test(rowSrc)`). It becomes the opposite: the row must not
  clip, and must not reference `ask`.
- `test/run-tests.js:2228-2235` tests `pxClipSummary` itself. Deleted with the
  function.

Per project convention, the beta is built after the implementation plan lands.

## Out of scope

- The hosted web `/projects` page (`web/app/projects/page.js`) — team-only; solo
  users never reach it.
- The first-run setup wizard and guided team-upgrade flow from the earlier
  approved solo-mode design. This page is designed to fit inside that work, not
  to deliver it.
- Any change to capture, distillation, or the team sync protocol.
