'use strict';
// Dev-time only: downloads prebuilt tree-sitter grammar .wasm files from their
// npm packages and vendors them under vendor/grammars/ so `npm install` never
// needs network access to run lib/skeleton.js. Run this once (or whenever a
// grammar version bump is wanted) and COMMIT the resulting wasm files —
// they are the point of vendoring, not a build artifact to .gitignore.
//
// Each grammar package ships its wasm at the tarball root (verified by
// inspecting `npm pack` output for all four packages during development), so
// the recipe per package is: `npm pack` into a scratch dir, extract, copy the
// .wasm(s) out, delete the scratch dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'grammars');

// pkg@version pinned for reproducibility; wasm entries map the file name
// inside the tarball to the name we vendor it under (tree-sitter-typescript
// ships two grammars — typescript and tsx — in one package).
const GRAMMARS = [
  { pkg: 'tree-sitter-typescript', version: '0.23.2', wasm: [
    { src: 'tree-sitter-typescript.wasm', dest: 'tree-sitter-typescript.wasm' },
    { src: 'tree-sitter-tsx.wasm', dest: 'tree-sitter-tsx.wasm' },
  ] },
  { pkg: 'tree-sitter-javascript', version: '0.25.0', wasm: [
    { src: 'tree-sitter-javascript.wasm', dest: 'tree-sitter-javascript.wasm' },
  ] },
  { pkg: 'tree-sitter-python', version: '0.25.0', wasm: [
    { src: 'tree-sitter-python.wasm', dest: 'tree-sitter-python.wasm' },
  ] },
  { pkg: 'tree-sitter-go', version: '0.25.0', wasm: [
    { src: 'tree-sitter-go.wasm', dest: 'tree-sitter-go.wasm' },
  ] },
];

// Candidate LICENSE file names, in the order npm packages commonly use them.
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License', 'license'];

function findLicense(extractDir) {
  for (const name of LICENSE_NAMES) {
    const p = path.join(extractDir, 'package', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fetchOne(grammar, scratchDir) {
  const spec = `${grammar.pkg}@${grammar.version}`;
  console.log(`fetching ${spec}...`);
  const tarballName = execFileSync(
    'npm', ['pack', spec, '--pack-destination', scratchDir, '--silent'],
    { encoding: 'utf8', cwd: scratchDir }
  ).trim().split('\n').pop();
  const tarballPath = path.join(scratchDir, tarballName);
  const extractDir = path.join(scratchDir, grammar.pkg);
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['xzf', tarballPath, '-C', extractDir], { encoding: 'utf8' });

  const found = [];
  for (const w of grammar.wasm) {
    const src = path.join(extractDir, 'package', w.src);
    if (!fs.existsSync(src)) {
      console.warn(`  MISSING ${grammar.pkg}: no ${w.src} in the published tarball — skipping`);
      continue;
    }
    const destPath = path.join(VENDOR_DIR, w.dest);
    fs.copyFileSync(src, destPath);
    const { size } = fs.statSync(destPath);
    console.log(`  vendored ${w.dest} (${(size / 1024).toFixed(1)} KB)`);
    found.push(w.dest);
  }

  // Every vendored .wasm ships with no licence text of its own, so carry the
  // source package's LICENSE along too — one copy per grammar name (not per
  // package), since tree-sitter-typescript's single package/licence covers
  // both the typescript and tsx grammars it vendors.
  const licenseSrc = findLicense(extractDir);
  if (!licenseSrc) {
    console.warn(`  MISSING ${grammar.pkg}: no LICENSE file in the published tarball — skipping licence vendoring`);
  } else {
    for (const w of grammar.wasm) {
      if (!found.includes(w.dest)) continue; // only for grammars actually vendored above
      const grammarName = w.dest.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '');
      const licenseDest = path.join(VENDOR_DIR, `LICENSE-${grammarName}.txt`);
      fs.copyFileSync(licenseSrc, licenseDest);
      console.log(`  vendored LICENSE-${grammarName}.txt`);
    }
  }

  return found;
}

function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-grammars-'));
  const vendored = [];
  try {
    for (const grammar of GRAMMARS) {
      vendored.push(...fetchOne(grammar, scratchDir));
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  console.log(`done: ${vendored.length} grammar file(s) in ${VENDOR_DIR}`);
  if (!vendored.length) {
    console.error('no grammars vendored — lib/skeleton.js will fall back to the stripper for everything');
    process.exitCode = 1;
  }
}

main();
