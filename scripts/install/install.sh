#!/bin/sh
# MemBridge macOS installer — installs the app + `membridge` CLI, no Gatekeeper warning.
# Pinned to one release (version + SHA-256) by scripts/install/gen-install.js.
#   curl -fsSL https://membridge.me/install.sh | sh
#   curl -fsSL https://membridge.me/install.sh | sh -s -- --dry-run
set -eu

VERSION="0.1.0"
SHA256="a8f979d1380e1a20fa8dfc1ceab60fc1ab1ca68100e6aceefd34722753291863"
REPO="MembridgeAi/membridge"
APP_NAME="MemBridge"
APP_DEST="/Applications/${APP_NAME}.app"
CLI_DEST="/usr/local/bin/membridge"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf '\033[1;34mmembridge\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mmembridge error\033[0m %s\n' "$1" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# 1. Preflight
[ "$(uname -s)" = "Darwin" ] || die "macOS only. On Linux/Windows: npm i -g membridge"
[ "$(uname -m)" = "arm64" ] || die "No prebuilt app for $(uname -m) yet. On Intel Macs: npm i -g membridge"
command -v curl   >/dev/null 2>&1 || die "curl is required."
command -v shasum >/dev/null 2>&1 || die "shasum is required."

ASSET="${APP_NAME}-${VERSION}-arm64.zip"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"

# 2. Download (curl never sets com.apple.quarantine — this is the whole point)
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

# 6. Strip quarantine (belt-and-suspenders; curl already avoids it)
run "xattr -dr com.apple.quarantine '$APP_DEST' 2>/dev/null || true"

# 7. Install the CLI wrapper (runs the bundled CLI via the app's Electron-as-Node)
if [ "$DRY_RUN" = 1 ]; then
  printf '  [dry-run] write %s (Electron-as-Node wrapper)\n' "$CLI_DEST"
else
  WRAPPER="$TMP/membridge"
  cat > "$WRAPPER" <<EOF
#!/bin/sh
APP="${APP_DEST}"
exec env ELECTRON_RUN_AS_NODE=1 "\$APP/Contents/MacOS/${APP_NAME}" "\$APP/Contents/Resources/app.asar/bin/membridge.js" "\$@"
EOF
  chmod +x "$WRAPPER"
  BIN_DIR="$(dirname "$CLI_DEST")"
  if mkdir -p "$BIN_DIR" 2>/dev/null && [ -w "$BIN_DIR" ] && cp "$WRAPPER" "$CLI_DEST" && chmod +x "$CLI_DEST"; then
    say "CLI installed at ${CLI_DEST}"
  elif sudo mkdir -p "$BIN_DIR" && sudo cp "$WRAPPER" "$CLI_DEST" && sudo chmod +x "$CLI_DEST"; then
    say "CLI installed at ${CLI_DEST}"
  else
    say "Couldn't install the CLI automatically. Add it later with:"
    cat <<MANUAL
  sudo mkdir -p ${BIN_DIR}
  sudo tee ${CLI_DEST} >/dev/null <<'SH'
#!/bin/sh
APP="${APP_DEST}"
exec env ELECTRON_RUN_AS_NODE=1 "\$APP/Contents/MacOS/${APP_NAME}" "\$APP/Contents/Resources/app.asar/bin/membridge.js" "\$@"
SH
  sudo chmod +x ${CLI_DEST}
MANUAL
  fi
fi

# 8. Launch + report
run "open '$APP_DEST'"
say "Done. ${APP_NAME} is installed and opens with no warning."
if command -v membridge >/dev/null 2>&1; then
  say "CLI ready: $(command -v membridge)"
else
  say "CLI installed — open a new terminal (ensure /usr/local/bin is on PATH) to use 'membridge'."
fi
