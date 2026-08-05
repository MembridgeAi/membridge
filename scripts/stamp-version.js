#!/usr/bin/env node
'use strict';
// Stamps app/package.json from the root package.json, and nothing else.
//
// WHY THIS EXISTS AS ITS OWN SCRIPT: app/package.json is a COMMITTED file that
// app.getVersion() reads, so an Electron run from source reports whatever is in
// git — but the only thing that had ever written it was scripts/prepare-app.js,
// at the end of a full packaging run. Releases here bump the root version by
// hand (docs/releasing-macos.md step 1), and 0.2.9 and 0.3.0 were both cut
// without anyone running a build in between, so the committed app manifest sat
// at 0.2.8 while the root said 0.3.0. Every shipped dmg was still correct,
// because packaging stamps it — but the repo could not state its own version,
// and `npm version` had no cheap hook to call.
//
// So: no dependency closure, no staging, no ui build — just the manifest sync.
// It runs on a fresh clone with no node_modules, which prepare-app.js cannot.
//
// Use it either way round:
//   npm version 0.3.1          # the `version` lifecycle script runs this and
//                              # stages the result INTO the release commit
//   node scripts/stamp-version.js   # after bumping the root version by hand
//
// If it is forgotten entirely, the committed-lockstep check in test/run-tests.js
// fails CI on the pushed commit and names this command.
const path = require('path');
const { syncAppManifest } = require('./prepare-app');

const root = path.join(__dirname, '..');
const drifted = syncAppManifest(root);

// Print the outcome either way. A silent no-op is indistinguishable from a
// script that did not run, which is the whole failure mode this addresses.
if (drifted.length) {
  const { version } = require(path.join(root, 'package.json'));
  console.log(`app/package.json stamped from root (${drifted.join(', ')}); version now ${version}`);
  console.log('Commit app/package.json alongside the root bump.');
} else {
  console.log('app/package.json already in lockstep with the root package.json; nothing to do.');
}
