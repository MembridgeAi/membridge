'use strict';
// QA finding B: `membridge --version` / `--help` must not load node:sqlite.
//
// lib/search-index.js used to require node:sqlite at module scope, and
// bin/membridge.js loads lib/server.js + lib/activity.js (-> search-index) on
// EVERY command. So every invocation paid for SQLite, and on the whole Node 22
// LTS line -- where node:sqlite is unflagged from 22.13 but still EXPERIMENTAL,
// and which `engines.node: >=22` explicitly supports -- Node printed
//   (node:NNNN) ExperimentalWarning: SQLite is an experimental feature...
// to stderr before any output, on `membridge --version` included.
//
// WHY THIS TEST IS VERSION-INDEPENDENT. It never looks for the warning text:
// on Node 24 there is no warning to find, so a text assertion would pass here
// while the regression shipped to everyone on Node 22. It asserts the actual
// cause instead -- whether node:sqlite was LOADED -- by reading
// process.moduleLoadList in the child. That is true or false on every Node.
//
// The positive control matters as much as the negative one: lazy must still
// mean loaded-when-needed, so the last two checks prove requiring the module
// does not load SQLite but calling open() does.

const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, BIN } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// A --require preload that reports, at exit, whether the process ever loaded
// SQLite. moduleLoadList entries look like "NativeModule sqlite" /
// "Internal Binding sqlite".
const PROBE = path.join(ROOT, 'sqlite-load-probe.js');
fs.writeFileSync(PROBE,
  "process.on('exit', () => {\n" +
  "  console.log('SQLITE_LOADED=' + process.moduleLoadList.some(m => /sqlite/i.test(m)));\n" +
  "});\n");

const SEARCH_INDEX = path.join(__dirname, '..', '..', 'lib', 'search-index.js');

function readProbe(res, what) {
  const all = `${res.stdout || ''}${res.stderr || ''}`;
  const m = all.match(/SQLITE_LOADED=(true|false)/);
  assert.ok(m, `probe never reported for ${what} (exit ${res.status}):\n${all || '(no output)'}`);
  return { loaded: m[1] === 'true', all };
}

// Run the CLI under the probe.
function cli(...args) {
  const res = spawnSync(process.execPath, ['--require', PROBE, BIN, ...args],
    { env: process.env, encoding: 'utf8' });
  return { ...readProbe(res, `membridge ${args.join(' ')}`), status: res.status };
}

// Run a snippet under the probe (for the module-level positive control).
function snippet(code, label) {
  const res = spawnSync(process.execPath, ['--require', PROBE, '-e', code],
    { env: process.env, encoding: 'utf8' });
  return { ...readProbe(res, label), status: res.status };
}

const version = cli('--version');
check('`membridge --version` does not load node:sqlite', () => {
  assert.strictEqual(version.loaded, false,
    'node:sqlite was loaded on the --version path -- something requires it at module scope '
    + 'again (search-index.js must require it lazily, inside open()). On Node 22 LTS this '
    + `prints an ExperimentalWarning on every command.\noutput: ${version.all}`);
  assert.strictEqual(version.status, 0, `--version exited ${version.status}`);
});

const help = cli('--help');
check('`membridge --help` does not load node:sqlite', () => {
  assert.strictEqual(help.loaded, false,
    `node:sqlite was loaded on the --help path.\noutput: ${help.all}`);
  assert.strictEqual(help.status, 0, `--help exited ${help.status}`);
});

const required = snippet(`require(${JSON.stringify(SEARCH_INDEX)});`, 'require(search-index)');
check('requiring lib/search-index.js alone does not load node:sqlite', () => {
  assert.strictEqual(required.loaded, false,
    'merely requiring search-index.js pulled in node:sqlite -- the require was hoisted back '
    + `to module scope.\noutput: ${required.all}`);
});

// Positive control: lazy must still load when the index is actually used.
const opened = snippet(
  `const i = require(${JSON.stringify(SEARCH_INDEX)}); const db = i.open(); i.close(db);`,
  'searchIndex.open()');
check('searchIndex.open() still loads node:sqlite and opens the index', () => {
  assert.strictEqual(opened.status, 0,
    `open() failed (exit ${opened.status}) -- the lazy require is broken:\n${opened.all}`);
  assert.strictEqual(opened.loaded, true,
    `open() did not load node:sqlite, so it cannot have opened a database.\noutput: ${opened.all}`);
});

h.finish();
