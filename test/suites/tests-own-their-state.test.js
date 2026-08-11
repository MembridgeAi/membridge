'use strict';
// A test that owns the file it asserts on cannot be flaked by an external
// writer. Run via `node test/run.js tests-own-their-state`, or directly.
//
// WHY THIS SUITE EXISTS (#77). verify-finding.js gates a failing test PHANTOM
// when it passes N runs in isolation on a quiet machine, and the standing rule
// is to drop PHANTOMs — because 99% of the time PHANTOM means "the failure was
// scheduler starvation, not a defect", and re-fixing working code to silence a
// measurement error is the worst outcome available.
//
// The 1% case is a test that reads a file the OS keeps rewriting on its own
// cadence. Failures cluster under load because that is when live sessions run
// (which is what the load IS), not because of scheduler contention — and the
// gate's model cannot tell the two apart: in 3 isolated runs the external
// writer may simply not have fired. The mcp-wiring check surfaced this: it
// snapshots the developer's real ~/.claude.json (rewritten every ~minute by
// any active Claude Code session) and asserts byte-identity.
//
// The judgement #77 chose from three: fix at authoring time, rather than widen
// verify-finding to guess which files might have external writers. The gate's
// contract stays narrow-and-correct; the responsibility for file ownership sits
// where it belongs — with the test author.
//
// SHAPE. Any test file that mentions `os.homedir()` must declare, at the top,
// one of these two intents:
//
//   NO_UNOWNED_FILE_READS: <reason>
//     "this file references os.homedir() but does not fs.<read> via it"
//     -- fixture strings that are never touched on disk, calls into product
//     code with homedir as an argument, assertions on a computed path.
//
//   KNOWN_READS_UNOWNED_FILE: <path text> — <why owning it is not an option>
//     "this file reads <path>, and here is why the test cannot just use a
//     fixture" -- one marker per distinct read.
//
// The point isn't the string. The point is the AUTHOR forced to write "who
// else writes to this file?" before the check goes green. That question is
// what separates the 1% case (mcp-wiring reading ~/.claude.json every minute)
// from the 99% (harness.js reading rarely-touched ~/.membridge/config.json
// for leak detection).
//
// SCOPE. Only files test/run.js discovers. Standalone scripts like
// test/teammate-notes-e2e.js are not audited because they never run in the
// suite; a test that no orchestrator runs cannot flake an orchestrator.
//
// NO_UNOWNED_FILE_READS: this file mentions os.homedir() only inside example strings above
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '..');

function testFilesInScope() {
  const files = [path.join(TEST_DIR, 'run-tests.js'), path.join(TEST_DIR, 'harness.js')];
  const suiteDir = path.join(TEST_DIR, 'suites');
  for (const f of fs.readdirSync(suiteDir).sort()) {
    if (f.endsWith('.test.js')) files.push(path.join(suiteDir, f));
  }
  return files;
}

const FS_READ_FNS = ['readFileSync', 'readFile', 'statSync', 'stat', 'lstatSync', 'lstat',
  'existsSync', 'accessSync', 'access', 'readdirSync', 'readdir', 'realpathSync', 'realpath'];

// Detects the CANONICAL homedir read forms this repo actually uses. The two
// limits below are named honestly, and they are what the file-level marker
// requirement is designed to cover:
//
//   • Module-scope-only binding capture. A `const X = path.join(os.homedir(),
//     ...)` at column 0 is captured; a nested one (mcp-wiring's
//     REAL_AGENT_FILES at 4-space indent, or a shadowing `const home =
//     os.homedir()` inside a test block) is NOT, because module-wide capture
//     would cross scopes and produce false positives on unrelated fixture
//     vars with the same name (observed live: `home = fs.mkdtempSync(...)`
//     inside a fixture block would collide with a `home = os.homedir()`
//     inside a different test block).
//
//   • Direct-only argument scan. `fs.<read>(EXPR)` sinks are detected when
//     EXPR contains `os.homedir()` literally OR a module-scope binding name.
//     `.map(f => fs.readFileSync(f, ...))` where `f` came from an
//     array-of-homedir-paths (mcp-wiring's shape) is missed by the sink
//     scanner -- but the OUTER mention scan still triggers the file-level
//     marker requirement.
//
// So: the sink list is a lower bound. The FILE-LEVEL marker requirement is
// the upper bound. Together they force the question at authoring time.
function scanFile(src) {
  const homedirModuleBindings = new Set();
  // Module-scope only: a `const NAME = ...` at column 0.
  const moduleBindingRe = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);(?=\s*(?:\n|$))/gm;
  let m;
  while ((m = moduleBindingRe.exec(src)) !== null) {
    if (/\bos\.homedir\s*\(\s*\)/.test(m[2])) homedirModuleBindings.add(m[1]);
  }

  // Sinks: fs.<read>(<arg containing os.homedir() or a module binding>).
  const sinks = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const fn of FS_READ_FNS) {
      const needle = `fs.${fn}(`;
      let from = 0;
      while (true) {
        const at = lines[i].indexOf(needle, from);
        if (at === -1) break;
        const rest = lines.slice(i, Math.min(lines.length, i + 6)).join('\n').slice(at + needle.length - 1);
        const arg = extractParenArg(rest);
        const reaches = /\bos\.homedir\s*\(\s*\)/.test(arg)
          || [...homedirModuleBindings].some(name => new RegExp(`\\b${name}\\b`).test(arg));
        if (reaches) sinks.push({ line: i + 1, fn: `fs.${fn}`, arg: arg.split('\n')[0].slice(0, 120) });
        from = at + needle.length;
      }
    }
  }

  // Construction count: each `path.join(os.homedir(), ...)` whose last string
  // literal ends in a file extension. This is the marker floor -- one per
  // named file the author has put in code. The extension gate excludes
  // directory names like '.codex' (mcp-agent-discovery's assertion target)
  // and keeps only literals that are unambiguously files.
  //
  // Why COUNT constructions rather than sinks: the sink scanner cannot see
  // reads that indirect through `.map(f => fs.readFileSync(f, ...))` where f
  // comes from an array-of-homedir-paths (mcp-wiring's shape). Counting
  // constructions catches that shape and every simpler one. `path.join(...,
  // 'foo.md')` with no read still forces the author to write either a
  // KNOWN_READS_UNOWNED_FILE naming it or a NO_UNOWNED_FILE_READS declaring
  // the file has no reads -- a small documentation cost, a real audit gain.
  const constructions = [];
  const joinRe = /path\.join\s*\(\s*os\.homedir\s*\(\s*\)\s*,\s*([\s\S]*?)\)/g;
  let jm;
  while ((jm = joinRe.exec(src)) !== null) {
    const argsText = jm[1];
    // Find the LAST single- or double-quoted literal in the args.
    const literals = [...argsText.matchAll(/(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map(x => x[2]);
    const last = literals[literals.length - 1] || '';
    if (/\.[a-z0-9]{1,6}$/i.test(last)) {
      const before = src.slice(0, jm.index);
      const line = (before.match(/\n/g) || []).length + 1;
      constructions.push({ line, literal: last });
    }
  }

  return {
    sinks,
    constructions,
    homedirModuleBindings: [...homedirModuleBindings],
    mentionsHomedir: /\bos\.homedir\s*\(\s*\)/.test(src),
  };
}

function extractParenArg(s) {
  if (s[0] !== '(') return '';
  let depth = 1;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return s.slice(1, i); }
  }
  return s.slice(1);
}

function readMarkers(src) {
  const known = [...src.matchAll(/KNOWN_READS_UNOWNED_FILE:\s*(.+)$/gm)].map(m => m[1].trim());
  const none = [...src.matchAll(/NO_UNOWNED_FILE_READS:\s*(.+)$/gm)].map(m => m[1].trim());
  return { known, none };
}

function main() {
  const files = testFilesInScope();
  const report = files.map(f => {
    const src = fs.readFileSync(f, 'utf8');
    return {
      // Forward-slash it: path.relative yields backslashes on Windows and every
      // `x.file === 'test/...'` comparison below is written with '/'.
      file: path.relative(path.join(TEST_DIR, '..'), f).split(path.sep).join('/'),
      ...scanFile(src),
      ...readMarkers(src),
    };
  });

  // ---- teeth. Adjacent-case discrimination is the whole point of shape 1.

  check('scan: harness-style REAL_CONFIG_PATH/STATE_PATH reads are detected as fs.<read> sinks', () => {
    for (const f of ['test/harness.js', 'test/run-tests.js']) {
      const r = report.find(x => x.file === f);
      assert.ok(r, `${f} was not scanned`);
      assert.ok(r.sinks.some(s => /REAL_CONFIG_PATH/.test(s.arg)),
        `${f}: REAL_CONFIG_PATH read was not detected: ${JSON.stringify(r.sinks)}`);
      assert.ok(r.sinks.some(s => /REAL_STATE_PATH/.test(s.arg)),
        `${f}: REAL_STATE_PATH read was not detected: ${JSON.stringify(r.sinks)}`);
    }
  });

  check('scan: files that CONSTRUCT homedir paths as fixture data are NOT flagged as sinks', () => {
    // project-attribution.test.js binds `const foreign = path.join(os.homedir(),
    // ...)` and hands it to event objects (`file: foreign`), never fs.reads it.
    // This is the adjacent case the shape-1 choice hinges on: a scanner that
    // cannot tell construction from reading degenerates into shape 2 (widen
    // the gate) with worse coverage.
    const pa = report.find(r => r.file === 'test/suites/project-attribution.test.js');
    assert.ok(pa, 'project-attribution.test.js was not scanned');
    assert.strictEqual(pa.sinks.length, 0,
      `false positive: project-attribution reads ${JSON.stringify(pa.sinks)} — those are fixture strings, not reads`);
  });

  check('scan: assertions on a computed homedir path (no fs.read) are NOT flagged as sinks', () => {
    // mcp-agent-discovery.test.js:115 asserts `r.dir === path.join(os.homedir(),
    // '.codex')` — an assertion on a computed string, never touched on disk.
    const mad = report.find(r => r.file === 'test/suites/mcp-agent-discovery.test.js');
    assert.ok(mad, 'mcp-agent-discovery.test.js was not scanned');
    assert.strictEqual(mad.sinks.length, 0,
      `false positive: mcp-agent-discovery reads ${JSON.stringify(mad.sinks)}`);
  });

  check('scan: fixture-scope `home` bindings shadowing a module binding do NOT poison unrelated fs.reads', () => {
    // The failure mode this pins: module-wide binding capture crosses scopes.
    // A `const home = os.homedir()` in one test block would otherwise turn
    // every `path.join(home, ...)` in a DIFFERENT fixture block (where `home`
    // is `fs.mkdtempSync(...)`) into a homedir sink. Module-scope-only
    // capture is what prevents that.
    const runTests = report.find(r => r.file === 'test/run-tests.js');
    // The nested-block declarations of `home = os.homedir()` in run-tests.js
    // live around lines 17077 and 17191; the misclassified fs.<read>s in the
    // earlier scanner iteration were around 19992-20108 (a different, fixture
    // `home`). Assert `home` is NOT a module binding, and that no sink in the
    // fixture range mentions the shadowing `home`.
    assert.ok(!runTests.homedirModuleBindings.includes('home'),
      'false positive: `home` was captured as a module-scope homedir binding: '
      + JSON.stringify(runTests.homedirModuleBindings));
    for (const s of runTests.sinks) {
      assert.ok(!(s.line > 17000 && s.line < 21500 && !/REAL_/.test(s.arg)),
        `L${s.line}: fixture-scope home read was misclassified: ${s.arg}`);
    }
  });

  // ---- coverage. The bite: an unmarked file that mentions os.homedir() fails.

  check('every named-file construction path.join(os.homedir(), …, "name.ext") is either KNOWN_READS_UNOWNED_FILE-marked or covered by a NO_UNOWNED_FILE_READS declaration', () => {
    const violations = [];
    for (const r of report) {
      if (!r.mentionsHomedir) continue;
      if (r.constructions.length === 0) {
        // Only bare mentions (isProtectedDir arguments, computed directory
        // paths). The author must still self-attest that no read is hiding.
        if (r.none.length === 0 && r.known.length === 0) {
          violations.push({ file: r.file, need: 'NO_UNOWNED_FILE_READS or KNOWN_READS_UNOWNED_FILE marker' });
        }
        continue;
      }
      // Constructions naming specific files exist. The author picks one of
      // two intents. NONE attests "no reads at all" and covers any count;
      // KNOWN must match the construction count one-to-one.
      if (r.none.length > 0) continue;
      if (r.known.length < r.constructions.length) {
        violations.push({
          file: r.file,
          constructions: r.constructions.map(c => `L${c.line} ${c.literal}`),
          markers: r.known.length,
          need: `${r.constructions.length} KNOWN_READS_UNOWNED_FILE marker(s), or a single NO_UNOWNED_FILE_READS declaring none are read`,
        });
      }
    }
    assert.deepStrictEqual(violations, [],
      'files mentioning os.homedir() must declare one of two markers -- see this suite\'s header for the two shapes.\n'
      + JSON.stringify(violations, null, 2));
  });

  h.finish();
}

main();
