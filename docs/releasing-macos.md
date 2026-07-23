# Releasing the macOS installer

The `curl | sh` installer is pinned to one release (version + SHA-256). Every
release regenerates and republishes `install.sh`.

1. Bump `version` in `package.json` (and let `scripts/prepare-app.js` sync
   `app/package.json` on the next build).
2. Create the GitHub release tagged `v<version>`. Publishing the release
   triggers the **Build app** workflow, which builds the macOS and Windows
   zips on CI and attaches them with `--clobber` — CI's zips are the
   canonical assets. Do NOT stamp the pin from a locally built zip: CI will
   overwrite the asset and the SHA-256 will no longer match.
3. Wait for the release's **Build app** run to finish, then download the
   CI-built asset and stamp the pin from it:
   ```sh
   curl -fsSL -o dist/MemBridge-<version>-arm64.zip \
     https://github.com/MembridgeAi/membridge/releases/download/v<version>/MemBridge-<version>-arm64.zip
   node scripts/install/gen-install.js
   ```
   It prints the version + SHA-256 it embedded.
4. (The asset name must match `MemBridge-<version>-arm64.zip` — the installer
   builds the download URL from it.)
5. Publish `install.sh` so `https://membridge.me/install.sh` serves it: copy
   `scripts/install/install.sh` to the root of the `mmelika/membridge-site`
   repo as `install.sh`, commit, and push (GitHub Pages serves it). The raw
   fallback URL, which works without the site repo, is
   `https://raw.githubusercontent.com/MembridgeAi/membridge/master/scripts/install/install.sh`.
6. Commit the regenerated `scripts/install/install.sh` in this repo.
7. Smoke-test on a clean Apple Silicon machine:
   ```sh
   curl -fsSL https://membridge.me/install.sh | sh
   membridge --version
   ```
   Confirm zero Gatekeeper prompts on the app.
