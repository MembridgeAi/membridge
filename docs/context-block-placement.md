# Where the context block lives (issue #66)

**Status:** part 1 shipped. Part 2 is an open product decision for Marco.
This document exists so that decision can be made without re-deriving the
investigation.

## The problem

MemBridge injects its "Shared AI memory" block into each project's context
files (`CLAUDE.md`, `AGENTS.md`, and four opt-in targets). Those files are
normally **tracked in git** — that is the ordinary way a team shares
instructions with its tools.

So every sync produces a diff in a tracked file that no human edited. On one
user's team this breaks their workflow outright: they run `gh pr merge`, then
`git pull --rebase`, and the rebase refuses because the tree is dirty. The
merge succeeds on GitHub and the rebase fails after it, leaving the checkout on
pre-merge code while everything upstream reports success. It cost them seven
manual stashes before they built a workaround.

This is the kind of bug that makes a team stop using the tool rather than file
a report.

### Why nobody here feels it

MemBridge gitignores its own `CLAUDE.md` (`.gitignore:28,33`; the real rules
live in `.claude/rules/`). The maintainers are structurally the one population
immune to their own bug. Worth remembering the next time a report seems not to
reproduce.

## Part 1 — shipped

The block's closing stamp used to be `new Date()` at render time,
minute-granular. `digest.inject()` already refuses to write a file whose
content has not changed, and that one line defeated the guard: an untouched
project re-rendered to a block differing by exactly the stamp, so the file was
rewritten.

The stamp is now derived from the newest activity actually rendered
(`lib/digest.js` `footerLine`), so an unchanged project renders byte-identically
and the existing guard suppresses the write. Universal across all six targets,
no migration, no git dependency. Pinned by
`test/suites/context-block-churn.test.js`.

**This is a narrowing, not a cure.** The primary churn is legitimate: new
activity genuinely changes the block every session, by design. Part 1 removes
only the churn that had no cause behind it.

## Part 2 — the open decision

To stop the remaining churn, the volatile block has to move out of the tracked
file, leaving behind something stable that points at it.

### The mechanism is not universal, and that is the crux

The obvious mechanism — an `@path` import — **is a Claude Code feature, not a
markdown feature.** Against the current target list:

| Target | Consumer | Import support |
|---|---|---|
| `CLAUDE.md` | Claude Code | yes (`@path`) |
| `AGENTS.md` | Codex, cross-tool convention | **no** |
| `GEMINI.md` | Gemini CLI | different semantics |
| `.cursor/rules/membridge.mdc` | Cursor | own referencing, different semantics |
| `.windsurfrules` | Windsurf | **no** |
| `.github/copilot-instructions.md` | GitHub Copilot | **no** |

Applying an import across the default target list would fix one file and
silently blank the block for the rest. `AGENTS.md` is the emerging cross-tool
norm, so a team that tracks it would get no fix and no signal that they got no
fix.

The fallback for a tool without imports is a pointer sentence ("the shared
memory for this project is in `<path>`"). **That is a downgrade from inline
content** — it depends on the tool choosing to follow the pointer. It is
partly mitigated by MemBridge's MCP server (`search_memory`,
`get_project_memory`) being the supported way for an agent to reach this
material, but it remains a real reduction in what non-Claude users receive.

**That trade — inline content vs. a pointer, for Codex, Cursor, Copilot and
Gemini users — is the product decision. It is the whole of part 2.**

### Hidden cost: three internal readers break silently

These parse the markers back out of the file. Each fails **silently** the
moment the block stops being inline, so all three become required work in the
same change, not follow-ups:

| Reader | What it does | Failure under a pointer/import |
|---|---|---|
| `lib/hooks-prime.js:74-100` | SessionStart dedupe gate; `ancestorClaudeMds` walks ancestors reading **`CLAUDE.md` only** | never matches → the hook injects a duplicate block on **every** session start. Its own header calls this out: it turns "inject only when stale" into "inject always". Pure token waste, invisible. |
| `lib/block-signature.js:117-119` | `hasRenderedBlock` — the "never conjure" gate | returns false → recipe changes (new wording, new target, new redaction pattern) stop reaching projects, and blocks go stale forever |
| `lib/server.js:477` | dashboard per-target `injected` flag | every project reports "not injected" |
| `lib/server.js:1970-1988` | `projectBlockPayload`, block-preview endpoint | returns `{file: null, block: null}` |

(The fourth is listed for completeness — it degrades to an honest empty answer
rather than a wrong one, so it is the least severe.)

### Open question: where does the sidecar live

`.membridge/` is **not reliably gitignored**. `team.json` inside it is *meant*
to be committed — `bin/membridge.js:1002` tells users to add a
`!.membridge/team.json` exception when they ignore the directory. So dropping
the volatile block at `.membridge/context.md` does not by itself guarantee git
ignores it, which would reproduce the original bug at a new path.

Candidate: a `.membridge/.gitignore` naming just the sidecar. Self-contained,
never touches the user's root `.gitignore`, written once. But it is a new file
written into the user's repo and deserves its own scrutiny before shipping.

### Prerequisite that does not exist yet

**There is no git awareness anywhere in the injection path.** No
`git check-ignore`, no `ls-files`, no tracked test — the only mentions of
`.gitignore` in `lib/` and `bin/` are a comment and a CLI hint. The decision
"should this file receive volatile content" currently has **no input at all**.
That is why the bug is intermittent.

Any placement fix keyed on tracked-ness needs that capability built, including
a correct answer for the not-a-git-repo case (no tracking, no problem, behave
as today). It is deliberately **not** built ahead of the decision — a
capability built before the decision that needs it tends to constrain the
decision.

## Shapes considered

| Shape | Fixes | Cost |
|---|---|---|
| Import everywhere | `CLAUDE.md` only | silently blanks 5 of 6 targets — rejected |
| Git-aware placement: sidecar + stable reference when tracked, unchanged when not | both layouts | pointer downgrade for non-Claude tools; 3 internal readers; sidecar-ignore question; new git capability |
| Documented per-project `targets` override (drop `CLAUDE.md`, keep `AGENTS.md`) | teams who opt in | teammates silently stop getting synced updates for the dropped target |
| Skip the write while the tree is dirty | the rebase collision specifically | leaves the block stale exactly when the user is mid-workflow; still needs git awareness |
