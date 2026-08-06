'use strict';
// A project_access row must only be able to decide access to a project in the
// team it was written under.
//
// THE HOLE, stated as the two halves that do not meet.
//
//   WRITE SIDE (024_project_access_and_audit.sql:77-83). The insert and update
//   policies are `with check (public.is_team_manager(team_id))` and nothing
//   else. project_key is a bare `text` column (024:32) with no foreign key, no
//   check constraint and no trigger tying it to a project of that team --
//   deliberately text, "so this table never has to change shape if a future
//   project identifier isn't a uuid". So an owner or admin of ANY team may
//   write a row naming ANY project's uuid. The composite FK (024:38) constrains
//   member_id to a member of team_id; nothing constrains project_key at all.
//
//   READ SIDE (028_enforce_project_access_default.sql:113-121). can_see_project
//   resolves the row by (project_key, member_id) and never mentions team_id.
//   Tier 1 -- an existing row -- is decisive by design ("an existing row ALWAYS
//   settles the answer and can never fall through to tier 2"), which is what
//   makes the deliberate revoke authoritative.
//
// Put together, a row written under team A settles access to a project in team
// B. Both directions are reachable:
//
//   GRANT. A member of team B cannot see project P because P.default_access is
//   false and nobody wrote them a row (tier 2 denies). They create their own
//   team A -- create_team is available to any authenticated user -- making
//   themselves its owner, then POST to /rest/v1/project_access with
//   { team_id: A, project_key: P, member_id: self, can_see: true }. The write
//   passes is_team_manager(A). can_see_project(P) now returns tier 1 = true,
//   and memory_entries_select / project_stats / team_feed / team_feed_counts
//   all open.
//
//   REVOKE. An owner of team A who shares any team with Bob writes
//   { team_id: A, project_key: <a project of team B>, member_id: Bob,
//     can_see: false }. bool_and lets any false win, so Bob loses access to a
//   project in a team A's owner has nothing to do with -- and on Bob's machine
//   lib/teamsync.js's access-lost branch then stamps teamAccessLost, empties
//   the cached rows, prunes the durable archive and erases the notes index.
//   Cross-tenant destruction of local data, not merely a denied read.
//
// Neither needs the app: 033_enforce_project_access_on_write.sql's own header
// already names "anyone using the project's anon key with their own valid
// bearer token directly (the anon key is public by design)" as a first-class
// caller.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE. Nothing here executes Postgres, so
// these are STRUCTURAL checks over supabase/migrations, the same stance
// test/suites/schema-indexes.test.js takes: they assert that the invariant is
// declared somewhere, not that a live database enforces it. The live database
// was checked separately and matches these files exactly -- project_access
// carries only the PK and the two team-scoped FKs, no trigger, and
// can_see_project's deployed body is 028's verbatim.
//
// NOTE FOR WHOEVER FIXES THIS. schema-indexes.test.js pins the CURRENT
// predicate ('member_id', 'project_key') and pairs it with 034's index. Scoping
// can_see_project by team therefore requires updating that suite and 034's
// index columns in the same change. The alternative fix -- constraining
// project_key on the write side -- leaves both untouched, which is why this
// suite asserts the invariant rather than one implementation of it.
//
// Run directly, or via `node test/run.js project-access-team-scope`.
// STATUS (2026-08-05): HALF FIXED, AND THE HALF THAT IS FIXED DESERVES A
// SECOND LOOK. Read this before concluding anything from the tally.
//
// `agent-sec` added supabase/migrations/037_project_access_team_scope.sql.
// Running THIS suite against that branch's full migration set (substituted in,
// run, reverted) gives 4/5:
//   - "a project_access write cannot name a project outside its own team" PASSES
//   - "can_see_project resolves ... within the project's own team" STILL FAILS
//
// THE READ SIDE IS GENUINELY STILL OPEN. The newest can_see_project on
// agent-sec is still the one in 028_enforce_project_access_default.sql, and it
// resolves the row on `a.project_key = p_project::text and a.member_id =
// auth.uid()` — no team_id, unchanged. That is a live finding, not a stale one.
//
// AND THE PASSING HALF IS WEAKER THAN THE GREEN SUGGESTS — flagged loudly
// because it is the failure mode this audit exists to catch, not a nitpick.
// These two checks are written as ALTERNATIVES: the failing one's own message
// says "Either add the team scope here ... or constrain project_key on the
// write side". A reader seeing one green and one red will reasonably conclude
// "they took the other route, the hole is closed". That conclusion is only
// safe if the write side is a real boundary, and here it is narrower than that:
//
//   037 adds ONLY two RLS policies. Verified across every migration on
//   agent-sec: there is no constraint, no trigger, and no reference from
//   project_access.project_key to public.projects anywhere on that branch.
//
// An RLS policy validates WRITES BY PRINCIPALS SUBJECT TO RLS. It is not a
// constraint, so it says nothing about rows already in the table: any
// mis-scoped project_access row written before 037 survives it untouched, and
// can_see_project still honours that row. Nothing on that branch backfills or
// validates the existing set.
//
// Credit where due, so this is not read as broader than it is: agent-sec ALSO
// moved the ops panel off service_role onto two least-privilege roles
// (047_ops_panel_roles.sql, with no SUPABASE_SERVICE_KEY fallback), and none of
// the functions granted to those roles touch project_access. So the "an
// RLS-bypassing principal writes a bad row" path is materially narrower than it
// was. The pre-existing-rows gap is the one that does not depend on any of that.
//
// TIGHTENED, 2026-08-05, rather than left as written. The old acceptance
// criterion was "both policies mention project_key", which a policy could
// satisfy cosmetically — `and project_access.project_key is not null` names the
// column and correlates nothing. Shipping a check that accepts a cosmetic fix
// is the exact class this branch has spent the day closing, so it is now two
// checks that separate the two halves of the property:
//
//   WRITE SIDE, FUTURE ROWS — the policies must actually CORRELATE project_key
//   to the row's own team by reaching public.projects and tying BOTH columns,
//   not merely mention the column.
//
//   WRITE SIDE, ROWS ALREADY IN THE TABLE — an RLS policy is not a constraint.
//   It validates writes by principals subject to RLS and says nothing about
//   what is already stored, so the finding is not closed until something
//   addresses the existing set: a validating constraint/FK, or a sweep written
//   down where an operator applying the migration will actually run it.
//
// Both now pass against agent-sec, which earns them: 037's policies correlate
// through `exists (select 1 from public.projects p where p.id::text =
// project_access.project_key and p.team_id = project_access.team_id)`, and its
// header carries a SELECT-then-DELETE sweep under "THE SWEEP — NOT RUN BY THIS
// MIGRATION, ON PURPOSE" that states plainly that the hole stays open for
// existing rows until they are removed. Verified by execution, and verified to
// REJECT a decoy policy that names project_key without correlating it.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', '..', 'supabase', 'migrations');

// Migration files in applied order; the numeric prefix makes a plain sort the
// order they run in, so the LAST definition of a `create or replace` object is
// the one that is current.
const migrationFiles = () => fs.readdirSync(MIGRATIONS)
  .filter(f => /^\d+_.*\.sql$/.test(f))
  .sort();

// Every migration's SQL with line comments stripped: each file quotes other
// migrations' statements in its header, and those quotes must never be mistaken
// for definitions.
function codeOf(file) {
  return fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')
    .split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
}

// The body of the newest `create or replace function public.<name>`.
function newestFunctionBody(name) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i');
  let found = null;
  for (const f of migrationFiles()) {
    const code = codeOf(f);
    const m = re.exec(code);
    if (!m) continue;
    const body = /\$\$([\s\S]*?)\$\$/.exec(code.slice(m.index));
    if (body) found = { file: f, body: body[1] };
  }
  return found;
}

// The newest `create policy <name> on public.<table>` statement, whole.
function newestPolicy(table, name) {
  const re = new RegExp(`create\\s+policy\\s+${name}\\s+on\\s+public\\.${table}\\b`, 'i');
  let found = null;
  for (const f of migrationFiles()) {
    const code = codeOf(f);
    const m = re.exec(code);
    if (!m) continue;
    const rest = code.slice(m.index);
    const end = rest.indexOf(';');
    found = { file: f, sql: end === -1 ? rest : rest.slice(0, end) };
  }
  return found;
}

// Does anything in supabase/migrations tie project_access.project_key to a
// project belonging to project_access.team_id? A foreign key, a check
// constraint, or a trigger on the table would all do it.
// Does this policy's SQL actually TIE project_key to the row's own team, or
// does it merely mention the column?
//
// The distinction is the whole point of the tightening. `and
// project_access.project_key is not null` mentions it and constrains nothing;
// the real shape reaches public.projects and correlates BOTH columns — the
// project named must be the one the writing team owns. Anything that reaches
// the projects table but ties only one of the two is still a hole: tying the
// project alone permits any team to name it, tying the team alone permits any
// project under that team.
//
// Alias-driven rather than hardcoding `p`, so a rename does not silently turn
// this into a check that passes on everything.
function policyCorrelatesProjectToTeam(sql) {
  const flat = String(sql).replace(/\s+/g, ' ');
  const sub = /exists\s*\(\s*select\b[^)]*?\bfrom\s+public\.projects\s+(\w+)/i.exec(flat);
  if (!sub) return false;
  const a = sub[1];
  const tiesProject = new RegExp(`\\b${a}\\.id(?:::text)?\\s*=\\s*[\\w.]*\\bproject_key\\b`, 'i').test(flat)
    || new RegExp(`\\bproject_key\\s*=\\s*\\b${a}\\.id\\b`, 'i').test(flat);
  const tiesTeam = new RegExp(`\\b${a}\\.team_id\\s*=\\s*[\\w.]*\\bteam_id\\b`, 'i').test(flat)
    || new RegExp(`\\bteam_id\\s*=\\s*\\b${a}\\.team_id\\b`, 'i').test(flat);
  return tiesProject && tiesTeam;
}

// What, if anything, addresses rows ALREADY in project_access?
//
// A constraint or FK validates the existing set when it is added. A policy does
// not. Where the remedy is a manual sweep instead, it only counts if it is
// written down in the migration an operator is applying — a sweep nobody can
// find is not a remedy — and it has to say the SELECT comes first, or it is an
// invitation to delete rows nobody has looked at.
function existingRowsAddressed() {
  const constrained = projectKeyIsConstrained();
  if (constrained.length) return `a constraint validates the stored set (${constrained.join('; ')})`;
  for (const f of migrationFiles()) {
    // The RAW file, comments included: the sweep is deliberately NOT executable
    // SQL, so codeOf() — which strips comments — cannot see it by design.
    const raw = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    if (!/project_access/i.test(raw)) continue;
    const hasSelect = /select[\s\S]{0,600}?from\s+public\.project_access[\s\S]{0,600}?not\s+exists/i.test(raw);
    const hasDelete = /delete\s+from\s+public\.project_access/i.test(raw);
    const namesTheGap = /future writes|already in the table|existing rows/i.test(raw);
    const selectFirst = /run the select first|read (what it returns|them before deleting)|once that list has been read/i.test(raw);
    if (hasSelect && hasDelete && namesTheGap && selectFirst) {
      return `${f} documents a SELECT-first sweep and names the existing-rows gap`;
    }
  }
  return null;
}

function projectKeyIsConstrained() {
  const reasons = [];
  for (const f of migrationFiles()) {
    const code = codeOf(f);
    if (/alter\s+table\s+public\.project_access[\s\S]{0,400}?(add\s+constraint|check\s*\()/i.test(code)) {
      reasons.push(`${f}: a constraint is added to project_access`);
    }
    if (/create\s+trigger\s+\w+[\s\S]{0,200}?on\s+public\.project_access\b/i.test(code)) {
      reasons.push(`${f}: a trigger guards project_access`);
    }
    // A project_key column declared with a reference to projects would close it
    // at creation time.
    if (/project_key\s+text[^,]*references\s+public\.projects/i.test(code)) {
      reasons.push(`${f}: project_key references public.projects`);
    }
  }
  return reasons;
}

function main() {
  // ---- 1. the read side ----
  check('can_see_project resolves a project_access row within the project\'s own team', () => {
    const fn = newestFunctionBody('can_see_project');
    assert.ok(fn, 'can_see_project must be defined in supabase/migrations');
    const from = /from\s+public\.project_access\s+(\w+)/i.exec(fn.body);
    assert.ok(from, `could not find the project_access subquery in ${fn.file}`);
    const alias = from[1];
    const after = fn.body.slice(from.index);
    const cols = [...new Set([...after.matchAll(new RegExp(`\\b${alias}\\.(\\w+)\\s*=`, 'g'))].map(m => m[1]))];
    assert.ok(cols.includes('team_id'),
      `can_see_project (${fn.file}) resolves the row on ${JSON.stringify(cols.sort())} and never on team_id, `
      + 'so a project_access row written under ANY team decides access to the project it names. '
      + 'Either add the team scope here (and update 034\'s index + schema-indexes.test.js to match), '
      + 'or constrain project_key on the write side — see the second check.');
  });

  // ---- 2. the write side ----
  check('a project_access write cannot name a project outside its own team', () => {
    const insert = newestPolicy('project_access', 'project_access_insert');
    const update = newestPolicy('project_access', 'project_access_update');
    assert.ok(insert && update, 'project_access must have insert and update policies in supabase/migrations');
    const constrained = projectKeyIsConstrained();
    // CORRELATES, not merely mentions. The old version of this check accepted
    // /project_key/ appearing anywhere in the policy, which `and project_key is
    // not null` satisfies while constraining nothing.
    const policyScopes = [insert, update].filter(p => policyCorrelatesProjectToTeam(p.sql));
    assert.ok(constrained.length || policyScopes.length === 2,
      'nothing ties project_access.project_key to project_access.team_id:\n'
      + `  ${insert.file} project_access_insert: ${insert.sql.replace(/\s+/g, ' ').trim()}\n`
      + `  ${update.file} project_access_update: ${update.sql.replace(/\s+/g, ' ').trim()}\n`
      + '  no constraint and no trigger found on public.project_access\n'
      + 'So a manager of any team may write a row naming any other team\'s project uuid, and '
      + 'can_see_project reads it. Fix by requiring `exists (select 1 from public.projects p '
      + 'where p.id = project_key::uuid and p.team_id = team_id)` in both policies, or by '
      + 'scoping can_see_project — see the first check.');
  });

  // ---- 3. the write side, for rows that are ALREADY THERE ----
  // Split out from the check above because it is a genuinely different claim
  // and the two fail for different reasons. An RLS policy governs writes by
  // principals subject to RLS; it is not a constraint and does not look at what
  // is already stored. So correlating policies close the hole going forward and
  // leave every row written before them exactly as it was — still resolved by
  // can_see_project, which does not scope on team.
  //
  // Without this, the suite would report the finding closed as soon as the
  // policies landed, which is the reading this whole audit exists to prevent:
  // one green check licensing "the hole is closed" when only half of it is.
  check('rows already in project_access are addressed, not just future writes', () => {
    const how = existingRowsAddressed();
    assert.ok(how,
      'nothing addresses project_access rows that predate the write-side fix.\n'
      + 'An RLS policy validates WRITES; it is not a constraint and never examines '
      + 'the stored set. Any mis-scoped row written before the policy landed still '
      + 'sits in the table, and can_see_project still resolves it on '
      + '(project_key, member_id) with no team scope — so for those rows the '
      + 'vulnerability is live and nothing here will ever go red about it.\n'
      + 'Close it with a validating constraint or FK on project_access.project_key, '
      + 'or document a sweep in the migration that adds the policy: a SELECT of the '
      + 'mismatched rows, an instruction to READ the result before deleting, and the '
      + 'matching DELETE. A sweep that exists only in someone\'s head is not a remedy.');
  });

  // ---- 3. the constraint that DOES exist, pinned so its scope is not overread ----
  // 024's header argues project_access "can only ever name an actual member of
  // that same team, not an arbitrary uuid". True of member_id, and easy to read
  // as covering the whole row. Pinned here so the next reader can see exactly
  // which column the FK protects and which one it does not.
  check('the composite FK constrains member_id only — not project_key', () => {
    const code = codeOf('024_project_access_and_audit.sql');
    const fk = /foreign\s+key\s*\(([^)]*)\)\s*references\s+public\.team_members/i.exec(code);
    assert.ok(fk, '024 must declare the composite FK against team_members');
    const cols = fk[1].split(',').map(s => s.trim());
    assert.deepStrictEqual(cols, ['team_id', 'member_id'],
      `the composite FK covers ${JSON.stringify(cols)}; this check exists to keep its scope visible`);
  });

  h.finish();
}

main();
