-- Richer summaries (goal/decisions/gotchas/changes) never reached teammates:
-- memory_entries had no columns for them, and team_feed only ever returned
-- summary (004_feed_summary.sql) + goal (added client-side in 005/006's
-- push path, but never a table column). This migration:
--   1. Adds the missing columns to memory_entries (nullable, additive).
--   2. Extends team_feed to return goal/decisions/gotchas/changes alongside
--      the existing columns, so the unified feed and injected context blocks
--      can show a teammate's full checkpoint, not just `summary`.
-- Additive/idempotent, matching 004/005/006's style. Postgres refuses to
-- change a function's RETURNS TABLE via create-or-replace, so the 9-arg
-- team_feed signature (unchanged since 004) is DROPped and recreated.
-- Old clients (pre-migration) keep working: they simply never request the
-- new columns, and lib/teamsync.js's push/pull paths already tolerate a
-- backend missing any of these columns (drop-and-retry on push, a select
-- fallback on pull) so this is safe to deploy before or after a client
-- rollout. Run in the Supabase SQL editor or `supabase db push`.

alter table public.memory_entries add column if not exists goal text;
alter table public.memory_entries add column if not exists decisions text;
alter table public.memory_entries add column if not exists gotchas text;
alter table public.memory_entries add column if not exists changes jsonb;

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
  goal text, decisions text, gotchas text, changes jsonb
)
language sql
security definer
set search_path = public
stable
as $$
  select e.id, e.project_id, p.name, e.author_id, e.author_name,
         e.ts, e.source, e.ask, e.summary, e.files, e.created_at,
         e.goal, e.decisions, e.gotchas, e.changes
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and p.archived_at is null
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
