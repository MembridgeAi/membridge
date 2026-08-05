'use strict';
// The gate on claims about what is deployed.
//
// WHY THIS EXISTS. A migration header is a claim about production, and this repo
// had no way to notice when one went stale. `032`, `033` and `034` each carried
// `UNAPPLIED AS OF THIS COMMIT` for four releases after a human applied them,
// and `claude/ops/queue.md` copied the same dead fact into the document the next
// session acts on — so a closed hole stayed on the open list and got budgeted
// for. Three copies of one fact drifted into three different facts.
//
// That is the documentation form of a test that cannot fail: an assertion about
// the outside world that nothing re-evaluates. This suite makes the mechanical
// half of it fail loudly.
//
// WHAT IT CANNOT DO, STATED UP FRONT. It runs offline. It cannot ask production
// anything, so it cannot tell you whether an `applied` row is TRUE. It enforces
// three things that are checkable without a database:
//
//   1. every migration declares a state in ONE ledger (a new file cannot be
//      added without saying what it is),
//   2. no file uses the undated `AS OF THIS COMMIT` stamp — the exact form that
//      reads as current forever,
//   3. a file's own header never contradicts the ledger.
//
// The truth of each row still needs a human with credentials running the
// Evidence query in supabase/MIGRATION-STATE.md, or pasting
// supabase/AUDIT-live-state.sql into the SQL editor. This converts silent drift
// into a red test; it does not make the repo self-verifying, and nothing
// offline could.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SUPABASE = path.join(__dirname, '..', '..', 'supabase');
const MIGRATIONS = path.join(SUPABASE, 'migrations');
const LEDGER = path.join(SUPABASE, 'MIGRATION-STATE.md');

const migrationFiles = () => fs.readdirSync(MIGRATIONS)
  .filter(f => /^\d+_.*\.sql$/.test(f))
  .sort();

// A ledger row looks like `| 033 \`enforce_project_access_on_write\` | applied | ... |`.
// Only the number and the state are load-bearing here; the evidence column is
// for the human running the query, not for this test to parse.
function ledgerStates() {
  const src = fs.readFileSync(LEDGER, 'utf8');
  const states = new Map(); // "033" -> Set of declared states
  for (const line of src.split('\n')) {
    // The state column may carry a qualifier — "applied (superseded)" — so the
    // capture has to allow parens. It did not at first, and the row simply
    // vanished from the map, which this suite then reported as "012 declares no
    // state". Worth keeping in mind: a parser that silently drops a row makes a
    // present fact look absent.
    const m = line.match(/^\|\s*(\d{3})\s*[`\w\s()]*\|\s*\**([\w ()]+?)\**\s*\|/);
    if (!m) continue;
    const [, num, state] = m;
    if (!states.has(num)) states.set(num, new Set());
    states.get(num).add(state.trim().toLowerCase());
  }
  return states;
}

async function main() {
  const files = migrationFiles();
  const ledger = ledgerStates();

  // The drift-prevention that actually matters going forward. Everything else
  // here is about the files that already exist; this is what stops the next
  // migration from being born with an unrecorded state.
  await check('every migration file has a row in supabase/MIGRATION-STATE.md', () => {
    const missing = files
      .map(f => f.match(/^(\d{3})/)[1])
      .filter(num => !ledger.has(num));
    assert.deepStrictEqual(missing, [],
      `these migrations declare no state: ${missing.join(', ')}. Add a row to ` +
      'supabase/MIGRATION-STATE.md — "unverified" is a valid and honest answer, ' +
      'and is NOT the same as "unapplied".');
  });

  // The ledger must not name files that do not exist, or a rename silently
  // leaves a row describing nothing while the real file goes unrecorded.
  await check('the ledger names no migration that is not on disk', () => {
    const onDisk = new Set(files.map(f => f.match(/^(\d{3})/)[1]));
    const ghosts = [...ledger.keys()].filter(num => !onDisk.has(num));
    assert.deepStrictEqual(ghosts, [],
      `the ledger has rows for migrations that do not exist: ${ghosts.join(', ')}`);
  });

  // THE anti-pattern, banned by name. A dated stamp reads as stale on sight; an
  // undated one reads as current forever, which is how three files stayed wrong
  // through four releases.
  await check('no migration carries the undated "AS OF THIS COMMIT" stamp', () => {
    // Anchored to the start of a comment line, because that is what a STAMP is.
    // A bare substring search also flags the corrected headers, which quote the
    // banned phrase in order to explain why it was wrong — and a rule that
    // punishes documenting the mistake teaches people to delete the history
    // instead of recording it.
    const offenders = files.filter(f =>
      /^--\s*(?:\*\*)?UNAPPLIED AS OF THIS COMMIT/im
        .test(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')));
    assert.deepStrictEqual(offenders, [],
      `${offenders.join(', ')} claim to be unapplied without saying as of WHEN. ` +
      'Use "UNAPPLIED AS OF <date>" plus the query that settles it, and record ' +
      'the same state in supabase/MIGRATION-STATE.md.');
  });

  // The three-copies problem, reduced to the two copies that must exist: a file
  // may state its own status, but it may not disagree with the ledger.
  await check('no migration header contradicts the ledger', () => {
    const conflicts = [];
    for (const f of files) {
      const num = f.match(/^(\d{3})/)[1];
      const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      const declared = ledger.get(num);
      if (!declared) continue;
      // A STAMP is uppercase and followed by a delimiter. Case-insensitive
      // matching here produced a false positive on 011, whose prose happens to
      // begin a line with "applied — an applied migration is a historical
      // record". A gate that cries wolf on ordinary English gets muted, which
      // costs more than the drift it was meant to catch, so it is deliberately
      // narrow: it recognises the convention, not the word.
      const headerSaysApplied = /^--\s*(?:\*\*)?APPLIED(?=\s*[—:-])/m.test(src);
      const headerSaysUnapplied = /^--\s*(?:\*\*)?UNAPPLIED\b/m.test(src);
      if (headerSaysApplied && headerSaysUnapplied) {
        conflicts.push(`${f}: header says both APPLIED and UNAPPLIED`);
        continue;
      }
      // A 016-style row can legitimately carry two states (one per variant), so
      // "the ledger says applied anywhere for this number" is the right test.
      const ledgerApplied = [...declared].some(s => s.startsWith('applied'));
      const ledgerUnapplied = [...declared].some(s => s.includes('not applied'));
      if (headerSaysApplied && !ledgerApplied) {
        conflicts.push(`${f}: header says APPLIED, ledger does not`);
      }
      if (headerSaysUnapplied && !ledgerUnapplied && !ledgerApplied) {
        conflicts.push(`${f}: header says UNAPPLIED, ledger has no matching row`);
      }
    }
    assert.deepStrictEqual(conflicts, [],
      `applied/unapplied is recorded in two places and they disagree:\n  ${conflicts.join('\n  ')}`);
  });

  // The ledger's whole value is that its claims are dated. An undated ledger is
  // the same failure one level up.
  await check('the ledger states when it was verified, and against which project', () => {
    const src = fs.readFileSync(LEDGER, 'utf8');
    assert.match(src, /\d{4}-\d{2}-\d{2}/,
      'MIGRATION-STATE.md must carry the date its rows were verified');
    assert.match(src, /mefgbiecvoszjorwzkfz/,
      'MIGRATION-STATE.md must name the project its rows were verified against — ' +
      '"applied" is meaningless without saying applied WHERE');
  });

  // 031 is the one genuinely-unapplied numbered migration, and it is also a
  // reconstruction of an object that already exists in production, so applying
  // it blind would overwrite live behaviour with a guess. That pairing is easy
  // to lose when someone works down the list applying everything outstanding.
  await check('031 is recorded as unapplied AND as a reconstruction', () => {
    const row = [...(ledger.get('031') || [])].join(',');
    assert.ok(row.includes('not applied'),
      `031 must stay recorded as unapplied; ledger says "${row}"`);
    const src = fs.readFileSync(LEDGER, 'utf8');
    assert.match(src, /031[\s\S]{0,600}?RECONSTRUCTION/i,
      'the 031 row must keep its "diff before applying" warning: the live ' +
      'rls_auto_enable predates the repo, so create-or-replace would overwrite ' +
      'production with a reconstruction');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
