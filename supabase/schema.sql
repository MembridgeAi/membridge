-- MemBridge team sync schema. Run this once in your Supabase project's SQL
-- editor (Dashboard -> SQL Editor -> paste -> Run). Requires nothing else:
-- auth.users is built into Supabase.
--
-- Access model: a user sees a team's rows only while they are a member of it.
-- Team creation and invite-code joins go through security-definer RPCs so the
-- row-level-security policies below can stay simple membership checks.

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  invite_code uuid not null default gen_random_uuid(),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  repo_url text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (team_id, name)
);

create table if not exists public.memory_entries (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  author_id uuid not null references auth.users (id),
  author_name text not null,
  ts timestamptz not null,
  source text not null,
  ask text not null check (char_length(ask) <= 400),
  files jsonb not null default '[]'::jsonb,
  session text,
  created_at timestamptz not null default now(),
  unique (project_id, author_id, ts, source)
);

-- Rich signals: the agent's final self-report for the entry, redacted and
-- clipped client-side (<=300 chars pushed; the check leaves headroom like
-- ask's). Nullable and added via `alter` so it is backwards-compatible: it
-- applies to already-live backends, and pre-existing clients that push rows
-- without the field keep working.
alter table public.memory_entries
  add column if not exists summary text check (char_length(summary) <= 400);

-- Privacy gate (config.team.sharePrompts): verbatim prompts stay on the
-- author's machine unless they opt in, so clients push ask = null by default.
-- Applied via `alter` so it is backwards-compatible with live backends whose
-- column predates the gate.
alter table public.memory_entries
  alter column ask drop not null;

create index if not exists memory_entries_pull_idx
  on public.memory_entries (project_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security: membership is the only gate.
-- ---------------------------------------------------------------------------
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.projects enable row level security;
alter table public.memory_entries enable row level security;

create or replace function public.is_team_member(p_team uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team and user_id = auth.uid()
  );
$$;

create policy teams_select on public.teams
  for select using (public.is_team_member(id));

create policy team_members_select on public.team_members
  for select using (public.is_team_member(team_id));

create policy projects_select on public.projects
  for select using (public.is_team_member(team_id));

create policy projects_insert on public.projects
  for insert with check (public.is_team_member(team_id) and created_by = auth.uid());

create policy memory_entries_select on public.memory_entries
  for select using (
    public.is_team_member((select team_id from public.projects where id = project_id))
  );

create policy memory_entries_insert on public.memory_entries
  for insert with check (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
  );

-- ---------------------------------------------------------------------------
-- RPCs (security definer): create a team, join by invite code, link a project.
-- ---------------------------------------------------------------------------
create or replace function public.create_team(p_name text, p_display_name text)
returns table (team_id uuid, invite_code uuid)
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
  insert into public.teams (name, created_by)
    values (p_name, auth.uid()) returning * into v_team;
  insert into public.team_members (team_id, user_id, display_name, role)
    values (v_team.id, auth.uid(), p_display_name, 'owner');
  return query select v_team.id, v_team.invite_code;
end;
$$;

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
    on conflict (team_id, user_id) do nothing;
  return query select v_team.id, v_team.name;
end;
$$;

-- Upsert by repo URL when one exists (same repo cloned by every teammate maps
-- to one project row), else by name.
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
  return v_id;
end;
$$;

-- Teams the calling user belongs to (RLS-safe convenience for the CLI).
create or replace function public.my_teams()
returns table (team_id uuid, team_name text, role text, invite_code uuid)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.name, m.role, t.invite_code
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by m.joined_at;
$$;
