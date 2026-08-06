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
const RUNBOOK = path.join(SUPABASE, 'APPLY-RUNBOOK.md');

// The number registry in APPLY-RUNBOOK.md — which migration numbers are
// CLAIMED, including by branches this checkout cannot see. Distinct from the
// ledger above, which records what is DEPLOYED. A number can be claimed and
// unwritten (allocated to a lane that has not committed yet), and a file can
// exist without being registered, which is the collision this catches.
//
// Rows look like: `| 041 | project_stats carries archived_at | agent-backend2 | no |`
// Returns number -> array of rows, so a number claimed TWICE is visible rather
// than silently overwritten — a map keyed by number would hide the exact defect
// this table exists to prevent.
function registryClaims() {
  const src = fs.readFileSync(RUNBOOK, 'utf8');
  const claims = new Map();
  for (const line of src.split('\n')) {
    const m = line.match(/^\|\s*(\d{3})\s*\|([^|]*)\|([^|]*)\|/);
    if (!m) continue;
    const [, num, what, branch] = m;
    if (!claims.has(num)) claims.set(num, []);
    claims.get(num).push({ what: what.trim(), branch: branch.trim() });
  }
  return claims;
}

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
    // A row may declare `applied (other branch)`: the migration is real and its
    // effect is live, but the FILE is on a sibling lane's branch and has not
    // merged yet. Deleting such a row to make this check pass would delete a
    // true fact about production — 035's delete policy IS live — so the state
    // carries the qualifier instead. The annotation is deliberately ugly: it
    // should be removed the moment that branch merges, and it is visible in the
    // ledger until someone does.
    const ghosts = [...ledger.keys()].filter(num => !onDisk.has(num)
      && ![...(ledger.get(num) || [])].some(s => s.includes('other branch')));
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

  // SEC-9. A migration that claims to RECONSTRUCT a live object is making the
  // strongest possible claim about production — "this file is what is already
  // running" — and it is the one claim nothing here can verify. 031 is the
  // worked example: it carried the verification query from the day it was
  // written, and the gap survived anyway, because nobody had run it and written
  // down what came back. The query alone proves nothing; a query plus a DATED
  // answer is falsifiable by the next reader in one paste.
  //
  // Deliberately narrow, and it fires on the CLAIM rather than on every
  // migration. Most files here create new objects and have nothing to
  // reconstruct; demanding evidence from all of them would be noise, and a
  // noisy gate gets muted, which costs more than the drift it was meant to
  // catch. The trigger is a file saying "reconstruction" / "reconstructs" /
  // "mirrors the LIVE" of itself.
  await check('a migration claiming to reconstruct a live object shows dated evidence', () => {
    const CLAIM = /\b(reconstructions?|reconstructs?|mirrors the live|verbatim from the\s+(?:--\s*)?live)\b/i;
    // The evidence: something that reads the live catalog, and a date next to
    // it. `pg_get_functiondef`, `pg_policy`, `pg_proc`, `information_schema` —
    // any of them is a query whose answer settles the claim.
    const QUERY = /(pg_get_functiondef|pg_proc|pg_policy|pg_policies|pg_class|pg_trigger|information_schema)/i;
    const DATE = /\d{4}-\d{2}-\d{2}/;
    const missing = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
      if (!CLAIM.test(src)) continue;
      // TWO dated markers, by name, and one of them must be present. Prose was
      // tried first and rejected: "was the live object actually read?" matched
      // on any file containing the word "read", which is nearly all of them —
      // a check that cannot fail. A named marker cannot be satisfied by
      // accident and states which of the two honest positions the file is in.
      //
      //   LIVE SHAPE VERIFIED <date>          someone ran the query and the
      //                                       file matches what came back
      //   LIVE SHAPE UNVERIFIED AS OF <date>  nobody has run it yet
      //
      // The second is not a way out. It is dated, it names what is outstanding,
      // and it reads as stale on sight — exactly what the undated "AS OF THIS
      // COMMIT" stamp banned above does not do. The query has to be present
      // either way, so whoever picks it up has the paste in front of them.
      const VERIFIED = /LIVE SHAPE VERIFIED\s+\d{4}-\d{2}-\d{2}/i;
      const UNVERIFIED = /LIVE SHAPE UNVERIFIED AS OF\s+\d{4}-\d{2}-\d{2}/i;
      const gaps = [];
      if (!QUERY.test(src)) gaps.push('no query against the live catalog');
      if (!VERIFIED.test(src) && !UNVERIFIED.test(src)) {
        gaps.push('no dated "LIVE SHAPE VERIFIED <date>" or '
          + '"LIVE SHAPE UNVERIFIED AS OF <date>" marker');
      }
      if (gaps.length) missing.push(`${f}: ${gaps.join('; ')}`);
    }
    assert.deepStrictEqual(missing, [],
      'these files claim to reconstruct or mirror a live object without leaving evidence '
      + 'that anyone looked:\n  ' + missing.join('\n  ')
      + '\nA reconstruction is a claim about production that create-or-replace will act on. '
      + 'Carry BOTH the query that reads the live object AND the dated result of running it. '
      + '031 is why: it had the query from day one and still shipped a filter that differed '
      + 'from live, because the query had never been run and answered in the file.');
  });

  // --- the number registry (SEC-12) ----------------------------------------
  //
  // Three migration-number collisions happened in one day. Every one had the
  // same cause: numbers allocated by hand, in conversation, across parallel
  // branches that cannot see each other's files. `ls supabase/migrations` on
  // one branch is not evidence a number is free, and it was trusted as evidence
  // three times.
  //
  // The registry in APPLY-RUNBOOK.md is the allocation record. These two checks
  // are what stop it becoming the hand-maintained list that already failed —
  // a registry nobody is forced to update is worth less than no registry,
  // because it looks authoritative while being stale.
  const claims = registryClaims();

  await check('every migration number is claimed exactly once in the registry', () => {
    const doubled = [...claims.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([num, rows]) => `  ${num}: claimed ${rows.length}x — `
        + rows.map(r => `${r.branch || '(no branch)'} "${r.what}"`).join(' AND '));
    assert.deepStrictEqual(doubled, [],
      'these migration numbers are claimed more than once in the APPLY-RUNBOOK registry, '
      + 'which is the collision the registry exists to prevent:\n' + doubled.join('\n'));
  });

  // THE BLIND SPOT, found by a real collision DURING the SEC-14 dry run and
  // fixed here. The two checks either side of this one both passed while
  // 048_ops_audit_via_role.sql and 048_audit_member_left.sql sat in the same
  // directory: the registry had exactly one row for 048, and every file's
  // number had a row, so nothing was violated. The registry records that a
  // NUMBER is claimed; it did not record that only ONE FILE may claim it.
  //
  // That is the same defect shape this whole session has been closing — a
  // check that looks like it covers a case and does not — and it was invisible
  // until two branches with different filenames under the same number were
  // merged. git will not conflict on that: different paths, no overlap, both
  // files simply coexist and the second one to be applied is a surprise.
  await check('no two migration files share a number', () => {
    const byNumber = new Map();
    for (const f of files) {
      const num = f.match(/^(\d{3})/)[1];
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(f);
    }
    const collisions = [...byNumber.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([num, list]) => `  ${num}: ${list.join('  AND  ')}`);
    assert.deepStrictEqual(collisions, [],
      'two migration files claim the same number:\n' + collisions.join('\n')
      + '\n\nGit does not conflict on this — different filenames, different paths, both '
      + 'files just coexist — so it survives a merge silently and only shows up when '
      + 'someone applies them. Renumber the one whose claim is NOT in the '
      + 'APPLY-RUNBOOK registry, and add its row in the same commit.');
  });

  await check('every migration file at or above the registry floor is registered', () => {
    // The floor is the lowest number the registry tracks, read from the table
    // rather than hardcoded: everything below it predates concurrent allocation
    // and is settled history covered by the ledger alone. Deriving it means the
    // check follows the registry if its range ever changes.
    const numbers = [...claims.keys()].map(Number);
    assert.ok(numbers.length, 'the APPLY-RUNBOOK registry table could not be parsed at all');
    const floor = Math.min(...numbers);
    const unregistered = files
      .map(f => f.match(/^(\d{3})/)[1])
      .filter(num => Number(num) >= floor && !claims.has(num));
    assert.deepStrictEqual(unregistered, [],
      `these migrations exist on disk but claim no number in the registry: ${unregistered.join(', ')}. `
      + 'Add a row to the table in supabase/APPLY-RUNBOOK.md — number, what it does, which branch '
      + 'holds it, whether it is applied — in the SAME commit as the migration. A number is not '
      + 'free because this branch cannot see a file using it.');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
