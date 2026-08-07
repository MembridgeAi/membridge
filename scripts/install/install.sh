#!/bin/sh
# MemBridge macOS installer. Installs the signed, notarized app plus the `membridge` CLI.
# Pinned to one release (version + SHA-256) by scripts/install/gen-install.js.
#   curl -fsSL https://membridge.app/install.sh | sh
#   curl -fsSL https://membridge.app/install.sh | sh -s -- --dry-run
set -eu

VERSION="0.3.4"
SHA256="aa760da05442f7deb0e11e37dcdd75c254b8feee0a709560dae12a3c6cd8c274"
REPO="MembridgeAi/membridge"
APP_NAME="MemBridge"
APP_DEST="/Applications/${APP_NAME}.app"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf '\033[1;34mmembridge\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mmembridge error\033[0m %s\n' "$1" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# 1. Preflight
[ "$(uname -s)" = "Darwin" ] || die "macOS only. On Linux/Windows: npm i -g @membridgeai/membridge"
[ "$(uname -m)" = "arm64" ] || die "No prebuilt app for $(uname -m) yet. On Intel Macs: npm i -g @membridgeai/membridge"
command -v curl   >/dev/null 2>&1 || die "curl is required."
command -v shasum >/dev/null 2>&1 || die "shasum is required."

ASSET="${APP_NAME}-${VERSION}-arm64.zip"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"

# 2. Download the release asset, then verify it against the pinned SHA-256 below.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading ${APP_NAME} ${VERSION}..."
run "curl -fsSL '$URL' -o '$TMP/$ASSET'"

# 3. Verify the pin
if [ "$DRY_RUN" != 1 ]; then
  GOT="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  [ "$GOT" = "$SHA256" ] || die "checksum mismatch (expected $SHA256, got $GOT). Refusing to install."
  say "Checksum verified."
fi

# 4. Quit any running instance so the bundle can be replaced
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] quit + kill any running %s\n' "$APP_NAME"
else
  osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
  pkill -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || true
fi

# 5. Install the app
say "Installing to ${APP_DEST}..."
run "rm -rf '$APP_DEST'"
run "mkdir -p '$TMP/unzip'"
run "ditto -x -k '$TMP/$ASSET' '$TMP/unzip'"
run "mv '$TMP/unzip/${APP_NAME}.app' '$APP_DEST'"

# 6. Install the CLI wrapper (runs the bundled CLI via the app's Electron-as-Node)
#
# NO SUDO anywhere in this script: the in-app updater re-runs it from a
# detached, non-interactive spawn where a sudo password prompt can only hang
# or fail. Install into the first user-writable bin dir instead:
#   /opt/homebrew/bin  (already on PATH on every Homebrew arm64 Mac)
#   ~/.local/bin       (created if needed; warned about if not on PATH)
# CLI_STATUS carries the truthful outcome to the final report:
#   ready | not_on_path | failed
CLI_STATUS="failed"
CLI_DEST=""
BIN_DIR=""
if [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then
  BIN_DIR="/opt/homebrew/bin"
elif mkdir -p "$HOME/.local/bin" 2>/dev/null && [ -w "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
fi
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] write %s/membridge (Electron-as-Node wrapper)\n' "${BIN_DIR:-<no writable bin dir>}"
  CLI_DEST="${BIN_DIR:-$HOME/.local/bin}/membridge"
  CLI_STATUS="ready"
elif [ -n "$BIN_DIR" ]; then
  CLI_DEST="$BIN_DIR/membridge"
  WRAPPER="$TMP/membridge"
  cat > "$WRAPPER" <<EOF
#!/bin/sh
APP="${APP_DEST}"
exec env ELECTRON_RUN_AS_NODE=1 "\$APP/Contents/MacOS/${APP_NAME}" "\$APP/Contents/Resources/app.asar/bin/membridge.js" "\$@"
EOF
  chmod +x "$WRAPPER"
  # Delete the destination before writing it. `cp` FOLLOWS a symlink at the
  # destination and writes through to its target, and `membridge` is very
  # often a symlink: `npm link` (the standard dev setup, and how anyone
  # working on MemBridge has it) points /opt/homebrew/bin/membridge at
  # lib/node_modules/membridge, which points at the developer's own checkout.
  # Without this rm, installing overwrites bin/membridge.js IN THEIR REPO
  # with this 3-line shim -- silently, since cp succeeds. Observed on a real
  # machine: 1191 lines of CLI replaced, and the only symptom was an
  # unrelated-looking wave of test failures.
  rm -f "$CLI_DEST"
  if cp "$WRAPPER" "$CLI_DEST" && chmod +x "$CLI_DEST"; then
    say "CLI installed at ${CLI_DEST}"
    case ":$PATH:" in
      *":$BIN_DIR:"*) CLI_STATUS="ready" ;;
      *)
        CLI_STATUS="not_on_path"
        say "Note: ${BIN_DIR} is not on your PATH. Add this to your shell profile:"
        printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
        ;;
    esac
  fi
fi
if [ "$CLI_STATUS" = "failed" ]; then
  CLI_DEST=""
  say "Couldn't install the CLI automatically (no user-writable bin dir). Add it yourself:"
  cat <<MANUAL
  mkdir -p \$HOME/.local/bin
  cat > \$HOME/.local/bin/membridge <<'SH'
#!/bin/sh
APP="${APP_DEST}"
exec env ELECTRON_RUN_AS_NODE=1 "\$APP/Contents/MacOS/${APP_NAME}" "\$APP/Contents/Resources/app.asar/bin/membridge.js" "\$@"
SH
  chmod +x \$HOME/.local/bin/membridge
  export PATH="\$HOME/.local/bin:\$PATH"
MANUAL
fi

# 6b. Register the MCP server with every AI tool this user actually has.
#
# HERE, and not left to the daemon, because this runs in the user's own shell:
# `claude` resolves off the real PATH (nvm, volta, asdf, a custom prefix) with
# no searching, and what it resolves is recorded so later launches never have
# to search either. A GUI-launched app inherits roughly /usr/bin:/bin and would
# often find nothing at all.
#
# NEVER ABORTS. Registration is a convenience; a MemBridge that installed fine
# but could not write someone's Cursor config must still be an install that
# succeeded. `|| true` under `set -e`, and the CLI itself reports per agent.
#
# </dev/null matters: this script is routinely run as `curl ... | sh`, so
# stdin is the REST OF THIS SCRIPT. A child that reads stdin would eat it.
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] %s mcp register\n' "$CLI_DEST"
elif [ -n "$CLI_DEST" ] && [ -x "$CLI_DEST" ]; then
  say "Registering the MemBridge MCP server with your AI tools..."
  "$CLI_DEST" mcp register </dev/null || say "MCP registration didn't complete. Run 'membridge mcp register' later. The install is fine."
fi

# 6c. Launch at login, via the app's own headless flag (see app/main.js:
# `MemBridge --set-login=on` flips the Electron login item and exits without
# opening any UI), so MemBridge survives reboots. Best-effort: guarded so a
# failure here can never fail the install. </dev/null for the same reason as
# mcp register above. Under `curl | sh`, stdin is the rest of this script.
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] %s --set-login=on\n' "$APP_DEST/Contents/MacOS/$APP_NAME"
else
  "$APP_DEST/Contents/MacOS/$APP_NAME" --set-login=on >/dev/null 2>&1 </dev/null \
    || say "Couldn't enable launch at login. Toggle 'Start at login' in the tray menu."
fi

# 7. Launch + report (truthful: say what actually happened to the CLI)
run "open '$APP_DEST'"
say "Done. ${APP_NAME} is installed."
case "$CLI_STATUS" in
  ready)
    if command -v membridge >/dev/null 2>&1; then
      say "CLI ready: $(command -v membridge)"
    else
      say "CLI installed at ${CLI_DEST}. Open a new terminal to use 'membridge'."
    fi
    ;;
  not_on_path)
    say "CLI installed at ${CLI_DEST}, but that directory isn't on your PATH yet. See the note above."
    ;;
  *)
    say "CLI not installed. See the manual steps above."
    ;;
esac
