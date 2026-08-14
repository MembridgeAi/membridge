# Handoff: why the session bullets read as slop

Written 2026-08-13, at the end of the 0.4.0/0.4.1 cut. Andrew's words: "they've
consistently just been the literal outputs, or just slop. hardly any of them are
properly distilled."

He is right, and the cause is **not** that the agent writes badly. It is a
specification mismatch that no amount of prompt-tuning will close.

---

## The finding, in one sentence

**One field is specified as PROSE and rendered as BULLETS.**

`lib/hooks.js` asks for `did` as *"1-2 plain-text sentences"*. Every Stop-hook
checkpoint writes one. `ui/src/features/session/distill.ts`'s
`distilledBullets()` then renders **each checkpoint's prose summary as one
bullet in a list**. A long session is many checkpoints, so the "What was done"
widget becomes a list of prose sentences that were never written to be a list.

That is where every observed symptom comes from.

## Evidence

Traced 2026-08-13 against the live corpus.

- `lib/server.js:1378` — `checkpoints = digest.sessionSummaries(events, id)`
- `lib/digest.js:581` — `sessionSummaries` returns `kind === 'summary'` events;
  their `.text` is the checkpoint summary
- `ui/.../distill.ts` `distilledBullets()` — `for (const c of checkpoints) push(c.text)`
- `lib/hooks.js:272` — the ask: `did: 1-2 plain-text sentences`

So: prose in, bullets out. Nothing in between converts one to the other.

## The two widgets are NOT the same, and only one is broken

This matters and cost time to establish:

| Widget | Source | Quality in the real corpus |
|---|---|---|
| `whatGroups()` | `decisions` + `gotchas` | **475 points, 0 junk** — genuinely good |
| `distilledBullets()` | `checkpoints[].text` (prose) | the slop Andrew is seeing |

`decisions`/`gotchas` are asked for as *"SHORT BULLETS, one per line, each line
ONE completed piece of work"* — and the agent complies. Those bullets are good.
Measured: every one of 475 carries a specific referent.

**Do not "fix" the decisions/gotchas path. It is not broken.** An earlier
attempt at a junk filter dropped `"Deploy confirmed on all three."` and
`"Four lanes done, all merge-ready."` — real content — and was reverted.

## Symptom catalogue, with the mechanism for each

Sampled from `.membridge/memory.json`, 128 summary-derived points:

| Symptom | Example | Mechanism |
|---|---|---|
| Contentless lead-in | `Ran the check.` | first sentence of a 2-sentence prose summary, split out alone |
| Same | `Stopped.` `All clear.` `No blockers.` `Tree clean.` | ditto |
| Pasted command | `ELECTRON_RUN_AS_NODE=1 "/Applications/…"` | agent quoted a command inside prose; rendered as a "point" |
| Truncation fragment | `It also f…` `So …` `My shortened wordin…` | prose clipped mid-word, fragment emitted as its own bullet |

Note the lead-ins are not wrong — `"Ran the check. Zero duplicates across all
teams — 057 applies clean."` is a good sentence. Cutting it in two orphans the
clause that carried the information.

## Fix options, most-leverage first

### 1. Stop fabricating a list from prose (recommended)

`splitPoints()` currently does:

```js
const pieces = raw.includes('\n') ? raw.split('\n') : raw.split(/(?<=[.!?])\s+/)
```

The newline branch is right — the writer made a list. **The sentence branch
manufactures one.** Options:

- render a no-newline field as a paragraph, not a list; or
- keep it one point (do not split), letting the clip handle length.

The file's own header already argues this direction: *"no renderer can shorten
a paragraph without hiding something… the only place a paragraph can be
prevented is the ask."*

### 2. Do not render `distilledBullets()` as bullets at all

The checkpoint trail is a chronological prose narrative. Consider rendering it
as a timeline of sentences rather than a bulleted list, which is what it is.

### 3. Write-time validation in the hook

The ask is already excellent (it says *"never a description of your process"*
and gives a good/bad example pair). What is missing is a **gate**: the hook
accepts whatever comes back. Reject and re-ask when a point is contentless
(no digit, path, identifier or backtick, under ~40 chars) or is a shell
command (`^[A-Z_]+=` or a bare absolute path).

Caution: measure any rule against the real corpus first. `.membridge/summaries.jsonl`
and `.membridge/memory.json` are the corpus; a rule with false positives
silently deletes real work.

### 4. Fix mid-word truncation

`It also f…` should never reach a renderer. Clip at a word boundary and drop a
fragment that has no verb rather than emitting it.

## How to verify a fix

```bash
# every decisions/gotchas point — expect ~0 dropped by any new filter
node -e "…read .membridge/summaries.jsonl, split decisions+gotchas on \n…"
# every summary-derived point — this is where the slop lives
node -e "…read .membridge/memory.json, split summary on sentence boundaries…"
```

Both one-liners were used on 2026-08-13; 475 points and 128 points respectively.
A candidate rule that drops anything from the first set is wrong.

## What is NOT the problem

- The hook's instruction text. It is specific, has a worked good/bad example,
  and the agent follows it for `decisions`/`gotchas`.
- The area-prefix work (shipped 0.4.1). Orthogonal — it groups points, it does
  not judge them.
- Model capability. The same model writes good `decisions` and prose `did` in
  the same call, because that is what each field asked for.
