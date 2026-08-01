# Session Detail Page: Implementation Plan (light workflow)

> **For agentic workers:** single implementer per task + **ONE final whole-branch review**. This is UI on top of data the daemon already produces. Match rigor to risk. Use `superpowers:executing-plans` (single-agent, TDD), not the full adversarial review loop. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A feed row previews on hover and routes to a session page: 1–2 sentence header, Intent, meta row, five collapsible brief widgets, and the full prompt chain newest-first, per [the spec](../specs/2026-07-31-session-detail-page-design.md).

**Architecture:** New `/api/session` endpoint in `lib/server.js` assembling one unsliced, uncollapsed session from `memorydb.buildEntries`. New `ui/src/features/session/` feature (page + widgets + chain). `RawFeedEntry`/`StreamEntry` widened to carry the brief fields `lib/feed.js` already emits. `EntryRow` becomes a link. Capture budgets added to `lib/hooks.js`.

**Tech stack:** Daemon is plain Node, tested by the custom harness `test/run-tests.js` (`node test/run-tests.js`). UI is React 19 + TS + wouter + react-query under `ui/`, tested by vitest + Testing Library (`cd ui && npm test`). **First: run BOTH suites on a fresh branch and record the real baselines. Do not assume any number.**

**Conventions:** commit `<type>: <description>`, no footer. TDD: failing test first, run it, see it fail, then implement. Route paths come from `ui/src/app/routes.ts`. Never write a path literal twice. Styles go in the feature's own `.css` using `styles/tokens.css` variables; no inline style objects, no hardcoded hex.

**Locked (do not relitigate):** empty widget = absent from the DOM, no placeholder; widget order Why → Watch out → Key files → Changes → Checkpoints; Why + Watch out open by default; prompt chain newest-first, 5 then +25 per press; nothing expands inside the feed; header is `summaryFull` (2 sentences), not `headline`; hover preview is pointer-only and never focusable; the stale-`live` bug is OUT OF SCOPE (do not recompute `live` in the UI).

---

## Task 0: branch baselines
**Files:** none.
- [ ] Branch from current master. Run `node test/run-tests.js` and `cd ui && npm test`; record both real baseline counts in the branch's first commit message.

## Task 1: `GET /api/session` in the daemon
**Files:** `lib/server.js`, `test/run-tests.js`.
- [ ] **Failing tests:** the endpoint returns the spec's shape for a known session id, with `prompts` newest-first and NOT collapsed, `checkpoints` oldest-first, `startedAt`/`endedAt` from the session's extreme timestamps; free-text fields pass through the same `digest.redactText` closure `/api/feed` uses (assert a planted `sk-` value is scrubbed in `summaryFull` AND in a prompt); an unknown id returns 404 with a JSON body, never a 500; a team-origin unshared prompt comes back `null`, never a fabricated string.
- [ ] Run → expect FAIL.
- [ ] Implement: resolve the owning project from the session id across `state.projects`, call `memorydb.buildEntries` for it with no slice, assemble the payload. Reuse `digest.pickSummary` for the settled summary and `digest.sessionSummaries` for the ordered checkpoint trail. Do NOT re-derive either. Register beside `/api/feed` (`lib/server.js:1658`).
- [ ] Run → green + full suite. Commit: `feat(server): /api/session returns one uncollapsed session`.

## Task 2: widen the UI's feed types to the fields the daemon already sends
**Files:** `ui/src/data/types.ts`, `ui/src/data/mappers.ts`, `ui/src/data/mappers.test.ts`.
- [ ] **Failing tests:** `toStreamEntry` carries `summaryFull`, `decisions`, `gotchas`, `changes[]`; absent fields become `null` / `[]` and never `undefined`; `intentOf` and `outcomeOf` behave exactly as before (assert the existing cases still pass; this task must be additive).
- [ ] Run → expect FAIL.
- [ ] Implement: add the fields to `RawFeedEntry` and `StreamEntry` and map them. No component reads them yet.
- [ ] Run → green + full suite. Commit: `feat(ui): carry the brief fields the daemon already ships`.

## Task 3: the session route + data client
**Files:** `ui/src/app/routes.ts`, `ui/src/app/App.tsx`, `ui/src/data/{types,DataClient,LocalDaemonClient,FakeDataClient,queries}.ts`, `ui/src/data/LocalDaemonClient.contract.test.ts`, `ui/src/features/session/SessionPage.tsx`, `ui/src/features/session/SessionPage.test.tsx`.
- [ ] **Failing tests:** `ROUTES.session === '/sessions/:sessionId'` and the app renders `SessionPage` at it; `useSession(id)` calls `/api/session?id=`; the contract test asserts the Task-1 payload shape including `prompts: null`; an unknown id renders the "isn't in memory anymore" state with a Feed link; a fetch failure renders a `role="alert"` error, not a redirect.
- [ ] Run → expect FAIL.
- [ ] Implement: add the route, a `Session` type, the client method on both `LocalDaemonClient` and `FakeDataClient` (fake data must include one live session, one finished, one with empty `decisions`/`gotchas`, and one 60-prompt session), the `useSession` query, and a `SessionPage` stub rendering only the header + Intent + meta row.
- [ ] Run → green + both suites. Commit: `feat(ui): /sessions/:id route, session query, page shell`.

## Task 4: the brief widgets
**Files:** `ui/src/features/session/BriefWidgets.tsx`, `ui/src/features/session/session.css`, `ui/src/features/session/SessionPage.tsx`, tests alongside.
- [ ] **Failing tests:** widgets render in the fixed order Why → Watch out → Key files → Changes → Checkpoints; **a widget whose content is empty is ABSENT from the DOM** (query by name, assert null; this is the locked empty-state rule); Why and Watch out have the `open` attribute, the other three do not; a closed widget's summary row shows a truncated one-line peek; Key files renders only `changes[]` entries carrying a `note`; Changes renders `+add −del` per file; Checkpoints renders the trail oldest-first.
- [ ] Run → expect FAIL.
- [ ] Implement with native `<details>/<summary>`. All styling via `session.css` + `tokens.css` vars.
- [ ] Run → green + suite. Commit: `feat(ui): session brief widgets`.

## Task 5: the prompt chain
**Files:** `ui/src/features/session/PromptChain.tsx`, `session.css`, tests alongside.
- [ ] **Failing tests:** prompts render newest-first (assert on rendered times, not array order); exactly 5 rows initially; `Show older prompts` reveals 25 more and disappears at the end; a checkpoint renders beneath the prompt it followed; an unshared prompt renders `(prompt not shared)`; a 60-prompt fixture renders 5 rows on first paint.
- [ ] Run → expect FAIL.
- [ ] Implement the left-ruled timeline: index, local clock time (`localTime.ts` helpers, never UTC), verbatim ask, per-prompt file chips.
- [ ] Run → green + suite. Commit: `feat(ui): prompt chain, newest-first, paged 5 + 25`.

## Task 6: feed row → link, plus the hover preview
**Files:** `ui/src/components/EntryRow.tsx`, `ui/src/components/components.css`, `ui/src/components/EntryRow.test.tsx`, `ui/src/features/feed/FeedPage.test.tsx`.
- [ ] **Failing tests:** a row with a `session` renders an `<a>` whose href is the session route built from `ROUTES`; a row with `session: null` renders no link and keeps today's markup; the row's height/anatomy is otherwise unchanged (assert the existing EntryRow assertions still pass verbatim); hover shows the preview after the delay, the preview is `aria-hidden`, focus does NOT show it, `Escape` dismisses it; `ProjectPage` rows inherit the link with no change to `ProjectPage.tsx`.
- [ ] Run → expect FAIL.
- [ ] Implement. Gate the preview behind a `hover: hover` media query in CSS, not a JS device sniff.
- [ ] Run → green + suite. Commit: `feat(ui): feed rows link to their session, with a hover preview`.

## Task 7: capture budgets for `goal` and `did`
**Files:** `lib/hooks.js`, `lib/digest.js`, `test/run-tests.js`.
- [ ] **Failing tests:** `runAppend` rejects a `goal` over the cap with a message telling the agent to write the intent in its own words rather than restate the prompt; accepts exactly at the boundary; a line with no `goal` is still accepted (the field stays optional); the existing `headline` cap checks are untouched and still pass.
- [ ] Run → expect FAIL.
- [ ] Implement: `GOAL_MAX` beside `HEADLINE_MAX`, enforced in `runAppend`; state the budget in `blockReason` and in the AGENTS.md instruction in `lib/digest.js`; change `did`'s ask from "1-3 sentences" to "1-2 sentences" (asked for, not rejected).
- [ ] Run → green + full suite. Commit: `feat(hooks): budget goal, tighten did to two sentences`.

## Final review (one pass)
- [ ] One whole-branch review against the spec: locked decisions honored (empty widget absent, fixed order, 5+25 chain, nothing expands in the feed, `live` untouched); no pre-existing test modified to pass; redaction on every new free-text surface; no hardcoded route strings or hex values.
- [ ] Human pass with the real daemon: open a session with full fields, one with empty `decisions`/`gotchas`, one live, and one long session; ⌘-click a row; keyboard-tab the whole page; toggle dark/light.

## Self-review
- Spec "hover preview → clean route" → Tasks 3, 6. "widgets" → Task 4. "prompt chain newest-first, collapse after 5" → Task 5. "1–2 sentence header + intent fix" → Tasks 3, 7. "no daemon change for widgets" → proven by Task 2 being types-only.
- Out of scope and deliberately untouched: the stale-`live` / wrong-timestamp defect (daemon-side, separate fix), the projects-tab work, analytics.
- Delegated (flagged): the exact hover-preview delay and offset. Tune against the real app; the assertions above stay as written.
