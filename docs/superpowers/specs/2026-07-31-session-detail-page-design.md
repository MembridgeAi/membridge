# Session Detail Page: hover preview, clean route, brief widgets, prompt chain

**Date:** 2026-07-31
**Status:** Approved design (Andrew, from mock `session-page-v2.html`)
**Applies to:** the React/TS dashboard in `ui/` (NOT the retired `lib/dashboard/client.js`)
**Builds on:** `ui/src/features/feed/FeedPage.tsx`, `ui/src/components/EntryRow.tsx`, `ui/src/data/{types,mappers,queries,DataClient}.ts`, `lib/server.js` `/api/feed`, `lib/feed.js` `normalizeLocal`

## Problem

A feed row is a dead end. It shows an outcome line, an INTENT line, and a file list, and that is the whole of it — there is nowhere to click and nothing deeper to read. Meanwhile every session already carries, and the daemon already ships, the material a teammate actually needs: the reasoning (`decisions`), the pitfalls (`gotchas`), the annotated key files (`changes[].note`), the per-file diffstat, the checkpoint trail, and every prompt in the session. `ui/src/data/types.ts`'s `RawFeedEntry` declares 15 fields; `lib/feed.js` `normalizeLocal` emits `summaryFull`, `decisions`, `gotchas`, `changes[]` and `tasks` on top of those. **The UI is throwing away most of the brief before it renders.**

Two consequences Andrew hit directly:

- Catching up on a teammate means reading a one-line outcome and guessing.
- INTENT reads as the raw prompt. `mappers.ts intentOf` is `goal ?? ask`, so any session whose agent did not write a `goal` falls back to the verbatim prompt — and `goal` itself has no length budget at capture time (unlike `headline`, which `lib/hooks.js runAppend` hard-rejects over 80 chars). A 10-person team produces ten paragraphs where it should produce ten phrases.

## The model

Three levels of disclosure, one new route, no new persistence.

**Level 1 — the feed row (unchanged height, now a link).** `EntryRow` keeps its current anatomy: avatar, `author · tool · project · relative time`, live dot or clock on the right, outcome, INTENT, files. Two changes only: the whole row becomes the navigation target for the new session route, and the row gains an affordance (`›`) marking it as such.

**Level 1.5 — hover preview.** Hovering a feed row (pointer devices, `hover: hover` media query only) raises a small card after a 400ms delay containing exactly: the full outcome (`summaryFull`, unclipped), the first line of `decisions`, and the file count with diffstat. It is *preview, not navigation* — nothing in it is clickable, it dismisses on pointer-leave or `Escape`, and it never appears on touch or keyboard focus. Its job is to answer "is this worth opening" without a round trip.

**Level 2 — the session page** (`/sessions/:sessionId`, new route). Top to bottom:

1. **Header** — a 1–2 sentence summary (`summaryFull`, capped at 2 sentences), NOT the 80-char headline. Above it, a mono eyebrow: `Session · finished 2d ago · 3h 12m` (or `Session · live` with the pulsing dot).
2. **Intent** — directly under the header, same `Intent`-labelled row as the feed uses.
3. **Meta row** — avatar, author, tool pill, project (mono), absolute start→end local time, prompt count. Same tokens as `EntryRow`'s meta.
4. **Widgets** — collapsible `<details>` cards, fixed order: **Why** (`decisions`) → **Watch out** (`gotchas`) → **Key files** (`changes[]` entries carrying a `note`) → **Changes** (all `changes[]`, with `+add −del`) → **Checkpoints** (the session's ordered checkpoint texts). Why and Watch out are open by default; the rest are closed with a one-line truncated peek in the summary row so the reader can judge without opening.
5. **Prompt chain** — every prompt in the session, **newest first**, on a left-ruled timeline. Each row: index, local clock time, the verbatim ask in italic, plus that prompt's files as mono chips. A checkpoint that landed after a prompt renders beneath it as an accent-ruled block.

## Locked decisions (do not relitigate)

- **A widget with no captured content does not render.** No "(not captured)" placeholder rows. This is the resolution of the empty-state question: absence is communicated by absence.
- **Widget order is fixed** across every session so the page reads the same every time. Only open/closed state varies.
- **The prompt chain shows the newest 5, then a `Show older prompts` button** that reveals the next 25 per press. A 200-prompt session must open instantly.
- **Nothing expands inside the feed.** The feed row's height is invariant. This is the whole reason the design routes instead of accordions.
- **The header is `summaryFull`, not `headline`.** `headline` stays the feed row's outcome line.
- **Hover preview is pointer-only.** Never on focus, never on touch — a keyboard user gets the route, which is the real content anyway.

## Data: what exists, what must change

**Already shipped by the daemon, dropped by the UI** (`lib/feed.js normalizeLocal` → `/api/feed`): `summaryFull`, `decisions`, `gotchas`, `changes[] ({file, status, add, del, note, dep})`, `tasks`. Widening `RawFeedEntry` and `StreamEntry` to carry these is a **type + mapper change only** — no daemon, server, or schema work.

**Not available and required: the session's prompt chain and checkpoint trail.** `/api/feed` returns page-sliced, checkpoint-collapsed entries (`mappers.ts collapseSessionCheckpoints` discards all but the newest checkpoint per session). Reconstructing a session from whatever pages happen to be loaded is wrong: it silently truncates any session older than the loaded window and produces a different page depending on how far the reader had scrolled.

→ **New endpoint `GET /api/session?id=<sessionId>`** in `lib/server.js`, returning one session assembled from `memorydb.buildEntries` for the owning project, unsliced and uncollapsed:

```
{ session, project, projectPath, author, authorId, source, startedAt, endedAt, live,
  summary, summaryFull, goal, headline, decisions, gotchas, files[], changes[],
  checkpoints: [{ ts, text }],
  prompts:     [{ ts, ask, files[] }] }     // newest-first
}
```

Redaction runs on the same `digest.redactText` closure `/api/feed` uses — a session page must never surface a secret the feed suppressed. Team-origin sessions return prompts as `null` where the author did not share them (the existing `(prompt not shared)` contract); the endpoint never fabricates a prompt it does not hold.

## Capture-side fix (in scope, small)

The header can only be 1–2 sentences if the captured text is. Two budgets in `lib/hooks.js`, enforced the way `HEADLINE_MAX` already is:

- **`goal` — new cap ~70 characters,** rejected loudly by `runAppend` with a message telling the agent to write the intent in its own words rather than restate the prompt. `blockReason` and the AGENTS.md instruction in `lib/digest.js` both get the budget added. This is the actual fix for "INTENT is just the prompt."
- **`did` — tighten the ask from "1-3 sentences" to "1-2 sentences"** in `blockReason`. Not rejected (too blunt for prose), but asked for and clipped at render.

Both are backward compatible: existing over-long lines already on disk still render, clipped at display.

## What does NOT change

- `EntryRow`'s anatomy, the feed's filters, `groupByDay`, `dayLabel`, pagination, and `collapseSessionCheckpoints` — all untouched.
- The `live` flag stays daemon-stamped (`lib/feed.js` against `util.LIVE_WINDOW_MS`); the UI does not recompute it. **The stale-`live` bug reported alongside this work is a daemon timestamp defect and is explicitly out of scope here** — do not "fix" it in the UI by recomputing.
- No change to team sync, encryption, memory.md, the context block, or Copy-for-AI.
- `ProjectPage` continues to use `EntryRow` and inherits the routing change for free.

## Error handling

- Unknown / evicted `sessionId` → the page renders a plain "This session isn't in memory anymore" state with a Feed link. Never a blank screen, never a thrown boundary.
- `/api/session` unreachable → the same error affordance `FeedPage` uses (`role="alert"`, retry via react-query), not a redirect.
- A session with zero prompts (bare plumbing rows, `session: null`) is not linkable: those rows keep today's non-interactive behavior.
- `changes[]` present but empty, or `notes` absent → the Key files widget does not render; the Changes widget still does if there are files.
- Clock skew / unparseable `ts` → duration line omitted rather than rendering `NaN`.

## Accessibility

- The row is a real link (`<a>` with an href to the route), not a click handler on a div — middle-click and ⌘-click must open a session in a new window in the Electron shell.
- Widgets are native `<details>/<summary>`: keyboard and screen-reader behavior for free.
- Hover preview is `aria-hidden` and never focusable; all of its content exists on the page it previews.
- Live dot keeps its existing `role="img"` + `aria-label="Live"`.

## Testing (`vitest` + Testing Library, `ui/`)

- `mappers`: widened `StreamEntry` carries `decisions`/`gotchas`/`changes`/`summaryFull`; absent fields map to `null`/`[]`, never `undefined`.
- `intentOf` unchanged (`goal ?? ask`) — assert the existing behavior still holds after the `goal` cap lands.
- `SessionPage`: header renders `summaryFull` clipped to 2 sentences; widgets render in the fixed order; **a widget with empty content is absent from the DOM** (assert absence, this is the locked empty-state rule); Why/Watch out open by default and the rest closed.
- Prompt chain: newest-first order asserted on times; exactly 5 rendered initially; `Show older prompts` reveals 25 more; a checkpoint renders under the prompt it followed.
- Routing: a feed row is an `<a>` to `/sessions/:id`; clicking navigates; an unknown id renders the not-in-memory state.
- Hover: preview appears after the delay under `hover: hover`, is `aria-hidden`, does not appear on focus, dismisses on `Escape`.
- `LocalDaemonClient.contract.test`: `/api/session` shape, including the `prompts: null` unshared-team case.
- Daemon side (`test/run-tests.js`): `runAppend` rejects a `goal` over the cap with an actionable message; accepts at the boundary; existing `headline` checks untouched.
