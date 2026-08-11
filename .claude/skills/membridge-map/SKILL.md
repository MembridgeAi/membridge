---
name: membridge-map
description: Where things live in the MemBridge repo and which parts have already cost someone hours. Use when orienting in an unfamiliar area, deciding which file owns a behaviour, or before changing anything in lib/, bin/, adapters, or the test suites.
---

# MemBridge repo map

Node daemon plus a React UI, shipped as an Electron app and an npm package.
CommonJS, plain Node, no transpile step outside `ui/`. `engines.node` is `>=18`
on purpose.

## Where things live

| Area | Path | Notes |
| --- | --- | --- |
| CLI | `bin/membridge.js` | The only binary entry point |
| HTTP daemon | `lib/server.js` | ~2,970 lines, largest file in the repo |
| Team sync | `lib/teamsync.js`, `teamcrypto.js`, `teampins.js`, `team-archive.js` | ~2,332 lines in teamsync alone |
| Agent hooks | `lib/hooks.js` plus `hooks-{recall,prime,search,notes}*.js` | What fires inside an agent session |
| Tool adapters | `lib/adapters/{claude-code,codex,cursor,custom}.js` | Each writes another tool's config file. Highest blast radius per line |
| Memory model | `lib/ledger*.js`, `lib/recall*.js`, `lib/memorydb.js` | Ledger, recall, storage |
| Repo reading | `lib/scan.js`, `lib/skeleton*.js` | What gets extracted from a codebase |
| React UI | `ui/src/` | Vite, React 19, TypeScript. Owned by ui-engineer |
| Tests | `test/run.js`, `test/suites/*.test.js`, `test/run-tests.js` | See the regression-test skill |
| Packaging | `scripts/`, `app/`, `package.json` | `prepare-app.js` syncs `app/package.json` |
| Backend | `supabase/migrations/` | Append-only |
| Release | `docs/releasing-macos.md`, `.github/workflows/` | See the ship-release skill |
| Ops state | `claude/ops/state.md`, `decisions.md`, `queue.md` | The repo is canonical, the Claude Project is a mirror |

## Landmines

Each of these has already cost real time. Do not rediscover them, and check
whether your change adds a new instance.

- **`util.homeDir()` returns `~/.membridge`, not the user's home.** Using it to
  find another tool's config silently resolves to a path nothing reads.
  Fixture-injected tests cannot catch it.
- **`state.json` has no locking.** Any load-work-save cycle erases whatever
  another process wrote in between. This is why agents run in separate
  worktrees and why one agent per tree is a hard rule.
- **Path keys fragment per worktree.** Any project-relative path used as a key
  splits the same file into a different row per worktree. Key through
  `repoRoot.ledgerKeyFor` / `wireKeyFor`.
- **The legacy dashboard client files are one enormous template literal.** A
  stray backtick breaks `require` at load time, far from the edit. Does not
  apply to the React app in `ui/`.
- **Migrations are append-only.** Editing a shipped migration produces a schema
  that exists nowhere but your machine.
- **A green local build proves nothing.** `npm run build:ui` does not run
  `tsc`. Only CI typechecks. `cd ui && npx tsc --noEmit` is the only local
  check that catches type errors, and it takes seconds.
- **Untracked files do not exist in a worktree.** Anything an agent needs at
  runtime has to be committed to the branch the worktree is cut from.

## Cut features

Roadmap, planning, and BYOK were removed on purpose. Proposals to add them back
get rejected, so do not spend a ticket on one.
