# Scope — #39, Codex capture via a SessionEnd hook

**Status:** scoped, not started. Assigned here after the b721 run recorded #39
as "yours to scope" (Hook/research, 2026-08-06).

**Read the ceiling section before estimating.** The honest answer to "make
Codex capture as good as Claude Code" is that it cannot be done with a hook,
and the reason is structural rather than a matter of effort.

---

## 1. What was wrong with the original premise

The b721 diagnostic (`phase2/hook-diagnostic.md` Part 2) concluded **"Codex has
no Stop-hook equivalent."** That is false, and it has been retracted upstream.

Codex ships eleven hook events. Every claim below is from
`learn.chatgpt.com/docs/hooks`, fetched 2026-08-06:

| | |
|---|---|
| Registration | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, or a `[hooks]` table in either `config.toml` |
| Events | `SessionStart` `SessionEnd` `PreToolUse` `PostToolUse` `PermissionRequest` `PreCompact` `PostCompact` `UserPromptSubmit` `SubagentStart` `SubagentStop` `Stop` |
| `SessionEnd` payload | `session_id`, `transcript_path` (**may be null**), `cwd`, `hook_event_name`, `reason` |
| Timeout | **1 second** default, **3 seconds** maximum |
| Can it block? | **No.** "SessionEnd hooks are advisory. Their output won't steer Codex or keep the thread open." |

The evidence the diagnostic actually had was all evidence about *this repo* —
MemBridge registers nothing Codex-side, `lib/adapters/codex.js` has no
registration path, `~/.claude/settings.json` is Claude-Code-only. All true.
**None of it is evidence about what Codex offers.** Worth remembering when
scoping the rest of this ticket: the same shape may be present elsewhere.

---

## 2. The ceiling, which decides whether this is worth doing

**A SessionEnd hook cannot produce a model-authored summary.** Three
independent reasons, each sufficient on its own:

1. **It cannot block.** Claude Code's entire distillation mechanism is that the
   Stop hook *blocks the stop* and asks the model to append a JSON line before
   it is allowed to finish. SessionEnd runs after the session is over. There is
   no model still listening.
2. **1 second.** Even if it could steer, nothing involving a model round-trip
   fits. The hook's only viable shape is fire-and-forget.
3. **The daemon has no model of its own.** `lib/advisor.js` exists and can call
   Anthropic or OpenAI — but it is **BYOK, opt-in, and wired only to roadmap
   and briefing generation** (`generatePlan`, `generateBriefing`). Nothing in
   `lib/scan.js`, `lib/adapters/*` or `lib/hooks.js` references it. Distillation
   has never had model access and most users have no key configured.

So `goal` / `did` / `headline` / `decisions` / `gotchas` — the fields that make
a Claude Code memory a brief — **cannot be obtained for Codex this way.** Any
plan that promises parity is wrong. The README/guide disclosure shipped in
`8e5a11a` and `4e37e96` stays accurate after this work lands.

---

## 3. What the hook does buy, which is still worth having

Today `lib/adapters/codex.js` derives a summary by keeping the newest assistant
message in `fileState.lastText` and emitting it if it clears
`MIN_SUMMARY_CHARS` (80) — `codex.js:12,119-121`. One field, one length check,
discovered by polling. A SessionEnd hook improves four separate things:

1. **A reliable end-of-session signal.** Capture stops depending on when the
   daemon next polls, and on the daemon being up at the right moment.
2. **`transcript_path` handed over directly.** This is the big one. It removes
   the need to *guess* which rollout files are genuine, which is the source of
   both known Codex fragilities: `isGenuineRollout`'s originator sniffing,
   whose verdict is cached on `fileState.foreign` and so is **sticky for the
   file's whole life**, and the **silent skip** where a rejected file returns
   `[]` forever with no log line. A path the tool itself handed us needs no
   provenance heuristic.
3. **Authoritative `session_id` and `cwd`.** Today both are inferred.
4. **Distillation over the whole transcript, not the last message.** Once the
   daemon is told "this session ended, here is its transcript", it can extract
   structurally — files touched, tools used, the user's opening ask, decisions
   stated — instead of taking whatever the agent happened to say last. This is
   a heuristic extractor, not a model, and it should be labelled as one.

Net: Codex goes from *a sign-off sentence, found by polling* to *a structured
extraction over the full transcript, triggered reliably*. That is a real
improvement and it is not parity.

---

## 4. Design

**Three pieces.** The hook must do nothing that can take a second.

**(a) Registration** — extend `lib/hooks.js`'s reconciler set to a Codex lane
writing `~/.codex/hooks.json`. Constraints inherited from this repo's own
history, all of which have already been paid for once:

- It must honour the **recorded consent opt-out** (#48/#49's fix), not just
  `distill.enabled`. A second tool installing hooks on launch after a user
  said no is the same bug twice.
- It must use `compareVersions`' **numeric ordering** and the four-state
  vintage check, not string compare.
- It must **not** assume it owns the file. `~/.codex/hooks.json` is shared with
  whatever else the user has registered — the same lesson as
  `splitHookCommand` preserving the wrapper prefix.

**(b) The hook entry point** — a new mode in `lib/membridge-hook.js`. Reads the
SessionEnd JSON on stdin, and does the minimum:

- `transcript_path` **may be null** — handle it, do not crash. Fall back to the
  existing rollout scan for that session.
- POST the three fields to the daemon and exit. Do not read the transcript in
  the hook; do not wait for the daemon's work.
- **Write a start line before any work**, per `lib/hook-stops.js` — a start with
  no end IS the timeout record, and at a 1s budget timeouts will happen.
- Daemon down must be a **distinct, named outcome**, not silence. Same rule
  `no-edits-daemon-down` established.

**(c) Daemon side** — a `POST /api/codex/session-end` that records the session
and schedules the extraction. `/api/sync` already exists but means something
else; do not overload it. The extraction itself is where the quality gain lives
and is the larger half of the work.

---

## 5. What cannot be verified on this machine

**Codex is not installed here.** There is no `~/.codex` directory. So:

- The registration path can be unit-tested against a temp dir, but **nothing
  here can prove a real Codex session fires the hook.**
- The 1s budget cannot be measured against a real session end.
- `transcript_path`'s null case cannot be observed, only handled.

This needs a machine with Codex installed before it can be called done, and the
ticket should say so rather than let a green suite imply otherwise. That is the
same trap as `test/mock-supabase.js` modelling the RPCs, which is why a missing
live migration never turned CI red.

---

## 6. Estimate

- (a) registration: 1 day, most of it the consent and vintage guards.
- (b) hook entry point: 0.5 day.
- (c) daemon endpoint + transcript extractor: 2–3 days. The extractor is the
  part with real design in it, and the part where the quality claim lives.
- Verification on a Codex machine: unestimated, blocked on hardware.

**Recommendation: do (a) and (b) only if (c) is also funded.** On their own they
make capture more *timely* and more *reliable* without making it any *better*,
and the honest disclosure would not change by a word. The reason to do this
ticket at all is (c).
