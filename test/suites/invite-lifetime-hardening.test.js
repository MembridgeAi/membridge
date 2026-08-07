'use strict';
// Invite lifetime, redemption atomicity, and audit-trail integrity (INV-1..3).
//
// Three findings, and one general defect behind the third that is worth more
// than the individual fix.
//
//   INV-1  Every invite the app mints is unlimited-use and never-expiring.
//          The daemon route ALREADY accepts expiresDays/maxUses
//          (lib/server.js:2655-2661) — it is the UI client that drops them
//          (ui/src/data/LocalDaemonClient.ts createInviteLink posts only
//          { teamId }), and the route defaults both to null when absent. So
//          the capability exists and nothing reaches it.
//
//   INV-2  redeem_invite has a TOCTOU on max_uses (029:157-183): read without
//          FOR UPDATE, check use_count >= max_uses, insert the member, then
//          increment. Under READ COMMITTED two concurrent redeems of a
//          max_uses = 1 invite both pass the check. Same shape in
//          redeem_onboarding_invite (023:36-53), where it yields two teams
//          from one token.
//
//   INV-3  024:97-99 drops and recreates team_audit_insert with only
//          is_team_manager(team_id); 025:144 later added
//          `and actor_id = auth.uid()`. Every migration here is advertised
//          re-runnable and they are hand-pasted into the SQL editor, so
//          re-running 024 after 025 silently reopens actor forgery.
//
// THE GENERAL DEFECT, which check 7 pins as a class rather than as one file:
// a re-runnable migration that recreates an object a later migration tightened
// will ALWAYS regress it when re-run. team_audit_insert is one instance; the
// check looks for every instance, so the next one cannot be introduced quietly.
//
// STANCE. Checks 4-9 are STRUCTURAL over supabase/migrations — the same stance
// test/suites/project-access-team-scope.test.js and schema-indexes.test.js
// take. Nothing here executes Postgres, so they assert that the invariant is
// DECLARED, not that a live database enforces it. A TOCTOU in particular cannot
// be demonstrated without real concurrent transactions; what can be checked,
// and what actually decides the outcome, is whether the claim is written as an
// atomic conditional update or as read-then-check-then-write.
//
// Checks 3, 6 and 9 are counter-checks: they pass today and must KEEP passing.
// They exist so a fix cannot satisfy this suite by removing behaviour — by
// ignoring the caller's explicit lifetime, by ripping the revoked/expired
// guards out of the redeem path, or by making the audit trail mutable.
//
// Run directly, or via `node test/run.js invite-lifetime-hardening`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const MIGRATIONS = path.join(__dirname, '..', '..', 'supabase', 'migrations');

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

// EVERY `create policy <name> on public.<table>` in migration order, not just
// the newest — the whole point of check 7 is comparing them to each other.
function allPolicyDefs() {
  const out = [];
  const re = /create\s+policy\s+(\w+)\s+on\s+public\.(\w+)\b/gi;
  for (const f of migrationFiles()) {
    const code = codeOf(f);
    let m;
    while ((m = re.exec(code)) !== null) {
      const rest = code.slice(m.index);
      const end = rest.indexOf(';');
      // Is this create wrapped in a "only if it does not already exist" guard?
      // A guarded create cannot overwrite a newer, tighter definition, so it is
      // exempt from the regression rule below however weak its own predicate
      // is — it simply never runs on a database that already has the policy.
      const before = code.slice(Math.max(0, m.index - 600), m.index);
      const guarded = /not\s+exists/i.test(before) && /pg_policies/i.test(before);
      out.push({
        file: f, name: m[1], table: m[2], guarded,
        sql: end === -1 ? rest : rest.slice(0, end),
      });
    }
  }
  return out;
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

// The security-relevant FEATURES of a policy predicate, compared as sets rather
// than as text. Comparing text would produce false differences the moment a
// column is qualified (`team_id` vs `project_access.team_id`) without any
// change in meaning, which is exactly the kind of noise that gets a check
// disabled.
function policyFeatures(sql) {
  const fns = new Set([...sql.matchAll(/public\.(\w+)\s*\(/g)].map(m => m[1].toLowerCase()));
  const authCols = new Set([...sql.matchAll(/(\w+)\s*=\s*auth\.uid\(\)/g)].map(m => m[1].toLowerCase()));
  return {
    fns,
    authCols,
    hasExists: /exists\s*\(/i.test(sql),
    hasAuthUid: /auth\.uid\(\)/i.test(sql),
  };
}

// What `newest` requires that `older` does not provide.
function missingFeatures(newest, older) {
  const gaps = [];
  for (const fn of newest.fns) if (!older.fns.has(fn)) gaps.push(`public.${fn}(...)`);
  for (const c of newest.authCols) if (!older.authCols.has(c)) gaps.push(`${c} = auth.uid()`);
  if (newest.hasExists && !older.hasExists) gaps.push('an exists (...) subquery');
  if (newest.hasAuthUid && !older.hasAuthUid) gaps.push('any reference to auth.uid()');
  return gaps;
}

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(71), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(71)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  const port = P(72);
  let srv = null;

  async function api(method, pathname, body) {
    const url = `http://127.0.0.1:${port}${pathname}`;
    const res = method === 'GET' ? await fetch(url) : await post(url, body);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  try {
    util.ensureConfig();
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'inv-owner@test.dev', 'pw-o', 'Owner');
    const team = await teamsync.createTeam(util.getConfig(), 'InviteCo');

    srv = startServer(port, { retries: 0 });
    await waitForHttp(`http://127.0.0.1:${port}/api/status`);

    // -----------------------------------------------------------------------
    // INV-1. The invite the APP mints, through the route the app actually uses.
    // -----------------------------------------------------------------------
    // Behavioural, not structural: this goes through POST /api/team/invite with
    // the exact body ui/src/data/LocalDaemonClient.ts sends today — { teamId }
    // and nothing else — so it fails for the same reason the product does.
    await check('an invite minted with no explicit lifetime still expires', async () => {
      const r = await api('POST', '/api/team/invite', { teamId: team.team_id });
      assert.strictEqual(r.status, 200, `invite status ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body && r.body.expires_at,
        'the app posts only { teamId }, and the route nulls expires_at when it is absent '
        + '(lib/server.js:2655-2661), so every invite the UI mints never expires. '
        + `got expires_at = ${JSON.stringify(r.body && r.body.expires_at)}`);
      assert.ok(new Date(r.body.expires_at).getTime() > Date.now(),
        `the default expiry must be in the future, got ${r.body.expires_at}`);
    });

    await check('an invite minted with no explicit cap has a finite use cap', async () => {
      const r = await api('POST', '/api/team/invite', { teamId: team.team_id });
      assert.strictEqual(r.status, 200, `invite status ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body && Number.isFinite(r.body.max_uses),
        'same route, same omission: max_uses is nulled when absent, so a link that leaks '
        + `is redeemable by everyone who finds it, forever. got max_uses = ${JSON.stringify(r.body && r.body.max_uses)}`);
      assert.ok(r.body.max_uses > 0, `a cap of ${r.body.max_uses} would mint a dead invite`);
    });

    // COUNTER-CHECK (passes today, must keep passing). A default is only
    // acceptable if it is a DEFAULT: an explicit lifetime from the caller has
    // to survive untouched, or the fix has replaced one hardcoded policy with
    // another and the CLI's existing --expires/--max-uses arguments silently
    // stop meaning anything.
    await check('an explicit lifetime from the caller is honoured, not overridden', async () => {
      const r = await api('POST', '/api/team/invite',
        { teamId: team.team_id, expiresDays: 3, maxUses: 9 });
      assert.strictEqual(r.status, 200, `invite status ${r.status}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.max_uses, 9, `caller asked for max_uses 9, got ${r.body.max_uses}`);
      const days = (new Date(r.body.expires_at).getTime() - Date.now()) / 86400000;
      assert.ok(days > 2.9 && days < 3.1,
        `caller asked for 3 days, got ${days.toFixed(2)} (${r.body.expires_at})`);
    });

    // The UI half of INV-1. The route can default all it likes; if the client
    // cannot express a choice, the product still has no way to set either, and
    // the "unlimited" wording the Members page renders stays unfalsifiable.
    check('the UI client can express an invite lifetime at all', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'ui', 'src', 'data', 'LocalDaemonClient.ts'), 'utf8');
      const fn = /createInviteLink[\s\S]{0,600}?\n  }/.exec(src);
      assert.ok(fn, 'could not find createInviteLink in LocalDaemonClient.ts');
      assert.ok(/expiresDays|maxUses/.test(fn[0]),
        'createInviteLink posts only { teamId }, so no caller in the app can set an expiry '
        + `or a use cap whatever the daemon supports. body sent: ${fn[0].replace(/\s+/g, ' ').slice(0, 200)}`);
    });

    // -----------------------------------------------------------------------
    // INV-2. Redemption must CLAIM a use, not check-then-take it.
    // -----------------------------------------------------------------------
    check('redeem_invite claims a use atomically rather than checking then incrementing', () => {
      const fn = newestFunctionBody('redeem_invite');
      assert.ok(fn, 'redeem_invite must be defined in supabase/migrations');
      const claim = /update\s+public\.invites[\s\S]{0,400}?;/i.exec(fn.body);
      assert.ok(claim, `redeem_invite (${fn.file}) never updates public.invites at all`);
      // `(?:\w+\.)?` because the columns may legitimately be qualified
      // (`invites.use_count < invites.max_uses`) — inside a policy or a WHERE
      // that names the table, qualifying is the CORRECT spelling, not an
      // alternative one. Matching only the bare form would fail a proper fix.
      const guarded = /use_count\s*<\s*(?:\w+\.)?max_uses|max_uses\s*>\s*(?:\w+\.)?use_count/i.test(claim[0]);
      const locked = /for\s+update/i.test(fn.body);
      assert.ok(guarded || locked,
        `redeem_invite (${fn.file}) reads the invite without FOR UPDATE, checks `
        + '`use_count >= max_uses`, inserts the member and only then increments. Under READ '
        + 'COMMITTED two concurrent redeems of a max_uses = 1 invite both pass the check and '
        + 'both join. The cap must be claimed by a conditional update whose WHERE carries the '
        + 'cap (`update public.invites set use_count = use_count + 1 where token = ... and '
        + '(max_uses is null or use_count < max_uses)`), branching on the affected row count. '
        + `the update found was: ${claim[0].replace(/\s+/g, ' ').trim()}`);
    });

    check('redeem_onboarding_invite claims the token atomically', () => {
      const fn = newestFunctionBody('redeem_onboarding_invite');
      assert.ok(fn, 'redeem_onboarding_invite must be defined in supabase/migrations');
      const claim = /update\s+public\.onboarding_invites[\s\S]{0,400}?;/i.exec(fn.body);
      assert.ok(claim, 'redeem_onboarding_invite never updates public.onboarding_invites');
      const guarded = /redeemed_at\s+is\s+null/i.test(claim[0]);
      const locked = /for\s+update/i.test(fn.body);
      assert.ok(guarded || locked,
        `redeem_onboarding_invite (${fn.file}) checks redeemed_at, calls create_team, and only `
        + 'then stamps redeemed_at. Two concurrent redeems of one token therefore create TWO '
        + 'teams. The claim must carry `where token = ... and redeemed_at is null` and branch on '
        + `the affected row count. the update found was: ${claim[0].replace(/\s+/g, ' ').trim()}`);
    });

    // COUNTER-CHECK (passes today, must keep passing). Making the claim atomic
    // must not cost the cheap, clear rejections that come before it. A fix that
    // collapsed everything into one conditional update would lose the distinct
    // "revoked" and "expired" messages, which are the two a user is most likely
    // to actually see.
    check('redeem_invite still refuses revoked and expired invites explicitly', () => {
      const fn = newestFunctionBody('redeem_invite');
      assert.ok(/revoked_at/i.test(fn.body),
        `redeem_invite (${fn.file}) no longer mentions revoked_at`);
      assert.ok(/expires_at/i.test(fn.body),
        `redeem_invite (${fn.file}) no longer mentions expires_at`);
    });

    // -----------------------------------------------------------------------
    // INV-3. The class, not the instance.
    // -----------------------------------------------------------------------
    // Every migration in this repo is advertised re-runnable and they are
    // hand-pasted into the SQL editor. So any migration that recreates a policy
    // a LATER migration tightened is a loaded gun: re-running it silently
    // reverts the tightening, with no error and no diff.
    //
    // Compared as feature SETS, not as text — see policyFeatures. The rule is
    // one-directional on purpose: an older definition may not be MISSING
    // anything the newest one has. It is free to differ otherwise.
    check('no migration recreates a policy weaker than its own newest definition', () => {
      const defs = allPolicyDefs();
      const byKey = new Map();
      for (const d of defs) {
        const key = `${d.table}.${d.name}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(d);
      }
      const regressions = [];
      for (const [key, list] of byKey) {
        if (list.length < 2) continue;
        const newest = list[list.length - 1];
        const newestF = policyFeatures(newest.sql);
        for (const older of list.slice(0, -1)) {
          if (older.guarded) continue; // cannot clobber; see allPolicyDefs
          const gaps = missingFeatures(newestF, policyFeatures(older.sql));
          if (gaps.length) {
            regressions.push(`  ${key}: ${older.file} is missing ${gaps.join(', ')} `
              + `which ${newest.file} requires — re-running ${older.file} reverts it`);
          }
        }
      }
      assert.deepStrictEqual(regressions, [],
        'these migrations recreate a policy in a weaker form than the newest definition, so '
        + 're-running any of them silently un-hardens the live database:\n' + regressions.join('\n')
        + '\n\nTHE CONVENTION THAT PREVENTS THIS CLASS: a migration must never DROP a policy it '
        + 'did not introduce. Only the migration that is deliberately REPLACING a policy may '
        + 'drop-then-create it; every earlier file must create it guarded —\n'
        + "    do $$ begin\n"
        + "      if not exists (select 1 from pg_policies where schemaname='public'\n"
        + "                       and tablename='<t>' and policyname='<p>') then\n"
        + '        create policy <p> on public.<t> ...;\n'
        + '      end if;\n'
        + '    end $$;\n'
        + 'That stays re-runnable, is a no-op on a database that already has the tightened '
        + 'policy, and — unlike restating the terminal predicate in the older file — introduces '
        + 'no forward reference to functions that did not exist yet at that point in history '
        + '(012 predates can_see_project by thirteen migrations). Guarded creates are exempt '
        + 'from this check for exactly that reason.');
    });

    // ---- the same class, one object type over: FUNCTIONS (SEC-8) -----------
  //
  // 029 defines redeem_invite with the TOCTOU; 038 fixes it; re-running 029
  // reinstates it. Identical to the policy case above and worse in one respect:
  // a reverted policy opens a door, while this silently restores a concurrency
  // bug that only shows under load.
  //
  // WHY THE POLICY GUARD DOES NOT SIMPLY TRANSFER — the finding that scoped
  // this. Function supersession comes in two shapes here:
  //
  //   SIGNATURE-STABLE (9 functions). Pure `create or replace`, no drop. The
  //   guard works exactly as it does for policies: guard every older
  //   definition, leave the newest as create-or-replace, and a fresh replay
  //   still ends on the newest because create-or-replace always applies.
  //
  //   DROP-CARRYING (team_feed, my_teams). Their return type CHANGES between
  //   versions — team_feed goes from 10 columns to 21 — and create-or-replace
  //   cannot change a return type, so each superseding migration issues
  //   `drop function if exists` first. Guarding only the CREATE in those files
  //   would leave the DROP live: re-running 004 would drop the current 21-column
  //   team_feed and then, finding it absent, install the 11-column one. The
  //   guard would make that case actively worse rather than safer. They are
  //   also the loud half — a missing column breaks callers immediately, unlike
  //   redeem_invite reverting in silence.
  //
  // So the guard is right for one group and wrong for the other, which is why
  // this check tracks them separately instead of demanding one treatment.
  //
  // NEITHER GROUP IS CONVERTED YET, deliberately. Wrapping a function whose
  // body is `$$`-quoted inside a `do $guard$` block is three levels of dollar
  // quoting in files that are pasted into a SQL editor by hand, and there is no
  // Postgres in this environment to parse the result — no psql, no supabase
  // CLI, and the Docker daemon is not running. Shipping 15 hand-written
  // nested-quoted blocks that have never been parsed, into migrations whose
  // failure mode is "half the file ran", is a worse trade than the re-run it
  // prevents. Recorded here so the backlog is in code rather than only in a
  // report, and so a NEW instance still fails.
  const RERUN_UNGUARDED_FUNCTIONS = new Set([
    // signature-stable; guardable, conversion pending a environment that can
    // parse PL/pgSQL
    'join_team', 'link_project', 'gen_invite_token', 'peek_invite',
    'redeem_invite', 'ops_snapshot', 'redeem_onboarding_invite',
    'can_see_project', 'is_team_member_uid',
    // ops_log joined this group when 048 redefined it to record via_role. It
    // is signature-stable (returns void, same four arguments), so it is
    // guardable on the same terms as the rest — and it was caught by THIS
    // check rather than noticed, which is the check doing its job on its
    // author's own change.
    'ops_log',
    // drop-carrying; guarding the create alone would be a regression, see above
    'team_feed', 'my_teams',
    // Added by the SEC-14 integration dry run, and they are the reason that dry
    // run was worth doing: the removal lane's 044 and 045 redefine these, which
    // 002_team_v2.sql also defines. NEITHER LANE COULD SEE IT — this check lives
    // on agent-sec and those migrations live on agent-removal, so the collision
    // exists only in the merged tree and appeared nowhere in either lane's green.
    // Both are signature-stable (void / void, same arguments), so they belong to
    // the guardable group on the same terms as the rest.
    'remove_member', 'leave_team',
    // Added by the SEC-15 integration dry run, and the same cross-lane shape one
    // round on: 002_team_v2.sql defines team_members_list and the deletion
    // lane's 053 supersedes it, so the collision exists only in the merged tree.
    // 053 arrived after the round that closed this class for the functions
    // above, which is why it missed the convention rather than declined it.
    //
    // DROP-CARRYING, the second of the two shapes. 053 adds auth.users.deleted_at
    // to the return table — four columns to five — and create-or-replace cannot
    // change a return type, so 053 must `drop function if exists` first. That is
    // the condition this check names as disqualifying the guard.
    //
    // Recorded honestly, because it differs from team_feed/my_teams in one
    // respect and the difference should not be glossed: the drop lives only in
    // the NEWEST file here. 002 is a bare create-or-replace, so guarding 002
    // alone would not leave a drop live the way guarding 004 would for
    // team_feed, and would in principle be safe. It is still not converted, for
    // the reason that keeps all fifteen entries above unconverted: 002's body is
    // `$$`-quoted, wrapping it in `do $guard$` is nested dollar quoting written
    // by hand, and there is no Postgres in this environment to parse the result
    // before it is pasted into a SQL editor. Converting exactly one function
    // that way — in the oldest and most foundational file in the set, whose
    // failure mode is "half the file ran" — buys less than it risks.
    //
    // What protects the live database in the meantime is not this entry but
    // Postgres itself: re-running 002 against a database that already has 053
    // raises "cannot change return type of existing function", which is loud
    // and stops the file. The silent-revert hazard this check exists for does
    // not apply to a supersession that changes the return type; that is the
    // same fact that puts it in this group.
    'team_members_list',
  ]);

  check('no NEW function is superseded across migrations without a re-run guard', () => {
    const byName = new Map();
    for (const f of migrationFiles()) {
      const code = codeOf(f);
      const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi;
      let m;
      while ((m = re.exec(code)) !== null) {
        const before = code.slice(Math.max(0, m.index - 600), m.index);
        const guarded = /not\s+exists/i.test(before) && /pg_proc/i.test(before);
        if (!byName.has(m[1])) byName.set(m[1], []);
        byName.get(m[1]).push({ file: f, guarded });
      }
    }
    const unguarded = [];
    for (const [name, defs] of byName) {
      if (defs.length < 2) continue;
      if (RERUN_UNGUARDED_FUNCTIONS.has(name)) continue; // tracked above
      const older = defs.slice(0, -1).filter(d => !d.guarded);
      if (older.length) {
        unguarded.push(`  ${name}: ${older.map(d => d.file).join(', ')} `
          + `superseded by ${defs[defs.length - 1].file}, unguarded`);
      }
    }
    assert.deepStrictEqual(unguarded, [],
      'these functions are defined in more than one migration with no guard on the older '
      + 'definitions, so re-running an older file reverts the newer one:\n' + unguarded.join('\n')
      + '\n\nIf the function is SIGNATURE-STABLE, guard the older creates on '
      + '`not exists (select 1 from pg_proc ...)` and leave the newest as create-or-replace. '
      + 'If the supersession carries a `drop function` because the return type changed, do '
      + 'NOT guard only the create — the drop would still fire and the guard would then '
      + 'install the OLD body. Add it to RERUN_UNGUARDED_FUNCTIONS with a reason instead, '
      + 'and say which of the two shapes it is.');
  });

  check('team_audit rows cannot be backdated by whoever writes them', () => {
      const guarded = migrationFiles().some(f => {
        const code = codeOf(f);
        if (/create\s+trigger\s+\w+[\s\S]{0,300}?on\s+public\.team_audit\b/i.test(code)) return true;
        return /alter\s+table\s+public\.team_audit[\s\S]{0,300}?(add\s+constraint|check\s*\()/i.test(code);
      });
      assert.ok(guarded,
        'team_audit.created_at is `timestamptz not null default now()` (024:49) — a DEFAULT, '
        + 'not an enforcement. PostgREST lets the inserting client name the column, so a manager '
        + 'can file audit rows at any timestamp they choose, in an append-only table with no '
        + 'delete policy to correct them. Force it with a BEFORE INSERT trigger.');
    });

    // COUNTER-CHECK (passes today, must keep passing). Whatever is done about
    // backdating must not reach for an UPDATE or DELETE policy to "fix up" rows
    // — append-only is the property that makes the trail worth reading, and
    // 025:139-141 records it as deliberate.
    check('team_audit stays append-only — no update or delete policy', () => {
      const bad = allPolicyDefs().filter(d => d.table === 'team_audit'
        && /for\s+(update|delete)/i.test(d.sql));
      assert.deepStrictEqual(bad.map(d => `${d.file}:${d.name}`), [],
        'an update or delete policy on team_audit would make the audit trail rewritable, '
        + 'which is the property 025:139-141 deliberately preserved');
    });
  } finally {
    if (srv) await new Promise(r => srv.close(r));
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
