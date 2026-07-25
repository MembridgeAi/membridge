'use strict';
// Stamps a pinned release (version + SHA-256 of the built zip) into the macOS
// install script. Run after `npm run dist:mac`:
//   node scripts/install/gen-install.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

/** Hex SHA-256 digest of a file's bytes. */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Replace the pin placeholders in the template with concrete values. */
function renderInstallScript(template, { version, sha256 }) {
  return template
    .replace(/__MEMBRIDGE_VERSION__/g, version)
    .replace(/__MEMBRIDGE_SHA256__/g, sha256);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  // Must track build.mac.artifactName in package.json (MemBridge-...).
  const asset = `MemBridge-${version}-arm64.zip`;
  const zipPath = path.join(ROOT, 'dist', asset);
  if (!fs.existsSync(zipPath)) {
    console.error(`Built zip not found: ${zipPath}\nRun "npm run dist:mac" first.`);
    process.exit(1);
  }
  const sha256 = sha256File(zipPath);
  const tmpl = fs.readFileSync(path.join(__dirname, 'install.sh.tmpl'), 'utf8');
  const out = renderInstallScript(tmpl, { version, sha256 });
  const outPath = path.join(__dirname, 'install.sh');
  fs.writeFileSync(outPath, out);
  fs.chmodSync(outPath, 0o755);
  console.log(`Wrote ${outPath}\n  version ${version}\n  sha256  ${sha256}`);
}

if (require.main === module) main();
module.exports = { sha256File, renderInstallScript };
