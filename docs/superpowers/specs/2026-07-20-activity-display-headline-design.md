# Activity Display: Outcome Headlines

**Date:** 2026-07-20 · **Status:** Approved

**Builds on:** `2026-07-17-outcome-led-cumulative-summaries-design.md` (distilled summaries) and the merged session-consolidation card model (`unitHtml` / `threadHtml`).

## The principle

Every card answers one question at a glance: **"What changed in our shared project reality?"** Detail is one click away. A card's headline should never be a wall of harvested AI chatter, a raw error paste, or a sentence clamped mid-word.

## Where we are now

The merge already fixed the biggest problem: the headline is distilled-only. A harvested last-message can no longer override a real distilled summary (`dashboard.js` ~2397: `t.rep = distilled; t.repHarvested = harvested`). Four gaps remain, all visible in today's feed:

| # | Symptom | Example in the feed |
|---|---------|---------------------|
| 1 | A finished run with no distilled summary still headlines with harvested prose (the agent's last chat line) before falling back to "session ended". | *"The merged trial build is running…"* |
| 2 | A live run headlines with the raw ask, unfiltered. | *"Working on: Install failed: Guru Meditation…"* |
| 3 | A distilled summary is too long to headline — no tight lead, so it clamps into mush. | *"Git identity now uses marco@melika.com everywhere (global config…"* |
| 4 | No clamp — headlines run 1–4 lines, so the feed has no scan rhythm. | — |

## The fix, in one line

Give summaries an optional one-glance **headline** field, route every card's main line through a **single picker helper** that never falls back to harvested prose, **guard live asks** against noise, and **clamp** the display.

---

## Delta 1 — add a `headline` field to distilled summaries

A new optional field alongside `goal` / `did` / `decisions` / `gotchas`: ≤ ~10 words, the outcome a teammate would read at a glance (e.g. *"Auto-approve rule added for summary appends"*). Thread it through, all backward-compatible:

- **`blockReason` (`lib/hooks.js`)** — add it to the JSON template and ask for it explicitly in the prompt.
- **`runAppend` (`lib/hooks.js`)** — optional: if present it must be a string; if absent, the line still validates. Older summaries and any that omit it are fine.
- **`scanSummaries` (`lib/scan.js`)** — carry `ev.headline` when present, exactly like `goal` / `decisions` / `gotchas`.
- **`feed.js`** — carry `headline` in both `normalizeLocal` and `normalizeTeam`, redacted like the other free-text fields.

No DB migration. Team rows pushed without a headline column simply arrive without one and fall back (Delta 2). Tight cross-teammate headlines can come later behind a migration — out of scope here.

## Delta 2 — one picker helper, used everywhere

Replace the inline three-way branch in `threadHtml` and `unitHtml` with a single `runHeadline(rep, opts)`. It resolves the main line by precedence — **first match wins**:

1. Distilled summary exists → `rep.headline`, else `firstSentence(rep.summary)`
2. Live run → `askHeadline(newest.ask)` *(Delta 3)*
3. Finished, real ask → `firstSentence(newest.ask)`
4. Nothing usable → `"session ended · no summary shared"`

**Key rule:** harvested prose (`repHarvested`) is **never** the headline. It can still exist as data and can still render inside the expander — it's just removed from the fallback chain entirely.

`firstSentence(text)` = text up to the first sentence break (`.` `!` `?` followed by a space or end-of-string), trimmed, hard-capped at ~90 chars. So even a rambling `did` or `ask` contributes only its lead clause.

## Delta 3 — guard the live ask (`askHeadline`)

Live runs currently dump the raw ask. `askHeadline(ask)` cleans it:

1. Collapse whitespace and newlines to single spaces.
2. Empty → `"Working…"`.
3. Noisy dump → `"Working…"`. **Noisy** = longer than ~120 chars after collapse, or containing stack-trace-like markers (multiple newlines, `at `, `Error`, `failed:`).
4. Otherwise → `"Working on: <ask, firstSentence-capped>"`.

The pulsing amber "Working now" label is unchanged — only the headline text is guarded.

## Delta 4 — clamp and rhythm (display only)

- Headline gets a **2-line CSS clamp**: `display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden`. The clamp handles overflow cleanly — no trailing-`…` hack.
- Compact triad stays under the headline, each subline clamped to 1 line: Intent (from `goal`) and the `decisions · gotchas` line.
- Full outcome moves into the expander: the complete `did` / `summary` (via `summaryFull` when present) renders at the top of the expanded body, above the per-run agent threads and alongside the existing changes block.

So: **headline = the glance, expander = the full story.** Card padding/height already come from `unitHtml`'s chrome; the clamp is what removes the height variance.

---

## What does NOT change

- Distilled-only primary-rep logic (already correct).
- Work-unit grouping, agent-thread expansion, the live / `STALE_GAP` rule, and card chrome from the merge.
- Summary storage/merge, beyond the one new `headline` field.
- Team push schema (no migration).

## Error handling

Every helper is pure and total: missing or empty input yields the safe placeholder (`"Working…"` or `"session ended · no summary shared"`), never `undefined` and never a throw. `runHeadline` returns text the caller escapes with the existing `esc()` — no double-escaping.

## Testing (`test/run-tests.js`)

- **`firstSentence`** — multi-sentence → first only; no punctuation → whole string, capped; empty → `""`.
- **`askHeadline`** — empty → `"Working…"`; short ask → `"Working on: <ask>"`; long/noisy (newlines, `Error`, `failed:`) → `"Working…"`.
- **`runHeadline` precedence** — distilled headline wins; distilled without headline → first sentence of summary; no distilled + live → `askHeadline`; no distilled + finished + real ask → first sentence of ask; nothing → `"session ended · no summary shared"`; a harvested-only run never yields harvested text as the headline.
- **`blockReason`** names the headline field; **`runAppend`** accepts a line with `headline` and one without (both valid) and rejects a non-string `headline`.
- **`scanSummaries` / feed** carry `headline` through — present and absent cases.

## Out of scope (YAGNI)

- A headline DB column + migration for cross-teammate tight headlines (first-sentence fallback covers it for now).
- Consecutive-duplicate collapse in the feed (separate concern; a pure-display change).
- Any restyle beyond the clamp + expander move — the calm, technical look stays.

---

## Notes

- The **precedence ladder (Delta 2)** is the heart of the doc — everything else is plumbing feeding into it.
- **Delta 1 and Delta 4 are independent** and could ship separately: Delta 4 (the clamp) works on today's data and buys the scan rhythm immediately, even before any summary carries a headline.
