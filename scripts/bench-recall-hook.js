#!/usr/bin/env node
// CPU cost of ONE PreToolUse recall-hook invocation, end to end, on the real
// hook path. Run it on two commits to get a before/after for a change to that
// path -- which is what the 150ms hook budget in lib/hooks-recall.js's header
// has to be argued against.
//
// process.cpuUsage(), never wall-clock: this machine runs several agents at
// once and wall-clock timings here have lied before. The number reported is
// the CHILD's own user+system CPU, which the child prints at exit, so node's
// startup and require graph are included -- that is what actually runs in
// front of a Read.
//
// Fully isolated: its own MEMBRIDGE_HOME and scratch project, like
// scripts/prove-tier-a-serves.js. Never touches the live daemon.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-bench-'));
const HOME = path.join(ROOT, 'home');
const PROJ = path.join(ROOT, 'scratch-project');
const SESSION = '11111111-2222-3333-4444-666666666666';

fs.mkdirSync(path.join(PROJ, 'lib'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
fs.mkdirSync(path.join(PROJ, '.membridge'), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });

// A read mix shaped like the measured one for this repo: mostly small source
// files, a long tail. Sizes in KB.
const SIZES = [4, 8, 10, 12, 16, 20, 24, 32, 42, 64, 96, 140, 200, 300, 512, 1513];
const rels = SIZES.map((kb, i) => {
  const rel = `lib/file-${i}-${kb}kb.js`;
  const line = 'function stepper() { return 1; } // padding to look like source\n';
  fs.writeFileSync(path.join(PROJ, rel), line.repeat(Math.round((kb * 1024) / line.length)));
  return rel;
});

fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({
  version: 2, files: {}, projects: { [PROJ]: { events: [] } }, catchup: {}, feedback: {},
}));
// The ledger a session's second read arrives in: this session has read them all.
fs.writeFileSync(path.join(PROJ, '.membridge', 'ledger.json'), JSON.stringify({
  version: 5, sessions: 1, requests: 1, volume: 1, reads: {}, hotPaths: [],
  fileReaders: Object.fromEntries(rels.map(r => [r, { sessions: [SESSION], reads: 2, lastTs: new Date().toISOString() }])),
}));

const env = { ...process.env, MEMBRIDGE_HOME: HOME };
// The child prints its own CPU at exit; runRecall's own stdout goes to the
// pipe we ignore.
const runner = path.join(ROOT, 'runner.js');
fs.writeFileSync(runner, `
const s = process.cpuUsage();
require(${JSON.stringify(path.join(REPO, 'lib', 'hooks-recall.js'))}).runRecall();
const d = process.cpuUsage(s);
require('fs').writeSync(2, String((d.user + d.system) / 1000));
`);

function once(rel) {
  const r = cp.spawnSync(process.execPath, [runner], {
    input: JSON.stringify({
      session_id: SESSION, cwd: PROJ, tool_name: 'Read',
      tool_input: { file_path: path.join(PROJ, rel) },
    }),
    env, encoding: 'utf8',
  });
  return { cpu: Number(r.stderr), served: /already read/.test(r.stdout || '') };
}

const PASSES = Number(process.argv[2] || 5);
const samples = [];
let serves = 0;
for (let pass = 0; pass < PASSES; pass++) {
  for (const rel of rels) {
    const { cpu, served } = once(rel);
    if (served) serves++;
    // Pass 0 is every path's FIRST read (bootstrap); later passes are the
    // repeat reads Tier A exists for. Both are reported.
    samples.push({ pass, rel, cpu });
  }
}
const stat = list => {
  const s = list.slice().sort((a, b) => a - b);
  const at = p => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return `p50 ${at(0.5).toFixed(2)}ms  p90 ${at(0.9).toFixed(2)}ms  max ${s[s.length - 1].toFixed(2)}ms`;
};
console.log(`invocations: ${samples.length} (${rels.length} paths x ${PASSES} passes), Tier A serves: ${serves}`);
console.log(`first read of a path : ${stat(samples.filter(s => s.pass === 0).map(s => s.cpu))}`);
console.log(`repeat reads         : ${stat(samples.filter(s => s.pass > 0).map(s => s.cpu))}`);
console.log(`all                  : ${stat(samples.map(s => s.cpu))}`);
fs.rmSync(ROOT, { recursive: true, force: true });
