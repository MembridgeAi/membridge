-- 024_project_access_and_audit.sql — Task 8: per-project access control
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
-- hardening.sql §1's note). This file USED to drop each policy first and then
-- create it, and called that "safe to re-run". It was not: four of these
-- policies have since been tightened by later migrations (project_access_select
-- by 025, project_access_insert/update by 037, team_audit_insert by 025), and a
-- drop-then-create re-run would have reverted every one of them silently.
--
-- Each create is now guarded on pg_policies instead, the convention 009:72-77
-- established. Re-running this file is genuinely safe now: on a database that
-- already has these policies — which is all of them — every branch is a no-op,
-- and the tightened definitions survive untouched.
--
-- THE GENERAL RULE, worth more than this one file: a migration must never DROP
-- a policy it did not introduce. Only the migration currently holding the
-- newest definition of a policy may drop-then-create it; once a later migration
-- supersedes it, the older file has to become a guarded create or it is a
-- regression waiting for someone to paste it. Enforced by
-- test/suites/invite-lifetime-hardening.test.js.
-- ---------------------------------------------------------------------------

-- project_access: any team member may read it (so a member can see who else
-- can see a project they're on); only owner/admin may write it. This is the
-- SAME gate the Node route (lib/api-access.js) checks independently before
-- ever attempting the write — RLS is the backstop if that check is ever
-- bypassed or wrong, not the only gate.
-- GUARDED, NOT DROP-AND-RECREATE — see the note at the head of the policy
-- section. Four of the policies this file introduced have since been tightened
-- by LATER migrations (project_access_select by 025, insert and update by 037),
-- so a drop-then-create here is a loaded gun: re-running this file, which its
-- own header invites, would silently restore the weaker predicate and take the
-- hardening with it. The guard makes each create a no-op on any database that
-- already has the policy, which is every database this file has ever run on.
-- Convention borrowed from 009:72-77, which established it and which later
-- migrations stopped following.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'project_access' and policyname = 'project_access_select') then
    create policy project_access_select on public.project_access
      for select using (public.is_team_member(team_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'project_access' and policyname = 'project_access_insert') then
    create policy project_access_insert on public.project_access
      for insert with check (public.is_team_manager(team_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'project_access' and policyname = 'project_access_update') then
    create policy project_access_update on public.project_access
      for update using (public.is_team_manager(team_id)) with check (public.is_team_manager(team_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'project_access' and policyname = 'project_access_delete') then
    create policy project_access_delete on public.project_access
      for delete using (public.is_team_manager(team_id));
  end if;
end $$;

-- team_audit: readable and insertable by owner/admin only. No update or
-- delete policy at all — no policy means no access (RLS defaults closed) —
-- so the trail can never be edited or pruned through the API, only ever
-- appended to.
-- GUARDED for the same reason, and this is the instance that mattered most:
-- 025:144 tightened team_audit_insert to
-- `is_team_manager(team_id) and actor_id = auth.uid()`, closing actor forgery.
-- Re-running the old drop-then-create below would have reopened it — letting a
-- manager file audit rows naming any member as the actor, which readAudit then
-- renders under that member's name. The guard is what stops a re-paste of this
-- file from quietly undoing 025.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'team_audit' and policyname = 'team_audit_select') then
    create policy team_audit_select on public.team_audit
      for select using (public.is_team_manager(team_id));
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'team_audit' and policyname = 'team_audit_insert') then
    create policy team_audit_insert on public.team_audit
      for insert with check (public.is_team_manager(team_id));
  end if;
end $$;
