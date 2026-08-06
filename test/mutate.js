'use strict';
// NOT_RUN_BY_CI: a manual development tool, not a test. Driven by hand (see
// the invocations below); test/run.js discovers only suites/*.test.js, so this
// never runs itself. Its own behaviour IS gated — the guard/ops/stub
// generators and the crash-vs-assertion labelling are exercised by nothing,
// which is worth knowing: a finding produced by this tool is only as good as
// the hand-verification behind it.
//
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
  const out = { mode: 'ops', suites: [], target: null, list: false, limit: Infinity, filter: null, lines: null, cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--suites') out.suites = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--mode') out.mode = argv[++i];
    // `--cmd "node test/foo.js"`: score an arbitrary command instead of
    // test/run.js suites. Needed to answer "does this standalone script catch
    // anything the discovered suites do not?" — which is the only honest way to
    // decide whether an undiscovered file is coverage or decoration.
    else if (a === '--cmd') out.cmd = argv[++i];
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

// Source text scanning is SHARED with test/suites/checks-can-fail.test.js
// (test/js-scan.js). See that module's header for why it is shared: the
// regex-literal bug fixed here once recurred verbatim in the other copy.
const { blankNonCode, matchingBrace } = require('./js-scan');

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

// ---- guard deletion ----
//
// `if (!allowed) return nothing;` has NO OPERATOR TO FLIP. Operator mutation is
// structurally blind to it: there is no ===, no &&, no boolean literal, so the
// scanner walks straight past the single line that decides whether a revoked
// teammate's content gets served. That blindness was found the hard way — the
// mayServeTeammateNotes gate in lib/server.js's projectDetail had to be deleted
// BY HAND to learn whether anything covered it, and a clean operator-mode
// result over that region meant nothing about the line that mattered most.
//
// Most access control in this codebase has that shape: an early return that
// refuses, a guard that fails closed, a check whose whole job is to NOT do
// something. So the mutation is the real-world edit that reintroduces a
// fail-open bug — remove the guard and let execution fall through.
//
// Deleted whitespace-for-whitespace, newlines preserved, so every reported line
// number still points at the original source.
const GUARD_STARTERS = ['return', 'continue', 'break', 'throw'];

// Populated by guardMutants: `if` statements that REFUSE (their body reaches a
// return/continue/break/throw) but that this operator would not touch. These
// are the blind spot — a line no mode reaches does not show up as a survivor,
// it shows up as nothing at all, and a report that lists only survivors reads
// as though the region were fully measured.
let declinedGuards = [];

function guardMutants(src) {
  const code = blankNonCode(src);
  const mutants = [];
  declinedGuards = [];
  const decline = (i, why) => {
    const line = src.slice(0, i).split('\n').length;
    declinedGuards.push({ line, why, context: (src.split('\n')[line - 1] || '').trim().slice(0, 100) });
  };
  for (let i = 0; i < code.length; i++) {
    if (!code.startsWith('if', i)) continue;
    if (/[\w$.]/.test(code[i - 1] || ' ')) continue;   // `notify`, `.if`, `elseif`
    if (/[\w$]/.test(code[i + 2] || ' ')) continue;
    const openParen = code.indexOf('(', i);
    if (openParen === -1 || code.slice(i + 2, openParen).trim() !== '') continue;
    let depth = 0, closeParen = -1;
    for (let j = openParen; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') { depth--; if (depth === 0) { closeParen = j; break; } }
    }
    if (closeParen === -1) continue;

    // What follows the condition: either `{ ...one statement... }` or a bare
    // statement. Either way it must be a pure refusal — return/continue/break/
    // throw and nothing else. A guard with side effects is not a guard, and
    // deleting it would test something other than the access decision.
    let k = closeParen + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    let end = -1, body = '';
    if (code[k] === '{') {
      const close = matchingBrace(code, k);
      if (close === -1) continue;
      body = code.slice(k + 1, close).trim();
      end = close + 1;
    } else {
      // Bare statement: to the first `;` at paren/brace depth 0.
      let d = 0, semi = -1;
      for (let j = k; j < code.length; j++) {
        const c = code[j];
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') d--;
        else if (c === ';' && d === 0) { semi = j; break; }
        else if (c === '\n' && d === 0 && code.slice(k, j).trim()) {
          // A guard whose body is on the next line is still a guard, but an
          // `if` with no `;` before a newline is usually a multi-line block we
          // already handled — bail rather than guess.
          if (!/^(?:return|continue|break|throw)\b/.test(code.slice(k, j).trim())) break;
        }
      }
      if (semi === -1) continue;
      body = code.slice(k, semi).trim();
      end = semi + 1;
    }
    if (!body) continue;
    // Does this `if` refuse AT ALL? A body that reaches a return/continue/
    // break/throw anywhere is a refusal in substance even when this operator
    // cannot express its deletion — those get recorded as declined rather than
    // silently skipped.
    const refuses = GUARD_STARTERS.some(w => new RegExp(`\\b${w}\\b`).test(body));
    if (!GUARD_STARTERS.some(w => new RegExp(`^${w}\\b`).test(body))) {
      if (refuses) decline(i, 'body does work before refusing (not a pure guard)');
      continue;
    }
    // One statement only. A body with an inner `;` is doing work as well as
    // refusing, and this operator has nothing to say about it.
    if (body.replace(/;+\s*$/, '').includes(';')) { decline(i, 'multi-statement body (logs/mutates, then refuses)'); continue; }
    // An `else` means both branches are live; deleting the `if` alone leaves a
    // dangling else and would not compile anyway.
    if (code.slice(end).trimStart().startsWith('else')) { decline(i, 'has an else branch — both paths are live'); continue; }

    const removed = src.slice(i, end);
    const line = src.slice(0, i).split('\n').length;
    mutants.push({
      id: `guard@${line}`,
      line,
      kind: 'guard',
      desc: `guard deleted: ${removed.replace(/\s+/g, ' ').slice(0, 90)}`,
      // Whitespace of identical length, newlines kept, so line numbers hold.
      src: src.slice(0, i) + removed.replace(/[^\n]/g, ' ') + src.slice(end),
      context: src.split('\n')[line - 1].trim().slice(0, 100),
    });
  }
  return mutants;
}

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

// HOW a mutant died, because the two answers are not equally good evidence.
//
//   assertion — a check FAILED. A test looked at the behaviour the guard
//               controls and said it was wrong. This is the evidence you want:
//               the suite can tell "allowed" from "denied".
//   crash     — the suite died (no tally). Something broke; nobody established
//               that the WRONG PERSON WAS SERVED. A deleted guard often makes
//               the code fall through into a TypeError on the value the guard
//               was protecting against, and that kills the mutant for a reason
//               unrelated to access control. Counted as a kill, reported
//               separately, and worth strictly less.
//
// This matters most for guard mode, which is exactly where fall-through
// crashes are likeliest.
function killKind(out) {
  const text = String(out || '');
  // A bare script driven by --cmd prints none of run.js's markers; it throws.
  // Without this arm every kill from a --cmd run came back "unclassified",
  // which is the same as not knowing whether the suite JUDGED the behaviour or
  // merely fell over — the distinction this function exists to make.
  const threwAssertion = /\bAssertionError\b/.test(text)
    || /^\s*(?:assert|AssertionError)[^\n]*(?:Expected|expected|!==|===)/m.test(text);
  const asserted = threwAssertion || /(?:^|\|\s)\s*FAIL {2}/m.test(text) || /failing checks:/.test(text);
  const crashed = /^CRASH /m.test(text) || /RESULT INCOMPLETE/.test(text) || /CRASHED with an UNKNOWN/.test(text);
  if (asserted && crashed) return 'assertion+crash';
  if (asserted) return 'assertion';
  if (crashed) return 'crash';
  return 'unknown';
}

function runSuites(suites, cmd) {
  const r = cmd
    ? spawnSync(cmd, { cwd: REPO, encoding: 'utf8', shell: true, timeout: 15 * 60 * 1000 })
    : spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...suites],
      { cwd: REPO, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

// Say which refusals this operator would not touch. Survivors and kills only
// describe the lines the tool REACHED; a guard it declined is measured by
// neither mode unless ops mode happens to find an operator inside it, and that
// silence is indistinguishable from coverage.
function reportDeclined(args) {
  if (args.mode !== 'guard') return;
  const inScope = declinedGuards.filter(d => !args.lines || (d.line >= args.lines[0] && d.line <= args.lines[1]));
  if (!inScope.length) return;
  console.log(`\nDECLINED — ${inScope.length} refusal(s) this operator cannot express, so NOTHING here measured them:`);
  for (const d of inScope) console.log(`  ${args.target}:${d.line}  ${d.why}\n      ${d.context}`);
  console.log('  These are not survivors and not kills. They are unmeasured, and ops mode only');
  console.log('  reaches them if the condition happens to contain an operator worth flipping.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) { console.error('need --target <file relative to repo root>'); process.exit(1); }
  const targetPath = path.join(REPO, args.target);
  const original = fs.readFileSync(targetPath, 'utf8');

  const GENERATORS = { ops: opMutants, stub: stubMutants, guard: guardMutants };
  if (!GENERATORS[args.mode]) {
    console.error(`unknown --mode ${JSON.stringify(args.mode)}; expected one of ${Object.keys(GENERATORS).join(', ')}`);
    process.exit(1);
  }
  let mutants = GENERATORS[args.mode](original);
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
    reportDeclined(args);
    return;
  }
  if (!args.suites.length && !args.cmd) { console.error('need --suites <a,b,c> or --cmd "<command>"'); process.exit(1); }

  // Baseline. A suite set that is already red cannot kill anything, and every
  // mutant would read as "killed" — the failure mode that makes a mutation run
  // report perfect coverage over a broken tree.
  process.stdout.write('baseline (unmutated): ');
  const base = runSuites(args.suites, args.cmd);
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
      const r = runSuites(args.suites, args.cmd);
      if (r.ok) {
        survived.push(m);
        if (m.fn) seenSurvivingFn.add(m.fn);
        console.log(`SURVIVED  ${m.id.padEnd(42)} L${String(m.line).padEnd(5)} ${m.context}`);
      } else {
        const kind = killKind(r.out);
        killed.push({ ...m, kind });
        console.log(`killed(${kind.padEnd(16)}) ${m.id.padEnd(30)} L${m.line}`);
      }
    }
  } finally {
    restore();
  }

  const byKind = k => killed.filter(m => m.kind === k).length;
  const byAssertion = killed.filter(m => /assertion/.test(m.kind || '')).length;
  console.log(`\n${killed.length} killed, ${survived.length} SURVIVED, of ${killed.length + survived.length} run`
    + (unparseable ? ` (${unparseable} more did not parse and were not scored)` : ''));
  if (killed.length) {
    console.log(`  of the kills: ${byAssertion} by a FAILING ASSERTION (a test judged the behaviour), `
      + `${byKind('crash')} by CRASH ONLY (something broke; nothing established the behaviour was wrong)`
      + (byKind('unknown') ? `, ${byKind('unknown')} unclassified` : ''));
    if (byKind('crash')) {
      console.log('  A crash-only kill is WEAKER evidence than an assertion kill: a deleted guard often falls');
      console.log('  through into a TypeError on the very value it was protecting against, which kills the');
      console.log('  mutant for a reason unrelated to the access decision. Treat those lines as unproven.');
      for (const m of killed.filter(x => x.kind === 'crash')) console.log(`    ${args.target}:${m.line}  ${m.desc}`);
    }
  }
  if (survived.length) {
    console.log('\nSurvivors — the suites run here do not distinguish these from the real code:');
    for (const m of survived) console.log(`  ${args.target}:${m.line}  ${m.desc}\n      ${m.context}`);
    console.log('\nBefore calling any of these a finding: re-run with --suites core. The legacy');
    console.log('monolith covers a great deal the split suites do not, and it is not in this loop.');
  }
  reportDeclined(args);
  const after = fs.readFileSync(targetPath, 'utf8');
  if (after !== original) { console.error('\nTARGET NOT RESTORED — git checkout it before doing anything else'); process.exit(2); }
}

main();
