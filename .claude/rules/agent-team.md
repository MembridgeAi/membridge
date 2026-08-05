# Agent operating rules

You are working on MemBridge, a local daemon that gives AI coding agents a
shared, persistent memory across sessions, across tools (Claude Code, Codex,
Cursor), and across teammates. The product thesis is "single-player tools,
multiplayer development": every agent tool keeps its own private context, so the
same discovery gets re-derived by every developer and every tool, over and over.
MemBridge is the shared layer underneath them. Node.js daemon plus a React
desktop/web UI, shipped as an Electron app and an npm package.

Hold onto that thesis when you make judgment calls. This product's job is to
make an agent's accumulated memory legible and trustworthy to a human. If a
change makes it harder to see what the system knows, where a fact came from, or
whether it is current, the change is wrong regardless of how nice it looks.

## Isolation

Work in your own git worktree. Never commit to `master`, never push, never merge
another agent's branch. When your ticket is done, say so and stop. A human lands
the work.

## Testing

The full suite is a ship gate, not a development tool. Never run
`node test/run.js` with no arguments, and never run `cd ui && npx vitest run`
with no file argument, unless a human explicitly asks. Both are blocked by a
hook; if you hit that block, you were about to do the wrong thing.

Verify only what you touched. The per-area table lives in
[testing.md](./testing.md) — that file is the authority on what to run, and
these rules do not restate it.

## A failing test is not a bug until the gate says so

This repo's suites have a documented failure mode. Testing Library's `findBy*`
and `waitFor` run on their own timeout, and several assertions are sensitive to
scheduler starvation. When the machine is busy, for instance because several
agents are compiling at once, passing tests report as failures, most often as
`Unable to find <element>`. These read exactly like real defects. They are not.

**No test failure may be reported, filed, or fixed until it has been re-run in
isolation on a quiet machine.** That is a command, not a vibe:

```bash
node scripts/verify-finding.js --ui src/features/feed/FeedScreen.test.tsx --runs 3
node scripts/verify-finding.js --suite search --runs 3
```

The gate takes a global lock (so two agents can never verify at once and
re-create the contention they are ruling out), waits for load to settle, re-runs
the target alone N times, and exits with a verdict:

| Exit | Verdict | What you do |
|---|---|---|
| `0` | CONFIRMED, failed every isolated run | Real. File it or fix it. |
| `3` | PHANTOM, passed in isolation | Load artifact. Do not file it. Do not "fix" the code. Drop it and move on. |
| `4` | FLAKY, inconsistent across identical runs | A genuinely nondeterministic test. Escalate to a human. Do not guess at a fix. |

Fixing code to satisfy a PHANTOM is the single worst outcome available here: it
breaks working software to silence a measurement error.

## Repo landmines

These have each cost someone hours. Do not rediscover them:

- `util.homeDir()` returns `~/.membridge`, **not** the user's home directory.
  Using it to find another tool's config silently resolves to a path nothing
  reads, and fixture-injected tests cannot catch it.
- `state.json` has no locking. Any `load → work → save` cycle erases whatever
  another process wrote in between. Never add a new read-modify-write of it.
- Path keys fragment per worktree. Almost all work here happens inside
  `.claude/worktrees/<name>`, so any project-relative path used as a key splits
  the same file into a different row per worktree. Key through
  `repoRoot.ledgerKeyFor` / `wireKeyFor`, never a raw relative path.
- The legacy dashboard client files are one enormous template literal. A
  backtick anywhere you add, including inside a comment, breaks `require`.
  Smoke-check with `node -e "require('./lib/<file>.js')"`. Does not apply to the
  React app in `ui/`.
- This codebase's characteristic bug is **a flag that records a success the code
  never achieved**: a fail-open path plus an unconditional success flag, which
  produces silent false success. When you touch error handling, check that the
  success marker is set on the success path only.

## Scope discipline

Do the ticket. If you find something else worth doing, write it up as a new
ticket rather than widening your diff. Do not add roadmap, planning, or BYOK
features; those were cut from the product on purpose and will be rejected.

## Reporting

When you finish a unit of work, post: what you changed, the diagnosis or failure
scenario that justified it, the verify commands you ran and their results, and
anything you deliberately left alone. Do not narrate your own diff line by line.
The human reads the diff. What they cannot read is your reasoning.

## If you are a teammate on an agent team

Your role file in `.claude/agents/` is appended to your system prompt and it
governs your scope. Do not take work outside it because a task looks unclaimed.
The role boundaries here are deliberate: the agent who wrote the code is the
worst possible judge of whether it is broken, and the agent who found a bug is
the worst possible judge of whether it is real.
