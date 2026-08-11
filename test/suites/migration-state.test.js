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
    const m = line.match(/^\|\s*(\d{3})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!m) continue;
    const [, num, what, branch, applied] = m;
    if (!claims.has(num)) claims.set(num, []);
    claims.get(num).push({ what: what.trim(), branch: branch.trim(), applied: applied.trim() });
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
    // Capture the state column WHOLE — everything up to the closing pipe —
    // rather than by an allow-list of characters.
    //
    // This was `[\w\s()]` and before that had no parens at all. Each time
    // someone wrote a status the class did not cover, the row did not error:
    // it silently STOPPED MATCHING and vanished from the map, resurfacing as
    // "012 declares no state" or as `ledger says ""`. Both read as a missing
    // row rather than a parse failure, which is the wrong problem to go
    // looking for. The class had been narrowed-then-widened reactively twice,
    // which is the tell that an allow-list is the wrong tool here.
    //
    // Now a row can only fail to parse by not being a row. Whatever is in the
    // state column arrives as text and is judged downstream, so the failure
    // mode is "unrecognised status" rather than "row disappeared".
    const m = line.match(/^\|\s*(\d{3})\s*[^|]*\|([^|]*)\|/);
    if (!m) continue;
    const [, num, state] = m;
    if (!states.has(num)) states.set(num, new Set());
    // Strip the bold markers the ledger uses for emphasis; they are formatting,
    // not part of the status.
    states.get(num).add(state.replace(/\*/g, '').trim().toLowerCase());
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

  // THE TWO-DOCUMENT DRIFT, and the one with a human at the end of it.
  //
  // MIGRATION-STATE.md records what is DEPLOYED. APPLY-RUNBOOK.md is the
  // numbered list a human opens and pastes from. Nothing read them together,
  // so they drifted, and on 2026-08-08 they disagreed in the direction that
  // costs something: the ledger had been reconciled against production and
  // said 037, 038, 039, 040 and 031 were live, while the runbook still listed
  // all five as steps to paste, in order, with prose telling the reader to do
  // 031 "when the other five are known good".
  //
  // Re-running 037-040 would likely have been harmless. 031 would not: it is a
  // RECONSTRUCTION of an object that predates the repo, so `create or replace`
  // would have replaced working production behaviour with our best guess at
  // it, for no gain, since the behaviour was already confirmed live.
  //
  // The suite was green throughout. It asserted things about the ledger and
  // nothing about the document that actually gets acted on — the check passed
  // while the dangerous instruction sat there. Fixing that instance by hand
  // fixes five rows and leaves the mechanism, so this is the mechanism.
  //
  // A struck step (`~~14~~`) is the runbook's own "do not paste this" marker
  // and is what the fix looks like, so struck rows are exempt by design.
  await check('the runbook never lists a migration the ledger calls applied', () => {
    const src = fs.readFileSync(RUNBOOK, 'utf8');
    const live = [];
    for (const line of src.split('\n')) {
      // A LIVE apply-step: a step number NOT wrapped in ~~strikethrough~~,
      // followed by a cell naming a NNN_*.sql file.
      const m = line.match(/^\|\s*(\d+)\s*\|\s*`?(\d{3})_[^`|]*\.sql`?\s*\|/);
      if (!m) continue;
      const [, , num] = m;
      const declared = [...(ledger.get(num) || [])];
      // TWO disqualifiers, not one. "applied" is the common case (pasting it
      // again is redundant). "never apply" is the rarer and worse one: 031 is
      // marked that way precisely BECAUSE its behaviour is live and the file is
      // a reconstruction, so its status is not "applied" and an applied-only
      // predicate would have walked straight past the single most dangerous
      // row in the table.
      const bad = declared.some(s => s.startsWith('applied') || s.includes('never apply'));
      if (bad) live.push(`step ${m[1]} = ${num}`);
    }
    assert.deepStrictEqual(live, [],
      'APPLY-RUNBOOK.md lists these as steps to paste, but MIGRATION-STATE.md '
      + `records them as applied or as never-apply: ${live.join(', ')}. `
      + 'Either the ledger is wrong or the runbook is stale — settle it against '
      + 'production, then strike the runbook step (~~N~~) with the reason. '
      + 'Re-applying is usually harmless; for a RECONSTRUCTION it overwrites '
      + 'live behaviour with a guess.');
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

  // 031 is a RECONSTRUCTION of an object that already exists in production, so
  // applying it blind would overwrite live behaviour with a guess. That is the
  // property worth pinning, and it is easy to lose when someone works down the
  // list applying everything outstanding.
  //
  // This check used to also assert the row said "not applied". That assertion
  // was a PROXY for the danger, and on 2026-08-08 the proxy went wrong while
  // the danger did not. Re-verification against production (`pg_get_functiondef`
  // on the live `rls_auto_enable`) found every distinctive string from 031's
  // body already live — the fail-closed `raise exception`, the `search_path`
  // pin, the skip-logging branch. The old "not applied" was false, and false in
  // the DANGEROUS direction: it told a reader that production's RLS auto-enable
  // fails OPEN when it in fact fails CLOSED.
  //
  // So the status string is not the invariant. The invariant is that the row
  // never lets a reader run this file against production without diffing first,
  // whatever its applied state says.
  await check('031 is recorded as a reconstruction that must not be applied blind', () => {
    const src = fs.readFileSync(LEDGER, 'utf8');
    assert.match(src, /031[\s\S]{0,600}?RECONSTRUCTION/i,
      'the 031 row must keep its "diff before applying" warning: the live ' +
      'rls_auto_enable predates the repo, so create-or-replace would overwrite ' +
      'production with a reconstruction');
    assert.match(src, /031[\s\S]{0,600}?diff before/i,
      'the 031 row must carry an explicit instruction to diff before any ' +
      '`create or replace`. Marking it "applied" is fine and is now correct — ' +
      'losing the do-not-apply-blind instruction is not');
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

  // THE REGISTRY AND THE APPLY ORDER MUST AGREE.
  //
  // This is the SECOND time the runbook silently lost migrations. The first was
  // four of them, found by the SEC-14 merge; the fix was to add them. That fix
  // did not stop it recurring, because the runbook holds TWO lists — a registry
  // of every number, and an apply order telling Marco what to paste — and
  // nothing made them agree. Migrations arriving from a later merge landed in
  // the registry (which the gate checks) and not in the order (which it did
  // not), so the artifact he actually follows was short by three.
  //
  // Adding the missing rows again would have been the same fix a second time.
  // These two checks are the thing that stops a third.
  const applyOrderNames = () => {
    const src = fs.readFileSync(RUNBOOK, 'utf8');
    // Every `NNN_name.sql` the runbook names ANYWHERE outside the registry
    // table. Deliberately loose about WHERE: a migration described in prose, in
    // a grouped table or in its own section is all equally "told to apply". The
    // failure being caught is silence, not formatting.
    return new Set([...src.matchAll(/`(\d{3})_[a-z0-9_]+\.sql`/g)].map(m => m[1]));
  };

  await check('every migration the registry calls unapplied appears in the apply order', () => {
    const named = applyOrderNames();
    const missing = [...claims.entries()]
      .filter(([, rows]) => rows.some(r => /^\s*no\b/i.test(r.applied || '')))
      .map(([num]) => num)
      .filter(num => !named.has(num));
    assert.deepStrictEqual(missing, [],
      `the registry marks these unapplied, and the apply instructions never mention them: ${missing.join(', ')}. `
      + 'Marco follows the apply order, not the registry — a migration missing from it is one he will '
      + 'not apply and will get no signal about. Either add it with its check, or say explicitly that '
      + 'it belongs to a later batch and why. "Absent" is not an answer, because absence is '
      + 'indistinguishable from an oversight, which is exactly what it was both times.');
  });

  await check('every migration in the apply order has a registry row', () => {
    const numbers = [...claims.keys()].map(Number);
    const floor = Math.min(...numbers);
    const orphans = [...applyOrderNames()]
      .filter(num => Number(num) >= floor && !claims.has(num));
    assert.deepStrictEqual(orphans, [],
      `the apply order tells someone to paste these, and the registry does not claim them: ${orphans.join(', ')}. `
      + 'The two lists are the same fact written twice; either both know about a migration or neither does.');
  });

  // --- the ACL treadmill (ticket #18) --------------------------------------
  //
  // `create or replace` cannot change a function's RETURNS TABLE column list,
  // so every function here that gains a column has to be dropped and recreated
  // — and **a drop resets the ACL to the Postgres default, EXECUTE to PUBLIC.**
  // `team_feed` went through that four times after 010 correctly revoked it
  // (013, 014, 017, 025), and each time it silently shipped PUBLIC-callable
  // again. Nothing in the repo said so, and the one file that looked like it
  // fixed this (054:201) revoked from `anon`, which holds no direct grant and
  // so was a no-op.
  //
  // GUARDED IS DERIVED, NOT HARDCODED. A function counts as guarded once ANY
  // migration has revoked it from PUBLIC — the repo's own history is the
  // evidence for what is supposed to be private, so this cannot go stale the
  // way a hand-kept list would. Adding a new definer function with its revoke
  // enrols it automatically.
  //
  // WHAT THIS GATE CANNOT DO, and it is the dominant risk in this project:
  // it reads the repo. A statement pasted straight into the Supabase SQL editor
  // and never committed escapes it completely, which is how much of this schema
  // actually got here. It narrows the recurrence that DID happen four times; it
  // does not make the rule self-enforcing, and a green run here is not evidence
  // about production.
  const ACL_RULE_FLOOR = 56; // the rule starts at 056; earlier files are history

  const flat = f => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/\s+/g, ' ');
  const createsIn = src =>
    [...src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi)].map(m => m[1]);
  const revokedFromPublicIn = src =>
    [...src.matchAll(/revoke\s+execute\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s*from\s+([^;]*);/gi)]
      .filter(m => /\bpublic\b/i.test(m[2])).map(m => m[1]);
  const grantedIn = src =>
    [...src.matchAll(/grant\s+execute\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s*to\s+([^;]*);/gi)]
      .map(m => m[1]);

  await check('recreating a guarded definer function re-issues its revoke and grant', () => {
    const guarded = new Set();
    for (const f of files) revokedFromPublicIn(flat(f)).forEach(fn => guarded.add(fn));
    assert.ok(guarded.size, 'no function is revoked from PUBLIC anywhere — this check cannot be right');

    const offenders = [];
    for (const f of files) {
      if (Number(f.match(/^(\d{3})/)[1]) < ACL_RULE_FLOOR) continue;
      const src = flat(f);
      const revoked = new Set(revokedFromPublicIn(src));
      const granted = new Set(grantedIn(src));
      for (const fn of new Set(createsIn(src))) {
        if (!guarded.has(fn)) continue;
        const gaps = [];
        if (!revoked.has(fn)) gaps.push('no `revoke execute ... from public`');
        // The grant is not optional either, and for a forward-looking reason: a
        // drop discards EVERY grant, so a file carrying only a revoke restores
        // nothing and leaves the next person to recreate the function with an
        // incomplete template. 042 makes the same point about can_see_project —
        // "revoking without this grant would break every read it guards."
        if (!granted.has(fn)) gaps.push('no paired `grant execute ... to authenticated`');
        if (gaps.length) offenders.push(`${f}: public.${fn} — ${gaps.join('; ')}`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      'these migrations create a function that this repo has elsewhere taken off the PUBLIC grant, '
      + 'without re-issuing it:\n  ' + offenders.join('\n  ')
      + '\n\nA drop+create resets the ACL to EXECUTE to PUBLIC, so the function ships public-callable '
      + 'and nothing in the repo records it. That happened to team_feed four times (013, 014, 017, 025). '
      + 'Put BOTH statements in the same file as the create: a drop discards every grant, so a file '
      + 'carrying only a revoke restores nothing and hands the next person an incomplete template.');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
