-- Rollback for 042_leave_rotates_invite_code.sql.
--
-- OUTSIDE supabase/migrations/ ON PURPOSE so nothing applies it by accident —
-- same placement and reasoning as the other files in this directory.
--
-- The body below is the PRE-042 definition restated verbatim from
-- 002_team_v2.sql:252. Nothing was read out of the live system to write this:
-- 042 changed exactly one function body and touched no table, no policy and no
-- data, so the prior state is fully described by that file.
--
-- Independent of pre-041: rolling back one does not require rolling back the
-- other. They restore different functions.
--
-- WHAT IT CANNOT UNDO. Every invite code and invite link that 042 already
-- rotated stays rotated — those are writes to teams.invite_code and
-- invites.revoked_at, not a behaviour toggle. Anyone cut off by a departure
-- that happened while 042 was live still needs a fresh invite after this
-- rollback.
--
-- WHAT IT WILL DO, so it is not run casually: restore the door. A member who
-- leaves voluntarily — including an admin who resigns holding the standing
-- code, which after 041 §2 is the only role that still receives it — walks
-- back in unaided, with member role and, through 029's materialization, access
-- to every project whose default_access is true.

create or replace function public.leave_team(p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.team_role(p_team) = 'owner' then
    raise exception 'the owner cannot leave their own team';
  end if;
  delete from public.team_members where team_id = p_team and user_id = auth.uid();
end;
$$;

revoke execute on function public.leave_team(uuid) from public, anon;
grant execute on function public.leave_team(uuid) to authenticated, service_role;
