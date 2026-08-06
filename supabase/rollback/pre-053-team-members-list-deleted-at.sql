-- pre-053-team-members-list-deleted-at.sql — restore public.team_members_list
-- to its pre-053 shape: four columns, no deleted_at, no join to auth.users.
--
-- Reconstructed from the LIVE function definition read out of pg_proc on
-- 2026-08-05 (`pg_get_functiondef`), not from a migration file, because
-- team_members_list has been redefined across several migrations and the repo
-- is not the authority on which one production is running. What is below is
-- what the database actually had.
--
-- ===========================================================================
-- SAFE TO RUN AT ANY TIME, unlike pre-052. Nothing here depends on data state:
-- 053 added a derived column and touched no rows, so removing it cannot fail
-- and cannot lose anything.
--
-- BUT IT SILENTLY REOPENS THE HOLE. Once this runs, every client filtering on
-- `deleted_at` sees the field absent, reads that as "live" (deliberately -- see
-- 053's header §"DEPLOY ORDER"), and a soft-deleted account is immediately
-- back on the roster, back in the access matrix, back in Insights, and back in
-- the recipient list for every new team key epoch. There is no error and no
-- log line; the protection just stops. If you roll this back, the operational
-- rule comes back with it: NEVER use the dashboard's soft delete -- use
-- "Remove from team" (remove_member).
-- ===========================================================================
--
-- Re-runnable. Grants restated for the same reason 053 restates them: DROP
-- FUNCTION destroys the ACL, and a bare CREATE picks up Postgres' default
-- PUBLIC grant plus Supabase's anon/authenticated defaults. The two lines
-- below reproduce the ACL read from pg_proc.proacl before 053 was written
-- (`postgres=X | authenticated=X | service_role=X` -- no PUBLIC, no anon).

drop function if exists public.team_members_list(uuid);

create or replace function public.team_members_list(p_team uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, m.display_name, m.role, m.joined_at
  from public.team_members m
  where m.team_id = p_team and public.is_team_member(p_team)
  order by m.joined_at;
$$;

revoke execute on function public.team_members_list(uuid) from public, anon;
grant execute on function public.team_members_list(uuid) to authenticated, service_role;
