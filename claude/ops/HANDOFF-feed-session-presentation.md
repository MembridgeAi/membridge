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

## B. Section boxing on the SESSION page (Andrew's ask — corrected)

**Corrected 2026-08-13.** An earlier draft of this doc read "pillbox" as rounded
chips on the day-card area tags. That was wrong. Andrew means **boxing the
sections** — `FILES TOUCHED`, `INTENT`, `WHAT WAS DONE`, `PROMPTS` — so the
dividers between them are visible and the page stops reading as one column.

### What is already boxed, and what is not

`.session-widget` (`session.css:287`) ALREADY has `background: var(--panel)`,
`border: 1px solid var(--line)`, `border-radius: var(--r)`. So the collapsible
widgets (`WHAT WAS DONE`, `PROMPTS`) are boxed.

**The unboxed parts are the top of the page:**

- the stat strip — `FILES TOUCHED` / `LINES` / `COMMITS` / `DURATION`
- the `INTENT` block
- the summary paragraph under it

Those three run together with no ground or rule between them, which is what
makes the page feel undivided. Give them the same `--panel` + `--line`
treatment the widgets already have, and the page becomes four obvious blocks.

**No radius-rule conflict.** `--r` is the app's normal radius and the widgets
already use it. This is applying an existing pattern, not adding an exception.
(The avatars-are-the-only-circle rule is about `border-radius: 50%`/pills, which
this does not need.)

### While in there — two things visible in the same strip

- `LINES  not captured` and `COMMITS  not captured` render as full stat tiles
  with no value. Two of four tiles saying "not captured" is worse than three
  tiles. Either hide an uncaptured stat or fold them into one line.
- The header renders `MemBridge 0.4.` — a truncated version string. Looks like
  a clip that cut mid-token. Worth a look.

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

Open question for the next chat: tool NAMES only, or names with session counts?
Counts are more informative but compete with the existing `2 sessions · 7 files`
stat line, which may then be redundant.

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
