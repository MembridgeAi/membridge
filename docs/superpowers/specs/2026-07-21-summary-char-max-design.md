# Summary character max — design

Date: 2026-07-21
Status: approved (user-directed: "there needs to be a character max so the summary
never gets cut off. the hook should ask for a summary in x amount of characters
and then can go longer once clicked in")

## Problem

The collapsed Activity card's glance line can get visually cut off. The Stop-hook
prompt asks for `headline: ≤10 words` — a word count, not a character bound — and
nothing enforces even that. When the headline is missing, the card falls back to
the summary's first sentence hard-cut at 90 chars with `…`. Either way the user
sees truncated text on the card.

## Decision

Bound the glance line at capture time, not render time. The hook asks for the
headline within a hard character max and the append command enforces it; the
longer `did` text is already one click away in the card expander (`summaryFull`),
which satisfies "can go longer once clicked in" with no new UI.

## Contract

- `HEADLINE_MAX = 80` (characters), exported from `lib/hooks.js` — single source
  of truth for prompt and validation.
- `blockReason` prompt: headline must be at most 80 characters, stated with the
  rationale (renders verbatim on a card, never truncated) and a pointer that
  anything longer belongs in `did`.
- `runAppend` validation: a present headline whose trimmed length exceeds 80
  fails loudly with the actual length, the limit, and what to do. The agent
  corrects and retries inside its summary turn — the same loud-failure loop the
  quoting rule already uses. Nothing is written on rejection.
- Display: the client's glance-line cap (90 chars, word-boundary + `…`) now also
  applies to headlines, so legacy or teammate rows captured before this change
  degrade gracefully instead of hitting the CSS line clamp mid-word. Compliant
  headlines (≤80) pass through every display path untouched.

## Why 80

The card headline renders at 15px in the main column (~85 chars/line on
desktop): 80 fits on one line, never triggers the 2-line CSS clamp, and sits
under the client's 90-char display guard so enforcement and display never fight.

## Alternatives considered

- Display-only trimming: still shows `…` on cards; doesn't change what the
  agent writes, which is what the user asked for.
- Silent truncation at append time: machine-chopped text mid-thought is worse
  than the model writing to fit; loud failure lets the model rewrite.

## Out of scope

- `did` / `goal` / `decisions` lengths (already clipped at 300/160/240 for team
  push; full text stays in the expander).
- Harvested (non-distilled) summaries — no headline field; they keep the
  first-sentence fallback.

## Testing

- `blockReason` states the character limit; the old word-count phrasing is gone.
- `runAppend` accepts an 80-char headline, rejects 81 loudly (length + limit in
  the message, nothing written).
- `hooks.HEADLINE_MAX` exported and equal to 80.
- Client `runHeadline` passes an 80-char headline through verbatim and caps a
  legacy 200-char headline at a word boundary with `…`.
