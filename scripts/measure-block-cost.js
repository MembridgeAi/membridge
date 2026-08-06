#!/usr/bin/env node
'use strict';
// Measure what MemBridge's own context block COSTS, against what the ledger
// records it avoided (REV-1). Read-only: touches nothing but this machine's
// ~/.membridge/state.json and each tracked project's ledger + context files.
//
// WHY THIS EXISTS. MemBridge's claim is that it saves tokens. The ledger
// measures the saving. The mechanism's own cost -- every injected block is
// tokens in someone's context window, every session, used or not -- is not
// recorded anywhere. This script measures it, so the comparison can be made
// on real data instead of asserted.
//
// THE RULER IS NOT chars/4. lib/token-estimate.js on master is
// `Math.ceil(len / 4)`, which understates real repo source by ~8%. Every
// figure the ledger reports today carries that bias. This script instead
// bootstraps the BPE tokenizer from the unmerged wip/bpe-tokenizer commit,
// which vendors Anthropic's published Claude BPE vocabulary (validated in
// that commit against js-tiktoken: exact match on 8 real repo files and 3000
// random-unicode fuzz strings). That branch is unmerged because of an
// unrelated MIN_COMPRESSION recalibration in the recall SERVE path -- which
// blocks using it as policy, not as a ruler.
//
// IT MUST BE ABLE TO FAIL. This script makes claims, so every way it could
// quietly produce a wrong number is a hard exit instead:
//   * tokenizer source or vocabulary not reachable   -> exit 2
//   * tokenizer loads but reports itself degraded    -> exit 3 (never falls
//     back to chars/4 -- a silent 8% error in a figure this contested is the
//     exact defect shape this codebase keeps finding)
//   * self-test against pinned expected counts fails -> exit 4
//   * no state / no ledgers / no blocks to measure   -> exit 5 (an empty
//     install must not print zeros as though they were a finding)
//
// USAGE
//   node scripts/measure-block-cost.js            # human-readable report
//   node scripts/measure-block-cost.js --json     # machine-readable
//
//   MEMBRIDGE_HOME=... node scripts/measure-block-cost.js   # another install
//
// Re-running this on an install that is NOT dominated by one huge project is
// the single most useful follow-up -- see docs/block-cost-measurement.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The wip/bpe-tokenizer commit. Pinned by sha, not by branch name: a branch
// can move or be deleted, and a measurement whose ruler silently changed is
// worse than one that fails to run.
const TOKENIZER_REF = 'ad6c9ff';
const BEGIN = '<!-- membridge:begin -->';
const END = '<!-- membridge:end -->';

// Pinned expectations for the ruler itself. If the vocabulary ever decodes to
// different merges these change, and the script stops rather than reporting
// numbers from an unknown tokenizer. Values captured 2026-08-05 against
// TOKENIZER_REF; chars/4 for the same strings is shown in the doc.
const SELF_TEST = [
  { text: 'The quick brown fox jumps over the lazy dog.', tokens: 10 }, // chars/4 says 11
  { text: BEGIN, tokens: 6 },
  { text: '## Shared AI memory (MemBridge)', tokens: 8 },
];

function die(code, msg, hint) {
  process.stderr.write(`\nmeasure-block-cost: ${msg}\n`);
  if (hint) process.stderr.write(`${hint}\n`);
  process.exit(code);
}

// Bootstrap the ruler out of git into a temp dir, in the layout its own
// vocabPath() expects (lib/ beside vendor/tokenizer/).
function loadTokenizer(repoRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-ruler-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'vendor', 'tokenizer'), { recursive: true });
  const show = (blob, dest) => {
    const buf = execFileSync('git', ['-C', repoRoot, 'show', `${TOKENIZER_REF}:${blob}`],
      { maxBuffer: 8 << 20 });
    fs.writeFileSync(dest, buf);
  };
  try {
    show('lib/token-estimate.js', path.join(dir, 'lib', 'token-estimate.js'));
    show('vendor/tokenizer/claude-bpe.bin', path.join(dir, 'vendor', 'tokenizer', 'claude-bpe.bin'));
  } catch (err) {
    die(2, `could not read the tokenizer from ${TOKENIZER_REF} (${err.code || err.message})`,
      'That commit carries the vendored Claude BPE vocabulary. Fetch the branch first:\n'
      + '  git fetch origin wip/bpe-tokenizer\n'
      + 'This script deliberately has no chars/4 fallback — see the header.');
  }
  let mod;
  try {
    mod = require(path.join(dir, 'lib', 'token-estimate.js'));
  } catch (err) {
    die(2, `the tokenizer module would not load (${err.message})`);
  }
  if (typeof mod.estimateDegraded === 'function' && mod.estimateDegraded()) {
    die(3, 'the tokenizer loaded but reports itself DEGRADED (missing or corrupt vocabulary).',
      'It would silently fall back to chars/4, which understates by ~8%. Refusing to report.');
  }
  for (const c of SELF_TEST) {
    const got = mod.estimateTokens(c.text);
    if (got !== c.tokens) {
      die(4, `tokenizer self-test failed: ${JSON.stringify(c.text.slice(0, 40))} -> ${got}, expected ${c.tokens}.`,
        'The vocabulary is not the one these figures were calibrated against. Refusing to report.');
    }
  }
  return mod.estimateTokens;
}

function blockTokensIn(file, countTokens) {
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  const b = s.indexOf(BEGIN);
  const e = s.lastIndexOf(END);
  if (b === -1 || e <= b) return 0;
  return countTokens(s.slice(b, e + END.length));
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const repoRoot = path.resolve(__dirname, '..');
  const countTokens = loadTokenizer(repoRoot);

  const home = process.env.MEMBRIDGE_HOME || path.join(os.homedir(), '.membridge');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  } catch (err) {
    die(5, `no readable state.json under ${home} (${err.code || err.message})`,
      'Nothing to measure. Point MEMBRIDGE_HOME at an install that has run.');
  }

  const rows = [];
  const tot = {
    projects: 0, sessions: 0, requests: 0, volume: 0,
    avoided: 0, billed: 0, notesTokens: 0, notesInjections: 0,
    blockOnce: 0, blockRide: 0, serves: 0, holdoutSkips: 0,
  };
  for (const key of Object.keys(state.projects || {})) {
    let led;
    try { led = JSON.parse(fs.readFileSync(path.join(key, '.membridge', 'ledger.json'), 'utf8')); } catch { continue; }
    // CLAUDE.md only. AGENTS.md carries its own block for Codex-family tools,
    // but counting both would assume one session loads both, which is a claim
    // about the reader's tool, not something this machine's data shows.
    const blockTokens = blockTokensIn(path.join(key, 'CLAUDE.md'), countTokens);
    const av = (led.avoided || {});
    const ho = (led.holdout || {});
    const notes = (led.notes || {});
    const sessions = led.sessions || 0;
    const requests = led.requests || 0;
    rows.push({
      project: path.basename(key),
      sessions, requests, volume: led.volume || 0,
      blockTokens,
      // Once-only: one copy per session. Directly comparable to ledger
      // `avoided`, which counts what a serve kept out of context ONCE.
      blockOnce: blockTokens * sessions,
      // Ride-along: the block is in the context of every request of the
      // session, so it is re-sent with each one. Same model as
      // lib/ledger-fold-recall-ride.js (tokens x subsequent requests), with
      // ONE deliberate difference: that model excludes sidechain (subagent)
      // requests because the avoided read was never in a subagent's context.
      // A subagent DOES load CLAUDE.md, so the block rides along there too
      // and those requests are counted here.
      blockRide: blockTokens * requests,
      avoided: av.tokens || 0,
      billed: (led.billed || {}).tokens || 0,
      notesTokens: notes.tokens || 0,
    });
    tot.projects++;
    tot.sessions += sessions;
    tot.requests += requests;
    tot.volume += led.volume || 0;
    tot.avoided += av.tokens || 0;
    tot.serves += av.serves || 0;
    tot.holdoutSkips += ho.skips || 0;
    tot.billed += (led.billed || {}).tokens || 0;
    tot.notesTokens += notes.tokens || 0;
    tot.notesInjections += notes.injections || 0;
    tot.blockOnce += blockTokens * sessions;
    tot.blockRide += blockTokens * requests;
  }

  if (!tot.projects) die(5, `no project ledgers found under ${home}`, 'Nothing to measure.');
  if (!tot.blockOnce) {
    die(5, 'no context blocks found in any tracked project',
      'Either nothing has been injected yet, or the targets do not include CLAUDE.md.');
  }

  rows.sort((a, b) => b.volume - a.volume);
  const ratio = (a, b) => (b ? `${(a / b * 100).toFixed(0)}%` : 'n/a (denominator is 0)');
  const out = {
    tokenizerRef: TOKENIZER_REF,
    home,
    totals: tot,
    perProject: rows,
    ratios: {
      blockOnceOverAvoided: tot.avoided ? tot.blockOnce / tot.avoided : null,
      blockRideOverBilled: tot.billed ? tot.blockRide / tot.billed : null,
      blockRideOverVolume: tot.volume ? tot.blockRide / tot.volume : null,
    },
    // The qualifiers travel WITH the numbers, in the machine-readable output
    // too, because the ratio alone supports a conclusion the data does not.
    qualifiers: {
      avoidedServes: tot.serves,
      holdoutSkips: tot.holdoutSkips,
      minHoldoutForEffect: 30,
      benefitSideSufficient: tot.holdoutSkips >= 30,
      note: tot.holdoutSkips < 30
        ? 'BENEFIT SIDE HAS NOT MET ITS OWN SUFFICIENCY GATE. The cost below is fully '
          + 'accrued; the benefit is not. Do not read the ratio as an effect size.'
        : 'Benefit side has met the sufficiency gate.',
    },
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  const f = n => n.toLocaleString();
  const L = [];
  L.push(`\nMemBridge block cost vs measured avoidance — ${home}`);
  L.push(`ruler: Claude BPE from ${TOKENIZER_REF} (self-test passed; NOT chars/4)\n`);
  L.push('project              sess    reqs  blkTok     block once     block ride');
  for (const r of rows) {
    L.push(`${r.project.slice(0, 18).padEnd(18)} ${String(r.sessions).padStart(5)} ${String(r.requests).padStart(7)} `
      + `${String(r.blockTokens).padStart(7)} ${f(r.blockOnce).padStart(14)} ${f(r.blockRide).padStart(14)}`);
  }
  L.push(`\n--- ONCE-ONLY BASIS (comparable to ledger 'avoided') ---`);
  L.push(`  avoided        ${f(tot.avoided).padStart(16)}`);
  L.push(`  block cost     ${f(tot.blockOnce).padStart(16)}   block is ${ratio(tot.blockOnce, tot.avoided)} of avoided`);
  L.push(`  net            ${f(tot.avoided - tot.blockOnce).padStart(16)}`);
  L.push(`\n--- RIDE-ALONG BASIS (comparable to ledger 'billed') ---`);
  L.push(`  billed         ${f(tot.billed).padStart(16)}`);
  L.push(`  block cost     ${f(tot.blockRide).padStart(16)}   block is ${ratio(tot.blockRide, tot.billed)} of billed`);
  L.push(`  net            ${f(tot.billed - tot.blockRide).padStart(16)}`);
  L.push(`\n--- ALREADY COUNTED, for contrast ---`);
  L.push(`  notesInjectedTokens ${f(tot.notesTokens).padStart(11)} (${tot.notesInjections} injections) — has a ledger surface`);
  L.push(`  block cost          ${f(tot.blockOnce).padStart(11)} — has none`);
  L.push(`\n--- QUALIFIERS (read these before the ratio) ---`);
  L.push(`  avoided.serves ${tot.serves}, holdout.skips ${tot.holdoutSkips} against a gate of 30`);
  L.push(`  ${out.qualifiers.note}`);
  L.push(`  block ride-along is ${(tot.blockRide / tot.volume * 100).toFixed(2)}% of all context ever sent here.`);
  L.push(`  See docs/block-cost-measurement.md before quoting any of this.\n`);
  process.stdout.write(`${L.join('\n')}\n`);
}

main();
