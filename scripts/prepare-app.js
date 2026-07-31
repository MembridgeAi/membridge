'use strict';
// Copies lib/ into app/lib so the Electron app dir is self-contained
// (electron-builder two-package layout packages only what's inside app/).
//
// Structure: everything is STAGED into a temp dir first, validated, and only
// then swapped into app/. The old shape (rmSync the target, then copy) meant
// any mid-run failure — a missing package, a bad ui build, even ctrl-C —
// left app/ gutted, and the test suite spawns this script on every run.
// Nothing under app/ is deleted until every copy has already succeeded.
const fs = require('fs');
const path = require('path');
const { uiDistGate, ALLOW_ENV } = require('./lib/ui-dist-gate');

// Escape hatch for packaging without the vendored tree-sitter grammars, same
// convention as ui-dist-gate's MEMBRIDGE_ALLOW_MISSING_UI (see that file for
// why an env var and not a CLI flag). A missing vendor/grammars used to be a
// warning that scrolled past in CI, permanently shipping an app that could
// only ever fall back to lib/skeleton-strip.js for every file.
const GRAMMARS_ALLOW_ENV = 'MEMBRIDGE_ALLOW_MISSING_GRAMMARS';

// Pure and dependency-injected like uiDistGate, so both branches are testable
// without deleting the real vendor/grammars out from under the suite.
function grammarsGate({ exists, allowMissing }) {
  if (exists) return null;
  if (allowMissing) {
    return {
      fatal: false,
      message: `vendor/grammars missing — packaging without tree-sitter grammars because ${GRAMMARS_ALLOW_ENV} is set. `
        + 'The packaged app will fall back to lib/skeleton-strip.js for every file.',
    };
  }
  return {
    fatal: true,
    message: 'vendor/grammars missing — refusing to package an app that can never parse code.\n'
      + '  Fix:  node scripts/fetch-grammars.js\n'
      + `  Or, to package without grammars on purpose:  ${GRAMMARS_ALLOW_ENV}=1`,
  };
}

// Resolve a package directory the way require() does: walk up from the
// depending package's own directory, checking each node_modules on the way,
// stopping at the repo root. The old walk assumed node_modules/<name> at the
// TOP LEVEL for every package — npm does not guarantee hoisting (reproduced:
// `npm ci --omit=dev` leaves cross-spawn's `which` only at
// node_modules/cross-spawn/node_modules/which), and that assumption aborted
// the whole run with ENOENT. Returns null when nothing resolves.
function resolvePkgDir(name, fromDir, stopDir) {
  let dir = path.resolve(fromDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The runtime dependency closure the packaged app needs. The walk must be
// transitive: libsodium-wrappers is a thin wrapper whose engine is the
// separate `libsodium` package — bundling only the wrapper leaves require()
// throwing inside the asar, and team encryption pauses fail-closed on every
// build. It must ALSO follow optionalDependencies (the old walk didn't):
// platform-specific optionals otherwise vanish from the asar and require()
// fails only in the packaged app. An optional that isn't installed is
// legitimately absent (that is what optional means) and is skipped; a hard
// dependency that doesn't resolve throws — a loud build failure beats an app
// that quietly cannot encrypt. The ENOENT wording is load-bearing:
// test/run-tests.js recognizes it to skip (not fail) on checkouts with no
// root npm install.
function collectClosure(rootDir, rootPkg) {
  const bundled = new Map(); // name -> resolved source dir
  const skippedOptional = [];
  const queue = [];
  const enqueue = (deps, fromDir, optional) => {
    for (const name of Object.keys(deps || {})) queue.push({ name, fromDir, optional });
  };
  enqueue(rootPkg.dependencies, rootDir, false);
  enqueue(rootPkg.optionalDependencies, rootDir, true);
  while (queue.length) {
    const { name, fromDir, optional } = queue.shift();
    if (bundled.has(name)) continue;
    const src = resolvePkgDir(name, fromDir, rootDir);
    if (!src) {
      if (optional) { skippedOptional.push(name); continue; }
      throw new Error(`ENOENT: no node_modules/${name} resolvable from ${fromDir} — run npm install at the repo root`);
    }
    bundled.set(name, src);
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    enqueue(pkg.dependencies, src, optional);
    // deps-of-optionals are only as mandatory as the optional that pulled
    // them in, and optionals stay optional at every depth.
    enqueue(pkg.optionalDependencies, src, true);
  }
  return { bundled, skippedOptional };
}

function main() {
  const root = path.join(__dirname, '..');

  // Both gates are checked FIRST, before anything is even staged: an aborted
  // packaging run must leave app/ exactly as it found it. See
  // scripts/lib/ui-dist-gate.js for why a missing UI is fatal.
  const uiDistSrc = path.join(root, 'ui', 'dist');
  const uiGate = uiDistGate({
    exists: fs.existsSync(uiDistSrc),
    allowMissing: !!process.env[ALLOW_ENV],
  });
  if (uiGate && uiGate.fatal) {
    console.error(uiGate.message);
    process.exit(1);
  }
  const vendorSrc = path.join(root, 'vendor', 'grammars');
  const vGate = grammarsGate({
    exists: fs.existsSync(vendorSrc),
    allowMissing: !!process.env[GRAMMARS_ALLOW_ENV],
  });
  if (vGate && vGate.fatal) {
    console.error(vGate.message);
    process.exit(1);
  }

  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // Resolve the whole closure before copying anything: an unresolvable hard
  // dependency aborts here, with app/ untouched.
  const { bundled, skippedOptional } = collectClosure(root, rootPkg);

  // Stage under app/ itself (not os.tmpdir()) so the final renames stay on
  // one filesystem and are therefore atomic.
  const stage = fs.mkdtempSync(path.join(root, 'app', '.prepare-stage-'));
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(stage, 'lib'), { recursive: true });

    // bin/ rides along so the packaged app.asar carries the CLI entrypoint
    // (bin/membridge.js) beside lib/. A wrapper on the user's PATH runs it via
    // the app's own Electron-as-Node runtime — no system Node required.
    fs.cpSync(path.join(root, 'bin'), path.join(stage, 'bin'), { recursive: true });

    for (const [name, src] of bundled) {
      fs.cpSync(src, path.join(stage, 'node_modules', name), { recursive: true });
    }

    // vendor/grammars (the tree-sitter wasm files fetched by
    // scripts/fetch-grammars.js and committed to the repo) goes into the
    // bundle because lib/skeleton.js resolves it relative to its own location
    // at runtime — same rationale as the libsodium closure above.
    if (!vGate) fs.cpSync(vendorSrc, path.join(stage, 'vendor', 'grammars'), { recursive: true });

    // The built React UI (ui/dist, a Vite build) mirrors to app/ui/dist so
    // lib/server.js's UI_DIST_ROOT — path.join(__dirname, '..', 'ui', 'dist'),
    // resolved from wherever lib/ itself ends up — finds it inside the
    // packaged asar too. Reaching here with no ui/dist means the escape hatch
    // was set on purpose (the fatal branch already exited above).
    if (!uiGate) fs.cpSync(uiDistSrc, path.join(stage, 'ui', 'dist'), { recursive: true });

    // Validate the staged tree before destroying anything in app/.
    for (const rel of ['lib', path.join('bin', 'membridge.js')]) {
      if (!fs.existsSync(path.join(stage, rel))) throw new Error(`staging incomplete: ${rel} missing`);
    }
    for (const name of bundled.keys()) {
      if (!fs.existsSync(path.join(stage, 'node_modules', name, 'package.json'))) {
        throw new Error(`staging incomplete: node_modules/${name} missing`);
      }
    }

    // Swap. Only now does anything under app/ get removed, and each staged
    // dir replaces its target via a same-filesystem rename. A dir with
    // nothing staged (ui/vendor under an escape hatch) is still cleared, so
    // the output layout matches the escape hatch exactly.
    for (const dir of ['lib', 'bin', 'node_modules', 'vendor', 'ui']) {
      const dest = path.join(root, 'app', dir);
      fs.rmSync(dest, { recursive: true, force: true });
      if (fs.existsSync(path.join(stage, dir))) fs.renameSync(path.join(stage, dir), dest);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  console.log('app/lib refreshed from lib/');
  console.log('app/bin refreshed from bin/');
  console.log(`app/node_modules refreshed (${[...bundled.keys()].sort().join(', ')})`);
  if (skippedOptional.length) {
    console.log(`optional dependencies not installed locally, not bundled: ${skippedOptional.sort().join(', ')}`);
  }
  if (vGate) console.warn(vGate.message);
  else console.log('app/vendor/grammars refreshed from vendor/grammars/');
  if (uiGate) console.warn(uiGate.message);
  else console.log('app/ui/dist refreshed from ui/dist/');

  // app/package.json must always track the root package.json — a stale
  // version labels a fresh build as an old release (the 0.2.1/0.2.2 dmgs
  // self-reported 0.2.0), and electron-builder stamps license/author/
  // description into the bundle while its own module collection resolves
  // against app/package.json's dependencies. Sync all of it so none of these
  // can drift again.
  const appPkgPath = path.join(root, 'app', 'package.json');
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
  const synced = {
    version: rootPkg.version,
    description: rootPkg.description,
    author: rootPkg.author,
    license: rootPkg.license,
    dependencies: rootPkg.dependencies || {},
  };
  const drifted = Object.keys(synced)
    .filter(k => JSON.stringify(appPkg[k]) !== JSON.stringify(synced[k]));
  if (drifted.length) {
    Object.assign(appPkg, synced);
    fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n');
    console.log(`app package.json synced from root (${drifted.join(', ')})`);
  }
}

if (require.main === module) main();

module.exports = { grammarsGate, GRAMMARS_ALLOW_ENV, resolvePkgDir, collectClosure };
