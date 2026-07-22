# Design: Unconditional Stop-hook auto-registration

**Date:** 2026-07-22
**Status:** Approved (design), pending implementation plan

## Problem

MemBridge's Claude Code Stop hook (and the git post-commit provenance hook) only
land in a user's environment after they run `membridge setup-hooks` by hand.
Every distribution channel therefore has a manual step:

- git clone + `npm install` + run
- `npm install -g membridge`
- curl installer (`membridge.me/install.sh`)
- downloading and double-clicking `MemBridge.app` (Electron)

The goal: **however you obtained MemBridge, the Stop hook registers itself into
`~/.claude/settings.json` with no manual `setup-hooks` step — unconditionally.**

## Key constraints discovered

1. **Shared chokepoint.** Both the CLI (`membridge start`) and the Electron app
   (`app/main.js:20`) boot the same daemon via `startServer()` in
   `lib/server.js`. The app is "just a face on" the CLI daemon.

2. **`startServer` is test-reachable.** `test/run-tests.js` imports and calls
   `startServer` directly. `claudeSettingsPath()` keys off
   `MEMBRIDGE_CLAUDE_SETTINGS` (`lib/hooks.js:43`), but the test harness only
   sets `MEMBRIDGE_CLAUDE_DIR` — **not** `MEMBRIDGE_CLAUDE_SETTINGS`. So any
   auto-ensure placed *inside* `startServer` would write to the developer's
   **real** `~/.claude/settings.json` during `npm test`. Auto-ensure must NOT
   live in `startServer`; it must live at the two real "a human is launching
   this" boundaries, which the test suite never reaches.

3. **Post-commit sweep is expensive per boot.** `installPostCommitHooks()`
   spawns `git config --get core.hooksPath` **once per tracked repo**, *before*
   the "already current" short-circuit. Measured: ~7.6 ms/spawn, ~168 ms for 22
   repos, paid on **every** launch even when nothing needs installing. The Stop
   hook write alone is ~1–3 ms.

## Design

### New helper: `hooks.ensureInstalled()`

A fail-open, mostly-idempotent wrapper added to `lib/hooks.js`:

- **Stop hook + narrow auto-approve rule** — reconciled on **every** call
  (~1–3 ms; self-heals if the resolved install path changed). Reuses the
  existing idempotent Stop-hook install logic from `setupHooks()`.
- **Post-commit sweep** — run **only** when a stored marker does not match the
  current MemBridge version (see below). First launch after install/upgrade runs
  the full sweep once; subsequent launches skip it entirely. Steady-state boot
  stays ~1 ms.
- **Fully silent on success** — no install log line, no matter what changed.
- **Fail-open** — any error (unwritable file, malformed existing JSON, git
  failure) is swallowed so the daemon always starts. A hard failure may be
  written to the daemon log only as a diagnostic; it is never surfaced to the
  user as an announcement.

### Once-per-version marker

- Stored in MemBridge state (e.g. `~/.membridge/state.json`,
  `hooksInstalledVersion`), read/written via the existing `util` state helpers.
- Compared against the running MemBridge version (`package.json` version).
- Mismatch (fresh install, upgrade, or never-run) → run the post-commit sweep,
  then stamp the marker to the current version.
- Match → skip the sweep.
- New repos linked after the sweep still get their post-commit hook through the
  daemon's normal link/scan flow and through explicit `setup-hooks`; nothing is
  lost by not re-sweeping unchanged repos every boot.

### Call sites (the two real launch boundaries)

1. **CLI** — `bin/membridge.js` `start` handler: call `ensureInstalled()` before
   `startServer`.
2. **App** — `app/main.js`, inside the existing `if (!SMOKE)` block
   (`app/main.js:181`): call `ensureInstalled()`.

Placing the app call inside `!SMOKE` means the `--smoke` CI/build boot-check
never registers hooks — the only skip, and it never represents a real user
session. Both call sites are unreachable from `test/run-tests.js`, so the suite
never touches real config.

### Unconditional — no user opt-out

Per decision, there is **no** `MEMBRIDGE_NO_HOOKS` escape hatch. The only path
that skips registration is `--smoke`.

### Curl installer (separate repo — coordinated change)

Add `membridge setup-hooks` to `install.sh` so curl users are registered eagerly
before first launch. ⚠️ `install.sh` lives in the **`mmelika/membridge-site`**
repo, not this one — this is a coordinated change to be applied there. First-run
auto-ensure already guarantees correctness regardless; the installer line just
makes it live before the app is first opened.

### Rebuild note

The Electron app bundles `lib/` at build time, so app users only get this after
`npm run dist:mac` and a re-release (consistent with the standing
"recompile app after big changes" note).

## Testing

- Unit: `ensureInstalled()` installs the Stop hook when absent; is idempotent
  when present; runs the post-commit sweep only on version mismatch and stamps
  the marker; skips the sweep on version match; is silent on success; fail-open
  on write errors (returns without throwing). All exercised with
  `MEMBRIDGE_CLAUDE_SETTINGS` + `MEMBRIDGE_HOME` pointed at temp dirs.
- Regression: confirm `test/run-tests.js` (which calls `startServer` directly)
  never writes to the real settings path — i.e. auto-ensure stays out of
  `startServer`.

## Out of scope

- Any change to what the Stop hook *does* once invoked (that is the separate
  ops-noise work).
- Removing or redesigning `setup-hooks` — it remains available and unchanged.
- Windows/Linux app packaging specifics beyond the shared `lib/` boot path.
