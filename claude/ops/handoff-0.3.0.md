# Handoff — after v0.2.9 / v0.3.0 (2026-08-04)

Both releases are out and verified. Everything below is what was deliberately
NOT done, with enough context to act without the originating conversation.

## Shipped, no action needed

- `v0.2.9` and `v0.3.0` tagged, released, on npm (`@membridgeai/membridge`,
  latest `0.3.0`, provenance attestations present), with signed+notarized mac
  dmg/zip and a Windows zip attached to both. `origin/master` is `78c2603`.
- `install.sh` pin regenerated to 0.3.0 from the CI-built zip (it had been
  stale at 0.2.8 for two releases). SHA-256 verified against the served asset.

## 1. Marco's own machine is still on 0.2.8

`/api/status` reports version 0.2.8. The v0.2.4 post-mortem records three bugs
filed against the UI that were all one cause — the app in `/Applications` was
two versions behind the DMG that had been verified. Do not diagnose any UI
report from this machine until it is on 0.3.0.

Install `MemBridge-0.3.0-arm64.dmg` from the v0.3.0 release. Check the mounted
volume name, not the filename in Downloads: a re-downloaded asset lands as
`MemBridge-arm64 (3).dmg` and the volume name is the cheapest version tell.

## 2. `.membridge/team.json` can be deleted again, silently

`16ae1c6` deleted it; `aab6c71` restored it. Nothing prevents a third time, and
the failure is invisible — no error, no log line, just a team owner reading
"Insights is available to team owners and admins".

Worth a CI guard: fail the build if `.membridge/team.json` is absent from the
tree. Ten lines in `ci.yml`. The file is the only source under `.membridge/`;
`.gitignore` carries `!**/.membridge/team.json` twice to keep it tracked, and
it pins the shared backend `project_id` so forks resolve to one team rather
than minting their own project row.

## 3. Two uncommitted edits were destroyed and should be redone if they mattered

A `git reset --hard` during release prep discarded working-tree changes that
predate the session:

- `claude/ops/queue.md` — modified, content lost. Andrew committed a queue item
  here as `bdd011f`; this was a later local edit on top of current master.
- `ui/vite.config.ts` — modified, content lost. The committed version still
  carries `testTimeout: 15_000` and the asyncUtilTimeout comment, so the known
  phantom-failure fix is intact; whatever the local edit added is not.
- `docs/ENCRYPTION-SPEC.md` — had been deleted locally; the reset restored it.
  Re-delete if that deletion was intentional.

Not recoverable: never staged, no APFS snapshot, nothing in VS Code or Cursor
local history.

## 4. The agent-team kit is parked, not landed

Branch `agent-team-local` (3 commits, off `b44f838`) holds the four-role agent
team: `.claude/agents/{ui-engineer,bug-hunter,skeptic}.md`, the `/team-start`
lead brief, `.claude/rules/agent-team.md`, the `guard-test-commands.sh`
PreToolUse hook, and `scripts/verify-finding.js`.

Kept off master for the releases at Marco's request ("that's just for my
development"). Two things to know before deciding:

- `scripts/verify-finding.js` is arguably NOT personal — it is the
  phantom-failure gate, it encodes a real property of this repo's suites, and
  Andrew would want it. Consider splitting it out and landing it alone.
- The guard hook blocks `git push` and commits onto master for ANY Claude Code
  session whose project dir is this repo — including a human's own session, not
  just agents. That is the kit's stated intent ("a human lands the work"), but
  it means landing it makes agent-assisted releases from the main checkout fail
  until someone works around it.

Worktrees `.claude/worktrees/{ui,hunt}` exist on branches `agent-ui` /
`agent-hunt`; `ui` has dependencies installed and `tsc` clean.

## 5. Same bug shape, unaudited elsewhere

`InsightsPage` was fixed to authorize on team membership rather than `solo`.
`Shell.tsx` and `settingsMapper.ts` already carried that correction. Nothing
has swept the rest of the app for other `status.solo` reads standing in for
"has a team".

    grep -rn "solo" ui/src --include=*.tsx --include=*.ts | grep -v test

Each hit needs the question asked: is this "is anyone else here" (solo is
right) or "do I have a team" (membership is right)?
