# Zero-friction macOS install (app + CLI, no Gatekeeper warning) — Design

**Date:** 2026-07-20
**Status:** Approved design, pre-implementation
**Author:** Marco Melika (with Claude Code)

## Problem

MemBridge ships as an Electron `.app` (`.dmg` + `.zip`) via GitHub releases. Today
the build only **ad-hoc signs** the bundle in [`scripts/afterPack.js`](../../../scripts/afterPack.js)
(`codesign --sign -`). Ad-hoc signing only stops Apple Silicon from reporting the app
as "damaged"; the app is still **unsigned and un-notarized**, so the README tells users
to *right-click → Open* on first launch (README:140), and macOS 15 (Sequoia) has removed
that right-click bypass entirely (users must now dig into System Settings → Privacy &
Security). The roadmap lists "Signed + notarized macOS builds" (README:509) as a
future item.

The user's goal: **the application opens with no warning**, **without paying** the
Apple Developer Program fee ($99/year — note: per *year*, not per month; there is no
individual student discount).

## The Gatekeeper reality (why the approach is what it is)

Proper notarization is the *only* mechanism that makes a browser-downloaded,
double-clicked `.app` launch silently — and notarization requires the paid account
(a free Apple ID **cannot** notarize). That path is explicitly **out of scope** here.

The free lever we use instead: **Gatekeeper only inspects files carrying the
`com.apple.quarantine` extended attribute, and that attribute is set by the
*downloader* (Safari, Chrome, Mail) — not by `curl`, `git`, or `npm`.** Strip that
one attribute from an ad-hoc-signed app and it opens instantly, forever, no warning.

One honest constraint we design around, not away from: **any file downloaded through
a browser is quarantined, so the first thing the user launches from that download
shows exactly one Gatekeeper prompt.** We move that single prompt onto the *installer*
(run once), and the installer strips quarantine off the app + CLI it installs — so the
**application** and every relaunch are warning-free. The `curl` front door avoids even
that one prompt, because `curl` never quarantines.

## Goals

- One downloadable artifact installs **both** the menu-bar app **and** the `membridge`
  CLI.
- After install, `MemBridge.app` opens with **no Gatekeeper warning**, and every
  relaunch is silent.
- The CLI is fully self-contained: **no system Node.js required** to run it.
- Two front doors: a GUI **DMG installer** (one one-time prompt) and a **`curl`
  one-liner** (zero prompts). Both drive the *same* install logic.
- No new paid dependencies; no change to the existing ad-hoc signature.

## Non-goals

- Developer ID code signing or Apple notarization ($99/yr).
- Windows / Linux installer changes (the CLI already ships cross-platform via npm).
- Auto-update / Sparkle.
- A Homebrew tap (possible later; not this spec).

## Architecture

**One install "brain," two front doors, CLI bundled inside the app.**

```
                    scripts/install/membridge-install.sh   ← single source of truth
                    (detects mode: DMG-adjacent app │ curl-download)
                              ▲                        ▲
        bundled in the app    │                        │  served over HTTPS
        (extraResources)      │                        │  at membridge.me/install.sh
                              │                        │
   DMG ──► "Install MemBridge.command" (stub)     curl -fsSL … | sh
   (one Gatekeeper prompt, GUI)                   (zero prompts, terminal)
```

### Component 1 — Bundle the CLI into the app

The packaged app currently bundles `lib/` (and `node_modules/libsodium*`) but **not**
`bin/membridge.js` — confirmed by [`lib/hooks.js:278`](../../../lib/hooks.js) ("the
packaged app bundles lib/ but not bin/") and by inspecting the built `app.asar`.

Change: [`scripts/prepare-app.js`](../../../scripts/prepare-app.js) copies `bin/` →
`app/bin` alongside its existing `lib/` → `app/lib` copy. Result: `app.asar/bin/membridge.js`
sits as a sibling of `app.asar/lib/`, which is exactly the layout
[`lib/autostart.js:11`](../../../lib/autostart.js) already assumes
(`path.join(__dirname, '..', 'bin', 'membridge.js')`).

**Why this is low-risk:** the app already runs its own Node code via the bundled
Electron runtime. [`lib/hooks.js:285`](../../../lib/hooks.js) emits an
`ELECTRON_RUN_AS_NODE=1` prefix whenever `process.versions.electron` is set, and
[`lib/membridge-hook.js`](../../../lib/membridge-hook.js) documents the
`ELECTRON_RUN_AS_NODE=1 "<runtime>" "<this file>"` command shape. Running
`bin/membridge.js` the same way needs **no rework** of the hook/autostart machinery.

### Component 2 — CLI launcher wrapper

Installed to `/usr/local/bin/membridge`, a small shell stub:

```sh
#!/bin/sh
# MemBridge CLI — runs the bundled CLI via the app's own Electron-as-Node runtime.
APP="/Applications/MemBridge.app"
exec env ELECTRON_RUN_AS_NODE=1 \
  "$APP/Contents/MacOS/MemBridge" \
  "$APP/Contents/Resources/app.asar/bin/membridge.js" "$@"
```

- No system Node.js required — the app's bundled Electron *is* the runtime.
- Consistent with hook/autostart commands, which also resolve `process.execPath` to the
  Electron binary when the CLI runs this way.
- The wrapper text is emitted by the install script (see Component 3), so the app path is
  fixed at install time.

### Component 3 — Shared install script (the brain)

`scripts/install/membridge-install.sh`, POSIX `sh`, idempotent, safe to re-run.

Responsibilities, in order:
1. **Resolve the app source (mode detection):**
   - **DMG mode:** if a `MemBridge.app` exists adjacent to the script (i.e., on the
     mounted DMG), use it.
   - **curl mode:** otherwise, query the GitHub releases API
     (`/repos/mmelika/membridge/releases/latest`), download the `.zip` asset to a temp
     dir, and unzip it.
2. **Quit any running instance** (`osascript -e 'quit app "MemBridge"'` / `pkill -f`),
   so replacing the bundle is safe.
3. **Install the app:** copy to `/Applications/MemBridge.app` (replace if present).
4. **Strip quarantine:** `xattr -dr com.apple.quarantine "/Applications/MemBridge.app"`
   → this is what removes the warning.
5. **Install the CLI wrapper:** write the Component-2 stub to `/usr/local/bin/membridge`,
   `chmod +x`. If `/usr/local/bin` is missing or not writable, create it / re-invoke the
   relevant step with `sudo`, prompting the user clearly. (`/usr/local/bin` is not
   writable by default on stock Apple Silicon.)
6. **Launch:** `open "/Applications/MemBridge.app"`, print a one-line success + confirm
   `membridge` is on `PATH`.

Error handling: `set -eu`; every external step guarded with a clear message; a failed
CLI-symlink step must not abort the (already successful) app install — it degrades to a
printed manual instruction.

### Component 4 — DMG front door

- The shared install script is bundled into the app via electron-builder
  `extraResources` (e.g. `Contents/Resources/membridge-install.sh`).
- `build/Install MemBridge.command` is a thin stub added to the DMG via
  electron-builder `dmg.contents`. It locates the `MemBridge.app` on the same mounted
  volume and execs that app's bundled `membridge-install.sh` in DMG mode.
- UX: user opens the DMG, double-clicks **Install MemBridge** → one Gatekeeper prompt on
  the `.command` (unavoidable for a browser download) → app + CLI installed, quarantine
  stripped → the **app opens with no warning**.
- **Fallback if `dmg.contents` cannot carry the extra file directly:** inject it with an
  electron-builder `afterAllArtifactBuild` hook that adds the `.command` to the produced
  DMG. (To be confirmed during implementation.)

### Component 5 — curl front door

- `install.sh` is published over HTTPS at **`https://membridge.me/install.sh`** (the
  user owns the domain, served from the `mmelika/membridge-site` GitHub Pages repo).
  Raw `githubusercontent.com` is the fallback host.
- README one-liner: `curl -fsSL https://membridge.me/install.sh | sh`.
- Because `curl` never sets `com.apple.quarantine`, this path installs app + CLI with
  **zero prompts**. It is the same script body as Component 3, running in curl mode.
- The published `install.sh` is generated from / kept in sync with the in-repo
  `scripts/install/membridge-install.sh` (single source of truth; a copy step or CI
  keeps the site copy current — mechanism decided in the plan).

### Component 6 — Keep ad-hoc signing

[`scripts/afterPack.js`](../../../scripts/afterPack.js) is unchanged. The ad-hoc
signature is still required for the binary to run at all on Apple Silicon; quarantine
stripping is what removes the *warning*. The two are complementary.

### Component 7 — Docs

README install section rewritten to present: (a) the DMG double-click installer, (b) the
`curl` one-liner, (c) an honest note that the installer needs one "Open Anyway" the first
time (or use curl for none), and (d) that the `membridge` CLI is installed alongside the
app. The roadmap's "Signed + notarized macOS builds" line stays (that's the paid future).

## Data flow

```
Browser download (DMG)          curl one-liner
      │                               │
      ▼                               ▼
Install MemBridge.command    membridge.me/install.sh
      │  (1 prompt)                   │  (0 prompts)
      └──────────────┬────────────────┘
                     ▼
        membridge-install.sh
   ┌─────────────────────────────────┐
   │ resolve app  →  /Applications   │
   │ xattr -dr com.apple.quarantine  │  → app opens with NO warning
   │ write /usr/local/bin/membridge  │  → CLI works, no system Node
   │ open MemBridge.app              │
   └─────────────────────────────────┘
```

## Risks & open verification items

- **`/usr/local/bin` writability** on stock Apple Silicon → handle with `mkdir -p` +
  `sudo` fallback and explicit messaging. Never silently fail the CLI step.
- **autostart from inside Electron** ([`lib/autostart.js`](../../../lib/autostart.js)
  uses `process.execPath`) — hooks already emit `ELECTRON_RUN_AS_NODE`; verify the
  start-at-login launch agent does too (the app's existing start-at-login feature
  implies it already works, but confirm during implementation).
- **`dmg.contents` extra-file support** — confirm electron-builder copies a non-app,
  non-link file into the DMG; else use the `afterAllArtifactBuild` fallback.
- **asar path stability** — the wrapper hardcodes
  `Contents/Resources/app.asar/bin/membridge.js`; confirm this path across builds and
  that `bin/` is not `asarUnpack`-excluded.
- **Replacing a running app** — quit the instance first; the app writes a PID file
  (`util.pidPath()`), which the script can use for a clean shutdown.
- **curl-site sync** — the `install.sh` served at membridge.me must not drift from the
  in-repo script; enforce with a copy/CI step.

## Testing

- **Unit (node harness, `test/run-tests.js`):** assert `scripts/prepare-app.js` produces
  `app/bin/membridge.js` (the bundling contract). Assert the CLI wrapper text the install
  script emits targets the correct app path.
- **Shell:** `shellcheck` the install script + `.command` stub; a `--dry-run` mode that
  prints planned actions without touching the system.
- **Manual E2E (Apple Silicon):**
  1. `npm run dist:mac` → mount DMG → double-click installer → confirm one prompt, then
     app opens silently, `membridge --version` works in a fresh shell.
  2. `curl -fsSL https://membridge.me/install.sh | sh` on a clean machine → confirm zero
     prompts, app + CLI installed.
  3. Re-run each installer (idempotency); confirm a running instance is replaced cleanly.

## Rollout

1. Bundle CLI + wrapper + install script + tests.
2. `dist:mac` DMG carries the `.command`; verify locally.
3. Publish `install.sh` to membridge.me; update README.
4. Cut a release; smoke-test both front doors on a clean machine.
