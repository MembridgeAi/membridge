-- MemBridge team schema v2: invite links, roles, management RPCs, feed views.
-- Apply AFTER schema.sql (v1) — this is a migration, not a rewrite, so it can
-- run against the already-live backend without touching existing tables/rows.
-- Run in the Supabase SQL editor, or `supabase db push` if you use the CLI.
--
-- ⚠ DO NOT RE-APPLY THIS FILE AFTER 044 AND 045.
-- It defines public.remove_member and public.leave_team, and both were later
-- REPLACED — 044 makes removing a member rotate the team's standing invite
-- code, 045 does the same for a voluntary departure. Re-running this file
-- restores these older bodies with `create or replace` and silently reverts
-- both, so a removed member's old invite code starts working again. No error,
-- no diff, and the symptom is a security property quietly gone.
--
-- The same warning is on 044 and 045 themselves. It is repeated HERE because
-- this is the file someone about to re-paste actually opens — a note living
-- only in the newer files is read by everyone except the person doing the
-- dangerous thing. Enforced as a class by
-- test/suites/invite-lifetime-hardening.test.js, which tracks every function
-- defined in one migration and superseded in a later one.
--
-- v1 (schema.sql) stays the source for the base tables and RLS. Everything
-- here is additive; the legacy teams.invite_code keeps working alongside the
-- new invite links.

-- ---------------------------------------------------------------------------
-- Roles: allow 'admin' between owner and member.
-- ---------------------------------------------------------------------------
alter table public.team_members drop constraint if exists team_members_role_check;
alter table public.team_members
  add constraint team_members_role_check check (role in ('owner', 'admin', 'member'));

create or replace function public.team_role(p_team uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.team_members
  where team_id = p_team and user_id = auth.uid();
$$;

create or replace function public.is_team_manager(p_team uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.team_role(p_team) in ('owner', 'admin'), false);
$$;

-- ---------------------------------------------------------------------------
-- Invite links: short URL-safe token -> https://<app>/join/<token> and
-- `membridge join <token>`. Revocable, optional expiry and use cap, and a
-- redeem can never grant more than the member role.
-- ---------------------------------------------------------------------------
create or replace function public.gen_invite_token()
returns text
language sql
volatile
as $$
  -- 10 chars from a 58-char alphabet (no 0/O/I/l): ~58^10 ≈ 4e17 tokens.
  select string_agg(
    substr('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ',
           1 + floor(random() * 58)::int, 1), '')
  from generate_series(1, 10);
$$;

create table if not exists public.invites (
  token text primary key default public.gen_invite_token(),
  team_id uuid not null references public.teams (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  use_count integer not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.invites enable row level security;

create policy invites_select on public.invites
  for select using (public.is_team_member(team_id));

-- All writes go through the RPCs below; no direct insert/update/delete policies.

create or replace function public.create_invite(p_team uuid, p_expires_at timestamptz, p_max_uses integer)
returns table (token text, expires_at timestamptz, max_uses integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_team_manager(p_team) then
    raise exception 'only a team owner or admin can create invite links';
  end if;
  insert into public.invites (team_id, created_by, expires_at, max_uses)
    values (p_team, auth.uid(), p_expires_at, p_max_uses)
    returning * into v_invite;
  return query select v_invite.token, v_invite.expires_at, v_invite.max_uses;
end;
$$;

create or replace function public.revoke_invite(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.invites where invites.token = p_token;
  if v_team is null then
    raise exception 'unknown invite';
  end if;
  if not public.is_team_manager(v_team) then
    raise exception 'only a team owner or admin can revoke invite links';
  end if;
  update public.invites set revoked_at = now()
    where invites.token = p_token and revoked_at is null;
end;
$$;

-- Peek at an invite without redeeming it (the /join/<token> landing page:
-- "You've been invited to Team X"). Anonymous-safe: exposes only the team
-- name and whether the link is still valid — never ids or membership.
create or replace function public.peek_invite(p_token text)
returns table (team_name text, valid boolean)
language sql
security definer
set search_path = public
stable
as $$
  select t.name,
         (i.revoked_at is null
          and (i.expires_at is null or i.expires_at > now())
          and (i.max_uses is null or i.use_count < i.max_uses))
  from public.invites i
  join public.teams t on t.id = i.team_id
  where i.token = p_token;
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
begin
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
  -- No conflict target: naming team_id here is ambiguous with the OUT column
  -- of the same name, and the composite PK is the table's only constraint.
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  if found then
    update public.invites set use_count = use_count + 1
      where invites.token = p_token;
  end if;
  return query select v_team.id, v_team.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Management RPCs: owner/admin only for destructive actions.
-- ---------------------------------------------------------------------------
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

create or replace function public.set_role(p_team uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.team_role(p_team) <> 'owner' then
    raise exception 'only the team owner can change roles';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member';
  end if;
  if p_user = auth.uid() then
    raise exception 'the owner cannot change their own role';
  end if;
  update public.team_members set role = p_role
    where team_id = p_team and user_id = p_user;
end;
$$;

create or replace function public.rename_team(p_team uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team_manager(p_team) then
    raise exception 'only a team owner or admin can rename the team';
  end if;
  update public.teams set name = p_name where id = p_team;
end;
$$;

create or replace function public.rotate_invite(p_team uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code uuid;
begin
  if not public.is_team_manager(p_team) then
    raise exception 'only a team owner or admin can rotate the invite code';
  end if;
  update public.teams set invite_code = gen_random_uuid()
    where id = p_team returning invite_code into v_code;
  -- Rotating also revokes every outstanding invite link for the team.
  update public.invites set revoked_at = now()
    where team_id = p_team and revoked_at is null;
  return v_code;
end;
$$;

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

-- Members list for the web settings screen (RLS-safe convenience).
create or replace function public.team_members_list(p_team uuid)
returns table (user_id uuid, display_name text, role text, joined_at timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select m.user_id, m.display_name, m.role, m.joined_at
  from public.team_members m
  where m.team_id = p_team and public.is_team_member(p_team)
  order by m.joined_at;
$$;

-- ---------------------------------------------------------------------------
-- Feed read model: the web feed is one RPC call, not N queries.
-- Keyset pagination on (created_at, id); optional member/project/tool/date
-- filters. RLS-safe: only rows in teams the caller belongs to.
-- ---------------------------------------------------------------------------
create or replace function public.team_feed(
  p_team uuid,
  p_before_created_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 50,
  p_author uuid default null,
  p_project uuid default null,
  p_source text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  id bigint, project_id uuid, project_name text,
  author_id uuid, author_name text,
  ts timestamptz, source text, ask text, files jsonb, created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.files, e.created_at
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and public.is_team_member(p_team)
    and (p_before_created_at is null
         or (e.created_at, e.id) < (p_before_created_at, p_before_id))
    and (p_author is null or e.author_id = p_author)
    and (p_project is null or e.project_id = p_project)
    and (p_source is null or e.source = p_source)
    and (p_since is null or e.ts >= p_since)
    and (p_until is null or e.ts <= p_until)
  order by e.created_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- Per-project stats for the web Projects screen. security_invoker keeps the
-- caller's RLS in force (members see only their teams' projects).
create or replace view public.project_stats
with (security_invoker = on) as
  select p.id as project_id, p.team_id, p.name, p.repo_url,
         max(e.ts) as last_activity,
         count(distinct e.author_id) as contributors,
         count(e.id) as entries
  from public.projects p
  left join public.memory_entries e on e.project_id = p.id
  group by p.id;
