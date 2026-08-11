---
name: ship-release
description: Cut and verify a MemBridge release, including notarization and published-artifact checks. Use when tagging a version, after a release build finishes, when regenerating the installer pin, or when confirming that what users actually download works. Covers the signals that have lied here before.
---

# Shipping and verifying a release

**No agent tags, publishes, or creates a release.** An agent prepares and
verifies; a human publishes. This skill is mostly about the verification,
because that is the part that has gone wrong.

`docs/releasing-macos.md` is the canonical procedure. Follow it, do not
paraphrase it from memory, and read it again each time because it encodes
ordering that matters. This skill adds the checks that document does not.

## Three signals that have lied here

1. **A green CI log is not proof a binary is signed.** Verify the asset a user
   would actually download, from the URL they would download it from.
2. **A 200 is not proof a download works.** Check the content type. An HTML
   error page returns 200 and saves happily as a `.dmg`.
3. **The repo working is not proof the product works.** The npm tarball has
   shipped without the UI before. Test the published artifact, not the checkout.

## Order that matters

Publishing the GitHub release triggers the **Build app** workflow, and CI's
zips are the canonical assets, attached with `--clobber`. **Never stamp the
installer pin from a locally built zip.** CI will overwrite the asset and your
SHA-256 will no longer match anything. Wait for the release's Build app run to
finish, download the CI asset, then stamp.

The site repo is `mmelika/membridge-site` and it serves from **`main`, not
`master`**. A push to `master` there creates an unserved branch and looks like
a successful deploy. In the same commit, bump `softwareVersion` in the JSON-LD
block of `index.html`; nothing verifies it, so it goes stale silently and
mis-reports the current version to crawlers.

## Verify the downloaded macOS asset

Download it the way a user would, then:

```sh
hdiutil attach ~/Downloads/MemBridge-<version>-arm64.dmg -nobrowse
APP=$(ls -d "/Volumes/MemBridge"*/*.app | head -1); echo "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Identifier=|Authority|TeamIdentifier'
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -t exec -vvv "$APP"
xcrun stapler validate "$APP"
```

All four must be true. `spctl` says `accepted` with `source=Notarized Developer
ID`, `stapler` says the validate action worked, `codesign --verify` is silent
on success, and the Team ID matches the expected one. A signed but unstapled
app passes `codesign` and still prompts users who are offline.

Then confirm the install path end to end on a clean Apple Silicon machine:

```sh
curl -fsSL https://membridge.app/install.sh | sh
membridge --version
```

Zero Gatekeeper prompts, and the version must match the release.

## Verify the download URL itself

```sh
curl -sIL "<asset url>" | grep -iE '^(HTTP/|content-type|content-length|location)'
```

`content-type` must be an octet stream or a zip type, not `text/html`. A
`content-length` in the low kilobytes for a 200MB app means you fetched an
error page.

## Verify the npm package

Check what was published, not what is in the checkout:

```sh
npm view @membridgeai/membridge version dist-tags
npm pack @membridgeai/membridge@<version>
tar tzf membridgeai-membridge-<version>.tgz | grep -c 'ui/dist'
```

`ui/dist` must be present. Unpacked size collapsing back toward a few hundred
KB means the UI did not ship. Install it clean into a scratch directory and run
the CLI before believing it.

## Cross-check the release itself

```sh
gh release view v<version> --json tagName,assets,isLatest
gh run list --branch master --limit 3
```

Confirm every expected asset is attached, the tag points where you think, and
CI on that commit succeeded. Version numbers in `package.json` and
`app/package.json` stay in lockstep and a check enforces it; if they disagree,
stop.

## Report

List each artifact you verified, the command you ran, and its actual output.
"Verified" without the output is not verification, and this is the exact area
where confident summaries have been wrong before.
