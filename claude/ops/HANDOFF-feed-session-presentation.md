# Handoff: feed and session presentation

Entry point for the next chat. Written 2026-08-13 after the 0.4.0/0.4.1 cut.

Three asks from Andrew, plus findings from reading the live UI with real data.
Ordered by value, not by the order he raised them.

Companion doc: [`HANDOFF-bullet-quality.md`](./HANDOFF-bullet-quality.md) — the
root cause of the slop bullets, with evidence and verification commands. Read it
before touching anything in `distill.ts`.

---

## A. Bullet quality — ROOT CAUSE FOUND, fix not written

**One field is asked for as PROSE and rendered as BULLETS.** `lib/hooks.js` asks
`did` for *"1-2 plain-text sentences"*; the session page renders each
checkpoint's prose summary as one bullet. Long session = many checkpoints = a
list of sentences never written to be a list.

Highest-leverage fix is one line in `ui/src/features/session/distill.ts`:

```js
const pieces = raw.includes('\n') ? raw.split('\n') : raw.split(/(?<=[.!?])\s+/)
```

The newline branch is right; the sentence branch **manufactures** a list.

**Do not filter.** `decisions`/`gotchas` measure 475 points with zero junk — that
path is healthy. A filter attempt dropped `"Deploy confirmed on all three."` and
was reverted. Full detail in the companion doc.

---

## B. DAY PAGE redesign (Andrew's ask — corrected twice, now precise)

**Corrected twice.** First draft read "pillbox" as rounded chips on day-card
tags — wrong. Second draft scoped it to the SESSION page — also wrong. The
screenshot Andrew sent is the **DAY page**: `ui/src/features/feed/DayPage.tsx`,
reached from a day card, headed "‹ Back to the Feed".

That is why "it's not boxed" was correct and my earlier note was not: the boxed
`.session-widget` styling lives in `session.css` and DayPage does not use it.
DayPage sections are `.day-section` + `.day-section-title` (`feed.css:314`) —
an uppercase grey label and then content, no ground, no border, no divider.

### B1. Box the sections

`FILES TOUCHED`, `WHAT WAS DONE`, `PROMPTS` each need a visible container.
The pattern to copy already exists — `.session-widget` (`session.css:287`):

```css
background: var(--panel);
border: 1px solid var(--line);
border-radius: var(--r);
```

Existing tokens, existing pattern, no new design decision and no radius-rule
conflict.

### B2. A stat strip at the top — NEW, does not exist today

`grep -c "StatStrip|day-stats" DayPage.tsx` → **0**. The day page has no stats
at all. Andrew wants a widget row at the top carrying:

| Stat | Source |
|---|---|
| Sessions that day | `day.sessions.length` — already on the model |
| Files touched | already computed for the FILES TOUCHED section |
| Commits | `lib/commits.js` exists; check what it exposes per day |
| Lines added / removed | **verify this is captured at all** — the SESSION page renders `LINES  not captured`, which suggests it may not be |

`ui/src/components/StatStrip.tsx` already exists (used elsewhere) — reuse it
rather than inventing a second stat row.

**Do the lines/commits availability check FIRST.** If the data is not captured,
this is a capture-side change, not a UI one, and the estimate changes completely.
Do not ship tiles that say "not captured" — that is the exact noise D-below
complains about on the session page.

### B3. File names white, not grey

`.day-file-name` is `color: var(--text2)` (`feed.css:346`). Andrew wants the
brighter token — `var(--text)`. One line. The filename is the content of that
section, not a label, so it should carry content weight.

### B4. Prompts must not auto-expand

Today `.day-prompts` renders every prompt inline under each session
(`DayPage.tsx:116-120`), which is how the raw prompts end up dominating the
page. Fold them into a collapsed disclosure — `<details>`/`<summary>`, the same
native pattern `session-widget` uses, closed by default, labelled with the
count.

This pairs with D1: prompts stop being the face of the page but stay one click
away for whoever wants them.

## C. Session-page area headers — SHIPPED, with a caveat

Merged (`7d11e64`) and in 0.4.1. Groups the "What" widget under `[Area]`
headings from an eight-value vocabulary in `lib/hooks.js`
(`Data/Schema, Build/CI, Tests, Docs, UI/UX, Integrations, Config, Backend`).

**Two things the next chat must know:**

1. **Headers only appear on sessions captured AFTER 0.4.1 is installed.** The
   parser reads a prefix the hook writes at capture time. Existing sessions have
   no prefix and render flat — the code calls this "intended degradation, not a
   gap". Nothing retroactive is possible without re-deriving areas from files.
2. **Grouping engages only at 4+ points across 2+ areas** (`GROUP_MIN_POINTS`,
   `GROUP_MIN_AREAS`). Below that it stays flat deliberately.

Day-card area **tags** are different and DO work retroactively — they derive
from file paths, not from the agent. Verified live: `Tests`/`Backend` on today,
`UI/UX`/`Docs`/`Data/Schema` on 08-12.

---

## D. Further upgrades found while reading the live UI

Not asked for. Ranked by how much they undermine the product's own pitch.

### D1. Raw prompts on the card face — DECIDED, substitute tool usage

`card.intent` renders the user's actual prompt on the day card. Observed live on
the shared feed: *"holy shit u gotta figure this out."* and *"need better data to
be captured tha this."*

**Andrew's decision (2026-08-13): take the raw prompt off the card face.** For a
product whose pitch is shared memory, a teammate's frustration or half-formed
thought becoming a card in everyone's feed is a trust problem — and
`team.sharePrompts` (`off` / `distilled` / `verbatim`) already exists to control
exactly this. Check whether the card honours that setting; if it renders the raw
prompt while the setting says `distilled`, that is a privacy defect, not polish.

**Substitute: tool usage (Claude Code / Codex).** The data is already on the
model — no new capture, no new endpoint:

- `DaySession.tool: string` (`dayCards.ts:606`), one per session in the day
- `FeedEntry.tools: string[]` (`mappers.ts:27`, from `row.tools`)

So the card can render e.g. `Claude Code · Codex`, or counts per tool
(`Claude Code 8 · Codex 2`). This also strengthens the product's own story —
"your tools share memory" is better evidenced by naming which tools were used
that day than by quoting what someone typed.

**DECIDED 2026-08-13: names WITH counts** — `Claude Code 8 · Codex 2`. Note this
overlaps the `2 sessions · 7 files` stat line and the new B2 strip; when B2
lands, check the card is not saying the same thing twice.

### D2. Summaries are semicolon-joined

Observed: *"Shipped member self-rename and avatars, then staged the 0.4.0
release; Shipped 0.4.0 to all channels, fixed two bugs the release exposed"* —
two separate session summaries mashed with `; `. Reads as one run-on sentence.
Same family as the bullet problem: joining prose that was written separately.
Either pick the most significant, or render them as distinct lines.

### D3. Low-signal cards say nothing

*"No summary yet for this day."* followed by a raw prompt as the only content.
A card with nothing to say should either be collapsed or omitted, not given the
same weight as a day with real work.

### D4. Coverage notes are written in implementation terms

*"3 more sessions not shown; showing only the part of this day that has loaded"*
explains the fetch loop to the user. The Insights banner had exactly this
problem and was rewritten (see queue.md, 2026-08-08 "Insights coverage copy").
Same fix, same reasoning, one screen over.

### D5. Stale team membership presents as fact

`state.teamCounts` is cached and never reconciled against the backend. Observed:
Settings said *"MemBridge Team · You are the Member · 2 members"* while the
backend had **zero** membership rows for that account. The only symptom was a
line in the daemon log (`team push paused — no team key`). A removed member's
machine keeps presenting as on-a-team. Same failure family this release fixed
elsewhere: **a local success flag outliving the server state it claims.**

---

## Verification corpus

Both one-liners were used 2026-08-13. Any candidate filter or parser change
should be measured against these before it ships:

- `.membridge/summaries.jsonl` — `decisions` + `gotchas`, split on `\n` → **475 points, all clean**
- `.membridge/memory.json` — `summary`, split on sentence boundaries → **128 points, ~23% contentless**

A rule that drops anything from the first set is wrong.

---

## E. The release process puts master red ON PURPOSE, and it emails you

Raised by Andrew mid-cut: *"three emails in the past minute."* He is right to be
annoyed, and this is a process defect, not noise to tolerate.

**The mechanism.** `docs/releasing-macos.md` step 2 bumps the version and pushes.
That push makes `install-integrity` fail — manifests say the new version,
`scripts/install/install.sh` still pins the old one. Step 3 stamps the installer
and turns it green. The doc says so outright: *"Do not try to make this push
green — the next step fixes it."*

The red is unavoidable **in that order**, because the installer pin can only be
stamped from the built artifact, and the artifact only exists after the bump is
pushed. Signed macOS builds are not byte-reproducible, so the SHA cannot be
predicted.

**But the order is not forced.** Cut the release on a branch:

1. branch, bump, push the branch — the branch goes red, master stays green
2. wait for `build-app` on the branch, stamp `install.sh` from its artifact
3. push the stamp; the branch goes green
4. **merge one green commit to master**, then tag

Master never goes red, and nobody gets a failure email for a state the process
created deliberately. Every trap in the current doc still applies — this only
changes where the intermediate red lives.

Worth doing before the next cut. It cost real trust this time.
