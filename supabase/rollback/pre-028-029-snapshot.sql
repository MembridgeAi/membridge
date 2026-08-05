-- Rollback snapshot: the LIVE definitions of every function that migrations
-- 028 and 029 replace, captured from the production database before either was
-- applied. Read out of pg_proc with pg_get_functiondef, so this is what the
-- server was actually running -- not what the repo's migration files say it
-- was. Those two are known to diverge in this project (see team_keys_insert),
-- which is exactly why this snapshot exists.
--
-- THIS IS NOT A MIGRATION. It lives outside supabase/migrations/ on purpose so
-- nothing applies it by accident. Run it only to undo 028/029.
--
-- To roll back: paste this whole file into the Supabase SQL editor and run it.
-- Every statement is CREATE OR REPLACE on an unchanged signature, so it
-- restores the previous behaviour without touching data, privileges, or any
-- policy that depends on these functions.
--
-- WHAT THIS DOES NOT UNDO: 029 also INSERTS rows into public.project_access
-- (the backfill). Restoring these function bodies stops new rows being written
-- but leaves the backfilled ones in place. Those rows record access everyone
-- already had -- every project's default_access is true today -- so with
-- can_see_project restored to the definition below (explicit-revoke-only) they
-- have no effect on what anyone can read. Delete them only if you have a
-- specific reason to, and never blindly: a row with can_see = false may be a
-- deliberate revoke that predates the backfill.

-- ---------------------------------------------------------------------------
-- can_see_project -- pre-028: explicit-revoke-only, never reads default_access.
-- This is the definition whose gap made the "New members join with access"
-- toggle inert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_see_project(p_project uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select not exists (
    select 1 from public.project_access a
    where a.project_key = p_project::text
      and a.member_id = auth.uid()
      and a.can_see = false
  );
$function$;

-- ---------------------------------------------------------------------------
-- join_team -- pre-029: adds the member, materializes no access rows.
-- Note the bare `on conflict do nothing`: team_id is a RETURNS TABLE column
-- and therefore a PL/pgSQL variable here, so a named conflict target raises
-- "column reference team_id is ambiguous". 029 follows this same pattern for
-- the same reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_team(p_code uuid, p_display_name text)
 RETURNS TABLE(team_id uuid, team_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  return query select v_team.id, v_team.name;
end;
$function$;

-- ---------------------------------------------------------------------------
-- link_project -- pre-029: creates or adopts the project, materializes no
-- access rows for the members who already exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_project(p_team uuid, p_name text, p_repo_url text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- redeem_invite -- pre-029.
-- The `if found` immediately after the team_members insert is load-bearing: it
-- decides whether this join burns one of the invite's uses. Any statement
-- inserted between them clobbers FOUND and silently breaks invite accounting,
-- which is why 029 captures the result into a variable instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invite(p_token text, p_display_name text)
 RETURNS TABLE(team_id uuid, team_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_invite public.invites;
  v_team public.teams;
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
  if found then
    update public.invites set use_count = use_count + 1
      where invites.token = p_token;
  end if;
  return query select v_team.id, v_team.name;
end;
$function$;
