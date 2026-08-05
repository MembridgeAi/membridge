-- Rollback for 039_removal_rotates_invite_code.sql.
--
-- OUTSIDE supabase/migrations/ ON PURPOSE so nothing applies it by accident —
-- same placement and reasoning as the other files in this directory.
--
-- Both bodies below are the PRE-039 definitions restated verbatim:
-- remove_member from 002_team_v2.sql:179, my_teams from
-- 006_team_meta.sql:9. Nothing was read out of the live system to write this —
-- 039 changed exactly two function bodies and touched no table, no policy and
-- no data, so the prior state is fully described by those two files.
--
-- WHAT IT CANNOT UNDO. Every invite code and invite link that 039 already
-- rotated stays rotated. Rotation is a write to teams.invite_code and
-- invites.revoked_at, not a behaviour toggle: the old UUIDs are gone and the
-- revoked links are revoked. Anyone cut off by a removal that happened while
-- 039 was live still needs a fresh invite after this rollback. There is no
-- statement that can restore them and this file does not pretend to.
--
-- WHAT IT WILL DO, so it is not run casually: put back the hole. A removed
-- member who kept the standing invite code re-joins the team unaided, with
-- member role and — through 029's materialization — access to every project
-- whose default_access is true. And every member is handed that code again on
-- every dashboard load. Run this only to unblock a team that a rotation has
-- genuinely stranded, and re-apply 039 immediately afterwards.

create or replace function public.remove_member(p_team uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team_manager(p_team) then
    raise exception 'only a team owner or admin can remove members';
  end if;
  if (select role from public.team_members where team_id = p_team and user_id = p_user) = 'owner' then
    raise exception 'the team owner cannot be removed';
  end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
end;
$$;

create or replace function public.my_teams()
returns table (
  team_id uuid,
  team_name text,
  role text,
  invite_code uuid,
  member_count bigint,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id,
    t.name,
    m.role,
    t.invite_code,
    (select count(*) from public.team_members mc where mc.team_id = t.id),
    t.created_at
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by m.joined_at;
$$;

revoke execute on function public.my_teams() from public, anon;
grant execute on function public.my_teams() to authenticated, service_role;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated, service_role;
