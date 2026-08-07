# Agent team: UI work and bug hunting

An importable agent team for [Agent Teams AI](https://github.com/777genius/agent-teams-ai).
In the app: **Import agent team → Choose folder →** select this directory
(`docs/agent-team`) → review → **Create draft team**.

The team does two things this repo needs: make the React UI materially better,
and find real bugs. It is deliberately small — four agents on a 10-core machine
leave enough headroom that the test suites still tell the truth.

## Layout

The importer reads this structure specifically:

```
docs/agent-team/
  CLAUDE.md          → becomes CTOpus's orchestration prompt (the lead)
  agents/
    ui.md              → member  (React app, ui/ only)
    backend.md         → member  (daemon, CLI, Supabase, tests)
    bug-boy.md         → member  (finds correctness defects)
    jamal.md           → member  (finds disclosure + authz defects)
    doubting-thomas.md → member  (judges candidates and fixes)
```

CTOpus is **not** an agent file — the prompt comes from `CLAUDE.md`. That is also why the role is
named rather than called "lead": `lead` and `team-lead` are reserved member names (see below), so
the orchestrator could not be registered under either. Each member file
is YAML frontmatter (`name`, optional `skills`) plus a markdown body that
becomes that member's workflow. Because members only ever see their own file,
the standing orders and the test gate are repeated in each one on purpose; that
duplication is load-bearing, not an oversight.

The app prepends its own board protocol (`task_create`, `task_start`,
`task_add_comment`, `task_complete`, `message_send`) to every prompt on import,
so none of these files describe board mechanics.

## Running it in the Claude Code desktop app

The instructions below, and `HOW-IT-WORKS.md` in the distributed kit, describe the
**terminal's** agent-teams feature: `/team-start`, the teammate panel, tmux panes,
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. None of that exists in the desktop app.

The role files in `agents/` are correct and reusable either way. For the app, the
operating manual is `.claude/skills/team/SKILL.md` — invoke it with `/team`. It
covers the app's actual mechanics (the Agent tool, SendMessage for plan approval,
the task board) plus the concurrency, isolation and reporting rules.

## Before you run it

- **Turn on worktree isolation per teammate** when launching. Four agents in one
  tree will clobber each other — `state.json` has no locking.
- Point the first run at a scratch branch, never `master`.
- Member names are fixed by the importer's rules: `lead`, `team-lead`, and
  `user` are reserved, and names must start alphanumeric and match
  `[a-zA-Z0-9._-]`.

## The test gate

The single most important rule in these prompts: **a failing test is not a bug
until `scripts/verify-finding.js` says so.** This repo produces phantom failures
under machine load — Testing Library's own timeouts trip when several agents
compile at once, and passing tests report as `Unable to find <element>`. The
gate re-runs a target alone on a quiet machine and exits `0` CONFIRMED,
`3` PHANTOM, or `4` FLAKY.

Without it, a four-agent team spends its day breaking working code to silence
measurement errors.
