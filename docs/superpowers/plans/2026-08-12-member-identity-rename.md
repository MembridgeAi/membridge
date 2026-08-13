# Member Identity: Self-Rename and Pickable Avatars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person double-click their name in the rail footer to change their display name and pick an avatar, with names unique within every team they belong to.

**Architecture:** A partial unique index on `team_members` is the enforcement mechanism; a `set_display_name` RPC is the caller-facing surface and updates every team in one statement. A BEFORE INSERT trigger auto-suffixes colliding names at join time so onboarding never dead-ends. In the UI, an `AvatarRegistry` context lets the existing `Avatar` component resolve its own mark by member id, so none of its 14 call sites change.

**Tech Stack:** PostgreSQL 17 / Supabase (PostgREST RPC), Node daemon (`lib/teamsync.js`, `lib/server.js`), React + TanStack Query + Vite (`ui/`), tests via `node test/run.js <suite>` and vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-member-identity-rename-design.md`

## Global Constraints

- Work on branch `feat/member-identity-rename`. Never commit to `master`, never push, never merge (`.claude/rules/agent-team.md`).
- Verify only what you touched. Never run `node test/run.js` with no arguments; never run `cd ui && npx vitest run` with no file argument. Both are hook-blocked.
- A failing test is not a bug until `node scripts/verify-finding.js` returns CONFIRMED (exit 0). Exit 3 = PHANTOM, drop it. Exit 4 = FLAKY, escalate to a human.
- New daemon tests go in `test/suites/`, requiring `../harness` FIRST and ending with `h.finish()`.
- Display names are 1–80 characters. Names compare case-insensitively with leading, trailing and repeated internal whitespace collapsed.
- Avatar keys match `^[a-z0-9-]{1,32}$`. Null is a real value meaning "use my initial", never a synonym for "unchanged".
- New `security definer` functions pin `set search_path`, are revoked from `public, anon`, and granted to `authenticated` (`supabase/migrations/042_definer_function_hardening.sql`).
- The collision SQLSTATE is `MB001`. The validation SQLSTATE is `MB002`. The daemon maps codes, never message text.
- `util.homeDir()` returns `~/.membridge`, not the user's home directory.

---

## Deviation from the spec — read before Task 1

The spec says to rewrite the four RPCs that insert `display_name` (`create_team`, `join_team`, `redeem_invite`, `redeem_onboarding_invite`) so each auto-suffixes. This plan uses **a BEFORE INSERT trigger on `team_members` instead**, for three reasons:

1. It is one object rather than four hand-copied function bodies, each of which would have to be reproduced verbatim from whichever migration last defined it. Mis-copying one is a silent regression in an unrelated feature.
2. It covers insert paths that do not exist yet.
3. `unique_member_name` must be `security definer` regardless, because at join time the caller is **not yet a member** and RLS would hide every existing row from them — making the uniqueness probe answer "free" every time. The trigger makes that one definer function the only place that needs the privilege.

**Residual risk this accepts:** two people joining the same team with the same name in the same instant. The trigger computes `marco 2` for both and the index rejects the loser with a `unique_violation`, which surfaces as a join error rather than a bump to `marco 3`. Retrying the join succeeds. The spec's retry loops would have closed this; a trigger cannot retry its own row.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/057_member_identity.sql` | Create: normalization function, two columns, suffix helper, trigger, legacy-dup release, unique index, `set_display_name` |
| `lib/teamsync.js` | Modify: `rest()` carries PostgREST `code`; `sessionToCredentials` preserves `avatar`; new `setDisplayName()` |
| `lib/server.js` | Modify: `POST /api/team/set-display-name`; `GET /api/team` returns `avatar` |
| `test/suites/display-name.test.js` | Create: daemon-side behavior against a mocked backend |
| `ui/src/data/{types,DataClient,LocalDaemonClient,FakeDataClient,mappers,queries}.ts` | Modify: `setDisplayName` through every layer; `Member.avatar` |
| `ui/src/assets/avatars.svg` | Create: sprite sheet, placeholder marks, replaced by Andrew |
| `ui/src/assets/avatars.ts` | Create: `AVATAR_KEYS`, `isAvatarKey` |
| `ui/src/components/AvatarRegistry.tsx` | Create: id → avatar context, so `Avatar` call sites stay untouched |
| `ui/src/components/Avatar.tsx` | Modify: render a sprite mark when one resolves, else today's initial |
| `ui/src/app/IdentityDialog.tsx` | Create: the name + avatar editor |
| `ui/src/app/Shell.tsx` | Modify: double-click / Enter opens the editor; mount sprite and registry |

---

### Task 1: Migration 057

**Files:**
- Create: `supabase/migrations/057_member_identity.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.set_display_name(p_name text, p_avatar text) returns table (display_name text, avatar text, teams int)`, raising SQLSTATE `MB001` on collision and `MB002` on validation failure. Also `public.normalize_member_name(text) returns text` and `public.unique_member_name(uuid, text) returns text`.

- [ ] **Step 1: Read the conventions this migration must follow**

Run: `sed -n '1,60p' supabase/migrations/053_team_members_list_deleted_at.sql`

You are copying two things: the long explanatory header (this repo documents *why* in the migration itself), and the "Verify after applying" block at the end.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/057_member_identity.sql`. Write a header in the style of 053 covering: why uniqueness is an index and not a client check, why the grace period needs a column, and the trigger deviation above. Then:

```sql
-- 1. NORMALIZATION. Immutable so it can sit in an index expression.
create or replace function public.normalize_member_name(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
$$;

-- 2. COLUMNS.
--    avatar: null means "render my initial", which is a CHOICE, not "unset".
--    name_released_at: non-null means this row no longer holds its name
--    against anyone. A partial index predicate must be immutable, so the
--    10-day grace period cannot live in the predicate -- it is expressed by
--    the RPC stamping this column when it meets an expired name.
alter table public.team_members
  add column if not exists avatar text,
  add column if not exists name_released_at timestamptz;

alter table public.team_members drop constraint if exists team_members_avatar_shape;
alter table public.team_members add constraint team_members_avatar_shape
  check (avatar is null or avatar ~ '^[a-z0-9-]{1,32}$');

-- 3. SUFFIX HELPER. security definer is REQUIRED, not defensive: at join time
--    the caller is not yet a member, so RLS hides every existing row from them
--    and an invoker-rights probe would answer "free" every single time.
create or replace function public.unique_member_name(p_team uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := btrim(coalesce(p_name, ''));
  v_try  text;
  n int := 1;
begin
  if v_base = '' then v_base := 'member'; end if;
  if char_length(v_base) > 80 then v_base := left(v_base, 80); end if;
  v_try := v_base;
  loop
    exit when not exists (
      select 1 from public.team_members m
       where m.team_id = p_team
         and m.name_released_at is null
         and public.normalize_member_name(m.display_name)
             = public.normalize_member_name(v_try)
    );
    n := n + 1;
    if n > 99 then
      return left(v_base, 71) || ' ' || substr(gen_random_uuid()::text, 1, 8);
    end if;
    v_try := left(v_base, 80 - (char_length(n::text) + 1)) || ' ' || n::text;
  end loop;
  return v_try;
end;
$$;

-- 4. TRIGGER. Every insert path -- create_team, join_team, redeem_invite,
--    redeem_onboarding_invite, and any added later -- goes through this.
create or replace function public.team_members_dedupe_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.display_name := public.unique_member_name(new.team_id, new.display_name);
  return new;
end;
$$;

drop trigger if exists team_members_dedupe_name on public.team_members;
create trigger team_members_dedupe_name
  before insert on public.team_members
  for each row execute function public.team_members_dedupe_name();

-- 5. PRE-RELEASE LEGACY DUPLICATES. Production held zero duplicates when this
--    was written, but one appearing before this is applied would fail index
--    creation below and abort the whole migration. Non-destructive: the later
--    joiner keeps their name, it is simply no longer protected.
with ranked as (
  select team_id, user_id,
         row_number() over (
           partition by team_id, public.normalize_member_name(display_name)
           order by joined_at asc, user_id asc
         ) as rn
    from public.team_members
   where name_released_at is null
)
update public.team_members m
   set name_released_at = now()
  from ranked r
 where m.team_id = r.team_id and m.user_id = r.user_id and r.rn > 1;

-- 6. THE CONSTRAINT. This, not any check in any function, is what makes two
--    simultaneous claims resolve to one winner.
create unique index if not exists team_members_display_name_unique
  on public.team_members (team_id, public.normalize_member_name(display_name))
  where name_released_at is null;

-- 7. THE RPC.
create or replace function public.set_display_name(p_name text, p_avatar text default null)
returns table (display_name text, avatar text, teams int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_norm  text;
  v_clash text;
  v_count int;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'a display name must be between 1 and 80 characters'
      using errcode = 'MB002';
  end if;
  if p_avatar is not null and p_avatar !~ '^[a-z0-9-]{1,32}$' then
    raise exception 'unrecognised avatar' using errcode = 'MB002';
  end if;
  v_norm := public.normalize_member_name(v_name);

  -- Lazy release of names held by accounts soft-deleted more than 10 days
  -- ago. Deletion sets auth.users.deleted_at and LEAVES the member row (053),
  -- so without this a departed teammate's name is locked up forever.
  update public.team_members m
     set name_released_at = now()
    from auth.users u
   where m.user_id = u.id
     and m.user_id <> auth.uid()
     and m.name_released_at is null
     and public.normalize_member_name(m.display_name) = v_norm
     and u.deleted_at is not null
     and u.deleted_at < now() - interval '10 days'
     and m.team_id in (select team_id from public.team_members where user_id = auth.uid());

  -- Message-only pre-check: it names the team so the error is actionable. It
  -- is NOT the enforcement mechanism -- the index below is.
  select t.name into v_clash
    from public.team_members m
    join public.teams t on t.id = m.team_id
   where m.user_id <> auth.uid()
     and m.name_released_at is null
     and public.normalize_member_name(m.display_name) = v_norm
     and m.team_id in (select team_id from public.team_members where user_id = auth.uid())
   limit 1;
  if v_clash is not null then
    raise exception 'somebody on % is already called %', v_clash, v_name
      using errcode = 'MB001';
  end if;

  -- One statement, so every team is updated atomically: a collision in any
  -- single team rolls back the rename in all of them. Assigning p_avatar
  -- directly (not coalesce) is deliberate -- null is the "just my initial"
  -- choice, and coalescing would make that choice unexpressible.
  -- name_released_at resets so a previously-released name is re-protected.
  update public.team_members m
     set display_name = v_name, avatar = p_avatar, name_released_at = null
   where m.user_id = auth.uid();
  get diagnostics v_count = row_count;

  -- Zero rows is NOT an error: it is the signed-in-with-no-team case.
  return query select v_name, p_avatar, v_count;
exception
  when unique_violation then
    raise exception 'somebody on your team is already called %', v_name
      using errcode = 'MB001';
end;
$$;

-- 8. GRANTS (042). A newly created function is EXECUTE-able by PUBLIC by
--    default, which means callable with the anon key.
revoke execute on function public.set_display_name(text, text) from public, anon;
grant  execute on function public.set_display_name(text, text) to authenticated;
revoke execute on function public.unique_member_name(uuid, text) from public, anon;
revoke execute on function public.team_members_dedupe_name() from public, anon;
```

- [ ] **Step 3: Append the verify-after-applying block**

Copy 053's comment style. The block must state expected results, not just queries:

```sql
-- Verify after applying:
--
--   select public.normalize_member_name('  Marco   B ');   -- expect 'marco b'
--
--   select indexdef from pg_indexes
--    where indexname = 'team_members_display_name_unique';  -- expect a partial
--                                                           -- unique index
--   select count(*) from public.team_members
--    where name_released_at is not null;                    -- expect 0 on a
--                                                           -- clean database
--
--   select proname, prosecdef, proconfig from pg_proc
--    where proname in ('set_display_name','unique_member_name',
--                      'team_members_dedupe_name');
--   -- expect prosecdef = true and a search_path in proconfig for all three
```

- [ ] **Step 4: Syntax-check the file**

There is no local Postgres in this repo, so this is a read-through, not a run. Confirm by eye: every `$$` is paired, every `create or replace function` ends with `$$;`, and section 5's CTE-plus-`update ... from` is one statement ending in `;`.

Run: `grep -c '\$\$' supabase/migrations/057_member_identity.sql`
Expected: an even number (each function body opens and closes).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/057_member_identity.sql
git commit -m "feat(db): per-team unique display names, avatars, and set_display_name"
```

---

### Task 2: Daemon — `teamsync.setDisplayName`

**Files:**
- Modify: `lib/teamsync.js` (`rest()` ~line 400, `sessionToCredentials` ~line 204, new export)
- Create: `test/suites/display-name.test.js`

**Interfaces:**
- Consumes: `public.set_display_name` from Task 1.
- Produces: `teamsync.setDisplayName(config, name, avatar, avatarColor) -> Promise<{ displayName: string, avatar: string|null, avatarColor: string|null, teams: number }>`. Throws an `Error` carrying `.code === 'MB001'` on collision, `.code === 'MB002'` on validation failure, `.status` from HTTP.

> **AMENDMENT — avatars are shape AND colour.** After this plan was written, the avatar art arrived as 15 glyphs × 10 colours, chosen independently. Migration 057 therefore carries a second column, `avatar_color`, and `set_display_name` takes a third parameter `p_avatar_color`. Everywhere below that mentions `avatar`, carry `avatarColor` alongside it with identical rules: it is a nullable string, null is the real choice "use the colour my id already derives" and never means "unchanged", and it is assigned directly rather than coalesced. Concretely:
> - the mock's `set_display_name` reads `body.p_avatar_color`, validates `^#[0-9A-Fa-f]{6}$` (MB002 on a bad value), stores it on the member rows, and returns it as `avatar_color`;
> - the mock's `team_members_list` returns `avatar_color: m.avatarColor || null` beside `avatar`;
> - `sessionToCredentials` preserves `avatarColor` exactly as it preserves `avatar`;
> - `teamsync.setDisplayName` takes and returns it, and the suite asserts it round-trips and that clearing it stores null.

- [ ] **Step 1: Teach the Supabase mock the new RPC**

`test/mock-supabase.js` is a 1515-line in-memory Supabase that models each RPC's real semantics. Every team suite runs against it, so it — not a hand-rolled stub — is where `set_display_name` belongs.

Add a name helper near the other member helpers, and call it from **both** `create_team` (~line 375) and `join_team` (~line 385), replacing the bare `displayName: body.p_display_name`:

```js
  // Models 057's BEFORE INSERT trigger: a colliding name is suffixed rather
  // than refused, because a joiner is often at a CLI with nowhere to retype.
  const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  function uniqueName(teamId, wanted) {
    let base = String(wanted || '').trim() || 'member';
    let attempt = base;
    let n = 1;
    while (members.some(m => m.teamId === teamId && !m.nameReleasedAt
                             && normName(m.displayName) === normName(attempt))) {
      n += 1;
      attempt = `${base} ${n}`;
    }
    return attempt;
  }
```

So `create_team`'s owner row becomes `displayName: uniqueName(team.id, body.p_display_name)`, and `join_team`'s join row likewise with `team.id`.

Then add the RPC beside `rename_team` (~line 507):

```js
    if (fn === 'set_display_name') {
      const name = String(body.p_name || '').trim();
      const avatar = body.p_avatar || null;
      if (name.length < 1 || name.length > 80) {
        return json(res, 400, { code: 'MB002', message: 'a display name must be between 1 and 80 characters' });
      }
      const myTeams = members.filter(m => m.userId === userId).map(m => m.teamId);
      const clash = members.find(m => m.userId !== userId && myTeams.includes(m.teamId)
        && !m.nameReleasedAt && normName(m.displayName) === normName(name));
      if (clash) {
        const t = teams.get(clash.teamId);
        return json(res, 400, {
          code: 'MB001',
          message: `somebody on ${t ? t.name : 'your team'} is already called ${name}`,
        });
      }
      // One pass over every team, mirroring the single UPDATE in 057.
      let n = 0;
      for (const m of members) {
        if (m.userId === userId) { m.displayName = name; m.avatar = avatar; m.nameReleasedAt = null; n += 1 }
      }
      return json(res, 200, [{ display_name: name, avatar, teams: n }]);
    }
```

Also add `avatar: m.avatar || null` to the row `team_members_list` returns (~line 548), so Task 4's `Member.avatar` has something to map.

**Not modelled:** the 10-day grace period on a soft-deleted account's name. That rule lives entirely in SQL against `auth.users.deleted_at`, and modelling it here would test the model rather than the migration. It is verified by 057's verify-after-applying block on a real database.

- [ ] **Step 2: Write the failing test**

Create `test/suites/display-name.test.js`, following `test/suites/account-deletion.test.js`'s structure — one `MEMBRIDGE_HOME` per persona, real `teamsync.signup` against the mock, a short-lived daemon per request:

```js
'use strict';
// Display-name changes: uniqueness within a team, atomicity across teams, and
// the rule that credentials.json is written ONLY after the backend agrees.
// Run directly, or via `node test/run.js display-name`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, waitForHttp, post } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const { startServer } = require('../../lib/server');
const { createMockSupabase } = require('../mock-supabase');

const HOME_A = path.join(ROOT, 'home-name-a');
const HOME_B = path.join(ROOT, 'home-name-b');
const homeFor = { a: HOME_A, b: HOME_B };
const portFor = { a: P(88), b: P(89) };

async function main() {
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(P(90), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(90)}`;

  async function apiAs(role, method, pathname, body) {
    process.env.MEMBRIDGE_HOME = homeFor[role];
    const port = portFor[role];
    const srv = startServer(port, { retries: 0 });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/api/status`);
      const url = `http://127.0.0.1:${port}${pathname}`;
      const res = method === 'GET' ? await fetch(url) : await post(url, body);
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      await new Promise(r => srv.close(r));
    }
  }
  const credsOf = role =>
    JSON.parse(fs.readFileSync(path.join(homeFor[role], 'credentials.json'), 'utf8'));

  try {
    for (const dir of Object.values(homeFor)) fs.mkdirSync(dir, { recursive: true });

    process.env.MEMBRIDGE_HOME = HOME_A;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'a@test.dev', 'pw-a', 'Ada');
    const team = await teamsync.createTeam(util.getConfig(), 'Acme');

    process.env.MEMBRIDGE_HOME = HOME_B;
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'b@test.dev', 'pw-b', 'Bo');
    const joined = await apiAs('b', 'POST', '/api/team/join', { inviteCode: team.invite_code });
    assert.strictEqual(joined.status, 200, 'fixture: Bo must join Acme');

    await check('a rename Bo does not clash with is accepted and stored locally', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'Bodhi', avatar: 'ring' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.displayName, 'Bodhi');
      assert.strictEqual(credsOf('b').displayName, 'Bodhi');
      assert.strictEqual(credsOf('b').avatar, 'ring');
    });

    await check('taking a teammate name is a 409 that names the team', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'Ada', avatar: null });
      assert.strictEqual(res.status, 409);
      assert.match(res.body.error, /Acme/);
    });

    await check('a refused rename leaves credentials.json untouched', () => {
      // This repo's characteristic bug is a fail-open path plus an
      // unconditional success flag. credentials.json IS the flag here: a
      // machine that records a rename the server refused goes on stamping the
      // refused name onto every entry it pushes.
      assert.strictEqual(credsOf('b').displayName, 'Bodhi');
    });

    await check('case and spacing alone do not make a name distinct', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: '  aDa ', avatar: null });
      assert.strictEqual(res.status, 409);
    });

    await check('changing only your own capitalisation is allowed', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'ring' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(credsOf('b').displayName, 'BODHI');
    });

    await check('a name that trims to empty never reaches the network', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: '   ', avatar: null });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(credsOf('b').displayName, 'BODHI');
    });

    await check('clearing the avatar stores null, not the previous mark', async () => {
      const res = await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: null });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(credsOf('b').avatar, null);
    });

    await check('joining under a taken name auto-suffixes instead of failing', async () => {
      // The mock models 057's insert trigger. Ada already holds "Ada"; a
      // second joiner asking for it must land as "Ada 2", not be turned away.
      const taken = mock.members.filter(m => m.teamId === team.team_id).map(m => m.displayName);
      assert.ok(taken.includes('Ada'), 'fixture: Ada holds her own name');
    });

    await check('GET /api/team reports the avatar alongside the name', async () => {
      await apiAs('b', 'POST', '/api/team/set-display-name', { name: 'BODHI', avatar: 'wave' });
      const res = await apiAs('b', 'GET', '/api/team');
      assert.strictEqual(res.body.user.avatar, 'wave');
    });
  } finally {
    mock.server.close();
  }

  h.finish();
}

main();
```

This suite covers Task 3's HTTP surface as well, so Task 3 adds no new test file.

- [ ] **Step 3: Run it to verify it fails**

Run: `node test/run.js display-name`
Expected: FAIL — the first rename check gets a 404, because neither the route (Task 3) nor `teamsync.setDisplayName` exists yet. Task 2 makes the daemon function real; Task 3 makes the route real and turns this suite green. Both tasks run the same command, and it is expected to stay red until Task 3 Step 5.

- [ ] **Step 4: Carry the PostgREST error code on thrown errors**

In `lib/teamsync.js`, `rest()` around line 419, extend the existing throw:

```js
    throw Object.assign(new Error(msg), { status: res.status, code: data && data.code });
```

The status comment above it already explains why callers need more than the message; add one line noting that `code` is how `MB001` is told from any other 400, so rewording a message never breaks the mapping.

- [ ] **Step 5: Preserve the avatar across login and refresh**

In `sessionToCredentials` (~line 204), add `avatar` beside the existing `displayName` fallback:

```js
    displayName: displayName || prev.displayName || String(session.user.email || '').split('@')[0],
    avatar: prev.avatar || null,
```

Without this, a token refresh silently drops the avatar.

- [ ] **Step 6: Implement `setDisplayName`**

Add near the team functions (~line 1120, beside `createTeam`):

```js
// Change this person's display name, and their avatar, across every team they
// belong to. The RPC does the work in one statement so the teams are atomic.
//
// The local write is deliberately AFTER the await and unreachable from any
// error branch. This function is the exact shape of this codebase's
// characteristic bug -- a fail-open path plus an unconditional success flag --
// and the flag here is credentials.json: a machine that records a rename the
// server refused goes on stamping the refused name onto every entry it pushes.
async function setDisplayName(config, name, avatar) {
  const creds = await getAccessToken(config);
  if (!creds) throw new Error('not logged in — run `membridge login` first');
  const rows = await rpc(config, creds, 'set_display_name', {
    p_name: name,
    p_avatar: avatar || null,
  });
  const row = (rows && rows[0]) || {};
  // Store what the server RETURNED, not what we asked for: it trims, and the
  // two must not be allowed to disagree.
  const next = loadCredentials() || creds;
  saveCredentials({ ...next, displayName: row.display_name, avatar: row.avatar || null });
  return { displayName: row.display_name, avatar: row.avatar || null, teams: row.teams || 0 };
}
```

Add `setDisplayName` to the `module.exports` list at the bottom of the file.

- [ ] **Step 7: Confirm the failure has moved, not vanished**

Run: `node test/run.js display-name`
Expected: still FAIL, but now on the 404 from the missing route rather than on `setDisplayName is not a function`. Task 3 closes it. Do not "fix" the suite here.

- [ ] **Step 8: Commit**

```bash
git add lib/teamsync.js test/suites/display-name.test.js test/mock-supabase.js
git commit -m "feat(daemon): teamsync.setDisplayName, saving locally only on success"
```

---

### Task 3: HTTP surface

**Files:**
- Modify: `lib/server.js` (route beside `/api/team/rename` ~line 3410; account payload ~line 2813)
- Modify: `test/suites/display-name.test.js`

**Interfaces:**
- Consumes: `teamsync.setDisplayName` from Task 2.
- Produces: `POST /api/team/set-display-name` with body `{ name: string, avatar: string|null, avatarColor: string|null }`, answering `200 { displayName, avatar, avatarColor, teams }`, `400 { error }`, `409 { error }`. `GET /api/team` gains `user.avatar` and `user.avatarColor`.

> **AMENDMENT — carry `avatarColor` through this route.** Read it from the body as `body.avatarColor ? String(body.avatarColor) : null`, pass it to `teamsync.setDisplayName` as the fourth argument, and include it in the `GET /api/team` user object beside `avatar`. Do NOT validate the hex format in the daemon — the RPC raises MB002 for a malformed colour and the route already maps MB002 to 400, so a second copy of the rule in JavaScript is a rule that can drift. The audit `detail` gains `avatarColor` alongside `name` and `avatar`.

- [ ] **Step 1: Confirm the test that will judge this task is already failing**

Task 2 wrote `test/suites/display-name.test.js`, and every check in it drives this route. No new test file is needed.

Run: `node test/run.js display-name`
Expected: FAIL with a 404 on `/api/team/set-display-name`.

- [ ] **Step 2: Add the route**

In `lib/server.js`, immediately after the `/api/team/rename` branch:

```js
    } else if (req.method === 'POST' && url.pathname === '/api/team/set-display-name') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const avatar = body.avatar ? String(body.avatar) : null;
      // Refused here, before the network: a name that trims to nothing is not
      // a backend question.
      if (!name) return json(res, 400, { error: 'a display name is required' });
      if (name.length > 80) return json(res, 400, { error: 'a display name must be 80 characters or fewer' });
      let result;
      try {
        result = await teamsync.setDisplayName(getConfig(), name, avatar);
      } catch (err) {
        // Keyed off the SQLSTATE, never the message text: the message is
        // user-facing prose and will be reworded.
        if (err.code === 'MB001') return json(res, 409, { error: err.message });
        if (err.code === 'MB002') return json(res, 400, { error: err.message });
        throw err;
      }
      await apiAccess.recordAudit(getConfig(), {
        action: 'member-renamed', objectType: 'member', objectKey: result.displayName,
        detail: { name: result.displayName, avatar: result.avatar },
      });
      json(res, 200, result);
```

Check how the neighbouring audit calls obtain `teamId` (the `/api/team/rename` branch takes it from the body) and follow the same pattern — read `grep -n "recordAudit" lib/server.js | head` and match the shape used by a route that has no `teamId` in its body.

- [ ] **Step 3: Return the avatar on `GET /api/team`**

In the account payload (~line 2813), add to the `user` object:

```js
      displayName: creds.displayName,
      avatar: creds.avatar || null,
```

- [ ] **Step 4: Run the tests**

Run: `node test/run.js display-name`
Expected: PASS — all nine checks, the first time this suite goes green.

If a check fails, run `node scripts/verify-finding.js --suite display-name --runs 3` before treating it as real.

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/suites/display-name.test.js
git commit -m "feat(api): POST /api/team/set-display-name, 409 on a taken name"
```

---

### Task 4: DataClient plumbing

**Files:**
- Modify: `ui/src/data/types.ts` (`TeamAccount` ~748, `Member` ~448)
- Modify: `ui/src/data/DataClient.ts`, `LocalDaemonClient.ts`, `FakeDataClient.ts`, `mappers.ts`, `queries.ts`
- Test: `ui/src/data/LocalDaemonClient.test.ts`

**Interfaces:**
- Consumes: `POST /api/team/set-display-name` from Task 3.
- Produces: `DataClient.setDisplayName(name: string, avatar: string | null, avatarColor: string | null): Promise<{ displayName: string; avatar: string | null; avatarColor: string | null }>`; `useSetDisplayName()` mutation hook taking `{ name, avatar, avatarColor }`; `Member.avatar` and `Member.avatarColor`; `TeamAccount.user.avatar` and `TeamAccount.user.avatarColor` — all `string | null`.

> **AMENDMENT — `avatarColor` travels with `avatar` everywhere in this task.** Every signature, type, mapper and fixture below that names `avatar` gains `avatarColor` beside it, same type, same null semantics. Specifically: `TeamAccount.user` and `Member` each get both fields; `mapMember` maps `avatarColor: raw.avatar_color ?? null` (note the wire name is snake_case from the RPC, unlike `avatar`, so check the raw shape rather than assuming); `LocalDaemonClient.setDisplayName` posts all three and returns all three; `FakeDataClient.setDisplayName(name, avatar, avatarColor)` echoes them; and `useSetDisplayName`'s `mutationFn` takes `{ name, avatar, avatarColor }`. Task 6's tests call `setDisplayName('marco', 'halo', '#22C08F')` positionally — match that argument order.

- [ ] **Step 1: Write the failing test**

In `ui/src/data/LocalDaemonClient.test.ts`, following the file's existing fetch-mocking style (read the top 40 lines first):

```ts
it('setDisplayName posts name and avatar and returns what the daemon wrote', async () => {
  const client = new LocalDaemonClient()
  fetchMock.mockResolvedValueOnce(jsonResponse({ displayName: 'Marco', avatar: 'ring', teams: 2 }))
  const r = await client.setDisplayName('Marco', 'ring')
  expect(r).toEqual({ displayName: 'Marco', avatar: 'ring' })
})

it('setDisplayName surfaces the daemon error text on a 409', async () => {
  const client = new LocalDaemonClient()
  fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'somebody on Acme is already called marco' }, 409))
  await expect(client.setDisplayName('marco', null)).rejects.toThrow(/already called/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/data/LocalDaemonClient.test.ts`
Expected: FAIL — `setDisplayName` is not a function.

- [ ] **Step 3: Extend the types**

`types.ts`, in `TeamAccount`:

```ts
  user: { userId: string; email: string; displayName: string; avatar: string | null } | null
```

`types.ts`, in `Member`, beneath `role`:

```ts
  // The mark this person picked, or null for "render my initial" -- which is
  // a choice, not an absence.
  avatar: string | null
```

- [ ] **Step 4: Add the interface method**

`DataClient.ts`, beneath `renameTeam` (~line 232):

```ts
  // Change YOUR OWN display name and avatar across every team you belong to
  // (POST /api/team/set-display-name). Uniqueness is enforced by the backend,
  // not here: a taken name rejects with the daemon's 409 text.
  setDisplayName(name: string, avatar: string | null): Promise<{ displayName: string; avatar: string | null }>
```

- [ ] **Step 5: Implement it in both clients**

`LocalDaemonClient.ts`, beside `renameTeam` (~line 372):

```ts
  async setDisplayName(name: string, avatar: string | null): Promise<{ displayName: string; avatar: string | null }> {
    const r = await postReadingError<{ displayName: string; avatar: string | null }>(
      '/api/team/set-display-name', { name, avatar })
    return { displayName: r.displayName, avatar: r.avatar ?? null }
  }
```

`FakeDataClient.ts`, beside `renameTeam` (~line 743):

```ts
  setDisplayName(name: string, avatar: string | null) {
    return this.guard<{ displayName: string; avatar: string | null }>({ displayName: name, avatar })
  }
```

- [ ] **Step 6: Map the avatar on members**

In `mappers.ts`, find `mapMember` and add `avatar: raw.avatar ?? null` to the returned object, plus `avatar?: string | null` on its raw input interface. Do the same for whatever raw type backs `TeamAccount.user`.

- [ ] **Step 7: Add the mutation hook**

`queries.ts`, beside `useSignIn` (~line 507):

```ts
export function useSetDisplayName() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { name: string; avatar: string | null }) => c.setDisplayName(v.name, v.avatar),
    // accountRefresh relabels the rail; ['members'] relabels the roster and
    // every avatar resolved through it.
    onSuccess: () => { accountRefresh(qc); qc.invalidateQueries({ queryKey: ['members'] }) },
  })
}
```

- [ ] **Step 8: Run the tests and the type check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean. This is the only local check that catches type errors — fix every `Member` literal in fixtures that now needs `avatar`.

Run: `cd ui && npx vitest run src/data/LocalDaemonClient.test.ts src/data/mappers.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/src/data
git commit -m "feat(ui): setDisplayName through DataClient, and Member.avatar"
```

---

### Task 5: Avatar glyphs and the identity registry

**Files:**
- Create: `ui/src/components/AvatarGlyph.tsx` (copied from the art drop), `ui/src/components/AvatarRegistry.tsx`
- Modify: `ui/src/components/Avatar.tsx`
- Test: `ui/src/components/components.test.tsx`

**Interfaces:**
- Consumes: `Member.avatar` and `Member.avatarColor` from Task 4.
- Produces: `GLYPHS: readonly Glyph[]`, `AVATAR_COLORS: readonly string[]`, `<AvatarGlyph glyph color name size />`, `isGlyph(v): v is Glyph`, `<AvatarRegistryProvider value={ReadonlyMap<string, {glyph: string; color: string | null}>}>`, `useRegisteredAvatar(id)`. `Avatar` gains optional `avatar?: string | null` and `avatarColor?: string | null` props; **its 14 existing call sites are unchanged**.

**This task supersedes an earlier sprite-sheet design.** Andrew delivered the art as a React component, not an SVG sprite, so there is no `avatars.svg`, no `?raw` import, no `<use>` indirection, and no `avatars.ts`. Do not create those files.

- [ ] **Step 1: Bring the art into the repo**

Copy the delivered component verbatim — do not redraw, restyle, or "improve" the glyph geometry:

```bash
cp .superpowers/sdd/2026-08-12-member-identity-rename/AvatarGlyph.source.tsx ui/src/components/AvatarGlyph.tsx
```

Read it before going further. It exports `GLYPHS` (15 keys), `AVATAR_COLORS` (10 hex tokens), types `Glyph` and `AvatarColor`, and the `AvatarGlyph` component. Its header states the design contract: shape and color are INDEPENDENT choices, and the picker must therefore be two rows rather than one grid of fixed combinations.

Add one export it does not yet have, used by `Avatar` to reject a glyph key this build does not know:

```tsx
export function isGlyph(v: string | null | undefined): v is Glyph {
  return !!v && (GLYPHS as readonly string[]).includes(v)
}
```

- [ ] **Step 2: Write the failing test**

In `ui/src/components/components.test.tsx`, beside the existing `Avatar` tests (~line 193):

```tsx
import { AvatarRegistryProvider } from './AvatarRegistry'

it('renders the initial when the person has picked no glyph', () => {
  render(<Avatar name="Sarah" id="sarah" />)
  expect(screen.getByLabelText('Sarah')).toHaveTextContent('S')
})

it('renders the glyph registered for that id', () => {
  render(
    <AvatarRegistryProvider value={new Map([['sarah', { glyph: 'halo', color: '#22C08F' }]])}>
      <Avatar name="Sarah" id="sarah" />
    </AvatarRegistryProvider>,
  )
  // AvatarGlyph puts the accessible name on the <svg role="img">.
  expect(screen.getByRole('img', { name: 'Sarah' })).toBeInTheDocument()
  expect(screen.queryByText('S')).toBeNull()
})

// A teammate on a newer build can pick a glyph this build does not have. A
// blank circle would be worse than the initial it replaced.
it('falls back to the initial for a glyph this build does not know', () => {
  render(
    <AvatarRegistryProvider value={new Map([['sarah', { glyph: 'not-a-real-glyph', color: null }]])}>
      <Avatar name="Sarah" id="sarah" />
    </AvatarRegistryProvider>,
  )
  expect(screen.getByLabelText('Sarah')).toHaveTextContent('S')
})

// Null color is a real choice meaning "the color my id already derives",
// not an absence to be defaulted to something arbitrary.
it('uses the id-derived palette color when the person picked no color', () => {
  render(
    <AvatarRegistryProvider value={new Map([['sarah', { glyph: 'halo', color: null }]])}>
      <Avatar name="Sarah" id="sarah" />
    </AvatarRegistryProvider>,
  )
  const svg = screen.getByRole('img', { name: 'Sarah' })
  expect(svg.getAttribute('style')).toMatch(/color:/)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ui && npx vitest run src/components/components.test.tsx`
Expected: FAIL — cannot resolve `./AvatarRegistry`.

- [ ] **Step 4: Create the registry**

`ui/src/components/AvatarRegistry.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react'

export interface RegisteredAvatar {
  glyph: string
  color: string | null
}

// Avatar is rendered at 14 call sites and every one already passes the member
// id. Resolving the glyph from the id HERE means none of them has to learn
// about avatars, and none of them can forget to pass one.
const AvatarContext = createContext<ReadonlyMap<string, RegisteredAvatar>>(new Map())

export function AvatarRegistryProvider({ value, children }: {
  value: ReadonlyMap<string, RegisteredAvatar>
  children: ReactNode
}) {
  return <AvatarContext.Provider value={value}>{children}</AvatarContext.Provider>
}

// The default is an EMPTY map, not a throw: a component rendered outside the
// provider (every existing component test) falls back to the initial, which is
// exactly the behaviour that shipped before glyphs existed.
export function useRegisteredAvatar(id: string): RegisteredAvatar | null {
  return useContext(AvatarContext).get(id) ?? null
}
```

- [ ] **Step 5: Teach Avatar to use it**

Rewrite `ui/src/components/Avatar.tsx`, keeping `PALETTE` and `colorForId` byte-for-byte as they are — `colorForId` is what makes an unpicked avatar keep the exact color it has today:

```tsx
import { AvatarGlyph, isGlyph } from './AvatarGlyph'
import { useRegisteredAvatar } from './AvatarRegistry'

interface AvatarProps {
  name: string
  id: string
  size?: number
  /** Overrides the registry lookup. Only the picker's live preview passes
   *  these; every other call site resolves through the registry. */
  avatar?: string | null
  avatarColor?: string | null
}

export function Avatar({ name, id, size = DEFAULT_SIZE, avatar, avatarColor }: AvatarProps) {
  const registered = useRegisteredAvatar(id)
  const glyph = avatar !== undefined ? avatar : registered?.glyph ?? null
  const picked = avatarColor !== undefined ? avatarColor : registered?.color ?? null
  // Null color means "the color my id already derives" -- a real choice, and
  // the reason nobody's avatar changes colour when this ships.
  const color = picked || colorForId(id)

  if (isGlyph(glyph)) {
    return <AvatarGlyph glyph={glyph} color={color} name={name} size={size} />
  }

  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="avatar"
      title={name}
      aria-label={name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: color }}
    >
      {initial}
    </span>
  )
}
```

Note `AvatarGlyph` carries its own `role="img"` and `aria-label`, so the initial branch keeps `aria-label` and the glyph branch does not double-announce.

- [ ] **Step 6: Run the tests**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

Run: `cd ui && npx vitest run src/components/components.test.tsx`
Expected: PASS, including the four new cases.

If a case fails with "Unable to find <element>", that is the documented phantom shape — run `node scripts/verify-finding.js --ui src/components/components.test.tsx --runs 3` before changing any code.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components
git commit -m "feat(ui): glyph avatars with an id-keyed registry, no call-site changes"
```


### Task 6: The avatar picker and the identity editor

**Files:**
- Create: `ui/src/components/AvatarPicker.tsx`, `ui/src/app/IdentityDialog.tsx`, `ui/src/app/IdentityDialog.test.tsx`
- Modify: `ui/src/app/app.css`

**Interfaces:**
- Consumes: `useSetDisplayName` (Task 4), `GLYPHS` / `AVATAR_COLORS` / `Avatar` (Task 5).
- Produces: `<AvatarPicker name viewerId glyph color onGlyph onColor />` — a **controlled, mutation-free** picker; and `<IdentityDialog currentName currentAvatar currentAvatarColor viewerId onClose />`. Task 7 (rail) and Task 8 (Settings) both open the same `IdentityDialog`, so there is exactly one save path.

- [ ] **Step 1: Write the failing test**

Create `ui/src/app/IdentityDialog.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import { IdentityDialog } from './IdentityDialog'

function renderDialog(client = new FakeDataClient({})) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>
        <IdentityDialog currentName="marco" currentAvatar={null} currentAvatarColor={null}
                        viewerId="u1" onClose={() => {}} />
      </DataClientProvider>
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('IdentityDialog', () => {
  it('opens with the current name already in the field', async () => {
    renderDialog()
    expect(await screen.findByLabelText(/display name/i)).toHaveValue('marco')
  })

  it('refuses to save an empty name without calling the client', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.clear(await screen.findByLabelText(/display name/i))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the reason when the name is taken', async () => {
    const client = new FakeDataClient({})
    vi.spyOn(client, 'setDisplayName').mockRejectedValue(
      new Error('somebody on Acme is already called nina'))
    renderDialog(client)
    await userEvent.clear(await screen.findByLabelText(/display name/i))
    await userEvent.type(screen.getByLabelText(/display name/i), 'nina')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already called nina/)
    // The typed text survives, so the person edits rather than retypes.
    expect(screen.getByLabelText(/display name/i)).toHaveValue('nina')
  })

  // Shape and colour are INDEPENDENT choices (AvatarGlyph.tsx's header states
  // this) -- picking one must not reset the other.
  it('sends the chosen glyph and colour together', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.click(await screen.findByRole('radio', { name: 'halo' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Colour 2' }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).toHaveBeenCalledWith('marco', 'halo', '#22C08F')
  })

  it('sends nulls when the initial and the derived colour are chosen', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.click(await screen.findByRole('radio', { name: 'halo' }))
    await userEvent.click(screen.getByRole('radio', { name: /^Initial$/ }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).toHaveBeenCalledWith('marco', null, null)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/app/IdentityDialog.test.tsx`
Expected: FAIL — cannot resolve `./IdentityDialog`.

- [ ] **Step 3: Build the picker**

`ui/src/components/AvatarPicker.tsx`. It holds no mutation and no state of its own — both entry points drive it, which is what keeps them honest about being one control:

```tsx
import { Avatar } from './Avatar'
import { GLYPHS, AVATAR_COLORS } from './AvatarGlyph'

interface AvatarPickerProps {
  name: string
  viewerId: string
  glyph: string | null
  color: string | null
  onGlyph: (glyph: string | null) => void
  onColour: (colour: string | null) => void
}

/** Two rows, not one grid: shape and colour are independent, so a grid of
 *  fixed combinations would misrepresent 15 x 10 as 150 separate things to
 *  scroll. Each row is a radiogroup; null is a real option in both. */
export function AvatarPicker({ name, viewerId, glyph, color, onGlyph, onColour }: AvatarPickerProps) {
  return (
    <>
      <fieldset className="avatar-row" role="radiogroup" aria-label="Avatar shape">
        <label className="avatar-choice">
          <input type="radio" name="glyph" aria-label="Initial"
                 checked={glyph === null} onChange={() => onGlyph(null)} />
          <Avatar name={name} id={viewerId} size={28} avatar={null} avatarColor={color} />
        </label>
        {GLYPHS.map(g => (
          <label className="avatar-choice" key={g}>
            <input type="radio" name="glyph" aria-label={g}
                   checked={glyph === g} onChange={() => onGlyph(g)} />
            <Avatar name={name} id={viewerId} size={28} avatar={g} avatarColor={color} />
          </label>
        ))}
      </fieldset>

      <fieldset className="avatar-row" role="radiogroup" aria-label="Avatar colour">
        <label className="avatar-choice">
          <input type="radio" name="avatarColour" aria-label="Default colour"
                 checked={color === null} onChange={() => onColour(null)} />
          <Avatar name={name} id={viewerId} size={28} avatar={glyph} avatarColor={null} />
        </label>
        {AVATAR_COLORS.map((c, i) => (
          <label className="avatar-choice" key={c}>
            <input type="radio" name="avatarColour" aria-label={`Colour ${i + 1}`}
                   checked={color === c} onChange={() => onColour(c)} />
            <Avatar name={name} id={viewerId} size={28} avatar={glyph} avatarColor={c} />
          </label>
        ))}
      </fieldset>
    </>
  )
}
```

Every swatch previews the person's ACTUAL current selection of the other axis, which is why both rows take `glyph` and `color` rather than only their own.

- [ ] **Step 4: Build the dialog**

`ui/src/app/IdentityDialog.tsx`:

```tsx
import { useState } from 'react'
import { FormDialog } from '../components/FormDialog'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSetDisplayName } from '../data/queries'

// Local, matching Shell.tsx:88, InsightsPage.tsx:22 and DaemonGroup.tsx:11.
// There is no shared export in this repo; inventing a fourth module here
// would be a refactor, not this ticket.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface IdentityDialogProps {
  currentName: string
  currentAvatar: string | null
  currentAvatarColor: string | null
  viewerId: string
  onClose: () => void
}

export function IdentityDialog({
  currentName, currentAvatar, currentAvatarColor, viewerId, onClose,
}: IdentityDialogProps) {
  const [name, setName] = useState(currentName)
  const [glyph, setGlyph] = useState<string | null>(currentAvatar)
  const [colour, setColour] = useState<string | null>(currentAvatarColor)
  const save = useSetDisplayName()
  const trimmed = name.trim()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // Refused locally: an empty name is not a question worth a round trip,
    // and the daemon answers 400 for it anyway.
    if (!trimmed || trimmed.length > 80) return
    save.mutate({ name: trimmed, avatar: glyph, avatarColor: colour }, { onSuccess: onClose })
  }

  return (
    <FormDialog titleId="identity-title" title="Your name" wide onClose={onClose}>
      <form onSubmit={submit}>
        {/* Exactly the field shape TeamGroup.tsx:46-50 uses for the team
            rename. There is no .dialog-label class in components.css. */}
        <label className="dialog-field">
          Display name
          <div className="dialog-field-hint">Your teammates see this. It has to be different from theirs.</div>
          <input
            className="dialog-input"
            aria-label="Display name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={e => setName(e.target.value)}
          />
        </label>

        <AvatarPicker
          name={trimmed || currentName}
          viewerId={viewerId}
          glyph={glyph}
          color={colour}
          onGlyph={setGlyph}
          onColour={setColour}
        />

        {save.isError && (
          <p className="dialog-error" role="alert">{errorMessage(save.error)}</p>
        )}

        <div className="dialog-actions">
          <button type="button" className="dialog-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="dialog-btn dialog-btn-primary"
                  disabled={!trimmed || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </FormDialog>
  )
}
```

The class names are verified against `ui/src/components/components.css:313-335` — `.dialog-field`, `.dialog-field-hint`, `.dialog-input`, `.dialog-error`, `.dialog-actions`, `.dialog-btn`, `.dialog-btn-primary` all exist. `.dialog-label` does not; do not use it.

- [ ] **Step 5: Style the two rows**

Add to `ui/src/app/app.css`:

```css
.avatar-row { border: 0; padding: 0; margin: 12px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
.avatar-choice { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
```

- [ ] **Step 6: Run the tests**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

Run: `cd ui && npx vitest run src/app/IdentityDialog.test.tsx`
Expected: PASS, 5 cases.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/AvatarPicker.tsx ui/src/app/IdentityDialog.tsx ui/src/app/IdentityDialog.test.tsx ui/src/app/app.css
git commit -m "feat(ui): shape-and-colour avatar picker in the identity editor"
```


### Task 7: Wire the rail footer

**Files:**
- Modify: `ui/src/app/Shell.tsx` (identity span line 218; provider mount ~line 147)
- Test: `ui/src/app/Shell.test.tsx`

**Interfaces:**
- Consumes: `IdentityDialog` (Task 6), `AvatarRegistryProvider` / `AvatarSprite` (Task 5), `useMembers` (existing, `queries.ts:151`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/app/Shell.test.tsx` inside `describe('Shell')`:

```tsx
it('opens the identity editor on a double-click of your name', async () => {
  renderApp({ solo: false })
  const identity = await screen.findByTestId('rail-identity')
  await userEvent.dblClick(identity)
  expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
})

// Double-click is unreachable without a mouse, so the same control answers
// Enter when focused.
it('opens the identity editor with the keyboard', async () => {
  renderApp({ solo: false })
  const identity = await screen.findByTestId('rail-identity')
  identity.focus()
  await userEvent.keyboard('{Enter}')
  expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
})

// A single click must NOT open it -- "double tap" is the asked-for gesture,
// and a plain <button> would fire on the first one.
it('does not open the editor on a single click', async () => {
  renderApp({ solo: false })
  const identity = await screen.findByTestId('rail-identity')
  await userEvent.click(identity)
  expect(screen.queryByRole('dialog')).toBeNull()
})

// FakeOptions has no `authenticated` flag, so the signed-out machine is
// modelled the way FirstRunClient models an unfinished setup at the top of
// this file: a subclass overriding the one query that decides.
class SignedOutClient extends FakeDataClient {
  async getTeamAccount(): Promise<TeamAccount> {
    return { ...(await super.getTeamAccount()), authenticated: false, user: null }
  }
}

it('offers no identity editor when signed out', async () => {
  renderWith(new SignedOutClient({ solo: true }), <App />)
  expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByTestId('rail-identity')).toBeNull()
})
```

`renderWith(client, ui)` and `TeamAccount` are already imported at the top of `Shell.test.tsx`; `renderApp(opts)` is just `renderWith(new FakeDataClient(opts), <App />)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/app/Shell.test.tsx`
Expected: FAIL — no dialog appears after the double-click.

- [ ] **Step 3: Wire the footer**

In `ui/src/app/Shell.tsx`, add imports and state:

```tsx
import { useMembers } from '../data/queries'
import { AvatarRegistryProvider, AvatarSprite } from '../components/AvatarRegistry'
import { IdentityDialog } from './IdentityDialog'
```

Inside the component, beside the existing `identity` const (line 138):

```tsx
  const [editingIdentity, setEditingIdentity] = useState(false)
  const avatar = account?.user?.avatar ?? null
  const avatarColor = account?.user?.avatarColor ?? null
  const viewerId = account?.viewerId ?? ''

  // The roster this app already fetches, reshaped into the id -> avatar map
  // the Avatar component resolves itself through. `onTeam` gates it because
  // getMembers() is meaningless without a team.
  const members = useMembers(onTeam)
  const avatarsById = useMemo(() => {
    const m = new Map<string, { glyph: string; color: string | null }>()
    for (const person of members.data ?? []) {
      if (person.avatar) m.set(person.id, { glyph: person.avatar, color: person.avatarColor })
    }
    // The viewer's own row, from the account query rather than the roster:
    // it updates the instant the save returns, and it is also the only
    // source when the roster query is disabled (not on a team).
    if (viewerId && avatar) m.set(viewerId, { glyph: avatar, color: avatarColor })
    return m
  }, [members.data, viewerId, avatar, avatarColor])
```

Replace the `signedIn` identity span (line 217-219) with:

```tsx
          {signedIn && (
            <>
              {/* Deliberately NOT a <button>: a button activates on a single
                  click, and the asked-for gesture is a double one. role +
                  tabIndex keep it announced and reachable, and Enter is the
                  keyboard equivalent of the double-click. */}
              <span
                className="rail-identity"
                data-testid="rail-identity"
                role="button"
                tabIndex={0}
                title={`${identity} — double-click to change your name`}
                onDoubleClick={() => setEditingIdentity(true)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setEditingIdentity(true)
                  }
                }}
              >
                {identity}
              </span>
              {editingIdentity && (
                <IdentityDialog
                  currentName={account?.user?.displayName || ''}
                  currentAvatar={avatar}
                  currentAvatarColor={avatarColor}
                  viewerId={viewerId}
                  onClose={() => setEditingIdentity(false)}
                />
              )}
            </>
          )}
```

Wrap the returned tree so the sprite and registry are mounted once. Change the outer element:

```tsx
    <AvatarRegistryProvider value={avatarsById}>
      <div className="shell">
        <AvatarSprite />
        {/* ...existing nav and main, unchanged... */}
      </div>
    </AvatarRegistryProvider>
```

Add `useState` and `useMemo` to the existing React import.

- [ ] **Step 4: Run the tests**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

Run: `cd ui && npx vitest run src/app/Shell.test.tsx src/components/components.test.tsx src/app/IdentityDialog.test.tsx`
Expected: PASS.

If a case fails with "Unable to find <element>", that is the documented phantom-failure shape. Run `node scripts/verify-finding.js --ui src/app/Shell.test.tsx --runs 3` before changing any code.

- [ ] **Step 5: Commit**

```bash
git add ui/src/app/Shell.tsx ui/src/app/Shell.test.tsx
git commit -m "feat(ui): double-click the rail name to change it"
```

---

### Task 8: The Settings entry point

**Files:**
- Modify: `ui/src/features/settings/SettingsPage.tsx`
- Test: `ui/src/features/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `IdentityDialog` (Task 6), `useTeamAccount` (existing, `queries.ts`).
- Produces: no new exports.

Andrew asked for the avatar and name to be editable from Settings **as well as** the rail footer. This task adds the second door, not a second control: it opens the same `IdentityDialog`, so there is one picker, one validation path and one mutation. Do not build a parallel form here.

- [ ] **Step 1: Write the failing test**

Read the file's existing render helper first — run `sed -n '1,40p' ui/src/features/settings/SettingsPage.test.tsx` and follow whatever it uses. Then add:

```tsx
it('opens the identity editor from the Settings row', async () => {
  renderSettings()   // use this file's existing helper name
  await userEvent.click(await screen.findByRole('button', { name: /change name/i }))
  expect(await screen.findByRole('dialog', { name: /your name/i })).toBeInTheDocument()
})

// One control, two doors: Settings must not grow its own picker.
it('shows the same shape and colour rows as the rail editor', async () => {
  renderSettings()
  await userEvent.click(await screen.findByRole('button', { name: /change name/i }))
  expect(await screen.findByRole('radiogroup', { name: /avatar shape/i })).toBeInTheDocument()
  expect(screen.getByRole('radiogroup', { name: /avatar colour/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/features/settings/SettingsPage.test.tsx`
Expected: FAIL — no such button.

- [ ] **Step 3: Add the row**

In `ui/src/features/settings/SettingsPage.tsx`, add a `SettingRow` in the "You"/personal area — beside the existing rows around line 365-382, NOT inside `TeamGroup` (which only renders when `settings.team` exists, and your own name is editable whether or not you are on a team).

```tsx
const account = useTeamAccount()
const [editingIdentity, setEditingIdentity] = useState(false)
```

```tsx
{account.data?.authenticated && (
  <SettingRow
    label="Your name and avatar"
    description="What your teammates see. Your name has to be different from theirs."
    testId="setting-identity"
  >
    <button type="button" className="setting-btn" onClick={() => setEditingIdentity(true)}>
      Change name
    </button>
  </SettingRow>
)}
{editingIdentity && account.data?.user && (
  <IdentityDialog
    currentName={account.data.user.displayName || ''}
    currentAvatar={account.data.user.avatar}
    currentAvatarColor={account.data.user.avatarColor}
    viewerId={account.data.viewerId ?? ''}
    onClose={() => setEditingIdentity(false)}
  />
)}
```

Check the button class other Settings rows use — run `grep -n 'className="setting-btn\|className="srow' ui/src/features/settings/SettingsPage.tsx | head -5` — and match it rather than introducing a new one.

- [ ] **Step 4: Run the tests**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

Run: `cd ui && npx vitest run src/features/settings/SettingsPage.test.tsx src/app/IdentityDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/settings
git commit -m "feat(ui): change your name and avatar from Settings too"
```


### Task 9: Reconcile the docs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-member-identity-rename-design.md`
- Modify: whichever migration ledger `supabase/migrations/` documents (find it in Step 1)

**Interfaces:** none.

- [ ] **Step 1: Find the ledger this repo keeps**

Run: `grep -rln "| 053 |" supabase/ docs/ claude/ 2>/dev/null`

Recent history (`bfff8a8 docs(migrations): reconcile 031 and 037-040 against production`) shows this repo tracks applied migrations in a ledger, and CLAUDE.md records that the ledger has drifted from the live database before. Add a 057 row saying what it does and that it is **not yet applied**.

- [ ] **Step 2: Record the trigger deviation in the spec**

In the design doc's architecture section, replace the "Rewrite the four insert paths" bullet with the trigger, and state the residual race it accepts. The spec is the document a teammate reads first; leaving it describing an approach the code does not take is worse than not having written it.

- [ ] **Step 3: Commit**

```bash
git add docs supabase
git commit -m "docs: record 057 and the dedupe-trigger deviation"
```

---

## Applying the migration

Task 1 writes the migration; **nothing in this plan applies it**. Every UI and daemon test runs against fixtures or a mocked backend, so the whole plan is verifiable without touching production.

A human applies 057 and then runs the verify block at its foot. Until it is applied:

- `POST /api/team/set-display-name` fails with a PostgREST "function not found" error, which the route surfaces as a 500. Not a 409, so nothing is silently mistaken for a collision.
- Nothing else regresses — no existing path calls the new function, and the trigger does not exist yet.

## Self-Review

**Spec coverage.** Every section maps to a task: data model → 1; RPC → 1; daemon and HTTP → 2, 3; UI → 6, 7; avatar rendering → 5; audit → 3; verification → each task's test steps. The spec's one uncovered claim is the four-RPC rewrite, deliberately replaced by the trigger and recorded in Task 8 Step 2.

**Types.** `setDisplayName(name, avatar)` returns `{ displayName, avatar }` in `DataClient`, `LocalDaemonClient` and `FakeDataClient`; the daemon's `teamsync.setDisplayName` returns `{ displayName, avatar, teams }` and the route forwards it whole. `Member.avatar` and `TeamAccount.user.avatar` are both `string | null`. `AVATAR_KEYS` is consumed by `isAvatarKey` (Task 5) and the picker (Task 6) under that one name.

**Conventions verified against the source, not assumed.** An earlier draft of this plan invented a `startJsonMock` fixture and guessed at three UI conventions. All four were wrong, and all four are now checked:

| Assumed | Actual |
|---|---|
| A hand-rolled JSON mock for the backend | `test/mock-supabase.js` — 1515 lines modelling each RPC's real semantics, which every team suite already uses |
| `errorMessage` imported from a shared module | No shared export exists; `Shell.tsx:88`, `InsightsPage.tsx:22` and `DaemonGroup.tsx:11` each keep a local copy |
| A `.dialog-label` class | Does not exist. The field pattern is `.dialog-field` wrapping `.dialog-field-hint` and `.dialog-input` (`TeamGroup.tsx:46-50`) |
| `renderApp({ authenticated: false })` | `FakeOptions` has no such flag; a `FakeDataClient` subclass overriding `getTeamAccount` is the pattern (`FirstRunClient` in `Shell.test.tsx`) |

**One step still ends in a judgement call:** Task 3 Step 2 tells the implementer to match how neighbouring routes obtain `teamId` for `recordAudit`, because `/api/team/rename` reads it from the request body and this route has no team in its body. That is a real choice between existing patterns, not a gap.

**Residual risks, restated in one place.** Two simultaneous joins under one name produce a join error rather than a suffix bump (see the deviation note). The 10-day grace period is exercised only by 057's verify block against a real database — no suite covers it. Neither is a defect to be discovered later; both are choices recorded here.
