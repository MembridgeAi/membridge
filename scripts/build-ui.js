#!/usr/bin/env node
'use strict';
// Builds the React dashboard into ui/dist. Wired to `prepack`, not
// `prepublishOnly`.
//
// prepublishOnly fires only on `npm publish`. A hand-run `npm pack` would
// therefore ship whatever ui/dist happened to be lying in the tree, which
// means the F1 tarball test would be verifying the developer's last local
// build instead of what publishing actually produces. prepack fires on
// `npm pack` AND `npm publish`, so the artifact and the thing under test
// become the same thing.
//
// KNOWN GAP, measured not assumed: npm's docs say prepack also runs when a
// consumer installs the package as a git dependency. On npm 11.13.0 it does
// not. Installing this repo with `npm i git+file://...#branch` completes in
// 8s, runs no lifecycle script, and yields a package with no ui/ directory
// at all -- the F1 defect, reached by a different road. `prepare` is the
// hook that still fires on git installs, but it also fires on every plain
// `npm install` in this repo, which would make CI build the UI during the
// root `npm ci --omit=dev` step that deliberately runs BEFORE ui/ deps are
// installed. Left as prepack on purpose: the registry tarball is the
// documented and primary channel and is fully covered, and a git install is
// not a channel this project advertises. Revisit if that changes.
//
// Dependencies are installed only when ui/node_modules is absent. `npm ci`
// deletes node_modules before it installs, and prepack fires on every
// `npm pack` -- which the suite itself runs. Installing unconditionally
// would wipe and refetch a developer's ui/ tree on every `npm test`, and
// would do it while other checks in the same run are reading ui/dist.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, '..', 'ui');

function run(args) {
  const r = spawnSync('npm', args, {
    cwd: UI,
    // Build chatter goes to STDERR, never stdout. prepack fires inside
    // `npm pack --json`, whose stdout is a data channel: vite's "built in
    // 105ms" banner landing there makes the JSON unparseable for every
    // consumer, which is exactly how this broke the vendor/grammars check
    // in the suite. Diagnostics are not data.
    stdio: ['inherit', process.stderr, 'inherit'],
    // On Windows npm is npm.cmd, which Node refuses to spawn without a shell
    // (EINVAL since the CVE-2024-27980 hardening). The args are static
    // strings, so the shell introduces no quoting hazard.
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    console.error(`\nbuild-ui: \`npm ${args.join(' ')}\` failed in ui/ (${why}).`);
    console.error('The npm tarball must not ship without ui/dist: an install with no');
    console.error('dashboard is the defect this script exists to prevent. Failing loudly.');
    process.exit(1);
  }
}

if (!fs.existsSync(path.join(UI, 'node_modules'))) {
  console.error('build-ui: ui/node_modules is absent, installing from the lockfile');
  run(['ci', '--no-audit', '--no-fund']);
}
run(['run', 'build']);
