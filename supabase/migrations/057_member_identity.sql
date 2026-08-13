-- 057_member_identity.sql — let a person rename themselves, with display
-- names unique within each team they belong to, plus a per-membership
-- avatar choice.
--
-- ===========================================================================
-- APPLIED 2026-08-13 to project mefgbiecvoszjorwzkfz, recorded in the
-- migration table as 20260813020145.
--
-- VERIFICATION OUTSTANDING. The apply reported success and the migration table
-- carries the row -- but that row is a LEDGER ENTRY, not a reading of the
-- catalog, and this repo's ledgers have been wrong in 13 of 17 rows. Nobody has
-- yet run the Verify block at the foot of this file; the session that applied
-- it had its catalog query blocked. Treat this as applied-unverified until
-- someone runs those queries, then replace this paragraph with the result.
-- ===========================================================================
--
-- WHY UNIQUENESS IS AN INDEX, NOT A CLIENT CHECK (OR EVEN A SERVER
-- PRE-CHECK). Two members can race to claim the same name: both read "free",
-- both write. A client-side or plpgsql "select ... where not exists" check
-- has a window between the check and the write that a second, concurrent
-- caller can land inside. The only thing that resolves that race to exactly
-- one winner is a constraint the database itself enforces atomically —
-- here, `team_members_display_name_unique`, a partial unique index over
-- (team_id, normalize_member_name(display_name)) restricted to rows that
-- still hold their name. `set_display_name` below DOES run a pre-check, but
-- it is explicitly a message-only convenience (it can name the team in the
-- error); the index is what actually decides, and the function's `exception
-- when unique_violation` handler is what turns a lost race into the same
-- MB001 the pre-check would have produced. Delete the pre-check and nothing
-- about correctness changes — delete the exception handler, and a lost race
-- surfaces as an unhandled `23505` instead of MB001, which is the
-- discipline this repo asks for explicitly: a check that only builds a nice
-- error message is not the enforcement mechanism, and must not be mistaken
-- for one.
--
-- WHY THE GRACE PERIOD NEEDS A COLUMN. A hard delete of a team_members row
-- would free its name for reuse immediately and for free, with no schema
-- change. But account deletion in this product is soft (053: auth.users.
-- deleted_at is set, the membership row survives) precisely so that
-- attribution on past work is not silently orphaned. That leaves a name
-- pinned forever by an account nobody can log into again unless something
-- explicitly lets it go. A partial index predicate has to be IMMUTABLE, so
-- "deleted more than 10 days ago" cannot live in the index predicate itself
-- — `now()` is not immutable and the 10-day grace window is not a fact
-- about the row alone. So the grace period is expressed as a plain nullable
-- column, `name_released_at`: null means this row still holds its name
-- against everyone else on the team, non-null means it has let go (either
-- because it renamed away, or because `set_display_name` lazily noticed the
-- previous holder is a long-gone deletion and released it on their behalf).
-- The 10-day wait itself is computed at call time in `set_display_name`,
-- comparing `auth.users.deleted_at` against `now() - interval '10 days'`;
-- the column only ever records the outcome, never the rule.
--
-- THE TRIGGER DEVIATION. Every existing insert path into team_members
-- (create_team, join_team, redeem_invite, redeem_onboarding_invite, and
-- anything added later) already writes a caller-supplied display_name with
-- no dedupe step, so a fresh insert can collide with an existing member
-- under the new unique index and abort the transaction outright. Rather
-- than teach every insert site the suffixing rule, `team_members_dedupe_name`
-- is installed as a `before insert` trigger and calls the same
-- `unique_member_name` helper `set_display_name` would use, so an insert
-- that would collide is silently suffixed (" 2", " 3", ...) instead of
-- failing. This is a deliberate asymmetry: a NEW member never sees an error
-- for a name they did not choose deliberately (it was often a default from
-- an OAuth provider or invite flow), but an EXISTING member who explicitly
-- asks to rename to a taken name gets told so via MB001 rather than being
-- silently suffixed — silently renaming a person who typed a specific name
-- and clicked save would be surprising in a way that silently renaming a new
-- joiner is not.
--
-- WHY BOTH unique_member_name AND set_display_name TAKE AN ADVISORY LOCK,
-- AND WHY IT LOOKS GRATUITOUS.
-- Four join paths (schema.sql's join_team, 003, 010's redeem_invite, 038's
-- redeem_invite, 029's redeem_onboarding_invite) all insert into
-- team_members with a BARE, UNTARGETED `on conflict do nothing` -- bare
-- because naming team_id as a conflict target is ambiguous with the OUT
-- column of the same name (003's fix). An untargeted `on conflict do
-- nothing` absorbs ANY unique violation on the table, not only the one it
-- was written for (the composite PK, so a double-join is a no-op). Once this
-- file adds a SECOND unique constraint, it is also silently absorbed by the
-- same clause in all four places -- and every one of those RPCs still
-- returns the team as successfully joined afterwards, which is exactly this
-- codebase's characteristic bug: a fail-open path paired with an
-- unconditional success flag.
--
-- The concrete race: two people redeem invites into the same team at the
-- same moment with the same display name. Both BEFORE INSERT triggers fire
-- before either transaction commits, so neither sees the other's row; both
-- independently compute "Marco 2". The loser's INSERT hits
-- team_members_display_name_unique, `on conflict do nothing` swallows it,
-- and the RPC reports success to someone who is not actually a member.
--
-- Fixing this by rewriting all four RPC bodies (naming the new index as an
-- additional `on conflict` arm, or checking FOUND) would spread the fix
-- across files this migration does not otherwise touch, for a race that is
-- entirely about how NAMES get assigned -- which already lives here. Instead
-- `unique_member_name` opens with `pg_advisory_xact_lock`, keyed on the team:
-- every insert into that team's roster, from any of the four paths, now
-- serializes on name assignment. The second joiner's trigger simply blocks
-- until the first transaction commits, then re-reads the now-committed
-- roster and computes "Marco 3" instead of colliding. The lock is
-- transaction-scoped (`_xact_`), so it releases automatically at commit or
-- rollback -- nothing to clean up, and no risk of a stuck lock outliving its
-- transaction. It will look gratuitous to a future reader because nothing
-- nearby appears to need it; it is the only thing standing between a bare
-- `on conflict do nothing` four call sites away and a member who is told
-- they joined a team that, underneath them, they did not.
--
-- unique_member_name's lock only covers INSERTs, and it is not the only
-- writer of display_name -- set_display_name (an existing member renaming)
-- is the other one, and it takes no lock of its own. A rename committing
-- while a joiner sits between its trigger's not-exists probe and its INSERT
-- reopens the identical race from the other direction. So set_display_name
-- takes the same per-team lock too, for every team the caller belongs to,
-- before it writes -- see the comment at its call site for why the lock
-- order there is `order by team_id` rather than arbitrary. The guarantee
-- that an INSERT's name is collision-free by the time it runs (leaned on by
-- the comments in schema.sql's join_team and 010's redeem_invite) rests on
-- BOTH writers taking this lock, not on unique_member_name's alone -- a
-- future change to either one that drops its lock reopens the race this
-- section describes.
--
-- Re-runnable: every function is `create or replace`, every column addition
-- is `add column if not exists`, the constraint and trigger are dropped
-- before being recreated, and the unique index is `create ... if not
-- exists`. Grants are restated for the same reason 042 restates them: a
-- fresh `create or replace function` does not reset an existing ACL, but
-- nothing here relies on that — the revoke/grant pair is written so this
-- file is correct whether it is the first run or the tenth.
-- ===========================================================================

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
--    avatar_color: a second, independent choice (glyph x background color,
--    15 glyphs x 10 token colors per the UI). Null means "use the color
--    colorForId already derives from my user id" -- the same shape as null
--    avatar, and for the same reason: a caller has to be able to say "go
--    back to my derived color" as an explicit act, not merely by omitting
--    the field, which is why set_display_name assigns it directly below
--    rather than coalescing.
--    name_released_at: non-null means this row no longer holds its name
--    against anyone. A partial index predicate must be immutable, so the
--    10-day grace period cannot live in the predicate -- it is expressed by
--    the RPC stamping this column when it meets an expired name.
alter table public.team_members
  add column if not exists avatar text,
  add column if not exists avatar_color text,
  add column if not exists name_released_at timestamptz;

alter table public.team_members drop constraint if exists team_members_avatar_shape;
alter table public.team_members add constraint team_members_avatar_shape
  check (avatar is null or avatar ~ '^[a-z0-9-]{1,32}$');

alter table public.team_members drop constraint if exists team_members_avatar_color_shape;
alter table public.team_members add constraint team_members_avatar_color_shape
  check (avatar_color is null or avatar_color ~ '^#[0-9A-Fa-f]{6}$');

-- 3. READ SIDE. team_members_list (053) predates avatar/avatar_color and
--    still returns only (user_id, display_name, role, joined_at,
--    deleted_at) -- confirmed against the function actually on file, not
--    assumed. Without this, the columns section 2 just added are write-only:
--    a member picks an avatar, set_display_name (section 8 below) reports it
--    back to THEM, but the roster every OTHER screen reads (GET
--    /api/team/members, the members RPC every non-self avatar renders from)
--    never sees it -- production would silently fall back to initials for
--    every teammate but yourself. test/mock-supabase.js's stand-in already
--    returns both columns (it was written ahead of this fix), so without
--    this the test suite certifies a shape the real function does not have.
--
--    `create or replace` cannot change a RETURNS TABLE column list --
--    Postgres treats that as an incompatible redefinition, the same
--    constraint 053's own header explains for why IT had to drop first to
--    add deleted_at. So this drops and recreates too. The body below is
--    053's, verbatim, with only `m.avatar` and `m.avatar_color` added to the
--    return signature and the select list -- the left join onto auth.users
--    and its deleted_at semantics are load-bearing (053 §2) and are not
--    being redesigned here.
drop function if exists public.team_members_list(uuid);

create or replace function public.team_members_list(p_team uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  joined_at timestamptz,
  deleted_at timestamptz,
  avatar text,
  avatar_color text
)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, m.display_name, m.role, m.joined_at, u.deleted_at, m.avatar, m.avatar_color
  from public.team_members m
  -- left join: a member whose auth.users row is genuinely gone keeps their
  -- row here with a null deleted_at (read as live) rather than disappearing
  -- from every roster in the product. See 053 §2 of its header.
  left join auth.users u on u.id = m.user_id
  where m.team_id = p_team and public.is_team_member(p_team)
  order by m.joined_at;
$$;

-- DROP FUNCTION destroyed the ACL again; restate it, the same shape 053 and
-- 035 both use -- never public/anon, always the two roles that need it.
revoke execute on function public.team_members_list(uuid) from public, anon;
grant execute on function public.team_members_list(uuid) to authenticated, service_role;

-- 4. SUFFIX HELPER. security definer is REQUIRED, not defensive: at join time
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
  -- Transaction-scoped advisory lock, keyed on the team. See the header's
  -- "WHY BOTH unique_member_name AND set_display_name TAKE AN ADVISORY LOCK"
  -- section: this serialises name assignment per team so two concurrent
  -- joins cannot both compute the same suffix and race a bare `on conflict
  -- do nothing` four call sites away. Released automatically at transaction
  -- end (commit or rollback).
  perform pg_advisory_xact_lock(hashtextextended(p_team::text, 0));

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
      -- Does not re-test not-exists before returning, which would normally
      -- be a gap -- a 100th concurrent caller could theoretically still
      -- collide. Safe here specifically BECAUSE of the lock above: every
      -- other insert into this team is blocked until this transaction ends,
      -- so nothing else can claim a name while this function is running,
      -- and the appended UUID makes a same-transaction self-collision
      -- practically impossible.
      return left(v_base, 71) || ' ' || substr(gen_random_uuid()::text, 1, 8);
    end if;
    v_try := left(v_base, 80 - (char_length(n::text) + 1)) || ' ' || n::text;
  end loop;
  return v_try;
end;
$$;

-- 5. TRIGGER. Every insert path -- create_team, join_team, redeem_invite,
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

-- 6. PRE-RELEASE LEGACY DUPLICATES. Production held zero duplicates when this
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

-- 7. THE CONSTRAINT. This, not any check in any function, is what makes two
--    simultaneous claims resolve to one winner.
create unique index if not exists team_members_display_name_unique
  on public.team_members (team_id, public.normalize_member_name(display_name))
  where name_released_at is null;

-- 8. THE RPC. Dropped first, not just replaced: p_avatar_color made this a
--    three-argument function, and `create or replace` cannot change a
--    function's SIGNATURE (only its body) -- Postgres treats a different
--    argument list as a different function. Without this drop, a database
--    that already ran this file's earlier two-argument revision would end
--    up with BOTH signatures live: the new three-argument one AND the old
--    two-argument one, still carrying its own `grant ... to authenticated`
--    from before. A PostgREST call with two arguments would keep resolving
--    to the stale function, which echoes its input instead of reporting
--    what was written -- the exact bug this migration's second revision
--    removed, still reachable through the old signature. Production has
--    never applied this file, so this only matters for a dev database that
--    ran an earlier revision, but the file has to be correct for that case
--    too.
--
-- THE AUDIT ROW IS WRITTEN HERE, NOT BY THE DAEMON. team_audit's insert
-- policy is `is_team_manager(team_id) and actor_id = auth.uid()` (024 §5,
-- tightened by 025 §5) -- manager-only. Renaming yourself is self-service for
-- EVERY member, so for any non-manager a daemon-side
-- `apiAccess.recordAudit` call would be refused by RLS and swallowed by
-- design (lib/api-access.js), landing a 200 with no audit row anywhere. Same
-- finding as 046's, on a different route: a fail-open path under an
-- unconditional success. `POST /api/team/delete-my-data` already avoids this
-- the same way (035 §3, lib/server.js) -- writing the row inside the
-- definer RPC's own transaction is the only way to log an action a plain
-- member is allowed to take on themself.
--
-- ONE ROW PER AFFECTED TEAM, not one row filed under an arbitrary "first"
-- team: this function is the only actor that knows which teams were
-- actually written (the UPDATE below touches every membership at once), and
-- a single row under one team would leave every OTHER team's log silent
-- about a rename its own roster shows. Written from inside the same
-- statement as the UPDATE (the FOR loop below iterates its RETURNING
-- output), so an audit row cannot exist for a rename that rolled back --
-- and cannot be missing for one that committed.
--
-- object_key is auth.uid()::text -- the member's user id, never the display
-- name -- matching the sibling convention at lib/server.js's member-removed
-- and role-changed audit calls. Keying the row on the value that just
-- changed would make it unjoinable against itself.
--
-- detail carries BOTH the generic memberId/targetName shape 046 and 049
-- already write (so lib/api-access.js readAudit's actor/target resolution
-- works on this action without a special case) AND an explicit oldName,
-- because "who was this person before" is the entire reason this row
-- exists and targetName alone (the new name) cannot answer it. oldName is
-- read from v_old_names, snapshotted from team_members BEFORE the UPDATE --
-- the only moment that value is still in the database, the same reasoning
-- 049's trigger gives for reading OLD off a row it is about to lose.
drop function if exists public.set_display_name(text, text);

create or replace function public.set_display_name(
  p_name text, p_avatar text default null, p_avatar_color text default null
)
returns table (display_name text, avatar text, avatar_color text, teams int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name  text := btrim(coalesce(p_name, ''));
  v_norm  text;
  v_clash text;
  v_count int;
  v_display_name text;
  v_avatar text;
  v_avatar_color text;
  -- team_id::text -> the name this row held BEFORE the rename, snapshotted
  -- just before the UPDATE below overwrites it. See the audit block after
  -- the UPDATE for why this cannot be read any later.
  v_old_names jsonb;
  r record;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'a display name must be between 1 and 80 characters'
      using errcode = 'MB002';
  end if;
  if p_avatar is not null and p_avatar !~ '^[a-z0-9-]{1,32}$' then
    raise exception 'unrecognised avatar' using errcode = 'MB002';
  end if;
  if p_avatar_color is not null and p_avatar_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'unrecognised avatar color' using errcode = 'MB002';
  end if;
  v_norm := public.normalize_member_name(v_name);

  -- Lazy release of names held by accounts soft-deleted more than 10 days
  -- ago. Deletion sets auth.users.deleted_at and LEAVES THE ROW (053),
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

  -- unique_member_name's advisory lock (see the header) only serialises
  -- INSERTs -- new joiners -- against each other. This UPDATE is the OTHER
  -- writer of display_name, and without taking the same lock, a rename
  -- committing here could still land between a joiner's trigger computing a
  -- name and that joiner's INSERT: the joiner's not-exists probe would read
  -- as free, this rename commits the same normalized name first, and the
  -- joiner's INSERT then hits team_members_display_name_unique -- swallowed
  -- by the same bare `on conflict do nothing` this file's header already
  -- describes, reporting a join that did not happen. So this function takes
  -- the identical per-team lock, for every team the caller belongs to,
  -- before writing.
  --
  -- `order by team_id` is load-bearing, not decoration: pg_advisory_xact_lock
  -- is not reentrant-safe across a set acquired in different orders, so two
  -- callers each renaming across two teams they share (A, B) must acquire A
  -- then B in BOTH sessions -- acquiring A,B in one and B,A in the other is
  -- the textbook lock-ordering deadlock. Sorting by team_id gives every
  -- caller the same order regardless of which teams they happen to belong
  -- to. A joiner only ever takes one lock (their own team), so it can never
  -- be the second half of a cycle.
  perform pg_advisory_xact_lock(hashtextextended(t.team_id::text, 0))
     from (select team_id from public.team_members
            where user_id = auth.uid() order by team_id) t;

  -- Snapshot every team's CURRENT name before the UPDATE below overwrites
  -- it -- read while this call already holds the per-team locks above, so
  -- nothing else can rename the caller between this read and the write.
  -- This is the only remaining place the pre-rename name exists; once the
  -- UPDATE runs, the audit block below has no other way to learn it.
  select coalesce(jsonb_object_agg(m.team_id::text, m.display_name), '{}'::jsonb)
    into v_old_names
    from public.team_members m
   where m.user_id = auth.uid();

  -- One statement, so every team is updated atomically: a collision in any
  -- single team rolls back the rename in all of them. Assigning p_avatar and
  -- p_avatar_color directly (not coalesce) is deliberate -- null is the
  -- "just my initial" / "just my derived color" choice, and coalescing
  -- would make that choice unexpressible. name_released_at resets so a
  -- previously-released name is re-protected.
  --
  -- FOR ... IN UPDATE ... RETURNING, not a bare `update ... returning ...
  -- into`: PL/pgSQL's INTO without STRICT already takes the first row and
  -- discards the rest when several rows match (PL/pgSQL 43.5.3), which was
  -- fine when the only job was picking a representative value (every row
  -- gets the same literal display_name/avatar/avatar_color, so any one
  -- row's output is representative) -- but discarding the rest is now
  -- wrong, because every row is also a team this rename must be audited
  -- against. The loop visits each updated row once, so it both accumulates
  -- the representative OUT values (v_display_name/v_avatar/v_avatar_color,
  -- reassigned identically on every iteration) and writes that team's own
  -- audit row -- see the header block above this function for why the
  -- write happens here and not in the daemon, and why it is one row per
  -- team rather than one overall.
  v_count := 0;
  for r in
    update public.team_members m
       set display_name = v_name, avatar = p_avatar, avatar_color = p_avatar_color,
           name_released_at = null
     where m.user_id = auth.uid()
     returning m.team_id, m.display_name, m.avatar, m.avatar_color
  loop
    v_count := v_count + 1;
    v_display_name := r.display_name;
    v_avatar := r.avatar;
    v_avatar_color := r.avatar_color;
    insert into public.team_audit (team_id, actor_id, action, object_type, object_key, detail)
    values (
      r.team_id,
      auth.uid(),
      'member-renamed',
      'member',
      auth.uid()::text,
      jsonb_build_object(
        'memberId', auth.uid()::text,
        'targetName', r.display_name,
        'oldName', v_old_names ->> r.team_id::text,
        'newName', r.display_name,
        'avatar', r.avatar,
        'avatarColor', r.avatar_color
      )
    );
  end loop;

  -- Zero rows is NOT an error: it is the signed-in-with-no-team case -- and
  -- with no rows, the loop above wrote no audit rows either, correctly:
  -- there is no team to file one against.
  return query select v_display_name, v_avatar, v_avatar_color, v_count;
exception
  when unique_violation then
    raise exception 'somebody on your team is already called %', v_name
      using errcode = 'MB001';
end;
$$;

-- 9. GRANTS (042). A newly created function is EXECUTE-able by PUBLIC by
--    default, which means callable with the anon key. Signature is
--    (text, text, text) now that p_avatar_color joined p_name/p_avatar.
revoke execute on function public.set_display_name(text, text, text) from public, anon;
grant  execute on function public.set_display_name(text, text, text) to authenticated;

-- unique_member_name and team_members_dedupe_name are deliberately NOT granted
-- to authenticated, unlike set_display_name above. unique_member_name takes a
-- caller-supplied team id with no membership check on it (by design -- see
-- its own header comment: at join time the caller is not yet a member, so a
-- membership check would always read false). Granting it to authenticated
-- would turn it into a cross-team oracle: any signed-in user could call it
-- directly with any team's uuid and learn, one guessed name at a time,
-- whether that name is already taken on a team they do not belong to. It
-- only needs to be callable from INSIDE team_members_dedupe_name's trigger
-- body, and a security definer function's internal calls run as ITS OWNER,
-- not as the original caller, so the trigger already has everything it needs
-- without authenticated (or anyone else) holding EXECUTE directly. The grant
-- to service_role below exists only so this migration satisfies the same
-- "every guarded function restates a grant" rule 042 established (enforced
-- by test/suites/migration-state.test.js) without handing either function to
-- a role that could actually call it -- service_role bypasses every
-- protection in this schema already (see supabase/APPLY-RUNBOOK.md's closing
-- section), so an explicit grant to it discloses nothing new.
--
-- THE REVOKE BELOW ALSO NAMES authenticated, ADDED AFTER THIS FILE WAS
-- ALREADY APPLIED TO PRODUCTION. The original revoke here named only
-- `public, anon` -- the two roles this repo usually reasons about -- but
-- Supabase's default privileges separately grant EXECUTE on every newly
-- created public-schema function to `authenticated`, independently of
-- anything this file writes, and the original line never named that role.
-- Verified live 2026-08-13: both functions were callable by `authenticated`
-- in production, reopening exactly the cross-team name-enumeration oracle
-- the paragraph above describes, through the one role the revoke forgot.
-- Because 057 was ALREADY APPLIED (migration-table row 20260813020145)
-- before this was noticed, editing the SQL in this file cannot retroactively
-- change what is live -- a migration file is a record of what ran, not a
-- lever on the present. `059_revoke_unique_member_name_authenticated.sql` is
-- the new statement that actually closes this in production; its header has
-- the full explanation and the live-verification query. The revoke below is
-- updated anyway, for the next database this file runs against from
-- scratch: revoking a privilege that was never granted is a harmless no-op,
-- so a database where 059 has already run is unaffected, and a FRESH
-- database that only ever runs 057 now gets the correct ACL immediately
-- instead of inheriting the same gap 059 exists to close.
revoke execute on function public.unique_member_name(uuid, text) from public, anon, authenticated;
grant  execute on function public.unique_member_name(uuid, text) to service_role;
revoke execute on function public.team_members_dedupe_name() from public, anon, authenticated;
grant  execute on function public.team_members_dedupe_name() to service_role;

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
--   select column_name, data_type from information_schema.columns
--    where table_name = 'team_members' and column_name = 'avatar_color';
--   -- expect one row, data_type 'text'
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'team_members_avatar_color_shape';
--   -- expect the check to reference '^#[0-9A-Fa-f]{6}$'
--
--   -- team_members_list must carry the two new columns too, not just the
--   -- table -- this is the read side the roster (GET /api/team/members)
--   -- actually calls, and it is a SEPARATE function from set_display_name.
--   select user_id, avatar, avatar_color
--     from public.team_members_list('<a team id you belong to>');
--   -- expect the avatar/avatar_color columns to be present in the result
--   -- (values null for anyone who has not picked one yet, which is correct)
--
--   select proname, prosecdef, proconfig from pg_proc
--    where proname in ('set_display_name','unique_member_name',
--                      'team_members_dedupe_name');
--   -- expect prosecdef = true and a search_path in proconfig for all three
--
--   -- Renaming a member of two teams must file ONE audit row PER TEAM, both
--   -- filed under the member's user id, not their name. Run as a member of
--   -- two teams (select set_display_name('New Name')), then:
--   select team_id, actor_id, object_key, detail->>'oldName' as old_name,
--          detail->>'newName' as new_name
--     from public.team_audit
--    where action = 'member-renamed' and object_key = auth.uid()::text
--    order by team_id;
--   -- expect one row per team that member belongs to, each with the same
--   -- object_key (the member's user id), the same new_name, and old_name
--   -- equal to whatever that team's row said before the call.
