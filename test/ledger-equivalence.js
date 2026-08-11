'use strict';
// NOT_RUN_BY_CI: an opt-in comparison harness that cannot run in CI at all —
// it needs a checkout of the reference Python implementation (MEMBRIDGE_REF),
// python3 on PATH, and REAL sessions under the developer's own
// ~/.claude/projects. Run by hand when changing ledger arithmetic.
//
// Runs the JS ledger and the reference Python implementation over the SAME
// local transcripts and compares. Opt-in:
//   MEMBRIDGE_REF=/path/to/token-spend-analysis node test/ledger-equivalence.js
// Needs real sessions under ~/.claude/projects and python3 on PATH.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REF = process.env.MEMBRIDGE_REF;
if (!REF || !fs.existsSync(path.join(REF, 'ledger_fixed.py'))) {
  console.log('skipped: set MEMBRIDGE_REF to the token-spend-analysis dir');
  process.exit(0);
}

const adapter = require('../lib/adapters/claude-code');
const ledger = require('../lib/ledger');
const { walkFiles } = require('../lib/util');

const root = path.join(os.homedir(), '.claude', 'projects');
const files = [];
for (const dir of fs.readdirSync(root)) {
  const d = path.join(root, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith('.jsonl')) files.push(path.join(d, f));
  }
}
files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
const sample = files.slice(0, 20);
assert.ok(sample.length, 'no local transcripts found');

// Newer Claude Code externalizes subagent turns into files under
// <session-id>/subagents/*.jsonl instead of interleaving them into the parent
// transcript, and those can nest arbitrarily deeper still (e.g.
// subagents/workflows/<wf-id>/agent-*.jsonl for sub-agents spawned inside a
// workflow). Both sides must fold ALL of those in, at any depth, or long
// sessions come in low on this side only -- the reference's main() walks
// every *.jsonl under the root (parent AND subagent files, recursively) and
// merges by sessionId; a per-file comparison here has to reproduce that
// fold, not a shallow one. Reuses lib/util.js's walkFiles, the same
// recursive directory walker production scanning (lib/scan.js) relies on.
function subagentFiles(parentFile) {
  const dir = path.join(path.dirname(parentFile), path.basename(parentFile, '.jsonl'), 'subagents');
  return walkFiles(dir, '.jsonl');
}

function readEntries(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return entries;
}

let checked = 0, worst = 0;
for (const file of sample) {
  const unitFiles = [file, ...subagentFiles(file)];
  const entries = [];
  for (const f of unitFiles) entries.push(...readEntries(f));
  const events = adapter.extractEvents(entries, { pendingCreates: {}, tasks: {} });
  const mine = ledger.sessionVolume(ledger.buildRequests(events));

  const py = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(REF)})
from ledger_fixed import parse_unit
paths = ${JSON.stringify(unitFiles)}
n = 0
v = 0
for p in paths:
    u = parse_unit(p)
    if u:
        n += u["n_requests"]
        v += u["volume"]
print(json.dumps({"n": n, "v": v}))
`], { encoding: 'utf8' });
  if (py.status !== 0) { console.error(py.stderr); process.exit(1); }
  const ref = JSON.parse(py.stdout);
  if (!ref.n) continue;

  const dReq = Math.abs(mine.nRequests - ref.n) / ref.n;
  const dVol = Math.abs(mine.volume - ref.v) / ref.v;
  worst = Math.max(worst, dReq, dVol);
  assert.ok(dReq <= 0.02, `${path.basename(file)}: requests ${mine.nRequests} vs ${ref.n}`);
  assert.ok(dVol <= 0.02, `${path.basename(file)}: volume ${mine.volume} vs ${ref.v}`);
  checked++;
}
// Comparing nothing is not a pass. Every transcript can be skipped (`!ref.n`)
// when the reference parser reads none of them -- a wrong MEMBRIDGE_REF, a
// changed transcript layout, a broken parse_unit -- and the loop would then
// fall through to a cheerful "0 transcripts" line with exit 0. Fail loudly
// instead: a guard that cannot fail is not a guard.
if (checked === 0) {
  console.error(`ledger equivalence: FAILED -- 0 of ${sample.length} transcripts were compared. ` +
    'The reference implementation returned no requests for any of them, so nothing was verified. ' +
    'Check MEMBRIDGE_REF points at a working token-spend-analysis checkout.');
  process.exit(1);
}
console.log(`ledger equivalence: ${checked} transcripts, worst drift ${(worst * 100).toFixed(3)}%`);
