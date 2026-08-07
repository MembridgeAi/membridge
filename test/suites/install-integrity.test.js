'use strict';
// The install and update path — the widest blast radius in the product. A
// compromise here reaches every install, not one team, and unlike every other
// surface audited it decides whether the software is what it claims to be.
//
// Every check PASSES. These are the properties that are cheap to lose and
// invisible when lost: the repo has already shipped four releases with the live
// installer pinned to a stale version and nothing noticing, which is a
// staleness bug with the same shape as a supply-chain one — nobody checking
// what is actually being served.
//
// Offline. It cannot check what membridge.app serves right now; that was done
// separately by fetching the live script and diffing it against this repo
// (identical at 0.3.2 on 2026-08-05). This suite guards the repo copy, which is
// what the next release is cut from.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install', 'install.sh');
const sh = fs.readFileSync(INSTALLER, 'utf8');
const pinned = name => (sh.match(new RegExp(`^${name}="([^"]*)"`, 'm')) || [])[1];

async function main() {
  // THE FOUR-SURFACES PROBLEM, reduced to the three this repo controls. These
  // must agree and nothing verified that they did — which is how the live site
  // served an installer pinned to 0.2.8 across 0.2.9, 0.3.0 and 0.3.1, so the
  // documented install command delivered a version nobody was shipping.
  await check('the installer version matches both package manifests', () => {
    const root = require(path.join(ROOT, 'package.json')).version;
    const app = require(path.join(ROOT, 'app', 'package.json')).version;
    assert.strictEqual(app, root, 'app/package.json must track the root manifest');
    assert.strictEqual(pinned('VERSION'), root,
      `install.sh pins ${pinned('VERSION')} but the manifest says ${root}. The ` +
      'installer downloads a release asset by this version, so a stale pin ships ' +
      'the wrong build to everyone using the documented install command.');
  });

  // THE PROPERTY THAT MAKES THE GITHUB LEG UNTRUSTED, and the one whose loss
  // would be silent. Without it the installer takes whatever the release URL
  // returns; with it, replacing a release asset alone is not enough to land
  // code — the attacker must also change the script that carries the hash.
  await check('the installer verifies a pinned SHA-256 and refuses on mismatch', () => {
    assert.match(pinned('SHA256') || '', /^[0-9a-f]{64}$/,
      'SHA256 must be a full pinned digest');
    assert.match(sh, /shasum -a 256/, 'the digest must actually be computed');
    assert.match(sh, /\[ "\$GOT" = "\$SHA256" \] \|\| die/,
      'a mismatch must REFUSE the install, not warn and continue — a checksum ' +
      'that is computed and then ignored is worse than none, because it reads ' +
      'as verification');
  });

  await check('the release asset is fetched over https from the expected repo', () => {
    assert.strictEqual(pinned('REPO'), 'MembridgeAi/membridge',
      'the release repo is a trust anchor; a changed owner is a changed publisher');
    const url = (sh.match(/^URL="([^"]*)"/m) || [])[1] || '';
    assert.match(url, /^https:\/\/github\.com\/\$\{REPO\}\/releases\/download\//,
      'the asset URL must be https and derived from REPO, not a free-standing host');
  });

  // curl is invoked with -f, so an HTTP error page cannot be saved as if it were
  // the asset and then fail the checksum with a confusing message.
  await check('the download fails hard rather than saving an error page', () => {
    assert.match(sh, /curl -fsSL/, 'curl must use -f so a 4xx/5xx is not written to disk');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
