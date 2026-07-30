-- 023_project_access_and_audit.sql — Task 8: per-project access control
-- (who on the team can see a given shared project) and the team audit trail
-- (a record of every sharing/admin change). Additive, re-runnable — apply in
-- the Supabase SQL editor (single transaction) or `supabase db push`; with
-- psql use `psql -1 -f` to keep that single-transaction property, matching
-- 002-022's style.
--
-- Schema-mismatch note (judgment call, recorded for the next reader): the
-- task skeleton this migration was drafted from wrote
--   member_id uuid not null references team_members(id) on delete cascade
-- and
--   actor_id uuid references team_members(id)
-- but public.team_members (schema.sql) has NO standalone `id` column — its
-- primary key is the composite (team_id, user_id) (schema.sql §team_members).
-- A bare `references team_members(id)` would fail to apply. Fixed here:
--   * project_access.member_id holds the same auth.users id that
--     team_members.user_id holds, enforced via a COMPOSITE foreign key
--     against team_members (team_id, user_id) — so a row can only ever name
--     an actual member of that same team, not an arbitrary uuid.
--   * team_audit.actor_id references auth.users (id) directly, the same
--     pattern public.projects.created_by already uses — an audit row must
--     survive its actor later leaving the team (team_members rows cascade-
--     delete on removal; the audit trail must not).
create table if not exists public.project_access (
  team_id uuid not null references public.teams (id) on delete cascade,
  -- The shared project this row governs. Keyed to public.projects.id (the
  -- one row every teammate's local team.json resolves to), NOT a local
  -- filesystem path — paths differ per machine, the backend project row is
  -- the one thing every teammate agrees on. Stored as text (not uuid) so
  -- this table never has to change shape if a future project identifier
  -- isn't a uuid.
  project_key text not null,
  member_id uuid not null,
  can_see boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  primary key (team_id, project_key, member_id),
  foreign key (team_id, member_id) references public.team_members (team_id, user_id) on delete cascade
);

create table if not exists public.team_audit (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  actor_id uuid references auth.users (id),
  action text not null,
  object_type text not null,
  object_key text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists team_audit_team_created_idx on public.team_audit (team_id, created_at desc);

alter table public.project_access enable row level security;
alter table public.team_audit enable row level security;

-- ---------------------------------------------------------------------------
-- RLS: mirrors the is_team_member / is_team_manager convention schema.sql
-- and 002_team_v2.sql already established — no new predicate function is
-- needed here. is_team_manager(p_team) (002_team_v2.sql §1) already means
-- "the caller's team_members.role is 'owner' or 'admin'", security definer /
-- set search_path = public, same shape as is_team_member.
--
-- `create policy` has no `if not exists`/`or replace` (see 011_backend_
-- hardening.sql §1's note), so every policy below is dropped first, then
-- created — safe to re-run this file.
-- ---------------------------------------------------------------------------

-- project_access: any team member may read it (so a member can see who else
-- can see a project they're on); only owner/admin may write it. This is the
-- SAME gate the Node route (lib/api-access.js) checks independently before
-- ever attempting the write — RLS is the backstop if that check is ever
-- bypassed or wrong, not the only gate.
drop policy if exists project_access_select on public.project_access;
create policy project_access_select on public.project_access
  for select using (public.is_team_member(team_id));

drop policy if exists project_access_insert on public.project_access;
create policy project_access_insert on public.project_access
  for insert with check (public.is_team_manager(team_id));

drop policy if exists project_access_update on public.project_access;
create policy project_access_update on public.project_access
  for update using (public.is_team_manager(team_id)) with check (public.is_team_manager(team_id));

drop policy if exists project_access_delete on public.project_access;
create policy project_access_delete on public.project_access
  for delete using (public.is_team_manager(team_id));

-- team_audit: readable and insertable by owner/admin only. No update or
-- delete policy at all — no policy means no access (RLS defaults closed) —
-- so the trail can never be edited or pruned through the API, only ever
-- appended to.
drop policy if exists team_audit_select on public.team_audit;
create policy team_audit_select on public.team_audit
  for select using (public.is_team_manager(team_id));

drop policy if exists team_audit_insert on public.team_audit;
create policy team_audit_insert on public.team_audit
  for insert with check (public.is_team_manager(team_id));
