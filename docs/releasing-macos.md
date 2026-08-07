# Releasing a new version

This is the whole sequence for cutting a release: the npm package, the GitHub
release, and the `curl | sh` macOS installer pin. It is written from the 0.3.4
cut, which hit every trap this file now warns about.

Two facts drive the entire procedure and explain why it is not one command:

- **`release.yml` (npm publish) runs from the git TAG, not from `master`.** If
  the tag is behind `master`, npm ships stale code. Always check first.
- **Signed macOS builds are NOT byte-reproducible.** Every build produces a
  different SHA-256. So the installer pin can only be stamped from the exact
  asset the release actually serves, and that asset does not exist until CI has
  built it. This forces a two-phase `install.sh`.

## Before you start: the tree must be green on `ci.yml`, not just `build-app`

`ci.yml` runs `node test/run.js`, the full `ui` vitest suite, AND
`cd ui && npm run build` (`tsc --noEmit && vite build`). `build-app.yml` does
NOT run the ui typecheck. So a ui type error is invisible on `build-app` and
red only on `ci.yml` — and `release.yml`'s npm publish shares that same
`cd ui && npm run build` step, so a red `ci.yml` means a dead npm publish.

Check `ci.yml`, not just `build-app`, before releasing:

```sh
gh run list --repo MembridgeAi/membridge --workflow ci.yml --limit 3 \
  --json headSha,conclusion
```

Landmine that bit 0.3.4: a test file imported `node:fs` / used `__dirname` but
`@types/node` was declared nowhere. It passed locally (transitively present)
and failed in CI's lockfile-exact install and in `release.yml`'s
`npm ci --omit=dev` root install. If `tsc` needs a type package, it must be a
declared dependency of the workspace that uses it — never rely on a transitive
copy being hoisted.

## Step 1 — check the tag is not stale, and decide the version

```sh
git rev-list --count v<previous>..origin/master
git log --oneline v<previous>..origin/master
```

If `master` is ahead of the version you were about to cut, do NOT force the old
tag over unrelated new work silently. Decide the version deliberately (a patch
bump that supersedes a never-released tag is clean — that is what 0.3.4 did to
an unreleased 0.3.3). This is a call for the human if it is not obvious.

## Step 2 — bump the version and push

```sh
npm version <patch|minor|major> --no-git-tag-version
git add package.json app/package.json package-lock.json
git commit -m "<version>"
git push origin master
```

`npm version` runs the `version` script (`scripts/stamp-version.js`), which
stamps `app/package.json` — a committed file `app.getVersion()` reads. Commit
it in the same commit; CI fails on that drift.

This push makes `install-integrity` go **red** (install.sh still pins the old
version). That is expected. The `build-app.yml` reorder uploads the signed
artifact BEFORE the test gate, so the artifact is still produced despite the
red. Do not try to make this push green — the next step fixes it.

## Step 3 — stamp install.sh from the push-build artifact (phase one)

Wait for the `build-app` run on your bump commit to upload `membridge-mac`
(~5–6 min; the run itself goes red at the test — ignore that), then:

```sh
RUN=$(gh run list --repo MembridgeAi/membridge --workflow build-app.yml \
  --branch master --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$RUN" --repo MembridgeAi/membridge --name membridge-mac --dir /tmp/rel
mkdir -p dist && cp /tmp/rel/MemBridge-<version>-arm64.zip dist/
node scripts/install/gen-install.js       # prints the version + SHA it embedded
node test/run.js install-integrity        # confirm green locally
git add scripts/install/install.sh
git commit -m "chore(install): regenerate install.sh for <version>"
git push origin master
```

Now `install-integrity` is green on `master`, which is what lets the
release-event `build-app` run pass its test gate and attach assets in step 5.
The SHA pinned here is the push-build's; step 6 reconciles it to the
release-build's asset.

Also update the CHANGELOG (`## Unreleased` → `## <version> — <date>`), commit,
push.

## Step 4 — tag and push the tag

```sh
git tag -a v<version> -m "<version> — <one line>"
git push origin v<version>
```

The tag must point at a commit whose `install.sh` version matches the manifest
(green `install-integrity`) AND whose ui build passes (green `ci.yml`).

## Step 5 — create the release (this publishes; it is the irreversible step)

```sh
awk '/^## <version>/{f=1} /^## <prev>/{f=0} f' CHANGELOG.md > /tmp/notes.md
gh release create v<version> --repo MembridgeAi/membridge --title "v<version>" \
  --notes-file /tmp/notes.md \
  dist/MemBridge-<version>-arm64.zip /tmp/rel/MemBridge-<version>-arm64.dmg
```

`release: published` fires two workflows in parallel:

- **Release** → `npm publish` via OIDC trusted publishing. This is CI-only; you
  cannot `npm publish` locally. Watch it succeed:
  `gh run list --repo MembridgeAi/membridge --event release`.
- **Build app** → rebuilds and re-attaches the signed assets with `--clobber`.
  CI's asset is the canonical one; it will overwrite the assets you attached
  above.

If the npm publish fails: fix the cause on `master`, force-move the tag to the
fix commit (`git tag -f v<version> <sha>; git push --force origin v<version>`),
then `gh release delete v<version> --yes` and recreate it — deleting and
recreating is what re-fires `release: published`; `gh run rerun` re-runs the
OLD commit and will not help. npm never publishes a partial version, so a
failed publish leaves the registry clean to retry.

## Step 6 — reconcile install.sh to the release asset (phase two)

After the release-event `build-app` run finishes, the release serves a
freshly-built asset with a different SHA than the one you pinned in step 3.
Stamp the pin from what the release actually serves:

```sh
curl -fsSL -o dist/MemBridge-<version>-arm64.zip \
  https://github.com/MembridgeAi/membridge/releases/download/v<version>/MemBridge-<version>-arm64.zip
node scripts/install/gen-install.js
git add scripts/install/install.sh
git commit -m "chore(install): stamp install.sh from the v<version> release asset"
git push origin master
```

Do NOT skip this. Without it, `curl | sh` computes the release asset's SHA,
finds it does not match the pin, and `die`s.

## Step 7 — publish install.sh to the site (human: Marco)

`https://membridge.app/install.sh` is served by the `mmelika/membridge-site`
repo, branch `main` (NOT `master` — a push to `master` there serves nothing and
looks successful). Copy `scripts/install/install.sh` to that repo's root,
commit, push to `main`. In the same commit bump `"softwareVersion"` in the
JSON-LD block of `index.html` — it tracks the public release, nothing verifies
it, and it goes stale silently. Until this lands, the site keeps installing and
advertising the previous release no matter what this repo says.

The raw fallback that works without the site repo is
`https://raw.githubusercontent.com/MembridgeAi/membridge/master/scripts/install/install.sh`.

## Step 8 — clean up and smoke-test

```sh
git push --delete origin v<superseded>   # if you bumped past an unreleased tag
curl -fsSL https://membridge.app/install.sh | sh
membridge --version
```

Confirm zero Gatekeeper prompts on the app.

## The shape of the whole thing

```
check ci.yml green  ->  check tag not stale  ->  bump+push (red is fine)
  ->  stamp install.sh from push artifact (green)  ->  CHANGELOG
  ->  tag+push  ->  gh release create (npm + assets fire)
  ->  reconcile install.sh from the release asset  ->  site deploy (Marco)
```

Two `install.sh` commits per release is correct, not a mistake: one to turn the
tree green so the release build can attach, one to match the asset the release
finally serves.
