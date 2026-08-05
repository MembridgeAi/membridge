'use strict';
// Schema-shape checks over supabase/ — specifically, that the hot predicates in
// RLS-critical functions are actually indexable.
//
// WHY A SUITE THAT READS SQL AT ALL. Nothing in this repo could execute Postgres
// when this was written, and nothing here pretends to: these checks do not
// measure a query plan, they assert the STRUCTURAL PRECONDITION for a good one —
// that the columns a predicate filters on are the leading columns of some
// declared index. That is a real, checkable invariant, and it is the one that
// silently broke: project_access's primary key is (team_id, project_key,
// member_id) while can_see_project filters on (project_key, member_id), so no
// index could serve the lookup and every call scanned the table.
//
// The pairing is what makes this worth a test rather than a comment. The function
// and the index live in different migrations and neither mentions the other, so
// a later edit to either one can break the pairing with nothing to notice. Both
// halves are pinned below.
//
// WHAT THESE CANNOT PROVE: that the planner actually chooses the index, what it
// costs, or that the index exists in the LIVE database — supabase/migrations is a
// claim about production, not a description of it (see 031's header on the
// migration-tracking table holding only two rows). 034's header carries the
// EXPLAIN commands that settle those.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SUPABASE = path.join(__dirname, '..', '..', 'supabase');
const MIGRATIONS = path.join(SUPABASE, 'migrations');

// Migration files in applied order. Numeric prefix, so a plain sort is the
// order they are meant to run in — and the LAST definition of a `create or
// replace` object is the one that is current.
const migrationFiles = () => fs.readdirSync(MIGRATIONS)
  .filter(f => /^\d+_.*\.sql$/.test(f))
  .sort();

// The body of the newest `create or replace function public.<name>`, or null.
// Deliberately takes the newest rather than the first match: can_see_project is
// defined in 025 and redefined in 028, and asserting against 025's body would
// pin a predicate that no longer runs.
function newestFunctionBody(name) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i');
  let found = null;
  for (const f of migrationFiles()) {
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    // Strip line comments first: every migration here quotes other migrations'
    // SQL in its header, and those quotes must not be mistaken for definitions.
    const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    const m = re.exec(code);
    if (!m) continue;
    // From the match to the end of the dollar-quoted body.
    const rest = code.slice(m.index);
    const body = /\$\$([\s\S]*?)\$\$/.exec(rest);
    if (body) found = { file: f, body: body[1] };
  }
  return found;
}

// Every `create index ... on public.<table> (a, b) [include (c)]` declared
// anywhere in supabase/migrations, as { file, cols, include }.
function declaredIndexes(table) {
  const out = [];
  const re = new RegExp(
    `create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?` +
    `(\\w+)\\s+on\\s+public\\.${table}\\s*\\(([^)]*)\\)\\s*(?:include\\s*\\(([^)]*)\\))?`, 'gi');
  for (const f of migrationFiles()) {
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    let m;
    while ((m = re.exec(code)) !== null) {
      out.push({
        file: f,
        name: m[1],
        cols: m[2].split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean),
        include: (m[3] || '').split(',').map(s => s.trim()).filter(Boolean),
      });
    }
  }
  return out;
}

async function main() {
  // The two halves of the pairing 034 exists to create. Kept as one check on
  // purpose: they are only meaningful together, and a failure should print both
  // sides so the reader can see which one moved.
  check('can_see_project filters project_access on exactly the columns 034 indexes', () => {
    const fn = newestFunctionBody('can_see_project');
    assert.ok(fn, 'can_see_project must be defined in supabase/migrations');
    // The predicate is `where a.project_key = ... and a.member_id = ...` against
    // the project_access subquery. Pull the compared columns off the alias.
    //
    // Scans from the FROM clause to the end of the body rather than trying to
    // find the subquery's closing paren: `auth.uid()` carries parens of its own,
    // so a naive lazy match to the first `)` stops mid-predicate and silently
    // misses any conjunct added after it — which is exactly the change this
    // check exists to catch. The alias is scoped to this subquery (the rest of
    // coalesce uses `p` for public.projects), so a wider scan cannot pick up
    // another table's columns; and if some future edit did reuse the alias, the
    // failure would be a false POSITIVE, which is the safe direction here.
    const from = /from\s+public\.project_access\s+(\w+)/i.exec(fn.body);
    assert.ok(from, `could not find the project_access subquery in ${fn.file}`);
    const alias = from[1];
    const after = fn.body.slice(from.index);
    const cols = [...after.matchAll(new RegExp(`\\b${alias}\\.(\\w+)\\s*=`, 'g'))].map(m => m[1]);
    const predicate = [...new Set(cols)].sort();
    assert.deepStrictEqual(predicate, ['member_id', 'project_key'],
      `can_see_project (${fn.file}) filters project_access on ${JSON.stringify(predicate)}. `
      + 'If that is deliberate, supabase/migrations needs an index whose LEADING columns are '
      + 'those, and 034_project_access_lookup_index.sql needs updating to match — otherwise '
      + 'this predicate scans the whole table once per row of every gated read.');

    const indexes = declaredIndexes('project_access');
    assert.ok(indexes.length, 'project_access has no declared index; 034 should declare one');
    const serving = indexes.filter(ix =>
      [...ix.cols].slice(0, predicate.length).sort().join(',') === predicate.join(','));
    assert.ok(serving.length,
      `no index on project_access leads with ${JSON.stringify(predicate)} — declared: `
      + JSON.stringify(indexes.map(ix => `${ix.name}(${ix.cols.join(',')})`))
      + '. A btree is only usable from its leading column inwards, so an index that does not '
      + 'START with these columns cannot serve can_see_project.');
    // can_see is the only value the function reads, so carrying it in the leaf
    // makes the lookup index-only. Not required for correctness — asserted
    // because dropping it silently reintroduces a heap fetch per row.
    const covering = serving.filter(ix => ix.include.includes('can_see') || ix.cols.includes('can_see'));
    assert.ok(covering.length,
      `${serving.map(ix => ix.name).join(', ')} leads with the right columns but does not carry `
      + 'can_see, so every lookup still needs a heap fetch. Add `include (can_see)`.');
  });

  check('the project_access primary key cannot serve can_see_project — which is why 034 exists', () => {
    // The trap this guards: someone reads "(team_id, project_key, member_id) is
    // already indexed as the PK" and drops 034 as redundant. It is not
    // redundant, because team_id leads and can_see_project never filters on it.
    // Pinning the PK's column ORDER makes that argument checkable rather than
    // something to be re-litigated from memory.
    const src = fs.readFileSync(path.join(MIGRATIONS, '024_project_access_and_audit.sql'), 'utf8');
    const pk = /primary\s+key\s*\(([^)]*)\)/i.exec(src);
    assert.ok(pk, 'could not read project_access primary key from 024');
    const cols = pk[1].split(',').map(s => s.trim());
    assert.deepStrictEqual(cols, ['team_id', 'project_key', 'member_id'],
      'the project_access primary key changed; re-derive whether 034 is still needed');
    assert.strictEqual(cols[0], 'team_id',
      'the PK leads with team_id, which can_see_project never filters on, so the PK index '
      + 'cannot serve that lookup — this is the whole reason 034 adds a separate index');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
