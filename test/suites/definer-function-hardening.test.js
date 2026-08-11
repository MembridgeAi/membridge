'use strict';
// SEC-5 — the security definer surface.
//
// A `security definer` function runs with the DEFINER's rights and bypasses row
// level security entirely. That is the correct tool in this schema — 030 exists
// precisely because a membership check evaluated as the CALLER reads false for a
// member RLS is hiding — but it means every such function has to re-implement,
// inside its own body, the check RLS would otherwise have made. 025 §4 states
// the trap for team_feed: "security definer, so RLS does NOT apply to it
// automatically — the predicate must be written into the function body itself,
// or a revoked member keeps reading the project's feed forever through this one
// function".
//
// Two invariants, both checked as CLASSES over supabase/migrations rather than
// as a list of known-bad functions, so the next one added cannot be quietly
// wrong.
//
//   A. EVERY definer function pins `set search_path`. Without it the function
//      resolves unqualified names through the caller's search_path, so anyone
//      who can create objects in a schema on that path can shadow a table or
//      operator the body relies on and have it run with definer rights. This
//      passes today for all 37 and is here as a regression guard — it is the
//      easiest of these to omit, because nothing breaks until it is exploited.
//
//   B. EVERY definer function is explicitly REVOKEd from public and anon.
//      This is the one that fails today. PostgreSQL grants EXECUTE on a NEWLY
//      CREATED function to PUBLIC by default — 011:140 says so in as many
//      words — so a definer function with no revoke is callable by the anon
//      key, which is public by design. Whether that is exploitable depends
//      entirely on the function's internal check, which is exactly the
//      single-layer position this whole file exists to avoid.
//
// And one specific finding, check C: is_team_member_uid answers about ANY
// (team, user) pair for any authenticated caller.
//
// STANCE. Structural over supabase/migrations, like schema-indexes.test.js and
// project-access-team-scope.test.js. Nothing here executes Postgres. These
// assert the invariant is DECLARED. The repo is also not proof of what is live
// — that gap is SEC-2's finding and is not re-litigated here.
//
// BOUNDARY. This suite is about FUNCTIONS. Which live TABLES lack RLS is the
// auditor's sweep, not this one; where a finding touches a table's policies it
// is cross-referenced rather than duplicated.
//
// Run directly, or via `node test/run.js definer-function-hardening`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const SCHEMA = path.join(__dirname, '..', '..', 'supabase', 'schema.sql');

const strip = raw => raw.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

// schema.sql first, then migrations in numeric order — the order they are
// applied, so the LAST definition of a function is the current one.
function sources() {
  const out = [{ file: 'schema.sql', code: strip(fs.readFileSync(SCHEMA, 'utf8')) }];
  for (const f of fs.readdirSync(MIGRATIONS).filter(x => /^\d+_.*\.sql$/.test(x)).sort()) {
    out.push({ file: f, code: strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')) });
  }
  return out;
}

// Newest definition of every function, with the header (everything between the
// name and the opening $$, which is where the modifiers live) and the body.
function newestFunctions() {
  const byName = new Map();
  for (const { file, code } of sources()) {
    const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi;
    let m;
    while ((m = re.exec(code)) !== null) {
      const after = code.slice(m.index);
      const body = /\$\$([\s\S]*?)\$\$/.exec(after);
      byName.set(m[1], {
        name: m[1],
        file,
        head: after.slice(0, body ? body.index : 400),
        body: body ? body[1] : '',
      });
    }
  }
  return [...byName.values()];
}

const definerFunctions = () => newestFunctions().filter(f => /security\s+definer/i.test(f.head));

// Every grant/revoke of EXECUTE on a public function, in applied order.
function executeGrants() {
  const out = [];
  const re = /(grant|revoke)\s+(?:all|execute)[\s\S]{0,80}?on\s+function\s+public\.(\w+)\s*\(([^)]*)\)\s*(?:to|from)\s+([^;]+);/gi;
  for (const { file, code } of sources()) {
    let m;
    while ((m = re.exec(code)) !== null) {
      out.push({ file, kind: m[1].toLowerCase(), fn: m[2], roles: m[4].replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

// Functions that are invoked by the SYSTEM rather than called by a client, and
// are therefore exempt from check B. Each entry states why, and the exemption is
// deliberately narrow: it does not excuse a missing search_path (check A still
// covers them) and it does not excuse a missing internal check.
//
// Both are TRIGGER functions. A trigger function called directly raises
// "trigger functions can only be called as triggers" before executing a single
// statement of its body, so the default PUBLIC grant confers nothing on a
// caller. Changing grants on a live trigger, by contrast, risks the flow the
// trigger serves — projects_materialize_access fires on every project insert —
// for no security gain. Documented and accepted rather than half-fixed.
const SYSTEM_INVOKED = new Set([
  'projects_materialize_access', // 032: BEFORE/AFTER INSERT trigger on public.projects
  'rls_auto_enable',             // 031: event trigger, fires on DDL, run by the owner
]);

function main() {
  // ---- A. search_path (green today — the counter-check) ------------------
  check('every security definer function pins its search_path', () => {
    const unpinned = definerFunctions()
      .filter(f => !/set\s+search_path/i.test(f.head))
      .map(f => `${f.name} (${f.file})`);
    assert.deepStrictEqual(unpinned, [],
      'a definer function without a pinned search_path resolves unqualified names through '
      + "the CALLER's search_path, so anyone able to create objects in a schema on that path "
      + 'can shadow a table or operator the body trusts and have it run with definer rights');
  });

  // ---- B. the default PUBLIC grant (RED today) ---------------------------
  check('every security definer function is revoked from public and anon', () => {
    const grants = executeGrants();
    const exposed = [];
    for (const f of definerFunctions()) {
      if (SYSTEM_INVOKED.has(f.name)) continue;
      const mine = grants.filter(g => g.fn === f.name);
      const revoked = mine.some(g => g.kind === 'revoke' && /\b(public|anon)\b/i.test(g.roles));
      if (!revoked) {
        exposed.push(`  ${f.name} (${f.file}) — `
          + (mine.length
            ? `grants exist but none revokes public/anon: ${mine.map(g => `${g.kind} ${g.roles}`).join(' | ')}`
            : 'no grant or revoke statement anywhere'));
      }
    }
    assert.deepStrictEqual(exposed, [],
      'PostgreSQL grants EXECUTE on a newly created function to PUBLIC by default (011:140 '
      + 'says exactly this), so each of these definer functions is callable with the anon key, '
      + 'which is public by design:\n' + exposed.join('\n')
      + '\n\nEach one may still be safe because of a check inside its body — that is the '
      + 'point: it reduces a two-layer defence to one, and the remaining layer is the one '
      + 'nobody re-reads. 010:409 revoked team_feed from public, anon for this reason; the '
      + 'sibling added seventeen migrations later did not inherit the habit.\n'
      + 'Fix with `revoke execute on function public.<fn>(<args>) from public, anon;` plus an '
      + 'explicit grant to the roles that genuinely need it.');
  });

  // ---- C. the caller-supplied identifier (RED today) ---------------------
  // The bug shape SEC-1 had at the policy layer, in its function-layer costume:
  // an argument naming a row, resolved without checking the caller is entitled
  // to an answer about that row.
  check('is_team_member_uid does not answer about a team the caller is not in', () => {
    const fn = definerFunctions().find(f => f.name === 'is_team_member_uid');
    assert.ok(fn, 'is_team_member_uid must be defined in supabase/migrations');
    // Presence of `auth.uid()` alone would be too weak — a body could mention
    // it without gating on it and satisfy a naive check. What is required is a
    // CORRELATION: the caller's own membership of p_team, either spelled out as
    // a subquery on team_members or delegated to is_team_member(p_team).
    const flat = fn.body.replace(/\s+/g, ' ');
    const correlated =
      /team_members[^;]{0,200}?team_id\s*=\s*p_team[^;]{0,200}?user_id\s*=\s*auth\.uid\(\)/i.test(flat)
      || /team_members[^;]{0,200}?user_id\s*=\s*auth\.uid\(\)[^;]{0,200}?team_id\s*=\s*p_team/i.test(flat)
      || /is_team_member\s*\(\s*p_team\s*\)/i.test(flat);
    assert.ok(correlated,
      `is_team_member_uid (${fn.file}) takes BOTH a team and a user as arguments and never `
      + 'mentions auth.uid(), so it answers "is user X in team Y" for any authenticated caller '
      + '— including one who has been removed from Y, about a team they can no longer read. '
      + '030:134-135 grants it to `authenticated` because a policy expression evaluates as the '
      + 'caller and so the caller needs EXECUTE; that grant is required and is not the bug. '
      + 'The bug is that the body trusts both arguments. Its only call site '
      + '(team_keys_insert, 030) already requires `public.is_team_member(team_id)` as a '
      + 'separate conjunct, so requiring the caller to be a member of p_team inside the body '
      + 'cannot break it — it is redundant there and load-bearing for a direct call.');
  });

  // ---- D. projects_materialize_access is not anon-callable --------------
  //
  // SEC-jamal-01 finding 3. This function is a TRIGGER function and is
  // therefore exempt from check B via SYSTEM_INVOKED — a direct call raises
  // "trigger functions can only be called as triggers" before any body
  // statement runs, so the default PUBLIC grant confers nothing on a caller
  // for data-safety purposes. That exemption stays, because unpacking it
  // would force every trigger function through the check-B revoke plumbing
  // and that has its own risks (042's header explains).
  //
  // But leaving the default PUBLIC grant intact still leaves an anon-callable
  // definer FINGERPRINT: a probe against the anon key gets a response from
  // this function, which is exactly the two-layer-defence-reduced-to-one
  // reduction check B exists to prevent. Closing the fingerprint requires a
  // revoke — no grant follows, because the trigger executor does not consult
  // a caller ACL.
  //
  // Structural check, like the rest of this suite. Newest revoke wins over
  // an older grant, and 054_sec_jamal_01.sql is that newest revoke — RED
  // before 054 lands as a file, GREEN after. This suite cannot verify what
  // is actually LIVE (that is SEC-2's finding) — only that the repo now
  // declares the closure.
  check('projects_materialize_access is revoked from public, anon and authenticated', () => {
    const grants = executeGrants().filter(g => g.fn === 'projects_materialize_access');
    // Walk in applied order; last statement per principal wins.
    const state = { public: null, anon: null, authenticated: null };
    for (const g of grants) {
      for (const p of Object.keys(state)) {
        if (new RegExp(`\\b${p}\\b`, 'i').test(g.roles)) state[p] = g.kind;
      }
    }
    const missing = Object.entries(state)
      .filter(([, kind]) => kind !== 'revoke')
      .map(([p, kind]) => `  ${p}: ${kind || 'no revoke or grant ever written'}`);
    assert.deepStrictEqual(missing, [],
      'projects_materialize_access is a trigger function, so a direct call cannot cross '
      + 'into its body — but the default PUBLIC grant still lets an anon probe RECEIVE '
      + 'a response, which is a fingerprint the audit named as a finding. Newest revoke '
      + 'over the following principals must be REVOKE, not GRANT (or absent):\n'
      + missing.join('\n')
      + '\n\nFix: `revoke execute on function public.projects_materialize_access() '
      + 'from public, anon, authenticated;` — no grant follows, the trigger executor '
      + 'does not consult a caller ACL. Reference: SEC-jamal-01, finding 3.');
  });

  // ---- counter-check (green today, must KEEP passing) -------------------
  // Hardening the grants must not revoke a function the product actually calls.
  // These four are reached by the daemon as an ordinary authenticated user, and
  // a fix that satisfied check B by revoking everything from `authenticated`
  // would break sign-in-adjacent flows while turning this suite green.
  check('the functions the daemon calls are still granted to authenticated', () => {
    const grants = executeGrants();
    const needed = ['team_feed', 'team_feed_counts', 'redeem_invite', 'my_teams'];
    const broken = [];
    for (const fn of needed) {
      const mine = grants.filter(g => g.fn === fn);
      const last = [...mine].reverse().find(g => /\bauthenticated\b/i.test(g.roles));
      if (!last || last.kind !== 'grant') {
        broken.push(`${fn}: ${last ? `last statement is a ${last.kind}` : 'never granted to authenticated'}`);
      }
    }
    assert.deepStrictEqual(broken, [],
      'these are called by the daemon as an authenticated user and must keep EXECUTE:\n  '
      + broken.join('\n  '));
  });

  h.finish();
}

main();
