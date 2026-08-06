'use strict';
// Two independent appends that produce a VALID FILE WITH A DEAD HALF.
//
// This is a merge hazard, not a coding mistake, and that is what makes it
// nasty: git does not conflict on it. Two lanes each append a handler, a
// function, a return; the file parses, the suite runs, and the half that lost
// is silently unreachable. Nothing goes red. Confirmed instances so far:
//
//   * TWO handlers for /auth/v1/logout in test/mock-supabase.js. The first
//     shadowed the second, which made flags.failLogout dead and let a sign-out
//     test pass for the wrong reason. Found, reconciled — and it RECURRED in a
//     second assembly, landing on top of the comment describing the defect.
//   * TWO returns in one function, making everything after the first
//     unreachable, including a helper other suites call. It surfaced three
//     suites away as "that function doesn't exist".
//
// Both were caught by `grep -c` commands living in a runbook and in verbal
// instructions to a verifier. A grep in a document is not a check: it runs
// when someone remembers, which is exactly the property the defect exploits.
//
// WHAT IS ASSERTED IS THE PROPERTY, NOT THE TWO KNOWN STRINGS. "Exactly one
// logout handler" catches one instance. "No route path is dispatched twice
// without distinct method guards" catches the class, including the next path
// nobody has thought of.
//
// WHAT THIS IS: a line-oriented scanner, not a parser. The repo has no linter
// and no parser dependency (no eslint, no acorn — checked), and hand-rolling a
// JavaScript masker good enough to be trusted is a bigger risk than the bug:
// a check with false positives gets disabled, and then the class is uncovered
// AND nobody is looking. So this does the four shapes it can do precisely, and
// says plainly below what it does not cover. It was measured, not assumed:
// run across all 143 .js files in lib/ bin/ test/ scripts/ app/ it reports
// ZERO findings today, and it catches all four shapes when they are injected.
//
// NOT COVERED, deliberately and specifically:
//   * duplicate keys in one object literal — needs a real parser to do safely.
//   * duplicate `case` labels in one switch — same.
//   * anything inside a TEMPLATE LITERAL. lib/client*.js is one big template
//     literal by construction, so a duplicate handler written inside one is
//     invisible here. Named because it is the largest gap, not because it is
//     unlikely.
//   * a dispatch written in some other style (a switch on pathname, a
//     startsWith prefix match) — this knows one dispatch shape, the one the
//     two servers in this repo actually use.
//   * duplicate `const`/`let`/`class` at module scope, which needs no check:
//     that shape is a SyntaxError and announces itself on load.
//
// Run directly, or via `node test/run.js merge-shadowing`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const SCANNED_DIRS = ['lib', 'bin', 'test', 'scripts', 'app'];

// THE ONLY EXCLUSION, and it is one file for one unavoidable reason: this
// suite has to contain the defective shapes as literal test data in order to
// prove its own detectors fire, and a line scanner cannot tell a pattern in a
// string from a pattern in code. Excluding it is not a judgement that the file
// is trustworthy — it is not checked, and the check below pins the list at
// exactly this length so the exclusion cannot quietly grow into the hole.
//
// The alternative was to obfuscate the fixtures (build the pattern by
// concatenation so the scanner cannot see it), which trades a visible
// exemption for an invisible one and makes the fixtures unreadable.
const NOT_SCANNED = [path.join('test', 'suites', 'merge-shadowing.test.js')];

// Comments stripped line-wise so a commented-out handler is not read as a real
// one — the recurrence landed directly on top of a comment describing the
// defect, so comment text near these patterns is the normal case, not an edge
// one. This does not understand a `//` inside a string literal; the tree-wide
// zero-findings measurement above is what stands in for proving that safe.
function codeLines(src) {
  let inBlock = false;
  return src.split('\n').map(raw => {
    let s = raw;
    if (inBlock) {
      const e = s.indexOf('*/');
      if (e === -1) return '';
      s = ' '.repeat(e + 2) + s.slice(e + 2);
      inBlock = false;
    }
    for (;;) {
      const b = s.indexOf('/*');
      if (b === -1) break;
      const e = s.indexOf('*/', b + 2);
      if (e === -1) { s = s.slice(0, b); inBlock = true; break; }
      s = s.slice(0, b) + ' '.repeat(e + 2 - b) + s.slice(e + 2);
    }
    const c = s.indexOf('//');
    return c === -1 ? s : s.slice(0, c);
  });
}

// Two handlers for one path are LEGITIMATE when they are told apart by method
// — test/mock-supabase.js dispatches /rest/v1/projects to a POST branch and a
// GET branch on purpose, and a check that flagged that would be turned off
// within a day. So the property is not "one handler per path", it is "no
// handler can shadow another": every handler for a repeated path must carry a
// method guard, and those guards must be pairwise distinct. An unguarded
// handler matches every method, so a repeated path containing one is a
// shadowing whatever the others say.
function shadowedRoutes(lines) {
  const byPath = new Map();
  lines.forEach((l, i) => {
    const m = /url\.pathname\s*===\s*'([^']+)'/.exec(l);
    if (!m) return;
    const method = /req\.method\s*===\s*'([A-Z]+)'/.exec(l);
    byPath.set(m[1], (byPath.get(m[1]) || []).concat({ line: i + 1, method: method ? method[1] : null }));
  });
  const out = [];
  for (const [p, hs] of byPath) {
    if (hs.length < 2) continue;
    const methods = hs.map(x => x.method);
    if (methods.some(x => x === null) || new Set(methods).size !== methods.length) out.push({ path: p, handlers: hs });
  }
  return out;
}

// A `return` followed by a sibling statement at the SAME indentation, inside
// the same block. Indentation rather than brace depth: the tree is uniformly
// 2-space indented, and an indentation rule has no way to mis-parse a template
// literal or a regex, which a brace counter does. A deeper next line is a
// nested block (fine); a shallower one, or a closer, ends the block (fine).
function unreachableAfterReturn(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)return\b[^;]*;?\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (!t.trim()) continue;
      const ind = t.search(/\S/);
      if (ind !== indent) break;        // deeper = nested, shallower = block ended
      if (/^\s*[})\]]/.test(t)) break;  // a closer at this indent ends the block
      out.push({ returnLine: i + 1, deadLine: j + 1, text: t.trim().slice(0, 70) });
      break;
    }
  }
  return out;
}

// A second top-level `function foo()` silently replaces the first: no error,
// no warning, and the loser's callers get the winner's behaviour. Same for a
// second module.exports, which discards the first wholesale.
function duplicateTopLevel(lines, rx) {
  const seen = new Map();
  lines.forEach((l, i) => {
    const m = rx.exec(l);
    if (m) seen.set(m[1] || m[0], (seen.get(m[1] || m[0]) || []).concat(i + 1));
  });
  return [...seen.entries()].filter(([, v]) => v.length > 1);
}

function jsFiles() {
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  for (const d of SCANNED_DIRS) {
    const abs = path.join(ROOT_DIR, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out.filter(f => !NOT_SCANNED.includes(path.relative(ROOT_DIR, f)));
}

function scan(file) {
  const lines = codeLines(fs.readFileSync(file, 'utf8'));
  return {
    routes: shadowedRoutes(lines),
    unreachable: unreachableAfterReturn(lines),
    functions: duplicateTopLevel(lines, /^function\s+([A-Za-z0-9_$]+)\s*\(/),
    exports: duplicateTopLevel(lines, /^(module\.exports)\s*=/),
    lines,
  };
}

const rel = f => path.relative(ROOT_DIR, f);

function main() {
  const files = jsFiles();
  const findings = files.map(f => ({ file: f, ...scan(f) }));

  check('scan: the scanner actually reached the tree it claims to cover', () => {
    // Presence first. Every "no findings" check below is satisfied just as well
    // by a scanner that read nothing at all.
    assert.ok(files.length > 100, `only ${files.length} files scanned — the walk is not reaching the tree`);
    assert.ok(files.some(f => rel(f) === path.join('test', 'mock-supabase.js')),
      'the file this class keeps recurring in is not being scanned');
    assert.ok(files.some(f => rel(f) === path.join('lib', 'server.js')),
      'the daemon\'s own route table is not being scanned');
  });

  check('the exclusion list is one file long, and that file is this one', () => {
    // An exclusion list is where a check like this goes to die: one entry for a
    // real reason, then a second for an inconvenient finding, then it is
    // wallpaper. Adding one means changing this assertion and saying why.
    assert.deepStrictEqual(NOT_SCANNED, [path.join('test', 'suites', 'merge-shadowing.test.js')],
      'the exclusion list grew. Every entry is a file this class is no longer guarded in — ' +
      'if the new entry is a fixture file, say so here; if it is real code, it needs fixing, not excluding');
    assert.ok(!files.some(f => rel(f) === NOT_SCANNED[0]), 'the excluded file was scanned anyway');
  });

  check('no route path is dispatched twice without distinct method guards', () => {
    const bad = findings.filter(f => f.routes.length);
    const detail = bad.map(f => f.routes.map(r =>
      `${rel(f.file)}: '${r.path}' handled at ${r.handlers.map(x => `line ${x.line}${x.method ? ` (${x.method})` : ' (no method guard)'}`).join(' and ')}`).join('\n  ')).join('\n  ');
    assert.strictEqual(bad.length, 0,
      `a route is handled more than once, and the later handler is unreachable:\n  ${detail}\n` +
      '  Two lanes appending a handler for one path is a clean git merge and a dead half. ' +
      'If both are wanted, tell them apart by method.');
  });

  check('no statement follows a return at the same level in the same block', () => {
    const bad = findings.filter(f => f.unreachable.length);
    const detail = bad.map(f => f.unreachable.map(u =>
      `${rel(f.file)}:${u.deadLine} is unreachable — return at line ${u.returnLine}: ${u.text}`).join('\n  ')).join('\n  ');
    assert.strictEqual(bad.length, 0,
      `code after a return is dead:\n  ${detail}\n` +
      '  Two lanes each appending a return to one function is how a helper other ' +
      'suites call disappears, surfacing three suites away as "that function does not exist".');
  });

  check('no top-level function name is declared twice in one file', () => {
    const bad = findings.filter(f => f.functions.length);
    const detail = bad.map(f => f.functions.map(([name, at]) =>
      `${rel(f.file)}: function ${name} declared at lines ${at.join(', ')}`).join('\n  ')).join('\n  ');
    assert.strictEqual(bad.length, 0,
      `a later declaration silently replaces an earlier one:\n  ${detail}`);
  });

  check('no file assigns module.exports twice', () => {
    const bad = findings.filter(f => f.exports.length);
    const detail = bad.map(f => f.exports.map(([, at]) =>
      `${rel(f.file)}: module.exports assigned at lines ${at.join(', ')}`).join('\n  ')).join('\n  ');
    assert.strictEqual(bad.length, 0,
      `the second assignment discards the first wholesale:\n  ${detail}`);
  });

  // THE COUNTER-CHECK THAT KEEPS THIS CHECK ALIVE.
  //
  // /rest/v1/projects is handled twice in the mock ON PURPOSE — a POST branch
  // and a GET branch. A check that flagged that would be disabled inside a day,
  // and then this whole class is uncovered with nobody watching. So the
  // legitimate shape is pinned as hard as the illegitimate one: the scanner
  // must SEE both handlers (or it is passing by reading nothing) and must not
  // report them.
  check('a deliberate POST/GET pair on one path is not a finding', () => {
    const mock = findings.find(f => rel(f.file) === path.join('test', 'mock-supabase.js'));
    assert.ok(mock, 'test/mock-supabase.js was not scanned');
    const hits = mock.lines.filter(l => /url\.pathname\s*===\s*'\/rest\/v1\/projects'/.test(l));
    assert.strictEqual(hits.length, 2,
      `expected the deliberate two-handler pair to still exist (found ${hits.length}) — ` +
      'without it this counter-check proves nothing about false positives');
    assert.ok(hits.every(l => /req\.method\s*===\s*'[A-Z]+'/.test(l)),
      'the fixture pair lost its method guards, so it no longer models the legitimate case');
    assert.ok(!mock.routes.some(r => r.path === '/rest/v1/projects'),
      'the deliberate POST/GET pair was reported as a shadowing — this check would be ' +
      'switched off, and the class it guards would go uncovered');
  });

  // The scanner has to be able to FAIL. Every check above asserts an absence,
  // and an absence is what a broken scanner reports too — so each detector is
  // run here against a synthetic file carrying the exact defect it looks for.
  check('every detector fires on the shape it claims to catch', () => {
    const dupRoute = codeLines([
      "if (url.pathname === '/auth/v1/logout') { return a(); }",
      "if (url.pathname === '/auth/v1/logout') { return b(); }",
    ].join('\n'));
    assert.strictEqual(shadowedRoutes(dupRoute).length, 1, 'the route detector missed a duplicate handler');

    const guarded = codeLines([
      "if (url.pathname === '/x' && req.method === 'POST') { return a(); }",
      "if (url.pathname === '/x' && req.method === 'GET') { return b(); }",
    ].join('\n'));
    assert.strictEqual(shadowedRoutes(guarded).length, 0, 'the route detector flagged a method-guarded pair');

    const dead = codeLines('function f() {\n  return null;\n  const x = 1;\n}');
    assert.strictEqual(unreachableAfterReturn(dead).length, 1, 'the unreachable detector missed dead code');

    const nested = codeLines('function f() {\n  if (a) {\n    return null;\n  }\n  const x = 1;\n}');
    assert.strictEqual(unreachableAfterReturn(nested).length, 0,
      'the unreachable detector flagged a return inside a nested block, which is ordinary code');

    const dupFn = codeLines('function f() {}\nfunction f() {}');
    assert.strictEqual(duplicateTopLevel(dupFn, /^function\s+([A-Za-z0-9_$]+)\s*\(/).length, 1,
      'the duplicate-function detector missed a redeclaration');

    const nestedFn = codeLines('function outer() {\n  function f() {}\n}\nfunction f() {}');
    assert.strictEqual(duplicateTopLevel(nestedFn, /^function\s+([A-Za-z0-9_$]+)\s*\(/).length, 0,
      'the duplicate-function detector counted a nested function as a top-level one');

    const dupEx = codeLines('module.exports = { a: 1 };\nmodule.exports = { b: 2 };');
    assert.strictEqual(duplicateTopLevel(dupEx, /^(module\.exports)\s*=/).length, 1,
      'the duplicate-exports detector missed a second assignment');

    const commented = codeLines("// if (url.pathname === '/auth/v1/logout') { }\nif (url.pathname === '/auth/v1/logout') { }");
    assert.strictEqual(shadowedRoutes(commented).length, 0,
      'a commented-out handler was counted as a real one — the recurrence landed on top of ' +
      'a comment describing the defect, so this is the normal case, not an edge one');
  });

  h.finish();
}

main();
