'use strict';
// SEC-7 — Supabase's default blanket grant, on the objects that rely on RLS
// alone to be safe.
//
// A new table in `public` starts with Supabase's default privileges: the full
// `arwdDxtm` set granted to `anon` and `authenticated`. RLS is what stands
// between that grant and the data. For a table with policies, that is the
// design. For a table with RLS enabled and ZERO policies, the entire protection
// is one property — "RLS on, no policy, therefore deny" — and the grant
// underneath it is untouched.
//
// That single property is one statement away from gone, in two different ways
// that are both ordinary maintenance rather than sabotage:
//
//   * `alter table ... disable row level security`, and the blanket grant is
//     live again.
//   * one later `create policy ... for all using (true)` written loosely, and
//     the grant decides what it means.
//
// 031's event trigger does not help with either: it fires on CREATE only, so it
// says nothing about a table that already exists having RLS turned back off.
//
// `010:153` already set the pattern for exactly this situation —
// `revoke all on table public.invite_attempts from public, anon, authenticated;`
// — with the reasoning written next to it: the table is reached only through
// SECURITY DEFINER functions running as the owner, whom RLS does not bind, so
// no client needs the grant at all. Three later tables in the same position
// never got the same treatment.
//
// The worst of the three is `onboarding_invites`: it holds UNREDEEMED invite
// tokens. A token dump readable with the public anon key is not a degraded
// experience, it is arbitrary team creation on someone else's invite.
//
// BOUNDARY. Which live tables have RLS on at all is the auditor's sweep and is
// not re-derived here; this suite is only about the GRANT sitting underneath,
// for tables this repo creates and never revokes. Structural over
// supabase/, like the sibling suites — it asserts the revoke is DECLARED.
//
// Run directly, or via `node test/run.js blanket-grants`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const SCHEMA = path.join(__dirname, '..', '..', 'supabase', 'schema.sql');

const strip = raw => raw.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');

function sources() {
  const out = [{ file: 'schema.sql', code: strip(fs.readFileSync(SCHEMA, 'utf8')) }];
  for (const f of fs.readdirSync(MIGRATIONS).filter(x => /^\d+_.*\.sql$/.test(x)).sort()) {
    out.push({ file: f, code: strip(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')) });
  }
  return out;
}

const allCode = () => sources().map(s => s.code).join('\n');

// Tables switched to RLS anywhere in supabase/, with where it happened.
function rlsTables() {
  const out = new Map();
  for (const { file, code } of sources()) {
    const re = /alter\s+table\s+public\.(\w+)\s+enable\s+row\s+level\s+security/gi;
    let m;
    while ((m = re.exec(code)) !== null) if (!out.has(m[1])) out.set(m[1], file);
  }
  return out;
}

// `(?:"[^"]+"|\w+)` because a policy name may be QUOTED, and two of them are:
// public.feedback's "anon can submit feedback" (015) and public.waitlist's
// (018). Matching only bare identifiers reported both tables as having zero
// policies, which would have argued for revoking anon's grant on the two tables
// whose whole purpose is an anonymous INSERT — breaking the public feedback
// form and the waitlist signup in the name of hardening them.
const hasPolicy = t => new RegExp(
  `create\\s+policy\\s+(?:"[^"]+"|\\w+)\\s+on\\s+public\\.${t}\\b`, 'i',
).test(allCode());
const isRevoked = t => new RegExp(
  `revoke\\s+(?:all|[\\w, ]+)\\s+on\\s+table\\s+public\\.${t}\\s+from\\s+[^;]*\\b(?:public|anon|authenticated)\\b`, 'i',
).test(allCode());

function main() {
  // ---- the class (RED today) --------------------------------------------
  check('a table protected by RLS alone is also revoked from anon and authenticated', () => {
    const exposed = [];
    for (const [table, file] of rlsTables()) {
      if (hasPolicy(table)) continue;      // policies are the intended gate
      if (isRevoked(table)) continue;      // 010:153's pattern applied
      exposed.push(`  public.${table} (RLS enabled in ${file}, zero policies, never revoked)`);
    }
    assert.deepStrictEqual(exposed.sort(), [],
      'these tables have RLS on and NO policies, so "deny everything" is their only '
      + "protection — while Supabase's default grant of arwdDxtm to anon and authenticated "
      + 'is still sitting underneath it:\n' + exposed.sort().join('\n')
      + '\n\nOne `alter table ... disable row level security`, or one loose `for all using '
      + '(true)` added later, and that grant decides what happens. 031 does not cover either '
      + 'case — it fires on CREATE only.\n'
      + 'Fix with the pattern 010:153 already established:\n'
      + '  revoke all on table public.<t> from public, anon, authenticated;\n'
      + 'service_role is deliberately untouched: it bypasses RLS and is how the ops '
      + 'dashboard legitimately reaches these.');
  });

  // ---- the same platform default, on a table that DOES have policies -----
  //
  // SEC-12. The checks above are about tables whose only protection is
  // "RLS on, zero policies". public.memory_entries is not one of those — it has
  // policies, and they are the design. But it carries the same Supabase
  // PLATFORM DEFAULT grant, and for DELETE specifically that grant plus 035's
  // `memory_entries_delete using (author_id = auth.uid())` is everything a
  // DELETE needs. So
  //
  //     DELETE /rest/v1/memory_entries?author_id=eq.<self>
  //
  // with an ordinary user's token removes rows and writes NOTHING to
  // team_audit, bypassing the delete_my_entries RPC that exists to record it.
  //
  // Neither of those two facts is visible in this repo on its own: the grant is
  // a platform default that appears in no file, and 035 lives on another
  // branch. What CAN be asserted here is the fix — that supabase/ explicitly
  // revokes the privilege rather than leaving it to the platform.
  check('DELETE on memory_entries is revoked from ordinary clients', () => {
    assert.ok(isRevoked('memory_entries'),
      'public.memory_entries carries Supabase\'s default DELETE grant for anon and '
      + 'authenticated, and nothing in supabase/ revokes it. Combined with 035\'s delete '
      + 'policy, a signed-in user can DELETE their own rows straight through PostgREST and '
      + 'leave no team_audit row — the supported path (delete_my_entries) writes one in the '
      + 'same transaction. Fix with `revoke delete on table public.memory_entries from '
      + 'public, anon, authenticated;`. NOT with a trigger: memory_entries cascades from '
      + 'projects from teams, so a trigger inserting into team_audit during a team deletion '
      + 'would fail its FK against the team being deleted and abort the cascade.');
  });

  // ---- SEC-13: the ops audit trail says what it can back up --------------
  //
  // The actor on an ops write is SELF-REPORTED — `p_actor` is an argument, so
  // anyone holding the write credential composes it. That cannot be fixed at
  // the database layer (048 §1 works through all four routes and why each
  // fails), so the deliverable is that nothing in the repo claims otherwise.
  // Three places did, and the wrangler.toml one understated the key in the
  // paragraph written to explain its risk.
  //
  // These are documentation checks, which is unusual in a suite of structural
  // ones, and deliberate: when the conclusion of a security question is "accept
  // and document", the documentation IS the control, and an uncontrolled
  // control rots back to the comfortable wording within a release or two.
  check('nothing claims the ops audit actor is verified or non-forgeable', () => {
    const claims = [
      ['supabase/migrations/021_ops_panel.sql', /verified Access email, never client-supplied/],
      ['cloudflare/README.md', /audited\*{0,2} with the verified Access email/],
      ['cloudflare/ops-api/wrangler.toml', /used for exactly one RPC/],
    ];
    const offenders = [];
    for (const [rel, pattern] of claims) {
      const p = path.join(__dirname, '..', '..', rel);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      // The corrected texts QUOTE the old wording to explain why it was wrong.
      // A bare substring search would therefore flag the fix — and a rule that
      // punishes recording the mistake teaches people to delete the history
      // instead. So a hit only counts when the file does NOT also carry the
      // correction marker beside it.
      const corrected = /used to read|used to list|CORRECTION|self-reported/i.test(src);
      if (pattern.test(src) && !corrected) offenders.push(rel);
    }
    assert.deepStrictEqual(offenders, [],
      'these files state or imply that the ops audit actor is verified by the database. '
      + 'It is not: p_actor is an argument, so a holder of the write credential can pass any '
      + 'string. Say self-reported, and say what the trail DOES guarantee — that the event is '
      + 'real (ops_log is service_role-only), the time is the database\'s, and nothing can be '
      + `erased. offenders: ${offenders.join(', ')}`);
  });

  check('ops_log records the verified role alongside the asserted actor', () => {
    const newest = [...sources()].reverse()
      .find(s => /create\s+or\s+replace\s+function\s+public\.ops_log/i.test(s.code));
    assert.ok(newest, 'ops_log must be defined in supabase/migrations');
    assert.match(newest.code, /via_role/,
      `ops_log (${newest.file}) writes only the caller-supplied actor. The role claim in the `
      + 'request JWT is the one identity-adjacent value PostgREST VERIFIES rather than '
      + 'receives, and recording it is what distinguishes a write that arrived through the '
      + "panel's own credential from one that did not.");
    assert.match(newest.code, /request\.jwt\.claims/,
      'via_role must come from the verified JWT claims, not from another argument — an '
      + 'argument would be exactly as forgeable as the actor it sits beside');
  });

  // ---- counter-check (green today, must KEEP passing) -------------------
  // The precedent this whole ticket is built on. If this ever goes red, the
  // pattern above has been undone at its source and the class check is
  // measuring nothing.
  check('invite_attempts keeps the revoke 010:153 established', () => {
    assert.ok(isRevoked('invite_attempts'),
      'invite_attempts is the table 010:153 revoked, with the reasoning written beside it; '
      + 'it is the precedent every other revoke in this area cites');
  });

  // ---- the same question, one object class over --------------------------
  // Functions are covered by test/suites/definer-function-hardening.test.js
  // (EXECUTE on a security definer function is the grant that matters most).
  // Sequences carry default grants too. This repo creates none standalone —
  // every id is `generated always as identity`, whose sequence is owned by its
  // table and reachable only through INSERT on it — so this check is VACUOUS
  // TODAY and exists as a forward guard for the day someone adds one.
  check('any standalone sequence in public is revoked from anon and authenticated', () => {
    const code = allCode();
    const seqs = [...code.matchAll(/create\s+sequence\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)]
      .map(m => m[1]);
    const exposed = seqs.filter(s => !new RegExp(
      `revoke\\s+(?:all|[\\w, ]+)\\s+on\\s+sequence\\s+public\\.${s}\\s+from\\s+[^;]*\\b(?:public|anon|authenticated)\\b`, 'i',
    ).test(code));
    assert.deepStrictEqual(exposed, [],
      `standalone sequences carry the same default grant as tables: ${exposed.join(', ')}`);
  });

  h.finish();
}

main();
