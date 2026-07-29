# Spike: FileChanged as a human notification channel

**Date:** 2026-07-28
**Claude Code version:** 2.1.220
**Plan task:** Task 1 of `docs/superpowers/plans/2026-07-28-live-teammate-decisions.md`

**Question:** Can a `FileChanged` hook watching `.membridge/teammate-notes.json` emit a `systemMessage` to the human, given the event is documented as having no decision control?

## Verdict: NO-GO

Drop delivery point 1's terminal line. The dashboard is the human surface.

## Result

| Question | Answer |
|---|---|
| Does `FileChanged` fire at all? | **Yes** — real payload with `file_path` and `event: "add"` |
| Does its `systemMessage` reach the human? | **No** — suppressed |
| Does it match `teammate-notes.json`? | **No** — a matcher containing `.` or `-` never fires |
| Does it match a plain name? | **Yes** — matcher `notes` fired for a file named `notes` |

## Method

A throwaway project with a project-level `.claude/settings.json`, driven by
`claude -p --output-format stream-json --verbose`. Files were changed from a
background subshell **during** the session, so the change was genuinely
external to the agent's own tool calls.

Three matchers were registered simultaneously — `teammate-notes.json`,
`teammate_notes`, and `notes` — and two files were touched: `teammate-notes.json`
(twice) and `notes` (once).

**The first run was invalid and was discarded.** It relied on the agent writing
the file with the `Write` tool. The session reported success and
`permission_denials: []`, but no file was ever created — the write was blocked
silently by the sandbox. A run whose trigger never happened proves nothing about
the hook. Worth remembering: in a sandboxed headless run, a reported tool success
is not evidence the side effect occurred.

**A positive control was added after the first `FileChanged` run came back
empty.** Without it, "no output" was indistinguishable between three causes:
the settings file not being read, `systemMessage` not working in `-p` mode, or
`FileChanged` genuinely suppressing it. A `SessionStart` hook emitting
`CONTROL-MARKER` was added to the same `settings.json`, writing to its own log.

## Evidence

The control fired and **its `systemMessage` did surface** in the same stream,
same session, same mechanism:

```
=== CONTROL (SessionStart) fired? ===
SessionStart fired
=== CONTROL-MARKER visible to user stream? ===
1
```

`FileChanged` fired for `notes` — the event is real and carries a usable payload:

```json
{"hook_event_name":"FileChanged",
 "file_path":".../fc-spike/notes",
 "event":"add",
 "session_id":"596a1f5e-...","cwd":".../fc-spike","prompt_id":"31c0fc78-..."}
```

But its `systemMessage` did **not** surface, in that same stream:

```
=== SPIKE-MARKER (FileChanged systemMessage) in the user stream? ===
0
```

And `teammate-notes.json` never matched, despite being changed twice and
having two matchers aimed at it:

```
=== did teammate-notes.json ever fire? ===
0
```

## Conclusions

1. **`FileChanged` cannot talk to the human.** The documented "no decision
   control" extends to suppressing `systemMessage`, not just to blocking
   decisions. The control proves the mechanism works for other events in the
   same mode, so this is specific to `FileChanged`.

2. **Its matcher is a narrow character set, as documented.** Letters, digits,
   `_` and `|` only. `teammate-notes.json` cannot be watched under any spelling
   — both the literal name and an underscore variant failed, while a plain
   `notes` matched. Any future use of `FileChanged` must watch an extensionless,
   punctuation-free filename.

3. **The event itself is sound** for side effects, and its payload carries
   `file_path` and `event`, so it remains available for non-user-facing work.

## Caveat

Tested headlessly (`claude -p`). Interactive mode was not tested. The control
makes suppression the most likely reading rather than a mode artefact, since
`systemMessage` demonstrably works in this mode for `SessionStart`. If the
terminal line is ever worth revisiting, retest interactively before trusting
this verdict.

## Consequences for the spec

- **§6** — the terminal line is removed; the dashboard, which already polls
  every 5 seconds, is the human surface.
- **§11** — both open questions are now closed and the section is replaced by
  this result.
- **Plan Task 10** — reduces to wiring the dashboard, and `FileChanged`
  registration is dropped from `NOTES_HOOKS`.

## Not evaluated, worth considering separately

MemBridge ships as an Electron app, so a **native desktop notification** raised
by the daemon when a teammate decision lands would reach the human without any
hook at all, and without the token cost of an agent-facing injection. That is a
different mechanism from anything in the current spec and was not tested here.
