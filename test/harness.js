'use strict';
// Shared plumbing for the split test suites under test/suites/.
//
// REQUIRE THIS FIRST — before any ../lib module. Requiring it sets the
// MEMBRIDGE_* env overrides that point every lib read/write at a throwaway
// per-process temp ROOT, exactly like the prelude of test/run-tests.js.
// A suite that requires a lib module before this file reads the REAL user
// config, which is the incident class the guards at the bottom exist for.
//
// run-tests.js does NOT use this module (yet): its own prelude is duplicated
// here on purpose. Refactoring the 25k-line legacy suite onto this harness
// would churn every line number in a file teammates have in-flight branches
// against; sections migrate out of it into test/suites/ instead, and the
// legacy prelude dies when the last section leaves.
// FIRST of all: no suite talks to a real host unless it says so. The four baked
// production defaults, and why an empty env var is not a way to turn them off,
// are documented in test/no-egress.js. This was missing here entirely -- the
// counters opt-out existed only in run-tests.js's setupFixtures, so all 26
// split suites ran with counters, diagnostics and TEAM SYNC pointed at the
// live backend.
const noEgress = require('./no-egress');
noEgress.install();

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-test-'));
process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home');
process.env.MEMBRIDGE_CLAUDE_DIR = path.join(ROOT, 'claude-projects');
process.env.MEMBRIDGE_CODEX_DIR = path.join(ROOT, 'codex-sessions');
process.env.MEMBRIDGE_INTERVAL = '3600';
delete process.env.ANTHROPIC_API_KEY; // a real key on the dev machine must not leak into settings tests

// Same safety net as run-tests.js: never strand ROOT (it contains .membridge
// markers the real daemon would treat as tracked-project evidence).
let rootCleaned = false;
function cleanupRoot() {
  if (rootCleaned) return;
  rootCleaned = true;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanupRoot);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanupRoot(); process.exit(1); });
}

// Real-file leak guards (see the incident history in run-tests.js): snapshot
// before any fixture code runs, assert at finish(). The state guard keys off
// the 'membridge-test-' ROOT prefix above — keep the two in sync.
//
// KNOWN_READS_UNOWNED_FILE: ~/.membridge/config.json — leak-detection snapshot. Rare-writer file (only when a user runs membridge signup/login), so external-writer flake is not the practical concern mcp-wiring's ~/.claude.json is. Cannot use a fixture: the whole point is to prove no fixture leaked into the real path. See test/suites/tests-own-their-state.test.js.
// KNOWN_READS_UNOWNED_FILE: ~/.membridge/state.json — same, for the state file. Detected leak = a fixture path ended up in the real user's state (see the incident history in run-tests.js's top-of-file comment).
const REAL_CONFIG_PATH = path.join(os.homedir(), '.membridge', 'config.json');
function snapshotRealConfig() {
  try { return fs.readFileSync(REAL_CONFIG_PATH, 'utf8'); } catch { return null; }
}
const realConfigBeforeSuite = snapshotRealConfig();

const REAL_STATE_PATH = path.join(os.homedir(), '.membridge', 'state.json');
function realStateLeakedFixtureKeys() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(REAL_STATE_PATH, 'utf8')); } catch { return []; }
  const keys = Object.keys((parsed && parsed.projects) || {});
  return keys.filter(k => /membridge-test-/.test(k));
}

// ---- test ports: one shifted block per process (same scheme and range as
// run-tests.js, so concurrent suites — or a suite next to a live daemon —
// land on disjoint blocks) ----
const PORT_BASE = (() => {
  // test/run.js assigns each concurrent suite a distinct verified-free block.
  const assigned = Number(process.env.MEMBRIDGE_TEST_PORT_BASE || '');
  if (Number.isFinite(assigned) && assigned >= 17900) return assigned;
  // Running this suite DIRECTLY: the block is derived from the pid and is not
  // verified free. There used to be a probe loop here that claimed to verify
  // it; the probe read `server.listening` synchronously after
  // `listen(port, '127.0.0.1')`, which is always false because that overload
  // defers through a DNS lookup, so it reported every port busy, every block
  // failed, and this returned the same unverified pid guess it returns now —
  // while reading like a checked answer. The keeper bind below is the only
  // real signal, and it warns when the block is already taken.
  return 17900 + ((process.pid % 40) * 100);
})();
const P = n => PORT_BASE + n;

// RESERVE the block for this process's lifetime by holding base+99 (test/run.js
// probes it before handing the block out). A suite may not bind its first real
// server for minutes, and a second run starting in that window would adopt the
// same block and cross-talk — observed live as two concurrent runs corrupting
// each other's results in both directions. +99 is above the highest offset any
// suite binds (+96). unref() so the keeper never holds the process open; a bind
// error is not fatal, but it is the one hard evidence that this block is
// already in use, so it is said out loud rather than swallowed.
{
  const net = require('net');
  const keeper = net.createServer();
  keeper.on('error', () => {
    process.stderr.write(`warning: port block ${PORT_BASE} is already held by another run; this suite may cross-talk with it\n`);
  });
  keeper.listen(PORT_BASE + 99, '127.0.0.1');
  keeper.unref();
}

const results = [];
// Supports both sync and async fn; async callers must `await check(...)`.
function check(name, fn) {
  const onOk = () => { results.push([name, null]); console.log(`  ok    ${name}`); };
  const onErr = err => { results.push([name, err]); console.log(`  FAIL  ${name}\n        ${err.message}`); };
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') return ret.then(onOk, onErr);
    onOk();
  } catch (err) {
    onErr(err);
  }
}

const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const read = f => fs.readFileSync(f, 'utf8');
// SOURCE-SHAPE reads (assertions about committed bytes) go through this, never
// read(): Windows checkouts materialize \r\n and silently change what regexes
// mean. Kept separate because some suites assert \r is PRESERVED via read().
const readSource = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const count = (hay, needle) => hay.split(needle).length - 1;

const notRoot = () => typeof process.getuid !== 'function' || process.getuid() !== 0;

// Canonical spelling of a path for comparing against paths GIT wrote to disk
// (macOS /var -> /private/var; Windows 8.3 short names).
const realCanon = p => {
  try { return fs.realpathSync.native(p); } catch {
    try { return fs.realpathSync(p); } catch { return p; }
  }
};

// Minimal OpenAI/Gemini-shaped JSON mock; returns the listening http.Server.
function startJsonMock(port, handler) {
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch {}
      handler(req, body, (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); });
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

async function waitForHttp(url, ms = 15000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr && lastErr.message}`);
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const httpGet = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then(r => r.json());
const httpPost = (port, p, body) => post(`http://127.0.0.1:${port}${p}`, body).then(r => r.json());

const BIN = path.join(__dirname, '..', 'bin', 'membridge.js');

// Every suite ends with this: leak guards, tally, exit code. The tally line
// format ("N/M checks passed") is load-bearing — test/run.js greps for it to
// tell "green" from "crashed before the summary printed".
function finish() {
  check('the suite never wrote to the real (non-MEMBRIDGE_HOME) ~/.membridge/config.json', () => {
    assert.strictEqual(snapshotRealConfig(), realConfigBeforeSuite,
      'the real user config changed during this run -- MEMBRIDGE_HOME isolation leaked');
  });
  check('the suite never leaked one of its own OS-temp fixture paths into the real ~/.membridge/state.json', () => {
    const leaked = realStateLeakedFixtureKeys();
    assert.deepStrictEqual(leaked, [],
      `the real state.json tracks a project shaped like this suite's own fixtures: ${JSON.stringify(leaked)}`);
  });
  assert.ok(results.length > 2, 'suite registered no checks of its own -- the file is vacuous');
  const failed = results.filter(([, e]) => e);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  cleanupRoot();
  if (failed.length) process.exit(1);
}

module.exports = {
  ROOT, P, PORT_BASE, BIN,
  check, results, finish,
  noEgress,
  jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost,
};
