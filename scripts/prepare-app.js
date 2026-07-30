'use strict';
// Copies lib/ into app/lib so the Electron app dir is self-contained
// (electron-builder two-package layout packages only what's inside app/).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'app', 'lib');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(root, 'lib'), dest, { recursive: true });
console.log('app/lib refreshed from lib/');

// Copies bin/ into app/bin so the packaged app.asar carries the CLI entrypoint
// (bin/membridge.js) beside lib/. A wrapper on the user's PATH runs it via the
// app's own Electron-as-Node runtime — no system Node required.
const binDest = path.join(root, 'app', 'bin');
fs.rmSync(binDest, { recursive: true, force: true });
fs.cpSync(path.join(root, 'bin'), binDest, { recursive: true });
console.log('app/bin refreshed from bin/');

// The app version must always track the root package.json — a stale
// app/package.json version labels a fresh build as an old release.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Copies the runtime dependency closure into app/node_modules so the packaged
// app can require what lib/ requires (app/package.json declares no deps, so
// electron-builder installs nothing on its own). The walk must be transitive:
// libsodium-wrappers is a thin wrapper whose engine is the separate
// `libsodium` package — bundling only the wrapper leaves require() throwing
// inside the asar, and team encryption pauses fail-closed on every build.
// A dep missing from root node_modules throws here: a loud build failure
// beats an app that quietly cannot encrypt.
const modDest = path.join(root, 'app', 'node_modules');
fs.rmSync(modDest, { recursive: true, force: true });
const bundled = new Set();
const queue = Object.keys(rootPkg.dependencies || {});
while (queue.length) {
  const name = queue.shift();
  if (bundled.has(name)) continue;
  bundled.add(name);
  const src = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  fs.cpSync(src, path.join(modDest, name), { recursive: true });
  queue.push(...Object.keys(pkg.dependencies || {}));
}
console.log(`app/node_modules refreshed (${[...bundled].sort().join(', ')})`);

// Copies vendor/grammars (the tree-sitter wasm files fetched by
// scripts/fetch-grammars.js and committed to the repo) into the app bundle.
// lib/skeleton.js resolves these relative to its own location at runtime, so
// the packaged asar needs them alongside app/node_modules/web-tree-sitter —
// same rationale as the libsodium closure above: missing here means the
// packaged app can only ever fall back to lib/skeleton-strip.js.
const vendorSrc = path.join(root, 'vendor', 'grammars');
const vendorDest = path.join(root, 'app', 'vendor', 'grammars');
fs.rmSync(path.join(root, 'app', 'vendor'), { recursive: true, force: true });
if (fs.existsSync(vendorSrc)) {
  fs.cpSync(vendorSrc, vendorDest, { recursive: true });
  console.log('app/vendor/grammars refreshed from vendor/grammars/');
} else {
  console.warn('vendor/grammars missing — packaged app will fall back to lib/skeleton-strip.js for every file');
}

// Copies the built React UI (ui/dist, a Vite build) into app/ui/dist so
// lib/server.js's UI_DIST_ROOT — path.join(__dirname, '..', 'ui', 'dist'),
// resolved from wherever lib/ itself ends up — finds it inside the packaged
// asar too, at the mirrored app/ui/dist. Same tolerance as vendor/grammars
// above: a missing build warns rather than failing the whole packaging step,
// because `npm run build` in ui/ is a separate step that may not have run
// yet; the packaged app then serves lib/server.js's own 503 at /app instead
// of crashing.
const uiDistSrc = path.join(root, 'ui', 'dist');
const uiDistDest = path.join(root, 'app', 'ui', 'dist');
fs.rmSync(path.join(root, 'app', 'ui'), { recursive: true, force: true });
if (fs.existsSync(uiDistSrc)) {
  fs.cpSync(uiDistSrc, uiDistDest, { recursive: true });
  console.log('app/ui/dist refreshed from ui/dist/');
} else {
  console.warn('ui/dist missing — packaged app will serve a 503 at /app until `cd ui && npm run build` runs');
}

const appPkgPath = path.join(root, 'app', 'package.json');
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
if (appPkg.version !== rootPkg.version) {
  appPkg.version = rootPkg.version;
  fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n');
  console.log(`app version synced to ${rootPkg.version}`);
}
