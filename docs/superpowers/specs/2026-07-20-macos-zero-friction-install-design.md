# Zero-friction macOS install (app + CLI, no Gatekeeper warning) — Design

**Date:** 2026-07-20
**Status:** Approved design, pre-implementation
**Author:** Marco Melika (with Claude Code)

## Problem

MemBridge ships as an Electron `.app` via GitHub releases. Today the build only
**ad-hoc signs** the bundle in [`scripts/afterPack.js`](../../../scripts/afterPack.js)
(`codesign --sign -`). Ad-hoc signing only stops Apple Silicon from reporting the app
as "damaged"; the app is still **unsigned and un-notarized**, so the README tells users
to *right-click → Open* on first launch (README:140), and macOS 15 (Sequoia) has removed
that right-click bypass entirely (users must dig into System Settings → Privacy &
Security).

The user's goal: **the application opens with no warning**, at **$0**, and the same
install must also set up the `membridge` **CLI**.

## Key insight (why curl/zip, not a DMG)

Proper notarization is the *only* mechanism that makes a **browser-downloaded**,
double-clicked `.app` launch silently, and it requires the paid Apple Developer Program
($99/year — per *year*, not month; no individual student discount). A free Apple ID
**cannot** notarize. That path is **out of scope**.

The free lever: **Gatekeeper only inspects files carrying the `com.apple.quarantine`
extended attribute, and that attribute is set by the *downloader* (Safari, Chrome,
Mail) — not by `curl`, `git`, or `npm`.** So the winning move is to **change the
delivery channel, not fight Gatekeeper**:

- A browser-downloaded DMG/zip is quarantined → the first launch always shows one
  Gatekeeper prompt. No free way around it.
- A **`curl`-downloaded release zip is never quarantined**. Unzip it, ad-hoc signature
  already satisfies the arm64 kernel, and it launches **clean, zero prompts, $0**.

So delivery is a **`curl | sh` one-liner that installs a pinned GitHub release zip** —
no browser DMG at all.

## Goals

- One `curl | sh` command installs **both** the menu-bar app **and** the `membridge`
  CLI.
- `MemBridge.app` opens with **no Gatekeeper warning**, and every relaunch is silent.
- **Zero** Gatekeeper prompts (curl never quarantines; we also strip quarantine as
  belt-and-suspenders).
- The CLI is fully self-contained — **no system Node.js required** to run it.
- Deterministic + tamper-evident: the installer pins an exact release (version +
  SHA-256), not "latest".
- No paid dependencies; no change to the existing ad-hoc signature.

## Non-goals

- Developer ID code signing or Apple notarization ($99/yr).
- **A browser DMG or `.command` GUI installer** — explicitly dropped; curl/zip only.
- Windows / Linux installer changes (the CLI already ships cross-platform via npm).
- Auto-update / Sparkle; a Homebrew tap (possible later).
- Intel (x64) builds — the release is arm64; Intel users use the npm CLI for now
  (arch-detection hook noted below for when an x64/universal zip exists).

## Architecture

**One hosted install script pulls a pinned release zip; the app carries the CLI inside it.**

```
   curl -fsSL https://membridge.me/install.sh | sh      (zero prompts)
                        │
                        ▼
      install.sh  (pinned: version + SHA-256)
   ┌──────────────────────────────────────────────┐
   │ download  MemBridge-<ver>-arm64.zip  (curl)   │  ← never quarantined
   │ verify    SHA-256 == pinned hash              │
   │ quit any running instance                     │
   │ unzip →   /Applications/MemBridge.app         │
   │ xattr -dr com.apple.quarantine  (belt/susp.)  │  → app opens, NO warning
   │ write     /usr/local/bin/membridge  (wrapper) │  → CLI works, no system Node
   │ open      MemBridge.app                        │
   └──────────────────────────────────────────────┘
```

### Component 1 — Bundle the CLI into the app

The packaged app bundles `lib/` (and `node_modules/libsodium*`) but **not**
`bin/membridge.js` — confirmed by [`lib/hooks.js:278`](../../../lib/hooks.js) ("the
packaged app bundles lib/ but not bin/") and by inspecting the built `app.asar`.

Change: [`scripts/prepare-app.js`](../../../scripts/prepare-app.js) copies `bin/` →
`app/bin` alongside its existing `lib/` → `app/lib` copy, so `app.asar/bin/membridge.js`
sits as a sibling of `app.asar/lib/` — exactly the layout
[`lib/autostart.js:11`](../../../lib/autostart.js) already assumes
(`path.join(__dirname, '..', 'bin', 'membridge.js')`).

**Why this is low-risk:** the app already runs its own Node code via the bundled Electron
runtime. [`lib/hooks.js:285`](../../../lib/hooks.js) emits an `ELECTRON_RUN_AS_NODE=1`
prefix whenever `process.versions.electron` is set, and
[`lib/membridge-hook.js`](../../../lib/membridge-hook.js) documents the
`ELECTRON_RUN_AS_NODE=1 "<runtime>" "<this file>"` command shape. Running
`bin/membridge.js` the same way needs **no rework** of the hook/autostart machinery.

### Component 2 — CLI launcher wrapper

Installed to `/usr/local/bin/membridge`, a small shell stub emitted by `install.sh`:

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

### Component 3 — The install script (`scripts/install/install.sh`)

POSIX `sh`, idempotent, safe to re-run, `set -eu`. This is the single deliverable users
run. Steps, in order:

1. **Preflight:** confirm macOS + arm64 (`uname`); if not arm64, print the npm CLI
   fallback and exit cleanly.
2. **Download** the pinned release asset with `curl -fsSL` to a temp dir:
   `https://github.com/mmelika/membridge/releases/download/v<VER>/MemBridge-<VER>-arm64.zip`.
   `curl` does not set `com.apple.quarantine`, which is the whole point.
3. **Verify** the downloaded zip's SHA-256 against the pinned hash baked into the script;
   abort loudly on mismatch (tamper-evidence for `curl | sh`).
4. **Quit** any running instance (`osascript -e 'quit app "MemBridge"'`, fallback
   `pkill`), using the app's PID file (`util.pidPath()`) where possible.
5. **Install the app:** unzip and replace `/Applications/MemBridge.app`.
6. **Strip quarantine:** `xattr -dr com.apple.quarantine "/Applications/MemBridge.app"`
   — belt-and-suspenders (curl already avoids it, but re-installs from other channels
   may not).
7. **Install the CLI wrapper:** write the Component-2 stub to `/usr/local/bin/membridge`,
   `chmod +x`. If `/usr/local/bin` is missing or not writable (the default on stock
   Apple Silicon), `mkdir -p` and/or fall back to `sudo` with a clear one-line prompt.
   A failure here must **not** abort the already-successful app install — it degrades to
   a printed manual instruction.
8. **Launch + report:** `open "/Applications/MemBridge.app"`, print success, and confirm
   `membridge` resolves on `PATH`.

A `--dry-run` mode prints the planned actions without touching the system (for tests /
cautious users).

### Component 4 — Pinning & publishing

- **Deterministic artifact name.** Set electron-builder `mac.artifactName` to
  `MemBridge-${version}-${arch}.zip` so the release URL is predictable. `mac.target`
  becomes `["zip"]` (drop `dmg`).
- **Pinned install.sh.** The version and the zip's SHA-256 are stamped into `install.sh`
  at release time by a tiny generator (`scripts/install/gen-install.js`) that reads the
  built zip, computes its hash, and writes the final `install.sh`. This keeps the pin in
  exactly one place (the built artifact) and makes the hosted script tamper-evident.
- **Hosting.** The generated `install.sh` is published over HTTPS at
  **`https://membridge.me/install.sh`** (served from the `mmelika/membridge-site`
  GitHub Pages repo the user owns). Raw `githubusercontent.com` is the fallback host.
- **README** gains the one-liner + a plain-English note that this installs the app and
  the `membridge` CLI with no warnings.

### Component 5 — Keep ad-hoc signing

[`scripts/afterPack.js`](../../../scripts/afterPack.js) is unchanged
(`codesign --force --deep --sign -`). Keep it **explicit** rather than trusting
electron-builder's default — this repo added afterPack precisely because the default left
arm64 builds unsigned and Gatekeeper called them "damaged" (see the file's own comment).
Ad-hoc signing satisfies the arm64 kernel; quarantine-avoidance removes the *warning*.
The two are complementary and both free.

## Risks & open verification items

- **`/usr/local/bin` writability** on stock Apple Silicon → `mkdir -p` + `sudo` fallback
  with explicit messaging. Never silently fail the CLI step.
- **autostart from inside Electron** ([`lib/autostart.js`](../../../lib/autostart.js)
  uses `process.execPath`) — hooks already emit `ELECTRON_RUN_AS_NODE`; confirm the
  start-at-login launch agent does too (the existing start-at-login feature implies it
  works; verify).
- **asar path stability** — the wrapper hardcodes
  `Contents/Resources/app.asar/bin/membridge.js`; confirm across builds and that `bin/`
  is not `asarUnpack`-excluded.
- **install.sh ↔ release drift** — the generator must run on every release so the pinned
  version + SHA-256 match the published zip; a stale `install.sh` fails the SHA check
  loudly (acceptable, not silent).
- **Replacing a running app** — quit first; the app writes a PID file (`util.pidPath()`).
- **`curl | sh` trust** — mitigated by HTTPS + pinned SHA-256; document that users can
  download and read `install.sh` before running it.
- **Intel Macs** — no x64 zip today; preflight prints the npm CLI fallback.

## Testing

- **Unit (node harness, `test/run-tests.js`):** assert `scripts/prepare-app.js` produces
  `app/bin/membridge.js` (the bundling contract); assert `gen-install.js` stamps the
  correct version + a matching SHA-256 into `install.sh` for a fixture zip.
- **Shell:** `shellcheck` `install.sh`; exercise its `--dry-run` path.
- **Manual E2E (clean Apple Silicon machine):**
  1. `npm run dist:mac` → `gen-install.js` → publish → `curl -fsSL …/install.sh | sh`
     → confirm **zero** prompts, app opens, `membridge --version` works in a fresh shell.
  2. Corrupt the pinned hash → confirm the SHA-256 check aborts before installing.
  3. Re-run the installer with the app running → confirms clean replace (idempotency).

## Rollout

1. Bundle CLI (`prepare-app.js`) + wrapper + `install.sh` + `gen-install.js` + tests.
2. Set `mac.target=["zip"]` and a deterministic `artifactName`; `npm run dist:mac`.
3. Run `gen-install.js` against the built zip; publish `install.sh` to membridge.me.
4. Update README with the one-liner; cut a release; smoke-test the curl path on a clean
   machine.
