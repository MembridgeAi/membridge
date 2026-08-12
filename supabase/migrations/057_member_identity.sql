-- 057_member_identity.sql — let a person rename themselves, with display
-- names unique within each team they belong to, plus a per-membership
-- avatar choice.
--
-- ===========================================================================
-- NOT APPLIED. Hand this to a human to run; nothing in this session has
-- touched any database.
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
revoke execute on function public.unique_member_name(uuid, text) from public, anon;
grant  execute on function public.unique_member_name(uuid, text) to service_role;
revoke execute on function public.team_members_dedupe_name() from public, anon;
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
--   select proname, prosecdef, proconfig from pg_proc
--    where proname in ('set_display_name','unique_member_name',
--                      'team_members_dedupe_name');
--   -- expect prosecdef = true and a search_path in proconfig for all three
