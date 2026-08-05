-- 029_materialize_project_access.sql — make "New members join with access"
-- mean what its label says.
--
-- THE PROBLEM 028 LEFT BEHIND. 028 made can_see_project consult
-- projects.default_access whenever a member has no explicit project_access
-- row. That is correct enforcement of the wrong scope: nothing in this product
-- ever materialized a row, so "no row" is the state of EVERY existing member,
-- including the team owner. Turning the toggle off therefore revoked the whole
-- team retroactively — including the person who flipped the switch — while the
-- label promises it governs new arrivals only.
--
-- THE FIX IS NOT ANOTHER PREDICATE REWRITE. Make "no row" stop being the
-- normal state. Once every (member, project) pair has an explicit row, the
-- project-level flag is consulted only for people who arrive later, which is
-- exactly its advertised scope. Three parts: backfill what exists (§4),
-- materialize on join (§2), materialize on project creation (§3).
--
-- WHY NOT TIMESTAMP GRANDFATHERING. A `default_access_set_at` column compared
-- against team_members.joined_at needs no row writes and reads elegant, but it
-- cannot survive the flag being toggled twice: flip off, someone joins, flip
-- on, flip off again, and the timestamp has moved past their joined_at, so a
-- member who joined while the project was closed is silently grandfathered
-- into access. Timing-based grandfathering is not a function of the member's
-- state, only of the flag's history. Materialized rows are.
--
-- WHAT 028's TIER 2 BECOMES. can_see_project keeps all three tiers and this
-- migration does not touch it. But tier 2 (fall through to default_access)
-- changes ROLE: before this migration it was the main path for every existing
-- member; after it, every member has a row, so tier 2 is reached only when a
-- row is missing for some reason this migration did not anticipate — a
-- SAFETY NET, and one that fails closed on a project whose default is off.
-- Deliberately kept, not removed: a missing row on a closed project must not
-- read as permission.
--
-- ---------------------------------------------------------------------------
-- THIS MIGRATION WRITES ROWS. Every other migration in this series was
-- `create or replace` and `alter ... add column if not exists` — inert until
-- something called them. §4 below INSERTs. It is idempotent and it never
-- overwrites, but it is a different risk class, and it must not be applied
-- without explicit human agreement to THIS migration specifically.
-- ---------------------------------------------------------------------------
--
-- HOW TO APPLY — SQL EDITOR ONLY, AND NEVER `supabase db push` IN THIS PROJECT.
-- Paste 028 into the Supabase SQL editor (which runs it in one transaction) and
-- run it, then paste this file and run it. 028 first, then 029: 028 alone is a
-- control that does not match its label, and 029 alone materializes rows nothing
-- consults. Every statement below is re-runnable.
--
-- `db push` must not be used here. supabase_migrations.schema_migrations holds
-- only TWO rows, so none of the repo's numbered files is recorded as applied and
-- a push would attempt all thirty-plus against a database that already has most
-- of their effects — including 030 and 031, which are a separate unreviewed
-- ticket, and including §4 below, which WRITES ROWS. Apply by hand, one file at
-- a time.
--
-- WHY THESE INSERTS ARE NOT BLOCKED BY RLS. project_access_insert requires
-- is_team_manager(team_id) (024:77-79), and a plain member joining a team is
-- not a manager. Every insert below runs either in this migration (as the
-- table owner) or inside an existing `security definer` function, which
-- executes as the function owner and so bypasses RLS on tables it owns. That
-- is load-bearing: if join_team / redeem_invite / link_project were ever
-- changed to `security invoker`, these inserts would start failing for
-- exactly the callers that need them.

-- ---------------------------------------------------------------------------
-- 1. Membership paths audited, not assumed. Every function that can add a row
-- to public.team_members was enumerated from the migration history:
--
--   * public.join_team          (schema.sql:155, current body 003:11)  -> §2
--   * public.redeem_invite      (002:135, current body 010:246)        -> §2
--   * public.create_team        (schema.sql:135)  -> NO CHANGE. It creates the
--     team and its first member in the same statement, so the team has zero
--     projects at that instant; there is nothing to materialize. §3 covers the
--     owner when they later link their first project.
--   * public.redeem_onboarding_invite (021:183, current body 023:22) -> NO
--     CHANGE, and this one is worth stating because it LOOKS like a join path.
--     It does not add a member to an existing team: it calls create_team and
--     the redeemer becomes owner of a brand-new team. Same zero-project
--     argument as create_team.
--
-- Paths that REMOVE membership (remove_member 002:179, leave_team 002:252)
-- need no change either — see §5.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 2. Materialize on join. Bodies restated verbatim from their current
-- definitions (003:11 for join_team, 010:246 for redeem_invite) with ONLY the
-- project_access insert added, so this file remains the whole truth about
-- these functions without reaching back to edit 003 or 010.
--
-- ONE `insert ... select`, never a loop: a team with 40 shared projects must
-- not turn a join into 40 statements.
--
-- `on conflict do nothing` is deliberately BARE here rather than naming
-- (team_id, project_key, member_id). Both of these functions declare
-- `returns table (team_id uuid, ...)`, which makes team_id a PL/pgSQL
-- variable, and the conflict target is an expression context — so naming it
-- reproduces exactly the `column reference "team_id" is ambiguous` failure
-- that 003_fix_join_ambiguity.sql exists to fix. The bare form is equivalent
-- because (team_id, project_key, member_id) is project_access's primary key
-- and its only unique constraint (024:24-40) — the same argument 003's own
-- header makes for team_members. §3 and §4 are not inside such a function, so
-- they name the target explicitly.
--
-- can_see is taken from each project's default_access AT THIS MOMENT, which is
-- the entire point: the flag's value when someone joins is what governs them,
-- and it is recorded rather than re-read later.
-- ---------------------------------------------------------------------------
create or replace function public.join_team(p_code uuid, p_display_name text)
returns table (team_id uuid, team_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_team from public.teams where teams.invite_code = p_code;
  if v_team.id is null then
    raise exception 'invalid invite code';
  end if;
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  -- 029: record this member's access to every project the team already shares,
  -- from each project's default at this instant.
  insert into public.project_access (team_id, project_key, member_id, can_see)
    select p.team_id, p.id::text, auth.uid(), p.default_access
      from public.projects p
      where p.team_id = v_team.id
    on conflict do nothing;
  return query select v_team.id, v_team.name;
end;
$$;

create or replace function public.redeem_invite(p_token text, p_display_name text)
returns table (team_id uuid, team_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_team public.teams;
  -- 029: FOUND is set by the most recent INSERT/UPDATE/DELETE, so the
  -- project_access insert added below would clobber it before the use_count
  -- update reads it — turning "this join burned a use" into "the last access
  -- row was new", which is a different question with a different answer. The
  -- membership result is captured the instant it is produced instead of being
  -- read three statements later.
  v_joined boolean;
begin
  perform public.check_invite_attempt();
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_invite from public.invites where invites.token = p_token;
  if v_invite.token is null then
    raise exception 'invalid invite link';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'this invite link has been revoked';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    raise exception 'this invite link has expired';
  end if;
  if v_invite.max_uses is not null and v_invite.use_count >= v_invite.max_uses then
    raise exception 'this invite link has already been used';
  end if;
  select * into v_team from public.teams where id = v_invite.team_id;
  -- Never grants more than member; joining twice is a no-op, not a burn.
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  v_joined := found;
  -- 029: same materialization as join_team above. Runs on a repeat redeem too,
  -- where `on conflict do nothing` makes it a no-op — a member whose rows
  -- already exist must not have them rewritten from the current default.
  insert into public.project_access (team_id, project_key, member_id, can_see)
    select p.team_id, p.id::text, auth.uid(), p.default_access
      from public.projects p
      where p.team_id = v_team.id
    on conflict do nothing;
  if v_joined then
    update public.invites set use_count = use_count + 1
      where invites.token = p_token;
  end if;
  return query select v_team.id, v_team.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. link_project — the writer that is easy to forget, and the one that would
-- have reintroduced the bug on its own. A project created AFTER members
-- already exist gives those members no row, so they would fall through to
-- tier 2 and be governed by a flag that was never meant to apply to them.
--
-- THE INVARIANT THIS BUYS IS A CLIENT CONVENTION, NOT A SCHEMA CONSTRAINT.
-- Nothing forces a project to be created through this RPC: the live
-- `projects_insert` policy lets an ordinary team member POST straight to
-- /rest/v1/projects, creating a projects row without ever calling link_project
-- and therefore without materializing a single access row. Every member is then
-- row-less on that project and governed by tier 2 — the retroactive behaviour
-- this migration exists to remove. So "every (member, project) pair has a row"
-- holds only for as long as callers use the RPC; it is not enforced anywhere.
-- Deliberately NOT chased here (a trigger on public.projects, or tightening
-- projects_insert, is a different change with its own blast radius) — it is its
-- own ticket. Do not widen this migration to cover it.
--
-- Materializes unconditionally, not only on the create branch: on the
-- adopt-existing branch every current member's row already exists and the
-- insert is a no-op, so running it either way costs nothing and closes the
-- gap where a project was created before this migration and is re-linked
-- after it.
--
-- team_id and can_see are both read from the PROJECT row rather than from
-- p_team / a literal, so they cannot disagree with the project they describe.
-- Body restated verbatim from schema.sql:182 with only the insert added.
-- ---------------------------------------------------------------------------
create or replace function public.link_project(p_team uuid, p_name text, p_repo_url text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_team_member(p_team) then
    raise exception 'not a member of this team';
  end if;
  if p_repo_url is not null and p_repo_url <> '' then
    select id into v_id from public.projects
      where team_id = p_team and repo_url = p_repo_url;
  end if;
  if v_id is null then
    select id into v_id from public.projects
      where team_id = p_team and name = p_name;
  end if;
  if v_id is null then
    insert into public.projects (team_id, name, repo_url, created_by)
      values (p_team, p_name, nullif(p_repo_url, ''), auth.uid())
      returning id into v_id;
  end if;
  -- 029: every current member of the team gets an explicit row for this
  -- project. No `returns table` here, so the conflict target is named.
  insert into public.project_access (team_id, project_key, member_id, can_see)
    select pr.team_id, pr.id::text, m.user_id, pr.default_access
      from public.projects pr
      join public.team_members m on m.team_id = pr.team_id
      where pr.id = v_id
    on conflict (team_id, project_key, member_id) do nothing;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. THE BACKFILL — the only data write in this series.
--
-- One row per (existing member, existing shared project) pair that has none,
-- with can_see taken from that project's current default_access. Since every
-- project's default_access is currently true, this records today's EFFECTIVE
-- access explicitly and changes nothing observable: it is a no-op in behaviour
-- and a prerequisite in state.
--
-- SAFE TO RUN TWICE, AND NEVER DESTRUCTIVE. `on conflict ... do nothing` on
-- the primary key (team_id, project_key, member_id) — confirmed against
-- 024:24-40, where it is the table's declared primary key and its only unique
-- constraint. There is no `do update` and no `update` anywhere in this file,
-- so a deliberate `can_see = false` written by an admin can never be
-- overturned by re-running this migration, and neither can a `true`.
--
-- ARCHIVED PROJECTS ARE INCLUDED ON PURPOSE. project_stats and team_feed both
-- filter `archived_at is null`, so an archived project is invisible either
-- way and backfilling it appears pointless. But archive is a SOFT delete with
-- unarchive_project (005) as its inverse: skipping archived projects would
-- leave every member row-less on them, so an unarchive would drop the whole
-- team back into tier 2 and re-expose exactly the retroactive behaviour this
-- migration removes. The cheap rows are worth the closed hole.
--
-- The cross product is bounded by (members x projects) per team, inserted in
-- one statement. `updated_by` is deliberately left NULL: no human made this
-- choice, and stamping a real user id here would put a name in the audit
-- surface next to a decision they did not make.
-- ---------------------------------------------------------------------------
insert into public.project_access (team_id, project_key, member_id, can_see)
  select p.team_id, p.id::text, m.user_id, p.default_access
    from public.projects p
    join public.team_members m on m.team_id = p.team_id
  on conflict (team_id, project_key, member_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. REMOVAL: no change, and here is the decision.
--
-- remove_member (002:179) and leave_team (002:252) both `delete from
-- public.team_members`, and project_access carries
-- `foreign key (team_id, member_id) references public.team_members
-- (team_id, user_id) on delete cascade` (024:38-39). So a departed member's
-- access rows are ALREADY deleted, by the schema, with no RPC change. That
-- cascade is kept rather than dropped, for two reasons: the rows are
-- meaningless without the membership they reference, and keeping them would
-- require dropping the FK that guarantees project_access never names a
-- non-member.
--
-- This is distinct from, and does not contradict, the rule that a departed
-- member's CONTRIBUTIONS are never deleted. memory_entries.author_id
-- references auth.users directly (schema.sql:46) and is untouched here; only
-- their permissions go.
--
-- THE CONSEQUENCE, NAMED RATHER THAN BURIED: because the rows vanish, a
-- re-joining member is treated as a new arrival and gets each project's
-- CURRENT default — they do not inherit an old grant. That is the desirable
-- half. The undesirable half is its mirror: they do not inherit an old
-- REVOKE either. If someone was explicitly revoked from project X, then later
-- removed from the team, then later re-invited while X's default is on, they
-- can see X again, and the admin re-inviting them gets no warning. The
-- deliberate revoke is not silently lost — team_audit still holds the
-- access-revoked event (024/025 §5, append-only) and the Project page grid
-- shows the current state — but nothing puts it in front of the person
-- re-inviting them at the moment it would matter. Not fixed here: doing it
-- properly means surfacing prior revokes at invite time, which is a product
-- change, not a migration.
-- ---------------------------------------------------------------------------
