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

// Does can_see_project resolve the project_access row within the project's own
// team? Reports the columns it DOES resolve on, so a failure can name them.
function readSideTeamScope() {
  const fn = newestFunctionBody('can_see_project');
  if (!fn) return { ok: false, cols: [], file: null };
  const from = /from\s+public\.project_access\s+(\w+)/i.exec(fn.body);
  if (!from) return { ok: false, cols: [], file: fn.file };
  const alias = from[1];
  const after = fn.body.slice(from.index);
  const cols = [...new Set([...after.matchAll(new RegExp(`\\b${alias}\\.(\\w+)\\s*=`, 'g'))].map(m => m[1]))];
  return { ok: cols.includes('team_id'), cols: cols.sort(), file: fn.file };
}

// Does the WRITE side refuse a row whose project_key names a project outside
// project_access.team_id? Either a schema-level guard (FK, check constraint or
// trigger), or both write policies correlating the named project with the row's
// own team. Naming project_key alone does NOT count: a policy only ties the two
// together if it reaches public.projects AND correlates on team_id.
function writeSideTeamScope() {
  const insert = newestPolicy('project_access', 'project_access_insert');
  const update = newestPolicy('project_access', 'project_access_update');
  const guards = projectKeyIsConstrained();
  if (guards.length) return { ok: true, via: guards.join('; '), insert, update };
  const ties = p => !!p && /project_key/i.test(p.sql)
    && /public\.projects/i.test(p.sql)
    && /team_id/i.test(p.sql);
  const ok = ties(insert) && ties(update);
  return { ok, via: ok ? `${insert.file}: insert+update policies` : null, insert, update };
}

function main() {
  // ---- 1. the invariant, satisfied by EITHER implementation ----
  //
  // AMENDED (SEC-1). This check used to require the READ-side scope
  // specifically — `cols.includes('team_id')` on can_see_project — while this
  // suite's own header says it "asserts the invariant rather than one
  // implementation of it" and both assertion messages are written as
  // "either… or…". The structure contradicted both: check 1 demanded the read
  // fix and check 2 demanded the write fix, as independent checks that had to
  // BOTH hold, so no single fix could ever turn the suite green.
  //
  // A suite cannot be implementation-agnostic and simultaneously require two
  // specific implementations. This is the repair, not a weakening: nothing is
  // deleted and nothing that was unsafe becomes safe. The invariant is
  // unchanged — a project_access row must not settle access for a project
  // outside its own team — and it now fails exactly when NEITHER side closes
  // the hole, which is the state the auditor found and which this still fails
  // against. (Check 2 below is left verbatim as the auditor wrote it; it pins
  // the write-side route, which is the route taken in 037.)
  check('a project_access row cannot settle access for a project outside its own team', () => {
    const read = readSideTeamScope();
    const write = writeSideTeamScope();
    assert.ok(read.ok || write.ok,
      'nothing stops a project_access row written under one team from settling access to '
      + 'another team\'s project. NEITHER side closes it:\n'
      + `  READ   can_see_project (${read.file || 'not found'}) resolves the row on `
      + `${JSON.stringify(read.cols)} — never on team_id.\n`
      + `  WRITE  ${write.insert ? write.insert.file : '?'} project_access_insert/update do not `
      + 'correlate project_key with the row\'s own team, and no constraint or trigger does either.\n'
      + 'Close EITHER side: scope can_see_project by team_id (and update 034\'s index + '
      + 'schema-indexes.test.js to match), or require `exists (select 1 from public.projects p '
      + 'where p.id::text = project_access.project_key and p.team_id = project_access.team_id)` '
      + 'in both write policies.');
  });

  // ---- 2. the write side ----
  check('a project_access write cannot name a project outside its own team', () => {
    const insert = newestPolicy('project_access', 'project_access_insert');
    const update = newestPolicy('project_access', 'project_access_update');
    assert.ok(insert && update, 'project_access must have insert and update policies in supabase/migrations');
    const constrained = projectKeyIsConstrained();
    const policyScopes = [insert, update].filter(p => /project_key/i.test(p.sql));
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
