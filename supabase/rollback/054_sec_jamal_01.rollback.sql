-- 054_sec_jamal_01.rollback.sql — undoes 054_sec_jamal_01.sql.
--
-- Reconstructed from the LIVE function definitions and pg_proc.proacl read out
-- of production `mefgbiecvoszjorwzkfz` on 2026-08-06, BEFORE 054 was written.
-- The bodies below are what pg_get_functiondef returned; the grants are what
-- has_function_privilege() returned. Both pastes are also in
-- `claude/ops/rollback-sec-jamal-01.md` for the human record.
--
-- OUTSIDE `supabase/migrations/` so nothing applies it by accident (see
-- backend agent standing orders). Apply by hand in the SQL editor only if 054
-- lands and something breaks. Every statement is re-runnable.
--
-- WHAT THIS UNDOES.
--   1. Restores peek_invite so `team_name` is returned unconditionally
--      alongside `valid`. Reopens the name-leak on revoked/expired/exhausted
--      invites. A former holder learns the current team name again.
--   2. Restores can_see_project so the terminal arm of the coalesce is `true`
--      instead of `false`. Reopens the LATENT hole (harmless today because
--      `projects.default_access` is NOT NULL, DANGEROUS if a future migration
--      relaxes that NOT NULL).
--   3. Re-GRANTs EXECUTE on projects_materialize_access to PUBLIC, and on
--      is_team_member and team_feed to anon. Restores the pre-054 grant
--      matrix documented in claude/ops/rollback-sec-jamal-01.md §3.
--
-- WHAT THIS CANNOT UNDO. Nothing on the write side — 054 touches function
-- bodies and grants, not rows. Any audit or attempt log written between the
-- apply of 054 and the run of this file stays. That is a feature, not a bug:
-- rollback restores capability, not history.


-- ---------------------------------------------------------------------------
-- 1. Restore peek_invite(text) to its pre-054 body, verbatim from
--    pg_get_functiondef on 2026-08-06.
-- ---------------------------------------------------------------------------

create or replace function public.peek_invite(p_token text)
returns table(team_name text, valid boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.check_invite_attempt();
  return query
    select t.name,
           (i.revoked_at is null
            and (i.expires_at is null or i.expires_at > now())
            and (i.max_uses is null or i.use_count < i.max_uses))
    from public.invites i
    join public.teams t on t.id = i.team_id
    where i.token = p_token;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Restore can_see_project(uuid) to its pre-054 body, verbatim from
--    pg_get_functiondef on 2026-08-06. The terminal arm goes back to `true`.
-- ---------------------------------------------------------------------------

create or replace function public.can_see_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select bool_and(a.can_see) from public.project_access a
       where a.project_key = p_project::text and a.member_id = auth.uid()),
    (select p.default_access from public.projects p where p.id = p_project),
    true
  );
$$;


-- ---------------------------------------------------------------------------
-- 3. Restore the pre-054 grant matrix, from has_function_privilege() output
--    on 2026-08-06. Named-role grants only; a bare `grant to public` would
--    also cover other principals not intended here.
--
--    Pre-054 ACLs, for the reader:
--      projects_materialize_access() —
--        {=X/postgres,postgres=X/postgres,anon=X/postgres,
--         authenticated=X/postgres,service_role=X/postgres}
--        (public, anon, authenticated, service_role all execute)
--      is_team_member(uuid) —
--        {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
--         service_role=X/postgres}
--        (anon, authenticated, service_role — public not granted)
--      team_feed(...9 args...) —
--        {=X/postgres,postgres=X/postgres,anon=X/postgres,
--         authenticated=X/postgres,service_role=X/postgres}
--        (public, anon, authenticated, service_role all execute)
-- ---------------------------------------------------------------------------

grant execute on function public.projects_materialize_access()
  to public, anon, authenticated, service_role;

grant execute on function public.is_team_member(uuid) to anon;

grant execute on function public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)
  to anon;
