'use strict';
// Mutation runner: break the product on purpose and see whether the suite
// notices. NOT a test suite — test/run.js discovers only suites/*.test.js, so
// this never runs itself. Drive it by hand:
//
//   node test/mutate.js --target lib/teamcrypto.js --suites redaction,team-identity
//   node test/mutate.js --target lib/util.js --suites teammate-notes,team-access --mode stub
//   node test/mutate.js --target lib/redact.js --suites redaction --mode ops --list
//
// WHY IT EXISTS. test/suites/checks-can-fail.test.js gates checks that assert
// NOTHING. It says plainly that it cannot catch the adjacent defect: a check
// that asserts plenty, but about the stub rather than the product. The tell is
// that the expected value and the observed value share an ancestor — the
// fixture computed both, or the mock returns exactly what the assertion wants
// regardless of what was asked of it. No static reading finds that reliably.
// Breaking the product and watching for silence does.
//
// THE QUESTION IT ANSWERS, exactly: if this function were deleted, inverted, or
// replaced with a stub of its own, would anything go red? A mutant that
// SURVIVES is a claim of coverage the suite cannot back.
//
// TWO MODES.
//   ops   — flip operators in place (=== <-> !==, && -> ||, >= -> >, true <->
//           false). Cheap, fine-grained, finds assertions that never exercise
//           the branch they name.
//   stub  — replace a whole top-level function body with `return <value>`, for
//           each of a few trivial values. This is the lying-stub question in
//           its literal form: does the suite distinguish this function from a
//           constant? Reports the FIRST value that survives.
//
// WHAT A SURVIVOR IS AND IS NOT. A survivor means the suites you RAN do not
// distinguish the mutant from the real thing. It is evidence of a gap in those
// suites, not proof the behaviour is untested anywhere — the legacy monolith
// covers a great deal that the split suites do not, and it costs ~100s, so it
// is not in the default loop. Re-run a survivor with --suites core before
// calling it a finding. The runner prints that reminder rather than assuming
// you remembered.
//
// Mutants are written to the real file and reverted in a finally, plus on
// SIGINT/SIGTERM. If this process is killed -9 mid-run, `git diff` the target.
//
// ONE WORKTREE, ONE MUTATION RUN, AND NOTHING ELSE. This edits lib/ in place,
// so any test you start while a run is in flight is testing a deliberately
// broken product. It looks exactly like a flake: unrelated checks failing with
// plausible messages, green again on a re-run once the finally has restored
// the file. Hit live -- a backgrounded run against lib/redact.js produced four
// "failures" in the redaction suite that were the mutant, not the code. Before
// diagnosing any surprising red, `git status lib/` and check for a run in
// flight (`pgrep -fl mutate.js`). To work while one runs, use a separate
// worktree.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { mode: 'ops', suites: [], target: null, list: false, limit: Infinity, filter: null, lines: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--suites') out.suites = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    // Comma-separated: re-running a handful of named survivors against the
    // monolith is the normal second pass, and one filter per invocation meant
    // paying the ~110s core run once per mutant instead of once per batch.
    else if (a === '--filter') out.filter = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    // `--lines 1317-1420`: sample a REGION of a large file. lib/server.js is
    // 3228 lines and 873 mutants; a full pass is not a development loop, and
    // "which handlers did you actually measure" has to be answerable precisely
    // rather than as a filter-string guess.
    else if (a === '--lines') {
      const m = String(argv[++i]).match(/^(\d+)-(\d+)$/);
      if (!m) { console.error('--lines wants a range like 1317-1420'); process.exit(1); }
      out.lines = [Number(m[1]), Number(m[2])];
    }
    else if (a === '--list') out.list = true;
  }
  return out;
}

// Comment-, string- AND REGEX-blanked view, offsets preserved, so a `===`
// inside a comment, a message string or a character class is never mutated.
// Mutating a string literal produces a mutant that only changes an error
// message: it survives everything and buries the real survivors in noise.
//
// The regex arm is not optional decoration. Without it, lib/redact.js line 109
// —
//   rx: /([?&])(...)(?![0-9]+(?:[&#\s'"]|$))[^&#\s'"<>]{8,}/gi
// — starts a "string" at the apostrophe inside the character class and
// swallows the remaining 9k characters of the file. That yielded ZERO mutants
// and a run that printed `0 killed, 0 SURVIVED` over a green baseline, which
// reads exactly like a clean result. A mutation tool that silently generates
// nothing is the same defect class it exists to find, so `assertMutable` below
// refuses a zero-mutant run outright.
//
// Regex-vs-division is decided by the previous significant character, the
// standard heuristic: a `/` that opens a regex follows an operator, an opening
// bracket, a comma, a semicolon, a colon, or the start of input — never an
// identifier, a literal, or a closing bracket (those mean division).
const REGEX_CAN_FOLLOW = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
function blankNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSignificant = '\n';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += q; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += ' '; i++; if (i >= n) break; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      out += q; i++; lastSignificant = q; continue;
    }
    if (c === '/' && REGEX_CAN_FOLLOW.has(lastSignificant)) {
      // Regex literal: consume to the unescaped closing '/', respecting
      // character classes (a '/' inside [...] does not close the literal).
      out += ' '; i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += '  '; i += 2; continue; }
        if (ch === '\n') break; // unterminated: bail rather than swallow the file
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { out += ' '; i++; break; }
        out += ' '; i++;
      }
      while (i < n && /[gimsuyd]/.test(src[i])) { out += ' '; i++; } // flags
      lastSignificant = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    else if (c === '\n') lastSignificant = '\n';
    i++;
  }
  return out;
}

// A mutant that does not PARSE is not a mutant. It fails every suite for a
// reason no test looked at, and counting it as "killed" inflates the kill rate
// into a vanity metric — the number would say the suite is discriminating when
// all it did was watch node refuse to load the file.
function parses(src, filename) {
  try { new (require('vm').Script)(src, { filename }); return true; } catch { return false; }
}

// Longest-first: '===' must be tried before '==', '!==' before '!='.
const OPS = [
  ['===', '!=='], ['!==', '==='],
  ['>=', '<'], ['<=', '>'],
  ['&&', '||'],
  ['true', 'false'], ['false', 'true'],
];

function opMutants(src) {
  const code = blankNonCode(src);
  const mutants = [];
  for (const [from, to] of OPS) {
    let at = 0;
    while (true) {
      const i = code.indexOf(from, at);
      if (i === -1) break;
      at = i + from.length;
      // Word operators must not match inside identifiers (`trueish`, `isTrue`).
      if (/^[a-z]+$/.test(from)) {
        if (/[\w$]/.test(code[i - 1] || ' ') || /[\w$]/.test(code[i + from.length] || ' ')) continue;
      }
      // '>=' inside '>>=' etc.
      if (from === '>=' && code[i - 1] === '>') continue;
      const line = src.slice(0, i).split('\n').length;
      mutants.push({
        id: `${from}->${to}@${line}`,
        line,
        desc: `${from} -> ${to}`,
        src: src.slice(0, i) + to + src.slice(i + from.length),
        context: src.split('\n')[line - 1].trim().slice(0, 100),
      });
    }
  }
  return mutants;
}

const STUB_VALUES = ['null', 'true', 'false', '[]', "''", '0', '{}'];

// Top-level `function NAME(args) { ... }` declarations. Deliberately only
// top-level: a nested helper replaced by a constant usually breaks the module
// at require time, which reads as "killed" without any test having looked.
function functionSpans(src) {
  const code = blankNonCode(src);
  const spans = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    let depth = 0, open = -1;
    for (let i = m.index; i < code.length; i++) {
      if (code[i] === '{') { if (depth === 0) open = i; depth++; }
      else if (code[i] === '}') { depth--; if (depth === 0) { spans.push({ name: m[1], open, close: i }); break; } }
    }
  }
  return spans;
}

function stubMutants(src) {
  const mutants = [];
  for (const s of functionSpans(src)) {
    for (const v of STUB_VALUES) {
      mutants.push({
        id: `stub:${s.name}=>${v}`,
        line: src.slice(0, s.open).split('\n').length,
        desc: `${s.name}() body replaced with \`return ${v}\``,
        fn: s.name,
        value: v,
        src: src.slice(0, s.open + 1) + ` return ${v}; ` + src.slice(s.close),
        context: `function ${s.name}(...)`,
      });
    }
  }
  return mutants;
}

function runSuites(suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...suites],
    { cwd: REPO, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) { console.error('need --target <file relative to repo root>'); process.exit(1); }
  const targetPath = path.join(REPO, args.target);
  const original = fs.readFileSync(targetPath, 'utf8');

  let mutants = args.mode === 'stub' ? stubMutants(original) : opMutants(original);
  // Zero mutants is a TOOL failure, never a clean bill of health. See the
  // blanker's header: a parse desync produced exactly this, and printed a
  // green-looking `0 killed, 0 SURVIVED`.
  if (!mutants.length) {
    console.error(`no mutants generated for ${args.target} in ${args.mode} mode — the scanner found nothing to `
      + 'break, which means it failed to read the file, not that the file is unbreakable. Do not read this as a pass.');
    process.exit(1);
  }
  // Filter FIRST, then parse-check, so the "did not parse" count in the
  // summary describes the set actually being run. Counting it over the whole
  // file made the footer report exclusions that had nothing to do with the
  // mutants on screen.
  if (args.lines) mutants = mutants.filter(m => m.line >= args.lines[0] && m.line <= args.lines[1]);
  if (args.filter) mutants = mutants.filter(m => args.filter.some(f => m.id.includes(f) || m.context.includes(f)));
  if (!mutants.length) {
    console.error(`--filter ${JSON.stringify(args.filter)}${args.lines ? ` / --lines ${args.lines.join('-')}` : ''} matched no mutants`);
    process.exit(1);
  }
  // Drop mutants that do not compile: they fail everything without any test
  // having examined behaviour, and would be scored as kills.
  const beforeParse = mutants.length;
  mutants = mutants.filter(m => parses(m.src, targetPath));
  const unparseable = beforeParse - mutants.length;
  if (!mutants.length) {
    console.error(`all ${beforeParse} mutants for ${args.target} failed to parse — the mutation operators are producing garbage`);
    process.exit(1);
  }
  if (mutants.length > args.limit) mutants = mutants.slice(0, args.limit);

  if (args.list) {
    for (const m of mutants) console.log(`${m.id.padEnd(42)} L${String(m.line).padEnd(5)} ${m.context}`);
    console.log(`\n${mutants.length} mutants`);
    return;
  }
  if (!args.suites.length) { console.error('need --suites <a,b,c>'); process.exit(1); }

  // Baseline. A suite set that is already red cannot kill anything, and every
  // mutant would read as "killed" — the failure mode that makes a mutation run
  // report perfect coverage over a broken tree.
  process.stdout.write('baseline (unmutated): ');
  const base = runSuites(args.suites);
  if (!base.ok) {
    console.log('FAILED');
    console.log(base.out.split('\n').slice(-25).join('\n'));
    console.error('\nthe suites are red before any mutation; every mutant would read as killed. Fix that first.');
    process.exit(1);
  }
  console.log('green');

  const restore = () => { try { fs.writeFileSync(targetPath, original); } catch {} };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(1); });

  const survived = [], killed = [];
  const seenSurvivingFn = new Set();
  try {
    for (const m of mutants) {
      // stub mode: one survivor per function is the finding; the remaining
      // trivial values for that function add nothing.
      if (args.mode === 'stub' && seenSurvivingFn.has(m.fn)) continue;
      fs.writeFileSync(targetPath, m.src);
      const r = runSuites(args.suites);
      if (r.ok) {
        survived.push(m);
        if (m.fn) seenSurvivingFn.add(m.fn);
        console.log(`SURVIVED  ${m.id.padEnd(42)} L${String(m.line).padEnd(5)} ${m.context}`);
      } else {
        killed.push(m);
        console.log(`killed    ${m.id.padEnd(42)} L${m.line}`);
      }
    }
  } finally {
    restore();
  }

  console.log(`\n${killed.length} killed, ${survived.length} SURVIVED, of ${killed.length + survived.length} run`
    + (unparseable ? ` (${unparseable} more did not parse and were not scored)` : ''));
  if (survived.length) {
    console.log('\nSurvivors — the suites run here do not distinguish these from the real code:');
    for (const m of survived) console.log(`  ${args.target}:${m.line}  ${m.desc}\n      ${m.context}`);
    console.log('\nBefore calling any of these a finding: re-run with --suites core. The legacy');
    console.log('monolith covers a great deal the split suites do not, and it is not in this loop.');
  }
  const after = fs.readFileSync(targetPath, 'utf8');
  if (after !== original) { console.error('\nTARGET NOT RESTORED — git checkout it before doing anything else'); process.exit(2); }
}

main();
