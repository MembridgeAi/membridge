-- 025_enforce_project_access.sql — Task 8 security fixup: ENFORCE can_see on
-- every read path instead of merely recording it. 023 created project_access
-- rows, but nothing read them: memory_entries, project_stats and the
-- team_feed RPC were still gated on team membership alone, so revoking a
-- member's access to a project changed nothing about what they could
-- actually fetch. Additive on top of 023 — do not edit 023. Apply in the
-- Supabase SQL editor (single transaction) or `supabase db push`; with psql
-- use `psql -1 -f` to keep that single-transaction property, matching
-- 002-023's style. Every statement below is re-runnable.
--
-- Also closes two related findings from the same review:
--   * team_audit's insert policy checked only the caller's ROLE, so an
--     owner/admin could POST directly to PostgREST with an arbitrary
--     actor_id and blame someone else for their own action. The insert
--     policy now also requires actor_id = auth.uid().
--   * project_access's select policy let any team member read the whole
--     grid, which leaks the existence of projects they have no access to
--     and every other member's can_see flag. Narrowed to owner/admin here,
--     matching the new Node-side gate on accessMatrix() in lib/api-access.js.

-- ---------------------------------------------------------------------------
-- 1. can_see_project(p_project uuid) — default-allow predicate, beside the
-- other helpers in the same security definer / set search_path = public
-- style as is_team_member / is_team_manager (schema.sql, 002_team_v2.sql).
--
-- Default-allow: absence of a row means the team default applies. A row with
-- can_see = false is an explicit revoke and must win everywhere project
-- content is read, not just where it is displayed.
-- ---------------------------------------------------------------------------
create or replace function public.can_see_project(p_project uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select not exists (
    select 1 from public.project_access a
    where a.project_key = p_project::text
      and a.member_id = auth.uid()
      and a.can_see = false
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. memory_entries: AND can_see_project into the existing select policy.
-- `create policy` has no `if not exists`/`or replace` (see 011_backend_
-- hardening.sql §1's note, and 023's own header) — drop then create, the
-- same convention every policy change in this codebase already follows.
-- ---------------------------------------------------------------------------
drop policy if exists memory_entries_select on public.memory_entries;
create policy memory_entries_select on public.memory_entries
  for select using (
    public.is_team_member((select team_id from public.projects where id = project_id))
    and public.can_see_project(project_id)
  );

-- ---------------------------------------------------------------------------
-- 3. project_stats: this is a VIEW, not a table, so it has no policy of its
-- own to drop-and-recreate. With security_invoker = on it inherits the
-- caller's RLS on the tables it joins, but that alone is not enough here: it
-- is a LEFT JOIN from projects to memory_entries, so even with (2) above
-- filtering out a revoked member's rows on the memory_entries side, the
-- PROJECT row would still surface with zeroed-out stats — a weaker but real
-- leak of "this project exists and you're on its team". Recreate the view
-- with the predicate applied directly in its WHERE clause instead, preserving
-- 005_project_archive.sql's archived_at filter; the column set is unchanged
-- so create-or-replace is enough, no drop needed (same as 005's own note).
-- ---------------------------------------------------------------------------
create or replace view public.project_stats
with (security_invoker = on) as
  select p.id as project_id, p.team_id, p.name, p.repo_url,
         max(e.ts) as last_activity,
         count(distinct e.author_id) as contributors,
         count(e.id) as entries
  from public.projects p
  left join public.memory_entries e on e.project_id = p.id
  where p.archived_at is null
    and public.can_see_project(p.id)
  group by p.id;

-- ---------------------------------------------------------------------------
-- 4. team_feed: security definer, so RLS does NOT apply to it automatically
-- — the predicate must be written into the function body itself, or a
-- revoked member keeps reading the project's feed forever through this one
-- RPC regardless of (2) above. Postgres refuses to change a function's OUT
-- row type in place, so drop + recreate, same dance 013/014/017 already used.
-- Signature and return table preserved from 002_team_v2.sql:285 as last
-- modified by 017_headline_parity.sql (headline column + archived_at filter
-- carried on line 67 below) — only the can_see_project line is new.
-- ---------------------------------------------------------------------------
drop function if exists public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz);

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
  ts timestamptz, source text, ask text, summary text, files jsonb, created_at timestamptz,
  goal text, decisions text, gotchas text, changes jsonb,
  session text, ciphertext text, nonce text, key_epoch integer,
  distilled boolean, headline text
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at,
         e.goal, e.decisions, e.gotchas, e.changes,
         e.session, e.ciphertext, e.nonce, e.key_epoch,
         e.distilled, e.headline
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and p.archived_at is null
    and public.is_team_member(p_team)
    and public.can_see_project(e.project_id)
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

-- ---------------------------------------------------------------------------
-- 5. team_audit: insert policy must also pin actor_id = auth.uid() — a role
-- check alone lets an owner/admin blame another member for their own write.
-- No update or delete policy exists on this table (023 never added one, and
-- this migration does not either), so the trail stays append-only end to end.
-- ---------------------------------------------------------------------------
drop policy if exists team_audit_insert on public.team_audit;
create policy team_audit_insert on public.team_audit
  for insert with check (public.is_team_manager(team_id) and actor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. project_access: narrow select to owner/admin. Any team member being able
-- to read the whole grid leaks which projects exist that they cannot see,
-- plus every other member's can_see flag — the same information the Node
-- accessMatrix() gate in lib/api-access.js now also refuses to a non-manager.
-- ---------------------------------------------------------------------------
drop policy if exists project_access_select on public.project_access;
create policy project_access_select on public.project_access
  for select using (public.is_team_manager(team_id));
