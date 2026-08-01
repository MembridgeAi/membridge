# Alpha readiness: design

**Date:** 2026-08-01
**Status:** proposed
**Repo state at audit:** `master` at `2e770ea`, tag `v0.2.3` at `802d366`, npm `latest` at `0.2.2`

## Problem

MemBridge works. The evidence for that is strong: 26 migrations with zero dynamic SQL, a loopback-bound daemon that validates `Host` on every request, a two-tier summary system, a holdout-based savings ledger that documents its own upward bias. The engineering is not the gap.

The gap is that a company evaluating the alpha never reaches any of it. The first ten minutes of an npm install produce nothing, for three separate reasons that compound. A prospect concludes the product does not work, and they are not wrong from where they are standing.

This document scopes what has to be true before MemBridge can be handed to a company we do not know.

## The evaluator's path

An evaluator does roughly this:

1. `npm i -g membridge`
2. `membridge start`
3. `membridge dashboard`
4. Open a project, do some AI work, look for memory

Today that path fails at step 3, and would still fail at step 4 if step 3 were fixed, and would still show an empty result at step 4 if both were fixed. Findings F1 to F3 are that path, in order.

## Findings

### F1 (CRITICAL): the npm tarball ships no UI

`package.json` `files` is `["bin","lib","vendor","README.md","LICENSE"]`. `ui/dist` is not in it. The dashboard server has nothing to serve, so `membridge dashboard` returns 503 for every npm install.

There is no build step wired to publish either. `prepublishOnly` is `npm test`, which does not build the UI.

Consequence: every user who installs the documented way gets a product with no interface. The Electron app is the only working surface, and it is Apple Silicon only.

### F2 (CRITICAL): there is no CLI command to enroll a project

The `commands` table in `bin/membridge.js` (around line 1046) has no `add`, `init`, `adopt` or `track`. Neither does the help text at line 976. The only enrollment path in the codebase is `POST /api/adopt` (`lib/server.js:2520`), which is a dashboard action.

`adoptProjects` and `addProject` exist only in `lib/server.js` (1291, 1315) and are not reachable from the CLI.

The ingestion gate is `isTrackedProject` (`lib/scan.js:495`): an event survives only if its project is a `state.projects` key or the directory already has a `.membridge/`. Neither happens on its own. Nothing in the daemon discovers a new root.

Consequence: F1 and F2 together mean an npm user has no enrollment path at all. Planting a `.membridge/` directory by hand makes the entire loop work, which proves the gate is the only break.

### F3 (HIGH): adopting a project never backfills its history

In `syncOnce` (`lib/scan.js:638`), the order is:

```
const scanned = filterScratchpadResidue(scanAll(state, config));   // :647 advances offsets
projectResolve.rehomeEvents(scanned, trackedRoots(state));         // :648
const events = filterTrackedSessions(scanned, trackedRoots(state)); // :649 drops untracked
```

`scanAll` mutates `state.files` read offsets for every session file it touches, including files belonging to untracked projects. The tracking filter runs after. So every daemon tick consumes transcript bytes for projects that are not yet adopted, and those bytes are never re-read.

`addProject` (`lib/server.js:1291`) writes a `state.projects` entry and does not touch `state.files`. `deleteProject`'s own comment (`lib/server.js:1371`) states the behavior plainly: "Transcript offsets stay consumed, so only future activity revives it."

Consequence: a user with three weeks of Claude Code history adopts their project, syncs, and sees an empty memory block. The value proposition of the product is retroactive memory, and adoption is the exact moment it is least likely to appear.

Note: `cmdScan` (`bin/membridge.js:113`) already builds a fresh `{ files: {}, projects: {} }` and rescans from byte zero. A scoped version of that is the fix.

### F4 (HIGH): free-form secrets are stored and served unredacted

`lib/redact.js` is pattern-based: `DEFAULT_PATTERNS` (line 17) plus a high-entropy heuristic (`redactHighEntropy`, line 119) gated on `ENTROPY_MIN_LEN = 24` and `ENTROPY_THRESHOLD = 4.5` bits per character.

That catches API keys. It does not catch a human typing a password in prose, because a real password has neither a recognizable prefix nor 4.5 bits per character over 24 characters. A prompt like "the staging db password is hunter2corgi" passes every filter.

Captured prompts flow into `CLAUDE.md`, `.membridge/memory.json`, and MCP tool results. On a team-synced project they also upload.

Consequence: this is the single finding most likely to end an enterprise conversation. It does not need to be solved perfectly for alpha, but it needs a documented answer and a visible control.

### F5 (MEDIUM): duplicate daemons from an unguarded pid file

`cmdDaemon` (`bin/membridge.js:127`) writes `fs.writeFileSync(util.pidPath(), String(process.pid))` unconditionally at line 131. There is no check for a live process holding the file, and no lock.

Two `membridge start` invocations, or a start racing an autostart launcher, produce two daemons. Both contend for port 7437, and both write `state.json`.

Consequence: nondeterministic state corruption during exactly the period an evaluator is poking at the product.

### F6 (LOW): `adoptProjects` is defined twice

`lib/server.js:1315` and `lib/server.js:1347`. The bodies are byte-identical, so the second silently shadows the first and behavior is unchanged. The duplicate block also displaced `deleteProject`'s doc comment, which now sits orphaned at line 1339 above the wrong function.

Consequence: no runtime effect. It is evidence a merge landed badly, which matters more than the dead code does.

### F7 (MEDIUM, unverified): `install.sh` may pin a v0.1.2 asset

The QA pass reported that the SHA in `install.sh` matches the live 0.1.2 zip byte for byte, and could not fetch the live script to confirm because the proxy returned 403.

This is a suspicion, not a finding. It needs a fetch from a machine with real network access before anyone acts on it.

Consequence if true: the curl installer, which is the path the site pushes hardest, installs a version from before the React rewrite.

### F8 (MEDIUM): the Windows asset does not exist

`MemBridge-win.zip` returns 404. The `windows` job in `.github/workflows/build-app.yml` (line 147) runs `npm run dist:win` and uploads the zip, but the upload step is gated on `github.event_name == 'release'`, and the asset is absent from the published release regardless.

Both `releases/latest/download/MemBridge-win.zip` and `releases/latest/download/MemBridge.dmg` return 404 unauthenticated. The DMG alias 404 may be a filename mismatch rather than a missing asset and needs checking before it is claimed as broken.

Consequence: the site advertises a Windows download that does not exist.

### F9 (MEDIUM): release state is stale

`v0.2.3` still points at `802d366`, which predates both the USD revert and the `package.json` repair. npm `latest` is `0.2.2`. Master is at `2e770ea` and has been for a while.

Consequence: nothing shipped in this cycle is actually reachable by a user. This is not a code fix; it is Andrew re-tagging and publishing after Tasks 1 to 3 land.

## What is already correct and must not be disturbed

Reviewed and deliberately left alone:

- **The ingestion gate itself.** `isTrackedProject` refusing to mint projects from arbitrary session cwds is correct and was clearly written after a real over-collection incident. F2 is not a request to weaken it. It is a request to give the user a way through it.
- **`isProtectedDir` overriding `roots.has()`.** The home directory is never a project even if a stale state key says it is. Load-bearing, do not touch.
- **Loopback binding, `Host` validation on GETs, zero CORS headers.** DNS rebinding defenses. Keep.
- **`/api/open` argv-array `spawnSync` with realpath containment.** Correct.
- **`contextIsolation: true`, `nodeIntegration: false`, denied window-open handler** in `app/main.js`. Correct.
- **Offsets advancing only once.** The dirty-flag comment at `lib/scan.js:651` explains why. F3's fix must be a scoped reset at adoption time, not a change to that invariant.

## Non-goals for alpha

- Windows or Intel Mac Electron builds beyond restoring the zip asset.
- Perfect secret detection. A documented boundary plus a visible control is the alpha bar.
- Reproducible signed macOS binaries. Not achievable; `install.sh` SHA has to come from the published asset.

## Success criterion

One sentence, and it is the acceptance test for the whole plan:

**A person with no context runs `npm i -g membridge`, `membridge start`, `membridge add .` in a repo with existing Claude Code history, and sees that history in their memory block within one sync interval.**

Nothing else in this document matters if that sentence is false.
